# Loops and searches without loops

A circuit has no `for`, `while` or `break` when it runs. It's a fixed list of operations that runs once per frame, and every operation runs on every frame. Builder code can loop while building, e.g. a `for` over 24 DOM nodes appends the loop body 24 times, so a loop whose iteration count is known while building translates directly. This section is about the loops that don't translate directly: searches that stop early, running totals, floor and division, sorting, and handing out leftover space in a layout.

Each rewrite below computes the same result as the loop, and every iteration of the loop still becomes operations in the circuit. Iterations that don't read each other's results can run side by side in the same layers, which adds work but not depth. Iterations that read the previous iteration's result stack up into a longer chain. For example, the running totals of 1,024 row heights can be 1,023 additions in a chain 1,023 layers deep, 1,023 wide sums in 1 layer, or 2,036 additions in 18 layers.

Three related topics are in other sections. A loop that runs a spring step a runtime number of times becomes powers of one step matrix, chosen by the binary digits of the step count, in [springs](springs.md). A loop that carries a state machine from event to event, and following links like "where does the next line start", are in [chains](chains.md). Reading `values[index]` at a computed index is in [indexing](indexing.md).

The short entries for these loops are in the repo root's [patterns.md](../../../../patterns.md). Sections 1 to 5 each link a long pattern doc, which has a runnable example and a test, and keep what the pattern doc doesn't cover: other ways to compute the same result, and what the prototypes measured. Section 6 is the long form of patterns.md's water filling entry.

## How cost is counted

An operation is one step of the compiled program: an affine sum (weights times inputs plus a constant), a ReLU-gated product, a boolean atom, or an index read (`circuit.indexRead`), which copies the value at a computed position. "Operations" counts the operations that some output needs, and all of them run on every frame.

A layer is a group of operations that don't read each other, which the executor runs as one sparse matrix multiplication. Depth is the number of layers, i.e. the longest chain of operations that must run one after another.

A stored weight is one nonzero coefficient of a layer. A sum over n values is 1 operation but n stored weights, so a formulation with n sums of up to n terms each shows its n²/2 cost only in stored weights.

On today's CPU executor, the work per frame follows operations and stored weights: `sparseMatmulAddBias` in numeric-ui-core.ts does one multiplication and one addition per stored weight, and depth costs nothing extra. Depth would matter on an executor that runs a whole layer at once, e.g. on a GPU, which the repo doesn't have ([executor](executor.md), [chains](chains.md)).

Numbers come from two places: the prototypes' READMEs, with the conditions they were measured under, and this section's examples in [examples/loops](../examples/loops/), which print their sizes with `bun lab/ui-exploration/guide/examples/loops/report.ts` from the repo root. Counts are exact. "0 mismatches" means over the traces or samples named, not a proof.

## The shapes of cost

The same loop can usually be written several ways, and the ways differ in how operations and depth grow with the item count n. These are the shapes that come up in this section:

| Operations | Depth | What the circuit does | UI example |
| --- | --- | --- | --- |
| O(n) | O(n) | copies the loop, one step after another (a chain) | row tops added one at a time; flex-wrap |
| O(n) | O(1) | evaluates the loop's test for every item at once, then counts or adds | the first visible row by counting; each item's grid column |
| O(n) | O(log n) | combines items in pairs, then pairs of pairs, like a tournament bracket | the frontmost window under a press; row tops from a Brent-Kung network |
| O(n log n) | O(log n) | combines more pairs at each level | row tops from a Kogge-Stone network |
| O(n log² n) | O(log² n) | runs a sorting network | sorting 64 photos by date |
| O(n²) operations, or O(n) operations and O(n²) stored weights | O(1) | compares or adds every pair | ranks by counting; one wide sum per row top |
| O(n × K) for K outputs | O(1) to O(log n) | tests every item against each output | a filtered list shown in K DOM nodes |
| O(log n) | O(log n) | runs a binary search, which needs an index read instruction, e.g. `circuit.indexRead` in numeric-ui-core.ts | the first visible row among 10,000 rows, in index-read |

Two things matter when choosing a shape. The first is what makes the executor do more work, which today is operations and stored weights, not depth. The second is FP32 rounding: two formulations that add the same numbers in a different grouping can give different last bits, and the grouping determines whether a circuit matches a sequential JavaScript loop bit for bit (section 3).

## Tools used throughout

FP32 is the 32-bit float format of `Float32Array`, and the runtime rounds to FP32 after every addition and product, like `Math.fround`. FP32 holds every integer up to 2^24 = 16,777,216 exactly, and it holds values on a power-of-two grid while their totals stay small, e.g. multiples of 1/4 px below 2^22 px.

A host contract is a guarantee about the numbers that the JavaScript around the circuit writes into the source table, e.g. "scrollTop is a multiple of 1/4 px". The circuit's exactness relies on the host contract, and the executor checks every source cell against its declared range on every evaluation.

ReLU is `relu(x) = max(0, x)`. `circuit.reglu([], 1, terms, bias)` is a plain `relu(terms + bias)`, i.e. a ReLU-gated product whose left side is the constant 1.

`[condition]` means 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript, e.g. `[rowBottom <= scrollTop]` is 1 for a row that ends at or above the scroll position.

An integer bit is an exact comparison of integers built from two ReLUs. When `v` is always an integer, `relu(v + 1) − relu(v)` is exactly 0 for `v <= −1` and exactly 1 for `v >= 0`, because an integer can't land strictly between −1 and 0. For example, `[rowBottom <= scrollTop]` on a quarter-pixel grid is the integer bit of `4 × (scrollTop − rowBottom)`. It costs 3 operations in 2 layers ([kit.ts](../examples/loops/kit.ts)):

```ts
// [terms + bias >= 0], for a sum that always holds an integer below 2^23 in magnitude
export function emitIntegerAtLeastZero(circuit: Circuit, terms: Terms, bias: number): Wire {
  const upper = circuit.reglu([], 1, terms, bias + 1)
  const lower = circuit.reglu([], 1, terms, bias)
  const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}
```

The bit uses `roundAffine`, which keeps the difference as its own operation. The builder copies an ordinary `affine` with fewer than 4 terms into every sum that reads it, so a sum over many bits built with `affine` would add up the large ReLU values each bit is made of, and its running total can round. Values that aren't on a known grid, e.g. a spring's position, need a continuous comparison from [comparisons](comparisons.md), e.g. the sign cascade.

A one-hot is a list of bits in which exactly one bit is 1, e.g. `[0, 0, 1, 0]` marks position 2. `circuit.assumeOneHot(bits)` declares to the compiler that the bits always form a one-hot. Nothing checks that declaration when the circuit runs, so tests should call `validateOneHotGroups` on evaluated values.

A masked sum over a one-hot, `Σ bit[i] × value[i]`, returns the value at the marked position, like `values[index]`. When the bits are a declared one-hot and every value has a finite declared range, the compiler replaces the n products with one gather, a read of the marked value alone. The gather removes the products, but building the one-hot still costs O(n) operations.

## 1. Count instead of search

A virtualized list keeps a fixed number of reusable DOM nodes, called DOM slots here, e.g. 24, and every frame it needs the first row that is at least partly visible, so that DOM slot k can show row `firstVisibleRow + k`. The loop `while (rowTops[firstVisibleRow + 1] <= scrollTop) firstVisibleRow++` stops at a position that depends on the data. The circuit evaluates the loop's test for every row at once and counts the rows that pass: row bottoms never decrease down the list, so the bits read `1 1 1 0 0`, and their count is the index where the loop stops. The differences of neighboring bits give the result as a one-hot, so each DOM slot's top is one gather. The pattern doc [count instead of search](../patterns/count-instead-of-search.md) covers why the count gives the loop's index, its cost, when it's exact and when not to use it.

This section's [first-visible-row.ts](../examples/loops/first-visible-row.ts) builds the list with 3-operation integer bits and row heights in source cells. At 10,000 rows, the Brent-Kung row tops are 19,981 operations in 24 layers, the count adds 30,001 operations and 3 layers, and the one-hot with 24 DOM slot tops brings the total to 60,007 operations, 28 layers and 24 gather reads. Row data the circuit doesn't compute with, e.g. labels, can stay in a JavaScript array indexed by the circuit's row index, which costs nothing in the circuit.

### Measured in the prototypes

- lists' virtualized list does the same work, plus giving each visible row a DOM slot that doesn't change while the row stays visible: 60,174 operations and 32 layers at 10,000 rows with row tops computed in the circuit, and 40,193 operations and 8 layers with row bottoms computed in JavaScript.
- Rows of one height need no per-row work, because the first visible row is `floor(scrollTop / rowHeight)` (section 4 covers floor). lists' uniform list is 280 operations and 19 layers at 1,000, 10,000 or 100,000 rows, with 0 mismatches in rows, y positions and DOM slots over every quarter-pixel scrollTop of 10,000 rows, at viewport heights 600 and 920 px.
- A binary search takes log2 n steps, and each step reads a row bottom at a position the previous step computed. Reading at a computed position through a one-hot over every row costs O(n) operations per step, so that search costs more than the count. index-read added an index read instruction to a copy of the runtime, which reads `values[floor(index)]` as 1 operation, and numeric-ui-core.ts now has the same instruction as `circuit.indexRead`. With that instruction, in index-read's copy ([lists](../../lists/README.md#merged-from-index-read-september-16-2026)), finding the first visible row among 10,000 rows of different heights, with row tops prepared in JavaScript and 2 fields read per DOM slot, was 215 operations and 57 layers by binary search, against 30,143 operations and 5 layers by counting. So counting is O(n) operations at O(1) depth, and a binary search with index reads is O(log n) operations at O(log n) depth.

### The same idea in other prototypes

- hn-thread's row under the pointer is the count of row bottoms at or above the pointer: 252 comparisons at 251 comments.
- The gallery's scroll anchor: index.ts steps through the first photo of each row until that photo's bottom is more than a fifth of the window height below the scroll position. Those bottoms increase row by row, so the circuit counts them instead.
- text-walker's line end: for a line that starts at segment s, the bits "segments s through j fit on the line" read `1...1 0...0` as j grows, because segment widths are never negative.
- [text-editing](../../code-points/README.md#merged-from-text-editing-september-16-2026)'s click to place the caret: the count of glyphs whose center is left of the pointer, since glyph centers never decrease along a line.
- lists' release velocity: the demo's loop walks back through pointer samples while they're within 100 ms of the newest one. "Sample `age` is within 100 ms" isn't monotone when timestamps arrive out of order, but "every sample from the newest through `age` is within 100 ms", `[inWindow[0] + ... + inWindow[age] >= age + 1]`, is monotone, and its neighbor differences mark the oldest sample to use.

## 2. When the test isn't monotone: the first hit

A press lands where several windows overlap, and the frontmost window under the pointer receives the press. A loop over the hit bits in stacking order, from the front, stops at the first 1. The hit bits look like `0 1 0 1 1`, which aren't sorted, so their count, 3, isn't the position of the first hit, 1.

### Circuit way 1: count the earlier hits

A window is the first hit when the press hits it and hits no window before it ([first-hit.ts](../examples/loops/first-hit.ts)):

```ts
// hitsBefore[window] = hit[0] + ... + hit[window - 1], a prefix sum of the hit bits (section 3)
const isFirstHit = hits.map((hit, window) => circuit.reglu([], 1, [[hit, 1], [hitsBefore[window]!, -1]], 0))
```

`relu(hit − hitsBefore)` is 1 for a hit with no earlier hit. A miss gives `relu(0 − k) = 0`, and every later hit has at least 1 earlier hit, so it gives `relu(1 − k) = 0`. For the bits `0 1 0 1 1`, the earlier-hit counts are `0 0 1 1 2`, and `relu(hit − hitsBefore)` is `0 1 0 0 0`.

Another way to see why this works: the running OR of the hits, `min(1, hitsBefore + hit)`, is monotone, `0 1 1 1 1`, and the first hit is where the running OR changes.

At 1,024 items with hit bits in source cells, the earlier-hit counts as wide sums are 2,046 operations in 2 layers with 525,822 stored weights, and from a Brent-Kung network 3,050 operations in 19 layers with 6,099 stored weights, against 5,116 operations in 51 layers for the tournament of way 2. In the gallery, where a click selects one photo among 221, the tournament accounts for about 20 of the circuit's 61 layers, and selecting the click by earlier-hit counts brings the whole circuit to 41 layers, for about 23,000 more stored weights.

numeric-library's `emitMinimumOf` finds "which value is smallest" by counting as well: it compares every pair and marks the value that is at most every other value, choosing the first index on ties. The exact minimum of 8 values is 121 operations and 5 layers, O(n²) operations at O(1) depth.

### Circuit way 2: a tournament

A tournament compares items in pairs, then the pairs' results in pairs, like a bracket. `emitFirstActive(circuit, gate, hits)` in numeric-ui-core.ts takes the maximum of neighboring hit bits up a balanced tree, then routes the gate, a bit that is 1 when a selection should happen, back down to the first hit: O(n) operations at O(log n) depth. The pattern doc [the first active candidate, in a tree](../patterns/first-active-tree.md) covers the tree, its sizes, when it's exact and when not to use it.

### Circuit way 3: the largest key

instanced-items' staged IndirectOS gives each window a key: its stacking rank + 1 when the press hits the window, where a higher rank is closer to the front, and 0 when the press misses. The frontmost hit window has the largest key, so the circuit takes the maximum key, and each window compares its own key with that maximum.

### Pitfalls

- The hits have to be exact bits, for the counts as well as for the tournament. [When the tree is exact](../patterns/first-active-tree.md#when-its-exact) lists which bits `emitFirstActive` can prove exact, and what fractional candidates do to the route.
- Wide sums store n²/2 weights, e.g. about half a million at 1,024 items.
- Items that can't overlap, e.g. photos in a grid, need none of this, since at most one hit bit is 1.

## 3. Prefix sums three ways

A prefix sum is the list of running totals of a list, e.g. `rowTops[r] = heights[0] + ... + heights[r − 1]`. UIs need prefix sums for row tops, the left edges of photos in a strip, the x positions of words along a line, and the number of visible items before each item. The loop is a chain as deep as the list is long. The pattern doc [running totals as a tree of additions](../patterns/running-totals.md) builds three arrangements of the same additions with `circuit.roundAffine`, a chain in the loop's order, one wide sum per total, and a Brent-Kung network, with their sizes, when each equals the loop, and which to use. Every FP32 addition rounds, so the grouping of the additions is part of what a prefix sum computes.

This section's [row-tops.ts](../examples/loops/row-tops.ts) builds the same three forms, and `bun lab/ui-exploration/guide/examples/loops/report.ts network` prints the additions in each layer of the 8-row Brent-Kung network. Its tests compare every form with a sequential `Math.fround` loop: on quarter-pixel heights at 1 to 200 rows every total of every form equals the loop's total, and on fractional heights at 5 to 200 rows the chain and the wide sums still do, while some Brent-Kung totals at 64 and 200 rows differ, each by less than 0.02 px. A Kogge-Stone network is another prefix network, with about n log2 n additions in log2 n layers, e.g. 9,217 additions in 10 layers for 1,024 values ([executor](executor.md#ui-jobs-under-each-choice)).

### Measured in the prototypes

- The gallery's photo strip, with the same outputs as the trace compiler's slice of index.ts, is 9 layers with wide sums and 21 layers with Brent-Kung sums. The trace compiler's slice was 1,580 layers, mostly from sequential sums and long comparison chains.
- hn-thread's 251 animated row tops as wide sums are 506 operations, 32,637 stored weights and 1 layer. Its natural row tops, from integer heights, use a Brent-Kung network of 487 operations and 974 stored weights, 13 layers deeper than the heights it adds. Writing the natural tops as wide sums too takes the whole thread from 69 to 57 layers, for about 31,000 more stored weights.
- lists' capacity routing shows the visible items of a filtered list of 1,000 items in 20 DOM slots, and counts the visible items before each item: 1,009 layers with a chain of counts, 27 layers and 140,408 stored weights with Brent-Kung counts, and 11 layers and 636,939 stored weights with wide sums.
- Two circuits that compute "the same" running totals can still group their additions differently. gallery-circuit.ts starts strip total k from `52 × k`, the k gaps, and then adds k widths, a grouping that no one-at-a-time loop reproduces. Switching instanced-items' staged gallery from sequential to Brent-Kung sums kept 90.7% of values bit-identical and moved strip destinations by up to 0.164 px, with no decision changed.

### Precision at large totals

A sequential loop adds a small height to a total that keeps growing, and past about a million pixels, neighboring FP32 values are 1/8 px apart or more. The example's report, with fractional heights between 20 and 300 px, against exact float64 sums: at 1,000 rows and 165,492 px of content, the sequential loop is off by up to 0.244 px and Brent-Kung by up to 0.021 px, and at 10,000 rows and 1,584,967 px, by up to 2.03 px against 0.288 px. [Instancing](instancing.md#accumulation-order-is-part-of-the-result) explains why Brent-Kung sums drift less, and what sequential sums did at 10,000 photos, where they flipped 74 decisions against index.ts.

## 4. Threshold counts instead of floor and division

A responsive grid computes its column count from the container width, e.g. index.ts's `colsBoxMaxSizeXF`, `clamp(1, Math.floor((containerWidth - 24) / (220 + 24)), 7)`, then places each item at row `Math.floor(item / columnCount)` and column `item % columnCount`. The circuit counts the thresholds the width reaches instead: `atLeastColumns[c] = [containerWidth − 24 − 244 c >= 0]` for c = 2 to 7, with `atLeastColumns[1] = 1` and `atLeastColumns[8] = 0` for the clamp, and the column count is 1 plus the bits for c = 2 to 7. The pattern doc [threshold counts instead of floor and division](../patterns/threshold-counts.md) covers why the count is exact, its cost with `emitCompare` and when not to use it, and [breakpoints found ahead of time](../patterns/breakpoints-found-ahead-of-time.md) finds the thresholds by searching a black-box layout. This section's [column-count.ts](../examples/loops/column-count.ts) builds each bit from 3 operations, so its column count is 19 operations in 3 layers, and with the rows and columns of 221 items, 466 operations in 4 layers.

### What goes wrong with a reciprocal and floor

A circuit can't divide by 244 exactly, but it can multiply by the constant `Math.fround(1 / 244)` and then round down. That gives one column too few exactly where a new column should start. At 1,000 px, `Math.fround(976 × Math.fround(1 / 244))` is 3.9999998 instead of 4, so floor returns 3. The example's test tries every width from 0 to 8,192 px, and the reciprocal is wrong at exactly 512, 756, 1,000, 1,244, 1,488 and 1,732 px.

### Dividing by the runtime column count

The column count is a runtime value with only 7 possible values. For each possible count c, `Math.floor(item / c)` and `item % c` are constants known while building, so each item's row and column is one sum over the one-hot of the column count. That one-hot is again the neighbor differences of the threshold bits:

```ts
// hasColumns[c - 1] = [columnCount == c] = atLeastColumns[c] - atLeastColumns[c + 1]
const hasColumns = Array.from({length: 7}, (_, index) =>
  circuit.roundAffine([[atLeastColumns[index + 1]!, 1], [atLeastColumns[index + 2]!, -1]]))
circuit.assumeOneHot(hasColumns)
const rows = Array.from({length: itemCount}, (_, item) =>
  circuit.affine(hasColumns.map((bit, index) => [bit, Math.floor(item / (index + 1))] as const)))
const columns = Array.from({length: itemCount}, (_, item) =>
  circuit.affine(hasColumns.map((bit, index) => [bit, item % (index + 1)] as const)))
```

For example, item 10's row is `10 × [columnCount == 1] + 5 × [columnCount == 2] + 3 × [columnCount == 3] + 2 × [columnCount == 4] + ...`, which is 2 at 4 columns.

### Other uses

- **Replacing sqrt, division and floor together.** vibescript's life-calendar sizes its grid with `Math.sqrt`, a runtime division, floor and ceil. codegen's circuit uses 141 threshold tests with constant coefficients instead: the grid has at least 7m columns exactly when `life × gridSizeX >= 49 m (m + 1) × gridSizeY`. It matched the demo's column and row counts on all 197,232 viewports of phase one's sweep.
- **A runtime value divided by a runtime count.** life-calendar's row per cell is `floor(week / m)`, with week up to 3,913 and m up to 140. The circuit computes `round(week × (1/m) − (m − 1) / (2m))`, reading `1/m` and the offset through the one-hot of m. The quotient's fractional part is a multiple of 1/m, so after the offset the value is at least 1/(2m) away from a tie, and rounding can't give the wrong integer. It was exact for all 27,393 cells and all 140 column counts.
- **Floor division by a constant.** `Math.floor(Math.fround(Math.fround(1 / rowHeight) × scrollTop))` misses at least one row for 74 of the 512 integer row heights from 1 to 512 ([index-read](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/index-read)). numeric-library's [`emitFloorDivide`](../../numeric-library/README.md#merged-from-index-read-september-16-2026), from index-read, rounds the approximate quotient, then subtracts 1 when the exact integer remainder is negative: 8 operations and 7 layers, for integer numerators in 0..2^21. It had 0 mismatches at every multiple of the row height up to 2^21, and one below each, for the first ten heights where the plain floor fails.
- **A step function of one runtime width.** A paragraph's height changes in steps as its container gets wider, so the height becomes `baseHeight + Σ heightChange × [width >= threshold]`, with thresholds found in JavaScript when the text is prepared. hn-thread's 251 comment heights use 1,768 thresholds: 5,283 operations in 4 layers. The [text](text.md) section covers this.

## 5. Ranks instead of sorting

A photo grid sorted by date after a toggle, or cards reordered by dragging, needs each item's position, e.g. its translateY, more than a sorted array. An item's rank is its position after sorting, i.e. the number of items that come before it. One comparison per pair gives the order in both directions, and each rank is one sum of those bits, O(n²) operations at O(1) depth. The pattern doc [ranks instead of sorting](../patterns/ranks-instead-of-sorting.md) builds ranks, item tops, and the update when one dragged card moves, with their sizes and when they're exact. This section's [rank-sort.ts](../examples/loops/rank-sort.ts) builds each bit from 3 operations, so its 64 ranks are 6,112 operations in 3 layers, against 4,096 with `emitCompare`'s 2-operation bits in the pattern doc, and with item tops 10,144 operations in 4 layers.

### Positions and sorted reads from the same comparisons

An item's top is the sum of the heights of the items that come before it, one product per pair, e.g. `earlierFirst[other][item] × heights[other]`, where `earlierFirst[earlier][later]` is the bit `[keys[earlier] <= keys[later]]`.

Reading "the height at sorted position p" uses the bits `[rank[item] == p]`, which form a one-hot over items for each p, so each read is a masked sum that compiles to one gather. Together these n² bits form a permutation matrix, a table of bits with exactly one 1 in each row and in each column. In the example, the height at each of 64 sorted positions brings the program to 14,496 operations in 6 layers, with 64 gather reads.

### A sorting network instead

A sorting network is a fixed list of compare-exchange steps that sorts any input, where each compare-exchange puts the smaller of two values first. Batcher's networks (bitonic and odd-even merge) use about n × log2²(n) / 4 compare-exchanges in log2(n) × (log2(n) + 1) / 2 stages, so O(n log² n) operations at O(log² n) depth. A compare-exchange on keys alone is a minimum and a maximum, 4 operations in 3 layers ([runtime notes](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)).

[outside-techniques](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) measured both forms with integer keys and one payload value carried per item:

- 16 items: a bitonic network was 1,248 operations and 50 layers, and ranks by counting with gathers were 1,056 operations and 5 layers.
- 64 items: 10,624 operations and 105 layers, against 16,512 operations and 5 layers.

The [runtime notes](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) measured an odd-even merge network over 64 keys, without a payload, at 2,172 operations and 63 layers. So at 16 items counting was less work, at 64 items the network was, and counting stayed at a constant 5 layers.

### An incremental update when one item moves

The pattern doc's update finds the dragged card's new rank from the pointer's position. rank-sort.ts's `buildMoveRanks` instead takes the dragged item's rank before and after the move, `fromRank` and `toRank`, and matches `order.splice(fromRank, 1); order.splice(toRank, 0, draggedItem)`: only the items between the two ranks change rank, each by 1, so each item compares its own rank with the two shared ranks instead of with every other item. For example, moving the item at rank 1 to rank 3, with items ranked 0, 1, 2 and 3, gives the ranks 0, 3, 1 and 2. That's 17 operations per item in 5 layers, e.g. 17,409 operations for 1,024 items. In lists' port of draggable-cards, recomputing the ranks every frame made its two O(n²) parts 18% of the circuit at 20 cards and 68% at 200 cards, where the circuit was 208,703 operations, against 71,807 with the incremental update ([lists](../../lists/README.md)).

Store order as ranks, or as a permutation matrix in the source table the way IndirectOS stores its 4 × 4 window stacking order, rather than as a link from each item to the next. Following links needs reads at computed positions: [outside-techniques](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) estimated pointer jumping over links, which replaces each link by its target's link in every round, at about 8n² operations per round with one-hots.

## 6. Grow and shrink with min and max (water filling)

### The problem

A row gives its leftover width equally to its growing children, but each child stops at its own maximum width, and the width a stopped child can't take goes to the other children. Shrinking works the same way with minimum widths.

### The JavaScript way

Clay distributes the leftover width in a loop: raise the smallest growing children toward the next smallest, clamp them at their maximums, and repeat until less than 0.01 px is left. layout-tree's port of that loop, in float32 as clay.h computes, took up to 226 rounds at 64 children over 1,000 random rows, and ended up to 0.00937 px from the exact widths.

### The circuit way

In the final layout, every child's width is `clamp(level, low, high)` for one shared level, where low is the child's fit width and high its maximum width when growing. The total width only increases as the level rises. Finding that level is called water filling, after water poured into connected containers whose floors and ceilings sit at different heights.

Instead of searching for the level, layout-tree's `waterFill` (layout-tree/ops.ts) evaluates the total at each child's own clamp points. Let `excess` be the width left over after every child gets its low, and `filledAt(p) = Σ_k relu(p − low_k) − relu(p − high_k)`, how much the children add on top of their lows when the level is at p:

- `atLow[i] = [filledAt(low_i) >= excess]`: the level stays at or below child i's low, so the child keeps its low.
- `atHigh[i] = [filledAt(high_i) <= excess] AND NOT atLow[i]`: the level reaches child i's high.
- Every other child is free, a free child's width is the level, and the level is `(excess − Σ atHigh[i] × (high_i − low_i) + Σ free[i] × low_i) / freeCount`.

For example, take three children with lows 50, 100 and 150 px and highs 80, 200 and 300 px, in a 360 px row, which leaves 60 px of excess. `filledAt(150) = 30 + 50 = 80`, which is at least 60, so child 2 keeps its low of 150 px. `filledAt(80) = 30`, which is at most 60, so child 0 reaches its high of 80 px. Child 1 is free, and the level is `(60 − 30 + 100) / 1 = 130`. The widths are 80, 130 and 150 px, which add up to 360 px.

[water-fill.ts](../examples/loops/water-fill.ts) builds this with lows and highs in source cells as whole pixels, and reads `1 / freeCount` through the one-hot of the free count. Its test compares the widths with a JavaScript loop that walks the sorted clamp points, on random rows of 1 to 8 children, half of them with many equal clamp points: every width was within 0.001 px.

### Cost

Depth stays constant as children are added. The example is 14 layers at 2, 8, 16 and 64 children. layout-tree's widths pass is 9 layers when fit widths are constants, and 11 to 13 layers when they're runtime values, at every count from 2 to 64 children.

Operations depend on how many clamp points are runtime values. Each child's test sums over every other child's clamp points, so with runtime lows and highs the work is O(n²): the example is 9,221 operations at 64 children, and layout-tree's widths pass for 64 grow containers is 5,601 operations. With constant fit widths the pairwise terms are constants while building, and layout-tree's grow costs about 14 operations per child, 784 at 64 children. Rows in real UIs have 2 to 8 children, where layout-tree's whole one-container circuit is 32 to 501 operations.

### Pitfalls

- When FP32 flips a clamp bit near a tie, the widths change continuously, e.g. a child that should be free at level 120.0001 gets clamped at its low of 120, so the flip shows up as drift in widths, not a jump.
- Flex-wrap, where children move to the next line once they don't fit, stayed a scan in layout-tree: about 4 layers per child, e.g. 1,185 operations and 276 layers at 64 children.

## 7. Counting and attention

RASP (Weiss, Goldberg and Yahav, "Thinking Like Transformers", 2021) is a programming language whose operations match what a transformer layer computes. As [outside-techniques](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) noted, two of this section's rewrites are RASP programs. A count of the items that pass a test is RASP's `selector_width`, e.g. "how many visible items come before this item". Ranks by counting are how RASP sorts.

Attention scores stored keys against a query and returns stored values weighted by those scores, and hard attention returns only the best-scoring value. A masked sum over the first visible row's one-hot is hard attention whose keys are row positions and whose scores are exact bits. The [indexing](indexing.md) section follows this further, including what a transformer has that these circuits don't: queries and keys computed by learned weights.

## 8. Common UI jobs and their formulations

executor.md's [UI jobs under each choice](executor.md#ui-jobs-under-each-choice) lists this section's UI jobs, the ways to compute each and their measured sizes, next to comparisons, springs and instancing, e.g. hn-thread's window slots, and five ways to break a paragraph of 1,023 segments into lines.

## Files

- [kit.ts](../examples/loops/kit.ts): the integer bit, program measurement, and a seeded random generator.
- [first-visible-row.ts](../examples/loops/first-visible-row.ts): the first visible row by counting, its one-hot, and the tops of the DOM slots.
- [first-hit.ts](../examples/loops/first-hit.ts): the first hit as a tournament and by earlier-hit counts.
- [row-tops.ts](../examples/loops/row-tops.ts): row tops as a chain, as wide sums and as a Brent-Kung network, plus `describeAdditions`, which lists what each addition covers and its layer.
- [column-count.ts](../examples/loops/column-count.ts): the gallery's column count by threshold counts, with each item's row and column.
- [rank-sort.ts](../examples/loops/rank-sort.ts): ranks, item tops and sorted reads, and the incremental rank update when one item moves.
- [water-fill.ts](../examples/loops/water-fill.ts): grow with min and max as clamp bits, and a JavaScript loop that walks the sorted clamp points.
- [loops.test.ts](../examples/loops/loops.test.ts): 17 tests in about 0.2 s, run with `bun test lab/ui-exploration/guide/examples/loops` from the repo root. They check the first visible row at every quarter-pixel scrollTop of a 48-row list; row tops of every form against a sequential `Math.fround` loop, with exact equality; the first hit on random hit patterns; the column count, rows and columns at every width from 0 to 8,192 px; ranks against a stable sort with many equal keys; every move of one rank against `splice`; water filling against its JavaScript reference; and worked examples, e.g. the first hit of the bits 0, 1, 0, 1, 1.
- [report.ts](../examples/loops/report.ts): prints the sizes of every form, the 8-row Brent-Kung network, and the precision numbers.
