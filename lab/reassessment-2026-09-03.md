# Reassessment, September 3, 2026

This note records the findings before implementation. The follow-up fixes and experiments are tracked in [current status](status.md); the original observations below remain as history, not descriptions of bugs still present.

## Bottom line

Keep the smaller numeric representation and the ambition to learn useful computation. Change what we treat as established, and make the next experiment test a rule that works on new situations rather than another configuration fitted to one situation.

The most encouraging finding is concrete: the last learned-interpreter experiment does not need a new architecture to recover two operations. Changing only the scale of its optimization objective reverses the reported failure. The most concerning finding is also concrete: some correctness checks compare implementations that share the same mistake.

This was a reassessment, not a production refactor. Existing implementation files and unfinished July edits were left untouched. The only repository additions are this note and the standalone reproduction script linked below.

## What I reviewed

I traced the relevant June and July Claude conversations, this conversation's experiments, the original June Codex design discussion, and the related "Explain reglu" and "Explore fp32 nonlinear logic" tasks. I read the project documentation, the talk, and the current vibescript engineering guidance. Three independent audits covered the learned interpreter, generative fields and event window, and numeric execution and compilation. I independently reran the decisive numerical, compiler, gradient, and event counterexamples. Neither I nor the reviewers read `exp/`.

The long original Codex discussion was reviewed selectively around the design decisions, not exhaustively message by message. Historical conversation claims were treated as hypotheses, including those written by the earlier Codex agent in this task.

## The learning result changes

The hard-program experiment already computes a table of losses for all 3,600 programs. Training learns separate probabilities for the first and second instructions using that table. The previous report found 0/20 successes for both tasks and proposed moving to structured discrete search.

Multiplying every table entry by the same positive constant leaves the correct programs and the optimization problem unchanged. Nevertheless, it changes this optimizer's behavior substantially:

| Loss multiplier | Two adds, exact on training grid | Coordinate transform, exact on training grid |
| --- | ---: | ---: |
| 1 | 0/20 | 0/20 |
| 10 | 0/20 | 0/20 |
| 100 | 3/20 | 0/20 |
| 1,000 | 4/20 | 0/20 |
| 10,000 | 9/20 | 20/20 |
| 1,000,000 | 20/20 | 20/20 |

These are my reruns with seeds 3001-3020. The reviewer separately obtained 20/20 for both tasks on the original seeds 1001-1020 and fresh seeds 2001-2020 at the largest multiplier. The reviewer's ten distinct resulting programs also passed 371,880 existing certification cases through both evaluators.

The original losses are already divided by `256 squared`. Adam then adds `1e-8` in its denominator. That numerical safeguard becomes significant when the gradients are tiny. Scaling all gradients by a positive factor `c` scales Adam's first moment by `c` and its second moment by `c squared`, so the update is mathematically equivalent to replacing epsilon with `epsilon / c`, apart from numerical rounding. The experiment changed the cached losses, not epsilon directly. See [the update](learned-interpreter/discrete-training.ts).

This supports a narrower and more useful conclusion: **separate instruction choices can recover composition in this experiment; the old 0/20 result was not sufficient evidence to abandon them.** It does not show that the method scales. The full loss table still enumerates every complete program. The earlier trainer that averages intermediate outputs is a different method; its failures are not resolved by this result.

There are two further qualifications:

- The supposed twelve equivalent two-add programs are equivalent on the small integer test domain, not arbitrary FP32 values. For `pointerX = 1`, `panelLeft = 2^-24`, and `distractor = -1`, the prescribed `(pointerX + panelLeft) + distractor` gives zero after FP32 rounding, but `(panelLeft + distractor) + pointerX` gives `2^-24`. A real trained run, seed 441 in the add-only control, produces the latter ordering. [Certification inputs](learned-interpreter/oracle.ts).
- The oracle currently rounds arithmetic results but not the incoming JS numbers. The circuit rounds inputs when storing them in `Float32Array`. For `pointerX = 1 + 2^-24`, `panelLeft = 1`, and `scale = 1`, the oracle returns `2^-24` while the authored circuit returns zero. Normalize inputs consistently before adding fractional tests. [Oracle](learned-interpreter/oracle.ts).

The primitive and missing-intermediate controls remain useful. They establish that individual operations are learnable and that the intermediate is necessary. They do not, by themselves, identify the mechanism causing optimization failure. Likewise, the old explanation that multiplication helps by amplifying gradients is a hypothesis, not an established result.

## Correctness findings

### 1. Range analysis can invalidate compilation

The core computes interval bounds using ordinary JS arithmetic, while execution rounds individual operations to FP32. Near a rounding boundary, a calculated bound can exclude a value that execution actually produces. The compiler then trusts the wrong bound when simplifying `floor`.

Concrete example: let `x = 1 - 2^-24` and `y = 2^-25`, with declared ranges from zero to those values. Compiling `Math.floor(x + y)` produces constant zero. Under the compiler's intended FP32 arithmetic, the addition rounds to one, so the result should be one. [Range calculation](../numeric-ui-core.ts), [floor simplification](trace-compiler/compile.ts).

The same issue breaks the gather guard. Select the first value from `[5, x * 2]`, where `x = fround(3e38)` and its declared range is `0..3.4e38`. The inferred upper bound of the product is `6.8e38`, a finite JS number but beyond finite FP32. The reference returns `NaN` because the unselected overflowing value is multiplied by zero; the lowered gather returns five. All source values satisfy their declared contracts. [Finiteness guard](../numeric-ui-core.ts).

This is a correctness problem for the claimed domain, not evidence that ordinary-sized gallery inputs currently overflow. The fix should model rounding in operation order and possible nonfinite results. Merely checking the final float64 endpoints for finiteness is insufficient.

### 2. The compiler's oracle can share its mistakes

This function returns three in native JS at `x = 2`:

```js
function example(x) {
  if (true) { return x + 1 }
  return x + 2
}
```

The compiled version returns four. Its harness nevertheless reports zero mismatches and zero float64 drift. Both modes of the source interpreter share the compiler's mistake: a copied block context loses the return. [Compiler](trace-compiler/compile.ts), [interpreter](trace-compiler/twin.ts).

The reviewer also reproduced unmasked mutations in an untaken ternary branch and nullable equality being incorrectly treated as a null test. Those constructs should be implemented correctly or rejected explicitly. [Ternary](trace-compiler/compile.ts), [nullable equality](trace-compiler/compile.ts).

The highest-value verification change is native execution of the original JS to validate source semantics independently. Then measure intentional FP32 differences separately. Agreement between several interpreters is useful, but not a substitute for this independent check.

### 3. Some gradients are wrong for the intended calculation

For the real multiplication function, the derivative of `3 * variable` with respect to `variable` at zero is three. `emitMultiply` expands signed multiplication into two ReLUs, and the chosen zero-slope convention at their shared corner makes the backward pass report zero. Reversing the operand order gives three. I reproduced both results and checked finite differences. This is a problem with differentiating the expansion, not the forward multiplication. Its contribution to the soft interpreter's failures has not yet been measured. [Multiplication expansion](../numeric-ui-core.ts).

The layout score also has missing derivatives. Padding and importance affect the score directly as well as through the generated geometry, but the backward pass seeds only the geometry route. Isolating fill ratio, a padding perturbation gives a finite-difference slope of approximately `4.3e-8`, while the implemented gradient is `-0.00144`. This is separate from the intentionally approximate gradients through decisions. [Score](generative-fields/fitness.ts), [gradient seeding](generative-fields/optimize.ts).

As in ordinary ML systems, these derivative statements refer to the intended real arithmetic, not derivatives of literal rounding steps.

### 4. The event demo drops information that behavior needs

The demo replaces consecutive pointer moves with the final move. Press, move twenty pixels away, return to the starting point, and release: the complete sequence cancels the click, but the compressed sequence toggles maximization. The oracle receives the same compressed sequence, so its agreement counter misses the bug. I reproduced this independently. [Move compression](event-window/demo.ts).

Retain the moves, or retain enough information to know whether the pointer crossed the drag threshold. This is a concrete example of why a shorter event history is only sufficient for behavior whose required information it preserves.

### 5. Smaller issues worth fixing alongside those

- `emitSelect` is documented as exact for any finite operands, but its `off + bit * (on - off)` expansion can overflow the subtraction. With `off = fround(3e38)`, `on = fround(-3e38)`, and `bit = 0`, it returns `NaN`. The trace compiler already uses a two-product form that avoids this particular overflow. [Guarantee](../macro-ranges.md).
- The real-file compiler experiments read a mutable file in another repository. Three selected tests now fail because `clamp` changed, a column calculation includes `console`, and `springStep` no longer exists there. Keep the measured source revision as a fixture; make compatibility with the latest external source a separate test. [Source loading](trace-compiler/real-slice.ts).
- Root type checking and linting include root files and `exp/*.ts`, not the new labs. The labs have separate checks, but there is no single command covering the supported code. [Package scripts](../package.json), [TypeScript configuration](../tsconfig.json).

## What the UI results actually establish

The generative-fields experiment really does find and repair configurations of its fixed layout algorithm. But the meaning of success is weaker than the narrative suggested:

- Of 4,154 repairs in the original study configuration, 1,408 hid previously visible items. One removed ten of sixteen items. Visibility is an adjustable field, so this is allowed by the experiment, not an implementation error. It is nevertheless a major limitation if the intended task is to lay out required content.
- Tiny continuous input changes can cause large position changes. Changing a width fraction from `0.239749` to `0.239751` moved one item from approximately `(965.55, 24)` to `(24, 98)`. Both layouts were valid. Wrapping and sorting still make discrete decisions.
- The demo sometimes replaces an invalid intermediate with a nearby saved sample. Validity of the sampled points does not establish a continuous valid path between them. [Fallback](generative-fields/demo.ts).
- Text fitting is measured afterward, not optimized. Containment also has tolerance: the reviewer found a valid item extending to `1282.56` in a `1280`-pixel viewport. Those definitions should be visible in the report, rather than hidden behind one validity bit.

The event experiment has a different positive result: six shared behavior parameters can be learned and reused on new event sequences and geometry. Eight fresh reviewer runs recovered the behavior across 320,000 verification frames. The demo's sliders are manually controlled parameters, however; the demo does not load those newly trained runs.

Training uses correct internal state and directly supervised decisions. That is why it can use one-step examples instead of following gradients through the history. Positions, focus, maximization, and press state still persist between steps. Event-triggered updates do not eliminate learning from delayed consequences when the model's own earlier decisions affect later states. The extra event archive is currently not consulted by behavior. [Training data](event-window/train.ts), [persistent state](event-window/circuit.ts).

## Claims to retire

The old shared brief labels several speculative conclusions "take these as given." That is the most important documentation cleanup: it passes yesterday's interpretation to tomorrow's agents as a constraint. [Shared brief](briefs/context-shared.md).

| Earlier claim | Better statement |
| --- | --- |
| Continuous fields interpolate through valid UIs. | Numeric interpolation is easy; preserving content, validity, and continuity requires separate evidence. |
| Dense training necessarily averages layouts into incoherence. | Some output representations and losses average incompatible solutions. That is not a general limitation of neural models. |
| Symmetry forces attention, and repeated slot functions are convolution. | Shared functions can respect permutations if all relevant data, including identity and tie rules, travel with the items. Attention is one possible mechanism; convolution is a more specific operation. |
| A latch is attention with one slot, so the event formulation removes recurrence. | A latch is persistent state. There is a useful analogy to memory access, but no automatic removal of temporal dependencies. |
| Behavior cells are fast weights because they are inputs. | A learned parameter remains a parameter wherever it is stored. "Fast" describes how it changes, not which array holds it. |
| Removing the boolean atom makes exact choices directly trainable. | The hard cascade's useful score gradients remain absent. The successful experiment trains softened circuits and then hardens them. |
| Gather lowering discovered hard attention. | It recognized retrieval after a selection was already represented. It neither learned query/key scoring nor made an entire attention operation constant-time. |
| The fixed circuit can express any behavior without recompilation. | It can express the family supported by its inputs, operations, and capacity. A programmable interpreter widens that family but still has a resource limit. |
| Compiling ordinary source is a dead end. | Compiling a defined numeric subset is feasible, as the current AST-based compiler itself demonstrates. Dynamic allocation, unbounded sizes, side effects, and precision contracts are the difficult parts. |
| A live-value peak in the present schedule is a universal scheduling lower bound. | It is a property of that schedule unless a separate argument establishes a bound over all schedules. |

The sign cascade remains an interesting exact forward construction within its numeric assumptions. Its training result uses soft versions and fits per-example score cells; it does not demonstrate a learned query/key rule for unseen examples. The reviewer measured zero hard score gradients for separated scores, ties, and the smallest subnormal difference, with nonfinite intermediate gradients in some cases. [Soft training](cascade-argmax/training.ts).

The gather optimization also remains useful. The fresh audit found 22 candidate-gallery reads and 12 window-manager reads, with approximately 1.29x and 1.03x speedups. The executor scans the one-hot bits once per group, stores candidate-index tables, and still computes candidate values. These are serial JS measurements, not GPU measurements.

## Better next experiments

### 1. Finish the numerical diagnosis before replacing the learner

Expose loss normalization and Adam epsilon as explicit settings. Verify the direct epsilon change against the equivalent scaling probe. Include the same fractional FP32 cases in the oracle, training assumptions, and certification. Check gradients of whole macros, especially at zero, rather than only the primitive backward rules.

Compare the corrected hard-loss trainer with direct exhaustive search and exact updates to one instruction at a time. The reviewer tried one scan of the 75 second-instruction choices followed by one scan of the 48 first-instruction choices; it repaired all forty original failed runs on the training domain. That is a useful cheap baseline, not a scalable synthesis result.

Then try three instructions or several task families. If trying conditional instruction selection, share parameters: a separate 75-way distribution for each first instruction largely recreates the complete-program table. If trying beam search, define how unfinished programs are scored; their current output error need not predict whether they can be completed correctly.

### 2. Learn a reusable layout rule

This would be my main UI experiment. It connects the original smaller-unit idea to something the current experiments have not established: learning that transfers between content and contexts.

There is already a shared neural function in [trainable-geometry.ts](../trainable-geometry.ts). Its inputs are baked-in slot-position features. Build on that work by supplying changing viewport and item features, instead of presenting a new network as though the project had never learned shared weights.

Start with required photos and real captions. Supply each item's aspect ratio, measured text requirements, importance, and stable identity, plus viewport size. Keep the required items and their importance outside the optimizer's control. Fix reading order initially; use scrolling when everything cannot fit on one screen, rather than quietly deleting content.

Train one small shared function to propose layout fields, and let the existing numeric layout calculation turn those fields into rectangles. Use either a small set of designer examples or outputs from an explicit layout objective, and report which source supplied the target. The latter trains a faster approximation to a solver; it does not independently learn human taste.

For example: train on four- and eight-item collections at several widths, then test six- and twelve-item collections, new aspect ratios, longer captions, and widths not used in training. Use a fixed capacity with an active-item mask first; arbitrary dynamic graph sizes are not necessary for this test. An identity permutation test should change storage positions while carrying reading order and all other item data with the items.

Compare three things: an ordinary wrapping rule, optimization of each layout separately, and the shared learned function. Measure required content retained, text fit, overflow, preference fit, runtime, and movement between nearby widths separately. Add interpolation only after those measurements work, and permit legitimate reflow without calling it smooth motion.

The important question is not whether a net can reproduce rectangles. It is whether a small learned rule adapts a design across changes we did not specify individually. A fixed flow decoder limits the layout family, and that limitation should be explicit.

### 3. Separate predicting users from choosing what is good for them

The click-metrics idea becomes clearer with two questions:

1. Given this task, user context, and layout, what action, completion time, or error is likely?
2. Given those predictions and an explicit user or designer goal, which layout should we choose?

Masked data or next-action prediction can help with the first. It does not determine the second. A frequently clicked button may be important, or just prominent, or repeatedly clicked because it failed. Changing the layout also changes what data gets collected. This presentation bias is a well-studied problem, not a minor implementation detail. [Joachims, Swaminathan, and Schnabel](https://arxiv.org/abs/1608.04468).

Start with a small task whose success is observable, such as finding a specified control. Compare a few permissible layouts, keep the layout stable during each attempt, and separately measure completion, errors, and movement. Simulation can test the machinery; only human observations can validate claims about human usability. When learning from logs, record what was shown and how it was selected, and do not assume observational correlations alone establish the effect of a new layout.

There is particularly relevant prior art beyond Flipboard: SUPPLE++ models an individual's motor capabilities and uses that model to generate a personalized interface. The useful pattern for us is learning a model of user effort separately from the layout optimizer. [SUPPLE++ paper](https://www.eecs.harvard.edu/~kgajos/papers/2007/gajos07automatically.shtml).

### 4. Let small computations become reusable functions

The GraphQL-like adapter idea is a good second research track: examples of available data and desired output, a small operation vocabulary, and exact checking of candidate transformations. The neural component can learn which computations to try across many tasks, instead of relearning probabilities for one fixed task from scratch.

After solving several tasks, look for repeated computations and make them reusable. This follows the spirit of the talk without presuming that the lowest-level units must remain the only useful vocabulary forever. DreamCoder is directly relevant: it learns both reusable program abstractions and a neural guide for program search. That is an alternative worth comparing, not a claim that symbolic search satisfies the original native-neural goal by itself. [DreamCoder](https://arxiv.org/abs/2006.08381).

For a small first data task, retrieve the rectangle for a selected item ID, then transform its coordinates. Vary the number and ordering of items, include distractors, and define absent-ID behavior. This tests genuine data-dependent lookup. It does not require claiming that the learner must discover attention; different successful mechanisms are interesting results.

## Architecture cleanups

- Preserve the meaning of multiplication, selection, comparison, and gather until the relevant differentiation or lowering step. The final execution representation can still be affine and ReGLU. We do not need to erase useful information early and then rediscover it from expanded arithmetic.
- Represent required FP32 rounding points explicitly. The compiler currently uses a ReGLU with a unit gate to prevent affine composition from removing rounding. That workaround obscures both intent and optimization opportunities.
- Separate exact forward execution from the gradient used for training. Label a softened operation or a custom derivative explicitly. A native derivative for multiplication can coexist with a ReGLU expansion for forward execution.
- Test a simple clipped ramp as a training baseline for comparisons before carrying the full softened sign cascade through training. Keep the exact cascade where exact forward execution is the point.
- Before sophisticated layer scheduling, benchmark reusable buffers, returning only requested outputs, and direct scalar JS. Those are measurements to perform, not assumed speedups. A GPU port needs its own precision and performance tests.
- Keep one current results table with the domain, what was learned, held-out tests, and limitations. Mark the July briefs as historical. Keep expensive seed studies separate from fast regression tests; a test asserting a particular optimizer fails 20/20 should not make an improvement look like a broken implementation.

The arithmetic representation is not the only route to differentiable computation. Slang, for example, supports automatic differentiation through ordinary shader functions, control flow, and dynamic indexing, with documented restrictions including bounded loops and resource access. It is a useful comparison backend, not a reason to discard this project. Our distinctive question is what making small pieces of behavior editable and learnable enables, not whether gradients are exclusive to two primitives. [Slang documentation](https://docs.shader-slang.org/en/stable/external/slang/docs/user-guide/07-autodiff.html).

## Verification and reproduction

Run `bun lab/reassessment-2026-09-03.ts`. The [standalone script](reassessment-2026-09-03.ts) reproduces the loss-scale sweep, multiplication-at-zero gradient, false early-return certification, rounded-bound simplification, and overflow gather. It restores the in-memory loss table after each sweep and writes no implementation files. It reports observations rather than asserting that today's bugs must continue to exist.

The independent audits ran 9 passing learned-interpreter tests, 51 passing generative-fields and event-window tests, and 53 passing selected core, gather, compiler, and cascade tests. Three additional real-file compiler tests failed because their external source changed. The reports also included fresh training, layout repair, and performance probes described above. I independently reran the loss sweep, both multiplication operand orders, the compiler and gather counterexamples, the missing padding derivative, and the event compression case.

This was not a full-suite run, a GPU benchmark, or a browser visual review. The observed results are about this checkout and its stated test domains. The implementation fixes and proposed new experiments remain to be done.
