# Event time: commit per event, sample per frame, predict until the next event

## What it is and how to run it

In IndirectOS today, one frame is one evaluation at one time: the frame both computes what's on screen and writes the next state back. This prototype separates the two. State is written back only by commit evaluations, which run at each event's timestamp and at settle times derived from the committed state. What's on screen comes from display evaluations, which run from the last committed table with the time since that commit, and discard their next-source outputs. Because no frame ever writes state, the committed tables are the same bits at 10 fps, 240 fps, and through 500 ms and 2 s stalls, and so is everything displayed at a shared timestamp. The prototype then treats time as an instance axis: from a commit, all 301 fixed 4 ms samples until the 300-step cap are instances of one program, where instance i holds M^i in the 4 spring-matrix cells. Those samples become Web Animations keyframes. In a model of how those animations play, transform and opacity keep playing while the main thread is blocked, and width, height and z-index wait for it.

Run from the repo root:

- `bun test lab/ui-exploration/event-time` runs 10 tests in about 3 to 5 s.
- `bunx tsgo -p lab/ui-exploration/event-time` typechecks the folder.
- `bun lab/ui-exploration/event-time/report.ts` prints every table below and writes `results.json`. It took 45 s, 106 s and 45 s in three runs on the shared machine.
- `deno run --unstable-webgpu --allow-all lab/ui-exploration/event-time/gpu-prediction.ts` runs the per-sample shader through wgpu. `DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/event-time/gpu-prediction.ts` runs it through Dawn (install `webgpu@0.6.1` in any folder outside the repo, as codegen's README describes; I used phase 2's install in the scratchpad). The saved outputs are `gpu-results-wgpu.json` and `gpu-results-dawn.json`. This script needs Deno or Node, since Bun has no WebGPU, but it typechecks with the rest of the folder, so it stays in `tsconfig.json`.
- `bun lab/ui-exploration/event-time/demo.html` serves the demo: IndirectOS committed per event, with predicted keyframes (`?presenter=keyframes`, the default) or display evaluations in requestAnimationFrame (`?presenter=frames`), a button that blocks the main thread for 500 ms, and a button that blocks it for 500 ms once the next animation starts. I checked that `demo.ts` bundles with `bun build`, but I haven't opened the page in a browser.

The folder imports `numeric-ui-core.ts` unchanged. It imports spring-bank's IndirectOS (`window-manager.ts`, `photo-gallery.ts`, `spring-bank.ts`, `spring-math.ts`, `trace.ts`) and codegen's backends (`codegen.ts`, `instance.ts`, `wgsl.ts`, `wgsl-interpreter.ts`, `gpu-runner.ts`) from their folders. Until September 15, 2026 this folder held its own copies of those files, and the measurements below ran on those copies. The copies differed from the originals only by `export` keywords on `writeBankFrame`, `validateWindowManagerSource` and `validateWindowManagerOutput` in `window-manager.ts`, and on `photoNames` in `photo-gallery.ts`, each marked with a `// (event-time copy: ...)` comment. Building the prototype changed nothing outside this folder. On September 15, 2026 spring-bank's files gained those 4 `export` keywords, without the comments, so that this folder could import them.

## What was built

Vocabulary used below:

- A commit is an evaluation that consumes latched events and writes next-source back, e.g. at the timestamp of a press on Files' minimize button.
- A display is an evaluation at a frame's timestamp from the last committed table. It writes nothing back.
- A settle commit is a commit at a simulated time after an event, which writes the springs' settled state into the table without depending on frames.
- A prediction is all 301 samples from one commit: sample i is what a display shows i fixed 4 ms steps after the commit's simulated time.
- The settle step of a prediction is the first step count in 16, 32, ..., 288 whose sample reports that nothing animates.

Files:

- `event-machine.ts`: the machine. It builds spring-bank's bank IndirectOS with deferred retargeting and either `split-table` springs (the clock in the circuit) or `source-matrix` springs (JS counts steps and writes M^steps into 4 cells). `commit(time)` writes the clock for the time since the last commit, evaluates, and writes next-source back. `display(time)` copies the committed table into a scratch table, writes the clock there, and evaluates. With `evaluator: 'generated'`, commits run codegen's generated JS over a program compiled with only the next-source roots, and displays run a program compiled with only the projection roots. `snapshot()` and `restore()` copy the committed table.
- `commits.ts`: when to commit, and a replay.
  - Settle policies. `'interval'`: while the committed clock runs, commit again 1,200 ms after the last commit (the 300-step cap). `'predicted'`: while the committed clock runs, find the settle step s from the committed table and commit at `lastCommit - leftover + 4 ms × s`, the simulated time of that step. When no checked step settles, commit 1,200 ms later. `sequentialSettleProbe` finds s with up to 18 displays; a prediction finds it from its samples.
  - `createCommitter` runs the schedule: events that share a timestamp share one commit, settle commits strictly before an event run before the event's commit, and an event commit at a settle time replaces that settle commit. Settle commits are derived from the last event commit, so when an event arrives with a timestamp at or before settle commits that already ran, e.g. a browser delivers a pointer event after a timer task ran a settle commit, the committer restores the table saved after the last event commit and redoes the settle commits that come before the event. An event with a timestamp before the last event commit can't be undone this way: it's committed with zero elapsed time and counted in `lateEvents`. The replays deliver events in timestamp order.
  - `replayCommitPerEvent` mounts at time 0, commits at every distinct event timestamp and at settle times, and displays at every frame time. It also returns the settle commit still scheduled at the end. `compareCommitLogs` compares committed tables bit for bit; `compareDisplays` compares displays at shared timestamps.
  - `coalescePointerMoves` keeps the last pointer move within each 1000 / hz ms bucket.
- `prediction.ts`: time as an instance axis. codegen's `planInstances` splits the display program into rows that depend on the 4 spring-matrix cells, computed once per sample, and rows that don't, computed once per prediction. JS writes M^0..M^300 into a per-instance table once per stiffness and damping. `predict()` returns the samples, the settle step, and the simulated time of sample 0. `sampleIndexAt(prediction, time)` gives the sample on screen at a time: the display's step count, snapped at the settle step.
- `keyframes.ts`: turns a prediction into Web Animations keyframes, one keyframe per sample until the settle step, `easing: steps(n, end)`, `fill: 'forwards'`, and the animation's `startTime` set half a clock grid step (1/128 ms) before the prediction's simulated time of sample 0. Displays round frame times to the nearest 1/64 ms, so a display switches to sample i 1/128 ms before the sample boundary, and the shift makes Web Animations switch at the same times. Each element gets up to two animations. Chrome runs an animation on the compositor only when every property in it can be composited, which transform and opacity can and width, height and z-index can't, so keeping them apart lets motion and fades play while the main thread is blocked. An element whose samples are all bit-identical gets a style write instead of an animation. `keyframeIntervalAt` evaluates the timing `demo.ts` passes to `element.animate()` with the Web Animations Level 1 timing model and CSS `steps()` easing in doubles, and `readStyle` parses the numbers back out of the keyframe strings.
- `playback.ts`: models of what's on screen, for comparisons. Predicted keyframes: JS commits and predicts at event and settle times and starts the animations `demo.ts` starts, and the screen at each time is what the emitted keyframe lists and underlying styles show, read back from their strings. During a stall JS doesn't run, so events inside a stall are committed at their own timestamps once the stall ends. Only composited animations advance during a stall, and only the ones the last main-thread frame before the stall sent to the compositor. Everything else, including width, height and z-index, shows the last main-thread frame until the stall ends. Display frames: the screen holds the last rendered frame.
- `springs-check.ts`: float64 references. Commits use spring-bank's `createWindowSpringCheck`. Displays step every window lane from the committed table with plain float64 Euler loops, toward the destinations and snap bits the display computed, and compare with the display's stepped spring state.
- `demo-model.ts`, `demo.ts`, `demo.html`: the page. `demo-model.ts` holds the scene (commit per event, one prediction and one keyframe plan per commit); `demo.ts` only reads plans and writes styles, starts animations, sets a timer for the settle commit, and commits each coalesced pointer move at its own `timeStamp`.
- `gpu-prediction.ts`: the per-sample program as WGSL through codegen's emitter, on wgpu and Dawn.
- `event-time.test.ts`, `report.ts`, `results.json`.

## Measured results

Counts are exact. Timings are rough: many agents share this machine, and the report runs differed by about 2 times in µs per evaluation. `results.json` holds the third run. The traces are spring-bank's IndirectOS trace (minimize, restore mid-animation, drag, maximize, restore mid-animation, open a photo, next twice, close the lightbox, close a window) and its live resize variant (Photos resized by hand with 60 pointer moves every 5 ms), with presses on 30 fps frame times, every event moved 1 ms later, or presses moved by random offsets in 0..30 ms with seeds 7 and 99. Every trace runs for 11 s.

### What a commit needs and what a display needs

| Variant | All roots: live ops / layers / weights | Commit roots (next-source) | Display roots (projections) | Display rows that depend on event latches | Display rows that depend on event coordinates | Display rows that depend on the clock | Next-source cells copied through unchanged |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| split-table, Photos reads current frame | 3,580 / 137 / 8,447 | 3,213 / 133 / 7,697 | 3,523 / 137 / 8,303 | 2,208 | 2,625 | 2,170 | 178 of 392 |
| source-matrix, Photos reads current frame | 3,413 / 137 / 8,011 | 3,046 / 133 / 7,261 | 3,360 / 137 / 7,905 | 2,208 | 2,625 | 2,007 | 179 of 392 |
| source-matrix, Photos reads previous frame | 3,415 / 91 / 8,016 | 3,034 / 87 / 7,241 | 3,362 / 91 / 7,910 | 1,693 | 2,510 | 1,190 | 179 of 392 |
| source-matrix, Photos reads stepped springs | 3,416 / 91 / 8,019 | 3,035 / 87 / 7,244 | 3,363 / 91 / 7,913 | 1,693 | 2,510 | 1,998 | 179 of 392 |

A row depends on a cell when it reads the cell directly or through other rows. "Event latches" are the pointer down, move and up latches and the Photos click, previous, next and close latches; "event coordinates" are the pointer and Photos click coordinates; "the clock" is the frame delta cell with split-table springs, or the 4 spring-matrix cells with source-matrix springs. A commit program drops about 370 of 3,413 operations, and a display program drops about 50. Most of the circuit is needed by both: destinations depend on events, springs step toward destinations, and projections read springs. On a display the event latches are always 0: along the live resize trace (seed 7), 0 of 138 commits left a nonzero latch in the written-back table. Yet 2,208 of the 3,360 display rows depend on a latch, e.g. hit tests of the last press coordinates that a zero latch then masks. The coordinates keep the last event's values (137 of the 138 commits left nonzero coordinates), so the 430 display rows that depend on coordinates but not on latches compute with real values on every display.

### Committed state across frame rates

Each of the 6 traces and 4 variants (source-matrix or split-table springs, predicted or interval settle commits) was replayed at 240 fps and compared with 7 other schedules: 10, 30, 60 and 120 fps, 60 fps with a 500 ms stall at 2,701 ms, 60 fps with a 2 s stall at 7,001 ms, and 240 fps with the 500 ms stall.

| Trace | Commits (event + settle + mount), predicted settle | Interval settle | Schedules with a different commit sequence | Commits whose table differs in any bit | Shared display frames | Display frames with any different bit |
| --- | --- | --- | ---: | ---: | --- | ---: |
| presses on 30 fps frames | 76 (71 + 4 + 1) | 75 (71 + 3 + 1) | 0 | 0 | 6,117 per variant | 0 |
| every event 1 ms later | 76 | 75 | 0 | 0 | 6,117 per variant | 0 |
| random press offsets, seeds 7 and 99 | 76 | 75 | 0 | 0 | 6,117 per variant | 0 |
| live resize, random press offsets, seeds 7 and 99 | 138 (133 + 4 + 1) | 136 (133 + 2 + 1) | 0 | 0 | 6,117 per variant | 0 |

That's 168 comparisons with 0 differing bits in committed tables and 0 in displayed outputs at shared timestamps. The tests check the same for 10, 30 and 60 fps with both stalls, and for the validating executor against generated JS.

For contrast, spring-bank's model, where every frame writes back and JS adds an evaluation at each event timestamp, compared the same way (source-matrix springs):

| Trace | Shared frames | Frames whose written-back table differs in any bit | Most differing cells in one frame | Max position and size difference (px) | Frames with different animationActive |
| --- | ---: | ---: | ---: | ---: | ---: |
| presses on 30 fps frames | 6,117 | 922 | 46 | 0.0030 | 1 |
| every event 1 ms later | 6,117 | 918 | 46 | 0.0032 | 1 |
| random press offsets, seed 7 | 6,117 | 917 | 47 | 0.00052 | 1 |
| random press offsets, seed 99 | 6,117 | 929 | 45 | 0.0051 | 6 |
| live resize, seed 7 | 6,117 | 1,063 | 47 | 0.0093 | 2 |
| live resize, seed 99 | 6,117 | 1,081 | 45 | 0.0043 | 9 |

So that model was already close (within 0.0093 px), but 15% to 18% of shared frames hold different bits, and settle bits flip in different frames: in the live resize with seed 99, window 0's opacity is 0 at 7,600 ms at 240 fps and 1 at 10, 30, 60 and 120 fps, at the end of Files' close animation.

### Commits while idle, and cost per commit

| Trace | Distinct event timestamps | Commits in 11 s, predicted / interval settle | Settle commits after the last event | Last commit (ms), predicted / interval | Settle commit still scheduled when the trace ends (11,000 ms) | Displays at 60 fps that report animating |
| --- | ---: | --- | ---: | --- | --- | ---: |
| presses on 30 fps frames | 71 | 76 / 75 | 1 | 7,640 / 8,200 | none | 170 |
| random press offsets, seed 7 | 71 | 76 / 75 | 1 | 7,669.5 / 8,229.5 | none | 168 |
| live resize, seed 7 | 133 | 138 / 136 | 1 | 7,669.2 / 8,229.2 | none | 194 |

There is one commit per distinct event timestamp, plus a settle commit whenever an animation outlives the last event before it. After the last settle commit, the committed clock is stopped and the committer has no settle commit scheduled, so no further commit would run however long the page stays idle. The committer never schedules a commit while the committed clock is stopped; a page only needs displays while something is moving.

µs per call over the live resize trace with seed 7, 14 replays each, median of the last 7:

| Pointer moves | Evaluator | Springs | Commits per replay | µs per commit, run 1 / run 2 / run 3 | µs per display (60 fps), run 1 / run 2 / run 3 |
| --- | --- | --- | ---: | --- | --- |
| every 5 ms (138 events) | executor | split-table | 136 | 30 / 61 / 30 | 30 / 61 / 31 |
| every 5 ms | executor | source-matrix | 136 | 29 / 58 / 28 | 30 / 57 / 29 |
| every 5 ms | generated JS | split-table | 136 | 9.2 / 22.5 / 8.9 | 9.1 / 22.4 / 8.9 |
| every 5 ms | generated JS | source-matrix | 136 | 8.0 / 19.1 / 8.2 | 8.5 / 18.8 / 8.8 |
| coalesced to 120 Hz (92 events) | generated JS | split-table | 90 | 8.7 / 20.0 / 9.4 | 8.7 / 20.4 / 8.9 |
| coalesced to 120 Hz | generated JS | source-matrix | 90 | 8.4 / 18.6 / 8.5 | 8.5 / 19.8 / 9.1 |

A commit runs the same circuit a frame ran, plus copying 392 cells back, so it costs about what a frame did. Generated JS runs about 3 times faster than the executor in every run; codegen measured 3.3 µs after seconds of warmup, and these replays run only about 11,000 evaluations per variant.

### Which outputs only make sense on displays

At each of the 133 event commits of the live resize trace (seed 7), I compared every projection the commit evaluation computed with a display at the same timestamp from the written-back table. Only one output ever differed: thumbnail left, in 58 of 133 commits, by at most 6.1e-5 px, probably because the display re-derives each thumbnail's displacement from its written-back position. Everything else, including focus, stacking, the animation bit, and every window position, was bit-identical. So no output means something different on the two kinds of evaluation; what separates them is who reads the result:

- Next-source cells are only read after commits. A display discards them.
- Projections (window translate, size, scale, opacity, z-index, focus and maximized flags, dock geometry, photos, thumbnails, controls) are only read after displays. A commit computes them and throws them away, which is why the generated commit program is compiled with next-source roots only.
- `animationActive` is read after both, for different reasons. After a commit it becomes the clock's running cell and decides whether a settle commit is scheduled. After a display it decides whether the page asks for another frame.
- The event latches are read by both programs, but on a display they're always 0, so the 2,208 display rows that depend on a latch see "no event" on every display. The event coordinates keep the last event's values.

### Float64 doctrine springs

| Trace | Springs | Commits that step | Commits: max position error (px) | Displays at 60 fps | Displays: max position error (px) | Displays: max velocity error (px/s) | Settle bit mismatches (commits, displays) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| every event 1 ms later | split-table | 7 | 3.7e-5 | 661 | 1.1e-4 | 4.5e-4 | 0, 0 |
| every event 1 ms later | source-matrix | 7 | 3.7e-5 | 661 | 1.1e-4 | 4.5e-4 | 0, 0 |
| live resize, seed 7 | split-table | 69 | 3.7e-5 | 661 | 8.4e-5 | 6.8e-4 | 0, 0 |
| live resize, seed 7 | source-matrix | 69 | 3.7e-5 | 661 | 5.1e-5 | 5.7e-4 | 0, 0 |

Every window lane of every commit and display is within 1.2e-4 px of plain float64 Euler loops started from the committed FP32 state, with 0 settle bit mismatches.

### Time as an instance axis

Along the live resize trace (seed 7), at every commit that leaves the clock running, the prediction's 301 samples were compared with 301 separate display evaluations of the whole display program:

| Photos reads | Display program: live ops / layers | Per-sample rows / layers / weights | Shared rows | Predictions checked | Values checked | Mismatches | Settle steps seen | ms per prediction, run 1 / run 2 / run 3 | ms for 301 generated displays, run 1 / run 2 / run 3 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| current frame | 3,360 / 137 | 2,007 / 80 / 4,956 | 1,353 | 69 | 4,735,332 | 0 | 112×31, 128×27, 80×3, 160×5, 144×2, 96×1 | 0.55 / 1.13 / 0.54 | 0.71 / 1.64 / 0.80 |
| previous frame | 3,362 / 91 | 1,190 / 25 / 3,074 | 2,172 | 69 | 4,735,332 | 0 | none×60, 160×5, 144×2, 96×1, 112×1 | 0.37 / 0.76 / 0.36 | 0.65 / 1.51 / 0.60 |
| stepped springs | 3,363 / 91 | 1,998 / 68 / 4,940 | 1,365 | 69 | 4,735,332 | 0 | none×60, 160×5, 144×2, 96×1, 112×1 | 0.54 / 1.21 / 0.53 | 0.63 / 2.06 / 0.69 |

In all 207 predictions, the settle step equals what `sequentialSettleProbe` finds with separate displays. Each sample checks settling on its own, so the circuit's animation bit isn't monotone over samples: with current-frame reads, 12 samples after a settle step reported animating again, at most 0.00104 px from the settle sample. spring-bank's README describes why: a lane can be within both thresholds at one step and above the speed threshold a few steps later, as position converts into velocity. Snapping every later sample to the settle sample, and committing at the settle step's simulated time, makes displays and keyframes agree, since after the settle commit the committed table itself is settled.

With early Photos reads, 60 of the 69 predictions never settle within 288 steps, and all 60 come from the commits at the live resize's 60 pointer moves (5,340 to 5,635 ms). A commit computes Photos' layout from the window size before its own resize move and writes those thumbnail destinations back. A display from that commit computes the layout from the new size, so each thumbnail steps toward the old destination while its settle check compares with the new one. The next commit fixes it, which during a live resize is 5 ms later. The visible cost of early reads changes too:

| Photos reads | Model | Max Photos difference from current-frame reads (px) | At (ms) | Frames differing by more than 0.001 px (of 2,641 at 240 fps) |
| --- | --- | ---: | ---: | ---: |
| previous frame | commit per event | 507 | 3,013 | 334 |
| previous frame | frames write back at 240 fps | 35.7 | 2,596 | 315 |
| stepped springs | commit per event | 1.69 | 5,625 | 140 |
| stepped springs | frames write back at 240 fps | 0.99 | 5,613 | 158 |

When displays never write back, "the previous evaluation" a display reads is the last commit, which can be hundreds of milliseconds old during an animation, so reading last state for Photos during the maximize and restore animations is 507 px off. Reading this evaluation's stepped springs only lags while the window is resized by hand, by up to 1.69 px.

### Predicted keyframes and stalls

`playback.ts` models what the page's Web Animations show at every 240 fps timestamp: it builds the keyframe lists and timing that `demo.ts` passes to `element.animate()`, evaluates them with the Web Animations timing model and `steps(n, end)` easing, and parses the numbers back out of the keyframe strings. The screens are compared with 240 fps display evaluations. During a stall, only composited animations (transform and opacity) advance, and only the ones the last main-thread frame before the stall sent to the compositor; width, height, z-index and everything else show the last main-thread frame. The stale interval runs from the first event after the last main-thread frame before a stall until the stall ends. JS may commit that event before the stall begins, e.g. the press at 2,701 ms in "every event 1 ms later", right after the frame at 2,700 ms, but the animations it starts reach the compositor only with the next main-thread frame, after the stall.

| Trace | Stall | Stale interval (ms) | Transform and opacity: frames with any different bit outside the stale interval (of 2,641) | Transform and opacity inside the stale interval: frames, max px | Width, height, z-index: frames with any different bit (all inside the stall) | Width and height: max px | All outputs outside the stall: frames with any different bit |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: |
| presses on 30 fps frames | none | none | 0 | none | 0 | 0 | 0 |
| presses on 30 fps frames | 500 ms at 2,701 ms | none | 0 | none | 120 | 688 | 0 |
| presses on 30 fps frames | 2 s at 7,001 ms | none | 0 | none | 341 | 0 (z-index only) | 0 |
| every event 1 ms later | none | none | 0 | none | 0 | 0 | 0 |
| every event 1 ms later | 500 ms at 2,701 ms | 2,701..3,201 | 0 | 120, 696 | 120 | 687 | 0 |
| every event 1 ms later | 2 s at 7,001 ms | 7,001..9,001 | 0 | 479, 538 | 480 | 0 (z-index only) | 0 |
| random press offsets, seed 7 | 500 ms at 2,701 ms | 2,701..3,201 | 0 | 120, 696 | 120 | 676 | 0 |
| random press offsets, seed 7 | 2 s at 7,001 ms | 7,030..9,001 | 0 | 472, 538 | 473 | 0 (z-index only) | 0 |
| live resize, seed 7 | none | none | 0 | none | 0 | 0 | 0 |
| live resize, seed 7 | 500 ms at 2,701 ms | 2,701..3,201 | 0 | 120, 696 | 120 | 676 | 0 |
| live resize, seed 7 | 2 s at 7,001 ms | 7,029..9,001 | 0 | 473, 538 | 473 | 0 (z-index only) | 0 |
| live resize, seed 99 | none | none | 0 | none | 0 | 0 | 0 |
| live resize, seed 99 | 500 ms at 2,701 ms | 2,711..3,201 | 0 | 118, 696 | 120 | 684 | 0 |
| live resize, seed 99 | 2 s at 7,001 ms | 7,021..9,001 | 0 | 474, 538 | 475 | 0 (z-index only) | 0 |

In every row, every animation's interpolation distance was exactly 0 or 1, so no screen blends two samples. The random press offsets trace with seed 7 without a stall also matched in all outputs (in `results.json`).

With presses on 30 fps frames, 240 fps renders each press before the stalls start. Transform and opacity then match 240 fps displays through both stalls in every bit, while width, height and z-index wait. The 500 ms stall lands during the restore of Photos' size (the press at 2,700 ms), so the window keeps moving and scaling while its size is up to 688 px off until the stall ends. In the 2 s stall after Files' close press at 7,000 ms, only z-index waits, in 341 frames. When an event arrives after the last main-thread frame before a stall, transform and opacity show the future predicted before that event until the stall ends, up to 696 px off, and everything is exact from the first frame after the stall.

The first version of this model returned the prediction's sample for every output, and missed two things. It let width, height and z-index play through stalls, and it counted the events at 2,701 and 7,001 ms as before the stall, so it reported 0 differing frames outside stale intervals for "every event 1 ms later" with both stalls. And before `startTime` moved half a clock grid step earlier, evaluating the emitted keyframes showed 5 of the 2,641 frames of the live resize trace with seed 7 differing with no stall, by up to 10.8 px. E.g. the frame at 7,129.1667 ms is 1/192 ms before a sample boundary: a display rounds that time up to the boundary, and Web Animations don't round. All of this is a model of the specification. I haven't checked the keyframes in a browser, which keeps animation times in whole microseconds and rounds layout sizes to 1/64 px.

Display frames at 60 fps, last frame held, at the same 240 fps timestamps:

| Trace | Stall | Frames with any different bit (of 2,641) | Transform and opacity outside the stall: max px | Inside the stall: transform and opacity max px | Inside the stall: width and height max px |
| --- | --- | ---: | ---: | ---: | ---: |
| presses on 30 fps frames | none | 558 | 86 | | |
| presses on 30 fps frames | 500 ms at 2,701 ms | 588 | 688 | 688 | 688 |
| presses on 30 fps frames | 2 s at 7,001 ms | 936 | 538 | 538 | 0 |
| every event 1 ms later | none | 567 | 423 | | |
| every event 1 ms later | 500 ms at 2,701 ms | 597 | 687 | 687 | 687 |
| live resize, seed 7 | none | 643 | 423 | | |
| live resize, seed 7 | 500 ms at 2,701 ms | 673 | 675 | 676 | 676 |
| live resize, seed 7 | 2 s at 7,001 ms | 1,015 | 538 | 538 | 0 |
| live resize, seed 99 | 500 ms at 2,701 ms | 679 | 684 | 684 | 684 |

Held display frames freeze everything during a stall, transform included: up to 688 px off in the 500 ms stall. Without stalls they also differ at 240 fps timestamps, by up to 423 px in transform, since they hold each frame for 16.7 ms.

How much keyframe work the page does:

| Trace | Predictions | Event commits | Event commits before the previous prediction's settle sample | Predictions with animated elements | Mean / most animated elements | Animations started | Keyframe objects created in 11 s |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| presses on 30 fps frames | 76 | 71 | 3 | 7 | 11.1 / 27 | 126 | 19,614 |
| every event 1 ms later | 76 | 71 | 3 | 7 | 11.1 / 27 | 126 | 19,614 |
| random press offsets, seed 7 | 76 | 71 | 3 | 7 | 11.1 / 27 | 126 | 19,614 |
| live resize, seed 7 | 138 | 133 | 65 | 69 | 11.9 / 27 | 1,497 | 181,481 |
| live resize, seed 99 | 138 | 133 | 65 | 69 | 11.9 / 27 | 1,494 | 180,822 |

Keyframe objects count each started animation's keyframe list, so an element with both a composited and a layout animation counts twice. For a maximize of Photos, the plan has a settle step of 160, 27 animated elements, 26 composited animations and 13 layout animations, and 6,279 keyframe objects, built in 0.6 to 1.1 ms. In the saved outputs of the second and third runs, a scene built in 32 ms and 20 ms, and the first prediction that runs all 301 samples, while the generated instance code was still cold, took 62 ms and 9.3 ms.

### The per-sample program as WGSL

codegen's emitter with the `max(x, lowest)` guard, interpreted on the CPU with strict f32 rounding for the 301 samples after maximizing Photos: 0 of 68,628 outputs differ from the generated instance loop for each Photos wiring (2,239 shader statements and 3,249 guards with current-frame reads, 1,422 and 1,925 with previous-frame reads, 2,230 and 3,242 with stepped springs, no gather reads).

On the GPU, 16 committed tables taken along the live resize trace while something animates, 301 samples and 228 outputs each:

| Runtime | Photos reads | Guard | Outputs that differ (of 1,098,048) | Largest difference | Animation bits that differ | Shader compile ms | CPU instance loop ms | GPU upload + dispatch + readback ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dawn (Node 23.10) | current frame | max | 0 | 0 | 0 | 428 | 0.80 | 0.43 |
| Dawn | current frame | none | 37,656 | 9.2e-5 | 0 | 248 | 0.52 | 0.34 |
| Dawn | previous frame | max | 0 | 0 | 0 | 281 | 0.44 | 0.36 |
| Dawn | previous frame | none | 8,983 | 6.1e-5 | 0 | 207 | 0.37 | 0.31 |
| Dawn | stepped springs | max | 0 | 0 | 0 | 382 | 0.77 | 0.65 |
| Dawn | stepped springs | none | 24,157 | 6.1e-5 | 0 | 248 | 0.50 | 0.34 |
| wgpu (Deno 1.42) | current frame | max | 0 | 0 | 0 | 491 | 1.49 | 14.8 |
| wgpu | previous frame | max | 0 | 0 | 0 | 329 | 0.38 | 14.7 |
| wgpu | stepped springs | max | 0 | 0 | 0 | 435 | 0.52 | 14.7 |

With the guard, both stacks reproduce the CPU prediction bit for bit. Without it, up to 3.4% of outputs differ by at most 9.2e-5 px, and no animation bit changes along these tables. Deno's times look like the polling latency codegen saw in `mapAsync`.

## What this shows about how far the approach goes

### What fit well

- Committed state became a function of the event list alone, for events delivered in timestamp order or delivered after settle commits that already ran. Across 6 traces, 4 variants and 7 frame schedules, committed tables and every displayed output at shared timestamps were identical in every bit, where spring-bank's best frame model differed in bits in 15% to 18% of shared frames. Nothing in the circuit changed; only when JS writes next-source back changed.
- A commit and a display are the same circuit read differently, so splitting them needed no builder work: two tensor programs compiled from one circuit with different roots, bit-identical to the executor.
- Idle costs nothing. There is one commit per distinct event timestamp plus a settle commit when an animation outlives the last event, and a stopped clock schedules nothing.
- Time works as data. From a committed table, all 301 samples are one run of one program, bit-identical to 301 separate displays over 4.7 million values per Photos wiring, and the same program on the GPU is bit-identical with the guard, in 0.36 to 0.65 ms through Dawn.
- Settling at fixed simulated times works as a reduction over samples: the first settled sample at a multiple of 16 steps gives both the keyframe snap and the settle commit time, the same as a sequential probe in all 207 predictions.
- In the specification model, the emitted keyframes show what 240 fps displays show at every timestamp, in all outputs, for every trace without a stall. Transform and opacity keep playing through stalls, exact in every bit, when no event arrives between the last main-thread frame and the end of the stall.
- A late event costs one table copy: the committer undoes settle commits by restoring the table saved after the last event commit, including when the event has the settle commit's own timestamp. The test compares the table, the next settle time and displays right after the late event with in-order processing.

### What got awkward

- Most of the circuit is needed by both kinds of evaluation. A display program is 3,360 of 3,413 operations, and 2,208 of its rows depend on event latches that are always 0 on a display. I didn't build a display program with the latches folded to 0.
- The instance axis gives little over generated JS for IndirectOS: 1,353 of 3,360 rows are shared, so one prediction ran 1.2 to 2 times faster than 301 separate generated displays. Against 301 executor evaluations, the phase 3 scratch script measured 12 to 17 times.
- Reading earlier state gets worse when displays never write back. "Previous frame" becomes "last commit", which was 507 px off during the Photos maximize and restore, where frames that write back at 240 fps were 35.7 px off. With early reads, predictions during a live resize never settled within 288 steps.
- Events that arrive during a stall, or just before it after the last main-thread frame, can't reach the screen until the main thread renders again, so transform and opacity show the old future, up to 696 px off, about as far as frozen frames. Commit per event separates state from frames, not from main-thread latency.
- Only part of what animates survives a stall. Width, height and z-index need main-thread style and layout: in the Photos size restore, the window keeps moving and scaling through the 500 ms stall while its size is up to 688 px off. This comes from the model of how Chrome composites animations; I haven't seen it in a browser.
- Keyframe volume. Every pointer move during a live resize restarts about 12 animated elements, each with up to two animations of over a hundred keyframes: about 181,000 keyframe objects in 11 s, and about 1 ms of JS per plan for a maximize.
- Time rounding matters for bit identity between two presenters. The circuit's clock rounds frame times to the nearest 1/64 ms and Web Animations don't, so keyframes started at the prediction's simulated time showed the previous sample at 5 frames of one trace, up to 10.8 px off. Starting them half a grid step earlier fixed it in the model. A browser's microsecond clock may round that 7.8 µs shift.
- The circuit's own settle check isn't monotone over samples (12 samples after a settle step reported animating, within 0.00104 px), so displays and keyframes only agree because the settle commit lands exactly on the settle step. With interval settle commits, displays between the settle step and 1,200 ms show the circuit's per-sample decision, which can flicker within 0.001 px.
- JS now runs a schedule. It decides when to commit, runs a timer for settle commits, checks timestamps for late events, and has to run due settle commits before any display at a later time.
- Cold generated code: the first full prediction took 9 to 62 ms in the saved runs.

### What stayed outside the circuit

- Every timestamp and the whole schedule: event timestamps, settle times, timers, catching up settle commits before a display, and undoing settle commits for late events.
- With source-matrix springs, the step count and M^i for every sample, computed in float64 JS.
- Keyframe strings, starting and cancelling Web Animations, setting `startTime`, creating and removing photo elements, and style writes for discrete properties like focus and dock flags.
- Choosing which properties go to the compositor and which need layout.
- Coalesced pointer events and their timestamps (`getCoalescedEvents()` in the page).

## How it connects to the talk

The talk's pattern is to take the unit you compose with and ask what it's made of. In IndirectOS the unit of time was the frame, and one frame was one evaluation that did two jobs: it changed state, and it showed the screen. This prototype splits that unit into two smaller ones: the event, which is the only thing that changes state, and the 4 ms sample, which is the only thing a screen shows.

The granularity gap is that a frame stops being something the circuit knows about. A display rate, a stall, or a skipped frame are only different times at which someone looks up a sample. The circuit never learns that a frame happened, so a page's frame loop can't change what the UI remembers.

What emerged once the unit was smaller: frame-rate independence became bit identity instead of an error bound; idle became free; motion and fades kept playing through a blocked main thread in the model; and replaying or scrubbing a session became committing the same events and asking for a sample at a time.

Homogeneity is what makes the future computable as one batch. Every sample is the same program with a different matrix, M^i in 4 cells, so "show me the UI 4 ms × i later" is one command given 301 times, like one shader run over pixels, and the same per-sample program ran on the CPU and on two GPU stacks with the same bits.

The premature compression was assuming that one timestamp serves both jobs. Measured, that assumption cost bit differences in 15% to 18% of frames, below any visible scale. Splitting the timestamp also showed how much a read of "last state" depends on what "last" means: 35.7 px off when every frame writes back at 240 fps, and 507 px off when only events write back.

## Open questions and next steps

- Open the demo in Chrome: check that transform and opacity animations keep playing during the 500 ms stall while width and height wait, that `startTime` on the event timestamp's clock, less half a clock grid step, lines sample 0 up with the commit at microsecond precision, and how often the committer undoes settle commits for events delivered after a timer.
- A display program with the event latches folded to 0, to measure how many of the 2,208 rows that depend on latches disappear.
- The settle step inside the circuit: a first-active reduction over samples, e.g. over the 18 checked samples, instead of JS scanning the animation bit.
- Early reads without the 507 px lag: read stepped springs for everything that reads spring state, or commit a second time right after an event so reads of last state catch up before any display.
- Fewer keyframes during direct manipulation: keyframe only parts that change over more than a few samples, or feed the samples to a canvas or WebGPU renderer instead of Web Animations.
- Size changes that survive stalls: animate `scale` on the compositor toward the predicted size and correct the layout size when the main thread is free, and measure the visual difference with the same screen model.
- Predictions on the GPU in the page: the Dawn readback of all 301 samples took 0.36 to 0.65 ms, so a page could dispatch predictions with WebGPU and build keyframes from the readback.
- Candidate futures as instances: e.g. predict what a release at each of several pointer positions would do, as ideas.md suggests, with one program over a grid of (sample, candidate) instances.
- Scrubbing and replay as a UI feature: the commit log is the session, and a display at any time is a lookup, so a timeline slider over a recorded session needs no new circuit.

## Browser check

2026-09-13, Chrome, in a hidden tab with a 1,160 by 853 CSS px viewport, served with `bun lab/ui-exploration/event-time/demo.html`. A hidden tab renders a frame only when something forces one, e.g. a screenshot, so `document.timeline` stood still between screenshots, and that limited what the stall check could show. A Worker heartbeat every 10 ms measured main-thread stalls as gaps between its messages.

Predicted keyframes (`?presenter=keyframes`):

- Loads, no console errors. On load the monitor showed "1353 shared · 2007 per sample" rows and a prediction of 1.90 ms.
- Real clicks: Files' minimize button, "stall 500 ms", "stall 500 ms once the next animation starts", and Photos' maximize button. Scripted presses: maximize and restore Photos, minimize Notes, and restore Notes from the dock. The commit counts always ended with "0 undone".
- Maximizing Photos started 27 animations: 14 hold only transform and opacity, and 13 hold width, height or z-index. E.g. Photos got "opacity,transform" and "height,zIndex,width" as two animations, each 576 ms long with `steps(144)`, 145 keyframes and `fill: forwards`. The monitor said "26 composited · 13 layout": it counts planned tracks, including 12 photo or thumbnail tracks that no sample shows, which `demo.ts` gives no animation.
- For scripted presses, `startTime` equaled the press's `event.timeStamp` at the 0.1 ms precision Chrome gives the page, e.g. 313,721.3 ms for both, so the half clock grid step (1/128 ms) wasn't measurable.
- Both stall buttons block the main thread: the heartbeat saw a 561 ms gap after "stall 500 ms", and a 502 ms gap after the maximize that followed "stall 500 ms once the next animation starts", and that button then cleared its highlight.
- Not verified: whether transform and opacity keep playing during a stall. In this hidden tab a screenshot waited for the main thread: in a scripted 8 s stall that started right after a forced frame, the three screenshots after the first one all showed a settle commit that ran after the stall. JS can't observe anything during a stall either.

Display frames (`?presenter=frames`), with `requestAnimationFrame` replaced by a Worker timer every 16 ms:

- Loads, no console errors. A scripted minimize of Files ran 15 frames, e.g. scale 0.094 at the first frame, 134 ms after the press, and scale 0 from 281 ms.
- The "stall 500 ms" handler, dispatched 307 ms after the press, just after Files reached scale 0, blocked for 500 ms (a 508 ms heartbeat gap), and no frame ran in between.

GIF: `~/Downloads/ui-exploration-event-time-demo.gif` (8 frames). No fixes.
