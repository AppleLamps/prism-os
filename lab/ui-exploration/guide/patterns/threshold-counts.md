# Threshold counts instead of floor and division

A floor or a division with a few possible results becomes a count of the fixed thresholds the input reaches, e.g. a responsive grid's column count is 1 plus how many of 6 widths the container reaches.

```txt
containerWidth = 1000 px

threshold             512   756  1000  1244  1488  1732
[width >= threshold]    1     1     1     0     0     0      columnCount = 1 + 3 = 4

c                       1     2     3     4     5     6     7     8
[columnCount >= c]      1     1     1     1     0     0     0     0
neighbor differences    0     0     0     1     0     0     0            [columnCount == c]
```

Every threshold's comparison with the container's width is computed at once, in the same layers. The bits never go from 0 back to 1 as the threshold grows, so their neighbor differences mark the count with exactly one 1. Anything that depends only on the count, and can be computed for every possible count while building, is then one sum over those bits, e.g. item 10's row is `10 × [columnCount == 1] + 5 × [columnCount == 2] + 3 × [columnCount == 3] + 2 × [columnCount == 4] + ...`, which is 2 at 4 columns.

## The loop it replaces

From chenglou.github.io's photo gallery (index.ts, `colsBoxMaxSizeXF`), and then per photo:

```ts
const cols = clamp(1, Math.floor((containerSizeX - boxesGapX) / (boxMinSizeX + boxesGapX)), 7)
const row = Math.floor(i / cols)
const column = i % cols
```

A circuit can't divide by 244 exactly. Multiplying by `Math.fround(1 / 244)` and rounding down gives one column too few exactly where a new column starts: at 1,000 px, `Math.fround(976 × Math.fround(1 / 244))` is 3.9999998, and the same happens at all 6 thresholds.

## The circuit

From [threshold-counts.ts](../examples/patterns/every-item/threshold-counts.ts), trimmed:

```ts
circuit.assumeGrid(containerWidth, 1) // the host writes whole pixels
// columnThresholds = [512, 756, 1000, 1244, 1488, 1732], i.e. 24 + 244 c for c = 2..7
const reached = columnThresholds.map(threshold => emitCompare(circuit, containerWidth, '>=', circuit.affine([], threshold)))
const columnCount = circuit.affine(reached.map(bit => [bit, 1]), 1)
// hasColumns[c - 1] = [columnCount >= c] - [columnCount >= c + 1], declared with circuit.assumeOneHot
const rows = items.map((_, item) => circuit.affine(hasColumns.map((bit, index) => [bit, Math.floor(item / (index + 1))])))
```

`emitCompare` against a constant threshold builds an integer bit, `relu(1 − relu(threshold − containerWidth))`, in 2 operations, and the constant costs nothing. The clamp to 1..7 costs nothing either: the count starts at 1, and there are only 6 thresholds.

## Cost

- K possible results cost K − 1 comparisons at O(1) depth, plus one sum per output computed for every possible result. The column count is 13 operations in 3 layers: 6 integer bits of 2 operations each, and the count. [Loops, section 4](../sections/loops.md#4-threshold-counts-instead-of-floor-and-division) builds each bit from 3 operations, so its column count is 19 operations.
- With the row and column of every item: 458 operations in 4 layers for 221 items, and 10,435 operations in 4 layers for 10,000 items.
- In the gallery, the column count and photo width are 30 operations in 6 layers, against 524 operations and 91 layers in the trace compiler's slice of index.ts.

## When it's exact

- The input lies on a grid, e.g. whole pixels, declared with `circuit.assumeGrid`, so every threshold comparison is an integer bit, and `validateGrids` checks the declaration in tests.
- Every output is a sum of exact bits with integer weights, e.g. rows and columns, so it's exact below 2^24.
- A threshold that FP32 can't represent has to be stored as the smallest FP32 value at or above it for `>=`, since a `Float32Array` holds only FP32 values. numeric-library's progress ring lit a tick one FP32 step early by comparing with `Math.fround(5 / 24)`, which is below 5/24.

## When not to use it

- When the result has many possible values, e.g. a row index among 10,000 rows: a threshold count needs one comparison per possible value. Use a floor on a known grid, index-read's `emitFloorDivide` (8 operations and 7 layers), or a binary search with `circuit.indexRead`.
- When the input isn't on a grid and JavaScript can't round it onto one: `emitCompare` then builds a sign cascade per threshold, e.g. 15 operations and 14 layers for `>=` within 0..16,384.

## Where it's used

- [gallery](../../gallery/README.md): the column count, which matched index.ts at every whole-pixel width from 320 to 3,840 px, including the 6 widths where the reciprocal fails.
- [hn-thread](../../hn-thread/README.md): all 251 comment heights at any window width, from 1,768 width thresholds found in JavaScript: 5,283 operations in 4 layers.
- [Text, idea 1](../sections/text.md#idea-1-tabulation) and [text-tabulated](../../text-tabulated/README.md): a paragraph's height as `baseHeight + Σ heightChange × [width >= threshold]`, e.g. text-tabulated's Notes window, whose 10 text blocks with 244 thresholds are 1,041 operations in 4 layers with every painting output.
- [codegen](../../codegen/README.md): life-calendar's grid, where 141 threshold tests replace `Math.sqrt`, a division, floor and ceil.
- [Loops, section 4](../sections/loops.md#4-threshold-counts-instead-of-floor-and-division): dividing a runtime value by a runtime count through the count's one-hot.
- [Breakpoints found ahead of time](breakpoints-found-ahead-of-time.md): the same count when JavaScript finds the thresholds by searching a black-box layout, e.g. chat bubbles' line counts, instead of from a closed form.
- Example and test: [threshold-counts.ts](../examples/patterns/every-item/threshold-counts.ts) and [threshold-counts.test.ts](../examples/patterns/every-item/threshold-counts.test.ts), which compare with index.ts at every whole-pixel width from 0 to 8,192 px, and in both evaluators next to every threshold and at random widths.
