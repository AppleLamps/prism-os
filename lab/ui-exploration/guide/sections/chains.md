# Long dependency chains, and ways to shorten them

A compiled circuit runs in layers. Every operation in a layer reads only values from earlier layers, so all operations of one layer could run at the same time. The number of layers is the circuit's depth, and the depth equals the circuit's longest dependency chain: the longest run of operations where each operation reads the result of the one before.

Three measures appear throughout this section. Operations are the total work of one evaluation. Depth is the number of layers, e.g. a loop that updates a button's state once per queued event is at least k layers deep for k events, however few operations each update takes. Stored weights are the nonzero coefficients the compiled layers keep, where O(n²) growth often shows first, e.g. the running totals of 1,024 row heights written as one sum per total are 1,023 operations but 524,799 stored weights.

This section explains the known ways to shorten a chain, each with a UI example, its cost, and what the prototypes measured. The runnable examples are in [examples/chains/](../examples/chains/).

## Why depth matters, and when

Amdahl's law says that when part of a program runs in parallel, the part that has to run one step at a time limits the total speedup. For circuits, Brent's theorem (1974) makes the limit concrete: a computation with W operations and depth D runs in about D + W / p steps on p processors. More processors shrink W / p, but nothing shrinks D. So on an executor that runs each layer as one parallel pass, e.g. one GPU dispatch per layer, depth sets a lower bound on a frame's time.

The same theorem says how much such an executor could gain at most. With unlimited processors a frame still takes D steps, against W steps when operations run one at a time, so the best possible speedup is W / D, the average number of operations per layer. The ratio counts every operation as one step, even a sum with thousands of terms, so W / D is a ceiling, not a prediction. For the prototypes:

| Program | Operations W | Layers D | W / D |
| --- | ---: | ---: | ---: |
| a button over 64 queued events, as a loop (this section) | 516 | 65 | 7.9 |
| the same button as a Sklansky prefix scan (this section) | 2,872 | 9 | 319 |
| layout-tree's app shell | 2,806 | 115 | 24 |
| IndirectOS | 5,253 | 192 | 27 |
| input's window circuit, 16 queued events with at most 2 presses | 1,494 | 55 | 27 |
| IndirectOS with spring-bank's springs, Photos reading its window's springs right after this frame's steps | 3,583 | 91 | 39 |
| indirect-os-2, the whole program with Notes | 19,854 | 343 | 58 |
| text-editing, one key at 256 characters | 54,431 | 239 | 228 |
| hn-thread, 251 comments | 53,703 | 69 | 778 |
| gallery, 221 photos | 48,411 | 61 | 794 |

Window management, input handling and app layout are mostly chains: even with unlimited processors, a layer-parallel executor could make IndirectOS at most about 27 times faster than running its operations one at a time. Collections are mostly wide rather than deep, because the gallery's 221 photos and hn-thread's 251 comments are computed side by side in the same layers, so their ceiling is near 800. Removing layers raises the ceiling: the button's prefix scan does 5.6 times the loop's work, and its ceiling goes from 8 to 319.

Today's executor isn't a layer-parallel executor. The executor runs layers one after another on one CPU thread, so its time grows with the number of operations: in indirect-os-2 the executor cost about 8 µs per 1,000 live operations, and removing 104 layers moved the time by less than the measurement noise. codegen's GPU runs are different again. They run one per-item program over many items (instancing, see [instancing.md](instancing.md)), so the statements inside one item's program run in order, and the parallelism comes from the number of items.

So depth is the limit for a layer-parallel backend, and operations are the cost today. Every way below removes layers at a price: more operations, a frame of lag, or a change in behavior.

## Two kinds of long chains

The first kind repeats the same step over a list of things: queued events, text segments, spring substeps, children of a flex-wrap row. The prototypes measured about 17 layers per press session in input (a press session is one pointer down, the moves after it, and its up), 12 layers per line in text-editing, about 4 layers per child in layout-tree's flex-wrap, and 33 layers per animated value in IndirectOS's original springs, which take 4 substeps per frame. Ways 1 to 3 below shorten chains of repeated steps, because they regroup many copies of one step.

The second kind is a pipeline of different stages, where each stage computes something that the next stage reads. The gallery's 61 layers are one such chain: pointer, click tournament (which compares the photos under the pointer in pairs, then compares the pair results in pairs, until one photo is left), new focus, photo strip positions, destinations (layer 43), scroll anchor and scroll adjustment, springs (layer 58), occlusion (layer 61).

Regrouping doesn't help a pipeline like the gallery's. The gallery's pipeline has about six stages, each passing a lot of state to the next, e.g. every photo's destination, so there's no small step to repeat, and most of the depth sits inside the stages: the click tournament alone accounts for about 20 of the 61 layers. A pipeline gets fewer layers when one stage is rewritten with fewer layers, e.g. selecting the clicked photo by counting earlier hits instead of by the tournament took the gallery from 61 to 41 layers, for 23,000 more stored weights. A pipeline also gets fewer layers when a stage reads an earlier value (way 4), or when the app computes something else (way 5).

## The running example: a button that acts on release

Native buttons act on release. Pressing on the button arms it, moving the pointer outside disarms it, moving back inside arms it again, and releasing while armed is a click. When one frame delivers several pointer events, each event's effect depends on the state after the previous event.

```ts
function nextButtonState(state: number, event: ButtonEvent): number {
  if (state === idle) return event === 'downOnButton' ? armed : idle
  if (event === 'up') return idle
  if (state === armed) return event === 'moveOutside' ? pressedOutside : armed
  return event === 'moveInside' ? armed : pressedOutside
}

let state = initialState
let clicks = 0
for (const event of events) {
  if (state === armed && event === 'up') clicks++
  state = nextButtonState(state, event)
}
```

The state carried from one event to the next has 3 possible values. Every way below relies on that number being small. A chain whose carried state has few possible values is a finite state machine: a program that is always in one of a fixed set of states and moves to another state on each input.

In the circuit, the state is a one-hot: 3 exact bits (values that are always exactly 0 or 1), one per state, exactly one of which is 1. Each queued event becomes a transition matrix, a 3 × 3 table of bits where entry `[from][to]` is 1 when the event moves the button from state `from` to state `to`. Each matrix row has exactly one 1, because an event takes each state to exactly one state. The source table, i.e. the `Float32Array` that JavaScript fills before each evaluation, holds one queue entry per queued event: four exact bits `downOnButton`, `moveInside`, `moveOutside` and `up`, all 0 for an empty entry.

```ts
const {downOnButton, moveInside, moveOutside, up} = queueEntry
const matrix = [
  // From idle, to idle, armed, pressedOutside. null is a constant 0.
  [circuit.affine([[downOnButton, -1]], 1), downOnButton, null],
  // From armed.
  [up, circuit.affine([[moveOutside, -1], [up, -1]], 1), moveOutside],
  // From pressedOutside.
  [up, moveInside, circuit.affine([[moveInside, -1], [up, -1]], 1)],
]
```

Applying an event is a sum of ANDs. An AND of two exact bits is one ReLU-gated product: `a × max(0, b)` is `a` when `b` is 1, and 0 when `b` is 0. Only the current state's row contributes to each sum, so each sum is again an exact bit.

```ts
const and = (a: Wire, b: Wire) => circuit.reglu([[a, 1]], 0, [[b, 1]], 0)

// next[to] = sum over `from` of (state[from] AND matrix[from][to])
function applyTransitions(circuit: Circuit, state: StateBits, matrix: TransitionMatrix): StateBits {
  return [idle, armed, pressedOutside].map(to => circuit.affine(
    [idle, armed, pressedOutside]
      .filter(from => state[from] !== null && matrix[from][to] !== null)
      .map(from => [and(state[from], matrix[from][to]), 1]),
  ))
}
```

Carrying the state through the queue event by event is the familiar loop, and its depth grows by one layer per event: 65 layers and 516 operations for 64 events. The loop costs one layer per event and not two, because the builder copies a sum of fewer than 4 terms into the operations that read the sum, so the sums cost no layer of their own.

The full code is in [button-machine.ts](../examples/chains/button-machine.ts) and [button-forms.ts](../examples/chains/button-forms.ts). [chains.test.ts](../examples/chains/chains.test.ts) checks every form against the loop above: all 1,875 queues of 4 events from every initial state, and 400 random queues each of 16 and 64 events, comparing the final state and the click count, and for the random queues also the state after every event. [report.ts](../examples/chains/report.ts) prints the sizes quoted below.

## Way 1: combine steps with a prefix scan

The pattern doc [events through a state machine, as a prefix scan](../patterns/state-machine-prefix-scan.md) builds the same button with integer tables in cells, where combining two tables is S index reads instead of S³ products, with a runnable example and a test.

### The problem

A loop over k steps is k steps deep, because each step reads the state that the previous step computed. The goal is to compute the state after every step with a chain that grows like log k instead of k.

### The familiar JavaScript way

The loop above is a reduce, `events.reduce(nextButtonState, initialState)`, and a reduce can only run one call after another, since each call reads the previous call's result. The trick is to reduce over functions instead of states. Represent each event as a table from state to next state; combining two tables gives a table of the same kind.

```ts
// table[state] is the state after the event.
const tables = events.map(event => [idle, armed, pressedOutside].map(state => nextButtonState(state, event)))
// Two events as one table: first `earlier`, then `later`.
const combine = (earlier: number[], later: number[]) => earlier.map(state => later[state]!)
const total = tables.reduce(combine)
const finalState = total[initialState]
```

`combine` is associative: `combine(combine(a, b), c)` equals `combine(a, combine(b, c))`, because both mean "a, then b, then c". So the reduce doesn't have to go left to right. A reduce over tables can combine events 0 and 1, events 2 and 3, and so on at the same time, then combine those pairs, like the rounds of a tournament.

### The circuit way

A transition matrix is the same table written as one-hot rows, and combining two matrices is a matrix product of bits: entry `[from][to]` of the combined matrix is 1 when the earlier event takes `from` to some middle state and the later event takes that middle state to `to`. Row `from` of the earlier matrix is itself a one-hot state, so combining applies the later matrix to every row.

```ts
// Two events as one matrix.
function composeTransitions(circuit: Circuit, earlier: TransitionMatrix, later: TransitionMatrix) {
  return earlier.map(row => applyTransitions(circuit, row, later))
}

const prefixes = sklanskyPrefix(matrices, (earlier, later) => composeTransitions(circuit, earlier, later))
// prefixes[i] describes events 0..i for every possible starting state at once.
const statesAfter = prefixes.map(prefix => applyTransitions(circuit, initialState, prefix))
```

A prefix scan computes every prefix combination `x[0]`, `x[0] ∘ x[1]`, `x[0] ∘ x[1] ∘ x[2]`, ... of an associative combine `∘`. Prefix sums, i.e. running totals, are the best-known prefix scan, with `+` as the combine. A prefix network is a fixed arrangement of combines that computes all prefixes. [prefix-networks.ts](../examples/chains/prefix-networks.ts) has two:

- Sklansky's network (1960): for blocks of size 2, 4, 8, ..., the last prefix of each block's left half is combined into every prefix of the block's right half. For k steps that's (k / 2) × log2(k) combines, and the longest chain of combines is log2(k).
- The Brent-Kung network (1982), the same up-sweep and down-sweep shape as Blelloch's scan (1990): the up-sweep builds a balanced tree of combines, and the down-sweep fills in the prefixes the tree skipped. For k steps (at least 4) that's 2k − 2 − log2(k) combines, and the longest chain is 2 × log2(k) − 2 combines.

A third common network, Kogge-Stone (1973), uses about k × log2(k) combines at log2(k) depth, and no combine's result is read by more than 2 later combines. index-read used it for prefix counts of visibility bits; this folder doesn't build it.

### Why it works

Every form of the button circuit computes the same product of transition matrices, `initialState × M[0] × M[1] × ... × M[k − 1]`. Associativity means any grouping of that product gives the same bits. The loop groups the product as `((initialState × M[0]) × M[1]) × ...`, and a prefix network groups the product as a tree. The one requirement is that combining two steps gives a step of the same kind, here a 3 × 3 matrix of bits, so the tree's inner nodes are the same size as its leaves.

Once the state before every event is computed, per-event outputs don't read each other. The click count is `sum over i of (armed before event i AND up at event i)`, one layer after the scan.

### Cost

For a machine with S states, one combine is up to S³ ANDs, since each of the S × S entries sums over S middle states. So for k events:

| Form | Operations | Depth |
| --- | --- | --- |
| Loop | O(k × S²) | O(k) |
| Sklansky prefix scan | O(k × log k × S³) | O(log k) |
| Brent-Kung prefix scan | O(k × S³) | O(log k), about twice Sklansky's |

Measured on the button (S = 3), with the final state and the click count as outputs:

| Events k | Form | Operations | Layers | Stored weights |
| ---: | --- | ---: | ---: | ---: |
| 4 | loop | 36 | 5 | 123 |
| 4 | prefix scan, Sklansky | 100 | 5 | 350 |
| 4 | prefix scan, Brent-Kung | 100 | 5 | 350 |
| 16 | loop | 132 | 17 | 507 |
| 16 | prefix scan, Sklansky | 568 | 7 | 2,459 |
| 16 | prefix scan, Brent-Kung | 586 | 9 | 2,540 |
| 64 | loop | 516 | 65 | 2,043 |
| 64 | prefix scan, Sklansky | 2,872 | 9 | 13,487 |
| 64 | prefix scan, Brent-Kung | 2,692 | 13 | 12,272 |

At 64 events, Sklansky's scan is 7 times shallower than the loop for 5.6 times the operations. The layer counts are the combine levels plus 3 layers: applying each prefix to the initial state, the click bits, and the click sum.

Sklansky's network has more combines than Brent-Kung's at 64 events (192 against 120), yet about as many operations, because of what the outputs read. The click count only reads the `armed` column of each prefix, and the compiler removes operations that no output reads. Most of Sklansky's prefixes feed no later combine, so most of their ANDs for the other two columns are removed. With the 3 state bits after every event as outputs, at 64 events Sklansky's scan is 5,666 operations, Brent-Kung's 3,722 and the loop 705, in the same 9, 13 and 65 layers. So when every step's state is an output, Brent-Kung's network costs about two thirds of Sklansky's, for 4 more layers.

The prototypes measured the same trade at other sizes:

- input's keyboard focus as 13 × 13 transition matrices (12 controls plus "no focus"; Tab, Shift+Tab, arrows and Escape only), at 16 queued key events: the Sklansky scan was 59,730 operations, 31 layers and 173,001 stored weights, against 27,698 operations, 53 layers and 83,769 weights for multiplying the focus one-hot by each matrix in turn. Both forms matched a reference implementation on 3,000 frames per queue size. The scan saved 22 layers for about twice the operations. The saving was small because both forms first spend the same layers computing the matrices, and multiplying a one-hot vector by a matrix already adds only about 2 layers per event.
- A running maximum over 64 items, in phase 1's outside-techniques survey: 189 layers as a loop of `emitMaximum`, 18 layers with Sklansky's network (576 operations against 189), and 30 layers with Brent-Kung's (360 operations). Each result matched plain JavaScript on random inputs.

### Which steps combine into a step of the same kind

Most per-event state in UI does. Examples, from cheapest to most general:

- Sums and counts, e.g. how many pointer downs came before event i. Counts are 1 layer as wide sums, see [loops.md](loops.md).
- A latch: a value that keeps its most recently written value until the next write, e.g. the press point, which each down overwrites. Two latch steps combine into "the later write if there was one, otherwise the earlier write".
- An OR that resets, e.g. "moved past the 4 px drag threshold since the latest press". Two steps combine into "reset if either step reset, and the OR of everything after the last reset".
- Maximum and minimum, e.g. the tallest item so far in a row.
- Linear maps, e.g. one fixed spring step is a 2 × 2 matrix on (displacement, velocity), and two steps combine into the matrix product.
- Finite state machines as transition matrices, like the button.

input used latches, counts and ORs for pointer moves. Prefix sums of down and up bits give every queued event its press session, and every move's distance from its own session's press point is computed in the same layers. One more queued event cost 46 operations and no layers, against 317 operations and 8.6 layers when the event step was written out once per event. At 32 events with at most 2 downs, that's 2,230 operations and 55 layers against 10,196 and 281. At 16 events, both forms matched a reference that handles one event at a time, over 20,000 frames and 101,771 events.

When every step is the same, e.g. a spring with constant stiffness and damping stepping 4 ms at a time, the scan gets cheaper still. N steps are the step matrix to the power N, which can be built from precomputed powers selected by the binary digits of N, or read directly from a table. spring-bank computes the step count with 33 exact threshold bits and reads two constant tables: the clock and the frame matrix, i.e. the step matrix raised to this frame's step count, cost 163 operations and 13 layers once per circuit, and each animated value then costs 4 products. IndirectOS went from 5,253 operations and 192 layers to 3,580 and 137, with window positions within 7.8e-5 px of float64 loops along a scripted session with minimizes, drags, maximizes and a live resize, at 30 and 120 fps. See [springs.md](springs.md).

### When not to use it

- On today's CPU executor, where time grows with the number of operations, a scan is slower than the loop it replaces.
- When the steps have a cheaper special structure. The button's state, for instance, is "pressed" (downs minus ups) plus "was the latest move inside", a count and a latch, which is how input handled moves at no extra depth. Look for counts, latches and ORs before writing general transition matrices.
- When S is large. 13 states already cost 2,197 products per combine. With a read at a computed index (see [indexing.md](indexing.md)), a combine over tables is S reads instead of S³ products. This folder doesn't build that form, but [events through a state machine](../patterns/state-machine-prefix-scan.md) does: Sklansky's scan over 64 events of the same button is 897 operations in 10 layers there, against 2,872 operations in 9 layers with transition matrices here.

### Pitfalls

- Every step's matrix has to be computable without the state. If classifying an event needs state, e.g. whether a move is past the drag threshold needs the press point, compute that state with its own scan first, as input did for the press point.
- A scan changes the grouping of the combines. Bits and integers below 2^24 give the same result in any grouping. Fractional sums don't: in instanced-items at 10,000 photos, sequential prefix sums put row tops up to 40.7 px away from native index.ts, while Brent-Kung sums kept every decision equal to index.ts. So the grouping is part of the result, and the JavaScript reference has to use the same grouping.
- Per-event outputs need every prefix, which Sklansky's and Brent-Kung's networks give. A plain balanced tree of k − 1 combines only gives the final state.
- The work depends on which intermediate states the app reads, as the Sklansky and Brent-Kung numbers above show, so measure with the outputs the app actually reads.

## Way 2: speculation

The pattern doc [speculation](../patterns/speculation.md) runs keyboard focus in a toolbar over a queue of key events, and selects each block's run with one index read, with a runnable example and a test.

### The problem

One step's input is the previous step's outcome, and the outcome isn't computed until the previous step finishes. But when the outcome has only a few possible values, the next step can run for each of them before the previous step finishes, and a select picks the right result afterwards. A select is `bit ? on : off` written as arithmetic, `bit × on + (1 − bit) × off`; for a one-hot state, selecting among runs is the same sum of ANDs as applying a transition matrix.

A carry-select adder (Bedrij 1962) uses the same idea for addition. The adder splits a long addition into blocks. Each block adds its digits twice, once for an incoming carry of 0 and once for an incoming carry of 1, without reading the carries from the blocks below it. Then a chain of selects, one per block, picks each block's result by the carry that actually comes in. Branch prediction in CPUs is related: the processor guesses a branch's outcome and runs ahead.

### The familiar JavaScript way

```ts
// For each block, where does the block end from each possible start state?
const blockEnds = blocks.map(block =>
  [idle, armed, pressedOutside].map(start => block.reduce(nextButtonState, start)))
// Then pick, one block after another.
let state = initialState
for (const ends of blockEnds) state = ends[state]!
```

### The circuit way

```ts
for (let firstEvent = 0; firstEvent < matrices.length; firstEvent += blockSize) {
  // runsFromEveryStart[t][start] is the state after event t of the block when the block
  // starts in `start`. No block reads another block's runs.
  const runsFromEveryStart: TransitionMatrix[] = []
  for (const matrix of matrices.slice(firstEvent, firstEvent + blockSize)) {
    const previousRuns = runsFromEveryStart.at(-1)
    runsFromEveryStart.push(previousRuns === undefined ? matrix : composeTransitions(circuit, previousRuns, matrix))
  }
  // The select: apply the runs to the actual start state.
  blockStartState = applyTransitions(circuit, blockStartState, runsFromEveryStart.at(-1)!)
}
```

### Why it works, and how it relates to way 1

Running a block from every possible start state gives, for each start, where the block ends. Written as a table indexed by the start state, those ends are exactly the block's transition matrix. So speculation and transition matrices are two descriptions of the same computation: the rows of a transition matrix are the speculative runs, one per guess. Speculation is one more grouping of the matrix product: products inside blocks, computed in parallel across blocks, then applied to the state block after block.

With blocks of about √k events, the runs are √k deep and the selects are k / √k = √k deep, so depth is O(√k). Doubling the idea, i.e. building each block's runs by speculation over two half-blocks, then over halves of those, gives the conditional-sum adder (Sklansky 1960) at O(log k) depth, which is the prefix scan of way 1.

### Cost

Speculation costs S times the loop's work, where S is the number of possible outcomes of a step: O(k × S × S²) operations for the button, at O(√k) depth. Measured on the button, next to way 1:

| Events k | Form | Operations | Layers | Stored weights |
| ---: | --- | ---: | ---: | ---: |
| 4 | loop | 36 | 5 | 123 |
| 4 | speculation, blocks of 2 | 70 | 5 | 223 |
| 16 | loop | 132 | 17 | 507 |
| 16 | speculation, blocks of 4 | 360 | 9 | 1,355 |
| 64 | loop | 516 | 65 | 2,043 |
| 64 | speculation, blocks of 8 | 1,612 | 17 | 6,427 |
| 64 | prefix scan, Sklansky | 2,872 | 9 | 13,487 |

At 64 events, running every block 3 times, once per possible start state, gave 3.1 times the loop's operations and a quarter of its depth. The 17 layers are 7 layers of combines, which every block runs at the same time (a block's first event needs no combine), then 8 layers of selects, one per block, then 1 layer of click bits and 1 for the click sum.

### When the outcomes don't stay few

Doubling needs the combined outcome of two blocks to again be one of few values, as a state machine's end state is one of S states however many events came before. Press sessions in a window manager make that condition hard to meet. input's open question proposes running press session s + 1's hit test against each possible outcome of session s (which window committed a drag, toggled maximize, or rose to the front) and selecting the matching result. A drag commit's outcome includes where the dragged window landed, a continuous position, so which values a block of press sessions should pass to the next block, and how many possible outcomes those values have, is the unbuilt part of the idea. Today each press session costs input about 427 operations and 17 layers, and indirect-os-2's event queue alone added 78 layers.

### Guessing in a fixed circuit

A CPU's branch predictor saves time because the processor keeps executing instead of stalling until the branch condition is computed, and on a wrong guess the processor throws the work away and redoes it. A fixed circuit computes every path in every evaluation anyway, so a guess can't skip work. A guess only shortens the chain if the frame shows the guessed result now and the corrected result one frame later, which is a delay (way 4) with a correction.

### When not to use it

- When S is large, since every block runs S times.
- When a prefix scan applies: speculation with blocks of √k sits between the loop and the scan in both work and depth, and the scan is the same idea taken all the way.

### Pitfalls

- The guesses have to cover every state a block can start in. When no run covers the actual start state, no run is selected: in the button circuit, applying runs that lack the row for the actual start state returns all 3 state bits as 0, a state that doesn't exist, and every later block starts from that nonexistent state.
- Every guess runs in every evaluation, including the guesses that end up unselected. An unselected run still computes, so a run that overflows can turn a masked sum into `0 × Infinity = NaN`, as happened in lists with a zero-gated path.
- The block size is fixed while building, like every capacity, so the depth is planned for the queue's capacity, not for the number of events that actually arrive.

## Way 3: pointer jumping for linked structures

The pattern doc [following links by doubling](../patterns/pointer-jumping.md) builds pointer jumping with `circuit.indexRead`, 342 operations in 7 layers at 63 segments and 32 line slots, with a runnable example and a test.

### The problem

Some chains follow links. Given a next-start table, where `nextStart[s]` is the first segment of the next line when a line starts at segment s, the third line starts at `nextStart[nextStart[0]]`, and line L's start takes L lookups one after another. Line walks were among the deepest parts of the prototypes, e.g. index-read's recovery of 157 line starts from pretext's next-start table was 490 layers.

### The familiar JavaScript way

The walk, and pointer jumping (Wyllie 1979): replace every pointer by the pointer it points to, so each round doubles how far every pointer reaches.

```ts
// The walk: L lookups one after another.
let start = 0
for (let line = 0; line < lineSlots; line++) {
  starts.push(start)
  if (start < segmentCount) start = nextStart[start]!
}

// Pointer jumping. jumps[level][s] is where 2^level lines starting at segment s end.
// Position segmentCount means past the end, and a line starting there ends there.
const jumps = [[...nextStart, segmentCount]]
for (let level = 1; 2 ** level < lineSlots; level++) {
  const previous = jumps[level - 1]!
  jumps.push(previous.map(target => previous[target]!))
}
// Line `line` is 2^level lines after line `line - 2^level`.
for (let line = 1; line < lineSlots; line++) {
  const level = Math.floor(Math.log2(line))
  starts.push(jumps[level]![starts[line - 2 ** level]!]!)
}
```

### The circuit way

Each `previous[target]` is a read at a computed index. [pointer-jumping.ts](../examples/chains/pointer-jumping.ts) was written before numeric-ui-core.ts had an index read instruction, so it builds a one-hot of the index and a masked sum, and declares the one-hot so the compiler turns the masked sum into one gather read (an indexed read of the selected value, see [indexing.md](indexing.md)). In the code, `[condition]` means 1 when the condition holds and 0 otherwise.

```ts
// [value >= threshold] for an integer-valued wire: exactly 0 or 1.
const atLeast = (value: Wire, threshold: number) => circuit.affine([
  [circuit.reglu([], 1, [[value, 1]], 1 - threshold), 1],
  [circuit.reglu([], 1, [[value, 1]], -threshold), -1],
])

function readAtIndex(circuit: Circuit, table: readonly Wire[], index: Wire): Wire {
  // Member j is [index >= j] - [index >= j + 1].
  const members = table.map((_, position) => circuit.affine([
    ...(position > 0 ? [[atLeast(index, position), 1]] : []),
    ...(position + 1 < table.length ? [[atLeast(index, position + 1), -1]] : []),
  ], position === 0 ? 1 : 0))
  circuit.assumeOneHot(members)
  return circuit.affine(members.map((member, position) => [circuit.multiply(table[position]!, member), 1]))
}

// One round of pointer jumping.
jumps.push(previous.map((target, start) =>
  start === segmentCount ? pastTheEnd : readAtIndex(circuit, previous, target)))
```

### Why it works

`jumps[level]` is a table of a function from a line's start to where 2^level lines end, and combining a table with itself is function composition, which is associative, as in way 1. Pointer jumping is also speculation over every possible start: the carried state is a segment position, one of n + 1 values, and every round computes the jump from every position, including positions where no line of the paragraph starts.

### Cost

A line slot is the group of outputs reserved for one line of text, and here each line slot holds only the line's start. Each round is n + 1 reads at computed indices, and L line slots need log2(L) rounds, so pointer jumping is O(n × log L) reads at O(log L) depth, against L reads at O(L) depth for the walk. The rest depends on what a read costs. When each read builds a one-hot over n + 1 positions, as in pointer-jumping.ts, a read costs about 3 operations per position, so pointer jumping is O(n² × log L) operations. With the index read instruction, which index-read built first and numeric-ui-core.ts now has as `circuit.indexRead`, a read is 1 operation, and pointer jumping is O(n × log L) operations.

Measured in this folder with numeric-ui-core.ts and one-hot reads, on 150 random paragraphs per circuit (segment widths from 20 to 80 px against a 160 px line), all equal to the walk:

| Segments n | Line slots L | Form | Operations | Layers | Stored weights | Gather reads |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 15 | 8 | walk | 215 | 20 | 400 | 6 |
| 15 | 8 | pointer jumping | 1,043 | 11 | 1,950 | 34 |
| 63 | 32 | walk | 3,935 | 92 | 7,744 | 30 |
| 63 | 32 | pointer jumping | 34,007 | 19 | 66,926 | 278 |

In index-read's runtime copy, with the index read instruction, on a 1,023-segment paragraph with 157 line slots: the next-start table was 190,279 operations in 7 layers. Recovering the line starts by walking cost 1,409 more operations and 490 layers, and pointer jumping cost 35,914 more operations and 66 layers. Both matched pretext's line count and widest line at 21 widths, and the walk also matched every line's start and width at 22 widths. index-read didn't build pointer jumping with one-hots at that size; phase 1 estimated 7 to 10 million operations.

### When not to use it

- When the table itself dominates. At 1,023 segments, pointer jumping's 35,914 operations came on top of the next-start table's 190,279.
- When reads cost O(n) each, i.e. without an index read, and n is large: the one-hots grow like n² per round.
- When few links need following, e.g. a card caption with at most 3 lines.

The trade also runs the other way. With reads at computed indices, a binary search finds the first visible row of 10,000 variable-height rows in 215 operations and 57 layers, where counting the rows above the scroll position takes 30,143 operations and 5 layers (index-read, checked at 303 scroll offsets). A count is shallow and wide; a search is narrow and deep.

### Pitfalls

- The index has to be an exact integer, or the one-hot interpolates between neighboring entries.
- The table needs a past-the-end entry, so a walk that runs out of lines keeps reading the end instead of reading out of range.
- Tables of positions can grow large, and operation counts don't show it. index-read's pointer jumping first stored 1,854,682 table entries at 1,023 segments, because every read whose candidates reached the end of the text also included the past-the-end entry as a constant. Dropping that entry, and clamping the index to the last segment instead, whose next start already is the end, made the count 0.

## Way 4: read last frame's value

The pattern doc [read last frame's value](../patterns/read-last-frame.md) measures a delay on a drawer whose thumbnail grid reflows while the drawer springs, with a runnable example and a test.

### The problem

Some values sit deep in the chain but change slowly, e.g. a window's content size during most frames. If a stage reads the value's copy from the previous frame instead, none of the operations that compute the value has to run before the stage.

### The familiar JavaScript way

Layout code that keeps a value from the previous frame and reads that copy instead of this frame's value:

```ts
// Photos lays out for last frame's window size, so it doesn't read this frame's window layout.
const photosLayout = layoutPhotos(previousPhotosContentWidth)
const windowLayout = layoutWindows(windowState, events)
render(windowLayout, photosLayout)
previousPhotosContentWidth = windowLayout.photos.contentWidth
```

### The hardware way

In hardware, a pipeline register holds a value from the previous clock tick, so logic after the register doesn't depend on logic before it within one tick. Retiming (Leiserson and Saxe) moves registers along a circuit to shorten its longest path, while keeping every path from inputs to outputs delayed by the same number of ticks, so outputs arrive later but are consistent with each other.

### The circuit way

A delayed value is one more source cell, written back after each evaluation like every other next-state value.

```ts
// Source cell previousContentWidth holds last frame's contentWidth. After each evaluation,
// JS copies the contentWidth output into it, next to the other next-state cells.
const photosLayout = buildPhotosLayout(circuit, previousContentWidth) // instead of contentWidth
```

A single delay in a UI circuit doesn't keep paths consistent with each other the way hardware retiming does: the delayed value is one frame older than the values around it.

### Cost

A delay adds no operations, only one source cell per delayed value and one more copy per frame when JavaScript writes next-state values back. The longest chain through the delayed value becomes the longer of two parts, the operations that compute the value and the operations that read it, instead of both parts added together. E.g. if a value sits 100 layers into a 190-layer chain, reading last frame's copy leaves a longest chain of 100 layers. The price is error: a delayed value is off by how far the value moves in one frame.

### What the prototypes measured

retiming turned delays into a program transformation and searched for them. The search replayed traces, i.e. recorded or generated sequences of input events and frame times, with each frame's state, including the delayed values, feeding the next frame, against a budget of 1 px, 0.02 opacity, and no changed decisions.

- None of the hand-chosen delays fit that budget. Photos reading last frame's content size and opacity took IndirectOS's longest chain from 191 to 116 layers, and cost 88.9 px at 60 fps and 161 px at 10 fps. layout-tree's app shell reading last frame's sidebar spring took the shell from 115 to 83 layers, and cost 1,380 px and 116 decision mismatches in 41 frames, e.g. caption line counts.
- A px budget means nothing without a statement of how fast inputs move, since a delay's error is how far the delayed value moves in one frame: the same Photos delay is 88.9 px at 60 fps and 161 px at 10 fps.
- A search overfits to the traces it replays, because a trace only tests values that change in the trace. Searched on one live resize trace, IndirectOS with spring-bank's springs reached 84 layers at 0 px, and the same delays produced over 7,000 decision mismatches on random interaction traces. Searched on scripted and random traces together, the critical-values strategy, which cuts values that every longest chain passes through at one depth, took the longest chain from 136 to 123 operations with 0 px and 0 mismatches on three random traces the search never replayed. The minimum-cut strategy, which cuts the smallest set of values that brings every chain to a target length, reached the same 123 and failed on one of those traces (996 px, 33 mismatches).
- Delays on chains with a decision at every stage removed almost no layers. In the gallery, the only delays that passed every searched trace removed 1 layer, through values those traces never changed, and those delays failed on 2 of 6 new traces.

A better option than a delay is often an earlier value from the same frame. With spring-bank's springs, Photos can read the window springs' positions right after this frame's spring steps, before settled springs are set exactly to their destinations. Those stepped positions depend only on source cells and the shared frame matrix, so they're computed early. IndirectOS went from 137 to 91 layers, and Photos lagged only during a live resize, by that frame's resize delta (6.6 px in the trace), against 85.7 px when reading last frame's value.

### When not to use it

- For decisions. A photo focused a frame late is a lost or misdirected click, and on the gallery's chain retiming's searches kept almost no delay for that reason.
- For values that move far in one frame, e.g. window geometry during a maximize, or any geometry at a low frame rate.
- When display frames don't write state back. In event-time, where state is committed only at events, "previous" meant the last commit, and Photos reading the last commit was 507 px off during a maximize, against 35.7 px when every 240 fps frame wrote back.

### Pitfalls

- A delay can change timing everywhere. In indirect-os-2, text obstacles read from the windows' springs right after this frame's steps used last frame's stacking, so words started moving one rendered frame after a click: 16.7 ms later at 60 fps and 8.3 ms later at 120 fps. All springs share one clock that restarts when something starts moving, so every later animation shifted, and windows differed by 28.8 px between 60 fps and 120 fps.
- Traces for a search have to change the delayed values. In retiming, 23 of the 49 delayed values chosen on one trace never changed in that trace, so replaying that trace couldn't show any error from them.
- An open question from retiming: delay every path at a stage boundary by one frame, as hardware retiming does, so outputs are one frame late but consistent with each other. Consistent delays would trade the inconsistency above for input latency, and they weren't measured.

## Way 5: change what the app computes

Some chains are long because of the behavior the app computes, and a change in behavior removes the dependency instead of shortening the chain. Two of these changes have pattern docs with runnable examples: [hit-test destinations instead of drawn positions](../patterns/hit-test-destinations.md) and [commit state at events](../patterns/commit-at-events.md).

**Hit-test destinations instead of animated positions.** vibescript's ui.md recommends hit-testing against an animated element's destination, the stable position its spring is heading to, instead of its moving position. The reason there is behavior: no mis-clicks on moving elements, and rapid repeated clicks work. In a circuit there's also a structural reason: destinations are computed before springs, so a decision that reads destinations doesn't depend on the springs. In window-manager.ts, Photos hit-tests clicks against its layout at the animated window size, so which photo a click lands on depends on spring timing: with the spring bank's trajectories, a click during a Photos window animation landed on a different photo in 2 of 8 random 400-frame traces. indirect-os-2's event queue hit-tests at the destination size, which removes that dependency.

**Lay text out around the windows' destinations.** indirect-os-2 flows a Notes paragraph around the other windows. With the windows' destinations as obstacles, the whole program was 19,854 operations and 343 layers; with their animated geometry, 19,861 and 368. Destinations also kept every animated value within 2.4e-4 px between 60 fps and 120 fps, where animated obstacles made words differ by 25.4 px, since each frame rate moved the words' destinations through a different sequence of values.

**Step springs toward last frame's destination.** Retargeting means changing a spring's destination while the spring is still moving. spring-bank's deferred retargeting makes this frame's spring steps move toward last frame's destination, stored in one cell per animated value, and the new destination takes effect from this frame's time. Deferred retargeting is a delay chosen for its semantics: with deferred retargeting, runs at 10 fps to 120 fps and through 500 ms and 2 s stalls differed by at most 0.003 px when presses landed on 30 fps frame times, where the two presses that fall between 10 fps frames start no animation. Deferred retargeting also puts the stepped positions early in the circuit, which is what let Photos read the window springs' positions right after this frame's steps, in way 4.

**Commit at events, and sample time independently.** event-time writes state back only at event timestamps and at settle times derived from the committed state, and display frames evaluate a copy without writing back. Committed tables were identical in every bit at 10 to 240 fps and through stalls, over 6 traces. From one commit, the sample i fixed 4 ms steps later reads the spring matrix to the power i from 4 per-sample cells, so the 301 samples of the next 1.2 s are independent evaluations of one program instead of a chain across frames: 2,007 of the display program's 3,360 operations depend on the sample, the other 1,353 run once, and all samples matched 301 separate evaluations bit for bit over 4.7 million values.

**Rewrite one stage with fewer layers.** The gallery's click tournament accounts for about 20 of its 61 layers. Selecting the click by counting earlier hits instead brought the total to 41 layers, at 23,000 more stored weights.

**What these changes have in common.** Each one makes a stage read a value that is computed early and changes only at events, e.g. a destination instead of an animated position, or the committed table instead of last frame's display. The dependency on the late value disappears, and nothing has to be regrouped.

**When not to use them.** Each change is a change in behavior, so each needs its own judgment. ui.md itself keeps the moving position for drag targets, so a draggable card can be grabbed where the card is drawn. Text laid out around destinations shows the final layout while a window is still moving, so a moving window can pass over words that are laid out for where the window will stop. Commits at events need JavaScript to run a schedule of commits and settle timers.

## What theory says about the limit

Complexity theory asks how depth has to grow as the input grows, e.g. with k events or n segments.

NC is the class of problems that circuits of 2-input gates can solve with a polynomial number of operations and polylogarithmic depth, i.e. depth O((log n)^c) for some constant c. Prefix scans of finite state machines, prefix sums, and pointer jumping are all in NC.

A problem is P-complete when it can be solved in polynomial time, and every polynomial-time problem reduces to it through a very simple transformation (one computable in logarithmic space). If any P-complete problem had polylogarithmic-depth circuits with polynomially many operations, every polynomial-time problem would too, so P-complete problems are believed to be inherently sequential, though nobody has proven that NC differs from P. The standard example is the circuit value problem: given an arbitrary Boolean circuit and its inputs, compute its output (Ladner 1975). Greenlaw, Hoover and Ruzzo's book "Limits to Parallel Computation" (1995) collects many more.

For UI, two consequences:

- An arbitrary chain of logic is an instance of the circuit value problem. When each step can read and change a large state in arbitrary ways, no general method shortens the chain, and depth grows with the number of steps.
- Most UI chains carry little state between steps: a focus index, a pressed bit, a latched press point, a spring's 2 numbers under a fixed linear step. A chain whose carried state has S possible values is a finite state machine, which way 1 runs at O(log k) depth for O(k × S³) operations. Small carried state is why scans and speculation worked for queued moves, keyboard focus, menus and springs, and why they got hard for press sessions, whose carried state includes all the window geometry that later hit tests read.

Inside one fixed UI, nothing grows toward infinity, so theory gives no hard limit for a given circuit. Theory says which chains will get deeper as counts grow, and which chains a different formulation can keep shallow.

## Two ideas: running the logic once per guess, and batching different chains together

### Running the same logic several times, one per guess

Running the logic once per guess is speculation (way 2), and speculation is exact when the guesses cover every possible outcome of the step before. The cost multiplies the loop's work by the number of outcomes: on the button with 3 outcomes, 3.1 times the operations for a quarter of the depth at 64 events. Taken all the way with doubling, speculation becomes the prefix scan. Doubling needs the set of outcomes to stay small after combining blocks.

Running the logic for, e.g., 10 likely outcomes instead of every outcome is branch prediction, and branch prediction needs a fallback for a wrong guess. A fixed circuit computes every path in every evaluation anyway, so the fallback can't be "redo the work now"; the fallback is the correct result arriving a frame later, i.e. a delay with a correction. When the outcome is continuous, e.g. where a dragged window landed, no finite set of guesses covers every outcome, which is why speculation over press sessions is still unbuilt.

A related idea from event-time wasn't built either: evaluate several candidate futures as instances of one program, e.g. what a release at each of several pointer positions would do, and commit the one that happens. [Run every candidate, then pick one](../patterns/run-every-candidate.md) builds the scored version of that idea for layouts: every layout runs, and the one with the highest score is shown.

### Batching different chains together

Chains that don't read each other already run together. The compiler assigns operations to layers only by what they read, not by what they compute, so one layer's sparse matrix multiplication can hold any mix of unrelated operations. Unrelated chains in one circuit are as deep as the longest of them, not as deep as their sum. The gallery's 221 photos each have their own springs, and springs are 64% of its 48,411 operations, yet the whole circuit is 61 layers.

Batching needs more when every item has to run the same code, e.g. one GPU compute shader over many items. Then there are two ways, and neither shortens any one chain.

The first is one program over different data, which is instancing. When many chains are the same program with different inputs, e.g. 221 photos or thousands of simulated users, the chains don't read each other, so their depths don't add: all of them together are as deep as one. instanced-items wrote the gallery's per-photo program once, 233 operations per photo at any photo count, and at 10,000 photos its executor took about 2 to 4 ms per frame against about 43 ms for the circuit with the program written out once per photo. user-population ran 16,384 simulated users for 600 frames each through input's window circuit on the GPU, bit for bit equal to the CPU. See [instancing.md](instancing.md).

The second is one interpreter program whose instructions are data. Different logic then becomes different source tables for one compiled program, and those tables can run as instances. [Tables that JavaScript writes](../patterns/tables-javascript-writes.md) covers why such tables stay editable and learnable. [table-machine.ts](../examples/chains/table-machine.ts) is a circuit for any machine with up to 4 states over the button's 5 event kinds, with the transition table in source cells. The button and a toggle switch that flips on release run through the same compiled program, and both match their JavaScript loops on 400 random queues per size:

| Events k | Program | Operations | Layers | Stored weights | Gather reads |
| ---: | --- | ---: | ---: | ---: | ---: |
| 16 | button, written directly (loop) | 132 | 17 | 507 | 0 |
| 16 | any 4-state machine, table in cells | 417 | 34 | 720 | 80 |
| 64 | button, written directly (loop) | 516 | 65 | 2,043 | 0 |
| 64 | any 4-state machine, table in cells | 1,665 | 130 | 2,880 | 320 |

The interpreter overhead here is about 3.2 times the operations and 2 times the depth. For each event, the circuit builds a one-hot over all 20 (state, event kind) pairs and reads the table through that one-hot, where the direct circuit only builds the 8 ANDs of the button's matrix. lab/learned-interpreter works the same way for arithmetic: each instruction is a choice among candidates held in source cells (48 for the first instruction, 75 for the second), and the circuit evaluates every candidate and sums the masked outputs. Percepta's posts "Can LLMs Be Computers?" and "Constructing an LLM-Computer" take the idea furthest: a WebAssembly interpreter compiled into a 7-layer transformer, with the program in the prompt, running millions of instruction steps. There the chain is spread across generated tokens, one evaluation per step, which the next part explains.

## Neural networks, width, and chain of thought

A transformer evaluates a fixed number of layers per token, e.g. 96 in GPT-3. Each layer is wide: many features computed in parallel, plus attention, which retrieves a value from any earlier position in one layer by matching keys, like a gather (see [indexing.md](indexing.md)).

With fixed depth and realistic numeric precision, a transformer's single evaluation can be simulated by a constant-depth threshold circuit (TC^0: constant depth, polynomially many AND, OR and majority gates, each with any number of inputs), per Merrill and Sabharwal (2023). So a single evaluation is believed unable to solve P-complete problems like the circuit value problem once inputs are large enough. Trained networks shorten chains the way way 1 does: Liu et al. ("Transformers Learn Shortcuts to Automata", 2023) showed that a transformer with O(log T) layers can represent the state of any finite state machine after T steps, and that training finds such shortcuts, which then break more easily on inputs unlike the training data.

When a problem needs more sequential steps than the layers give, a language model spreads the steps over chain of thought: each generated token is one full evaluation of the fixed-depth network, and its output is appended to the context that the next evaluation reads. With polynomially many such steps, transformers can simulate any polynomial-time computation (Merrill and Sabharwal 2024).

Indirect has the same structure. One frame is one evaluation of a fixed-depth circuit, and the next-state write-back plays the role of the appended token: the next evaluation reads what the previous evaluation wrote. IndirectOS already spreads a long chain over frames this way. A spring in spring-bank's copy of IndirectOS settles in about 0.6 s, i.e. about 150 steps of 4 ms, and the circuit only runs the steps of one frame per evaluation, writing the spring's state back for the next frame.

Any computation longer than a frame's depth could be spread over frames the same way, at a cost of latency in frames. For example, index-read's line walk costs about 3 layers per line (490 layers for 157 line slots). A walk that keeps its current line start in a source cell and walks 16 lines per evaluation would be about 50 layers deep per frame, and a 157-line paragraph would finish over 10 frames, with its first lines on screen in the first frame. Nothing like this was built; the costs are that later lines appear frames late, and a width change restarts the walk.

event-time goes in the other direction: sample i of a spring's future reads the step matrix to the power i directly, so a chain across frames becomes independent evaluations.

The two approaches differ in how the chain gets into the layers. A network approximates a chain of logic with whatever wide structure training finds, so its shortcuts can fail where the training data didn't reach, and its layers don't line up with the steps of the logic. Indirect compiles the chain itself, exactly, so its depth equals the logic's actual dependencies, and shortening the chain means restructuring the logic: an associative combine, a read by index, or state written back across evaluations. A transformer has learned counterparts of those three: wide layers that combine many things at once, attention that reads by key, and chain of thought that writes state back.

## Choosing a way

k is the number of repeated steps, S the number of possible values of the state carried between steps, n the number of positions a pointer can hold, and L how many pointer steps to follow.

| Way | Applies when | Operations | Depth | What it costs besides operations |
| --- | --- | --- | --- | --- |
| Loop | always | O(k × step) | O(k) | nothing |
| Unrelated chains in one circuit | the chains don't read each other | the sum of the chains | the longest chain | nothing; the compiler does this already |
| Counts, latches, ORs | the state is a count, a latch or an OR that resets | O(k), with O(k²) stored weights for all prefix counts | O(1) to O(log k) | the step has to have that structure |
| Prefix scan | two steps combine into a step of the same kind | Sklansky O(k log k × combine), Brent-Kung O(k × combine); a combine is S³ for matrices | O(log k) | fractional sums get a different grouping |
| Powers | every step is the same linear map | O(log k) products, or one table read | O(log k), or constant with a table | a bounded step count |
| Speculation, blocks of √k | a step's outcome has few values | O(k × S × step) | O(√k) | nothing beyond operations |
| Pointer jumping | following links in a table of n positions | O(n log L) reads, each O(n) without an index read | O(log L) | a table with a past-the-end entry |
| Delay | the value moves little per frame, and no decision reads it | one source cell per delayed value | the longer of the part that computes the value and the part that reads it | visible lag, timing shifts, and traces that change the value |
| Spread over frames | the result may arrive frames late | one evaluation's share per frame | the share's depth per frame | latency in frames; not built |
| Change what the app computes | a decision can read a stable value, or time can be sampled directly | varies | removes the dependency | a change in behavior |

## Examples in this folder

Run from the repo root:

- `bun test lab/ui-exploration/guide/examples/chains` runs 10 tests in about a second.
- `bunx tsgo -p lab/ui-exploration/guide/examples/chains` typechecks the folder.
- `bun lab/ui-exploration/guide/examples/chains/report.ts` prints every size table in this section, with W / D for the button forms, and the button forms with every state after every event as outputs.

Files:

- [prefix-networks.ts](../examples/chains/prefix-networks.ts): Sklansky's and Brent-Kung's prefix networks for any associative combine, tested for 1 to 70 items against string concatenation, with their combine counts and depths.
- [button-machine.ts](../examples/chains/button-machine.ts): the button's JavaScript loop, its source layout, transition matrices, and the AND, apply and combine helpers.
- [button-forms.ts](../examples/chains/button-forms.ts): the loop, the two prefix scans, and speculation, with either the final state and clicks or every state after every event as outputs.
- [pointer-jumping.ts](../examples/chains/pointer-jumping.ts): line starts by walking and by pointer jumping, in JavaScript and as circuits over the shared runtime.
- [table-machine.ts](../examples/chains/table-machine.ts): one circuit for any 4-state machine with its table in source cells, run with the button's table and a toggle switch's table.
- [measure.ts](../examples/chains/measure.ts), [report.ts](../examples/chains/report.ts), [chains.test.ts](../examples/chains/chains.test.ts).
