# Writing interactive UI as one numeric program

## How to read this

This guide explains how Indirect writes an interactive UI as one fixed numeric program, and what the 24 prototypes in lab/ui-exploration measured about that approach. It's written for you, Cheng: someone who knows vibescript's ui.md and front-end development well, but hasn't looked at Indirect's methods in a while. It's also meant to become the starting point for agents with no context who build apps like IndirectOS.

Every section explains its concepts in the same order: the problem in UI terms, the familiar JavaScript, the circuit form with builder code, why the circuit form gives the same result, what it costs, measured numbers with their conditions, when not to use it, and pitfalls. Costs use two measures. Operations are the total work of one evaluation, and depth is the longest chain of operations that must run one after another, counted in layers. Big-O shapes use n for the item count, e.g. comparing every pair of n items is O(n²) operations at constant depth.

A suggested reading order:

1. [The model](sections/model.md) first. It starts with what changes compared with an ordinary JavaScript UI, maps ui.md's render loop onto the source table and the program, introduces the three operations and the index read instruction, the first macros and declared ranges, and ends with a translation table and a toggle switch checked against plain JavaScript. The table maps 35 JavaScript concepts, in two groups: the same idea written differently, and a different algorithm. A third group lists 4 things JavaScript has no counterpart for.
2. [Loops](sections/loops.md) next, since counts, prefix sums, threshold counts and ranks show up in every other section. The [patterns](patterns/README.md) put 18 such algorithms on one page each, with a runnable example.
3. Then whichever topic you're curious about, from the [table of contents](#table-of-contents). [Answers to your review](#answers-to-your-review) links each point you raised to the section that goes deeper, and [Decisions for you](#decisions-for-you) collects what the sections left open.

Numbers come from the prototype READMEs' final text, with the conditions stated there, or from the runnable examples in [examples/](examples/), whose tests check each circuit against plain JavaScript. "0 mismatches" means over the named traces or samples, not a proof. Timings are rough, because many agents shared one laptop while measuring. This is exploratory research, so each section states its limits plainly.

## Glossary

The sections use each of these terms with the meaning given here.

### Notation

- **`[condition]`**: 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript. E.g. `[pointerX >= windowLeft]` is 1 while the pointer is at or right of the window's left edge, and `[arrivedCount >= segmentIndex + 1]` is 1 for every segment that has arrived.

### The program and the host

- **Source table**: the `Float32Array` that holds every number a frame reads, i.e. inputs that JavaScript writes and state that the program computes. E.g. IndirectOS's source table has 201 cells, including the viewport width and each window's left edge.
- **Cell**: one number at a fixed position in the source table, with a declared range and a policy: constant, input, event latch or state. E.g. `downActive` is the event latch cell that holds 1 after a pointer press.
- **Latch**: a stored value that keeps its most recently written value until the next write. E.g. an event latch cell holds 1 after a pointer press until a frame reads it, and the frame's next value for that cell is 0.
- **Event queue**: a fixed number of queue entries in the source table, each holding one event's kind bits and coordinates, for when the order of several events within one frame matters. E.g. indirect-os-2's queue has 8 entries and handles at most 2 presses per evaluation.
- **Press session**: one pointer down, the moves after it, and its up. E.g. input's window circuit handles at most 2 press sessions per evaluation.
- **Builder code**: ordinary JavaScript that runs once at startup and appends operations to a `Circuit` instead of computing values. E.g. a `for` loop over 4 windows appends every window's hit test 4 times, and at runtime there's no loop.
- **Wire**: the position of a value in the array that an evaluation fills, with source cells first and then one position per appended operation. E.g. in the toggle switch example, wire 0 is the viewport width cell, and wire 16, the constant 1, is the first appended operation.
- **Evaluation**: one run of the compiled program over the source table, usually once per frame. E.g. event-time runs one commit evaluation per distinct event timestamp.
- **Roots**: the wires whose values JavaScript reads, i.e. outputs and next-state values, which a program is compiled for. E.g. `circuit.createTensorEvaluator(roots)`.
- **Next-state values**: the outputs that hold each state cell's next value, which JavaScript copies back into the source table all at once after the frame, like ui.md's commit step. E.g. `nextSource[cells.on] = nextOn`.
- **Host**: the JavaScript around the program, which writes DOM reads and events into cells, evaluates, copies next-state values back, turns outputs into styles and schedules frames. E.g. the toggle switch's `mountToggleSwitch`.
- **Host contract**: the conditions that the numbers the host writes must meet, which the circuit's exactness depends on. E.g. "scrollTop is a multiple of 1/4 px".
- **Quantize**: round an input onto a known grid in the host, so that comparisons on the input become integer comparisons. E.g. pointer coordinates to 1/64 px, scrollTop to 1/4 px, and times to 1/64 ms relative to the frame.
- **Capacity**: a maximum count chosen while building, which every evaluation pays for whether or not it's used. E.g. 16 queued events, 12 lines of text or 48 DOM slots.
- **Presence bit**: one bit per entry of a capacity that is 1 when the entry holds an item. E.g. streaming-words' `[arrivedCount >= segmentIndex + 1]` for each segment.
- **DOM slot**: one of a fixed number of reusable DOM nodes, each showing whichever item the program routes to it, like a virtualized list that recycles elements. E.g. hn-thread routes visible comments into 48 DOM slots.
- **Line slot**: the group of outputs reserved for one line of text, e.g. its start, its end and its width. E.g. text-walker's circuits for a 1,023-segment paragraph have 157 line slots.

### Operations and macros

- **Affine sum**: weights times inputs plus a constant, `circuit.affine(terms, bias)`. E.g. `trackLeft + trackWidth / 2` is `circuit.affine([[trackLeft, 1], [trackWidth, 0.5]])`.
- **ReLU**: `relu(x) = max(0, x)`. E.g. `Math.max(0, contentHeight - viewportHeight)` is a ReLU of a difference.
- **ReLU-gated product** (ReGLU in the code): one affine value times the ReLU of another, `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)`. E.g. `hovered × max(0, highlightOpacity)` computes `hovered ? highlightOpacity : 0` when both values are declared within 0..1.
- **Boolean atom**: the operation `circuit.boolean(score)`, which rounds a score declared within 0..1 to exactly 0 or 1 by adding and subtracting 8,388,609 in FP32. E.g. a score of 0.5 returns 1, and the FP32 value just below 0.5 returns 0.
- **The three operations**: affine sums, ReLU-gated products and boolean atoms, which every program is made of. E.g. `emitMinimum(circuit, a, b)` is `a - relu(a - b)`, a ReLU-gated product and an affine sum over its operands. Since September 14, 2026, numeric-ui-core.ts also has a fourth instruction, the index read instruction, described under [Reading, searching and sorting](#reading-searching-and-sorting).
- **`roundAffine`**: an affine sum kept as its own operation, in the caller's term order, so the builder never copies its terms into the operations that read it, and the sum is rounded exactly once. E.g. the difference `pointerX - trackLeft` inside an exact comparison.
- **Macro**: a builder function that expands into the three operations. E.g. `emitSelect`, `emitMinimum`, `emitSpring`, `emitArgmax`, `emitCompare` and `emitAnimatedObject` in numeric-ui-core.ts.
- **Select**: `emitSelect(circuit, bit, off, on)`, which computes both sides and returns `bit × on + (1 − bit) × off`. E.g. `isOn ? onColor : offColor` is 4 operations in 3 layers, and both colors are computed on every frame.
- **Declared range**: `circuit.assumeRange(wire, minimum, maximum)`, a declaration that a value stays within a range, which the executors check on every evaluation for source cells, and don't check for computed values. E.g. declaring a timestep nonnegative before the springs are built makes `velocity × timestep` 1 operation instead of 3.
- **Constant folding**: computing, while building, every part of an expression whose inputs are known. E.g. ranking 64 items costs 64 constant operations when the widths are known while building, and 8,128 operations when the widths are in cells.

### Compiled cost

- **Live operations**, or just operations: the operations a compiled program keeps because some root depends on them, all of which run on every evaluation. E.g. IndirectOS builds 6,146 operations and keeps 5,253 live.
- **Layer**: a group of operations that don't read each other, which runs as one sparse matrix multiplication. E.g. a thousand hit tests against one pointer can share the same layers.
- **Depth**: the number of layers, i.e. the longest chain of operations that must run one after another. E.g. IndirectOS is 192 layers deep, and a loop that updates a button's state once per queued event takes at least one layer per event.
- **Stored weights**: the nonzero coefficients the compiled layers keep, which measure memory and the work inside sums. E.g. one sum over 1,024 values is 1 operation but 1,024 stored weights, so O(n²) growth often shows only in stored weights.
- **Layer width**: the number of operations in one layer, i.e. how much could run at the same time on hardware that runs a whole layer at once. E.g. IndirectOS has a median of 24 operations per layer.
- **Executor**: the code that runs a program. `evaluateReference` runs operations one at a time and defines what a program means, while `evaluateTensor` and `createTensorEvaluator` run the compiled layers and must return the same bits. E.g. the toggle switch's test checks on every frame that both return the same bits.
- **Generated JS**: plain JavaScript statements that the codegen prototype emits from a compiled program, with the same bits as the executor. E.g. IndirectOS runs in about 3 µs as generated JS once the engine has optimized it, against about 30 to 40 µs on the executor.

### Numbers and exact decisions

- **FP32**: the 32-bit float format of `Float32Array`, which the runtime rounds to after every addition and product, like `Math.fround`. E.g. integers are exact up to 2^24 = 16,777,216, and positions 100,000 px down a page are 1/128 px apart.
- **Exact bit**: a wire whose value is always exactly 0 or 1. E.g. `pressed`, the product of the `downActive` latch and a hit test bit.
- **Integer bit**: `relu(v − t + 1) − relu(v − t)`, which is exactly `[v >= t]` for an integer v, in 3 operations and 2 layers. E.g. `columnCount >= 3`, or `[pointerX >= windowLeft]` as the integer bit of `64 × (pointerX − windowLeft)` on a 1/64 px grid. `emitCompare` in numeric-ui-core.ts builds the same bit as `relu(1 − relu((t − v) / grid))`, in 2 operations and 2 layers, when both operands are declared on a grid.
- **Sign cascade**: a comparison that multiplies a difference by powers of two and clamps it to at most 1 in stages, with no rounding inside, until every difference at or above the resolution reaches exactly 1. E.g. `[pointerX > windowLeft]` for every pair of FP32 values within 16,384 is 16 operations and 15 layers. `emitCompare` builds one when the operands aren't declared on a grid.
- **Rounding stage**: a comparison that scales a difference into a score next to 0.5, clamps the score to 0..1 and rounds it with the boolean atom. E.g. the model section's `emitAtLeast` is one rounding stage, 4 operations in 3 layers.
- **Resolution**: the smallest positive difference a comparison must detect. E.g. 1/64 when both operands are on a 1/64 px grid, or 2^-149 to handle every pair of FP32 values.
- **Grid**: a power of two that every value of a wire is a multiple of, declared with `circuit.assumeGrid(wire, step)`, or inferred by the builder for sums and products of wires that have grids. E.g. pointer coordinates that the host writes in 1/64 px lie on a 1/64 grid, so `emitCompare` compares them with integer bits, and `validateGrids(circuit, values)` checks the declaration in tests.
- **Rounding point**: an operation where FP32 rounding turns a value into a decision, or a value that feeds such an operation, so a backend that reorders sums, fuses products into sums or skips FP32 rounding has to keep the stored FP32 steps there. E.g. a boolean atom; each step of `round(x) = (x + 2^23 + 2^22) − (2^23 + 2^22)`, which rounds only because FP32 values above 2^23 are whole numbers; and the difference `pointerX − windowLeft` that feeds a rounding stage. numeric-library's exact `[a >= b]` has 4 rounding points (its difference, the two ReLUs of its clamp and its boolean atom), and a blend `0.3 × a + 0.7 × b` has none. exactness-budget found rounding points by matching patterns in compiled operations, and one of its patterns, a ReLU that scales one runtime value by a power of two of at least 2^8, also matches the stages of a sign cascade, e.g. `relu(2^24 × clamped − 1)`, although a sign cascade gives the same bits without any rounding. The builder now records rounding points itself: `circuit.roundingPoints()` lists every boolean atom, every operation `emitCompare` builds, as `'integer bit'` on grids and `'sign cascade'` otherwise, and operations marked with `circuit.markRoundingPoint(wire)`, e.g. the steps of a round chain.
- **Accumulation order**: the order in which a sum adds its terms, which in FP32 is part of the result. E.g. `Math.fround(Math.fround(16777216 + 1) + 1)` is 16,777,216, while `Math.fround(16777216 + Math.fround(1 + 1))` is 16,777,218.
- **Max guard**: wrapping a value in `max(x, lowest)` with `lowest` read from a buffer, so a GPU shader compiler can't simplify `(x + 8388609) - 8388609` back to `x` or fuse a product into a sum. E.g. codegen's WGSL shaders, guarded only at rounding points, gave 0 decision mismatches through wgpu (the WebGPU implementation in Firefox and Deno) and Dawn (Chrome's).

### Reading, searching and sorting

- **One-hot**: a list of bits in which exactly one bit is 1. E.g. `[0, 0, 1, 0]` names index 2.
- **Tent function**: `relu(x − p + 1) − 2 relu(x − p) + relu(x − p − 1)`, a triangle that is 1 at x = p and falls linearly to 0 at p − 1 and p + 1, also called a hat function. E.g. at whole-number x it's the one-hot bit for position p, and at x = p + 0.25 it's 0.75, which is why a fractional index blends two neighboring entries.
- **Masked sum**: `Σ bit[i] × value[i]` over a one-hot, which returns the value at the marked position. E.g. reading `rowTops[firstVisibleRow]` through the first visible row's one-hot.
- **Gather**: a read of one value at a position, like `table[index]`. E.g. `torch.gather` in PyTorch, or the read the compiler makes out of a masked sum.
- **Gather lowering**: the compiler replacing a masked sum over a declared one-hot (`circuit.assumeOneHot`) with one gather, which removes the products but not the operations that build the one-hot. E.g. reading one of 64 entries goes from 256 operations to 192.
- **Index read instruction**: `circuit.indexRead(index, candidates)` in numeric-ui-core.ts, which reads `candidates[floor(index)]` as 1 operation without building a one-hot. The index needs a declared range strictly inside ±2^24 and must hold an integer. index-read first built the instruction in its copy of the runtime. E.g. `values[index]` over 10,000 entries is 1 operation instead of 30,002 with gather lowering.
- **Tournament**: a balanced tree that compares items in pairs, then pairs of pairs, so picking one of n items takes O(n) operations and O(log n) layers. E.g. `emitFirstActive` picks the first hit among overlapping windows.
- **Monotone bits**: bits that read 1...1 0...0 along an index, so the position of the first 0 is the count of 1s, and the differences of neighboring bits give that position's one-hot. Bits of the form `[count >= 1], [count >= 2], ...` are also called a thermometer code. E.g. `[rowBottom[row] <= scrollTop]` over rows in top-to-bottom order.
- **Threshold count**: a result such as a floor, computed as a sum of comparison bits against fixed thresholds. E.g. the gallery's column count is 1 plus how many of the widths 512, 756, 1,000, 1,244, 1,488 and 1,732 px the container width reaches.
- **Rank**: an item's position after sorting, computed as the number of items that come before it. E.g. ranking 64 integer keys by pairwise comparisons is 6,112 operations in 3 layers with 3-operation integer bits, and 4,096 operations with `emitCompare`'s 2-operation integer bits.
- **Prefix sum**: the list of running totals of a list, built as a chain (n layers), as wide sums (one sum per total over every earlier value: 1 layer and about n²/2 stored weights), or as a Brent-Kung network (about 2n additions in about 2 log2 n layers). E.g. `rowTops[row] = heights[0] + ... + heights[row - 1]`.
- **Prefix scan**: every prefix combination `x[0]`, `x[0] ∘ x[1]`, `x[0] ∘ x[1] ∘ x[2]`, ... of an associative combine `∘`, which a prefix network computes at O(log k) depth for k steps. E.g. a prefix sum is a prefix scan with `+`, and a button's state after every queued event is a prefix scan of transition matrices.

### Chains of steps

- **Finite state machine**: a program that is always in one of a fixed set of states and moves to another state on each input. E.g. a button that is idle, armed, or pressed with the pointer outside.
- **Transition matrix**: a table of bits whose entry `[from][to]` is 1 when an event moves a state machine from state `from` to state `to`, so combining two events is a matrix product. E.g. the button's 3 × 3 matrix for a `moveOutside` event.
- **Speculation**: running a step once for each possible outcome of the step before it, and selecting the matching result afterwards. E.g. running a block of queued events from all 3 button states at once.
- **Pointer jumping**: replacing every link in a table by the link it points to, so each round doubles how far each link reaches. E.g. going from "where the next line starts" to "where the line 2, 4, 8 lines later starts".
- **Delay**: reading last frame's value of a wire from an extra source cell, which shortens the chain at the cost of one frame of lag. E.g. Photos reading last frame's content size and opacity took IndirectOS's longest chain from 191 to 116 layers, and was 88.9 px off at 60 fps.

### Time and springs

- **Spring step**: one semi-implicit Euler step, which updates the velocity from the spring and damping forces and then the position from the new velocity. E.g. index.ts runs one step per 4 ms of simulated time.
- **Catching up**: running as many fixed steps as the elapsed time allows, and carrying the leftover time into the next frame. E.g. 4 steps for a 16.7 ms frame, with 0.7 ms carried over.
- **Settle**: snapping a spring onto its destination with zero velocity once its speed and its distance are both below a threshold. E.g. index.ts's threshold of 0.01.
- **Settle check**: an evaluation that ends at a fixed simulated time, e.g. every 64 ms counted from when the clock started, and the bit the host writes into a cell during that evaluation. E.g. `emitAnimatedObject` in numeric-ui-core.ts only lets a moving object settle while its `settleCheck` cell holds 1, so whether an object settles doesn't depend on which step counts the frames land on. An object whose springs are all exactly at rest, e.g. right after a snap, settles at any evaluation.
- **Retargeting**: changing a spring's destination while the spring is still moving. E.g. pressing ArrowDown twice while a selection highlight is still sliding.
- **Frame-rate independent**: what's on screen at a timestamp doesn't depend on which other frames were rendered. E.g. a 30 fps run shows the same positions as every fourth frame of a 120 fps run.
- **Spring bank**: spring-bank's fixed 4 ms steps, applied as a power of one shared 2×2 step matrix, so each animated number costs 4 products. E.g. IndirectOS went from 5,253 operations and 192 layers to 3,580 and 137.
- **Frame matrix**: the 2×2 matrix that moves a spring's displacement and velocity through all of one frame's fixed 4 ms steps at once, i.e. the one-step matrix M raised to the frame's step count. E.g. for a 16.7 ms frame, which runs 4 steps and carries 0.7 ms into the next frame, JavaScript computes M^4 and writes its 4 entries into cells, or the circuit computes M^4 from the step count. numeric-ui-core.ts and host-timing.ts call it the spring matrix (`SpringMatrixWires`), since evaluations between frames, e.g. at an event's timestamp, write one too.
- **Deferred retargeting**: this frame's spring steps keep moving toward last frame's destination, and the spring starts moving toward this frame's new destination only from this frame's timestamp onward. E.g. after a press between two frames, the steps up to the next frame's timestamp still head to the old destination. spring-bank keeps last frame's destination in one extra cell per animated value, and `emitAnimatedObject` reads it from each spring's `destinationDuringSteps` wire.
- **Commit at events**: event-time's way of running, which its README calls commit per event, where state is written back only at event timestamps and settle times, while display evaluations at frame times throw their next state away. E.g. the committed tables were identical in every bit at 10 to 240 fps and through stalls. host-timing.ts's `advanceFrame` runs this way when its `writeBack` argument is `'events and settle checks'`, and [commit state at events](patterns/commit-at-events.md) runs a toast stack this way.

### Collections

- **Instancing**: writing the per-item program once and running it over every item, like a shader over pixels. E.g. the gallery's per-photo program is 233 operations at any photo count.
- **Duplicated circuit**: one circuit in which builder code writes the per-item program out once per item. E.g. gallery-circuit.ts is 48,411 operations at 221 photos.
- **Map stage**: a program that runs once per item and reads only that item's values plus shared values. E.g. the gallery's "grid and strip sizes, and the focus relation" stage, 25 operations per photo.
- **Reduction**: a computation across all items, placed between map stages. E.g. `groupMax` for each row's tallest photo, `prefixSum` for row tops, and `firstActive` for the photo under a click.
- **Shared value**: a value computed once per frame and read by every item, like a shader uniform. E.g. the column count.
- **Per-item constant**: a number known while building that differs per item, which a map stage reads as an input and scales with a product. E.g. a photo's aspect ratio.
- **Staged program**: instanced-items' builder form, an ordered list of shared stages, map stages and reductions. E.g. the staged gallery has 6 map stages over photos and 31 reductions.

### Learning

- **Gradient**: how much an output changes per unit change of one input. E.g. a linear read over rowHeights 60 and 36 at rowIndex 3.7 has gradient −24 with respect to rowIndex.
- **Backward pass**, or backpropagation: computing the gradient of an output with respect to every wire, by applying the chain rule from the last operation to the first. E.g. `circuit.backpropagateReference(values, outputGradients)`.
- **Finite difference**: the change of an output between two nearby inputs, divided by their distance, used to check gradients. A central difference takes both sides, and a one-sided difference only one. E.g. `(read(index + 0.01) - read(index - 0.01)) / 0.02`.
- **Straight-through**: a backward pass option that passes a boolean atom's gradient on to its score as if the rounding had slope 1. E.g. in drag-knobs, straight-through gradients differed from finite differences in 592 of 2,250 checks while no decision flipped.
- **Frozen decisions**: a backward pass that passes no gradient through a decision, i.e. treats every decision as a constant and differentiates the arithmetic around it. E.g. drag-knobs' "frozen" booleans.
- **Relaxation**: a smooth or piecewise-linear version of a discrete computation, used while training. E.g. one clamp with slope 1 in place of the sign cascade's steep stages.
- **Annealing**: making a relaxation steeper as training goes on. E.g. indexing's toy 1 raises a softmax's sharpness from 0.25 to 8.
- **Hardening**: putting the numbers learned on a relaxation into the exact program, then verifying the exact program. E.g. lab/cascade-argmax moved learned scores into its hard circuit, which picked the right candidate in 160 of 160 cases.
- **Attention**: scoring stored keys against a query and returning a weighted sum of stored values, where soft attention weights every value and hard attention reads only the best match. E.g. with keys `(2j, -j²)` and query `(index, 1)`, hard attention reads the entry at the position nearest the index.
- **Softmax** and **argmax**: softmax turns scores into positive weights that add up to 1, `exp(score[j]) / Σ exp(score[k])`, and argmax is the position of the highest score. E.g. at query 2.25 and sharpness 64, the softmax weight on position 2 is 0.99996.

### Text

- **Segment**: pretext's unit of text, e.g. a word or a space, which pretext measures as one width. E.g. "The quick" is 3 segments: "The", " " and "quick".
- **Tabulation**: finding in JavaScript the widths where a paragraph's layout result changes, so the circuit only compares the runtime width with those thresholds and adds constants. E.g. the Notes window's 10 text blocks are 1,041 operations in 4 layers.
- **Line walker**: pretext's greedy line breaking, which adds segments to a line until the next segment doesn't fit. E.g. text-walker computes a line's end as a count of "the line through segment j fits" bits.
- **Lookahead**: how many segments after a line's start the line walker compares, which caps how many segments one line can hold. E.g. 26 in indirect-os-2's Notes flow, and 21 in text-walker's circuits for a 1,023-segment paragraph.

### Checking

- **Reference**, or oracle: an independent plain JavaScript implementation that a circuit is compared with, and that never imports circuit code. E.g. input's reference applies a frame's events one at a time.
- **Trace**: a recorded or generated sequence of inputs and frame times that both a circuit and its reference run. E.g. the toggle switch's scripted trace of 280 frames with 25 pointer events.
- **Open loop** and **closed loop**: open loop evaluates each frame on state copied from a reference run, and closed loop lets the circuit carry its own state, so small differences can grow over frames. E.g. exactness-budget's reordered and fused sums flipped 1 boolean atom open loop and 5 closed loop.
- **Mutation check**: corrupting one live operation at a time and checking that the tests fail. E.g. hn-thread's tests caught 69 of 78 corruptions.

## Table of contents

- [The model, and how familiar UI code maps onto it](sections/model.md). What runs in JavaScript, what runs in the program, and what does familiar code become? JavaScript keeps the render loop, the DOM, strings and timestamps, the program computes the middle of ui.md's render from the source table, and a translation table maps 35 JavaScript concepts to circuit forms with how their costs grow, split into the same idea written differently and a different algorithm, plus 4 things JavaScript has no counterpart for.
- [Patterns: familiar loops as different algorithms](patterns/README.md). Which algorithm replaces a loop that JavaScript would write? 18 one-page docs in five families, e.g. a count instead of a search, a tree of additions for running totals, and a press hit-tested against spring destinations instead of drawn positions, each with the loop it replaces, the circuit, measured sizes, when it's exact, and a runnable example with a test.
- [Loops and searches without loops](sections/loops.md). What replaces a loop that stops early, a running total, floor and division, and sort? Counts of monotone bits, prefix sums in three forms, threshold counts and ranks, e.g. the first visible row among 10,000 rows is a count at constant depth.
- [Springs, time, and composing behavior](sections/springs.md). Is IndirectOS's frame-rate dependent spring a quirk or a limit? A quirk: window-manager.ts makes each substep a quarter of the frame's duration. Fixed 4 ms steps cost 3 layers per spring when JavaScript computes the frame matrix, i.e. the product of all of this frame's steps, and writes it into 4 cells, which numeric-ui-core.ts now builds with `emitApplySpringMatrix` and `emitAnimatedObject`, while host-timing.ts plans the evaluations. The section also covers what composes while building and what doesn't compose at runtime.
- [Instancing: write the per-item program once](sections/instancing.md). What changes when each photo's program is written once? The gallery goes from 48,411 operations for 221 photos to 233 operations per photo at any count, with reductions such as prefix sums and the first photo under a click between the per-photo stages.
- [Reading at a computed index, differentiation, and attention](sections/indexing.md). How does a circuit read `table[index]`, and does a gradient reach the index? Three ways cost from O(n) operations down to 1, and the 1-operation way is now `circuit.indexRead` in numeric-ui-core.ts; the table's values get gradients but the index doesn't, and the soft reads that do give the index a gradient are soft attention.
- [How comparisons become exact bits](sections/comparisons.md). What happened to the sign cascade, and which comparison should be the default? Integer bits for quantized inputs, the sign cascade for continuous values (16 operations and 15 layers for every pair of FP32 values within 16,384), and the boolean atom only as an optional last stage. numeric-ui-core.ts's `emitCompare` now picks between them from declared ranges and grids.
- [Long dependency chains, and ways to shorten them](sections/chains.md). Can a deep chain get shorter? When the state carried between steps has few possible values, yes, with prefix scans, speculation or pointer jumping, for more operations than the loop, e.g. about 2 to 9 times as many on the button queue and keyboard focus, and 25 times for index-read's pointer jumping. A pipeline of different stages only gets fewer layers when one stage is rewritten with fewer layers, e.g. picking the clicked photo by counting earlier hits instead of by a tournament took the gallery from 61 to 41 layers, or when the app computes something else, e.g. hit tests against destinations.
- [What the compiled program costs, in big-O terms](sections/executor.md). How do you predict a circuit's cost without timing it? Count live operations, layers, stored weights and layer width; builder and compiler steps mostly change constant factors, while semantic choices, e.g. an index read instruction, change how cost grows.
- [Differentiability, and static bounds](sections/differentiability.md). Which parts of a program give useful gradients, and can springs be trained later? Sums, products and selects do and exact decisions don't; a spring whose step matrix comes from cells gave gradients within 1.3e-4 relative error of finite differences, and every quantity that looks dynamic gets a static bound with a fallback, which also fixes the size of the backward pass.
- [Text and pretext: what actually translated](sections/text.md). Which parts of pretext became circuit? Only layout, either as tabulated width thresholds or as the line walker written in arithmetic; `prepare` and measuring stayed in JavaScript, and rich inline layout has a likely bug with a one-line candidate fix.
- [The talk-inspired prototypes, explained plainly](sections/talk.md). What did the prototypes from the talk build and show? Each of the eleven gets its idea from the talk, its UI problem, what was built, numbers with conditions, what to try in its demo, and its main limitation.

## Answers to your review

### Comparisons

The sign cascade you remembered is in [tricks.md](../../../tricks.md) ("Decision bits") and the [trace compiler README](../../trace-compiler/README.md) ("The Sign Cascade"). It multiplies a difference by powers of two and clamps it in stages, and no operation inside it rounds, so its bits equaled JavaScript's `>` on every FP32 input tested. The bits also stayed the same under three rewrites a compiler may apply: evaluating everything in float64, adding every sum's terms in reverse order, and computing every sum in float64 and rounding it once.

With each multiplication inside a ReLU's gate, the cascade costs 16 operations and 15 layers for every pair of FP32 values within 16,384. The 26 layers quoted in earlier write-ups came from the trace compiler's layout, which spends 3 layers per stage.

The recommended default is integer bits on inputs the host quantizes (3 operations, 2 layers), the cascade for values that come out of non-integer arithmetic, and the boolean atom only as an optional last stage that saves 2 layers when the executor keeps FP32 rounding. Cheng chose that default on September 14, 2026, and numeric-ui-core.ts builds it as one helper, `emitCompare(circuit, a, relation, b)`: integer bits when both operands are declared on a grid (2 operations, 2 layers), the cascade otherwise, and the boolean atom only with `{endWithBoolean: true}`. The 1732 px failure came from a rounding stage whose scale was too small, not from rounding as such. More in [comparisons](sections/comparisons.md).

### Indexing and differentiation

A read at a computed index is differentiable with respect to the table's values, like `gather` in ML frameworks, but not with respect to the index, whose derivative is 0 between whole numbers and doesn't exist at them. Through a one-hot a read costs O(n) operations, while the index read instruction, which numeric-ui-core.ts now has as `circuit.indexRead`, costs 1 operation at any table size. Its backward pass throws when a gradient reaches the index, unless the caller passes `{indexGradient: 'zero'}` or `{indexGradient: 'backward-difference'}`.

Two kinds of read give the index a gradient. Linear interpolation blends the two neighboring entries. A softmax read weights every entry by how close its position is to the index: give position j the key `(2j, −j²)` and the index the query `(index, 1)`, and their dot product, `index² − (index − j)²`, is largest at the position nearest the index. That softmax read is soft attention whose keys are positions, and picking the highest score instead (argmax) is hard attention.

In a toy carousel of 8 pages, gradient descent through a soft read learned three weights that compute the query from a flick's release position and velocity. With those weights, an exact argmax circuit picked the same page as plain JavaScript on 10,895 of a grid of 10,976 releases. The toy doesn't show that attention was needed: fitting the query directly with a squared error learned nearly the same weights. And nothing here learned keys, which is what a transformer's attention adds.

More generally, sums, products and selects give useful gradients, while exact decisions give 0 or make the backward pass throw. A spring's matrix power backpropagates through 562 operations for any step count up to 511, against 4,202 operations for up to 300 unrolled steps with a mask per step.

As your note suggested, every quantity that looks dynamic got a static bound with a named fallback, e.g. at most 300 spring steps per frame, past which vibescript and spring-bank carry the rest of the elapsed time into later frames, and host-timing.ts snaps every animated object onto its destination. A fixed bound also fixes the size of the backward pass. More in [indexing](sections/indexing.md) and [differentiability](sections/differentiability.md).

### Wording

Every section was written for someone who hasn't written a circuit: each concept starts from the UI problem and the familiar JavaScript, and each established term is defined at first use and collected in the [glossary](#glossary). The words your review flagged, e.g. "wall", "lane", "box" for springs that settle together, "knob", "fold" as a verb, "hoist", "earn", "win" and "seam", don't appear in the sections, apart from the folder name drag-knobs. Where two sections had used one word for two ideas, the guide keeps one meaning, e.g. a line slot is always the group of outputs reserved for one line of text. The prototype READMEs weren't rewritten, and some still use the old words, e.g. indirect-os-2's README says "Moves fold."

### Photos instancing before and after

Before, [gallery-circuit.ts](../gallery/gallery-circuit.ts) appends every photo's operations to one circuit, with each photo's constants as weights: 48,411 live operations and 61 layers at 221 photos. After, instanced-items writes each per-photo stage once, 233 operations per photo at any count, with 31 reductions between stages, e.g. `groupMax` for each row's tallest photo, `prefixSum` for row tops and `firstActive` for the photo under a click. The staged executor took about 65, 310 and 4,106 µs per frame at 221, 1,000 and 10,000 photos, against 546, 2,569 and 43,027 µs for the duplicated circuit, and made 0 decision mismatches against native index.ts, including 2,408,107 checks at 10,000 photos with Brent-Kung prefix sums. The price is that per-item constants stop being free weights: the gallery pays about 33 more operations per photo, and IndirectOS's 20 small items got bigger when staged (6,282 against 5,253 operations). More in [instancing](sections/instancing.md).

### Big-O of the executor

Predict a circuit's cost from counts that `compileTensorProgram` reports exactly: live operations for total work, layers for depth, stored weights for memory and the work inside sums, and layer width for how much could run at the same time. Today's CPU executor does O(source cells + live operations + stored weights) work per evaluation plus a small fixed cost per layer, and no executor in the repo runs a whole layer at once, so depth doesn't cost time yet. Builder and compiler steps mostly change constant factors, but copying a wide sum into many readers is where O(n²) comes from, e.g. a total read by 256 items stores 65,792 weights when copied and 768 when kept as its own value. Semantic choices change growth the most, e.g. `values[index]` over 10,000 entries is 40,002 operations as a masked sum, 30,002 with gather lowering, and 1 with an index read instruction. More in [executor](sections/executor.md).

### Long dependency chains

A circuit's depth is its longest dependency chain, and even with unlimited processors a layer-parallel executor could gain at most the average number of operations per layer: about 27 for IndirectOS and about 800 for the gallery.

When a chain repeats one step and the state carried between steps has few possible values, e.g. a button that is idle, armed, or pressed with the pointer outside, over a queue of events, each step can be written as a table from state to next state. Combining two tables gives a table of the same kind, and any grouping of the combines gives the same final table, like reducing over functions instead of over states. So steps can combine in pairs, then pairs of pairs, like the rounds of a tournament. At 64 events, the loop is 516 operations and 65 layers, Sklansky's prefix scan is 2,872 operations and 9 layers, and speculation is 1,612 operations and 17 layers.

A pipeline of different stages, like the gallery's click, focus, destinations, scroll anchor, springs and occlusion, only gets fewer layers when one stage is rewritten with fewer layers, when a stage reads an earlier value, or when the app computes something else, e.g. hit tests against destinations. Today's executor pays per operation, so these trades only pay off on a layer-parallel backend, and retiming's hand-chosen one-frame delays were 86 to 1,380 px off. More in [chains](sections/chains.md).

### Concept explanations and the guide

This guide is the explanation you asked for, and the [model](sections/model.md#translation-table) section's translation table is its index of 35 JavaScript concepts. The table's first group is the same idea written differently. Its second group needs a different algorithm, and each row there links a [pattern doc](patterns/README.md) that explains the algorithm on one page with a runnable example. A third group lists 4 things JavaScript has no counterpart for, e.g. design numbers in cells.

Variables, arithmetic, fixed loops, helper functions, objects, `if/else` on values, and min, max and clamps translate simply. Searches and early exits become counts or tournaments, sorting becomes ranks, floor and division over a small range of results become threshold counts, running totals become prefix sums, reads at computed indices become one-hots or index reads, and runtime loop counts become a maximum plus bits. Strings, absolute timestamps, `fetch`, platform calls and DOM node lifetime stay in JavaScript.

The building blocks worth packaging:

- An exact comparison that picks its form from declared ranges, e.g. `[pointerX >= windowLeft]` as an integer bit when both values are declared on a 1/64 px grid, and as a sign cascade when they come out of spring arithmetic. numeric-ui-core.ts now has it as `emitCompare`.
- A count of monotone bits that also declares the one-hot of the count, e.g. the first visible row as the count of the bits `[rowBottom[row] <= scrollTop]`, plus the neighbor differences of those bits, which mark that row.
- Prefix sums whose order of additions is an argument, e.g. a chain or wide sums to match a JavaScript loop bit for bit, or a Brent-Kung network for totals that can pass about a million px.
- A spring whose frame matrix JavaScript computes and writes into 4 cells, e.g. one matrix for every window spring with the same stiffness and damping. numeric-ui-core.ts now has it as `emitApplySpringMatrix` and `emitAnimatedObject`, and host-timing.ts computes the matrix.
- Staged per-item programs, e.g. the gallery's per-photo stages with `groupMax`, `prefixSum` and `firstActive` between them.
- A button that acts on release, e.g. the toggle switch's `armed` state bit, or the chains section's 3-state machine over an event queue.
- Tabulated text blocks, e.g. a paragraph's line count as `9 − [width >= 64.245] − [width >= 70.245] − …` over the widths where pretext's layout changes, which JavaScript finds once per text.

[Decisions for you](#decisions-for-you) asks which to adopt, and records the ones already adopted, and [How to check a circuit app](#how-to-check-a-circuit-app) collects the checks a shared verification script could run.

### Pretext

None of pretext's `prepare` was translated: normalizing whitespace, segmenting with `Intl.Segmenter`, merging, classifying and `measureText` still run in JavaScript, and only numbers reach the circuit.

`layout` translated two ways. The first is tabulation, where JavaScript finds the widths at which results change, and the circuit compares the runtime width with them in 4 layers whatever the text. The second is the line walker as arithmetic, where a line's end is a count of "fits" bits, which allows a width per line but spends 70 to 89% of text-walker's circuits at 1,023 segments on one-hots.

code-points moved line break classes and a 41 × 41 pair table into index reads, which cut line start mismatches with pretext from 8,806 to 215 of 41,820 layouts.

The likely pretext bug is in `stepRichInlineLine`: the walker called at src/rich-inline.ts:755 lets an item fit within `lineFitEpsilon`, but line 769 ends the line without the epsilon. E.g. "q" at 12px followed by "-w" at 20px lays out as "q-" / "w" at 23.18 px, "q" / "-w" from 23.1825 px, and "q-w" from 23.1875 px. Adding the epsilon at line 769 removed every one-epsilon-wide backward range in scratch copies and kept pretext's 173 tests passing, but nobody has compared these flows with browsers. More in [text](sections/text.md).

### The talk prototypes

The [talk](sections/talk.md) section explains eleven prototypes: nine that came out of reading the talk against earlier prototypes, and two that ran at the same time, indirect-os-2 as a consolidation check and instanced-items, which carries out one of the notes' ideas. Each gets the idea from the talk in one sentence, the UI problem in front-end terms, what was built, a few numbers with conditions, how cost grows, what to try in its demo with the real control labels, and its main limitation.

The results that carry over to writing apps:

- One program per item, with computations across items between its stages, e.g. instanced-items' gallery is 233 operations per photo, with row maxima, row tops and the clicked photo computed between the per-photo stages.
- Committing state only at event timestamps, while frames evaluate a copy of the table without writing it back, e.g. event-time's committed tables were identical in every bit at 10 to 240 fps.
- Design and behavior numbers in cells instead of constants, e.g. drag-knobs moved card padding, the grid gap and three more design numbers into cells for 60 operations, so a designer's drag can change them.
- A fixed capacity plus a count of how many entries are real, e.g. streaming-words builds for 95 segments and writes `arrivedCount`, and whole-text outputs like the line count read that count.
- Layout and hit tests against destinations instead of drawn positions, e.g. indirect-os-2's Notes paragraph flows around the other windows' destinations, which kept 60 and 120 fps within 2.4e-4 px.

learned-bits' learned rules, retiming's searched delays, pixel-output's per-pixel programs and exactness-budget's relaxed order of additions are research directions, not building blocks.

### Springs and time

IndirectOS's frame-rate dependence is a choice in IndirectOS's code, not a limit: window-manager.ts runs 4 substeps per frame, each a quarter of min(frame duration, 32 ms), so the step length follows the frame rate and frames longer than 32 ms lose time.

What the approach does force is a maximum step count fixed while building, with the count arriving as data: masks over up to 300 unrolled steps (902 layers), the count's binary digits choosing powers of the step matrix (27 to 40 layers), or a frame matrix that JavaScript computes and writes into 4 cells (14 operations and 3 layers for one spring).

ui.md's frame order, which applies new destinations and then catches up, is frame-rate dependent too when a destination changes between frames, and index.ts follows that order: a float64 copy of its loop differed by up to 112 px between 30 and 120 fps. Stepping to each event's timestamp before applying the event, with a settle check after every step, made 10, 30 and 60 fps match 120 fps exactly.

Cheng made that order the default on September 14, 2026. host-timing.ts's `advanceFrame` steps springs to each event's timestamp before the event applies, and checks settling at fixed simulated times, every 64 ms from when the clock started. When state is written back only at events and settle checks, every stored table was identical in every bit at 10, 30, 60 and 120 fps and through 500 ms stalls ([spring-matrix.test.ts](../../../spring-matrix.test.ts)). More in [springs](sections/springs.md).

### Composability

Builder code composes like ordinary functions, because builder code is ordinary JavaScript: the springs section builds a step, a catch-up that calls the step, and a per-frame app that calls the catch-up for two springs sharing one clock, and the app matched a float64 copy of index.ts's `render()` in every step count and settle decision over 15,000 random frames. notation's components, i.e. cell declarations plus a build function that reads the parent's wires, compiled IndirectOS to the identical program.

What doesn't compose at runtime: loop counts and recursion that depend on data; early exits; state kept between frames, which needs a cell that the caller allocates before building; and springs coupled through one shared clock. E.g. in indirect-os-2, text obstacles read from last frame's stacking made Notes' words start moving one rendered frame later, the shared clock restarted in different frames at 60 and 120 fps, and windows ended up 28.8 px apart between the two rates.

Build order also leaks into results, e.g. a range declared after the window springs exist cost IndirectOS 320 operations, and moving a statement changes the order in which ordinary sums add their terms. More in [springs](sections/springs.md#what-composes-at-build-time).

### Decisions

The ten section reports carried 36 decisions. [Decisions for you](#decisions-for-you) merges them into eight questions, most important first, where each question's follow-up decisions only matter once the question itself is settled, and it lists the decisions that can wait. Cheng decided the first three on September 14, 2026.

### The demo directory

Run `bun lab/ui-exploration/serve-demos.ts` from the repo root to serve every demo from one server; another agent is building and checking that script. The [talk](sections/talk.md#running-the-demos) section says what to try in each talk-inspired demo, with the real control labels, and [notes/browser-check.md](../notes/browser-check.md) records what a Chrome check of each demo found, and what that check couldn't measure because its tab was hidden.

## Decisions for you

The ten section reports carried 36 decisions. The questions below merge them, most important first. Under each question, the follow-up decisions only matter once the question itself is settled. The decisions that can wait are listed at the end.

Cheng decided questions 1 to 3 on September 14, 2026, choosing the recommended option each time. Each of those questions starts with what the repo root now has and what's still open, followed by the options, recommendation and reasons as they were when the question was asked.

### 1. Should the shared runtime get an index read instruction?

**Decided on September 14, 2026: add the instruction.** numeric-ui-core.ts now has it, and gather lowering stays for selections that already exist as declared one-hots:

- `circuit.indexRead(index, candidates, {outOfRange})` copies `candidates[floor(index)]` without rounding, and `circuit.indexReadAffine(indexTerms, indexBias, candidates, below, above, {indexRange})` takes the index as an affine form with a rule per side, e.g. `firstVisibleRow + 3` with `'clamp'` below the table and `'zero'` above it. Outside the table a read returns the nearest end (`'clamp'`, the default) or +0 (`'zero'`).
- The index needs a declared range strictly inside ±2^24, and the builder throws on an open range, or on an endpoint that FP32 rounded onto ±2^24. The index must hold an integer, which `validateIndexReads(circuit, values)` checks in tests.
- `backpropagateReference` gives the selected candidate the output's gradient, and throws when a gradient reaches the index, unless the caller passes `{indexGradient: 'zero'}` or `{indexGradient: 'backward-difference'}`.
- `compileTensorProgram(roots, lowerGathers, {recomputeDepths: true})` places each live operation one layer after the deepest value it reads in the compiled program, so a lowered gather stops keeping the depth of the products it replaced. The option is off by default, because it changes existing programs: IndirectOS goes from 192 to 191 layers with the same operations, stored weights and values.

Existing programs compile to the same programs with the same values, e.g. IndirectOS and the candidate gallery. [execution-model.md](../../../execution-model.md#index-reads) defines the instruction, [index-read.test.ts](../../../index-read.test.ts) tests it, and the [indexing](sections/indexing.md#way-3-the-index-read-instruction) section explains it.

**Settled later on September 14, 2026.**

- Changed: the index range has to lie strictly inside ±2^24. Ranges follow FP32 rounding, so the builder also throws on an endpoint on ±2^24, e.g. a cell declared within 0..2^24 plus 1, whose range endpoint f(2^24 + 1) is 2^24 while the real sum is one more.
- Changed: `emitFirstActive` counts an index read whose reachable candidates are all exact bits as a proven bit, e.g. a hit test bit read from a table at a computed row, so it declares a one-hot group over selections among such reads.
- Kept: the builder doesn't require integer endpoints on the index range, it freezes the candidates array, and `recomputeDepths` stays off by default.

**Still open.**

- Packaging the line walker and binary searches on the instruction. A binary search needs an integer comparison, which `emitCompare` from question 2 now provides.

**Options.** Add `indexRead` to numeric-ui-core.ts as a fourth instruction; add only index-read's compile pass, which recognizes ReLU one-hots and reads from their index directly; or keep gather lowering only.

**Recommendation.** Add the instruction, and keep gather lowering for selections that already exist as declared one-hots, e.g. `emitArgmax`'s output. Settle the contract before agents depend on it: the index has a declared integer range, an index outside the table clamps or reads +0, and the value is copied without rounding.

**Follow-up decisions.**

- The backward pass for the index should throw by default, with `'zero'` and `'backward-difference'` as explicit options, since a silent 0 hides that a training loop can't move the index.
- Package the line walker and binary searches on the instruction instead of on one-hots.
- Have `compileTensorProgram` recompute depths after gather lowering, one pass over live operations, so a lowered read stops keeping the depth of the products it replaced.

**Why.** It's the largest change in how cost grows that the prototypes measured. `values[index]` over 10,000 entries goes from 30,002 operations to 1, a binary search finds the first visible row among 10,000 rows in 215 operations against 30,143 by counting, and one-hots are 70 to 89% of text-walker's circuits at 1,023 segments. code-points already depends on the instruction for its break tables, and the compile pass alone still builds each one-hot before removing it (561 ms against 9 ms to build a 10,000-row list).

### 2. Which comparison should building blocks use, and who chooses it?

**Decided on September 14, 2026: one helper that chooses from declarations.** Building blocks use `emitCompare(circuit, a, relation, b, {endWithBoolean})` from numeric-ui-core.ts, for `>`, `>=`, `<`, `<=` and `===`:

- It throws on operands without finite declared ranges, and on ranges whose difference can overflow FP32.
- When both operands are declared on a grid with `circuit.assumeGrid(wire, step)`, and every partial sum stays within 2^24 grid steps, it builds integer bits from `D = (a − b) / grid`, e.g. `[a >= b]` is `relu(1 − relu(−D))`, 2 operations in 2 layers. The builder also infers grids for sums and products of wires that have grids, and `validateGrids(circuit, values)` checks grids in tests.
- Otherwise it keeps the difference as its own operation and builds a sign cascade planned from the declared ranges, so every nonzero FP32 difference, down to 2^-149, gives 1. E.g. for operands within 0..16,384, `[a > b]` is 16 operations in 15 layers, and `[a >= b]` 15 operations in 14 layers.
- `{endWithBoolean: true}` ends with a boolean atom, e.g. 13 layers instead of 15 for `[a > b]` within 0..16,384, or a single atom on a grid.
- The builder records rounding points: `circuit.roundingPoints()` lists every boolean atom (`'boolean'`), every operation of `emitCompare`'s integer bits (`'integer bit'`) and of its sign cascade (`'sign cascade'`), and every operation marked with `circuit.markRoundingPoint(wire)` (`'marked'`), e.g. the steps of a round chain.
- `emitMinimumExact`, `emitMaximumExact` and `emitClampExact` select exactly one operand with an `emitCompare` bit.

The guarantee in execution-model.md: on the CPU, the bit is correct for every nonzero FP32 difference, and on GPU backends that turn subnormal values into 0, the bit may be wrong for differences below 2^-126. In a scratch copy of IndirectOS, converting its 64 hit test atoms, with pointer coordinates declared within ±2^16 on a 1/64 grid, took it from 5,253 to 6,973 live operations and from 192 to 209 layers, with every output equal to today's over 1,612 presses. Window geometry isn't on a grid, so every comparison there became a sign cascade. window-manager.ts wasn't changed. [execution-model.md](../../../execution-model.md#comparisons) defines the helper, [comparison.test.ts](../../../comparison.test.ts) tests it, and the [comparisons](sections/comparisons.md#which-form-to-use-by-default) section explains each form.

**Settled later on September 14, 2026.**

- Changed: the `'comparison'` rounding point kind is split in two. `'integer bit'` marks the operations of integer bits on grids, where a backend may add an operation's terms in any order, fuse them or evaluate them in float64, as long as each operation stays its own operation. `'sign cascade'` marks the operations of a sign cascade, where a backend may evaluate an operation's own sum in any order or in float64, but has to keep each operation separate and reading the same wires, and keep subnormal values.
- Changed: `emitFirstActive` counts the bit `emitCompare` returns as a proven bit, so it declares a one-hot group over a selection among comparison bits. An operation inside `emitCompare`, e.g. a sign cascade stage within 0..1, doesn't count.
- Kept: the integer bit stays `relu(1 − relu(−D))`, and grid operands that span too many grid steps for integer bits get the sign cascade, without an error or a warning.

**Still open.**

- Whether to convert IndirectOS's hit tests, given the measured 17 more layers.
- Whether `emitCompare` should also accept a number as a threshold and pick its FP32 value itself, e.g. the smallest FP32 value at or above 5/24 for `>=`. For now a threshold is a constant wire, e.g. `circuit.affine([], 3)`, and the caller picks the FP32 value.
- The records cover atoms, `emitCompare` and marked operations, e.g. 64 rounding points in IndirectOS, where exactness-budget's patterns found 256. The ReLUs and drifting minimums that feed today's atoms aren't recorded.

**Options.** One comparison helper in numeric-ui-core.ts that picks the form from declared ranges and a declared grid or resolution per wire; separate helpers that authors pick per call; or one rounding stage as the default, as most prototypes did.

**Recommendation.** The one helper. It throws on open ranges, uses integer bits when both operands are declared on a grid, uses the sign cascade planned for every FP32 value otherwise, and ends with a boolean atom only with `{endWithBoolean: true}`.

**Follow-up decisions.**

- Have the builder record rounding points, i.e. boolean atoms, round and floor chains, and the differences that feed comparisons, so a backend or a notation may reorder and fuse every other sum.
- Convert IndirectOS's 64 boolean atoms to integer bits on quantized inputs and cascades on the rest, and measure the change from 192 layers before making the helper the default there.
- Promise exact bits down to differences of 2^-149 on the CPU, and state 2^-126 as the guarantee on GPU backends, since Apple's GPU set subnormal values to 0.

**Why.** The forms fail differently below their resolution: the cascade returns fractions, a rounding stage silently returns wrong bits, and the atom depends on how the executor rounds, so the choice belongs in a declaration that tests can check. Integer bits cost 3 operations and 2 layers and gave the right bit under every executor mode tested, and the cascade gave JavaScript's bits on every FP32 input tested in 16 operations and 15 layers. Wrapping only rounding points in the max guard took IndirectOS's press map, a GPU program that computes which window would receive a press at each pixel, from 537 guards to 84, with 0 decision mismatches. But exactness-budget found rounding points by matching patterns in compiled operations, and those patterns missed life-calendar's clamps.

### 3. How should time enter the program, and which spring should be the default?

**Decided on September 14, 2026: JavaScript writes durations, event times and the spring matrix.** The repo root now has:

- host-timing.ts, the float64 host code. `quantizeFrameTiming(frameTimeStamp, previousFrameTimeMs, eventTimeStamps)` returns the frame's duration and each event's time relative to the frame on a 1/64 ms grid, with a duration of 0 for the first frame after idle. `springMatrixPower(springStepMatrix({stiffness, damping}), steps)` is the matrix JavaScript writes into the 4 cells of each stiffness and damping pair, for fixed 4 ms steps, and `springMatrixBound(constants)` is the range to declare on those cells.
- In numeric-ui-core.ts, `emitApplySpringMatrix(circuit, matrix, displacement, velocity)`, 14 operations in 3 layers for any step count, and `emitAnimatedObject(circuit, springs, {settleCheck, snap})`, which steps every spring of one animated object and settles all of them with one exact bit. Each spring stores its displacement from its destination, not a position. A spring's optional `destinationDuringSteps` is the destination its steps pull toward before this evaluation's events apply.
- `advanceFrame(clock, frameTimeStamp, events, evaluate, writeBack)` in host-timing.ts, which plans a frame's evaluations. Before the events with timestamp T apply, springs step to T, and settling is checked at fixed simulated times, every 64 ms from when the clock started. A frame runs at most 300 steps, and when it would need more, every animated object snaps onto its destination instead. With `writeBack` set to `'events and settle checks'`, only those evaluations write state back, and a frame evaluates a copy of the table.

In spring-matrix.test.ts's traces at 10, 30, 60 and 120 fps and through 500 ms stalls, with presses between frames, `'events and settle checks'` gave identical bits in every stored table and every displayed output at shared timestamps, and settled at the same simulated times as frame-free float64 springs. Writing back every evaluation stayed within 1.4e-4 px of float64, and settled at the same simulated times as well. No demo uses these APIs yet. [execution-model.md](../../../execution-model.md#springs-and-time) defines them, and the [springs](sections/springs.md#4-javascript-writes-the-frame-matrix) section explains the forms they come from.

**Settled later on September 14, 2026.**

- Changed: `emitAnimatedObject` stores each spring's displacement from its destination instead of its position, and rebases the displacement onto a new destination once per retarget. In spring-matrix.test.ts's traces, writing back every evaluation went from 7.3e-4 px to 1.4e-4 px of float64, and the runs that settled differently from float64 went from 2 of 48 to 0. Moved to 65,536 and 131,072 px, every run settled like float64, where with stored positions 42 to 48 of 48 runs settled differently.
- Changed: an object whose springs are all exactly at rest, e.g. right after a snap, has an `active` bit of 0 at any evaluation, instead of keeping it at 1 until the next settle check.
- Changed: when a frame would need more than 300 steps, `advanceFrame` plans a `'snap'` evaluation that lands every animated object on its destination and stops the clock, instead of carrying the backlog into later frames. `maxCarriedMs` is gone, and `quantizeFrameTiming` clamps durations and event times at 1,200 ms.
- Documented: inputs that change destinations, e.g. a viewport resize, should reach `advanceFrame` as timestamped events when stored state must be frame-rate independent.
- Kept: `emitApplySpringMatrix` uses `circuit.multiply` (14 operations and 3 layers, with the right gradient at a matrix entry of exactly 0) rather than spring-bank's signed products (10 operations and 2 layers), a settle check costs one extra evaluation, an event with a timestamp before the last evaluation that wrote state back applies at that evaluation's time, and settle thresholds are numbers fixed while building.

**Still open.**

- The first follow-up below: ui.md, Animation.md and index.ts still apply events first and then catch up.
- event-time's predicted keyframes and the closed-form matrix exp(A × elapsed time) aren't built.
- Converting IndirectOS's springs, which run 4 substeps of the frame's duration, or any demo, to these APIs.

**Options.** For the clock: absolute requestAnimationFrame timestamps in cells, subtracted inside the program, as window-manager.ts does; or the frame's duration and event times relative to the frame, computed in JavaScript. For springs: `emitSpring`'s 4 substeps of the frame duration; spring-bank's power tables inside the program; JavaScript writing the step count's 9 binary digits; or JavaScript writing the frame matrix.

**Recommendation.** JavaScript writes the frame's duration and event times relative to the frame on a 1/64 ms grid, and a duration of 0 for the first frame after idle. The default spring is a frame matrix that JavaScript writes, 4 cells per stiffness and damping pair, with one settle bit per animated object.

**Follow-up decisions.**

- Change ui.md, Animation.md and index.ts to step springs to each event's timestamp before applying the event, and to check settling at fixed simulated times, e.g. every 16 steps, instead of once per frame.
- Where stored state must be bit-identical across frame rates, commit state only at event timestamps, and let frames evaluate a copy of the table without writing it back.
- Keep event-time's predicted keyframes optional, i.e. Web Animations keyframes built from the screen at 301 moments 4 ms apart after each commit, so the browser keeps playing transforms while JavaScript blocks, until a visible Chrome tab shows transforms playing through a stall.
- Later, prototype the closed-form matrix exp(A × elapsed time) as the matrix JavaScript writes, which would match Animation.md's closed-form spring.

**Why.** A `Float32Array` stores absolute timestamps on a 0.5 ms grid from about 70 minutes after page load, so a 16.6 ms frame then measures 16.5 ms. The frame matrix costs 14 operations and 3 layers per spring, doesn't depend on the frame rate, keeps stiffness and damping editable, and gave spring-bank's smallest copy of IndirectOS (3,413 operations). In float64, stepping to event timestamps removed the 112 px difference between 30 and 120 fps without changing the architecture, but a settle check once per frame still left 15.8 px at 10 fps.

### 4. What should agents build apps from?

**Options.** Raw numeric-ui-core.ts calls with hand-kept offsets, or notation's declarations (cells with range, policy and initial value, and `table.next`); buttons that act on press, or on release; several presses per evaluation, or one press per evaluation with JavaScript splitting the frame; each app's own validator, or one shared host check.

**Recommendation.** notation's declarations for app code, and raw calls only in the model section, where every operation should stay visible. Buttons act on release, like native buttons. When the table keeps one latch per event kind, a button needs one extra state bit, `armed`, as in the toggle switch example. When the table holds an event queue, a button is the chains section's 3-state machine (idle, armed, and pressed with the pointer outside), which arms again when the pointer moves back inside before the release. indirect-os-2's buttons use a stricter rule: a press that moves more than 4 px from the press point turns into a drag, so moving back onto the button before the release doesn't click. One press per evaluation, with JavaScript splitting the rare frame that has more.

**Follow-up decisions.**

- Make notation's derived validators the shared host check, run on the cells JavaScript writes and on next-state values before they're copied back, with full-table validation kept in tests.
- Add a helper that counts monotone bits and declares their neighbor-difference one-hot, with a test-time check that the bits are sorted.
- Make a prefix sum's accumulation order a required argument: a chain or wide sums when a sequential JavaScript reference must match bit for bit, and Brent-Kung for totals that can pass about a million px.
- Use tabulated text by default, and the line walker only when lines need their own widths or words change width at runtime.

**Why.** notation compiled IndirectOS to the identical program, with hand-kept bookkeeping down from 641 lines to 110. The toggle switch's release form costs one state bit and one more hit test (22 operations), and matched plain JavaScript on all 280 frames. Each more press per evaluation costs about 427 operations and 17 layers in input's window circuit, and about 2,200 operations and 40 layers in indirect-os-2's whole program, whether or not a press arrives. The executor's range check accepts Infinity in open ranges and 0.5 in cells that should hold exact bits, unsorted bits from a negative row height gave wrong counts with no error, and one-at-a-time prefix sums flipped 74 decisions at 10,000 photos where Brent-Kung sums flipped none. Tabulated text is 4 layers deep, while the walker's Notes flow added 11,795 operations and 174 layers to IndirectOS.

### 5. Should collections be written as staged per-item programs?

**Options.** Staged programs for large or unknown-size collections, and duplicated circuits for a handful of different items; staged programs for every repeated part; or duplicated circuits only.

**Recommendation.** The first option, with instanced-items' staged builder moved into the shared runtime, and the duplicated circuit kept as the definition every executor must match bit for bit. Keep products for per-item constants, and keep reductions on the CPU until a workload needs well past 10,000 items.

**Why.** The gallery stays at 233 operations per photo, and ran about 10 times faster than its duplicated circuit at 10,000 photos (4,106 against 43,027 µs). Staging IndirectOS's 20 small items made it bigger (6,282 against 5,253 operations), because lookup tables that were free weights became products. Map stages were bit-exact on the GPU, but with one readback per stage the GPU pipeline was slower than the CPU executor at every size.

### 6. Should depth be optimized now?

**Options.** Ignore depth until a layer-parallel backend exists; build a layer-parallel GPU executor first and optimize depth against it; or measure one per-layer GPU pass first, and meanwhile accept only changes that remove layers while adding few operations.

**Recommendation.** Measure what one per-layer GPU pass costs first. Until then, accept changes that remove layers while adding few operations. E.g. computing a frame's spring steps as one matrix power (192 to 137 layers in IndirectOS); letting Photos read its window's spring positions right after this frame's steps, before settled springs snap to their destinations (137 to 91 layers); and hit-testing and laying out against the windows' destinations instead of their drawn positions.

**Follow-up decisions.**

- No automatic one-frame delays: prefer earlier values from the same frame and destinations, and allow a delay only on outputs that a written list marks as tolerant of one frame of lag.
- Offer prefix scan helpers for latches, counts, ORs that reset, maximum and minimum, and linear maps, with the prefix network as a required argument, and keep general transition-matrix scans hand-written.

**Why.** The prefix scan, speculation and pointer jumping forms cost more operations than the loop in every measurement: about 2 to 9 times as many on the button queue, keyboard focus, a running maximum and the chains section's line starts, and 25 times for index-read's pointer jumping over 157 lines (35,914 against 1,409 operations beyond the table). Removing 104 layers in indirect-os-2 changed CPU time by less than the noise. The ceiling on what a layer-parallel executor could gain is only 24 to 58 for window managers and app layout, while collections reach about 800 without any rewrite. Hand-chosen delays were 86 to 1,380 px off, and one searched set of delays broke with over 7,000 mismatches on random traces.

### 7. Should pretext take the epsilon change at src/rich-inline.ts:769?

**Options.** Apply `lineWidthContribution > remainingWidth + lineFitEpsilon` now, with regression tests for the two minimal flows; lay the flows out in browsers first; or leave rich inline layout as it is.

**Recommendation.** Lay out "q" at 12px followed by "-w" at 20px near 23.18 px, and "u" at 16px followed by "了解で" at 20px near 46.995 px, in Chrome, Safari and Firefox first. If the browsers don't give either flow more lines or an earlier line start as the width grows, apply the change with a test that no line start moves earlier as the width grows.

**Why.** In scratch copies the change removed every one-epsilon-wide backward range (1,567 to 2,089 per engine profile over 80 random flows), left the wider ranges from soft hyphens unchanged, and kept pretext's 173 tests passing. But pretext aims to match browsers, and nobody has compared these flows with one.

### 8. What should the next learning experiment be?

**Options.** todo.md's retrieval of an item's rectangle by id, while storage positions, active counts and distractors vary; extending indexing's carousel toy to uneven snap targets with runtime keys; or pausing learning experiments until the index read instruction lands. numeric-ui-core.ts has had the instruction since September 14, 2026 ([decision 1](#1-should-the-shared-runtime-get-an-index-read-instruction)), so the condition in the third option is already met.

**Recommendation.** The retrieval task, trained with soft attention over runtime keys, run with argmax, and compared with lab/data-adapter's authored lookup and program search.

**Follow-up decisions.**

- Add a builder that computes scores once and gives both a soft read for training and argmax or an index read for the circuit that runs, with the learned numbers in cells.
- Train through exact decisions with a relaxation built from the same code, e.g. one clamp or fewer cascade stages, then harden, and keep frozen decisions for gradient checks.

**Why.** Retrieval is the smallest task where no fixed position works, so the keys have to come from data, while the carousel toy's squared-error control showed that fixed keys can be learned by plain regression. The hard cascade gives gradient 0 almost everywhere, straight-through gradients differed from finite differences at 592 of 2,250 checks in drag-knobs, and lab/cascade-argmax trained through a single clipped ramp and then picked the right candidate in 160 of 160 cases with the hard circuit.

### Decisions that can wait

- Whether constant folding should turn `multiply` with a constant operand into a weight, and warn when a constant reaches `emitSelect`, `roundAffine`, `emitMinimum` or `emitMaximum`. E.g. `circuit.multiply(velocity, circuit.affine([], 0.004))` is 2 operations and 2 layers, where `circuit.affine([[velocity, 0.004]])` is 1 operation with the same bits.
- Whether copying sums of fewer than 4 terms into the operations that read them is the right trade. Copying saves an operation and a layer per sum, but multiplies stored weights, and can put large ReLU values into a running sum, e.g. an integer bit's two ReLUs inside a weighted sum.
- Whether an operation should read its coefficient from a per-item column instead of multiplying by a per-item cell. That would remove the products for per-item constants, which are part of the staged gallery's 33 extra operations per photo.
- Whether to run reductions on the GPU, e.g. counts, the first set bit and Brent-Kung prefix sums as GPU passes, so a frame stops reading results back after every map stage.
- Whether to package a sorting network for apps that sort well past 64 items, next to ranks by counting and the update when one item moves. E.g. at 64 items with a payload, a bitonic network was 10,624 operations and 105 layers, against 16,512 operations and 5 layers for ranks by counting.
- Whether to build speculation over press sessions, i.e. running one press session's hit tests against each possible outcome of the session before it, e.g. which window rose to the front, and selecting the matching result. A drag's outcome includes where the window landed, a continuous position, and how to pass that position to the next block of sessions is the unbuilt part.
- Whether Stop in the middle of a streamed word should keep the word as shown when JavaScript handles the click, instead of shortening the word back to what had arrived at the press, which sent the growing word back a line at 9 of 260 press times in streaming-words.
- Whether grapheme cluster boundaries should become another pair table in code-points, so the caret can't stop inside an emoji sequence or a letter with combining marks.

## How to check a circuit app

A circuit can be wrong in ways a plain JavaScript app can't: a declaration that the compiler used without checking was false, FP32 drift crossed a threshold, or an unpicked branch overflowed and turned a masked sum into NaN. The prototypes used the checks below, and each check catches a different kind of failure. Every prototype wrote its own harness, e.g. hn-thread's `differential.ts` and `mutation.ts`, and input's `traces.ts`, while numeric-ui-core.ts provides `validateOneHotGroups`, `validateIndexReads`, `validateGrids` and `validateTensorEvaluation`, and every evaluator checks source ranges itself. A shared verification script could run all of these checks from an app's cell declarations, its plain JavaScript reference and its trace generators.

### Compare with a plain JavaScript reference

Write the same app as plain JavaScript in ui.md's shape, without importing any circuit code, run both versions over the same traces, and compare every decision exactly and every position within a stated tolerance. input's reference applies a frame's events one at a time, so the comparison also checks how the circuit handles several events in one frame, e.g. indirect-os-2's named case where a press must read the result of a drag commit earlier in the same frame.

This comparison catches wrong semantics, NaN from masked paths, and FP32 drift that crosses a threshold. gallery's differential tests found springs near 100,000 px that could never come within 0.01 px of their destination, so the page never stopped animating, and a table lookup over threshold bits whose entry near 1e-6 carried 10% error after a 912 ms stall.

A float64 reference and an FP32 circuit give different results next to thresholds, so choose one of two approaches. Either use exactly representable inputs, e.g. quarter-pixel pointers, integer sizes and dyadic frame durations, where both versions compute the same numbers, as the instancing example does. Or state a tie rule: hn-thread counts a decision as a tie when the reference's own values put the decision within 0.02 px of its threshold, and its first two tie rules silently exempted every decision in most frames until a mutation check exposed them.

### Compare the compiled program with the reference evaluator

Evaluate the same table with `evaluateReference` and with the compiled executor, and compare every live wire bit for bit, e.g. with `validateTensorEvaluation`. This comparison catches compiler and executor bugs, and false declarations that the compiler used without checking. For example, with a fractional index of 2.5 over a declared one-hot, the reference evaluator returns 44 (half of 28 plus half of 60), while the compiled gather returns 28.

### Validate ranges, exact bits, one-hot groups and index reads

The executors check every source cell against its declared range on every evaluation and reject NaN, but accept Infinity in an open range and 0.5 in a cell that should hold an exact bit. So the host should also check finiteness and exact bits, on the table before a frame and on the next-state values before copying them back, e.g. the toggle switch's `validateCells`, or notation's validators derived from cell declarations, which cost about 1 µs per frame on IndirectOS. Tests should run `validateOneHotGroups` on evaluated values, `validateIndexReads` wherever the index read instruction is used, and `validateGrids` wherever a grid is declared.

These checks catch the host writing values outside their ranges, state that leaves its range, and ranges that are false in FP32. layout-tree declared a timestep cell's maximum as 0.008, which a `Float32Array` stores as 0.0080000004, so every frame of 32 ms or more threw. A validator that throws can also be the rule that's wrong: photo-gallery.ts's output check rejected a thumbnail's left edge at -6.61 px, but thumbnails legitimately spring in past the left edge.

### Choose traces for what they test

Random traces reach many paths quickly when the trace generator runs its own copy of the plain JavaScript reference, reads the positions of what's on screen from that copy, and places presses on those elements, e.g. a window's title bar, its buttons or its body. input's random trace caught 8 of 10 planted corruptions. Realistic traces help choose which numbers should ship, but don't check whether the circuit is right: user-population's simulated users at a steady 60 fps caught only 2 of the same 10 corruptions, because 72.6% of user-frames carried no event and 4 in 39 million carried two presses. Scripted traces pin named cases, e.g. a press exactly on a track's right edge, or a press and a release within one frame.

Random inputs almost never land in thin bands, so probe those bands directly. gallery's edge probe put pointers right next to photo edges at 6 viewports and scroll positions, and found 10 hover and click results that differ from index.ts, all between index.ts's edge and the circuit's edge, within 0.18 px of each other. Exhaustive sweeps work for small inputs, e.g. every quarter-pixel scroll position of a 48-row list, every container width from 0 to 8,192 px, or 1 to 3 FP32 steps on either side of every text threshold.

Count coverage, not checks. In gallery, 83% of 957,258 raw checks were visibility bits, most of them for photos far offscreen, so its README counts how often each decision's reference value changed. retiming's searched delays broke on new traces, because 23 of 49 delayed values never changed in the trace the search replayed.

### Plant corruptions

A mutation check corrupts one live operation at a time and reruns the tests. hn-thread's tests caught 69 of 78 corruptions. The misses were ReLUs whose change a clamp absorbed, and a branch that the 60-comment thread never takes, and an earlier version of the sweep missed a corrupted "already collapsed and clicked" bit because it clicked each banner from only one starting state. This check catches traces that never reach a branch, and tolerances or tie rules that exempt too much.

### Run open loop and closed loop

Open loop copies a reference run's state into the circuit before every frame, so each frame compares one evaluation's arithmetic. Closed loop lets the circuit carry its own state, where small differences grow, e.g. a spring settles one frame late and the shared clock restarts in a different frame. Run both: in exactness-budget, reordered and fused sums flipped 1 boolean atom open loop and 5 closed loop across its seven UIs. Copying state can create its own mismatches, e.g. gallery's copied-state run paired the reference's float64 displacement with the circuit's FP32 destination, and produced one mismatch that the circuit didn't cause.

### Replay at several frame rates, and under other executors

Replay the same trace at 10 to 240 fps and with stalls, and compare the runs at the timestamps they share. This replay catches frame-rate dependence, e.g. IndirectOS's substeps put windows 183 px apart between 30 and 120 fps, where event-time's commits differed in 0 bits.

When a program will run on another executor, test it there, and also run it under the rewrites a compiler may apply. exactness-budget ran seven UIs with reversed, balanced, fused and float64 sums, and float64 everywhere broke every UI that relies on FP32 rounding. The comparisons examples add a mode that sets subnormal values to 0, which broke the sign cascade on exactly the inputs where Apple's GPU did. codegen found that emitted shaders need differential tests in every mode: an operator precedence bug in the unguarded shaders went undetected while the tests only interpreted guarded ones.

### Check exactness and gradients directly

Two more checks measure what differential tests can't. The comparisons examples recompute every operation's result exactly with BigInt arithmetic and compare it with the FP32 result, which showed that no operation inside a sign cascade rounded on the tested inputs. The indexing and differentiability examples compare the backward pass with central finite differences of a float64 twin, and use one-sided differences at corners, e.g. a ReLU at 0 or an integer bit at its threshold, where a central difference gives neither side's slope.

### Open the page in a browser

Headless tests missed several problems that a Chrome check found ([browser check](../notes/browser-check.md)). layout-tree's machine threw on every frame of 32 ms or more. streaming-words stepped its springs through up to 1,020 ms of idle time on the first frame after an input. pixel-output's generated code nested `Math.fround` 1,003 deep, and V8 throws a stack overflow error at about 665 levels, while Bun's JavaScriptCore runs the same code. indirect-os-2's switch to generated code stalled an animation with a warmup step of about 500 ms. The check ran in a hidden tab with `requestAnimationFrame` replaced by a timer, so it couldn't check real frame pacing or window resizes.

## Running the examples

From the repo root:

- `bun test lab/ui-exploration/guide/examples` runs every example's tests: 217 tests across 33 files in a few seconds, each checking circuits against plain JavaScript, or gradients against finite differences. `bun test lab/ui-exploration/guide/examples/patterns` runs only the pattern docs' 83 tests.
- `bunx tsgo -p lab/ui-exploration/guide/examples/model` typechecks one folder. The other section folders are loops, springs, instancing, indexing, comparisons, chains, executor, differentiability and text, and the pattern folders are patterns/selection, patterns/combining-steps, patterns/every-item, patterns/candidates-and-tables and patterns/fewer-dependencies.
- Every section folder except model has a `report.ts` that prints the numbers its section quotes, e.g. `bun lab/ui-exploration/guide/examples/loops/report.ts`. The pattern folders pin the numbers their docs quote in their tests.
