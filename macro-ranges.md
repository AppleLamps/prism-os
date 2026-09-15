# Macro magnitude preconditions

The macros in `numeric-ui-core.ts` lower to affine, ReGLU, and boolean operations. Exactness means equality to the stated FP32 calculation, ignoring the sign of zero, not equality to arbitrary JavaScript float64 arithmetic. `f(x)` means `Math.fround(x)`.

| Macro | Forward calculation | Exactness contract |
| --- | --- | --- |
| `emitMultiply(a, b)` | One ReGLU product, or the difference of positive and negative products | Equals `f(f(a) * f(b))` for finite operands, including a product overflowing to infinity |
| `emitMaximum(a, b)` | `b + relu(a - b)` | Integer operands with magnitudes below `2**23`; arbitrary fractional inputs can drift |
| `emitMinimum(a, b)` | `a - relu(a - b)` | Same restriction as maximum |
| `emitSelect(gate, off, on)` | `gate * on + (1 - gate) * off`, with preserved rounding | At gate zero or one, returns the corresponding finite operand exactly, including extreme magnitude differences |
| `clamp01(v)` | `relu(v) - relu(v - 1)` | The upper plateau requires `v <= 2**24` when `v` is its own operation. When `v` is a small affine sum that the builder copies into both ReLUs, both copies must add without rounding, e.g. `v <= 2**23` for multiples of 1/2; see "Clamping and springs". Negative finite values produce zero |
| Settled `emitSpring` | Select destination and multiply velocity by zero | Once its active bit reaches zero and the operands are finite, destination and zero velocity are exact |
| `emitCompare(a, relation, b)` on grids | Integer bits on `D = (a - b) / grid` | Exact bit while every product and partial sum stays within `2**24` grid steps, or `2**22` with `endWithBoolean`; otherwise the sign cascade is built |
| `emitCompare(a, relation, b)` otherwise | Kept difference `f(a - b)`, then stages of `min(limit, scale * input)` | Exact bit for every pair of finite values within the declared ranges, subnormal differences included; refuses open ranges and ranges whose difference can overflow |
| `emitMinimumExact`, `emitMaximumExact`, `emitClampExact` | A comparison bit, then `on * relu(bit) + off * relu(1 - bit)` | Returns exactly one operand, up to the sign of zero; ties return the first operand |
| `emitApplySpringMatrix(matrix, e, v)` | Four multiply products, summed per row | Equals `f(f(m0 * e) + f(m1 * v))` and `f(f(m2 * e) + f(m3 * v))` for finite operands; the matrix cells need finite declared ranges |
| `emitAnimatedObject(springs, options)` | Matrix steps on each spring's stored displacement and velocity, a rebase onto the new destination, and one exceedance sum, one rest bit and one boolean atom per object | A settled, snapped or exactly resting object lands exactly on its destinations with zero velocity, up to the sign of zero; thresholds of at least `2**-22` |
| `emitFirstActive(gate, candidates)` | Up a balanced tree, `emitMaximum` of each pair; down, a node's route `r` gives `r * leftMaximum` to its left child and `r - r * leftMaximum` to its right child, starting from `gate * rootMaximum` | An exact one-hot, or all zeros, when the gate and every candidate are exact bits, since every value in the tree is then 0 or 1; fractional candidates split the route, e.g. candidates `[0.5, 0]` send 0.25 to each output. Declares the one-hot group only when the gate and every candidate are proven bits, i.e. boolean atoms, `emitCompare` bits, members of declared one-hot groups, index reads of such bits, or wires whose range is exactly 0 or exactly 1, and not a `0..1` cell or an AND of bits built with a ReLU |
| `emitArgmax(scores, unit)` | Up a balanced tree, each pair computes `leftWins = boolean(c + s * left - s * right)`, where `c` is the FP32 value just above 0.5 and `s = 1 - c`, and keeps `emitSelect(leftWins, right, left)`; down, `route * leftWins` goes left and the rest goes right | Needs scores declared within `0..1`, `unit` declared exactly 1, and an executor that keeps FP32 rounding at the atoms; always declares the one-hot group. Keeps the left candidate on an exact tie, and in the sweep of adjacent FP32 scores in `lab/ui-exploration/guide/examples/patterns/selection/highest-score-tree.test.ts`, when the right score is less than `1.04e-7` larger, and for some left scores up to `2.09e-7` larger. That band isn't transitive, so the tree can pick a different candidate from a loop, e.g. index 1 of `[0, 0.5, 0.5 + 2**-24, 0.5 + 2**-23]`, where the loop picks index 3. `emitHighestScoreExact` in the same folder's `highest-score-tree.ts` combines pairs with `emitCompare` and matches the loop |

## Multiplication and gradients

For signed finite operands, only one of the two products in `a * relu(b) - a * relu(-b)` is nonzero. The subtraction does not introduce additional error, and the result matches one FP32 multiplication.

The builder preserves multiplication as metadata on its expanded result. Backpropagation uses the derivative of multiplication, including at zero. Differentiating the two ReLUs independently with zero slope at their shared corner previously returned the wrong derivative in one operand order. This metadata adds no runtime atom. `inlineCircuit` preserves it.

## Selection

The older `off + gate * (on - off)` expansion could lose a small selected value, or overflow `on - off` even when both candidates were finite. Both failures are covered by regression tests. The current two-product expansion avoids subtracting the candidates during forward execution.

With a fractional gate, the selection interpolates between the operands with FP32 rounding; the interpolation is not an exact real-number calculation. Infinite or NaN candidates are outside the finite-operand contract because an unselected product can still compute `0 * Infinity`.

## Minimum and maximum

These constructions still have narrower guarantees than native `Math.min` and `Math.max`. For example, `emitMaximum(2**24, -1)` produces `16777215`, and the corresponding minimum produces zero instead of minus one. Fractional values can drift even at small magnitudes. `emitMinimumExact` and `emitMaximumExact` select an operand with a comparison bit instead, and need finite declared ranges on both operands, e.g. `emitMinimumExact(f(1000.37), f(0.3))` returns `f(0.3)`. The trace compiler uses comparison and selection where it needs exact selection between fractional operands.

The subtraction and reconstruction now preserve their rounding order and operand values. Bounds describe that arithmetic, not an ideal mathematical min/max. For finite nonnegative inputs, minimum is bounded by `0..a.maximum`, which allows a rounded result below the smaller input. Maximum retains `0..1` only when both inputs are in that interval. Other cases use the conservative arithmetic bounds, including possible overflow.

## Clamping and springs

The subtraction in `clamp01` stops producing the intended plateau at large magnitudes: `2**24 + 2` can produce two, and `2**25` produces zero. Keeping each stage below that range is part of the sign cascade's forward construction.

Those limits hold when `v` is its own operation, e.g. a source cell or a `roundAffine` result. When `v` is an ordinary affine sum of fewer than 4 terms, the builder copies its terms into both ReLUs, and each ReLU rounds its own sum, so the plateau holds only while both sums add without rounding: whole numbers up to `2**24`, multiples of 1/2 up to `2**23`, and multiples of 1/4 up to `2**22`. E.g. for `v = x - 0.5` at `x = 2**23 + 1`, `relu(v)` computes `f(x - 0.5) = 2**23`, `relu(v - 1)` computes `f(x - 1.5) = 2**23 - 0.5`, and the clamp returns 0.5. Other fractions can round at any size, e.g. `v = x + 0.25` at `x = f(0.8)` returns `0.99999994`. Keeping `v` as its own operation with `roundAffine` restores the limits above. lab/ui-exploration/notes/runtime.md section 7 records a square root whose score hit this case.

A spring's exact settled state depends on reaching an exact inactive bit. It does not imply that every preceding integration step equals a float64 spring, or that gradients through arbitrary temporal dynamics are necessarily stable.

## Index reads

`indexRead` is an instruction, not a macro, and its magnitude contract is about the index. See [execution-model.md](execution-model.md#index-reads) for its definition.

- The index range must lie strictly inside ±2^24, where every integer is an FP32 value. Ranges follow FP32 rounding, so the builder refuses an endpoint on ±2^24, e.g. a cell declared in `0..2**24` plus 1, whose range endpoint `f(2**24 + 1)` is `2**24`, while at that cell value the real sum is one more. The builder infers the range from the declared ranges of the index form's operands, and narrows it with the range declared on the index wire of `indexRead`, or with `indexRange` for `indexReadAffine`. An integer index is computed exactly when every product and partial sum of its form is an integer within that span, e.g. `firstRow + 3` with `firstRow` declared in `0..9999`.
- Positions outside `0..count-1` follow each side's rule, e.g. at index -5, the read returns `candidates[0]` with `'clamp'` and +0 with `'zero'`.
- The copy is exact for every FP32 candidate, including `-0`, the largest FP32 value, subnormal values and infinities.
- The read's inferred range is the union of the ranges of the candidates its index range can reach, plus 0 where a side with the `'zero'` rule is reachable. E.g. an index declared in `2..9` over 4 candidates, with `'zero'` above, covers candidates 2 and 3, and 0. A candidate with no declared range makes the read's range open.

Unlike gather lowering, an index read needs no finite candidate bounds, since it never multiplies an unselected candidate by 0.

## Comparisons

`emitCompare` is described in [execution-model.md](execution-model.md#comparisons). Its magnitude contracts:

- Integer bits: every partial sum of `sign * D + offset`, added bias first, must stay within `2**24` grid steps according to the declared ranges, e.g. operands within `0..2**17` on a 1/64 grid fit, and operands within `0..2**18` get the sign cascade. With `endWithBoolean`, the limit is `2**22` grid steps, so each partial score `0.5 + k * 2**-24` stays within `0.25..0.75`, where FP32 represents every multiple of `2**-24`.
- Sign cascade: a stage multiplies by a power of two only while the product stays at most `2**24` times its limit. A declared difference bound above `2**24` first comes down by up to `2**24` per stage without multiplying, since multiplying by less than one would round the smallest differences to zero. lab/ui-exploration/numeric-library's first `emitCompare` multiplied by `2**-7` for a bound of `2**30`, and returned 0 for `2**-149 > 0`. Coefficients stay at most `2**127`.
- Both operand ranges must be finite, and `f(the largest |a - b| they allow)` must be finite, e.g. operands within `±3.4e38` are refused because their difference can overflow.

Grid inference follows the same rule as integer bits: a sum or product has a grid only while every product and partial sum stays within `2**24` steps of that grid, from declared ranges. An open range gives no grid.

## Springs whose matrix the host writes

`emitApplySpringMatrix`, `emitAnimatedObject` and the host utilities in `host-timing.ts` are described in [execution-model.md](execution-model.md#springs-and-time). Their magnitude contracts:

- Matrix cells: declare them within `±springMatrixBound(constants)`, the largest `|entry|` of `M**n` for `n = 0..maxStepsPerFrame`, with headroom so every FP32 entry the host writes stays within it, e.g. 10.36 for stiffness 650 and damping 45. `springMatrixBound` throws for a spring whose powers overflow, e.g. stiffness `1e7` with 4 ms steps.
- Settle thresholds: at least `2**-22`. A nonzero `relu(offset - threshold)` is at least the FP32 spacing just above the threshold, which is `2**-45` or more, and `2**20 * 2**-45 = 2**-25` is the spacing just below 0.5, so the settle score rounds to 0. E.g. index.ts's 0.01 gives at least `2**-30`.
- Displacements: each spring stores its displacement from its destination, so the stored state and the settle test round at the size of the displacement, not of the position. The drawn position `f(destination + displacement)` rounds once at the destination's magnitude, e.g. to multiples of `2**-7` px near 100,000 px, and isn't stored. When springs stored positions, the settle test computed each offset from a position, so the offset was only as fine as FP32's spacing at that position, and springs near 100,000 px never settled in lab/ui-exploration's gallery prototype. In `spring-matrix.test.ts`'s traces moved to 65,536 and 131,072 px, stored displacements stayed within `1.4e-4` px of float64 and every run settled like float64. On the same traces, the earlier runtime, which stored positions, had 42 to 48 of 48 runs settle differently.
- Retargets: the rebase is `f(f(oldDestination - newDestination) + displacement)`. The destination difference is exact for destinations on a power-of-two grid within `2**23` grid steps, or of the same sign within `2**24` grid steps, e.g. whole-pixel destinations near `2**20`, so only its sum with the displacement rounds, once per retarget. Destinations of opposite signs farther out can round the difference too, e.g. `(2**23 + 1) / 64` and `-(2**23 + 2) / 64` on the 1/64 grid differ by `(2**24 + 3) / 64`, which FP32 rounds to `(2**24 + 4) / 64`, so the drawn position moves by 1/64 px at the retarget. A destination that isn't an FP32 value rounds before it reaches the program, e.g. FP32 values near `2**20` px are 1/8 px apart.
- Rest bit: the ReLUs of every displacement and velocity are multiplied by `2**127` and added, so every nonzero FP32 value, down to `2**-149`, adds at least `2**-22` or Infinity, and `relu(1 - 2**22 * sum)` is exactly the bit of every value being ±0. A backend that turns subnormal values into 0 also turns a displacement below `2**-126` into 0, so that displacement counts as rest.
- Times: `quantizeFrameTiming` returns durations and event times that are multiples of 1/64 ms within `maxStepsPerFrame * stepMs`, 1,200 ms by default, i.e. within 76,800 grid steps, which FP32 holds exactly in a cell. It clamps there, since springs snap past it, and `validateSpringClockConfig` refuses a configuration past `2**24` grid steps. `advanceFrame`'s `PlannedEvaluation.durationMs`, the time since the last evaluation that wrote state back, isn't clamped, e.g. 2,000 ms for the snap after a 2 s stall. A cell that holds it needs a declared range of its own, and FP32 holds it exactly only within `2**24` grid steps, 262,144 ms.

## Bounds and rounding

Inferred ranges follow the rounded coefficient, product, and accumulated sum at each FP32 step. Potentially nonfinite products are not treated as finite zero. Gather lowering requires finite FP32 candidate bounds, not merely finite float64 endpoints.

`Circuit.affine` remains a builder expression that may combine small affine producers. Use `Circuit.roundAffine` when an evaluation must remain a separate rounding point. It also preserves term order, including constant and duplicate terms. Multiplication and selection preserve their operand wires automatically.

`assumeRange`, `assumeGrid` and `assumeOneHot` are caller contracts, not proofs, and so are the integer index of an index read and the exact 0 or 1 in an animated object's `settleCheck` and `snap` cells. A false declaration can still lead to an invalid optimization, e.g. a false grid turns an integer bit into a fraction. See `numeric-semantics.test.ts`, `macro-ranges.test.ts`, `index-read.test.ts`, `comparison.test.ts`, `spring-matrix.test.ts`, and the gather differential tests.
