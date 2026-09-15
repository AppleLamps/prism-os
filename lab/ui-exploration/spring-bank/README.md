# Spring bank: fixed-step springs as shared matrix powers

## What it is and how to run it

This prototype rebuilds IndirectOS's springs with vibescript's timing (docs/Animation.md): every spring steps a fixed 4 ms at a time, a frame runs as many steps as the elapsed time allows, leftover time carries into the next frame, and catch-up is capped at 300 steps. The steps don't loop at runtime. With constant stiffness and damping, one semi-implicit Euler step is a 2x2 matrix on (displacement, velocity), so N steps are that matrix to the power N. The circuit computes N from the frame delta with exact threshold bits, reads M^N once per group of springs that share stiffness and damping, and applies it to every animated value with four products. All values of one animated object snap together once they're all settled, and land exactly on their destinations.

Run from the repo root:

- `bun test lab/ui-exploration/spring-bank` runs 12 tests in about 2 s.
- `bunx tsgo -p lab/ui-exploration/spring-bank` typechecks the folder.
- `bun lab/ui-exploration/spring-bank/report.ts` prints every table below in about 15 to 25 s and writes `results.json`.
- `bun lab/ui-exploration/spring-bank/demo.html` opens the predictive keyframes demo. Click to fling five boxes. The render loop runs only every 300 ms; Web Animations plays 301 predicted 4 ms samples per box.
- `bun lab/ui-exploration/spring-bank/indirect-os.html` opens IndirectOS with bank springs and controls for the spring variant, retarget timing, frame pacing (display rate, 30 fps, 10 fps), and a button that blocks the main thread for 500 ms. The same choices work as query parameters, e.g. `?springs=original&fps=10`. The page applies events in the next rendered frame; it doesn't do the event-time evaluations described in the frame-rate results.

I checked that both pages bundle with `bun build`, but I haven't opened them in a browser.

Nothing outside this folder changed. The folder imports `numeric-ui-core.ts` unchanged.

## What was built

Vocabulary used below: a lane is one animated number with its position and velocity, e.g. a window's center x. A box is one animated object whose lanes settle together, e.g. a window with 5 lanes or a Photos thumbnail with 2. A group is the set of lanes that share stiffness and damping. Retargeting means changing a lane's destination while it's still moving.

- `spring-math.ts`: float64 matrix helpers, the clock contract, and the independent JS reference. The reference runs plain Euler loops, the `animatedUntilTime` clock with the 300-step cap, and per-box snapping.
- `spring-bank.ts`: the builder.
  - Clock, once per circuit. JS rounds requestAnimationFrame timestamps to a 1/64 ms grid, subtracts them in float64, and writes the frame delta into a cell. The circuit computes `pending = running * (leftover + delta)` and caps it at 1200 ms with a min. It counts coarse chunks `c = sum over m of [capped >= 64m]` for m = 1..18, then the remainder `r = capped - 64c`, then fine steps `f = sum over n of [r >= 4n]` for n = 1..15. Then `steps = 16c + f` and `nextLeftover = min(pending - 4 steps, 65536)`. Each threshold is 2 ReLUs and 1 boolean over the difference scaled by 32. Every value is a multiple of 1/64 ms below 2^17, so each bit is exact. That's 33 thresholds instead of the 300 in phase 1's thermometer (3,911 operations). When nothing animated last frame, `running` is 0 and the clock starts from zero, like the doctrine's `animatedUntilTime = null`.
  - Group, four variants for computing the frame matrix M^steps:
    - `split-table`: exact one-hot bits of c and f (differences of neighboring thresholds) read two constant tables, M^(16c) and M^f. Each entry is one affine row whose only nonzero term is the selected constant, so the read is exact. One 2x2 product combines the two tables.
    - `binary-powers`: the 9 binary digits of steps come out of the same thresholds, select constant M^(2^j), and a balanced product tree multiplies them.
    - `source-table`: JS writes both tables into 140 source cells whenever stiffness or damping change. The circuit reads them with one-hot masked sums that the compiler lowers to 8 gather reads, so stiffness and damping stay editable while the clock stays in the circuit.
    - `source-matrix`: JS counts steps and computes M^steps in float64, then writes 4 cells. The clock leaves the circuit.
  - Lane: `e' = F00 e + F01 v` and `v' = F10 e + F11 v`. Each product is written as `reglu(e; F) - reglu(e; -F)`. One of the two ReLU arms is always exactly zero, so the sum is the exact FP32 product.
  - Box: `exceedance = sum over lanes of relu(check - distanceThreshold) + relu(-check - distanceThreshold) + relu(v' - speedThreshold) + relu(-v' - speedThreshold)`, and `settled = boolean(relu(0.5 - 2^20 * exceedance))`. A sum of nonnegative FP32 values is 0 only when every term is 0, so `settled` is exactly 1 when every lane is within both thresholds (0.01 px and 0.01 px/s, as in the doctrine). A large exceedance drives the score far below 0, where the ReLU clamps it to 0, so no magnitude can overflow the boolean. Then `active = (1 - settled) * (1 - snap)`, `position = destination + active * check`, and `velocity = active * v'`. A settled or snapped box lands exactly on its destinations with zero velocity (sometimes -0). The `snap` bit is IndirectOS's direct manipulation: dragging, resizing, or a hidden window.
  - Retarget timing:
    - `doctrine`: this frame's steps move toward the destination computed this frame, as in the vibescript demos, where "handle inputs" runs before the animation tick.
    - `deferred`: this frame's steps move toward last frame's destination, stored in one extra cell per lane. The new destination applies from the next frame's first step. The reason is explained with the frame-rate results below.
- `bank-machine.ts`: a standalone bank with a source table, the host clock, and destination cells written by JS.
- `bank-check.ts`: runs a standalone bank along random frame times with 500 ms and 2 s stalls and retargets, and compares it with float64 Euler loops, either restarted from the circuit's state every frame or free-running. The tests and the report share it.
- `window-manager.ts` and `photo-gallery.ts`: copies of IndirectOS. New source cells are appended after the original layout, so every original wire keeps its index. Options:
  - `springs: 'original' | 'split-table' | 'binary-powers' | 'source-table' | 'source-matrix'`. With `'original'` the copy rebuilds the original circuit exactly (same live operations, layers, and stored weights), and every output matches the original file bit for bit along the trace.
  - `retarget: 'doctrine' | 'deferred'`.
  - `photosInputs: 'current-frame' | 'previous-frame' | 'stepped-springs'`: where Photos reads its window's content size and presence (see the depth section).
  - `debugOutputs` adds each window's snap bit as an output, for the float64 check.

  The machine also returns `inlinedPhotos`: the Photos circuit before inlining and the wire map that `inlineCircuit` returns, so the report can attribute the thumbnail springs copied into IndirectOS. One behavior change: Photos thumbnails clamp their snapped position like their moving position. The original selects the unclamped target when snapping, but the strip layout keeps every target inside the viewport, so the values are the same.
- `trace.ts`: a timestamped IndirectOS trace (minimize, restore mid-animation, drag, maximize, restore mid-animation, open a photo, next twice, close the lightbox, close a window), with an optional live resize. Presses sit on 30 fps frame times, which 30, 60 and 120 fps render. At 10 fps, the drag release (1833.3 ms), the lightbox close (6666.7 ms), and the resize grip press and release (5333.3 and 5666.7 ms) fall between frames, and pointer moves fall between frames at every rate. `offsetPresses` moves presses off the frame grid, by a fixed or a random offset. Replay works at any frame rate with optional stalls, and can evaluate the circuit once more at each event's timestamp without rendering (event-time evaluations). The file also has a comparison at shared timestamps and a float64 check of the window springs inside the circuit.
- `predictive.ts`: predictions (sample i evaluates a copy of the table as if i * 4 ms passed), a batched circuit that outputs all 301 samples in one evaluation, keyframe conversion, and the demo scene.
- `demo.html`/`demo.ts`, `indirect-os.html`/`indirect-os-demo.ts`: the two browser pages. All logic lives in modules the tests exercise.
- `bank.test.ts`, `indirect-os.test.ts`, `report.ts`, `results.json`.

## Measured results

Counts are exact. Timings are rough: a dozen other agents share the machine, and the original IndirectOS evaluation measured between 35 and 53 µs across three report runs. The tables use the last run, which is the one in `results.json`, so compare timings within a table.

### IndirectOS size

| Variant | Live operations | Layers | Widest layer | Stored weights | Window spring builder operations | Photos spring builder operations (inlined) | µs per evaluation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| original window-manager.ts | 5,253 | 192 | 123 | 11,598 | 1,240 | 1,116 | 53 |
| original springs, Photos reads previous frame | 5,255 | 118 | 150 | 11,603 | 1,240 | 1,116 | 49 |
| bank split-table | 3,580 | 137 | 365 | 8,447 | 523 | 468 | 44 |
| bank binary-powers | 3,644 | 137 | 384 | 8,513 | 587 | 468 | 45 |
| bank source-table | 3,584 | 137 | 369 | 8,323 | 527 | 468 | 45 |
| bank source-matrix | 3,413 | 137 | 430 | 8,011 | 356 | 468 | 43 |
| bank split-table, doctrine retarget | 3,580 | 141 | 189 | 8,195 | 523 | 468 | 44 |
| bank split-table, Photos reads previous frame | 3,582 | 91 | 392 | 8,452 | 523 | 468 | 42 |
| bank split-table, Photos reads stepped springs | 3,583 | 91 | 365 | 8,455 | 523 | 468 | 42 |
| bank source-matrix, Photos reads stepped springs | 3,416 | 91 | 430 | 8,019 | 356 | 468 | 41 |

The builder columns count live operations created inside `emitSpring`, or inside the bank clock, group, and box builders: for the 20 window lanes, and for the 24 thumbnail lanes that `inlineCircuit` copies from Photos. The report labels the copied operations by mapping the labels recorded on the Photos circuit through the wire map that `inlineCircuit` returns. The original file doesn't return that wire map, so its thumbnail count comes from the copy with `springs: 'original'`, which builds the same circuit. The clamps and selects around springs count elsewhere. The thumbnail counts match standalone Photos:

| Photos standalone | Live operations | Layers | Stored weights | Thumbnail spring builder operations |
| --- | ---: | ---: | ---: | ---: |
| original photo-gallery.ts | 2,358 | 91 | 5,574 | 1,116 |
| copy, bank springs, JS writes a fixed 16 ms frame matrix (no clock) | 1,563 | 64 | 3,974 | 468 |

The copy's thumbnail boxes read their frame matrix from 4 inputs. Standalone, JS writes M^4 into those 4 source cells once (16 ms per call, the same simulated time as the original's four 4 ms substeps), so this row has no clock and no table group. Inside IndirectOS, the same 4 inputs are wired to the window springs' frame matrix.

Along the deepest path of the original (193 operations), 74 are spring operations: 41 from the window `emitSpring` calls and 33 from the thumbnail `emitSpring` calls inlined from Photos. With the bank, 15 of 138 are box operations (7 from a window box and 8 from a thumbnail box), and the other 123 are hit tests, frontmost selection, press routing, drag geometry, targets, and the rest of Photos. When Photos reads stepped springs, 8 of 91 are thumbnail box operations. The report walks back from the deepest operation into one dependency per layer; taking the most spring operations over every chain of maximum depth gives the same counts.

Deferred retargeting has 4 fewer layers than doctrine retargeting (137 against 141) but 252 more stored weights. With deferred timing, the stepping reads last frame's destination from a source cell, so it no longer waits for this frame's destination logic. Only the settle check reads the new destination.

### Unit costs

| Construction | Live operations | Layers | Stored weights | Booleans |
| --- | ---: | ---: | ---: | ---: |
| `emitSpring`, one lane | 46 | 33 | 104 | 0 |
| clock alone | 108 | 13 | 196 | 33 |
| clock plus a split-table frame matrix | 163 | 13 | 398 | 33 |
| clock plus a binary-powers frame matrix | 227 | 18 | 464 | 33 |
| clock plus a source-table frame matrix (8 gathers) | 167 | 13 | 274 | 33 |
| one box of 1 lane, frame matrix given | 21 | 8 | 58 | 1 |
| one box of 2 lanes | 38 | 8 | 112 | 1 |
| one box of 5 lanes with a snap bit | 89 | 9 | 266 | 1 |

A window's 5 lanes cost 89 operations in 9 layers once the frame matrix is given, where five `emitSpring` calls cost 230 operations in 33 layers. A box also needs the clock and a frame matrix: 163 operations in 13 layers with split-table, once per circuit and shared by all 44 IndirectOS lanes. The largest frame matrix entry over 0..300 steps is 10.4 for stiffness 650 and damping 45, which sets the declared ranges.

### Exactness against float64

- Clock: `min(300, floor(pending / 4))` and the carried leftover match the float64 reference exactly. The test covers pending times one grid step below, at, and above every multiple of 4 ms up to 305 steps, plus 500 random times up to 120 s.
- Standalone bank (`bank-check.ts`), all 4 variants with both retarget timings, along random frame deltas with 500 ms and 2 s stalls and retargets. The table shows the worst variant:

  | Retarget timing | Restarted from the circuit's state every frame (400 frames): max position error | Free-running (3,000 frames): max position error while both sides animate | Free-running: max position error | Free-running: frames with a different settle bit |
  | --- | ---: | ---: | ---: | ---: |
  | deferred | 1.85e-4 px | 3.8e-4 px | 3.4e-3 px | 10 |
  | doctrine | 1.47e-4 px | 4.4e-4 px | 5.3e-4 px | 3 |

  Restarted every frame, the comparison measures one frame's error: settle bits agree in every frame, and settled lanes equal their destination bit for bit with zero velocity. The tests check 1e-3 px. Free-running, float64 carries its own state, so near the settle thresholds FP32 and float64 cross them in different frames. In those frames one side has snapped to the destination while the other still animates within the 0.01 px settle distance, which gives the larger max error.
- Window springs inside IndirectOS, checked frame by frame against float64 loops using the circuit's own destinations and snap bits. All 4 variants, both retarget timings, 30 and 120 fps, with the live resize trace: at most 7.8e-5 px and 6.3e-4 px/s, with 0 settle bit mismatches.
- Focus, stacking, open, minimized, maximized, drag and resize owners, and photo focus match the original IndirectOS frame by frame along the trace at 60 fps.

### Frame-rate independence

The same trace, compared with a 120 fps run at the timestamps both runs rendered. Every press in this trace sits on a 30 fps frame time, so 30, 60 and 120 fps apply each press in a frame at the press's own time. At 10 fps, the drag release (1833.3 ms) and the lightbox close (6666.7 ms) fall between frames, but neither starts an animation: the dropped window stays put, and the Photos layout jumps back to the grid without springs, so neither shows at shared timestamps. The next section moves presses off the frame grid. The 500 ms stall starts right after a retarget in the middle of the Photos restore animation; the 2 s stall starts during the close animation of Files.

| Variant | Compared with 120 fps | Shared frames | Max position difference (px) | Frames with different focus, stack, flags | Frames with different animationActive |
| --- | --- | ---: | ---: | ---: | ---: |
| bank, deferred retarget | 10 fps | 111 | 0.0030 | 0 | 0 |
| bank, deferred retarget | 30 fps | 331 | 0.0030 | 0 | 0 |
| bank, deferred retarget | 60 fps | 661 | 0.00043 | 0 | 0 |
| bank, deferred retarget | 60 fps, 500 ms stall | 631 | 0.00043 | 0 | 0 |
| bank, deferred retarget | 60 fps, 2 s stall | 541 | 0.00043 | 0 | 0 |
| bank, doctrine retarget | 10 fps | 111 | 513 | 0 | 3 |
| bank, doctrine retarget | 30 fps | 331 | 157 | 0 | 3 |
| bank, doctrine retarget | 60 fps | 661 | 57 | 0 | 2 |
| original window-manager.ts | 10 fps | 111 | 318 | 0 | 40 |
| original window-manager.ts | 30 fps | 331 | 183 | 0 | 4 |
| original window-manager.ts | 60 fps | 661 | 72 | 0 | 5 |
| original window-manager.ts | 60 fps, 500 ms stall | 631 | 401 | 0 | 33 |
| original window-manager.ts | 60 fps, 2 s stall | 541 | 311 | 0 | 36 |

The source-matrix variant gives the same numbers as split-table.

When animations end (first frame with `animationActive = 0`):

| Run | Bank, deferred retarget | Original |
| --- | --- | --- |
| 120 fps | 983, 3292, 5667, 7583 ms | 950, 3250, 5633, 7550 ms |
| 10 fps | 1000, 3300, 5700, 7600 ms | 2000, 4400, 6600, 8600 ms |
| 30 fps | 1000, 3300, 5667, 7600 ms | 933, 3233, 5600, 7533 ms |
| 60 fps, 500 ms stall | 983, 3300, 5667, 7583 ms | 967, 3750, 5650, 7567 ms |
| 60 fps, 2 s stall | 983, 3300, 5667, 9017 ms | 967, 3283, 5650, 9550 ms |

With the bank, each end time is the first frame at or after the 120 fps end time. The original clamps every frame at 32 ms and splits it into 4 substeps, so at 10 fps it simulates 32 ms per 100 ms frame and every animation ends about a second late, and a 500 ms stall delays the end by 500 ms. The 300-step cap never visibly binds in IndirectOS: its springs settle in about 0.6 s, so the first frame after a 2 s stall runs 300 steps and finishes the animation.

Why doctrine retargeting diverges: a frame first sets new destinations, then runs catch-up steps that simulate the time since the previous frame. Those steps already pull toward the new destination, so the effective input time is the previous frame's time: 8 ms early at 120 fps, 100 ms early at 10 fps. Deferred retargeting steps toward last frame's destination and applies the new one from this frame's time, within the 4 ms leftover. This frame's time is the press's time at every rate only because the presses sit on shared frame times. When the clock was stopped because nothing was animating, both timings run zero steps in the first frame after a press, so the animation starts at that frame's time.

With a live resize of Photos (thumbnail destinations change at every pointer move during the drag, and the moves fall between frames), the bank differs from 120 fps by 13.9 px at 10 fps, 3.9 px at 30 fps, and 1.3 px at 60 fps, all during the resize: each rate applies the moves at its own frame times, so the springs chase a different sequence of destinations. With event-time evaluations (next section), the same trace agrees within 0.0091 px at every rate, with 0 frames of different animationActive. The original differs by 318, 183, and 72 px.

### Presses between frames

`offsetPresses` moves each press, with the pointer moves and release that follow it, off the 30 fps grid. The report runs five traces: every event 1 ms later; random offsets in 0..30 ms with seeds 7 and 99; and the live resize trace with random offsets, seeds 7 and 99. The table shows the max position difference from 120 fps at shared timestamps, worst over the five traces, with mismatch frames summed over all five traces and four rates:

| Variant | 10 fps (px) | 30 fps (px) | 60 fps (px) | 60 fps, 500 ms stall (px) | Frames with different animationActive | Frames with different focus, stack, flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bank, deferred retarget | 514 | 193 | 57.7 | 696 | 174 | 0 |
| bank, doctrine retarget | 505 | 168 | 57.7 | 57.7 | 24 | 0 |
| original window-manager.ts | 357 | 181 | 71.8 | 504 | 409 | 0 |
| bank, deferred retarget, event-time evaluations | 0.0043 | 0.0042 | 0.0051 | 0.0051 | 2 | 0 |
| bank, doctrine retarget, event-time evaluations | 77.9 | 124 | 56.0 | 43.8 | 12 | 0 |
| original window-manager.ts, event-time evaluations | 351 | 183 | 66.9 | 499 | 379 | 0 |

Without extra evaluations, deferred retargeting diverges as much as doctrine retargeting: on the 1 ms trace both differ by 505 px at 10 fps, 168 px at 30 fps, and 57.7 px at 60 fps. A frame applies every press that arrived since the previous frame, so the frame's time, not the press's time, decides when a new destination starts pulling. The largest differences come from animations that start from rest. The clock is stopped, the first frame after the press runs zero steps, and the animation starts at that frame's time: e.g. a Photos maximize pressed at 2501 ms starts animating at 2600 ms at 10 fps and at 2508.3 ms at 120 fps. With deferred timing, a press that arrives during the 500 ms stall applies only after the stall (696 px). Doctrine timing happens to do better there: its catch-up steps after the stall pull toward the new destination from the frame just before the stall, which is close to the press's time.

Event-time evaluations: JS evaluates the circuit once more at each event's timestamp and writes the next-source outputs back without rendering. Events that share a timestamp share one evaluation. With deferred retargeting, the steps up to the event pull toward the old destination, the new destination applies from the event's time within the 4 ms leftover, and an animation that starts from rest starts at the event's time. Every rate then agrees within 0.0051 px, also with the stall. The 2 frames of different animationActive are one frame at 60 fps and one at 60 fps with the stall, both in the live resize trace with seed 99, where a box's settle bit flipped in a different frame. Doctrine timing doesn't gain as much: an extra evaluation's steps already pull toward the new destination, so the effective input time is the previous evaluation's time. On the 1 ms trace, that previous evaluation is the same 30 fps frame at every rate, so doctrine timing agrees there (0.0028 px), but not with random offsets. The original's 32 ms frame clamp and substeps stay frame-rate dependent either way.

### Depth diet: where Photos reads its window size

Photos is inlined after the window springs, so this frame's animated window size puts its whole circuit on top of the window manager's depth.

| Photos reads | Layers (bank split-table) | Max Photos difference from current-frame reads (px) | During the live resize (px) | Frames differing by more than 0.001 px |
| --- | ---: | ---: | ---: | ---: |
| current-frame (the original wiring) | 137 | 0 | 0 | 0 |
| previous-frame: last frame's spring state and presence | 91 | 85.7 | 6.6 | 85 of 541 |
| stepped-springs: this frame's stepped window springs before snapping, presence from last frame | 91 | 6.6 | 6.6 | 41 of 541 |

Reading the previous frame is visible. During the maximize animation the window width changes by up to 114 px between two 60 fps frames, and Photos lays out for last frame's size, up to 86 px off. With deferred retargeting, the window springs' stepped positions depend only on source cells and the frame matrix, so they sit early in the circuit. They differ from the output position only while the box snaps. Photos reading them matches the current-frame layout within 0.05 px along the default trace. It lags only during a live resize, by that frame's resize delta (6.6 px here), and the thumbnails then settle from slightly different states. Presence still comes from last frame, which would show as a one-frame opacity delay when Photos opens or closes; the trace never does that.

### Predictive keyframes

Five boxes with 3 lanes each (x and y with stiffness 290 and damping 24, scale with stiffness 333 and damping 12), predicting 301 samples of 4 ms, i.e. 1,200 ms ahead:

| Prediction | Live operations | Layers | Stored weights | µs per sample |
| --- | ---: | ---: | ---: | ---: |
| 301 separate evaluations, split-table | 467 | 22 | 1,436 | 5.9 |
| 301 separate evaluations, binary-powers | 617 | 27 | 1,564 | 8.0 |
| 301 separate evaluations, source-matrix | 280 | 9 | 840 | 3.9 |
| one batched evaluation of all 301 samples | 31,620 | 7 | 102,295 | 2.0 |
| plain JS loop carrying state, for context | | | | 0.87 |
| the whole IndirectOS bank circuit per sample, for scale | 3,580 | 137 | 8,447 | 47 |

Separate predictions match float64 stepping within 1e-3 px, and the batched circuit matches the separate predictions within 1e-3 px. Each sample's settle check runs independently, so a box could in principle snap at sample i and leave its destination at sample i + 1. That happened 0 times in the demo scene. In the batched circuit every sample's step count is a build-time constant, so its frame matrix is a constant too, and each predicted position is an affine row over (displacement, velocity) plus the box's settle snap: shallow, but 102k stored weights.

## What this shows about how far the approach goes

### What fit well

- Animation was 59% of IndirectOS and behaved like a loop; as a matmul it behaves like one shared matrix. The step count becomes 33 exact threshold bits in 13 layers, the frame matrix is two constant table reads and one 2x2 product, and every lane is four exact products. IndirectOS goes from 5,253 to 3,580 live operations (32% fewer) and from 11,598 to 8,447 stored weights (27% fewer). The window spring builders go from 1,240 to 523 operations, and the thumbnail spring builders from 1,116 to 468.
- vibescript's timing semantics compose with the circuit: fixed 4 ms steps, carried leftover time, the 300-step cap, a clock that starts over after idle, and per-box snapping. With deferred retargeting, when every compared rate applies each press in a frame at the press's own time, 10 to 120 fps and 500 ms and 2 s stalls agree within 0.003 px at shared timestamps, with identical settle bits; the original differs by up to 401 px. When presses fall between frames, deferred retargeting alone diverges like doctrine retargeting, but one extra evaluation at each event's timestamp restores the agreement: within 0.0051 px over five traces with presses between frames, including a live resize, with 2 frames of different settle bits. The original differs by up to 504 px there.
- Settling stays exact. One boolean per box decides for all its lanes, and settled lanes equal their destination bit for bit. The standalone bank matches float64 Euler loops within 1.85e-4 px per frame, and within 4.4e-4 px over 3,000 free-running frames while both sides animate.
- Springs take a much smaller share of the depth. Spring operations went from 74 of the deepest path's 193 operations (41 window, 33 thumbnail) to 15 of 138 (7 and 8). Deferred retargeting also makes stepped positions available early, which let Photos read this frame's animated window size early in the circuit (91 layers instead of 137) without the visible lag of reading last frame's values.
- Stiffness and damping can stay editable without loops. `source-table` keeps the clock in the circuit and reads JS-written tables with 8 gathers (4 more operations than constant tables). `source-matrix` moves the clock to JS and is the smallest bank (3,413 operations).
- Predictions as independent evaluations work as Animation.md hoped: sample i is the circuit at step count i, 5.9 µs per sample serially in the last run, and the batched form runs all 301 samples in one 7-layer evaluation.
- A copy with `springs: 'original'` rebuilds the original circuit bit for bit. Appending new cells after the original layout let one file hold both versions, so the comparison isolates the springs.

### What got awkward

- The doctrine's own retarget timing isn't frame-rate independent when a destination changes during an animation: the new destination pulls from the previous frame's time. Fixing that needed one previous-destination cell per lane (44 cells in IndirectOS, 252 more stored weights), a semantic choice the doctrine doesn't state, and the event-time evaluations of the next point.
- Frame-rate independence needs every event applied at its own timestamp, not only live resizes. Every retarget, and every animation that starts from rest, starts pulling at the time of the frame that applies the event. With every event 1 ms after a 30 fps frame, deferred retargeting alone differs from 120 fps by 505 px at 10 fps and 168 px at 30 fps, as much as doctrine retargeting. The fix measured here is one extra circuit evaluation per distinct event timestamp, run by JS without rendering. It costs one evaluation per event, e.g. 60 extra evaluations for a 300 ms drag with a pointer move every 5 ms, and it needs JS to keep each event's timestamp. In a browser, pointer moves between frames would likely need `getCoalescedEvents()`. The browser page doesn't do this yet.
- Exact threshold bits need frame deltas on a grid. JS rounds timestamps to 1/64 ms, and each delta and the carried leftover are clamped to 65,536 ms so every sum stays exact in FP32.
- Constant tables fix stiffness and damping at build time. Keeping them editable either moves 140 table cells into the source table or moves the clock to JS.
- Settle bits depend on which step counts a frame lands on. A spring can have both |x| and |v| below threshold at one step and |v| above it a few steps later, because position converts into velocity. Along the default trace, settle bits agreed at every shared timestamp, but nothing guarantees it. With the live resize and no event-time evaluations, 1 shared frame at 10 fps and 1 at 30 fps disagreed, after springs had chased different destination sequences. With event-time evaluations and presses between frames, 2 frames disagreed over five traces. The free-running float64 comparison shows the same effect at the FP32 level: 10 frames (deferred) and 3 frames (doctrine) of 3,000.
- The batched prediction circuit is wide: 31,620 operations and 102,295 stored weights for 15 lanes. On the CPU it's about 3 times faster per sample than separate evaluations and about 2.3 times slower than a plain JS loop.
- The remaining 123 operations of the deepest path are discrete logic: hit tests, frontmost selection over the stack permutation, press routing, drag geometry, targets, and Photos. Further depth cuts have to restructure those, since springs now account for 15 operations of the path.
- The bank only covers linear springs whose lanes don't interact. Repulsion, collisions, or springs whose stiffness depends on state don't collapse into one matrix.
- A few smaller things: settled velocities can be -0; the evaluation time moved much less than the operation count (53 µs to 44 µs in the last run), probably because the executor's per-layer overhead dominates at this size; the JavaScriptCore stack trace leaves out frames, so attributing operations needed recorded op-index ranges instead of stack traces.

### What stayed outside the circuit

- Absolute timestamps. JS keeps requestAnimationFrame times and event timestamps in float64, rounds them to 1/64 ms, clamps, and writes only the delta. With event-time evaluations, JS also decides when to evaluate the circuit between frames.
- With `source-matrix`, counting steps and computing M^steps. With `source-table`, recomputing tables when stiffness or damping change.
- The prediction loop over 301 samples, keyframe strings, cancelling and starting Web Animations, and the 300 ms render schedule.
- Random fling destinations (32-bit hashing in JS at event time) and the demo's frame pacing and stall button.

## Open questions and next steps

- Event-time stepping inside one evaluation. The extra evaluation per event works in replay. Splitting a frame's steps at a latched event timestamp (two table reads per group and 8 products per lane) would avoid the extra evaluation for one event per frame, but the steps after the event need this frame's destination, which puts stepping after the destination logic again. Also try event-time evaluations in the browser page, with `getCoalescedEvents()` for pointer moves.
- Settling at fixed simulated times. Check the settle condition at multiples of, e.g., 64 ms of simulated time instead of at frame boundaries, so settle bits no longer depend on the frame rate.
- Exact per-step matrices. Tables of e^(A * 4 ms) instead of Euler powers would sample the closed-form spring at every 4 ms, which phase 1 measured to 1e-4 px, with the same clock and tables.
- The same clock for other linear time-invariant motion: exponential decay and Apple-style scroll momentum are scalar tables read by the same one-hot bits.
- Scale. chenglou.github.io's gallery has 222 boxes with 6 springs each. Phase 1 measured 40,243 operations with per-spring snapping; per-box snapping should cut that substantially.
- An executor with an instance axis. Every lane in a group applies the same 2x2 block, which is exactly what a batched or GPU executor runs well, for frames and for predictions.
- The remaining depth. Try a balanced frontmost selection and reading focus for Photos from stepped state, to see how far below 91 layers IndirectOS can go.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/spring-bank/demo.html lab/ui-exploration/spring-bank/indirect-os.html`, which serves the two pages at `/demo` and `/indirect-os`.

- Both pages load with no console errors.
- `demo.html`: clicking flings the five boxes to new places, and each box gets a 1,200 ms Web Animation with 301 keyframes. Both prediction modes work. The status line showed 9.3 to 29.6 µs per sample for 301 separate evaluations and 3.3 to 6.0 µs per sample for one batched evaluation. It lists the bank at 467 live ops, 22 layers and 1,436 weights, and the batch at 31,620 live ops, 7 layers and 102,295 weights, as in the predictive keyframes table.
- `indirect-os.html`: minimizing Photos, restoring it from the dock, dragging Notes by its title bar, maximizing Photos, opening a photo into the lightbox, pressing "stall 500 ms" while the lightbox opened, and switching to 10 fps all worked. The System Monitor showed 3,580 activations, 137 layers and 8,447 sparse weights with bank springs, and 5,253 activations, 192 layers and 11,598 sparse weights with `?springs=original`, matching the size table above. Its "frame execution" row showed 16.7 ms on the first frame after load, then between 0.4 and 3.2 ms.
- The Chrome window was in the background during the check, so I didn't judge by eye whether motion looks the same at display rate, 30 fps and 10 fps.
- No fixes were needed.
