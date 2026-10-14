# Tutorial

This tutorial walks through [template/](../template/), a toggle switch written as one numeric program. Like a native switch, it acts on release: a press on the track arms it, and a release on the track while it's armed flips it. The thumb springs to its new side. Run it with `bun run start:template`, run its test with `bun test template`, and type-check it with `bunx tsc -p .`, since `bun` strips types without checking them; tsc prints nothing when the check passes. `bun run check` runs the same type-check on every lab folder and then lints, so it takes longer.

JavaScript writes browser inputs into a `Float32Array`, the source table, and runs the program on it. The program's next-state values are written back into the table, and its other outputs go to the DOM. Builder code is ordinary JavaScript that runs once and appends operations to a `Circuit`, so nothing in the program branches or loops at runtime. `toggle.ts` holds the cells, the builder code, the host loop and the DOM writes, `toggle-reference.ts` is the same switch in plain JavaScript, `toggle.test.ts` compares the two, and `index.html` with `main.ts` is the page.

## Cells

Every number the program reads, or keeps from one evaluation to the next, is a cell of the source table. [cells.ts](../src/runtime/cells.ts) declares each cell once, with what happens to it around an evaluation, a range and an initial value:

```ts
const coordinate = () => input([-16_384, 16_384], {grid: 1 / 64})
export const toggleCells = {
  viewportWidth: input([0, 16_384], {initial: 1280, grid: 1}),
  viewportHeight: input([0, 16_384], {initial: 800, grid: 1}),
  down: {active: event(), x: coordinate(), y: coordinate()},
  up: {active: event(), x: coordinate(), y: coordinate()},
  cancel: event(),
  on: stateBit(),
  armed: stateBit(),
  springMatrix: [matrixEntry, matrixEntry, matrixEntry, matrixEntry] as const,
  settleCheck: inputBit(),
  snap: inputBit(),
  thumb: {
    displacement: state([-2 * layout.travel, 2 * layout.travel]),
    velocity: state([-64 * layout.travel, 64 * layout.travel]),
    destination: state([0, layout.travel]),
  },
}
```

| Declaration | Around an evaluation | E.g. |
| --- | --- | --- |
| `constant(value, range)` | set once in the initial table, and kept | a margin of 12 px |
| `input(range, {initial, grid})` | written by JavaScript before the evaluation, and kept | the viewport width |
| `inputBit(initial)` | an input that is exactly 0 or 1 | the settle check bit |
| `event()` | an exact bit that JavaScript sets to 1 when an event arrives, and the program resets to 0 | a pointer press, next to input cells for its coordinates, or a keyboard shortcut, e.g. `reset: event()`, which has no coordinate cells |
| `state(range, {initial, grid})` | computed by the program | the thumb's velocity |
| `stateBit(initial)` | a state cell that is exactly 0 or 1 | whether the switch is on |

Cells nest into objects and lists, e.g. `list(4, index => ({open: stateBit(Number(index === 0))}))`. `oneHot(members)` declares that exactly one member is 1, e.g. the selected tab, `permutation(order)` stores a stacking order as a matrix whose rows and columns are one-hot, and `table.atMostOne(name, members)` adds a rule that only the validator checks. A number that builder code knows, e.g. the track width, becomes a coefficient or a bias of an operation rather than a cell. Declare it as a `constant` cell instead when it should change without rebuilding the program, e.g. a margin tuned by hand or by gradients.

A range is a promise that the builder relies on and the validator checks. E.g. `emitCompare` refuses operands with open ranges, and when both operands lie on declared grids, like pointer coordinates on a 1/64 px grid and a track edge on a 1/2 px grid, it builds an exact comparison in 2 operations, while operands within 0..16,384 with no grid need a sign cascade of 15 operations ([execution-model.md](execution-model.md#comparisons)). Both constructions return the same bits, so only the program's size shows which one a comparison got. `circuit.roundingPoints()` lists the operations of every `emitCompare` call with the kind `'integer bit'` or `'sign cascade'`, next to boolean atoms and marked operations, so count its entries by kind after building, e.g. lists' text rows at 10,000 rows has 60,708 integer bit operations and one comparison built as a sign cascade of 17 operations, since under the declared worst-case totals its operands span more than 2^24 quarter pixels ([rounding points](execution-model.md#rounding-points)).

The thumb's ranges come from stepping the spring in JavaScript with `springStepMatrix`: released from rest 20 px from its destination, this spring, with stiffness 650 and damping 45, peaks at 207 px/s, about 10 × the travel, and overshoots by 0.009 px, and flipping the destination while the thumb still moves adds less than 0.1% to either, so ±2 × travel for the displacement and ±64 × travel for the velocity leave room. Measure a spring with other constants the same way, over the worst sequence of retargets it can get, since `evaluate` throws when a value leaves its declared range.

Building has two phases, since a `Circuit` needs the number of cells before the first operation exists:

```ts
const table = createSourceTable()
const cells = table.declare(toggleCells) // wires, e.g. cells.down.x is that cell's position in the table
const circuit = table.createCircuit() // declares every range, grid and one-hot group
// ...builder code...
table.next(cells.on, on) // each state cell gets exactly one next value
return {cells, output, ...table.finish()} // circuit, nextSource, initialSource, validate
```

The table derives each cell's position in declaration order, the circuit's declarations, the initial table, a validator, and `nextSource`, the wire that holds each cell's next value: a constant or an input holds itself, and an event holds 0. A state cell that never gets a next value, or gets two, throws while building, with the cell's name. `table.next` pairs whole objects by field name, e.g. `table.next(cells.thumb, {velocity, displacement, destination})` in any field order.

A position in the table has the type `Wire`, a number with a type of its own, so a plain number doesn't type-check where a wire is expected, e.g. `emitCompare(circuit, cells.down.x, '>=', 614)` is refused. Write a threshold that builder code knows as a constant wire instead, e.g. `emitCompare(circuit, cells.down.x, '>=', circuit.constant(614))`, which folds into the comparison's bias. Unlike a `constant` cell, `circuit.constant(value)` has no position in the table, so changing the value means rebuilding the program. The type doesn't catch the opposite mistake, a wire where a number is expected, e.g. `circuit.affine([[cells.viewportWidth, 0.5]], cells.viewportHeight)` adds the height cell's position as a bias.

## Builder code

Each line of builder code appends the operations of one familiar expression, and the comments in toggle.ts show the JavaScript that each line replaces. `circuit.affine(terms, bias)` appends a weighted sum, where each term is a `[wire, coefficient]` pair, e.g. `circuit.affine([[cells.viewportWidth, 0.5]], -26)` computes `viewportWidth × 0.5 - 26`. `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)` appends `(leftTerms + leftBias) × max(0, gateTerms + gateBias)`, so `circuit.reglu([], 1, terms, bias)` computes `max(0, terms + bias)`, a ReLU. Every arithmetic step rounds to FP32, like `Math.fround`.

```ts
// JS: trackLeft = viewportWidth / 2 - trackWidth / 2
const trackLeft = circuit.affine([[cells.viewportWidth, 0.5]], -layout.trackWidth / 2)
// JS: bits.every(bit => bit === 1), as relu(sum of bits - (count - 1)).
const all = (...bits: Wire[]) => circuit.reglu([], 1, bits.map(bit => [bit, 1] as const), 1 - bits.length)
// JS: !bit
const not = (bit: Wire) => circuit.affine([[bit, -1]], 1)
// JS: x >= trackLeft && x < trackLeft + trackWidth && y >= trackTop && y < trackTop + trackHeight
const insideTrack = (point: {x: Wire, y: Wire}) => all(emitCompare(circuit, point.x, '>=', trackLeft), /* ...3 more */)
// JS: if (down) armed = insideTrack(down)
const armedAfterDown = emitSelect(circuit, cells.down.active, cells.armed, insideTrack(cells.down))
// JS: if (up && armed && insideTrack(up)) on = !on
const on = emitSelect(circuit, all(cells.up.active, armedAfterDown, insideTrack(cells.up)), cells.on, not(cells.on))
// JS: if (up || cancel) armed = false
const armed = all(armedAfterDown, not(cells.up.active), not(cells.cancel))
```

A wire is a number's position, either a cell or an earlier operation. `emitSelect(circuit, condition, off, on)` computes both sides and picks one, so an `if` that assigns a cell becomes a select on the cell's next value. The inputs are handled in a fixed order, down, then up, then cancel, the way a JavaScript render reassigns a local variable: `armedAfterDown` holds the value after the press, while `cells.armed` still holds the previous evaluation's value. Each call of `insideTrack` appends a whole hit test, and the program computes both hit tests in every evaluation.

```ts
// JS: thumb.destination = on ? travel : 0, then step the thumb's spring toward it.
const destination = circuit.affine([[on, layout.travel]])
const thumb = emitAnimatedObject(circuit, [{
  matrix: cells.springMatrix, displacement: cells.thumb.displacement, velocity: cells.thumb.velocity,
  destination, destinationDuringSteps: cells.thumb.destination,
}], {settleCheck: cells.settleCheck, snap: cells.snap})
table.next(cells.thumb, {displacement: thumb.displacements[0]!, velocity: thumb.velocities[0]!, destination})
const output = {trackLeft, trackTop, thumbOffset: thumb.positions[0]!, on, armed, active: thumb.active}
```

A program can't loop a runtime number of times, so JavaScript counts the spring's fixed 4 ms steps and writes the matrix of all of them into `springMatrix`. `emitAnimatedObject` returns `displacements`, `velocities` and `positions`, one wire per spring, and the bits `settled` and `active`. The spring stores its displacement from its destination and its velocity, and `positions` is what to draw. `destinationDuringSteps` is the previous evaluation's destination, since the steps simulate time before this evaluation's events. `active` is 1 while the thumb still moves. execution-model.md's [Springs and time](execution-model.md#springs-and-time) has the contract. [expressions.md](expressions.md) has more constructions for one expression, e.g. `Math.min(a, b)`, `x / y` and `table[index]`, and [patterns.md](patterns.md) has constructions for loops, e.g. `findIndex` over overlapping click targets or `items.sort(compare)`.

## The host loop

`createToggleMachine` is the JavaScript around the program. Event handlers only queue events with their timestamps. Each frame calls `advanceFrame` from [host-timing.ts](../src/runtime/host-timing.ts), which plans the frame's evaluations: one per distinct event timestamp, which steps the spring to that timestamp before applying the events, a settle check every 64 ms of simulated time, and one at the frame's timestamp. For each evaluation, the callback writes the spring matrix of `evaluation.steps` steps, the settle check bit, the snap bit, the viewport and the events into the table, runs the program, and writes next state back. The snap bit pins the thumb onto its destination when a frame would need more than 300 steps, e.g. after a long stall.

```ts
const evaluate = createEvaluator(built) // compiles the program for nextSource and the output
// The spring matrix of every step count a frame can plan.
const matrices = Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(springStepMatrix(springConstants), steps))
machine.clock = advanceFrame(machine.clock, frameTime, queued, evaluation => {
  const values = evaluation.writesBack ? source : copy
  if (!evaluation.writesBack) copy.set(source)
  const matrix = matrices[evaluation.steps]!
  cells.springMatrix.forEach((wire, index) => { values[wire] = matrix[index]! })
  values[cells.settleCheck] = evaluation.settleCheck ? 1 : 0
  values[cells.snap] = evaluation.snap ? 1 : 0
  values[cells.viewportWidth] = viewportWidth
  values[cells.viewportHeight] = viewportHeight
  for (const {kind, x, y} of evaluation.events) {
    if (kind === 'cancel') {
      values[cells.cancel] = 1
    } else {
      values[cells[kind].active] = 1
      values[cells[kind].x] = x
      values[cells[kind].y] = y
    }
  }
  const result = evaluate(values)
  if (evaluation.writesBack) source.set(result.nextValues)
  frameOutput = result.output
  return result.output.active > 0
}, writeBack)
```

The callback reads five fields of `evaluation`, a `PlannedEvaluation` from host-timing.ts: `steps`, the spring step count, whose matrix goes into the matrix cells; `settleCheck` and `snap`, which go into the two bit cells; `events`, the queued events at this evaluation's timestamp; and `writesBack`, which says whether to evaluate the table itself or a copy.

`evaluate(values)` checks the table against every declaration before running the program, and checks the next-state values and the outputs before returning them, e.g. a pointer coordinate off the 1/64 px grid throws `down.x must be a multiple of 0.015625`, and a NaN output throws with the operation that produced the NaN. With `'events and settle checks'`, only evaluations that apply events, check settling or snap write state back, and a frame's own evaluation runs on a copy, so stored state depends on the events and not on the frame rate. [behavior-choices.md](behavior-choices.md#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks) explains that choice. Within one evaluation, an event cell and its coordinates keep the last event of its kind, and events with different timestamps get evaluations of their own.

These checks loop over every cell, twice per evaluation, since the next values are a whole table too, including every input and constant cell, so their cost grows with the number of cells rather than with the program. E.g. lists' text rows checks 100,004 cells in about 90 µs each time, about 180 µs of a 1,030 µs frame in Bun, and the tensor evaluator checks each source cell's range once more ([measured results](../lab/ui-exploration/lists/README.md#measured-results-in-bun)). `built.circuit.createTensorEvaluator(roots)` runs the program with only a range check of each source cell, and returns the roots' values in an array that the next call overwrites, e.g. with the output wires as roots for a program without state, or with `built.nextSource` before them for a program with state. E.g. json-highlighter's 4,575 cells, most of them constant tables, cost 138 µs per evaluation through `createEvaluator` and 122 µs through `createTensorEvaluator` on the outputs ([results](../src/json-search/highlighter/README.md#results)). Keep `createEvaluator` in tests, since its errors name the cell or the operation that broke a declaration.

A resize isn't an event, so it doesn't start the clock, and with `'events and settle checks'` a frame's evaluation runs on a copy of the table and writes nothing back. So spring offsets within an element that follows the viewport, like the thumb's offset within the track, rather than positions on the page. A spring whose destination is a page position, e.g. `trackLeft + on × travel`, keeps drawing its old position after a resize until the next event, e.g. a switch that's on keeps its thumb at x 634 instead of 644 after the viewport grows from 1280 to 1300 px. A resize that moves the destination by more than the displacement cell's range, ±40 px here, makes `evaluate` throw, e.g. `thumb.displacement must be finite and within -40..40, got -70`.

## DOM writes

`mountToggle` runs one step per `requestAnimationFrame`, then writes the DOM from output numbers only:

```ts
const output = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime)
track.style.transform = `translate3d(${output.trackLeft}px,${output.trackTop}px,0)`
track.setAttribute('aria-checked', output.on === 1 ? 'true' : 'false')
thumb.style.transform = `translate3d(${layout.thumbInset + output.thumbOffset}px,${layout.thumbInset}px,0)`
if (machine.clock.animatedUntilMs !== null) scheduleRender()
```

The page requests another frame only while the clock runs, i.e. until an evaluation that writes state back finds nothing animating. Pointer handlers round coordinates onto the declared 1/64 px grid and pass `event.timeStamp`, which shares `requestAnimationFrame`'s time origin. A keyboard shortcut goes through the same queue: a `keydown` handler queues an event with no coordinates and the key event's `timeStamp`, which has the same time origin. Drawing stays in CSS, e.g. the track's color mixes gray and green by `--fill`.

## A program without state or animation

A program that only computes outputs from its inputs, e.g. a syntax highlighter that reads the text and the caret, leaves out what springs need: `advanceFrame`, the spring matrix, settle check and snap cells, and `emitAnimatedObject`. Declare input and constant cells, call `table.finish()` with no `table.next` call, since only state cells need a next value, and create one evaluator with `createEvaluator(built)`. Then, once per frame in which an input changed, e.g. in a `requestAnimationFrame` callback that an input event schedules, write the inputs into the table, evaluate once, and write the DOM. An input or constant cell's next value is the cell itself, so nothing needs to be written back, while an event cell's next value is 0, so a program with event cells still copies next values back or sets its event cells to 0. json-highlighter's `createHighlighterMachine` in [highlighter.ts](../src/json-search/highlighter/highlighter.ts) runs this way, except that it checks the table with `built.validate(source)` and evaluates the outputs alone with `createTensorProgramEvaluator` ([buffer lifetime](execution-model.md#buffer-lifetime)), since a program without state has no next values to check. A program with state but nothing animating also evaluates once per frame, then copies its state cells' next values back, e.g. `createTextRowsMachine` in lists' [text-rows.ts](../lab/ui-exploration/lists/text-rows.ts) keeps every row's bottom from the last evaluation in 10,000 state cells, and copies their next values back with one `Float32Array.set`, since the cells were declared one after another.

## Testing against JavaScript

`toggle-reference.ts` is the same switch in plain JavaScript, in float64, e.g. `if (down !== undefined) switchState.armed = insideTrack(down) ? 1 : 0`, with the timing that `advanceFrame` plans: 4 ms spring steps up to each event's timestamp, and a settle check every 64 ms of simulated time. Events that share a timestamp apply together, in the order that the program handles them within one evaluation, e.g. a release and a press at one timestamp apply as the press, then the release, whichever arrived first. The reference never snaps, so the trace's stalls stay below about 1,140 ms, the shortest stall that can snap. `toggle.test.ts` runs both over a scripted trace of 138 frames and compares them every frame: the `on` and `armed` bits and the track position exactly, the thumb within 1e-5 px (the largest difference is 1.3e-6 px), and whether the clock still runs. That tolerance is for a 20 px travel: FP32 rounds the stored displacement and velocity at their own size, so the difference from float64 grows with the distance a spring travels, e.g. spring-matrix.test.ts's traces, whose destinations move by hundreds of pixels, stay within 1.4e-4 px ([execution-model.md](execution-model.md#which-evaluations-write-state-back)), so scale the tolerance with the travel. Each scripted step also states what it must do, e.g. a press 1/64 px left of the track doesn't arm the switch, and a release exactly on the right edge only disarms it, and whether the thumb must still be moving when the step lands, so a step that silently does nothing fails the test. Two assertions are specific to this trace, the number of frames during which the clock runs, 38, and the thumb's rest position at the end, 20 px; the others, equal bits and track position, the thumb within the tolerance and the same clock state, hold for any trace, so a copied test with another trace only changes those two. Another test puts events at one timestamp in other orders, e.g. a cancel and then a press, and compares both versions.

Decisions match exactly, since `emitCompare`'s bits equal JavaScript's comparisons for every declared value, while positions come out of FP32 spring arithmetic and match within a tolerance. Test presses exactly on edges, e.g. `x === trackLeft`, since an inexact decision shows there first.

## Adding a second switch

toggle.ts builds one switch. To show two, turn the switch into a component: a plain object of its cells, and a build function that takes the circuit, the table, the component's wires and the parent's wires. Photos in [photo-gallery.ts](../src/handwiredos/photo-gallery.ts) is a real one: `photoCells` holds its cells, and `buildPhotos(circuit, table, cells, host)` builds it from wires that the host passes, e.g. the size of the content box and whether Photos takes events. The list of the Monitor window in [value-list.ts](../src/handwiredos/value-list.ts) is a second one of the same form, with `valueListCells` and `buildValueList`. HandwiredOS in [window-manager.ts](../src/handwiredos/window-manager.ts) declares `photos: photoCells` among its own cells and passes the Photos window's content size and focus bit, while the standalone Photos machine declares the same cells next to viewport cells of its own. The parent declares the component's cells once per switch, before `createCircuit`:

```ts
// One switch: whether it's on, whether a press armed it, and its thumb's spring.
export const switchCells = {on: stateBit(), armed: stateBit(), thumb: {/* ...displacement, velocity and destination as before */}}
// toggleCells keeps the viewport, pointer, cancel and spring cells, and declares two switches.
export const toggleCells = {/* ...viewportWidth to snap as before */ switches: list(2, () => switchCells)}

// One switch whose track's top left corner is at (left, top). It reads the page's pointer, cancel and spring cells.
export function buildSwitch(circuit: Circuit, table: SourceTable, switchWires: CellWires<typeof switchCells>, page: CellWires<typeof toggleCells>, left: Wire, top: Wire) {
  // ...buildToggle's hit test, selects and spring, reading e.g. page.down.active and switchWires.armed
  table.next(switchWires, {on, armed, thumb: {displacement: thumb.displacements[0]!, velocity: thumb.velocities[0]!, destination}})
  return {top, on, armed, thumbOffset: thumb.positions[0]!, active: thumb.active}
}

// In buildToggle, after createCircuit. JS: top = viewportHeight / 2 - trackHeight - gap / 2 + index × (trackHeight + gap)
const switches = cells.switches.map((switchWires, index) => buildSwitch(circuit, table, switchWires, cells, trackLeft,
  circuit.affine([[cells.viewportHeight, 0.5]], -layout.trackHeight - layout.gap / 2 + index * (layout.trackHeight + layout.gap))))
// JS: switches.some(item => item.active), as the sum of their exact active bits
const output = {trackLeft, switches, active: circuit.affine(switches.map(item => [item.active, 1] as const))}
```

Both thumbs read the same `springMatrix`, since they have the same stiffness and damping, while a spring with other constants needs matrix cells of its own. Each `emitAnimatedObject` call settles its springs together, so with one call per switch, one thumb settles while the other still moves, and `result.output.active > 0` still says whether the clock should run. Then write each switch's numbers to its own `.track` element, and give the reference and the trace a second switch. A component can't add cells while building, and `table.declare(switchCells, 'extraSwitch')` declares one more switch in a second call, with `extraSwitch` in its cells' error messages. A rule over a component's cells also goes in before `createCircuit`, e.g. HandwiredOS calls `table.atMostOne('photos events', photoEvents(cells.photos))`, since a later Photos event within one evaluation replaces an earlier one. A build function starts by declaring the ranges it relies on for the parent's wires, e.g. `buildPhotos` declares the content box's width within 0..16,384, and `assumeRange` throws while building when such a range narrows a wire that operations already read. A drag, e.g. of a slider thumb, keeps state between the press and the release: HandwiredOS's window drag in window-manager.ts is one, and patterns.md's [A state machine over queued events](patterns.md#a-state-machine-over-queued-events) shows the construction.

## A new app folder

To start another app, copy template/ to a new folder next to it at the repo root, e.g. counter/, so that its imports from `../src/runtime/` still resolve, and add the folder in three places, since `bun run check` and `bun run test` only see the folders they list:

- tsconfig.json's `include` list, e.g. `"counter/*.ts"`, so tsc type-checks the folder. `bun` strips types without checking them, so without this entry, e.g. a plain number where a wire is expected runs without an error.
- scripts/check.ts's oxlint command, e.g. `'counter'` next to `'template'`.
- package.json's `test` script, e.g. `bun test --timeout 30000 ./tests ./template ./counter ./lab`. A script that serves the page goes next to `start:template`, e.g. `"start:counter": "bun ./counter/index.html"`.

After the tsconfig.json entry, `bunx tsc -p .` type-checks the root project with the new folder in under a second, while `bun run check` also type-checks every lab folder and lints, in about 2.5 s on an 18-core machine. `bun run knip`, which reports unused exports, only looks at src/, scripts/ and template/, per knip.config.ts's `entry` and `project` lists, so it isn't a check a new folder needs; to have it cover the folder, add the page script and the plain JavaScript reference, e.g. `counter/main.ts` and `counter/toggle-reference.ts`, to `entry`, and `counter/*.ts` to `project`. Only the folder's test imports the reference, so without its `entry` item knip reports `counter/toggle-reference.ts` as an unused file.

The repo's three demos have another layout, which those three lists already cover: the code in a folder of src/, e.g. src/learned-gallery/, the page and its stylesheet in assets/, and the tests in a folder of tests/, e.g. tests/learned-gallery/. An app with that layout adds itself in two other places: the module that its page loads goes into knip.config.ts's `entry` list, e.g. `'src/learned-gallery/learned-gallery.ts'`, and a page of the demo site goes into scripts/demo-site-pages.ts's list of pages.

## More

- [expressions.md](expressions.md): constructions that replace one familiar expression, e.g. exact decision bits for `a >= b`.
- [patterns.md](patterns.md): constructions that replace a loop, e.g. a balanced tree instead of `findIndex`.
- [behavior-choices.md](behavior-choices.md): choices that change what the user sees, e.g. hit-testing where elements are going instead of where they're drawn.
- [execution-model.md](execution-model.md): the instructions, and the contracts of the builder functions, e.g. comparisons, springs and time.
