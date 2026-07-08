# Shared context for lab experiments (July 2026)

You are building a serious experiment for the `indirect` repo. This document carries the context you need from a long design conversation with Cheng (the author) that you were not part of. Read it fully, then read your specific brief.

## The project

`indirect` tests whether an interactive UI can compile into one fixed numeric program: browser inputs go into a flat `Float32Array` (the source table), one compiled circuit runs, outputs project onto the DOM. Three atoms: `affine` (weighted sum plus offset), `reglu` (one affine value times ReLU of another), `boolean` (a score in 0..1 rounded to an exact bit via an FP32 rounding step). Macros (multiply, min, max, springs, argmax, hit tests) expand into those atoms at build time. Every arithmetic step is FP32 (`Math.fround`). The literal instruction interpreter defines correctness; the compiled tensor backend must produce the same FP32 value for every wire (differential tests enforce this).

The keystone claim: state AND behavior both live as numbers in one source table, flowing through one compiled circuit. Editing a behavior cell and gradient-descending it are the same operation. Changing behavior needs zero recompilation.

Files to read before designing (all in the repo root):
- `README.md` — overview, current program stats
- `execution-model.md` — exact instruction and layer semantics
- `tricks.md` — the trick catalog, including the three exact decision-bit constructions
- `macro-ranges.md` — FP32 magnitude preconditions
- `parallel-winner.md` — argmax tree selection
- `agents.md` — REQUIRED: tone rules for all comments, docs, names you write
- `numeric-ui-core.ts` — circuit construction, compilation, execution, reference backprop
- `window-manager.ts`, `photo-gallery.ts`, `candidate-gallery.ts`, `trainable-geometry.ts`, `learned-gallery.ts` — the production circuits and the trained-geometry precedent
- `todo.md` — includes the hardAttend (dynamic lookup) analysis

## HARD RULE: do not read the exp/ folder

The repo has an `exp/` folder of earlier experiments. You must NOT read anything in it. Cheng's instruction: those were "neat little poetic toys, not enough engineering and grounding and not even the best explorations," and reading them would anchor your design. Everything durable from them already lives in the committed docs (`tricks.md`, `todo.md`), which you may read freely. Design fresh.

## Cheng's goals

1. Generative UI: use these circuits to interpolate between UIs that were never exactly specified.
2. Apply neural methods to the substrate and explore seriously.
3. A side fascination: rediscovering mechanisms like recurrence and attention at small scope, fully exact and fully interpretable.

## Established conclusions from the design conversation (take these as given)

1. UI is a recurrent data transformation: `f(state, input) -> (state, output)`. The DOM is a peripheral for visual familiarity. Reducing UI to compiled data transformation is sound.
2. Specialness enters as data fields, never as forked code. Keep one shared per-slot function (the instancing trick — this is weight sharing, the equivariant form) and express "the hero photo," priorities, groupings as per-slot input cells (e.g. an importance value in 0..1). A field is editable at runtime, trainable by gradient, and interpolable; a special-cased code path is none of those. Even tie rules follow this: leftmost-wins means the slot index enters as the tiebreaking field. All asymmetry enters as declared input fields.
3. Fields interpolate; structures don't. Categorical knobs (one-hot mode bits) create invalid configurations mid-interpolation; continuous fields consumed by a shared function pass through valid intermediates. Push design from structure into fields wherever possible.
4. Validity is self-scored coherence. The circuit can compute validity outputs about its own configuration (no overlap, containment, exactly-one-winner). Generative work should use these as hard constraints: interpolation and search project back to validity rather than hoping data volume produces coherence.
5. The right unit for generative UI is the macro/relation/field level. Dense weights trained on UI data average modes into mush; whole templates cap generation at the template vocabulary (Flipboard's ceiling). Prior art: Flipboard's Duplo engine — designer layouts expanded into 2,000–6,000 candidates, a fitness function of dozens of weighted heuristics (text density, frame fill, crop limits, Perlin noise for pacing), branch-and-bound selection. The repo's candidate gallery is a 3-candidate version of this with the scorer inside the circuit.
6. Discrete multi-frame behavior wants the transformer treatment, not recurrence. An input event is a query against the previous frame's snapshot (the user clicked what they SAW). A drag is fully determined by a latched grab event plus the live pointer — no per-frame integration. A latch is attention with one slot: a write gate that fires on an event, a value that persists, a read every frame. Store a small bounded window of latched events (plus the interaction geometry that was live when each fired), and multi-frame behavior becomes a pure feedforward function of (current input, event window) — trainable WITHOUT backpropagation through time. Genuine recurrence remains only for continuous animation (springs), where it is smooth and benign.
7. Integer-score decisions need no boolean atom: when a hardened score is an integer count, `clamp01(score) = relu(score) - relu(score - 1)` is already the exact bit, the plain reference backward pass trains it (no surrogate gradient), and it survives narrower float formats. The boolean atom remains only where genuinely continuous quantities are thresholded (pointer hit tests at 0.5, argmax tie-margin comparisons). See `tricks.md` "Decision bits."
8. Train soft, run exact: relax discrete cells to [0,1] during training, harden by rounding, verify bit-exactness through both evaluators. This recipe is validated in this repo. Softmax over stored logits, baked into source cells on the parameter side (the trainer owns any division), sharpened over training, hardened to argmax, is the validated approach for trainable selections.
9. A JS-to-circuit compiler for arbitrary code is a dead end (the high-level-synthesis lesson), but Cheng's own vibescript style is unusually close to the substrate: one render tick, batched reads/writes, centralized numeric state, fixed-step springs, clamp helpers, range annotations as `@fit` comments. The viable route is tracing (staging): run a render tick with recorded numbers, reconstruct dataflow, emit a circuit — with select-style conditionals for data-dependent branches, and capacities/encodings declared or decided by judgment. Reference docs: `~/github/vibescript/docs/ui.md`, `~/github/vibescript/docs/engineering.md`; real demo: `~/github/chenglou.github.io/index.ts`.
10. Dynamic lookup (reading a large collection at a runtime index) currently costs work proportional to collection size per read via one-hot indexing. The design decision (see `todo.md`): no fourth atom; instead declared group invariants ("these wires are an exact one-hot") plus compiler idiom recognition that lowers one-hot-masked sums to a gather operation in the tensor executor, provably FP32-identical.
11. Text measurement is solved in userland by Cheng's `pretext` library (`~/github/pretext`, npm `@chenglou/pretext`): `prepare()` measures text segments once via canvas; `layout()` is pure arithmetic over cached widths. Text-bearing layout can therefore be pure numbers (and a fitness function can score text fill without DOM reflow).
12. Percepta (percepta.ai) compiled a WebAssembly VM into standard transformer weights using exactly two gate families: LookUp (attention, exact key-value retrieval via parabolic key encoding) and ReGLU (feed-forward). Their scheduling is a mixed-integer program minimizing peak live values; their exact bits are ReLU differences over integer-valued wires; softmax approximates hard-max with exponentially small error when scores are scaled. PDFs: `~/Downloads/Can LLMs Be Computers? | Percepta.pdf` and `~/Downloads/Constructing an LLM-Computer | Percepta.pdf`. Their code: github.com/Percepta-Core/transformer-vm.
13. Read `lab/briefs/talk-repeatable-breakthrough.md` — Cheng's talk. Its pattern (smaller unit of composition -> granularity gap -> emergent controllable behavior) and its warning against premature compression are design guidance for everything here.

## Engineering bar (this is the point)

Cheng's verdict on prior experiments: poetic toys, not enough engineering and grounding. Yours must be different:

- Ground truth: every claim verified by tests. Differential exactness (reference vs compiled tensor evaluator) for any circuit you build. Oracle grounding where a JS reference exists (write one if your brief calls for it). Property-based/randomized testing over long input traces, not three hand-picked cases.
- Metrics, not adjectives: report numbers in tables (op counts, stored weights, layer depth, success rates across seeds, timing where relevant). State what was measured and how.
- Honest failure reporting: if part of the design fails, document the failure precisely — a well-characterized failure is a finding. Do not soften results.
- Scale beyond toy: prefer 16+ slots, thousands of randomized trials, long traces — whatever "this would survive contact with a real UI" means for your brief.
- Style: follow `agents.md` exactly in all comments, docs, and names. No invented jargon. No hard line breaks in markdown you write.
- Conventions: 2-space indent, no semicolons, single quotes, non-null assertions where the repo uses them. `bun test lab/<yourFolder>` must pass. Create `lab/<yourFolder>/tsconfig.json` extending the root config with `"include": ["*.ts"]` scoped to your folder and make `bunx tsgo -p lab/<yourFolder>` pass, plus `bunx oxlint --type-aware lab/<yourFolder>`.

## Boundaries

- Write ONLY inside `lab/<yourFolder>/` (your brief names it). Exception: only if your brief explicitly grants it (the compiler brief touches `numeric-ui-core.ts`).
- Do not commit. Leave everything in the working tree.
- Do not modify `package.json`, root `tsconfig.json`, or any production file unless your brief grants it.
- Never read `exp/`.
- Deterministic seeds for anything random (the repo's LCG pattern: `Math.imul(state, 1_664_525) + 1_013_904_223`).

## Resources

GPU compute is available if you genuinely need it: a private note documents a GPU platform. These four briefs are expected to be CPU-comfortable; reach for GPUs only if your training genuinely outgrows the machine.

## Deliverables

`lab/<yourFolder>/` containing implementation, tests, and a `README.md` with: what was built, the design decisions and why, how every claim is verified, metrics tables, failures and limits, and next steps. Your final message back should be the condensed version of that README with the key numbers.
