# Patterns

These constructions replace a familiar loop. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item. A pattern adds no instruction: some patterns are packaged as builder functions, e.g. `emitFirstActive` and `emitApplySpringMatrix`, and others are written by hand. Constructions that replace one expression, e.g. `a >= b` or `x / y`, are in [expressions.md](expressions.md), and choices that change what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, are in [behavior-choices.md](behavior-choices.md). Most patterns rely on inputs that the host quantizes, e.g. pointer coordinates in 1/64 px, which the guide glossary's ["The program and the host"](../lab/ui-exploration/guide/README.md#the-program-and-the-host) explains.

Costs count operations, the total work of one evaluation, and layers, the longest chain of operations that must run one after another. n is the item count, k the number of steps or events, S the number of states, L the number of line slots, C the number of candidates, and K a number of DOM slots fixed while building. Sizes come from each entry's long form and test. The long forms, in [lab/ui-exploration/guide/patterns](../lab/ui-exploration/guide/patterns/README.md), quote the concrete demo code, and `bun test lab/ui-exploration/guide/examples/patterns` runs every pattern's test.

On today's CPU executor, the time of an evaluation follows the operations more than the layers while each layer holds many operations, e.g. regex-search's programs took 8 to 14 µs per 1,000 live operations with 1,026 to 8,190 layers, which is why several entries below say to keep the loop. Each layer also adds work of its own: `executeTensorProgram` copies the values that the layer's operations read into an input buffer, multiplies them by the layer's sparse weights, and copies the results into the buffer of values. For example, in Bun on an Apple M5 Max on September 17, 2026, the same 16,384 sums of two terms took about 90 µs in 64 layers, 97 µs in 1,024 layers and 250 µs in 16,384 layers, about 10 µs per 1,000 layers. Until commit 093650b that day, `executeTensorProgram` also created an array view per layer, and the same probe measured about 35 µs per 1,000 layers, e.g. 672 to 709 µs in 16,384 layers. So removing operations by adding layers may not save time, e.g. at about 35 µs per 1,000 layers, json-highlighter's running count of hits removed 2,554 operations and raised the layers from 574 to 1,043, and an evaluation went from 141 to 148 µs, a comparison that hasn't been measured again since ([json-highlighter, what got awkward](../lab/json-highlighter/README.md#what-got-awkward)).

## Why a tree gives the loop's answer

A loop that visits parts one at a time is a chain, n layers deep for n parts. Several entries below combine parts in pairs, then pairs of pairs, so the longest chain grows like log2 n instead. The tree gives the loop's answer when the combining step gives the same result however the parts are grouped: combining a with b, and then the result with c, gives what combining a with the combination of b and c gives. E.g. "the left group's first hit if the left group has one, otherwise the right group's" returns the first hit among a, b and c in either grouping, and so does "the larger score, and the left one on a tie" for the first highest score. For a state machine, combining two events' tables means "the earlier event, then the later event", which any grouping of three events also means.

Whether the grouping can change a bit depends on what the combining step computes:

- Choosing a candidate never computes a new number. The step passes one candidate's values along, so every grouping returns the same bits, as long as every comparison is exact. `emitArgmax`'s comparison isn't exact for right scores between about 1e-7 and 2e-7 larger than the left score, and inside that band its tree can pick a different candidate from the loop ([the highest score so far](#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far)).
- Sums and products round in FP32, so the grouping is part of the result. With row heights 229, 167.4, 208.5 and 194.4 px, the loop's content height is 799.300048828125, while adding in pairs gives 799.2999877929688, one FP32 step lower. Integers below 2^24, and multiples of a power-of-two grid while totals stay small, add exactly in any grouping, which is when [running totals](#running-totals) as a tree match the loop bit for bit. A spring's matrix power built by the circuit differs from JavaScript's squaring in its last bits for the same reason.
- Tables of integer states or positions, combined with index reads, copy integers without rounding, so [a state machine's tables](#a-state-machine-over-queued-events) and [links followed by doubling](#following-links-one-at-a-time) give the same bits in any grouping.

## Index

| Familiar code | Size of the circuit version, against the loop |
| --- | --- |
| [`findIndex` when the test flips once along the items](#findindex-when-the-test-flips-once-along-the-items) | 195 operations in 3 layers at 64 rows, against 447 in 34 for a tree |
| [`findIndex` when passing items can be anywhere, and keeping the best score so far](#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far) | 316 operations in 31 layers at 64 candidates, against 127 in 127 for the loop |
| [Comparing each item's index with the selected index](#comparing-each-items-index-with-the-selected-index) | one sum, then a few operations per item, e.g. 4 in 2 layers |
| [Build every option, score each, and keep the best](#build-every-option-score-each-and-keep-the-best) | every option's operations plus the pick, e.g. 114 operations in 25 layers for 3 layouts |
| [Running totals](#running-totals) | 2,036 operations in 18 layers at 1,024 rows, against 1,023 in 1,023 |
| [A linear step repeated a runtime number of times](#a-linear-step-repeated-a-runtime-number-of-times) | 14 operations in 3 layers per spring at any step count |
| [A state machine over queued events](#a-state-machine-over-queued-events) | 897 operations in 10 layers at 64 events, against 129 in 65 |
| [A loop whose decision needs later input](#a-loop-whose-decision-needs-later-input) | two passes of one step per position, e.g. 13,413 operations in 1,026 layers for an 8-state pattern over 256 code points |
| [A stack of one bit per level](#a-stack-of-one-bit-per-level) | 5 operations per position after the depth, e.g. 2,569 at 512 positions |
| [Following links one at a time](#following-links-one-at-a-time) | 342 operations in 7 layers at 63 segments and 32 line slots, against 94 in 32 |
| [`items.sort(compare)`](#itemssortcompare) | 4,096 operations in 3 layers at 64 items |
| [`items.filter(isVisible).slice(0, K)` into K DOM nodes](#itemsfilterisvisibleslice0-k-into-k-dom-nodes) | 7,824 operations in 57 layers for 1,000 items into 20 DOM slots |
| [A loop over items that mixes per-item work with values carried to the next item](#a-loop-over-items-that-mixes-per-item-work-with-values-carried-to-the-next-item) | the per-item work, once, at any item count |
| [Growing and shrinking children with min and max](#growing-and-shrinking-children-with-min-and-max) | 784 operations in 9 layers at 64 children |
| [A layout function of one runtime number](#a-layout-function-of-one-runtime-number) | 2 operations per threshold, in 3 layers |
| [A loop over data that rarely changes](#a-loop-over-data-that-rarely-changes) | 1 operation per read at any table size |

## Searching and choosing

Each item's test or score is computed in the same layers, and one small structure over the results picks one item: a count when the results read 1...1 0...0, or a tree when they can be in any order.

### `findIndex` when the test flips once along the items

A loop stops at the first item that fails the test. When the test passes for a run of items at the start and fails for every item after it, the number of items that pass is the index the loop returns.

```js
const pointedRow = rowBottoms.findIndex(rowBottom => pointerY < rowBottom) // e.g. the comment under the pointer, in rows of different heights
```
```txt
rowBottom                  40   80   80  140  180    pointerY = 90
[rowBottom <= pointerY]     1    1    1    0    0    their count, 3, is the pointed row
previous bit minus bit      0    0    0    1    0    the pointed row's one-hot, where row 0's previous bit is [pointerY >= 0]
```

- **Circuit version.** `emitCompare(circuit, rowBottom, '<=', pointerY)` for every row in the same layers, one `circuit.roundAffine` sum of the bits, and neighbor differences declared with `circuit.assumeOneHot(isPointedRow, true)`, so reading any field of the pointed row is 1 gather. The count gives the loop's index because the bits never go from 0 back to 1, and a sum of exact 0s and 1s is exact in any grouping below 2^24.
- **Cost.** O(n) operations in O(1) layers after the row bottoms, 3n + 3 operations in 3 layers: 195 in 3 at 64 rows, against 447 in 34 for a tree built with `emitFirstActive`. The loop is O(n) operations in O(n) layers.
- **Exact when.** The test is exact, e.g. pointerY on a 1/64 px grid and bottoms on a 1/4 px grid give integer bits, while bottoms off a grid get a sign cascade, 15 operations in 14 layers per row within 0..16,384. The bits are monotone: unsorted bottoms give a wrong row without an error, e.g. a height of −10 px makes the bottoms 40, 30 and 80, and at pointerY 35 the count is 1 while the loop returns 0, which `validateOneHotGroups` catches in tests. The count is the row's index only while the pointer is on the rows: above the first row it's 0, and at or below the last bottom it's the row count.
- **Don't use it when.** The test isn't monotone, e.g. hit bits of overlapping windows: use [the next entry](#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far). Every row has the same height: `Math.floor(pointerY / rowHeight)` doesn't grow with the row count, e.g. lists' uniform list is 280 operations in 19 layers with 24 DOM slots. Depth doesn't matter and rows are many: a binary search over the sorted bottoms reads ceil(log2(n + 1)) of them, e.g. among 10,000 rows, for each step from 2^13 down to 1, `bottom = circuit.indexReadAffine(countTerms, step - 1, rowBottoms, 'clamp', 'clamp')`, declared on the bottoms' grid with `circuit.assumeGrid(bottom, 1)` so that each comparison is 2 operations, then `countTerms.push([emitCompare(circuit, bottom, '<=', pointerY), step])`, and the count is the sum of `countTerms`: 42 operations in 42 layers, against 20,001 in 3 for counting every row's bit. Reads past the table clamp to the last bottom, so take `Math.min(count, rowCount)`, as lists' text rows does with `countBottomsAtOrAbove` ([text-rows.ts](../lab/ui-exploration/lists/text-rows.ts)).
- **Used in, long form, test.** hn-thread's pointed comment and lists' virtualized list. [count-instead-of-search.md](../lab/ui-exploration/guide/patterns/count-instead-of-search.md), tested by [count-instead-of-search.test.ts](../lab/ui-exploration/guide/examples/patterns/selection/count-instead-of-search.test.ts).

### `findIndex` when passing items can be anywhere, and keeping the best score so far

A loop that picks one candidate reads the candidates one at a time, so the result depends on a chain through every candidate. The circuit computes every test or score in the same layers, then picks one candidate with a balanced tree in O(log n) layers. Earlier notes call this parallel argmax.

```js
const clickedIndex = targets.findIndex(target => contains(target, pointer)) // e.g. the topmost of overlapping click targets, front to back
let bestIndex = 0 // e.g. the best-fitting of several candidate layouts
for (let index = 1; index < scores.length; index++) if (scores[index] > scores[bestIndex]) bestIndex = index
```
```txt
[0 1 0 1 0 0 1 0]   hit bits, front to back
 \_/ \_/ \_/ \_/    up: each pair holds 1 when either side holds 1
  1   1   0   1
   \_/     \_/
    1       1
      \___/
        1           down: the 1 goes left when the left side holds 1, otherwise right
[0 1 0 0 0 0 0 0]   the one-hot of the first hit, or all zeros when nothing is hit
```

- **Circuit version.** `emitFirstActive(circuit, gate, hitBits)` in numeric-ui-core.ts builds this tree, where the gate is 1 when a selection should happen, e.g. `pressed`. `emitArgmax(circuit, scores, unit)` builds the same shape for scores declared within 0..1: in each pair, a boolean atom compares the two scores and a select keeps the larger one, the left one on a tie, and the 1 goes down along those comparison bits. The tree gives the loop's answer because each combining step gives the same result however candidates are grouped ([why](#why-a-tree-gives-the-loops-answer)).
- **Cost.** O(n) operations in O(log n) layers, against O(n) in O(n) for the loop. At 64 candidates, `emitFirstActive` is 316 operations in 31 layers, against 127 in 127 for the chain, and `emitArgmax` is 437 in 33.
- **Exact when.** `emitFirstActive` returns an exact one-hot, or all zeros, when the gate and every candidate are exact bits, while fractional candidates split the route, e.g. [0.5, 0] sends 0.25 to each output. It declares the one-hot group itself only for bits it can prove, e.g. `emitCompare` bits and boolean atoms, and not for an AND of bits built with a ReLU, so when each hit bit is an AND of 4 edge comparisons, the caller declares the group with `circuit.assumeOneHot(selected, true)`. Once the group is declared, a masked read of the selection, e.g. the pressed target's left edge, compiles to one gather. `emitArgmax` needs an executor that keeps FP32 rounding at its atoms. It keeps the left candidate on an exact tie, and in the test's sweep of adjacent FP32 scores, for every right score less than 1.04e-7 larger, and for some right scores up to 2.09e-7 larger. That band isn't transitive, so the tree can pick a different candidate from the loop. When the pick must match the loop, the guide example's `emitHighestScoreExact` combines pairs with `emitCompare`: 500 operations in 39 layers at 64 scores on a 1/64 grid.
- **Don't use it when.** Candidates can't overlap, e.g. photos in a grid, since the hit bits already are the selection. The test flips once along the items, e.g. rows top to bottom: use [the count](#findindex-when-the-test-flips-once-along-the-items). There are only a few candidates on today's CPU executor, which pays per operation: at 4 candidates the chain is 7 operations and the tree 16. Training needs a gradient through the pick: `backpropagateReference` throws on `emitArgmax`'s boolean atoms by default, so train through a soft read, e.g. a softmax, and run the tree. The code needs both the first and the last hit, e.g. `hits.indexOf(1)` and `hits.lastIndexOf(1)`: running totals of the hits give both as counts of bits that flip once, the first hit as `Σ relu(1 − hitsThrough[i])` and the last as `Σ [hitsThrough[i] < totalHits]`, where `totalHits` tells whether anything is hit. At 513 positions that's 2,052 operations in 515 layers with a chain of totals, or 2,554 in 19 with `brentKungPrefix`, against 5,125 in 51 for two `emitFirstActive` trees, and json-highlighter's matching bracket went from 9,241 to 6,687 operations this way ([highlighter.ts](../lab/json-highlighter/highlighter.ts)).
- **Used in, long forms, tests.** photo-gallery.ts's click priority (the previous and next controls, then the thumbnails, then the main image), and [candidate-gallery.ts](../lab/candidate-gallery/candidate-gallery.ts)'s layout choice with `emitArgmax` and clicked thumbnail with `emitFirstActive`, while window-manager.ts's `emitFrontmost` checks stacking ranks one at a time, since at 4 windows that chain is smaller than an `emitFirstActive` tree. [first-active-tree.md](../lab/ui-exploration/guide/patterns/first-active-tree.md) and [highest-score-tree.md](../lab/ui-exploration/guide/patterns/highest-score-tree.md), tested by [first-active-tree.test.ts](../lab/ui-exploration/guide/examples/patterns/selection/first-active-tree.test.ts), [highest-score-tree.test.ts](../lab/ui-exploration/guide/examples/patterns/selection/highest-score-tree.test.ts), and 'argmax breaks exact ties toward the lower-indexed candidate' in [numeric-ui-core.test.ts](../tests/runtime/numeric-ui-core.test.ts).

### Comparing each item's index with the selected index

When the selection comes as one-hot bits, e.g. from the tree above, a per-item relation to it can be written as a lookup: every item gets a term for every possible selection, e.g. a thumbnail's falloff as `Σ selected[s] × falloff(index − s)`, items × possible selections terms in all. Computing the selected index once replaces that lookup with one sum and a few operations per item.

```js
const nearSelected = thumbnails.map((_, index) => Math.abs(index - selectedIndex) <= 1) // e.g. the photos next to the focused photo, which get a blur
```

- **Circuit version.** The selected index is one sum, `Σ s × selected[s]`, or comes straight from a count or an index read. Every item computes `d = selectedIndex − index`, and for an integer d, `relu(d + 1) − 2 relu(d) + relu(d − 1)` is 1 when d is 0 and 0 otherwise. "At most 1 away" adds that bit at d − 1, d and d + 1, so no item's operations read another item's wire, which a program written once per item requires.
- **Cost.** One sum, then O(1) operations per item, e.g. the guide's row of cards computes each card's hovered bit, including the AND with a presence bit, in 4 operations in 2 layers.
- **Exact when.** The selection's bits are exact and indexes are integers below 2^24, so the sum and every ramp are exact.
- **Don't use it when.** Each item only needs its own selection bit in a circuit that writes every item out: the one-hot member already is that bit. The code reads values at the selected item, e.g. the selected photo's width: use a masked read or `circuit.indexRead` at the index ([expressions.md](expressions.md)). Neighbors wrap around, e.g. Previous on the first photo focuses the last: the difference of indexes doesn't wrap by itself, so add a bounded wrap correction or use [circular coordinates](expressions.md#circular-coordinates).
- **Used in, long form, test.** The staged gallery's focus relation in instanced-items. [instancing.md, "Habits that change along with the constants"](../lab/ui-exploration/guide/sections/instancing.md#habits-that-change-along-with-the-constants), and the row of cards' hovered stage in [cards-staged.ts](../lab/ui-exploration/guide/examples/instancing/cards-staged.ts), tested by [instancing.test.ts](../lab/ui-exploration/guide/examples/instancing/instancing.test.ts).

### Build every option, score each, and keep the best

The program builds every option in the same layers, scores each, and picks one with the tree above, so every output comes from the same option. When a score replaces hand-written rules, e.g. `viewportWidth / viewportHeight > 1.6 ? heroLayout() : stripLayout()`, the app's behavior changes too, and the numbers behind the score can sit in cells, where a designer or a solver can change them.

```js
const options = optionBuilders.map(build => build(viewportWidth, viewportHeight)) // e.g. a gallery's hero, grid and strip layouts
let bestOption = 0
for (let index = 1; index < options.length; index++) if (options[index].score > options[bestOption].score) bestOption = index
```

- **Circuit version.** Each option is ordinary builder code that returns its outputs and a score within 0..1, e.g. `Math.min(1, size / targetSize)` for each size, then the smallest of those. `emitArgmax(circuit, scores, one)` gives the one-hot, and each output is a masked sum over it, which the compiler lowers to one gather. When each option either fits or doesn't, and earlier options are preferred, e.g. a toolbar that shows labels when they fit, otherwise icons, otherwise an overflow menu, `emitFirstActive` over the fit bits gives the one-hot instead.
- **Cost.** Every option's operations, plus O(C) operations in O(log C) layers for the pick, plus one gather per distinct picked number: 3 layouts of 8 photos are 114 operations in 25 layers, of which the scores are 60 operations in 16 layers.
- **Exact when.** `emitArgmax` throws when a score isn't declared within 0..1, and every output is exactly one option's value. Options with equal scores, e.g. every layout scoring 1 on a large viewport, and scores within `emitArgmax`'s tie band are picked by their order. A JavaScript version picks the same option only when its scores come out the same, e.g. the example keeps sizes on eighth-pixel grids and target sizes at powers of two, so every score is a multiple of 2^-10 in both FP32 and float64. A masked sum becomes a gather only when every option's value has a finite declared range; otherwise the dense sum runs, and an unpicked option holding Infinity turns `0 × Infinity` into NaN.
- **Don't use it when.** The choice depends only on one runtime width: use [the thresholds of a layout function](#a-layout-function-of-one-runtime-number), 2 operations per threshold. There are many options, or expensive ones: every option runs on every frame whether or not it's picked.
- **Used in, long form, test.** [candidate-gallery.ts](../lab/candidate-gallery/candidate-gallery.ts), the Dynamic UI demo. [run-every-candidate.md](../lab/ui-exploration/guide/patterns/run-every-candidate.md), tested by [run-every-candidate.test.ts](../lab/ui-exploration/guide/examples/patterns/candidates-and-tables/run-every-candidate.test.ts).

## Carrying a value from step to step

A loop that carries a value from step to step becomes a tree of combining steps when two steps combine into a step of the same kind: two additions into a sum, two spring steps into one matrix, two events into one table, two links into a longer link.

### Running totals

Each total reads the total before it, so the loop is a chain n layers deep.

```js
const rowTops = [] // e.g. the top of each row in a list whose rows have different heights
let top = 0
for (const height of heights) { rowTops.push(top); top += height }
```
```txt
h0   h1   h2   h3
 \___/     \___/      layer 1: 0..1 and 2..3
  0..1      2..3
     \______/         layer 2: 0..3, and 0..2 = (0..1) + h2
       0..3
```

- **Circuit version.** Three arrangements of the same additions, each built with `circuit.roundAffine`, which keeps a sum as its own operation with the caller's term order: a chain in the loop's order, one wide sum per total, or a Brent-Kung network, `brentKungPrefix(heights, combine)` in [src/runtime/prefix-networks.ts](../src/runtime/prefix-networks.ts), which takes any associative combine, e.g. `(earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]])`. With `circuit.affine`, the builder copies a sum of fewer than 4 terms into the sums that read it and sorts its terms, which regroups the additions.
- **Cost.** At 1,024 rows, the chain is 1,023 operations in 1,023 layers, wide sums 1,023 operations in 1 layer with 524,799 stored weights, i.e. O(n²) weights, and Brent-Kung about 2n operations in about 2 log2 n layers, 2,036 in 18.
- **Exact when.** The chain and wide sums take the loop's rounding steps, so they equal a loop that rounds every addition to FP32, bit for bit. Brent-Kung equals that loop only when every partial sum is exact, e.g. quarter-pixel heights with a content height within 2^22 px, or counts below 2^24. On long pages Brent-Kung is the more precise grouping: at 10,000 rows of 20 to 300 px, the loop's totals are up to 5.67 px from float64 sums of the same FP32 heights, and Brent-Kung's up to 0.26 px.
- **Don't use it when.** Depth doesn't matter, as on today's CPU executor: the chain is the least work. A reference that adds one row at a time must match bit for bit on fractional heights: use the chain or wide sums. There are more than a few hundred rows: wide sums store n²/2 weights.
- **Used in, long form, test.** instanced-items' photo strip edges, hn-thread's row tops, lists' counts of visible items. [running-totals.md](../lab/ui-exploration/guide/patterns/running-totals.md), tested by [running-totals.test.ts](../lab/ui-exploration/guide/examples/patterns/combining-steps/running-totals.test.ts).

### A linear step repeated a runtime number of times

A program runs each of its layers once, so it can't run a loop a runtime number of times. When one step is linear with constant coefficients, any number of steps is one matrix power.

```js
for (let step = 0; step < steps; step++) { // e.g. a window's spring through a frame's 4 ms steps, where steps comes from the frame's timestamp
  velocity += (-stiffness * displacement - damping * velocity) * dt
  displacement += velocity * dt
}
```

- **Circuit version.** One step maps (displacement, velocity) through a 2×2 matrix M, so `steps` steps are M^steps. host-timing.ts's `springMatrixPower(springStepMatrix(constants), steps)` squares in float64, JavaScript writes the 4 entries into cells before each evaluation, and `emitApplySpringMatrix(circuit, matrix, displacement, velocity)` in numeric-ui-core.ts applies them with 4 products. The cells need finite declared ranges, e.g. `±springMatrixBound(constants)`. Matrix products are associative and powers of one matrix commute, so every grouping gives the same real matrix. The long form also builds the power in the circuit from the step count's binary digits, and reads M^i from a table of M^0 to M^300 with `circuit.indexRead`.
- **Cost.** 14 operations in 3 layers per spring at any step count, and 280 in 3 for 20 springs. Unrolling the loop with one mask per possible step is 3,301 operations in 902 layers for one spring and up to 300 steps. JavaScript pays O(log N) 2×2 products per stiffness and damping pair per evaluation.
- **Exact when.** Close to the float64 loop, not bit for bit, since the state rounds once per evaluation instead of once per step: within 3e-4 px over 1,000 random springs within ±2,000 px and ±20,000 px/s. Reading M^i from a table of powers gives the same outputs as writing M^i into cells, bit for bit, while the step count holds an integer.
- **Don't use it when.** The step isn't linear with constant coefficients, e.g. stiffness that depends on position, or items that push each other apart: unroll a small maximum count. Stiffness and damping are values inside the program: the steps no longer combine into constant weights, e.g. 2,142 operations in 1,295 layers for one spring built from binary digits, so keep them in JavaScript.
- **Used in, contract, long form, test.** `emitAnimatedObject` with host-timing.ts's `advanceFrame` is the default spring ([execution-model.md](execution-model.md#springs-and-time)), e.g. in window-manager.ts, where the windows and Photos' thumbnails share one spring matrix. [matrix-powers.md](../lab/ui-exploration/guide/patterns/matrix-powers.md), tested by [matrix-powers.test.ts](../lab/ui-exploration/guide/examples/patterns/combining-steps/matrix-powers.test.ts).

### A state machine over queued events

Each step reads the state the previous step produced, so the loop is k layers deep for k events. When the state has few possible values, the steps can be regrouped.

```js
let state = initialState // e.g. a button that acts on release, over the pointer events queued in one frame
for (const event of events) state = nextState(state, event)
```
```txt
each event as a table from state to next state, over the states idle, armed, pressedOutside:
  downOnButton = [armed, armed, pressedOutside]      moveOutside = [idle, pressedOutside, pressedOutside]
two events as one table, one read per state:  combined[state] = later[earlier[state]]
  downOnButton, then moveOutside = [pressedOutside, pressedOutside, pressedOutside]
```

- **Circuit version.** Two ways. A prefix scan: JavaScript writes the machine's transition table into cells, each event's table is S index reads, two tables combine with one `circuit.indexRead` per state, and `sklanskyPrefix` or `brentKungPrefix` in [src/runtime/prefix-networks.ts](../src/runtime/prefix-networks.ts) gives every prefix, so the state before every event. Speculation: each block of B events runs once from every possible start in the same layers, and one `circuit.indexRead` per block picks the run that starts where the state actually is. When the machine can be in several states at once, e.g. an automaton built from a regular expression, the state is a 0/1 vector of S bits instead of one integer, and each step multiplies it by the current character class's matrix of transition bits. An index read gives each term of that product in 1 operation, `bit ? transitions[class][s][t] : 0` as `circuit.indexReadAffine([[characterClass, 1], [bit, -classCount]], classCount, transitionsByClass, 'clamp', 'zero')`, which reads +0 past the table when the bit is 0, so a step is S² reads plus one ReLU per state for "none of these reads is 1" ([regex-search](../lab/regex-search/README.md#the-automaton-and-its-cells)).
- **Cost.** The loop is O(k) operations in O(k) layers. The prefix scan is S reads per event plus S reads per combine, in O(log k) layers: Sklansky's network has (k / 2) × log2 k combines, so O(S × k log k) operations, and Brent-Kung's about 2k, so O(S × k), e.g. 897 operations in 10 layers and 681 in 14 for a 3-state button at 64 events, against 129 in 65 for the loop. From a constant initial state, e.g. state 0, every prefix is read only at that state, so the compiler removes S − 1 reads per prefix, and the scan is k + S × combines operations instead of S × (k + combines), e.g. 26,850 instead of 39,650 with Brent-Kung's network for a 26-state tokenizer over 512 positions, as in json-highlighter. Speculation is about S times the loop's operations in O(√k) layers, e.g. 1,000 operations in 25 layers for keyboard focus over 5 buttons at 64 events, against 193 in 129. A set of states costs S² reads per step, e.g. regex-search's automaton in cells costs about 2S² + 4S + 71 operations per code point for its two passes and the character class, about 2,244 at S = 32.
- **Exact when.** Reads copy integers without rounding, so every grouping gives the same bits, while every table cell holds an integer state within 0..S − 1 and every event kind an integer within its declared range. A fractional cell doesn't throw, since the read floors it, so tests run `validateIndexReads`. Speculation's runs have to cover every value the state can hold when a block starts; otherwise the read returns the nearest end of the table, and every later block starts from the wrong state.
- **Don't use it when.** Operations cost more than layers, as on today's CPU executor: at 64 events the loop is about 7 times fewer operations than the scan. The state has cheaper structure, e.g. a count, a latch, or an OR that resets: build that structure directly, as input did with running counts of downs and ups for pointer moves. The state has many possible values, e.g. a line's start among 1,000 segments: speculation runs once per value, so [follow links by doubling](#following-links-one-at-a-time) instead. An event's table depends on another state, e.g. whether a move passes the drag threshold depends on the press point: compute that state with its own scan first.
- **Used in, long forms, tests.** input's keyboard focus over 12 controls, json-highlighter's tokenizer and grammar, and regex-search's automaton over a set of states. [state-machine-prefix-scan.md](../lab/ui-exploration/guide/patterns/state-machine-prefix-scan.md) and [speculation.md](../lab/ui-exploration/guide/patterns/speculation.md), tested by [state-machine-prefix-scan.test.ts](../lab/ui-exploration/guide/examples/patterns/combining-steps/state-machine-prefix-scan.test.ts) and [speculation.test.ts](../lab/ui-exploration/guide/examples/patterns/candidates-and-tables/speculation.test.ts), and the operation counts in [prefix-networks.test.ts](../tests/runtime/prefix-networks.test.ts).

### A loop whose decision needs later input

A loop that finds the longest match only knows where the match ends after reading past it, and then goes back, e.g. for `a+b|a` on `aaac`, the scan from position 0 reads `aaac` before it knows that only `a` matches. A program runs every step once, in order, so it can't go back.

```js
let end = -1 // e.g. the longest token that starts at `start`, as a tokenizer or a regular expression search takes it
let states = new Set([initialState])
for (let position = start; position < text.length && states.size > 0; position++) {
  states = nextStates(states, text[position])
  if ([...states].some(isAccepting)) end = position + 1
}
```

- **Circuit version.** A reverse pass first, from the end of the text: `reach[j][s]` is 1 when some path from state s at position j reads at least one more code point and ends in an accepting state, i.e. `reach[j][s] = states.some(t => transitions[classOf(text[j])][s][t] && (accepting[t] || reach[j + 1][t]))`. The forward pass then knows at every position whether the match in progress can still get longer, `reached[j][s] && reach[j][s]` for some state s, and when no match continues, a match starts at j when `reach[j][initialState]`. Each pass is the state machine above over a set of states, and the reverse pass reads the transition matrices by column instead of by row.
- **Cost.** Two passes of one step per position, about twice the operations of the forward pass alone. Every forward step reads the reverse pass at its position, so the forward pass starts after the whole reverse pass, and the layers grow with the text, e.g. 13,413 operations in 1,026 layers for an 8-state pattern built into the program over 256 code points, and 2,297,760 operations in 8,190 layers for a 32-state pattern in cells over 1,024 code points.
- **Exact when.** Every value is an exact bit, so the passes are exact at any text length: regex-search's matches equal a JavaScript scan that keeps the last accepting position, on 26 hand-written cases and 400 random patterns with 6 texts each.
- **Don't use it when.** The decision only needs earlier input, e.g. the first position where a fixed string ends: the forward pass alone gives it. The layers matter: grouping the steps into a tree of matrix products would give O(log n) layers, but combining two S × S matrices of bits takes S³ products, e.g. 32,768 at S = 32, and regex-search didn't build it.
- **Used in, long form, test.** regex-search's leftmost-longest search. [regex-search, "How the program finds where matches start and end"](../lab/regex-search/README.md#how-the-program-finds-where-matches-start-and-end) with [data-program.ts](../lab/regex-search/data-program.ts), tested by [regex-search.test.ts](../lab/regex-search/regex-search.test.ts).

### A stack of one bit per level

A parser keeps a stack of open containers and reads its top, e.g. whether a comma leads to a key or a value in JSON. Each push or pop changes the stack that the previous character left, so the loop is a chain.

```js
const stack = [] // e.g. whether each position of a JSON text is inside an object or an array
for (const character of text) {
  inObject.push(stack.at(-1) === 'object')
  if (character === '{' || character === '[') stack.push(character === '{' ? 'object' : 'array')
  if (character === '}' || character === ']') stack.pop()
}
```
```txt
text           {   [   {   }   ]   }
depthBefore    0   1   2   3   2   1
codeBefore     0   1   1   5   1   1    bit d − 1 is 1 when the container at depth d is an object
inObject       0   1   0   1   0   1    [codeBefore >= 2^(depthBefore − 1)], and 0 at depth 0
```

- **Circuit version.** At a bounded depth, the stack's kinds fit in one integer whose bit d − 1 is 1 when the container at depth d is an object. A running total adds 2^depthBefore at `{` and subtracts 2^(depthBefore − 1) at `}`, where each weight is one index read at `depthBefore × kindCount + kind`, and the kind at the current depth is one comparison, `emitCompare(circuit, codeBefore, '>=', levelWeight)`, with `levelWeight = 2^(depthBefore − 1)` read from a table, since the containers below the current depth add up to less than that bit. The depth is its own running total of +1 and −1.
- **Cost.** O(n) operations, 5 per position after the depth: a weight read, an addition, a level read and a 2-operation comparison, e.g. 2,569 operations after the depth's 1,022 at 512 positions and depths up to 16, in 528 layers with chains of totals.
- **Exact when.** Nothing reads the kind after the first mismatched bracket: until then, every container below the current depth is still open and every closer matched its opener's kind, so no bit at or above the depth is set, while e.g. `[}` subtracts a bit that was never added. json-highlighter's grammar stays in its error state after its first error, so it never reads a wrong kind. The comparison at position p is a 2-operation integer bit while (p + 1) × 2^(maximum depth − 1) stays below 2^24 and every read and total has a grid ([Grids](execution-model.md#grids)). Past that, `emitCompare` builds a sign cascade of 17 operations, which is also exact, e.g. at position 511 at depths up to 16 ([json-highlighter, stage 4](../lab/json-highlighter/README.md#what-the-program-computes)), and `circuit.roundingPoints()` lists which comparisons got one.
- **Don't use it when.** The stack holds more than one bit per level, e.g. the positions of open brackets: pair brackets by depth instead, where an opener's match is the closer just before the first later position whose depth is at most the opener's, as json-highlighter's matching bracket does with [the first and the last hit](#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far). The maximum depth passes 24: the code's bits past 2^24 aren't exact in FP32.
- **Used in, long form, test.** json-highlighter's container kinds. [json-highlighter, "What the program computes", stage 4](../lab/json-highlighter/README.md#what-the-program-computes) with [highlighter.ts](../lab/json-highlighter/highlighter.ts), tested by [highlighter.test.ts](../lab/json-highlighter/highlighter.test.ts).

### Following links one at a time

Each step reads where the previous step landed, so following L links is L layers deep. Replacing every link by the link it points to doubles how far every link reaches, so L links take about log2 L rounds (pointer jumping).

```js
let start = 0 // e.g. where each line of a paragraph starts, from a table of where the next line starts
for (let line = 0; line < lineSlots; line++) {
  starts.push(start)
  if (start < segmentCount) start = nextStart[start]
}
```
```txt
segment s        0   1   2   3   4   5   6   7   8   9 | 10 = past the end
1 line later     3   3   4   6   6   8   9   9  10  10     nextStart[s]
2 lines later    6   6   6   9   9  10  10  10  10  10     (1 line later)[(1 line later)[s]]
line 3 starts at (1 line later)[(2 lines later)[0]] = (1 line later)[6] = 9
```

- **Circuit version.** `jumps[level] = jumps[level − 1].map(target => circuit.indexRead(target, jumps[level − 1]))`, then `starts[line] = circuit.indexRead(starts[line − 2^level], jumps[level])` with `level = Math.floor(Math.log2(line))`. Every read of one level reads the level before, so a level is one layer.
- **Cost.** O(n log L) operations in O(log L) layers, against O(L) in O(L) for the walk: 342 operations in 7 layers at 63 segments and 32 line slots, against 94 in 32. The next-start table isn't included, and it dominates at realistic sizes, e.g. 190,279 operations for 1,023 segments, measured in index-read's copy of the runtime ([text-walker](../lab/ui-exploration/text-walker/README.md#merged-from-index-read-september-16-2026)).
- **Exact when.** Positions are integers below 2^24, which reads copy without rounding, so every grouping gives the same bits. Every `nextStart[s]` holds an integer within 1..n, and `nextStart[n − 1]` is n, as greedy line breaking gives, so a read clamped at the end still reads n.
- **Don't use it when.** Few links need following, e.g. a card caption of at most 3 lines. Each line needs its own width, which one next-start table can't express. Operations cost more than layers, as on today's CPU executor: at 1,023 segments the walk is about 16 times fewer operations.
- **Long form and test.** [pointer-jumping.md](../lab/ui-exploration/guide/patterns/pointer-jumping.md), tested by [pointer-jumping.test.ts](../lab/ui-exploration/guide/examples/patterns/combining-steps/pointer-jumping.test.ts).

## The same work on every item, then counts and sums

Instead of visiting items in order and stopping at a match, the same computation runs on every item in the same layers, e.g. how many items come before this item, and the results are added up.

### `items.sort(compare)`

A sort reaches each item's place through comparisons that depend on earlier comparisons. The DOM needs each item's position after sorting, e.g. for a `translateY`, and that position is a count: how many items come before this item.

```js
const order = items.map((_, index) => index).sort((left, right) => keys[left] - keys[right] || left - right) // e.g. cards stacked by date
let top = 0
for (const item of order) { itemTops[item] = top; top += heights[item] }
```
```txt
keys                30   10   30   20
item 0 (key 30)      ·    1    0    1   → rank 2      an entry is 1 when the other item comes before this item,
item 1 (key 10)      0    ·    0    0   → rank 0      and of two equal keys, the earlier item comes first
item 2 (key 30)      1    1    ·    1   → rank 3
item 3 (key 20)      0    1    0    ·   → rank 1
```

- **Circuit version.** One `emitCompare(circuit, keys[earlier], '<=', keys[later])` per pair gives both of the pair's entries, and each rank is one sum of bits. An item's top is one sum of `comesBefore × height` products. When one item moves, e.g. a dragged card, each other card gets the bit `[rank < fromRank] AND [pointerY < midpoint]`, or the same bit downward, and the moved card's rank shifts by the count of passed cards: midpoints never decrease along ranks, so the passed cards form one run, the run a swap loop walks.
- **Cost.** O(n²) operations in O(1) layers: 4,096 operations in 3 layers at 64 items, with keys on a grid, so every bit is 2 operations. When one card moves, O(n): 1,404 operations in 8 layers at 100 cards.
- **Exact when.** Keys are integers or declared on a grid; other keys get a sign cascade, still exact but 15 operations in 14 layers per `<=` within 0..16,384. Tops are exact while heights lie on a grid and totals stay below 2^24 grid steps. The update needs last frame's tops in rank order.
- **Don't use it when.** There are well over a hundred items: a sorting network is O(n log² n) operations in O(log² n) layers, e.g. 10,624 operations in 105 layers against 16,512 in 5 for 64 items with a payload. The order is known while building, e.g. a fixed menu: sort in JavaScript while building. Many items move in one frame, e.g. switching the sort from date to name: recompute the ranks.
- **Used in, long form, test.** lists' port of vibescript's draggable-cards. [ranks-instead-of-sorting.md](../lab/ui-exploration/guide/patterns/ranks-instead-of-sorting.md), tested by [ranks-instead-of-sorting.test.ts](../lab/ui-exploration/guide/examples/patterns/every-item/ranks-instead-of-sorting.test.ts).

### `items.filter(isVisible).slice(0, K)` into K DOM nodes

Which items pass the filter isn't known while building, but the number of DOM nodes K is. Every item's visibility is computed in the same layers, a prefix sum numbers the visible items, and DOM slot k shows the visible item numbered k.

```js
const shownItems = items.filter(isVisible).slice(0, slotCount) // e.g. the first 20 products within a price range, in 20 reusable DOM nodes
```
```txt
item                     0   1   2   3   4   5   6   7
visible                  0   1   1   0   1   0   1   1
visibleThrough           0   1   2   2   3   3   4   5    a prefix sum of the visible bits
[visibleThrough <= 2]    1   1   1   1   0   0   0   0    the neighbor difference at item 4 marks what DOM slot 2 shows
```

- **Circuit version.** Each item's visibility bit, e.g. an AND of two `emitCompare` bits, then the counts from a Brent-Kung network of additions. Each DOM slot k then finds its item one of two ways: neighbor differences of `[visibleThrough[item] <= k]`, declared with `circuit.assumeOneHot`, so each field the slot shows is one gather, or a binary search over the counts with `circuit.indexReadAffine`, then `circuit.indexRead` at the found position with `{outOfRange: 'zero'}`. A slot's presence bit is `[visibleThrough[n − 1] >= k + 1]`.
- **Cost.** Visibility and counts are O(n) operations in O(log n) layers, 6,984 operations in 20 layers for 1,000 items. Into 20 DOM slots, in all, one-hots are O(n × K), 47,044 operations in 24 layers, and binary search O(K log n), 7,824 operations in 57 layers.
- **Exact when.** The visibility test is exact, e.g. integers or values on a declared grid, so the counts are sums of exact bits, exact in any grouping below 2^24. Nothing checks the one-hot declaration at runtime, so tests run `validateOneHotGroups`, and every field needs a finite declared range for its gather. The binary search's indexes hold integers, which `validateIndexReads` checks in tests.
- **Don't use it when.** The visible items form one run, e.g. rows scrolled into view: DOM slot k shows `firstVisibleRow + k`, e.g. 1,269 operations for hn-thread's 48 window slots against 25,616 for rank slots, though rows of height 0 use up slots. The per-item work that each DOM slot runs is small: lists found that routing pays off only once that work costs more than about 2 + 2K operations, e.g. 42 for 20 slots. K is close to the item count: run the work for every item, and let JavaScript skip the hidden ones.
- **Used in, long form, test.** lists' capacity routing and hn-thread's rank slots. [compaction-into-slots.md](../lab/ui-exploration/guide/patterns/compaction-into-slots.md), tested by [compaction-into-slots.test.ts](../lab/ui-exploration/guide/examples/patterns/every-item/compaction-into-slots.test.ts).

### A loop over items that mixes per-item work with values carried to the next item

Writing the loop body out once per item in one circuit gives a program whose size grows with the item count, and whose carried values form a chain. Instead, the lines that read one item are written once as map stages that run for every item, like a shader over pixels, and the lines that carry a value become reductions between the stages.

```js
let rowTop = 0 // e.g. an expandable list, where a row's height depends on whether it's expanded
for (const row of rows) {
  const rowHeight = headerHeight + (row.expanded ? row.lineCount * lineHeight : 0) // reads this row only
  visible.push(rowTop + rowHeight > scrollTop && rowTop < scrollTop + viewportHeight) // this row only
  rowTop += rowHeight // carried to the next row
}
```

- **Circuit version.** A map stage is ordinary builder code over one item's values and shared values, e.g. scrollTop, compiled once as its own program and evaluated for every item. The reductions between stages, e.g. prefix sums, sums and first hits, run in between. The guide example's `buildMapStage` and `runListStages` are a simple runner, and lab/ui-exploration/instanced-items has the staged builder and executors that generate one loop or one GPU compute shader per stage, outside numeric-ui-core.ts.
- **Cost.** O(p) operations at any item count, where p is the per-item work, and a frame does O(n × p) operations plus O(n) per reduction: the example's stages are 3 operations in 3 layers and 12 in 4, where the circuit with every row written out is 901 operations in 71 layers at 64 rows. instanced-items' gallery is 233 operations per photo at 221, 1,000 and 10,000 photos, and at 10,000 photos its staged executor took about 4,106 µs per frame, against 43,027 µs for the circuit with every photo written out.
- **Exact when.** The staged program gives the written-out circuit's bits when each reduction takes the same FP32 steps, e.g. a prefix sum in row order that rounds after every addition. A stage boundary can move a rounding point: a per-item constant that was a weight becomes a product, e.g. IndirectOS's thumbnail centers moved by up to 0.0012 px.
- **Don't use it when.** There are a handful of items whose constants sit in lookup tables: staging IndirectOS's 20 small items took it from 5,253 to 6,282 operations, measured before IndirectOS moved to host-timed springs on September 15, 2026. The items don't share a program, e.g. a settings page where every control is different. The one fixed program of layers is the point, e.g. an executor that runs a whole layer at once.
- **Long forms and test.** [one-program-per-item.md](../lab/ui-exploration/guide/patterns/one-program-per-item.md) and [instancing](../lab/ui-exploration/guide/sections/instancing.md), tested by [one-program-per-item.test.ts](../lab/ui-exploration/guide/examples/patterns/every-item/one-program-per-item.test.ts).

### Growing and shrinking children with min and max

Handing out leftover width in rounds is a loop with a runtime number of rounds, e.g. layout-tree's port of Clay's loop took up to 226 rounds at 64 children over 1,000 random rows. In the final layout, every child's width is `clamp(level, low, high)` for one shared level, and the level can be found without rounds, which is called water filling.

```js
const widths = children.map(child => child.minWidth) // e.g. toolbar buttons that share a row, each growing up to its max-width
let leftover = rowWidth - sum(widths)
while (leftover > 0.01 && children.some((child, index) => widths[index] < child.maxWidth)) {
  const growingCount = children.filter((child, index) => widths[index] < child.maxWidth).length
  const added = children.map((child, index) => Math.min(leftover / growingCount, child.maxWidth - widths[index]))
  added.forEach((width, index) => { widths[index] += width; leftover -= width })
}
```

- **Circuit version.** Let `excess` be the width left after every child gets its low, and `filledAt(p) = Σ relu(p − low) − relu(p − high)` over the children. Each child tests the total at its own clamp points: it keeps its low when `[filledAt(low) >= excess]`, it reaches its high when `[filledAt(high) <= excess]` and it doesn't keep its low, and every other child is free and gets the level, `(excess − Σ atHigh × (high − low) + Σ free × low) / freeCount`, with `1 / freeCount` read through the free count's one-hot. The total only grows as the level rises, so these tests give the clamps the final layout has.
- **Cost.** O(1) layers. layout-tree's widths pass at 64 children is 784 operations in 9 layers when fit widths are constants, O(n), and 5,601 operations in 12 layers when they're runtime values, O(n²), since each child's test sums over every other child's clamp points.
- **Exact when.** Close, not bit for bit: the example's widths stayed within 0.001 px of a JavaScript loop over the sorted clamp points, on random rows of 1 to 8 children, half of them with many equal clamp points. When FP32 flips a clamp bit near a tie, the widths change continuously, e.g. a child that should be free at level 120.0001 gets clamped at its low of 120, so the flip shows up as drift in widths, not a jump.
- **Don't use it when.** Children wrap to the next line once they don't fit, i.e. flex-wrap: layout-tree kept a scan one child at a time, 1,185 operations in 276 layers at 64 children.
- **Used in, long form, test.** layout-tree's `waterFill`. [Loops, section 6](../lab/ui-exploration/guide/sections/loops.md#6-grow-and-shrink-with-min-and-max-water-filling) with [water-fill.ts](../lab/ui-exploration/guide/examples/loops/water-fill.ts), tested by 'water filling matches a loop over the sorted breakpoints on random children, including equal breakpoints' in [loops.test.ts](../lab/ui-exploration/guide/examples/loops/loops.test.ts).

## Work JavaScript does ahead of time

Work that a loop would redo on every frame runs in JavaScript when the data changes, and the program compares with its results or reads them.

### A layout function of one runtime number

Laying out on every frame runs loops over words and lines. When the result only changes at a few widths, JavaScript finds those widths while preparing, and the program compares the runtime width with them and adds constants.

```js
const layout = layoutMessageList(messages, containerWidth) // e.g. every chat bubble's top, height and width, from a greedy line-breaking loop per message
```

- **Circuit version.** While preparing, the guide example's `findBreakpoints` calls the JavaScript layout as a black box every 1 px, and wherever two samples differ, bisects down to 1/64 px steps. The program computes `[containerWidth >= threshold]` with `emitCompare` for every threshold, and every output is its value below the first threshold plus `change × bit` for each threshold where the output changes. Anything that depends only on which interval the width is in, e.g. `Math.min(480, containerWidth * 0.75)`, moves into JavaScript.
- **Cost.** T thresholds cost 2T operations plus one sum per output, in 3 layers whatever the layout does: 5 messages between 160 and 1,280 px have 45 thresholds, and every bubble's top, height and width, plus the content height, are 106 operations in 3 layers. JavaScript calls the layout once per 1 px plus about 6 times per threshold, 1,391 calls, whenever the text changes.
- **Exact when.** The host writes the width on the declared 1/64 px grid, so every comparison is an integer bit and gives the black box's own result at every width the host can write, e.g. all 71,681 widths the test compares. Every output's changes add up exactly, e.g. whole and half pixels far below 2^24, and the width stays within the tabulated range, which the example declares on the width cell. Every change falls between two 1 px samples that differ, which holds for a greedy line breaker, since it only moves line ends forward as the width grows, while with pretext's rich inline layout a paragraph can get more lines as it gets wider.
- **Don't use it when.** The result depends on a second runtime value, e.g. a width and a font scale. Each line has its own width, e.g. text flowing around a dragged window: use the line walker ([text, idea 2](../lab/ui-exploration/guide/sections/text.md#idea-2-the-walker-as-arithmetic)). The text changes at runtime while the thresholds are weights, e.g. appended or edited chat messages: keep each row's sorted thresholds in cells, as in [the next entry](#a-loop-over-data-that-rarely-changes), and count the thresholds the width reaches with a binary search, log2(T + 1) reads with `circuit.indexReadAffine` at the count so far plus a step, each followed by one `emitCompare`, as in [the count's binary search](#findindex-when-the-test-flips-once-along-the-items), e.g. 9 operations per row at 7 thresholds per row in lists' text rows ([text-rows.ts](../lab/ui-exploration/lists/text-rows.ts), [README](../lab/ui-exploration/lists/README.md#text-rows-with-pretext-heights-september-17-2026)).
- **Used in, long form, test.** text-tabulated's Notes window, hn-thread's comment heights, whose `tabulateStaircase` in text-heights.ts takes the range of container widths and the bisection tolerance, and lists' text rows. When the thresholds come from a closed form, e.g. a grid's column count, the same count replaces one expression and is in [expressions.md](expressions.md), with the long form [threshold-counts.md](../lab/ui-exploration/guide/patterns/threshold-counts.md). [breakpoints-found-ahead-of-time.md](../lab/ui-exploration/guide/patterns/breakpoints-found-ahead-of-time.md), tested by [breakpoints.test.ts](../lab/ui-exploration/guide/examples/patterns/candidates-and-tables/breakpoints.test.ts).

### A loop over data that rarely changes

A loop that walks data on every frame, e.g. up a comment thread, is a chain in the program. When the data only changes between frames, JavaScript runs the loop for every possible input whenever the data changes and writes the results into cells, and the program reads the entry it needs.

```js
let ancestor = row // e.g. the pointed comment's ancestor at the pointed indent level
while (ancestor > 0 && depths[ancestor] > level) ancestor--
```
```txt
depths [0 1 2 1 2 3]    ancestorAtLevel, one row per comment and one column per level, e.g. row 3: [0 3 3 3], row 5: [0 3 4 5]
the program:            ancestor = ancestorAtLevel[row × 4 + level], 1 operation
```

- **Circuit version.** The host writes the table into cells, e.g. the guide example's `prepareAncestorTable(depths, rowCapacity, levelCount)`, and the program reads it with `circuit.indexReadAffine([[row, levelCount], [level, 1]], 0, ancestorTable, 'clamp', 'clamp')`, then e.g. `circuit.indexRead(ancestor, rowTops)`. The table sits in cells, so one compiled program runs any data, and the backward pass gives gradients to a table's values, e.g. a spring matrix, while a read's index gets none: `backpropagateReference` throws there unless the caller passes `{indexGradient: 'zero'}`.
- **Cost.** 1 operation in 1 layer per read at any table size: the ancestor and its top are 2 operations in 2 layers both at 64 rows × 8 levels and at 1,024 rows × 16 levels. JavaScript pays O(table size) whenever the data changes.
- **Exact when.** Each read's index holds an integer within its declared range, strictly inside ±2^24, which `validateIndexReads` checks in tests. Every cell holds a value within its declared range, including rows past the last comment. The table matches the data, so JavaScript rewrites it before the evaluation in which new data can be read.
- **Don't use it when.** The table's inputs change inside the frame, e.g. which comments are collapsed after this frame's click: the table would lag one evaluation. The table grows too fast, e.g. a line break rule over three neighboring classes needs 41 × 41 × 41 = 68,921 cells in code-points. Nothing changes at runtime and nothing will be learned: constants let the builder compute everything whose inputs are known, e.g. ranking 64 items is 64 constant operations when their widths are known while building, and 8,128 when the widths are in cells.
- **Used in, long form, test.** code-points' 41 × 41 pair table of line break rules, and the spring matrix that host-timing.ts writes. [tables-javascript-writes.md](../lab/ui-exploration/guide/patterns/tables-javascript-writes.md), tested by [tables-javascript-writes.test.ts](../lab/ui-exploration/guide/examples/patterns/candidates-and-tables/tables-javascript-writes.test.ts).

## Not written up yet

The exploration found more loops that no entry covers yet. Each one is explained in a section or a prototype:

- Window slots: DOM slot k shows `firstVisibleRow + k` when the visible rows form one run, e.g. hn-thread's 48 window slots, 1,269 operations ([executor, UI jobs under each choice](../lab/ui-exploration/guide/sections/executor.md#ui-jobs-under-each-choice)).
- Floor division by a constant with a correction step, numeric-library's `emitFloorDivide`, 8 operations in 7 layers ([numeric-library](../lab/ui-exploration/numeric-library/README.md#merged-from-index-read-september-16-2026)), and division by a runtime count through reciprocals read from the count's one-hot, as in codegen's life-calendar ([loops, section 4](../lab/ui-exploration/guide/sections/loops.md#other-uses)).
- Other ways to find the first hit: earlier-hit counts `relu(hit − hitsBefore)` ([loops, way 1](../lab/ui-exploration/guide/sections/loops.md#circuit-way-1-count-the-earlier-hits)), the largest key ([way 3](../lab/ui-exploration/guide/sections/loops.md#circuit-way-3-the-largest-key)), and numeric-library's exact minimum by counting.
- Per-item constants moved from weights to inputs ([instancing](../lab/ui-exploration/guide/sections/instancing.md#per-item-constants-from-weights-to-inputs)).
- A line's end as a count of "the line through segment j fits" bits, and the next-start table built from those counts ([text, idea 2](../lab/ui-exploration/guide/sections/text.md#a-lines-end-is-a-count)).
- Map lookups by id, e.g. lab/data-adapter's equality-bit lookup over 12 slots ([data-adapter](../lab/data-adapter/README.md)).
- One interpreter program whose rules live in cells, so different state machines run through one compiled program ([chains](../lab/ui-exploration/guide/sections/chains.md#batching-different-chains-together)).
- Sorting networks, O(n log² n) operations in O(log² n) layers ([loops, section 5](../lab/ui-exploration/guide/sections/loops.md#a-sorting-network-instead)).
- Training through a soft read, then running the hard tree ([indexing](../lab/ui-exploration/guide/sections/indexing.md#hard-attention-as-the-limit), [lab/cascade-argmax](../lab/cascade-argmax/README.md)).

The guide's earlier list also named constructions that replace one expression, i.e. circular coordinates, a masked sum over a one-hot as a read, and Newton's method and polynomials for division, square roots, sine and cosine ([numeric-library](../lab/ui-exploration/numeric-library/README.md)). Those are in [expressions.md](expressions.md).
