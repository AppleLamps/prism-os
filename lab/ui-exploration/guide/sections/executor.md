# What the compiled program costs, in big-O terms

This section explains how to predict what a circuit costs from the way its UI logic is written. It uses counts that the compiler reports exactly, not timings: how many operations run, how many layers they need, how many weights the compiled matrices store, and how many operations each layer holds. It covers what the builder and the compiler do to those counts, what exactness allows a backend to reorder or merge, what instancing changes, and which choices of semantics decided how cost grows in the prototypes.

Most builder and compiler steps change constant factors, while the way the UI is written changes how cost grows. For example, reading `values[index]` over 10,000 entries costs 40,002 operations when the circuit multiplies every entry by a bit that says whether the entry is the selected one and adds up the products, 30,002 once the compiler replaces those products with a direct read of the selected entry, and 1 operation once reading at an index is its own instruction, which numeric-ui-core.ts now has as `circuit.indexRead` ([index-read](../../index-read/README.md), [indexing](indexing.md#way-3-the-index-read-instruction)). As long as the index has to become one bit per entry first, the read is O(N) work however well the compiler does. As an instruction, the read is O(1).

The examples for this section are in [examples/executor/](../examples/executor/). From the repo root, `bun lab/ui-exploration/guide/examples/executor/report.ts` prints every size quoted from them, and `bun test lab/ui-exploration/guide/examples/executor` checks each circuit against a plain JavaScript reference.

## Summary

- Count operations for work, layers for depth, stored weights for memory and for the work inside sums, and layer width for how much could run at the same time. `compileTensorProgram(roots)` gives all four exactly. O(n²) growth often shows only in stored weights.
- While you build, the builder computes numbers that are known while building, copies sums of fewer than 4 terms into the operations that read them, keeps wider sums as their own values, shares identical expressions, and bases the form of each product on declared ranges. Constant folding and keeping wide sums as their own values change how cost grows; the other steps change constant factors.
- The compiler removes operations that no requested output reads, puts every operation in the earliest layer its inputs allow, stores each layer as a sparse matrix, and turns sums that read a table through one bit per entry into direct reads. A direct read removes the O(N) products of a read, but not the O(N) work of building the bits.
- A sum's FP32 result depends on the order in which its terms are added. In seven UIs, reordering or fusing sums changed one reference check, while skipping FP32 rounding broke every UI that relies on FP32 rounding. Keeping the stored FP32 order only at the operations where rounding turns a value into a decision, from 1.6% to 61% of a UI's operations, repaired all of those UIs.
- Writing the per-item program once keeps the program's size constant as the item count grows. The work per frame still grows with the item count.
- The choices that determined big-O in the prototypes were whether reading at an index is an instruction, how comparisons become bits, whether per-item programs exist, how a frame's events are handled, which capacities are fixed, and whether a value may be one frame late.

## The measures

**Operations** count total work. A compiled program keeps only its live operations, i.e. the operations that some requested output depends on, and computes each of them once per evaluation, where an evaluation is one run of the program over a source table, usually once per frame. Each operation is one of three kinds: an affine sum (weights times inputs plus a constant); a ReLU-gated product (`circuit.reglu`, called ReGLU in the code), i.e. an affine value times the ReLU `max(0, x)` of another affine value; or a boolean atom, which rounds a score in 0..1 to exactly 0 or 1 by adding and subtracting 8,388,609 in FP32. numeric-ui-core.ts also has one more instruction, the index read, which copies the value at a computed position without building one bit per entry (see [sparsification](#sparsification-direct-reads-instead-of-masked-sums)). IndirectOS has 3,654 live operations.

**Stored weights** count memory, and the work inside sums. The compiler stores each layer as a sparse matrix, i.e. a matrix that keeps only its nonzero entries, and each term of a sum is one stored weight. A sum over 1,000 values is 1 operation and 1,000 stored weights, so quadratic growth often shows only here. For example, running totals of 1,024 row heights written as one wide sum per total are 1,023 operations and 524,799 stored weights ([prefix-sums.ts](../examples/executor/prefix-sums.ts)). To check whether a formulation is O(n) or O(n²), count stored weights, not only operations.

**Layers** count depth: the longest chain of operations in which each operation reads the result of the one before. The compiler puts each operation in the first layer after everything the operation reads, so the number of layers equals the length of the longest dependency chain. IndirectOS is 124 layers deep.

**Layer width** is the number of operations in one layer, i.e. how much work could run at the same time on hardware that runs a whole layer at once. IndirectOS has a median of 23 operations per layer and at most 426, so it's narrow and deep: a long chain of dependencies, not a stack of wide matrices. Before September 15, 2026, it had a median of 24 and at most 123 ([notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)).

Two more counts matter once the others are small. **Table entries** are the integer positions that direct reads store, described under sparsification below. **Source cells** are checked against their declared ranges on every evaluation, which is O(source cells) work. For example, index-read's list of 10,000 rows shown through 24 DOM nodes compiles to 153 operations, and most of its evaluation time went to checking 30,001 source cells.

### A compiled program, layer by layer

The UI job: is the pointer inside a window's close button? In JavaScript:

```ts
const buttonLeft = windowLeft + windowWidth - buttonInset - buttonSize
const buttonTop = windowTop + (titleHeight - buttonSize) / 2
const pressed = buttonLeft <= pointerX && pointerX < buttonLeft + buttonSize
  && buttonTop <= pointerY && pointerY < buttonTop + buttonSize
```

[anatomy.ts](../examples/executor/anatomy.ts) builds the same test over five source cells that hold whole pixels, with a buttonSize of 16, a buttonInset of 6 and a titleHeight of 28. Each comparison is an integer bit, `[v >= 0] = relu(v + 1) - relu(v)`, where `[condition]` means 1 when the condition holds and 0 otherwise, and the AND of four exact bits is `relu(bit1 + bit2 + bit3 + bit4 - 3)`. Shortened:

```ts
const buttonLeft = circuit.affine([[windowLeft, 1], [windowWidth, 1]], -buttonInset - buttonSize)
const buttonTop = circuit.affine([[windowTop, 1]], (titleHeight - buttonSize) / 2)
const bits = [
  emitAtLeastZero(circuit, [[pointerX, 1], [buttonLeft, -1]], 0), // pointerX >= buttonLeft
  emitAtLeastZero(circuit, [[buttonLeft, 1], [pointerX, -1]], buttonSize - 1), // pointerX < buttonLeft + buttonSize
  emitAtLeastZero(circuit, [[pointerY, 1], [buttonTop, -1]], 0),
  emitAtLeastZero(circuit, [[buttonTop, 1], [pointerY, -1]], buttonSize - 1),
]
const pressed = circuit.reglu([], 1, bits.map(bit => [bit, 1]), -3)
```

`describeProgram` in the same file prints the program compiled for the root `pressed`:

```txt
layer 1: 8 operations, reads 5 values, 16 matrix rows (8 output rows + 8 gate rows), 20 stored weights
  rightOfLeftEdge.upper = relu(pointerX - windowLeft - windowWidth + 23)
  rightOfLeftEdge.lower = relu(pointerX - windowLeft - windowWidth + 22)
  leftOfRightEdge.upper = relu(-pointerX + windowLeft + windowWidth - 6)
  leftOfRightEdge.lower = relu(-pointerX + windowLeft + windowWidth - 7)
  belowTopEdge.upper = relu(pointerY - windowTop - 5)
  belowTopEdge.lower = relu(pointerY - windowTop - 6)
  aboveBottomEdge.upper = relu(-pointerY + windowTop + 22)
  aboveBottomEdge.lower = relu(-pointerY + windowTop + 21)
layer 2: 1 operation, reads 8 values, 2 matrix rows (1 output row + 1 gate row), 8 stored weights
  pressed = relu(rightOfLeftEdge.upper - rightOfLeftEdge.lower + leftOfRightEdge.upper - leftOfRightEdge.lower
    + belowTopEdge.upper - belowTopEdge.lower + aboveBottomEdge.upper - aboveBottomEdge.lower - 3)
```

What the printout shows:

- The builder appended 16 operations, and 9 are live. buttonLeft, buttonTop and the four bits are sums of fewer than 4 terms, so the builder copied their terms into the operations that read them. For example, `pointerX - windowLeft - windowWidth + 22` inside the second ReLU is `pointerX - buttonLeft`. No live operation reads the copied sums, so the compiler removes them. The compiler also removes `buttonCenterX`, a tooltip position that the example builds but doesn't request; compiling for both `pressed` and `buttonCenterX` gives 10 operations.
- The 8 ReLUs don't read each other, so they share layer 1, which is 8 operations wide. `pressed` reads all 8 ReLUs, so it's computed in layer 2.
- A layer's matrix has one row per operation, plus one gate row per ReLU-gated product. The executor multiplies the matrix with the layer's inputs and adds the biases, then multiplies each gated output row by `max(0, gate row)`.
- Each nonzero coefficient is one stored weight: 3 for each ReLU that reads pointerX, windowLeft and windowWidth, 2 for each ReLU on the vertical axis, and 8 for `pressed`.

The matrix of layer 2, in compressed sparse row form (CSR), stores for each row where the row's entries start, then the column and the weight of every entry:

```txt
rowOffsets [0, 0, 8]                   row 0 has no entries, row 1 has entries 0 to 7
columns    [0, 1, 2, 3, 4, 5, 6, 7]    positions in the layer's list of 8 inputs
weights    [1, -1, 1, -1, 1, -1, 1, -1]
bias       [1, -3]
```

Row 0 is the left side of `pressed`: no weights and a bias of 1, so the left side is the constant 1. Row 1 is the gate, `rightOfLeftEdge.upper - rightOfLeftEdge.lower + ... - 3`. So the executor computes `1 × max(0, gate)`.

Built with `roundAffine`, which the builder never copies, buttonLeft and buttonTop stay values of their own, and the program is 11 operations, 3 layers and 27 stored weights. buttonLeft and buttonTop fill layer 1, the ReLUs move to layer 2 and read the edges with 2 weights each, and `pressed` moves to layer 3. Copying saved 2 operations and a layer here, for 1 more stored weight. The test checks both builds against the JavaScript at every whole-pixel pointer position in a 50 by 50 px square around the button, for three windows.

### Which measure an executor pays for

- The current executor is JavaScript on the CPU. It runs layers one after another, and its work is O(source cells + live operations + stored weights), plus a small fixed cost per layer for copying the layer's inputs out of the value array and its outputs back in. Depth costs only that per-layer overhead: in indirect-os-2, the executor's time grew with live operations, about 8 µs per 1,000, and removing 104 layers moved the time by less than the measurement noise.
- Generated JavaScript ([codegen](../../codegen/README.md)) writes one statement per live operation, so its work grows with operations and stored weights, and layers don't matter.
- The work of a shader that runs one program per pixel or per item grows with the operations of that program. Its parallelism comes from the number of pixels or items, not from layers.
- An executor that runs each layer as one parallel pass, e.g. one GPU dispatch per layer, pays per layer: layers set the number of passes, and layer width sets how much each pass does. Brent's theorem ([chains](chains.md#why-depth-matters-and-when)) gives the limit: W operations of depth D take about D + W / p steps on p processors. No such executor exists in the repo, so depth is currently something to watch rather than a cost you pay.

### Measuring a circuit

[stats.ts](../examples/executor/stats.ts) reads the counts from `compileTensorProgram`:

```ts
const program = circuit.compileTensorProgram(roots)
const operations = program.valueCount - program.sourceSize
const layers = program.layers.length
let storedWeights = 0
let widestLayer = 0
for (const layer of program.layers) {
  storedWeights += layer.weights.length
  widestLayer = Math.max(widestLayer, layer.outputSize)
}
```

Pass the roots that JavaScript actually reads, i.e. the outputs and the next-state values. Without roots, `compileTensorProgram()` keeps every built operation, and so does `evaluateTensor(source)`, which compiles that way.

## What the builder does while you write

`Circuit.append` in [numeric-ui-core.ts](../../../../numeric-ui-core.ts) runs a few steps on every new operation, before the compiler runs:

| Step | What it does | What it changes |
| --- | --- | --- |
| Constant folding | computes every part of an expression whose inputs are known while building | how cost grows, e.g. 64 ranks of known widths are 64 constants instead of 8,128 operations |
| Copying small sums | copies a sum of fewer than 4 terms into every operation that reads it | saves an operation and a layer per sum, for more stored weights |
| Keeping wide sums | keeps a sum of 4 or more terms as its own value | how cost grows, e.g. a total read by 256 items stores 768 weights instead of 65,792 |
| Sharing identical expressions | returns the existing value for an identical operation | the same hit test written twice costs once |
| Keeping the operands of products, selects, minimums, maximums and `roundAffine` | never copies an affine operand into these calls | one more operation and layer per such operand, e.g. 33 layers for one `emitSpring` |
| Choosing a product's form from declared ranges | a product with an operand known to be nonnegative is 1 ReLU-gated product | 1 operation instead of 3 |

### Constant folding

Constant folding means computing, while building, every part of an expression whose inputs are known, the way a JavaScript engine can compute `24 * 60` once instead of on every call. For ordinary sums and ReLU-gated products, the builder sorts the terms by wire number, merges repeated terms into one coefficient, drops zero terms, moves a value that is a constant into the bias of every sum that reads it, and turns a ReLU-gated product whose gate is a constant into a plain affine sum.

Folding is why static structure costs nothing at runtime. In [builder-steps.ts](../examples/executor/builder-steps.ts), each item's rank is the number of narrower items, `rank[item] = Σ over other items of [width[other] < width[item]]`. With widths known while building, the 64 ranks become 64 operations that each hold a constant, with 0 stored weights. With widths in source cells, every pair of items needs its own integer comparison: 8,128 operations and 24,192 stored weights.

```ts
// [left < right] for integer-valued wires: relu(right - left) - relu(right - left - 1)
function lessThan(circuit: Circuit, left: Wire, right: Wire): Wire {
  const atLeastOne = circuit.reglu([], 1, [[right, 1], [left, -1]], 0)
  const atLeastTwo = circuit.reglu([], 1, [[right, 1], [left, -1]], -1)
  return circuit.affine([[atLeastOne, 1], [atLeastTwo, -1]])
}
```

When `left` and `right` are constants, both gates are constants, so both ReLU-gated products become constants while building, and so does the comparison.

The prototypes measured the same effect at full size. In [layout-tree](../../layout-tree/README.md), a row of 64 children that grow between their min and max widths costs 897 operations when every child's content width is a constant, because every pairwise ReLU between those widths is computed while building, and 5,750 operations (about 1.4 n²) when the content widths are runtime values. [drag-knobs](../../drag-knobs/README.md) moved five design numbers of layout-tree's app shell (card padding, grid gap, minimum card width, sidebar width, title font scale) from constants into source cells for 60 more operations and 1 more layer.

Folding stops at `multiply`, `select`, `roundAffine`, `emitMinimum` and `emitMaximum`, because these calls keep their operands as values (see below). A known number passed to one of these calls as a value of its own stays an operation. In builder-steps.ts, `distance = velocity × 0.004` with 0.004 as a coefficient, `circuit.affine([[velocity, 0.004]])`, is 1 operation, 1 layer and 1 stored weight. Written as `circuit.multiply(velocity, circuit.affine([], 0.004))`, the same product is 2 operations, 2 layers and 2 stored weights, with the same bits. For the same reason, the [model](model.md#builder-code-runs-once-at-startup) section's clamp of a window's left edge, built with a constant 0 value, costs one operation and one layer more than the two macros alone.

When not to use constants: a number that must change while the UI runs, e.g. a drag threshold chosen per user, or a design number that an agent edits without rebuilding, has to be stored in a cell, and every operation that scales by the number then needs a product instead of a weight.

### Copying small sums into the operations that read them

An ordinary `affine` sum with fewer than 4 terms isn't kept as a value of its own: the builder copies the small sum's terms into every ordinary sum or ReLU-gated product that reads the small sum. Compilers call this inlining, e.g. a JavaScript engine replacing a call to a tiny function with the function's body. In the close button example, buttonLeft and buttonTop exist only as copies inside the ReLUs, which saves 2 operations and a layer.

Copying multiplies stored weights. A sum with t terms, copied into r readers, stores about t × r weights, while keeping the sum as its own value stores t + r. Composing a layer of sums into the next layer is a matrix product, and the product of two sparse matrices can have far more nonzero entries than either matrix; sparse linear algebra calls those new entries fill-in. So copying a wide sum into many readers is where n² comes from.

In [shared-sum.ts](../examples/executor/shared-sum.ts), each of n items has its label at `0.5 × totalHeight + offset[item]`, where `totalHeight` adds up every item's height:

```ts
const totalHeight = circuit.affine(heightCells.map((height): [Wire, number] => [height, 1]))
const labelTops = offsetCells.map(offset => circuit.affine([[totalHeight, 0.5], [offset, 1]]))
```

| Items | Total kept as its own value: operations / layers / stored weights | Total copied into every label: operations / layers / stored weights |
| ---: | --- | --- |
| 3 | 3 / 1 / 12 | 3 / 1 / 12 |
| 4 | 5 / 2 / 12 | 4 / 1 / 20 |
| 64 | 65 / 2 / 192 | 64 / 1 / 4,160 |
| 256 | 257 / 2 / 768 | 256 / 1 / 65,792 |

The builder keeps a sum of 4 or more terms as its own value (`affineShareThreshold = 4` in numeric-ui-core.ts), so `circuit.affine` gives the shared form, and stored weights stay O(n). At 3 items the total has 3 terms, the builder copies it, and both builds are identical. So a test at a small item count can't show the n² growth.

The rule depends only on the sum's own term count, after its own inputs were copied in, and never on what was built before the sum. The test "wide affine sharing is independent of consumer order" in numeric-ui-core.test.ts checks that rule. When sharing depends on build history, identical expressions can get different values that round differently, and an operation that no output reads can change a live output.

Copying changes the FP32 steps too. The shared total is rounded as each height is added and then halved once, while the copied form adds half of each height, so on fractional heights the two forms can differ in the last bits. Both give the float64 result on quarter-pixel heights. The test checks each form against a plain loop that takes the same FP32 steps.

Copying also merges chains. A running total built as `circuit.affine([[previousTotal, 1], [height, 1]])` gets copied into the next total until the copy reaches 4 terms, so 1,024 heights take 341 layers and 3,069 stored weights, where the same chain built with `roundAffine` takes 1,023 layers and 2,046 stored weights. The copied chain adds the heights in another grouping, so on fractional heights some of its totals differ from a sequential FP32 loop ([prefix-sums.ts](../examples/executor/prefix-sums.ts); the test counts those differences).

Pitfall: copying puts large values into a running sum, where they can round. A bit written as `relu(v) - relu(v - 1)` is a small sum, so both ReLUs are copied into every sum that reads the bit, however large the ReLUs get. Building the bit with `roundAffine`, which is never copied, avoids that. The [comparisons](comparisons.md#form-1-integer-bits) section has the failures this caused in lists and input.

### Sharing identical expressions

The builder keys every operation by its kind, bias, terms, rounding flag and macro, and returns the existing value when an operation with the same key exists. Compilers call this common subexpression elimination. The same hit test written twice costs once. In [masked-read.ts](../examples/executor/masked-read.ts), bit p of a one-hot (a group of bits in which exactly one bit is 1) for an integer index i is `relu(i - p + 1) - 2 × relu(i - p) + relu(i - p - 1)`. Neighboring bits share two of their three ReLUs, so 1,024 bits need 1,026 ReLUs instead of 3,072.

Pitfall: `roundAffine` keeps the caller's term order in its key, so the same terms written in another order build a second operation, and with 3 or more terms the two may round differently.

### Products, selects, minimums and maximums keep their operands

`multiply`, `select`, `emitMinimum`, `emitMaximum` and `roundAffine` fix their FP32 steps, so the builder never copies an affine operand into them, and the operand stays its own operation, one layer earlier. This is why one animated number built with `emitSpring` is 46 operations and 33 layers. In each of its 4 integration substeps, the acceleration, the new velocity and the new position each become their own operation before the next product reads them ([notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)).

### Declared ranges determine the form of a product

`multiply(a, b)` puts an operand known to be nonnegative into the ReLU's gate, which costs 1 operation. When neither operand is known to be nonnegative, `multiply` builds two ReLU-gated products of opposite signs and subtracts them: 3 operations and 2 layers. In builder-steps.ts, `velocity × timestep` is 1 operation, 1 layer and 2 stored weights when the timestep's range is declared before the product, and 3 operations, 2 layers and 6 stored weights when the range is declared after.

A range declared after an operation was built doesn't change that operation. Until September 15, 2026, IndirectOS declared its spring timestep's range after the window springs existed, and declaring the range where the timestep was computed saved 320 operations, 8 layers and 640 stored weights, with bit-identical outputs ([notation](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/notation), [indirect-os-2](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2)).

## What `compileTensorProgram` does

Given the roots, the compiler runs five steps:

1. **Plan gather lowering.** It finds sums that read a table through a declared one-hot, which can become direct reads of the selected entry (see sparsification below).
2. **Remove dead code.** It walks back from the roots and keeps only the operations that some root depends on. In the close button example, 9 of the 16 built operations stay. IndirectOS builds 4,011 operations and keeps 3,654.
3. **Group operations into layers.** Each operation's layer is the depth that the builder recorded: one more than the deepest value the operation reads. This is called an as-soon-as-possible schedule, because no operation is placed in a later layer than its inputs require. With `compileTensorProgram(roots, lowerGathers, {recomputeDepths: true})`, the compiler instead computes each live operation's depth from the values it reads in the compiled program, which differs from the builder's depth only after gather lowering.
4. **Build each layer's sparse matrix** in CSR form, as shown above. Index arrays use the smallest unsigned integer type that fits.
5. **Pack the values.** The executor keeps one array that holds every source cell and every live operation's value. Each layer appends its outputs to that array, and `wireOrder` maps array positions back to wires.

The executor then runs each layer in five steps:

| Executor step, per layer | Work |
| --- | --- |
| copy the layer's inputs out of the value array | O(distinct values the layer reads) |
| multiply the sparse matrix with the inputs, and add the biases | O(stored weights + matrix rows) |
| direct reads of selected entries (gathers) | O(bits) once per one-hot group per evaluation, plus O(1) per read |
| index reads: floor each read's index row, then copy the selected value | O(1) per read |
| multiply gated rows by `max(0, gate row)`, and round boolean rows | O(matrix rows) |
| append the outputs to the value array | O(operations in the layer) |

Before the layers, `validateSourceRanges` checks every source cell against its declared range: O(source cells).

Over one evaluation that's O(source cells + live operations + stored weights), plus the bits of gathered one-hots, plus a fixed cost per layer. The values a layer copies out are distinct values that its terms read, so there are at most as many of them as the layer's stored weights. Memory is one number per source cell and per live operation, plus the program itself: stored weights, biases, index arrays and table entries.

What the compiler doesn't do today: it doesn't recompute depths after gather lowering unless called with `{recomputeDepths: true}`, doesn't move operations to later layers, doesn't free values that no later layer reads, doesn't reorder the terms inside a sum, and doesn't merge operations.

### Reordering operations across layers

A schedule assigns each operation to a layer, and any layer after every value the operation reads works. Moving an operation to a later layer doesn't change any result, because the operation still reads the same values. No schedule can have fewer layers than the longest dependency chain, so scheduling changes memory and layer widths, not depth.

The as-soon-as-possible schedule can keep values alive for a long time. E.g. a value computed in layer 1 and first read in layer 190 has to be stored across 189 layers. Today's executor keeps every value for the whole evaluation anyway. A backend with a fixed width, like a transformer's residual stream (the vector of numbers that every layer reads and adds to), pays for the largest number of values alive at once. The repo [README](../../../../README.md)'s TODO names Percepta's mixed-integer formulation as the reference approach for scheduling. [notes/outside-techniques.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) describes that approach: an integer optimization places operations into layers while minimizing the peak number of live values, and interval coloring, i.e. giving two values the same position whenever the layers in which they're alive don't overlap, then reuses positions of the residual stream.

## Sparsification: direct reads instead of masked sums

A gather is a read of one value from a table at a position, like `table[index]`, e.g. `torch.gather` in PyTorch. A masked sum reads a table through a one-hot instead: `Σ over p of bit[p] × value[p]`. Dense, a masked sum over N entries is N products plus one sum of N terms, i.e. N + 1 operations and 3N stored weights for each read.

The UI job in masked-read.ts is reading the selected row's top, `rowTops[selectedIndex]`, over 1,024 rows. In JavaScript that's one array access. The circuit builds the one-hot of `selectedIndex`, declares the bits as a one-hot group, and adds up masked products (shortened, with names for the source cells):

```ts
const bits = rowTopCells.map((_, position) => circuit.affine([
  [relu(circuit, [[selectedIndexCell, 1]], -position + 1), 1],
  [relu(circuit, [[selectedIndexCell, 1]], -position), -2],
  [relu(circuit, [[selectedIndexCell, 1]], -position - 1), 1],
]))
circuit.assumeOneHot(bits)
const selectedTop = circuit.affine(bits.map((bit, row): [Wire, number] =>
  [circuit.multiply(bit, rowTopCells[row]!), 1]))
```

The compiler looks for sums whose terms are products of the bits of a declared one-hot group with values, covering each bit exactly once, where every value has a finite declared range. For such a sum, the executor computes the selected position once per group per evaluation, as `Σ over p of p × bit[p]`, and each read adds the selected value to the sum's bias. The products leave the program, and the read stores no weights. The read still stores N integer positions of values, and each group stores the N integer positions of its bits.

The lowered read gives the same bits as the dense sum. Every unselected product is `fround(value × 0)`, which is +0 or -0 for a finite value, and adding a zero doesn't change an FP32 sum, so the dense sum reduces to the bias plus the selected value. A value that may be Infinity breaks that argument, since `fround(Infinity × 0)` is NaN, which is why lowering needs finite declared ranges.

| Selection | Compiled | Operations | Layers | Stored weights | Table entries |
| --- | --- | ---: | ---: | ---: | ---: |
| an integer index in one cell, one-hot built in the circuit | dense | 3,075 | 4 | 7,170 | 0 |
| | gather lowering | 2,051 | 3 | 4,098 | 2,048 |
| one bit per row in cells | dense | 1,025 | 2 | 3,072 | 0 |
| | gather lowering | 1 | 1 | 0 | 2,048 |

Lowering removes the O(N) products of each read, not the O(N) work of building the one-hot. With k fields read at one index, the dense form stores about 3kN weights, while the lowered form builds the one-hot once, O(N), and then pays O(1) per field. Only when the selection is already stored as bits in source cells, e.g. IndirectOS's stacking order stored as a permutation matrix of bits, does the whole read cost O(1) operations.

[index-read](../../index-read/README.md) added reading at an integer index as its own instruction, `values[floor(index)]`, in a copy of the runtime, and numeric-ui-core.ts now has the same instruction as `circuit.indexRead`. `values[index]` over 10,000 entries went from 40,002 operations dense and 30,002 with gather lowering to 1, with 1 stored weight and no stored positions in numeric-ui-core.ts. A compile pass in index-read's copy recognizes ReLU one-hots and reads from their index directly, which reached the same count for circuits already written with one-hots, and numeric-ui-core.ts didn't take that pass. But the builder still constructs the one-hot before the compiler removes it: building the 10,000-row list took 561 ms, against 9 ms with the instruction.

A masked sum is a form of attention, i.e. a weighted sum of values whose weights come from comparing a query with keys; here the keys are positions and the weights are a one-hot. Gather lowering and the index read instruction are hard attention (attention whose weights are a one-hot) computed as a lookup. The [indexing](indexing.md) section covers the constructions and their gradients.

Two other sparsifications came up:

- A constant per pair of items became a table. IndirectOS's Photos computes each thumbnail's offset from the focused photo as `Σ over focused photos f of focus[f] × constant(thumbnail, f)`, one weight per (thumbnail, focused photo) pair. At 1,024 photos that's 1,063,936 stored weights. Stored instead as a table of 2 × 1,024 cells per field and read once per thumbnail, the offsets take 3,072 stored weights ([index-read](../../index-read/README.md)).
- Matrix rows stay sparse. IndirectOS averages 1.39 stored weights per matrix row, against 1.43 before September 15, 2026, when a dense matrix per layer would have stored about 26 times as many numbers ([notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)).

Pitfalls:

- A lowered read keeps the depth of the products it replaced. The layer that held the products disappears (4 layers to 3 above), but operations after the read don't move earlier. index-read's copy recomputes depths after lowering. For recovering the lines of a 1,023-segment paragraph, recomputing took the circuit whose one-hots the compiler removed from 744 to 490 layers, but the shared runtime's gather lowering only from 850 to 801, because that circuit still builds its one-hots before the reads. numeric-ui-core.ts recomputes depths only with `{recomputeDepths: true}`, which is off by default because it changes existing programs, e.g. IndirectOS goes from 192 to 191 layers with the same operations, stored weights and values.
- A declared one-hot is a declaration, like `assumeRange`, and nothing checks the one-hot during evaluation. When the declaration is false, the read returns a wrong value, and the executor clamps the position so it never reads outside the table. `validateOneHotGroups` checks the declaration in tests.
- The compiler doesn't lower sums with any other term, coefficients other than ±1, bits that aren't all covered, or bits that constant folding removed. candidate-gallery.ts, a repo-root demo that scores three candidate layouts and shows the best one, reads each layout's hero rectangle, i.e. its large featured area, through the winning layout's one-hot. Those reads stay dense: the Contact layout has no hero, so its rectangle is the constant 0, constant folding removed that product, and the sum covers only 2 of the 3 bits ([lab/gather-lowering](../../../gather-lowering/README.md)).
- Table entries can grow large, and operation counts don't show it. In the shared runtime, every lowered gather read stores N positions, e.g. hn-thread's circuit stores 109,949 table entries at 251 comments. An index read stores a start position and a stride when the entries sit evenly spaced in the value array, and reads of the same table share one list of positions, as in index-read's copy. Gather reads keep their lists of positions, so existing programs didn't change.

## Reordering and merging arithmetic: what exactness requires

### Every sum has an FP32 order

The executor computes a sum as `value = f(bias)`, then `value = f(value + f(weight × input))` for each term in stored order, where `f` is `Math.fround`. An ordinary `affine` stores its terms by ascending wire number, which follows creation order, and `roundAffine` keeps the order the caller wrote. So term order is part of what a circuit computes: the reference evaluator, the compiled executor and generated JavaScript all add terms in stored order.

[sum-order.ts](../examples/executor/sum-order.ts) adds a spring position of 1,256 px, a step of 0.0001 px and a destination of 1,256 px in two orders. Adding the step first gives 0.0001220703125, one FP32 step at 1,256 px (1/8,192 px), because the sum 1,256 + 0.0001 rounds to the nearest FP32 value. Subtracting first gives 0.0001 as FP32:

```ts
const addThenSubtract = circuit.roundAffine([[position, 1], [step, 1], [destination, -1]])
const subtractThenAdd = circuit.roundAffine([[position, 1], [destination, -1], [step, 1]])
```

A fused multiply-add computes `a + b × c` without rounding `b × c` first. For `1 + 0.1 × 9`, the executor rounds the product to 0.9000000357627869 and gets 1.9000000953674316, while the fused form gets 1.899999976158142.

Some sums don't depend on the order. A difference `a - b` has the same FP32 result in every order, with or without fusion, because the first term enters exactly and only one rounding step remains. Sums with three or more addends, counting a nonzero bias, or with two addends where a weight isn't a power of two, can change.

### What compilers for parallel hardware do to sums

Floating-point contraction computes `a × b + c` as one fused multiply-add, without rounding the product first. Reassociation regroups `(a + b) + c` into `a + (b + c)`. Compilers apply both when their fast-math settings allow them. [codegen](../../codegen/README.md) probed Apple's Metal shader compiler through two WebGPU implementations, wgpu and Dawn. The compiler fused multiply-adds even across statements, regrouped sums depending on the surrounding code, and simplified `(x + 8,388,609) - 8,388,609`, the boolean atom's shape, back to `x`. Storing a value in a `let` or a `var`, or adding a zero read from a buffer, didn't stop any of this. Wrapping a result in `max(x, lowest)`, with `lowest` read from a buffer, did, because the compiler can't prove that the `max` returns `x`.

A parallel prefix network, or a framework's parallel sparse kernel, also adds a sum's terms in another order than the executor, e.g. pairwise in a balanced tree.

Skipping FP32 rounding is the extreme case. `round(x) = (x + 2^23 + 2^22) - (2^23 + 2^22)` rounds only because FP32 values above 2^23 are whole numbers, so round(2.5) is 2 in FP32 and 2.5 in float64 (sum-order.ts). The boolean atom rounds the same way.

### Which exactness the UIs actually used

[exactness-budget](../../codegen/README.md#merged-from-exactness-budget-september-16-2026), since merged into codegen's README, called an operation a rounding point when FP32 rounding turns its value into a decision, or when the operation feeds such a decision: a boolean atom, each step of a round or floor chain like `(x + 2^23 + 2^22) - (2^23 + 2^22)`, a ReLU that scales one runtime value by a power of two of at least 2^8, e.g. the gallery's `relu(2^40 × difference + 0.5)`, and the difference that a comparison feeds into one of these. That ReLU pattern also matches the stages of a sign cascade, although a sign cascade gives the same bits without any rounding. For example, numeric-library's exact comparison `[a >= b]` has four rounding points: its difference `roundAffine([[a, 1], [b, -1]])`, the two ReLUs of its clamp, and its boolean atom. A blend like `0.3 × a + 0.7 × b` isn't a rounding point. Rounding points were 1.6% of operations in vibescript's life-calendar, 4.9% in IndirectOS (256 of 5,253), 43% in the photo gallery, and 61% in numeric-library's dock and progress ring.

exactness-budget replaced the executor with an interpreter that adds terms eight ways: stored order, reversed, balanced like a parallel reduction, fused, balanced and fused, float64, and two modes that keep the stored FP32 order only at rounding points and use balanced fused sums or float64 everywhere else. It ran seven UIs through each mode with each prototype's own page logic and reference checks: IndirectOS, the gallery, hn-thread, lists' draggable cards, text-editing, numeric-library's dock and ring, and life-calendar.

What the modes found:

- Reversing, balancing or fusing every sum, rounding points included, changed one reference check across all seven UIs: in the gallery, one settle decision came one frame late, in 1 of 3,600 frames.
- float64 everywhere broke every UI that relies on FP32 rounding: 1,150,506 wrong rows (and as many wrong columns and days of week) in life-calendar, 5,736 of 12,000 frames of draggable cards at 20 cards, 1,436 of 1,500 typing frames, and 18,820 of 20,000 percent labels. Keeping the stored FP32 order at rounding points and float64 everywhere else repaired all four.
- In six of the seven UIs, with stored order at rounding points and balanced fused sums or float64 everywhere else, no boolean atom, gather index, decision output or reference check changed. Positions drifted by at most 0.0022 px in IndirectOS and 0.006 px in hn-thread.
- None of IndirectOS's 256 rounding points depends on order: its comparisons are two-term differences and clamps scaled by powers of two.

Where order did matter:

- The gallery computes whether a spring may settle by comparing a destination recomputed this frame with last frame's stored FP32 copy. With the same arithmetic in both frames, the difference is exactly 0. Recomputed in float64 at 50,607 px, the destination differed by 0.0105 px, just above the 0.01 px settle threshold, which kept springs animating (108 mismatches against index.ts, the original gallery code). A value compared with its own stored copy needs the same arithmetic every frame, not only stored order at rounding points.
- Settle tests on drifting spring velocities: under another order, a velocity near 0.01 came out on the other side of the threshold, and one settle decision came a frame late in 1 of 3,600 gallery frames. Stored order at rounding points didn't prevent it, because the difference started in ordinary spring sums of 4 to 12 terms.
- A tie inside a rounding point: the dock's sine and cosine round `angle × 2 / π` to a quadrant. At 3π/4 the FP32 product is exactly 1.5, which rounds to 2, while the fused product is just below 1.5 and rounds to 1. Stored order at those operations removed the flips.
- A comparison sitting exactly on its threshold: in draggable cards, the pointer sat exactly on a card's right edge, and under fused order one FP32 step of drift in the card's position flipped the hit test's bit. No output changed.

On the GPU, wrapping only rounding points in `max(x, lowest)` gave 0 decision mismatches through wgpu and Dawn on codegen's 12 random circuits and five workloads that run one program over many pixels or items, with 84 guards instead of 537 for IndirectOS's press map (which window receives a press at each pixel), and 30 instead of 787 for shapes described by their distance from each pixel. The seven UIs above weren't run on the GPU.

Order can help precision as well. At 10,000 photos, sequential running sums in [instanced-items](../../instanced-items/README.md) add row heights of a few hundred pixels to totals past a million pixels, where FP32 values are 1/8 px apart. Row tops drifted by up to 40.7 px, and one trace flipped 74 decisions. A Brent-Kung network mostly adds totals of similar size, and kept every decision equal to index.ts.

What this means for writing UI:

- A backend or a notation may reorder, balance and fuse every sum except at rounding points, as long as the rounding points are recorded where the backend or notation can read them. exactness-budget recovered them from compiled operations by pattern, which missed life-calendar's clamps with a scale of 128. The builder now records them: `circuit.roundingPoints()` lists every boolean atom as `'boolean'`, every operation of `emitCompare`'s integer bits as `'integer bit'`, which a backend may regroup or evaluate in float64 as long as each stays its own operation, every operation of its sign cascade as `'sign cascade'`, which also needs subnormal values, and every operation marked with `circuit.markRoundingPoint(wire)` as `'marked'`, e.g. the steps of a round chain, which the builder can't recognize by itself. Existing circuits record only their boolean atoms, e.g. 64 in IndirectOS, where exactness-budget's patterns found 256.
- Settle tests and hit tests on moving geometry need rounding points of their own, e.g. exactness-budget suggests comparing a destination change quantized to 1/64 px, so that one FP32 step of drift can't flip them.
- Pitfall: moving a statement changes creation order, and so the order in which an ordinary sum adds its terms. notation had to create the window center before the dock center, as window-manager.ts does, to compile to the identical program.

### Merging operations

Operator fusion, in ML compilers, merges several operations into one step so the values in between are never stored. The runtime already merges operations in a few places:

- Copying small sums into their readers merges an affine sum into the next operation, and a ReLU-gated product computes an affine gate, a ReLU and a product as one operation.
- [numeric-library](../../numeric-library/README.md) computes one Newton step of a reciprocal as `estimate × relu(2 - x × estimate)`, 2 operations, and one Horner step of a polynomial as 1 operation, with each gate computed inside its ReLU-gated product. That took sine and cosine from 100 operations to 34.
- Linear steps with constant coefficients merge into one matrix. [spring-bank](../../spring-bank/README.md) computes a frame's N fixed 4 ms spring steps as the constant matrix M^N read from tables, so every animated number then costs 4 products, where `emitSpring` costs 46 operations and 33 layers. IndirectOS went from 5,253 operations and 192 layers to 3,580 and 137.

A merge between rounding points only moves positions by FP32 steps. A merge across a rounding point can change decisions.

Generated JavaScript doesn't merge operations, but it removes the interpreter's cost per operation, about 90% of the executor's time for IndirectOS. That's a constant factor, and it didn't help wide circuits: the gallery's generated code was still slower than the executor after 6,000 evaluations.

## Instancing: cost per item, and in total

An instance is one item running the per-item program with its own inputs, e.g. photo 17 with photo 17's aspect ratio and spring state. Instancing writes the per-item program once and runs it over every instance. Values that are the same for every item are computed once per frame, like a shader's uniforms, i.e. shader inputs with one value for every pixel. Reductions across items, e.g. sums, counts, running totals, the first active item, argmax, maximums and reads at an index, run between the per-item programs. The [instancing](instancing.md) section covers the builder.

The duplicated circuit writes the per-item program out once per item, so its size grows with the item count. The gallery at 221 photos is 48,411 operations, and springs are 64% of them ([gallery](../../gallery/README.md)). [instanced-items](../../instanced-items/README.md) expanded its staged gallery into one duplicated circuit at 10,000 photos: 2,571,887 operations, 80 layers and 5.6 million stored weights, 4.7 s to build and compile, and about 2 GB of heap.

Written once per item, the gallery is 233 operations per photo at 221, 1,000 and 10,000 photos, and the program builds in 22 ms at 10,000 photos. The work per frame is still O(photos × 233), as it is for a shader. What stays constant is the program: its size, its build time, its memory, and its generated code.

With n items, p operations per item and s shared operations:

| | Duplicated circuit | One program per item |
| --- | --- | --- |
| program size, build time and memory | O(n × p + s) | O(p + s) |
| work per frame | O(n × p + s), plus the reductions | O(n × p + s), plus the reductions |

codegen splits any compiled program into shared and per-instance operations automatically: an operation is per-instance when it reads a per-instance source cell, directly or through other operations. life-calendar has 27,393 grid squares, and 63 of its 2,054 operations run once per square, while the other 1,991 run once for the whole grid. IndirectOS's press map runs 458 of its 574 operations per pixel.

What one program per item buys, besides a constant program size:

- A GPU can run the per-item program as one shader over all items. The gallery's per-photo stages ran bit-identical through wgpu and Dawn at 10,000 photos, though uploading and reading back each stage made that pipeline slower than the CPU executor.
- Each reduction's definition specifies one accumulation order, which both its JavaScript loop and its circuit form follow.
- Per-item decisions become local: the per-photo program compares the photo's own index with the focused index, instead of reading bits that belong to other photos.

What it costs:

- A per-item constant turns from a weight into a product. The staged gallery has about 33 more operations per photo than the hand-written circuit, mostly products for per-photo constants plus per-photo comparisons and reads, and IndirectOS grew from 5,253 to 6,282 operations when its windows, dock items and photos became instances.
- A runtime index into another list of items doesn't lower. A photo's row depends on the runtime column count, so the gallery keeps 7 arrays of rows, one per column count, and each photo's program reads the photo's row values from the array for the current column count. The staged builder was written before numeric-ui-core.ts had `circuit.indexRead`, which reads at a per-item runtime index in 1 operation, and wasn't updated.

## Choices of semantics that determine big-O

### Whether reading at an index is a primitive

numeric-ui-core.ts now has an index read instruction ([indexing](indexing.md#way-3-the-index-read-instruction)), and keeps gather lowering for selections that already exist as declared one-hots. Without an index read instruction, `table[i]` needs an O(N) one-hot per index. That makes one-hots 70% to 89% of [text-walker](../../text-walker/README.md)'s circuits at 1,023 segments. It also makes routing the comments in view into 48 DOM nodes, each showing whichever comment the circuit routes to it, cost 25,616 of [hn-thread](../../hn-thread/README.md)'s 53,703 operations, because every comment needs one bit per DOM node: O(comments × DOM nodes).

With O(1) reads, a search becomes log2 N reads. Finding the first visible row among 10,000 rows of different heights goes from 30,143 operations, one comparison per row, to 215 operations with a binary search. A filtered list of 1,000 items shown through 20 DOM nodes goes from 81,961 operations and 660,424 stored weights to 10,000 operations and 19,396 stored weights ([index-read](../../index-read/README.md)).

### How comparisons become bits

A comparison's cost is multiplied by the number of comparisons a UI makes. Every exact form costs a constant number of operations per comparison, and the form sets the constant. An integer bit, `[v >= t] = relu(v - t + 1) - relu(v - t)`, is 3 operations and 2 layers. One rounding stage, i.e. a scaled difference clamped around 0.5 and rounded with the boolean atom, is 4 operations and 3 layers when the largest possible difference is at most 2^45 times the smallest positive difference that must give 1. The sign cascade is 16 operations and 15 layers for every pair of FP32 values within 16,384; the earlier count of 26 operations and 26 layers came from the trace compiler's layout of the same cascade, which spends 3 layers per stage. The [comparisons](comparisons.md#form-3-the-sign-cascade) section explains each form. The form that numeric-ui-core.ts's `emitCompare` builds depends on declarations: integer bits in 2 operations and 2 layers when both operands are declared on a grid, and the sign cascade otherwise.

The trace compiler lowered every comparison to a sign cascade and every running total to a chain. Its slice of the gallery's 1D photo strip came out at 21,213 operations and 1,580 layers. Written by hand with 4-operation comparisons and one wide sum per running total, the same outputs are 3,399 operations in 9 layers ([gallery](../../gallery/README.md)).

Choosing among items is a comparison structure too. A tournament, which compares items in pairs, then compares the pairs' results, until one item remains, e.g. `emitArgmax`, is O(n) operations and O(log n) layers: 437 operations and 33 layers for 64 scores ([the highest score, in a tree](../patterns/highest-score-tree.md)). Counting, where an item is selected when it's below every other item, is O(n²) comparisons at constant depth: numeric-library's exact minimum of 8 values is 121 operations and 5 layers. Sorting 64 integer keys is 2,172 operations and 63 layers as a Batcher network (a fixed arrangement of compare-and-swap steps), and 20,418 operations and 6 layers as ranks by counting, with each sorted position read through a one-hot of its rank ([notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)).

### Whether per-item programs exist

As described under instancing: without per-item programs, the program is O(items × per-item operations). With them, the program is O(per-item operations + shared operations), and the work per frame is the same.

### How a frame's events are handled

IndirectOS keeps one latch per event kind, i.e. a source cell that holds the latest down, move or up until the circuit clears it. Latches are cheap but lose information: several moves in one evaluation collapse into the last one, and the order within an evaluation is fixed as down, move, up. Until September 15, 2026, IndirectOS ran one evaluation per frame, so a frame's moves collapsed. Since then host-timing.ts's `advanceFrame` runs one evaluation per distinct event timestamp, e.g. about 17 evaluations for a 60 fps drag frame with 16 coalesced moves ([lab/status.md](../../../status.md#known-issues-in-production-code)). [input](../../input/README.md) built a queue of events per evaluation instead, with a fixed number of entries:

- With the event step written out once per queue entry, input's window circuit is 10,196 operations and 281 layers at 32 events: O(events) operations and O(events) layers.
- A move only affects later events through the press point, a count, or an OR such as "moved past the drag threshold since the press". So every move can be handled at once from prefix counts, i.e. running counts of downs and ups up to each event. With at most 2 presses per evaluation, that's 2,230 operations and 55 layers at 32 events. One more queue entry costs 46 operations and no layers. One more press per evaluation costs 427 operations and 17 layers, because a press hit-tests geometry that an earlier release in the same frame may have changed.
- Keyboard focus as 13 × 13 transition matrices (tables of bits that say which focus each key event leads to), combined pairwise in a balanced tree (a parallel prefix scan), is 59,730 operations and 31 layers at 16 events, against 27,698 operations and 53 layers when the same matrices apply one event at a time. The scan saves 22 layers for about twice the work.

[event-time](../../event-time/README.md) went another way. JavaScript evaluates the program once per distinct event timestamp and writes state back only then, while display frames evaluate a copy and throw its next state away. Each commit is one whole evaluation, idle time costs nothing, and the committed tables were identical in every bit at 10 to 240 fps and through 500 ms and 2 s stalls, for events delivered in timestamp order.

### Fixed capacities

Every capacity is paid on every evaluation, whether or not it's used: queue entries per evaluation, text cells, line outputs, DOM nodes. input's window circuit with the event step written out for 16 events costs as much for an empty frame as for a full one. [text-editing](../../text-editing/README.md) costs about 210 operations per text cell, and 8 more layers per doubling of the capacity. indirect-os-2's event queue over the whole IndirectOS ([input](../../input/README.md#merged-from-indirect-os-2-september-16-2026)) cost 4,476 more operations and 78 more layers than latches. Each press session it handled per evaluation, i.e. one down with the moves and the up after it, cost about 2,200 operations and 40 layers whether or not a press arrived. Allowing one press per evaluation, with JavaScript splitting the rare frame that has two, brought the queue's cost down to 2,233 operations.

### Whether a value may be one frame late

Reading last frame's value from a source cell cuts a chain at that value, like a register in hardware, which holds a value from the previous clock tick. The delay adds no operations, but the value lags by one frame. In [retiming](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/retiming/README.md)'s measurements, Photos reading its window's content size and opacity from last frame took IndirectOS's longest chain from 191 to 116 layers, and was 88.9 px off during a maximize or restore at 60 fps. A search over such delays with retiming's critical-values strategy took the longest chain of spring-bank's IndirectOS from 136 to 123 operations, with 0 px of error on three random traces it never replayed, while the minimum-cut strategy reached the same length and failed on one of those traces (996 px, 33 mismatches). Chains with a decision at every stage, like the gallery's, lost almost no layers. The [chains](chains.md#way-4-read-last-frames-value) section covers these measurements.

## UI jobs under each choice

Operations and layers for one evaluation, from the prototypes' READMEs, this guide's examples and its pattern docs. "Dense" means masked sums without gather lowering, and "index reads" means index-read's instruction, measured in index-read's copy of the runtime, which numeric-ui-core.ts now has too. Rows from the pattern docs were measured on numeric-ui-core.ts with `emitCompare`, whose integer bits are 2 operations, while sections/loops.md's examples build each integer bit from 3.

| UI job | Choice | Operations | Layers | Growth | Source |
| --- | --- | ---: | ---: | --- | --- |
| `values[index]` over 10,000 entries | ReLU one-hot, dense | 40,002 | 5 | O(N) | index-read |
| | ReLU one-hot, gather lowering | 30,002 | 4 | O(N) | index-read |
| | index read instruction | 1 | 1 | O(1) | index-read |
| list of 10,000 rows shown through 24 DOM nodes, 3 fields per node | ReLU one-hot, dense | 750,154 | 12 | O(rows × nodes × fields) | index-read |
| | ReLU one-hot, gather lowering | 30,154 | 11 | O(rows) operations, O(rows × nodes × fields) table entries | index-read |
| | index reads | 153 | 9 | O(nodes × fields) | index-read |
| | rows of one height, row data kept in JavaScript | 280 | 19 | O(nodes) | lists |
| | rows of one height, 1 field per node in source cells, read through the first visible row's one-hot | 20,305 | 19 | O(rows) | lists |
| first visible row among 10,000 rows of different heights | count of comparisons, index reads for the nodes | 30,143 | 5 | O(N) work, constant depth | index-read |
| | binary search, index reads | 215 | 57 | O(log N) work and depth | index-read |
| filtered list, 1,000 items shown through 20 DOM nodes | count earlier visible items, one equality bit per item and node (rank slots) | 81,961 | 6 | O(items × nodes) | index-read |
| | neighbor differences of `[visible items through item <= k]`, Brent-Kung prefix counts | 49,224 | 27 | O(items × nodes) | lists |
| | the same, on numeric-ui-core.ts | 47,044 | 24 | O(items × nodes) | patterns/compaction-into-slots.md |
| | prefix counts, then a binary search per node with index reads | 10,000 | 49 | O(items log items + nodes log items) | index-read |
| | the same, on numeric-ui-core.ts | 7,824 | 57 | O(items + nodes log items) | patterns/compaction-into-slots.md |
| filtered list, 10,000 items shown through 24 DOM nodes | prefix counts, then a binary search per node with index reads | 125,324 | 69 | O(items log items + nodes log items) | index-read |
| hn-thread's comments in view, 251 comments through 48 DOM nodes, routing only | rank slots | 25,616 | | O(comments × nodes) | hn-thread |
| | window slots | 1,269 | | O(comments + nodes) | hn-thread |
| HN thread drawn per pixel, 251 comments | find the row under the pixel by counting | 1,615 per pixel | 24 per pixel | O(rows) per pixel | pixel-output |
| | binary search, index reads | 314 per pixel | 54 per pixel | O(log rows) per pixel | pixel-output |
| running totals of 1,024 heights | chain of 2-term sums | 1,023 | 1,023 | O(n) work, O(n) depth | this section |
| | one wide sum per total | 1,023 (524,799 weights) | 1 | O(n²) weights, constant depth | this section |
| | Brent-Kung network | 2,036 | 18 | O(n) work, O(log n) depth | this section |
| | Kogge-Stone network | 9,217 | 10 | O(n log n) work, O(log n) depth | this section |
| sort 64 integer keys | Batcher network | 2,172 | 63 | O(n log² n) work, O(log² n) depth | [notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) |
| | ranks by counting | 20,418 | 6 | O(n²) work, constant depth | [notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) |
| | ranks alone, with `emitCompare` bits | 4,096 | 3 | O(n²) work, constant depth | patterns/ranks-instead-of-sorting.md |
| sort 64 integer keys, carrying one payload value each | bitonic network | 10,624 | 105 | O(n log² n) work, O(log² n) depth | [notes/outside-techniques.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) |
| | ranks by counting, with gathers | 16,512 | 5 | O(n²) work, constant depth | [notes/outside-techniques.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md) |
| drag to reorder 100 cards, whole circuit | recount every card's rank each frame | 69,653 | 105 | O(n²) | lists |
| | update the layout from the one card that moves | 36,207 | 90 | O(n) | lists |
| a dragged card's next rank among 100 cards | count the cards the pointer passes, `emitCompare` bits | 1,404 | 8 | O(n) | patterns/ranks-instead-of-sorting.md |
| `[a > b]` on continuous values within 16,384 | sign cascade, every pair of FP32 values | 16 | 15 | constant | comparisons |
| | the trace compiler's layout of that cascade | 26 | 26 | constant | [notes/runtime.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) |
| | one rounding stage, 2^45 ratio | 4 | 3 | constant | numeric-library |
| gallery's 1D photo strip, 221 photos | sign cascades and chains (trace compiler) | 21,213 | 1,580 | | gallery |
| | one rounding stage per comparison, one wide sum per total | 3,399 | 9 | | gallery |
| which of 221 photos a click lands on, whole gallery circuit | tournament over hit bits | 48,411 | 61 | O(n) work, O(log n) depth | gallery |
| | prefix counts of hit bits | 48,129 (23,243 more weights) | 41 | O(n²) weights, constant depth | gallery |
| first hit among 1,024 overlapping items, hit bits in source cells | tournament (`emitFirstActive`) | 5,116 | 51 | O(n) work, O(log n) depth | sections/loops.md |
| | earlier-hit counts, wide sums | 2,046 (525,822 weights) | 2 | O(n²) weights, constant depth | sections/loops.md |
| | earlier-hit counts, Brent-Kung network | 3,050 | 19 | O(n) work, O(log n) depth | sections/loops.md |
| the gallery's column count, 1 to 7 columns | threshold count, `emitCompare` bits | 13 | 3 | O(possible counts) | patterns/threshold-counts.md |
| the gallery's column count and photo width | threshold count | 30 | 6 | O(possible counts) | gallery |
| | the trace compiler's slice of index.ts | 524 | 91 | | gallery |
| 32 pointer events per evaluation, window behaviors | event step written out per event | 10,196 | 281 | O(events) depth | input |
| | moves from prefix counts, at most 2 presses | 2,230 | 55 | O(presses) depth | input |
| 16 key events, keyboard focus | transition matrices, parallel prefix scan | 59,730 | 31 | | input |
| | the same matrices one event at a time | 27,698 | 53 | | input |
| recover 157 lines of a 1,023-segment paragraph; totals include a 190,279-operation table of where a line starting at each segment ends | one line at a time, ReLU one-hot, dense | 993,877 | 957 | O(lines × segments) beyond the table | index-read |
| | one line at a time, index reads | 191,688 | 490 | O(lines) beyond the table | index-read |
| | pointer jumping, index reads | 226,193 | 66 | O(segments × log lines) beyond the table | index-read |
| greedy line breaking of 1,023 segments into 157 line slots | the line walker, unrolled one segment at a time | 23,496 | 9,204 | O(segments) work and depth | text-walker |
| | text-walker's own next-start table, then one line slot at a time through one-hots | 457,882 | 725 | O(segments × lookahead + lines × segments) work, O(lines) depth | text-walker |
| grow and shrink with min and max, 64 children | Clay's loop, unrolled | up to 226 rounds, not built | | | layout-tree |
| | water filling, constant fit widths, whole circuit | 897 | 9 | O(n) operations, O(n²) weights | layout-tree |
| | the same, widths pass only | 784 | 9 | O(n) operations, O(n²) weights | layout-tree |
| | water filling, runtime fit widths, whole circuit | 5,750 | 13 | O(n²) work, constant depth | layout-tree |
| | the same, widths pass only | 5,601 | 12 | O(n²) work, constant depth | layout-tree |
| flex-wrap, 64 children | scan over children | 1,185 | 276 | O(n) depth | layout-tree |
| IndirectOS's springs | `emitSpring`, 4 substeps per frame | 5,253 (whole circuit) | 192 | 46 operations per animated number | spring-bank |
| | shared matrix powers | 3,580 (whole circuit) | 137 | 4 products per animated number | spring-bank |
| | `emitAnimatedObject` with the matrix written by JavaScript, in window-manager.ts since September 15, 2026 | 3,783 (whole circuit), 3,654 after the hit tests moved to `emitCompare` the same day | 128, then 124 | 128 operations per window of 5 springs, 56 per thumbnail of 2 | window-manager.ts |
| gallery at 10,000 photos | one duplicated circuit | 2,571,887 | 80 | program O(items) | instanced-items |
| | one program per photo | 233 per photo | | program O(1) | instanced-items |
| thumbnail targets, 1,024 photos | one weight per (thumbnail, focused photo) | 3,072 (1,063,936 weights) | 1 | O(n²) weights | index-read |
| | a table in cells, read per thumbnail | 3,072 (3,072 weights) | 1 | O(n) | index-read |

Some terms in the table: a parallel prefix network computes running totals as a fixed tree of pairwise additions. A Brent-Kung network uses about 2n additions in about 2 log2 n layers, and a Kogge-Stone network about n log2 n additions in log2 n layers. Pointer jumping replaces each "where does the line starting here end" pointer with its target's pointer, doubling how far each pointer reaches per round. Water filling raises one shared level until the children's sizes add up to the container, with every child clamped between its own min and max. Clay is a C layout library whose grow step distributes leftover space in a loop. A tournament picks one item by comparing items in pairs, then the pairs' results in pairs. Rank slots and window slots are hn-thread's two ways to fill a fixed number of DOM nodes: with rank slots, node k shows the (k + 1)-th visible item, found with one equality bit per item and node, and with window slots, node k shows the first visible row + k, since visible rows are contiguous. Window slots are 20 times cheaper, but rows of height 0 in view use up nodes, e.g. once a collapsed subtree has settled in view, window slots need 32 nodes where rank slots need 7. The line walker is text-walker's greedy line breaker written as arithmetic, one segment after another.

## When depth is worth trading for work

- Parallel formulations cost more work than serial ones, e.g. the Kogge-Stone running totals are 9,217 operations against the chain's 1,023. On a serial executor they buy nothing, and they pay off only on an executor that runs a layer's operations at the same time.
- One wide sum per total keeps the sequential loop's FP32 steps exactly, at n²/2 stored weights, so it flattens depth without changing results. Balanced networks change the steps.
- Depth that comes from the UI's own chain of decisions can't be removed by rewriting loops. The gallery's 61 layers are the chain from the click to the focus, the strip positions, the destinations, the scroll anchor, the scroll adjustment, the springs and occlusion, and [retiming](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/retiming)'s search found almost nothing on that chain that could be one frame late. The [chains](chains.md) section covers the ways to shorten repeated steps.

## Pitfalls

- Count stored weights, not only operations: O(n²) often shows only in stored weights.
- Test growth at a realistic item count. At 3 items a shared sum and a copied sum compile identically.
- `evaluateTensor` compiles every built operation and fills an array as wide as every built operation. Measure with `compileTensorProgram(roots)` and evaluate with `createTensorEvaluator(roots)`, using the roots JavaScript reads.
- Declare ranges before building the operations that read them; a later declaration doesn't change products already built.
- Put known numbers into coefficients, not into constant values passed to `multiply`, `select`, `roundAffine`, `emitMinimum` or `emitMaximum`, where constant folding can't reach them.
- The order in which wires are created is the order in which ordinary sums add their terms.
- A lowered read keeps the depth of the products it replaced, unless the program is compiled with `{recomputeDepths: true}`.
- Capacities cost the same when unused, and every source cell costs a range check on every evaluation.
- The builder records boolean atoms and `emitCompare`'s operations as rounding points, but not a round chain unless each step is marked with `circuit.markRoundingPoint`, so a backend that reorders or fuses sums has no record that those steps must keep the stored order.

## Files

From the repo root:

- `bun test lab/ui-exploration/guide/examples/executor` runs every check quoted above.
- `bunx tsgo -p lab/ui-exploration/guide/examples/executor` typechecks the folder.
- `bun lab/ui-exploration/guide/examples/executor/report.ts` prints every size quoted above, including the close button's layers and matrices.

| File | What it holds |
| --- | --- |
| [anatomy.ts](../examples/executor/anatomy.ts) | the close button hit test built two ways, and `describeProgram`, which prints a compiled program layer by layer |
| [stats.ts](../examples/executor/stats.ts) | `measureProgram` (operations, layers, stored weights, layer widths, gather reads, table entries) and `evaluateCompiled` |
| [builder-steps.ts](../examples/executor/builder-steps.ts) | ranks from known widths and from cells, `velocity × timestep` with the range declared before and after the product, and a known timestep as a coefficient and as a constant value |
| [shared-sum.ts](../examples/executor/shared-sum.ts) | a total read by every item, shared and copied, with FP32 references |
| [masked-read.ts](../examples/executor/masked-read.ts) | `rowTops[selectedIndex]` with the selection as an integer index and as stored bits |
| [prefix-sums.ts](../examples/executor/prefix-sums.ts) | running totals as a chain, as wide sums, as a chain of ordinary affine sums, and as Brent-Kung and Kogge-Stone networks |
| [sum-order.ts](../examples/executor/sum-order.ts) | stored, reversed, balanced and fused addition, two term orders, a difference, and round in FP32 and float64 |
| [executor.test.ts](../examples/executor/executor.test.ts) | each circuit against plain JavaScript, and the sizes quoted above |
| [report.ts](../examples/executor/report.ts) | the report |
