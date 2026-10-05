# Review answers and decisions

A dated record, moved here from the guide's [README](README.md) on September 15, 2026: Cheng's review points with the guide's answers, and the decisions as they were asked, with what Cheng decided on September 14, 2026. [execution-model.md](../../../docs/execution-model.md) holds the current contracts.

## Answers to your review

### Comparisons

The sign cascade you remembered is in tricks.md, now [expressions.md](../../../docs/expressions.md) ("Decision bits"), and the [trace compiler README](../../trace-compiler/README.md) ("The Sign Cascade"). It multiplies a difference by powers of two and clamps it in stages, and no operation inside it rounds, so its bits equaled JavaScript's `>` on every FP32 input tested. The bits also stayed the same under three rewrites a compiler may apply: evaluating everything in float64, adding every sum's terms in reverse order, and computing every sum in float64 and rounding it once.

With each multiplication inside a ReLU's gate, the cascade costs 16 operations and 15 layers for every pair of FP32 values within 16,384. The 26 layers quoted in earlier write-ups came from the trace compiler's layout, which spends 3 layers per stage.

The recommended default is integer bits on inputs the host quantizes (3 operations, 2 layers), the cascade for values that come out of non-integer arithmetic, and the boolean atom only as an optional last stage that saves 2 layers when the executor keeps FP32 rounding. Cheng chose that default on September 14, 2026, and numeric-ui-core.ts builds it as one helper, `emitCompare(circuit, a, relation, b)`: integer bits when both operands are declared on a grid (2 operations, 2 layers), the cascade otherwise, and the boolean atom only with `{endWithBoolean: true}`. The 1732 px failure came from a rounding stage whose scale was too small, not from rounding as such. More in [comparisons](sections/comparisons.md).

### Indexing and differentiation

A read at a computed index is differentiable with respect to the table's values, like `gather` in ML frameworks, but not with respect to the index, whose derivative is 0 between whole numbers and doesn't exist at them. Through a one-hot a read costs O(n) operations, while the index read instruction, which numeric-ui-core.ts now has as `circuit.indexRead`, costs 1 operation at any table size. Its backward pass throws when a gradient reaches the index, unless the caller passes `{indexGradient: 'zero'}` or `{indexGradient: 'backward-difference'}`.

Two kinds of read give the index a gradient. Linear interpolation blends the two neighboring entries. A softmax read weights every entry by how close its position is to the index: give position j the key `(2j, −j²)` and the index the query `(index, 1)`, and their dot product, `index² − (index − j)²`, is largest at the position nearest the index. That softmax read is soft attention whose keys are positions, and picking the highest score instead (argmax) is hard attention.

In a toy carousel of 8 pages, gradient descent through a soft read learned three weights that compute the query from a flick's release position and velocity. With those weights, an exact argmax circuit picked the same page as plain JavaScript on 10,895 of a grid of 10,976 releases. The toy doesn't show that attention was needed: fitting the query directly with a squared error learned nearly the same weights. And nothing here learned keys, which is what a transformer's attention adds.

More generally, sums, products and selects give useful gradients, while exact decisions give 0 or make the backward pass throw. A spring's matrix power backpropagates through 562 operations for any step count up to 511, against 4,202 operations for up to 300 unrolled steps with a mask per step.

As your note suggested, every quantity that looks dynamic got a static bound with a named fallback, e.g. at most 300 spring steps per frame, past which chenguini and spring-bank carry the rest of the elapsed time into later frames, and host-timing.ts snaps every animated object onto its destination. A fixed bound also fixes the size of the backward pass. More in [indexing](sections/indexing.md) and [differentiability](sections/differentiability.md).

### Wording

Every section was written for someone who hasn't written a circuit: each concept starts from the UI problem and the familiar JavaScript, and each established term is defined at first use and collected in the [glossary](README.md#glossary). The words your review flagged, e.g. "wall", "lane", "box" for springs that settle together, "knob", "fold" as a verb, "hoist", "earn", "win" and "seam", don't appear in the sections, apart from the folder name drag-knobs. Where two sections had used one word for two ideas, the guide keeps one meaning, e.g. a line slot is always the group of outputs reserved for one line of text. The prototype READMEs weren't rewritten, and some still use the old words, e.g. indirect-os-2's README says "Moves fold."

### Photos instancing before and after

Before, [gallery-circuit.ts](../instanced-items/gallery-circuit.ts) appends every photo's operations to one circuit, with each photo's constants as weights: 48,411 live operations and 61 layers at 221 photos. After, instanced-items writes each per-photo stage once, 233 operations per photo at any count, with 31 reductions between stages, e.g. `groupMax` for each row's tallest photo, `prefixSum` for row tops and `firstActive` for the photo under a click. The staged executor took about 65, 310 and 4,106 µs per frame at 221, 1,000 and 10,000 photos, against 546, 2,569 and 43,027 µs for the duplicated circuit, and made 0 decision mismatches against native index.ts, including 2,408,107 checks at 10,000 photos with Brent-Kung prefix sums. The price is that per-item constants stop being free weights: the gallery pays about 33 more operations per photo, and IndirectOS's 20 small items got bigger when staged (6,282 against 5,253 operations). More in [instancing](sections/instancing.md).

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

[Decisions for you](#decisions-for-you) asks which to adopt, and records the ones already adopted, and [How to check a circuit app](README.md#how-to-check-a-circuit-app) collects the checks a shared verification script could run.

### Pretext

None of pretext's `prepare` was translated: normalizing whitespace, segmenting with `Intl.Segmenter`, merging, classifying and `measureText` still run in JavaScript, and only numbers reach the circuit.

`layout` translated two ways. The first is tabulation, where JavaScript finds the widths at which results change, and the circuit compares the runtime width with them in 4 layers whatever the text. The second is the line walker as arithmetic, where a line's end is a count of "fits" bits, which allows a width per line but spends 70 to 89% of text-walker's circuits at 1,023 segments on one-hots.

code-points moved line break classes and a 41 × 41 pair table into index reads, which cut line start mismatches with pretext from 8,806 of 41,820 layouts to 418, and to 215 when CJK runs that don't fit on a line are kept whole.

The likely pretext bug is in `stepRichInlineLine`: the walker called at src/rich-inline.ts:755 lets an item fit within `lineFitEpsilon`, but line 769 ends the line without the epsilon. E.g. "q" at 12px followed by "-w" at 20px lays out as "q-" / "w" at 23.18 px, "q" / "-w" from 23.1825 px, and "q-w" from 23.1875 px. Adding the epsilon at line 769 removed every one-epsilon-wide backward range in scratch copies and kept pretext's 173 tests passing, but nobody has compared these flows with browsers. More in [text](sections/text.md).

### The talk prototypes

The [talk](sections/talk.md) section explains eleven prototypes: nine that came out of reading the talk against earlier prototypes, and two that ran at the same time, indirect-os-2 as a consolidation check and instanced-items, which carries out one of the notes' ideas. Each gets the idea from the talk in one sentence, the UI problem in front-end terms, what was built, a few numbers with conditions, how cost grows, what to try in its demo with the real control labels, and its main limitation.

The results that carry over to writing apps:

- One program per item, with computations across items between its stages, e.g. instanced-items' gallery is 233 operations per photo, with row maxima, row tops and the clicked photo computed between the per-photo stages.
- Committing state only at event timestamps, while frames evaluate a copy of the table without writing it back, e.g. event-time's committed tables were identical in every bit at 10 to 240 fps.
- Design and behavior numbers in cells instead of constants, e.g. drag-knobs moved card padding, the grid gap and three more design numbers into cells for 60 operations, so a designer's drag can change them.
- A fixed capacity plus a count of how many entries are real, e.g. streaming-words builds for 95 segments and writes `arrivedCount`, and whole-text outputs like the line count read that count.
- Layout and hit tests against destinations instead of drawn positions, e.g. [indirect-os-2](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2)'s Notes paragraph flows around the other windows' destinations, which kept 60 and 120 fps within 2.4e-4 px.

learned-bits' learned rules, [retiming](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/retiming)'s searched delays, pixel-output's per-pixel programs and [exactness-budget](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/exactness-budget)'s relaxed order of additions are research directions, not building blocks.

### Springs and time

IndirectOS's frame-rate dependence is a choice in IndirectOS's code, not a limit: window-manager.ts runs 4 substeps per frame, each a quarter of min(frame duration, 32 ms), so the step length follows the frame rate and frames longer than 32 ms lose time. Since September 15, 2026, window-manager.ts steps springs with `emitAnimatedObject` and `advanceFrame` instead.

What the approach does force is a maximum step count fixed while building, with the count arriving as data: masks over up to 300 unrolled steps (902 layers), the count's binary digits choosing powers of the step matrix (27 to 40 layers), or a frame matrix that JavaScript computes and writes into 4 cells (14 operations and 3 layers for one spring).

ui.md's frame order, which applies new destinations and then catches up, is frame-rate dependent too when a destination changes between frames, and index.ts follows that order: a float64 copy of its loop differed by up to 112 px between 30 and 120 fps. Stepping to each event's timestamp before applying the event, with a settle check after every step, made 10, 30 and 60 fps match 120 fps exactly.

Cheng made that order the default on September 14, 2026. host-timing.ts's `advanceFrame` steps springs to each event's timestamp before the event applies, and checks settling at fixed simulated times, every 64 ms from when the clock started. When state is written back only at events and settle checks, every stored table was identical in every bit at 10, 30, 60 and 120 fps and through 500 ms stalls ([spring-matrix.test.ts](../../../tests/runtime/spring-matrix.test.ts)). More in [springs](sections/springs.md).

### Composability

Builder code composes like ordinary functions, because builder code is ordinary JavaScript: the springs section builds a step, a catch-up that calls the step, and a per-frame app that calls the catch-up for two springs sharing one clock, and the app matched a float64 copy of index.ts's `render()` in every step count and settle decision over 15,000 random frames. [notation](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/notation)'s components, i.e. cell declarations plus a build function that reads the parent's wires, compiled IndirectOS to the identical program.

What doesn't compose at runtime: loop counts and recursion that depend on data; early exits; state kept between frames, which needs a cell that the caller allocates before building; and springs coupled through one shared clock. E.g. in indirect-os-2, text obstacles read from last frame's stacking made Notes' words start moving one rendered frame later, the shared clock restarted in different frames at 60 and 120 fps, and windows ended up 28.8 px apart between the two rates.

Build order also leaks into results, e.g. a range declared after the window springs exist cost IndirectOS 320 operations, and moving a statement changes the order in which ordinary sums add their terms. More in [springs](sections/springs.md#what-composes-at-build-time).

### Decisions

The ten section reports carried 36 decisions. [Decisions for you](#decisions-for-you) merges them into eight questions, most important first, where each question's follow-up decisions only matter once the question itself is settled, and it lists the decisions that can wait. Cheng decided the first three on September 14, 2026.

### The demo directory

Run `bun lab/ui-exploration/serve-demos.ts` from the repo root to serve every demo from one server, with [demos.html](../demos.html) as its index page at http://127.0.0.1:4321/. The script was still being built when this answer was written, and notes/browser-check.md's [Demo directory check, 2026-09-14](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/browser-check.md#demo-directory-check-2026-09-14) later opened all 37 page links through it. The [talk](sections/talk.md#running-the-demos) section says what to try in each talk-inspired demo, with the real control labels, and [notes/browser-check.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/browser-check.md) records what a Chrome check of each demo found, and what that check couldn't measure because its tab was hidden.

## Decisions for you

The ten section reports carried 36 decisions. The questions below merge them, most important first. Under each question, the follow-up decisions only matter once the question itself is settled. The decisions that can wait are listed at the end.

Cheng decided questions 1 to 3 on September 14, 2026, choosing the recommended option each time. Each of those questions starts with what the repo root now has and what's still open, followed by the options, recommendation and reasons as they were when the question was asked.

### 1. Should the shared runtime get an index read instruction?

**Decided on September 14, 2026: add the instruction.** numeric-ui-core.ts now has `circuit.indexRead` and `circuit.indexReadAffine`, and gather lowering stays for selections that already exist as declared one-hots. Two of the follow-up decisions below are done: the backward pass throws when a gradient reaches the index unless the caller passes an option, and `compileTensorProgram` can recompute depths after gather lowering, with an option that is off by default. Existing programs compile to the same programs with the same values, e.g. IndirectOS and the candidate gallery. execution-model.md defines [the instruction](../../../docs/execution-model.md#index-reads) and [the option](../../../docs/execution-model.md#compilation), [index-read.test.ts](../../../tests/runtime/index-read.test.ts) tests the instruction, and the [indexing](sections/indexing.md#way-3-the-index-read-instruction) section explains it.

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

**Decided on September 14, 2026: one helper that chooses from declarations.** Building blocks use `emitCompare(circuit, a, relation, b, {endWithBoolean})` from numeric-ui-core.ts, for `>`, `>=`, `<`, `<=` and `===`: integer bits when both operands are declared on a grid, a sign cascade otherwise, and a boolean atom at the end only with `{endWithBoolean: true}`. `emitMinimumExact`, `emitMaximumExact` and `emitClampExact` select exactly one operand with an `emitCompare` bit. Two of the follow-up decisions below are done: the builder records rounding points for boolean atoms, `emitCompare`'s operations and marked operations, and execution-model.md states the guarantee on the CPU and on GPU backends. Converting IndirectOS's hit tests was measured in a scratch copy, and window-manager.ts wasn't changed until September 15, 2026, as the still-open list below says. execution-model.md defines [the helper](../../../docs/execution-model.md#comparisons), with its costs and that measurement, [grids](../../../docs/execution-model.md#grids) and [rounding points](../../../docs/execution-model.md#rounding-points), [comparison.test.ts](../../../tests/runtime/comparison.test.ts) tests the helper, and the [comparisons](sections/comparisons.md#which-form-to-use-by-default) section explains each form.

**Settled later on September 14, 2026.**

- Changed: the `'comparison'` rounding point kind is split in two. `'integer bit'` marks the operations of integer bits on grids, where a backend may add an operation's terms in any order, fuse them or evaluate them in float64, as long as each operation stays its own operation. `'sign cascade'` marks the operations of a sign cascade, where a backend may evaluate an operation's own sum in any order or in float64, but has to keep each operation separate and reading the same wires, and keep subnormal values.
- Changed: `emitFirstActive` counts the bit `emitCompare` returns as a proven bit, so it declares a one-hot group over a selection among comparison bits. An operation inside `emitCompare`, e.g. a sign cascade stage within 0..1, doesn't count.
- Kept: the integer bit stays `relu(1 − relu(−D))`, and grid operands that span too many grid steps for integer bits get the sign cascade, without an error or a warning.

**Still open.**

- Whether to convert IndirectOS's hit tests, given the measured 17 more layers. Decided and done on September 15, 2026: with pointer coordinates and window geometry declared on a 1/64 px grid, its 24 window rectangles use integer bits, and IndirectOS went from 3,782 to 3,654 operations and from 128 to 124 layers, with the same decisions on every press tested. The 4 dock items keep the older form ([execution-model.md](../../../docs/execution-model.md#comparisons)).
- Whether `emitCompare` should also accept a number as a threshold and pick its FP32 value itself, e.g. the smallest FP32 value at or above 5/24 for `>=`. For now a threshold is a constant wire, e.g. `circuit.affine([], 3)`, and the caller picks the FP32 value.
- The records cover atoms, `emitCompare` and marked operations, e.g. 64 rounding points in IndirectOS on September 14, 2026, where exactness-budget's patterns found 256, and 200 since its hit tests and springs changed on September 15. The ReLUs and drifting minimums that feed today's atoms aren't recorded.

**Options.** One comparison helper in numeric-ui-core.ts that picks the form from declared ranges and a declared grid or resolution per wire; separate helpers that authors pick per call; or one rounding stage as the default, as most prototypes did.

**Recommendation.** The one helper. It throws on open ranges, uses integer bits when both operands are declared on a grid, uses the sign cascade planned for every FP32 value otherwise, and ends with a boolean atom only with `{endWithBoolean: true}`.

**Follow-up decisions.**

- Have the builder record rounding points, i.e. boolean atoms, round and floor chains, and the differences that feed comparisons, so a backend or a notation may reorder and fuse every other sum.
- Convert IndirectOS's 64 boolean atoms to integer bits on quantized inputs and cascades on the rest, and measure the change from 192 layers before making the helper the default there.
- Promise exact bits down to differences of 2^-149 on the CPU, and state 2^-126 as the guarantee on GPU backends, since Apple's GPU set subnormal values to 0.

**Why.** The forms fail differently below their resolution: the cascade returns fractions, a rounding stage silently returns wrong bits, and the atom depends on how the executor rounds, so the choice belongs in a declaration that tests can check. Integer bits cost 3 operations and 2 layers and gave the right bit under every executor mode tested, and the cascade gave JavaScript's bits on every FP32 input tested in 16 operations and 15 layers. Wrapping only rounding points in the max guard took IndirectOS's press map, a GPU program that computes which window would receive a press at each pixel, from 537 guards to 84, with 0 decision mismatches. But exactness-budget found rounding points by matching patterns in compiled operations, and those patterns missed life-calendar's clamps.

### 3. How should time enter the program, and which spring should be the default?

**Decided on September 14, 2026: JavaScript writes durations, event times and the spring matrix.** The repo root now has host-timing.ts, the float64 host code, with `quantizeFrameTiming`, `springMatrixPower`, `springMatrixBound` and `advanceFrame`, and numeric-ui-core.ts's `emitApplySpringMatrix` and `emitAnimatedObject`. One of the follow-up decisions below is done: with `writeBack` set to `'events and settle checks'`, `advanceFrame` writes state back only at events, settle checks and snaps, and a frame evaluates a copy of the table. Since September 15, 2026, IndirectOS uses them. execution-model.md defines [them](../../../docs/execution-model.md#springs-and-time), with the measurements over [spring-matrix.test.ts](../../../tests/runtime/spring-matrix.test.ts)'s traces, and the [springs](sections/springs.md#4-javascript-writes-the-frame-matrix) section explains the forms they come from.

**Settled later on September 14, 2026.**

- Changed: `emitAnimatedObject` stores each spring's displacement from its destination instead of its position, and rebases the displacement onto a new destination once per retarget. In spring-matrix.test.ts's traces, writing back every evaluation went from 7.3e-4 px to 1.4e-4 px of float64, and the runs that settled differently from float64 went from 2 of 48 to 0. Moved to 65,536 and 131,072 px, every run settled like float64, where with stored positions 42 to 48 of 48 runs settled differently.
- Changed: an object whose springs are all exactly at rest, e.g. right after a snap, has an `active` bit of 0 at any evaluation, instead of keeping it at 1 until the next settle check.
- Changed: when a frame would need more than 300 steps, `advanceFrame` plans a `'snap'` evaluation that lands every animated object on its destination and stops the clock, instead of carrying the backlog into later frames. `maxCarriedMs` is gone, and `quantizeFrameTiming` clamps durations and event times at 1,200 ms.
- Documented: inputs that change destinations, e.g. a viewport resize, should reach `advanceFrame` as timestamped events when stored state must be frame-rate independent.
- Kept: `emitApplySpringMatrix` uses `circuit.multiply` (14 operations and 3 layers, with the right gradient at a matrix entry of exactly 0) rather than [spring-bank](../event-time/README.md#merged-from-spring-bank-september-16-2026)'s signed products (10 operations and 2 layers), a settle check costs one extra evaluation, an event with a timestamp before the last evaluation that wrote state back applies at that evaluation's time, and settle thresholds are numbers fixed while building.

**Still open.**

- The first follow-up below: ui.md, Animation.md and index.ts still apply events first and then catch up.
- event-time's predicted keyframes and the closed-form matrix exp(A × elapsed time) aren't built.
- Converting demos to these APIs. Decided and done on September 15, 2026 for IndirectOS: its windows and Photos' thumbnails moved from `emitSpring`'s 4 substeps to `emitAnimatedObject` with `advanceFrame` and `'events and settle checks'` ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)). Other demos still use older springs.

**Options.** For the clock: absolute requestAnimationFrame timestamps in cells, subtracted inside the program, as window-manager.ts did until September 15, 2026; or the frame's duration and event times relative to the frame, computed in JavaScript. For springs: `emitSpring`'s 4 substeps of the frame duration; spring-bank's power tables inside the program; JavaScript writing the step count's 9 binary digits; or JavaScript writing the frame matrix.

**Recommendation.** JavaScript writes the frame's duration and event times relative to the frame on a 1/64 ms grid, and a duration of 0 for the first frame after idle. The default spring is a frame matrix that JavaScript writes, 4 cells per stiffness and damping pair, with one settle bit per animated object.

**Follow-up decisions.**

- Change ui.md, Animation.md and index.ts to step springs to each event's timestamp before applying the event, and to check settling at fixed simulated times, e.g. every 16 steps, instead of once per frame.
- Where stored state must be bit-identical across frame rates, commit state only at event timestamps, and let frames evaluate a copy of the table without writing it back.
- Keep event-time's predicted keyframes optional, i.e. Web Animations keyframes built from the screen at 301 moments 4 ms apart after each commit, so the browser keeps playing transforms while JavaScript blocks, until a visible Chrome tab shows transforms playing through a stall.
- Later, prototype the closed-form matrix exp(A × elapsed time) as the matrix JavaScript writes, which would match Animation.md's closed-form spring.

**Why.** A `Float32Array` stores absolute timestamps on a 0.5 ms grid from about 70 minutes after page load, so a 16.6 ms frame then measures 16.5 ms. The frame matrix costs 14 operations and 3 layers per spring, doesn't depend on the frame rate, keeps stiffness and damping editable, and gave spring-bank's smallest copy of IndirectOS (3,413 operations). In float64, stepping to event timestamps removed the 112 px difference between 30 and 120 fps without changing the architecture, but a settle check once per frame still left 15.8 px at 10 fps.

### 4. What should agents build apps from?

**Options.** Raw numeric-ui-core.ts calls with hand-kept offsets, or [notation](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/notation)'s declarations (cells with range, policy and initial value, and `table.next`); buttons that act on press, or on release; several presses per evaluation, or one press per evaluation with JavaScript splitting the frame; each app's own validator, or one shared host check.

**Recommendation.** notation's declarations for app code, and raw calls only in the model section, where every operation should stay visible. Buttons act on release, like native buttons. When the table keeps one latch per event kind, a button needs one extra state bit, `armed`, as in the toggle switch example. When the table holds an event queue, a button is the chains section's 3-state machine (idle, armed, and pressed with the pointer outside), which arms again when the pointer moves back inside before the release. indirect-os-2's buttons use a stricter rule: a press that moves more than 4 px from the press point turns into a drag, so moving back onto the button before the release doesn't click. One press per evaluation, with JavaScript splitting the rare frame that has more.

**Follow-up decisions.**

- Make notation's derived validators the shared host check, run on the cells JavaScript writes and on next-state values before they're copied back, with full-table validation kept in tests.
- Add a helper that counts monotone bits and declares their neighbor-difference one-hot, with a test-time check that the bits are sorted.
- Make a prefix sum's accumulation order a required argument: a chain or wide sums when a sequential JavaScript reference must match bit for bit, and Brent-Kung for totals that can pass about a million px.
- Use tabulated text by default, and the line walker only when lines need their own widths or words change width at runtime.

**Why.** notation compiled IndirectOS to the identical program, with hand-kept bookkeeping down from 641 lines to 110. Counted by characters on September 15, 2026 ([notation at the tag](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/notation)), behavior code shrank 1.71 times, bookkeeping 4.4 times and validation 12.7 times, while host JavaScript shrank only 1.42 times, since the DOM work stays. Bookkeeping plus validation fell from 38% of the lines to 18%, and the shared library added 402 lines, written once for any app. The toggle switch's release form costs one state bit and one more hit test (22 operations), and matched plain JavaScript on all 280 frames. Each more press per evaluation costs about 427 operations and 17 layers in input's window circuit, and about 2,200 operations and 40 layers in indirect-os-2's whole program, whether or not a press arrives. The executor's range check accepts Infinity in open ranges and 0.5 in cells that should hold exact bits, unsorted bits from a negative row height gave wrong counts with no error, and one-at-a-time prefix sums flipped 74 decisions at 10,000 photos where Brent-Kung sums flipped none. Tabulated text is 4 layers deep, while the walker's Notes flow added 11,795 operations and 174 layers to IndirectOS.

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

**Options.** todo.md's retrieval of an item's rectangle by id, while storage positions, active counts and distractors vary (todo.md, since removed; see [lab/status.md](../../status.md#parked-and-deferred)); extending indexing's carousel toy to uneven snap targets with runtime keys; or pausing learning experiments until the index read instruction lands. numeric-ui-core.ts has had the instruction since September 14, 2026 ([decision 1](#1-should-the-shared-runtime-get-an-index-read-instruction)), so the condition in the third option is already met.

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
