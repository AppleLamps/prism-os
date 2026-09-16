# The model, and how familiar UI code maps onto it

This section is a refresher on how Indirect runs a UI, written for someone who knows vibescript's render loop (described in vibescript's `ui.md`) and ordinary front-end code, but hasn't written one of these circuits. It starts with what changes compared with writing an ordinary JavaScript UI, then explains the source table, the program that runs once per frame, how state is written back, and how outputs reach the DOM, and it maps each of these onto ui.md's phases. Then it covers builder code, the three operations every program is made of, the index read instruction, the first macros a UI needs, and why every value needs a declared range. The core of the section is a translation table from JavaScript concepts to circuit forms, with how their costs grow and pointers to the rest of this guide, in three groups: the same idea written differently, a different algorithm, and things JavaScript has no counterpart for. It ends with a complete small app, a toggle switch that acts on release, checked against a plain JavaScript version of the same app.

Terms used across the guide are collected in the [glossary](../README.md#glossary). Costs use two measures throughout. Operations counts the total work of one evaluation: every live operation of a compiled program runs on every frame. Depth counts layers, i.e. the longest chain of operations that must run one after another. Where a cost grows with the number of items, n stands for that number, e.g. comparing every pair of n items is O(n²) operations at constant depth.

## What changes compared with an ordinary JavaScript UI

Most familiar UI code translates into the same idea written differently, e.g. a variable becomes a wire, and `isOn ? onColor : offColor` becomes a select that computes both colors. The five habits below change more, and the rest of the guide keeps coming back to them.

**A loop that exits at the first match becomes the same computation on every item, then a count.** A JavaScript loop visits items in order and exits at the first match. A program has no early exit, so the same test runs on every item in the same layers, and the result is a count of the items that pass the test, or a small tree of pairwise choices over the test bits. E.g. `findIndex` over rows from top to bottom becomes the count of rows whose bottom is at or above the pointer ([count instead of search](../patterns/count-instead-of-search.md)), `sort` becomes, for each item, a count of the items that come before it ([ranks instead of sorting](../patterns/ranks-instead-of-sorting.md)), and `Math.floor((containerWidth - 24) / 244)` becomes a count of the fixed widths the container reaches ([threshold counts](../patterns/threshold-counts.md)). With instancing, the per-item program is written once and runs on every item ([one program per item](../patterns/one-program-per-item.md)).

**JavaScript works out a function ahead of time, and the program compares with its breakpoints or reads its values.** When JavaScript can work out once how a result depends on a runtime value, the program only compares the runtime value with the precomputed breakpoints, or reads precomputed values. E.g. pretext's paragraph heights change only at certain widths, so JavaScript finds those widths while preparing the text, and the program compares the container width with them ([breakpoints found ahead of time](../patterns/breakpoints-found-ahead-of-time.md)). A spring's ~150 steps of 4 ms, about 0.6 s of animation, become one 2×2 matrix raised to the step count, which JavaScript writes into 4 cells ([repeated steps as one matrix power](../patterns/matrix-powers.md)), and event-time reads the i-th power directly to show where every spring will be i steps later, without running the steps in between.

**A frame costs the whole program, whatever happened in the frame.** Every operation runs on every frame, like hardware. Both sides of every `?:` compute, a spring that already settled still runs its steps, and capacities, e.g. 16 queued events or 48 DOM slots, are fixed while building and paid for on every frame whether they're used or not.

**Some chains only get shorter by changing the behavior.** When a decision reads the end of a long chain of steps, regrouping the steps doesn't always help, but changing the behavior so the decision reads values computed earlier does. E.g. a press can be hit-tested against the destinations that elements animate toward instead of the positions where they're drawn, so the hit test doesn't depend on the spring steps ([hit-test destinations instead of drawn positions](../patterns/hit-test-destinations.md)). indirect-os-2 lays Notes' text around the windows' destinations, 343 layers against 368 around their drawn geometry. And committing state only at events makes each frame one evaluation starting from the last commit, instead of the end of a chain through every frame since that commit ([commit state at events](../patterns/commit-at-events.md)). Each is a change in what the user sees, so each needs its own judgment.

**The program is data.** A number in a cell can change while the page runs, differ from one copy of the program to another, or be tuned with gradients. E.g. drag-knobs moved card padding, the grid gap and three more design numbers into cells for 60 operations, so a designer can drag an edge and the design numbers change to match. One compiled window circuit ran 16,384 simulated users for 600 frames on a GPU, bit for bit equal to the CPU (user-population). A behavior can be a table in cells, so one compiled program runs both a button and a toggle switch ([tables that JavaScript writes](../patterns/tables-javascript-writes.md)). And a backward pass computes a gradient for every cell and every computed value, e.g. for the 4 cells of a spring matrix.

The [translation table](#translation-table) sorts familiar JavaScript by how much changes, and the root [patterns.md](../../../../patterns.md) explains each different algorithm in a short entry that links its long form.

## Examples in this section

The examples live in [examples/model](../examples/model/). From the repo root, `bun test lab/ui-exploration/guide/examples/model` runs 19 tests in about 0.1 s, and `bunx tsgo -p lab/ui-exploration/guide/examples/model` typechecks them. Every size this section quotes from these files is pinned by a test.

| File | What it holds |
| --- | --- |
| [helpers.ts](../examples/model/helpers.ts) | `measure` (live operations, layers, stored weights), a constant wire, NOT, a clamp to 0..1, an exact comparison, an integer comparison, and an AND of bits |
| [atoms.ts](../examples/model/atoms.ts) | Each operation and each first macro as a whole circuit, next to the JavaScript it replaces |
| [atoms.test.ts](../examples/model/atoms.test.ts) | Evaluates each circuit and its JavaScript on the same inputs, and pins the sizes |
| [toggle-switch.ts](../examples/model/toggle-switch.ts) | A toggle switch: cell declarations, builder code, the machine that runs frames, the DOM writes, and a browser host |
| [toggle-switch-reference.ts](../examples/model/toggle-switch-reference.ts) | The same toggle switch as plain JavaScript, in ui.md's shape |
| [toggle-switch-trace.ts](../examples/model/toggle-switch-trace.ts) | A scripted trace of 280 frames with 25 pointer events, and 20 named checks of what particular frames must do |
| [toggle-switch.test.ts](../examples/model/toggle-switch.test.ts) | Runs both versions over the trace and compares them on every frame |

## The render loop, split between JavaScript and one program

ui.md's render loop runs once per frame: DOM reads, then state changes in a fixed order (handle inputs, new layout and cursor, animation tick, commit state), then DOM writes and side effects, then scheduling another render while something animates. Event handlers only store raw input and schedule a render.

Indirect keeps that loop and moves its middle into one fixed numeric program. The loop itself, the DOM, strings and timestamps stay in JavaScript. The program only holds numbers. The middle of the loop splits into four pieces:

- The source table is a `Float32Array` that holds every number a frame reads: DOM reads such as the viewport width, the latest pointer press, and all state, e.g. each window's geometry and each spring's position and velocity.
- The program runs once per frame over the source table and computes every output in one pass. It's built once at startup and doesn't change while the page runs.
- Some outputs are the next values of state cells. After the frame, JavaScript copies all of them back into the source table at once. This is ui.md's commit step.
- The other outputs are numbers for the DOM, e.g. a translate x, an opacity, a focused bit, and one number that is above 0 while another frame should be scheduled. JavaScript turns them into style strings.

Here is how ui.md's phases split between the two, in IndirectOS (`window-manager.ts`) and in this section's toggle switch:

| ui.md phase | Done by | IndirectOS | Toggle switch |
| --- | --- | --- | --- |
| Initialization: state declaration | JavaScript declares cells, builds and compiles the program, and fills the initial table | `compileWindowManagerCircuit` and `createWindowManagerMachine` (window-manager.ts:325, 1286-1349) | `buildToggleSwitch`, `createToggleSwitchMachine` |
| Initialization: static DOM and event registration | JavaScript, as before | `mountWindowManager` (1543-1639, 1686-1744) | `mountToggleSwitch` |
| First paint | The same frame as every later frame, run once at mount | `renderWindowManager(window.performance.now())` (1745) | `render(window.performance.now())` |
| DOM reads | JavaScript writes numbers into input cells | the handlers queue events with their timestamps, `step` queues a resize when the viewport changed, and each evaluation writes its spring matrix, settle check bit, snap bit and events (1429-1435, 1477-1512, 1686-1744) | `step` writes the viewport size and the frame's duration |
| Handle inputs | The program, reading latch cells | hit tests, the frontmost window, presses (497-709) | `armedAfterDown`, `clicked`, `nextOn`, `nextArmed` |
| New layout and cursor | The program | the maximized rectangle and the dock (451-483, 618-678) | the track rectangle, and `hovered` for the cursor |
| Animation tick | The program | `emitAnimatedObject` for every window and thumbnail, stepped by a spring matrix that JavaScript writes (919-1034) | `emitSpring` for the thumb |
| Commit state | The program outputs next values, and JavaScript copies them all back after the frame | `nextSource` (1049-1088), copied back only by evaluations that apply events, check settling or snap (1442-1446) | `nextSource`, copied in `step` |
| DOM writes | JavaScript formats outputs into styles | `renderWindowManager` (1647-1684), with window styles in `projectWindowElements` (1753-1780) | `renderToggleSwitch` |
| Side effects | JavaScript acts on outputs when they change | none; the [input](../../input/README.md) prototype's menu bar outputs which element to focus | none |
| Schedule next render | JavaScript reads one output | whether the clock still runs, `machine.clock.animatedUntilMs !== null` (1678-1679) | `animationActive > 0` |

Inside the program, the phases don't have to come in ui.md's literal order. An operation only has to come after the values it reads, e.g. the toggle switch computes the track rectangle before the hit tests that read it.

IndirectOS's `step` has host-timing.ts's `advanceFrame` plan the frame's evaluations: one per distinct event timestamp, settle checks at fixed simulated times, and one for the frame. Each evaluation is the whole middle of the loop (window-manager.ts:1429-1456, trimmed):

```ts
function evaluate(evaluation: PlannedEvaluation<WindowManagerEvent>) {
  // A 'frame' evaluation runs on a copy, so stored state changes only at events,
  // settle checks and snaps.
  const table = evaluation.writesBack ? source : scratch
  if (!evaluation.writesBack) scratch.set(source)
  table.set(springMatrixPowers[evaluation.steps]!, sourceField.springMatrixStart)
  table[sourceField.settleCheck] = evaluation.settleCheck ? 1 : 0
  table[sourceField.snap] = evaluation.snap ? 1 : 0
  for (const event of evaluation.events) event.apply(table)
  validateWindowManagerSource(table, numericTolerance)
  const rootValues = evaluateRoots(table)
  for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
  validateWindowManagerOutput(values, output, numericTolerance)
  if (evaluation.writesBack) {
    for (let field = 0; field < source.length; field++) {
      source[field] = values[output.nextSource[field]!]!
    }
  }
  return values[output.animationActive]! > 0
}
```

Five things differ from an ordinary JavaScript render function.

**Every operation runs on every frame.** There's no early return and no branch that skips work: a spring that already settled still runs its steps, and a hit test runs whether or not a press arrived. So the cost of a frame follows how much the program was built to handle, e.g. how many windows or queued events, not what happened in the frame.

**A frame reads state only from the table as it was before the frame.** There's no `st.selectedId = x` followed by a later read of `st.selectedId` in the same render. The new value is a separate wire, and code that needs the new value reads that wire. Every state cell is committed after the frame, all at once.

**Values are FP32 numbers.** Every sum and product rounds to the nearest 32-bit float, the way `Math.fround` does. For example, integers are exact only up to 2^24 = 16,777,216, and positions 100,000 px down a page are 1/128 px apart. Decisions have to be designed to be exact; the [comparisons](comparisons.md) section covers how.

**The shape is fixed while building.** The number of cells, the number of items, the number of events a frame can hold, and every operation are decided at startup. A list whose length changes becomes a fixed capacity with presence bits, i.e. one bit per entry that is 1 when the entry holds an item.

**Strings, DOM node lifetime and platform calls stay in JavaScript**, and exchange only numbers with the program. For example, chenglou.github.io's `index.ts` finds the photo named in the URL hash with a loop over its photo list (index.ts:177-178); the [gallery](../../gallery/README.md) prototype keeps that loop in JavaScript and writes the photo's index into a cell.

## The source table

The source table plays the role of ui.md's single state object `st`, with three differences. Each field is one FP32 number at a fixed position. Each cell has a declared range, which the executor checks on every evaluation. And each cell has a policy for what happens to the cell around a frame:

- constant: written once at startup, e.g. a title bar height of 44 px. The program keeps it.
- input: written by JavaScript before a frame, e.g. the viewport width, or the latest pointer position. The program keeps the last value.
- event: a latch, i.e. a cell that holds 1 after an event handler stores an event of one kind, until a frame reads it. E.g. `downActive` is 1 after a pointer press, next to the input cells `downX` and `downY` that hold the press's coordinates. The frame's next value for a latch is 0, which is ui.md's "reset ephemeral events". A second event of the same kind before the frame overwrites the first, like ui.md's `st.events.click`.
- state: the frame computes its next value, e.g. whether a window is open.

These policies come from the [notation](../../notation/README.md) prototype's `table.ts`. The toggle switch declares its 16 cells with a smaller helper (toggle-switch.ts, trimmed):

```ts
// pointerLimit is 16,384, and open is Infinity.
const cells = {
  viewportWidth: cell('viewportWidth', 'input', 0, 16_384, 1280),
  viewportHeight: cell('viewportHeight', 'input', 0, 16_384, 800),
  frameDuration: cell('frameDuration', 'input', 0, 1000),
  pointerX: cell('pointerX', 'input', -pointerLimit, pointerLimit, -pointerLimit),
  pointerY: cell('pointerY', 'input', -pointerLimit, pointerLimit, -pointerLimit),
  downActive: cell('downActive', 'event', 0, 1, 0, true),
  downX: cell('downX', 'input', -pointerLimit, pointerLimit),
  downY: cell('downY', 'input', -pointerLimit, pointerLimit),
  // upActive, upX and upY the same way, then cancelActive
  on: cell('on', 'state', 0, 1, 0, true),
  armed: cell('armed', 'state', 0, 1, 0, true),
  thumbPosition: cell('thumbPosition', 'state', -open, open),
  thumbVelocity: cell('thumbVelocity', 'state', -open, open),
}
```

The arguments are the cell's name, its policy, its range, its initial value, and whether it's an exact bit, i.e. must hold exactly 0 or 1. Each call returns the cell's position, so `cells.viewportWidth` is the number 0 and `cells.on` is 12.

Nested objects and arrays exist only while building. The builder lays their numbers out one after another, e.g. 4 windows of 8 fields each take 32 consecutive cells, and code refers to each number by name. IndirectOS's source table has 241 cells.

The original IndirectOS writes positions by hand, and states ranges and next values in separate places (window-manager.ts:110-153, 322-399, 1019-1024 at commit 4a91fec, before its springs moved to `emitAnimatedObject`):

```ts
export const sourceField = {
  viewportWidth: 0,
  viewportHeight: 1,
  unit: 2,
  margin: 3,
  // ... 31 more fields, then offsets for windows, drag latches, stacking, springs and Photos
}
circuit.assumeRange(sourceField.viewportWidth, 0, 16_384)
// ...
const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
for (const field of eventActiveFields) nextSource[field] = zero
nextSource[sourceField.pointerX] = pointerX
```

The notation prototype declares each cell once, with its range, initial value and policy, and derives the positions, the range declarations, the initial table, a validator and the writeback from those declarations (notation/indirect-os.ts):

```ts
export const indirectOSCells = {
  viewportWidth: input(pixel),
  down: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  windows: list(windowCount, index => {
    const [left, top, width, height] = initialGeometry[index]!
    return {
      left: state(pixel, left), top: state(pixel, top), width: state(pixel, width), height: state(pixel, height),
      open: bit(1), minimized: bit(), maximized: bit(), present: state(unitInterval, 1),
    }
  }),
  // ...
}
// later, while building behavior:
table.next(cells.pointer, pointer)
```

`table.next(stored, next)` pairs state cells with their next values by field name, and throws while building when a state cell gets no next value or two. The rewrite of IndirectOS in this style compiles to exactly the same program as window-manager.ts before September 15, 2026 (5,253 live operations, 192 layers, 11,598 stored weights) and matched the original on 6,609,174 values bit for bit. Hand-kept bookkeeping went from 641 lines to 110, and validation from 357 lines to 11, with somewhat different, mostly stricter rules.

Behavior code in notation's style reads like shader code over structs: every helper closes over one circuit, and `select` works on whole objects. notation's settings panel keeps the latest pointer position and tests presses like this (notation/settings-panel.ts:84-89):

```ts
const down = {x: cells.down.x, y: cells.down.y}
const baseline = select(cells.down.active, cells.pointer, down)
const moved = select(cells.move.active, baseline, {x: cells.move.x, y: cells.move.y})
const pointer = select(cells.up.active, moved, {x: cells.up.x, y: cells.up.y})
table.next(cells.pointer, pointer)
const pressed = (box: Rect) => mul(cells.down.active, hit(down, box))
```

Each `select` is JavaScript's `latchActive ? eventPoint : previousPoint` over both coordinates, and `hit` returns 1 when the point is at least half a pixel inside the rectangle.

A `Circuit` needs its source size before the first operation exists, so building has two phases: declare every cell, including the cells of child components, then build behavior. A component can't add another cell halfway through building.

## Builder code runs once, at startup

Builder code is ordinary JavaScript that runs once, at startup, and produces the program. `new Circuit(sourceSize)` starts an empty program over a table of that size. Calls such as `circuit.affine(...)` or `emitMultiply(circuit, a, b)` append one operation or a few, and return a wire. To build a first program, the repo root's [tutorial.md](../../../../tutorial.md) walks through [template/](../../../../template/), a toggle switch on today's defaults, `emitCompare`, `emitAnimatedObject` and `advanceFrame`, checked against plain JavaScript, before the root docs [expressions.md](../../../../expressions.md), [patterns.md](../../../../patterns.md) and [behavior-choices.md](../../../../behavior-choices.md).

A wire is a number: the position of a value in the array that an evaluation fills. Positions 0 to sourceSize - 1 are the source cells, and each appended operation takes the next position. In the toggle switch, wire 0 is the viewport width cell, and the first operation the builder appends, the constant 1, is wire 16. Nothing is computed while building; the builder only records what to compute.

Familiar code means something different in builder code:

- A `for` loop runs while building and appends its body once per iteration, e.g. `for (let windowIndex = 0; windowIndex < windowCount; windowIndex++)` in window-manager.ts appends every window's hit tests 4 times. At runtime there's no loop.
- A helper function appends its operations each time it's called, e.g. the toggle switch calls its `insideTrack` helper for the pointer, the press and the release, so the program holds three hit tests. At runtime there's no call stack and no call overhead.
- An `if` chooses what to build, like a compile-time flag, e.g. `if (declareTimestepNonNegative) circuit.assumeRange(...)`. A decision on runtime values has to be built as arithmetic, e.g. a select.
- Reassigning a variable that holds a wire points the name at a new wire, and the old wire stays readable, e.g. `emitSpring` reassigns `velocity` once per substep.
- Objects and arrays of wires, e.g. `{left, top, width, height}`, cost nothing at runtime.

The builder changes costs in three ways that are easy to miss:

- A small affine sum, one with fewer than 4 terms, is copied into any ordinary affine sum that reads it, and then costs no operation of its own. For example, `buttonTop = windowTop + 13` and `closeBottom = buttonTop + 18` compile to one operation, `windowTop + 31` (`buttonTopReadTwice` in atoms.ts).
- An expression identical to an existing one returns the existing wire, so the same hit test written twice costs once.
- `emitMultiply`, `emitSelect`, `emitMinimum`, `emitMaximum` and `circuit.roundAffine` keep their operands as separate wires, so an operand that an ordinary sum would have copied becomes its own operation. For example, the clamp `Math.min(Math.max(windowLeft, 0), maxLeft)` built with a constant 0 wire is 7 operations in 7 layers, one more of each than the two macros alone, because the constant 0 stays an operation (`clampWindowLeft` in atoms.ts).

Two pitfalls come from builder code being ordinary JavaScript.

Creation order is part of the arithmetic. An ordinary affine sum adds its terms in the order of their wire numbers, which follow creation order, so moving a statement can round a fractional sum differently, e.g. computing the dock center before the window center. The notation rewrite had to create a few wires in the original's order to compile to the identical program.

`Wire` is a plain `number` type, so TypeScript's types don't distinguish a wire from a pixel value. `emitMinimum(circuit, availableWidth, 1)` reads whatever sits at position 1, e.g. the viewport height cell, not the number 1, and gives no error. A position past every existing wire fails while building, with an error message that doesn't mention the wrong argument ("undefined is not an object (evaluating 'range.maximum')"). A constant needs its own wire, e.g. `circuit.affine([], 1)`.

## Compiling and running the program

`circuit.compileTensorProgram(roots)` compiles the program for a list of roots, i.e. the wires whose values JavaScript reads. `circuit.createTensorEvaluator(roots)` compiles once and returns a function that evaluates a source table and returns the roots' values, in an array it overwrites on the next call. Compiling does three things:

1. It keeps only the live operations, the ones some root depends on. IndirectOS builds 4,011 operations and keeps 3,654. The toggle switch builds 189 and keeps 129; the other 60 are small sums and constants that the builder copied into the operations reading them.
2. It gives every operation a depth, one more than the deepest value it reads, and puts operations of equal depth in one layer. Operations in one layer don't read each other, so they could run at the same time. The number of layers is the program's depth.
3. It turns each layer into one sparse matrix multiplication: the layer's inputs are multiplied by a matrix that stores only its nonzero coefficients, biases are added, and then the ReLU gates and rounding of the layer's operations apply. The nonzero coefficients of all layers together are the program's stored weights.

There are two evaluators. `evaluateReference` runs operations one at a time, in creation order, and defines what a program means. `evaluateTensor` and `createTensorEvaluator` run the compiled layers, and must return the same bits for every live value ([execution-model.md](../../../../execution-model.md)). The toggle switch's test checks that on every frame.

On today's CPU executor, a frame's work grows with live operations and stored weights; depth would affect speed only on an executor that runs a whole layer's operations at once, and none exists in the repo yet ([executor](executor.md)). For scale, IndirectOS is 3,654 live operations in 124 layers with 7,890 stored weights, over 241 source cells, and one evaluation takes about 25 µs on the CPU executor. Before September 15, 2026, it was 5,253 operations in 192 layers, a frame took about 30 to 40 µs, and generated JavaScript ran that program in about 3 µs after warming up ([codegen](../../codegen/README.md)).

## The three operations, and index reads

Every program is made of three kinds of operations, plus one instruction that copies a value at a computed position, described under [index reads](#index-reads) below. `f(x)` below means `Math.fround(x)`, rounding to the nearest FP32 value. An affine sum is computed term by term: start from `f(bias)`, then for each term, `value = f(value + f(f(coefficient) × input))`.

### Affine sums

An affine sum is weights times inputs plus a constant. JavaScript `trackLeft + trackWidth / 2` becomes:

```ts
const trackCenterX = circuit.affine([[trackLeft, 1], [trackWidth, 0.5]])
```

The sum costs 1 operation, 1 layer and 2 stored weights when a root or a macro reads the sum as its own value (`trackCenter` in atoms.ts), and nothing when an ordinary affine sum reads the sum and copies its terms. Any number known while building, e.g. a 52 px track width or a photo's aspect ratio, becomes a coefficient or a bias, which is free at runtime.

`circuit.affine` sorts terms by wire number and merges repeated wires. `circuit.roundAffine` computes the same kind of sum, but keeps the caller's term order and is never copied into a reader, so it's rounded exactly once, in a known order. That matters when a decision depends on how a value rounds, e.g. the difference inside an exact comparison below.

### ReLU-gated products

A ReLU is `max(0, x)`. The second operation, `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)`, computes `f(left × max(0, gate))`, where left and gate are two affine sums over existing wires. Two uses cover almost everything.

A ReLU on its own is the case where left is the constant 1. `Math.max(0, contentHeight - viewportHeight)` becomes `emitRelu(circuit, circuit.affine([[contentHeight, 1], [viewportHeight, -1]]))`: 1 operation, with the difference copied into the gate (`scrollOverflow` in atoms.ts).

A product of two runtime values puts an operand declared nonnegative in the gate, where `max(0, b)` is just `b`. `hovered ? highlightOpacity : 0`, with both inputs declared within 0..1, becomes `emitMultiply(circuit, hovered, highlightOpacity)`, i.e. `hovered × max(0, highlightOpacity)`: 1 operation (`hoverOpacity` in atoms.ts). When neither operand is declared nonnegative, the product is `a × max(0, b) - a × max(0, -b)`: 3 operations in 2 layers.

Multiplying a value by a bit keeps the value or zeroes it, and every conditional in a program is built from such products.

### Exact bits

The third operation, the boolean atom `circuit.boolean(score)`, takes a score declared within 0..1 and returns exactly 0 or 1, like `score >= 0.5 ? 1 : 0` (`roundScore` in atoms.ts). It computes `f(f(score + 8,388,609) - 8,388,609)`. Between 2^23 and 2^24, FP32 values are whole numbers 1 apart, so adding 8,388,609 rounds the score to a whole number, and subtracting 8,388,609 again leaves exactly 0 or 1. A score of exactly 0.5 lands halfway between two whole numbers, and FP32 rounds a tie to the even one, which is the upper one because 8,388,609 is odd. So 0.5 returns 1, and the FP32 value just below 0.5 returns 0.

The boolean atom costs 1 operation. The builder throws when the score's declared range isn't inside 0..1.

Decisions need exact bits. A focused, open or pressed flag must be exactly 0 or 1: a score of 0.3 stored as `open` would leave a window partly open in state. Once a value is an exact bit, products of bits, and sums of bits that can't be 1 at the same time, stay exact bits, so most logic after the first decision needs no more rounding ([expressions.md](../../../../expressions.md#decision-bits)).

### Index reads

Since September 14, 2026, numeric-ui-core.ts also has an instruction that reads a table at a computed position. JavaScript `rowHeights[rowIndex]` becomes:

```ts
circuit.assumeRange(rowIndex, 0, rowCount - 1)
const rowHeight = circuit.indexRead(rowIndex, rowHeights)
```

The read copies `rowHeights[floor(rowIndex)]` without rounding, and outside the table returns the nearest end, or +0 with `{outOfRange: 'zero'}`. It costs 1 operation, 1 layer and 1 stored weight at any table size, where building the index's one-hot and a masked sum costs O(n) operations. The index needs a declared range strictly inside ±2^24, or the builder throws, and the index must hold an integer, which `validateIndexReads(circuit, values)` checks in tests. [execution-model.md](../../../../execution-model.md#index-reads) has the contract, and the [indexing](indexing.md#way-3-the-index-read-instruction) section covers the gradients and the costs.

## The first macros a UI needs

Macros are builder functions that expand into the three operations. numeric-ui-core.ts has `emitRelu`, `emitMultiply`, `emitSelect`, `emitMinimum`, `emitMaximum`, `emitSpring`, `emitArgmax` and `emitFirstActive`, and since September 14, 2026 also `emitCompare`, the exact `emitMinimumExact`, `emitMaximumExact` and `emitClampExact`, `emitApplySpringMatrix` and `emitAnimatedObject`. This section's [helpers.ts](../examples/model/helpers.ts) adds a clamp to 0..1, an exact comparison, an integer comparison, NOT and AND. The sizes below are measured on each example alone.

### if/else on values: select

JavaScript `isOn ? onColor : offColor` becomes:

```ts
const color = emitSelect(circuit, isOn, offColor, onColor)
```

`emitSelect` expands to `isOn × onColor + (1 - isOn) × offColor`, as two products of a value and a bit, then a sum: 4 operations, 3 layers, 7 stored weights (`thumbColor` in atoms.ts). At a gate of exactly 0 or 1 it returns exactly one side, even when the two sides differ hugely in magnitude, e.g. -1e30 and 1e-7. For a struct, select runs leaf by leaf, e.g. selecting a whole rectangle is 4 selects.

Both sides always compute, and multiplying the unpicked side by 0 still gives NaN when that side is Infinity or NaN. JavaScript `isOpen ? scale * scale : 1` returns 1 while `isOpen` is 0, but with `scale` at 1e30 the circuit still computes `scale × scale`, which overflows FP32 to Infinity, and `0 × Infinity` is NaN (`selectAfterOverflow` in atoms.ts). The [lists](../../lists/README.md) prototype hit this for real: on frames without a release, the release velocity's time difference was far outside its declared range, the reciprocal of that time overflowed, and NaN leaked through the zero into spring state. The fix was to clamp the inputs of every computation whose result a bit may zero out into their declared ranges.

When one side is expensive and rarely picked, e.g. a layout that only applies while a photo is open, the program still pays for that side on every frame.

### min, max and clamp

`Math.min(maxPanelWidth, availableWidth)` becomes `emitMinimum(circuit, maxPanelWidth, availableWidth)`, which computes `a - relu(a - b)`; `emitMaximum` computes `b + relu(a - b)`. Each is 3 operations in 3 layers (`panelWidth` in atoms.ts).

Both are exact for integer operands below 2^23. With fractional operands of different magnitudes, the result rebuilds the smaller operand from a rounded difference, and can drift: `min(1000.37, 0.3)` returns 0.29998779296875, where `Math.fround(0.3)` is 0.30000001192092896. The error, 1.2e-5, is under one FP32 step at 1,000 (2^-14 ≈ 6.1e-5). When a decision depends on such a minimum, use an exact minimum, a comparison followed by a select. numeric-library's exact minimum is 7 operations in 5 layers ([numeric-library](../../numeric-library/README.md)), and numeric-ui-core.ts's `emitMinimumExact` is 18 operations in 16 layers for operands within 0..16,384, where its comparison is a sign cascade that handles every pair of FP32 values, or 5 operations in 4 layers when both operands are declared on a 1/64 grid ([expressions.md](../../../../expressions.md#familiar-expressions)).

A clamp between runtime bounds is a max, then a min. `Math.min(Math.max(windowLeft, 0), maxLeft)` is 7 operations in 7 layers, counting the constant 0 wire. A clamp to 0..1 is cheaper, `relu(v) - relu(v - 1)`: 3 operations in 2 layers (`fillAmount` in atoms.ts). When v is its own operation, e.g. a source cell, it returns exactly 1 for every v above 1 while v is at most 2^24. When v is an ordinary affine sum of fewer than 4 terms, the builder copies the sum into both ReLUs, and the clamp returns exactly 1 above 1 only while both copies add without rounding, e.g. up to 2^23 for multiples of 1/2, while `v = x + 0.25` at `x = f(0.8)` returns 0.99999994. `roundAffine` keeps v as its own operation ([execution-model.md](../../../../execution-model.md#clamping)).

### A decision bit from continuous values

JavaScript `pointerX >= trackLeft ? 1 : 0` becomes (`emitAtLeast` in helpers.ts, used by `pointerPastTrackLeft` in atoms.ts):

```ts
const difference = circuit.roundAffine([[pointerX, 1], [trackLeft, -1]])
const score = circuit.affine([[difference, 64]], 0.5)
const pointerPastTrackLeft = circuit.boolean(emitClampZeroOne(circuit, score))
```

Why it's exact:

- FP32 subtraction of two different finite values never rounds to 0, so `difference` is 0 exactly when the operands are equal, and has the correct sign otherwise.
- Multiplying by a power of two is exact.
- At equality the score is exactly 0.5, which the boolean atom sends to 1. Any difference of at least 2^-23 / 64 = 2^-29 in size moves the rounded score to the correct side of 0.5. The toggle switch's host writes pointer coordinates on a 1/64 px grid, and the track's edges sit on a 1/2 px grid, so two different values always differ by at least 1/64.
- The clamp still returns exactly 1 above 1 while 64 × |difference| ≤ 2^22. In the example, the pointer is declared within ±16,384 and trackLeft within 0..16,384, so |difference| ≤ 2^15, and 64 × 2^15 = 2^21. `emitAtLeast` reads that bound from the declared ranges, and throws while building when the ranges are open.

The comparison costs 4 operations, 3 layers and 6 stored weights. The test compares it with JavaScript's `>=` on 20,029 pairs, including track edges next to their neighboring FP32 values. Writing `[condition]` for 1 when the condition holds and 0 otherwise, a strict `[a < b]` is `1 - [a >= b]`.

This form is one rounding stage, and it isn't the default. Building blocks use `emitCompare(circuit, a, relation, b)` from numeric-ui-core.ts, which picks the form from declarations. For inputs declared on a grid, like this example's 1/64 px pointers, it builds an integer bit on the scaled difference, e.g. `[pointerX >= trackLeft]` as `relu(1 - relu(64 × (trackLeft - pointerX)))`, 2 operations in 2 layers with no boolean atom ([below](#a-decision-bit-from-an-integer) shows the 3-operation form). When values come out of non-integer arithmetic, e.g. springs or products, and aren't on a known grid, a difference can be smaller than this form's resolution, and `emitCompare` builds a sign cascade instead: a comparison that multiplies the difference by powers of two and clamps it in stages, which gives the correct bit for every pair of FP32 values within 16,384 in 16 operations and 15 layers. The [comparisons](comparisons.md) section explains both. IndirectOS's window hit tests compare each edge distance with `emitCompare`, e.g. `[pointerX - windowLeft >= 0.5]`, which means "at least half a pixel inside", and combine the 4 bits as `relu(sum of bits - 3)`: 13 operations in 4 layers per rectangle once the edges exist. Its dock items keep an older form of the same rule, `boolean(clamp01(min(distances to the four edges)))`, 16 operations and 9 layers per rectangle ([runtime notes](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md)), since the dock's layout divides the viewport width by 3, which lies on no grid.

### A decision bit from an integer

For an integer, `columnCount >= 3 ? 1 : 0` is `relu(columnCount - 2) - relu(columnCount - 3)`: 3 operations in 2 layers (`atLeastThreeColumns` in atoms.ts). An integer can't land strictly between 2 and 3, so the result is always exactly 0 or 1, with no boolean atom.

Keep such a bit as its own operation, e.g. with `roundAffine`, before a large sum reads it. Otherwise the builder copies both ReLUs into the sum, and when those ReLUs hold large values, the running FP32 sum rounds. In lists, fractional weights over ReLU values up to 8,192 made a reciprocal's starting estimate 233% wrong, and in input, a 2^18 coefficient pushed partial sums past 2^24 and arrow-key navigation picked the wrong control.

Logic over exact bits is arithmetic. NOT is `1 - bit`. AND of N bits is `relu(sum of the bits - (N - 1))`, which is 1 only when every bit is 1, e.g. "the press is inside the track" is the AND of 4 comparisons (`emitAll` in helpers.ts). OR of N bits is `1 - relu(1 - sum of the bits)`, or just the sum when at most one of the bits can be 1.

## Why declared ranges matter

`circuit.assumeRange(wire, minimum, maximum)` declares that a value stays within a range. For a source cell, the executors check it on every evaluation. For a computed value, the builder uses the declared range without checking it. The builder also computes a range for every operation it appends, from the ranges of the operation's inputs, with FP32-rounded endpoints. Ranges matter in five places.

**Validation.** `evaluateReference`, `evaluateTensor` and `createTensorEvaluator` throw "source wire N is outside its assumed range" when JavaScript wrote a value outside a cell's range, and a NaN fails that check too. The check accepts Infinity in a cell declared -Infinity..Infinity, and 0.5 in a cell declared 0..1 that should hold an exact bit, so the host checks finiteness and exact bits itself. The toggle switch's `validateCells` checks both, on the table before the frame and on the next values before they're copied back, and a test pins all three cases. notation's validators, derived from declarations, cost about 1 µs per frame for every check on IndirectOS.

**How a product compiles.** `velocity × timestep` is 1 operation in 1 layer when `timestep` is declared nonnegative, and 3 operations in 2 layers otherwise, with the same values apart from the sign of zero (`velocityTimesTimestep` in atoms.ts). Until September 15, 2026, IndirectOS didn't declare its spring timestep nonnegative where the timestep was computed, so every window spring's products by the timestep used the 3-operation form, and declaring it there saved 320 live operations with bit-identical outputs (notation).

**Exact decisions.** The boolean atom needs a score within 0..1, and an exact comparison needs a bound on the difference to choose its scale. numeric-library could make IndirectOS's minimums and maximums exact only where both operands had finite ranges: 42 of 273 call sites with today's declarations, and 183 once pointer coordinates were declared within ±2^16.

**Indexed reads.** A one-hot is a list of bits in which exactly one bit is 1, e.g. `[0, 0, 1, 0]` names position 2, and `circuit.assumeOneHot(bits)` declares that some bits always form one. A masked sum `Σ bit[i] × value[i]` over a one-hot returns the value at the marked position. The compiler turns such a sum into one gather, i.e. a read of the one marked value, only when every value has a finite declared range, because an unpicked `Infinity × 0` would turn the dense sum into NaN, and the gather wouldn't.

**FP32's exact budget.** Integers are exact up to 2^24, `emitMinimum` and `emitMaximum` are exact for integers below 2^23, the clamp to 0..1 returns exactly 1 above 1 up to 2^24, and an exact comparison needs scale × |difference| ≤ 2^22. An author, or a helper like `emitAtLeast`, reads the declared ranges to check that every operand stays within these limits.

Four pitfalls:

- A range declared after other operations already read a wire doesn't change those operations. That's how IndirectOS lost the 320 operations above, until its springs moved to `emitAnimatedObject` on September 15, 2026: Photos declared the timestep nonnegative when it was inlined, after the window springs existed.
- A range that describes the ideal value can be false in FP32. [layout-tree](../../layout-tree/README.md) declared a timestep cell's maximum as 0.008, but a `Float32Array` stores 0.008 as 0.0080000004, so every frame of 32 ms or more threw; the fix was declaring `Math.fround(0.008)`. [indirect-os-2](../../indirect-os-2/README.md) declared window destination centers within 0..16,384, and in a 2 px wide viewport a dock item is centered at -4.8e-7 px.
- Range propagation doesn't track NaN, so a product can get a finite range while it holds `Infinity × 0 = NaN` ([codegen](../../codegen/README.md)).
- An open range, e.g. -Infinity..Infinity, is fine for a value that only feeds positions, like the toggle switch's thumb position. An open range blocks exact comparisons and indexed reads on everything computed from that value.

## Translation table

Each row names a JavaScript concept, the circuit form that replaces it, how its cost grows, and where to read more. "Grows as" gives operations, then depth, in big-O terms: n is the item count, and K a capacity or a number of possible results fixed while building. A row that replaces one expression or a loop links its short entry in the root [expressions.md](../../../../expressions.md) or [patterns.md](../../../../patterns.md), which quote the sizes their tests pin. The other rows give a measured size, which holds under the conditions that the linked README or this section's examples state. Links to folders point to prototypes in lab/ui-exploration.

The rows fall into three groups. Most JavaScript is the same idea written differently. Searches, sorts, floors, running totals, text layout, springs and the topmost hit need a different algorithm, and each row of that group links its short entry. And a few things have no counterpart in JavaScript, because the program is a fixed list of operations over numbers in cells.

### The same idea, written differently

| JavaScript | Circuit form | Grows as (operations; depth) | Measured | More |
| --- | --- | --- | --- | --- |
| A variable, e.g. `const trackLeft = viewportWidth / 2 - 26` | A wire. Reassigning a variable in builder code points the name at a new wire and leaves the old value readable, like static single assignment (SSA), where every value is assigned once. | O(1); O(1) | 0 operations for an affine sum of fewer than 4 terms that an ordinary affine sum reads, otherwise 1 | [Builder code](#builder-code-runs-once-at-startup) |
| Numbers | FP32, rounded after every sum and product, in stored term order. Integers are exact up to 2^24. Quantize inputs in JavaScript, i.e. round them onto a known grid, e.g. pointers to 1/64 px and times to 1/64 ms relative to the frame, so comparisons read values that differ by whole grid steps. | no extra work | Positions drift from float64, e.g. up to 0.18 px at 98,197 px down the gallery | [comparisons](comparisons.md), [gallery](../../gallery/README.md) |
| `if/else` choosing a value, e.g. `isOn ? onColor : offColor` | Compute both sides, then `emitSelect` with an exact bit. A struct selects leaf by leaf. | both sides' work, plus O(1) per selected number; O(1) | in [expressions.md](../../../../expressions.md#familiar-expressions) | [select](#ifelse-on-values-select) |
| `if/else` choosing what runs, e.g. `if (clicked) st.on = 1 - st.on` | A select on the next value of every cell the branch writes, e.g. `nextOn = select(clicked, on, 1 - on)`. Nothing is skipped. | the branch's work on every frame, plus O(cells the branch writes); O(1) | in [expressions.md](../../../../expressions.md#familiar-expressions) | [toggle switch](#a-complete-small-app-a-toggle-switch) |
| Comparisons and logic, e.g. `x >= left && x < right`, `!open` | `emitCompare(circuit, a, relation, b)`, which builds integer bits when both operands are declared on a grid, and a sign cascade otherwise. NOT is `1 - bit`, AND of N bits `relu(sum - (N - 1))`, OR `1 - relu(1 - sum)`. | O(1); O(1), except the sign cascade, whose depth grows with log(largest difference / smallest difference to resolve) | in [expressions.md](../../../../expressions.md#familiar-expressions) | [decision bits](#a-decision-bit-from-continuous-values), [comparisons](comparisons.md) |
| `Math.min`, `Math.max`, `Math.abs`, clamps | `emitMinimum`, `emitMaximum`; `relu(x) + relu(-x)` for abs; a max then a min for a clamp. When a decision depends on the result, `emitMinimumExact`, `emitMaximumExact` and `emitClampExact` select one operand with an `emitCompare` bit. | O(1); O(1) | in [expressions.md](../../../../expressions.md#familiar-expressions) | [min, max and clamp](#min-max-and-clamp), [numeric-library](../../numeric-library/README.md) |
| Functions and helpers, e.g. `insideTrack(x, y)` | Builder functions that append operations. A component is a cell declaration plus a build function that reads its parent's wires, e.g. notation's `photos.ts`. | each call appends the helper's operations again, and identical expressions are shared; no call overhead | The toggle switch's `insideTrack`, measured on its own: 22 operations, 6 layers, including the 4 track edges that later calls share | [Builder code](#builder-code-runs-once-at-startup), [notation](../../notation/README.md) |
| `throw` and assertions | The frame can't throw. Declared ranges and exact bits become validators that JavaScript runs on the table before the frame and on the next values after it; output contracts check outputs. | O(cells) of JavaScript work per frame | notation's derived validators: about 1 µs per frame for every check on IndirectOS | [ranges](#why-declared-ranges-matter), [notation](../../notation/README.md) |
| A fixed-count loop, e.g. over 4 windows | A builder loop that appends the body once per iteration. Iterations that don't read each other share layers. An iteration that reads the previous iteration's result adds depth, and should become a prefix sum, a count, or a tournament where possible. | n × the body's operations; the body's depth for independent iterations, n × the body's depth for a chain | The trace compiler's version of the gallery's photo strip: 1,580 layers, where the hand-written strip is 9 | [loops](loops.md), [chains](chains.md), [gallery](../../gallery/README.md) |
| Objects and arrays of objects, e.g. `windows[i].left` | While building: objects and arrays whose leaves are wires. In the table: cells at fixed positions. | nothing | IndirectOS's source table: 241 cells | [the source table](#the-source-table), [notation](../../notation/README.md) |
| Recursion over a tree, e.g. `layout(node)` calling `layout(child)` | A tree known while building is unrolled while building. A walk over structure that never changes becomes a table prepared in JavaScript, e.g. hn.js's `while` loop that climbs from a comment to its ancestor at the pointed indent (hn.js:333) became a 2,761-entry table read through one-hots, and [tables that JavaScript writes](../patterns/tables-javascript-writes.md) reads the same kind of table with one index read. Trees whose shape changes at runtime weren't built. | O(nodes); O(tree depth) | layout-tree: about 4 layers and 12 operations per nesting level | [chains](chains.md), [layout-tree](../../layout-tree/README.md), [hn-thread](../../hn-thread/README.md) |
| Reading `values[index]` at a computed index | `circuit.indexRead(index, values)` copies `values[floor(index)]`. A selection that already exists as a one-hot, e.g. `emitArgmax`'s output, reads through a masked sum, which the compiler turns into one gather when the values have finite ranges. | Index read instruction: O(1); O(1). One-hot: O(n); O(1). | in [expressions.md](../../../../expressions.md#familiar-expressions) | [indexing](indexing.md), [index-read](../../index-read/README.md) |
| Writing `values[index] = value` | There's no write at a computed index: every cell's next value is a select between its old value and the new one. | O(capacity); O(1). Replacing a range and shifting the rest, as typing does: O(n log n); O(log n). | text-editing's cell rewrite for one key at 256 characters: 6,387 operations | [indexing](indexing.md), [text-editing](../../text-editing/README.md) |
| `Map` lookups by id, e.g. `photosById.get(id)` | Resolve the id to a position in JavaScript before the frame, e.g. the photo id in the URL hash becomes an index cell. Inside the program: compare a query with N stored integer keys, e.g. with `emitCompare(circuit, key, '===', query)`, and read through the resulting one-hot. Attention, in machine learning, scores stored keys against a query and returns stored values weighted by the scores; reading only the best match, as this lookup does, is called hard attention. | in JavaScript: nothing. In the program: O(N); O(1). | `emitCompare`'s `===` on keys declared on a grid: 3 operations in 2 layers per key, plus one read. lab/data-adapter built a lookup by id from equality bits over 12 slots. | [indexing](indexing.md), [gallery](../../gallery/README.md), [data-adapter](../../../data-adapter/README.md) |
| `Math.random` and hashes | A seeded hash inside the program, or a hash computed in JavaScript when the event arrives and written into a cell, e.g. spring-bank's random fling destinations. | O(1); O(1) | in [expressions.md](../../../../expressions.md#familiar-expressions) | [numeric-library](../../numeric-library/README.md), [spring-bank](../../spring-bank/README.md) |
| Mutation across frames, e.g. `st.armed = armed` | A state cell whose next value is an output. JavaScript copies every next value back after the frame, all at once. Within the frame, the old value is the cell and the new value is a wire. | 1 root per state cell, and O(cells) of copying per frame | Reading last frame's value on purpose shortens chains but lags a frame, e.g. up to 88.9 px of error in IndirectOS's Photos at 60 fps | [toggle switch](#a-complete-small-app-a-toggle-switch), [read last frame's value](../patterns/read-last-frame.md), [chains](chains.md#way-4-read-last-frames-value), [retiming](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/retiming/README.md) |
| Absolute time, e.g. `performance.now()`, requestAnimationFrame timestamps | Kept in JavaScript: host-timing.ts's `quantizeFrameTiming` gives the table the frame's duration and event times relative to the frame on a 1/64 ms grid, with a duration of 0 for the first frame after idle. IndirectOS keeps timestamps in JavaScript too: host-timing.ts's `advanceFrame` counts each evaluation's steps, and the host writes the spring matrix for that step count. | nothing | From 2^22 ms, about 70 minutes after page load, a `Float32Array` stores timestamps on a 0.5 ms grid, so a 16.6 ms frame measures 16.5 ms (`frameDurationFromTimestamps` in atoms.ts) | [springs](springs.md), [event-time](../../event-time/README.md) |
| `requestAnimationFrame` scheduling | JavaScript schedules another frame while an `animationActive` output is above 0. host-timing.ts's `advanceFrame` plans one frame's evaluations: one per distinct event timestamp, a settle check every 64 ms of simulated time, and one at the frame's timestamp. The host keeps requesting frames until the clock `advanceFrame` returns has stopped. | 1 root, plus one evaluation per distinct event timestamp and per 64 ms of animation | The toggle switch's host writes a duration of 0 for the first frame after idle, so the spring doesn't step through the idle time. With state written back only at events and settle checks, `advanceFrame`'s stored tables were identical in every bit at 10 to 120 fps, like event-time's committed tables at 10 to 240 fps. | [the host](#the-host), [commit state at events](../patterns/commit-at-events.md), [springs](springs.md), [event-time](../../event-time/README.md) |
| Event handlers | The handler stores raw input and schedules a render, as ui.md already recommends: a latch per event kind, next to the event's coordinates. The program handles the kinds in a fixed order, e.g. down, then up, then cancel. When the order of several events in one frame matters, the table holds a queue with a fixed capacity. | latches: O(1) cells per event kind. Queue of K entries: O(K) operations, plus operations and depth that grow with the presses allowed per evaluation. | The toggle switch: 4 event kinds in 9 cells. input's window circuit: 1,494 operations, 55 layers for 16 queued events with at most 2 presses; each more queue entry costs about 46 operations and no layers, and each more press about 427 operations and 17 layers. | [toggle switch](#the-frame), [input](../../input/README.md), [chains](chains.md) |
| DOM reads, e.g. `clientWidth`, `scrollTop` | JavaScript reads before the frame and writes input cells, quantized, e.g. lists floors `scrollTop` onto a 1/4 px grid. | nothing | | [lists](../../lists/README.md) |
| DOM writes and node lifetime | Outputs. JavaScript formats strings, writes every dynamic property on every frame, and creates or removes nodes from visibility bits; ui.md's `domCache` stays in JavaScript. | nothing beyond the roots | The toggle switch writes 6 properties from its outputs | [the host](#the-host), [notation](../../notation/README.md) |
| Side effects, e.g. `element.focus()`, `scrollTo`, `pushState` | Outputs that JavaScript acts on when they change, e.g. an integer naming the element to focus. `preventDefault` has to be decided inside the event handler, before the frame runs, so it can only read last frame's outputs. | nothing beyond the roots | input's menu bar outputs one focus target integer | [input](../../input/README.md), [gallery](../../gallery/README.md) |
| Strings, e.g. labels, `charCodeAt`, `measureText`, key names | Kept in JavaScript, which turns text into numbers: segment widths, break kinds, key bits, code points. | Editing a text field: O(capacity) per key. | One key into a 256-character field: 54,431 operations (text-editing), 42,326 with index read instructions (code-points). | [text](text.md), [text-editing](../../text-editing/README.md), [code-points](../../code-points/README.md) |
| `async` and `fetch` | Kept in JavaScript. A result reaches the program as cells written before a later frame, e.g. a loaded bit, or streaming-words' count of arrived words. None of the prototypes put a request inside the program. | nothing for the request; the program pays for the capacity it reserves for results | streaming-words: stopping a streamed reply writes back 1 cell, the count of arrived words, or 2 when the press lands inside a word | [streaming-words](../../streaming-words/README.md) |

### A different algorithm

| JavaScript | Circuit form | Grows as (operations; depth) | Short entry | More |
| --- | --- | --- | --- | --- |
| `while` loops and early exit, e.g. `findIndex`, `break` on the first match | When the condition flips only once along the index, e.g. "this row's bottom is at or above scrollTop" for rows in top-to-bottom order, the first match is the count of 1 bits, and its one-hot is the difference of neighboring bits. Otherwise a balanced tree of pairwise choices, e.g. `emitFirstActive`; or a fixed bound on iterations with an output that reports overflow; or one iteration per frame with the loop's state in cells. | count: O(n); O(1). Tree: O(n); O(log n). Bounded walk: K × the step's operations; K × the step's depth. | [when the test flips once](../../../../patterns.md#findindex-when-the-test-flips-once-along-the-items), or [when passing items can be anywhere](../../../../patterns.md#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far) | [loops](loops.md#1-count-instead-of-search), [text-editing](../../text-editing/README.md) |
| The topmost element under the pointer, e.g. a loop over the stacking order that stops at the first hit | A hit bit per element, then a tree over the stacking order, or counts of earlier hits. Elements that can't overlap need neither, since at most one bit is 1. IndirectOS's frontmost of 4 windows is 55 operations in 10 layers. | tree: O(n); O(log n). Earlier-hit counts as wide sums: O(n) operations and O(n²) weights; O(1). | [patterns.md](../../../../patterns.md#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far) | [loops](loops.md#2-when-the-test-isnt-monotone-the-first-hit), [runtime notes](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/runtime.md) |
| Running totals, e.g. `rowTop += height` | A prefix sum, i.e. the list of running totals: a chain of additions, one wide sum per total with terms in loop order, or a Brent-Kung network, a standard arrangement of pairwise additions. The chain and the wide sums round exactly like the loop. | chain: O(n); O(n). Wide sums: O(n) operations and O(n²) stored weights; O(1). Brent-Kung: O(n); O(log n). | [patterns.md](../../../../patterns.md#running-totals) | [loops](loops.md#3-prefix-sums-three-ways) |
| `sort` | Ranks by counting: an item's rank is how many items come before it, from pairwise comparisons. When one item moves, e.g. a dragged card, update last frame's ranks instead. A sorting network is the other form. | ranks: O(n²); O(1). Incremental update: O(n); O(1). Sorting network: O(n log² n); O(log² n). | [patterns.md](../../../../patterns.md#itemssortcompare) | [loops](loops.md#5-ranks-instead-of-sorting), [lists](../../lists/README.md) |
| `Math.round`, `Math.floor` | Round by adding and subtracting a large number, as the boolean atom does. Or count threshold tests, e.g. the gallery's column count is 1 plus how many of 6 fixed widths the container reaches. | O(1); O(1). Threshold count for K possible results: O(K); O(1). | [expressions.md](../../../../expressions.md#familiar-expressions) | [loops](loops.md#4-threshold-counts-instead-of-floor-and-division), [numeric-library](../../numeric-library/README.md) |
| An array of unknown length, e.g. `items.push(item)` | A capacity K fixed while building, a presence bit per entry, and an output that counts what didn't fit. Showing the visible items in K reusable DOM nodes, each showing whichever item the program routes to it, needs a comparison per item and node, or a binary search per node with index reads. | O(K) per field of each entry. Routing n items into K nodes: O(n K) with one-hots, or O(K log n) with a binary search; O(log n). | [patterns.md](../../../../patterns.md#itemsfilterisvisibleslice0-k-into-k-dom-nodes) | [executor](executor.md#ui-jobs-under-each-choice), [lists](../../lists/README.md), [hn-thread](../../hn-thread/README.md) |
| Many similar items, e.g. a loop that lays out every photo | One per-item program run over every item, with sums, counts, maxima and prefix sums across items between its stages. | Per-item program written out per item: program size O(n × per-item). Written once and run per item: program size O(per-item), work O(n × per-item). | [patterns.md](../../../../patterns.md#a-loop-over-items-that-mixes-per-item-work-with-values-carried-to-the-next-item) | [instancing](instancing.md), [instanced-items](../../instanced-items/README.md) |
| Animation, e.g. a spring toward a destination | Fixed 4 ms steps as a power of one 2×2 matrix, which JavaScript computes with host-timing.ts's `springMatrixPower` and writes into 4 cells per stiffness and damping pair. `emitAnimatedObject` in numeric-ui-core.ts steps every spring of one object and settles them together with one exact bit. `emitSpring`, which IndirectOS used until September 15, 2026, runs 4 substeps of the frame's duration instead. | O(1) per animated number; O(1) | [patterns.md](../../../../patterns.md#a-linear-step-repeated-a-runtime-number-of-times), and [behavior-choices.md](../../../../behavior-choices.md#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks) for stored state that doesn't depend on the frame rate | [springs](springs.md), [spring-bank](../../spring-bank/README.md) |
| Text layout, e.g. pretext's `layout(prepared, maxWidth, lineHeight)` for a paragraph's height | JavaScript measures segments and finds the widths where a layout result changes, and the program compares the runtime width with those width thresholds and adds constants. When every line needs its own width, e.g. text flowing around a window, the line walker runs as arithmetic instead. | width thresholds for one runtime width: O(thresholds); O(1) | [patterns.md](../../../../patterns.md#a-layout-function-of-one-runtime-number) | [text](text.md), [text-tabulated](../../text-tabulated/README.md) |
| Division by a runtime value, e.g. `(pointerX - trackLeft) / trackWidth` | Newton's method for the reciprocal, from a starting estimate chosen with threshold bits, then a product. When the divisor is a DOM read, JavaScript can write its inverse into a cell before the frame instead. | O(log(high / low)) threshold bits plus a few operations per Newton step; depth grows with the steps | [expressions.md](../../../../expressions.md#dynamic-division) | [numeric-library](../../numeric-library/README.md), [notation](../../notation/README.md) |
| `Math.sqrt`, `Math.sin`, `Math.cos` | Newton steps for square roots. For sine and cosine, a reduction to a small angle, then polynomials evaluated as nested multiply-adds (Horner's method). | O(1) for a fixed input range; O(1) | [expressions.md](../../../../expressions.md#familiar-expressions) | [numeric-library](../../numeric-library/README.md) |

### Things JavaScript has no counterpart for

| What | Circuit form | Grows as | Measured | More |
| --- | --- | --- | --- | --- |
| Many copies of one program at once, e.g. simulated users, or the screen at many future times | One compiled program runs over many source tables, each with its own state, settings or time, as instances of the same program. | work: copies × operations; the program's size doesn't change | user-population: 64 settings × 1,024 users × 600 frames, 39,321,600 user-frames at about 1.2 µs of circuit time each on one core, and 16,384 users for 600 frames on a GPU, bit for bit equal to the CPU. event-time: 301 samples of the next 1.2 s as independent evaluations, where 2,007 of the display program's 3,360 operations depend on the sample. | [talk](talk.md#user-population-a-city-of-simulated-users), [chains](chains.md#batching-different-chains-together), [user-population](../../user-population/README.md), [event-time](../../event-time/README.md) |
| Design numbers in cells, e.g. card padding that a designer drags | A number that would be a constant weight becomes a source cell, so JavaScript, a solver or a designer can change it while the page runs, and a backward pass gives its gradient. | O(1) per number: 0 to 2 operations each when the sums that use the number already exist | drag-knobs: 5 design numbers into cells for 60 operations (2.1% of the app shell) and 1 layer. Over 500 scripted drags, one gradient step solved 63.6% of moving frames. | [tables that JavaScript writes](../patterns/tables-javascript-writes.md), [talk](talk.md#drag-knobs-dragging-an-edge-moves-the-design-numbers), [drag-knobs](../../drag-knobs/README.md) |
| Behavior as tables, e.g. a state machine's transitions or a line break rule | The rules are numbers in cells that JavaScript writes, and one compiled program reads them, so different behavior is different data. | an interpreter's overhead, e.g. about 3.2 times the operations of the same machine written directly | chains' table machine, any 4-state machine over 64 events: 1,665 operations and 130 layers, against 516 operations and 65 layers for the button written directly. A prefix scan over integer tables in cells runs a button and a toggle switch through one program: 897 operations, 10 layers at 64 events. user-population's tremor estimate picks each user's drag slop and double-click distance from 8 table cells. | [tables that JavaScript writes](../patterns/tables-javascript-writes.md), [events through a state machine](../patterns/state-machine-prefix-scan.md), [chains](chains.md#batching-different-chains-together), [code-points](../../code-points/README.md) |
| Gradients, e.g. how far a card's edge moves per px of padding | `circuit.backpropagateReference` computes a gradient for every cell and every computed value. Sums, products and selects pass useful gradients, exact decisions give 0 or make the pass throw, and an index read gives gradients to the table's values but not to the index. | a backward pass costs about what a forward pass does | A spring's matrix power backpropagates through 562 operations for any step count up to 511, against 4,202 for up to 300 unrolled steps with a mask per step. Gradients through a step matrix in cells were within 1.3e-4 relative error of finite differences over 1,080 checks. drag-knobs' backward pass took about 10 µs against 16 µs for the generated forward pass. | [differentiability](differentiability.md), [indexing](indexing.md#is-a-read-differentiable), [drag-knobs](../../drag-knobs/README.md) |

## A complete small app: a toggle switch

[toggle-switch.ts](../examples/model/toggle-switch.ts) is a small app that uses every piece above. It compares with this section's rounding stage, `emitAtLeast` in helpers.ts, and animates with `emitSpring`, which the September 14, 2026 decisions replaced as defaults with `emitCompare`, `emitAnimatedObject` and host-timing.ts's `advanceFrame`; the example wasn't rebuilt on them, while the repo root's [template/](../../../../template/) is the same switch built on them, with [tutorial.md](../../../../tutorial.md) walking through it. A 52 × 32 px track sits centered in the viewport, with a 24 px thumb inside. Like a native switch, it acts on release: a press on the track arms the switch, and a release on the track while it's armed flips it. A release off the track, or a pointercancel, disarms it without flipping. The thumb springs to its new side, and the cursor becomes a pointer while the pointer is over the track.

[toggle-switch-reference.ts](../examples/model/toggle-switch-reference.ts) is the same app as plain JavaScript in float64, written in ui.md's shape: event handlers that only store raw input in a centralized `st`, a `render` function in phases, and state committed at the end. [toggle-switch-trace.ts](../examples/model/toggle-switch-trace.ts) is a scripted trace, and [toggle-switch.test.ts](../examples/model/toggle-switch.test.ts) runs both versions over it.

### The source table

The switch has the 16 cells shown in [The source table](#the-source-table): 9 inputs (the viewport width and height, the frame's duration, the latest pointer position, and the coordinates of the last down and the last up), 3 latches (down, up and cancel), and 4 state cells (`on`, `armed`, and the thumb's position and velocity). Pointer coordinates are declared within ±16,384, which the exact comparisons need. The thumb's position and velocity are open, since they only feed positions.

`armed` is the state bit that carries a press across frames: it's 1 from a press on the track until the release or cancel that ends the press. The thumb's spring state is in normalized units, 0 on the off side and 1 on the on side, and pixels only appear in the outputs, so a viewport resize moves the track without starting an animation.

### The frame

The builder code (toggle-switch.ts, trimmed):

```ts
// Layout and cursor. JS: trackLeft = viewportWidth / 2 - 26
const trackLeft = circuit.affine([[cells.viewportWidth, 0.5]], -layout.trackWidth / 2)
const trackRight = circuit.affine([[cells.viewportWidth, 0.5]], layout.trackWidth / 2)
// ... trackTop and trackBottom the same way
// JS: x >= trackLeft && x < trackRight && y >= trackTop && y < trackBottom
const insideTrack = (x: Wire, y: Wire) => emitAll(circuit, [
  emitAtLeast(circuit, x, trackLeft, 64),
  emitNot(circuit, emitAtLeast(circuit, x, trackRight, 64)),
  emitAtLeast(circuit, y, trackTop, 64),
  emitNot(circuit, emitAtLeast(circuit, y, trackBottom, 64)),
])
const hovered = insideTrack(cells.pointerX, cells.pointerY)

// Handle inputs, in a fixed order: down, then up, then cancel.
// JS: if (down) armed = insideTrack(down)
const armedAfterDown = emitSelect(circuit, cells.downActive, cells.armed, insideTrack(cells.downX, cells.downY))
// JS: const clicked = up && armed && insideTrack(up)
const clicked = emitAll(circuit, [cells.upActive, armedAfterDown, insideTrack(cells.upX, cells.upY)])
// JS: if (clicked) on = 1 - on
const nextOn = emitSelect(circuit, clicked, cells.on, emitNot(circuit, cells.on))
// JS: if (up || cancel) armed = false
const nextArmed = emitAll(circuit, [armedAfterDown, emitNot(circuit, cells.upActive), emitNot(circuit, cells.cancelActive)])

// Animation tick. JavaScript writes the frame's duration in ms; the program caps it at 32 ms.
const cappedDuration = emitMinimum(circuit, cells.frameDuration, emitConstant(circuit, layout.maxFrameDuration))
const timestep = circuit.affine([[cappedDuration, 0.001 / 4]])
const thumb = emitSpring(circuit, cells.thumbPosition, nextOn, cells.thumbVelocity, /* stiffness, damping, */ timestep, /* settle thresholds, */ unit)

// Commit state: inputs keep their value, latches go back to 0, and every state cell gets a next value.
const nextSource: Wire[] = specs.map((spec, wire) => spec.policy === 'event' ? zero : wire)
nextSource[cells.on] = nextOn
nextSource[cells.armed] = nextArmed
nextSource[cells.thumbPosition] = thumb.position
nextSource[cells.thumbVelocity] = thumb.velocity

// Values for DOM writes and scheduling.
const fill = emitClampZeroOne(circuit, thumb.position)
const output = {
  trackLeft, trackTop,
  thumbLeft: circuit.affine([[trackLeft, 1], [fill, thumbTravel]], layout.thumbInset),
  thumbTop: circuit.affine([[trackTop, 1]], layout.thumbInset),
  fill, on: nextOn, armed: nextArmed, hovered, clicked, animationActive: thumb.active,
}
```

Reading the builder code next to its JavaScript comments:

- `armedAfterDown` is the value of `armed` after this frame's down. `clicked` reads that wire, not the `armed` cell, like a JavaScript render reading a local variable it just reassigned. The `armed` cell still holds last frame's value, and receives `nextArmed` only after the frame.
- A press and a release within one frame click, because the down is handled before the up.
- Each call of `insideTrack` appends a whole hit test against this frame's track, so after a resize, a release where the track used to be doesn't click.
- `clicked` and `nextArmed` are ANDs of exact bits, and `nextOn` is a select between exact bits, so every decision stays an exact bit with no rounding after the comparisons.

The whole program is 129 live operations in 47 layers with 227 stored weights, over 16 source cells. `nextOn` is 12 layers deep, and `emitSpring` adds its 33 layers on top of the destination it reads, so most of the depth is the thumb's 4 substeps and its settle check. The settle check snaps the thumb onto its destination with zero velocity once its distance and speed are both below 0.001.

### The host

`createToggleSwitchMachine` compiles the program for the next-state values and the outputs, and runs frames:

```ts
step(frame: ToggleSwitchFrame): ToggleSwitchOutput {
  // DOM reads, written into input cells.
  source[cells.viewportWidth] = frame.viewportWidth
  source[cells.viewportHeight] = frame.viewportHeight
  source[cells.frameDuration] = frame.frameDuration
  validateCells(specs, source)
  const values = evaluate(source)
  // ... read the outputs from values
  // Commit: every next-state value is copied back at once, after the whole frame is computed.
  const nextValues = values.slice(0, specs.length)
  validateCells(specs, nextValues)
  source.set(nextValues)
  return result
},
// Event handlers only store raw input; the next frame's evaluation reads it.
pointerDown(x: number, y: number) {
  source[cells.pointerX] = x
  source[cells.pointerY] = y
  source[cells.downActive] = 1
  source[cells.downX] = x
  source[cells.downY] = y
},
// pointerMove, pointerUp and pointerCancel the same way
```

`mountToggleSwitch` is the browser host, in ui.md's shape. It creates the two nodes once, with their static width, height, class and role. The `pointermove`, `pointerdown`, `pointerup` and `pointercancel` handlers quantize coordinates to 1/64 px, store them through the machine, and schedule a render. `render` computes the frame's duration from the previous animating frame's timestamp, with 0 after idle, runs `step`, writes the dynamic properties with `renderToggleSwitch` (the two transforms, the `--fill` and `--pressed` custom properties, `aria-checked`, and the body's cursor), and schedules another frame while `animationActive` is above 0. The host typechecks, and the test runs `renderToggleSwitch` against fake elements, but the page hasn't been opened in a browser.

### Checked against plain JavaScript

The trace has 280 frames and 25 pointer events, and 20 of its frames carry named checks. At 1280 × 800, the track spans x 614..666 and y 384..416. In order, the trace:

- moves the pointer right of the track, where hover stays off, then onto the track, where hover turns on;
- presses on the track, holds for 3 frames, and releases on it, which flips the switch on;
- presses left of the track and releases on it, which does nothing;
- presses exactly on the left edge, which counts like `x >= trackLeft`, then releases off the track, which disarms without flipping;
- presses and releases 1/64 px inside the bottom right corner within one frame, which flips the switch off;
- while the thumb moves: presses exactly on the right edge, which doesn't count like `x < trackRight`; presses on a quarter pixel and releases exactly on the bottom edge, which doesn't click; clicks, which changes the spring's destination mid-animation; and presses, cancels and releases, which doesn't click;
- shrinks the viewport to 1000 × 700 while the thumb moves, stalls one frame for 500 ms, which the program caps at 32 ms, and continues with frames of 8.25, 33.5 and 4 ms;
- presses inside the moved track, then releases at the same point after the viewport grows back to 1280 × 800, which doesn't click, since the release is tested against the track's new place;
- clicks at (-20, -10) in a 1 × 1 viewport, where the track spans x -25.5..26.5, which flips the switch.

Results, all from `bun test lab/ui-exploration/guide/examples/model`:

- Every decision equals the JavaScript version on all 280 frames: `on`, `armed`, `clicked`, `hovered`, the track's position, and whether the thumb still animates. 109 frames animate.
- Each of the 20 named checks does what its description says, and 7 of them land while the thumb moves.
- The thumb's left edge stays within 3e-5 px of the float64 version, and its normalized position within 2e-7; the test bounds them at 1e-4 px and 1e-6.
- After the first click from rest, the thumb lands exactly on 1 with zero velocity 27 frames of 16 ms later, and its left edge is exactly the track's left edge plus 24 px.
- Through the resize, the thumb's position and velocity are bit-identical to a run of the same trace without the resize.
- The compiled executor matches `evaluateReference` bit for bit on all 26 roots of every frame.

### What the example leaves out

A latch keeps only the latest event of its kind, so a down, an up and another down within one frame lose the click, and a test pins that. People can't click that fast, but code that dispatches events can produce that sequence. The [input](../../input/README.md) prototype queues every event of a frame instead, and [chains](chains.md#the-running-example-a-button-that-acts-on-release) builds a button that also re-arms when the pointer moves back inside, over such a queue.

`emitSpring` ties the thumb's trajectory to the frame rate, and a 500 ms stall only advances the thumb by 32 ms. The [springs](springs.md) section covers fixed 4 ms steps that don't depend on the frame rate, which numeric-ui-core.ts's `emitAnimatedObject` and host-timing.ts's `advanceFrame` now provide.

There's no dragging of the thumb, no keyboard focus or Space key, and no label. A drag would store whether a drag is in progress in a state cell and follow the pointer's x, as notation's settings slider does. A key would be one more latch that JavaScript writes from `event.key`. A label, like every string, stays in JavaScript.

## Limits

Every frame pays for everything the program was built to handle. A settled gallery still evaluates every spring, and an empty frame costs as much as a frame with 16 queued events.

Depth comes from what depends on what. The gallery's 61 layers are one chain: a click determines the focus, the focus determines the photo strip's positions and every photo's destination, the destinations determine the scroll anchor, the anchor determines the scroll adjustment, that adjustment shifts the springs, and the springs determine which photos are hidden. The [chains](chains.md) section covers what shortens a chain and what doesn't.

Exactness has to be designed at every decision. Decisions on drifting FP32 positions can differ from float64: far down the gallery, pointers inside a 0.18 px band next to a photo's edge got a different hover and click than native index.ts.

Capacities are fixed while building: events per frame, lines of text, DOM nodes, list entries. The prototypes report overflow as outputs, or JavaScript splits the work into more evaluations.

On the CPU executor, cost follows live operations and stored weights. IndirectOS takes about 25 µs per evaluation, and the gallery's 48,411 operations took about 375 to 510 µs per frame, against 13 µs for native index.ts.
