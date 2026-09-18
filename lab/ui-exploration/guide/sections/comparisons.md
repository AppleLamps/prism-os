# How comparisons become exact bits

A UI makes yes-or-no decisions all the time: is the pointer inside this window, has the drag moved past the drag threshold, has the list scrolled past this row, does this toolbar button still fit. In JavaScript each of these is a comparison, e.g. `pointerX >= windowLeft`. An Indirect circuit has no comparison operator and no `if`. A circuit computes with three operations, affine sums, ReLU-gated products and the boolean atom, and every decision has to be built from those three. The fourth instruction, the index read, only copies a value at a computed position.

This section explains three ways to turn a comparison into an exact bit, what each one costs, what backpropagation and compiler rewrites do to each one, and which one to use by default. Numbers come from the runnable examples in [examples/comparisons](../examples/comparisons/), unless another folder is named.

On September 14, 2026 Cheng decided that building blocks use one helper, `emitCompare` in numeric-ui-core.ts, which builds a different form depending on the declared ranges and grids ([decision 2](../review-and-decisions.md#2-which-comparison-should-building-blocks-use-and-who-chooses-it)). The forms below are built by hand to show how and why each one works, and [Which form to use by default](#which-form-to-use-by-default) describes what the helper builds.

## In brief

- The sign cascade gives an exact bit without relying on FP32 rounding. It's documented in [expressions.md](../../../../docs/expressions.md#decision-bits), "Decision bits" (the sign cascade paragraph), and in [lab/trace-compiler/README.md](../../../trace-compiler/README.md), "The Sign Cascade". Commit 3c59821 (2026-07-07) added the cascade to tricks.md, now expressions.md, and commit aee659a (2026-07-08) landed the trace compiler, whose `exactPositiveBit` in compile.ts emits a sign cascade for every comparison on continuous values. None of the trace compiler's measured circuits contains a boolean atom.
- The cascade is more precise. Its bit equaled JavaScript's `>` on every FP32 input tested, including differences as small as 2^-149, and an exact check with BigInt arithmetic found no operation inside it that rounds.
- The cascade runs through `backpropagateReference` without a special case, while the boolean atom makes the backward pass throw. But the gradient that reaches the operands is 0 at every tested input except one, where it overflows to Infinity. A step function's derivative is 0, so the cascade on its own gives no training signal; what can be trained is a softer version of the same code, e.g. a single clamp.
- Nothing inside the cascade can be simplified away the way `(x + 8,388,609) - 8,388,609` can, because the cascade gives the right bit in real arithmetic too. Two things can still break the cascade: an optimizer that copies one stage into the next stage and regroups the terms, and hardware that treats subnormal values as 0, which breaks native comparisons on the same inputs.
- It costs 16 operations and 15 layers to handle every pair of FP32 values within 16,384 when each multiplication sits inside a ReLU's gate. The 26 operations and 26 layers quoted in earlier write-ups are the trace compiler's layout of the same idea, with each multiplication as its own operation.
- The recommended default is integer bits on inputs quantized by the host, and the sign cascade for values that come out of non-integer arithmetic. The boolean atom becomes an optional last stage that saves 2 layers when the executor is known to keep FP32 rounding.
- That default is now `emitCompare(circuit, a, relation, b)` in numeric-ui-core.ts. It builds integer bits in 2 operations and 2 layers when both operands are declared on a grid, the sign cascade otherwise, and the atom only with `{endWithBoolean: true}`, and it records every operation it builds as a rounding point, of kind `'integer bit'` or `'sign cascade'`.

## Why a decision has to be exactly 0 or 1

A number between 0 and 1 is fine for smooth things like opacity, but not for a decision. If `maximized` comes out as 0.3, the window is drawn partly maximized, and every value multiplied by `maximized` is scaled by 0.3 ([expressions.md](../../../../docs/expressions.md#decision-bits), "Decision bits").

Exact bits combine without error. The product of two bits is an exact AND, `1 - bit` is an exact NOT, and a sum of bits is an exact count, e.g. `openWindowCount = open[0] + open[1] + open[2] + open[3]`.

The compiler relies on exact bits too. A one-hot group is a list of bits in which exactly one bit is 1, e.g. which of 4 windows has focus. After `circuit.assumeOneHot(focusBits)`, gather lowering replaces "the sum of every candidate times its bit" with "read the candidate at the selected index". A fractional bit makes that declaration false: the reference evaluator then blends two candidates, while the compiled program reads one.

## Terms used below

- `[condition]` means 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript, e.g. `[pointerX >= windowLeft]`.
- FP32 is the 32-bit float format of `Float32Array`. `f(x)` means `Math.fround(x)`, which rounds x to the nearest FP32 value.
- An FP32 step is the gap between an FP32 value and the next larger one, e.g. 2^-23 just above 1, 1 between 2^23 and 2^24, and 2 just above 2^24. Every integer from -2^24 to 2^24 is an FP32 value.
- Subnormal values are the nonzero FP32 values smaller than 2^-126, down to 2^-149. They fill the gap next to 0, so for finite FP32 values, `f(a - b)` is 0 only when `a === b`, and otherwise has the sign of `a - b` even when the subtraction rounds. E.g. `f(16384 - 2^-20)` rounds to 16,384 but stays positive.
- ReLU is `relu(x) = max(0, x)`. `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)` computes `left × relu(gate)`, so `circuit.reglu([], 1, [[x, 1]], 0)` is `relu(x)`.
- `clamp01(x)` is `min(1, max(0, x))`, which two ReLUs compute as `relu(x) - relu(x - 1)`.
- `circuit.roundAffine(terms, bias)` computes a sum as its own operation, adding the bias first and then the terms in the caller's order. The builder normally copies a small ordinary sum, one made with `circuit.affine` with fewer than 4 terms, into every operation that reads it; `roundAffine` prevents that copying.
- The difference bound is the largest `|a - b|` that the declared ranges allow, e.g. 16,384 when `a` and `b` are both declared within 0..16,384.
- The resolution is the smallest positive difference that must give 1, e.g. 1/64 when both operands are on a 1/64 px grid, or 2^-149 to handle every pair of FP32 values.
- Operations count total work, and layers count depth, i.e. the longest chain of operations that must run one after another (see the [glossary](../README.md#glossary)).

## The idea behind all three forms

`clamp01(scale × difference)` is an exact bit of `difference > 0` when, after multiplying by `scale`, every difference that matters is either at most 0 or at least 1. The clamp then returns exactly 0 or exactly 1, and never a fraction. The three forms differ in how positive differences get to 1:

| Form | How positive differences reach 1 | Cost for a, b within 0..16,384 | Needs FP32 rounding? | What `backpropagateReference` does |
| --- | --- | --- | --- | --- |
| Integer bit | the operands are integers, or multiples of a grid step, so positive differences are already at least 1 after scaling | 3 operations, 2 layers | no | runs; slope 1 between two integers |
| Boolean atom | the remaining fraction is rounded to 0 or 1 at 0.5 | 4 operations and 3 layers for differences down to 2^-31; 15 operations and 13 layers for every pair of FP32 values | yes | throws, unless straight-through is requested |
| Sign cascade | multiply by powers of two and clamp, in stages, until the resolution reaches 1 | 16 operations and 15 layers for every pair of FP32 values | no | runs; gradient 0 on the operands |

Every form costs a constant amount of work per comparison. Comparisons that don't read each other run in the same layers, so a thousand hit tests against one pointer add operations but not depth. Depth adds up only when one decision feeds the next comparison, which is why the per-comparison layer count matters on long dependency chains (see [A chain of dependent decisions](#a-chain-of-dependent-decisions)).

## Form 1: integer bits

**The problem.** Decisions on counts, indices and inputs the host quantized, e.g. "is the pressed item at index 7 or later", or "is the pointer, stored in 1/64 px, right of the window's left edge".

**The JavaScript way.**

```js
const pressedAtOrAfterSeven = pressedIndex >= 7 ? 1 : 0
```

**The circuit way** ([integer-bit.ts](../examples/comparisons/integer-bit.ts)):

```ts
// [value >= threshold] for an integer value.
function emitAtLeastInteger(circuit: Circuit, value: Wire, threshold: number): Wire {
  const aboveThresholdMinusOne = circuit.reglu([], 1, [[value, 1]], 1 - threshold) // relu(value - threshold + 1)
  const aboveThreshold = circuit.reglu([], 1, [[value, 1]], -threshold)           // relu(value - threshold)
  const bit = circuit.roundAffine([[aboveThresholdMinusOne, 1], [aboveThreshold, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}
```

**Why it works.** The two ReLUs form `clamp01(value - threshold + 1)`, a ramp that is 0 at or below `threshold - 1` and 1 at or above `threshold`. An integer can't land strictly between `threshold - 1` and `threshold`, so the ramp returns exactly 0 or 1. Every value along the way is an integer, and FP32 represents every integer up to 2^24, so nothing rounds while the operands stay within 2^23.

Values on a power-of-two grid work the same way after dividing by the grid step. If the host stores pointer coordinates in 1/64 px, `[pointerX >= windowLeft]` is the integer bit of `64 × (pointerX - windowLeft)`, e.g. `emitAtLeastOnGrid(circuit, pointerX, windowLeft, 1 / 64)`. That bit stays exact while `64 × pointerX` and `64 × windowLeft` stay within 2^23, i.e. within 131,072 px. `emitSumAtLeastZeroOnGrid` does the same for a sum, e.g. `[maxWidth - lineWidth - itemWidth >= 0]`.

**Cost.** 3 operations in 2 layers per decision. N thresholds against one value cost 3N operations, still in 2 layers.

`emitCompare` builds the bit with one operation fewer when both operands are declared on a grid with `circuit.assumeGrid(wire, step)`. With `D = (a - b) / grid`, `[a >= b]` is `relu(1 - relu(-D))`, which equals `relu(D + 1) - relu(D)` at every integer, `[a > b]` is `relu(1 - relu(1 - D))`, and `[a === b]` is `relu(1 - relu(D) - relu(-D))`. That's 2 operations in 2 layers, or 3 operations for equality, while every partial sum stays within 2^24 grid steps according to the declared ranges, e.g. operands within 0..2^17 on a 1/64 grid. Wider operands get the sign cascade instead. The bit is a product instead of a sum of two ReLUs, so the builder can't copy large ReLU values into the sums that read the bit ([shared-runtime-compare.ts](../examples/comparisons/shared-runtime-compare.ts)).

**Measured.** [comparisons.test.ts](../examples/comparisons/comparisons.test.ts) checks the integer bit against `value >= threshold` for the integers from -20 to 20 and near 2^22 and 2^23 with five thresholds, and the grid bit against `a >= b` on 4,005 pairs on a 1/64 grid: 0 mismatches. In the prototypes, [input](../../input/README.md) builds every decision from integer bits and uses no boolean atom, and the [synthesis README](../../README.md) reports that quantizing at the host boundary (scroll positions to 1/4 px, pointers to 1/64 px, times to 1/64 ms relative to the frame) made most decisions integer comparisons.

**When not to use it.** On values that went through non-integer arithmetic. Quantizing the inputs doesn't keep later values on the grid: `0.24 × viewportWidth`, a spring's position or a reciprocal is no longer a multiple of 1/64, and the ramp then returns fractions. In the toolbar chain below, fed arbitrary FP32 widths instead of 1/64 px widths, the integer bit gave 597 wrong decisions out of 20,000, and 229 of those were fractions.

**Pitfalls.**

- Keep the bit as its own operation with `roundAffine`. When the bit is built as an ordinary affine sum, which has fewer than 4 terms, the builder copies both ReLUs into every sum that reads the bit, and those ReLUs can hold large values. In [lists](../../lists/README.md), a weighted sum over bits whose ReLUs reached 8,192 rounded at magnitudes near 1e5, which gave a reciprocal's first estimate a relative error of up to 2.33, and the reciprocal after four Newton steps a relative error of up to 9.0; building the weighted sum with `roundAffine` fixed both errors. In [input](../../input/README.md), a disabled control's score was written as `score + 2^18 × (1 - valid)`, which multiplied the bit's two ReLUs, holding values near 2^18, by 2^18. The partial sums passed 2^24 and arrow navigation picked the wrong control, until the score was selected with a product instead.
- Keep the operands within 2^23, so that `value - threshold + 1` stays within 2^24.

## Form 2: the boolean atom

**What it is.** `circuit.boolean(score)` takes a score declared within 0..1 and computes `f(f(score + 8,388,609) - 8,388,609)`, which is always exactly 0 or 1: a score of 0.5 returns 1, and the FP32 value just below 0.5 returns 0. The [model](model.md#exact-bits) section explains why the rounding lands there. The atom arrived in commit fd8f0a3 (2026-06-07), one day after commit 6cf0d81 removed the first integer bits.

The atom is an operation of its own, not an ordinary sum, because its rounding has to survive compilation. An optimizer that treats floats as real numbers simplifies `(x + 8,388,609) - 8,388,609` to `x`.

**A rounding stage on a difference.** Most of the prototypes compared continuous values with one rounding stage: a difference, multiplied by a power of two, clamped into 0..1, and rounded (numeric-library's `emitCompare`, layout-tree, text-tabulated). From [boolean-atom.ts](../examples/comparisons/boolean-atom.ts):

```ts
// [difference > 0]. scale is a power of two with scale × |difference| <= 2^22.
function emitRoundingStage(circuit: Circuit, difference: Wire, scale: number): Wire {
  const justBelowHalf = 0.5 - 2 ** -25
  const scoreAboveZero = circuit.reglu([], 1, [[difference, scale]], justBelowHalf)
  const scoreAboveOne = circuit.reglu([], 1, [[difference, scale]], justBelowHalf - 1)
  // clamp01(0.5 - 2^-25 + scale × difference), copied into the atom's operation by the builder
  const score = circuit.affine([[scoreAboveZero, 1], [scoreAboveOne, -1]])
  circuit.assumeRange(score, 0, 1)
  return circuit.boolean(score)
}

// [pointerX > windowLeft] for coordinates within 0..16,384. Scale 2^8 keeps 2^8 × 16,384 = 2^22.
const difference = circuit.roundAffine([[pointerX, 1], [windowLeft, -1]])
const pointerRightOfEdge = emitRoundingStage(circuit, difference, 2 ** 8)
```

**Why it works.** `0.5 - 2^-25` is the FP32 value just below 0.5, so a difference of 0 scores just below 0.5 and rounds to 0, while a positive difference large enough to push the score to 0.5 rounds to 1. Multiplying by a power of two is exact, and the clamp stays exact while `scale × |difference|` is at most 2^22. Unlike a clamp stage of the cascade below, the score doesn't need to reach exactly 1, only 0.5, so one rounding stage covers a ratio of 2^45 between the difference bound and the resolution (numeric-library's contract). For operands within 16,384, the contract covers every difference of at least 2^-31; measured, a stage with scale 2^8 returned 1 for positive differences down to 2^-34, and 0 below that.

**Cost.** 4 operations in 3 layers: the difference, two ReLUs and the atom. When the ratio between the bound and the resolution is wider than 2^45, clamp stages from the cascade run first. Handling every pair of FP32 values within 16,384 takes 5 clamp stages and a rounding stage: 15 operations in 13 layers.

**The atom on integers.** [text-editing](../../code-points/README.md#merged-from-text-editing-september-16-2026)'s editor, now in code-points, compares integers with a single atom on `0.5 + (a - b) × 2^-24`: 1 operation in 1 layer (`emitAtLeastIntegerByRounding` in [boolean-atom.ts](../examples/comparisons/boolean-atom.ts)). The builder adds the bias first and then each term. While every partial sum stays within 2^22 of 0, each partial score is a multiple of 2^-24 between 0.25 and 0.75, which FP32 represents exactly, so equal operands score exactly 0.5 and round to 1, and `a = b - 1` scores `0.5 - 2^-24` and rounds to 0. The test checks this form against `a >= b` on 3,006 integer pairs within 0..2^22: 0 mismatches. `emitCompare` with `{endWithBoolean: true}` builds this form when both operands are declared on a grid and every partial sum stays within 2^22 grid steps.

**Measured.**

- [numeric-library](../../numeric-library/README.md) measured `emitCompare` at 0 wrong over 1M pairs in each of three tiers: integers up to 2^20, pixel values up to 2^14 at a resolution of 2^-30, and every pair of FP32 values.
- One rounding stage with scale 2^8, on a source cell holding a difference within ±16,384, always returned 0 or 1, but returned 0 for every positive difference below 2^-34. Over 4,034 differences from every FP32 class (listed under the cascade's measurements), that gave 660 wrong bits: 5 of the 10 subnormal values, 4 of the 8 smallest normal values, 2^-40, and 650 of 2,000 random bit patterns. On 20,005 operand pairs within 0..16,384, of which a fifth have both operands below 2^-20, it gave 1 wrong `[a > b]`.
- With clamp stages first, the same checks gave 0 wrong over 4,050 differences up to the largest finite FP32 value, and 0 wrong on the 20,005 pairs.

**When not to use it.**

- On an executor that doesn't keep FP32 rounding at the atom, e.g. a float64 executor, or a GPU shader without a guard (see [What compiler rewrites do to each form](#what-compiler-rewrites-do-to-each-form)).
- When a gradient has to flow through the decision (see [What backpropagation does through each form](#what-backpropagation-does-through-each-form)).

**Pitfalls.**

- Choose the scale from the declared bound and the resolution. A scale that's too small gives wrong bits for small differences, e.g. at viewport width 1,732 (below), a rounding stage with scale 2^-6 gives the wrong bit for a difference of 2^-21.
- Below its resolution, a rounding stage returns a wrong bit without any sign that something went wrong.
- The atom on integers depends on the order in which the builder adds the terms. `emitSumAtLeastZeroByRounding` checks the partial sums from the declared ranges while building, but a term that the builder copies in from a small ordinary sum changes those partial sums.

## Form 3: the sign cascade

**The problem.** Comparisons on continuous values that went through FP32 arithmetic, e.g. a hit test on a spring's current position, or `columnsReal >= 7` after multiplying by a reciprocal.

**The JavaScript way.**

```js
const pointerRightOfEdge = pointerX > windowLeft ? 1 : 0
```

**Why it can be exact.** Three facts about FP32:

1. For finite FP32 operands, `difference = f(a - b)` is 0 exactly when `a === b`, and otherwise has the sign of `a - b`. This fact relies on subnormal values.
2. Multiplying by a power of two of at least 1 is exact, because the multiplication only changes the exponent, as long as the result doesn't overflow.
3. `x - relu(x - limit)` equals `min(limit, x)` exactly for `0 <= x <= 2^24 × limit`, because `x - limit` is an FP32 value there. E.g. with `limit = 1`, `x = 2^24` gives 1, but `x = 2^24 + 2` gives 2, because `2^24 + 1` isn't an FP32 value and `f(x - 1)` rounds back to 2^24.

So one stage, `output = scale × input - relu(scale × input - limit)`, computes `min(limit, scale × input)` with no rounding, as long as `scale × input` is at most `2^24 × limit`. Chaining stages multiplies their scales. After the last stage, whose limit is 1, the output is `min(1, relu(difference) × (the product of all scales))`. When that product is at least 1 divided by the resolution, every difference at or above the resolution gives exactly 1, and every difference at or below 0 gives exactly 0.

**What the trace compiler emits.** `exactPositiveBit` in lab/trace-compiler/compile.ts keeps `relu(difference)`, multiplies it by a power of two that lifts the range to about 2^23, then repeats "clamp01, then multiply by 2^23" until the total exponent reaches 150, and clamps once more. Each multiplication is its own operation, so each stage is 3 operations in 3 layers. For a difference within ±16,384 that's 26 operations in 26 layers, the "26 and 26" of earlier write-ups (`emitTraceCompilerCascade` in [sign-cascade.ts](../examples/comparisons/sign-cascade.ts) copies this layout).

**The circuit way, with each multiplication inside a ReLU's gate** (`emitPositiveBitWithScales` in [sign-cascade.ts](../examples/comparisons/sign-cascade.ts), shortened, for difference bounds up to 2^24, where every limit is 1; `emitPositiveBit` in the same file handles larger bounds):

```ts
// [difference > 0] as stages of min(1, scale × input).
function emitPositiveBitWithScales(circuit: Circuit, difference: Wire, scales: readonly number[]): Wire {
  const [firstScale, ...laterScales] = scales
  // The first stage reads the signed difference, so it keeps only the positive side.
  const scaledPositive = circuit.reglu([], 1, [[difference, firstScale!]], 0)  // relu(firstScale × difference)
  const scaledAboveOne = circuit.reglu([], 1, [[difference, firstScale!]], -1) // relu(firstScale × difference - 1)
  let clamped = circuit.roundAffine([[scaledPositive, 1], [scaledAboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  for (const scale of laterScales) {
    const aboveOne = circuit.reglu([], 1, [[clamped, scale]], -1)    // relu(scale × clamped - 1)
    clamped = circuit.roundAffine([[clamped, scale], [aboveOne, -1]]) // scale × clamped - aboveOne
    circuit.assumeRange(clamped, 0, 1)
  }
  return clamped
}

// [pointerX > windowLeft] for coordinates within 0..16,384: 2^10 × (2^24)^5 × 2^19 = 2^149.
const difference = circuit.roundAffine([[pointerX, 1], [windowLeft, -1]])
const pointerRightOfEdge = emitPositiveBitWithScales(circuit, difference, [2 ** 10, 2 ** 24, 2 ** 24, 2 ** 24, 2 ** 24, 2 ** 24, 2 ** 19])
```

`[a >= b]` is `1 - [b > a]` (`emitAtLeast`), an ordinary affine sum of one term, which the builder copies into the operations that read it, without an extra layer. `[a === b]` is `1 - [a > b] - [a < b]` (`emitEqual`), where both cascades read one difference and the two bits can't both be 1. `emitCompare` in numeric-ui-core.ts plans the same scales, and ends `[a >= b]` and `[a === b]` with one ReLU, `relu(1 - scale × stage)`, instead of a clamp followed by a negation. For operands within 0..16,384 that's 15 operations in 14 layers for `[a >= b]`, and 28 operations in 14 layers for `[a === b]`.

**Planning.** `planSignCascade({differenceBound, resolution, stageExponent})` computes the stages from the bound and the resolution. The first stage multiplies as far as the bound allows, 2^24 divided by the bound, e.g. 2^10 for 16,384, and each later stage multiplies by up to 2^24, until the product of the scales reaches 1 divided by the resolution. The default resolution is 2^-149, the smallest subnormal value, which handles every pair of distinct FP32 values. A bound above 2^24, e.g. the largest finite FP32 value, first lowers the limit by a factor of up to 2^24 per stage without multiplying, because multiplying by less than 1 would round the smallest differences to 0. `emitGreater`, `emitAtLeast` and `emitEqual` read the bound from the declared ranges. numeric-ui-core.ts's `emitCompare` plans its stages the same way, with at most 12 stages for any finite bound.

**Cost.** One operation for the difference, 3 for the first stage and 2 for each later stage, with 2 layers per stage. Operations and depth are both O(log2(bound / resolution) / 24) per comparison: every 24 more bits of ratio between the bound and the resolution cost 2 more operations and 2 more layers. How far each stage multiplies sets the constant. For `[a > b]` with a and b within 0..16,384, handling every pair of FP32 values, including the difference operation:

| Layout | Each later stage multiplies by at most | Clamp stages | Operations | Layers |
| --- | --- | ---: | ---: | ---: |
| multiplication inside the ReLU's gate | 2 | 140 | 282 | 281 |
| multiplication inside the ReLU's gate | 2^8 | 19 | 40 | 39 |
| multiplication inside the ReLU's gate | 2^23 | 8 | 18 | 17 |
| multiplication inside the ReLU's gate | 2^24 | 7 | 16 | 15 |
| trace compiler | 2 | 142 | 428 | 428 |
| trace compiler | 2^8 | 19 | 59 | 59 |
| trace compiler | 2^23 | 8 | 26 | 26 |

2^24 is the largest scale that keeps a stage exact when the stage's input is at most 1, so it gives the fewest stages. Equality costs two cascades on one difference: 32 operations in 16 layers.

With a stated resolution, fewer stages are needed. For the same a and b, as stages / operations / layers:

| Resolution | Sign cascade | Clamp stages + rounding stage |
| --- | --- | --- |
| every FP32 value (2^-149) | 7 / 16 / 15 | 5 + 1 / 15 / 13 |
| 2^-60 | 4 / 10 / 9 | 2 + 1 / 9 / 7 |
| 2^-30 | 2 / 6 / 5 | 0 + 1 / 4 / 3 |
| 2^-10 | 1 / 4 / 3 | 0 + 1 / 4 / 3 |
| 1/64 or coarser | 1 / 4 / 3 | 0 + 1 / 4 / 3 |

At a resolution of 1/64 or coarser, the cascade is one clamp on the kept difference, the same ramp as an integer bit plus the difference operation.

**Measured** ([report.ts](../examples/comparisons/report.ts)):

- The differences tested, of both signs: 0, subnormal values, the smallest normal values, values near 1, near 2^14 and near 2^24, huge values up to the largest finite FP32 value, 2,000 random bit patterns (every exponent equally likely) and 2,000 random uniform values, 4,050 in all. A cascade bounded by the largest finite FP32 value gave 0 wrong bits with later stages multiplying by up to 2^24, 2^23 and 2^8 (25, 25 and 49 operations on a cell that holds the difference), and with 2 on a smaller sample of 1,050 values (309 operations). The trace compiler's layout, bounded by 2^14, gave 0 wrong bits over the 4,034 values within that bound with 2^23 and 2^8 per stage, and over a smaller sample of 1,034 values with 2 per stage.
- In every stage of every evaluation, the scaled value stayed within 2^24 × limit, the range where the clamp is exact. The largest ratio was exactly 1 in the gate layout and 0.5 in the trace compiler's layout. Every stage output equaled `min(limit, scaled value)` computed in float64, where these products are exact: 0 violations.
- [exact-arithmetic.ts](../examples/comparisons/exact-arithmetic.ts) computes every operation's result exactly with BigInt, from the same FP32 inputs, and compares that result with the FP32 result. Over every evaluation above, except the two samples with 2 per stage, which weren't checked, 0 operations rounded.
- On 20,005 operand pairs within 0..16,384, of which a fifth are equal, a fifth are adjacent FP32 values and a fifth have both operands below 2^-20: 0 wrong `[a > b]`, `[a >= b]` and `[a === b]`.
- The compiled tensor program gave the same value as the reference evaluator on every live wire of every evaluation.

**When not to use it.**

- On a long dependency chain whose decisions can be quantized instead. Integer bits cost 2 layers per decision instead of 15.
- When an operand has no finite declared range, e.g. a raw `requestAnimationFrame` timestamp. The plan needs a bound, so take times relative to an event instead.

**Pitfalls.**

- Each stage output has to be its own operation, built with `roundAffine`. Built as an ordinary `affine`, the builder copies the output into the next stage. Stage 2's gate then became `-1 - 2^24 × scaledAboveOne + 2^24 × scaledPositive`, added left to right, and for a difference of 0.3 its first partial sum, -5,137,183,745, isn't an FP32 value (FP32 values there are 512 apart), so it rounded. That version (11 operations, 10 layers) gave 1,792 wrong bits over the 4,034 differences within 2^14.
- Never multiply a stage by less than 1: `f(2^-149 × 2^-7)` is 0, so the smallest differences give the same bit as equal operands. numeric-library's `emitCompare` does this when the declared difference bound passes 2^23: `[2^-149 > 0]` returned 0 with bounds of 2^30 and 2^60, and 1 with bounds of 2^15 and 2^23. UI operands stay far below 2^23, so none of the prototypes' measurements reach this case. `planSignCascade` lowers the limit instead, and so does numeric-ui-core.ts's `emitCompare`.
- A cascade planned for a coarser resolution returns fractions below that resolution, not wrong bits. With a resolution of 2^-10, a difference of 2^-20 gives 2^-10. On the 20,005 pairs above, that plan gave 3,106 wrong `[a > b]` and 6,223 outputs that weren't 0 or 1, mostly from the pairs below 2^-20. A fraction in a declared one-hot group makes the declaration false, so check decision cells in tests, e.g. with `validateOneHotGroups`, or handle every FP32 value.

## What backpropagation does through each form

`backpropagateReference` in [numeric-ui-core.ts](../../../../src/runtime/numeric-ui-core.ts) differentiates each operation as real arithmetic. A ReLU-gated product passes gradient to its gate only when the gate is strictly positive, so a ReLU exactly at its corner passes nothing. A boolean atom throws "cannot backpropagate through a boolean atom" unless the caller passes `{booleanGradient: 'straight-through'}`, which passes the atom's gradient to its score unchanged, as if rounding had slope 1. That trick is known in machine learning as the straight-through estimator.

Measured with gradient 1 on the bit, for a and b within 0..16,384 ([report.ts](../examples/comparisons/report.ts); the gradient on b is always the negation of the gradient on a):

| Form and input | Bit | Gradient on a |
| --- | ---: | ---: |
| sign cascade, every FP32 value, a − b = −1 or 0 | 0 | 0 |
| same, a − b = 2^-148, 2^-30, 0.3 or 100 | 1 | 0 |
| same, a − b = 2^-149 | 1 | +Infinity |
| sign cascade at resolution 1 (one clamp), a − b = 0.5 or 1 | 0.5 or 1 | 1 |
| same, a − b = −0.5 or 2 | 0 or 1 | 0 |
| one rounding stage, no option | 1 | throws |
| one rounding stage, straight-through, a − b = 0 or 2^-10 | 0 or 1 | 256 |
| same, a − b = −1, 0.25 or 100 | 0 or 1 | 0 |
| clamp stages + rounding stage, straight-through, a − b = 2^-149 or 2^-130 | 1 | 2^126 |
| same, a − b = −1, 2^-100 or 0.3 | 0 or 1 | 0 |
| integer bit `[value >= 5]`, value = 3, 4 or 6 | 0 or 1 | 0 |
| same, value = 4.5 or 5 | 0.5 or 1 | 1 |

What the table shows:

- The cascade runs through the plain backward pass with no special case, but the operands get gradient 0 at every tested input. That's the true derivative of a step function, and it gives no direction in which to move an operand. The exception is a difference exactly at the plan's resolution, 2^-149 here. The last stage then lands exactly on 1, so its upper ReLU sits at its corner and passes nothing. The gradient flows through all 7 stages, and the product of the scales, 2^149, overflows to Infinity. For false decisions, 3 internal wires get Infinity gradients, which don't reach the operands because the first ReLU's gate isn't positive. [lab/cascade-argmax](../../../cascade-argmax/README.md) reports the same: "The hard cascade does not provide useful score gradients", and "Some internal gradients can also become nonfinite".
- So the cascade doesn't make hard comparisons trainable, as the trace compiler README also says. What can be trained is a relaxation, i.e. a smooth version of the step, built from the same code: fewer or smaller stages turn the step into a ramp. At resolution 1 the cascade is one clamp with slope 1 between 0 and 1. lab/cascade-argmax trained an 8-candidate selection through a soft seven-stage cascade, then moved the learned scores into the hard circuit, which selected the right candidate in 160 of 160 cases over seeds 1 to 10. A single clipped ramp did as well (160 of 160 over seeds 101 to 110), with less than half as many operations.
- Straight-through passes the score's slope, 256 here, but only while the score isn't clamped, i.e. for |a − b| below about 2^-9, and 0 elsewhere. With clamp stages first, it passes the product of every unclamped scale, up to 2^126, for the smallest differences. A score that never clamps passes slopes everywhere. In [drag-knobs](../../drag-knobs/README.md), `emitArgmax` compares candidates with the score `0.5 + 0.5 × (left - right)`, which never clamps. Straight-through gradients there differed from finite differences (the change of an output between two nearby inputs, divided by their distance) at 592 of 2,250 checks on candidate-gallery (a demo in lab/candidate-gallery that scores three candidate layouts and shows the best one) while no decision flipped. One gradient step solved 16.5% of 1,500 frames over 250 drags, against 37.6% when booleans were frozen, i.e. passed gradient 0, with nothing else changed.
- The integer bit gives slope 1 for fractional values between `threshold - 1` and `threshold`, and at exactly `threshold`, where the upper ReLU's gate is 0 and only the lower ReLU passes gradient. `emitCompare`'s integer bits give an operand a nonzero gradient only when `D` is a fraction strictly between -1 and 1, e.g. between -1 and 0 for `[a >= b]`, and that gradient is ±1/grid, so exactly at the threshold they give 0. A fractional `D` only happens when a grid declaration is false.

## What compiler rewrites do to each form

An optimizing compiler may rewrite arithmetic into a form that's equal for real numbers, e.g. simplify `(x + K) - K` to `x`, add a sum's terms in another order, or merge a product and a sum into one fused operation. The boolean atom needs rounding to happen exactly where the atom is written. Integer bits and the sign cascade need no rounding at all: they compute the same bits in real arithmetic, and every intermediate FP32 value equals its real value. That difference determines what an optimizing compiler can break.

[rewrites.ts](../examples/comparisons/rewrites.ts) evaluates one circuit six ways: the stored FP32 semantics; float64 with no rounding at all; FP32 with the atom's `(score + 8,388,609) - 8,388,609` replaced by `score`; FP32 with every sum's terms added in reverse order and the bias last; every sum computed in float64 and rounded once, like a fused kernel; and FP32 with every subnormal value replaced by 0, like hardware in denormals-are-zero and flush-to-zero modes. Wrong outputs:

| Form | Cases | Stored FP32 | float64 | Atom rewritten to its score | Terms reversed | Sums rounded once | Subnormal values set to 0 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| integer bit `[value >= 7]` | 2,001 | 0 | 0 | 0 | 0 | 0 | 0 |
| integer bit `[a >= b]` on a 1/64 grid | 4,003 | 0 | 0 | 0 | 0 | 0 | 0 |
| one atom `[a >= b]` on integers within 0..2^22 | 4,000 | 0 | 4,000 | 4,000 | 0 | 0 | 0 |
| sign cascade, every FP32 value | 4,034 | 0 | 0 | 0 | 0 | 0 | 14 |
| sign cascade with stage outputs copied into the next stage | 4,034 | 1,875 | 1,675 | 1,875 | 1,875 | 1,675 | 1,889 |
| one rounding stage, planned for resolution 2^-31 | 4,034 | 660 | 1,702 | 1,710 | 660 | 660 | 660 |
| clamp stages + rounding stage, every FP32 value | 4,034 | 0 | 2,019 | 2,022 | 0 | 0 | 14 |

Without rounding, the atom returns its score, so every false decision of a rounding stage reads 0.49999997 instead of 0, and the atom on integers returns a score near 0.5 for every pair. The 14 wrong outputs with subnormal values set to 0 are exactly the 14 positive subnormal differences among the cases.

**On a GPU.** [codegen](../../codegen/README.md) probed Apple's Metal shader compiler through two WebGPU implementations, wgpu and Dawn. The compiler simplified `(a + 8388609) - 8388609` to `a` in both implementations (0 of 2 cases kept the rounding), and kept the rounding in `max(a + 8388609, lowest) - 8388609`, with `lowest` read from a buffer (2 of 2). [exactness-budget](../../codegen/README.md#merged-from-exactness-budget-september-16-2026) found that float64 everywhere, which also stands in for that simplification, broke every UI that uses round chains, e.g. 18,820 of 20,000 percent labels of numeric-library's progress ring.

[gpu-probe.ts](../examples/comparisons/gpu-probe.ts) runs the cascade and a rounding stage as WGSL compute shaders with no guards, one `let` per operation, through Deno's WebGPU (wgpu, which translates WGSL to Metal) on this machine's Apple GPU. The inputs are the class values plus 20,000 random bit patterns and 20,000 random uniform values up to the largest finite FP32 value:

- The cascade was right on every value except positive subnormal differences: 5 of the 10 subnormal class values, and 42 of the 20,000 random bit patterns, which are the 42 positive values among 78 subnormal ones. The shader's native `d > 0.0` was wrong on exactly the same values, and `d × 2^100` and `d + d` returned 0 for every positive subnormal value tested, so this GPU treats subnormal values as 0.
- The rounding stage without a guard differed from the CPU on both zeros, all 10 subnormal values, all 8 smallest normal values, and 9,331 of the 11,093 random bit patterns within 2^14, e.g. it returned 0.49999997 for a difference of 0. With the max guard it differed on none.

**Does the cascade rely on anything like `(x + K) - K` surviving?** No. Its result holds in real arithmetic, so rewrites that are valid for real numbers keep it right, including float64, reversed terms and sums rounded once in the table above. The cascade relies on two other things:

- Each stage's sum stays a separate computation before the next stage multiplies it. A rewrite that copies a stage into the next stage and regroups the terms creates partial sums like `-1 - 2^24 × 306.2`, which round, and later stages reach terms like `2^72 × clamped`, which even float64 can't hold exactly, so the copied version fails under every mode above. The builder's own copying did this (see the cascade's pitfalls). codegen's probes didn't test distributing a multiplication over a sum, and the unguarded cascade shader showed no such failure. numeric-ui-core.ts records every operation of this cascade as a `'sign cascade'` rounding point, and every operation of an integer bit as `'integer bit'`, so a backend can find the operations that have to stay separate.
- Subnormal values. On hardware that sets them to 0, differences smaller than 2^-126 give the same bit as equal operands in every form, native comparisons included. Two FP32 operands can differ by that little only when both are smaller than about 2^-103.

## What the 1732 px case shows

tricks.md, now expressions.md, and the trace compiler README cite one real failure of the rounding approach. The trace compiler's column count computes `columnsReal = f(f(viewportWidth - 24) × f(1 / 244))`. At a viewport width of 1,732, `columnsReal` is 6.9999995, one FP32 step (2^-21) below 7, while float64 gives exactly 7. The README says the July policy "scaled a difference into a score near 0.5 and used the boolean atom", and that the score lost that small difference, which is why the trace compiler switched to the cascade. The bits of `[columnsReal >= 7]`, measured:

| Computed by | Bit |
| --- | ---: |
| JavaScript on the FP32 value 6.9999995 | 0 |
| JavaScript in float64, where the value is exactly 7 | 1 |
| sign cascade | 0 |
| rounding stage planned from the declared range for a resolution of 2^-30 (scale 2^16) | 0 |
| rounding stage with scale 2^-5 | 0 |
| rounding stage with scale 2^-6 | 1 |

A rounding stage gives the right bit in this case whenever its scale is at least 2^-5. So the case shows that a rounding stage's resolution depends on its scale, which has to be planned from the declared range and the needed resolution. The case doesn't show that rounding can't give an exact bit. Every circuit form still gives a different result from float64 at this width, because the reciprocal rounds before any comparison runs, which is the point [notes/doctrine.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/doctrine.md) makes. The trace compiler README lists six such widths: 512, 756, 1,000, 1,244, 1,488 and 1,732 px.

## A chain of dependent decisions

Depth adds up when each decision reads the result of the decision before it. [chain.ts](../examples/comparisons/chain.ts) builds a toolbar that places its items on one line in order, and skips an item that doesn't fit in the width that's left:

```js
let lineWidth = lineStart
for (const itemWidth of itemWidths) {
  if (f(f(lineWidth + itemWidth) - maxWidth) <= 0) lineWidth = f(lineWidth + itemWidth)
}
```

Whether item k fits depends on `lineWidth` after item k − 1, so the decisions can't run side by side. Each item costs its comparison plus 2 layers: a product for the placed width and a sum for the new line width. Measured with 20 items, over 1,000 random cases with widths on a 1/64 px grid and 1,000 with arbitrary FP32 widths; in two thirds of the cases, one item lands exactly on the edge or one step to either side:

| Form | Operations | Layers | Layers per item | Wrong decisions, 1/64 px widths | Wrong decisions (of which fractions), arbitrary FP32 widths |
| --- | ---: | ---: | ---: | ---: | ---: |
| one boolean atom on 1/64 px widths (text-editing's form) | 60 | 60 | 3 | 0 | 695 (0) |
| integer bit on 1/64 px widths | 100 | 80 | 4 | 0 | 597 (229) |
| one rounding stage, planned for resolution 1/64 | 120 | 100 | 5 | 0 | 0 (0) |
| sign cascade, resolution 1/64 | 120 | 100 | 5 | 0 | 582 (217) |
| clamp stages + rounding stage, every FP32 value | 340 | 300 | 15 | 0 | 0 (0) |
| sign cascade, every FP32 value | 360 | 340 | 17 | 0 | 0 (0) |

Each column counts 20,000 decisions. Every form keeps the chain at O(n) layers for n items, and the form sets the constant, from 3 to 17 layers per item. The forms on a 1/64 grid are only valid on grid inputs, and the arbitrary-width column shows what happens when that contract breaks. The rounding stage planned for 1/64 still got every arbitrary-width decision right, because at this bound its scale, 2^8, detects differences down to 2^-31 whatever resolution was requested.

## Corrections to earlier write-ups

- **One rounding stage was presented as the default exact comparison.** [lab/ui-exploration/README.md](../../README.md) lists "Exact comparisons from rounding" with "An exact `[a >= b]` costs 4 operations", its capability map gives numeric-library's cost as "comparison 4", and its text section calls text-tabulated's comparison "a 4-atom comparison". That README has since labeled the first two as numeric-library's one-stage form. [layout-tree](../../layout-tree/README.md) says "Every decision uses the 4-atom comparison from phase 1", and [notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) calls the rounding stage "Cheap comparisons ... in 3 layers instead of the cascade's 26". What those statements leave out: "exact" there means exact for differences at or above the stage's resolution, and below the resolution the stage returns wrong bits without any sign (660 of 4,034 class values within 2^14); the stage needs FP32 rounding at the atom, which Metal removes without a guard and a float64 executor doesn't do; and the backward pass rejects the atom. For inputs on a grid, an integer bit is cheaper (3 operations, 2 layers) and needs no rounding. For continuous values, the sign cascade handles every FP32 value in 16 operations and 15 layers without rounding.
- **The cascade's cost was quoted from the trace compiler's layout.** numeric-library's README says "Exact comparison no longer needs a 26-layer cascade" and "Phase one's sign cascade took 26 and 26"; [notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) gives "26 ops, 26 layers, 35 weights"; [notes/doctrine.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/doctrine.md) "about 25 ops and 25 layers"; [notes/pretext.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/pretext.md) "about 25 atoms, 29 layers"; [the gallery README](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/gallery/README.md#against-the-trace-compilers-slices-of-the-same-file) "a 25-layer sign cascade"; text-tabulated's README "No 26-layer sign cascade was needed"; [text-editing's README](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/text-editing/README.md#exactness) "the sign cascade 26"; and tricks.md "~25 operations", which tricks.md, now expressions.md, has since replaced with `emitCompare`'s measured costs. Those counts describe the trace compiler's layout, which spends 3 layers per stage. With each multiplication inside a ReLU's gate, handling every pair of FP32 values within 16,384 costs 16 operations and 15 layers, 2 layers more than ending with the atom (13), and the same 15 layers as numeric-library's own every-FP32 plan within 2^15 (22 operations).
- **numeric-library's `emitCompare` breaks its contract for large bounds.** The contract guarantees an exact bit whenever `a === b` or `|a - b|` is at least the resolution, and the default resolution handles every FP32 pair. When the declared difference bound passes 2^23, the first clamp stage multiplies by less than 1 (2^-7 for a bound of 2^30), and `[2^-149 > 0]` returns 0. numeric-ui-core.ts's `emitCompare` doesn't have this problem, since a bound above 2^24 first lowers the limit.
- **The 1732 px case is evidence about the scale.** tricks.md read the case as "the rounding approach mis-resolving a real layout case", and [notes/doctrine.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/doctrine.md) says both comparison forms "see the same already-rounded value". Both statements are true about different comparisons: the July rounding stage did give a different result from the FP32 source, and every form gives a different result from float64. What the measurements add is that a rounding stage planned from the declared range gives the right bit in this case (see [What the 1732 px case shows](#what-the-1732-px-case-shows)). expressions.md, which replaced tricks.md, now reads the case as a rounding stage whose scale was too small.

## Which form to use by default

On September 14, 2026 Cheng decided that building blocks use one helper, `emitCompare(circuit, a, relation, b, {endWithBoolean})` in numeric-ui-core.ts, which builds integer bits when both operands are declared on a grid, a sign cascade otherwise, and a closing boolean atom only when asked, so call sites don't choose a form. [execution-model.md](../../../../docs/execution-model.md#comparisons) has its contract, its cost table, and what converting IndirectOS's window hit tests to `emitCompare` bits cost, and its [rounding points](../../../../docs/execution-model.md#rounding-points) section says what the builder records for each form. [shared-runtime-compare.ts](../examples/comparisons/shared-runtime-compare.ts) builds the helper, and its test checks every relation against native comparisons and against [sign-cascade.ts](../examples/comparisons/sign-cascade.ts)'s hand-built cascade. The helper has no option for a coarser resolution: without a grid, it always plans for every FP32 value.

The reasons behind those choices, semantics first, then depth:

1. **Quantize at the host boundary, and use integer bits.** This covers counts, indices, and inputs that the host writes on a grid, e.g. pointer coordinates to 1/64 px, scroll offsets to 1/4 px and times to 1/64 ms relative to an event, plus thresholds known while building, snapped to the same grid. `emitCompare` builds an integer bit in 2 operations and 2 layers. The hand-built form above gave the right bit under every executor mode tested, and is a ramp with slope 1 when training feeds it fractional inputs.
2. **Use the sign cascade planned for every FP32 value on continuous values.** This covers values that come out of non-integer arithmetic, e.g. springs, products, reciprocals and remapped ranges. The cascade costs 16 operations and 15 layers for operands within 16,384, and at most 12 stages for any finite bound. Its bits equaled JavaScript's `>` on every FP32 input tested, no operation inside it rounds, and every executor mode tested gave the same bits except setting subnormal values to 0, which breaks native comparisons on the same inputs. The backward pass runs through the cascade, with gradient 0 on the operands.
3. **Treat everything else as a depth optimization with a written contract.**
   - State a coarser resolution only where the data guarantees it, and check the decision cells in tests. At a resolution of 2^-30, the cascade costs 6 operations and 5 layers and a rounding stage costs 4 operations and 3 layers. Below the resolution, a cascade returns fractions and a rounding stage returns wrong bits.
   - End with the boolean atom when the executor keeps FP32 rounding at the atom: the reference evaluator, the tensor executor and codegen's generated JS do, a GPU shader needs codegen's max guard, and a float64 executor has to evaluate the atom as `score >= 0.5`, as [exactness-budget](../../codegen/README.md#merged-from-exactness-budget-september-16-2026)'s float64 mode did. Ending with the atom saves 2 layers (13 instead of 15 for every FP32 value within 16,384) and never returns a fraction, but no gradient passes without straight-through.
   - Use the atom on integers (text-editing's form) where depth matters most. At 1 operation and 1 layer, it's the shallowest decision measured, with the same executor requirement, plus a check of the partial sums while building.

On a chain of dependent decisions, these choices set the constant: 3 layers per toolbar item with the atom on integers, 4 with integer bits, 5 with one rounding stage, 15 with clamp stages and a rounding stage, and 17 with the cascade for every FP32 value. Quantizing at the host boundary keeps a chain at 4 layers per decision without depending on how the executor rounds. For comparison, lab/cascade-argmax's exact argmax over 8 candidates is 196 operations and 75 layers with cascades, against 56 operations and 15 layers for numeric-ui-core.ts's `emitArgmax`, whose comparisons are boolean atoms that can keep the left candidate when the right one is only slightly larger.

## Files

From the repo root:

- `bun test lab/ui-exploration/guide/examples/comparisons` runs 24 tests in about 200 ms.
- `bunx tsgo -p lab/ui-exploration/guide/examples/comparisons` typechecks the folder.
- `bun lab/ui-exploration/guide/examples/comparisons/report.ts` prints every table in this section, in about 0.6 s.
- `deno run --unstable-webgpu --allow-all lab/ui-exploration/guide/examples/comparisons/gpu-probe.ts` runs the GPU probe. The probe isn't part of `bun test`, because the probe needs WebGPU.

| File | What it holds |
| --- | --- |
| [integer-bit.ts](../examples/comparisons/integer-bit.ts) | `emitAtLeastInteger`, `emitSumAtLeastZeroOnGrid`, `emitAtLeastOnGrid` |
| [boolean-atom.ts](../examples/comparisons/boolean-atom.ts) | `planRoundingCompare`, `emitRoundingStage`, `emitGreaterByRounding`, `emitAtLeastByRounding`, and text-editing's atom on integers, `emitSumAtLeastZeroByRounding` and `emitAtLeastIntegerByRounding` |
| [sign-cascade.ts](../examples/comparisons/sign-cascade.ts) | `planSignCascade`, `emitPositiveBit`, `emitPositiveBitWithScales`, `emitGreater`, `emitAtLeast`, `emitEqual`, and `emitTraceCompilerCascade`, a copy of the trace compiler's layout for the cost comparison |
| [chain.ts](../examples/comparisons/chain.ts) | the toolbar line fill in six comparison forms, its plain JavaScript reference, and random cases |
| [rewrites.ts](../examples/comparisons/rewrites.ts) | the six executor modes |
| [exact-arithmetic.ts](../examples/comparisons/exact-arithmetic.ts) | the BigInt check that finds operations whose FP32 result differs from the exact result |
| [measure.ts](../examples/comparisons/measure.ts) | the circuits and checks that the test and the report share, including the class check and the 1732 px case |
| [fp32.ts](../examples/comparisons/fp32.ts) | neighboring FP32 values, the classes of differences, seeded random values, operation and layer counts |
| [gpu-probe.ts](../examples/comparisons/gpu-probe.ts) | the cascade and a rounding stage as WGSL shaders without guards |
| [comparisons.test.ts](../examples/comparisons/comparisons.test.ts) | each example against plain JavaScript, plus the measurements quoted above |
| [shared-runtime-compare.ts](../examples/comparisons/shared-runtime-compare.ts) | `emitCompare` from numeric-ui-core.ts over two coordinates, with and without a grid, and `emitMinimumExact` next to `emitMinimum` |
| [shared-runtime-compare.test.ts](../examples/comparisons/shared-runtime-compare.test.ts) | the helper against native comparisons and the hand-built cascade, its costs, grids, rounding points and the errors it throws |
| [report.ts](../examples/comparisons/report.ts) | the tables in this section |
