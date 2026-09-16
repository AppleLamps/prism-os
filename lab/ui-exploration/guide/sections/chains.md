# Long dependency chains, and ways to shorten them

A compiled circuit runs in layers. Every operation in a layer reads only values from earlier layers, so all operations of one layer could run at the same time. The number of layers is the circuit's depth, and the depth equals the circuit's longest dependency chain: the longest run of operations where each operation reads the result of the one before.

Three measures appear throughout this section. Operations are the total work of one evaluation. Depth is the number of layers, e.g. a loop that updates a button's state once per queued event is at least k layers deep for k events, however few operations each update takes. Stored weights are the nonzero coefficients the compiled layers keep, where O(n²) growth often shows first, e.g. the running totals of 1,024 row heights written as one sum per total are 1,023 operations but 524,799 stored weights.

This section explains the known ways to shorten a chain, each with a UI example, its cost, and what the prototypes measured. The runnable examples are in [examples/chains/](../examples/chains/). Ways 1 to 3 have long pattern docs with their own runnable examples, and their short entries are in the repo root's [patterns.md](../../../../patterns.md). Way 4 and most of way 5 change what the user sees, and their short entries are in [behavior-choices.md](../../../../behavior-choices.md).

## Why depth matters, and when

Amdahl's law says that when part of a program runs in parallel, the part that has to run one step at a time limits the total speedup. For circuits, Brent's theorem (1974) makes the limit concrete: a computation with W operations and depth D runs in about D + W / p steps on p processors. More processors shrink W / p, but nothing shrinks D. So on an executor that runs each layer as one parallel pass, e.g. one GPU dispatch per layer, depth sets a lower bound on a frame's time.

The same theorem says how much such an executor could gain at most. With unlimited processors a frame still takes D steps, against W steps when operations run one at a time, so the best possible speedup is W / D, the average number of operations per layer. The ratio counts every operation as one step, even a sum with thousands of terms, so W / D is a ceiling, not a prediction. For the prototypes:

| Program | Operations W | Layers D | W / D |
| --- | ---: | ---: | ---: |
| a button over 64 queued events, as a loop (this section) | 516 | 65 | 7.9 |
| the same button as a Sklansky prefix scan (this section) | 2,872 | 9 | 319 |
| layout-tree's app shell | 2,806 | 115 | 24 |
| IndirectOS before September 15, 2026 | 5,253 | 192 | 27 |
| IndirectOS since September 15, 2026 | 3,654 | 124 | 29 |
| input's window circuit, 16 queued events with at most 2 presses | 1,494 | 55 | 27 |
| IndirectOS with spring-bank's springs, Photos reading its window's springs right after this frame's steps | 3,583 | 91 | 39 |
| indirect-os-2, the whole program with Notes and word springs, before September 15, 2026 | 19,854 | 343 | 58 |
| indirect-os-2, the whole program with Notes, since September 15, 2026 | 18,027 | 337 | 53 |
| text-editing, one key at 256 characters | 54,431 | 239 | 228 |
| hn-thread, 251 comments | 53,703 | 69 | 778 |
| gallery, 221 photos | 48,411 | 61 | 794 |

Window management, input handling and app layout are mostly chains: even with unlimited processors, a layer-parallel executor could make IndirectOS at most about 29 times faster than running its operations one at a time. Collections are mostly wide rather than deep, because the gallery's 221 photos and hn-thread's 251 comments are computed side by side in the same layers, so their ceiling is near 800. Removing layers raises the ceiling: the button's prefix scan does 5.6 times the loop's work, and its ceiling goes from 8 to 319.

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

A loop over k events is k layers deep, because each step reads the state that the previous step computed. The loop above is a reduce, `events.reduce(nextButtonState, initialState)`, and reducing over functions instead of states removes that dependency: each event becomes a table from state to next state, and combining two tables, first the earlier event, then the later event, gives a table of the same kind. Combining is associative, since `combine(combine(a, b), c)` and `combine(a, combine(b, c))` both mean "a, then b, then c", so a prefix network can compute the state before every event with a chain of combines that grows like log k. The pattern doc [events through a state machine, as a prefix scan](../patterns/state-machine-prefix-scan.md) builds the same button with integer tables in cells, where combining two tables is S index reads for S states, with its sizes, when it's exact and when not to use it.

A prefix network is a fixed arrangement of combines that computes every prefix combination, and [prefix-networks.ts](../examples/chains/prefix-networks.ts) has two. Sklansky's network (1960) uses (k / 2) × log2(k) combines, with a longest chain of log2(k) combines. The Brent-Kung network (1982), the same up-sweep and down-sweep shape as Blelloch's scan (1990), uses 2k − 2 − log2(k) combines for k at least 4, with a longest chain of 2 × log2(k) − 2. A third common network, Kogge-Stone (1973), uses about k × log2(k) combines at log2(k) depth: index-read used it for prefix counts of visibility bits, and [examples/executor/prefix-sums.ts](../examples/executor/prefix-sums.ts) builds it for running totals, 9,217 operations in 10 layers at 1,024 rows.

This section's [button-forms.ts](../examples/chains/button-forms.ts) stores each event's table as a transition matrix of bits instead, and `composeTransitions` combines two matrices with a matrix product of bits, up to S³ ANDs per combine. At 64 events, with the final state and the click count as outputs, Sklansky's scan is 2,872 operations in 9 layers and Brent-Kung's 2,692 in 13, against 516 in 65 for the loop, where the pattern doc's Sklansky scan over integer tables is 897 operations in 10 layers. The work depends on which prefixes the app reads, since the compiler removes operations that no output reads: with the 3 state bits after every event as outputs, at 64 events Sklansky's scan is 5,666 operations, Brent-Kung's 3,722 and the loop 705, in the same 9, 13 and 65 layers.

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

## Way 2: speculation

One step's input is the previous step's outcome, and the outcome isn't computed until the previous step finishes. But when the outcome has only a few possible values, the next block of steps can run once for each of them before the previous step finishes, and a select picks the run that starts where the state actually is. A carry-select adder (Bedrij 1962) uses the same idea for addition: each block adds its digits once for an incoming carry of 0 and once for an incoming carry of 1, and a chain of selects, one per block, picks each block's result by the carry that actually comes in. The pattern doc [speculation](../patterns/speculation.md) runs keyboard focus in a toolbar over a queue of key events and picks each block's run with one index read, with its sizes, when it's exact and when not to use it.

In this section's button-forms.ts, the state is a one-hot, so picking among runs is the same sum of ANDs as applying a transition matrix. At 64 events, blocks of 8 are 1,612 operations in 17 layers, against 516 operations in 65 layers for the loop: running every block 3 times, once per possible start state, gave 3.1 times the loop's operations and a quarter of its depth. Every run computes in every evaluation, including the runs that end up unselected, so a run that overflows can turn a masked sum into `0 × Infinity = NaN`, as happened in lists with a zero-gated path.

### Why it works, and how it relates to way 1

Running a block from every possible start state gives, for each start, where the block ends. Written as a table indexed by the start state, those ends are exactly the block's transition matrix. So speculation and transition matrices are two descriptions of the same computation: the rows of a transition matrix are the speculative runs, one per guess. Speculation is one more grouping of the matrix product: products inside blocks, computed in parallel across blocks, then applied to the state block after block.

With blocks of about √k events, the runs are √k deep and the selects are k / √k = √k deep, so depth is O(√k). Doubling the idea, i.e. building each block's runs by speculation over two half-blocks, then over halves of those, gives the conditional-sum adder (Sklansky 1960) at O(log k) depth, which is the prefix scan of way 1.

### When the outcomes don't stay few

Doubling needs the combined outcome of two blocks to again be one of few values, as a state machine's end state is one of S states however many events came before. Press sessions in a window manager make that condition hard to meet. input's open question proposes running press session s + 1's hit test against each possible outcome of session s (which window committed a drag, toggled maximize, or rose to the front) and selecting the matching result. A drag commit's outcome includes where the dragged window landed, a continuous position, so which values a block of press sessions should pass to the next block, and how many possible outcomes those values have, is the unbuilt part of the idea. Today each press session costs input about 427 operations and 17 layers, and indirect-os-2's event queue alone added 78 layers.

### Guessing in a fixed circuit

A CPU's branch predictor saves time because the processor keeps executing instead of stalling until the branch condition is computed, and on a wrong guess the processor throws the work away and redoes it. A fixed circuit computes every path in every evaluation anyway, so a guess can't skip work. A guess only shortens the chain if the frame shows the guessed result now and the corrected result one frame later, which is a delay (way 4) with a correction.

## Way 3: pointer jumping for linked structures

Some chains follow links. Given a next-start table, where `nextStart[s]` is the first segment of the next line when a line starts at segment s, line L's start takes L lookups one after another, e.g. index-read's recovery of 157 line starts from pretext's next-start table was 490 layers. Pointer jumping (Wyllie 1979) replaces every link by the link it points to, so each round doubles how far every link reaches, and L line slots need about log2 L rounds. The pattern doc [following links by doubling](../patterns/pointer-jumping.md) builds it with `circuit.indexRead`, 342 operations in 7 layers at 63 segments and 32 line slots, with when it's exact and when not to use it. `jumps[level]` is a table of a function from a line's start to where 2^level lines end, and combining a table with itself is function composition, which is associative, as in way 1. Pointer jumping is also speculation over every possible start: every round computes the jump from every position, including positions where no line of the paragraph starts.

This section's [pointer-jumping.ts](../examples/chains/pointer-jumping.ts) was written before numeric-ui-core.ts had an index read instruction, so each read builds a one-hot of the index over n + 1 positions, about 3 operations per position, and pointer jumping grows like n² × log L: 34,007 operations in 19 layers at 63 segments and 32 line slots, against 3,935 in 92 for the walk. The one-hot form needs an exact integer index, or the one-hot interpolates between neighboring entries, and a past-the-end entry, so a walk that runs out of lines keeps reading the end. In index-read's copy of the runtime, with the index read instruction, on a 1,023-segment paragraph with 157 line slots, pointer jumping cost 35,914 operations and 66 layers on top of the next-start table's 190,279, against 1,409 operations and 490 layers for the walk ([index-read](../../index-read/README.md)).

## Way 4: read last frame's value

Some values sit deep in the chain but change slowly, e.g. a window's content size during most frames. A stage that reads the value's stored copy from the previous frame doesn't depend on the operations that compute the value: the copy is one more source cell, written back after each evaluation like the other next-state values, and the longest chain through the value becomes the longer of the part that computes the value and the part that reads it. The price is that the stage's output is off by how far the value moves in one frame. In hardware, a pipeline register holds a value from the previous clock tick the same way, and retiming (Leiserson and Saxe) moves registers to shorten the longest path while delaying every path from inputs to outputs by the same number of ticks, whereas a single delay in a UI circuit leaves the delayed value one frame older than the values around it. The pattern doc [read last frame's value](../patterns/read-last-frame.md) measures a delay on a drawer whose thumbnail grid reflows while the drawer springs, and [behavior-choices.md](../../../../behavior-choices.md#read-last-frames-value) says what the user sees and when to choose it.

[retiming](../../retiming/README.md) turned delays into a program transformation and searched for them over replayed traces. Photos reading last frame's content size and opacity took IndirectOS's longest chain from 191 to 116 layers, but hand-chosen delays were 85.7 to 1,380 px off, and delays searched on too few traces failed on traces that changed the delayed values. An open question from retiming: delay every path at a stage boundary by one frame, as hardware retiming does, so outputs are one frame late but consistent with each other, which trades the inconsistency for input latency and wasn't measured.

## Way 5: change what the app computes

Some chains are long because of the behavior the app computes, and a change in behavior removes the dependency instead of shortening the chain. [behavior-choices.md](../../../../behavior-choices.md) lists these choices, each with what the user sees differently. Two have pattern docs with runnable examples: [hit-test destinations instead of drawn positions](../patterns/hit-test-destinations.md), where destinations are computed before springs, so a decision that reads destinations doesn't depend on the springs, and [commit state at events](../patterns/commit-at-events.md), where state is written back only at events and settle checks, so stored state doesn't depend on which frames ran. The prototypes measured more changes of this kind:

**Lay text out around the windows' destinations.** indirect-os-2 flows a Notes paragraph around the other windows. With the windows' destinations as obstacles, the whole program was 19,854 operations and 343 layers; with their animated geometry, 19,861 and 368. Destinations also kept every animated value within 2.4e-4 px between 60 fps and 120 fps, where animated obstacles made words differ by 25.4 px, since each frame rate moved the words' destinations through a different sequence of values. Those numbers were measured with a spring per word. Since the word springs were removed on September 15, 2026, the whole program is 18,027 operations and 337 layers around destinations and 18,034 and 362 around the animated geometry, words at shared timestamps are identical with either obstacle source, and animated obstacles instead make the text reflow in 8 frames with no event.

**Step springs toward last frame's destination.** Retargeting means changing a spring's destination while the spring is still moving. spring-bank's deferred retargeting makes this frame's spring steps move toward last frame's destination, stored in one cell per animated value, and the new destination takes effect from this frame's time. Deferred retargeting is a delay chosen for its semantics: with deferred retargeting, runs at 10 fps to 120 fps and through 500 ms and 2 s stalls differed by at most 0.003 px when presses landed on 30 fps frame times, where the two presses that fall between 10 fps frames start no animation. Deferred retargeting also puts the stepped positions early in the circuit, which is what let Photos read the window springs' positions right after this frame's steps ([read last frame's value](../patterns/read-last-frame.md#when-not-to-use-it)).

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
- `bun lab/ui-exploration/guide/examples/chains/report.ts` prints the sizes of the button forms with W / D, both with the final state and clicks and with every state after every event as outputs, and the sizes of the line starts and of the 4-state machine.

Files:

- [prefix-networks.ts](../examples/chains/prefix-networks.ts): Sklansky's and Brent-Kung's prefix networks for any associative combine, tested for 1 to 70 items against string concatenation, with their combine counts and depths.
- [button-machine.ts](../examples/chains/button-machine.ts): the button's JavaScript loop, its source layout, transition matrices, and the AND, apply and combine helpers.
- [button-forms.ts](../examples/chains/button-forms.ts): the loop, the two prefix scans, and speculation, with either the final state and clicks or every state after every event as outputs.
- [pointer-jumping.ts](../examples/chains/pointer-jumping.ts): line starts by walking and by pointer jumping, in JavaScript and as circuits over the shared runtime.
- [table-machine.ts](../examples/chains/table-machine.ts): one circuit for any 4-state machine with its table in source cells, run with the button's table and a toggle switch's table.
- [measure.ts](../examples/chains/measure.ts), [report.ts](../examples/chains/report.ts), [chains.test.ts](../examples/chains/chains.test.ts).
