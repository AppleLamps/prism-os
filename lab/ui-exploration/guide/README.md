# Writing interactive UI as one numeric program

## How to read this

This guide explains how Indirect writes an interactive UI as one fixed numeric program, and what the 24 prototypes in lab/ui-exploration measured about that approach. It's for people who know front-end development and vibescript's ui.md, and for agents with no context who build apps like IndirectOS. This folder holds the long explanations, the glossary and the runnable examples. [review-and-decisions.md](review-and-decisions.md) is a dated record of Cheng's review points with the guide's answers, and of the decisions as they were asked.

Every section explains its concepts in the same order: the problem in UI terms, the familiar JavaScript, the circuit form with builder code, why the circuit form gives the same result, what it costs, measured numbers with their conditions, when not to use it, and pitfalls. Costs use two measures. Operations are the total work of one evaluation, and depth is the longest chain of operations that must run one after another, counted in layers. Big-O shapes use n for the item count, e.g. comparing every pair of n items is O(n²) operations at constant depth.

A suggested reading order:

1. The short docs in docs/. [tutorial.md](../../../docs/tutorial.md) walks through [template/](../../../template/), a toggle switch written as one program and checked against plain JavaScript: cells, builder code, the host loop, DOM writes and the test. Then [expressions.md](../../../docs/expressions.md) covers constructions that replace one familiar expression, e.g. `a >= b` or `table[index]`, [patterns.md](../../../docs/patterns.md) constructions that replace a loop, e.g. `findIndex` or `items.sort(compare)`, and [behavior-choices.md](../../../docs/behavior-choices.md) choices that change what the user sees, e.g. hit-testing where elements are going instead of where they're drawn. [execution-model.md](../../../docs/execution-model.md) defines the instructions and the contracts these docs depend on.
2. [The model](sections/model.md). It starts with what changes compared with an ordinary JavaScript UI, maps ui.md's render loop onto the source table and the program, introduces the three operations and the index read instruction, the first macros and declared ranges, and ends with a translation table and a toggle switch checked against plain JavaScript. The table maps 35 JavaScript concepts, in two groups: the same idea written differently, and a different algorithm. A third group lists 4 things JavaScript has no counterpart for.
3. [Loops](sections/loops.md) next, since counts, prefix sums, threshold counts and ranks show up in every other section. [patterns/](patterns/README.md) holds 18 of the long forms, one construction per page, each with a runnable example.
4. Then whichever topic you're curious about, from the [table of contents](#table-of-contents).

Numbers come from the prototype READMEs' final text, with the conditions stated there, or from the runnable examples in [examples/](examples/), whose tests check each circuit against plain JavaScript. "0 mismatches" means over the named traces or samples, not a proof. Timings are rough, because many agents shared one laptop while measuring. This is exploratory research, so each section states its limits plainly.

## Glossary

The sections use each of these terms with the meaning given here.

### Notation

- **`[condition]`**: 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript. E.g. `[pointerX >= windowLeft]` is 1 while the pointer is at or right of the window's left edge, and `[arrivedCount >= segmentIndex + 1]` is 1 for every segment that has arrived.

### The program and the host

- **Source table**: the `Float32Array` that holds every number a frame reads, i.e. inputs that JavaScript writes and state that the program computes. E.g. IndirectOS's source table has 241 cells, including the viewport width and each window's left edge.
- **Cell**: one number at a fixed position in the source table, with a declared range and a policy: constant, input, event latch or state. E.g. `downActive` is the event latch cell that holds 1 after a pointer press.
- **Latch**: a stored value that keeps its most recently written value until the next write. E.g. an event latch cell holds 1 after a pointer press until a frame reads it, and the frame's next value for that cell is 0.
- **Event queue**: a fixed number of queue entries in the source table, each holding one event's kind bits and coordinates, for when the order of several events within one frame matters. E.g. input's folded window circuit has 16 queue entries per evaluation.
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

- **Live operations**, or just operations: the operations a compiled program keeps because some root depends on them, all of which run on every evaluation. E.g. IndirectOS builds 4,011 operations and keeps 3,654 live.
- **Layer**: a group of operations that don't read each other, which runs as one sparse matrix multiplication. E.g. a thousand hit tests against one pointer can share the same layers.
- **Depth**: the number of layers, i.e. the longest chain of operations that must run one after another. E.g. IndirectOS is 124 layers deep, and a loop that updates a button's state once per queued event takes at least one layer per event.
- **Stored weights**: the nonzero coefficients the compiled layers keep, which measure memory and the work inside sums. E.g. one sum over 1,024 values is 1 operation but 1,024 stored weights, so O(n²) growth often shows only in stored weights.
- **Layer width**: the number of operations in one layer, i.e. how much could run at the same time on hardware that runs a whole layer at once. E.g. IndirectOS has a median of 23 operations per layer.
- **Executor**: the code that runs a program. `evaluateReference` runs operations one at a time and defines what a program means, while `evaluateTensor` and `createTensorEvaluator` run the compiled layers and must return the same bits. E.g. the toggle switch's test checks on every frame that both return the same bits.
- **Generated JS**: plain JavaScript statements that the codegen prototype emits from a compiled program, with the same bits as the executor. E.g. before September 15, 2026, IndirectOS ran in about 3 µs as generated JS once the engine had optimized it, against about 30 to 40 µs on the executor.

### Numbers and exact decisions

- **FP32**: the 32-bit float format of `Float32Array`, which the runtime rounds to after every addition and product, like `Math.fround`. E.g. integers are exact up to 2^24 = 16,777,216, and positions 100,000 px down a page are 1/128 px apart.
- **Exact bit**: a wire whose value is always exactly 0 or 1. E.g. `pressed`, the product of the `downActive` latch and a hit test bit.
- **Integer bit**: an exact `[v >= t]` built from ReLUs of a whole-number difference. `emitCompare` in numeric-ui-core.ts builds it as `relu(1 − relu((t − v) / grid))`, in 2 operations and 2 layers, when both operands are declared on a grid and every partial sum stays within 2^24 grid steps. E.g. `columnCount >= 3`, or `[pointerX >= windowLeft]` on a 1/64 px grid, where `64 × (windowLeft − pointerX)` is a whole number. The older form, `relu(v − t + 1) − relu(v − t)` for an integer v, is 3 operations in 2 layers.
- **Sign cascade**: a comparison that multiplies a difference by powers of two and clamps it to at most 1 in stages, with no rounding inside, until every difference at or above the resolution reaches exactly 1. E.g. `[pointerX > windowLeft]` for every pair of FP32 values within 16,384 is 16 operations and 15 layers. `emitCompare` builds one when the operands aren't declared on a grid.
- **Rounding stage**: a comparison that scales a difference into a score next to 0.5, clamps the score to 0..1 and rounds it with the boolean atom. E.g. the model section's `emitAtLeast` is one rounding stage, 4 operations in 3 layers.
- **Resolution**: the smallest positive difference a comparison must detect. E.g. 1/64 when both operands are on a 1/64 px grid, or 2^-149 to handle every pair of FP32 values.
- **Grid**: a power of two that every value of a wire is a multiple of, declared with `circuit.assumeGrid(wire, step)`, or inferred by the builder for sums and products of wires that have grids. E.g. pointer coordinates that the host writes in 1/64 px lie on a 1/64 grid, so `emitCompare` compares them with integer bits, and `validateGrids(circuit, values)` checks the declaration in tests.
- **Rounding point**: an operation where FP32 rounding turns a value into a decision, or a value that feeds such an operation, so a backend that reorders sums, fuses products into sums or skips FP32 rounding has to keep the stored FP32 steps there. E.g. a boolean atom; each step of `round(x) = (x + 2^23 + 2^22) − (2^23 + 2^22)`, which rounds only because FP32 values above 2^23 are whole numbers; and the difference `pointerX − windowLeft` that feeds a rounding stage. numeric-library's exact `[a >= b]` has 4 rounding points (its difference, the two ReLUs of its clamp and its boolean atom), and a blend `0.3 × a + 0.7 × b` has none. [exactness-budget](../codegen/README.md#merged-from-exactness-budget-september-16-2026) found rounding points by matching patterns in compiled operations, and one of its patterns, a ReLU that scales one runtime value by a power of two of at least 2^8, also matches the stages of a sign cascade, e.g. `relu(2^24 × clamped − 1)`, although a sign cascade gives the same bits without any rounding. The builder now records rounding points itself: `circuit.roundingPoints()` lists every boolean atom, every operation `emitCompare` builds, as `'integer bit'` on grids and `'sign cascade'` otherwise, and operations marked with `circuit.markRoundingPoint(wire)`, e.g. the steps of a round chain.
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
- **Spring bank**: fixed 4 ms spring steps, applied as a power of one shared 2×2 step matrix, so each animated number costs 4 products. E.g. [spring-bank](../event-time/README.md#merged-from-spring-bank-september-16-2026)'s copy of IndirectOS, in event-time since September 16, 2026, went from 5,253 operations and 192 layers to 3,580 and 137.
- **Frame matrix**: the 2×2 matrix that moves a spring's displacement and velocity through all of one frame's fixed 4 ms steps at once, i.e. the one-step matrix M raised to the frame's step count. E.g. for a 16.7 ms frame, which runs 4 steps and carries 0.7 ms into the next frame, JavaScript computes M^4 and writes its 4 entries into cells, or the circuit computes M^4 from the step count. numeric-ui-core.ts and host-timing.ts call it the spring matrix (`SpringMatrixWires`), since evaluations between frames, e.g. at an event's timestamp, write one too.
- **Deferred retargeting**: this frame's spring steps keep moving toward last frame's destination, and the spring starts moving toward this frame's new destination only from this frame's timestamp onward. E.g. after a press between two frames, the steps up to the next frame's timestamp still head to the old destination. spring-bank's copy of IndirectOS in event-time keeps last frame's destination in one extra cell per animated value, and `emitAnimatedObject` reads it from each spring's `destinationDuringSteps` wire.
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
- **Lookahead**: how many segments after a line's start the line walker compares, which caps how many segments one line can hold. E.g. 26 in IndirectOS's Notes flow at the paragraph widths baked into notes-paragraph.ts, and 21 in text-walker's circuits for a 1,023-segment paragraph.

### Checking

- **Reference**, or oracle: an independent plain JavaScript implementation that a circuit is compared with, and that never imports circuit code. E.g. input's reference applies a frame's events one at a time.
- **Trace**: a recorded or generated sequence of inputs and frame times that both a circuit and its reference run. E.g. the toggle switch's scripted trace of 280 frames with 25 pointer events.
- **Open loop** and **closed loop**: open loop evaluates each frame on state copied from a reference run, and closed loop lets the circuit carry its own state, so small differences can grow over frames. E.g. [exactness-budget](../codegen/README.md#merged-from-exactness-budget-september-16-2026)'s reordered and fused sums flipped 1 boolean atom open loop and 5 closed loop.
- **Mutation check**: corrupting one live operation at a time and checking that the tests fail. E.g. hn-thread's tests caught 69 of 78 corruptions.

## Table of contents

- [The model, and how familiar UI code maps onto it](sections/model.md). Covers the instructions and expressions, and lists loops in its translation table. What runs in JavaScript, what runs in the program, and what does familiar code become? JavaScript keeps the render loop, the DOM, strings and timestamps, the program computes the middle of ui.md's render from the source table, and a translation table maps 35 JavaScript concepts to circuit forms with how their costs grow, split into the same idea written differently and a different algorithm, plus 4 things JavaScript has no counterpart for.
- [Patterns, in long form](patterns/README.md). Covers loops and behavior choices, plus threshold counts, which replace one expression. Which algorithm replaces a loop that JavaScript would write? 18 one-page docs, e.g. a count instead of a search, a tree of additions for running totals, and a press hit-tested against spring destinations instead of drawn positions, each with the familiar code it replaces, the circuit, measured sizes, when it's exact, and a runnable example with a test. Their short entries are in docs/: [patterns.md](../../../docs/patterns.md), [behavior-choices.md](../../../docs/behavior-choices.md) and [expressions.md](../../../docs/expressions.md).
- [Loops and searches without loops](sections/loops.md). Covers loops, and threshold counts, which replace one expression. What replaces a loop that stops early, a running total, floor and division, and sort? Counts of monotone bits, prefix sums in three forms, threshold counts and ranks, e.g. the first visible row among 10,000 rows is a count at constant depth.
- [Springs, time, and composing behavior](sections/springs.md). Covers loops and behavior choices. Is IndirectOS's frame-rate dependent spring a quirk or a limit? A quirk: window-manager.ts made each substep a quarter of the frame's duration, until it moved to `emitAnimatedObject` on September 15, 2026. Fixed 4 ms steps cost 3 layers per spring when JavaScript computes the frame matrix, i.e. the product of all of this frame's steps, and writes it into 4 cells, which numeric-ui-core.ts now builds with `emitApplySpringMatrix` and `emitAnimatedObject`, while host-timing.ts plans the evaluations. The section also covers what composes while building and what doesn't compose at runtime.
- [Instancing: write the per-item program once](sections/instancing.md). Covers loops. What changes when each photo's program is written once? The gallery goes from 48,411 operations for 221 photos to 233 operations per photo at any count, with reductions such as prefix sums and the first photo under a click between the per-photo stages.
- [Reading at a computed index, differentiation, and attention](sections/indexing.md). Covers expressions, and gradients through them. How does a circuit read `table[index]`, and does a gradient reach the index? Three ways cost from O(n) operations down to 1, and the 1-operation way is now `circuit.indexRead` in numeric-ui-core.ts; the table's values get gradients but the index doesn't, and the soft reads that do give the index a gradient are soft attention.
- [How comparisons become exact bits](sections/comparisons.md). Covers expressions. What happened to the sign cascade, and which comparison should be the default? Integer bits for quantized inputs, the sign cascade for continuous values (16 operations and 15 layers for every pair of FP32 values within 16,384), and the boolean atom only as an optional last stage. numeric-ui-core.ts's `emitCompare` now picks between them from declared ranges and grids.
- [Long dependency chains, and ways to shorten them](sections/chains.md). Covers loops and behavior choices. Can a deep chain get shorter? When the state carried between steps has few possible values, yes, with prefix scans, speculation or pointer jumping, for more operations than the loop, e.g. about 3 to 8 times as many on the button queue, and 25 times for index-read's pointer jumping. A pipeline of different stages only gets fewer layers when one stage is rewritten with fewer layers, e.g. picking the clicked photo by counting earlier hits instead of by a tournament took the gallery from 61 to 41 layers, or when the app computes something else, e.g. hit tests against destinations.
- [What the compiled program costs, in big-O terms](sections/executor.md). Covers the cost of instructions and compiled programs, for constructions of every size. How do you predict a circuit's cost without timing it? Count live operations, layers, stored weights and layer width; builder and compiler steps mostly change constant factors, while semantic choices, e.g. an index read instruction, change how cost grows.
- [Differentiability, and static bounds](sections/differentiability.md). Covers gradients, and one behavior choice: a fixed maximum with a named fallback. Which parts of a program give useful gradients, and can springs be trained later? Sums, products and selects do and exact decisions don't; a spring whose step matrix comes from cells gave gradients within 1.3e-4 relative error of finite differences, and every quantity that looks dynamic gets a static bound with a fallback, which also fixes the size of the backward pass.
- [Text and pretext: what actually translated](sections/text.md). Covers loops. Which parts of pretext became circuit? Only layout, either as tabulated width thresholds or as the line walker written in arithmetic; `prepare` and measuring stayed in JavaScript, and rich inline layout has a likely bug with a one-line candidate fix.
- [The talk-inspired prototypes, explained plainly](sections/talk.md). Covers expressions, loops and behavior choices, one prototype at a time. What did the prototypes from the talk build and show? Each of the eleven gets its idea from the talk, its UI problem, what was built, numbers with conditions, what to try in its demo, and its main limitation.
- [Review answers and decisions](review-and-decisions.md). A dated record, not a section: Cheng's review points with the guide's answers, and the eight decisions as they were asked, with what was decided on September 14, 2026.

## How to check a circuit app

A circuit can be wrong in ways a plain JavaScript app can't: a declaration that the compiler used without checking was false, FP32 drift crossed a threshold, or an unpicked branch overflowed and turned a masked sum into NaN. The prototypes used the checks below, and each check catches a different kind of failure. Every prototype wrote its own harness, e.g. hn-thread's `differential.ts` and `mutation.ts`, and input's `traces.ts`, while numeric-ui-core.ts provides `validateOneHotGroups`, `validateIndexReads`, `validateGrids` and `validateTensorEvaluation`, and every evaluator checks source ranges itself. A shared verification script could run all of these checks from an app's cell declarations, its plain JavaScript reference and its trace generators.

### Compare with a plain JavaScript reference

Write the same app as plain JavaScript in ui.md's shape, without importing any circuit code, run both versions over the same traces, and compare every decision exactly and every position within a stated tolerance. input's reference applies a frame's events one at a time, so the comparison also checks how the circuit handles several events in one frame, e.g. input's named case where a press must read the result of a drag commit earlier in the same frame.

This comparison catches wrong semantics, NaN from masked paths, and FP32 drift that crosses a threshold. The gallery's differential tests, now in [instanced-items](../instanced-items/README.md#merged-from-gallery-september-16-2026), found springs near 100,000 px that could never come within 0.01 px of their destination, so the page never stopped animating, and a table lookup over threshold bits whose entry near 1e-6 carried 10% error after a 912 ms stall.

A float64 reference and an FP32 circuit give different results next to thresholds, so choose one of two approaches. Either use exactly representable inputs, e.g. quarter-pixel pointers, integer sizes and dyadic frame durations, where both versions compute the same numbers, as the instancing example does. Or state a tie rule: hn-thread counts a decision as a tie when the reference's own values put the decision within 0.02 px of its threshold, and its first two tie rules silently exempted every decision in most frames until a mutation check exposed them.

### Compare the compiled program with the reference evaluator

Evaluate the same table with `evaluateReference` and with the compiled executor, and compare every live wire bit for bit, e.g. with `validateTensorEvaluation`. This comparison catches compiler and executor bugs, and false declarations that the compiler used without checking. For example, with a fractional index of 2.5 over a declared one-hot, the reference evaluator returns 44 (half of 28 plus half of 60), while the compiled gather returns 28.

### Validate ranges, exact bits, one-hot groups and index reads

The executors check every source cell against its declared range on every evaluation and reject NaN, but accept Infinity in an open range and 0.5 in a cell that should hold an exact bit. So the host should also check finiteness and exact bits, on the table before a frame and on the next-state values before copying them back, e.g. the toggle switch's `validateCells`, or the validator that src/runtime/cells.ts derives from cell declarations. cells.ts took those declarations from [notation](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/notation), whose derived validators cost about 1 µs per frame on IndirectOS. Tests should run `validateOneHotGroups` on evaluated values, `validateIndexReads` wherever the index read instruction is used, and `validateGrids` wherever a grid is declared.

These checks catch the host writing values outside their ranges, state that leaves its range, and ranges that are false in FP32. layout-tree declared a timestep cell's maximum as 0.008, which a `Float32Array` stores as 0.0080000004, so every frame of 32 ms or more threw. A validator that throws can also be the rule that's wrong: photo-gallery.ts's output check rejected a thumbnail's left edge at -6.61 px, but thumbnails legitimately spring in past the left edge.

### Choose traces for what they test

Random traces reach many paths quickly when the trace generator runs its own copy of the plain JavaScript reference, reads the positions of what's on screen from that copy, and places presses on those elements, e.g. a window's title bar, its buttons or its body. input's random trace caught 8 of 10 planted corruptions. Realistic traces help choose which numbers should ship, but don't check whether the circuit is right: user-population's simulated users at a steady 60 fps caught only 2 of the same 10 corruptions, because 72.6% of user-frames carried no event and 4 in 39 million carried two presses. Scripted traces pin named cases, e.g. a press exactly on a track's right edge, or a press and a release within one frame.

Random inputs almost never land in thin bands, so probe those bands directly. The gallery's edge probe, now in [instanced-items](../instanced-items/README.md#merged-from-gallery-september-16-2026), put pointers right next to photo edges at 6 viewports and scroll positions, and found 10 hover and click results that differ from index.ts, all between index.ts's edge and the circuit's edge, within 0.18 px of each other. Exhaustive sweeps work for small inputs, e.g. every quarter-pixel scroll position of a 48-row list, every container width from 0 to 8,192 px, or 1 to 3 FP32 steps on either side of every text threshold.

Count coverage, not checks. In gallery, 83% of 957,258 raw checks were visibility bits, most of them for photos far offscreen, so its README counts how often each decision's reference value changed. [retiming](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/retiming)'s searched delays broke on new traces, because 23 of 49 delayed values never changed in the trace the search replayed.

### Plant corruptions

A mutation check corrupts one live operation at a time and reruns the tests. hn-thread's tests caught 69 of 78 corruptions. The misses were ReLUs whose change a clamp absorbed, and a branch that the 60-comment thread never takes, and an earlier version of the sweep missed a corrupted "already collapsed and clicked" bit because it clicked each banner from only one starting state. This check catches traces that never reach a branch, and tolerances or tie rules that exempt too much.

### Run open loop and closed loop

Open loop copies a reference run's state into the circuit before every frame, so each frame compares one evaluation's arithmetic. Closed loop lets the circuit carry its own state, where small differences grow, e.g. a spring settles one frame late and the shared clock restarts in a different frame. Run both: in [exactness-budget](../codegen/README.md#merged-from-exactness-budget-september-16-2026), reordered and fused sums flipped 1 boolean atom open loop and 5 closed loop across its seven UIs. Copying state can create its own mismatches, e.g. gallery's copied-state run paired the reference's float64 displacement with the circuit's FP32 destination, and produced one mismatch that the circuit didn't cause.

### Replay at several frame rates, and under other executors

Replay the same trace at 10 to 240 fps and with stalls, and compare the runs at the timestamps they share. This replay catches frame-rate dependence, e.g. IndirectOS's former substeps put windows 183 px apart between 30 and 120 fps, where event-time's commits differed in 0 bits, and so did window-manager.ts's timestamped session after its springs moved to `emitAnimatedObject` on September 15, 2026.

When a program will run on another executor, test it there, and also run it under the rewrites a compiler may apply. [exactness-budget](../codegen/README.md#merged-from-exactness-budget-september-16-2026) ran seven UIs with reversed, balanced, fused and float64 sums, and float64 everywhere broke every UI that relies on FP32 rounding. The comparisons examples add a mode that sets subnormal values to 0, which broke the sign cascade on exactly the inputs where Apple's GPU did. codegen found that emitted shaders need differential tests in every mode: an operator precedence bug in the unguarded shaders went undetected while the tests only interpreted guarded ones.

### Check exactness and gradients directly

Two more checks measure what differential tests can't. The comparisons examples recompute every operation's result exactly with BigInt arithmetic and compare it with the FP32 result, which showed that no operation inside a sign cascade rounded on the tested inputs. The indexing and differentiability examples compare the backward pass with central finite differences of a float64 twin, and use one-sided differences at corners, e.g. a ReLU at 0 or an integer bit at its threshold, where a central difference gives neither side's slope.

### Open the page in a browser

Headless tests missed several problems that a Chrome check found ([browser check](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/browser-check.md)). layout-tree's machine threw on every frame of 32 ms or more. streaming-words stepped its springs through up to 1,020 ms of idle time on the first frame after an input. pixel-output's generated code nested `Math.fround` 1,003 deep, and V8 throws a stack overflow error at about 665 levels, while Bun's JavaScriptCore runs the same code. indirect-os-2's switch to generated code stalled an animation with a warmup step of about 500 ms ([codegen](../codegen/README.md#merged-from-indirect-os-2-september-16-2026)). The check ran in a hidden tab with `requestAnimationFrame` replaced by a timer, so it couldn't check real frame pacing or window resizes.

## Running the examples

From the repo root:

- `bun test lab/ui-exploration/guide/examples` runs every example's tests: 217 tests across 33 files in a few seconds, each checking circuits against plain JavaScript, or gradients against finite differences. `bun test lab/ui-exploration/guide/examples/patterns` runs only the pattern docs' 83 tests.
- `bunx tsgo -p lab/ui-exploration/guide/examples/model` typechecks one folder. The other section folders are loops, springs, instancing, indexing, comparisons, chains, executor, differentiability and text, and the pattern folders are patterns/selection, patterns/combining-steps, patterns/every-item, patterns/candidates-and-tables and patterns/fewer-dependencies.
- Every section folder except model has a `report.ts` that prints the numbers its section quotes, e.g. `bun lab/ui-exploration/guide/examples/loops/report.ts`. The pattern folders pin the numbers their docs quote in their tests.
