# Browser check of the ui-exploration demos

Status, September 15, 2026: each section below records one check as it ran, so later sections supersede the earlier "Look at these first" lists. E.g. "Morning fixes" fixed the first list's codegen, layout-tree, hn-thread, notation and text selection problems, and both demo directory checks found pixel-output drawing in Chrome.

2026-09-13, Chrome. I served each page with Bun's HTML dev server from the repo root, opened it in a tab I created, read the console, exercised what the folder's README describes, and recorded a GIF. Each folder's README.md now ends with a "Browser check" section. Nothing was committed.

## How the check ran, and what that limits

- Chrome reported my tab as hidden (`document.visibilityState` was `'hidden'`), so `requestAnimationFrame` only fired when a screenshot forced a frame, and timers were throttled. For pages that animate or check every frame, I replaced `window.requestAnimationFrame` from the console with a scheduler that runs callbacks about every 16 ms through a `MessageChannel`. That changed no files, but it means frame pacing wasn't the browser's own.
- The tab's viewport stayed at 2,320 by 1,268 CSS px (devicePixelRatio 2) whatever the window size. I resized the Chrome window to 900 by 700 and then 540 by 420 to try it, and the page never saw a resize, so no demo got a real window resize check. The Chrome window is left at that size.
- Chrome gives these pages `performance.now()` in steps of 0.1 ms, so µs figures on the demo panels are coarse, e.g. medians are always multiples of 100 µs.
- Chrome serializes numbers in inline styles to 6 significant digits, e.g. `translateY(12353.75px)` reads back as `12353.8px`. Any check that reads positions back from styles past 10,000 px needs a tolerance.
- Where a real pointer or keyboard wasn't enough, e.g. hundreds of states, a script dispatched input events or set slider values. Each README says which checks were scripted.
- GIFs were saved to `~/Downloads/`. The recorder dropped frames on some pages, so a few GIFs are short.

## text-walker/demo.html

- Loads, no console errors. 223 segments, 112 words, 34,132 live operations, 239 layers, compile time 2,350 ms.
- Checked: dragging the window reflows the paragraph around it, clicking words toggles bold, the column slider narrows and widens the text, and words spring to their places.
- Mismatch counter: 0 over 236 states (6 by hand, 230 scripted random widths and bold toggles).
- Evaluation median: 4,700 µs on load, then 600 to 1,600 µs.
- Small problem: dragging the title bar selects the "Drag me" text.
- GIF: `ui-exploration-text-walker-demo.gif`. No fixes.

## text-tabulated/demo.html

- Loads, no console errors. 10 blocks, 235 thresholds with real fonts, 1,985 live ops, 48 layers, circuit 25 to 98 µs.
- Checked: dragging the right edge to the 1,052 px clamp and back, and the autopilot traces.
- Agreement panel after 2,473 frames: 0 frames with a wrong decision, widest maxLineWidth drift 1.8e-4 px, widest heading x drift 1.5e-5 px.
- Problems: dragging the grip selects all text in the window. During fast autopilot drags, a right-aligned bubble's text briefly reaches past its springing bubble and gets cut off at the window edge.
- GIF: `ui-exploration-text-tabulated-demo.gif`. No fixes.

## index-read/demo.html

- Loads, no console errors.
- Checked: scrolling the 10,000-row list with each of the three circuits (every drawn slot's y was its row times 28 px), arrow keys and clicks on the photo strip (the focused photo stays centered).
- Building either relu one-hot circuit freezes the page for about 2.3 s. The bit gather variant showed 5.1 ms per evaluation, against 0.3 to 0.8 ms for the other two.
- Fixed in `demo.css`: the scroller filled the window (about 1,140 px) while the circuit only fills 24 slots of 28 px, so the lower part of the list was blank. The scroller now has `max-height: calc(23 * 28px)`. Tests (25) and tsgo pass.
- GIF: `ui-exploration-index-read-demo.gif`.

## spring-bank/demo.html and indirect-os.html

- Both load, no console errors.
- `demo.html`: flings work in both prediction modes, each box gets 301 keyframes over 1,200 ms. 9.3 to 29.6 µs per sample serially, 3.3 to 6.0 µs batched.
- `indirect-os.html`: minimize, restore from the dock, title bar drag, maximize, open a photo, "stall 500 ms", switching to 10 fps, and `?springs=original` all worked. The monitor's counts match the README (3,580 activations and 137 layers with the bank, 5,253 and 192 original). Frame execution was 16.7 ms on the first frame, then 0.4 to 3.2 ms.
- Not checked: whether motion looks the same at every frame rate, since the window wasn't visible.
- GIFs: `ui-exploration-spring-bank-demo.gif`, `ui-exploration-spring-bank-indirect-os.gif`. No fixes.

## notation/indirect-os.html and demo.html

- Both load, no console errors.
- `indirect-os.html`: 5,253 activations, 192 layers, 11,598 sparse weights, the same as the original. Drag, grip resize, maximize, lightbox and next photo worked, and no validator threw.
- `demo.html`: toggles, the segmented control, the slider and Reset work. 54 source cells, 670 live ops, 75 layers.
- Fixed in `demo.css`: while dragging, the slider knob was drawn about 124 px right and 84 px below its circuit position, because the knob had `scale: calc(1 + var(--dragging) * 0.12)` and the individual `scale` property also multiplies the `transform` translate. The circle is now a `::before` pseudo-element that scales around the knob's center. Tests (18) and tsgo pass.
- Not fixed: the slider's `dragging` output stays 1 in the frame that handles pointerup, and nothing schedules another frame, so the knob keeps its enlarged look until the next pointer event.
- GIFs: `ui-exploration-notation-indirect-os.gif`, `ui-exploration-notation-demo.gif`.

## lists/list.html and cards.html

- Both load, no console errors.
- `list.html`: scripted checks at 100 scroll positions each for uniform rows, variable heights, and variable heights after "New heights" with colors read through the slot one-hots. Every drawn slot held a row whose index mod 24 is the slot, rows were contiguous and covered the viewport, and swatches had their rows' hues. 0 problems in each run. Evaluation median 300 µs or less for uniform rows, about 3 ms for variable heights.
- `cards.html`: drags reorder the stack with 5, 20 and 100 cards (69,653 live ops at 100 cards, step median 900 µs). No range check stopped the machine.
- GIFs: `ui-exploration-lists-list.gif`, `ui-exploration-lists-cards.gif` (1 frame only; the recorder dropped the rest). No fixes.

## input/demo.html

- Loads, no console errors. 13,331 live operations, 262 layers.
- Checked by hand: title bar drag, clicking key 5, arrow navigation on the keypad, double-click to maximize, the Layout menu opening upward, "Cascade windows" by keyboard, and the About toast. Then 395 scripted keys over 200 frames.
- Divergence counter: 0 after 455 frames.
- Step time: 2,700 to 3,300 µs per evaluation over the first frames, then 220 to 260 µs.
- Small problem: on load, the Inspector window covers part of the Keypad's "#" key.
- GIF: `ui-exploration-input-demo.gif`. No fixes.

## text-editing/demo.html

- Loads, no console errors. 92,683 live ops, 536 layers, built in 609 ms.
- Checked: click to place the caret, typing, Backspace, Option+Left, Shift+Right selection, ArrowDown and ArrowUp with a kept preferred x, drag selection across lines, the "more than 12 lines" warning, and typing é, 字 and 👋.
- Last frame times: 1.4 to 12.3 ms.
- Small problems: while the text needs more than 12 lines, the caret sits at x = 4,096 px. After the emoji, the next glyph starts 4 px too far right, since canvas measured the emoji at 21 px and the DOM draws it at 17 px.
- GIF: `ui-exploration-text-editing-demo.gif`. No fixes.

## layout-tree/demo.html

- Loads, no console errors. 2,806 live ops, 115 layers, 5 grid columns.
- Checked: the menu button springs the sidebar closed and open. For all 80 texts, the DOM's line count equals the circuit's, with the sidebar open, closed, and on 90 frames during the animations (34 distinct sidebar widths).
- Not checked: wheel scrolling (the content fits this viewport) and window resizing.
- Fixed in `demo.ts`: any frame of 32 ms or longer stopped the page with "source wire 9 is outside its assumed range". The machine writes a timestep of up to 0.008 into a Float32Array, which stores 0.0080000004, above the cell's declared maximum of 0.008. The demo now passes at most 31.9999 ms, and 12 frames of 60 ms raised no error. Tests (8) and tsgo pass.
- Not fixed: the clamp in `app-shell.ts` still throws for any caller with `frameDuration >= 0.032`.
- GIF: `ui-exploration-layout-tree-demo.gif`.

## gallery/demo.html

- Loads, no console errors. 48,411 live operations, 61 layers.
- Checked: hover sets the zoom-in cursor, clicking a box opens the strip and sets the hash, arrow keys move the focus, Escape returns to the grid, and scrolling attaches only boxes near the viewport.
- Render time with DOM writes: 22 to 24 ms on the first frames, about 7 ms while the grid flies in, then 0.7 to 1.2 ms.
- Not checked: `?photos=cdn`, resizing, caption selection.
- GIF: `ui-exploration-gallery-demo.gif`. No fixes.

## hn-thread/demo.html

- Loads, no console errors. 55,821 live operations, 69 layers, 3,858 comparisons, setup 3,426 ms.
- Checked: scrolling with sticky banners, collapsing "wyclif" to "[+2]", the row-resize cursor on a gutter, and the peek while holding a press. 8 to 13 of 48 slots in use, step 750 to 5,150 µs.
- Native layout against the predicted heights: 141 comments match exactly. 109 draw 8 px shorter than predicted, and 108 of those start with text followed by `<p>` or `<pre>`: `.comment > :first-child { margin-top: 0 }` in `demo.css` removes the first block's margin, while `comment-doc.ts` counts an 8 px gap. With that margin restored by a script, 249 of 251 match. The DOM was never taller than predicted, so nothing is clipped.
- GIF: `ui-exploration-hn-thread-demo.gif`. No fixes.

## codegen/demo.html

- Doesn't load. The module graph throws "candidate gallery stage is missing" before `demo.ts` runs, so nothing is drawn and WebGPU never starts. Chrome did expose `navigator.gpu`.
- Cause: the folder imports `candidate-gallery.ts` (from `demo-model.ts` and `workloads.ts`) and `window-manager.ts` (from `window-ownership.ts`) from the repo root, and both mount their own page at import time whenever `document` exists. Headless runs have no `document`.
- A scratch copy of the page with off-screen candidate markup got past the first import, then threw "desktop is missing" from `window-manager.ts`. I stopped there.
- Not fixed, since it needs changes to repo-root modules other pages use.
- No GIF (the recorder captured 0 frames). Screenshot of the error on the scratch copy: `scratchpad/browser-check/codegen-import-error.jpg`. The scratch page is `codegen-workaround.html` in the same folder. Both are backed up at `~/github/indirect-scratch-backup/2026-09-15/scratchpad/browser-check/`.

## numeric-library/demo.html

- Loads, no console errors. 2,230 live ops, 41 layers, 3,932 weights.
- Checked: the ring spins and fills, e.g. 20 of 24 ticks at 82% and 3 at 11%. Hovering the dock magnifies the nearest icon to 95 px, with exactly one icon outlined.
- GIF: `ui-exploration-numeric-library-demo.gif`. No fixes.

## Files changed

- `lab/ui-exploration/notation/demo.css`: the slider knob circle moved to `::before`.
- `lab/ui-exploration/index-read/demo.css`: the scroller's `max-height`.
- `lab/ui-exploration/layout-tree/demo.ts`: the frame duration cap.
- A "Browser check" section at the end of the README.md of text-walker, text-tabulated, index-read, spring-bank, notation, lists, input, text-editing, layout-tree, gallery, hn-thread, codegen and numeric-library.
- This file.

## Look at these first

1. codegen: the page can't load until `candidate-gallery.ts` and `window-manager.ts` stop mounting at import, so the WebGPU half is still unverified in a browser.
2. layout-tree: `createAppMachine(...).step` throws on any frame of 32 ms or more. The demo works around it, the machine doesn't.
3. hn-thread: native text layout matches the prepared heights once the `:first-child` margin rule is accounted for. Decide whether to change the CSS or the model.
4. notation: check the slider knob fix, and decide whether a release should schedule one more frame.
5. index-read: the relu one-hot circuits freeze the page for about 2.3 s while building.
6. Text selection while dragging, in text-tabulated (all window text) and text-walker (the title).

## Morning fixes

Later on 2026-09-13, a second agent fixed the problems above inside the prototype folders, without editing repo-root files, and rechecked each demo in Chrome. The tab was still hidden, so pages ran with the same console replacement for `requestAnimationFrame`. The tab's viewport was 406 by 422 CSS px this time, and it didn't follow window resizes either, so where a demo needed a bigger viewport, I loaded the page in an iframe of that size, e.g. 2,320 by 1,268 px for hn-thread to match the first check. `lab/ui-exploration/` isn't in git yet, so before editing I copied the nine affected folders to the session scratchpad (`demo-fixes/backup/`, backed up at `~/github/indirect-scratch-backup/2026-09-15/scratchpad/demo-fixes/backup/`). Nothing was committed. Each README's "Browser check" section has the details.

### codegen

- Added `candidate-gallery-copy.ts` and `window-manager-copy.ts`: the root modules' code without the mount at import time, and without the DOM renderers that only the mount uses. Every codegen module imports the copies, the tests and `report.ts` included. The new `root-copies.test.ts` checks that each copy compiles to the same program as its root module, and that the IndirectOS copy steps to bit-identical values over the 240-frame scripted session. `bun test lab/ui-exploration/codegen` (20 tests) and tsgo pass.
- Recheck: the page loads and runs, and WebGPU is available. The probes gave the same answers as the headless wgpu and Dawn runs. With the max guard, GPU outputs matched generated JS bit for bit on all four workloads: 806,400 outputs for the shapes, 512,000 for the press map, 273,930 for the life calendar and 3,866,624 for the layout map. Without the guard, 23,883, 0, 132,879 and 325,019 of them differed. The generated JS backend draws every workload too.

### layout-tree

- `app-shell.ts` declares the `spring.timestep` cell's maximum as `Math.fround(0.008)`, the value the Float32Array stores, and `demo.ts` passes the measured frame duration again. A new test steps 120 frames of 100 ms, and it threw the old error before the change. The README's counts didn't change: live ops, layers, stored weights, widest layer and gather reads of all four depth variants, and the split by pass and tree level, came out identical before and after. 9 tests and tsgo pass.
- Recheck with frames of 100 ms: no errors. In a 1,280 by 800 px iframe, the menu button closed the sidebar in 11 frames and opened it again in 11 frames.

### hn-thread

- `demo.ts` gives the class `leading-block` to a comment's first `<p>` or `<pre>` only when no visible text comes before that element, and `demo.css` removes the top margin only for that class. 9 tests and tsgo pass.
- Recheck at 2,320 by 1,268 px: 249 of 251 comments match, i.e. the DOM's height plus the 12 px bottom gap equals the circuit's comment box height, as the first check's scripted estimate said. "The species over the individual…" is predicted one 14 px line taller than the DOM. The comment whose HTML starts with `<p></p><pre>` is predicted 8 px taller. Its block gaps add up to the same total in the DOM and in `comment-doc.ts`, so the difference comes from some block's text height, and I didn't find which block.

### notation

- `settings-dom.ts`: a pointerup or pointercancel sets a flag, and the frame that handles the release schedules one more frame. The circuit and its tests are unchanged. 18 tests and tsgo pass.
- Recheck: after a scripted slider drag, the release frame still set `--dragging` to 1, and the next frame set it to 0 without any further pointer event.

### text-walker and text-tabulated

- text-walker `demo.css`: the title bar sets `user-select: none`. A real mouse drag from "Drag me" moved the window and selected no text. 18 tests and tsgo pass.
- text-tabulated `demo.css`: the page sets `user-select: none`, and `.notes-content` and `.notes-panel` set `user-select: text`. The circuit's resize band reaches 8 px past the window's right edge, onto the page background, so the grip element alone wasn't enough. In a scaled iframe, real drags from the grip and from 4 px outside the edge resized the window and selected nothing, while a drag across a paragraph still selected its text. 10 tests and tsgo pass.

### text-editing

- `demo.ts` hides the caret while the circuit's overflow output is set, and the warning says the caret is hidden until the text fits. 17 tests and tsgo pass.
- Recheck: once the text needed more than 12 lines, the circuit's caret x was 2,048 px, and the caret was hidden. The caret also stays hidden when its output could be drawn, e.g. at (0, 0) after Command+ArrowUp, because the demo has no signal for whether the caret's own line is laid out. Deleting until the text fit brought the caret back.

### index-read

- Not changed. `demo.ts` already builds a relu one-hot circuit only when its menu item is chosen, and shows "building…" before the build starts, so the freeze is the build itself. In Bun, one build took about 500 ms to construct 750,154 operations, about 160 ms to compile the program for the stats line, and about 150 ms more because `createTensorEvaluator` compiles it again. Compiling once needs two functions that the folder's `numeric-ui-core.ts` doesn't export, and keeping built circuits to avoid rebuilding isn't cheap either, since one built relu one-hot circuit kept about 474 MB of heap alive in Bun. In Chrome this time, "relu one-hot, resolved from its index" showed "built in 8693 ms" with the tab hidden.

### Files changed in the morning

- `codegen/`: new `candidate-gallery-copy.ts`, `window-manager-copy.ts` and `root-copies.test.ts`. Imports switched to the copies in `demo-model.ts`, `workloads.ts`, `window-ownership.ts`, `indirect-os-machine.ts`, `report.ts`, `codegen.test.ts`, `instance.test.ts`, `wgsl.test.ts` and `indirect-os-machine.test.ts`. Header comments in `demo.ts` and `indirect-os-machine.ts`. README.
- `layout-tree/`: `app-shell.ts`, `app-shell.test.ts`, `demo.ts`, README.
- `hn-thread/`: `demo.ts`, `demo.css`, README.
- `notation/`: `settings-dom.ts`, README.
- `text-walker/`: `demo.css`, README.
- `text-tabulated/`: `demo.css`, README.
- `text-editing/`: `demo.ts`, README.
- `index-read/`: README only.
- This file.

## Third round: indirect-os-2 and instanced-items

Later on 2026-09-13, a third agent checked the two newest demos in Chrome, each served with Bun's HTML dev server from the repo root. The tab was hidden again, with a 1,160 by 853 CSS px viewport. This time the console replacement for `requestAnimationFrame` was driven by a Worker timer every 16 ms, and it only ran while a frame was pending. Nothing was committed, and no demo file changed. Each README's "Browser check" section has the details.

### How the check ran, and what that limits

- In this hidden tab, `requestIdleCallback` never got an idle period. A callback with a 2 s timeout ran after 2,059 ms with `didTimeout` true and `timeRemaining()` at 0, and timers ran in steps of about 1 s, e.g. a 100 ms timeout fired after 1,061 ms. indirect-os-2 promotes to generated code in idle callbacks without a timeout, so pages loaded later in the session never promoted on their own. For the promotion check, I loaded the page in an iframe and ran its idle callbacks from a script, one per clock tick, with the rest of the 16.7 ms frame as the deadline, the way a visible tab schedules idle time.
- Scroll events only fire when a frame renders, and the hidden tab rendered only during screenshots. For scripted scroll jumps in instanced-items, I dispatched a `scroll` event after `window.scrollTo`.
- The javascript tool gives up on a call after 45 s, so a script that waits for a long run has to return before then.
- GIFs are in `~/Downloads/`. The recorder kept 27 frames for indirect-os-2 and 7 for instanced-items.

### indirect-os-2/indirect-os.html

- Loads, no console errors. 759 inputs, 1,129 outputs, 20,302 operations (8,500 affine, 10,872 ReGLU, 930 boolean), 343 layers, 50,732 weights. The layers match the README. The operations and weights are more than the README's 19,854 and 49,900 because the demo also compiles the Photos viewport, present and interactive wires, which `report.ts` doesn't measure.
- Checked with the real mouse and keys: raising Notes, dragging Photos over Notes, minimize and restore from the dock, maximize and restore, opening a photo, ArrowRight and Escape with Photos focused (they act) and with Notes focused (they don't), a quick click that closes Files, and reopening Files from the dock. Scripted: pressing Files' close button, moving 30 px away and back, and releasing on the button left Files open.
- The Notes flow in 8 settled layouts: no visible word overlapped a window stacked above Notes or another word on its line, and words stayed at least 12.64 px away from an obstacle in their band, where the circuit pads obstacles by 10 px. After a minimize, 41 words passed through 49 to 53 positions each over about 810 ms.
- Promotion with scripted idle deadlines, while a script dragged Photos over Notes: in two runs, the switch came 5.3 s into the drag, one warmup step took about half a second (446.5 and 505.9 ms), and the first step took 190.7 and 86.7 ms. Frame time went from about 2.2 ms on the executor to 1.1 to 1.4 ms on generated code.
- Problem, not fixed because it's circuit logic: the paragraph's bands don't check the Notes content height, so with Files over the top of Notes, 13 of the 22 visible words sat partly or wholly below the content box's bottom edge and were clipped.
- GIF: `ui-exploration-indirect-os-2-indirect-os.gif`. No fixes.

### instanced-items/demo.html

- Loads, no console errors, at 10,000 photos and with `?count=221`. 233 operations per photo in 6 map stages, 401 shared operations, 31 reductions.
- Checked: scripted scroll jumps to 7 positions from the top to the bottom of the 851,495 px page, where every position attached 12 to 16 photos in contiguous rows, e.g. photos 9,988 to 9,999 at the bottom. A real wheel scroll, the zoom-in cursor on hover and auto over a gap, a click that opens the strip and sets `#synthetic-14`, ArrowRight and ArrowLeft, and Escape back to the grid at the same scroll position.
- Frame time at 10,000 photos depended on when I measured, not on the input: the HUD's average reached 4,249 to 5,020 µs during one part of the session, while five timed runs of 112 to 423 frames had medians of 12.3 to 19.0 ms. DOM writes took 36 to 214 µs. I didn't find the cause.
- GIF: `ui-exploration-instanced-items-demo.gif`. No fixes.

### Files changed in the third round

- `indirect-os-2/README.md` and `instanced-items/README.md`: a "Browser check" section at the end.
- This file.

### Look at these first

1. indirect-os-2: promotion stalls the animation in Chrome, e.g. a 505.9 ms warmup step during a drag, and a first step of up to 190.7 ms.
2. indirect-os-2: the Notes flow can put visible words below the window's bottom edge, since the bands don't know the content height.
3. instanced-items: in Chrome, a frame at 10,000 photos took from about 4 to 19 ms at different times in one session.

## Third round: talk-inspired demos

Later on 2026-09-13, another agent checked five more demos in Chrome: streaming-words, drag-knobs, event-time, pixel-output and code-points, each served with Bun's HTML dev server from the repo root. The tab was hidden, with a 1,160 by 853 CSS px viewport at devicePixelRatio 2. `lab/ui-exploration/` still isn't in git, and nothing was committed. Each README's "Browser check" section has the details.

### How the check ran, and what that limits

- As in the previous round, a console script replaced `requestAnimationFrame` with a Worker timer every 16 ms that only runs while a frame is pending. Waits inside scripts used a `setTimeout` inside a Worker, since main-thread timers were throttled.
- A Worker heartbeat every 10 ms measured main-thread stalls as gaps between its messages.
- In the hidden tab, `document.timeline` only advanced when a frame rendered, and a screenshot waited for the main thread. So nothing could show whether composited animations keep playing during a stall. Setting `playbackRate` on a running animation in this tab moved its `startTime` by up to 1,444 ms, since Chrome keeps the animation's current time, computed from a stale timeline. That only affected a scripted test, not the demo.
- Wheel ticks from the automation tool produced no frame, so scrolling was scripted with `wheel` events.
- GIFs are in `~/Downloads/`. The recorder kept 5, 12, 8, 1 and 17 frames.

### streaming-words/demo.html

- Loads, no console errors. 46,599 live operations, 205 layers and 98,642 stored weights for the demo's 194 segments.
- 886 states checked against pretext with 0 mismatches, 10 line changes of visible words, median evaluation 1,700 to 2,100 µs. A real Stop inside a word wrote 2 cells. Both ways an arriving word can start worked.
- Fixed in `demo.ts`: the first frame after the page went idle stepped springs through the idle time, up to 1,020 ms, so e.g. a width change moved words to their new places in one frame. When an input starts a new render loop, the springs' time now moves forward to the input, and the same change animated over 51 frames. The panel also refreshes on the last frame of a render loop now, so the width label doesn't stay stale. 10 tests and tsgo pass.
- GIF: `ui-exploration-streaming-words-demo.gif`.

### drag-knobs/demo.html

- Loads, no console errors.
- Real drags of a right edge and a bottom edge, the lock checkboxes and Reset knobs work. E.g. dragging the right edge of "Harbor at dawn" 80 px to the left gave "searched (picked sweep), error -0.33 px" and 4 columns. With gap and sidebarOpenWidth locked, a bottom edge drag moved cardPadding, and titleScale up to its maximum of 1.5, which left an error of 5.08 px.
- A scripted 12-move drag showed what a width drag does while the column count can't change smoothly: 0 gradient steps, and the search keeps the starting knobs until dropping a column gets closer, at +80 px with an error of -73.33 px. 6.7 to 10.9 ms per move.
- Small problem: "recent.grid drops to 1 columns".
- GIF: `ui-exploration-drag-knobs-demo.gif`. No fixes.

### event-time/demo.html

- Both presenters load, no console errors.
- Predicted keyframes: maximizing Photos started 14 animations with only transform and opacity, and 13 with width, height or z-index. `startTime` equaled the event's timestamp at Chrome's 0.1 ms precision. Both stall buttons blocked the main thread for about 500 ms (gaps of 561 and 502 ms), and the armed one ran after the next animated commit.
- The monitor's "26 composited" counts planned tracks, including 12 invisible photo or thumbnail tracks that get no animation.
- Display frames: a minimize ran 15 frames, and "stall 500 ms" blocked for 508 ms with no frame in between.
- Not verified: transform animations playing during a stall, see above.
- GIF: `ui-exploration-event-time-demo.gif`. No fixes.

### pixel-output/demo.html

- Doesn't draw in Chrome. The first frame throws "RangeError: Maximum call stack size exceeded" in `runShared`, with glyphs and with bars. `sumExpression` rounds the running sum before each term, so one generated statement of thread logic nests `f(...)` 1,003 deep, and a probe in Chrome threw at 665 levels. Bun's JavaScriptCore runs the same code.
- Not fixed in the repo, since `codegen.ts` also produces the generated JS the tests and `report.ts` measure. A scratch copy stores the running sum in a variable every 256 terms, which keeps the float32 values and brings the deepest statement to 257 levels, and its 8 tests pass. With the copy, WebGPU draws the thread with glyph text at 7.2 to 7.6 ms per frame. Of 247,080 CPU samples, 246,629 equal one of the two nearest GPU device pixels, and the other 451 sit on text rows and equal a device pixel within their 4 by 4 block.
- The copy is `scratchpad/browser-check-3c/pixel-output-workaround/`, and `pixel-output-workaround.diff` in the same folder shows the change. The copy and this round's other scratch files are backed up at `~/github/indirect-scratch-backup/2026-09-15/scratchpad/browser-check-3c/`.
- GIF: `ui-exploration-pixel-output-demo.gif` (1 frame). A screenshot of the scrolled WebGPU frame is `pixel-output-webgpu-scrolled.jpg` in the same scratch folder.

### code-points/demo.html

- Loads, no console errors. 77,100 live ops, 572 layers, built in 584 ms.
- Real typing of Latin text with numbers and of Korean, the Chinese, Korean and mixed samples, a scripted IME composition, Backspace, arrow keys, Shift selection, the width slider down to 160 px, and the font size toggle all work. At 160 px no line starts with 、, 。 or 」, "$1,299.99" stays whole, and lines 1 to 11 fit. At 22 px, glyph spans sit within 0.125 px of the circuit's positions.
- Small problem: once the text needs more than 12 lines, the caret and the hidden textarea move to the circuit's caret x, e.g. 890.5 px in a 160 px field.
- GIF: `ui-exploration-code-points-demo.gif`. No fixes.

### Files changed in this round

- `streaming-words/demo.ts`: the idle time fix and the panel refresh. `streaming-words-demo.diff` in the scratch folder above shows the change.
- A "Browser check" section at the end of the README.md of streaming-words, drag-knobs, event-time, pixel-output and code-points.
- This file.

### Look at these first

1. pixel-output: the demo can't run in Chrome until generated sums nest less deeply. The scratch copy's comma expression is one way, and it needs a decision, since the same generator produces the generated JS numbers in `report.ts`.
2. event-time: whether transform and opacity keep playing during a stall is still unverified in a browser. It needs a visible tab.
3. streaming-words: check the idle time fix in `demo.ts`, and decide whether `session.ts` should own that rule instead.
4. code-points: where the caret and the textarea go while the text needs more than 12 lines.
5. drag-knobs: "drops to 1 columns".

## Demo directory check

2026-09-13, Chrome. I started `bun lab/ui-exploration/serve-demos.ts` from the repo root, opened `http://127.0.0.1:4321/` in a tab I created, and followed every link on the index page: the 30 demo pages, the 7 query variants and the 29 README links. For each page I read the console, looked at a screenshot and tried one interaction. `lab/ui-exploration/` still isn't in git, and nothing was committed.

### How the check ran, and what that limits

- The tab was hidden again, with a 1,160 by 853 CSS px viewport at devicePixelRatio 2. I saved a script in the origin's `localStorage` and ran it on each page. The script replaces `requestAnimationFrame` with a Worker timer every 16 ms, and returns the page's navigation status, failed same-origin resource loads, window errors and a frame count. Every page is served from the same origin, so one saved script worked on all of them. I removed the script at the end.
- Each page had already scheduled its first frame with Chrome's own `requestAnimationFrame` before the script ran, so that first frame only ran when a screenshot forced it. Later frames ran on the Worker timer.
- I checked the README links with `fetch` from the index page instead of opening each one. All 29 returned 200 as non-empty `text/plain`.
- Where the automation tool's input wasn't enough, a script dispatched events or set control values, e.g. scroll positions, slider values and key presses. The results below say which interactions were scripted.
- In lists/cards.html, the automation tool's own drag didn't reorder the cards. The tool sends the press, the move and the release within one frame, and that page keeps only one sample of each event kind per frame. A drag with its moves spread over frames worked. A person's drag lasts many frames, so this only affects automated checks.
- In hn-thread, a `scroll` event dispatched on `window` threw "e.target.contains is not a function" from a Chrome extension's content script (`chrome-extension://…/content_script.js`), not from the page.
- Not checked: window resizing (the tab's viewport doesn't follow the window), whether motion looks right, and timing claims, e.g. the original springs ending about a second late at 10 fps.

### Results

All 37 page links returned 200, drew something and logged no console errors of their own. No page had a failed same-origin resource load, and the server log shows all 31 HTML imports bundled without an error.

- `/`, the index page: 34 cards and 71 links, with dark colors from `prefers-color-scheme`.
- `index.html`: 12 photos (the inlined webp files). Dragging the Notes title bar moved Notes and raised it above Photos.
- `candidate-gallery.html`: clicking the "Desert Light" thumbnail made it the large photo.
- `learned-gallery.html`: dragging the large Target rectangle moved it, and Learned retrained to match (loss 2.10e-5).
- `hard-attend.html`: moving the query slider from 1.00 to 1.80 (scripted) changed the winner from Banyan to Cobalt, and all three gathers returned 30.
- `lab/generative-fields/demo.html`: 8,421 operations and 201 layers. Clicking Mosaic started "filmstrip → mosaic", and both stages stayed valid.
- `lab/event-window/demo.html`: dragging the Atlas title bar moved Atlas and turned the autopilot off, with "757 frames · 0 divergences".
- `lab/reusable-layout/demo.html`: 12 inlined photos. New collection went from Collection 101 to 102 and recomputed the layout.
- text-walker: changing Column width from 520 to 376 px (scripted) rewrapped the paragraph, with 0 mismatches against pretext.
- text-tabulated: dragging the window's right edge narrowed Notes to 465 px. 364 frames had 0 wrong line breaks, and no text got selected.
- index-read: scrolling the list to 140,000 px (scripted) drew rows 5000 to 5023, and ArrowRight (scripted) moved the strip's focus from photo 110 to 111.
- spring-bank/demo.html: a click started 5 animations of 301 keyframes over 1,200 ms each.
- spring-bank/indirect-os.html with no query, `?springs=original`, `?fps=10` and `?springs=original&fps=10`: the selected controls and the monitor matched each link, e.g. 3,580 activations and 137 layers with the bank, 5,253 and 192 with the original springs. The maximize button maximized Photos on all four.
- notation/indirect-os.html: 5,253 activations, 192 layers and 11,598 sparse weights, the same as the original. Maximizing Photos worked.
- notation/demo.html: clicking the Bluetooth toggle and Dark worked, and the springs settled.
- lists/list.html: scrolling to row 7000 (scripted) drew rows from 7008, and switching to variable heights (scripted) rebuilt the program with 60,174 live operations.
- lists/cards.html: a drag spread over frames (scripted) reordered the cards from 0 1 2 3 4 to 1 2 3 0 4.
- input: clicking key 5 raised its counter to 1 and brought Keypad to the front, with "3 events · 1 evaluation · 0 divergences".
- text-editing: clicking after "Paste works too." and typing " Hi" took the buffer from 157 to 160 cells.
- layout-tree: the menu button closed the sidebar from 220 px to 0 px, and the grid went from 3 to 4 columns.
- gallery: clicking a photo set the hash, ArrowRight (scripted) moved it to the next photo, and Escape (scripted) cleared it. With `?photos=cdn`, the real photos loaded from Midjourney's CDN, and clicking a photo opened the strip on it.
- hn-thread: clicking the "wyclif" banner collapsed that comment to "[+2]". The thread scrolls inside `.comments-scroller`, not the window, and scrolling that element to 6,000 px (scripted) brought later comments into view.
- codegen: the page loads and draws. The shapes workload showed "GPU outputs differing from CPU 0 of 806,400". Switching to the IndirectOS press map (scripted) gave 0 of 512,000 differing, with and without the max guard.
- numeric-library: hovering above the middle dock icon magnified it from 48 to 104 px, with exactly one icon outlined, and the ring kept advancing.
- indirect-os-2: 759 inputs, 1,129 outputs, 343 layers, 50,732 weights, execution tier "generated". Dragging Photos away from Notes let the paragraph reflow to the full width.
- instanced-items: at 10,000 photos the page is 851,495 px tall, and scrolling to the bottom (scripted) attached photos up to 9,999. `?count=221` showed 221 photos, a scripted click set the hash, and Escape cleared it. `?count=1000` scrolled to photos 997 to 999.
- streaming-words: all 194 segments had arrived by the time the first frame was forced. Restart (scripted) streamed again, and Stop (scripted) wrote 1 cell at 44 of 194 segments, with 0 mismatched states.
- drag-knobs: dragging the right edge of "Harbor at dawn" 80 px to the left gave "searched (picked sweep), error -0.33 px" and 4 columns, the same as the earlier check.
- event-time: with predicted keyframes, maximizing Photos committed "3 event · 2 settle". With `?presenter=frames`, the same click ran 35 display frames and committed "3 event · 1 settle".
- pixel-output: the real page draws now, and no "Maximum call stack size exceeded" appeared. The earlier check only saw the fix working in a scratch copy. The 507-statement fragment shader compiled in 115 ms, a frame took 34.5 to 40.1 ms, and 10 wheel events (scripted) scrolled the thread.
- code-points: Insert Chinese (scripted) took the buffer from 62 to 92 code points, and a width of 160 px (scripted) wrapped the text into 9 lines, none starting with 、, 。 or 」.

### Fixes, and what still doesn't work

- No fixes. Nothing broke because all the pages share one server, and no file changed except this one.
- Nothing I tried failed. The limits listed above still apply, e.g. resizing and motion quality weren't checked.

## Demo directory check, 2026-09-14

2026-09-14, Chrome. Another agent repeated the check above. `serve-demos.ts` and `demos.html` hadn't changed since then. I started `bun lab/ui-exploration/serve-demos.ts` from the repo root, opened `http://127.0.0.1:4321/` in a tab I created, opened IndirectOS by clicking its card's link, and navigated to each of the other page links. For each page I read the console, looked at a screenshot and tried one interaction. `lab/ui-exploration/` still isn't in git, and nothing was committed.

The check ran the way the first one did: a hidden tab with a 1,160 by 853 CSS px viewport at devicePixelRatio 2, and a script saved in the origin's `localStorage` that replaced `requestAnimationFrame` with a Worker timer every 16 ms. I removed the script at the end. A page whose next frame was already scheduled with Chrome's own `requestAnimationFrame` only moved on when a screenshot forced a frame, e.g. text-walker ignored a scripted width change until the next screenshot. "Scripted" below means a script dispatched the events or set the control's value.

### Results

All 37 page links returned 200, drew something, and logged no console errors of their own. No page had a failed same-origin resource load, and the server log has no bundling errors. From the index page (34 cards, 71 links), `fetch` returned 200 for every page and its bundled script, and non-empty `text/plain` for all 29 README links. The only console error came from a Chrome extension's content script ("e.target.contains is not a function") when my script dispatched a `scroll` event on `window` in instanced-items, the same error the first check saw in hn-thread.

- `index.html`: dragging the Notes title bar moved Notes. Notes stayed below Photos, while the first check saw Notes raised above Photos. I didn't look into why.
- `candidate-gallery.html`: clicking "Desert Light" made it the large photo.
- `learned-gallery.html`: dragging the large Target rectangle moved it, and Learned started retraining.
- `hard-attend.html`: moving the query slider from 1.00 to 1.80 (scripted) changed the winner from Banyan to Cobalt, and the one-hot and direct gathers returned 30.
- `lab/generative-fields/demo.html`: clicking Mosaic started "filmstrip → mosaic", and both stages stayed valid.
- `lab/event-window/demo.html`: dragging the Atlas title bar moved Atlas and turned the autopilot off, with 0 divergences.
- `lab/reusable-layout/demo.html`: all 12 photos are inlined webp data URIs, and New collection (scripted) went from Collection 101 to 102.
- text-walker: changing Column width from 520 to 376 px (scripted) rewrapped the paragraph, with 0 mismatches.
- text-tabulated: dragging the window's right edge narrowed Notes to 469 px, with 0 wrong line breaks over 366 frames and no selected text.
- index-read: scrolling the list to 140,000 px (scripted) drew rows 5000 to 5022, and ArrowRight (scripted) moved the strip's focus from photo 110 to 111.
- spring-bank/demo.html: a click flung the five shapes, each with 301 keyframes over 1,200 ms.
- spring-bank/indirect-os.html with no query, `?springs=original`, `?fps=10` and `?springs=original&fps=10`: the selected controls matched each link, the monitor showed 3,580 activations and 137 layers with the bank and 5,253 and 192 with the original springs, and the maximize button maximized Photos on all four.
- notation/indirect-os.html: 5,253 activations, 192 layers and 11,598 sparse weights. Maximizing Photos worked.
- notation/demo.html: clicking the Bluetooth toggle and Dark worked, and the springs settled.
- lists/list.html: scrolling to 280,000 px (scripted) drew rows 7000 to 7017.
- lists/cards.html: a drag spread over frames (scripted) reordered the cards from 0 1 2 3 4 to 1 2 3 0 4.
- input: clicking key 5 raised its counter to 1, with "3 events · 1 evaluation · 0 divergences".
- text-editing: clicking after "Paste works too." and typing " Hi" took the buffer from 157 to 160 cells.
- layout-tree: the menu button closed the sidebar from 220 px to 0 px, and the grid went from 3 to 4 columns.
- gallery: clicking a photo set the hash, ArrowRight (scripted) moved to the next photo, and Escape (scripted) cleared the hash. With `?photos=cdn`, the photos loaded from Midjourney's CDN, and clicking one opened the strip on it.
- hn-thread: clicking the "wyclif" banner changed it to "[+2]", and the comment collapsed only after the next input event, see below.
- codegen: WebGPU drew the shapes with 0 of 806,400 GPU outputs differing from generated JS, and the IndirectOS press map (scripted) gave 0 of 512,000.
- numeric-library: hovering above the middle dock icon magnified it from 48 to 98 px, with exactly one icon outlined.
- indirect-os-2: 759 inputs, 1,129 outputs, 343 layers, 50,732 weights, execution tier "generated". Dragging Photos off Notes let the paragraph use the window's full width.
- instanced-items: at 10,000 photos, scrolling to the bottom (scripted) attached photos 9988 to 9999. With `?count=221`, the grid showed the real photo list, a click set the hash, and Escape (scripted) cleared it. With `?count=1000`, the bottom showed photos 988 to 999.
- streaming-words: Restart streamed the reply again with 0 mismatched states, and Restart then Stop (scripted) at 27 of 194 segments wrote 1 cell.
- drag-knobs: dragging the right edge of "Harbor at dawn" 80 px to the left gave "searched (picked sweep), error -0.33 px", the same as the first check.
- event-time: maximizing Photos committed "3 event · 2 settle". With `?presenter=frames`, the same click ran 35 display frames and committed "3 event · 1 settle".
- pixel-output: WebGPU drew the thread with legible glyph text, and 10 `wheel` events (scripted) scrolled it at 6.8 ms per frame.
- code-points: Insert Chinese (scripted) took the buffer from 62 to 92 code points, and a width of 160 px (scripted) wrapped the text into 9 lines, none starting with 、, 。 or 」.

### Fixes, and what still doesn't work

- No fixes. Nothing broke because all the pages share one server, and no file changed except this one.
- hn-thread, not caused by the shared server: the render that handled the banner click changed the banner to "[+2]" but didn't move any rows, and the circuit's `scheduleNextRender` output didn't ask for another render. The comment's text and its reply stayed drawn through two more screenshots. They went away after the next input event, a `pointermove` dispatched by a script, which ran 31 frames of the collapse. A person's pointer usually moves after a click, but a click with no movement after it may leave the comment drawn until the next event. I didn't change it, since `scheduleNextRender` is a circuit output.
- The limits of the first check still apply, e.g. window resizing and motion quality weren't checked.
