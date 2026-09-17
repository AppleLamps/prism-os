Size: loop. Short entry: [patterns.md, "A loop over data that rarely changes"](../../../../docs/patterns.md#a-loop-over-data-that-rarely-changes).

# Tables that JavaScript writes

Numbers that a loop would compute from data that rarely changes, e.g. each comment's ancestor at every indent level, or a spring's matrix for this evaluation's steps, get computed by JavaScript and written into source cells, and the program reads them with one operation or a few products.

```txt
indents [0 1 2 1 2 3]            ancestorAtLevel, one row per comment, one column per indent level
                                 row 0: [0 0 0 0]
JavaScript runs the while        row 1: [0 1 1 1]
loop for every row and level     row 2: [0 1 2 2]
whenever the thread changes,     row 3: [0 3 3 3]
and writes the results           row 4: [0 3 4 4]
into cells                       row 5: [0 3 4 5]    pointed row 5, level 2: cell 5 × 4 + 2 = 22 holds 4

the program, every frame:  ancestor    = ancestorAtLevel[pointedRow × 4 + pointedLevel]    1 operation
                           ancestorTop = rowTops[ancestor]                                 1 operation
```

## The loops it replaces

```ts
// hn.js line 333: climb from the comment under the pointer to its ancestor at the pointed indent level.
let ancestor = pointedRow
while (ancestor > 0 && indents[ancestor] > pointedLevel) ancestor--

// index.ts: one semi-implicit Euler step per 4 ms, for every spring.
for (let step = 0; step < steps; step++) {
  velocity += (-stiffness * displacement - damping * velocity) * dt
  displacement += velocity * dt
}
```

## The circuit

The host writes `prepareAncestorTable(indents, rowCapacity, levelCount)` into the table's cells whenever the thread changes, and host-timing.ts's `springMatrixPower(springStepMatrix({stiffness, damping}), steps)` into 4 cells before each evaluation. The program reads them ([tables-javascript-writes.ts](../examples/patterns/candidates-and-tables/tables-javascript-writes.ts)):

```ts
// JS: let ancestor = row; while (ancestor > 0 && indents[ancestor] > level) ancestor--
const ancestor = circuit.indexReadAffine([[cells.pointedRow, levelCount], [cells.pointedLevel, 1]], 0, ancestorTable, 'clamp', 'clamp')
// JS: rowTops[ancestor]
const ancestorTop = circuit.indexRead(ancestor, rowTops)
// JS: for (let step = 0; step < steps; step++) { velocity += ...; displacement += velocity × dt }
const stepped = springs.map(spring => emitApplySpringMatrix(circuit, matrix, spring.displacement, spring.velocity))
```

A table indexed by two values is read through one affine index form, e.g. `pointedRow × levelCount + pointedLevel`, and every spring with the same stiffness and damping reads the same 4 matrix cells.

## Why cells keep behavior editable and learnable

- Editable at runtime. A number known while building becomes a weight, and changing a weight means building and compiling the program again, e.g. a median of 2.5 ms per keystroke to rebuild and compile the whole Notes window when its text tables are weights ([text](../sections/text.md#when-not-to-use-tabulation)). A number in a cell is data: JavaScript writes a new table before the next evaluation, and the compiled program stays the same. The example's test runs every row and level of 45 threads through one compiled program, and 4 stiffness and damping pairs with 0 to 300 steps through another. In code-points, changing a line break rule between two existing classes is a write to its pair table, not a circuit change.
- Learnable. The backward pass computes a gradient for every wire, and source cells are wires, while weights aren't. Seeding a spring's next displacement gives exactly `(displacement, velocity, 0, 0)` at the 4 matrix cells, and JavaScript finishes the chain rule, e.g. 0.1055 px per unit of stiffness and −0.5047 px per unit of damping after 16 steps from 100 px short of the destination ([differentiability](../sections/differentiability.md#spring-banks-fast-variants-stop-the-gradient-at-the-frame-matrix)). An index read passes gradients to the table's values and none to the index: `rowTops[ancestor]` gets 1, while `backpropagateReference` throws at the index unless the caller passes `{indexGradient: 'zero'}`. So an ancestor table can be edited, but its values are indexes, which get no gradient, while a spring matrix or a table of sizes can be trained.
- The price is cells and declared ranges instead of free weights, e.g. text-tabulated's Notes window keeps 5,792 cells for values that take 1,972 stored weights as constants ([text](../sections/text.md#values-as-weights-or-values-in-source-cells)). Each cell also needs a declared range, e.g. ±`springMatrixBound` over every pair the host may write, so a bad write fails the range check instead of stepping springs to Infinity.

## Cost

An index read is 1 operation in 1 layer at any table size, and applying a spring matrix is 14 operations in 3 layers per spring for any step count. JavaScript pays O(table size) whenever the data changes, e.g. one `while` loop per row and level, or a few 2×2 matrix products per evaluation.

Measured by the example's test: the ancestor and its top are 2 operations, 2 layers and 3 stored weights both at 64 rows × 8 levels and at 1,024 rows × 16 levels, and 20 springs sharing one matrix are 280 operations in 3 layers.

## When it's exact

- An index read copies a candidate without rounding when its index holds an integer within its declared range, strictly inside ±2^24, which `validateIndexReads` checks in tests. The evaluators check every table cell against its declared range on every evaluation, so rows past the thread's last comment still need values in range; the example points them at themselves.
- The program matches the loop only while the table matches the data, so JavaScript rewrites the table before the evaluation in which a new comment's row can be pointed at.
- A spring matrix is rounded to FP32, so springs follow float64 closely but not bit for bit. Over 400 random runs of 8 springs with 0 to 300 steps, displacements within ±800 px and velocities within ±2,000 px/s stayed within 1e-4 px and 1e-3 px/s of the loop. A decision on springs, e.g. settling, needs its own exact rule ([springs](../sections/springs.md)).

## When not to use it

- When the table's inputs change inside the frame, e.g. which comments are collapsed after this frame's click: JavaScript writes cells only between evaluations, so the table would lag one evaluation unless the program computes those entries itself.
- When the table grows too fast, e.g. a line break rule that needs the class before a pair of neighbors would take a 41 × 41 × 41 = 68,921 cell table in code-points.
- When nothing changes at runtime and nothing will be learned: constants need no cells and let the builder compute everything whose inputs are known, e.g. ranking 64 items is 64 constant operations when their widths are known while building, and 8,128 operations when the widths are in cells.

## Where it's used

- [host-timing.ts](../../../../src/runtime/host-timing.ts) with `emitApplySpringMatrix` in [numeric-ui-core.ts](../../../../src/runtime/numeric-ui-core.ts): the default spring, 4 cells per stiffness and damping pair ([springs](../sections/springs.md#4-javascript-writes-the-frame-matrix)).
- [hn-thread](../../hn-thread/README.md): `ancestorAtLevel`, 2,761 entries built into the program as constants and read through a row one-hot and a level one-hot. Its README notes that a thread that changes at runtime needs runtime ancestor data instead of constant tables.
- [code-points](../../code-points/README.md): line break classes and a 41 × 41 pair table, `breakAfter[c] = pairs[class[c] × 41 + class[c + 1]]`, which took line start mismatches against pretext from 8,806 to 418 of 41,820 layouts ([text, idea 3](../sections/text.md#idea-3-code-points-and-break-rules-inside-the-circuit)).
- [Chains](../sections/chains.md#batching-different-chains-together): one circuit for any 4-state machine with its transition table in cells, which runs both a button and a toggle switch.
- [drag-knobs](../../drag-knobs/README.md): design numbers in cells, e.g. card padding and the grid gap, which a solver moves with gradients while a designer drags an edge.
- Example and test: [tables-javascript-writes.ts](../examples/patterns/candidates-and-tables/tables-javascript-writes.ts) and [tables-javascript-writes.test.ts](../examples/patterns/candidates-and-tables/tables-javascript-writes.test.ts).
