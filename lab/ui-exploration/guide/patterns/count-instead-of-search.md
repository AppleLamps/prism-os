# Count instead of search

When a test passes for a run of items at the start and fails for every item after it, e.g. `rowBottom <= pointerY` over rows from top to bottom, the number of items that pass is the index of the first item that fails, and the differences of neighboring bits mark that item.

```txt
row                         0    1    2    3    4
rowBottom                  40   80   80  140  180    heights 40, 40, 0, 60, 40 px
[rowBottom <= pointerY]     1    1    1    0    0    pointerY = 90
previous bit                1    1    1    1    0    [pointerY >= 0] before row 0
previous bit minus bit      0    0    0    1    0    one-hot of the pointed row

1 + 1 + 1 + 0 + 0 = 3, the pointed row
```

## The loop it replaces

hn.js finds the comment under the pointer by walking rows from the top (hn.js 328-341, simplified):

```js
let pointedRow = -1
let rowTop = 0
for (let row = 0; row < rowHeights.length; row++) {
  if (rowTop <= pointerY && pointerY < rowTop + rowHeights[row]) {
    pointedRow = row
    break
  }
  rowTop += rowHeights[row]
}
```

## The circuit

Evaluate the loop's test for every row at once, add the bits, and subtract neighbors. From [count-instead-of-search.ts](../examples/patterns/selection/count-instead-of-search.ts), where JavaScript writes the row bottoms into cells:

```ts
const belowStart = emitCompare(circuit, pointerY, '>=', zero)
const rowAbove = rowBottoms.map(bottom => emitCompare(circuit, bottom, '<=', pointerY))
const pointedRow = circuit.roundAffine(rowAbove.map(bit => [bit, 1] as const))
const isPointedRow = rowAbove.map((bit, row) =>
  circuit.roundAffine([[row === 0 ? belowStart : rowAbove[row - 1]!, 1], [bit, -1]]))
circuit.assumeOneHot(isPointedRow, true) // all zeros when the pointer is off the rows
```

Row bottoms never decrease down the list, so the bits read `1 1 1 0 0`, i.e. they're monotone. The loop steps over the 1s and stops at the first 0, and the index of the first 0 is the number of 1s. Each difference is 0 or 1, because monotone bits never go from 0 back to 1, and the differences add up to `[pointerY >= 0] − rowAbove[last]`, so exactly one of them is 1 while the pointer is on the rows. A row of height 0 repeats its neighbor's bottom, so its difference is 0, like the loop, which never matches an empty row.

The loop adds one row at a time, and the count adds every bit in one sum. Both give the same result because a sum of exact 0s and 1s is exact in FP32 in any grouping, below 2^24.

## Cost

O(n) operations in O(1) layers after the row bottoms: 2 operations per row for the integer bit, 1 per row for the one-hot, 1 sum, and 2 for `[pointerY >= 0]`, i.e. 3n + 3 operations in 3 layers. Reading any field of the pointed row, e.g. its top, is 1 gather. A tree over the bits `[rowBottom > pointerY]` with `emitFirstActive` finds the same row in O(log n) layers. Index and one-hot together, pinned by [count-instead-of-search.test.ts](../examples/patterns/selection/count-instead-of-search.test.ts):

| Rows | Count | Tree |
| ---: | --- | --- |
| 16 | 51 operations, 3 layers | 111 operations, 24 layers |
| 64 | 195 operations, 3 layers | 447 operations, 34 layers |
| 256 | 771 operations, 3 layers | 1,791 operations, 44 layers |
| 1,024 | 3,075 operations, 3 layers, 6,146 stored weights | 7,167 operations, 54 layers, 13,891 stored weights |

## When it's exact

- The test has to be exact. In the example, pointerY is on a 1/64 px grid and row bottoms on a 1/4 px grid within ±65,536 px, so `emitCompare` builds integer bits; bottoms that aren't on a grid get a sign cascade, 15 operations in 14 layers per row within 0..16,384.
- The bits have to be monotone. A count returns a number for any bits, so unsorted bottoms give a wrong result without an error: a height of −10 px makes the bottoms 40, 30 and 80, and at pointerY 35 the count is 1 while the loop returns 0. The declared one-hot then fails `validateOneHotGroups`, which tests should run.
- The count is the pointed row's index only while the pointer is on the rows, i.e. while `[pointerY >= 0] − rowAbove[last]` is 1. Above the first row it's 0, and at or below the last bottom it's the row count.

## When not to use it

- When the test isn't monotone, e.g. hit bits of overlapping windows in stacking order: use [the first active candidate, in a tree](first-active-tree.md).
- When every row has the same height: `Math.floor(pointerY / rowHeight)` doesn't grow with the row count, e.g. lists' uniform list is 280 operations in 19 layers at any row count, with 24 DOM slots ([loops](../sections/loops.md#1-count-instead-of-search)).
- When depth doesn't matter and rows are many: a binary search with the index read instruction reads log2 n bottoms, e.g. 215 operations in 57 layers among 10,000 rows in index-read's copy of the runtime, against 30,143 operations in 5 layers by counting ([index-read](../../index-read/README.md)).

## Where it's used

- [hn-thread](../../hn-thread/README.md): the pointed comment, 252 comparisons at 251 comments, and the pointed indent level the same way.
- [Loops, section 1](../sections/loops.md#1-count-instead-of-search) and [first-visible-row.ts](../examples/loops/first-visible-row.ts): the first visible row of a virtualized list, 30,001 operations in 3 layers on top of the row tops at 10,000 rows, with the loops section's 3-operation integer bits.
- [lists](../../lists/README.md): the virtualized list, and the oldest pointer sample within 100 ms for the release velocity.
- [gallery](../../gallery/README.md): the scroll anchor, the first box whose bottom is more than a fifth of the window height below the scroll position.
- [text-walker](../../text-walker/README.md): a line's end, as the count of "segments s through j fit" bits; [text-editing](../../text-editing/README.md): the caret's position, as the count of glyph centers left of the pointer.
- [Threshold counts instead of floor and division](threshold-counts.md), from [loops, section 4](../sections/loops.md#4-threshold-counts-instead-of-floor-and-division): the column count, a count of threshold bits whose neighbor differences give its one-hot.
- Example and test: [count-instead-of-search.ts](../examples/patterns/selection/count-instead-of-search.ts) and [count-instead-of-search.test.ts](../examples/patterns/selection/count-instead-of-search.test.ts).
