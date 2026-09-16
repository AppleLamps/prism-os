# IndirectOS again, with the phase 2 results compounded

This prototype asks whether the separate phase 2 wins compound: can IndirectOS become richer (text that flows around windows, exact multi-event input, keyboard routing) and cheaper at the same time, in one circuit, written in the notation from lab/ui-exploration/notation?

It builds IndirectOS as one program where each phase 2 change is an option: the spring timestep declared nonnegative, the spring bank, Photos reading stepped springs, the folded event queue with key routing, and a Notes window whose paragraph flows around the other windows with a spring per word. Each step is checked against an independent reference, the report measures every step and several other orders of the same changes, and the same program runs on the executor and as tiered generated JavaScript.

The short answer: richer, yes, and exact everywhere it was checked. Cheaper, no. The whole program is 19,854 live operations, 343 layers and 49,900 stored weights, against the original's 5,253, 192 and 11,598. The springs got cheaper and their savings add up across every other change, but exact multi-event input costs more than the latches it replaces, and the Notes flow alone costs more than the whole original desktop. Some gains interfered: the event queue erased Photos' depth gain, text that flows around the windows' animated geometry loses the spring bank's frame-rate independence, and generated JavaScript needs tens of thousands of evaluations before the wider program runs fast.

Update, 2026-09-15: the word springs were removed, so words move straight to the new layout in the frame of the event, and the whole program is now 18,027 live operations, 337 layers and 44,326 stored weights. The rest of this README was measured with word springs; [Words without springs](#words-without-springs-2026-09-15) has the new numbers.

Update, September 15, 2026: window-manager.ts moved to host-timed springs, so `base.test.ts` and `pair-traces.ts` import the pre-change IndirectOS from codegen's `window-manager-copy.ts`.

## What it is and how to run it

From the repo root:

```sh
bun test lab/ui-exploration/indirect-os-2              # 25 tests, 4 to 9 seconds on this shared machine
bunx tsgo -p lab/ui-exploration/indirect-os-2
bun lab/ui-exploration/indirect-os-2/report.ts          # every table below, about 10 minutes; writes results.json
bun lab/ui-exploration/indirect-os-2/report.ts structure framerate   # parts: structure, traces, timings, tierup, framerate
bun lab/ui-exploration/indirect-os-2/indirect-os.html   # the demo page
```

The shared runtime `numeric-ui-core.ts` is imported unchanged, and no file outside this folder was edited. Pieces it builds on without changes are imported from their folders (until September 15, 2026 this folder held unchanged copies of them), and pieces it changed are copies in this folder; "Files" says which is which and lists the changes to the copies. The demo page bundles with `bun build` (44 modules), and `dom.test.ts` runs its projection and input decoding against fake DOM elements, but nobody opened the page in a browser. A later Chrome check opened the page, see [Browser check](#browser-check).

## What was built

### Files

| File | What it holds |
| --- | --- |
| `indirect-os.ts` | the options-driven build and the machine: allocation, clock, window springs and projection, Photos inputs, Notes, writeback, one frame of events split into evaluations |
| `desktop-latches.ts` | window logic with one latch per event kind, creating window-manager.ts's operations in the same order |
| `desktop-queue.ts` | window logic over the event queue, in the folded form |
| `events.ts` | the JS side of the queue: key decoding, whole pixels, a legal pointer stream, splitting a frame into evaluations |
| `oracle.ts` | the one-event-at-a-time reference for the queue build, plain float64 |
| `photos.ts` | Photos: notation's build with a springs switch, plus the layout, click, key and render parts the queue build uses |
| `notes.ts` | the Notes flow: obstacles, slots, line walker, word springs |
| `notes-reference.ts`, `paragraph.ts` | dynamic-layout's layoutColumn for several rectangles with pretext's layoutNextLineRange; the paragraph and its options |
| `table.ts`, notation's `wires.ts` | notation's allocator and helpers; `table.ts` is a copy that gained an exact-bit `inputBit` cell, and `wires.ts` is imported |
| spring-bank's `spring-bank.ts`, `spring-math.ts` | imported from spring-bank: clock, constant power groups, boxes, and the float64 doctrine reference |
| `fast-walker.ts`, `text-kit.ts`, text-walker's `fake-canvas.ts`, `pretext-src/` | from text-walker; `fake-canvas.ts` and `pretext-src/` are imported, and the other two are copies: the walker is trimmed to gathered lines and builds its tables inside an existing circuit over existing cells, and `text-kit.ts` gained a count of integer one-hot operations |
| input's `kit.ts` | imported from input: exact integer bits, picks, masks |
| `codegen.ts` | copied from codegen, with an optional term budget per generated function |
| `tiered.ts` | executor first, then generated code, verified on every live wire before switching |
| `configurations.ts`, `measure.ts`, `report.ts`, `results.json` | named option sets, section attribution, measurements |
| `pair-traces.ts`, `queue-traces.ts`, `box-check.ts`, `framerate.ts`, `session.ts`, notation's `compare.ts` | traces against window-manager.ts, random queue frames, the float64 spring check, the 60 fps against 120 fps replay, a scripted session, notation's structural comparison (imported) |
| `indirect-os.html`, `indirect-os-dom.ts`, `demo.css` | the demo on window-manager.css's markup, with word spans in the Notes window |

### 1. The notation base

With `originalOptions`, `indirect-os.ts` allocates window-manager.ts's source layout and creates its operations in the same order. One detail had to be kept: window-manager.ts creates each dock item's hit test right after that item's box, and building all four boxes first changed wire numbering. `declareTimestep: true` declares the spring timestep nonnegative where it's computed.

### 2. The spring bank

`springs: 'bank'` replaces every `emitSpring` lane with spring-bank's construction: a clock that counts fixed 4 ms steps from the frame delta, carries the leftover time and caps catch-up at 300 steps, one frame matrix per stiffness and damping pair read from constant tables, four exact products per lane, and one settle bit per box. Retargeting is deferred: this frame's steps move toward last frame's destination, stored in one cell per lane. A window is a box of 5 lanes, and a thumbnail a box of 2 lanes in the same group. `photosViewport: 'stepped-springs'` lays Photos out at the Photos window's springs after stepping and before the settle snap, with presence from last frame.

### 3. The event queue

`input: {kind: 'queue', capacity, maximumDowns}` removes the pointer latches and Photos' event latches. Each queue slot holds down, move, up, ArrowLeft, ArrowRight and Escape bits and whole-pixel coordinates. The rules, stated in `oracle.ts`:

- A down hit-tests the frontmost visible window, focuses and raises it, and records a press: the point, the window, which region of it was hit (close, maximize, minimize, resize grip, title bar, content, in that priority order), the dock item under the point, and the window's geometry at the press.
- A drag or resize is always the geometry recorded at the press plus the pointer's offset from the press point, clamped to the workspace. So a drag past the left edge and back returns the window under the pointer. window-manager.ts clamps its stored geometry every frame instead, so there the window ends up offset from the pointer.
- A move or up farther than 4 px from the press point, measured as Chebyshev distance, turns the press into a drag. An up that never crossed that distance is a click. Window buttons and dock items act on a click, where window-manager.ts acts on the down, so pressing a close button, moving out, and moving back cancels the close.
- A click on the Photos content reaches Photos at local coordinates, hit-tested against the layout at the Photos window's destination size.
- ArrowLeft, ArrowRight and Escape reach Photos while Photos is the focused window at that key's position in the queue. JS no longer maps the three keys to Photos, and Photos no longer gets events from DOM click handlers.
- After every evaluation, every window is clamped to the current viewport.

`desktop-queue.ts` handles a whole queue in one evaluation, with the folded form from lab/ui-exploration/input:

- Prefix counts of downs and ups give each slot its press session (session 0 continues a press carried in from an earlier evaluation). With a legal stream they're exact integers, and each session's down and up are read through one-hot bits.
- Moves fold. The pointer latch is the last pointer event, and "the press crossed slop" is an OR over the session's moves and up, each measured from its own session's press point.
- Press sessions run in sequence, down then up, because a down hit-tests geometry that an earlier up may have changed, e.g. a window dragged and released, then pressed at its new place within one evaluation.
- Photos' focus runs its own sequence. Each session's up may click Photos, and the keys between two ups fold into "clear if any Escape, otherwise rotate by rights minus lefts". That summary is enough because Escape closes the lightbox, and next or previous with no photo open do nothing. The rotation is an integer one-hot that reads the rotated focus through gathers.
- A key slot's phase is the number of downs and ups through it, and it names the window state the key sees. Photos' focused bit is computed after each down and each up, and each run of keys reads only the states of its own phases.

JS keeps the stream legal (an up without a press is dropped, and a down while pressed gets a synthesized up) and splits a frame with more events or more downs than the circuit handles into more evaluations; only the first evaluation carries the frame's time.

### 4. The Notes flow

`notes` builds the Notes window's paragraph in the same circuit, in coordinates local to the Notes content box.

- The obstacles are the three other windows while they're visible and stacked above Notes. `obstacles: 'destinations'` (the final configuration) reads where the windows are going: this frame's destination rectangles and visibility. `'current-frame'` reads the windows' projected geometry as drawn this frame, scaled about the center. `'stepped-springs'` reads their springs after stepping and before the snap, with last frame's stacking and presence.
- Each band, one line tall, carves the column around the obstacles that overlap it vertically, keeps the widest remaining slot at least as wide as the widest word, and prefers the slot further right on a tie, as dynamic-layout's layoutColumn does. The slot depends on the band only through which obstacles block it, so it's computed once for each of the 8 subsets of the 3 obstacles, and each band reads its subset's slot through a one-hot of its 3 blocking bits. Obstacle geometry is fractional while windows animate, so these comparisons are rounding comparisons: exact bits when a difference sits on a 1/64 px grid, and either answer within 1/128 px of a tie.
- text-walker's gathered-lines walker lays out the paragraph band by band over runtime segment widths and break-after bits, with each band's slot width and a gate for bands with no slot. Segment geometry gives every word an x, a y, and a visible bit.
- Every word is a spring bank box of 2 lanes in its own group (stiffness 290, damping 30). A word snaps while it isn't laid out, while Notes is hidden, and on the first evaluation. Removed on 2026-09-15: each word is now at the walker's x and y from the same evaluation, see [Words without springs](#words-without-springs-2026-09-15).

The paragraph is 45 words and 89 segments, laid out in 16 bands of 22 px in a column of at most 440 px, with a walker window of 26 segments.

### 5. Execution

`tiered.ts` evaluates with the executor. To promote, it compiles the generated functions, runs them on copies of the table for a while so the engine optimizes them, compares every live wire with the executor on the current table, and switches only when all of them match. The demo spreads that work over idle callbacks, 3 seconds of warmup in total.

### 6. The demo page

`indirect-os.html` is window-manager.css's markup with the Notes window's content replaced by word spans. `indirect-os-dom.ts` measures the paragraph with pretext and the browser's canvas, rounds widths to 1/64 px so prefix sums stay exact in FP32, builds the circuit, and projects outputs by field name. Handlers push raw input (with coalesced pointer moves when the browser provides them) and schedule a render. The handler calls `preventDefault` for the three understood keys, since the browser needs that decision before the circuit runs.

## Measured results

Counts are exact. µs are rough: other agents share this machine, and two runs of the same report measured the original circuit's executor at 78 µs and 42.5 µs (a scratch run earlier measured 29 µs), so compare µs within one table.

### Size of each step

| Configuration | Source cells | Live operations | Layers | Stored weights | Gather reads | Widest layer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| window-manager.ts, as the notation rewrite | 201 | 5,253 | 192 | 11,598 | 12 | 123 |
| 1. timestep declared nonnegative | 201 | 4,933 | 184 | 10,958 | 12 | 123 |
| 2a. spring bank | 245 | 3,580 | 137 | 8,447 | 12 | 365 |
| 2b. Photos reads stepped springs | 245 | 3,583 | 91 | 8,455 | 12 | 365 |
| 3. event queue: 8 slots, 2 downs per evaluation, key routing | 309 | 8,059 | 169 | 21,611 | 91 | 387 |
| 4. Notes flowing around the windows' destinations, word springs | 759 | 19,854 | 343 | 49,900 | 987 | 1,133 |

What each step changed:

| Change | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: |
| 1. timestep declared nonnegative | -320 | -8 | -640 |
| 2a. spring bank | -1,353 | -47 | -2,511 |
| 2b. Photos reads stepped springs | +3 | -46 | +8 |
| 3. event queue | +4,476 | +78 | +13,156 |
| 4. Notes flow | +11,795 | +174 | +28,289 |
| whole program against window-manager.ts | +14,601 | +151 | +38,302 |

The bank's counts are the ones spring-bank measured in its own copy of window-manager.ts (3,580 / 137 / 8,447, and 3,583 / 91 / 8,455 with stepped Photos), so writing the bank in the notation lost nothing.

Other settings of the same changes:

| Configuration | Source cells | Live operations | Layers | Stored weights | Gather reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| queue with 1 down per evaluation | 309 | 5,816 | 129 | 15,409 | 64 |
| queue with 16 slots | 373 | 9,002 | 169 | 25,775 | 91 |
| queue whose key slots read Photos' focus through one gather | 309 | 7,984 | 257 | 20,221 | 99 |
| Notes around current-frame obstacles | 759 | 19,861 | 368 | 49,919 | 987 |
| Notes around stepped-springs obstacles | 759 | 20,034 | 264 | 50,221 | 987 |
| Notes around destinations, 1 down per evaluation | 759 | 17,608 | 304 | 43,698 | 960 |

The same changes in other orders, to see whether savings add up:

| Configuration | Live operations | Layers | Stored weights | Compared with |
| --- | ---: | ---: | ---: | --- |
| queue with the original springs (timestep declared) | 9,409 | 204 | 24,114 | step 3: the bank saves 1,350 operations, as with latches (1,353) |
| queue with the bank, Photos at the current frame | 8,056 | 169 | 21,603 | step 3: stepped springs save no layers with the queue |
| Notes with the original springs (timestep declared) | 24,332 | 367 | 58,087 | step 4: the bank saves 4,478 operations |

### Where the operations go

The queue build (step 3), by labeled section:

| Section | Live operations | Stored weights | On the deepest path |
| --- | ---: | ---: | ---: |
| Photos clicks, one per session (3) | 1,973 | 4,831 | 74 |
| down updates (2) | 1,756 | 4,084 | 30 |
| up updates (3) | 947 | 2,877 | 14 |
| spring boxes | 824 | 2,376 | 8 |
| Photos render | 454 | 1,148 | 12 |
| key gates | 432 | 1,968 | 2 |
| queue counts, slop, pointer latch | 400 | 1,346 | |
| Photos' focused bit after each down and up | 297 | 625 | 10 |
| Photos key runs | 248 | 680 | 12 |
| window springs and projection | 233 | 426 | |
| end of evaluation | 194 | 503 | |
| clock and group | 167 | 436 | |
| other | 134 | 311 | 8 |

With latches (step 2b), the window logic was 1,179 operations and Photos 1,093, with 46 and 24 of the deepest path's 91 operations. Reading Photos' focus through one gather over all six window states (the alternative above) made the deepest path 257: every key run waited for the last state, so Photos' whole focus sequence came after the whole window sequence.

The whole program (step 4):

| Section | Live operations | Stored weights | On the deepest path |
| --- | ---: | ---: | ---: |
| Notes line walker | 8,221 | 17,786 | 173 |
| spring boxes: 4 windows, 12 thumbnails, 45 words | 2,534 | 7,371 | 1 |
| Photos clicks (3) | 1,973 | 4,831 | |
| down updates (2) | 1,756 | 4,084 | 52 |
| up updates (3) | 947 | 2,877 | 41 |
| Notes band blocking | 912 | 2,992 | 2 |
| Notes slot per obstacle subset | 807 | 1,860 | 50 |
| Photos render | 454 | 1,148 | |
| key gates | 432 | 1,968 | |
| queue counts, slop, pointer latch | 400 | 1,346 | |
| Photos' focused bit after each down and up | 297 | 625 | |
| Photos key runs | 248 | 680 | |
| window springs and projection | 233 | 426 | |
| end of evaluation | 194 | 503 | 8 |
| clock and groups | 189 | 602 | |
| other | 134 | 313 | 13 |
| Notes word snap bits | 95 | 411 | 3 |
| Notes obstacles | 28 | 77 | |

The 45 word boxes are 1,710 of the box operations, 38 per word, the cost spring-bank measured for one box of 2 lanes. Integer one-hots, which the walker builds to read tables at a computed index, are 2,984 of the walker's operations.

### Exactness

From `report.ts traces`, with the final configuration wherever the whole program is checked:

| Check | Frames or cases | Compared | Mismatches | Notes |
| --- | ---: | ---: | ---: | --- |
| timestep declared vs window-manager.ts, every next-source value and output bit for bit, seeds 1, 2, 3 | 3 × 2,001 | 2,575,287 values | 0 | 58 frames moving a held drag, 30 moving a held resize |
| bank vs window-manager.ts: focus, geometry, open, minimized, maximized, drag and resize owners, stacking, photo focus, seed 5 | 3,001 | 204,068 values | 0 | 33 photo focus changes, 53 closes |
| bank with stepped Photos vs window-manager.ts, same values, seeds 12 and 6 | 2 × 3,001 | 408,136 values | 0 | 48 photo focus changes, 113 closes |
| whole program vs the one-event-at-a-time oracle: window geometry and flags, stacking, the press record, photo focus, seeds 1 to 4 | 4 × 3,000 | 33,129 events, 5,046 of them keys | 0 frames | 2 points moved off a hit threshold, none dropped |
| window, thumbnail and word boxes vs float64 doctrine springs, restarted from the circuit state each evaluation | 3,000 evaluations | 183,000 boxes | 0 settle bits, 0 step counts | max 1.2e-4 px and 8.7e-4 px/s |
| settled Notes flows vs pretext's layoutNextLineRange, random window arrangements | 150 | 6,750 words, 2,400 bands | 0 | slot, line start and painted width per band, and every word's position and visibility; 778 bands blocked by two or three windows |
| generated JavaScript vs the executor, every live wire, the session and a random trace | 800 evaluations | 16,490,400 values | 0 | 32 rows per function |

Random queue frames are aimed at what's on screen through a shadow copy of the oracle, with up to 8 events and 2 downs per frame, keys in 15% of the slots, and viewports from 360×300 to 1440×900. When a press or release would put a float64 hit decision within 0.01 px of its threshold, where FP32 rounding could decide differently, the generator moves the point by a pixel or two.

The named cases in `queue.test.ts` run the same way: a click on a close button closes the window, and moving outward past slop and back cancels it within one frame; down, up, down within one frame, where the second down sees the maximized window; a drag commit visible to a later down in the same frame; a drag past the left edge and back; a Photos grid click that opens a photo, and keys that reach Photos only while it's focused, including an ArrowRight after a click on Files in the same frame, which is ignored.

Two findings came out of these checks:

- Photos' clicks in window-manager.ts depend on spring timing. Photos hit-tests a click against its layout at the animated window size, so with the bank's trajectories a click during a Photos window animation landed on a different photo in 2 of 8 random 400-frame traces, while every window decision matched. The comparison sends Photos clicks only while both machines have settled the Photos window. The queue build hit-tests at the destination size, which removes that dependence. Update, September 15, 2026: window-manager.ts now hit-tests Photos clicks at the window's destination size too.
- A range copied from spring-bank was false. Window destination centers were declared within 0..16,384, and in a 2 px wide viewport a dock item is centered at -4.8e-7 px, because FP32 rounds a third when the dock gap shrinks with the viewport. The derived validator rejected the frame, and the recovery path then wrote the value back into a table the executor refused. The centers are now declared within -16,384..32,768.

### Frame-rate independence

The scripted session (`session.ts`: drags, a resize, maximize and restore, a photo, keys, minimize, reopen from the dock) replayed at 60 fps and 120 fps. Every event sits on a 60 fps frame time, which 120 fps also renders, so both runs apply each event at its own time.

| Configuration | Shared frames | Windows, max px | Thumbnails, max px | Words, max px | Frames with different stacking, flags, photo focus, word visibility | Frames with different animationActive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2b. Photos reads stepped springs | 400 | 2.4e-4 | 1.8e-4 | | 0 | 1 |
| 3. event queue | 400 | 2.4e-4 | 1.8e-4 | | 0 | 1 |
| 4. Notes around destinations | 400 | 2.4e-4 | 1.8e-4 | 1.5e-4 | 0 | 0 |
| Notes around current-frame obstacles | 400 | 2.4e-4 | 1.8e-4 | 25.4 | 0 | 0 |
| Notes around stepped-springs obstacles | 400 | 28.8 | 14.4 | 69.7 | 0 | 1 |

With current-frame obstacles, the words' destinations follow windows that are still animating, so each rate retargets the words toward a different sequence of destinations: at 120 fps twice as often. spring-bank saw the same effect for thumbnails during a live resize. With destinations, words retarget only when a window's destination changes, which happens at event times, and every animated value agrees within 2.4e-4 px.

With stepped-springs obstacles the windows diverge too, and the cause took a closer look. Those obstacles read last frame's stacking, so after the click that raised Notes at frame 60, the words started moving in the next rendered frame: frame 61 at 60 fps and frame 60.5 at 120 fps. Nothing was animating before, so the one clock all boxes share restarted in those two different frames, and the carried leftover time had a different phase in the two runs from then on (it differed at 115 of the 400 shared frames, against 1 with destination obstacles). At frame 140 Photos is maximized, and from frame 142 the two runs had stepped a different amount of simulated time at the same timestamps, 28.8 px apart during the maximize.

### µs per evaluation

Update, 2026-09-15: results.json's `timings` and `tierup` entries now hold a rerun without word springs, see [Words without springs](#words-without-springs-2026-09-15). The two tables below are the run with word springs.

Warm µs per evaluation over the scripted session's source tables, with the executor's reusable evaluator and with generated JavaScript after 8 seconds of continuous running, in one process (`report.ts timings`):

| Configuration | Live operations | Layers | Executor µs | Generated µs, 32 rows per function | Generated µs, 128 rows per function | Executor µs / generated µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| window-manager.ts, as the notation rewrite | 5,253 | 192 | 42.5 | 3.1 | 3.3 | 13.7 |
| 1. timestep declared nonnegative | 4,933 | 184 | 39.3 | 3.1 | 2.8 | 14.0 |
| 2a. spring bank | 3,580 | 137 | 29.6 | 2.0 | 1.9 | 15.6 |
| 2b. Photos reads stepped springs | 3,583 | 91 | 28.2 | 1.7 | 1.9 | 16.6 |
| 3. event queue | 8,059 | 169 | 65.9 | 6.7 | 7.8 | 9.8 |
| 4. Notes around destinations | 19,854 | 343 | 159.1 | 29.3 | 33.2 | 5.4 |
| Notes around current-frame obstacles | 19,861 | 368 | 159.7 | 30.1 | 48.7 | 5.3 |
| Notes around stepped-springs obstacles | 20,034 | 264 | 153.0 | 29.1 | 80.8 | 5.3 |

The executor's cost follows live operations, about 8 µs per 1,000 here, and removing 104 layers moved it by less than the noise. Generated code for the whole program ran at about the original circuit's executor cost, but only after 8 seconds of continuous running, and for this program its time varied more with warmup and function size than with the circuit. In scratch runs on the program with current-frame obstacles, 3 seconds of warmup gave 79 µs at 128 rows per function and 48 µs at 32 rows, and 10 seconds gave 30 µs and 26 µs. A term budget per function (256 or 512 terms) changed nothing.

The whole machine step on generated code (derived validation of 759 cells, evaluation, writeback, output and input contracts) took a median 40.9 µs per frame over 3,000 frames, of which the derived validator was 0.75 µs.

How generated code gets fast, in fresh processes, µs per evaluation of the whole program by evaluation count (`report.ts tierup`, 32 rows per function):

| Backend | Setup ms | Evaluation 1 | 2-10 | 11-100 | 101-1,000 | 1,001-10,000 | 10,001-30,000 | 30,001-100,000 | Total s for 100,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| executor | 46 | 259 | 134 | 126 | 130 | 133 | 132 | 141 | 13.8 |
| generated | 23 | 31,153 | 1,469 | 3,766 | 1,446 | 100 | 83 | 41 | 7.1 |
| tiered | 54 | 321 | 165 | 153 | 144 | 182 | 101 | 46 | 8.0 |

The tiered backend stays on the executor for 1,000 evaluations, then promotes with 1 second of warmup, counted inside the 1,001-10,000 column. Generated code costs 31 ms for its first evaluation and 1.4 to 3.8 ms per evaluation for the next thousand, 10 to 30 times the executor, while JavaScriptCore runs the big functions before optimizing them. It passes the executor after about a thousand evaluations and reaches about 41 µs only after 30,000. At 60 frames per second, 30,000 evaluations are more than eight minutes of continuous animation, so the page has to warm the functions on copies of the table in idle time; the demo's 3 seconds of idle warmup cover roughly the first 10,000 evaluations of this curve, which run at about 100 µs.

## What this shows about how far the approach goes

### What fit well

- One circuit holds the window manager, exact multi-event input, keyboard routing, a photo viewer, and a paragraph that flows around windows with a spring per word, and every decision in it was an exact bit in every check: 0 mismatches against window-manager.ts, the one-event-at-a-time oracle, pretext, float64 springs, and the executor.
- The notation and the spring bank compose without loss: the bank written in the notation compiles to spring-bank's own counts.
- The bank's savings add up across the other changes: 1,353 operations with latches, 1,350 with the queue, 4,478 with Notes, where 45 words add 90 animated values. A lane costs four exact products, and a box one settle bit, where an `emitSpring` lane costs 46 operations and 33 layers.
- Laying text out against where windows are going worked the way hit-testing against destinations does in the doctrine: it's slightly cheaper than reading drawn geometry (19,854 against 19,861 operations, 343 against 368 layers), settled flows match pretext, and every animated value stays frame-rate independent.
- The folded queue made the named multi-event cases mechanical. One more slot costs about 120 operations, moves and keys included, and no depth (169 layers with 8 or 16 slots), and reading only a key's own phases kept Photos' focus sequence interleaved with the window sequence (169 layers against 257).
- Carving the column once per subset of blocking windows turned a per-band search into 8 slot computations and a 3-bit one-hot per band.
- Generated JavaScript kept its bit-for-bit contract on the whole program, and tiered execution can switch mid-session without changing a single written-back value.

### What got awkward

- Exact multi-event input costs more than latches: 4,476 more operations and 78 more layers. Every press session is paid on every evaluation whether or not a press arrived, about 2,200 operations and 40 layers, and one more slot costs about 120 operations. With one down per evaluation, and JS splitting the rare frame with two, the queue costs 2,233 operations.
- Photos' clicks are the most expensive part of the queue, 1,973 operations for three possible clicks per evaluation, because each click lays Photos out at the window's size at that point and hit-tests every thumbnail at the focus at that point. They're also most of the deepest path.
- Cancellable clicks needed new semantics, and the choices aren't free of judgment: buttons and dock items act on a click, drags follow the press geometry, windows are clamped at the end of an evaluation. From step 3 on, window-manager.ts can't be the reference, so the oracle is.
- The Notes flow costs more than the original desktop: 11,795 operations and 174 layers. The line walker is 8,221 operations and 173 layers of the deepest path, and integer one-hots, which exist only to read tables at a computed index, are 2,984 operations.
- Picking the widest slot with a sequential tournament put 50 layers of the deepest path into the carving, more than any other part of Notes except the walker.
- Some phase 2 gains interfered with others:
  - The timestep declaration saves 320 operations only while the original springs exist; the bank has no timestep products.
  - Photos reading stepped springs removed 46 layers with latches and none with the queue, because the queue computes Photos' focus in a sequence after the press sessions.
  - Obstacles from stepped springs cut 104 layers from current-frame obstacles, and made every animation in the program frame-rate dependent, windows included (28.8 px). They read last frame's stacking and presence, so after a click raised Notes, the words started moving one rendered frame later: 16.7 ms later at 60 fps, 8.3 ms later at 120 fps. All boxes share one clock, which stops while nothing animates and restarts in the frame something starts, so the two runs' clocks restarted at different times, and a delay of one frame in one feature became a timing difference for every later animation.
  - Generated code's advantage shrinks as the program widens, and the wide program needs far more runs before the engine optimizes it (below).
- Range declarations that describe the ideal value, like "a center within the viewport", break on FP32 rounding in corners such as a 2 px wide viewport.

### What stayed outside the circuit

- Text measurement and segmentation (pretext's `prepareWithSegments`), and rounding widths to 1/64 px.
- Decoding keys, whole-pixel coordinates, keeping the pointer stream legal, splitting frames into evaluations, coalesced pointer moves, and `preventDefault`.
- The frame delta from absolute timestamps, and deciding when to warm and promote generated code.
- DOM node lifetime: word spans are created once, photo nodes while visible; CSS turns numbers into colors, shadows and corner radii.
- Presses between frames. The machine applies a frame's events at the frame's time; spring-bank's extra evaluation at each event's timestamp wasn't built here.

## Open questions and next steps

- One Photos click per evaluation. JS could split a frame at every second up, so Photos would need one click per evaluation instead of three. That would remove about 1,300 operations, and Photos clicks are 74 of the 170 operations on the queue build's deepest path.
- A log-depth form for press sessions, e.g. input's idea of running session s + 1's hit test against every possible outcome of session s and selecting the matching result.
- An index read instruction for the walker, as in lab/ui-exploration/index-read. Replacing each of the 16 line slots' integer one-hots with one index read would remove an estimated 2,968 operations; this wasn't built.
- A shallower slot choice: comparing all pairs of candidates at once instead of a tournament.
- Clocks per animation group, so a delay in when one group starts moving can't shift when every other group's steps land.
- The instance axis from codegen. The 45 word boxes and 12 thumbnail boxes are the same program per item, which a batched executor or a shader runs well.
- Warming generated code ahead of time, or a backend whose functions don't need tens of thousands of runs to get fast.
- Open the demo in a browser: real Georgia widths, the idle-time promotion, and whether the words' springs read well while a window is dragged over Notes.

## Browser check

2026-09-13, Chrome. I served the page with `bun lab/ui-exploration/indirect-os-2/indirect-os.html` in a 1,160 by 853 CSS px viewport, and recorded `~/Downloads/ui-exploration-indirect-os-2-indirect-os.gif` (27 frames). Chrome reported the tab as hidden, so `requestAnimationFrame` only fired when a screenshot forced a frame. For the checks below, a console script replaced `window.requestAnimationFrame` with callbacks driven by a Worker timer every 16 ms, running only while a frame was pending. No file in this folder changed.

### What worked

- The page loads with no console errors. The System Monitor shows 759 inputs, 1,129 outputs, 8,500 affine, 10,872 ReGLU and 930 boolean operations, 343 layers and 50,732 weights. The layers match the table above. The 20,302 operations and 50,732 weights are more than the table's 19,854 and 49,900 because the demo compiles its program for `machine.roots`, which also keeps the Photos viewport, present and interactive wires, while `report.ts` measures only the next-source values and the outputs.
- The Notes flow with real Georgia widths. In the 8 settled layouts I checked, no visible word overlapped a window stacked above Notes, no two words on a line overlapped (the smallest gap between two words was 3.37 px), and no word crossed the content box's left or right edge. For example, with Photos above Notes at (600, 175), the paragraph took 11 lines between 115 and 152 px wide, and every word stayed at least 12.64 px away from Photos, more than the 10 px `horizontalPadding`. At load, Monitor and Photos together block every band below y 344, so 29 of the 45 words are visible.
- Word springs. After Photos was minimized, 41 words each passed through 49 to 53 distinct positions over about 810 ms before settling into 4 full-width lines.
- With the real mouse: raising Notes by its title bar, dragging Photos over Notes twice, minimizing Photos and restoring it from the dock, maximizing Photos to 1,136 by 717 px and restoring it, and opening a photo from the grid.
- Key routing with real keys while a photo was open. With Photos focused, ArrowRight moved from "Misty Lake" to "Desert Light", and Escape closed the photo. After a click on the Notes dock item gave Notes the focus, ArrowRight and Escape both left "Desert Light" open.
- Cancellable clicks. A scripted press on Files' close button, moves 12 px and 30 px away, a move back onto the button and a release there left Files open at the same place, and the press still focused and raised Files. A quick real click on the same button closed Files, and a click on its dock item reopened it.
- Frame time on generated code over the 636 frames of that session: median 2.3 ms, 3.9 ms at the 95th percentile, at most 36.3 ms.

### Promotion to generated code

When I first read the monitor, shortly after the first load, the page had already switched to generated code. Later loads never switched: in the hidden tab, a `requestIdleCallback` callback only ran once its timeout expired, with `didTimeout` true and `timeRemaining()` at 0, and the page asks for idle callbacks without a timeout. To see what promotion does to frames, I loaded the page twice more in an iframe and replaced its `requestIdleCallback` with a script that runs one idle callback per clock tick, with the rest of the 16.7 ms frame as its deadline, the way a visible tab schedules idle time. In both runs, a script dragged Photos over Notes for 11 s starting 300 ms after the page mounted, so the promotion ran while every frame animated.

| Run | Idle steps | Switched after | Steps that ran more than 4 ms past their deadline | Gaps between frames over 34 ms | Frame time on the executor | Frame time on generated code |
| --- | ---: | --- | --- | --- | --- | --- |
| 1 | 242 | 5.3 s of dragging | the first step (compile, then warm) 190.7 ms; warmup steps 446.5, 81.9, 68.9, 25.2, 21.5 and 19.5 ms; the last step (compare and switch) 21.6 ms | 448.8, 192.8, 84.7, 71.6 ms, and 44.5 ms before the first idle step | median 2.3 ms over 348 frames | median 1.1 ms over 398 frames |
| 2 | 244 | 5.3 s of dragging | the first step 86.7 ms; warmup steps 505.9, 64.7, 37.7, 18.7 and 18.7 ms; the last step 22.2 ms | 509.3, 89.2, 67.4 and 40.0 ms | median 2.1 ms over 333 frames | median 1.4 ms over 389 frames |

So in Chrome, the promotion does stall the animation. In both runs, one warmup step in the middle of the drag took about half a second, and the first step took 87 to 191 ms. A warmup step only checks the clock between runs of the generated functions, so one slow run, or a garbage collection during a step, makes the step overrun its deadline. I didn't find which of the two it was. After the switch, frames took about half as long.

### What didn't work, or looks off

- The last lines of the paragraph can hide under the window's bottom edge. With Files raised over the top of Notes, the circuit made 22 words visible on 5 lines with tops at y 415, 437, 459, 481 and 503, but the content box ends at y 469 and has `overflow: hidden`, so 13 of those words were partly or wholly cut off. In `notes.ts`, a band's `usable` bit depends only on the obstacles and the slot widths, and the Notes box passed to the flow has left, top and width but no height. 16 bands of 22 px after the 24 px padding reach 376 px, against a content box 320 px tall at the default window size. Not changed, since the band gate is circuit logic.
- A page that loads in a hidden tab can stay on the executor, since the promotion waits for idle periods that the hidden tab doesn't give.
- Not checked: resizing the window, frame pacing in a visible tab, and whether the springs look the same at other frame rates.

### Fixes

None.

## Words without springs, 2026-09-15

Each Notes word is now at the walker's x and y from the same evaluation, with no spring, so the text reflows once, in the frame of the event, while the windows animate. This removed the 45 word boxes, their snap bits and spring group, and 271 source cells: 6 per word, and the cell that marked the first evaluation. The Notes flow has no state of its own anymore. The paragraph's sentence "Each word follows its own spring to its new place" now reads "Words move straight to their new places in one frame"; with the test font, both texts give the same 89 segments, walker window, minimum slot width and compiled sizes. The sections above stay as they were measured with word springs. The numbers below come from `report.ts` on the new code; the browser check wasn't redone.

| Configuration | Source cells | Live operations | Layers | Stored weights | Gather reads | Widest layer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3. event queue (unchanged) | 309 | 8,059 | 169 | 21,611 | 91 | 387 |
| 4. Notes flowing around the windows' destinations | 488 | 18,027 | 337 | 44,326 | 987 | 532 |
| Notes around current-frame obstacles | 488 | 18,034 | 362 | 44,345 | 987 | 532 |
| Notes around stepped-springs obstacles | 488 | 18,207 | 258 | 44,647 | 987 | 538 |
| Notes around destinations, 1 down per evaluation | 488 | 15,781 | 298 | 38,124 | 960 | 532 |
| Notes with the original springs (timestep declared) | 444 | 19,377 | 337 | 46,829 | 987 | 576 |

- The Notes flow now adds 9,968 operations, 168 layers and 22,715 stored weights to step 3, against 11,795, 174 and 28,289 with word springs. The whole program is 12,774 operations, 145 layers and 32,728 stored weights more than window-manager.ts.
- The bank saves 1,350 operations with Notes, the same as with the queue alone, since the Notes flow has no springs left to replace (4,478 with word springs).
- In the whole program's breakdown, the spring boxes are 824 operations (4 windows and 12 thumbnails) and the clock and group 167, and every other section has the same operations as before. The deepest path is the line walker 174, down updates 52, slots per obstacle subset 50, up updates 41, other 10, end of evaluation 8, band blocking 2.

| Check | Frames or cases | Compared | Mismatches |
| --- | ---: | ---: | --- |
| whole program vs the one-event-at-a-time oracle, seeds 1 to 4 | 4 × 3,000 | 33,129 events, 5,046 of them keys | 0 frames |
| window and thumbnail boxes vs float64 doctrine springs | 3,000 evaluations | 48,000 boxes | 0 settle bits, 0 step counts; max 9.8e-5 px and 8.7e-4 px/s |
| settled Notes flows vs pretext's layoutNextLineRange | 150 | 6,750 words, 2,400 bands | 0 |
| generated JavaScript vs the executor, every live wire | 800 evaluations | 14,812,000 values | 0 |

The scripted session at 60 and 120 fps, 400 shared frames:

| Configuration | Windows, max px | Thumbnails, max px | Words, max px | Frames with different stacking, flags, photo focus, word visibility | Frames with different animationActive | Frames at 60 fps where words moved with no event |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4. Notes around destinations | 2.4e-4 | 1.8e-4 | 0 | 0 | 1 | 0 |
| Notes around current-frame obstacles | 2.4e-4 | 1.8e-4 | 0 | 0 | 1 | 8 |
| Notes around stepped-springs obstacles | 2.4e-4 | 1.8e-4 | 0 | 0 | 1 | 9 |

- Words carry no state, so at a timestamp both rates render, they're laid out from window geometry that agrees within 2.4e-4 px, and with every obstacle source they came out identical. The word differences of 25.4 px and 69.7 px, and the 28.8 px window difference, in [Frame-rate independence](#frame-rate-independence) came from the word springs: retargeting toward a different sequence of destinations at each rate, and restarting the shared clock at a different frame.
- The one frame with a different animationActive is frame 175, the same frame as in steps 2b and 3: the 60 fps run has stopped animating and the 120 fps run hasn't yet. With word springs, the words were still animating at that frame, so both runs reported animationActive.
- What separates the obstacle sources now is when the text reflows. With destinations, words move only in frames with an event. With current-frame obstacles, the text reflows in 8 frames with no event while Photos maximizes and restores (frames 141 to 143 and 255 to 262). With stepped-springs obstacles, it reflows in the same 8 frames and in frame 61, the frame after the click that raised Notes, since those obstacles read last frame's stacking.

`report.ts timings` and `report.ts tierup` were rerun on the new code as well, so all 5 entries of results.json come from it. Warm µs per evaluation, measured the same way as in [µs per evaluation](#µs-per-evaluation):

| Configuration | Live operations | Layers | Executor µs | Generated µs, 32 rows per function | Generated µs, 128 rows per function | Executor µs / generated µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4. Notes around destinations | 18,027 | 337 | 132.2 | 21.4 | 23.9 | 6.2 |
| Notes around current-frame obstacles | 18,034 | 362 | 126.2 | 21.5 | 25.4 | 5.9 |
| Notes around stepped-springs obstacles | 18,207 | 258 | 124.2 | 22.9 | 37.6 | 5.4 |

- With word springs, step 4 was 159.1 µs on the executor and 29.3 and 33.2 µs generated. Configurations 1 to 3 didn't change, and their rows moved by up to 10 µs on the executor between the two runs, e.g. window-manager.ts as the notation rewrite went from 42.5 to 32.5 µs, so differences of that size are noise between runs.
- The whole machine step on generated code took a median 36.0 µs per frame, against 40.9 µs with word springs, of which the derived validator was 0.58 µs.
- In fresh processes, generated code took 26.7 ms for its first evaluation, 81 µs per evaluation from the 1,001st to the 10,000th, and 34 µs after 30,000, while the executor stayed between 126 and 135 µs after its first evaluation.
