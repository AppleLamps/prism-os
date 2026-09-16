Size: loop. Short entry: [patterns.md, "Running totals"](../../../../patterns.md#running-totals).

# Running totals as a tree of additions

Computes every row's top from the row heights, `rowTops[row + 1] = heights[0] + ... + heights[row]`, with the additions arranged as a tree, so a total doesn't depend on a chain through every total before it.

```txt
heights    h0    h1    h2    h3    h4    h5    h6    h7
            \____/      \____/      \____/      \____/          layer 1: pairs
             0..1        2..3        4..5        6..7
                \_________/             \_________/             layer 2: pairs of pairs
                   0..3                    4..7
                      \______________________/                  layer 3
                                0..7

the totals in between add one finished block to one smaller block:
0..2 = (0..1) + h2 in layer 2,  0..4 = (0..3) + h4 and 0..5 = (0..3) + (4..5) in layer 3,  0..6 = (0..5) + h6 in layer 4
```

## The loop it replaces

```ts
const rowTops: number[] = []
let top = 0
for (let row = 0; row < heights.length; row++) {
  rowTops.push(top)
  top += heights[row]
}
const contentHeight = top
```

The same loop gives the left edges of photos in a strip, the x of each word along a line, and how many visible items come before each item of a filtered list.

## The circuit

Three arrangements of the same additions, each built with `circuit.roundAffine`, which keeps a sum as its own operation with the caller's term order ([running-totals.ts](../examples/patterns/combining-steps/running-totals.ts), trimmed). Each form returns `totals[row] = heights[0] + ... + heights[row]`:

```ts
// A chain: each total adds one height to the previous total, in the loop's order.
totals.push(circuit.roundAffine([[totals[row - 1], 1], [heights[row], 1]]))
// Wide sums: one sum per total, with its terms in loop order, so no total reads another.
circuit.roundAffine(heights.slice(0, row + 1).map(height => [height, 1]))
// Brent-Kung: pairs, pairs of pairs, then the totals in between.
brentKungPrefix(heights, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]))
```

`brentKungPrefix` in [prefix-networks.ts](../examples/patterns/combining-steps/prefix-networks.ts) takes any associative combine, and [events through a state machine](state-machine-prefix-scan.md) calls the same function with index reads as the combine. Use `roundAffine` rather than `affine` here: the builder copies an ordinary affine sum of fewer than 4 terms into the sums that read it and sorts its terms by wire number, which regroups the additions.

## Cost

For n rows:

| Form | Operations | Layers | Stored weights | Measured at 1,024 rows |
| --- | --- | --- | --- | --- |
| chain | O(n) | O(n) | O(n) | 1,023 operations, 1,023 layers, 2,046 weights |
| wide sums | O(n) | 1 | O(n²) | 1,023 operations, 1 layer, 524,799 weights |
| Brent-Kung | about 2n | about 2 log2 n | O(n) | 2,036 operations, 18 layers, 4,072 weights |

The 8-row network in the diagram is 11 operations in 4 layers, against 7 operations in 7 layers for the chain.

## When it's exact

Sums round in FP32, so the grouping is part of the result. The tests compare with the loop with every addition rounded to FP32, `top = Math.fround(top + heights[row])`. With heights 229, 167.4, 208.5 and 194.4 px, that loop, the chain and the wide sums give a content height of 799.300048828125, while Brent-Kung's `(229 + 167.4) + (208.5 + 194.4)` gives 799.2999877929688, one FP32 step lower.

- The chain and the wide sums take the loop's rounding steps, so they equal the loop bit for bit on any heights. The tests check fractional heights at 5 to 200 rows, including heights that alternate between about a million and a tenth of a pixel.
- Brent-Kung equals the loop only when every partial sum is exact, e.g. quarter-pixel heights with a content height within 2^22 px, or integer counts below 2^24. Past 2^24 even integers group differently: heights 2^24, 1, 1 and 1 give 2^24 as the loop's last total, and 2^24 + 2 with Brent-Kung.
- On long pages Brent-Kung is the more precise grouping, since most of its additions combine totals of similar size. At 10,000 rows of 20 to 300 px, about 1,598,516 px of content, the loop's totals are up to 5.67 px from float64 sums of the same FP32 heights, and Brent-Kung's up to 0.26 px. The largest error depends on the heights: [loops, section 3](../sections/loops.md#precision-at-large-totals) measured 2.03 px against 0.288 px on other random heights, about 1,584,967 px of content.

## When not to use it

- On today's CPU executor, where depth costs nothing and the chain is the least work.
- When a JavaScript reference that adds one row at a time must match bit for bit on fractional heights. Use the chain or the wide sums.
- Wide sums past a few hundred rows, where the n²/2 stored weights dominate, e.g. 524,799 at 1,024 rows.

## Where it's used

- [loops, section 3](../sections/loops.md#3-prefix-sums-three-ways): what the prototypes measured with each form, and how far the loop's totals and Brent-Kung's drift from exact sums at 1,000 and 10,000 rows. [Instancing](../sections/instancing.md#accumulation-order-is-part-of-the-result) explains why the order of additions is part of the result.
- The gallery in [instanced-items](../../instanced-items/README.md#merged-from-gallery-september-16-2026): the photo strip's left edges, 9 layers with wide sums and 21 with Brent-Kung sums.
- [hn-thread](../../hn-thread/README.md): 251 animated row tops as wide sums, and the natural row tops as a Brent-Kung network over integer heights.
- [lists](../../lists/README.md): counts of the visible items before each item, when routing 1,000 items into 20 DOM slots, 1,009 layers with a chain of counts, 27 with Brent-Kung counts and 11 with wide sums.
- [instanced-items](../../instanced-items/README.md): Brent-Kung row tops and strip edges kept every decision equal to index.ts at 10,000 photos, where sums added one photo at a time flipped 74 decisions.
- [input](../../input/README.md): running counts of down and up bits give every queued event its press session.
- Example and test: [running-totals.ts](../examples/patterns/combining-steps/running-totals.ts) and [running-totals.test.ts](../examples/patterns/combining-steps/running-totals.test.ts).
