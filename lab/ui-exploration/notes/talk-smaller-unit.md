# A smaller unit of composition

Status, September 15, 2026: four of this note's six ideas were built as prototypes after it was written: [streaming-words](../streaming-words/README.md) (idea 1), [event-time](../event-time/README.md) (3), [learned-bits](../learned-bits/README.md) (4) and [instanced-items](../instanced-items/README.md) (5). The per-pixel owner map (2) and field morphs (6) weren't built. [guide/sections/talk.md](../guide/sections/talk.md) explains each prototype.

This note reads Cheng's talk "Repeatable breakthrough" through its first step, taking a smaller unit of composition, and asks what the UI analog of triangles, pixels, subword tokens and individual bits is for Indirect. It is grounded in the thirteen phase 2 prototypes in this folder and in three short scratch experiments. It ends with six prototype ideas and a list of assumptions that look like premature compression.

The scratch scripts are session scratch files (scratch folder `phase3-ideas/smaller-unit/`, not in the repo): `streaming.ts`, `gates.ts` and `tab-baseline.ts`. Each one imports the repo's files unchanged.

## How this lens reads tonight's results

The runtime's unit is already small: a wire, computed by one of three atoms. But almost every prototype tonight still composed UI from larger units, and the largest costs came from mapping those units onto wires:

- A widget with a fixed number of slots. hn-thread's 48 rank slots cost 25,616 live operations, nearly as much as the other 28,340 operations of the whole thread UI, because every comment needs a one-hot member for every slot.
- A paragraph walked one line at a time. At 1,023 segments, integer one-hots are 89% of text-walker's gathered-lines circuit, and the walk adds about 8.75 layers per line.
- A text field with a capacity. One key at capacity 256 is 54,431 live operations, about 210 per cell, repeated for every queued key.
- An item written out once per item. The gallery's 221 photos are 48,411 live operations, and generated JS became slower than the executor at that size.
- The frame as the moment state changes. When presses fall between frames, spring-bank measured up to 514 px of difference between 10 fps and 120 fps, and 696 px after a 500 ms stall. Only evaluating the circuit once per event removed the difference.

The approach was cleanest where the unit was already small and repeated:

- A spring lane is 4 products against one shared frame matrix. That took IndirectOS from 5,253 to 3,580 live operations.
- codegen's per-pixel map of which IndirectOS window receives a press is 458 per-instance rows. It ran over a million pixels in about 2 ms on the GPU through Dawn, bit for bit equal to the CPU.
- A life-calendar cell is 63 per-instance rows.
- A queued pointer move folds at 46 operations per slot and adds no layers.
- The first segment that overflows a line is a count of comparison bits, not a search.

The talk's second step, the granularity gap, shows up for an author as widgets that stop being things you write. A chat bubble becomes a reduction over words, e.g. the widest line among one speaker's words. A window's hit region becomes the set of pixels whose owner code is that window. A frame becomes a sample of state that was committed at event times. A menu's behavior becomes a netlist of bits that can be read gate by gate, or learned.

The third step, emergent behavior directed through homogeneity, has concrete candidates:

- With the word as the unit, reflow becomes motion, and stopping a streamed reply is one cell write. One spring group and a stagger by word index direct all of it.
- With the pixel as the unit of hit testing, a hit region of any shape adds nothing to the scalar circuit. A few shared values, such as a corner radius, direct it.
- With the event as the unit of time, frame-rate independence becomes bit-exact by construction, instead of within 0.005 px.
- With the photo as an instance, the photo count becomes a buffer length.

One scratch measurement tempers the "individual bits as learned logic gates" reading. A differentiable logic gate network with 2-input gates learned Tab and Shift+Tab over 2 controls exactly in under a second, but reached at most 53 of 64 cases for 3 controls, and 458 of 896 for 6 controls after 106 seconds. The hand-written counting construction in input/ handles 6 controls exactly in 127 live operations. Every exact decision tonight was a count followed by a threshold, e.g. `relu(count - t + 1) - relu(count - t)` for an integer count. So in this runtime, the smallest unit of behavior that still composes well may be the counting bit rather than the 2-input gate.

The talk warns against compressing concepts too early. IndirectOS's own vocabulary is the obvious place to look: the frame, the element, the window and the message bubble are compressions that the atoms don't require.

## Units: what emerges, and what the gap looks like for an author

### The word, or a chunk of a word, as the unit of text

- Today: text-tabulated treats a paragraph as one step function of width, so an edit means re-tabulating and rebuilding (about 3 ms per keystroke for the Notes window). text-walker's fast walker already reads a width cell and a break-after bit per segment, outputs each segment's line index and x, and adds a spring per word for 25 operations.
- What emerges as the count goes up: streamed text whose reflow is motion, interruption at any word, and a conversation laid out as one flow of words with a speaker bit per word, where bubbles are reductions.
- The gap for an author: there is no bubble component and no "append message" call. You write constants per word (arrival, speaker, spring group) and read reductions.
- What a prototype measures: exactness of arrived words at every arrival state, how often an already visible word changes line, and cost per word.

### The pixel as the unit of hit testing and output

- Today: IndirectOS's deepest path spends 12 layers on hit tests, 11 on frontmost selection and 3 on press routing (notes/indirect-os.md, section 1.15). Its 24 rectangle hits cost 408 live operations. codegen's `window-ownership.ts` computes the same decision for every pixel.
- What emerges: hit regions of any shape, e.g. rounded corners, button outsets that split the gap between neighbors, or a smooth union between dock items, at no cost to the scalar circuit. Routing no longer grows with the window count, and drawing and hit testing can come from one per-pixel program.
- The gap: a window is no longer an object with handlers, only an owner code in a field. Hit precision becomes pixel-center precision.
- What a prototype measures: layers and operations removed from the scalar circuit, routing decisions compared with today's circuit, and the cost of updating the map.

### The event as the unit of time

- Today: IndirectOS writes state back once per frame. input/ folds a frame's queue into one evaluation. spring-bank's event-time evaluations brought 10 fps and 120 fps within 0.0051 px of each other.
- What emerges: committed state that is identical at every display rate, no evaluations while idle, and UI state that is a pure fold over timestamped events, so replay and scrubbing are just evaluations.
- The gap: rendering and committing separate. A display frame computes what is on screen at its timestamp but never writes state.
- What a prototype measures: bit equality of committed tables across display rates, cost per event, and which outputs only make sense on display evaluations.

### The bit as the unit of behavior

- Today: input/ built menus and keyboard focus entirely from bits over one-hots. lab/event-window learned six shared behavior parameters, and lab/cascade-argmax recovered 160 of 160 table selections through softened comparisons before exact hardening (lab/status.md).
- What emerges: behaviors as netlists that can be edited one unit at a time, learned from traces, and checked on every case when the input space is small.
- The gap: there are no if-statements, only a wiring diagram.
- What a prototype measures: exact cases after hardening, generalization to held-out cases, and compiled size against the hand-written circuit.

### The item program as an instance

- Today: tricks.md's instancing (now in [patterns.md](../../../patterns.md#a-loop-over-items-that-mixes-per-item-work-with-values-carried-to-the-next-item)), and codegen's instance axis, which splits a compiled circuit into shared rows and per-instance rows automatically. The gallery and hn-thread still write per-item code out once per item.
- What emerges: the item count becomes a buffer length, the per-item program has a fixed size, and work across items is confined to a few reduction passes.
- The gap: items can't read each other inside the instance program. Decisions across items, e.g. a row's tallest photo, prefix sums, the first photo under a click, or the scroll anchor, become reductions between instance passes, like separate passes in a GPU renderer.
- What a prototype measures: per-instance rows, bit equality with the flat circuit, the number of reduction passes, and time at 10,000 to 100,000 items.

## Scratch measurements for this note

### Streaming words through gathered lines (`streaming.ts`)

The paragraph is `makeParagraph(48, 7)` from text-walker: 48 words, 95 segments. The circuit is text-walker's `buildGatheredLines` with per-segment geometry, built once for all 95 segments at 240 px, with a window of 20 segments and 16 line slots. A word that hasn't arrived is a segment with width 0. Every state is compared with pretext's `walkLineRanges` on the prefix text, through text-walker's `expectedFastLayout`, with the fake canvas.

| Measurement | Result |
| --- | --- |
| Circuit | 10,167 live operations, 160 layers, 23,591 stored weights, 976 gather reads, 92,720 gather table entries, built in 196 ms |
| One evaluation, executor | 70 to 137 µs |
| Whole words arriving, 48 states, absent segments with width 0 and break-after 0 | 0 line index mismatches and 0 x mismatches on arrived segments. `lineCount` wrong in 43 states, `windowOverflow` nonzero in 43 states |
| The same, absent segments with break-after 1 | 0 mismatches on arrived segments. `runOverflow` nonzero in 47 states, `lineCount` wrong in 37 |
| 3-character chunks, 88 states | 0 mismatches on arrived segments. 2 hops, i.e. an arrived segment moving to another line, and both hops were the growing word |
| Whole words arriving | 0 hops |

A zero-width segment always fits, so the last line absorbs every absent segment, the window runs out, and the walker counts extra empty lines. The arrived words' positions don't depend on those extra lines. Reading the line count at the arrived count, e.g. the line index of the last arrived segment plus 1, would fix the global output. Greedy wrapping never changes earlier lines when whole words are appended, so in streaming, the only reflow of visible words comes from chunks that widen a word past the line's end.

### Learned 2-input gates for Tab (`gates.ts`, `tab-baseline.ts`)

The network follows Petersen et al., "Deep Differentiable Logic Gate Networks" (2022). Every gate reads 2 wires, chosen at random from the inputs and the previous layer, and learns a softmax over the 16 two-input functions, each written as `c0 + c1 a + c2 b + c3 ab`. Each output bit is the majority vote of a group of 4 or 8 gates in the last layer. Training is Adam over every case at once. Hardening keeps each gate's most likely function. The hardened netlist compiles into `numeric-ui-core.ts` as one product and one affine per gate, plus an exact count bit per majority vote, and the compiled circuit matched the hardened JS netlist on every case of every run. A finite-difference check of the logit gradients gave a worst relative error of 2.6e-5 over 192 logits, so the trainer's gradients are right.

The task is input/keyboard.ts's `cyclicNextEnabled` for Tab and Shift+Tab. The inputs are a focus bit per control (all zero means nothing is focused), an enabled bit per control, and Shift. The outputs are the next focus bits. Every case is enumerated: 24 cases for 2 controls, 64 for 3, 160 for 4 and 896 for 6.

| Controls | Gates per layer | Epochs | Exact cases after hardening | Training seconds | Compiled live operations / layers |
| --- | --- | ---: | --- | ---: | --- |
| 2 | 16, 16, 8 | 2,000 | 20, 22 and 23 of 24 (3 seeds) | 0.1 | 40 to 48 / 8 |
| 2 | 64, 64, 64, 8 | 6,000 | 22, 24 and 24 of 24 | 0.4 to 0.5 | 84 to 102 / 10 |
| 3 | 32, 32, 32, 12 | 3,000 | 42 and 46 of 64 | 0.2 to 0.3 | 91 to 102 / 10 |
| 3 | 128, 128, 128, 12 | 6,000 | 53 and 51 of 64 | 1.1 to 1.6 | 169 to 172 / 10 |
| 4 | 32, 32, 32, 16 | 3,000 | 86 and 86 of 160 | 3.3 to 4.2 | 113 to 117 / 10 |
| 6 | 48, 48, 48, 6, no vote groups, initial logit +2 on "pass input a" | 1,500 | 214 and 205 of 896 | 8 | 46 to 56 / 7 to 8 |
| 6 | 64, 64, 64, 64, 48 | 3,000 | 376 of 896 | 61 | 321 / 12 |
| 6 | 128, 128, 128, 128, 48, initial logit +2 on "pass input a" | 3,000 | 458 of 896 | 106 | 379 / 12 |
| 6 | hand-written `cyclicNextAvailable` in both directions, plus a select on Shift | - | 896 of 896 | - | 127 / 7, 515 stored weights |

Tab needs "the first enabled control after the focused one, wrapping around", which is a wide AND over the controls in between. A randomly wired 2-input gate rarely sees the right pair of wires. The hand-written form counts instead: control k is chosen when it's enabled, comes after the focus, and the count of enabled controls between them is 0. I tried one optimizer setting per size and no temperature schedule, so these numbers bound what a quick attempt reaches, not what gate networks can do.

## Ideas

### 1. Streaming words: every word springs, and a bubble is a reduction

Size: one to two hours.

Talk connection: "half a bubble", a unit smaller than a chat bubble where every word is interruptible, and subword tokens.

What it tests: can a text flow whose unit is the arriving word, or a chunk of a word, run in one fixed circuit with a spring per word, where a bubble is only a reduction over words and stopping a reply is one cell write?

Build plan:

- Inputs: `makeParagraph` texts of 48 and 96 words, a second speaker's text interleaved as a conversation, and chunks of 1 and 3 characters. JS prepares each prefix with pretext, headless with text-walker's fake canvas, and writes one width cell per changed segment.
- Circuit: the gathered-lines build from text-walker/fast-walker.ts at a capacity of 191 segments, with per-segment geometry. Add an `arrivedCount` cell, and compute the line count as 1 plus the line index of segment `arrivedCount - 1`, read with `integerOneHot` and a masked read from text-walker/kit.ts, or with index-read's `indexRead`. Mask `windowOverflow` at or after the arrived count. Add one spring per segment with `emitStepMatrix` and `emitWordSpring` from text-walker/word-springs.ts, targeting the segment's x and y. An arriving word starts from the previous word's position: the circuit selects that spawn position with the bit `[segment index >= previous arrivedCount]`.
- Speakers: a speaker bit per segment. Force a break where the speaker changes by adding a large constant to prefix sums after the change, as text-editing does after a newline, or indent the second speaker's lines with `perLineWidths: true`. Each speaker run's bubble rectangle is a maximum tournament over its segments' right edges, masked by the run's bits.
- Interruption: pressing Stop writes `arrivedCount` back to the count at the press's timestamp, and later words fade out with an opacity spring.
- References: pretext's `walkLineRanges` on each prefix, as in `streaming.ts`, and text-walker's float64 `iterateSpring`.

Builds on: lab/ui-exploration/text-walker (fast-walker.ts, word-springs.ts, kit.ts, fake-canvas.ts, fast-check.ts), lab/ui-exploration/index-read, lab/ui-exploration/text-editing (the newline offset), lab/ui-exploration/codegen (generated JS), and the scratch `streaming.ts`.

Expected evidence: mismatches on arrived segments at every arrival state (the scratch found 0 in 136 states), line count correct at every state after the fix, hops per 1,000 chunks for 1-character and 3-character chunks (the scratch found 2 in 88 states of 3-character chunks), live operations and layers at 95 and 191 segments with springs (the scratch circuit is 10,167 operations without springs, and text-walker measured 208 shared operations plus 25 per spring), µs per evaluation for the executor and generated JS, and frames to settle after an interruption.

### 2. Route presses by reading a per-pixel owner map

Size: one to two hours.

Talk connection: pixels and shaders, "one supercomputer behind every pixel", and the DOM as a peripheral.

What it tests: how much of IndirectOS's scalar circuit is "what is under the pointer", and does replacing that part with one read of a per-pixel owner map keep every routing decision? What hit regions become free once hit testing is a per-pixel function?

Build plan:

- Per-pixel circuit: codegen/window-ownership.ts already outputs, for every pixel, an owner code (desktop, window, dock item) and a region code (content, title bar, close, maximize, minimize, resize grip) from IndirectOS's source cells, with 0 mismatches against a float64 stack walk over 1,024,000 pixels in four states. Run it through `planInstances` with the generated instance loop on the CPU, and through `emitInstanceWgsl` with the max guard on Dawn.
- Scalar circuit: a copy of notation/indirect-os.ts where `windowHit`, `closeHit`, `maximizeHit`, `minimizeHit`, `dragHit`, `resizeHit`, `pressedWindow` (lines 112 to 126) and each dock item's `hit` come from two source cells, `ownerAtPress` and `regionAtPress`, decoded into one-hots with input/kit.ts's `atLeast`. JS reads `map[y * width + x]` at the press's pixel.
- Timing: the map is computed from the source table before this frame's evaluation, which is the same geometry today's hit tests read.
- Variants that only change the per-pixel circuit: rounded window corners with sdf-shapes.ts's rounded box distance, forgiving button outsets, and a smooth union between dock items.
- References: the original IndirectOS, run side by side with notation's trace runner, comparing every output bit by bit.

Builds on: lab/ui-exploration/codegen (window-ownership.ts, instance.ts, wgsl.ts, gpu-runner.ts, gpu-headless.ts, sdf-shapes.ts, indirect-os-machine.ts), lab/ui-exploration/notation (indirect-os.ts, traces.ts, compare.ts), lab/ui-exploration/input/kit.ts.

Expected evidence: live operations and layers of the scalar circuit before and after (today 5,253 operations and 192 layers, of which 26 layers on the deepest path are hit tests, frontmost selection and press routing), frames where focus, stacking, drag or resize owners differ over codegen's 240-frame session and notation's random traces (whole-pixel pointers should give 0; fractional pointers give a count of pixel-center differences), map update time at 1280×800 on the CPU (codegen measured 184 ms) and on Dawn (about 2 ms), the same time with the update limited to the rectangles of windows that moved, and how many pixels change owner with rounded corners.

### 3. Commit per event, sample per frame

Size: one to two hours.

Talk connection: a smaller unit of time, and interruptibility at every chunk.

What it tests: if state is only written back at event timestamps, and display frames are evaluations that never write back, is IndirectOS's committed state bit for bit identical at every display rate and after stalls, and what does it cost per event?

Build plan:

- Inputs: spring-bank's `createIndirectOSTrace`, with and without `liveResize`, shifted by `offsetPresses` with `randomPressOffsets` seeds 7 and 99. Frame times from `scheduleFrameTimes` at 10, 30, 60, 120 and 240 fps, with 500 ms and 2 s stalls.
- Circuit: spring-bank's IndirectOS copy with `springs: 'split-table'` and `retarget: 'deferred'`, unchanged.
- Replay change: a commit evaluation at each event timestamp writes the next-source cells back. Events with the same timestamp share one commit. A display evaluation at each frame timestamp runs from the last committed table with the time since that commit, and discards its next-source outputs. Because a display evaluation is capped at 300 steps (1.2 s), JS also commits at fixed simulated times after the last event, e.g. the last event plus 1,200 ms, so settled springs get committed without depending on frames.
- References: the committed tables of the 240 fps run.

Builds on: lab/ui-exploration/spring-bank (window-manager.ts, trace.ts, spring-bank.ts, bank-check.ts), lab/ui-exploration/codegen (codegen.ts for generated JS), lab/ui-exploration/input (input.ts for the legal pointer stream).

Expected evidence: committed source tables compared bit for bit at every commit across all rates and stalls (expected identical by construction, where the best result today is 0.0051 px between rates), displayed positions at shared timestamps, µs per commit in generated JS with coalesced pointer moves at 120 Hz, commits per second while idle (expected 0 after the last settle commit), and the list of outputs that only make sense on display evaluations, e.g. `animationActive`.

### 4. Learned behavior bits with counting units

Size: one to two hours.

Talk connection: individual bits wired to each other and learned, "what if logic gates have learned backprops?"

What it tests: which UI behaviors can be learned exactly at the level of bits, and does a learning unit that matches the runtime's own exact decision, a count followed by a threshold, close the gap that 2-input gates showed in the scratch?

Build plan:

- Tasks, each enumerated exhaustively: Tab and Shift+Tab from `cyclicNextEnabled` at 6 and 8 controls; one event slot of the menu bar from `menuOracleEvent` over its state bits and event bits; IndirectOS's window flags (open, minimized, maximized) given which control was pressed.
- Units: (a) the 16-function 2-input gate from `gates.ts`; (b) a counting unit that reads a small random candidate set of wires (e.g. 8), learns a weight in {-1, 0, 1} per candidate through a 3-way softmax, and learns a threshold t through a softmax over 1..8. Its relaxed output is `clamp01(sum - t + 1)`, and its hardened form is `relu(sum - t + 1) - relu(sum - t)`, exact for integer sums.
- Training: Adam over every logit, on 60% of the cases, tested on the held-out 40% and on every case, 3 seeds per configuration, at equal logit counts for both unit types.
- Compile: the hardened netlist into numeric-ui-core, checked on every case with the tensor evaluator, as `gates.ts` does.

Builds on: the scratch `gates.ts` and `tab-baseline.ts`, lab/ui-exploration/input (keyboard.ts, menu.ts, kit.ts), numeric-ui-core.ts.

Expected evidence: exact cases after hardening for each unit type (2-input gates reached 458 of 896 for 6 controls), exact fraction on held-out cases, compiled live operations and layers against the hand-written 127 operations and 7 layers, training seconds, and how many learned counting units read as named constructions, e.g. AND over k bits, OR over k bits, or "no enabled control in between".

### 5. One program per photo: the gallery as instance passes

Size: longer.

Talk connection: one small program behind every pixel, homogeneity, and the 100,000-agent city.

What it tests: can chenglou.github.io's gallery be written as a per-photo program plus a few reduction passes, match gallery-circuit.ts's decisions at 221 photos, and scale the photo count to 10,000 or 100,000 as a buffer length?

Build plan:

- Today: gallery-circuit.ts is 48,411 live operations and 61 layers. Springs are 31,191 of them, 2D targets and hover 2,652, occlusion 2,210. The work that spans photos is the tallest photo per row for 7 column counts, prefix sums of row tops and strip lefts, the click tournament, the anchor count and "any spring still animating".
- Pass A, shared: column count one-hot, clock, frame matrix, focus arithmetic, pointer.
- Pass B, per photo: box size from aspect ratio and column width, and the row index `floor(i / columns)` with codegen's shared reciprocal plus rounding.
- Pass C, reductions: tallest photo per row, row tops, strip prefix sums, the first photo under a click, the anchor count. Written first in JS, then as a Blelloch scan over pass B's outputs with the instance axis.
- Pass D, per photo: destinations, hover, 6 spring lanes against the shared frame matrix, occlusion, settle bit.
- Run passes B and D with codegen/instance.ts on the CPU and with WGSL on Dawn, feeding pass D's outputs straight to drawing when possible.
- References: gallery/reference.ts and gallery/differential.ts along the same traces.

Builds on: lab/ui-exploration/gallery (gallery-circuit.ts, kit.ts, reference.ts, differential.ts, photo-data.ts), lab/ui-exploration/codegen (instance.ts, wgsl.ts, gpu-runner.ts, life-calendar.ts for the row division), lab/ui-exploration/spring-bank (the clock and shared frame matrix).

Expected evidence: per-instance rows of pass D, µs per frame at 221 photos with the generated instance loop against 375 to 510 µs for the flat circuit, 0 decision mismatches over the gallery's differential traces, GPU time at 10,000 and 100,000 synthetic photos, and the number and depth of reduction passes.

### 6. Field morphs: every pixel carries spring state

Size: longer, and bolder.

Talk connection: pixels as the unit of output, diffusion, and Cheng's goal of interpolating between UIs that were never specified.

What it tests: can a UI transition be written as only its start and end states, with every pixel's signed distance value springing on its own, and are the shapes in between valid often enough to be a transition method?

Build plan:

- Per pixel: codegen/sdf-shapes.ts's rounded box distances for the destination state, a stored (distance, velocity) pair per pixel, and a spring step against one shared frame matrix from spring-bank's clock. Coverage is a clamp of `0.5 - distance`. Per-pixel state across frames lives in two storage buffers that swap every frame, which codegen didn't attempt.
- Transitions: IndirectOS's minimize (window rectangle into dock item), maximize, and two cards merging. A retarget mid-transition is a new destination field.
- Validity: count connected components and holes of the covered pixels every frame on the CPU.
- References: CPU generated instance loop against WGSL on Dawn, bit for bit, and a straight blend of the two distance fields as a baseline.

Builds on: lab/ui-exploration/codegen (sdf-shapes.ts, instance.ts, wgsl.ts, gpu-runner.ts, render.ts), lab/ui-exploration/spring-bank (spring-bank.ts).

Expected evidence: per-pixel rows, GPU time per frame at 1280×800 with state feedback, CPU and GPU agreement, frames to settle, and the fraction of frames whose covered shape has more than one component or a hole, for springs against the straight blend.

## Assumptions worth dropping

- **The frame is when state changes.** When presses fall between frames, spring-bank measured up to 514 px of difference between 10 fps and 120 fps, and only one evaluation per event removed it. Committing only at events would make committed state independent of the display rate by construction, make idle cost nothing, and turn replay and scrubbing into evaluations.
- **A hit test belongs to an element.** In IndirectOS, rectangle hits, frontmost selection and press routing take 26 layers of the deepest path and about 500 live operations, and hit regions are limited to rectangles. A read from a per-pixel owner map would allow any shape and share one decision between drawing and hit testing.
- **A paragraph or a message is the unit of text.** text-tabulated re-tabulates and rebuilds on every edit, and painting every line of a 4,096-word paragraph takes 153,549 stored weights. Per-word cells stream without a rebuild, and the scratch placed every arrived word exactly with the rest of the capacity filled by zero-width segments.
- **An output describes the whole capacity.** With zero-width absent segments, `lineCount` was wrong in 43 of 48 streaming states and `windowOverflow` fired in 43, while every arrived word was placed exactly. Reading global outputs at the arrived count would let capacity be an upper bound instead of the content.
- **Per-item code is copied per item.** The gallery is 48,411 live operations for 221 photos, generated JS was slower than the executor at that size (428 to 566 µs against 375 to 508 µs), and hn-thread's rank slots cost 25,616 operations. A per-item program run as instances would make the count a buffer length and confine work across items to reductions.
- **The 2-input gate is the unit of learned behavior.** In the scratch, 2-input gates learned Tab exactly for 2 controls, but not for 3 (at most 53 of 64) or 6 (at most 458 of 896), while the counting construction is exact in 127 operations. Learning counting units, the form every exact decision tonight used, may close that gap.
- **A spring belongs to a window or an item.** One shared frame matrix makes a spring lane 4 products, so springs can belong to words (25 operations each in text-walker) or to pixels, and reflow and transitions become motion of small units.

## What I didn't check

- I didn't build any of the six ideas. The streaming scratch used the fake canvas and didn't add springs, the line count fix, or speakers.
- The gate trainer used one learning rate, no temperature schedule and random wiring only. Learned wiring or a larger search might do better at 3 and 6 controls.
- The per-pixel owner map's cost as a replacement for scalar hit tests, and whether pixel-center quantization changes decisions in real traces, are estimates from codegen's numbers.
- No browser was opened.
