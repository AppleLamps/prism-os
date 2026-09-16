Size: loop. Short entry: [patterns.md, "A layout function of one runtime number"](../../../../patterns.md#a-layout-function-of-one-runtime-number).

# Breakpoints found ahead of time

When a layout result only changes at a few widths, e.g. a paragraph's line count or a grid's column count, JavaScript finds those widths while preparing, and the program only compares the runtime width with them and adds up constants.

```txt
columnCount
  4 |                                 +----------
  3 |                      +----------+
  2 |           +----------+
  1 |-----------+
    +-----------+----------+----------+----------> container width (px)
               512        756       1000

columnCount = 1 + [width >= 512] + [width >= 756] + [width >= 1000] + ...
```

Every decision inside the layout compares something that grows with the width against a number that doesn't depend on the width, so between two neighboring thresholds nothing changes. JavaScript finds the thresholds once, and the program never lays anything out.

## The loop it replaces

A list of chat messages, laid out at the container's width on every frame ([breakpoints.ts](../examples/patterns/candidates-and-tables/breakpoints.ts)):

```ts
function layoutMessageList(messages, containerWidth) {
  const textWidth = Math.min(480, containerWidth * 0.75) - 2 * bubblePadding
  const layout = {bubbleTops: [], bubbleHeights: [], bubbleWidths: [], contentHeight: 0}
  let top = 0
  for (const message of messages) {
    // A greedy while loop that adds words to a line until the next word doesn't fit.
    const {lineCount, widestLine} = layoutParagraph(message, textWidth)
    const height = lineCount * lineHeight + 2 * bubblePadding
    layout.bubbleTops.push(top)
    layout.bubbleHeights.push(height)
    layout.bubbleWidths.push(widestLine + 2 * bubblePadding)
    top += height + bubbleGap
  }
  layout.contentHeight = top - bubbleGap
  return layout
}
```

## The circuit

While preparing, `findBreakpoints` calls the JavaScript layout as a black box every 1 px, and wherever two samples differ, bisects over 1/64 px steps until two widths one step apart give different results. Each threshold is the smallest width on the grid where the new result holds. Then:

```ts
circuit.assumeRange(containerWidth, minimumContainerWidth, maximumContainerWidth)
circuit.assumeGrid(containerWidth, 1 / widthGridSteps)
// [containerWidth >= threshold]. Both operands lie on the 1/64 px grid, so emitCompare builds an integer bit, 2 operations in 2 layers.
const bits = table.thresholds.map(threshold => emitCompare(circuit, containerWidth, '>=', circuit.affine([], threshold)))
// Every output is its value on the first interval, plus how much it changes at each threshold the width reaches.
const roots = Array.from({length: outputCount}, (_, output) => {
  const terms: [Wire, number][] = []
  bits.forEach((bit, threshold) => {
    const change = table.valuesByInterval[threshold + 1]![output]! - table.valuesByInterval[threshold]![output]!
    if (change !== 0) terms.push([bit, change])
  })
  return circuit.roundAffine(terms, table.valuesByInterval[0]![output]!)
})
```

Anything that depends only on which interval the width is in moves into the JavaScript step, e.g. the `Math.min(480, containerWidth * 0.75)` formula and each bubble's shrink-wrapped width.

## Cost

T thresholds cost 2T operations for the bits plus one sum per output, in 3 layers whatever the text, the formula or the number of messages. Stored weights grow with each output's nonzero changes. The work moves into JavaScript, which calls the layout once per 1 px of the range plus about log2(64) = 6 times per threshold, and again whenever the text changes.

Measured by the example's test: 5 messages between 160 and 1,280 px have 45 thresholds, found with 1,391 layout calls. Every bubble's top, height and width, plus the content height, are 106 operations in 3 layers with 201 stored weights, and the content height alone is 29 operations. The test compares all 71,681 widths on the grid with the JavaScript layout.

## When it's exact

- The host writes the width on the declared grid, which `validateGrids` checks in tests, and each threshold is the smallest grid width where the new result holds. Then `[width >= threshold]` is an integer comparison, and gives the black box's own result at every width the host can write. Without a grid, e.g. a springing width that isn't rounded, `emitCompare` builds a sign cascade instead, e.g. 15 operations in 14 layers for `[a >= b]` with both operands within 0..16,384 ([comparisons](../sections/comparisons.md#which-form-to-use-by-default)).
- Every output is constant on each interval, and its changes add up exactly in FP32, e.g. whole and half pixels far below 2^24.
- The width stays inside the tabulated range. Outside it, the program would return the first or last interval's results, so the example declares the tabulated range on the width cell, and the evaluators reject a width outside it.
- Every change of the result falls between two neighboring samples that differ. A change that is undone before the next sample leaves both samples equal, so it's never bisected. The example's greedy walker only moves line ends forward as the width grows, but with pretext's rich inline layout, a paragraph can get more lines, or a line can start earlier, as the width grows ([text](../sections/text.md#does-a-paragraph-ever-get-more-lines-when-it-gets-wider)).

## When not to use it

- When the result depends on a second runtime value, e.g. a width and a font scale: the table is indexed by one value.
- When each line has its own width, e.g. text flowing around a dragged window: use the line walker ([text, idea 2](../sections/text.md#idea-2-the-walker-as-arithmetic)).
- When the text changes on every keystroke and the thresholds are weights, since every edit means preparing, tabulating and building the program again: keep the thresholds and values in cells ([tables that JavaScript writes](tables-javascript-writes.md)), or use the walker.

## Where it's used

- [Threshold counts instead of floor and division](threshold-counts.md): the same circuit with thresholds from a closed form instead of a search, e.g. the gallery's column count, 13 operations in 3 layers with `emitCompare`'s 2-operation integer bits, or 19 operations in [loops, section 4](../sections/loops.md#4-threshold-counts-instead-of-floor-and-division) with 3-operation integer bits.
- [Text, idea 1](../sections/text.md#idea-1-tabulation), from [text-tabulated](../../text-tabulated/README.md): the Notes window's 10 text blocks with 244 thresholds are 1,041 operations in 4 layers, with 0 frames showing a wrong line count over 2,473 frames in Chrome with real fonts.
- [hn-thread](../../hn-thread/README.md): 251 comment heights from 1,768 thresholds, 5,283 operations in 4 layers.
- The gallery's caption variant in [instanced-items](../../instanced-items/README.md#merged-from-gallery-september-16-2026): each caption's two-line and three-line breakpoints, found once with pretext.
- Example and test: [breakpoints.ts](../examples/patterns/candidates-and-tables/breakpoints.ts) and [breakpoints.test.ts](../examples/patterns/candidates-and-tables/breakpoints.test.ts).
