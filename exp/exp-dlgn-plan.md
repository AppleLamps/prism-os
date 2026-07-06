# Differentiable logic / straight-through training plan

do not change this before asking the user

Research notes for making the `boolean` atom and, eventually, circuit
*structure* trainable. This file is additive and descriptive: it does not change
any runtime semantics. The runtime forward pass stays exact FP32 as defined in
`execution-model.md` and `boolean-state.md`; everything here is about the
*backward* pass and about future trainable parameterizations.

## Where this repo sits structurally

Read `numeric-ui-core.ts` lines 154-192 first. `backpropagateReference` already
differentiates `affine` and `reglu` as real-valued FP32 arithmetic (ReLU uses
zero slope at the corner, line 162). It throws on `boolean` (line 169). The
`boolean(score)` atom is `round-to-bit at 0.5` over a value the circuit has
already constrained to `[0,1]` (`numeric-ui-core.ts:88-92`, `boolean-state.md`).

That makes our `boolean` atom **a threshold/sign unit on an affine score**, i.e.
structurally a Binarized-Neural-Network sign activation, **not** a 2-input
lookup-table logic gate. This matters for choosing the literature:

- The **STE / BNN lineage** (Bengio 2013; Courbariaux/Hubara 2015-2016) and
  **surrogate gradients** (Neftci 2019) apply *directly* to the existing atom:
  same forward (hard threshold), the only question is the backward surrogate.
- The **DLGN lineage** (Petersen 2022/2024; DiffLogic CA 2025) is about making
  the *operation itself* (which gate / which comparison) trainable. That is a
  new parameterization on top of our atoms, addressed in stage 3.

`trainable-geometry.ts` is the template for the optimizer side: params live as
*source cells*, the circuit is differentiated by `backpropagateReference`, and
an Adam loop (bias correction, global gradient-norm clip, weight decay, `[-6,6]`
param clamp, lines 547-612) updates the source. Any trainable-boolean or
trainable-structure work reuses exactly that machinery — only the loss and the
backward rule for `boolean` change.

The recurrence to worry about is the `nextSource` writeback: each frame the
outputs at the `nextSource` wires become the next frame's source table
(`window-manager.ts:982-1009`, `photo-gallery.ts:533-560`, and the
`step()` writeback at `window-manager.ts:1254-1256`). Multi-frame behavior (focus that stays
latched, a drag that owns the pointer until release) is therefore a *recurrent*
computation, and training it is backprop-through-time across that writeback.
This is the exact structural match to DiffLogic CA's per-step state carry.

Terminology note: stage 1 here is the surrogate backward rule for the existing
`boolean` atom. The parallel `exp-ste-backprop.ts` work is the same thing — use
"STE / surrogate backward for `boolean`" consistently; "surrogate" = the smooth
function substituted only in the backward pass; "hard forward" = the unchanged
exact `boolean` forward.

---

## 1. Recipe table per source

### 1a. Petersen et al., Deep Differentiable Logic Gate Networks (NeurIPS 2022)

| Aspect | Detail |
| --- | --- |
| Relaxation form | Each node is a soft mixture over all 16 two-input Boolean gates. For logits `z ∈ R^16`, output `f_z(a,b) = Σ_i softmax(z)_i · g_i(a,b)`, where each `g_i` is the probabilistic relaxation of a gate: `AND→a·b`, `XOR→a+b−2ab`, `OR→a+b−ab`, `A→a` (pass-through), `NAND→1−ab`, etc. (full 16-row table below). Inputs `a,b ∈ [0,1]` treated as independent Bernoulli probabilities. |
| Surrogate shape | None on the gate itself — the relaxation is genuinely differentiable; gradient flows through the soft mixture. No STE here. |
| Temperature schedule | No annealing of the gate softmax. A separate output **GroupSum** aggregation divides class scores by temperature `τ`: `Σ_j a_j / τ + β` then softmax-cross-entropy. Heuristic: increasing neuron count `n` by 10× → decrease `τ` by ~√2 to ~10. Default style `τ = n/k`, `β = 0`. |
| Init | Gate logits `z` ~ **standard normal**. Connections (which two earlier nodes feed each node) **pseudo-random and fixed** for the whole run — only the gate choice is learned. |
| Optimizer | **Adam**, constant **lr 0.01** (chosen for its gradient-magnitude normalization). |
| Known failure modes | Works well only at **4-8 layers ("straight networks")**; deeper randomly-connected nets do not train well. Gaussian-init softmax is "washed out", activations drift to 0.5, gradients shrink — motivates 2024 fix. Vanilla 5M-gate net = 90 GPU-hours. |
| Discretization | At inference take `argmax_i z_i` per node → hard gate. "Minimal loss in accuracy" vs the soft model. |
| URL | https://arxiv.org/abs/2210.08277 · code https://github.com/Felix-Petersen/difflogic |

16-gate relaxation table (Petersen 2022, reproduced via DiffLogic CA Table 1):

```
FALSE              0
AND                a·b
A AND NOT B        a − a·b
A   (pass-through) a
NOT A AND B        b − a·b
B   (pass-through) b
XOR                a + b − 2·a·b
OR                 a + b − a·b
NOR                1 − (a + b − a·b)
XNOR               1 − (a + b − 2·a·b)
NOT B              1 − b
A OR NOT B         1 − b + a·b
NOT A              1 − a
NOT A OR B         1 − a + a·b
NAND               1 − a·b
TRUE               1
```

### 1b. Petersen et al., Convolutional Differentiable Logic Gate Networks (NeurIPS 2024)

| Aspect | Detail |
| --- | --- |
| Relaxation form | Same 16-gate softmax mixture (Eq. 1). Adds learnable logic-gate **trees** and **logical OR pooling** = the max t-conorm `⊥max(a,b) = max(a,b)` (fixed, not learned). |
| Surrogate shape | Same soft mixture; OR-pooling backward only flows through the max element (like max-pool). |
| Temperature schedule | GroupSum `τ` chosen per model size; `τ* ∝ √(output gates per class)`; rule of thumb: increase `τ` by √2 when output-neuron count grows. No gate-logit annealing. |
| Init | **Residual initialization** — the key trick. Instead of `z ~ N(0,1)`, set the pass-through gate 'A' (index 3) logit to **`z3 = 5`** and all other `z_i = 0`. This puts ~**90%** mass on pass-through and ~0.67% on each other gate, so a fresh node is ~identity. Gives a "differentiable residual connection" with no extra wiring. |
| Optimizer | **AdamW**, **lr 0.02**, batch 128 (CIFAR-10). |
| Known failure modes | Without residual init, Gaussian-init activations collapse toward 0.5 and **gradient norm decays ×0.1-0.2 per layer** → vanishing gradients; deep nets "do not converge and [are] quite unstable" (≈9% accuracy drop ablation). Residual init enables training **beyond 6 layers** (23-layer LogicTreeNet). |
| Discretization | `argmax` gate per node; pass-through gates become bare wires (free in hardware). |
| URL | https://proceedings.neurips.cc/paper_files/paper/2024/file/db988b089d8d97d0f159c15ed0be6a71-Paper-Conference.pdf · https://openreview.net/forum?id=4bKEFyUHT4 |

### 1c. DiffLogic CA — Differentiable Logic Cellular Automata (arXiv 2506.04912, 2025)

The closest structural match to this repo's `nextSource` frame loop: a recurrent,
stateful, hard-gate circuit trained by gradient descent.

| Aspect | Detail |
| --- | --- |
| Relaxation form | Same Petersen 16-gate softmax mixture. Two sub-circuits per cell: **perception kernels** (channel-wise DLGNs over the Moore 3×3 neighborhood, replacing Sobel convs) and an **update network** (a DLGN mapping concatenated [own state ; perception bits] → next state bits). |
| Surrogate shape | Soft mixture forward in training; **fully discrete (hard argmax gates) at inference**. State bits are exact 0/1 at inference, continuous `[0,1]` during training. |
| Temperature schedule | Not annealed; loss is plain sum-of-squared-error between predicted and target grid. |
| Init | Random fixed connections; gate logits initialized per Petersen. Pattern-gen seeds: random uniform 0/1 initial state (checkerboard) or a single central seed (lizard) to break symmetry. |
| Recurrence training (the important part) | **Full unrolled BPTT** across all CA steps. Game of Life: 1 bit of state, supervised on **every** single-step transition (all 512 3×3 configs) — no long horizon needed. Pattern generation: 8-bit state, **20 steps unrolled**, loss **only at the final step** (no per-step supervision) — the circuit must discover its own intermediate dynamics. Lizard: 128-bit state, 12 steps. |
| Tricks that make recurrence trainable | (i) **Loss only at final step** forces emergent multi-step rules; (ii) **state width >> output width** (8-128 bits for a 1-channel target) gives scratch memory across steps; (iii) **asynchronous updates** — randomly update only 60% of cells per step during training — yields lower error under perturbation and better self-healing; (iv) trained synchronously still survives async inference (robustness is emergent); (v) small fixed grid generalizes to 4× larger grid and 4× more steps. |
| Known failure modes | Long-horizon credit assignment is the hard case (final-step-only loss over 20+ steps); they keep state width generous and horizons short (12-20) to compensate. Discrete inference matches soft training only because softmax converged to near-one-hot. |
| URL | https://arxiv.org/abs/2506.04912 · interactive https://google-research.github.io/self-organising-systems/difflogic-ca/ |

Related, even closer on the recurrence question:
**Recurrent Deep Differentiable Logic Gate Networks (arXiv 2508.06097, 2025)** —
unrolls recurrent logic layers over a length-16 sequence with full BPTT. Reports:
state carried by **concatenating previous hidden bits with current input** before
the next logic block; **residual initialization** (per 1b) on the recurrent
decoder layers beats Gaussian (24.6% vs 22.6% val); GroupSum **`τ=1` works, `τ=0.25`
causes training failure**; **lr 0.001 completely fails (0.44%), lr 0.05-0.1 works**;
AdamW `β=(0.9,0.999)`, weight decay `1e-3`, ReduceLROnPlateau (γ=0.8); **dropout
>0.2 severely impairs** logic-layer training. URL https://arxiv.org/abs/2508.06097

### 1d. Straight-through estimator lineage (Bengio 2013; BinaryConnect/BNN 2015-2016)

This is the lineage that fits the **existing** `boolean` atom directly.

| Aspect | Detail |
| --- | --- |
| Relaxation form | None on the forward pass. Forward stays the **hard threshold/sign**; only the backward pass substitutes a surrogate. |
| Surrogate shape (vanilla STE) | Backprop through the hard threshold "as if it had been the identity function" — `∂L/∂z = ∂L/∂z_b`, gradient passes unchanged. "It is clearly a biased estimator" but low-variance and works well in practice (Bengio 2013). |
| Surrogate shape (clipped STE / BinaryConnect) | Identity backward **masked by saturation**: gradient = `1·[|z| ≤ 1]`, i.e. the derivative of `hardtanh`. Stops gradient when the pre-threshold score is far outside the decision band — the standard BNN trick (Courbariaux/Hubara). |
| Slope-annealed variant | Bengio 2013: train a soft sigmoid and "gradually anneal the magnitude of the parameters, turning soft-output easy-to-train units" into hard threshold units — i.e. sharpen the sigmoid toward a step over training. |
| Temperature schedule | The "temperature" = sigmoid slope; anneal slope up (band narrows) over training. |
| Init | n/a (no gate parameter); the affine score feeding the threshold is initialized by the surrounding network. |
| Known failure modes | Bias grows when the score sits far from the threshold (vanilla STE keeps pushing); clipping fixes the worst of it. High-variance for stochastic variants; STE preferred for its low variance despite bias. |
| URL | Bengio 2013 https://arxiv.org/abs/1308.3432 · BinaryConnect https://arxiv.org/abs/1511.00363 · BNN/Hubara https://arxiv.org/abs/1602.02830 |

### 1e. Surrogate gradients in spiking networks (Neftci, Mostafa, Zenke 2019)

Surrogate-shape guidance for the `boolean` backward. Forward is always the hard
Heaviside threshold; the backward derivative is replaced by one of:

| Surrogate | Backward derivative | Default param | Notes |
| --- | --- | --- | --- |
| Straight-through | `1` (constant) | — | The unclipped baseline. |
| Boxcar / rectangular | `1·[|x| < w]` | window `w` | = clipped STE; gradient only inside a band. |
| Triangular | `max(0, 1 − |x|·k)` | threshold 1 | Linear falloff; cheap. |
| Sigmoid′ | `k·e^{−kx}/(1+e^{−kx})²` | slope `k=25` | Smooth bump at threshold. |
| Fast-sigmoid / SuperSpike | `1/(1 + k·|x|)²` | slope `k=25` | Heavy tails, cheapest smooth option; Zenke & Ganguli. |
| ArcTan | `(1/π)·1/(1+(π·x·α/2)²)` | `α=2` | snntorch default family. |

Headline finding (Neftci 2019; Zenke & Vogels 2021 "remarkable robustness"):
the **exact shape barely matters** — training is robust across boxcar / sigmoid /
triangle / fast-sigmoid as long as the surrogate is (i) centered on the
threshold, (ii) bounded, and (iii) has the right slope/width. Slope is the one
parameter that matters; too sharp = vanishing gradient, too wide = the surrogate
stops resembling the hard function.
URLs: https://arxiv.org/abs/1901.09948 ·
https://snntorch.readthedocs.io/en/latest/snntorch.surrogate.html ·
robustness study https://direct.mit.edu/neco/article/33/4/899/97482

---

## 2. Three-stage adoption plan (this repo's actual API)

All three stages reuse the `trainable-geometry.ts` optimizer pattern: params are
**source cells**, the loss produces `outputGradients` over wires,
`circuit.backpropagateReference(values, outputGradients)` returns source
gradients, and the same Adam loop (lines 585-611) steps them. Only the `boolean`
backward rule and (stage 2/3) the circuit construction change.

### Stage 1 — STE / surrogate backward through existing `boolean` atoms

Goal: let gradients flow through `boolean` so any loss downstream of a decision
can train the affine score feeding it. The forward pass is **unchanged** (exact
round-to-bit). This aligns with the parallel `exp-ste-backprop.ts`.

The fix is in the surrogate backward pass (the parallel `exp-ste-backprop.ts`
exposes `backpropagateSurrogate` with modes `'ste'` and `'sigmoidSte'`, both
centered at the `0.5` decision boundary; this plan adds clipped STE / fast-sigmoid
as further options and keeps the naming). The `boolean` op stores `leftTerms` =
the score affine (`numeric-ui-core.ts:91`). Below, `'ste'` = identity backward
(Bengio baseline); `'sigmoidSte'` = scale by `sigmoid'(temperature·(score−0.5))`
(already implemented); the boxcar/fast-sigmoid variants are the Neftci-family
additions. The score is already in `[0,1]` with threshold `0.5`, so the band is
naturally around `0.5`.

```ts
// inside the backward loop, replacing the boolean throw:
if (operation.kind === 'boolean') {
  // forward was: bit = score >= 0.5 ? 1 : 0   (exact, unchanged)
  const score = evaluateTerms(values, operation.leftTerms, operation.leftBias)
  // surrogate slope: how wide a band around 0.5 passes gradient.
  // boxcar/clipped-STE (Bengio/Courbariaux + Neftci robustness):
  const surrogate = Math.abs(score - 0.5) <= surrogateHalfWidth ? 1 : 0
  // alternative fast-sigmoid (Zenke): surrogate = 1 / (1 + k*Math.abs(score-0.5))**2
  accumulateTermGradients(
    gradients,
    operation.leftTerms,
    Math.fround(outputGradient * surrogate),
  )
  continue
}
```

Recipe choices, justified by section 1d/1e:

- **Surrogate**: clipped STE (boxcar) `surrogateHalfWidth ≈ 0.25` (i.e. pass
  gradient when score ∈ [0.25, 0.75]) as the default; or fast-sigmoid with `k`
  tuned so the band is comparable. Shape is not critical (Neftci robustness);
  start boxcar for simplicity and exact-zero gradient outside the band.
- **Slope annealing** (Bengio): optionally shrink `surrogateHalfWidth` over
  training so late training matches the hard function — only if early training
  is too biased. Likely unnecessary given short horizons here.
- **Optimizer / clamp**: unchanged from `trainable-geometry.ts` — Adam,
  global grad-norm clip, `[-6,6]` source clamp.

Atom cost: **zero**. No new atoms; only the backward pass changes. The forward
circuit, compilation, and FP32 results are byte-identical (this is exactly what
`boolean-state.md` line 22-23 anticipates: "its backward pass may use a surrogate
gradient; that does not change the exact forward result").

What stage 1 buys: any single-frame decision whose downstream loss is
differentiable becomes trainable end-to-end. It does **not** make the *choice of
which comparison* feeds the boolean trainable (that is stage 2), nor multi-frame
latching (needs stage-3 recurrence handling).

### Stage 2 — relaxed predicate mixtures (which comparison feeds a boolean)

Goal: make *which predicate* drives a decision a trainable, annealable choice.
E.g. "is the pointer inside the title bar?" might be `pointerY < barBottom` vs
`pointerY < barBottom + slack` vs a different edge — currently authored, here
learned. This is the Petersen idea applied to **comparison selection**, not full
gate selection.

Construction: build `k` candidate score expressions `s_1..s_k` (each an
affine/reglu sub-circuit already in `[0,1]`), then form a soft mixture before the
hard `boolean`:

```ts
// candidate scores s_1..s_k are wires in [0,1].
// mixture weights from k trainable source cells (logits) via a softmax macro.
// During training: feed the SOFT mixture forward so gradients reach every s_i
//                  AND the logits. The boolean's STE (stage 1) handles the final
//                  threshold.
// Annealing: sharpen the softmax (raise its inverse-temperature) over training
//            until it is ~one-hot, then the winning predicate alone feeds boolean.
const mixed = circuit.affine(
  candidateScores.map((s, i) => [emitMultiply(circuit, softmaxWeightWire(i), s), 1]),
)
const bit = circuit.boolean(mixed)   // mixed stays in [0,1] since weights sum to 1
```

Honest atom cost of a k-way mixture (per decision site):

- `k` candidate score sub-circuits — cost = whatever each predicate costs
  (these may already exist; the *extra* cost is the ones you add as
  alternatives).
- softmax over `k` logits: exp is not an atom here, so a softmax macro must be
  expanded. A practical normalized-weight macro costs on the order of **k
  multiplies + (k−1) adds for the numerator blend, plus the normalization**.
  Division is not a primitive (see `tricks.md` "Dynamic division" — unvalidated),
  so the cleanest path is to **bake the softmax on the parameter side** (compute
  weights from logits in JS during training as part of the source table, like
  `trainable-geometry.ts` keeps params in source cells) rather than expanding a
  runtime softmax. Then the runtime circuit cost is just the **k multiplies + (k−1)
  adds** of the blend (`reglu`/`affine` atoms), and the softmax lives in the
  trainer, not the compiled circuit.
- After annealing to one-hot and discretizing, the mixture **collapses to the
  single winning predicate** — runtime atom cost returns to ~1 score path + 1
  boolean. So the blowup is a *training-time* cost, not a deployed-circuit cost,
  provided you prune to the argmax predicate (mirrors Petersen's discretization).

Net: training-time `+O(k)` atoms per decision site; deployed-time `~0` after
argmax pruning. Anneal the softmax (stage-2 temperature) the same way DLGNs rely
on the softmax converging to near-one-hot.

### Stage 3 — trainable circuit structure (DLGN), honest blowup

Goal: stop authoring the circuit and instead learn *which operation* each node
performs, à la Petersen. Each trainable node becomes a **soft mixture over a gate
set**, with random fixed fan-in, trained then discretized.

This repo's atoms are arithmetic, not Boolean LUTs, so a node is built two ways:

- **Boolean-gate nodes** (operating on bits that came out of `boolean`): expand
  the relevant subset of the 16-gate table from section 1a as affine/reglu. Each
  gate relaxation is 1-3 atoms (`AND=a·b` is one `emitMultiply`; `XOR=a+b−2ab`
  is a multiply + an affine). A soft mixture over `m` gates = the `m` gate
  sub-circuits + a baked-softmax blend (as in stage 2).
- **Pass-through / residual** must be in the gate set and **initialized hot**
  (Petersen 2024 residual init: logit ≈ 5 on 'A', ~0 elsewhere → ~90% identity)
  or deep stacks vanish (gradient ×0.1-0.2 per layer; section 1b).

Honest atom-count blowup. Let the deployed circuit want `N` trainable nodes, fan-in
2, mixture over `m` gates (full set `m=16`, but 4-8 is usually enough):

- Per node during training: `m` gate relaxations × (1-3 atoms each) + blend
  ≈ **`2m` to `4m` atoms per node**, vs **1 atom** after discretization.
- So a structure-learning circuit is roughly **8×-64× larger during training**
  than the gate net it compiles to (with `m=4..16`). For reference the current
  fused program is 2,933 activations (`README.md`); a from-scratch structural
  search over even a few hundred nodes at `m=8` is tens of thousands of training
  activations — feasible to train offline, then **discretized to argmax gates**
  and recompiled to roughly the authored size.
- Connections (fan-in wiring) stay **random and fixed** per Petersen — learning
  wiring too is not attempted here (it is the expensive open problem).

Deployed cost after argmax + pass-through-pruning ≈ the size of an authored
circuit. The blowup is entirely a training-time phenomenon, as in DLGN.

---

## 3. When this breaks

### Known instabilities (from the literature, expected to recur here)

- **Vanishing gradients at depth** (Petersen 2024): washed-out gate softmaxes
  push activations to 0.5 and decay gradients ×0.1-0.2 per layer; only **residual
  init** (hot pass-through gate) trains past ~6 layers. Any stage-3 stack needs it.
- **Surrogate slope sensitivity** (Neftci 2019): too-sharp `boolean` surrogate →
  no gradient; too-wide → surrogate stops matching the hard forward and the model
  trains for the wrong function. Shape is robust, slope is not.
- **STE bias** (Bengio 2013): vanilla STE keeps pushing scores already far past
  the threshold; clip (boxcar) to bound it.
- **Temperature cliffs** (Recurrent DLGN): GroupSum `τ=0.25` caused outright
  training failure where `τ=1` worked; **learning-rate cliffs** — `lr 0.001`
  failed, `0.05-0.1` worked. Expect the analogous loss-shaping/lr to be the most
  fragile knobs, not the surrogate.
- **Discretization gap**: soft → hard argmax only matches if the softmax actually
  converged near one-hot. If it did not, the deployed circuit silently diverges
  from the trained one. Monitor max-softmax-mass before discretizing.

### The recurrence problem (multi-frame behavior, BPTT across `nextSource`)

Multi-frame behaviors are recurrent: the loss at frame `t` depends on decisions
made at frames `< t` through the `nextSource` writeback. Stage-1 STE only fixes
the *single-frame* gradient. To train behavior that spans frames you must
**unroll the writeback loop and backprop through time**, exactly as DiffLogic CA
does over 12-20 CA steps with loss at the final step.

Concretely, the trainer would: run `T` frames feeding each frame's `nextSource`
wires into the next frame's source table (the loop already exists at
`window-manager.ts:982-1009` / `photo-gallery.ts:533-560`), accumulate the
gradient backward across all `T` copies, and step Adam once. Risks specific to
this repo:

- **The latched state itself passes through `boolean`.** `open`, `focused`,
  `maximized`, drag/resize ownership are stored as exact bits and re-enter as
  source the next frame (`window-manager.ts:994-1002`). So BPTT crosses a
  `boolean` *every frame* — the STE surrogate (stage 1) is a prerequisite, and
  the per-frame bias compounds over `T`. Keep `T` short (DiffLogic CA stays at
  12-20) and consider clipped STE to bound compounding bias.
- **Source-range validation.** `validateSourceRanges` (`numeric-ui-core.ts:199`)
  asserts every fed-back value is inside its assumed range; soft/relaxed states
  during training can stray outside `[0,1]` and trip it. Training would need a
  relaxed-range mode or to clamp fed-back states.
- **No async escape hatch yet.** DiffLogic CA's main stabilizer for long
  recurrence is asynchronous updates (60% of cells/step). The analogue here would
  be updating a random subset of windows/state per frame during training — not
  currently a runtime concept.

### Which repo behaviors are learnable at each stage

- **Focus latching** — pick the focused window, hold it across frames until a
  click elsewhere. The *pick* (argmax over a focus score) is single-frame and
  learnable at **stage 1** (STE through the focus `boolean`). The *latch* (state
  persists via `nextSource`) is multi-frame and needs **stage-3 / BPTT** to learn
  the keep-vs-switch rule end-to-end; without BPTT the persistence must stay
  authored and only the per-frame score is trained.
- **Stacking permutation** — the z-order is a permutation updated per click. A
  single reorder step (move clicked window to front, others shift) is a
  selection + shift, single-frame, plausibly **stage 1-2** (stage 2 if *which*
  comparison defines "clicked-on-top" is itself learned). The full permutation
  *maintained over a session* is recurrent → **stage 3 / BPTT**, and is the
  hardest because the state is a structured permutation, not a few bits.
- **Drag ownership** — "this window owns the pointer until release" is inherently
  multi-frame (ownership set on press, held across moves, cleared on release via
  `nextSource` drag bits, `window-manager.ts:1001`). The press/release *decisions*
  are single-frame (**stage 1**), but ownership *persistence* is recurrent →
  **stage 3 / BPTT** to learn the hold rule. Most BPTT-dependent of the three.

Summary: every per-frame *decision* in these behaviors is reachable at stage 1
(plus stage 2 if the predicate is also learned); every *persistence/latch* across
frames requires the stage-3 BPTT-through-`nextSource` machinery, kept to short
horizons with a clipped surrogate to limit compounding bias.

---

## Sources

- Petersen et al., Deep Differentiable Logic Gate Networks (NeurIPS 2022):
  https://arxiv.org/abs/2210.08277 · code https://github.com/Felix-Petersen/difflogic
- Petersen et al., Convolutional Differentiable Logic Gate Networks (NeurIPS 2024):
  https://proceedings.neurips.cc/paper_files/paper/2024/file/db988b089d8d97d0f159c15ed0be6a71-Paper-Conference.pdf
- Miotti et al., Differentiable Logic Cellular Automata (arXiv 2506.04912, 2025):
  https://arxiv.org/abs/2506.04912 · https://google-research.github.io/self-organising-systems/difflogic-ca/
- Recurrent Deep Differentiable Logic Gate Networks (arXiv 2508.06097, 2025):
  https://arxiv.org/abs/2508.06097
- Bengio, Léonard, Courville, Estimating or Propagating Gradients Through
  Stochastic Neurons (2013): https://arxiv.org/abs/1308.3432
- Courbariaux, Bengio, David, BinaryConnect (2015): https://arxiv.org/abs/1511.00363
- Hubara et al., Binarized Neural Networks (2016): https://arxiv.org/abs/1602.02830
- Neftci, Mostafa, Zenke, Surrogate Gradient Learning in SNNs (2019):
  https://arxiv.org/abs/1901.09948 · snntorch surrogates
  https://snntorch.readthedocs.io/en/latest/snntorch.surrogate.html
- Zenke & Vogels, robustness of surrogate gradients (2021):
  https://direct.mit.edu/neco/article/33/4/899/97482
