# Runtime and vocabulary

Status, September 15, 2026: written in phase 1, before the round 2 prototypes. Later measurements are in the [exploration README's capability map](../README.md#capability-map), and the current runtime's contracts and costs in the repo root's [execution-model.md](../../../execution-model.md). What this note says about IndirectOS still describes window-manager.ts, which hasn't changed since commit a915dcb.

These are phase-one reader notes on Indirect's numeric runtime. They cover the atoms and macros a UI author can use today, how the compiler and executor turn them into layers, measured sizes and CPU times for the production circuits, the operations that don't exist yet (with prototyped constructions and their measured costs), and what a GPU or batched backend would look like for this program shape.

Line numbers in `numeric-ui-core.ts` refer to commit c3d8e54 (September 5, 2026); on September 14, 2026 the file grew from 1,653 to 3,158 lines.

All scripts live in `scratchpad/phase1/runtime/` (backup: `~/github/indirect-scratch-backup/2026-09-15/scratchpad/phase1/runtime/`), with their raw JSON outputs beside them: `measure-circuits.ts` (production circuits), `macro-costs.ts` (each macro alone), `constructions.ts` and `probe.ts` (missing operations), and `codegen-study.ts` (generated code and instance batching). Measurements used Bun 1.4.0 on an Apple-silicon laptop. Structural counts are exact. Timings move by tens of percent from run to run.

## 1. How one frame runs

IndirectOS keeps one `Float32Array` source table of 201 cells (window-manager.ts:86-153):
- the viewport size and pixel constants (margin, title height, button size, dock sizes)
- pointer latches (`downActive`, `downX`, `downY`, and the same for move and up) and frame times
- spring constants
- per-window state (left, top, width, height, open, minimized, maximized, present) and drag and resize latches
- a 4x4 stacking permutation matrix and 10 spring cells per window
- the Photos state: 4 constants, 4 event latches, 12 focus cells, and 4 thumbnail spring cells per photo

Event listeners only write latches. For example, `pointerDown(x, y)` sets `downActive = 1`, `downX = x`, `downY = y` (window-manager.ts:1256-1303).

`renderWindowManager` (window-manager.ts:1418) calls `machine.step`, which does four things:
1. validates the source table in JavaScript
2. runs `circuit.evaluateTensor`
3. validates the outputs in JavaScript
4. copies every `nextSource` wire back into the table

The circuit clears latches by writing zero into their next-source cells. The DOM projection then writes style strings for 4 windows, 4 dock items, and the Photos nodes. It schedules another animation frame only while the `animationActive` output is above zero.

## 2. Vocabulary available today

### 2.1 Atoms

`f(x)` means `Math.fround(x)`. An affine starts from `value = f(bias)` and then runs `value = f(value + f(f(coefficient) * values[wire]))` for each term in stored order. Even a plain sum is a sequence of rounding steps, and term order is part of its meaning (numeric-ui-core.ts:1083-1095).

| atom | forward calculation | cost in the compiled program | contract |
| --- | --- | --- | --- |
| affine | weighted sum plus bias, one rounding step per term | 1 operation, 1 projection row, 1 stored weight per term | FP32 by definition |
| reglu | `f(left * max(0, gate))`, where `left` and `gate` are both affine forms | 1 operation, 2 projection rows (output and gate), weights for both sides | FP32 by definition |
| boolean | `f(f(f(score) + 8388609) - 8388609)` | 1 operation, 1 projection row | the builder refuses scores whose declared range isn't inside 0..1; 0.5 rounds to 1 |

### 2.2 Builder calls and compile-time contracts

- `circuit.affine(terms, bias)` is a builder expression. Terms are sorted by wire, duplicates merge into one coefficient, and zeros are dropped. Constant wires fold into the bias. If the expression is an identity or was built before, the existing wire comes back. Small affine producers are composed into consumers (section 3.1).
- `circuit.roundAffine(terms, bias)` computes the same arithmetic but keeps it as its own rounding point. It keeps the caller's term order and duplicate terms, and is never composed into consumers.
- `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)` is the raw atom. A constant gate turns it into an affine.
- `circuit.multiply(a, b)` and `circuit.select(gate, off, on)` produce outputs tagged with macro metadata, used for derivatives and gather recognition. Their operands are kept as wires and never composed.
- `circuit.boolean(score)`.
- `assumeRange(wire, minimum, maximum)` is a promise. It drives range propagation, the orientation of a multiply (which operand goes in the gate), and whether a masked read may become a gather. Only source cells are checked at evaluation time (`validateSourceRanges`).
- `assumeOneHot(members, allowAllZero)` promises exact bits with sum one, or zero when `allowAllZero` is set. It enables gather lowering, and `validateOneHotGroups` checks it in tests.
- `inlineCircuit(target, child, sourceWires)` rebuilds a child circuit inside a parent. It maps the child's sources to parent wires and carries over ranges, macro metadata, and one-hot groups. Photos is authored as its own circuit and inlined into IndirectOS this way (window-manager.ts:1133-1134).

### 2.3 Macros and helpers, with measured compiled cost

I built each row alone with representative ranges and compiled it (`macro-costs.ts`). In the table, "ops" means live operations, "layers" means compiled depth, and "weights" means stored sparse weights.

| macro | expansion | ops / layers / weights | exactness contract | UI job |
| --- | --- | --- | --- | --- |
| `emitRelu(v)` | `reglu([], 1, [[v, 1]], 0)` | 1 / 1 / 1 | exact | interval distances, the "nothing above was hit" mass in stacking, clamps |
| `emitMultiply(a, b)`, one operand provably nonnegative | one reglu with the nonnegative operand as gate | 1 / 1 / 2 | equals `f(a * b)` for finite operands, including overflow to Infinity | masking a value by a bit, e.g. `canvasPress = downActive * selectedCanvas`; spring forces; `halfWidth * scale` |
| `emitMultiply(a, b)`, both signed | `reglu(a; b) - reglu(a; -b)` | 3 / 2 / 6 | same | products of two signed values, e.g. `acceleration * timestep` inside a spring |
| `emitSelect(gate, off, on)` | `gate * on + (1 - gate) * off` as two masked products | 4 / 3 / 7 | exact at gate 0 or 1 for finite operands, including extreme magnitudes; a fractional gate interpolates with rounding | maximized geometry, pointer coordinates from latches, open/minimized transitions, snapping a spring during direct manipulation |
| `emitMaximum(a, b)` | `b + relu(a - b)`, preserved rounding | 3 / 3 / 5 | exact for integers below 2^23 in magnitude; fractional inputs can drift | interval and workspace geometry, clamps |
| `emitMinimum(a, b)` | `a - relu(a - b)` | 3 / 3 / 5 | same | the quality bottleneck in candidate-gallery, hit distances |
| minimum and maximum of one pair | shares the difference and relu through deduplication | 4 / 3 / 7 | same | one compare-exchange of a sorting network |
| clamp to 0..1 (a local helper in each app file) | `relu(v) - relu(v - unit)` | 3 / 2 / 5 | plateau exact for `v ≤ 2^24` when `v` is its own wire, but only `v ≤ 2^23` when `v` is a small affine composed separately into both relus (section 7) | hit scores; "any of these is active", e.g. `clamp01(dragForMotion + resizeForMotion)` |
| clamp between runtime bounds (window-manager.ts:1602) | `min(max(value, low), high)` | 6 / 6 / 10 | as for minimum and maximum | window position and size constraints, keeping spring centers inside the viewport |
| rectangle hit (window-manager.ts:1566) | two interval distances, a minimum, clamp to 0..1, boolean | 16 / 9 / 30 | an exact bit; the score is the distance to the nearest edge, clamped, so it rounds within half a pixel of an edge | which window, button, resize grip, or dock item received a press |
| `emitSpring` (numeric-ui-core.ts:1165) | four fixed explicit-Euler substeps, distance and speed thresholds, clamp, select to snap | 46 / 33 / 104 | once the active bit is exactly zero, position equals the destination and velocity is zero | every animated value: window center, size, and scale; thumbnail center and scale |
| `emitArgmax(scores, unit)` | pairwise boolean comparisons with a one-ulp margin that favors the left candidate, `select` of the winning score, then routing the unit back down with products | 3 scores: 14 / 8 / 26; 4: 21 / 9 / 40; 8: 49 / 15 / 95; 16: 105 / 21 / 203; 64: 441 / 33 / 855 | scores in 0..1; output is an exact one-hot by construction and is declared as a group automatically | choosing the best layout in candidate-gallery |
| `emitFirstActive(active, candidates)` | a maximum tree, then routing `active * rootMass` down with `route * left.mass` | 4: 16 / 11 / 30; 16: 76 / 21 / 145; 64: 316 / 31 / 605 | exact one-hot-or-zero only when the gate and every candidate are proven bits; fractional candidates split the mass | fixed-priority ownership among overlapping controls (Photos: previous, next, thumbnails, main image) |
| frontmost among 4 windows (window-manager.ts:1532) | from the top rank down: `rankHit = clamp01(sum stack[rank][window] * hit[window])`, taken only if nothing above was taken; then map ranks back to windows | 55 / 10 / 105, with 4 gather reads | exact for bit inputs and a permutation stack | pointer ownership by stacking order, and the focused window |
| masked selection after argmax (candidate-gallery.ts:332) | `sum selected[layout] * value[layout]` | one gather read per value, 0 stored weights, +1 layer | exact for a declared one-hot and finite candidate ranges | projecting the chosen layout's geometry |

Two app-level tricks are worth naming because they're cheap. First, candidate-gallery scores layouts with `scaledQuality(size, scale) = min(1, size * scale)` and `bottleneck(values)`, a chain of minimums. Second, photo-gallery builds its thumbnail strip by putting compile-time constants into weights. For each item, `offset = sum over focusedItem of focus[focusedItem] * wrappedDistance(item, focusedItem)` (photo-gallery.ts:279-319). A runtime "distance to the focused photo" becomes one affine over the one-hot focus cells, not a comparison per pair.

### 2.4 The trace compiler's emitter

`lab/trace-compiler/compile.ts:141-761` holds the widest vocabulary in the repository, and only the trace compiler uses it:
- `compare` supports all six operators. Integers use `relu(d) - relu(d - 1)`. Continuous values use `exactPositiveBit`, the sign cascade: relu, scale by a power of two, then alternate clamp and multiply by 2^23 until even the smallest subnormal difference saturates to 1. I rebuilt it: 26 ops, 26 layers, 35 weights, and 0 mismatches over 100k pairs of adjacent FP32 values.
- `minimum` and `maximum` are built from an exact comparison plus `select`. Unlike `emitMinimum` they're exact on fractional values, but they cost 26+ layers.
- `floor` of a bounded continuous value is computed as `low + sum of [x >= k]`, limited to 64 integer steps (64 cascades).
- `oneHot` of a bounded integer; `divide` by a constant (multiply by `f(1/b)`) or by a bounded runtime integer (one branch per possible divisor, at most 33); `modulo` by a constant (counting reached multiples) or by a bounded integer.
- `notBit`, `andBit` (a product), `orBit` (`a + b - ab`), `absolute`, and `select`, which checks that both branches have finite FP32 ranges.
- `affineStep` refuses sums whose FP32 result would depend on term order, because the builder sorts terms.

### 2.5 Executor-level vocabulary: gathers

`compileTensorProgram` looks for an affine whose terms are products of one declared one-hot group against value wires, with each member appearing exactly once (numeric-ui-core.ts:684-860). The row keeps its bias and stores no weights. Per evaluation, the executor computes each group's selected index once (`index = sum position * bit`), then adds `packedValues[candidateTable[index]]` for each read (numeric-ui-core.ts:1034-1063).

Every candidate needs a finite declared range, because an unselected `Infinity * 0` would turn the dense sum into NaN. Current counts are 26 reads in candidate-gallery (848 stored weights instead of 940) and 12 in IndirectOS (11,598 instead of 11,742). The pass only speeds up retrieval once a selection exists. It doesn't make the selection itself cheaper.

## 3. Compile pipeline and executor

### 3.1 While building (`Circuit.append`, numeric-ui-core.ts:202-269)

1. Normalize terms and fold constants, unless the call preserves rounding.
2. Compose affine producers into the consumer. Any ordinary affine with fewer than 4 terms is replaced by its own terms (`affineShareThreshold = 4`, numeric-ui-core.ts:883). Wider sums stay as one wire, so a sum read by many consumers isn't copied into each. The test "a sum shared by many consumers stays one materialized wire" pins this. Cheng's memory note on affine composition says the threshold is 12, but the code today says 4.
3. Simplify a reglu with a constant gate, or with a zero left side, into an affine.
4. Deduplicate by a serialized key (kind, bias, terms, rounding flag, macro metadata).
5. Compute the new wire's range with FP32-rounded endpoints. A NaN endpoint makes the range unknown.
6. Record depth as one more than the deepest dependency.

What this means for someone writing UI:
- An ordinary `affine` read only by ordinary consumers costs no operation and no layer, but its terms get copied into each consumer's row. For example, a window's `buttonTop = top + titleHeight/2 - buttonSize/2` is repeated inside each button hit test.
- `multiply`, `select`, `emitMaximum`, and `emitMinimum` keep their operands as wires, so an affine operand must become its own operation and layer. That's why one spring lane is 33 layers deep. In each substep, the acceleration, the new velocity, and the new position each become separate wires before the next product reads them. Of the 193 operations on IndirectOS's longest chain, 58 are preserved-rounding affines.
- Deduplication is global and keyed on exact expressions, so the same hit test written twice costs once.

### 3.2 `compileTensorProgram` (numeric-ui-core.ts:366-539)

1. Plan gather lowering.
2. Walk back from the requested roots and keep only reachable operations. IndirectOS builds 6,146 operations and keeps 5,253.
3. Put each live operation in layer `depth - 1`. This is an as-soon-as-possible schedule. Operations are never delayed to a later layer, and packed storage is never reused. The README TODO names Percepta's mixed-integer scheduling as the reference for doing better.
4. For each layer, build:
   - the union of input wires, sorted by packed position
   - a CSR matrix (`rowOffsets`, `columns`, and `weights` as `Float32Array`), with one row per output plus one gate row per reglu
   - the lists of gate rows, boolean rows, gather computes, and gather reads
   - index arrays in the smallest unsigned type that fits
5. Append outputs to one packed value array. `wireOrder` maps packed positions back to wires.

### 3.3 Executor (numeric-ui-core.ts:989-1081)

Each layer runs in five steps:
1. copy its inputs into a staging buffer
2. run the sparse matmul plus bias, accumulating each row sequentially in FP32
3. apply gathers
4. multiply output rows by `max(0, gate row)` and round boolean rows
5. append the outputs

`createTensorEvaluator(roots)` reuses buffers and returns only the roots. `evaluateTensor` returns a fresh full wire array.

### 3.4 What the pipeline implies

- Depth is the longest chain of materialized operations. The only parallelism is the number of independent operations that happen to share a depth.
- UI circuits are narrow and deep. IndirectOS has a median of 24 values per layer across 192 layers; candidate-gallery has a median of 3 across 60 layers.
- Rows are extremely sparse. IndirectOS averages 1.43 stored weights per projection row (at most 24). A dense matrix per layer (projection rows times input columns) would store roughly 26 times as many numbers.
- Inlining one circuit after another stacks their depths. Photos alone is 91 layers deep. Inside IndirectOS its thumbnails sit at depth 191-193, because Photos reads the window's content size, opacity, and focus, which are around depth 100.
- CPU cost follows live operations and layer count more than stored weights, because staging and appending cost something per layer (section 4.2). That overhead dominates narrow layers.

## 4. Measurements

### 4.1 `bun lab/runtime-cost/report.ts`

| circuit | sources | operations | live | layers | stored weights | roots | reference µs | tensor full array µs | tensor reusable µs | direct JS µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coordinate transform | 3 | 4 | 4 | 3 | 8 | 1 | 0.081 | 0.226 | 0.143 | 0.024 |
| candidate gallery | 27 | 463 | 417 | 60 | 848 | 87 | 13.7 | 5.47 | 4.47 | none |
| window manager (IndirectOS) | 201 | 6,146 | 5,253 | 192 | 11,598 | 429 | 147.5 | 43.2 | 36.0 | none |

### 4.2 `measure-circuits.ts`

Circuit structure:

| | IndirectOS | candidate gallery | Photos alone |
| --- | ---: | ---: | ---: |
| build time / compile time | 28.4 ms / 6.2 ms | 5.0 ms / 0.6 ms | 13.4 ms / 2.2 ms |
| sources | 201 | 27 | 82 |
| operations built / live | 6,146 / 5,253 | 463 / 417 | 2,771 / 2,358 |
| live ordinary affine | 1,268 | 113 | 678 |
| live preserved-rounding affine | 1,078 | 128 | 357 |
| live reglu used as a product | 1,903 | 67 | 836 |
| live reglu used as a plain relu | 940 | 95 | 451 |
| live boolean | 64 | 14 | 36 |
| live multiply and select macro outputs | 1,685 and 210 | 67 and 2 | 836 and 72 |
| layers | 192 | 60 | 91 |
| values per layer: median / 90th percentile / maximum | 24 / 48 / 123 | 3 / 20 / 66 | 24 / 49 / 98 |
| layers with at most 4 values | 20 | 34 | 14 |
| stored weights (without gathers) | 11,598 (11,742) | 848 (940) | 5,574 (5,574) |
| biases, gate rows, boolean rows | 8,096 / 2,843 / 64 | 579 / 162 / 14 | 3,645 / 1,287 / 36 |
| gather reads / group index computations | 12 / 8 | 26 / 1 | 0 / 0 |
| stored weights per projection row: mean / maximum | 1.43 / 24 | 1.46 / 7 | 1.53 / 24 |
| program memory: weights and biases / indices | 78.8 KB / 48.8 KB | 5.7 KB / 3.5 KB | 36.9 KB / 22.4 KB |

Output depths in IndirectOS:

| output | maximum depth | median depth |
| --- | ---: | ---: |
| dock geometry | 59 | 19 |
| window projection | 111 | 102 |
| Photos photos | 150 | 150 |
| Photos thumbnails | 193 | 191 |
| `animationActive` | 185 | 185 |
| next-source cells | 190 | 96 |

In candidate-gallery, the layout scores are at depth 18, the argmax selection at 26, the thumbnails at 28, and the focus next-source at 60.

The longest chain in IndirectOS has 193 operations: 49 products, 38 plain relus, 58 preserved-rounding affines (7 of them select outputs and 9 signed multiply outputs), 46 ordinary affines, and 2 booleans.

Per-evaluation timing (median µs):

| method | IndirectOS | candidate gallery | Photos alone |
| --- | ---: | ---: | ---: |
| reference evaluator (full wire array) | 127.3 | 12.6 | 78.5 |
| tensor evaluator (full wire array) | 39.1 | 4.34 | 17.6 |
| tensor evaluator (reusable, roots only) | 30.8 | 3.55 | 14.6 |
| source range validation alone | 0.23 | 0.035 | 0.098 |
| `machine.step` (JS validation of source and output, evaluation, writeback) | 113.2 | 5.38 | 36.9 |
| replica of the executor: input staging only | 6.4 | 0.49 | 3.0 |
| + sparse matmul | 23.5 | 1.29 | 10.0 |
| + gathers | 23.4 | 1.56 | 10.3 |
| full replica (+ gates, booleans, append) | 30.6 | 3.50 | 14.2 |
| generated JS, one function per layer (0 live-wire mismatches), short warmup | 20.7 | 0.49 | 7.95 |
| generated JS, one monolithic function (0 mismatches), short warmup | 543 | 0.76 | 187 |

Reading these numbers:
- The IndirectOS executor spends about 21% of its time staging inputs, 56% in the sparse matmul, and 23% on gates, booleans, and appending. In candidate-gallery, whose layers are tiny, the gate and append pass is 55%.
- A live operation costs about 5.8 ns in the executor for IndirectOS, and a stored weight about 2.6 ns.
- The JS validation inside `machine.step` costs more than the circuit: about 80 µs of IndirectOS's 113 µs frame step. That's a demo-side cost, not the runtime's.
- The generated-JS rows above had a short warmup. With a 2.5-second warmup (section 6), generated code runs IndirectOS in 2.5 µs and candidate-gallery in 0.29 µs, about 11 times faster than the executor, as long as no single function holds more than a few hundred rows. One 496 KB function stays around 470 µs, because JavaScriptCore doesn't optimize functions that large.

## 5. Gaps, with constructions and measured costs

Cheng's UI code gives a sense of what an author reaches for. Counting in vibescript demos, chenglou.github.io/index.ts, and nicer-hacker-news: `Math.max` 51, `Math.min` 40, `Math.floor` 39, `Math.abs` 31, `while` 24, `Math.imul` 11, `Math.sqrt` 5, `Math.round` 4, one each of sin, cos, exp, and pow, and a handful of `sort`, `findIndex`, `splice`, and `Map` uses. pretext's `src` is dominated by `charCodeAt`/`codePointAt` (76), `while` (48), `Set`/`Map` lookups, `push`, and `measureText`.

Every construction below was built in `constructions.ts` or `probe.ts` and checked against plain JavaScript or BigInt.

| operation | construction | ops / layers / weights | exactness and domain |
| --- | --- | --- | --- |
| `a >= b`, integers | `relu(d) - relu(d - 1)` | 3 / 2 / 6 | exact for integers below 2^24; wrong on 25,283 of 100k fractional pairs |
| `a >= b`, continuous, bounded magnitudes | keep `d = f(a - b)` with `roundAffine`, then `boolean(clamp01(0.5 + 2^9 * d))` | 4 / 3 / 6 | 0 mismatches over 20k adjacent-float pairs per magnitude band from 2^-11 to 2^13, and 20k random pairs per difference band from 2^8 to 2^13. Resolves the trace compiler's 1732 case. Fails near `|a - b| = 2^14` (2,857 wrong of 20k, and 967 outputs that aren't bits), because `2^9 * d` passes 2^23, where the composed -0.5 and -1.5 offsets round to even. Rule of thumb: pick a power-of-two scale `s` with `s * |a - b| ≤ 2^23`; operands whose magnitude is below about `2^-24 / s` can resolve wrong |
| `a > b`, any finite values | sign cascade | 26 / 26 / 35 | exact for `|a - b| < 2^23` |
| `Math.round(x)` outside 0..1 | `roundAffine([[x, 1]], 2^23 + 2^22)`, then `roundAffine([[shifted, 1]], -(2^23 + 2^22))` | 2 / 2 / 2 | ties to even, because the base is even; 0 mismatches over 200k values with `|x| < 2^22`, exact halves included. The boolean atom is the 0..1 case of this |
| `Math.floor(x)`, any FP32 value | `r = round(x)`; subtract the exact bit `[r > x]` from a sign cascade on `r - x`, a difference of at most 0.5 that FP32 computes exactly | 26 / 26 / 35 | 0 mismatches over 200k values with `|x| ≤ 2^21`, including values one ulp below integers |
| `Math.floor(x)`, x on a 1/256 grid | `round(x - 0.5 + 1/512)`; the offset means rounding never hits a tie | 3 / 3 / 3 | 0 mismatches over 200k. The cost of this reformulation is quantizing values before they enter the table, because springs and products break grid alignment |
| bits, `x ^ y`, shifts | parallel floors `q_j = floor(x / 2^j)` on grids, `bit_j = q_j - 2 q_(j+1)`; xor is `a + b - 2ab`; a shift only renumbers bits | bits of one 22-bit integer: 110 / 5 / 132; xor of two 22-bit integers, recombined: 243 / 7 / 374 | 0 mismatches over 100k pairs |
| `Math.imul`-style hashing | multiply by a constant using 11-bit limbs, so every partial product stays below 2^24, with grid floors for carries | 22 / 20 / 28 | equal to `((key * multiplier) mod 2^22) >> 12` computed with BigInt, on 100k keys |
| cheap per-item pseudo-randomness | shader-style hash: `fract(p * .1031)`, `p *= p + 33.33`, `p *= p + p`, `fract(p)`, with `fract` from the round construction | 13 / 13 / 18 | chi-square 21.6 over 16 buckets for keys 0..16384 (15 degrees of freedom) |
| `a / b` at runtime | threshold bits on `b / threshold - 0.5` (the score must be its own wire, see section 7); a seed as first differences over those bits in one affine; Newton steps `x = x * (2 - b * x)`; then `a * x` | 1 threshold per octave, 5 steps: 69 / 20 / 105; 4 per octave, 3 steps: 231 / 14 / 347; 16 per octave, 2 steps: 900 / 11 / 1,350 | for `b` in 1..16384, the reciprocal's maximum relative error is 9.8e-8, 1.4e-7, and 3.6e-7 respectively; 66%, 57%, and 42% of results are bit-equal to `fround(1 / b)` |
| `Math.sqrt(x)` | octave seeds for `1/sqrt(x)`, Newton `r = r * (1.5 - 0.5 * x * r^2)`, then `x * r` | 1 per octave, 5 steps: 114 / 25 / 175; 4 per octave, 3 steps: 394 / 17 / 593 | x in 1..2^24: maximum relative error 1.4e-7 and 1.7e-7 |
| `Math.sin`, `Math.cos` | quadrant `k = round(angle * 2/π)`; `r = angle - k * π/2`; Horner polynomials in `r^2` (degree 9 for sine, 10 for cosine); an exact integer one-hot of `k mod 4` declared as a group; two gather reads choose `±sin r` or `±cos r` | 100 / 18 / 154 (178 without gathers) | angle in [-4π, 4π]: maximum absolute error 6.7e-7 |
| prefix sums (running x in a flow layout, line widths in text) | chain of `roundAffine` | 1,024 values: 1,023 / 1,023 / 2,046 | exact on integer widths |
| | one wide sum per prefix | 1,023 / 1 / 524,799 | accumulates in the same order as the chain, so it's bit-identical on fractional widths |
| | Kogge-Stone parallel prefix | 9,217 / 10 / 18,434 | exact on integers; up to 0.17 px away from the chain on fractional widths below 400 px (totals near 200k px) |
| | Brent-Kung parallel prefix | 2,036 / 18 / 4,072 | same drift as Kogge-Stone |
| | chain of ordinary `affine` | 1,023 / 341 / 3,069 | the builder composes 3-term sums, which changes rounding order: 0.2 px drift |
| sorting | Batcher odd-even merge network of min/max compare-exchanges | 16 values: 252 / 30 / 441; 64: 2,172 / 63 / 3,801 | exact on integers; on fractional values 20-24% of outputs aren't bit-equal to any sorted input (errors up to 6e-5) |
| | rank sort: stable `rank_i = sum_j [x_j < x_i]`; one declared one-hot group per output rank; gather routing | 16 integer keys: 1,266 / 6 / 2,688; 64: 20,418 / 6 / 44,544 | exact on integer keys. Fractional keys need 4-op boolean comparisons (3 layers each) or 26-op cascades |
| `values[index]` | integer index to one-hot via threshold bits, declared group, one gather read | 64 values: 194 / 4 / 318 (510 without gathers); 1024: 3,074 / 4 / 5,118 (8,190) | exact; building the one-hot is O(N) operations, and the read itself is O(1) |
| variable-length lists | bounded visibility compaction ([patterns.md](../../../patterns.md#itemsfilterisvisibleslice0-k-into-k-dom-nodes)): count earlier visible items, one equality bit per item and slot, one declared group per slot (all-zero allowed), gather reads | 100 items into 10 slots: 4,181 / 7 / 13,014; 1,000 into 20: 81,961 / 7 / 660,424 | 0 mismatches over 2,000 random visibility patterns each; the wide prefix counts dominate the weights |
| `while` loops, search until found | unroll to a bound with a mask per iteration (trace compiler), a first-active tree, or one iteration per frame with the state in the table, the way springs integrate | first-active over 64: 316 / 31 / 605 | a bound must be known; carrying iteration across frames trades latency for depth |
| lookups by key (`Map`, `Set`) | resolve keys to slot indices in JavaScript before the table, or compare the query against N stored integer keys (about 3N ops, 2 layers) and gather | not built | |
| strings, `charCodeAt`, `measureText` | outside the circuit: a prepare step turns text into numbers (segment widths, break kinds) that enter the table | not applicable | |
| `Math.exp`, `Math.log`, `Math.pow` | not built. The likely route: `exp(x) = exp(x / 2^k)^(2^k)` with a short polynomial and k squarings; `log` from octave bits plus a polynomial or Newton step on `exp` | | |

What the table suggests:
- Rounding is a missing connective in the macro library: two preserved affines give `round`, three give `floor` for grid values, and bits decompose in parallel. Once these exist, hashing, bitwise operations, trigonometric quadrant reduction, and small-integer one-hots are all shallow.
- Exact comparison doesn't always need the 26-layer cascade. A clamped boolean on a preserved difference, with a power-of-two scale picked from declared ranges, is 3 layers over a wide magnitude window. A compiler could choose the cheap form whenever the ranges allow it.
- Transcendental functions cost roughly 15-25 layers and 70-400 operations each. That's comparable to one spring lane (33 layers), so a UI using a few of them stays in the same depth range as IndirectOS.
- Work that is naturally sequential in JavaScript can be traded for width. Prefix sums go from 1,023 layers to 1 layer (quadratic weights), 10 layers (N log N), or 18 layers (linear). Sorting goes from a 63-layer network to 6 layers of O(N^2) comparisons. Once exact rounding points are accounted for, parallel prefix changes FP32 rounding on fractional values, so a backend has to pick an accumulation order and say so.

## 6. What a GPU or batched backend would look like

The program shape IndirectOS produces:
- 192 layers, with a median of 24 values per layer and a maximum of 123
- 1.43 stored weights per projection row
- 5,253 values and 11,598 weights
- about 430 outputs, most of them read back into the source table or the DOM every frame

That shape is a dataflow graph with a long critical path, not a stack of wide matrices.

Per-layer GPU kernels, in the style of an ML framework, would launch at least one kernel per layer for one UI instance: 192 dispatches, plus gathers and gates. Each layer does only about 60 weight multiplications, so the arithmetic is tiny next to the dispatch cost. I haven't measured WebGPU dispatch overhead here, but it's orders of magnitude above the 0.16 µs the CPU executor spends per layer. Reading outputs back for DOM projection also adds latency.

For a single interactive instance, per-layer GPU execution would be slower than the current CPU path. Framework sparse kernels would also break exactness: they reduce wide rows in parallel, changing rounding order (the prefix-sum rows above show the resulting drift).

The shader-technique reading fits better. The generated JS in section 4.2 is already a flat list of statements, one per live value, which translates mechanically into one compute or fragment shader body per instance. Inside a shader, depth only makes the function longer. Parallelism comes from running many instances of the same program in one dispatch, as a fragment shader runs one program per pixel. Some examples of many instances:
- the same widget repeated thousands of times, e.g. list rows each with a spring and a hit test
- one layout circuit evaluated at hundreds of viewport widths to see where it reflows
- candidate layouts or behavior parameters searched in parallel
- IndirectOS's hit tests evaluated at every pixel of the screen, drawing a map of which window owns each pixel

Requirements for such a backend:
- **Float semantics:** match `Math.fround` step by step. The shader compiler must not contract `a * b + c` into a fused multiply-add or reassociate sums. Metal enables fast math by default, and each target needs checking. The boolean atom would be folded away by an optimizer that simplifies `(x + K) - K`, so a backend should emit it as a native `score >= 0.5 ? 1 : 0`, which equals the atom for scores in 0..1. `max(0, gate)` differs from `Math.max` only on NaN.
- **Gathers:** array indexing with a clamp, which shaders already do.
- **State:** the source table becomes a storage buffer, and `nextSource` becomes a copy into a second buffer (the GPGPU feedback pattern). Only DOM-bound outputs need readback, unless rendering also moves to the GPU and the circuit's translate, scale, and opacity outputs feed instanced quads directly.
- **Size:** IndirectOS's generated body is about 496 KB of JavaScript. Driver shader compilers have their own function-size behavior, similar to what JavaScriptCore showed with the monolithic function.

Batching on the CPU tests the same idea without a GPU. `codegen-study.ts` emits code that loops over B instances inside functions of 64 rows, with pointer coordinates varied per instance, and checks every live wire of the first instances against the executor.

I warmed each variant for 2.5 seconds of wall-clock time before timing (median µs per instance, 0 live-wire mismatches in every variant):

| variant | IndirectOS | candidate gallery |
| --- | ---: | ---: |
| executor, reusable evaluator | 29.6 | 3.36 |
| generated JS, one function per layer | 3.27 | 0.37 |
| generated JS, 64 rows per function | 2.53 | 0.30 |
| generated JS, 256 rows per function | 2.54 | 0.29 |
| generated JS, 1,024 rows per function | 439 | 0.29 |
| generated JS, one monolithic function | 473 | 0.29 |
| generated JS looping over 1 instance, 64 rows per function | 4.75 | 0.33 |
| generated JS looping over 16 instances, per instance | 2.01 | 0.22 |
| generated JS looping over 256 instances, per instance | 5.82 | 0.22 |

Interpretation is about 90% of the executor's cost. The same arithmetic written as plain JS statements runs IndirectOS in about 2.5 µs per frame, roughly 0.5 ns per live value, as long as each function is small enough for JavaScriptCore to optimize. Functions of 1,024 rows or more ran about 170 times slower.

Looping over instances inside the generated functions adds little on a CPU: 16 instances cost 2.0 µs each, and 256 instances cost more per instance, probably because 256 copies of 5,253 values (5.4 MB) stop fitting in cache. On a CPU, code generation matters far more than batching. Batching pays only on hardware that truly runs instances in parallel.

An earlier run of the same code with a short warmup (`codegen-wm.json`, and the generated-JS rows in section 4.2) showed 20-110 µs for IndirectOS. That run caught JavaScriptCore still compiling large functions in its background tiers, which matters for a page's first seconds.

Scheduling matters differently per backend:
- **Per-layer backend:** fewer layers means fewer dispatches. Section 3.1's preserved-rounding materialization and the spring's 33 layers are the main targets.
- **Whole-program shader:** what matters is the size of the statement list and instance count.
- **Framework backend:** Percepta's mixed-integer scheduling (minimizing peak live values) reduces memory, but not depth.

## 7. Surprises and hazards found while measuring

- **Composed clamp plateau:** clamp to 0..1 loses its plateau above 2^23, not 2^24, when its input is a small affine composed separately into both relus. The four-thresholds-per-octave square root first failed with a relative error of 1. The score `x / threshold - 0.5` for `x ≈ 1.4e7` was composed into `relu(score)` and `relu(score - 1)`, each rounding `cx - 0.5` and `cx - 1.5` to even, which produced a clamp result of 2 that the boolean atom passed through. Materializing the score with `roundAffine` fixed it (0 failures, maximum relative error 1.7e-7). macro-ranges.md states the 2^24 limit for a materialized value. The composed form has a lower limit, and nothing in the builder warns about it.
- **Spring depth:** springs are the deepest macro. One scalar lane is 46 ops and 33 layers. IndirectOS has 44 lanes (5 per window, 2 per thumbnail), roughly 2,000 of its 5,253 live operations. Preserved rounding around `multiply` makes each substep materialize its affine operands.
- **Inlining cost:** Photos inside IndirectOS is about 100 layers deeper than Photos alone, because it reads window outputs.
- **Cheap comparisons:** the boolean atom on a preserved difference with a power-of-two scale is an exact comparison over a wide, declarable magnitude window, in 3 layers instead of the cascade's 26.
- **Round and floor:** `round` for `|x| < 2^22` is two preserved affines, and `floor` on a grid is three. Neither exists as a macro.
- **Frame validation:** the frame-time JS validation in `machine.step` costs about 2.6 times the circuit for IndirectOS.
- **Interpreter overhead:** interpretation is about 90% of the executor's time. Generated JS runs IndirectOS in 2.5 µs instead of 30 µs, but only when functions stay within a few hundred rows and the engine has warmed up. One monolithic function costs about 470 µs, and a short warmup shows 20-110 µs.
- **Composition threshold:** `affineShareThreshold` is 4 in the code, while the memory note on affine composition says 12.
- **Wide sums:** a wide sum per prefix is bit-identical to a sequential chain, because both accumulate in ascending wire order. Wide sums are the safe way to flatten depth without changing rounding.

## 8. What the tests pin

numeric-ui-core.test.ts pins:
- inlined circuits share matching expressions
- layers append only new values
- weights and biases are stored as `Float32Array`
- index arrays use the smallest unsigned type
- first-active uses at most `5 log2 N + 1` layers, and argmax at most `6 log2 N`
- argmax ties choose the lower index
- every arithmetic step rounds (`2^24 + 1` stays `2^24`)
- the reference backward pass follows affine and reglu, and boolean derivatives are rejected
- a wrong source length is rejected
- duplicate terms merge into one coefficient
- a wide sum stays one wire regardless of consumer order, and identical consumers share one wire
- constant folding, identity aliasing, affine composition, and deduplication behave as described in section 3.1
- dead-code removal from roots
- layers gather only the values they read
- affine outputs don't allocate gate rows
- the boolean tie rule sends 0.5 to 1

numeric-semantics.test.ts pins:
- `roundAffine` survives consumers, duplicate terms, and inlining with permuted sources
- ranges include rounded endpoints and overflow
- overflowing unselected candidates don't lower to gathers
- min/max ranges describe their arithmetic, and the weaker bounds hold on a unit-interval FP32 sweep
- multiply has the right derivative at zero in either order
- select preserves extreme finite operands and its derivative
- boolean surrogate derivatives must be requested explicitly
- the reusable evaluator returns only roots and refreshes on every call
