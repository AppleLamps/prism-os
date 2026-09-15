# Loops and searches without loops

A circuit has no `for`, `while` or `break` when it runs. It's a fixed list of operations that runs once per frame, and every operation runs on every frame. Builder code can loop while building, e.g. a `for` over 24 DOM nodes appends the loop body 24 times, so a loop whose iteration count is known while building translates directly. This section is about the loops that don't translate directly: searches that stop early, running totals, floor and division, sorting, and handing out leftover space in a layout.

Each rewrite below computes the same result as the loop, and every iteration of the loop still becomes operations in the circuit. Iterations that don't read each other's results can run side by side in the same layers, which adds work but not depth. Iterations that read the previous iteration's result stack up into a longer chain. For example, the running totals of 1,024 row heights can be 1,023 additions in a chain 1,023 layers deep, 1,023 wide sums in 1 layer, or 2,036 additions in 18 layers.

Three related topics are in other sections. A loop that runs a spring step a runtime number of times becomes powers of one step matrix, chosen by the binary digits of the step count, in [springs](springs.md). A loop that carries a state machine from event to event, and following links like "where does the next line start", are in [chains](chains.md). Reading `values[index]` at a computed index is in [indexing](indexing.md).

## How cost is counted

An operation is one step of the compiled program: an affine sum (weights times inputs plus a constant), a ReLU-gated product, or a boolean atom. "Operations" counts the operations that some output needs, and all of them run on every frame.

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

The pattern doc [count instead of search](../patterns/count-instead-of-search.md) has this idea on one page, with a runnable example and a test.

### The problem

A virtualized list creates DOM nodes only for the rows in view. It keeps a fixed number of reusable DOM nodes, called DOM slots here, e.g. 24, and every frame it needs the first row that is at least partly visible, so that DOM slot k can show row `firstVisibleRow + k`. When rows have different heights, dividing scrollTop by a row height doesn't give that row.

### The JavaScript way

```ts
// rowTops[r] is the top of row r, and rowTops[r + 1] is its bottom.
let firstVisibleRow = 0
while (firstVisibleRow < rowCount && rowTops[firstVisibleRow + 1] <= scrollTop) firstVisibleRow++
```

The loop stops at a position that depends on the data, and so does a binary search.

### The circuit way

Evaluate the loop's test for every row at once, then count the rows that pass ([first-visible-row.ts](../examples/loops/first-visible-row.ts)):

```ts
// aboveViewport[r] = [rowBottom[r] <= scrollTop], an integer bit on the quarter-pixel grid
const aboveViewport = Array.from({length: rowCount}, (_, row) =>
  emitIntegerAtLeastZero(circuit, [[scrollTop, 4], [rowTops[row + 1]!, -4]], 0))
const firstVisibleRow = circuit.affine(aboveViewport.map(bit => [bit, 1] as const))
```

### Why it works

Row bottoms never decrease down the list, so the test "this row's bottom is at or above scrollTop" passes for a run of rows at the start and fails for every row after that run. The bits look like `1 1 1 0 0`. Bits with that shape are called monotone along the index. The loop steps over the 1s and stops at the first 0, so its result, the index of the first 0, equals the number of 1s.

For example, with row heights 40, 40, 0, 60 and 40 px, the row bottoms are 40, 80, 80, 140 and 180 px. At scrollTop 90, the bits are `1 1 1 0 0`, and their count is 3: row 3, which spans 80 to 140 px, is the first visible row. Row 2 is collapsed to height 0, so it repeats row 1's bottom, and the bits stay sorted.

The count adds exact 0s and 1s, which FP32 adds exactly in any order.

### The result's one-hot, from neighboring bits

Reading the first visible row's top, or any value stored per row, needs the result as a one-hot. For monotone bits, the differences of neighboring bits form that one-hot, with no more comparisons:

```ts
// isFirstVisible[r] = aboveViewport[r - 1] - aboveViewport[r], treating aboveViewport[-1] as 1 and aboveViewport[rowCount] as 0
const isFirstVisible = Array.from({length: rowCount + 1}, (_, row) => {
  if (row === rowCount) return aboveViewport[rowCount - 1]!
  const previous: [Wire, number][] = row === 0 ? [] : [[aboveViewport[row - 1]!, 1]]
  return circuit.roundAffine([...previous, [aboveViewport[row]!, -1]], row === 0 ? 1 : 0)
})
circuit.assumeOneHot(isFirstVisible)
// DOM slot k shows row firstVisibleRow + k, so its top is a masked sum that compiles to one gather.
const slotTops = Array.from({length: slotCount}, (_, slot) => circuit.affine(
  isFirstVisible.map((bit, row) => [circuit.multiply(rowTops[Math.min(row + slot, rowCount)]!, bit), 1] as const)))
```

In the example, the bits `1 1 1 0 0` give the differences `0 0 0 1 0 0`, which mark position 3, and DOM slots 0 and 1 get the tops 80 and 140 px. Each difference is 0 or 1, because monotone bits never go from 0 back up to 1. The differences add up to `aboveViewport[−1] − aboveViewport[rowCount] = 1 − 0`, so exactly one of them is 1. Position `rowCount` is marked when every row is above the viewport.

### Cost

Counting is O(n) operations at O(1) depth: one integer bit per row (3 operations, 2 layers), 1 count, and n + 1 one-hot members in 1 more layer. Each DOM slot's top is 1 gather.

The example at 10,000 rows, with row heights in source cells and 24 DOM slots:

- The row tops, from a Brent-Kung prefix sum (section 3): 19,981 operations and 24 layers.
- With the count added: 49,982 operations and 27 layers.
- With the one-hot and the 24 DOM slot tops added: 60,007 operations, 28 layers and 24 gather reads.

### Measured in the prototypes

- lists' virtualized list does the same work, plus giving each visible row a DOM slot that doesn't change while the row stays visible: 60,174 operations and 32 layers at 10,000 rows with row tops computed in the circuit, and 40,193 operations and 8 layers with row bottoms computed in JavaScript.
- Rows of one height need no per-row work, because the first visible row is `floor(scrollTop / rowHeight)` (section 4 covers floor). lists' uniform list is 280 operations and 19 layers at 1,000, 10,000 or 100,000 rows, with 0 mismatches in rows, y positions and DOM slots over every quarter-pixel scrollTop of 10,000 rows, at viewport heights 600 and 920 px.
- A binary search takes log2 n steps, and each step reads a row bottom at a position the previous step computed. Reading at a computed position through a one-hot over every row costs O(n) operations per step, so that search costs more than the count. index-read added an index read instruction to a copy of the runtime, which reads `values[floor(index)]` as 1 operation, and numeric-ui-core.ts now has the same instruction as `circuit.indexRead`. With that instruction, in index-read's copy, finding the first visible row among 10,000 rows of different heights, with row tops prepared in JavaScript and 2 fields read per DOM slot, was 215 operations and 57 layers by binary search, against 30,143 operations and 5 layers by counting. So counting is O(n) operations at O(1) depth, and a binary search with index reads is O(log n) operations at O(log n) depth.

### When not to use it

- When every row has the same height: `floor(scrollTop / rowHeight)` takes fewer than 10 operations at any row count.
- When the index read instruction is available and depth doesn't matter: a binary search reads log2 n row bottoms instead of comparing every row.
- When the test isn't monotone, e.g. hit bits of overlapping windows: see section 2.

### Pitfalls

- A count returns a number for any bits, so unsorted bits give a wrong result and no error. pixel-output finds the row under each pixel by counting row tops. In 20 of its 60 random frames, hn-thread's resize handling had made a row height negative, so the row tops weren't sorted, and 1,728 decisions per variant differed from an independent painter's rasterizer.
- Gather lowering relies on `assumeOneHot` without checking it. Run `validateOneHotGroups` in tests, as [loops.test.ts](../examples/loops/loops.test.ts) does.
- The comparison has to be exact. The example's host contract is that scrollTop and row heights are multiples of 1/4 px, and lists rounds scrollTop down onto that grid in JavaScript.
- The count compares every row on every frame, even when 24 rows are in view. Row data the circuit doesn't compute with, e.g. labels, can stay in a JavaScript array indexed by the circuit's row index, which costs nothing in the circuit.

### The same idea in other prototypes

- hn-thread's row under the pointer is the count of row bottoms at or above the pointer: 252 comparisons at 251 comments.
- The gallery's scroll anchor: index.ts steps through the first photo of each row until that photo's bottom is more than a fifth of the window height below the scroll position. Those bottoms increase row by row, so the circuit counts them instead.
- text-walker's line end: for a line that starts at segment s, the bits "segments s through j fit on the line" read `1...1 0...0` as j grows, because segment widths are never negative.
- text-editing's click to place the caret: the count of glyphs whose center is left of the pointer, since glyph centers never decrease along a line.
- lists' release velocity: the demo's loop walks back through pointer samples while they're within 100 ms of the newest one. "Sample `age` is within 100 ms" isn't monotone when timestamps arrive out of order, but "every sample from the newest through `age` is within 100 ms", `[inWindow[0] + ... + inWindow[age] >= age + 1]`, is monotone, and its neighbor differences mark the oldest sample to use.

## 2. When the test isn't monotone: the first hit

The pattern doc [the first active candidate, in a tree](../patterns/first-active-tree.md) has way 2 on one page, with a runnable example and a test.

### The problem

A press lands where several windows overlap, and the frontmost window under the pointer receives the press. The hit bits, in stacking order from the front, look like `0 1 0 1 1`. These bits aren't sorted, so their count, 3, isn't the position of the first hit, 1.

### The JavaScript way

```ts
let pressedWindow = -1
for (let window = 0; window < windowCount; window++) {
  if (hit[window] === 1) {
    pressedWindow = window
    break
  }
}
```

### Circuit way 1: count the earlier hits

A window is the first hit when the press hits it and hits no window before it ([first-hit.ts](../examples/loops/first-hit.ts)):

```ts
// hitsBefore[window] = hit[0] + ... + hit[window - 1], a prefix sum of the hit bits (section 3)
const isFirstHit = hits.map((hit, window) => circuit.reglu([], 1, [[hit, 1], [hitsBefore[window]!, -1]], 0))
```

`relu(hit − hitsBefore)` is 1 for a hit with no earlier hit. A miss gives `relu(0 − k) = 0`, and every later hit has at least 1 earlier hit, so it gives `relu(1 − k) = 0`. For the bits `0 1 0 1 1`, the earlier-hit counts are `0 0 1 1 2`, and `relu(hit − hitsBefore)` is `0 1 0 0 0`.

Another way to see why this works: the running OR of the hits, `min(1, hitsBefore + hit)`, is monotone, `0 1 1 1 1`, and the first hit is where the running OR changes.

### Circuit way 2: a tournament

A tournament compares items in pairs, then the pairs' results in pairs, like a bracket. `emitFirstActive(circuit, gate, hits)` in numeric-ui-core.ts takes the maximum of neighboring hit bits up a balanced tree, so each tree node holds 1 when the press hits any window under that node. Then it routes the gate, a bit that is 1 when a selection should happen, back down the tree: at each node the route goes left when the left subtree holds a hit, and right otherwise. The window where the route arrives is the first hit. That's O(n) operations at O(log n) depth.

### Circuit way 3: the largest key

instanced-items' staged IndirectOS gives each window a key: its stacking rank + 1 when the press hits the window, where a higher rank is closer to the front, and 0 when the press misses. The frontmost hit window has the largest key, so the circuit takes the maximum key, and each window compares its own key with that maximum.

### Cost

The example at 1,024 items, with hit bits in source cells:

| Form | Operations | Layers | Stored weights |
| --- | ---: | ---: | ---: |
| tournament (`emitFirstActive`) | 5,116 | 51 | 9,793 |
| earlier-hit counts as wide sums | 2,046 | 2 | 525,822 |
| earlier-hit counts from a Brent-Kung network | 3,050 | 19 | 6,099 |

At 64 items the same forms are 316 operations in 31 layers; 126 operations in 2 layers with 2,142 stored weights; and 178 operations in 11 layers. The tournament is 5 log2 n + 1 layers at every size the report prints, from 16 to 1,024 items.

In the gallery, where a click selects one photo among 221, the tournament accounts for about 20 of the circuit's 61 layers. Selecting the click by earlier-hit counts brings the whole circuit to 41 layers, for about 23,000 more stored weights.

numeric-library's `emitMinimumOf` finds "which value is smallest" by counting as well: it compares every pair and marks the value that is at most every other value, choosing the first index on ties. The exact minimum of 8 values is 121 operations and 5 layers, O(n²) operations at O(1) depth.

### Pitfalls

- The hits have to be exact bits. `emitFirstActive` accepts fractional scores, and then the route splits, e.g. candidates `[0.5, 0]` send 0.25 to each output. It declares its output a one-hot only when the gate and every candidate are provably exact bits: a boolean atom, a bit returned by `emitCompare`, a member of a declared one-hot, an index read whose reachable candidates are all such bits, or a range pinned to exactly 0 or exactly 1. A plain 0..1 range isn't enough, and neither is an AND of bits built with a ReLU.
- Wide sums store n²/2 weights, e.g. about half a million at 1,024 items.
- Items that can't overlap, e.g. photos in a grid, need none of this, since at most one hit bit is 1.

## 3. Prefix sums three ways

The pattern doc [running totals as a tree of additions](../patterns/running-totals.md) has the three forms on one page, with a runnable example and a test.

### The problem

A prefix sum is the list of running totals of a list, e.g. `rowTops[r] = heights[0] + ... + heights[r − 1]`. UIs need prefix sums for row tops, the left edges of photos in a strip, the x positions of words along a line, and the number of visible items before each item.

### The JavaScript way

```ts
// row-tops.ts, in FP32 like the circuit
let top = 0
for (let row = 0; row < heights.length; row++) {
  top = Math.fround(top + heights[row]!)
  rowTops[row + 1] = top
}
```

### Why the order of additions matters

Every FP32 addition rounds, so adding the same numbers in a different grouping can give a different result. For example, with row heights 229, 167.4, 208.5 and 194.4 px, the loop computes `((229 + 167.4) + 208.5) + 194.4` and gets 799.300048828125, while adding in pairs, `(229 + 167.4) + (208.5 + 194.4)`, gives 799.2999877929688, one FP32 step lower. So a prefix sum's grouping is part of what it computes, and the grouping determines whether a circuit matches a sequential JavaScript loop bit for bit.

### Form 1: a chain

```ts
rowTops[row + 1] = circuit.roundAffine([[rowTops[row]!, 1], [heights[row]!, 1]])
```

Each total adds one height to the previous total, in the loop's order, so the results equal the loop's results bit for bit. n heights cost n − 1 additions in n − 1 layers.

Use `roundAffine` here, not `affine`. The builder copies an ordinary affine sum with fewer than 4 terms into the sums that read it and sorts terms by wire number, so a chain written with `affine` regroups its additions. The runtime notes measured a chain of 1,024 ordinary affine sums at 341 layers, drifting 0.2 px from the sequential loop.

### Form 2: one wide sum per total

```ts
rowTops[row + 1] = circuit.roundAffine(heights.slice(0, row + 1).map(height => [height, 1] as const))
```

Each total is one sum whose terms are in loop order. An affine computes `value = fround(bias)`, then `value = fround(value + fround(coefficient × input))` for each term in stored order, and `roundAffine` stores the caller's order. So each sum takes the same rounding steps as the loop and gives the same bits. No total reads another total, so n − 1 sums fit in 1 layer. The cost moves into stored weights: the total after r rows stores r weights, about n²/2 in all.

### Form 3: a Brent-Kung network

A prefix network is a fixed arrangement of pairwise additions that computes every running total in fewer layers than a chain. In the Brent-Kung network (Brent and Kung, 1982), an upward pass adds neighbors, then pairs of pairs, and so on, completing the totals of the first 2, 4, 8, ... heights. A downward pass then fills in the totals in between, each by adding one completed total to one smaller block (`emitRowTopsBrentKung` in [row-tops.ts](../examples/loops/row-tops.ts)).

For 8 heights h0 to h7, the builder places each addition in the first layer where both of its operands exist, which gives this network (`report.ts network`):

| Layer | Additions | Totals completed |
| --- | --- | --- |
| 1 | h0 + h1, h2 + h3, h4 + h5, h6 + h7 | rowTops[2] |
| 2 | (h0..h1) + (h2..h3), (h4..h5) + (h6..h7), (h0..h1) + h2 | rowTops[4], rowTops[3] |
| 3 | (h0..h3) + (h4..h7), (h0..h3) + (h4..h5), (h0..h3) + h4 | rowTops[8], rowTops[6], rowTops[5] |
| 4 | (h0..h5) + h6 | rowTops[7] |

That's 11 additions in 4 layers, against 7 additions in 7 layers for the chain. `rowTops[1]` is h0 itself and needs no addition. In general a Brent-Kung network is about 2n additions in about 2 log2 n layers, e.g. 2,036 additions in 18 layers for 1,024 heights.

Each total groups its additions differently from the loop, e.g. rowTops[4] is `(h0 + h1) + (h2 + h3)`, the paired grouping from the example above. When every partial sum is exact, e.g. quarter-pixel heights with totals below 2^22 px, the results equal the loop's results. On fractional heights the last bits can differ.

A Kogge-Stone network is another prefix network, with about n log2 n additions in log2 n layers: the runtime notes measured 9,217 additions in 10 layers for 1,024 values.

### Cost

The example, with row heights in source cells:

| Rows | Chain | Wide sums | Brent-Kung |
| ---: | --- | --- | --- |
| 8 | 7 operations, 7 layers, 14 weights | 7 operations, 1 layer, 35 weights | 11 operations, 4 layers, 22 weights |
| 64 | 63 operations, 63 layers, 126 weights | 63 operations, 1 layer, 2,079 weights | 120 operations, 10 layers, 240 weights |
| 256 | 255 operations, 255 layers, 510 weights | 255 operations, 1 layer, 32,895 weights | 502 operations, 14 layers, 1,004 weights |
| 1,024 | 1,023 operations, 1,023 layers, 2,046 weights | 1,023 operations, 1 layer, 524,799 weights | 2,036 operations, 18 layers, 4,072 weights |

The example's tests compare all three forms with the sequential `Math.fround` loop. On quarter-pixel heights at 1 to 200 rows, every total of every form equals the loop's total. On fractional heights at 5 to 200 rows, every total of the chain and of the wide sums equals the loop's total, while some Brent-Kung totals at 64 and 200 rows differ, each by less than 0.02 px.

### Measured in the prototypes

- The gallery's photo strip, with the same outputs as the trace compiler's slice of index.ts, is 9 layers with wide sums and 21 layers with Brent-Kung sums. The trace compiler's slice was 1,580 layers, mostly from sequential sums and long comparison chains.
- hn-thread's 251 animated row tops as wide sums are 506 operations, 32,637 stored weights and 1 layer. Its natural row tops, from integer heights, use a Brent-Kung network of 487 operations and 974 stored weights, 13 layers deeper than the heights it adds. Writing the natural tops as wide sums too takes the whole thread from 69 to 57 layers, for about 31,000 more stored weights.
- lists' capacity routing shows the visible items of a filtered list of 1,000 items in 20 DOM slots, and counts the visible items before each item: 1,009 layers with a chain of counts, 27 layers and 140,408 stored weights with Brent-Kung counts, and 11 layers and 636,939 stored weights with wide sums.

### Precision at large totals

A sequential loop adds a small height to a total that keeps growing. Past about a million pixels, neighboring FP32 values are 1/8 px apart or more, and thousands of rounded additions can round in the same direction. A Brent-Kung network mostly adds totals of similar size, and adds at the full total's size only in its last few levels, so its rounding error grows with the number of levels rather than the number of rows. The example's report, with fractional heights between 20 and 300 px, against exact float64 sums:

- 1,000 rows, 165,492 px of content: the sequential loop is off by up to 0.244 px, Brent-Kung by up to 0.021 px.
- 10,000 rows, 1,584,967 px of content: up to 2.03 px against up to 0.288 px.

In instanced-items at 10,000 photos, sequential sums put row tops off by up to 40.7 px and strip left edges by up to 472.8 px, and one trace flipped 74 decisions against index.ts. With Brent-Kung sums, every decision matched index.ts over 2,408,107 checks ([instancing](instancing.md)).

### Which form to use

- To match a sequential JavaScript loop bit for bit on fractional values: a chain or wide sums.
- For a prefix sum on the UI's longest chain of dependencies: wide sums while n²/2 stored weights are acceptable, e.g. a few hundred rows, and Brent-Kung beyond that.
- For totals past about a million pixels: Brent-Kung, which drifts less but doesn't match a sequential loop's bits.
- On today's CPU executor, with nothing to gain from depth: the chain, which is the least work.

### Pitfalls

- Partial sums are exact only below 2^24 units, e.g. below 2^22 px on a quarter-pixel grid.
- Two circuits that compute "the same" running totals can still group their additions differently. gallery-circuit.ts starts strip total k from `52 × k`, the k gaps, and then adds k widths, a grouping that no one-at-a-time loop reproduces. Switching instanced-items' staged gallery from sequential to Brent-Kung sums kept 90.7% of values bit-identical and moved strip destinations by up to 0.164 px, with no decision changed.

## 4. Threshold counts instead of floor and division

The pattern doc [threshold counts instead of floor and division](../patterns/threshold-counts.md) has this idea on one page, with a runnable example and a test, and [breakpoints found ahead of time](../patterns/breakpoints-found-ahead-of-time.md) finds the thresholds by searching a black-box layout.

### The problem

A responsive grid computes its column count from the container width, then places each item in a row and a column.

### The JavaScript way

From chenglou.github.io's photo gallery, index.ts's `colsBoxMaxSizeXF`, with its gap of 24 px and its minimum photo width of 220 px written in:

```ts
const columnCount = clamp(1, Math.floor((containerWidth - 24) / (220 + 24)), 7)
// and per item:
const row = Math.floor(item / columnCount)
const column = item % columnCount
```

### What goes wrong with a reciprocal and floor

A circuit can't divide by 244 exactly, but it can multiply by the constant `Math.fround(1 / 244)` and then round down. That gives one column too few exactly where a new column should start. At 1,000 px, `Math.fround(976 × Math.fround(1 / 244))` is 3.9999998 instead of 4, so floor returns 3. The example's test tries every width from 0 to 8,192 px, and the reciprocal is wrong at exactly 512, 756, 1,000, 1,244, 1,488 and 1,732 px.

### The circuit way

For x >= 0, `floor(x / d)` is the number of multiples of d at or below x, `Σ_(k >= 1) [x >= k × d]`. With a fixed range of possible results, that's a fixed number of comparisons against constants, called a threshold count ([column-count.ts](../examples/loops/column-count.ts)):

```ts
// atLeastColumns[c] = [columnCount >= c] = [containerWidth - 24 - 244 c >= 0] for c = 2..7.
// The clamp makes atLeastColumns[1] = 1 and atLeastColumns[8] = 0.
for (let columns = 2; columns <= 7; columns++) {
  atLeastColumns.push(emitIntegerAtLeastZero(circuit, [[containerWidth, 1]], -(24 + 244 * columns)))
}
const columnCount = circuit.affine(atLeastColumns.slice(2, 8).map(bit => [bit, 1] as const), 1)
```

At 1,000 px the width reaches the thresholds 512, 756 and 1,000 px, so the count is 1 + 3 = 4 columns. The clamp costs nothing, because the count starts at 1 and there are only 6 thresholds.

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

### Why it works

Under the host contract that the container width is a whole number of pixels, each threshold is an exact integer comparison. The threshold bits are monotone, since a width with room for 7 columns also has room for 6, so their neighbor differences form an exact one-hot. Every output is a sum of exact bits with integer coefficients.

### Cost

K possible results cost K comparisons at O(1) depth, and each value that can be tabulated per possible result while building costs one sum per output. In the example, the column count is 19 operations in 3 layers. With the rows and columns of 221 items, the program is 466 operations, 4 layers and 2,532 stored weights, and with 10,000 items, 10,443 operations in still 4 layers.

In the gallery, the column count and photo width are 30 operations, 6 layers and 54 stored weights, against 524 operations and 91 layers in the trace compiler's slice, and the column count matched index.ts at every whole-pixel width from 320 to 3,840 px.

### Other uses

- **Replacing sqrt, division and floor together.** vibescript's life-calendar sizes its grid with `Math.sqrt`, a runtime division, floor and ceil. codegen's circuit uses 141 threshold tests with constant coefficients instead: the grid has at least 7m columns exactly when `life × gridSizeX >= 49 m (m + 1) × gridSizeY`. It matched the demo's column and row counts on all 197,232 viewports of phase one's sweep.
- **A runtime value divided by a runtime count.** life-calendar's row per cell is `floor(week / m)`, with week up to 3,913 and m up to 140. The circuit computes `round(week × (1/m) − (m − 1) / (2m))`, reading `1/m` and the offset through the one-hot of m. The quotient's fractional part is a multiple of 1/m, so after the offset the value is at least 1/(2m) away from a tie, and rounding can't give the wrong integer. It was exact for all 27,393 cells and all 140 column counts.
- **Floor division by a constant.** `Math.floor(Math.fround(Math.fround(1 / rowHeight) × scrollTop))` misses at least one row for 74 of the 512 integer row heights from 1 to 512 (index-read). index-read's `emitFloorDivide` rounds the approximate quotient, then subtracts 1 when the exact integer remainder is negative: 8 operations and 7 layers, for integer numerators in 0..2^21. It had 0 mismatches at every multiple of the row height up to 2^21, and one below each, for the first ten heights where the plain floor fails.
- **A step function of one runtime width.** A paragraph's height changes in steps as its container gets wider, so the height becomes `baseHeight + Σ heightChange × [width >= threshold]`, with thresholds found in JavaScript when the text is prepared. hn-thread's 251 comment heights use 1,768 thresholds: 5,283 operations in 4 layers. The [text](text.md) section covers this.

### When not to use it

When the range of results is wide, e.g. a row index among 10,000 rows, because a threshold count costs one comparison per possible result. Use `emitFloorDivide`, or a floor on a known grid, instead.

### Pitfalls

- The input has to be on a known grid, e.g. whole pixels. A fractional width needs rounding onto a grid in JavaScript, or a continuous comparison.
- A threshold that FP32 can't represent gets rounded. numeric-library's progress ring lit tick 5 one FP32 step early by comparing progress with `Math.fround(5 / 24)`, which is below 5/24. For an FP32 value x, `x >= t` holds exactly when x is at least the smallest FP32 value at or above t, so storing that value as the threshold makes the comparison match float64.

## 5. Ranks instead of sorting

The pattern doc [ranks instead of sorting](../patterns/ranks-instead-of-sorting.md) has ranks, and the update when one card moves, on one page, with a runnable example and a test.

### The problem

E.g. a photo grid sorted by date after a toggle, or cards reordered by dragging. The DOM needs each item's position, e.g. its translateY, more than it needs a sorted array.

### The JavaScript way

```ts
const order = items.map((_, item) => item).sort((left, right) => keys[left] - keys[right] || left - right)
let top = 0
for (const item of order) {
  itemTops[item] = top
  top += heights[item]
}
```

### The circuit way

An item's rank is its position after sorting, which is the number of items that come before it ([rank-sort.ts](../examples/loops/rank-sort.ts)):

```ts
// earlierFirst[earlier][later] = [keys[earlier] <= keys[later]]: does the earlier item come first?
// n(n - 1)/2 integer bits, none of which reads another, so all of them share the same 2 layers.
const ranks = Array.from({length: itemCount}, (_, item) => {
  const terms: [Wire, number][] = []
  let bias = 0
  for (let other = 0; other < itemCount; other++) {
    if (other < item) terms.push([earlierFirst[other]![item]!, 1]) // an earlier item comes first when its key is at most this item's key
    if (other > item) { // a later item comes first when this item's key is larger
      terms.push([earlierFirst[item]![other]!, -1])
      bias += 1
    }
  }
  return circuit.roundAffine(terms, bias)
})
```

For example, with keys 30, 10, 30 and 20, e.g. dates as day numbers, the ranks are 2, 0, 3 and 1. Items 0 and 2 have the same key, and the earlier item comes first, as in a stable sort, i.e. a sort that keeps items with equal keys in their original order. For each pair, exactly one of the two items comes first, so one comparison per pair gives the order in both directions.

### Positions and sorted reads from the same comparisons

An item's top is the sum of the heights of the items that come before it, one product per pair, e.g. `earlierFirst[other][item] × heights[other]`.

Reading "the height at sorted position p" uses the bits `[rank[item] == p]`, which form a one-hot over items for each p, so each read is a masked sum that compiles to one gather. Together these n² bits form a permutation matrix, a table of bits with exactly one 1 in each row and in each column.

### Why it works

An item's final position depends only on how many items come before it, and that count adds up one comparison per pair. With integer keys every comparison is exact, and on a quarter-pixel grid every sum of heights is exact. The example's tests compare ranks, tops and sorted reads with a stable JavaScript sort at 1 to 33 items, on keys drawn from 8 values so that many keys tie.

### Cost

Ranks are O(n²) operations at O(1) depth. The example, where each column includes the ranks:

| Items | Ranks | Item tops | Height at each sorted position |
| ---: | --- | --- | --- |
| 16 | 376 operations, 3 layers | 616 operations, 4 layers | 936 operations, 6 layers, 16 gather reads |
| 64 | 6,112 operations, 3 layers | 10,144 operations, 4 layers | 14,496 operations, 6 layers, 64 gather reads |
| 128 | 24,512 operations, 3 layers | 40,768 operations, 4 layers | 57,664 operations, 6 layers, 128 gather reads |

### A sorting network instead

A sorting network is a fixed list of compare-exchange steps that sorts any input, where each compare-exchange puts the smaller of two values first. Batcher's networks (bitonic and odd-even merge) use about n × log2²(n) / 4 compare-exchanges in log2(n) × (log2(n) + 1) / 2 stages, so O(n log² n) operations at O(log² n) depth. A compare-exchange on keys alone is a minimum and a maximum, 4 operations in 3 layers (runtime notes).

outside-techniques measured both forms with integer keys and one payload value carried per item:

- 16 items: a bitonic network was 1,248 operations and 50 layers, and ranks by counting with gathers were 1,056 operations and 5 layers.
- 64 items: 10,624 operations and 105 layers, against 16,512 operations and 5 layers.

The runtime notes measured an odd-even merge network over 64 keys, without a payload, at 2,172 operations and 63 layers. So at 16 items counting was less work, at 64 items the network was, and counting stayed at a constant 5 layers.

### An incremental update when one item moves

A drag moves one item from rank `fromRank` to rank `toRank`. Only the items in between change rank, each by 1, so each item needs a few comparisons against the two shared ranks rather than against every other item:

```ts
// buildMoveRanks in rank-sort.ts, per item
const afterFrom = emitIntegerAtLeastZero(circuit, [[rank, 1], [fromRank, -1]], -1) // [rank > fromRank]
const beforeFrom = emitIntegerAtLeastZero(circuit, [[fromRank, 1], [rank, -1]], -1) // [rank < fromRank]
const atOrBeforeTo = emitIntegerAtLeastZero(circuit, [[toRank, 1], [rank, -1]], 0) // [rank <= toRank]
const atOrAfterTo = emitIntegerAtLeastZero(circuit, [[rank, 1], [toRank, -1]], 0) // [rank >= toRank]
const shiftsUp = circuit.reglu([], 1, [[afterFrom, 1], [atOrBeforeTo, 1]], -1) // AND of two bits: relu(a + b - 1)
const shiftsDown = circuit.reglu([], 1, [[beforeFrom, 1], [atOrAfterTo, 1]], -1)
const isDragged = circuit.roundAffine([[afterFrom, -1], [beforeFrom, -1]], 1) // [rank == fromRank]
const nextRank = circuit.roundAffine([[rank, 1], [shiftsUp, -1], [shiftsDown, 1], [circuit.multiply(rankShift, isDragged), 1]])
```

`rankShift` is `toRank − fromRank`, and the JavaScript reference is `order.splice(fromRank, 1); order.splice(toRank, 0, draggedItem)`. For example, moving the item at rank 1 to rank 3, with items ranked 0, 1, 2 and 3, gives the ranks 0, 3, 1 and 2: the dragged item goes to rank 3, and the two items it passed each move up by one. The update is O(n) operations at O(1) depth: 17 operations per item in 5 layers, e.g. 17,409 operations for 1,024 items.

`toRank` is itself a count: lists' port of vibescript's draggable-cards counts the cards ranked before the dragged card whose midpoint is below the pointer, and the cards ranked after it whose midpoint is above the pointer.

lists measured both forms in that port. Recomputing ranks and the stack layout every frame is 69,653 operations at 100 cards and 208,703 at 200 cards, and its two O(n²) parts are 18% of the circuit at 20 cards, 35% at 50, 51% at 100 and 68% at 200. The incremental layout is 36,207 operations at 100 cards and 71,807 at 200 cards. Both layouts matched the demo's card order, z index, dragged card, cursor and pointer buffer length on all 284,000 compared frames at 5 to 100 cards. Most of what remains is springs.

### When not to use it, and pitfalls

- Pairwise ranks get expensive from about a hundred items.
- The incremental update depends on laid-out state from earlier frames: the cards port needs every resting card's destination from last frame, so its incremental layout can't start from arbitrary state the way the demo's first frame does.
- Keys have to compare exactly: integers, or positions on a known grid. Keys that drift in FP32 can flip a comparison near a tie.
- Store order as ranks, or as a permutation matrix in the source table the way IndirectOS stores its 4 × 4 window stacking order, rather than as a link from each item to the next. Following links needs reads at computed positions. outside-techniques estimated pointer jumping over links, which replaces each link by its target's link in every round, at about 8n² operations per round with one-hots.

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

RASP (Weiss, Goldberg and Yahav, "Thinking Like Transformers", 2021) is a programming language whose operations match what a transformer layer computes. As outside-techniques noted, two of this section's rewrites are RASP programs. A count of the items that pass a test is RASP's `selector_width`, e.g. "how many visible items come before this item". Ranks by counting are how RASP sorts.

Attention scores stored keys against a query and returns stored values weighted by those scores, and hard attention returns only the best-scoring value. A masked sum over the first visible row's one-hot is hard attention whose keys are row positions and whose scores are exact bits. The [indexing](indexing.md) section follows this further, including what a transformer has that these circuits don't: queries and keys computed by learned weights.

## 8. Common UI jobs and their formulations

n is the item count, K the number of DOM slots or possible results, L the number of line slots (a line slot is the group of outputs reserved for one line of text: its start, its end and its width), and the lookahead is how many segments after a line's start the line walker compares. "Index reads" means the index read instruction, measured in index-read's copy of the runtime, which numeric-ui-core.ts now has as `circuit.indexRead`. Pointer jumping builds, for every line start, where the line 2, 4, 8, ... lines later starts, by reading the previous table at the positions that table holds. The [executor](executor.md) section has a wider table that also covers comparisons, springs and instancing. Several rows have a pattern doc with a runnable example, e.g. [compaction into K DOM slots](../patterns/compaction-into-slots.md) for a filtered list in K DOM nodes, and [following links by doubling](../patterns/pointer-jumping.md) for line starts from a next-start table.

| UI job | Formulation | Operations | Depth | Measured |
| --- | --- | --- | --- | --- |
| first visible row, rows of different heights | count of monotone bits | O(n) | O(1) after the row bottoms | example, 10,000 rows: 30,001 operations and 3 layers on top of the row tops; index-read, row tops from JavaScript, 24 DOM slots with 2 fields each: 30,143 operations, 5 layers |
| | binary search with index reads | O(log n) | O(log n) | index-read, the same list: 215 operations, 57 layers |
| first visible row, rows of one height | floor of scrollTop / rowHeight | O(1) | O(1) | lists, with 24 DOM slots: 280 operations, 19 layers at any row count |
| visible rows into K DOM nodes | the first visible row's one-hot, then one gather per DOM slot and field | O(n + K) operations, and each gather stores O(n) positions | O(1) | lists, rows of one height with data in source cells, 10,000 rows: 20,305 operations, 19 layers; index-read with index reads, 3 fields per DOM slot: 153 operations, 9 layers |
| row tops | chain | O(n) | O(n) | example, 1,024 rows: 1,023 operations, 1,023 layers, 2,046 weights |
| | wide sums | O(n) operations, O(n²) weights | O(1) | example, 1,024 rows: 1,023 operations, 1 layer, 524,799 weights |
| | Brent-Kung network | O(n) | O(log n) | example, 1,024 rows: 2,036 operations, 18 layers, 4,072 weights |
| overlapping hit test | tournament | O(n) | O(log n) | example, 1,024 items: 5,116 operations, 51 layers |
| | earlier-hit counts, wide sums | O(n) operations, O(n²) weights | O(1) | example, 1,024 items: 2,046 operations, 2 layers, 525,822 weights; gallery, 221 photos: whole circuit 41 layers instead of 61 |
| | earlier-hit counts, Brent-Kung | O(n) | O(log n) | example, 1,024 items: 3,050 operations, 19 layers |
| sorting by a runtime key | ranks by counting | O(n²) | O(1) | example, 64 items: 6,112 operations and 3 layers, or 14,496 operations and 6 layers with sorted reads; outside-techniques, 64 items with a payload: 16,512 operations, 5 layers |
| | sorting network | O(n log² n) | O(log² n) | outside-techniques, 64 items with a payload: 10,624 operations, 105 layers |
| | incremental update when one item moves | O(n) | O(1) | example, 1,024 items: 17,409 operations, 5 layers; lists, whole cards circuit at 100 cards: 36,207 operations against 69,653 |
| a filtered list in K DOM nodes, where DOM slot k shows the (k + 1)-th visible item | one equality bit `[visible items before item == k]` per item and DOM slot (hn-thread calls these rank slots) | O(n × K) | O(1) to O(log n), depending on the prefix counts | index-read, 1,000 items into 20 DOM slots, wide prefix counts: 81,961 operations, 6 layers, 660,424 weights; hn-thread, 251 comments into 48 DOM slots: 25,616 operations |
| | neighbor differences of `[visible items through item <= k]` | O(n × K) | O(log n) | lists, 1,000 into 20 with Brent-Kung prefix counts: 49,224 operations, 27 layers, 140,408 weights |
| | prefix counts, then a binary search per DOM slot with index reads | O(n log n + K log n) | O(log n) | index-read, 1,000 into 20: 10,000 operations, 49 layers; 10,000 into 24: 125,324 operations, 69 layers |
| | DOM slot k shows the first visible row + k, since visible rows are contiguous (hn-thread calls these window slots) | O(n + K) | O(1) | hn-thread, 48 DOM slots: 1,269 operations, but zero-height rows use up DOM slots: a settled collapsed subtree in view needed 32 window slots where rank slots needed 7 |
| column count | threshold count | O(K) | O(1) | example: 19 operations, 3 layers; gallery, with the photo width: 30 operations, 6 layers |
| grow and shrink with min and max | water filling | O(n) with constant clamp points, O(n²) with runtime ones | O(1) | layout-tree, widths pass at 64 children: 784 operations and 9 layers with constant fit widths, 5,601 operations and 12 layers with runtime fit widths |
| flex-wrap | scan one child at a time | O(n) | O(n) | layout-tree, 64 children: 1,185 operations, 276 layers |
| greedy line breaking over n segments | the line walker unrolled one segment at a time | O(n) | O(n) | text-walker, 1,023 segments: 23,496 operations, 9,204 layers |
| | a next-start table (where a line starting at each segment ends, as a count), then one line slot at a time through one-hots | O(n × lookahead + L × n) | O(L) | text-walker, 1,023 segments, 157 line slots: 457,882 operations, 725 layers |
| | the same table, then one line slot at a time with index reads | O(n × lookahead + L) | O(L) | index-read: 191,688 operations, of which 190,279 build the table, 490 layers |
| | the same table, then pointer jumping with index reads | O(n × lookahead + n log L) | O(log L) after the table | index-read: 226,193 operations, 66 layers |

## Files

- [kit.ts](../examples/loops/kit.ts): the integer bit, program measurement, and a seeded random generator.
- [first-visible-row.ts](../examples/loops/first-visible-row.ts): the first visible row by counting, its one-hot, and the tops of the DOM slots.
- [first-hit.ts](../examples/loops/first-hit.ts): the first hit as a tournament and by earlier-hit counts.
- [row-tops.ts](../examples/loops/row-tops.ts): row tops as a chain, as wide sums and as a Brent-Kung network, plus `describeAdditions`, which lists what each addition covers and its layer.
- [column-count.ts](../examples/loops/column-count.ts): the gallery's column count by threshold counts, with each item's row and column.
- [rank-sort.ts](../examples/loops/rank-sort.ts): ranks, item tops and sorted reads, and the incremental rank update when one item moves.
- [water-fill.ts](../examples/loops/water-fill.ts): grow with min and max as clamp bits, and a JavaScript loop that walks the sorted clamp points.
- [loops.test.ts](../examples/loops/loops.test.ts): 17 tests in about 0.2 s, run with `bun test lab/ui-exploration/guide/examples/loops` from the repo root. They check the first visible row at every quarter-pixel scrollTop of a 48-row list; row tops of every form against a sequential `Math.fround` loop, with exact equality; the first hit on random hit patterns; the column count, rows and columns at every width from 0 to 8,192 px; ranks against a stable sort with many equal keys; every move of one rank against `splice`; water filling against its JavaScript reference; and every worked example quoted in this section.
- [report.ts](../examples/loops/report.ts): prints the sizes, the 8-row Brent-Kung network, and the precision numbers quoted above.
