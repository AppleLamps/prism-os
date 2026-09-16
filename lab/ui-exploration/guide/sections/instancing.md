# Instancing: write the per-item program once

Many UIs show a collection of similar items, e.g. photos in a gallery, cards in a row, windows on a desktop. In JavaScript you write the per-item work once, inside a loop. Indirect's first hand-written gallery circuit instead contained the per-photo arithmetic once per photo, 221 copies in one circuit. The instanced-items prototype built the alternative, the way a GPU shader is written: write the per-photo program once, run that program for every photo, and put the few computations that read many photos' values between those runs.

This section covers the Photos gallery before and after (gallery-circuit.ts and gallery-staged.ts, both in lab/ui-exploration/instanced-items), which parts of the gallery needed computations across photos and why, what each form costs, why the order of additions matters, why staging IndirectOS made it bigger, how a staged program runs on the CPU and the GPU, a runnable example of a row of cards, and what all of this has in common with a transformer.

Instancing isn't a line-by-line translation of JavaScript loops. A loop over items becomes a list of steps, where each step is either one small program that runs for every item, or one computation across all items. A few habits change along the way, e.g. an item's program no longer reads its neighbor's value directly, and an item's constants are no longer written into the code.

The pattern doc [one program per item](../patterns/one-program-per-item.md) has the idea on one page, with a runnable example of a list of rows and its test.

## Terms

An **instance** is one item running the shared per-item program with its own inputs, e.g. photo 17 running the per-photo program with photo 17's aspect ratio and spring state.

A **map stage** is a program written once that runs once per item, reading only that item's values plus shared values, e.g. "this photo's grid width and height, from the column width and this photo's aspect ratio". A map stage's outputs are new per-item values, like the array that `Array.prototype.map` returns.

A **reduction** is a computation across all items, e.g. the tallest photo in a row, the running totals of row heights, the first photo under a click, or the number of springs still animating. A reduction turns per-item values into one shared value (a count), into per-item values that depend on other items (running totals), or reads one item's value at an index. The name is borrowed from `Array.prototype.reduce`, even though some reductions here output one value per item.

A **shared value** is computed once per frame and is the same for every item, e.g. the window width, the column count or the pointer position. GPU shaders call such inputs uniforms: a uniform is a shader input that has the same value for every pixel or vertex the shader runs on.

A **per-item constant** is a number known while building that differs per item, e.g. a photo's aspect ratio, or its row index when there are 3 columns.

A **field** is a per-item value stored as one Float32Array with one number per item, e.g. `sizeY2D` holds every photo's grid height. Keeping one array per field, instead of one object per item, is called struct of arrays.

A **duplicated circuit** is one circuit in which builder code writes the per-item program out once per item. A **staged program** is instanced-items' form: an ordered list of shared stages, map stages and reductions.

A reduction's **lowering** is the list of operations that replaces the reduction when a staged program is expanded into a duplicated circuit, e.g. `firstActive` lowers into a tournament of ReLUs.

The numbers below use four measures. **Live operations**, or just operations, are the operations of a compiled program that some output depends on, all of which run on every evaluation. A **layer** is a group of operations that don't read each other, and **depth** is the number of layers, i.e. the longest chain of operations that must run one after another. **Stored weights** are the nonzero coefficients that the compiled layers keep, which measure memory and the work inside sums. **FP32** is the 32-bit float format of Float32Array, and every addition and product rounds to the nearest FP32 value, like `Math.fround`. The [glossary](../README.md#glossary) collects these and the other terms of the guide.

`[condition]` means 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript, e.g. `[newIndex − index = 0]` is 1 for the focused photo.

## Short answers

**What changed for Photos?** Before, lab/ui-exploration/instanced-items/gallery-circuit.ts appended every photo's operations to one circuit, with each photo's constants written into the weights: 48,411 operations and 61 layers for 221 photos. After, lab/ui-exploration/instanced-items/gallery-staged.ts writes 6 per-photo stages once, 233 operations per photo at 221, 1,000 and 10,000 photos, with 31 computations across photos between them, e.g. the tallest photo in each row, the running totals of row heights, and the first photo under a click. Both forms made 0 decision mismatches against native index.ts over the same random and scripted traces at 221 photos. On synthetic photos with other random traces, the staged form made 0 mismatches at 1,000 photos, and at 10,000 photos only with Brent-Kung prefix sums: adding one item at a time flipped 74 decisions there.

**Which parts needed computations across photos?** Only the parts where one photo's result depends on other photos, or where one shared result depends on every photo: row maxima, row tops, strip left edges, the clicked photo, whether any photo is hovered, the scroll anchor, reads at the focused photo or the anchor photo, and whether anything is still animating. Sizes, the focus relation, grid targets, hover, destinations, springs and occlusion stayed per photo.

**What does it cost?** The program's size stops growing with the item count, while the work per frame still grows the way a shader's does: n × 233 operations for n photos, plus a loop per reduction. The duplicated form of the same gallery at 10,000 photos is 2,571,887 operations and took 4.7 s to build and compile, while the staged program built in 22 ms. Constants that were free weights become inputs read by products, which made the gallery's per-photo arithmetic about 33 operations larger, and made IndirectOS's 20 small items bigger than its hand-written circuit (6,282 against 5,253 operations).

**Is this attention?** Partly. A transformer block is a per-token program (a map stage) plus attention across tokens (a reduction that reads other tokens' values). The staged gallery already has per-item programs, hard reads at computed indices, first-match selections, and maxima and sums across items. It has no soft attention: no fractional weights computed at runtime from how well a query matches each key, no query per item, and nothing learned.

## The familiar JavaScript: index.ts's loops

chenglou.github.io's gallery has one `render(now)` function with several loops over photos. The excerpts here come from the frozen copy at lab/trace-compiler/fixtures/index.ts.txt (commit f315d586), which both prototypes run against; the live site's index.ts has changed since. The first loop sizes every photo and records where each row starts:

```ts
const boxes2DSizeX: number[] = [], boxes2DSizeY: number[] = [], rowsTop: number[] = [windowPaddingTop]
let rowMaxSizeY = 0
for (let i = 0; i < data.length; i++) {
  let d = data[i]!
  const imgMaxSizeY = d.ar === 1 ? boxMaxSizeX * 0.85 : d.ar < 1 ? boxMaxSizeX * 1.05 : boxMaxSizeX
  const sizeX = Math.min(d.naturalSizeX, boxMaxSizeX, imgMaxSizeY * d.ar)
  const sizeY = sizeX / d.ar + promptSizeY
  boxes2DSizeX.push(sizeX)
  boxes2DSizeY.push(sizeY)
  rowMaxSizeY = Math.max(rowMaxSizeY, sizeY)
  if (i % cols === cols - 1 || i === data.length - 1) { // last photo of the row, or the last photo
    rowsTop.push(rowsTop.at(-1)! + rowMaxSizeY + boxesGapY)
    rowMaxSizeY = 0
  }
}
```

A later loop centers each photo vertically in its row, `d.y.dest = rowsTop[currentRow]! + (rowMaxSizeY - sizeY) / 2`, so every photo's position depends on the tallest photo of its row and on every earlier row.

The click hit test returns the first photo whose rectangle contains the pointer:

```ts
function hitTest2DMode(data: BoxData[], pointerX: number, pointerY: number): number | null {
  for (let i = 0; i < data.length; i++) {
    let {x, y, sizeX, sizeY} = data[i]!
    if (x.dest <= pointerX && pointerX < x.dest + sizeX.dest && y.dest <= pointerY && pointerY < y.dest + sizeY.dest) return i
  }
  return null
}
```

Each loop mixes two kinds of lines. Some lines only read photo `i`'s values, e.g. `sizeY = sizeX / d.ar + promptSizeY`. Other lines carry a value from one photo to the next, e.g. `rowMaxSizeY = Math.max(rowMaxSizeY, sizeY)`, `rowsTop.push(rowsTop.at(-1)! + ...)`, or the `return i` that stops at the first hit. Instancing separates the two kinds: lines of the first kind go into map stages, and lines of the second kind become reductions.

## Before: gallery-circuit.ts writes every photo out

### A builder loop appends 221 copies

A circuit is made by builder code, i.e. ordinary JavaScript that runs once at startup and appends operations to a `Circuit` instead of computing values. There are three kinds of operations, plus an index read instruction described in [indexing](indexing.md#way-3-the-index-read-instruction). `circuit.affine(terms, bias)` is a weighted sum of values plus a constant. `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)` is a ReLU-gated product: one weighted sum times `max(0, another weighted sum)`, where `max(0, x)` is called a ReLU. `circuit.boolean(score)` rounds a score between 0 and 1 to exactly 0 or 1.

Where index.ts loops over photos at runtime, gallery-circuit.ts loops over photos while building and appends each photo's operations to the one circuit. A photo's constants, like its aspect ratio, go straight into the weights:

```ts
const sizes2D = photos.map((photo, index) => {
  const ar = photo.w / photo.h
  const factor = ar === 1 ? 0.85 : ar < 1 ? 1.05 : 1
  const widthFactor = Math.min(1, factor * ar)
  const sizeX = circuit.affine([
    [columns.boxMaxSizeX, widthFactor],
    [circuit.reglu([], 1, [[columns.boxMaxSizeX, widthFactor]], -photo.w), -1],
  ])
  const sizeY = circuit.affine([[sizeX, 1 / ar]], K.promptSizeY)
  return {sizeX, sizeY}
})
```

`sizeX` is `min(boxMaxSizeX × widthFactor, photo.w)`, written as `a − max(0, a − photo.w)`, which is index.ts's `Math.min` rearranged. `widthFactor`, `photo.w` and `1 / ar` are plain numbers while building, so each photo's copy gets its own weights, and scaling by a known number is a coefficient inside a weighted sum rather than a product of two values.

### Loops across photos become constructions over every photo's values

A wire is the position of one value in the circuit, e.g. photo 17's x destination. The loops that carry a value from photo to photo become constructions that read all 221 photos' wires at once.

The click hit test computes one exact 0 or 1 per photo, then a tournament picks the first photo whose bit is 1. A tournament is a balanced binary tree that combines items in pairs, then pairs of pairs, so it reads n items in O(log n) layers. This tournament computes "is any bit set" on the way up, and routes a single 1 down to the first set bit:

```ts
const hitBits = photoCells.map(({springs}) => emitAll(circuit, [
  atLeastZero(circuit.roundAffine([[pointer.localX, 1], [springs.x.destination, -1]])),
  aboveZero(circuit.roundAffine([[springs.x.destination, 1], [springs.sizeX.destination, 1], [pointer.localX, -1]])),
  atLeastZero(circuit.roundAffine([[pointer.localY, 1], [springs.y.destination, -1]])),
  aboveZero(circuit.roundAffine([[springs.y.destination, 1], [springs.sizeY.destination, 1], [pointer.localY, -1]])),
], {booleanAtom: true}))
const selected = emitFirstSetBit(circuit, gate2D, hitBits)
const hitIndex = circuit.affine(selected.map((wire, index) => [wire, index] as const))
```

`roundAffine` is a weighted sum that keeps its terms in the written order and stores its result as its own value, which exact comparisons need. `emitAll` turns the four differences into one exact bit; the [comparisons](comparisons.md) section explains how.

The row maxima become a small tree of maxima per row. The row tops become a prefix sum, i.e. the list of running totals, here `rowTops[k] = windowPaddingTop + 24 × k + rowHeights[0] + ... + rowHeights[k − 1]`. gallery-circuit.ts writes each running total as its own sum over all earlier rows. The code calls these triangle prefix sums, and the [loops](loops.md) section calls them wide sums: 1 layer, but about n²/2 stored weights for n rows.

Photos' operations also read each other's wires directly. The blur on the focused photo's neighbors reads the focus bits of photos `index − 1` and `index + 1`:

```ts
const blurTerms: [Wire, number][] = [[newFocus.members[index]!, 1]]
if (index > 0) blurTerms.push([newFocus.members[index - 1]!, 1])
if (index + 1 < count) blurTerms.push([newFocus.members[index + 1]!, 1])
```

`newFocus.members` is the one-hot of the new focused index. A one-hot is a list of bits in which exactly one bit is 1, e.g. `[0, 0, 1, 0]` names index 2. gallery-circuit.ts builds this one-hot once, from one shared chain of ReLUs over the index.

### What the duplicated circuit costs

At 221 photos, gallery-circuit.ts has 48,411 live operations, 61 layers and 174,708 stored weights, and building it takes about 100 ms ([instanced-items](../../instanced-items/README.md#merged-from-gallery-september-16-2026)). Springs are 31,191 of those operations (64%): 6 springs per photo, 1,326 in all.

Every copy adds its own operations, so the program's size, build time and memory grow with the photo count. instanced-items expanded its staged gallery into a duplicated circuit at larger counts, with Brent-Kung prefix sums (explained under "Accumulation order"):

| Photos | 221 | 1,000 | 10,000 |
| --- | ---: | ---: | ---: |
| live operations | 57,135 | 257,433 | 2,571,887 |
| layers | 67 | 71 | 80 |
| stored weights | 124,533 | 560,955 | 5,603,733 |
| expand + compile | 49 + 39 ms | 235 + 218 ms | 2,626 + 2,099 ms |
| heap afterward | 215 MB | 402 MB | 1,969 MB |

gallery-circuit.ts itself wasn't built at 10,000 photos, because page coordinates there pass its declared range of ±2^22 px.

Running a large duplicated circuit is slow too. At 221 photos, the executor took about 375 to 508 µs per frame, and plain JavaScript generated from the compiled program became 2,242 functions that still took about 428 to 566 µs after 6,000 warm runs. index.ts natively took 13 to 14 µs per frame, DOM writes included. These timings are rough, since about a dozen other agents shared the machine.

## After: instanced-items writes each stage once

### The builder

lab/ui-exploration/instanced-items/staged.ts adds a builder on top of `Circuit`. A `StagedProgram` holds shared cells, arrays of items, and an ordered list of steps, where each step is a stage or a reduction:

- `program.sharedCell(name, minimum, maximum)` declares a shared input that JavaScript writes, e.g. the window width.
- `program.array(name, count)` declares a list of items. `array.cell(name, minimum, maximum)` declares a per-item input that JavaScript writes, e.g. a spring's velocity, and `array.constant(name, values)` declares a per-item constant, e.g. every photo's aspect ratio.
- `program.shared(name, inputs, build)` declares a stage that runs once per frame, and `program.map(array, name, inputs, build)` declares a map stage. Both build one ordinary `Circuit` whose source cells are the values the stage reads, and the build function is plain builder code, written once.
- Reductions go between stages: `sum` and `countBits`; `prefixSum`, added one item at a time or with Brent-Kung; `firstActive`; `argmax`; `max`; `gatherAt`, which reads one item's value at a shared index; `gatherIndexed`, which reads another array's values at a per-item constant index; `scatter`, which turns a shared index back into per-item bits; and `groupMax`, the maximum over consecutive items that share a group, e.g. the photos of one row.
- `program.next(cell, value)` copies a value back into a cell after each frame, and `program.output(struct)` marks the values JavaScript reads.

### The click hit test, before and after

The gallery's click becomes one map stage and one reduction. The map stage is the per-photo part of `hitTest2DMode`, and `firstActive` is the loop that stops at the first hit:

```ts
const hit = program.map(photos, 'click hit test', {
  localX: pointer.localX, localY: pointer.localY,
  x: state.x.destination, sizeX: state.sizeX.destination, y: state.y.destination, sizeY: state.sizeY.destination,
}, (circuit, input) => ({
  bit: emitAll(circuit, [
    atLeastZero(circuit.roundAffine([[input.localX, 1], [input.x, -1]])),
    aboveZero(circuit.roundAffine([[input.x, 1], [input.sizeX, 1], [input.localX, -1]])),
    atLeastZero(circuit.roundAffine([[input.localY, 1], [input.y, -1]])),
    aboveZero(circuit.roundAffine([[input.y, 1], [input.sizeY, 1], [input.localY, -1]])),
  ], {booleanAtom: true}),
}))
const click = program.firstActive(hit.bit, keys.gate2D, 'click selection')
```

The per-photo arithmetic is the same text as in gallery-circuit.ts. Two things changed. The arithmetic is written once, against `input.x` instead of photo `index`'s `springs.x.destination`. And the tournament isn't in the staged program anymore: the staged executor runs `firstActive` as a JavaScript loop, and only the duplicated form lowers `firstActive` into a tournament.

### The gallery as a list of steps

gallery-staged.ts computes the same render path as gallery-circuit.ts, with 6 map stages over photos, 14 one-operation map stages over rows, 9 shared stages and 31 reductions. In order:

| Step | Kind | What the step computes |
| ---: | --- | --- |
| 1 | shared stages | the pointer; keys; the strip's left and right click regions (the strip is the horizontal row a clicked photo opens into) |
| 2 | map over photos, 10 operations | click hit test: does this photo's previous destination contain the pointer |
| 3 | `firstActive` | the clicked photo |
| 4 | shared stages | the new focused photo from keys and clicks; the column count and grid cell width |
| 5 | map over photos, 25 operations | grid and strip sizes; whether this photo is the focused photo, before it, after it, or next to it |
| 6 | for each column count from 1 to 7: `groupMax`, map over rows, `prefixSum`, map over rows, `gatherIndexed` | each row's tallest photo; that height plus the gap; row tops; row centers; each photo's row top and center |
| 7 | map over photos, 19 operations | grid targets and hover |
| 8 | `countBits` | how many photos are hovered, for the cursor |
| 9 | `prefixSum`, 2 × `gatherAt` | strip left edges, and the left edges at the focused photo |
| 10 | shared stage | strip hover and the cursor |
| 11 | map over photos, 20 operations | destinations, including the hover magnet that pulls a hovered photo toward the pointer |
| 12 | 3 × `gatherAt` | the old focused photo's row top and height; the anchor photo's destination |
| 13 | shared stage | the scroll adjustment |
| 14 | map over photos, 5 operations; `countBits`; shared stage | the scroll anchor |
| 15 | shared stage | the clock and the spring step matrix |
| 16 | map over photos, 154 operations | springs and occlusion, i.e. whether the photo is on screen |
| 17 | `sum`; shared stage | active springs; "still animating"; the page height |

### What the staged gallery measured

The map stages over photos add up to 233 live operations per photo. The map stages over rows are 2 operations per row of each column count, and the shared stages are 401 operations, of which the clock and spring matrix are 248. The staged gallery builds in about 5 ms and generates 31 JavaScript functions.

The program doesn't change with the photo count. At 221, 1,000 and 10,000 photos it's still 233 operations per photo, and building plus generating JavaScript took 4 + 2 ms, 5 + 2 ms and 22 + 3 ms. The work per frame still grows with the photo count, as it does for a shader, but the program, its build time and its generated code stay the same size.

Decisions stayed exact. At 221 photos, against native index.ts, the staged gallery made 0 decision mismatches in 957,258 checks over 3,600 frames whose durations FP32 represents exactly, in 939,289 checks over 3,600 frames with microsecond timestamps, and in 126,182 checks over a 420-frame scripted trace. Against its own duplicated circuit, all 4,122,000 values of 2 random traces of 300 frames were bit-identical, i.e. every output and every written-back cell of every photo. With Brent-Kung prefix sums, it made 0 decision mismatches in 618,401 checks at 1,000 photos and in 2,408,107 checks at 10,000 photos.

## Which parts of the gallery needed reductions, and why

A computation needs a reduction when one photo's result depends on other photos' values, or when one shared result depends on every photo. Everything else stays in a map stage. The gallery's reductions:

- **The tallest photo in each row** (`groupMax`). A photo's vertical center in the grid depends on the tallest photo of its row.
- **Row tops** (`prefixSum` over row heights plus the gap). A row's top depends on the heights of every earlier row.
- **Row values back to photos** (`gatherIndexed`). Each photo reads its row's top and center at its per-item constant row index, once per column count.
- **Strip left edges** (`prefixSum` over unfocused widths plus the gap, then `gatherAt`). In the strip, a photo's left edge depends on every earlier photo's width, and photos are placed relative to the focused photo's edges, which is a read at the focused index.
- **The clicked photo** (`firstActive`). index.ts returns the first photo whose rectangle contains the pointer, and turning 221 hit bits into one index reads every photo's bit.
- **Whether any photo is hovered** (`countBits`). Hover tests the new grid targets, which don't overlap, so a map stage computes each photo's hovered bit from that photo's values alone, and only the cursor needs a count across photos.
- **The scroll anchor** (`countBits` over the first photo of each row). The anchor is the photo the page keeps in place when the layout changes. index.ts searches the leftmost column for the first photo whose bottom is more than 20% of the window below the scroll position. Row bottoms increase down the page, so the rows past that line are always the last k rows, and counting them gives the result without a search that stops early. The [loops](loops.md) section explains this "count instead of search" idea.
- **Reads at a shared index** (`gatherAt`). Scrolling back to a photo after closing the strip reads the old focused photo's row top and height, and keeping the page steady on resize reads the anchor photo's destination.
- **Whether anything is still animating** (`sum` of per-photo counts of active springs). One bit determines whether JavaScript requests another frame.

Sizes, the focus relation, grid targets and hover, destinations, the anchor predicate, springs and occlusion all stayed per photo.

## Map stages and shared values

### The problem

A per-item computation reads the item's own values and a few values that are the same for every item, e.g. every photo's hover test reads the same pointer. Written out once per item, the shared part would be copied n times.

### The familiar JavaScript

```ts
const localX = pointerX + scrollX // once
for (let card = 0; card < cards.length; card++) {
  hitBits[card] = lefts[card] <= localX && localX < lefts[card] + widths[card] ? 1 : 0
}
```

### The circuit way

A map stage is written once, and the stage's inputs mix shared values and per-item fields. From [generated-loop.ts](../examples/instancing/generated-loop.ts), which uses instanced-items' builder:

```ts
const hit = program.map(cards, 'hit test', {pointerX, scrollX, left, width}, (circuit, input) => {
  const localX = circuit.roundAffine([[input.pointerX, 1], [input.scrollX, 1]])
  return {
    bit: emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[localX, 1], [input.left, -1]])),
      aboveZero(circuit.roundAffine([[input.left, 1], [input.width, 1], [localX, -1]])),
    ], {booleanAtom: true}),
  }
})
```

### Why it works

A value is per-item only when its operation reads a per-item input, directly or through other operations. Every other operation gives the same result for every item, so the executor computes such operations once per frame before the loop over items, the way a compiler moves loop-invariant code out of a loop. The prototype's generated JavaScript for the stage above, as printed by [report.ts](../examples/instancing/report.ts), with comments added:

```js
// once per evaluation: localX = pointerX + scrollX
v[4] = (v[0] + 0) + v[1]

// once per card, over a block of up to 1,024 cards
function instance0(v, s, n, gi, gm, sgi, sgm) {
  const s4 = s[4] // localX, read once for the block
  for (let i = 0, o = 0, g = 0; i < n; i++, o += 8, g += 1) {
    v[o + 2] = (s4 + 0) - v[o + 0]                   // localX - left
    v[o + 3] = f((v[o + 0] + 0) + v[o + 1]) - s4     // left + width - localX
    v[o + 4] = Math.max(0, (f(-1099511627776 * v[o + 2]) + 0))
    v[o + 5] = Math.max(0, f(0.5 + f(-1099511627776 * v[o + 3])))
    v[o + 6] = Math.max(0, f(f(1 + f(-2 * v[o + 4])) + f(-2 * v[o + 5])))
    v[o + 7] = f((v[o + 6] + 0) + 8388609) - 8388609 // the boolean: exactly 0 or 1
  }
}
```

`f` is `Math.fround`, and every write into the Float32Array `v` rounds to FP32 as well. `v` holds one block of cards at 8 values per card: the card's 2 inputs, `left` and `width`, then its 6 computed values. The shared part is 1 operation, and the per-card part is 6.

### Cost

Let p be the operations of all map stages for one item, and s the shared operations. The program has p + s operations at any item count, and each frame runs n × p per-item operations plus s shared ones. In the gallery, p is 233 and s is 401.

The split can matter a lot. codegen's life-calendar has 27,393 grid squares, and only 63 of its 2,054 operations run once per square, while the other 1,991 run once for the whole grid ([codegen README](../../codegen/README.md)). The [executor](executor.md) section has more numbers on the split.

### When not to use a map stage

When the items don't share a program, e.g. a settings page where every control is different.

### Pitfalls

- A map stage reads only its own item and shared values. A neighbor's value needs a reduction first (see "Habits that change" below).
- A map stage that returns a shared input unchanged returns the shared value, not a per-item field, and a reduction throws while building when its input is a shared value.
- Settled items still run. The springs stage runs for every photo on every frame, e.g. 1,809 µs of a 4,106 µs frame at 10,000 photos. A step that runs the springs stage only for photos that are still moving isn't built.

## Reductions between stages

### The problem

Some results depend on other items, e.g. a row's top depends on every earlier row's height, and the clicked photo depends on every photo's hit bit.

### The familiar JavaScript

Loops that carry a value from item to item, e.g. `tallest = Math.max(tallest, height)`, `left += width + gap`, `hoverCount += hovered`, or `return i` at the first hit.

### The circuit way

Each such loop becomes one reduction call between stages. The gallery's row layout, once per column count, from gallery-staged.ts (trimmed):

```ts
const maximum = program.groupMax(sizes.sizeY2D, rowArray, rowOf[variant]!, 'row maxima')
const step = program.map(rowArray, 'row step', {maximum}, (circuit, input) =>
  ({step: circuit.roundAffine([[input.maximum, 1]], K.boxesGapY)}))
const tops = program.prefixSum(step.step, 'row tops', {bias: K.windowPaddingTop, order: prefixOrder})
const center = program.map(rowArray, 'row centers', {top: tops.before, maximum}, (circuit, input) =>
  ({center: circuit.roundAffine([[input.top, 1], [input.maximum, 0.5]])}))
const back = program.gatherIndexed({top: tops.before, center: center.center}, photos, rowOf[variant]!, 'row values back to photos')
```

`groupMax` takes the maximum over consecutive photos that share a row, into an array with one item per row. A map stage over rows adds the gap. `prefixSum` returns, for each row, the total before the row (`before`, which is the row's top) and the total through the row. Another map stage computes each row's center, and `gatherIndexed` copies each row's top and center back to its photos, reading at every photo's constant row index `rowOf`.

### Why it works

The staged executor runs each reduction as a small JavaScript loop, e.g. `firstActive` in instanced-items/executor.ts:

```ts
let found = -1
if (shared[gate] === 1) {
  for (let instance = 0; instance < input.length; instance++) {
    if (input[instance] === 1) {
      found = instance
      break
    }
  }
}
shared[index] = Math.max(0, found)
shared[present] = found >= 0 ? 1 : 0
```

Each reduction's definition also specifies the exact FP32 steps it takes, e.g. the order in which a sum adds its terms, and its lowering in the duplicated circuit takes the same steps, so both forms give the same bits. A test in instanced-items ran 30 random staged programs over every reduction kind, four evaluations each with next values written back, and the staged executor matched the duplicated circuit on every output of every item.

### The reductions and what they cost

A gather is a read of one value at a position, like `table[index]`. In a circuit, a gather is written `Σ bit[i] × value[i]` over a one-hot, and the compiler replaces that sum with one indexed read that stores no weights ([indexing](indexing.md)). A Brent-Kung network is a fixed arrangement of pairwise additions that computes every running total: an upward pass adds neighbors, then pairs of pairs, and a downward pass fills in the totals in between.

| Reduction | The JavaScript it replaces | As a loop | Lowering in the duplicated circuit, for n items |
| --- | --- | --- | --- |
| `sum`, `countBits` | `total += value` | O(n) | one sum: 1 operation, 1 layer, n stored weights |
| `prefixSum`, one item at a time | `before[i] = running; running += value` | O(n) | a chain: n operations in n layers; or wide sums: n operations in 1 layer with about n²/2 stored weights |
| `prefixSum`, Brent-Kung | the same outputs | O(n) | about 2n operations in about 2 log2 n layers |
| `firstActive` | `if (bits[i] === 1) return i` | O(n) | a tournament: about 2.7n operations in about 3 log2 n layers, e.g. 172 operations and 17 layers for 64 items with instanced-items/kit.ts's `emitFirstSetBit`, a different helper from numeric-ui-core.ts's `emitFirstActive`, which is 316 operations in 31 layers |
| `argmax` | the index of the highest score | O(n) | `emitArgmax`'s tournament: O(n) operations in O(log n) layers |
| `max`, `groupMax` | `tallest = Math.max(tallest, value)` | O(n) | a chain of maxima: 3 operations and 3 layers per item |
| `gatherAt` | `values[index]`, with index a shared value | O(1) | the index's one-hot from about n ReLUs, then one gather |
| `gatherIndexed` | `rowTops[rowOf[i]]`, with `rowOf` known while building | O(n) | direct wire references: 0 operations |
| `scatter` | `bits[i] = i === index ? 1 : 0` | O(n) | the index's one-hot, ANDed with a present bit |

In gallery-circuit.ts, the click tournament accounts for about 20 of the 61 layers.

`gatherAt`, `gatherIndexed` and `scatter` were written before numeric-ui-core.ts had `circuit.indexRead`, which reads at a runtime index, including a different index per item, in 1 operation. The staged builder and its duplicated form weren't updated to use it.

### Measured

At 10,000 photos, the slowest reduction, the strip's prefix sum, took 26 µs of a 4,106 µs frame. At 1,000 photos, every reduction took at most 2.7 µs.

### When not to use a reduction

When one item needs a runtime index into another array, e.g. each photo reading its row for the current column count. `gatherIndexed` only takes per-item constant indices, because a runtime index per photo into n rows would need an n-member one-hot per photo in the duplicated circuit. `circuit.indexRead` in numeric-ui-core.ts now reads at such an index in 1 operation, but the staged builder doesn't use it. The gallery instead keeps 7 arrays of rows, one per column count, and each photo gathers the current variant through the column count's one-hot.

### Pitfalls

- A reduction's order is part of its result (see "Accumulation order is part of the result").
- `groupMax` needs nondecreasing group constants with every group holding at least one item, e.g. the photos of row 0, then the photos of row 1.
- `gatherAt` needs an integer index within the array even when nothing is present, e.g. index 0 with a present bit of 0.

## Per-item constants: from weights to inputs

### The problem

Items differ by constants known while building, e.g. aspect ratios. A duplicated circuit writes each item's constants into that item's weights, but in a program written once, the weights are the same for every item, so the weights can't hold one item's constants.

### The familiar JavaScript

```ts
const sizeX = Math.min(boxMaxSizeX * widthFactors[i], naturalWidths[i])
```

### The circuit way

In a map stage written once, the width factor is a per-item input, so scaling by it is a product:

```ts
// gallery-circuit.ts, once per photo: widthFactor is a weight
const sizeX = circuit.affine([
  [columns.boxMaxSizeX, widthFactor],
  [circuit.reglu([], 1, [[columns.boxMaxSizeX, widthFactor]], -photo.w), -1],
])

// gallery-staged.ts, once: widthFactor and width are per-item constants, read as inputs
const scaled = circuit.multiply(input.boxMaxSizeX, input.widthFactor)
const sizeX2D = circuit.affine([[scaled, 1], [circuit.reglu([], 1, [[scaled, 1], [input.width, -1]], 0), -1]])
```

### Why it works

A weight multiplies a value by a number fixed while building, which the compiled program stores as a coefficient. A per-item input is a value like any other, so multiplying by it is a ReLU-gated product, i.e. one more operation. The two forms compute the same quantity with a different rounding step.

### Cost

About 33 more operations per photo. Expanded into one circuit at 221 photos, the staged gallery has 55,627 live operations against gallery-circuit.ts's 48,411, i.e. 7,216 more: products for per-item constants (the width factor, 1 / aspect ratio, the aspect ratio, height / width), per-photo index comparisons for the focus relation, and gathers of the 7 row variants into each photo.

### Habits that change along with the constants

**Each item's index is compared with a shared index.** gallery-circuit.ts builds the focus one-hot once, and each photo's operations read the photo's own member and its neighbors' members. In the staged gallery, a map stage compares each photo's index with the new focused index instead. For an integer d = newIndex − index, `relu(d + 1) − 2 relu(d) + relu(d − 1)` is 1 when d is 0 and 0 otherwise:

```ts
// d = newIndex - index. Integers, so every ramp below is exact.
const ramp = (offset: number) => circuit.reglu([], 1, [[input.newIndex, 1], [input.index, -1]], offset)
const equal = (offset: number) => circuit.affine([[ramp(1 - offset), 1], [ramp(-offset), -2], [ramp(-1 - offset), 1]])
const member = emitAnd(circuit, [equal(0), input.newPresent])
const blurred = emitAnd(circuit, [circuit.affine([[equal(-1), 1], [equal(0), 1], [equal(1), 1]]), input.newPresent])
```

The neighbor blur becomes "this photo is at most 1 away from the focused photo", so no photo's operations read another photo's wire, at the cost of a few operations per photo.

**Neighbors come from reads at constant indices.** When an item does need a neighbor's value, a reduction reads the value at a per-item constant index. In the staged IndirectOS, pressing Previous focuses the photo before the focused one, so `gatherIndexed` reads, for each photo, the focus bit of the photo after it (`focusAfter` in indirect-os-staged.ts) at the per-item constant index `(index + 1) % 12`, and a photo becomes focused when Previous is pressed and that bit is 1.

**Runtime layout choices become variants plus a gather.** A photo's row depends on the column count, which is only known at runtime, while `gatherIndexed` only takes constant indices. So the staged gallery keeps one array of rows per column count, 7 in all, and each photo gathers its row values through the column count's one-hot.

### When not to use per-item constants

For a handful of items whose constants sit in lookup tables, the duplicated circuit can be smaller, as IndirectOS showed (next section).

### Pitfalls

- A product rounds at a different point than a weight, so values can differ from the duplicated circuit's. IndirectOS's thumbnail falloff multiplies `f32(−0.22)` by an integer distance, where photo-gallery.ts rounds `−0.22 × k` once as a weight, and thumbnail centers moved by up to 0.0012 px.
- A stage boundary can change the arithmetic. numeric-ui-core.ts merges a small sum (fewer than 4 terms, not written with `roundAffine`) into the operations that read it, and staged.ts rebuilds such a sum from its terms when a later stage reads it, so the later stage merges the sum the same way. In staged.test.ts's two-stage example, turning the rebuild off changed 252 of 600 values; on the gallery's scripted trace, only 217 of 2,885,400 values changed, by at most 0.00003 px, and no decision changed.

## Why staging IndirectOS made it bigger

IndirectOS has 4 windows, 4 dock items and 12 photos. instanced-items/indirect-os-staged.ts writes those as three arrays of items, with 7 shared stages, 8 map stages and 17 reductions. Over a 220-frame session of dragging, resizing, closing and reopening windows and opening photos, it made 0 decision mismatches against window-manager.ts in 94,380 values, and 98.8% of the values were bit-identical; only thumbnail centers and their velocities differed, by up to 0.0012 px and 0.013 px/s. But expanded into one circuit, the staged version is larger:

| Circuit | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: |
| window-manager.ts | 5,253 | 192 | 11,598 |
| staged program, duplicated | 6,282 | 215 | 13,346 |

On September 15, 2026, window-manager.ts moved to host-timed springs and `emitCompare` hit tests, at 3,654 live operations, 124 layers and 7,890 stored weights, so instanced-items now compares with codegen's copy of the pre-change IndirectOS.

With so few items, writing each item out costs little, and photo-gallery.ts keeps per-item lookup tables in weights. Each thumbnail's offset from the focused photo is a weighted sum over all 12 focus bits, with the table entry as the weight, so reading the table costs no operation:

```ts
// photo-gallery.ts, inside a loop over thumbnails while building
for (let focusedItem = 0; focusedItem < itemCount; focusedItem++) {
  let offset = item - focusedItem
  if (offset > itemCount / 2) offset -= itemCount
  if (offset < -itemCount / 2) offset += itemCount
  const visibleOffset = Math.abs(offset) < 5 ? offset : 0
  offsetTerms.push([focus[focusedItem]!, visibleOffset])
  distanceTerms.push([focus[focusedItem]!, Math.abs(offset)])
}
const offset = circuit.affine(offsetTerms)
```

In a thumbnail program written once, the item's index isn't a constant while building. So the staged version computes the wrapped offset `index − focusIndex` at runtime, turns the offset into 13 equality bits (one per offset from −6 to 6), and reads each table through those bits. With those lookups, the map stages over photos come to 270 operations per photo. Likewise, the frontmost window under a press became a maximum over per-window keys (the window's stacking rank + 1 when the press hits the window, else 0), and each window's key is compared with that maximum. In all, the staged IndirectOS has 254 shared operations, 681 per window, 19 per dock item and 270 per photo.

So instancing helps most when the item count is large, or not known while building. For a handful of items whose constants sit in lookup tables, the duplicated circuit can be smaller. The staged executor did run IndirectOS faster, about 9 µs against 59 µs through `evaluateTensor`, but most of that difference comes from generated JavaScript: codegen measured about 3 µs for the flat IndirectOS circuit as generated JavaScript.

## Accumulation order is part of the result

### The problem

Every FP32 addition rounds, so adding the same numbers in a different order can give a different result. For example, 2^24 + 1 isn't an FP32 value, so `Math.fround(Math.fround(16777216 + 1) + 1)` is 16,777,216, while `Math.fround(16777216 + Math.fround(1 + 1))` is 16,777,218. A reduction whose definition doesn't specify its order doesn't specify what it computes.

### The familiar JavaScript

`running += value` in item order, in float64, where the rounding is too small to see at UI sizes.

### The circuit way

Each reduction's definition specifies its order as the FP32 steps it takes, and both its executor loop and its lowering take those steps. For example, a prefix sum added one item at a time is `p = fround(start)`, then for each item `before[i] = p; p = fround(p + values[i])`. A maximum in item order is `m = values[0]`, then `m = fround(values[i] + max(0, fround(m − values[i])))`. The staged executor matched its duplicated circuit bit for bit because both follow the same steps.

### Maxima change with the order too

A maximum built from ReLUs isn't always exactly one of its inputs in FP32. `emitMaximum(a, b)` computes `b + relu(a − b)`, and when a and b are far apart, `a − b` rounds, and adding b back can land one FP32 step away from a. So combining the same heights in a different order can give different bits. [max-order.ts](../examples/instancing/max-order.ts) combines fractional heights (zoom × natural height + 52 px) in item order, like the staged `max` reduction, and as a balanced tree, like gallery-circuit.ts's `emitMaximumTree`. Over 500 random trials per height count:

| Heights | Item order | Tree | Trials where the two orders differ | Trials where item order differs from `Math.max` |
| ---: | --- | --- | ---: | ---: |
| 7 | 18 operations, 18 layers | 18 operations, 9 layers | 19 | 29 |
| 64 | 189 operations, 189 layers | 189 operations, 18 layers | 104 | 107 |
| 221 | 660 operations, 660 layers | 660 operations, 24 layers | 125 | 130 |

The largest difference was 0.000061 px, which is one FP32 step for values between 512 and 1,024 px. On integer heights, both orders equal `Math.max`, and the test checks both circuits against their loops bit for bit.

### The same gallery, a different order

gallery-circuit.ts and the staged gallery compute the same layout with different orders, e.g. gallery-circuit.ts puts all k gaps into the bias of the k-th strip total (52 × k px) and then adds k widths, while the staged gallery adds the gap into each width first (width + 52 px). instanced-items copied all 4,004 cells from gallery-circuit.ts into the staged program before each frame, so each frame compares one evaluation from identical state. 88.2% of values were bit-identical on the scripted trace, and 86.7% and 86.1% on the two sets of 6 random traces. Destinations differed by at most 0.063 px. The only decision that differed was "still animating", in 51 and 32 of 3,600 frames, for springs within a few 10^-4 px of the 0.01 px settle threshold.

### Why Brent-Kung prefix sums were more precise at 10,000 photos

At 10,000 photos the page is millions of pixels tall and the strip millions of pixels long, and FP32 values there are 1/8 to 1/2 px apart.

A running total added one item at a time adds a few hundred pixels to a total that has already passed a million pixels, and every addition rounds. Thousands of those rounded additions can round in the same direction. In the gallery's random traces at 10,000 synthetic photos, one-at-a-time prefix sums moved row tops by up to 40.7 px after about 5,000 rows, and the last photo's strip left edge by 472.8 px (seed 7001, at 2560 × 1400). In the other trace (seed 7000, at 1440 × 900), decisions flipped: first the cursor over a photo near 4.4 million px, then at frame 98 the anchor search picked row start 6,208 where index.ts picked 6,206, and the trace diverged, with 74 decision mismatches in 2,407,967 checks.

The Brent-Kung network computes the same running totals by adding pairs. The upward pass stores the sum of each block of 2, 4, 8, ... items at the block's last position, and the downward pass fills in the positions in between from those block sums:

```ts
// instanced-items/executor.ts, trimmed. inclusive starts as a copy of the values,
// and writing into a Float32Array rounds each addition to FP32.
let span = 1
for (; span < count; span *= 2) {
  for (let index = 2 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
}
for (span = span / 4; span >= 1; span /= 2) {
  for (let index = 3 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
}
```

Most of the network's additions combine sums of similar size, e.g. two rows, then two pairs of rows, and only the last few levels add values at the total's size. So the rounding error grows with the number of levels instead of the number of items. With Brent-Kung sums at 10,000 photos, the staged gallery made 0 decision mismatches in 2,408,107 checks, and destinations stayed within 3.3 px (x) and 1.1 px (y) of index.ts's float64 values. At 1,000 photos, destinations were within 4.5 px of index.ts with one-at-a-time sums and within 0.21 px with Brent-Kung, with 0 decision mismatches in 618,401 checks for both. Here the order that can run in parallel was also the more precise order.

[prefix-precision.ts](../examples/instancing/prefix-precision.ts) isolates the effect. The script computes strip widths the way the gallery's strip does at a 1440 × 900 window, for synthetic photos with Midjourney's aspect ratios, and compares FP32 running totals with float64 totals of the same FP32 widths. The table shows the largest distance over all running totals:

| Photos | Strip length | One addition at a time | Brent-Kung |
| ---: | ---: | ---: | ---: |
| 221 | 146,116 px | 0.086 px | 0.017 px |
| 1,000 | 655,422 px | 2.138 px | 0.099 px |
| 10,000 | 6,509,010 px | 178.324 px | 1.400 px |

Both orders give exact totals for integer widths, which the test checks with 10,000 integer widths.

### Cost

As loops, both orders are O(n). Lowered into a circuit, a chain is n operations in n layers, and Brent-Kung is about 2n operations in about 2 log2 n layers.

### When not to use Brent-Kung

When a JavaScript reference that adds one item at a time must match bit for bit on fractional values. Use a chain or wide sums there.

### Pitfalls

- Switching the order changes values at any size. On the 221-photo scripted trace, 90.7% of values were bit-identical between the two orders, and strip destinations moved by up to 0.164 px, with no decision changed.
- Decisions that compare positions inherit order differences, e.g. springs right at the settle threshold.
- Even with Brent-Kung sums, destinations far down a 10,000-photo page were up to 3.3 px from index.ts's float64 values. Positions there are 1/8 to 1/2 px apart, and gallery-circuit.ts's declared ±2^22 px range had to become ±2^24 px.

## How a staged program runs

The same staged program runs through three executors, and in every comparison the prototype ran, all three gave bit-identical results.

### The duplicated circuit, as the reference

instanced-items/expand.ts copies each shared stage once and each map stage once per item, operation by operation, and lowers each reduction into operations that take the reduction's stated FP32 steps, e.g. `firstActive` into a tournament, and a one-at-a-time prefix sum into a chain or wide sums. The duplicated circuit exists for comparisons and size measurements. A test checks that every item's copy of each stage has exactly the stage's live operations.

### Generated JavaScript, one loop per stage

instanced-items/executor.ts runs shared stages as generated JavaScript, and each map stage as generated JavaScript with one loop over items. Fields are struct-of-arrays columns, so a stage reads its per-item inputs from Float32Arrays and writes its outputs into Float32Arrays that later stages read. The part of a map stage that reads no per-item input runs once per frame, before the loop (see "Map stages and shared values"). A map stage's per-item part becomes generated functions of at most 128 compiled operations each, and each function loops over a block of up to 1,024 items (instanced-items/columns.ts). Reductions are plain JavaScript loops.

Keeping generated functions small is the fix codegen found for JavaScriptCore's function size limit; the duplicated gallery instead became thousands of distinct functions that each had to warm up.

Measured on a mid-animation frame (photo 40 open, five frames in), µs per evaluation, with Brent-Kung prefix sums in every circuit, on a laptop shared with a dozen other agents (load average about 10), Bun 1.4.0:

| Photos | 221 | 1,000 | 10,000 |
| --- | ---: | ---: | ---: |
| staged executor | 65 µs | 310 µs | 4,106 µs |
| duplicated circuit, executor | 546 µs | 2,569 µs | 43,027 µs |
| index.ts natively | 21 µs | 100 µs | 3,055 µs |

At 10,000 photos, the slowest steps of the staged executor were springs and occlusion (1,809 µs), destinations (539 µs), grid targets (538 µs) and sizes (471 µs). In Chrome at 10,000 photos, a frame (evaluation, DOM writes and the on-screen stats) took 12 to 19 ms at the median in most measurements, and about 4 ms in one part of the session, for reasons not found.

### The GPU for map stages, with a readback per stage

instanced-items/gpu-executor.ts replaces a map stage's loop with a compute shader: a GPU program that runs the same function for every element of a buffer in parallel, here written in WGSL, WebGPU's shading language. Shared stages, each map stage's shared part, and every reduction stay on the CPU. A stage goes to the GPU when its per-item part has at least 8 compiled operations, so 5 of the gallery's 6 per-photo stages do.

The WGSL for the hit test stage above, as printed by report.ts, trimmed (without the buffer declarations) and with comments added:

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
let i: u32 = id.x;
if (i >= params.count) {
return;
}
let source_base: u32 = i * 2u;
let output_base: u32 = i * 1u;
let lowest: f32 = shared_values[11u];
let s4: f32 = shared_values[4u];                   // localX, computed on the CPU
let v0: f32 = instance_sources[source_base + 0u];  // this card's left
let v1: f32 = instance_sources[source_base + 1u];  // this card's width
let v2: f32 = max(s4 - v0, lowest);
let v3: f32 = max(max(v0 + v1, lowest) - s4, lowest);
let v4: f32 = max(0.0f, ((-0x1.000000p40f) * v2));
let v5: f32 = max(0.0f, max(0x1.000000p-1f + ((-0x1.000000p40f) * v3), lowest));
let v6: f32 = max(0.0f, max(max(1.0f + ((-2.0f) * v4), lowest) + ((-2.0f) * v5), lowest));
let v7: f32 = select(0.0f, 1.0f, v6 >= 0.5f);
instance_outputs[output_base + 0u] = v7;
}
```

The GPU runs `main` once per card, in parallel, with `i` as the card's index.

Each `max(x, lowest)` is a guard: `lowest` is the lowest FP32 value, loaded from a buffer, so the shader compiler can't prove the `max` does nothing, and can't fuse a product into a sum or reorder additions across it, while for every finite x the `max` returns x unchanged. `select(0.0f, 1.0f, v6 >= 0.5f)` equals the boolean operation for every score between 0 and 1.

For every GPU stage, every frame, the executor packs the per-item inputs into one buffer, uploads the buffer, dispatches the shader, reads the outputs back into CPU memory (a readback, which waits on `mapAsync`), and unpacks the outputs into columns. Because the gallery alternates map stages with CPU reductions, this round trip happens once per stage.

The results were exact. Comparing every stored value with the CPU executor every frame over the first frames of a 220-frame session, 0 of 75,229,020 values differed through wgpu (Deno) at 10,000 photos over 60 frames, and 0 of 25,076,340 through Dawn (Node) over 20 frames. But the round trips made the GPU pipeline slower than the CPU executor. Through Dawn, a frame took 2.2 ms against 0.80 ms on the CPU at 221 photos, 2.6 ms against 0.59 ms at 1,000, and 12.2 ms against 9.1 ms at 10,000. Through Deno, each readback waited about 15 ms, so frames took 74 to 78 ms. Keeping fields on the GPU would need the reductions on the GPU too, e.g. counts and the first set bit as parallel reductions, and Brent-Kung prefix sums as GPU passes. GPU reductions aren't built.

## Cost in big-O terms

Let n be the item count, p the operations of all map stages for one item, and s the shared operations.

| | Duplicated circuit | Staged program |
| --- | --- | --- |
| Program size, build time, memory | O(n × p + s), plus each reduction's lowering, e.g. n²/2 stored weights for wide prefix sums | O(p + s), e.g. 233 operations per photo and 22 ms to build at 10,000 photos |
| Work per frame | O(n × p + s) plus the lowerings | O(n × p + s) plus O(n) per reduction |
| Depth | the stages' layers plus each lowering's layers, e.g. 80 layers at 10,000 photos with Brent-Kung sums, and 10,039 layers with chain sums | on a parallel executor, a map stage's own layers, independent of n, e.g. 13 layers for springs and occlusion; reductions would need parallel forms with O(log n) passes, which aren't built |

Build time and memory follow the operation count, e.g. 4.7 s and about 2 GB of heap for the duplicated circuit's 2.57 million operations.

## A runnable example: a row of cards

[examples/instancing](../examples/instancing/) has a row of cards written three ways: plain JavaScript loops, a duplicated circuit, and a staged program. Cards are laid out left to right with a gap, each card is centered vertically on the tallest card, and the first card under the pointer is hovered. A negative gap makes neighboring cards overlap, so "first" matters.

- [cards-types.ts](../examples/instancing/cards-types.ts): the inputs, outputs and declared ranges.
- [cards-reference.ts](../examples/instancing/cards-reference.ts): the plain loops.
- [cards-duplicated.ts](../examples/instancing/cards-duplicated.ts): before, one circuit with each card written out.
- [map-stage.ts](../examples/instancing/map-stage.ts) and [cards-staged.ts](../examples/instancing/cards-staged.ts): after, three map stages with three reductions between them.
- [bits.ts](../examples/instancing/bits.ts): the exact comparison bits both circuits use, this folder's own helpers that end in a boolean atom instead of `emitCompare` (see [comparisons](comparisons.md)).
- [max-order.ts](../examples/instancing/max-order.ts) and [prefix-precision.ts](../examples/instancing/prefix-precision.ts): the accumulation order numbers above.
- [generated-loop.ts](../examples/instancing/generated-loop.ts): a hit test stage run through instanced-items' executor, and its generated JavaScript and WGSL.
- [card-traces.ts](../examples/instancing/card-traces.ts), [instancing.test.ts](../examples/instancing/instancing.test.ts) and [report.ts](../examples/instancing/report.ts): random inputs, the checks, and the numbers. From the repository root, `bun test lab/ui-exploration/guide/examples/instancing` runs 6 tests in about 0.15 s, and `bun lab/ui-exploration/guide/examples/instancing/report.ts` runs in under a second.

### The plain loops

```ts
const widths = cards.map(card => card.naturalWidth * input.zoom)
const heights = cards.map(card => card.naturalHeight * input.zoom)

let tallest = heights[0]!
for (const height of heights) tallest = Math.max(tallest, height)

const lefts: number[] = []
let left = input.rowLeft
for (const width of widths) {
  lefts.push(left)
  left += width + input.gap
}

const tops = heights.map(height => input.rowTop + (tallest - height) / 2)

let hoveredIndex: number | null = null
if (input.pointerPresent) {
  for (let index = 0; index < cards.length; index++) {
    if (contains(index)) {
      hoveredIndex = index
      break
    }
  }
}
```

### Before: every card written out

The builder loops over cards and appends each card's operations. A card's natural size is a weight, and the three loops across cards become a chain of maxima, a chain of additions, and a tournament:

```ts
const widths = cards.map(card => circuit.affine([[cell.zoom, card.naturalWidth]]))
const heights = cards.map(card => circuit.affine([[cell.zoom, card.naturalHeight]]))
const steps = widths.map(width => circuit.roundAffine([[width, 1], [cell.gap, 1]]))

let tallest = heights[0]!
for (let index = 1; index < cards.length; index++) tallest = emitMaximum(circuit, tallest, heights[index]!)

const lefts: Wire[] = []
let running = cell.rowLeft
for (const step of steps) {
  lefts.push(running)
  running = circuit.roundAffine([[running, 1], [step, 1]])
}

const tops = heights.map(height => circuit.roundAffine([[cell.rowTop, 1], [tallest, 0.5], [height, -0.5]]))
const hits = cards.map((_, index) => emitAllChecks(circuit, [
  atLeastZero(circuit.roundAffine([[cell.pointerX, 1], [lefts[index]!, -1]])),
  aboveZero(circuit.roundAffine([[lefts[index]!, 1], [widths[index]!, 1], [cell.pointerX, -1]])),
  atLeastZero(circuit.roundAffine([[cell.pointerY, 1], [tops[index]!, -1]])),
  aboveZero(circuit.roundAffine([[tops[index]!, 1], [heights[index]!, 1], [cell.pointerY, -1]])),
]))
const hovered = emitFirstActive(circuit, cell.pointerPresent, hits)
```

### After: three map stages and three reductions

Each stage is written once. The natural size is a per-card input, so scaling by the zoom is a product, and the hovered stage compares each card's own index with the shared hovered index:

```ts
const sizes = buildMapStage('sizes',
  {zoom: sharedRanges.zoom, gap: sharedRanges.gap},
  {naturalWidth: [1, 4096], naturalHeight: [1, 4096]},
  (circuit, shared, card) => {
    const width = circuit.multiply(shared.zoom, card.naturalWidth)
    const height = circuit.multiply(shared.zoom, card.naturalHeight)
    return {width, height, step: circuit.roundAffine([[width, 1], [shared.gap, 1]])}
  })

const placement = buildMapStage('placement and hit test',
  {rowTop: sharedRanges.rowTop, tallest: [0, 8192], pointerX: sharedRanges.pointerX, pointerY: sharedRanges.pointerY},
  {left: [-(2 ** 24), 2 ** 24], width: [0, 8192], height: [0, 8192]},
  (circuit, shared, card) => {
    const top = circuit.roundAffine([[shared.rowTop, 1], [shared.tallest, 0.5], [card.height, -0.5]])
    const hit = emitAllChecks(circuit, [
      atLeastZero(circuit.roundAffine([[shared.pointerX, 1], [card.left, -1]])),
      aboveZero(circuit.roundAffine([[card.left, 1], [card.width, 1], [shared.pointerX, -1]])),
      atLeastZero(circuit.roundAffine([[shared.pointerY, 1], [top, -1]])),
      aboveZero(circuit.roundAffine([[top, 1], [card.height, 1], [shared.pointerY, -1]])),
    ])
    return {top, hit}
  })

const hover = buildMapStage('hovered',
  {hoveredIndex: [0, maximumCards - 1], hoverPresent: [0, 1]},
  {index: [0, maximumCards - 1]},
  (circuit, shared, card) => {
    const isHoveredIndex = emitIntegerIsZero(circuit, [[shared.hoveredIndex, 1], [card.index, -1]])
    const hovered = circuit.reglu([], 1, [[isHoveredIndex, 1], [shared.hoverPresent, 1]], -1)
    circuit.assumeRange(hovered, 0, 1)
    return {hovered}
  })
```

Between the stages, the reductions are loops that call `Math.fround` after every step, in card order:

```ts
const sized = runMapStage(program.sizes, {zoom: input.zoom, gap: input.gap}, {naturalWidth, naturalHeight}, count)
const tallest = maximumInOrder(sized.height)
const lefts = prefixSumsInOrder(sized.step, input.rowLeft)
const placed = runMapStage(program.placement,
  {rowTop: input.rowTop, tallest, pointerX: input.pointerX, pointerY: input.pointerY},
  {left: lefts, width: sized.width, height: sized.height},
  count)
const hit = firstActive(placed.hit, input.pointerPresent ? 1 : 0)
const hovered = runMapStage(program.hover, {hoveredIndex: hit.index, hoverPresent: hit.present}, {index}, count)
```

map-stage.ts is a simplified runner: it compiles each stage once with `createTensorEvaluator` and evaluates the compiled stage once per card. The prototype's executor generates one loop per stage instead, which generated-loop.ts shows.

### What the example measures

The staged program has 18 live operations per card at any card count: 3 for sizes (2 layers), 11 for placement and the hit test (5 layers), and 4 for the hovered bit (2 layers).

The duplicated circuit, with chain prefix sums and fractional natural sizes (so the builder, which reuses an operation when the same expression is appended twice, never merges two cards' operations):

| Cards | Live operations | Per card | Layers | Stored weights |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 177 | 22.1 | 44 | 340 |
| 64 | 1,465 | 22.9 | 227 | 2,836 |
| 512 | 11,769 | 23.0 | 1,586 | 22,804 |
| 4,096 | 94,201 | 23.0 | 12,353 | 182,548 |

Building and compiling the 4,096-card circuit took about 200 ms. Per card, the duplicated circuit has the same 14 operations for sizes, placement and the hit test as the staged program, plus 3 for each step of the maximum chain, 1 for each addition to the running left edge, and about 5 for the tournament. The duplicated circuit needs no hovered stage, because the tournament's output bits are the hovered bits.

The duplicated circuit's depth grows by about 3 layers per card, because the tallest-card loop becomes a chain of maxima, each 3 operations deep. With wide sums, the operation count and depth stay about the same (1 more operation), but stored weights grow as n²/2: 153,110 at 512 cards and 2,185,347 at 2,048 cards.

In this example the per-card constants only scale `zoom`, and the scaled widths and heights are outputs, so both versions store one operation per scaled size. In the gallery, constants sat inside larger sums, which is where the staged form paid about 33 extra operations per photo.

The tests check:

- The staged and duplicated versions give bit-identical outputs on fractional inputs: 320 random frames at 1, 2, 7 and 64 cards, with both prefix sum lowerings and pointers aimed at card edges and interiors, compared 30,560 values with 0 differing. 194 frames had a hovered card, and 18 had the pointer over two or more cards.
- Both versions equal the plain loops on exactly representable inputs (integer natural sizes, zoom in eighths, integer gap and origin, quarter-pixel pointers), over 180 frames at 1, 5 and 64 cards. On such inputs FP32 holds every intermediate value exactly, so float64 JavaScript computes the same numbers.
- The sizes above; that Brent-Kung prefix sums drift at least 10 times less than one-at-a-time sums at 10,000 strip widths; that each maximum circuit equals its loop, the two orders differ on some fractional heights, and both equal `Math.max` on integers; and that instanced-items' executor runs the hit test stage with 1 shared operation and 6 per card, and its hit bits and first hit equal plain loops over 180 frames with quarter-pixel pointers.

## What's already here, and what isn't: transformers

A transformer is the neural network architecture behind today's large language models. It keeps one vector of numbers per token, where a token is one element of the input, e.g. a piece of a word, and it runs every token's vector through a stack of blocks. Each block has two parts:

- An MLP (multi-layer perceptron): a few matrix multiplications with a ReLU-like function between them, applied to each token's vector on its own, with the same weights for every token. That's a map stage.
- Attention: each token computes a query vector, and every token computes a key vector and a value vector. A token's output is a weighted sum of all tokens' value vectors, where the weights come from a softmax over the dot products of the token's query with every key. Softmax turns scores into positive weights that add up to 1, `exp(score[j]) / Σ exp(score[k])`. That's a reduction across tokens, with one query per token.

Soft attention is attention with those fractional weights, where many tokens contribute to one output. Hard attention reads only the best match, i.e. the weights are a one-hot, which makes a hard attention read a gather. Causal attention lets each token attend only to earlier tokens.

| Transformer part | Nearest thing in these prototypes | Present? |
| --- | --- | --- |
| The same MLP for every token | map stages, e.g. 233 operations per photo | yes, with weights written by hand |
| A token's position | the per-item constant `index`, e.g. each photo's program computing `[newIndex − index = 0]` | yes, as a constant |
| Hard attention by position | `gatherAt`, e.g. the strip left edge at the focused photo | yes |
| Hard attention by content, with one query | `firstActive` over hit bits, where the pointer is the query and each photo's rectangle a key; IndirectOS's frontmost window as a `max` over per-window keys | yes |
| Pooling, i.e. a maximum or a sum over tokens | `max`, `groupMax`, `sum`, `countBits` | yes |
| Causal attention with equal weights, which averages earlier tokens | `prefixSum`: each item's total is the sum of the earlier items, with every weight 1 and no normalization | partly |
| Soft attention: fractional weights computed at runtime from query-key scores | none | no |
| One query per token, i.e. n × n scores | none: every reduction has one shared query or a constant index, so each reduction is O(n) work | no |
| Learned weights | none: every weight is written by hand | no |

The structure lines up: a staged program alternates per-item programs with computations across items, and a transformer alternates per-token MLPs with attention across tokens. What a transformer adds is the part that learns where to read: queries and keys computed from the inputs by learned weights, with soft weights while training. The [indexing](indexing.md) section builds soft and hard attention over positions in a circuit, trains a query index with a softmax read in a toy, and proposes a small next experiment on a UI decision.

## When not to use instancing

- A handful of items with per-item lookup tables, like IndirectOS's 12 thumbnails. Writing them out costs little, and the tables stay weights.
- Items that don't share a program, e.g. a settings page where every control is different.
- A per-item runtime index into another array, e.g. each photo reading its row for the current column count, unless a few variants plus a gather cover every case.
- When the single fixed numeric program is the point. A staged program runs as a list of stages and loops, not as one list of layers where each layer is one sparse matrix multiplication. The duplicated circuit remains the single-program form, and the definition the executors are checked against.

## Open questions

- Reductions on the GPU: counts and the first set bit as parallel reductions, Brent-Kung prefix sums as GPU passes with the max guard, gathers as indexed reads inside the next shader, and grouped maxima over at most 7 photos per row. Then fields could stay on the GPU, and a frame could become a few dispatches plus one readback of the visible photos.
- Per-item weight columns: an operation whose coefficient comes from a per-item column instead of a product would keep the duplicated circuit's weights, and remove the gallery's extra operations per photo.
- Runtime indices across arrays, e.g. rows for the current column count, with a lowering that chooses among a few variants, or one `circuit.indexRead` per item, which numeric-ui-core.ts has had since September 14, 2026.
- Precision past a million pixels: prefix sums anchored at the focused photo or at the scroll anchor would keep onscreen positions small at any photo count, and a two-part sum (whole pixels and the fraction) would keep the fraction precise.
- Skipping settled photos: a step that runs the springs stage only for photos still moving, so the cost follows the moving photos.
- Why a frame at 10,000 photos in Chrome (evaluation, DOM writes for 12 to 16 visible photos, and the on-screen stats) took 12 to 19 ms at the median in most measurements and about 4 ms in one part of the session, when the staged executor's evaluation alone took 4,106 µs in Bun. The DOM writes took 36 to 214 µs.

## Files

- Prototype: [instanced-items](../../instanced-items/README.md) (gallery-circuit.ts, the duplicated circuit, [merged from gallery](../../instanced-items/README.md#merged-from-gallery-september-16-2026); staged.ts, gallery-staged.ts, indirect-os-staged.ts, expand.ts, executor.ts, gpu-executor.ts, wgsl.ts).
- Source: lab/trace-compiler/fixtures/index.ts.txt, photo-gallery.ts and window-manager.ts.
- Examples: [examples/instancing](../examples/instancing/).
