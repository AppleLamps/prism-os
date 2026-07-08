# Trace compiler: vibescript-style TypeScript to circuits

The question from the brief: how much of a real vibescript-style render tick compiles mechanically into an affine/reglu/boolean circuit, with the residue precisely characterized? The answer, measured on `~/github/chenglou.github.io/index.ts` (Cheng's photo gallery, 221 photos): both layout modes, the column math, the spring physics step, the 1D hit test, the occlusion condition, and the scroll compensation all compile from the file's own source text and match an FP32 reference bit-for-bit — 64 of the render path's 221 statement units are compiled and equivalence-verified, 113 of its 173 numeric units (65.3%) are inside the supported subset, and every unit that is not gets one of twelve rejection categories with a fixability judgment. The full taxonomy is at the bottom; it is the main deliverable.

## What was built

- `compile.ts` — the compiler. It walks the TypeScript AST (parsed with the `typescript` package) with symbolic values: compile-time constants fold, runtime numbers become wires, and every emitted operation goes through an emission layer that keeps the circuit's FP32 rounding points identical to the source's. Entry points: `compileFunctionFromSource` for whole functions, and the lower-level `Compilation` session for block slices, per-value specialization, and expression slices.
- `annotations.ts` — the `@fit` parser: `int 0..Infinity`, `0..<4096`, `> 0`, `given max >= min` (a relation between parameters, used to constrain sampling), `return.cols: int 1..7`.
- `twin.ts` — the fround twin: an interpreter that runs the same subset with FP32 semantics (every arithmetic step through `Math.fround`, division rewritten to reciprocal multiplication). The same interpreter in fp64 mode is the original float64 function, used for drift statistics.
- `harness.ts` — the equivalence harness: seeded LCG sampling inside declared ranges (with boundary and exact-integer emphasis, since ties are where decision bits fail), then per trial: circuit reference evaluator, compiled tensor backend, FP32 twin, and float64 original. The first three must agree bit-for-bit on every output; the repo's `validateTensorEvaluation` additionally checks every live wire on early trials.
- `gauntlet.ts` — eight synthetic layout functions in the vibescript style, compiled and verified.
- `real-slice.ts` — the real-file slices and two rejection probes, compiled from the target file's own bytes (statements located by distinctive source text, so edits to the file fail loudly).
- `residue-census.ts` — classifies every statement unit of the render path into compiled/rejection categories; `report.ts` prints all tables below (`bun lab/trace-compiler/report.ts`).

## The supported subset

Numeric `const`/`let` with reassignment, object and array literals, object destructuring, arithmetic (`+ - * / %`), comparisons, `&& || !` over decision bits, ternaries (including branches mixing numbers and `null`), `??` and `== null` tests, `Math.min/max/abs/floor`, bounded `for` loops (unrolled; runtime integer bounds become masked unrolls), `for...of` over fixed arrays, array `push`/`at`/`.length`/indexing at unroll-time-constant indices, single-level-plus function inlining with default parameters, parameter object fields as inputs with mutations as outputs, and module-level constants. Everything else rejects with a diagnostic carrying the line, the construct, and a taxonomy category — the diagnostics are the data.

## Lowering rules

| Source construct | Lowering | Cost |
| --- | --- | --- |
| every arithmetic step | one reglu whose gate reads a source wire holding 1 | 1 op |
| `a * b`, signs unknown | `f(a·relu(b)) - f(a·relu(-b))`; one product is an exact zero | 2–3 ops |
| `a / constant` | multiply by the FP32 reciprocal (the twin mirrors this rewrite) | 1 op |
| `a / boundedInt`, `a % boundedInt` | exact one-hot over the divisor's range, one folded branch per value | ~8 ops per possible divisor value |
| integer comparison | `relu(d) - relu(d - 1)` decision bit, exact below 2^24 | 4–8 ops |
| continuous comparison | exact sign cascade: relu, then power-of-two scaling and clamp01 rounds until every positive value saturates at exactly 1 | ~25 ops |
| ternary on a bit | select as two masked products: `on·bit + off·(1-bit)`, exact for any finite operands | 4 ops |
| `Math.floor` over a bounded range | sum of exact step bits `[x >= k]` | ~25 ops per integer step |
| `Math.min/max` | comparison bit plus select | ~30 ops |
| loop with a runtime integer bound | unroll the static range; mask each iteration's writes with `select(mask, old, new)` — a masked-off iteration is an exact no-op, so the unroll matches the twin's native loop bit-for-bit | per-iteration mask ~6 ops |
| `if` under a runtime condition | same masking; assignments in both branches become selects | |
| runtime-sized structure driven by a bounded integer | per-value specialization: compile the block once per possible value, combine outputs through the exact one-hot (used for the 2D grid's row structure over cols 1..7) | ~7x the block, minus heavy sharing from expression dedup |
| `x: number \| null` | a presence bit plus a value | 2 outputs |

Two policies are load-bearing and deliberately differ from the repo's macro library. First, every source arithmetic step is frozen as its own reglu with a unit gate, because the Circuit builder's affine composition (`composeAffineTerms`) merges small affine forms into consumers and sorts terms by wire index — either one moves FP32 rounding points away from the source's. Second, select uses the two-masked-products form instead of the repo's `off + gate·(on - off)`, because the repo form re-rounds through a subtraction and is only exact for integer operands below 2^23 (see `macro-ranges.md`), while traced source code selects between arbitrary fractional values. Consequence: the compiled circuits are all reglu (`affine: 0` everywhere), which trades stored weights for exactness.

Range analysis rides on the Circuit's own interval tracking (`assumeRange`), tightened by product hulls and select hulls, plus one addition: comparison-guided narrowing in ternary branches. In the false branch of `v > max ? max : v`, the value `v` is at most `max` — the flow narrowing TypeScript performs for types, applied to numeric ranges. Without it, the clamp helper's result range stays unbounded and division by the clamped column count would reject. Narrowing comes with a soundness rule that adversarial verification proved necessary: everything stamped onto a circuit wire with `assumeRange` is computed from context-free (un-narrowed) ranges only, because the builder's expression dedup shares one wire across every occurrence of the same expression — a hull derived from a branch-narrowed operand would silently become a global claim about the shared wire and miscompile the uses outside the branch (the verified repro: `a * b` inside an `a > 5` branch dedup-shared with the same product outside, whose stamped non-negative hull made `Math.max(outer, -5)` fold away). Branch-derived hulls travel on the compiler-side value metadata instead, which stays local to the branch. This also restores the premise of the sign cascade, whose first scaling exponent and overflow safety derive from stored ranges: with only context-free facts on wires, that derivation is sound for every input the wire can carry.

## Exactness policy, and the one policy that failed

The policy is option (a) from the brief: the circuit computes in FP32 and must agree bit-for-bit with a mechanically derived fround twin of the source; drift between the twin and the original float64 function is measured, not hidden. The twin makes exactly one algebraic rewrite, forced by the substrate: `a / b` becomes `f(a · f(1/b))`, since the circuit has no division. Plus and minus zero compare as equal (the repo's differential tests use the same equality). NaN cannot arise because inputs are range-validated and every lowering that computes a value on a masked-off path (select branches, masked loop writes, one-hot divisor branches) rejects at compile time unless the value's context-free range stays within FP32's largest finite value (about 3.4e38) — a float64-finite bound is not enough, since fround(1e30 * 1e30) is Infinity and fround(Infinity * 0) is NaN.

The first comparison policy followed the brief's suggestion — scale the difference into a score near 0.5 and round with the boolean atom, argmax-style, with a documented margin. The exhaustive column-count sweep falsified it: at viewport width 1732, `(1732 - 24) · fround(1/244)` lands one FP32 ulp below 7, the twin's `Math.floor` says 6, and the score-based step bit could not resolve a difference below the score's own rounding step, so the circuit said 7. Differences smaller than the margin are not rare corner dust; they are systematically produced at every exact column boundary by the reciprocal rewrite. The replacement makes the comparison exact with no margin at all: `relu(d)` keeps positive values, one power-of-two multiplication lifts the range near 2^23, then clamp01 (`v - relu(v - 1)`, exact for v < 2^24) and another power-of-two multiplication repeat until even the smallest positive FP32 value (2^-149) has saturated at exactly 1. Power-of-two multiplication only shifts the exponent, so every intermediate is an exact rescaling of `d` or exactly 1, and `f(a - b)` is zero exactly when `a` equals `b` — so the bit agrees with the native comparison on every input. A surprising side effect: the compiler never emits the boolean atom (`boolean: 0` in every table row); continuous decisions come out of pure relu arithmetic, extending the integer decision-bit trick of `tricks.md` to continuous values.

## Gauntlet results

Every function matches the twin bit-for-bit on every output of every trial, and `responsiveColumnCount` is verified exhaustively over every integer viewport width in 0..4096. `twin==f64 bits` is how often the FP32 result equals the float64 result rounded to FP32 — measured drift, not a correctness criterion.

| function | ops | reglu | boolean | layers | stored weights | trials | outputs checked | three-way | mismatches | twin==f64 bits | max abs drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| responsiveColumnCount | 443 | 443 | 0 | 51 | 883 | 4097 | 4097 | all | 0 | 99.9% | 1.0e+0 |
| gapDistribution | 82 | 82 | 0 | 40 | 169 | 5000 | 5000 | all | 0 | 81.3% | 8.1e-5 |
| clampedPanelPosition | 124 | 124 | 0 | 60 | 250 | 5000 | 10000 | all | 0 | 99.9% | 1.2e-4 |
| wrapIndex | 213 | 213 | 0 | 29 | 466 | 5000 | 5000 | all | 0 | 100.0% | 0.0e+0 |
| springSettle | 79 | 79 | 0 | 43 | 158 | 5000 | 15000 | all | 0 | 86.7% | 1.9e-3 |
| heroRowSizing | 118 | 118 | 0 | 58 | 239 | 5000 | 5000 | all | 0 | 92.5% | 1.5e-4 |
| hitTestBox | 113 | 113 | 0 | 31 | 227 | 5000 | 5000 | all | 0 | 100.0% | 0.0e+0 |
| hoverMagnet | 13 | 13 | 0 | 7 | 29 | 5000 | 5000 | all | 0 | 97.3% | 1.3e-4 |

Integer-only functions (`wrapIndex`, and `hitTestBox` whose inputs make every taken branch integral in the harness) drift zero: exact integer arithmetic is exact in both precisions. The 1.0 max drift of `responsiveColumnCount` is the column decision flipping at exact multiples, quantified below.

## The real-file slice

All slices compile from the real file's own source text; photo dimensions (221 entries from `data.ts`) enter as compile-time constants, the tracing stance — the render tick runs against recorded static content, so `sizeX / d.ar` is division by a per-photo constant rather than dynamic division. Slice boundaries, stated honestly: the 2D slice covers the column computation, the sizing pass, and the destination loop, but not the dismissed-scroll adjustment above it (dynamic index `rowsTop[Math.floor(focused / cols)]`), the hover magnet (needs `hitTest2DMode`), or the anchor search (loop with break). The 1D slice covers everything in the lightbox layout except the keyboard rubber-band decoding (`inputCode === 'ArrowLeft'`, string work), which enters as a numeric input instead. The 2D slice has a single input — the viewport width; cols and boxMaxSizeX derive inside the slice through the compiled `colsBoxMaxSizeXF`.

| slice | ops | reglu | boolean | layers | stored weights | trials | outputs checked | three-way | mismatches | twin==f64 bits | max abs drift |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clamp | 60 | 60 | 0 | 31 | 122 | 5000 | 5000 | all | 0 | 100.0% | 0.0e+0 |
| colsBoxMaxSizeXF | 524 | 524 | 0 | 91 | 1050 | 4097 (exhaustive) | 8194 | all | 0 | 81.1% | 2.4e+2 |
| springStep | 12 | 12 | 0 | 8 | 28 | 5000 | 10000 | all | 0 | 71.9% | 2.1e-1 |
| springGoToEnd | 0 | 0 | 0 | 0 | 0 | 2000 | 4000 | 2000 (+2000 constant outputs) | 0 | 100.0% | 0.0e+0 |
| hitTest1DMode | 117 | 117 | 0 | 32 | 228 | 5000 | 10000 | 6444 (+3556 twin-null value slots) | 0 | 100.0% | 0.0e+0 |
| 2D grid layout (per-cols specialization x7) | 24894 | 24894 | 0 | 600 | 56418 | 300 | 398100 | all | 0 | 65.2% | 1.6e-1 |
| 1D lightbox layout (masked loops, no specialization) | 21213 | 21213 | 0 | 1580 | 43767 | 300 | 464100 | 397800 (+66300 constant outputs) | 0 | 81.9% | 4.1e-1 |
| occlusion culling bits (one per photo) | 25416 | 25416 | 0 | 32 | 51274 | 500 | 110500 | all | 0 | 100.0% | 0.0e+0 |
| scroll compensation (y.pos writes) | 222 | 222 | 0 | 2 | 666 | 500 | 110500 | all | 0 | 92.6% | 3.9e-2 |

Zero mismatches across 1,174,491 output comparisons (gauntlet plus slices): 1,102,635 with all three legs (literal reference evaluator, compiled tensor backend, fround twin), 68,300 without the tensor leg (constant-folded outputs never enter the tensor program: springGoToEnd's `config.v = 0`, the 1D slice's `scale.dest = 1`), and 3,556 without the twin leg (hitTest1DMode's value slot when the twin returns null — 71.1% of its 5,000 value comparisons — where the circuit's value is arbitrary by the nullable encoding and only the presence bit is meaningful). No comparison ran reference-only. `springGoToEnd` compiles to zero operations — its outputs are an input wire and a constant, which is correct.

Drift against float64, characterized rather than averaged: `colsBoxMaxSizeXF`'s 240-pixel max drift is not accumulated error but a discrete decision flip — at exactly 6 of the 4097 widths (512, 756, 1000, 1244, 1488, 1732, i.e. wherever width − 24 is an exact multiple of 244), the FP32 reciprocal lands one ulp below the exact quotient, FP32 chooses one fewer column than float64, and the per-column width jumps accordingly. The circuit and the twin agree with each other at all 4097 widths; the disagreement is between FP32-as-a-semantics and float64-as-a-semantics, and it is pinned to those 6 inputs. The 2D slice's 65.2% bit-agreement with float64 (max 0.16px) is ordinary FP32 rounding through the sizing chains; positions drift by less than a hundredth of a pixel in typical rows.

Two functions reject, as expected, with precise diagnostics (the probes are tests): `hitTest2DMode` at line 219, category `early return` (first-match search loop — the parallel-winner tree is the known lowering, not implemented here), and `stepSpring` at line 188, category `dynamic loop bound` (its `@fit` says `int 0..Infinity`; a finite bound would turn it into a masked unroll of spring steps).

## Residue taxonomy (the deliverable)

Every statement unit (leaf statement, if condition, or loop header) of the render path — `render` plus the nine helpers it calls — classified. Counts are produced mechanically by `residue-census.ts` and the table was reviewed line by line against the file.

| category | count | example (line) | fixability | how |
| --- | --- | --- | --- | --- |
| compiled and verified in a slice | 64 | `const {cols, boxMaxSizeX} = colsBoxMaxSizeXF(newWindowSizeX)` (292) | compiled | bit-exact against the fround twin over seeded random inputs |
| compilable numeric (not sliced) | 49 | `for (let i = 0; i < data.length; i++)` (263) | compiled | inside the supported subset but not part of an equivalence-verified slice |
| DOM write | 27 | `const {node, img, promptNode} = d` (413) | boundary I/O | stays in the JS glue; circuit outputs project onto the DOM in the batched write phase |
| nullable state | 15 | `let focused: number \| null = null` (263) | mechanically fixable | a presence bit plus a value; demonstrated by the compiled hitTest1DMode (return.present, return.value) |
| event object plumbing | 14 | `const inputCode = events.keydown == null ? null : events.keydown.code` (233) | mechanically fixable | event handlers store numeric cells (the window-manager pattern: downActive, downX, downY) and render reads the cells |
| string work | 9 | `data[i]!.id === hashImgId` (263) | annotation-fixable | encode as integers: key codes as an enum cell, the photo id in the URL hash as an index, the cursor name as a one-hot choice |
| browser side effect | 9 | `const selection = window.getSelection()` (278) | boundary I/O | scrollTo, pushState, and selection stay imperative; their arguments can be circuit outputs |
| dynamic loop bound | 8 | `const stillAnimating = animationDisabled ? false : stepSprings(steps)` (406) | annotation-fixable | a finite @fit bound turns the loop into a masked unroll (demonstrated by the 1D backward loop); stepSpring's @fit says int 0..Infinity, so it stays rejected until the bound is finite |
| debug-only | 6 | `debug` (249) | out of scope | manual frame stepping for development; not part of the product tick |
| DOM read | 6 | `const newWindowSizeX = document.documentElement.clientWidth` (255) | boundary I/O | stays in the JS glue; the read value enters the source table as an input cell, the way window-manager.ts feeds viewport facts today |
| dynamic index | 6 | `const focusedTop = rowsTop[Math.floor(focused / cols)]!` (319) | mechanically fixable | one-hot gather or scatter, O(n) operations per access; the core's declared one-hot groups lower the tensor cost to a single read |
| state commit (write-back) | 4 | `anchor = newAnchor` (468) | supported by the architecture | module state cells become source-table entries written back each frame — the recurrence f(state, input) -> (state, output) |
| loop early exit (first match) | 3 | `for (newAnchor = 0; newAnchor < data.length; newAnchor += cols)` (352) | mechanically fixable | per-item condition bits plus a first-match selection tree (the emitFirstActive precedent); recognized but not implemented in this compiler |
| unbounded range (needs a finite @fit) | 1 | `const steps = Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep)` (404) | annotation-fixable | Math.floor over the frame-time delta has no finite bound, so the compiler cannot lower it to step bits; a spiral-of-death clamp on the delta (ui.md caps the step count with Math.min(300, ...)) would bound it |

Totals: 221 units (exact per-category counts are pinned by a test, so drift in the target file or the classifier fails loudly). 64 (29.0%) compiled and equivalence-verified. Of the 173 numeric units (excluding DOM reads/writes, browser side effects, and debug-only), 113 (65.3%) are inside the supported subset and 64 (37.0%) are verified bit-exactly. The brief's hypothesis holds with names attached: straight-line layout math traces cleanly; the residue is data-dependent structure (dynamic indices, first-match searches, the runtime-length rowsTop array), capacities (loop bounds, the photo count), and encodings (strings for keys/ids/cursors, null for modes) — plus the browser boundary, which is not residue but the I/O the architecture already assigns to glue code.

The coding pattern shifts the residue asks of an author, concretely: give `@fit` bounds that are actually finite (the only annotation in the file that blocked compilation was `int 0..Infinity` on `steps` and `containerSizeX`), let event handlers write numbers instead of letting render read event objects, prefer indices over id strings in state, phrase searches so the first match is a maskable condition, and treat `null` as a presence bit you could have declared.

## Failures and limits

- Adversarial verification found two genuine soundness holes, both fixed with regression tests. First, branch-narrowed range hulls leaked onto circuit wires through expression dedup: `a * b` emitted inside an `a > 5` branch shares its wire with the same product outside, and the branch-derived non-negative hull stamped on that wire made a later `Math.max(outer, -5)` fold away (circuit -100, twin -5 at a = -10, b = 10). The fix keeps wire-stamped ranges context-free and moves branch-derived hulls to compiler-side metadata. Second, the select guard checked float64 finiteness where the real precondition is FP32 representability: with inputs in [0, 1e30], the masked-off `a * b` branch computed fround(Infinity · 0) = NaN and poisoned the select. The guard (and the one-hot divisor branches) now reject any branch whose context-free range exceeds FP32's largest finite value.
- The boolean-atom margin policy for continuous comparisons is measurably insufficient for bit-exactness (6 systematic failures in one 4097-input sweep); the exact sign cascade replaced it at ~10x the per-comparison cost. This is the experiment's clearest finding about the substrate: exactness against a native-comparison twin needs exact bits, and exact bits over continuous FP32 values cost about 25 operations each.
- Comparisons require finite declared ranges below 2^23 in magnitude, floors require bounded spans, and one-hot divisors require small integer ranges. These are preconditions the diagnostics name, not silent assumptions.
- The 1D slice is 1580 layers deep because `currentLeft` accumulates through 221 masked iterations sequentially; a prefix-sum restructuring would cut the depth to O(log n) but changes rounding order, so it cannot be bit-exact against this twin. Depth is the honest price of sequential source semantics.
- Per-value specialization multiplies work by the number of possible values (7 here); expression dedup absorbed most of it (the 2D slice is 24.9k ops, not 7x its single-variant size), but the technique needs a small bounded driver to stay reasonable.
- The census classifier is syntactic (marker sets plus AST checks), reviewed by hand against this one file; it is a measurement instrument for this target, not a general classifier.
- The real pointer state initializes to `-Infinity`; compiled comparisons need finite ranges, so the slices declare finite pointer bounds and the sentinel is noted as an encoding to fix (a presence bit, or a finite off-screen coordinate).
- The core (`numeric-ui-core.ts`) gained declared one-hot groups and gather lowering from a parallel experiment while this one was running; these circuits declare no groups, so the additions do not engage, and the full equivalence suites pass unchanged against the revised core.

## Next steps

- Implement the first-match lowering (per-item bits plus prefix masking) to absorb `hitTest2DMode` and the anchor search — the two remaining mechanical rejections.
- Route the per-cols one-hot and the divisor one-hots through the core's new declared one-hot groups (`assumeOneHot`), so the tensor backend gathers instead of summing 7 masked branches.
- A `steps` bound (`@fit int 0..8` matches 120fps frame budgets) would unroll `stepSpring` and close the animation tick.
- Fold the slices into one circuit with the mode bit selecting between the 2D and 1D destination sets, plus the state write-backs — that would be the full compiled tick minus DOM glue.

## Reproducing

`bun test lab/trace-compiler` (28 tests: unit lowering tests, the gauntlet, the real-file slices, the census), `bunx tsgo -p lab/trace-compiler`, `bunx oxlint --type-aware lab/trace-compiler`, and `bun lab/trace-compiler/report.ts` regenerates every table above. Tests read `~/github/chenglou.github.io/index.ts` and `data.ts` live; if the file changes, statement markers and counts fail loudly rather than silently compiling something else.
