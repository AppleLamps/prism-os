# Premature compression, and going all the way to the bottom

This note reads tonight's thirteen prototypes through two lines of Cheng's talk "Repeatable breakthrough": that we "prematurely compress concepts", and that "maybe to reach all the way up, you need to understand all the way til the bottom." It lists the places where going one level lower already gave a higher-level capability, assumptions in tonight's work that look like premature compressions (with the numbers that show their cost), three scratch experiments run for this note, and six proposals.

Scratch scripts live in `scratchpad/phase3-ideas/premature-compression/`: `time-instance.ts`, `perturbed-executor.ts`, and `difflogic-tab.ts`. Each runs with `bun <file>` and only imports from the prototype folders. Timings are rough, because other agents share the machine.

## Where going one level lower already gave a higher-level capability

| Level dropped | Prototype | Capability that appeared | Number |
| --- | --- | --- | --- |
| Below pretext's `layout(width)` API to the walker's comparisons | text-walker | A different width per line, e.g. text flowing around a dragged rectangle, and a spring per word | 0 mismatches over 200 random rectangles; 48 words with 96 springs is 14,760 live ops |
| Below a paragraph's thresholds to FP32 bit patterns | text-tabulated | Every line decision exact at every FP32 width, with a 4-atom comparison | 0 wrong line counts or cursors over pretext's oracle cases |
| Below the frame to the 4 ms step | spring-bank | Frame-rate independent animation | within 0.003 px from 10 to 120 fps, against up to 401 px for the original springs |
| Below the latest event of each kind to the event queue | input | An outward-and-back move cancels a click inside one frame, and moves fold | 46 live ops and 0 layers per extra queued move |
| Below absolute positions to displacement from the destination | gallery | Springs settle at 100,000 px, where FP32 values are 1/64 px apart | 0 decision mismatches over about 2 million checks |
| Below a one-hot to a floor inside the executor | index-read | Reading a table at a computed integer | 10,000 entries: 1 live op instead of 30,002 |
| Below the widget to the pixel | codegen | A map of what a press does at every pixel of IndirectOS | 1,024,000 pixels in about 0.3-1.8 ms through Dawn, bit-exact against the CPU |
| Below strings to integer codes | text-editing | A text field's editing model inside the circuit | 0 mismatches over about 35,000 frames |
| Below a float64 threshold to the next FP32 value above it | numeric-library | Decisions equal to float64's, at no extra cost | 7 of 168 tick boundary values were wrong with the rounded constant, 0 with `ceilFloat32` |

The shape repeats: a prototype stopped treating something as a unit (an API call, a frame, a paragraph, a string) and worked with what that unit is made of, and a capability the unit couldn't express appeared.

## Assumptions that look like premature compression

### 1. FP32 as the one numeric floor for every value

Evidence:
- The census in `perturbed-executor.ts` (below) found that over the codegen 240-frame session, 2,039 of IndirectOS's 5,253 live values were exact bits in every frame, 842 more were integers below 2^15, and none was an integer above 2^15. 2,372 were fractional.
- text-editing and input build every decision from integers and use no boolean atom. text-editing's position keys must stay below 2^23, so capacity 1024 only fits a 512 px field, and capacity 2048 doesn't fit at all.
- numeric-library's float hash is already unevenly spread at 16,384 keys (chi-square p = 0.018), and past 65,536 keys it's far from even, likely because `key * .1031` keeps only about 11 fractional bits there.
- codegen's WGSL needed a `max` guard on nearly every row (537 guards for 510 statements on the press map), because Metal fuses multiply-adds and folds `(x + 8388609) - 8388609`. The press map was exact even without the guard, because every product in it is an exact integer.

What dropping it would unlock: a separate integer representation for values that are provably integers, e.g. `i32` in WGSL, where fusing and folding can't change a result, native `u32` hashing, and text buffers whose position keys don't share a 24-bit mantissa with fractional geometry. expressions.md ("Decision bits") already notes that integer-count bits stay exact in narrower formats like bfloat16, while the 2^23 rounding trick doesn't.

### 2. Bit-exact accumulation order on every wire

Evidence:
- `perturbed-executor.ts` evaluated IndirectOS's compiled program with every sum reversed, balanced, or fused (the product not rounded before it's added), and with float64 everywhere. None of these flipped any of the 64 boolean atoms or any of 48 discrete state cells (open, minimized, maximized, drag, resize, stacking, photo focus), open or closed loop over 240 frames. In the closed loop, the animation bit matched in every frame too.
- Continuous outputs were more sensitive than one FP32 step suggests. Open loop, window outputs drifted up to 0.20 px (reversed), 0.57 px (balanced) and 0.59 px (float64), but only 3.8e-6 px for fused multiply-add. Closed loop, one window output spiked to 13.9 px in one frame (reversed, frame 164, in maximized Photos after a photo click), while every tenth frame stayed within 0.0016 px. I didn't trace which construction amplifies the difference.
- notation: "creation order is part of the meaning", because ordinary affine terms are sorted by wire number. numeric-library: converting all 273 minimum and maximum sites to exact forms cost 18% more operations and 13% more layers, and didn't change the largest layout difference from float64, which one FP32 step of affine rounding sets (6.1e-5 px).

What dropping it would unlock: exactness only at rounding points (boolean atoms, `round` and `floor` chains, comparison differences), with a measured error bound on geometry. That's what a fused GPU kernel, a framework sparse kernel, or a parallel prefix network needs, and it would let the notation reorder statements freely. The 13.9 px spike says the error bound has to be measured, not assumed.

### 3. One frame is one evaluation at one time

Evidence:
- spring-bank: when presses fall between frames, deferred retargeting alone differs from 120 fps by 514 px at 10 fps. One extra evaluation per event timestamp brings every rate within 0.0051 px.
- lists: the settle rule reads drifting spring state, so one differing animation bit shifts every moving card's timeline, by up to 173 px. The animation bit differed in 24 of 61 runs at 100 cards.
- input: an unrolled capacity-16 event circuit costs about 44 µs per frame whether events arrived or not.
- 1,984 of IndirectOS's 5,253 live values never changed during the 240-frame session, yet every frame recomputes them.
- `time-instance.ts` (below): with the 4 spring-matrix cells as the instance axis, 301 samples of all of IndirectOS, 1.2 s ahead at 4 ms, cost 0.48-0.69 ms on the CPU, against 7.8-8.5 ms for 301 executor evaluations, with 0 mismatches.

What dropping it would unlock: time as data. Predictions of the whole UI until the next event, animation that keeps playing through a main-thread stall as compositor keyframes, settle checks at fixed simulated times instead of frame boundaries, and ideas.md's "candidate futures" as instances of one program.

### 4. Every output of a frame is consistent with that frame's inputs

Evidence:
- layout-tree: reading the previous frame's spring position took the app shell from 115 to 83 layers, and also dropping the tag wrap brought it to 48. 162 of 185 rectangles sit at layers 109-115 only because they read the body row's height.
- spring-bank: Photos reading the previous frame's window size cut IndirectOS from 137 to 91 layers, but Photos was up to 85.7 px off during the maximize animation. Reading this frame's stepped springs gave the same 91 layers, with a 6.6 px lag only during live resize.
- gallery's 61 layers come from one chain, from the click to occlusion. hn-thread's 69 layers come from one chain, from natural heights to slot reads.

What dropping it would unlock: one frame of latency where it isn't visible, chosen by measurement. Hardware synthesis calls this retiming: moving registers along a circuit to shorten its longest path. Tonight every cut was picked by hand.

### 5. The DOM as the output

Evidence:
- hn-thread: routing rows into 48 DOM slots is 25,616 of the circuit's 53,703 live ops and 134,366 of its 218,170 stored weights. Window slots are 20 times cheaper, but a settled collapsed subtree in view needs 32 window slots where rank slots need 7.
- notation: the title bar buttons are laid out twice, by circuit arithmetic for hit tests and by CSS flexbox for drawing. IndirectOS's CSS turns numeric outputs into border alpha, shadows and corner radii with `calc()`, which is the job a fragment shader does.
- hn-thread: comments render natively from `innerHTML`, so a comment can be a line taller or shorter than pretext predicted. The text-walker demo counts such mismatches instead of assuming none.
- codegen: a per-pixel program over 1,024,000 pixels ran in about 2 ms on the GPU.

What dropping it would unlock: pixels as the output. A per-pixel program reads shared per-row tables, so there's no slot routing and no second layout, and glyphs land where the circuit decided.

### 6. Capacities and slot counts fixed at compile time

Evidence:
- gallery: every per-photo operation is written out 221 times (48,411 live ops, 64% of them springs). Generated JS becomes 2,242 functions that still take 430-570 µs after 6,000 warm runs, slower than the executor.
- text-editing: about 210 live ops per cell, paid on every key whatever the text length. layout-tree: 284 text threshold cells reserved where 153 are used, which is about 470 of the text pass's 1,013 live ops.
- text-walker: the window, line slots and run limit are reported as overflow counts rather than handled.

What dropping it would unlock: per-item programs whose item count is a dispatch size, like codegen's instance axis, where only cross-item reductions (sum, maximum, first hit, prefix sum) span items.

### 7. A static widget tree

Evidence: layout-tree and hn-thread both state that children can't appear or disappear at runtime. hn-thread's ancestor loop became a constant 2,761-entry table. index-read's pointer jumping over 1,023 segment starts costs 35,914 live ops beyond the next-start table, where phase 1 estimated 7 to 10 million atoms with one-hots.

What dropping it would unlock: parents as runtime cells, resolved by pointer jumping, e.g. a thread that receives new comments without recompiling, or an outline with drag-to-reparent.

### 8. Strings, and a grapheme vocabulary assigned in JS

Evidence: text-editing's JS assigns each new grapheme a code in a 96-entry width table ("A full table drops new graphemes") and classifies it with a regex. Only spaces and newlines open break opportunities, so 2,023 of 2,460 CJK layouts differ from pretext. Reading a cell's advance from the table costs 194 atoms per lookup with one-hots, about 49,700 live ops per layout at capacity 256, so cells cache their class and advance, and a font change means JS rewrites every cell.

What dropping it would unlock: the code assignment is the UI's tokenizer, and the talk expects tokenizers to go away. Cells could hold Unicode scalar values (below 2^21, exact in FP32), with advances, break classes and pair rules read from tables at an index, so the circuit decides break opportunities and a font change rewrites one table.

### 9. Three atoms, with index read as a special fourth instruction

Evidence: index read is hard attention whose keys are integer positions. `hard-attend.ts` already uses parabola keys `[2i, -i²]`, where a query `(q, 1)` scores highest at `i = q`. Tonight, lookups by id still resolve in JS (index-read, "Keys and strings"), and phase 1 measured the nearest of 64 runtime targets at 1,141 live ops and 43 layers. There's also no matching write, so replacing a range of cells costs text-editing 6,387 live ops of barrel shifts per key at capacity 256.

What dropping it would unlock: scored retrieval (by sparse id, by nearest target) as one instruction, with reading at an integer as its special case, plus a scatter for next-source tables.

### 10. Circuits are written by hand

Evidence: text-tabulated treated pretext as a black box, sampled it, and bisected every change down to adjacent FP32 widths. That absorbed soft hyphens, emergency breaks, tabs, letter spacing, CJK and keep-all with no feature-specific code and 0 wrong decisions on pretext's oracle cases. The hand-authored text-walker needed a JS derivation per feature (`rows.ts`). The same tabulation produced hn-thread's 1,768 height breakpoints and the caption tables in layout-tree and gallery. Everything else tonight was authored.

What dropping it would unlock: circuits that are found, by tabulation when one runtime value drives the result, and possibly by learning at the level of gates. The scratch run below shows the second one isn't free.

## Scratch experiments for this note

### Time as an instance axis (`time-instance.ts`)

spring-bank's IndirectOS copy with `springs: 'source-matrix'` and `retarget: 'deferred'`, after maximizing Photos and stepping 3 frames. The 4 frame-matrix cells are per-instance, and instance i holds M^i, so it computes the UI i × 4 ms later. Outputs are the window and dock projections, Photos' photos and thumbnails, and the animation bit (217 values).

| Photos reads | Live rows | Layers | Per-sample rows | Per-sample layers | 301 samples, generated instance loop | 301 executor evaluations | Mismatches over 1,302 checked values |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| current frame | 3,413 | 137 | 2,051 | 80 | 0.69 ms | 8.5 ms | 0 |
| previous frame | 3,415 | 91 | 1,234 | 25 | 0.48 ms | 8.0 ms | 0 |
| stepped springs | 3,416 | 91 | 2,042 | 68 | 0.67 ms | 7.8 ms | 0 |

The prediction says the animation ends at sample 138, 552 ms ahead. With Photos reading the previous frame, 64% of the circuit is shared and runs once per prediction.

### Which exactness IndirectOS depends on (`perturbed-executor.ts`)

An interpreter over codegen's flattened program, checked equal to the production executor on every root at 5 frames. The reference session is codegen's `applyInteraction`: drag, resize, close and reopen, maximize Photos, open photos, restore, minimize. "Open loop" evaluates each mode on the reference's source tables. "Closed loop" lets each mode drive its own state through the same events.

| Mode | Live values that differ, open loop | Boolean flips | Discrete state cells that differ, closed loop | Largest window output drift, open loop | Largest, closed loop |
| --- | ---: | ---: | ---: | ---: | ---: |
| reversed term order | 67,181 of 1,260,720 | 0 | 0 | 0.20 px | 13.9 px (one frame) |
| balanced pairwise sums | 54,191 | 0 | 0 | 0.57 px | 1.8 px |
| fused multiply-add | 4,179 | 0 | 0 | 3.8e-6 px | 3.8e-6 px |
| float64, boolean atom as `score >= 0.5` | 133,012 | 0 | 0 | 0.59 px | 1.2 px |

Under reversed order, the row that differs most given identical inputs is a 3-term sum over -4,876.84, -46.19 and 18.03, off by 4.9e-4. The drift reaches 0.2-13.9 px downstream, so some construction amplifies it. This is one scripted session of one UI. gallery's coordinates at 170,000 px are the obvious next test.

### A logic gate network on the Tab rule (`difflogic-tab.ts`)

A differentiable logic gate network (Petersen et al., "Deep Differentiable Logic Gate Networks", NeurIPS 2022): every node reads two random inputs from the layer before, holds a softmax over the 16 two-input gates, and hardens to its most likely gate. Each output is a majority vote over a group of gates. The task is input's Tab rule for 4 controls, with 4 enabled bits, 4 focus bits and Shift as inputs: 160 cases, a random 112 for training and 48 held out.

| Gates | Layers | Group size | Steps | Seconds | Training cases exact after hardening | Held-out cases exact |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 272 | 5 | 4 | 1,500 | 12 | 91 of 112 | 24 of 48 |
| 896 | 4 | 32 | 2,000 | 85 | 104 of 112 | 27 of 48 |
| 1,408 | 6 | 32 | 2,000 | 129 | 108 of 112 | 35 of 48 |

No run learned the rule exactly, and the held-out counts trail the training counts, so the networks mostly memorized. These were short runs with no tuning, so they show that this direction needs real work, not that it fails.

## Ideas

### 1. Which exactness each UI depends on, measured with perturbed executors

- Talk connection: bit-exact FP32 on every wire compresses two different requirements, exact decisions and bounded geometry, into one. The WGSL `max` guard is the price of keeping them together.
- What it tests: whether tonight's UIs need strict accumulation order everywhere or only at rounding points. That decides whether fused GPU kernels, framework kernels, parallel prefix networks and a notation without order meaning are allowed.
- Sketch: extend `perturbed-executor.ts` with a mode that keeps stored order only at rounding points (boolean rows, `roundAffine` rows that feed a boolean or a `round`, comparison differences) and balances and fuses every other sum. Run open and closed loop on IndirectOS's session, gallery's dyadic traces (coordinates past 170,000 px), hn-thread's scripted session, lists' card seeds, text-editing's typing trace, life-calendar (whose `round` steps broke unguarded shaders), and numeric-library's boundary workload. Count flips of booleans, next-source bits and gather indices, settle-bit differences, and continuous drift, and trace the construction behind the largest drift, e.g. the 13.9 px spike. Then emit WGSL with guards only on rounding points and rerun `gpu-headless.ts`.
- Builds on: `codegen/codegen.ts`, `codegen/indirect-os-machine.ts`, `codegen/wgsl.ts`, `codegen/gpu-headless.ts`, `gallery/differential.ts`, `hn-thread/differential.ts`, `lists/traces.ts`, `text-editing/report.ts`, the scratch `perturbed-executor.ts`.
- Expected evidence: a table per UI of decisions checked and flipped per mode, closed-loop divergence, worst drift with its cause, the fraction of rows that are rounding points, and the guard count before and after, with GPU decision mismatches.
- Size: one to two hours.

### 2. Time as an instance axis: predict all of IndirectOS until the next event

- Talk connection: below the frame to the 4 ms sample. The sample is the homogeneous unit, and one program at M^i directs every sample the same way.
- What it tests: whether "one frame is one evaluation at one time" is a premature compression, i.e. whether a UI's future until the next event can be computed as one batch, so animation survives main-thread stalls and settle checks stop depending on frame boundaries.
- Sketch: start from `time-instance.ts` (1,234-2,051 rows per sample, 0.48-0.69 ms for 301 samples, 0 mismatches). Turn the 301 samples of window translate, scale and size, and thumbnail positions, into Web Animations keyframes, as `spring-bank/predictive.ts` does for 5 boxes. Invalidate the prediction on any event. Emit the per-sample part as WGSL. Add settling at fixed simulated times, e.g. check only at samples whose step count is a multiple of 16, and snap every later sample. Replay `spring-bank/trace.ts` at 10, 30, 60 and 120 fps and with the 500 ms stall, and compare keyframe playback at display times with the 120 fps run.
- Builds on: `spring-bank/window-manager.ts`, `spring-bank/predictive.ts`, `spring-bank/trace.ts`, `codegen/instance.ts`, `codegen/wgsl.ts`, the scratch `time-instance.ts`.
- Expected evidence: per-sample rows and layers for each Photos wiring, prediction time on CPU and GPU, the largest px difference between keyframe playback and the 120 fps replay with stalls, settle-bit agreement across frame rates, and how often events invalidate a prediction in the trace.
- Size: one to two hours.

### 3. Retiming: one-frame delays chosen by search, against a visible-error budget

- Talk connection: requiring every output to be consistent with this frame's inputs compresses "one frame" and "circuit depth" into one unit. Hardware answers the same problem one level down, with registers placed by retiming.
- What it tests: how much depth a program sheds for a measured visible error when cuts are found automatically, and whether the search picks the cuts people picked by hand tonight (the spring feeding layout, content heights, Photos' window size).
- Sketch: work on flattened programs, so no builder changes are needed. A cut on a packed value makes every reader take the value from a new source cell that holds last frame's value, and depths are recomputed as the longest chain from sources. Greedy search: try cutting each value on the longest chain, replay the trace, and keep the cut that removes the most layers per px of error, until the error passes 1 px or a decision mismatches. Workloads: IndirectOS (codegen session, spring-bank live resize trace), the layout-tree app shell frames, gallery's dyadic traces, hn-thread's scripted session.
- Builds on: `codegen/codegen.ts` (`flattenProgram`), the scratch `perturbed-executor.ts` interpreter, `layout-tree/app-shell.ts`, `spring-bank/trace.ts`, `gallery/differential.ts`, `hn-thread/differential.ts`.
- Expected evidence: layers against largest px error and decision mismatches per workload, the list of chosen cuts, and a comparison with the hand-chosen variants (115 to 48 layers, 137 to 91).
- Size: one to two hours.

### 4. Pixels instead of DOM slots: draw the HN thread per pixel

- Talk connection: Ken Perlin's "one supercomputer behind every pixel". The pixel is the smallest homogeneous output unit, while DOM slots are a heterogeneous one the circuit has to route into.
- What it tests: whether the slot router and the second layout exist only because of the DOM, and what a per-pixel program over a text-heavy UI costs.
- Sketch: add `pixelX` and `pixelY` source cells to `hn-thread/thread-circuit.ts` built with no slots (28,340 live ops). Per-pixel operations read shared per-row outputs: the row under the pixel as a count of `[top_r <= pixelY]` over 251 rows, the sticky banner rectangle, gutter lines (within 0.5 px of a gutter's x and inside its extent), collapsed and hover emphasis, and text as one gray bar per line from each comment's line count. `planInstances` with the two pixel cells separates the thread logic from the per-pixel part automatically. Run the generated instance loop on the CPU at 320×200 and the WGSL shader through `gpu-headless.ts` at 1280×800, and check both against a float64 JS rasterizer of the same rectangles. A longer extension adds index-read rows to `flattenProgram` and the WGSL emitter as clamped storage-buffer reads, replaces the count with an 8-read binary search, and reads a 1-bit glyph atlas for real text.
- Builds on: `hn-thread/thread-circuit.ts`, `hn-thread/differential.ts`, `codegen/instance.ts`, `codegen/wgsl.ts`, `codegen/gpu-headless.ts`, `codegen/render.ts`, `codegen/sdf-shapes.ts`, `index-read/numeric-ui-core.ts`.
- Expected evidence: per-pixel rows and layers, ms per frame on CPU and GPU, the live ops and weights that disappear with the slot section (25,616 and 134,366 today), pixel mismatches against the rasterizer, and GPU bits against CPU bits.
- Size: one to two hours for the count version. The index-read extension is longer.

### 5. Wire the bits directly: learned logic gates for a UI rule (longer)

- Talk connection: "literally wiring every 1 and 0 with each other and make them learned ... What if logic gates have learned backprops?"
- What it tests: whether a UI decision rule can be found at the level of gates instead of authored, hardened with no rounding trick, and generalized to held-out inputs, i.e. a rule rather than a table. The best scratch run got 108 of 112 training cases and 35 of 48 held-out cases right after hardening.
- Sketch: a ladder of tasks with exhaustive certification: first active of 8 bits, cyclic Tab over 4, 6 and 12 controls (input's `keyboard.ts` oracle), rectangle hit on 6-bit coordinates, click versus drag on 5-bit deltas. Training changes to try: temperature annealing, each input bit and its complement as inputs, wiring biased toward prefix structure (gate i reads i and i - 2^k), and the Adam epsilon lesson from the September reassessment. Certify with bit-sliced evaluation, 32 inputs per `Uint32` operation. Compile a hardened netlist into the circuit with integer bits (AND as a product, XOR as `a + b - 2ab`) and compare atoms and layers with input's authored Tab form. Inspect the learned netlist for a prefix OR or carry-lookahead structure.
- Builds on: `input/keyboard.ts`, `input/kit.ts`, `lab/learned-interpreter` (optimizer lessons), the scratch `difflogic-tab.ts`, `numeric-ui-core.ts`.
- Expected evidence: per task over 20 seeds, gates, depth, training and held-out exactness after hardening, exhaustive certification counts, compiled atoms against the authored circuit, and bit-sliced throughput.
- Size: longer.

### 6. Code points in cells: break rules as table reads, with no grapheme vocabulary

- Talk connection: "Obviously the llm tokenizer is gonna go away." text-editing's JS code assignment, a 96-entry vocabulary that drops new graphemes, is the UI's tokenizer.
- What it tests: whether the string boundary can move down from grapheme codes to Unicode scalar values, with advances and break opportunities read and decided in the circuit, and what that costs per cell.
- Sketch: switch `text-editing` to `index-read/numeric-ui-core.ts`. Cells hold only a code point. Per cell, `advance = indexRead(advanceTable, codePoint)`, filled by JS the first time a code point appears, and the line break class comes from a two-level table (a block index, then the class within the block), like the code point tries ICU uses. `breakAfter[i] = indexReadAffine([[class_i, K], [class_(i+1), 1]], 0, pairTable, 'clamp', 'clamp')` reads a simplified UAX #14 pair table over about K = 43 classes: break between ideographs, no break before closing punctuation, hanging spaces. `breakAfter` replaces the space class in the latest-opportunity scan. Keep one code point per cell and report emoji ZWJ sequences as out of scope. Rerun `pretext-agreement.ts`, including the CJK family that differs in 2,023 of 2,460 layouts today.
- Builds on: `text-editing/editor-circuit.ts`, `text-editing/width-table.ts`, `text-editing/pretext-agreement.ts`, `index-read/numeric-ui-core.ts`, and pretext's `analysis.ts` in the read-only copy for break kinds.
- Expected evidence: CJK and other family mismatches before and after, live ops per cell for decode and break bits against today's 8 atoms per cell, table sizes and their source validation cost, and which JS classification remains.
- Size: one to two hours.
