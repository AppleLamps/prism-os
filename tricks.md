do not change this before asking the user

# Tricks

## Instancing

Use one shared function for repeated items:

```txt
rectangle = layout(instance index, count, container, shared inputs)
```

This can produce many rectangles without separate layout logic for every item. The circuit still needs a fixed maximum item count for now.

## One-hot indexing

Recover a selected index from exact one-hot bits:

```txt
selected index = selected[0] * 0 + selected[1] * 1 + ...
```

Compute this once, then let every item compare itself with the shared index. This can replace an `items * possible selections` lookup with one reduction followed by one calculation per item. It does not provide cyclic wraparound by itself; use a bounded wrap correction or circular coordinates for that.

## Circular coordinates

Represent a position in a repeating sequence as a point on an imaginary circle. The first and last items are then naturally close, so cyclic distance and direction need no modulo jump. For a fixed item count, the circle points are constants and the remaining math is differentiable.

## Decision bits

A score is not automatically a decision. A rectangle edge may produce `0.3`; that is useful for smooth math but invalid for `open`, `focused`, or `maximized` — passing it onward as state would give a partly maximized UI. Make the bit exact at the moment a score becomes a decision (click ownership, focus, visibility flags), and keep positions, sizes, opacity, scale, springs, and epsilon-based animation settling at full precision. Once a bit exists, ordinary Boolean arithmetic (products, sums of exclusive bits) preserves it; the constructions below are needed only at that first crossing. Three ways to cross, from cheapest to most general:

When the score is an integer count, `relu(score) - relu(score - 1)` is already the exact bit of `score >= 1`: an integer cannot land strictly between 0 and 1, so the clamp never emits a fraction. Prefer this form for decisions that can be phrased as counts, e.g. `visible = clamp01(baseVisible + how many selected slots reveal me)`. It needs no special constant, it trains with the plain reference backward pass (for a fractional score inside `0..1` the same expression is the identity ramp, so no surrogate gradient is needed), and it stays exact in narrower formats like bfloat16 as long as the integers fit the mantissa. Validated in `exp/exp-integer-boolean.ts`.

When the score is genuinely continuous and lands in `0..1` — a clamped hit distance, say — the cheap bit comes from rounding. FP32 loses fractional precision near a sufficiently large number: add `8_388_609`, then subtract it, to round the score at `0.5`. This is the `boolean` atom (see `execution-model.md`): one operation, total on `0..1`, but FP32-specific, and its backward pass must invent a slope (a surrogate gradient; the exact forward result is unchanged either way).

When the decision is a comparison between two continuous values and the answer must be exact for ANY finite difference — even one below the rounding step of a scaled score — use the sign cascade: `relu(difference)` keeps the positive side, then alternate multiplying by a power of two (exact in FP32: the exponent shifts, the mantissa is untouched) with `clamp01` (exact below `2**24`), until every positive value has saturated at exactly 1. `a >= b` is the negation of `b > a`; equality is `1 - greater - less` in one exact integer step. This came out of the trace compiler experiment (`lab/trace-compiler`), whose exhaustive sweep caught the rounding approach mis-resolving a real layout case — viewport width 1732, where `(1732 - 24) * fround(1/244)` lands one FP32 ulp below 7 — and every circuit that experiment compiles now contains zero boolean atoms. The consequence for the substrate: the `8_388_609` constant is a one-operation compression of this construction, not a necessity.

`emitCompare(circuit, a, relation, b)` in `numeric-ui-core.ts` builds this cascade from both operands' declared ranges, which must be finite. For operands within `0..16,384`, `a >= b` takes 15 operations in 14 layers, and `a > b` 16 in 15. When both operands are declared on a grid, e.g. `circuit.assumeGrid(pointerX, 1 / 64)`, it builds an integer bit instead, in 2 operations and 2 layers. `execution-model.md` has the full cost table.

History, briefly: the relu form is the older of the two — the first commit's integer machinery had it as `emitStepForInteger` — and it was deleted with the move to continuous coordinates (`6cf0d81`), one day before the rounding boolean arrived (`fd8f0a3`). It returned once behavior decisions turned out to be integer counts after all, and the sign cascade then closed the remaining gap for continuous comparisons.

## Magnitude safety

FP32 represents every integer exactly only up to `2**24` (16,777,216); above that the gap between neighbors grows to 2, then 4. Macros that subtract inside their expansion silently lose precision past that point:

- `clamp01(v) = relu(v) - relu(v - 1)` returns exactly 1 only for `v <= 2**24`; it returns 2 at `2**24 + 2` and collapses to 0 by `2**25`.
- `max`/`min` (`b + relu(a - b)`) and `select` with gate 1 reconstruct through a subtraction, so they are exact only when the difference fits: keep integer operands under `2**23` so `|a - b| < 2**24`. `select` gate 0 and `off = 0` are exact at any size; `multiply` is one product, exact for all finite inputs; the rounding boolean above is exact in `0..1`.

Keep clamp/min/max/select inputs well under `2**23` (~8.4M). Pixel-space UI (coordinates in the thousands, scores in `0..1`) sits orders of magnitude inside the band; the only way out is to deliberately scale up (e.g. a `* 100000` sharpening constant) — don't. Full per-macro table and failing values in `macro-ranges.md`.

## Dynamic division

Explore whether FP32's changing precision can provide enough nonlinearity to compute a useful reciprocal, then multiply by the numerator. This could support division between two runtime values without adding division as a primitive.

This has not been validated.

## Bounded visibility compaction

If at most ten of one hundred items can be visible, first compute one cheap visibility bit per item. Count earlier visible items to give each visible item a number, then route visible numbers `0..9` into ten output slots.

The circuit keeps a fixed shape: one hundred visibility checks followed by ten expensive item paths. It does not know which ten items ahead of time. This still needs an exact-bit routing test in our compiler before we rely on it.

## Parallel argmax

Compare candidates in pairs, then compare the pair winners until one remains. Route that result back down the same tree to produce a one-hot winner.

This selects among `N` candidates in `log N` dependent steps. Every comparison on the same step runs independently, and the full construction remains differentiable apart from the explicit Boolean decisions it contains.
