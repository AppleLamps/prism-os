# Reading at a computed index, differentiation, and attention

This section explains how a circuit reads `table[index]` when the index is computed while the UI runs, what each way of reading costs, whether a read is differentiable, and how the reads that are differentiable in the index become soft and hard attention. It ends with two small learning experiments and what they suggest.

Every example lives in [examples/indexing](../examples/indexing/). `bun test lab/ui-exploration/guide/examples/indexing` checks each circuit against plain JavaScript (16 tests, about 0.3 s), and `bun lab/ui-exploration/guide/examples/indexing/report.ts` prints every count and toy result that this section quotes from those examples (about 1 s). Numbers about larger workloads come from the final text of [index-read's README](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/index-read/README.md), whose list and line recovery numbers are now in [lists](../../lists/README.md#merged-from-index-read-september-16-2026) and [text-walker](../../text-walker/README.md#merged-from-index-read-september-16-2026), and [lab/gather-lowering/README.md](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/gather-lowering/README.md).

## Short answers

**Is reading at an index differentiable?** With respect to the table's values, yes: the entry that was read gets the output's gradient, and every other entry gets 0. ML frameworks differentiate `gather`, their read at given positions, the same way. With respect to the index, no: a hard read is a step function of the index, so its derivative is 0 between whole numbers and doesn't exist at them.

**Can a read be made differentiable in the index?** Yes, by reading softly while training: linear interpolation between the two neighboring entries, or a softmax over scores for every position. Linear interpolation only involves two entries, and costs a constant number of operations per read with an index read instruction. A softmax involves every entry, for O(n) operations per read. In an 8-entry toy, gradient descent with a softmax read that started wide and then sharpened moved a query index onto the entry holding a target id from every starting position tried, and a hard read could then replace the soft read. With a read that was sharp from the start, the query didn't move.

**Is this attention?** A hard read at a computed index is hard attention whose keys are the table's positions. With the parabola keys from [hard-attend.ts](../../../hard-attend/hard-attend.ts), "position equals query" becomes a dot-product score. A softmax over those scores is soft attention, and taking the highest score is hard attention. In a second toy, gradient descent through a soft read learned the three weights that compute a query from a flick's release position and velocity, and with those weights an exact argmax circuit picked the same carousel page as plain JavaScript on 10,895 of 10,976 releases. But a plain squared error on the query, with no read, learned nearly the same weights, and nothing here learned keys or stacked several reads, which is what a transformer's attention adds.

## Terms used in this section

The [glossary](../README.md#glossary) defines live operations, layers, depth and stored weights. A few more terms appear below:

- **FP32** is the 32-bit float format of `Float32Array`. The runtime rounds to FP32 after every addition and product, like `Math.fround`, so integers up to 2^24 stay exact.
- **ReLU** is `relu(v) = max(0, v)`. `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)` computes `(leftTerms + leftBias) × max(0, gateTerms + gateBias)`, a **ReLU-gated product**. E.g. `circuit.reglu([], 1, [[rowIndex, 1]], -3)` is `relu(rowIndex - 3)`.
- `circuit.roundAffine(terms, bias)` is an affine sum kept as its own operation. The builder copies the terms of small ordinary affine sums into every sum that reads them; `roundAffine` stops that, so every operation that reads the sum gets the same rounded FP32 value.
- A **declared range**, `circuit.assumeRange(wire, minimum, maximum)`, is a declaration that a value stays within a range. The builder uses it, e.g. a product whose operand is declared nonnegative costs 1 operation instead of 3.
- A **boolean atom**, `circuit.boolean(score)`, rounds a score within 0..1 to exactly 0 or 1 with FP32 rounding. `emitArgmax` uses one per comparison.

## The problem in UI terms

UI code reads arrays at positions that change every frame. E.g. a virtualized list reads `rowTops[firstVisibleRow + k]` for the k-th row element it draws, a photo strip reads the focused photo's left edge at `focusedIndex`, and a line walker reads `nextLineStart[currentStart]`. In JavaScript each of these is one array access.

A circuit has no array access. Every operation reads wires that were chosen when the circuit was built, so the choice of entry has to come from arithmetic on the index. The three ways below differ in where that arithmetic happens: inside the circuit (a one-hot masked sum), inside the compiler (gather lowering), or inside an instruction of its own (`circuit.indexRead` in numeric-ui-core.ts, which index-read built first).

## Way 1: a one-hot masked sum

A **one-hot** is a list of bits in which exactly one bit is 1, e.g. `[0, 0, 0, 1, 0, 0, 0, 0]` names position 3. A **masked sum** multiplies each table entry by its bit and adds up the products, so the sum equals the entry whose bit is 1. Written as a JavaScript loop:

```ts
let rowHeight = 0
for (let position = 0; position < rowHeights.length; position++) {
  const bit = position === rowIndex ? 1 : 0
  rowHeight += bit * rowHeights[position]
}
```

The circuit needs `position === rowIndex` as arithmetic. For a whole-number index, a difference of two ReLUs is a step: `relu(rowIndex - j + 1) - relu(rowIndex - j)` is 1 when `rowIndex >= j` and 0 when `rowIndex <= j - 1`. Writing `[condition]` for 1 when the condition holds and 0 otherwise, subtracting neighboring steps leaves a 1 only at `rowIndex`: `bit[j] = [rowIndex >= j] - [rowIndex >= j + 1]`. E.g. at rowIndex 3 over 8 entries, the steps `[rowIndex >= j]` for j = 1 to 7 are 1, 1, 1, 0, 0, 0, 0, and the bits for positions 0 to 7 are 0, 0, 0, 1, 0, 0, 0, 0. Fixing `[rowIndex >= 0] = 1` and `[rowIndex >= 8] = 0` makes an index below the table select the first entry, and an index above the table select the last entry.

From [one-hot-read.ts](../examples/indexing/one-hot-read.ts), shortened:

```ts
// Inside emitTentWeights, for j = 1..count-1:
const upper = circuit.reglu([], 1, [[rowIndex, 1]], 1 - j) // relu(rowIndex - j + 1)
const lower = circuit.reglu([], 1, [[rowIndex, 1]], -j)    // relu(rowIndex - j)
const atLeastJ = circuit.roundAffine([[upper, 1], [lower, -1]]) // [rowIndex >= j]
// ...then bit[j] = [rowIndex >= j] - [rowIndex >= j + 1], each as its own roundAffine.

// emitMaskedSum:
const rowHeight = circuit.roundAffine(bits.map((bit, j) =>
  [circuit.multiply(bit, rowHeights[j]!), 1] as const))
```

**Why it works.** For a whole-number index, every bit is exactly 0 or 1. Each unselected product is `fround(entry × 0)`, which is +0 or -0 for any finite entry, and adding a zero doesn't change an FP32 sum. So the sum equals the selected entry, bit for bit.

**Cost.** O(n) operations for a table of n entries, at constant depth. The example builds n ReLUs (the lower ReLU of one step is the upper ReLU of the next, and the builder merges identical operations), n - 1 steps, n bits, n products and one sum: 4n operations, 5 layers and 8n - 4 stored weights. Measured at 64 entries: 256 operations, 5 layers and 508 stored weights. Another table read at the same index reuses the bits and adds n products and one sum. index-read measured its own version at 10,000 entries: 40,002 operations, 79,998 stored weights, and about 244 µs per evaluation, a rough timing on a machine shared with other agents.

**When not to use it.** For reading at a whole-number index over a large table, ways 2 and 3 cost less. The masked sum is the natural form when the selection already exists as bits, e.g. the one-hot that `emitArgmax` produces, or HandwiredOS's window stacking order, which window-manager.ts keeps as one-hot rows and columns.

**Pitfalls.**

- An entry that may be `Infinity` breaks the sum. `Infinity × 0` is NaN, and the NaN spreads through the sum even though that entry wasn't selected.
- A fractional index doesn't select one entry. Between j and j + 1 the bits become `1 - fraction` and `fraction`, so the read interpolates between two entries. That's useful for the differentiable reads below, but wrong where a hard read was intended.
- Keep each step and bit as its own `roundAffine`. Exact bits stop being exact once the builder copies their ReLU terms into a sum with large values ([comparisons](comparisons.md#form-1-integer-bits) has the measured failures).

## Way 2: gather lowering in the compiler

A **gather** reads entries at given positions, e.g. `table[indices]` in NumPy or `torch.gather` in PyTorch. The runtime in src/runtime/ turns a masked sum into a gather when the circuit declares its bits as a one-hot:

```ts
circuit.assumeOneHot(bits) // declares that every bit is exactly 0 or 1, and exactly one is 1
const program = circuit.compileTensorProgram([rowHeight])
```

`compileTensorProgram` looks for affine sums whose terms are products of a declared group's bits with value wires, where every position appears exactly once and every value has a finite declared range. It replaces each such sum with a read that stores no weights. Once per evaluation, for each group, the executor computes the selected position from the bits, and then each read copies one value. `applyGathers` in numeric-ui-core.ts does this:

```ts
let selectedPosition = 0
for (let position = 0; position < bitValues.length; position++) selectedPosition += position * bitValues[position]
const rowHeight = candidateValues[selectedPosition]
```

**Why it works.** The masked sum already equals the selected entry exactly (way 1), and `Σ position × bit` over exact bits is an exact whole number, so copying that entry gives the same FP32 value. Products that nothing else reads drop out of the compiled program.

**Cost.** The n products and the sum disappear, so each read does O(1) work and stores 0 weights, plus a table of n integer positions. The bits still cost O(n) operations, and computing the selected position is O(n) work per group per evaluation, shared by every read over that group. Measured at 64 entries: 192 operations, 4 layers, 316 stored weights and 1 gather read, against 256 operations, 5 layers and 508 stored weights without lowering. At 10,000 entries (index-read): 30,002 operations, 49,998 stored weights, 10,000 integer table entries, about 150 µs. Root gather-lowering.test.ts checks that stored weights per read go from exactly 3n to 0, and that window-manager.ts lowers 908 reads, 12 over its stacking one-hots and the rest over the Notes flow's line groups.

**When it doesn't apply.** Recognition is tied to the exact shape. A sum with any other term, a coefficient other than ±1, a sum over only some of the positions, or a value whose declared range allows Infinity stays dense.

**Pitfalls.**

- The compiler relies on the declaration, and nothing checks the declaration during evaluation. With a fractional index the bits aren't a one-hot, and the two evaluators give different values. At index 2.5 over rowHeights [28, 44, 28, 60, 36, 28, 52, 40], the reference evaluator returns 44 (half of 28 plus half of 60), while the compiled program returns 28: the executor stores `Σ position × bit = 2.5` in an `Int32Array`, which truncates it to 2. `validateOneHotGroups(circuit, values)` checks the declaration in tests.
- The bits are still built. index-read added a compile pass (`lowerIndexOneHots`) that recognizes bits built from ReLU differences of one index wire and computes the position from that wire, which brought `values[index]` over 10,000 entries to 1 operation. But the builder still constructs the one-hot before the compiler removes it: 52 ms to build at 10,000 entries, against 1 ms for the instruction below. numeric-ui-core.ts added the instruction and not this pass.

## Way 3: the index read instruction

[index-read](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/index-read) added a fourth instruction to its copy of the runtime, and on September 14, 2026 Cheng decided to add it to the repo root runtime, numeric-ui-core.ts ([decision 1](../review-and-decisions.md#1-should-the-shared-runtime-get-an-index-read-instruction)). `circuit.indexRead(index, candidates, {outOfRange})` returns `candidates[floor(index)]`. Outside the table it returns the nearest end, or +0 with `{outOfRange: 'zero'}`. `circuit.indexReadAffine(indexTerms, indexBias, candidates, below, above, {indexRange})` takes the index as an affine form, with one rule per side. From [shared-runtime-index-read.ts](../examples/indexing/shared-runtime-index-read.ts), shortened:

```ts
import {Circuit} from '../../../../../src/runtime/numeric-ui-core.ts'

circuit.assumeRange(rowIndex, -4, count + 4) // without a declared range, the builder throws
const rowHeight = circuit.indexRead(rowIndex, rowHeights)

// A virtualized list: DOM slot k shows row firstVisibleRow + k, and reads +0 past the last row.
circuit.assumeRange(firstVisibleRow, 0, rowCount - 1)
const slotTops = Array.from({length: slotCount}, (_, slot) =>
  circuit.indexReadAffine([[firstVisibleRow, 1]], slot, rowTops, 'clamp', 'zero'))
```

[execution-model.md](../../../../docs/execution-model.md#index-reads) has the contract: which declared index ranges the builder accepts, why the index must hold an integer, which `validateIndexReads(circuit, values)` checks in tests, how `-0`, infinities and NaN come through, and which reads count as proven bits for `emitFirstActive`.

[index-read-instruction.ts](../examples/indexing/index-read-instruction.ts) builds the first read and the linear interpolation below over index-read's copy of the runtime, which moved into [pixel-output](../../pixel-output/numeric-ui-core.ts) when [index-read](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/index-read) was removed on September 16, 2026, and [shared-runtime-index-read.test.ts](../examples/indexing/shared-runtime-index-read.test.ts) checks that both runtimes return the same values with the same counts.

In the compiled program, the layer's sparse matrix multiplication computes the index form like any affine sum. Then the executor floors that value in float64 and copies the chosen candidate's FP32 value. When the candidates sit at evenly spaced positions in the executor's value array, e.g. a run of source table cells, the read stores a base position and a stride instead of a list of positions, e.g. the virtualized list above stores no positions over 10,000 row tops.

**Why it gives the same value as ways 1 and 2.** For an exact whole-number index, floor changes nothing and the one-hot selects the same entry. The copied value isn't rounded, so integers and bits read through a table stay exact.

**Cost.** 1 operation, 1 layer, 1 stored weight (the index form) and O(1) work per read, at any table size. Measured 1, 1 and 1 at 8, 64 and 1,024 entries, in both runtimes, and the virtualized list above is 24 operations in 1 layer for 24 DOM slots over 10,000 rows. index-read's workloads ([lists](../../lists/README.md#merged-from-index-read-september-16-2026), [text-walker](../../text-walker/README.md#merged-from-index-read-september-16-2026)) show what that changes: filling 24 row elements from a 10,000-row list takes 153 operations and 9 layers (750,154 operations with dense one-hots), and recovering every line start of a 1,023-segment paragraph from pretext's next-start table takes 1,409 operations beyond the table, against 483,399 with gather lowering. A read that costs O(1) also makes binary search practical, as log2(n) reads, comparisons and additions: the first visible row among 10,000 rows of different heights takes 215 operations and 57 layers, against 30,143 operations for counting rows ([loops](loops.md#1-count-instead-of-search) explains counting).

**Pitfalls.**

- The index has to hold an exact whole number for the read to mean what the one-hot means. `validateIndexReads(circuit, values)` checks that in tests. Computing the index needs care: `floor(fround(1 / rowHeight) × scrollTop)` misses at least one row for 74 of the 512 integer row heights from 1 to 512, e.g. height 41 at scrollTop 41 gives row 0. numeric-library's [`emitFloorDivide`](../../numeric-library/README.md#merged-from-index-read-september-16-2026), from index-read, corrects the rounded quotient with the sign of the exact remainder, for 8 operations and 7 layers.
- The instruction and the masked sum differ on purpose in three cases. With a fractional index, the instruction floors and the masked sum interpolates, e.g. 28 and 44 at index 2.5 over rowHeights. With an infinite candidate, the instruction returns the selected value and the masked sum returns NaN. With a selected `-0`, the instruction returns `-0` and the masked sum returns `+0`.
- A table whose candidates aren't evenly spaced stores n integer positions, which numeric-ui-core.ts shares between every read of the same table. index-read's pointer jumping ([text-walker](../../text-walker/README.md#merged-from-index-read-september-16-2026)) first stored 1,854,682 table entries at 1,023 segments, because every read whose candidates reached the end of the text also included the past-the-end entry as a constant. Dropping that entry, and clamping the index to the last segment instead, brought the count to 0.
- There's no matching write. Setting `table[i] = value` for the next frame still takes one select per cell.
- Reading doesn't shorten walks that read one position after another. Line recovery still takes about 3 layers per line: 490 layers for 157 lines.

## The three ways side by side

For a table of n entries:

| way | operations | layers | stored weights | work per evaluation | at 64 entries (this folder) | at 10,000 entries (index-read) |
| --- | --- | --- | --- | --- | --- | --- |
| one-hot masked sum | O(n) per table, plus n + 1 per extra read at the same index | constant (5) | O(n) | O(n) | 256 operations, 5 layers, 508 weights | 40,002 operations, 79,998 weights |
| gather lowering | O(n) for the bits, 1 per read | constant (4) | O(n) for the bits, 0 per read | O(n) per group, O(1) per read | 192 operations, 4 layers, 316 weights | 30,002 operations, 49,998 weights |
| index read instruction | 1 per read | 1 | 1 per read | O(1) per read | 1 operation, 1 layer, 1 weight | 1 operation, 1 layer, 1 weight |

## Is a read differentiable?

The **gradient** of an output with respect to a wire is how much the output changes per unit change of that wire. A **backward pass** computes the gradients of an output with respect to every wire by applying the chain rule from the last operation to the first. `Circuit.backpropagateReference(values, outputGradients)` uses the real-number derivative of each operation at the FP32 values the forward pass computed, and takes a ReLU's slope at its corner, where the gate is exactly 0, to be 0. It throws on a boolean atom unless the caller passes `{booleanGradient: 'straight-through'}`:

```ts
const values = circuit.evaluateReference(source)
const outputGradients = new Float32Array(values.length)
outputGradients[rowHeight] = 1
const gradients = circuit.backpropagateReference(values, outputGradients)
// gradients[wire] is d rowHeight / d wire, e.g. gradients[rowIndex] or gradients[rowHeights[3]]
```

A **finite difference** checks a gradient without the backward pass: evaluate the output at two nearby inputs and divide the change by their distance, e.g. the central difference `(read(index + 0.01) - read(index - 0.01)) / 0.02`.

### With respect to the table values

The entry that was read gets the output's gradient, and every other entry gets 0. In JavaScript, the backward pass of `rowHeight = rowHeights[rowIndex]` is `rowHeightsGradient[rowIndex] += rowHeightGradient`. ML frameworks implement the backward pass of a gather the same way, as a **scatter-add**: adding gradients into the positions that were read, so two reads of the same entry add their gradients. All three ways do this. In the masked sum, the product `bit × entry` has derivative `bit` with respect to the entry, and the backward pass of an index read adds the output's gradient to the selected candidate.

So a table of values can be learned through any read, e.g. per-row constants read at a computed row. The test checks this at every whole-number index of the 8-entry example: the gradient over the table is the one-hot of the index.

### With respect to the index

A hard read is a step function of the index. Between two whole numbers the output doesn't change, so the derivative is 0. At a whole number the output jumps, so there's no derivative. Over rowHeights [28, 44, 28, 60, ...], reading at 3, 3.4 and 3.9 all return 60, and reading at 2.99 returns 28.

For an index read, `backpropagateReference` in numeric-ui-core.ts, like index-read's copy in pixel-output, makes the caller choose what the index gets with its `indexGradient` option:

- `'reject'`, the default, throws, like the backward pass does for a boolean atom, so a training loop can't silently receive zeros.
- `'zero'` reports 0, which is the true derivative between whole numbers.
- `'backward-difference'` reports `read(i) - read(i - 1)` at `i = floor(index)`, e.g. 60 - 28 = 32 at rowIndex 3.

`'backward-difference'` exists because it's exactly what the backward pass gives the ReLU one-hot of way 1 at a whole-number index. At rowIndex 3, the step `[rowIndex >= 3]` has an upper ReLU `relu(rowIndex - 2)` with slope 1 and a lower ReLU `relu(rowIndex - 3)` at its corner, where the backward pass uses slope 0, so that step gets gradient 1. Every other step's two ReLUs have the same slope, so their gradients cancel. Bit 3 then gets +1 and bit 2 gets -1, and the read's gradient is entry 3 minus entry 2. index-read's tests, and tests/runtime/index-read.test.ts, compare the instruction with both one-hot styles on every source wire at every whole-number index from -3 to count + 2. This folder's tests check the one-hot read against `clampedRead(rowIndex) - clampedRead(rowIndex - 1)` at every index of the 8-entry table, and numeric-ui-core.ts's `'backward-difference'` against the one-hot read's gradient at every index from -3 to 10. It's a finite difference between two neighboring whole numbers, not a derivative of anything the forward pass computes.

## Reads that are differentiable in the index

To learn where to read, the read has to change smoothly as the index changes. There are two established ways: interpolate between neighboring entries, or weight every entry by a smooth function of a score.

### Linear interpolation

**The problem in UI terms.** E.g. sampling an easing curve stored as 16 entries at a fractional position, or a row's top at a fractional row index. GPU texture sampling with linear filtering does the same between neighboring texels, and spatial transformer networks (Jaderberg et al., 2015) sample images the same way so that image coordinates get gradients.

**The familiar JavaScript way:**

```ts
function linearRead(table: number[], index: number) {
  const lowerPosition = Math.floor(index)
  const fraction = index - lowerPosition
  return table[lowerPosition] * (1 - fraction) + table[lowerPosition + 1] * fraction
}
```

**First circuit form: way 1's wires without the declaration.** The ReLU-difference bits already interpolate. For an index between j and j + 1, `[index >= j + 1] = index - j = fraction`, so bit j is `1 - fraction`, bit j + 1 is `fraction`, and every other bit is 0. In general `bit[j] = relu(1 - |index - j|)`, a **tent function** centered on position j: 1 at j, falling linearly to 0 at j - 1 and j + 1. Neighboring tents add up to 1 at every index inside the table, so the weights need no normalization. [linear-read.ts](../examples/indexing/linear-read.ts) is `buildOneHotRead(count, {declareOneHot: false})`. Without the declaration, the compiler keeps the masked sum dense, and the compiled program interpolates exactly like the reference evaluator: 0 mismatching wires at index 2.5, where the read is 44.

Gradients: with respect to the index, the slope between the two neighbors, e.g. -24 at index 3.7, between 60 and 36; with respect to the entries, `1 - fraction` and `fraction`. At a whole number the read has a corner, and the backward pass reports the slope on the left side, e.g. 16 at index 1 (from 28 to 44), because each ReLU at its corner gets slope 0. At index 0 it reports 0. The test checks 6 fractional indices: the backward pass gives exactly the slope, and a central difference with step 0.01 is within 1e-3 of that slope.

Cost: the same as way 1, O(n) operations in 5 layers (256 operations and 508 stored weights at 64 entries). Gather lowering doesn't apply, because the weights aren't a one-hot.

**Second circuit form: three index reads.** With the instruction, interpolation costs a constant number of operations per read. From `buildLinearReadFromIndexReads` in [index-read-instruction.ts](../examples/indexing/index-read-instruction.ts), over pixel-output's copy of index-read's runtime:

```ts
const clampedIndex = circuit.roundAffine([ // min(max(index, 0), last)
  [circuit.reglu([], 1, [[index, 1]], 0), 1],
  [circuit.reglu([], 1, [[index, 1]], -last), -1],
])
const positions = Array.from({length: last}, (_, position) => circuit.affine([], position)) // 0..last-1
const lowerPosition = circuit.indexRead(clampedIndex, positions) // floor(clampedIndex), at most last - 1
const fraction = circuit.roundAffine([[clampedIndex, 1], [lowerPosition, -1]])
const lowerValue = circuit.indexRead(clampedIndex, table.slice(0, last))
const upperValue = circuit.indexRead(clampedIndex, table.slice(1))
const difference = circuit.roundAffine([[upperValue, 1], [lowerValue, -1]])
const read = circuit.roundAffine([[lowerValue, 1], [circuit.multiply(fraction, difference), 1]])
```

Reading a table that holds 0, 1, 2, ... returns `floor(index)` as a wire. Because that table stops at `last - 1`, `fraction` is 1 at the last position. With `{indexGradient: 'zero'}`, the three reads add nothing to the index's gradient, and the index gets `difference` through `fraction`, which is the slope between the neighbors. At the whole numbers from 1 to `last - 1`, this form reports the slope on the right side, e.g. -16 at index 1 (from 44 to 28). At the last position it reports the slope on the left side, because the positions table stops at `last - 1`, and at index 0 it reports 0, because the clamp's ReLU sits at its corner.

Cost: 10 operations, 6 layers and 15 stored weights per read at any table size, plus one constant per position with no stored weights, which every read over the same table shares. Measured: 17, 73 and 1,033 operations at 8, 64 and 1,024 entries.

**Pitfalls.**

- Where floor comes from determines the gradient. A floor built from rounding affine sums, e.g. numeric-library's `emitRound`, gets slope 1 in the backward pass, so `index - floor(index)` gets slope 0 and the index's gradient disappears. numeric-library's `emitFloor` contains a boolean atom, which the backward pass rejects.
- With `'backward-difference'`, the read of the positions table adds a second, wrong term to the index's gradient, so this form needs `'zero'`.
- Linear interpolation only involves two entries. When both neighbors are equally bad, the slope is 0 and descent doesn't move the index (see toy 1 below).
- A loss on the interpolated value can be satisfied by a blend of two entries that don't hold the target (see toy 1 below).

### Soft attention

**Attention** scores every stored key against a query, turns the scores into weights, and returns the weighted sum of the stored values. **Soft attention** turns scores into weights with **softmax**, `weight[j] = exp(score[j]) / Σ exp(score[k])`, so the weights are positive and add up to 1. Multiplying every score by a **sharpness** concentrates the weights on the highest score; ML write-ups often call 1 / sharpness the temperature.

**Parabola keys.** To attend to "the position that equals the query", give position j the key `(2j, -j²)` and give the query the vector `(query, 1)`. Their dot product is `score[j] = 2 × query × j - j² = query² - (query - j)²`, which is largest at the position nearest the query. hard-attend.ts is a DOM walkthrough of this trick, not a circuit: a query slider and a sharpness slider over three items, showing each item's key and score, the one-hot of the highest score, and the softmax weights. Subtracting `query²` from every score doesn't change the softmax, and it turns every exponent into `-sharpness × (query - j)²`. So the weights are a Gaussian bump centered on the query: a soft read at a fractional index.

**The familiar JavaScript way:**

```ts
const exponentials = table.map((_, j) => Math.exp(sharpness * (2 * query * j - j * j - query * query)))
const total = exponentials.reduce((sum, exponential) => sum + exponential, 0)
const read = exponentials.reduce((sum, exponential, j) => sum + exponential / total * table[j], 0)
```

**The circuit way**, from [soft-attention.ts](../examples/indexing/soft-attention.ts), shortened:

```ts
const querySquared = circuit.multiply(query, query)
const exponentials = table.map((_, j) => {
  const score = circuit.affine([[query, 2 * j]], -j * j)                // query · key
  const shiftedScore = circuit.affine([[score, 1], [querySquared, -1]]) // -(query - j)²
  const exponent = circuit.multiply(sharpness, shiftedScore)
  const aboveFloor = circuit.reglu([], 1, [[exponent, 1]], 16)          // relu(exponent + 16)
  const flooredExponent = circuit.affine([[aboveFloor, 1]], -16)        // max(exponent, -16)
  circuit.assumeRange(flooredExponent, -16, 1)
  return emitExp(circuit, flooredExponent)                              // from numeric-library
})
const total = circuit.roundAffine(exponentials.map(exponential => [exponential, 1] as const))
circuit.assumeRange(total, 0.25, 4)
const reciprocal = emitReciprocalWithoutBits(circuit, total, 0.25, 4)
const read = circuit.roundAffine(exponentials.map((exponential, j) =>
  [circuit.multiply(circuit.multiply(exponential, reciprocal), table[j]!), 1] as const))
```

**Why it works.**

- With constant keys, each score is an affine function of the query, so a score costs no operation of its own.
- numeric-library's `emitExp(x)` computes `exp(x / 2^k)` with a degree-8 **Taylor polynomial**, the first terms of exp's power series `1 + y + y²/2 + ... + y^8/8!`. It evaluates the polynomial with **Horner's rule**, which rewrites it as `1 + y(1 + y/2(1 + y/3(...)))`, so each step is one ReLU-gated product whose gate stays positive. Then it squares the result k times, since `exp(x) = exp(x / 2^k)^(2^k)`. Its domain is -16..16, hence the floor at -16. `exp(-16)` is about 1.1e-7, which stands in for 0.
- The reciprocal uses **Newton's method**: a guess `estimate` of `1 / total` is refined with `estimate × (2 - total × estimate)`, which squares the relative error at each step. The example starts from one constant guess and takes 8 steps, enough for totals from 0.25 to 4. numeric-library's `emitReciprocal` starts from a better guess chosen with threshold bits, but those bits are boolean atoms, which the backward pass rejects.
- Every operation is an affine sum or a ReLU-gated product, so `backpropagateReference` differentiates the whole read with no options. Differentiating Newton's steps gives the derivative of `1 / total` along with its value, once the steps have converged.

**Accuracy.** Over rowHeights [28, 44, 28, 60, 36, 28, 52, 40], sharpness 0.25, 0.5, 1, 2, 4 and 8, and every query from 0 to 7 in steps of 1/8, the circuit's read was within 1.87e-5 of a float64 softmax with the same floor, its query gradient within 1.04e-4 of the derivative, and its sharpness gradient within 2.79e-5. The sum of the exponentials stayed within 0.2707..3.5312, inside its declared range. At query 2.3 and sharpness 1, the query gradient was 12.0144, the derivative 12.0144, and a central difference with step 0.01 gave 12.0127.

**Cost.** O(n) operations and O(n) work per read, at constant depth. Each position takes 17 operations (the shifted score, the exponent, the floor, 12 for exp, the weight and the weighted entry), and 18 more are shared (the query squared, the sum, 15 for the reciprocal and the final sum). Measured: 154 operations, 35 layers and 310 stored weights at 8 positions; 1,106 operations, 35 layers and 2,270 stored weights at 64. The 35 layers come from exp and the reciprocal, not from the table size.

**When not to use it.** In the circuit a UI runs every frame, a soft read costs O(n) operations against 1 for the instruction, and it blends entries. It belongs in training, or in outputs that are meant to blend.

**Pitfalls.**

- The Newton steps rely on the sum's declared range. For query in 0..count-1 and sharpness in 0.25..8, the smallest sum is about 2 × exp(-2) = 0.27, at sharpness 8 with the query halfway between two positions, and the largest is below sqrt(pi / 0.25) = 3.54, at sharpness 0.25. The test checks the range on every sampled state. A wider sharpness range needs a wider declared range and more Newton steps.
- Exponents below the floor get gradient 0, and those far entries still keep a weight of about 1.1e-7 each in the forward read.
- A soft read is a blend. A loss on the blended value can be satisfied by entries that aren't the target. Compare each entry with the target first, then average (see toy 1 below).
- If exp isn't available, weights can come from ReLUs instead. The tent weights of linear interpolation are ReLU weights that already add up to 1, at the price of only involving two entries. Wider ReLU weights, `relu(score[j] - threshold)`, add up to 1 only for the right threshold, or after dividing by their sum. E.g. sparsemax (Martins and Astudillo, 2016) computes that threshold from the sorted scores. None of these were measured here.

### Hard attention as the limit

As the sharpness grows, the softmax weights approach the one-hot of the highest score. At query 2.25 over 8 positions, the weight on position 2 is 0.53001 at sharpness 1, 0.98201 at sharpness 8, and 0.99996 at sharpness 64 (float64). **Hard attention** skips the softmax and computes that one-hot directly with **argmax**, the position of the highest score.

[hard-attention.ts](../examples/indexing/hard-attention.ts) uses the same parabola scores, shifted into 0..1 and scaled by a power of two so the scaling is exact, and `emitArgmax` from the runtime in src/runtime/:

```ts
const scoreOffset = (count - 1) ** 2
const scale = 2 ** -Math.ceil(Math.log2(2 * scoreOffset))
const scores = table.map((_, j) => circuit.roundAffine([[query, 2 * j * scale]], (scoreOffset - j * j) * scale))
const {selected} = emitArgmax(circuit, scores, unit) // unit is a wire that holds 1
const read = emitMaskedSum(circuit, selected, table)
```

`emitArgmax` compares the scores in pairs, then compares the larger score of each pair, and so on until one remains (a **tournament**). It routes a 1 back down the path of the highest score and declares the result as a one-hot, so the masked sum lowers to a gather. Over the 8-entry table, at every query on a 1/64 grid from 0 to 7, the read equals the entry at the nearest position, with ties going to the lower position, and 0 mismatching wires between the evaluators. Note the rounding: with parabola keys, hard attention reads the nearest position, while `indexRead` reads `floor(index)`.

**Cost.** O(n) operations in O(log n) layers: 55 operations, 17 layers, 93 stored weights and 1 gather read at 8 positions, and 503 operations, 35 layers and 909 stored weights at 64. Reading at the nearest whole-number position costs a rounding step (2 operations with numeric-library's `emitRound`) plus 1 index read, so a tournament over evenly spaced position keys is rarely worth its cost. A tournament is useful when the keys aren't evenly spaced positions, e.g. snap targets at different distances apart, or keys that are runtime values (next). The pattern doc [the highest score, in a tree](../patterns/highest-score-tree.md) compares `emitArgmax` with exact trees built on `emitCompare`, including where `emitArgmax`'s tie band makes its tree pick a different candidate from a loop.

**No gradient.** The tournament's comparisons are boolean atoms, and `backpropagateReference` throws on them. With `{booleanGradient: 'straight-through'}`, a boolean passes its gradient to its score unchanged. drag-knobs found that this is only right where a boolean's score saturates, i.e. sits flat at 0 or 1, and `emitArgmax`'s comparison score, about `0.5 × (left - right) + 0.5`, doesn't saturate. So straight-through gives slopes that aren't there: on candidate-gallery (a demo in lab/candidate-gallery that scores three candidate layouts and shows the best one), at the smallest step size, 592 of 2,250 gradients of an edge with respect to a design constant differed from finite differences while no recorded decision flipped. With booleans given slope 0 instead, all 2,250 matched. Either way, the query gets no useful gradient through argmax, so training needs the soft version.

### Keys that are runtime values

**The problem in UI terms.** Snap a released card to the nearest of n snap positions that come from layout, e.g. card left edges, so the keys change whenever the layout changes. chenguini's gesture-flick-snap-target demo does this in 2D with `nearestCorner`, a loop over 4 corners that keeps the smallest squared distance.

**The familiar JavaScript way**, from hard-attention.ts:

```ts
function nearestTargetReference(targetPositions: number[], pointerX: number) {
  let bestTarget = 0
  let bestDistance = Math.abs(pointerX - targetPositions[0])
  for (let target = 1; target < targetPositions.length; target++) {
    const distance = Math.abs(pointerX - targetPositions[target])
    if (distance < bestDistance) {
      bestTarget = target
      bestDistance = distance
    }
  }
  return targetPositions[bestTarget]
}
```

**The circuit way.** With key `(2 × targetX[j], -targetX[j]²)` and query `(pointerX, 1)`, the score is `pointerX² - (pointerX - targetX[j])²`, which is largest at the nearest target. Each score now takes two products instead of an affine sum. From hard-attention.ts, `buildRuntimeKeyHardAttention`, shortened:

```ts
const scoreOffset = maximumPosition ** 2
const scale = 2 ** -Math.ceil(Math.log2(2 * scoreOffset))
const scores = targetPositions.map(targetX => {
  const pointerTimesTarget = circuit.multiply(pointerX, targetX)
  const targetSquared = circuit.multiply(targetX, targetX)
  return circuit.roundAffine([[pointerTimesTarget, 2 * scale], [targetSquared, -scale]], scoreOffset * scale)
})
const {selected} = emitArgmax(circuit, scores, unit)
const snapX = emitMaskedSum(circuit, selected, targetPositions)
```

**Why it's exact.** With pointerX on a 1/4 px grid and integer target positions within 0..256, every product and score is exact in FP32, and two different scores differ by at least 1/2 before scaling, i.e. at least 3.8e-6 after scaling by 2^-17. `emitArgmax`'s comparison only keeps the left candidate over a larger right score when the difference is below about 2.1e-7 (measured at left scores 0.25, 0.5 and 0.75), so every comparison in a lookup gives the correct bit. The test checks 4 random layouts of 8 targets at every quarter pixel from 0 to 256: the circuit's snap position equals the plain JS result, with ties going to the lower target index, and 0 mismatching wires between the evaluators at every 8 px.

**Cost.** 2 products per target on top of the version with position keys: 71 operations, 18 layers, 133 stored weights and 1 gather read at 8 targets, and 631 operations, 36 layers and 1,229 stored weights at 64. That's O(n) operations and O(log n) layers per lookup. `indexRead` doesn't help here, since it needs the position first, and finding the position is the search itself. When the targets are sorted, e.g. card left edges in layout order, index-read's binary search pattern could find the two targets on either side of pointerX in log2(n) reads and comparisons; that wasn't built here. Outside a circuit, Percepta's "Can LLMs Be Computers?" post uses hard max over 2D keys on a parabola, and a convex hull cache at inference time finds each lookup's result in O(log n) instead of scoring all n keys ([notes/outside-techniques.md](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/notes/outside-techniques.md)). lab/data-adapter's lookup by id uses equality bits instead of scores, and it too reads all 12 storage slots, each holding an active bit, an id and a rectangle, to find a match.

### The reads side by side

| read | operations per read | layers | gradient to the index or query | gradient to the values | at a whole-number index | at 8 entries | at 64 entries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| linear interpolation, tent weights | O(n) | 5 | the slope between the two neighbors | `1 - fraction` and `fraction` | reads one entry | 32 operations, 5 layers | 256 operations, 5 layers |
| linear interpolation, three index reads | 10, plus one shared constant per position | 6 | the slope between the two neighbors, with `'zero'` | `1 - fraction` and `fraction` | reads one entry | 17 operations, 6 layers | 73 operations, 6 layers |
| soft attention, parabola keys | O(n) | 35 | from every entry whose exponent is above the floor | the softmax weights | blends entries | 154 operations, 35 layers | 1,106 operations, 35 layers |
| hard attention, position keys | O(n) | O(log n) | none, the backward pass throws | the selected entry | reads the nearest position | 55 operations, 17 layers | 503 operations, 35 layers |
| hard attention, runtime keys | O(n) | O(log n) | none, the backward pass throws | the selected entry | reads the nearest target | 71 operations, 18 layers | 631 operations, 36 layers |
| index read instruction | 1 | 1 | throws, 0, or a backward difference | the selected entry | reads `floor(index)` | 1 operation, 1 layer | 1 operation, 1 layer |

## Toy 1: learning where to read

**The task.** `itemIds = [41, 7, 23, 88, 15, 64, 30, 52]`, and the target id 64 sits at position 5. The familiar JavaScript way is a search: `itemIds.indexOf(64)`. The toy checks whether gradient descent on a query index finds the same position. **Gradient descent** repeatedly moves a parameter against its gradient, here `query -= learningRate × d loss / d query`.

**The loss compares each entry with the target, then averages.** `entryLosses[j]` is 0 where `itemIds[j] === 64` and 1 elsewhere, and the loss is a read of `entryLosses` with the read's weights: the average per-entry loss under those weights. It's small only when the weights sit on the matching entry. From [query-descent.ts](../examples/indexing/query-descent.ts), shortened:

```ts
for (let step = 0; step < 140; step++) {
  const sharpness = schedule(step) // 0.25 for 80 steps, then growing to 8 over 40 steps
  const values = reader.circuit.evaluateReference(reader.source(query, sharpness, entryLosses))
  const outputGradients = new Float32Array(values.length)
  outputGradients[reader.read] = 1
  const gradients = reader.circuit.backpropagateReference(values, outputGradients)
  const change = -learningRate / sharpness * gradients[reader.query]!
  query = clamp(query + clamp(change, -0.5, 0.5), 0, 7)
}
```

A low sharpness makes the read's weights wide, spread over several positions, and a high sharpness makes them sharp, concentrated on about one position. The learning rate is 1, divided by the sharpness because the loss curves more steeply as the sharpness grows, and one step moves the query at most 0.5 positions. In a scratch run with a fixed learning rate and no limit on the step, the query jumped past position 5 once the sharpness grew.

**Results**, from `report.ts`:

- **Soft attention, wide first, then sharp.** From starting queries 0, 1.2, 2.7, 4, 6.5 and 7, the query ended at 5.0000, and the weight on position 5 at sharpness 8 was 0.9993. During the wide phase every start settled at about 5.14, not 5. The loss is smallest where the weight on position 5 is largest, which is where the weighted average of the positions equals 5. The table stops at position 7, which cuts off weight on the right, so the weighted average sits a little left of the query, and the query ends up a little right of 5. Sharpening narrowed the weights until the cut-off didn't matter, and the query moved onto 5. From 0, where the loss barely changes with the query, the query needed the whole wide phase to get close: every 20 steps it was at 0.00, 0.16, 0.40, 0.84, 2.68, then 5.00.
- **Soft attention, sharp from the start (sharpness 8).** From 1.2 the query moved by about 1e-5, to 1.20001. At sharpness 8 and query 1.2, the weight on position 5 is about 1.5e-7, so the loss barely changes as the query moves.
- **Soft attention, wide only (sharpness 0.25).** From 1.2 the query ended at 5.1410, next to the entry but not on it.
- **Linear interpolation, same loss.** From 1.2 the query didn't move: both neighbors have loss 1, so the slope is 0. From 4.3 it reached position 5, then alternated between 4.9 and 5.1 with the fixed step size.
- **Hard read.** The index's gradient is 0, or `'reject'` throws, so the query never moves.
- **Linear interpolation with a loss on the blended value.** With the loss `((read - 64) / 100)²` over the ids themselves, from 1.2 the query ended at 2.6308, where the blend of ids 23 and 88 is 64.0000. No entry there holds 64, and the entry at the rounded query is 88.

**What toy 1 shows.**

- How far away the target entry can be and still give the query a nonzero gradient depends on how wide the read's weights are. Linear interpolation involves the two neighbors, a wide softmax involves several positions, and a sharp softmax about one. Starting wide and sharpening is the established trick of lowering a softmax's temperature during training, e.g. in Gumbel-softmax training (Jang et al., 2017).
- Averaging entries before comparing with the target lets two wrong entries mix into the target. lab/learned-interpreter reports the same effect with programs: its hard-loss trainer "scores each hard program before averaging losses, so wrong outputs cannot cancel each other into a correct target".
- After training, the soft read can be replaced by a hard one, e.g. `indexRead` at the rounded query, or argmax, which keeps every decision exact while the UI runs.

**Limits.** 8 entries, one target, one learned number, and a schedule tuned on this table.

## Toy 2: learning the weights that compute a query

**The task.** A paged carousel with 8 pages settles, on release, on the page nearest to where the flick would come to rest. chenguini's demos/gesture-flick-snap-target/snap-layout.ts computes the rest position as `pos + velocity / decayFriction`, with `decayFriction = 4.5`, and the demo snaps to the corner nearest that rest position. Written for pages:

```ts
function snapPageReference(releasePage: number, releaseVelocity: number) {
  const restPage = releasePage + releaseVelocity / 4.5
  return Math.min(7, Math.max(0, Math.round(restPage)))
}
```

Toy 1 learned the query itself. In a transformer, the query is computed from the inputs by learned weights. This toy learns three weights that compute the query from the release:

`query = clamp(weightRelease × (releasePage - 3.5) + weightVelocity × releaseVelocity + bias, 0, 7)`

The authored weights are weightRelease 1, weightVelocity 1 / 4.5 ≈ 0.2222 and bias 3.5. Measuring the release position from the middle page keeps the gradients of the three weights on similar scales, so one learning rate works for all three.

**Two circuits over the same query.** [learned-query.ts](../examples/indexing/learned-query.ts) builds the query from the release cells and three weight cells:

```ts
const releaseOffset = circuit.roundAffine([[releasePage, 1]], -3.5)
const projectedPage = circuit.roundAffine([
  [circuit.multiply(weightRelease, releaseOffset), 1],
  [circuit.multiply(weightVelocity, releaseVelocity), 1],
  [bias, 1],
])
const query = circuit.roundAffine([ // clamp to 0..7
  [circuit.reglu([], 1, [[projectedPage, 1]], 0), 1],
  [circuit.reglu([], 1, [[projectedPage, 1]], -7), -1],
])
```

The training circuit reads a table of per-page losses, 0 at the target page and 1 elsewhere, with the soft attention read above, as in toy 1. The snap circuit, which a UI would run, computes the same query and the same parabola scores, picks the highest score with `emitArgmax`, and outputs the page number as `Σ page × bit`. The weights sit in source cells, so the learned numbers move from one circuit to the other by writing 3 cells.

**Training.** 400 steps of gradient descent. Each step averages the gradients of 16 releases, taken in order from a fixed set of 512 random releases with releasePage within 0..7 and releaseVelocity within -6..6 pages per second. The sharpness stays at 0.25 for 200 steps, grows to 8 over 100 steps and stays at 8, and the learning rate 0.05 is divided by the sharpness, as in toy 1. One training run takes about 50 to 70 ms.

**Checking.** The snap circuit runs over a grid of 10,976 releases: releasePage on odd multiples of 1/128, and releaseVelocity on multiples of 1/4 from -6 to 6. On this grid no rest position is within 1/1152 page of a boundary between two pages, so FP32 rounding can't change which page is nearest, and the authored weights match plain JS on all 10,976 releases.

**Results**, from `report.ts`:

- From "nearest page, ignoring velocity" (1, 0, 3.5) and from "always the middle page" (0, 0, 3.5), training ended at weightRelease 0.9993, weightVelocity 0.2244 and bias 3.4957 with seed 1, and at 1.0045, 0.2243 and 3.4978 with seed 2. Both starts ended on the same weights to four decimal places: with the same releases in the same order, the two runs converged onto the same path. The snap circuit matched plain JS on 10,895 (seed 1) and 10,892 (seed 2) of the 10,976 releases, and every mismatching release had its rest position within 0.0182 page of a boundary between two pages.
- With learning rate 0.1, the weights moved around more at sharpness 8: 10,634 and 10,745 matches, with mismatches within 0.0842 page of a boundary.
- From "projecting the wrong way" (0.5, -0.5, 1), learning rate 0.05 didn't get there in 400 steps (4,313 and 4,103 matches), while learning rate 0.1 reached the same weights as the other starts.
- The control computes the same query, uses the squared error `(query - targetPage)²` as the loss, and has no read at all. With learning rate 0.02 and seed 1, it ended at 1.0061, 0.2316 and 3.4823 from all three starts, and matched on 10,675 releases, with mismatches within 0.0807 page of a boundary.

**Cost.** The training circuit is 165 operations and 41 layers: the soft read's 154 operations plus 11 for the query. The snap circuit is 66 operations and 23 layers, and the squared-error control is 15 operations and 9 layers.

**What toy 2 shows.**

- A gradient through a soft read reaches the weights that compute a query, and weights learned through the soft read carry over to an exact argmax circuit, which then picks the same page as plain JS except for releases whose rest position lies within about 0.02 page of a boundary between pages.
- It doesn't show that attention was needed. The query's form was written by hand so that the authored rule is one of its settings, and a plain squared error on the query learned nearly the same weights. Why the soft read matched slightly more releases (10,895 against 10,675) wasn't isolated.
- **Limits.** 8 pages, fixed keys (the page positions), one read, three weights, and one hand-picked schedule.

## What this suggests

### For learning lookups

- Learning the values a UI reads works through every way of reading, because the selected entries get the gradient.
- Learning where to read needs a soft read while training. Linear interpolation is cheapest, 10 operations per read with the instruction, but its gradient only depends on the two neighbors. The gradient of a softmax over positions also depends on entries further away, for O(n) operations per read.
- The loss should compare each entry with the target before averaging, e.g. read a table of per-entry losses with the soft weights instead of putting a loss on the blended value.
- The circuit a UI runs every frame can keep the hard read, with its exact decisions, and take the learned numbers as cells. lab/cascade-argmax did the same with comparisons: it trained soft comparisons, moved the learned scores into the exact argmax circuit, and the hard circuit picked the right candidate in 160 of 160 cases (16 cases over 10 seeds). What it learned was one score per case and candidate, a table of 128 numbers, not a shared scoring function.

### For the hunch about rediscovering attention

- The shapes line up. The index is a query, the positions are keys, parabola keys turn "position equals query" into a dot product, a softmax over those scores is soft attention, argmax is hard attention, and the masked sum or gather is the weighted sum of values. `indexRead` is hard attention whose keys are positions, compiled down to a floor and a copy. Both toys trained with the soft version and ran the hard one.
- The costs have the familiar big-O shapes. A soft read over n entries is O(n) operations, so m soft reads over n entries are O(mn), and a transformer layer in which each of n tokens reads over all n tokens is O(n²). A hard read with runtime keys is O(n) operations at O(log n) depth as a tournament, and O(log n) per lookup with Percepta's convex hull cache outside the weights. Only the special case where the keys are positions and the query is already a whole number becomes 1 operation, with `indexRead`.
- What a transformer's attention adds isn't here. In a transformer, queries and keys are both computed from the inputs by learned weights, each layer has several attention patterns, and layers feed each other. Toy 2 learned three query weights with fixed keys and one read, and none of the prototypes learned keys. learned-bits tried learning UI decision rules at the level of bits, and no network learned Tab exactly from part of its cases.
- The repo's own notes caution against reading too much into the resemblance. lab/reassessment-2026-09-03.md corrects "Gather lowering discovered hard attention" to "It recognized retrieval after a selection was already represented. It neither learned query/key scoring nor made an entire attention operation constant-time." The "Revisit hardAttend" entry in [lab/status.md's parked list](../../../status.md#parked-and-deferred), formerly in todo.md, says: "Compare alternatives without presuming that attention must emerge."
- A next experiment closer to what attention learns is the one that entry and [decision 8](../review-and-decisions.md#8-what-should-the-next-learning-experiment-be) describe: retrieve the rectangle for a selected item id while the item's storage position, the number of active items and the distractors vary, so that no fixed position can solve it, and learn how keys and queries are computed. lab/data-adapter already has an authored lookup and a program search baseline for that task.

## Files

- [one-hot-read.ts](../examples/indexing/one-hot-read.ts): ReLU-difference bits, the masked sum, and the plain JS `clampedRead`.
- [linear-read.ts](../examples/indexing/linear-read.ts): the same bits without the one-hot declaration, with `linearRead` and its derivative.
- [index-read-instruction.ts](../examples/indexing/index-read-instruction.ts): `indexRead`, and linear interpolation from three index reads, over index-read's copy of the runtime, in pixel-output since September 16, 2026.
- [shared-runtime-index-read.ts](../examples/indexing/shared-runtime-index-read.ts): `indexRead` and `indexReadAffine` from numeric-ui-core.ts: the same read and linear interpolation, and a virtualized list's row tops.
- [shared-runtime-index-read.test.ts](../examples/indexing/shared-runtime-index-read.test.ts): the instruction against plain JS, the one-hot read and index-read's copy in pixel-output, including the reads that the builder throws on, and the three index gradient options.
- [soft-attention.ts](../examples/indexing/soft-attention.ts): parabola keys, softmax with `emitExp`, the Newton reciprocal without boolean atoms, and float64 references.
- [hard-attention.ts](../examples/indexing/hard-attention.ts): parabola scores into `emitArgmax` with position keys and with runtime keys, `nearestPositionRead` and `nearestTargetReference`.
- [query-descent.ts](../examples/indexing/query-descent.ts): toy 1.
- [learned-query.ts](../examples/indexing/learned-query.ts): toy 2, with the training circuit, the snap circuit, the squared-error control and the release grid.
- [measure.ts](../examples/indexing/measure.ts): operation counts and mismatch counts.
- [indexing.test.ts](../examples/indexing/indexing.test.ts): every check quoted above.
- [report.ts](../examples/indexing/report.ts): every count and toy result quoted above.

Run from the repo root: `bun test lab/ui-exploration/guide/examples/indexing`, `bunx tsgo -p lab/ui-exploration/guide/examples/indexing`, and `bun lab/ui-exploration/guide/examples/indexing/report.ts`.
