# Tutorial

This tutorial walks through [template/](../template/), a toggle switch written as one numeric program. Like a native switch, it acts on release: a press on the track arms it, and a release on the track while it's armed flips it. The thumb springs to its new side.

```sh
bun run start:template   # the page, at http://localhost:3000/
bun test template        # its test
bunx tsc -p .            # the type-check, which prints nothing when it passes
```

`bun` runs TypeScript without checking its types, so run the type-check after a change.

A numeric program is a fixed list of operations over 32-bit floats, called FP32 here, mostly weighted sums and products with a ReLU. You don't write the list itself: you write builder code, i.e. ordinary JavaScript that runs once and appends operations to a `Circuit`, so nothing in the program branches or loops at runtime. The program reads a `Float32Array`, the source table. The JavaScript around the program is the host: it writes browser inputs into the table and runs the program on it, which is one evaluation, then writes the program's next-state values back into the table and its other outputs to the DOM. `toggle.ts` holds the cells, the builder code, the host loop and the DOM writes, `toggle-reference.ts` is the same switch in plain JavaScript, `toggle.test.ts` compares the two, and `index.html` with `main.ts` is the page.

## Cells

Every number the program reads, or keeps from one evaluation to the next, is a cell of the source table. toggle.ts declares each cell once with the functions of [cells.ts](../src/runtime/cells.ts), which say what happens to the cell around an evaluation, and take a range and an initial value:

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

`springMatrix`, `settleCheck` and `snap` are what the host writes before each evaluation to step the thumb's spring, see [Builder code](#builder-code) and [The host loop](#the-host-loop). `matrixEntry` is `input([-matrixBound, matrixBound])`, where `matrixBound`, from `springMatrixBound(springConstants)`, is the largest magnitude that any of the matrix's 4 numbers can have.

| Declaration | Around an evaluation | E.g. |
| --- | --- | --- |
| `constant(value, range)` | set once in the initial table, and kept | a margin of 12 px |
| `input(range, {initial, grid})` | written by JavaScript before the evaluation, and kept | the viewport width |
| `inputBit(initial)` | an input that is exactly 0 or 1 | `settleCheck`, which says whether the spring may come to rest in this evaluation |
| `event()` | an exact bit that JavaScript sets to 1 when an event arrives, and the program resets to 0 | a pointer press, next to input cells for its coordinates, or a keyboard shortcut, e.g. `reset: event()`, which has no coordinate cells |
| `state(range, {initial, grid})` | computed by the program | the thumb's velocity |
| `stateBit(initial)` | a state cell that is exactly 0 or 1 | whether the switch is on |

Cells nest into objects and lists, e.g. `list(4, index => ({open: stateBit(Number(index === 0))}))`. `oneHot(members)` declares that exactly one member is 1, e.g. the selected tab, `permutation(order)` stores a stacking order as a matrix whose rows and columns are one-hot, and `table.atMostOne(name, members)` only adds a check that at most one of the members is 1. A number that builder code knows, e.g. the track width, becomes a coefficient or a bias of an operation rather than a cell. Declare it as a `constant` cell instead when it should change without rebuilding the program, e.g. a margin tuned by hand or by gradients.

A range is a promise that builder functions rely on and every evaluation checks. A grid is a second promise: every value is a multiple of that power of two, e.g. `{grid: 1 / 64}` for pointer coordinates rounded to 1/64 px. Both decide what a comparison costs. `emitCompare`, which builds e.g. `a >= b`, throws for an operand whose range isn't finite. When both operands have grids, like a pointer coordinate on 1/64 px and a track edge on 1/2 px, the comparison takes 2 operations. Without grids, operands within 0..16,384 take 15. Both forms return the same bits, so a missing grid shows only in the program's size: count the entries of `circuit.roundingPoints()` by kind after building, `'integer bit'` for the short form and `'sign cascade'` for the long one ([expressions.md](expressions.md#decision-bits) has an example, and [execution-model.md](execution-model.md#comparisons) the rules).

The thumb's ranges leave room around what the spring does. Released from rest 20 px from its destination, a spring with stiffness 650 and damping 45 peaks at 207 px/s, about 10 × the travel, and overshoots by 0.009 px, and a flip while the thumb still moves adds less than 0.1% to either. So ±2 × travel holds the displacement, and ±64 × travel the velocity. For a spring with other constants, step it in JavaScript with `springStepMatrix` over the worst sequence of retargets it can get, since an evaluation throws when a value leaves its declared range.

Building has two phases, since a `Circuit` needs the number of cells before the first operation exists:

```ts
const table = createSourceTable()
const cells = table.declare(toggleCells) // wires, e.g. cells.down.x is that cell's position in the table
const circuit = table.createCircuit() // declares every range, grid and one-hot group
// ...builder code...
table.next(cells.on, on) // each state cell gets exactly one next value
return {cells, output, ...table.finish()} // circuit, nextSource, initialSource, validate
```

A wire is the position of a number, either a cell or the result of an operation. `table.declare` gives each cell a position in declaration order and returns the cells' wires. From the declarations, the table also derives the initial table, a validator, i.e. a function that checks a table against every declaration, and `nextSource`, which lists the wire that holds each cell's next value: a constant or an input holds itself, and an event holds 0. A state cell that never gets a next value, or gets two, throws while building, with the cell's name. `table.next` pairs whole objects by field name, e.g. `table.next(cells.thumb, {velocity, displacement, destination})` in any field order.

A wire has the type `Wire`, a number with a type of its own, so a plain number doesn't type-check where a wire is expected, e.g. `emitCompare(circuit, cells.down.x, '>=', 614)` is refused. Write a threshold that builder code knows as a constant wire instead, e.g. `emitCompare(circuit, cells.down.x, '>=', circuit.constant(614))`, which folds into the comparison's bias. Unlike a `constant` cell, `circuit.constant(value)` has no position in the table, so changing the value means rebuilding the program. The type doesn't catch the opposite mistake, a wire where a number is expected, e.g. `circuit.affine([[cells.viewportWidth, 0.5]], cells.viewportHeight)` adds the height cell's position as a bias.

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

`emitCompare(circuit, a, relation, b)` returns a wire that is exactly 1 when the comparison holds and 0 otherwise. `emitSelect(circuit, condition, off, on)` computes both sides and picks one, so an `if` that assigns a cell becomes a select on the cell's next value. The inputs are handled in a fixed order, down, then up, then cancel. Where JavaScript would reassign a variable, builder code makes a new wire: `armedAfterDown` holds the value after the press, while `cells.armed` still holds the previous evaluation's value. Each call of `insideTrack` appends a whole hit test, and the program computes both hit tests in every evaluation.

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

A program can't loop a number of times that is only known at runtime, and the time since the last evaluation decides how many fixed 4 ms steps the spring takes. One step is a 2 × 2 matrix applied to the spring's displacement and velocity, and n steps are that matrix to the power n. So the host counts the steps and writes the 4 numbers of that power into the `springMatrix` cells, and the program applies it once. `emitAnimatedObject` returns `displacements`, `velocities` and `positions`, one wire per spring, and the bits `settled` and `active`. The spring stores its displacement from its destination and its velocity, and `positions` is what to draw. `destinationDuringSteps` is the previous evaluation's destination, since the steps simulate time before this evaluation's events. `active` is 1 while the thumb still moves. execution-model.md's [Springs and time](execution-model.md#springs-and-time) has the contract.

## The host loop

`createToggleMachine` is the host. Event handlers only queue events with their timestamps. Each frame calls `advanceFrame` from [host-timing.ts](../src/runtime/host-timing.ts), which plans the frame's evaluations: one per distinct event timestamp, which steps the spring to that timestamp before applying the events, a settle check every 64 ms of simulated time, and one at the frame's timestamp. A settle check is an evaluation in which a spring that is within 0.01 px of its destination and no faster than 0.01 px/s lands on the destination and stops. A moving spring stops at no other evaluation, so it stops at the same simulated time at every frame rate. The one exception is a snap, which pins the thumb onto its destination when a frame would need more than 300 steps, e.g. after a long stall.

`advanceFrame` calls the callback below for each evaluation. The callback reads five fields of the planned `evaluation`: `steps`, the number of spring steps, whose matrix it writes into the matrix cells; `settleCheck` and `snap`, which it writes into the two bit cells; `events`, the queued events at this evaluation's timestamp; and `writesBack`, which says whether to evaluate the table itself and write next state back, or to evaluate a copy. `advanceFrame` then returns the clock, which runs, i.e. its `animatedUntilMs` isn't null, while something animates.

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

`advanceFrame`'s `writeBack` argument says which evaluations write state back. The template passes `'events and settle checks'`: only evaluations that apply events, check settling or snap write state back, and a frame's own evaluation runs on a copy, so stored state depends on the events and not on the frame rate ([behavior-choices.md](behavior-choices.md#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks) explains that choice). The other value, `'every evaluation'`, is `advanceFrame`'s default, and also writes state back after a frame's own evaluation. Within one evaluation, an event cell and its coordinates keep the last event of its kind, and events with different timestamps get evaluations of their own.

`evaluate(values)` checks the table against every declaration before running the program, and checks the next-state values and the outputs before returning them, e.g. a pointer coordinate off the 1/64 px grid throws `down.x must be a multiple of 0.015625`, and a NaN output throws with the operation that produced the NaN. These checks visit every cell twice per evaluation, the table and then its next values, so their cost grows with the number of cells and not with the program. That doesn't matter for the toggle's 20 cells, while 100,000 cells take about 90 µs per check in Bun. A host with that many cells can call `built.circuit.createTensorEvaluator(wires)` instead, e.g. with `[...built.nextSource, ...outputWires]`, or with the output wires alone for [a program without state](#a-program-without-state-or-animation). It checks only each cell's range, and returns those wires' values in an array that the next call overwrites. Keep `createEvaluator` in tests, since its errors name the cell or the operation that broke a declaration.

A resize isn't an event: it doesn't start the clock, and its frame's evaluation runs on a copy of the table. So put a spring on an offset within an element that follows the viewport, like the thumb's offset within the track, and not on a position on the page. A spring whose destination is a page position, e.g. `trackLeft + on × travel`, keeps drawing its old position after a resize until the next event, and a resize that moves the destination by more than the displacement cell's range, ±40 px here, makes `evaluate` throw.

## DOM writes

`mountToggle` runs one step per `requestAnimationFrame`, then writes the DOM from output numbers only:

```ts
const output = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime)
track.style.transform = `translate3d(${output.trackLeft}px,${output.trackTop}px,0)`
track.setAttribute('aria-checked', output.on === 1 ? 'true' : 'false')
thumb.style.transform = `translate3d(${layout.thumbInset + output.thumbOffset}px,${layout.thumbInset}px,0)`
if (machine.clock.animatedUntilMs !== null) scheduleRender()
```

The page requests another frame only while the clock runs, i.e. until an evaluation that writes state back finds nothing animating. Pointer handlers round coordinates onto the declared 1/64 px grid and pass `event.timeStamp`, which shares `requestAnimationFrame`'s time origin. A keyboard shortcut goes through the same queue: a `keydown` handler queues an event with the key event's `timeStamp` and no coordinates. Drawing stays in CSS, e.g. the track's color mixes gray and green by `--fill`.

## Testing against JavaScript

`toggle-reference.ts` is the same switch in plain JavaScript, in float64, with the timing that `advanceFrame` plans: 4 ms spring steps up to each event's timestamp, and a settle check every 64 ms of simulated time. Events that share a timestamp apply together, in the order that the program handles them, whichever arrived first: the press, then the release, then the cancel. The reference never snaps, so the trace's stalls stay below about 1,140 ms, the shortest stall that can snap.

`toggle.test.ts` runs both over a scripted trace and compares them every frame: the `on` and `armed` bits and the track position exactly, the thumb within 1e-5 px, and whether the clock still runs. Decisions match exactly, since `emitCompare`'s bits equal JavaScript's comparisons for every declared value. Positions come out of FP32 spring arithmetic, and differ from float64 by 1.3e-6 px at most over this 20 px travel. FP32 rounds the stored displacement and velocity at their own size, so the difference grows with the distance a spring travels, e.g. up to 1.4e-4 px in traces whose destinations move by hundreds of pixels ([execution-model.md](execution-model.md#which-evaluations-write-state-back)). Scale the tolerance with the travel.

Each scripted step states what it must do, e.g. a press 1/64 px left of the track doesn't arm the switch, and whether the thumb must still be moving when it lands, so a step that silently does nothing fails the test. Put presses exactly on edges, e.g. `x === trackLeft`, since an inexact decision shows there first. A copied test with another trace changes two assertions: the number of frames during which the clock runs, 38 here, and the thumb's rest position at the end, 20 px. Another test puts events at one timestamp in other orders, e.g. a cancel and then a press, and compares both versions.

## A program without state or animation

A program that only computes outputs from its inputs, e.g. a progress bar's fill from the number of loaded files, leaves out what springs need: `advanceFrame`, the spring matrix, settle check and snap cells, and `emitAnimatedObject`. Declare input and constant cells, call `table.finish()` with no `table.next` call, since only state cells need a next value, and create one evaluator with `createEvaluator(built)`. Then, once per frame in which an input changed, e.g. in a `requestAnimationFrame` callback that an input event schedules, write the inputs into the table, evaluate once, and write the DOM. An input or constant cell's next value is the cell itself, so nothing needs to be written back, while an event cell's next value is 0, so a program with event cells still copies next values back or sets its event cells to 0.

`createEvaluator` checks the table, and then the next values. Without state or event cells, every next value is the cell itself, so the second check repeats the first. To skip it, check the table with `built.validate(source)` and evaluate the output wires alone with `createTensorEvaluator` ([buffer lifetime](execution-model.md#buffer-lifetime)):

```ts
const built = buildProgressBar() // returns {cells, output, ...table.finish()}, with no table.next call
const outputWires = [built.output.fillWidth, built.output.overBar]
const evaluate = built.circuit.createTensorEvaluator(outputWires)
const source = new Float32Array(built.initialSource)
function run(inputs: {pointerX: number, loadedFiles: number}) {
  source[built.cells.pointerX] = inputs.pointerX
  source[built.cells.loadedFiles] = inputs.loadedFiles
  built.validate(source)  // every cell against its declaration, e.g. "loadedFiles must be finite and within 0..320, got 321"
  return evaluate(source) // the outputs, in outputWires' order, in an array that the next call overwrites
}
```

A program with state but nothing animating also evaluates once per frame, then writes next values back, e.g. with `source.set(result.nextValues)`, as toggle.ts does.

## Adding a second switch

toggle.ts builds one switch. To show two, turn the switch into a component: a plain object of its cells, and a build function that takes the circuit, the table, the component's wires and the parent's wires. The parent declares the component's cells once per switch, before `createCircuit`. The snippet also imports `list` and the types `SourceTable` and `CellWires` from cells.ts, and the type `Circuit` from numeric-ui-core.ts:

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

// In buildToggle, after createCircuit, with `gap: 16` added to `layout`. JS: top = viewportHeight / 2 - trackHeight - gap / 2 + index × (trackHeight + gap)
const switches = cells.switches.map((switchWires, index) => buildSwitch(circuit, table, switchWires, cells, trackLeft,
  circuit.affine([[cells.viewportHeight, 0.5]], -layout.trackHeight - layout.gap / 2 + index * (layout.trackHeight + layout.gap))))
// JS: switches.some(item => item.active), as the sum of their exact active bits
const output = {trackLeft, switches, active: circuit.affine(switches.map(item => [item.active, 1] as const))}
```

What else changes:

- **Spring matrix.** Both thumbs read the same `springMatrix`, since they have the same stiffness and damping. A spring with other constants needs matrix cells of its own.
- **Settling.** Each `emitAnimatedObject` call settles its springs together, so with one call per switch, one thumb settles while the other still moves, and `result.output.active > 0` still says whether the clock should run.
- **Page.** Give it a second `.track` element, and write each switch's `top`, `on` and `thumbOffset` to its own element.
- **Test.** Give the reference and the trace a second switch too. In the reference, each thumb settles alone at a settle check, and the clock stops when both have settled.

Photos, a window of HandwiredOS, the desktop demo in src/handwiredos/, is a component of this form: `photoCells` in [photo-gallery.ts](../src/handwiredos/photo-gallery.ts) holds its cells, `buildPhotos(circuit, table, cells, host)` builds it from wires that its parent passes as `host`, e.g. the size of the window's content box, and [window-manager.ts](../src/handwiredos/window-manager.ts) declares `photos: photoCells` among its own cells. Three more things to know about components:

- **Cells come first.** A component can't add cells while building. `table.declare(switchCells, 'extraSwitch')` declares one more switch in a second call, before `createCircuit`, with `extraSwitch` in its cells' error messages. A rule over a component's cells goes there too, e.g. `table.atMostOne('photos events', photoEvents(cells.photos))`.
- **Parent's wires.** A build function starts by declaring the ranges it relies on for the parent's wires, e.g. `buildPhotos` calls `circuit.assumeRange(host.viewportWidth, 0, 16_384)`. `assumeRange` throws while building when it narrows a wire that operations already read.
- **Dragging.** A drag, e.g. of a slider thumb, keeps state between the press and the release. patterns.md's [A state machine over queued events](patterns.md#a-state-machine-over-queued-events) shows the construction, and HandwiredOS's window drag in window-manager.ts is an example.

## A new app folder

To start another app, copy template/ to a new folder next to it at the repo root, e.g. counter/, so that its imports from `../src/runtime/` still resolve, and add the folder in three places, since `bun run check` and `bun run test` only see the folders they list:

- tsconfig.json's `include` list, e.g. `"counter/*.ts"`, so tsc type-checks the folder. Without this entry nothing reports a plain number where a wire is expected, e.g. `emitCompare(circuit, cells.down.x, '>=', 3)` runs and compares with the cell at position 3.
- scripts/check.ts's oxlint command, e.g. `'counter'` next to `'template'`.
- package.json's `test` script, e.g. `bun test --timeout 30000 ./tests ./template ./counter ./lab`. A script that serves the page goes next to `start:template`, e.g. `"start:counter": "bun ./counter/index.html"`.

After the tsconfig.json entry, `bunx tsc -p .` type-checks the new folder with the root project in under a second. `bun run check` also type-checks every lab folder and lints, in about 3 s. `bun run knip`, which reports unused exports, only looks at src/, scripts/ and template/, and a new folder doesn't need it. To have it cover the folder, add `counter/main.ts` and `counter/toggle-reference.ts` to knip.config.ts's `entry` list, the second because only the test imports it, and `counter/*.ts` to `project`.

The repo's three demos have another layout: the code in a folder of src/, e.g. src/learned-gallery/, the page and its stylesheet in assets/, and the tests in a folder of tests/, e.g. tests/learned-gallery/. The check and the tests already cover those folders. An app with that layout adds itself in two other places: the module that its page loads goes into knip.config.ts's `entry` list, e.g. `'src/learned-gallery/learned-gallery.ts'`, and a page of the demo site goes into scripts/demo-site-pages.ts's list of pages.

## More

[README.md](README.md) lists the other docs in reading order: [expressions.md](expressions.md) for one expression, [patterns.md](patterns.md) for loops, [behavior-choices.md](behavior-choices.md) for choices that change what the user sees, and [execution-model.md](execution-model.md) to look things up in.
