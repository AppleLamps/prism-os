# Behavior choices

These choices change what the user sees, to shorten dependency chains, to make stored state independent of the frame rate or of the sizes that the viewport had, or to keep each frame's work under a fixed maximum. Constructions that replace one familiar expression are in [expressions.md](expressions.md), and loops rewritten without changing what the user sees are in [patterns.md](patterns.md). Contracts stay in [execution-model.md](execution-model.md), and each entry links the sections it depends on.

Several entries compare with [ui.md](https://github.com/chenglou/chenguini/blob/main/docs/ui.md) of chenguini, a set of engineering and UI guidelines. HandwiredOS's render loop follows ui.md's, except for [when events apply and when state is written back](#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks), and it snaps where ui.md carries leftover spring steps into later frames ([A fixed maximum with a named fallback](#a-fixed-maximum-with-a-named-fallback)).

## Hit-test destinations instead of drawn positions

When an element animates, test a press against its destination, the position its spring is heading to, instead of where the element is drawn. ui.md's "Hit Testing" section recommends this, as testing `dest` instead of `pos`.

```js
// familiar: test where each item is drawn
let pressedIndex = items.findIndex(item => contains(item.drawnRect, pointer))
// the choice: test where each item's spring is heading, e.g. toasts that slide up after one is dismissed
pressedIndex = items.findIndex(item => contains(item.destinationRect, pointer))
```

**What the user sees differently.** In the toast stack of [the guide](../lab/ui-exploration/guide/README.md), three presses 80 ms apart, 4 px below the top, dismiss three toasts, like closing tabs in Safari by clicking the same spot. Testing drawn positions dismisses one toast, since the second and third presses land above a toast that's still sliding up. A single press on a moving element can act on another element: 80 ms after a dismissal, a press at 60 px dismisses the toast whose destination is under the pointer, not the toast drawn there.

**Circuit version.** Destinations come from stored state, e.g. a toast's destination top is 48 px times the number of present toasts above it. Destinations built from whole pixels and bits lie on a grid, like pointer coordinates quantized to 1/64 px, so `emitCompare` builds integer bits, and destinations that don't overlap give at most one hit, so no `emitFirstActive` tree is needed. Drawn positions come out of spring arithmetic and lie on no grid, so each of their comparisons is a sign cascade.

**Cost.** In the toast stack, the hit test up to the pressed bits is 35 operations in 5 layers on destinations, and 205 in 34 on drawn positions.

**Why choose it.** For the user, ui.md's reasons: moving elements don't cause mis-clicks, and rapid repeated presses work. In the circuit, the hit test reads only stored state, so no spring has to run before it.

**Don't use it when.** A press should act on what's drawn under the pointer, e.g. the start of a drag: ui.md keeps the drawn position for drag targets, so a card can be grabbed where it's drawn. Destinations of present elements can overlap: pick one hit with `emitFirstActive`.

**Contract, long form, tests.** execution-model.md's [Comparisons](execution-model.md#comparisons) and [Grids](execution-model.md#grids); [hit-test-destinations.md](../lab/ui-exploration/guide/patterns/hit-test-destinations.md), tested by [hit-test-destinations.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/hit-test-destinations.test.ts). window-manager.ts lays out Photos at the window's destination size, and reads a Photos click relative to the content box at the window's destination.

## Apply events at their timestamps, and write state back only at events and settle checks

Step springs to each event's timestamp before applying the event, and write next state back only at events and settle checks. The familiar order, in ui.md's "Render Loop", handles a frame's inputs, then steps springs up to the frame's timestamp toward the new destinations, then commits state, on every render, so springs pull toward a new destination from before the event, and which frames ran becomes part of stored state. The choice keeps the program as it is, and changes when the host runs the program and when the host writes next state back.

```js
function render(now) {
  handleInputs(st.events) // e.g. a press that gives a toast a new destination
  stepSpringsUpTo(now) // every catch-up step pulls toward the new destination
  commitState() // on every render, so which frames ran becomes part of the state
}
```

**What the user sees differently.** A new destination starts pulling within 4 ms of the event at any frame rate. With ui.md's order, the new destination pulls from up to one frame plus 4 ms before the event, and an animation from rest starts at the next frame, up to one frame after the event: in a float64 copy of ui.md's order, 10 fps differs from 120 fps by up to 359 px at shared timestamps. Writing state back only at events and settle checks changes nothing visible at a steady frame rate, e.g. the toast stack's drawn tops stay within 1e-4 px of float64 springs either way.

**Circuit version.** host-timing.ts's `advanceFrame(clock, frameTimeStamp, events, evaluate, writeBack)` plans a frame's evaluations: one per distinct event timestamp, which steps springs to that timestamp toward the destinations in effect before it and then applies the events, a settle check every 64 ms of simulated time, and one at the frame's timestamp. With `'events and settle checks'`, only event, settle check and snap evaluations write state back, and the frame's evaluation runs on a copy of the table. In the program, `emitAnimatedObject` steps springs toward `destinationDuringSteps`, the destination before this evaluation's events, and an object not exactly at rest settles only while the `settleCheck` cell holds 1.

**Cost.** The same program at the same size and depth, and the same evaluations as when every evaluation writes back. Each frame first copies the table, e.g. 22 cells in the toast stack.

**Why choose it.** Stored state depends only on the events: in the toast stack, every stored table and every drawn top at a shared timestamp is identical in every bit at 10, 30, 60 and 120 fps and through 500 ms stalls, so replaying recorded events at another frame rate, e.g. in a screenshot test, reproduces the screen bit for bit. When every evaluation writes back, about half the tables that frames store differ in bits between 60 and 120 fps. Stored state stays bit-identical only while events arrive in timestamp order and no snap runs: a frame gap from just above 1,140 ms can snap every object onto its destination at one frame rate and not at another.

**Don't use it when.** A stage reads last frame's value on purpose, since that value then comes from the last evaluation that wrote state back, see [Read last frame's value](#read-last-frames-value). An input that changes destinations can't reach `advanceFrame` as a timestamped event, e.g. a viewport width written every frame without a resize event: springs then pull toward it from frame times again. Nothing replays sessions, so bit-identical stored state doesn't matter.

**Contract, long form, tests.** execution-model.md's [The ordering rule](execution-model.md#the-ordering-rule), [Settling at fixed simulated times](execution-model.md#settling-at-fixed-simulated-times), [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back) and [Static bounds](execution-model.md#static-bounds); [commit-at-events.md](../lab/ui-exploration/guide/patterns/commit-at-events.md), and springs.md's [ui.md's render order is frame-rate dependent](../lab/ui-exploration/guide/sections/springs.md#uimds-render-order-is-frame-rate-dependent-when-a-destination-changes-between-frames); tested by [commit-at-events.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/commit-at-events.test.ts) and [spring-matrix.test.ts](../tests/runtime/spring-matrix.test.ts). HandwiredOS runs this way, and [window-manager.test.ts](../tests/handwiredos/window-manager.test.ts) replays a timestamped session at several frame rates and checks that the stored tables and drawn outputs are identical.

## Read last frame's value

A stage reads a stored copy of a value from the previous frame instead of this frame's value, so the stage's layers no longer come after the chain that computes the value. Use it only on outputs that tolerate one frame of lag, and prefer an earlier value from the same evaluation, or a destination, where one exists.

```js
stepSprings(now) // e.g. a drawer springs open while its thumbnail grid reflows
layout = computeLayout(containerWidth.pos) // familiar: this frame's width
layout = computeLayout(previousContainerWidth) // the choice: last frame's width
previousContainerWidth = containerWidth.pos // stored with the rest of the state
```

**What the user sees differently.** The stage's output is a frame behind while the value moves. In the guide's drawer, 12 thumbnails reflow from 2 to 5 columns while the drawer springs from 320 to 760 px wide. Laid out for last frame's width, the grid trails the drawer's edge by up to 60 px at 60 fps and 159 px at 10 fps, and about 5% of frames at 60 fps drew a different column count, which moved a thumbnail by up to 533 px. At rest both layouts are the same.

**Circuit version.** The copy is one more source cell with a declared range, whose next value is this evaluation's value, e.g. `nextSource[previousWidth] = drawnWidth`, written back with the other next-state values. The longest chain through the value becomes the longer of the part that computes the value and the part that reads it, instead of the two added together.

**Cost.** No more operations, one more source cell, and one more copy per evaluation that writes back. The drawer is 144 operations either way, in 17 layers instead of 30.

**Why choose it.** Fewer layers with no more operations. Fewer layers only save time on an executor that runs a layer's operations at the same time, while today's CPU executor pays per operation.

**Don't use it when.** The stage computes a decision: a column count a frame late moved thumbnails by up to 533 px. An earlier value from the same evaluation exists: a spring's position right after this evaluation's steps is 4 layers deep, and the drawer reading that position takes 21 layers and draws the same layout as this frame's width in every frame. State is written back only at events and settle checks: the copy is then as old as the last of those evaluations, and the drawer's lag grows from 60 px to 174 px at 60 fps.

**Contract, long form, tests.** execution-model.md's [In the program](execution-model.md#in-the-program), for the position right after the steps, and [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back); [read-last-frame.md](../lab/ui-exploration/guide/patterns/read-last-frame.md), and chains.md's [way 4](../lab/ui-exploration/guide/sections/chains.md#way-4-read-last-frames-value), which has the measurements in HandwiredOS; tested by [read-last-frame.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/read-last-frame.test.ts).

## A fixed maximum with a named fallback

A program's size is fixed while building, so every count that JavaScript keeps in a growing array or a loop variable becomes a maximum, and what the program does past the maximum is part of the behavior. ui.md caps a frame's spring steps at 300 in "Render Loop", following chenguini's [Animation.md](https://github.com/chenglou/chenguini/blob/main/docs/Animation.md), "Spiral of Death Prevention", and carries the rest of the backlog into later frames, while host-timing.ts snaps instead. When every occurrence counts, ui.md's "Event Handling" pushes events onto an array with no maximum.

```js
const steps = Math.floor((now - animatedUntilTime) / msPerStep) // e.g. every catch-up step after a stalled tab
st.events.keydowns.push(event) // every key event before the next render
const visibleRows = rows.filter(isVisible) // one DOM node per visible row
```

**What the user sees differently.** Only at the maximum, where the named fallback runs. E.g. past 300 steps, every animated object snaps onto its destination, which shows after a stall of about 1.2 s while something still moves. In the text field of [lab/ui-exploration/code-points](../lab/ui-exploration/code-points/README.md), lines past 12 aren't laid out, and the demo shows a warning. The list in HandwiredOS's Monitor window says "Only 64 rows are drawn at a time." when the window shows more rows than the list has DOM slots. HandwiredOS's Photos has two springs for the zoom of its 12 photos, one for the open photo and one for the photo that was closed last, about 300 operations fewer than a spring per photo. When a second photo is closed while the first is still on its way back, which takes a close, an open of another photo and a second close within about half a second, the first photo jumps into its cell. Extra events in a frame go to another evaluation, which the user never sees.

**Circuit version.** Give each quantity a maximum and one of these fallbacks: snap, e.g. `advanceFrame` runs a snap evaluation when a frame would need more than `maxStepsPerFrame` steps; carry, e.g. ui.md's backlog of steps; split, e.g. a host that runs another evaluation for the events that don't fit the program's event cells; report, e.g. the `slotOverflow` output of the list in HandwiredOS's Monitor window; drop, e.g. rows past the last of that list's 64 DOM slots get no node; clamp, e.g. a release velocity at ±2^16 px/s; or throw, e.g. the range check on every source cell.

**Cost.** Every capacity is paid on every evaluation, whether or not it's used, e.g. about 210 operations per character cell of a text field ([lab/ui-exploration/code-points](../lab/ui-exploration/code-points/README.md)), and about 2,200 operations and 40 layers for each press that an event queue over the whole HandwiredOS can take in one evaluation ([lab/ui-exploration/input](../lab/ui-exploration/input/README.md)).

**Why choose it.** The program keeps a fixed size, and so does its backward pass, e.g. `emitApplySpringMatrix` is 14 operations whether the frame runs 2 steps or 300. A fallback turns a limit into defined behavior that a plain JavaScript reference can reproduce, e.g. a reference that clamps the release velocity the way the circuit does.

**Choosing the maximum.** Pick it from the quantity's measured distribution, so normal use doesn't reach it, e.g. 300 steps against about 4 per frame at 60 fps, or 48 DOM slots against at most 32 needed in the measured states of lab/ui-exploration/hn-thread. Give every maximum an output or a check, e.g. an overflow output like `slotOverflow`: without one, a program past a capacity computes wrong values, and no output shows the problem.

**Contract, long form, tests.** execution-model.md's [Static bounds](execution-model.md#static-bounds); differentiability.md's [Static bounds with named fallbacks](../lab/ui-exploration/guide/sections/differentiability.md#static-bounds-with-named-fallbacks), and executor.md's [Fixed capacities](../lab/ui-exploration/guide/sections/executor.md#fixed-capacities) and [How a frame's events are handled](../lab/ui-exploration/guide/sections/executor.md#how-a-frames-events-are-handled); tested by [spring-matrix.test.ts](../tests/runtime/spring-matrix.test.ts), e.g. "a 3 s stall snaps every object onto its destination once, no frame runs more than 300 steps, and the committed tables stay bit-identical across frame rates".

## Store what the user placed, and fit it to the viewport in every evaluation

When the viewport can get too small for an element's stored rectangle, e.g. a window near the right edge of a browser window that shrinks, keep the stored rectangle as the user placed it, and compute the rectangle that fits the viewport from it in every evaluation. HandwiredOS's windows do this. chenguini's [engineering.md](https://github.com/chenglou/chenguini/blob/main/docs/engineering.md), "Data Modeling", says to compute derived data and not to store it on the data that it came from, and ui.md's "State The Browser Keeps" counts the viewport's size among a frame's inputs.

```js
// familiar: clamp the stored rectangle in every frame, so every viewport the page ever had is part of the state
windowRect = clampIntoViewport(windowRect, viewport)
// the choice: the stored rectangle is what the user placed, and the fitted one is computed and not stored
const fittedRect = clampIntoViewport(windowRect, viewport)
// a drag starts from where the window is drawn, and stores only in an evaluation in which the pointer moved
if (dragging && (deltaX !== 0 || deltaY !== 0)) windowRect.left = fittedRect.left + deltaX
```

**What the user sees differently.** A viewport that shrinks and grows back leaves every window where it was, e.g. a phone turned on its side and back. With the fitted rectangle written back instead, that turn leaves HandwiredOS's three windows on one small rectangle, and a window keeps the smallest size that a viewport ever gave it. A window that is only dragged while a small viewport makes it smaller keeps its stored size, and has that size again in a larger viewport. A press and a release at one point store nothing, e.g. a tap on a title bar that only brings its window to the front.

**Circuit version.** The fitted rectangle is a clamp of each stored cell against the viewport's cells, `fitIntoWorkspace` in window-manager.ts. Each window is fitted once before the hit tests and once after the drag or the resize, and the hit tests, the drawing and the springs read the fitted rectangle. A drag stores the position, a resize the position and the size, and one bit, whether the pointer moved in this evaluation, selects between the stored value and the new one. For a value that comes out of `emitMinimum` and `emitMaximum` clamps, the builder infers less than the clamps guarantee, e.g. no grid for the fitted edges, and a range far wider than the viewport. So the fitted rectangle declares its range, which is the viewport cells', and its 1/64 px grid, with `assumeRange` and `assumeGrid`. Without the two declarations, the hit tests' comparisons are sign cascades instead of integer bits.

**Cost.** In HandwiredOS, with three windows, 125 live operations and 7 layers. Without the two declarations, 844 more live operations and 5 more layers.

**Why choose it.** The stored rectangle depends only on what the user did, so the same drags and resizes give the same windows whatever sizes the viewport had in between, and a test can compare stored and drawn rectangles with a plain JavaScript reference over random viewports.

**Don't use it when.** A press whose release is a few pixels away should count as a click: "the pointer moved" is then the wrong bit to store on, and the bit has to say that the drag passed its threshold. HandwiredOS has no drag threshold, so a release 1 px from its press drags the window by 1 px and stores where that leaves it.

**Contract, long form, tests.** execution-model.md's [Comparisons](execution-model.md#comparisons) and [Grids](execution-model.md#grids); the comment "A window's rectangle while it isn't maximized" in window-manager.ts's `buildWindowManager`; tested by [window-manager.test.ts](../tests/handwiredos/window-manager.test.ts), in the tests whose names start with "a viewport that shrinks and grows back", "a press and a release that move nothing store nothing" and "stored and drawn rectangles equal a plain JavaScript reference".

## Anchor the scroll position to the row at the top of the view

When the program computes the scroll position, e.g. of a virtualized list whose row heights change with the container width, the program moves the view by as much as the row at the top of the view moved, instead of keeping the scroll position in pixels, and the host turns off the browser's own scroll anchoring. chenguini's [Scrolling.md](https://github.com/chenglou/chenguini/blob/main/docs/Scrolling.md) documents scroll anchoring in plain JavaScript in its "Scroll Anchoring" section, and lists CSS `overflow-anchor` among the less preferred alternatives.

```js
// familiar: keep scrollTop in pixels, so rows above the view that change height move the rows in view
spacer.style.height = `${totalHeight}px`
// the choice: move the view by as much as the row at its top moved, e.g. after a resize from 1200 to 400 px
const atBottom = scrollTop + viewportHeight >= previousTotalHeight // the view showed the end of the rows, like a chat log
const anchorRow = previousBottoms.findIndex(bottom => bottom > scrollTop)
scrollTop = atBottom ? maximumScroll : Math.min(scrollTop + tops[anchorRow] - previousTops[anchorRow], maximumScroll)
```

**What the user sees differently.** Rows above the view that get taller or shorter don't move the rows in view: after a resize, an edit above the view, or a scroll in the same frame as either, the row at the top of the view keeps its position on screen, and a view that showed the end of the rows keeps showing the end after an append. When the row at the top gets shorter than its part above the view, that row goes out of view and the next row comes first.

**Circuit version.** The program keeps every row's bottom from the last evaluation in state cells, and finds the anchor row with a binary search over those bottoms at the scrollTop the DOM reports now, which includes any scroll since the last evaluation. Storing only the first row and its top after each evaluation would miss that scroll: a scroll and a resize in one evaluation would then move the view by the rows scrolled past times their change in height, e.g. by 35,000 px. The host writes the spacer's height before the scroll position, so the browser doesn't clamp the new scroll position to the old height, writes `scrollTop` only when it differs from the scroller's, and sets `overflow-anchor: none` on the scroller, so Chrome's own scroll anchoring doesn't also move the view.

**Cost.** In the text rows demo of [lab/ui-exploration/lists](../lab/ui-exploration/lists/README.md#anchoring) at 10,000 rows: 10,000 state cells for the bottoms, which the host copies back with one `Float32Array.set` in about 0.4 µs, 13 index reads and 14 comparisons for the anchor row, and 1,290 of the program's 111,271 live operations for the scroll position, the anchor row, the first row and the 64 DOM slots together.

**Why choose it.** One rule covers resizes, edits above the view, viewport height changes and a scroll in the same frame as any of them, and it's exact, since row tops are whole pixels.

**Don't use it when.** Row tops aren't whole pixels: each frame starts from the scrollTop that the browser rounded, so the rounding adds up. E.g. chenguini's Scrolling.md measured an anchor drifting 3 to 4 px over a 15-step continuous resize with this formula, and keeps the anchor's position on screen from when the anchor was picked instead.

**Contract, long form, tests.** execution-model.md's [Index reads](execution-model.md#index-reads) and [Grids](execution-model.md#grids); [Anchoring](../lab/ui-exploration/lists/README.md#anchoring) in the README of lab/ui-exploration/lists, with the program in [text-rows.ts](../lab/ui-exploration/lists/text-rows.ts) and the DOM writes in [text-rows-demo.ts](../lab/ui-exploration/lists/text-rows-demo.ts); tested by [text-rows.test.ts](../lab/ui-exploration/lists/text-rows.test.ts), whose random sessions check that the row at the top of the view keeps its position on screen, and by text-rows-browser.ts in headless Chrome.

## Scroll a list natively, and select a row at the release

The list in HandwiredOS's Monitor window is a virtualized list in a native scroller. The program keeps no scroll position: the host reads the scroller's `scrollTop` at the top of each frame, as ui.md's "State The Browser Keeps" section says to read such state, and the program computes which row each DOM slot shows. The program asks the host to scroll only after a key that moves the selection, or when the user picks another of the list's three locations in Monitor's sidebar, e.g. Operations. A row is selected at a release over the list instead of at the press, and the list takes its six keys only while Monitor is the focused window. The entry above this one covers the other case, a list whose program computes the scroll position.

```js
// familiar: select at the press
row.addEventListener('pointerdown', () => { selectedRow = row.index })
// the choice: the browser scrolls, every frame reads where, and a release selects
const scrollTop = scroller.scrollTop // read at the top of the frame, e.g. 1000 px
const firstRow = Math.floor(scrollTop / rowHeight) // row 41, with rows of 24 px
if (released && pressStartedOnList && contains(listRect, releasePoint)) selectedRow = rowUnder(releasePoint, scrollTop)
if (key === 'ArrowDown' && focusedWindow === monitor) selectedRow++ // then the program asks for a scroll that shows the row
```

**What the user sees differently.** The browser moves the rows while the list scrolls, also between the page's frames. A press on a row selects nothing, and a release selects the row under it when the press started on the list too. So the press that starts a touch scroll, which the browser ends with a pointercancel, selects nothing, and a release while the list still moves selects the row under the scroll position that the frame read. After ArrowUp, ArrowDown, PageUp, PageDown, Home or End, the list scrolls just far enough to show the whole selected row, and the frame of the key already draws the rows at that position. While another window is focused, the six keys do nothing to the list.

**Circuit version.** `scrollTop` is an input cell that the host writes before every evaluation, floored onto a 1/4 px grid and clamped into the cell's range. `buildValueList` in [value-list.ts](../src/handwiredos/value-list.ts) finds the first row in view with a floor division, draws row r in DOM slot r % 64, and outputs each slot's row, top, presence bit and selected bit. The program holds no row, so its size doesn't depend on the row count, up to the 100,000 rows that the scroll cell's range covers. A press on the list sets a state bit, and a release over the list while the bit is set is a click, like a release on Photos' content. `scrollTarget` and `scrollRequest` are outputs. A request comes from an event, e.g. a key that moves the selection out of view, while the DOM code only reads the outputs of the frame's last evaluation, which applies no event. So the host takes the request from the evaluation that applied the key, writes the requested position into the `scrollTop` cell for the frame's later evaluations, and scrolls the scroller there after its DOM writes.

**Cost.** A fixed number of operations at any row count, most of them the four outputs of each of the 64 DOM slots, and one evaluation in every frame where the scroll position changed.

**Why choose it.** The browser keeps the scrolling, e.g. its scrollbar and its wheel and touch handling, and the program gets one more input. Rows are positioned in the scroller's content coordinates, and the DOM slots that the view leaves over draw the rows above and below the view, half on each side, e.g. 22 above and 23 below a view of 19 rows in the middle of the list, so a frame that arrives late still finds rows on screen. A release, unlike a press, is never the start of a scroll.

**Don't use it when.** Stored state must not depend on the frame rate while the user scrolls: a scroll position has no timestamp, so the row under a release depends on the position that the frame read. The rows above the view can change height: keep the row at the top of the view in place, as in the entry above this one.

**Contract, long form, tests.** execution-model.md's [Grids](execution-model.md#grids) and [Rounding points](execution-model.md#rounding-points), which the floor division's round chain relies on; chenguini's ui.md, "State The Browser Keeps", and Scrolling.md, "Scroll Value & Quirks"; tested by [value-list.test.ts](../tests/handwiredos/value-list.test.ts), which compares every output with the same list in plain JavaScript on 60,000 random frames and at every quarter pixel around row tops of a 100,000 row list, and by window-manager.test.ts's session, which stays bit-identical across frame rates because it runs without a scroller.
