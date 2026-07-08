# One-hot group invariants and gather lowering in the tensor compiler

Dynamic lookup — reading one item out of N at a runtime index — previously cost O(N) stored weights and O(N) work per read: a one-hot mask multiplied against every candidate, then summed. This experiment implements the alternative chosen in `todo.md` ("Revisit hardAttend"): no fourth atom. The circuit algebra stays affine/reglu/boolean, the literal reference evaluator stays the definition of correctness, and the tensor **executor** gains a gather operation that `compileTensorProgram` emits when it recognizes the masked-sum idiom over a declared one-hot group. The lowering is bit-identical to the reference on every wire (with one precisely-characterized signed-zero caveat), proven by randomized differential tests over thousands of seeded circuits and by the production circuits running their full test suites through lowered programs.

## What was built (all in `numeric-ui-core.ts`, additive; reference evaluator untouched)

1. **`Circuit.assumeOneHot(members, allowAllZero = false)`** — a declared contract in the spirit of `assumeRange`: every member wire is exactly 0 or 1 and exactly one is 1. The `allowAllZero` variant also permits the all-zero state; it is needed because `emitFirstActive` legitimately produces all zeros when its gate is inactive or no candidate is hot. The declaration narrows member ranges to 0..1. `emitArgmax` declares its selection unconditionally (the tournament routes the unit down exactly one path regardless of the scores). `emitFirstActive` declares its selection **only when its gate and every candidate are provably exact bits** — see the exactness section; a plain 0..1 range is not enough. `inlineCircuit` copies groups through the wire map. `validateOneHotGroups(circuit, values)` checks every group against evaluated values, for tests and trainer writebacks.
2. **Idiom recognition** (`planGatherLowering`) — runs inside `compileTensorProgram` (a `lowerGathers = true` parameter turns it off for A/B measurement). It finds affine operations whose terms are single-product reglus pairing each group bit against a value wire, covering the whole group exactly once, plus an optional bias. Every candidate value wire must have a **finite declared range** on both ends (see exactness).
3. **Gather execution** — a lowered sum stores zero sparse weights. Per group, the executor resolves the selected index once per evaluation by taking the dot of the packed bits with 0..N-1 (exact for 0/1 bits, so no wire is added to the operation stream and the reference semantics cannot drift). Per read, it adds `packedValues[candidateTable[index]]` onto the row's bias with one `fround`. All-zero-allowed groups multiply the gathered value by the group mass first, so an inactive group contributes exactly 0. A violated contract clamps the index into the table instead of reading out of bounds. Liveness follows the rewritten dependencies, so mask products with no other consumer drop out of the compiled program entirely. `validateTensorProgram` checks the new metadata (slots resolved exactly once, before use, from strictly earlier layers; gather rows are plain affine rows with no stored weights).

## The recognition algorithm and its robustness

A product term qualifies in the orientations `emitMultiply` actually produces:

| shape | reads value exactly because | condition |
| --- | --- | --- |
| `fround(value * max(0, bit))`, bit in the gate | `fround(v * 1) = v`, `fround(v * 0) = ±0` | value's declared range is finite on both ends |
| `fround(bit * max(0, value))`, bit on the left | relu is the identity on the value | value's declared range is non-negative and finite |
| pair `+fround(bit * relu(value))`, `-fround(bit * relu(-value))` | the arms reconstruct `bit * value`; each non-selected arm is `±0` | arms both present and pair up; value's range finite |
| `fround(x * max(0, -bit))` with any ±1 coefficient | `max(0, -bit) = 0` for a 0/1 bit, so the term is a signed zero | ignorable filler; `x`'s range must still be finite |

Robustness to the builder's own rewrites was the hard part, and the naive version failed on it: **zero gathers fired in candidate-gallery** at first, because `emitArgmax`'s selection wires that are two-term affines (`route - leftRoute`) get composed *into* the product reglus by `composeAffineTerms` (any affine under 4 terms is inlined into consumers). The recognizer therefore resolves each reglu side through the builder's own expression-deduplication map: an inlined copy of a wire's definition serializes to exactly the key under which that wire was registered, and negated copies are matched by serializing the negated terms. Deduplication itself is handled for free — identical reads collapse to one wire and one gather, which the tests pin.

Boundaries where recognition correctly declines (each is a test):

- a sum mixing masked products with any other term, or with coefficients other than ±1, or covering the group partially, or mixing products of two different groups — FP32 accumulation order makes a partial substitution unsound, so only pure masked reads lower;
- any read whose candidate (or the filler term's value) has a declared range that admits `±Infinity`, in every orientation (see exactness) — the tests cover bit-in-gate, bit-on-left, mixed-sign pair, and the filler branch;
- a hand-written `bit * relu(value)` product over a value whose declared range admits negatives (relu would clip it; `emitMultiply` never builds this, so the range check only rejects hand-built reglus);
- a size-1 group's unbiased read, which aliases straight back to the product reglu (there is no affine to lower; a 1-item lookup is O(1) already); the biased read and the mixed-sign product-pair affine do lower;
- members constant-folded out of the sum: candidate-gallery's hero geometry reads lose their Contact term because Contact's hero is the constant-zero wire and `foldConstantTerms` erases the product, leaving a 2-of-3 cover. Recognition cannot distinguish that from a genuinely partial sum. This is a real interaction between constant folding and idiom recognition, and the hero reads stay dense because of it.

## The exactness argument

The reference computes an affine as `value = fround(bias)`, then `value = fround(value + fround(fround(c) * term))` in ascending wire order. For a pure masked read with the contract honored: every non-selected product contributes exactly `±0` (`fround(v * 0)`, `fround(0 * relu(v))`, or a negated arm — all signed zeros for **finite** `v`), and adding a signed zero is the FP32 identity on every value except that it can flip the sign of an exactly-zero accumulator. The chain therefore collapses to `fround(fround(bias) + v_k)` where `v_k` is the selected candidate's already-rounded FP32 value (`fround(1 * v_k) = v_k`, and for the bit-on-the-left orientation `max(0, v_k) = v_k` since the range proves `v_k >= 0`). That is exactly what the gather computes: the row's bias plus one gathered value, one `fround`. The index dot `sum(j * bit_j)` over exact 0/1 bits is an exact small integer.

Two conditions the argument depends on, both now enforced in the compiler and covered by tests:

- **Finiteness.** `fround(v * 0)` is a signed zero only for finite `v`; for `v = ±Infinity` it is `NaN`, which poisons the whole dense sum while the gather reads the selected value cleanly. So a candidate whose declared range admits `Infinity` breaks the argument. The compiler refuses to lower any read whose candidate (or filler value) range is not finite on both ends, in every orientation. Verified repro (`gather-recognition.test.ts`): with a declared source one-hot, `v0 = 5`, `v1 = Infinity`, selecting slot 0, the reference computes `NaN` (from `fround(Infinity * 0)`) and lowering is refused so the tensor program computes the same `NaN`. Before this rule, the read lowered and returned 5.
- **Proven exact bits for `emitFirstActive`.** The selection is one-hot-or-all-zero only when the gate and every candidate are exact bits; `emitFirstActive`'s only precondition is a 0..1 range, and fractional scores are legal there (candidates `[0.5, 0]` route mass 0.25 to each output). Declaring unconditionally was a false contract that lowering miscompiled. Verified repro: `active = 1`, candidates `[0.5, 0]`, values `[100, 200]` → reference 75, but a gather over the (falsely declared) group returned 50. `emitFirstActive` now declares only when the gate and candidates are provably exact — a range pinned to a single 0 or 1, a `boolean` atom output, or a declared one-hot member — and abstains otherwise; `emitArgmax`'s declaration was checked sound and stays unconditional.

The remaining divergence is **signed zero**, and the claim is honest about it: the reference accumulates signed zeros across products in wire order while the gather adds only the selected contribution, so a result that is exactly zero can come out `+0` on one side and `-0` on the other. These compare **equal under `===`**, which is the repo's own agreement standard (`validateTensorEvaluation` uses `===`, and `===` treats `+0 === -0`). They differ only under `Object.is`. Two cases are pinned in `gather-recognition.test.ts` (an all-zero-allowed inactive group with a `-0` bias; a strict one-hot selecting a `-0` value with a positive non-selected candidate later in wire order): both show `reference` and `tensor` `===`-equal while carrying opposite zero signs. The differential and benchmark suites compare with `===`-or-`Object.is` (`sameNumericValue`), which accepts these and still catches every genuine difference including `NaN`-vs-number.

Verification: 2,000 seeded circuits with groups from all four origins (declared source bits before and after the reads, `emitArgmax`, `emitFirstActive` over boolean-atom candidates), 5,729 lowered reads, 2,715 decoys that must not lower, 409 chained reads (a read whose candidate is itself an earlier read) across 494 such candidate picks — counted by actual use, not pool availability — 693 circuits exercising the mixed-sign pair form, 1,306 all-zero-allowed groups, 559,977 wire comparisons across reference, lowered tensor, and dense tensor, all agreeing under `sameNumericValue`. Adversarial unit tests cover FP32 extremes within range (±3.4028234663852886e38, subnormals, -0, 2^24 neighbors), unbounded-range refusal in every orientation, fractional first-active refusal, constant-folded candidates, size-1 groups, shared groups (one index resolution for many reads), chained gathers, dedup, bias, both orientations, the pair form, the two signed-zero cases, and a violated contract (divergence demonstrated, `validateOneHotGroups` catches it).

## Benchmark: N slots x T reads (`bun lab/gather-lowering/benchmark.ts`)

The library circuit stores T value fields per slot plus a one-hot selection in the source table; each read is a masked sum over one field. Each (configuration, mode) runs in its own subprocess (see methodology below); 5 subprocesses per pair, 500 timed runs each, on Bun 1.3.14 / JavaScriptCore, Apple-silicon laptop. "Execution" is the end-to-end median minus the source-range validation that `evaluateTensor` always pays, measured in the same subprocess (that O(sources) cost is mode-independent). The execution columns show the **min–max of the per-subprocess medians**, not a single number, because several cells are bimodal across subprocesses (the same code lands in one of two JIT states run to run). Stored-weight and program-size columns are exact and stable.

| N | T | stored weights off | on | program KB off | on | execution µs off | execution µs on | median speedup | one-hot check µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 64 | 1 | 192 | 0 | 2.1 | 0.3 | 1.8-2.3 | 1.3-1.3 | 1.5x | 0.3 |
| 64 | 4 | 768 | 0 | 10.0 | 1.1 | 4.8-5.0 | 2.0-2.3 | 2.4x | 0.2 |
| 64 | 16 | 3,072 | 0 | 41.4 | 4.4 | 12.9-14.0 | 3.1-3.5 | 4.0x | 0.2 |
| 256 | 1 | 768 | 0 | 10.8 | 1.8 | 5.5-6.5 | 2.1-2.4 | 2.5x | 0.7 |
| 256 | 4 | 3,072 | 0 | 42.0 | 5.0 | 13.5-14.2 | 3.5-3.8 | 3.9x | 0.7 |
| 256 | 16 | 12,288 | 0 | 165.0 | 17.5 | 19.6-43.5 | 9.8-10.4 | 4.2x | 0.7 |
| 1024 | 1 | 3,072 | 0 | 45.1 | 8.2 | 16.0-17.6 | 6.0-7.2 | 2.7x | 1.1 |
| 1024 | 4 | 12,288 | 0 | 168.0 | 20.6 | 20.8-45.7 | 12.3-14.1 | 1.8x | 1.0 |
| 1024 | 16 | 49,152 | 0 | 659.6 | 70.0 | 71.5-77.7 | 8.6-16.7 | 6.5x | 1.1 |
| 4096 | 1 | 12,288 | 0 | 180.2 | 32.8 | 22.2-24.6 | 17.9-19.4 | 1.2x | 4.2 |
| 4096 | 4 | 49,152 | 0 | 671.8 | 82.0 | 74.8-80.0 | 15.2-41.3 | 2.0x | 4.2 |
| 4096 | 16 | 196,608 | 0 | 3,703.0 | 426.4 | 457.5-461.8 | 41.7-45.5 | 10.7x | 4.2 |

Honest accounting. Stored FP32 weights per read drop from exactly 3N (2 per product reglu plus 1 per sum term) to 0, and the dead products leave the program (`valueCount` shrinks to sources + reads). What remains O(N): the one-hot itself (source cells, and argmax if the one-hot is computed rather than stored), one shared bit table of N index entries per group, and one candidate table of N index entries per read — integer bookkeeping (the "program KB on" column, roughly `4 + 4T` bytes per slot at Uint32 width) rather than FP32 weights, touched O(1) per read at runtime except the shared O(N) index dot per group. Wall-clock speedup saturates at small T and large N because the executor's fixed per-evaluation costs — source-range validation, the O(width) output array allocation and copy, `packedValues.set` — dominate once the masked-sum arithmetic is gone; at N=4096, T=1 those floors leave only 1.2x end-to-end even though the replaced compute itself shrank several-fold (see the executor study).

The flagship case from the brief — a 1,024-slot library with a 4-value geometry read — goes from 12,288 stored weights / 168 KB / ~21µs to 0 stored weights / 20.6 KB / ~13µs of execution per evaluation.

Timing methodology (this cost real time; the findings are worth recording):

- Measuring different configurations, or the off and on programs, in one process lets earlier programs drive the executor's typed-array access sites polymorphic (Uint8 vs Uint16 vs Uint32 index arrays), distorting later work up to 10x and even inverting the off/on comparison. Every (configuration, mode) now runs in its own subprocess so each access site stays monomorphic, the way a production circuit runs. Inside a subprocess, evaluation and the two validation checks run round-robin in one loop so JIT state, core assignment, and GC hit them equally.
- Even with that, several cells are genuinely **bimodal across subprocesses** (e.g. N=256/T=16 dense 19.6–43.5µs, N=1024/T=4 dense 20.8–45.7µs, N=4096/T=4 lowered 15.2–41.3µs): the same program lands in one of two JIT states from run to run. The table reports the min–max spread rather than hiding it behind one median; the median-speedup column uses the median of each side. Stored-weight, program-size, and validation-cost columns are exact.

## The executor study (`bun lab/gather-lowering/executor-study.ts`, retained and reproducible)

Two earlier README claims rested on unretained instrumentation. Both are now reproducible from committed code on the N=4096, T=1 library (500 timed runs per subprocess):

- **Phase decomposition.** A faithful replica of the executor with timers between phases shows where each mode spends its evaluation: dense spends ~10µs in the sparse matmul (and ~4µs each in input staging and output copy-out); lowered spends ~0.1µs in the matmul and ~6.4µs in the gather work (index dot plus indexed reads), with copy-out ~5.5µs. So lowering replaces a ~10µs matmul with ~6.4µs of gather work; the remaining per-evaluation floor (setup, copy-out) is shared. (The old README's "42.9µs matmul vs 7.5µs gather" was not reproducible and is retracted.)
- **The JIT pathology behind `applyGathers`.** A replica with the gather loops inlined into the evaluation function runs 3.6–5.3x slower than the same code with the loops extracted into a separate function (~56µs monolithic vs ~15µs extracted, on identical work), because JavaScriptCore's top tier fails to optimize the monolithic function. Each variant runs in its own subprocess so the compiled shapes cannot pollute each other. This is exactly why the shipped executor keeps `applyGathers` separate; the comment at its definition points here. (The old "69µs → 18µs" anecdote is replaced by these reproducible numbers.)

## Two executor performance fixes that fell out of the measurement

- `validateSourceRanges` (pre-existing, runs on every `evaluateTensor`) built its failure message eagerly — one template string per source cell per evaluation, megabytes of garbage per call at tens of thousands of sources. The message is now built only on failure. Semantics unchanged; verified by the full suite.
- The `applyGathers` extraction above: keeping the gather loops out of `evaluateTensorProgram` avoids the JIT pathology, 3.6–5.3x on the affected shape.

## Production survey (`production-survey.test.ts`)

| circuit | declared groups | gather reads (default compile) |
| --- | --- | --- |
| candidate-gallery (as committed) | 1 (argmax winner) | 0 |
| window-manager (as committed) | 0 | 0 |
| window-manager + declared stack contracts (from the test) | 8 | 12 |

The headline production finding, stated honestly: **with the exactness fixes in place, all committed production circuits lower 0 gathers by default** — not because the idiom is absent, but because their masked-read candidates cannot be *proven* to satisfy the contract from declared ranges alone, even though at runtime they do.

- **candidate-gallery: 1 group, 0 gathers.** The argmax winner group is still declared. Its 22 `selectValue` masked reads (53 call sites minus deduplication and the hero sums that constant folding truncates) match the shape over that group — and they lowered under the pre-fix compiler. But every candidate is viewport-derived geometry with a declared range of `0..Infinity`, and the finiteness rule now refuses unbounded candidates: with a non-selected value infinite and its bit 0, the dense sum computes `fround(Infinity * 0) = NaN` that a gather would not reproduce. Confirmed by isolating the fix — with only the finiteness gate disabled, exactly those 22 reads come back. In practice the viewport is finite so the pre-fix lowering matched at runtime, but the *declared contract* was unsound; declaring finite viewport-derived bounds inside the builder would re-enable all 22 reads soundly. The 60-frame click/resize trace stays bit-identical to the reference every frame with the group validated.
- **window-manager: 0 groups, 0 gathers.** The photo gallery's click selection gates on a product of 0..1-range wires — not a *provably* exact bit — so `emitFirstActive` no longer declares it (correctly: the pre-fix unconditional declaration was the exactness hole). Its real dynamic lookups (`emitFrontmost`, the stacking updates) run over the stack permutation matrix, a source-table contract that nothing declares.
- **Declaring the stack contracts finds the lookups.** Declaring the 4 stack rows and 4 stack columns as one-hot groups — from the test, without touching `window-manager.ts` — lowers 12 gathers (the frontmost-window selection and the selected-rank reads; stored weights 11,145 → 10,993). A full interaction trace (title-bar drag, restacking clicks, dock minimize/restore, photo navigation, spring settling) stays bit-identical to the reference every frame, and `validateOneHotGroups` confirms the permutation stays exactly one-hot throughout. The `focusedWindow` call reads the *next* stack (computed wires, not the declared source cells), so it stays dense: declared invariants do not propagate through computation.
- **event-window (a sibling lab, unmodified): 0 groups, 0 gathers, 33 tests still green.** Its `emitFirstActive` selection is over products `bit * stateCell` that are exact bits at runtime but not provably so from declared ranges, so the stricter rule abstains. Its 20k-frame differentials pass unchanged, dense.

## Validation cost and policy

Measured per evaluation (benchmark table, "one-hot check µs"): checking every declared group costs 0.2–0.7µs for production-sized groups and ~4µs even at a 4,096-member group — cheaper than the source-range validation the evaluators already run. Policy recommendation: **validate in tests always, and at writeback for source-borne groups; never per evaluation.** Rationale: groups declared by `emitArgmax` (or `emitFirstActive` over proven bits) construct the property, so runtime checking is redundant there; the risk surface is bits stored in the source table (focus one-hots, the stack permutation), and those change only when the frame writes back or a trainer hardens soft weights into bits — one check at that point (as `validateOneHotGroups` after the writeback loop, the way the production machines already validate stack masses each step) covers every subsequent read. A violated contract does not corrupt memory (the executor clamps the index); it produces a wrong value, exactly like a violated `assumeRange`, and the divergence test pins that behavior.

## Failures and limits

- Recognition is shape-bound: mixed sums, scaled reads, partial covers, and balanced-tree partial sums stay dense (correctly, since FP32 accumulation order forbids partial substitution).
- The finiteness rule is conservative on declared ranges, not runtime values: production geometry is finite at runtime but declared `0..Infinity`, so those reads stay dense until the builder declares finite bounds. This is the main reason the committed circuits lower nothing by default. It is the correct conservative choice — the alternative miscompiles — but it means the production payoff needs a small change to the circuit builders (finite range annotations), not just to the compiler.
- The `emitFirstActive` proven-bit rule is likewise conservative: selections over products-of-bits are exact bits at runtime but abstain from declaration. Threading exact-bit provenance through products would re-enable them.
- Constant folding erases degenerate members before recognition sees them (candidate-gallery's hero); recognizing "the missing member was the constant zero" would need the sum to remember folded terms; not built.
- At N below the affine-share threshold (4), consumers inline the products, keeping them alive; lowering then saves the sum's weights but not the products'.
- Declared invariants do not flow through computation: the *next*-stack wires are provably a permutation of declared one-hots, but nothing infers that, so `focusedWindow` stays dense.
- Signed zero: an exactly-zero result may carry either sign of zero, equal under `===` (the repo standard) but not `Object.is`. Characterized and tested, not eliminated.
- End-to-end speedup is bounded by the executor's fixed O(sources + width) per-evaluation costs; at T=1, N=4096 the win is ~1.2x despite the replaced compute shrinking several-fold. Wall-clock numbers are engine-dependent and partly bimodal; the structural columns are exact.

## Next steps

Declare finite viewport-derived ranges in the candidate-gallery and window-manager builders so their masked reads lower soundly; thread exact-bit provenance through products so first-active selections over products-of-bits can declare; split mixed sums during emission so focus-style updates lower; infer one-hot propagation through selection sums; return packed values from the executor and adopt a writeback-time validation policy to attack the fixed costs; teach `emitArgmax` to hand the gather its index directly instead of re-deriving it from the bits; extend the declared-invariant-plus-idiom pattern to bounded visibility compaction.

## Files

- `numeric-ui-core.ts` (repo root, modified additively): `assumeOneHot`, `validateOneHotGroups`, `planGatherLowering` + `attemptGatherMatch` + `resolveAffineSide` + `hasFiniteRange`, gather metadata in `TensorProgram`, `applyGathers` in the executor, `isProvenBit`, auto-declarations in `emitArgmax`/`emitFirstActive`/`inlineCircuit`, the two performance fixes.
- `gather-recognition.test.ts` — 24 unit tests: every orientation, every non-recognition boundary (including unbounded-range refusal in each orientation and fractional first-active refusal), inlining/dedup robustness, chaining, size-1, all-zero, the signed-zero caveat, contract violation, FP32 extremes.
- `gather-differential.test.ts` — 2,000 seeded circuits, 559,977 exact wire comparisons across three evaluation paths; chained coverage counted by actual use.
- `gather-scaling.test.ts` — structural asymptotics (3NT to 0 stored weights, dead-product elimination, bookkeeping bound).
- `production-survey.test.ts` — the survey table above plus full interaction traces compared against the reference each frame.
- `benchmark.ts` — the N x T grid (subprocess-isolated timing, min–max spread); `executor-study.ts` — the retained phase decomposition and JIT-pathology measurement; `library-circuit.ts`, `measure.ts` — shared builders and instrumentation.
