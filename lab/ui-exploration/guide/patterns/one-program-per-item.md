# One program per item

A collection's per-item work is written once as map stages that run for every item, like a shader over pixels, and the few lines that carry a value from one item to the next become reductions between the stages.

```txt
row               0           1           2           3
                  |           |           |           |
map stage     rowHeight   rowHeight   rowHeight   rowHeight     3 operations, written once
                  |           |           |           |
reduction     ------------- prefix sum: rowTop -------------
                  |           |           |           |
map stage     visible     visible     visible     visible       12 operations, written once
              hovered     hovered     hovered     hovered
                  |           |           |           |
reduction     ------ sums: visibleCount, hoveredRow -------
```

A map stage reads only its own row's values and shared values, e.g. scrollTop and pointerY. The [instancing](../sections/instancing.md) section covers the details: the gallery before and after, per-item constants, accumulation order, and how staged programs run on the CPU and the GPU.

## The loop it replaces

```ts
let rowTop = 0
for (let row = 0; row < rows.length; row++) {
  const rowHeight = headerHeight + (rows[row].expanded ? rows[row].lineCount * lineHeight : 0) // this row only
  const rowBottom = rowTop + rowHeight
  visible[row] = rowBottom > scrollTop && rowTop < scrollTop + viewportHeight // this row only
  hovered[row] = pointerY >= rowTop && pointerY < rowBottom // this row only
  if (visible[row]) visibleCount++ // carried
  if (hovered[row]) hoveredRow = row // carried
  rowTop = rowBottom // carried to the next row
}
```

## The circuit

From [one-program-per-item.ts](../examples/patterns/every-item/one-program-per-item.ts). A map stage is ordinary builder code over one row's wires:

```ts
export function emitRowHeight(circuit: Circuit, shared: {headerHeight: Wire, lineHeight: Wire}, row: {lineCount: Wire, expanded: Wire}): Wire {
  const bodyHeight = circuit.multiply(row.lineCount, shared.lineHeight)
  return circuit.roundAffine([[shared.headerHeight, 1], [circuit.multiply(row.expanded, bodyHeight), 1]])
}
```

`buildMapStage` makes one `Circuit` whose source cells are the stage's shared values followed by one row's fields, and `runListStages` evaluates it once per row. Between the stages, JavaScript loops compute row tops with `Math.fround` after every addition, and the sums. Rows don't overlap, so at most one row is hovered, and `hoveredRow` is the sum of `row × hovered[row]`. `buildDuplicatedList` calls the same builder functions once per row in one circuit, with row tops as a chain of `roundAffine` additions: that duplicated circuit is the one program the staged form has to match.

## Cost

- Let p be the operations of all map stages for one item. The program is O(p) operations at any item count, and a frame does O(n × p) operations plus O(n) per reduction. The example's stages are 3 operations in 3 layers and 12 operations in 4 layers at any row count.
- The duplicated circuit is O(n × p) operations, and its chain of row tops adds a layer per row: 117 operations and 15 layers at 8 rows, 901 and 71 at 64 rows, 7,173 and 519 at 512 rows. A Brent-Kung prefix sum would bring the depth down to O(log n).
- In instanced-items, the gallery is 233 operations per photo at 221, 1,000 and 10,000 photos, with 31 reductions. At 10,000 photos its staged executor took about 4,106 µs per frame, against 43,027 µs for the duplicated circuit.

## When it's exact

- The staged program gives the duplicated circuit's bits when each reduction takes the same FP32 steps as its operations in the duplicated circuit, e.g. a prefix sum in row order, rounded after every addition, against a chain of `roundAffine`.
- A stage boundary can change where a value rounds: the builder copies small affine sums into the operations that read them, and a per-item constant that was a weight becomes a product. E.g. with instanced-items' rebuild of small sums across stages turned off, 217 of 2,885,400 values on the gallery's scripted trace changed, by at most 0.00003 px and with no decision changed, and products for per-item constants moved IndirectOS's thumbnail centers by up to 0.0012 px.
- The example's host contract puts every input on a quarter-pixel grid with totals below 2^21 px, so every sum is exact, and the test compares the stages, the duplicated circuit and the plain loop exactly.

## When not to use it

- A handful of items whose constants sit in lookup tables: staging IndirectOS's 20 small items took it from 5,253 to 6,282 operations, because table entries that were weights became products.
- Items that don't share a program, e.g. a settings page where every control is different.
- When the one fixed program is the point, e.g. an executor that runs a whole layer at once: a staged program runs as a list of stages and loops, and the duplicated circuit stays the single program of layers.

## Where it's used

- [Instancing](../sections/instancing.md): the gallery's 6 map stages and 31 reductions, the reductions' costs, [per-item constants](../sections/instancing.md#per-item-constants-from-weights-to-inputs), [accumulation order](../sections/instancing.md#accumulation-order-is-part-of-the-result), and a row of cards in [examples/instancing](../examples/instancing/).
- [instanced-items](../../instanced-items/README.md): the staged builder (staged.ts), the gallery and IndirectOS as staged programs, and executors with one generated loop per stage and GPU compute shaders per stage.
- [gallery](../../gallery/README.md): gallery-circuit.ts, the duplicated form, 48,411 operations for 221 photos.
- [codegen](../../codegen/README.md): life-calendar's 27,393 grid squares, where only 63 of its 2,054 operations run once per square, and the other 1,991 run once for the whole grid.
- Example and test: [one-program-per-item.ts](../examples/patterns/every-item/one-program-per-item.ts) and [one-program-per-item.test.ts](../examples/patterns/every-item/one-program-per-item.test.ts), which compare the stages in both evaluators, the duplicated circuit in both evaluators and the plain loop, with scrollTop and pointerY on row edges and one quarter pixel to either side, and rows of height 0.
