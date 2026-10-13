# Behavior choices

These choices change what the user sees, to shorten dependency chains, to make stored state independent of the frame rate, or to keep each frame's work under a fixed maximum. Constructions that replace one familiar expression are in [expressions.md](expressions.md), and loops rewritten without changing what the user sees are in [patterns.md](patterns.md). Contracts stay in [execution-model.md](execution-model.md), and each entry links the sections it depends on.

HandwiredOS's render loop follows chenguini's `ui.md` ([doctrine notes](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/notes/doctrine.md)), except that since September 15, 2026, HandwiredOS uses the second choice below, and snaps where ui.md carries leftover steps into later frames. ui.md already documents the first choice in its "Hit Testing" section, one case of the fifth, a cap of 300 spring steps per frame, in its "Render Loop" section, and the first half of the last, reading the scroll position as an input, in its "State The Browser Keeps" section. The other choices come from this repo's measurements. ui.md's "Render Loop" handles a frame's inputs before its animation tick and commits state on every render, and in a float64 copy of that order, stored state depends on the frame rate when an event changes a destination between frames. ui.md mentions last frame's value only as "needing to see prev layout", in a TODO under "State Management".

## Hit-test destinations instead of drawn positions

When an element animates, test a press against its destination, the position its spring is heading to, instead of where the element is drawn. ui.md's "Hit Testing" section recommends this, as testing `dest` instead of `pos`.

```js
// familiar: test where each item is drawn
let pressedIndex = items.findIndex(item => contains(item.drawnRect, pointer))
// the choice: test where each item's spring is heading, e.g. toasts that slide up after one is dismissed
pressedIndex = items.findIndex(item => contains(item.destinationRect, pointer))
```

**What the user sees differently.** In the guide's toast stack, three presses 80 ms apart, 4 px below the top, dismiss three toasts, like closing tabs in Safari by clicking the same spot. Testing drawn positions dismisses one toast, since the second and third presses land above a toast that's still sliding up. A single press on a moving element can act on another element: 80 ms after a dismissal, a press at 60 px dismisses the toast whose destination is under the pointer, not the toast drawn there.

**Circuit version.** Destinations come from stored state, e.g. a toast's destination top is 48 px times the number of present toasts above it. Destinations built from whole pixels and bits lie on a grid, like pointer coordinates quantized to 1/64 px, so `emitCompare` builds integer bits, and destinations that don't overlap give at most one hit, so no `emitFirstActive` tree is needed. Drawn positions come out of spring arithmetic and lie on no grid, so each of their comparisons is a sign cascade.

**Cost.** In the toast stack, up to the pressed bits, 35 operations in 5 layers against destinations, against 205 in 34 against drawn positions.

**Why choose it.** For the user, ui.md's reasons: moving elements don't cause mis-clicks, and rapid repeated presses work. In the circuit, the hit test reads only stored state, so no spring has to run before it.

**Don't use it when.** The element is dragged: ui.md keeps the drawn position for drag targets, so a card can be grabbed where it's drawn. A press should act on what's drawn under the pointer, e.g. chenglou.github.io's index.ts tests grid clicks against the rectangles it presented. Destinations of present elements can overlap: pick one hit with `emitFirstActive`.

**Contract, long form, tests.** execution-model.md's [Comparisons](execution-model.md#comparisons) and [Grids](execution-model.md#grids); [hit-test-destinations.md](../lab/ui-exploration/guide/patterns/hit-test-destinations.md), tested by [hit-test-destinations.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/hit-test-destinations.test.ts). window-manager.ts lays out Photos at the window's destination size, and reads a Photos click relative to the content box at the window's destination, as [indirect-os-2](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2) did.

## Apply events at their timestamps, and write state back only at events and settle checks

ui.md's "Render Loop" handles a frame's inputs, then steps springs up to the frame's timestamp toward the new destinations, then commits state, on every render. So springs pull toward a new destination from before the event, and which frames ran becomes part of stored state. This choice keeps the program as it is, and changes when the host runs the program and when the host writes next state back. ui.md doesn't document this choice.

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

**Don't use it when.** A stage reads last frame's value on purpose, since that value then comes from the last evaluation that wrote state back, e.g. the drawer grid in the next entry lags by up to 174 px at 60 fps, against 60 px when every evaluation writes back. An input that changes destinations can't reach `advanceFrame` as a timestamped event, e.g. a viewport width written every frame without a resize event: springs then pull toward it from frame times again. Nothing replays sessions, so bit-identical stored state doesn't matter.

**Contract, long form, tests.** execution-model.md's [The ordering rule](execution-model.md#the-ordering-rule), [Settling at fixed simulated times](execution-model.md#settling-at-fixed-simulated-times), [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back) and [Static bounds](execution-model.md#static-bounds); [commit-at-events.md](../lab/ui-exploration/guide/patterns/commit-at-events.md), and springs.md's [ui.md's render order is frame-rate dependent](../lab/ui-exploration/guide/sections/springs.md#uimds-render-order-is-frame-rate-dependent-when-a-destination-changes-between-frames); tested by [commit-at-events.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/commit-at-events.test.ts) and [spring-matrix.test.ts](../tests/runtime/spring-matrix.test.ts). window-manager.ts runs this way, and window-manager.test.ts replays a timestamped session at 10, 30, 60 and 120 fps and through 500 ms stalls, with identical committed tables and drawn outputs at shared times.

## Read last frame's value

A stage reads a stored copy of a value from the previous frame instead of this frame's value, so the stage's layers no longer come after the chain that computes the value. ui.md doesn't document this choice. The guide's [decision 6](../lab/ui-exploration/guide/review-and-decisions.md#6-should-depth-be-optimized-now) recommends no automatic one-frame delays: a delay goes only on outputs that a written list marks as tolerant of one frame of lag.

```js
stepSprings(now) // e.g. a drawer springs open while its thumbnail grid reflows
layout = computeLayout(containerWidth.pos) // familiar: this frame's width
layout = computeLayout(previousContainerWidth) // the choice: last frame's width
previousContainerWidth = containerWidth.pos // stored with the rest of the state
```

**What the user sees differently.** The stage's output is a frame behind while the value moves. In the guide's drawer, 12 thumbnails reflow from 2 to 5 columns while the drawer springs from 320 to 760 px wide. Laid out for last frame's width, the grid trails the drawer's edge by up to 60 px at 60 fps and 159 px at 10 fps, and 158 of 3,007 frames at 60 fps drew a different column count, which moved a thumbnail by up to 533 px. At rest both layouts are the same.

**Circuit version.** The copy is one more source cell with a declared range, whose next value is this evaluation's value, e.g. `nextSource[previousWidth] = drawnWidth`, written back with the other next-state values. The longest chain through the value becomes the longer of the part that computes the value and the part that reads it, instead of the two added together.

**Cost.** No more operations, one more source cell, and one more copy per evaluation that writes back. The drawer is 144 operations in 17 layers instead of 30.

**Why choose it.** Fewer layers with no more operations. Fewer layers only save time on an executor that runs a layer's operations at the same time, while today's CPU executor pays per operation.

**Don't use it when.** The stage computes a decision: a column count a frame late moved thumbnails by up to 533 px. An earlier value from the same evaluation exists: a spring's position right after this evaluation's steps is 4 layers deep, and the drawer reading that position takes 21 layers and draws the same layout as this frame's width in every frame. State is written back only at events and settle checks: the copy is then as old as the last of those evaluations, and the drawer's lag grows from 60 px to 174 px at 60 fps.

**Contract, long form, tests.** execution-model.md's [In the program](execution-model.md#in-the-program), for the position right after the steps, and [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back); [read-last-frame.md](../lab/ui-exploration/guide/patterns/read-last-frame.md), and chains.md's [way 4](../lab/ui-exploration/guide/sections/chains.md#way-4-read-last-frames-value), which covers [retiming](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/retiming)'s measurements in HandwiredOS; tested by [read-last-frame.test.ts](../lab/ui-exploration/guide/examples/patterns/fewer-dependencies/read-last-frame.test.ts).

## Flow text around destinations, in a fixed number of lines

In HandwiredOS, the Notes text flows around the windows stacked above it, and the visitor can type into it. The text is laid out around each window's destination rectangle, where its springs are heading, and around the windows that are visible after this evaluation's events, so the text reflows once per event instead of once per animated frame, e.g. once at the release of a maximize button, and once at each typed character. The flow's capacities are fixed: 16 line slots, 256 segment cells, where a segment is a word or the space after it, and 64 segments on one line. ui.md doesn't document text flowing around moving elements; the lab's [indirect-os-2](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2) compared this choice with obstacles read from the drawn frames and from the stepped springs.

```js
// familiar: reflow every frame around the windows as they're drawn
obstacles = windows.filter(window => window.drawnOpacity > 0 && window.stack > notes.stack).map(window => window.drawnRect)
// the choice: reflow at events, around where each window is going, e.g. the maximized rectangle as soon as the maximize button is released
obstacles = windows.filter(window => window.visibleAfterEvents && window.stack > notes.stack).map(window => window.destinationRect)
```

**What the user sees differently.** The words jump to their final places in the frame of the event, while the windows still animate: at the release of a maximize button the text clears the window's final rectangle before the frame covers it, and at the release of a minimize or close button the text fills the area of a window that is still flying to the dock. Dragging a window over the text reflows it at every move, since each move changes the destination, and a typed character reflows it in the frame of the key. A press on the note puts the caret at the character that ends up under the pointer, e.g. a press on a covered Notes raises the window, reflows the text, and places the caret in the new layout. Past a capacity the text isn't laid out as written, and the note says so above its first line, e.g. "This text has 801 words and spaces, and the note lays out the first 256." for a text of more than 256 segments, or "The last 5 words don't fit in the lines that are free." when overlapping windows leave slots too narrow. A line of more than 64 segments wraps early, e.g. a line of one-letter words, and a slot that ends below the content box is skipped instead of clipped. A word wider than its slot is laid out whole and reaches past the slot, under the window beside it, where pretext would break the word between two letters.

**Circuit version.** notes.ts reads each window's next destination rectangle, next visibility and next stacking, the same wires that Photos lays out against. Each band's blocking bits form a one-hot over the 8 subsets of the 3 obstacles, whose slot is carved once per subset, and a band is also unusable when its bottom lies below the destination content height. notes-walker.ts then walks the text band by band over the widths and break-after bits in the segment cells, with index reads of the prefix tables at each band's line start, and gives every segment cell an x, a y and a visible bit. The cells after the text hold width 0, and one more input cell counts the cells that hold text, the construction of [streaming-words](../lab/ui-exploration/streaming-words/README.md). The characters stay in the browser, as ui.md's "State The Browser Keeps" has it: a textarea that is never shown holds them with the caret, the selection and the undo history. Each frame reads the textarea with the other DOM reads, measures a changed value into segments with pretext, and queues one event that rewrites the cells, so stored state still depends only on timestamped events. The program decides whether a press is on the note, against the window's destination rectangle and the stacking order, and stores a count of such presses and the last one's point in three state cells, the flow's only state. The page then finds the character at that point from the segments' positions, in the layout after the press.

**Cost.** In HandwiredOS, 16,440 live operations, 107 more layers and 36,903 stored weights on top of the windows, Photos and Files, counted on October 13, 2026, plus 517 source cells: two per segment cell, and 5 for the count of cells in use, the first segment and the press. That is about 780 operations per band, about 28 per segment cell, and about 7 per band for each of the 64 segments that a line can hold, paid on every evaluation whether or not the text uses them.

**Why choose it.** Word positions are a pure function of stored destinations and the segment cells, so they change only in evaluations that apply events, and the session test finds them bit-identical at 10, 30, 60 and 120 fps, with two text changes and a press on the note in the session. Read from the drawn frames instead, the text reflows in frames with no event: on September 15, 2026, indirect-os-2 measured 8 such frames while Photos maximized and restored ([Words without springs](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/indirect-os-2/README.md#words-without-springs-2026-09-15)). When each word also had its own spring, the words retargeted at every frame of an animation, and word positions differed by up to 25.4 px between 60 and 120 fps ([Frame-rate independence](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/indirect-os-2/README.md#frame-rate-independence)). The browser keeps what it is good at, i.e. input methods, paste, undo and the selection, and the program keeps the layout.

**Don't use it when.** The text should visibly flow with a moving frame, e.g. a caption inside a dragged card. The text must always be complete: raise the band count, at about 780 operations per band, or lay it out in JavaScript. The program itself should hold the characters, the caret and the selection, e.g. so that an edit can be replayed from the table alone: [code-points](../lab/ui-exploration/code-points/README.md) does that for 256 code points in 42,000 to 54,000 operations, without flow around obstacles.

**Contract, long form, tests.** execution-model.md's [Static bounds](execution-model.md#static-bounds) and [Index reads](execution-model.md#index-reads); indirect-os-2's README at the exploration-2026-09 tag, [section 4](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/indirect-os-2/README.md#4-the-notes-flow) and [Words without springs](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/indirect-os-2/README.md#words-without-springs-2026-09-15); tested by [notes.test.ts](../tests/handwiredos/notes.test.ts), which checks flows against pretext's `layoutNextLineRange` line for line and segment for segment, e.g. for every prefix of a sentence typed one character at a time and for random texts around random windows, and checks the texts past each capacity against the walker's rule in plain JavaScript; by [notes-text.test.ts](../tests/handwiredos/notes-text.test.ts) and [notes-host.test.ts](../tests/handwiredos/notes-host.test.ts) for the page's side; and by window-manager.test.ts's session, where the words change only at events.

## A fixed maximum with a named fallback

A program's size is fixed while building, so every count that JavaScript keeps in a growing array or a loop variable becomes a maximum, and what the program does past the maximum is part of the behavior. ui.md caps a frame's spring steps at 300 in "Render Loop", following Animation.md's "Spiral of Death Prevention", and carries the rest of the backlog into later frames, while host-timing.ts snaps instead. When every occurrence counts, ui.md's "Event Handling" pushes events onto an array with no maximum.

```js
const steps = Math.floor((now - animatedUntilTime) / msPerStep) // e.g. every catch-up step after a stalled tab
st.events.keydowns.push(event) // every key event before the next render
const visibleRows = rows.filter(isVisible) // one DOM node per visible row
```

**What the user sees differently.** Only at the maximum, where the named fallback runs. E.g. past 300 steps, every animated object snaps onto its destination, which shows after a stall of about 1.2 s while something still moves. A text field's lines past 12 aren't laid out, and the demo in [code-points](../lab/ui-exploration/code-points/README.md) says why. HandwiredOS's note lays out the first 256 words and spaces of a longer text and says how many the text has, and its Files list says "Only 64 rows are drawn at a time." when the window shows more rows than the list has DOM slots. Extra events in a frame go to another evaluation, which the user never sees.

**Circuit version.** Give each quantity a maximum and one of these fallbacks: snap, e.g. `advanceFrame` runs a snap evaluation when a frame would need more than `maxStepsPerFrame` steps; carry, e.g. ui.md's backlog of steps; split, e.g. input's JavaScript splits a frame's events into several evaluations; report, e.g. the `slotOverflow` output of hn-thread and of HandwiredOS's Files list; drop, e.g. rows past the last of Files' 64 DOM slots get no node; clamp, e.g. lists' release velocity at ±2^16 px/s; or throw, e.g. the range check on every source cell.

**Cost.** Every capacity is paid on every evaluation, whether or not it's used, e.g. about 210 operations per text cell in text-editing's text field ([code-points](../lab/ui-exploration/code-points/README.md#merged-from-text-editing-september-16-2026)), and about 2,200 operations and 40 layers per press session per evaluation in indirect-os-2's event queue over the whole HandwiredOS ([input](../lab/ui-exploration/input/README.md#merged-from-indirect-os-2-september-16-2026)).

**Why choose it.** The program keeps a fixed size, and so does its backward pass, e.g. 562 operations per frame for differentiability.md's spring built on a matrix power, whether the frame runs 2 steps or 300. A fallback turns a limit into defined behavior that a JavaScript reference can reproduce, e.g. lists' JavaScript reference clamps the release velocity the way the circuit does.

**Choosing the maximum.** Pick it from the quantity's measured distribution, so normal use doesn't reach it, e.g. 300 steps against about 4 per frame at 60 fps, or hn-thread's 48 DOM slots against at most 32 needed in its measured states. Give every maximum an output or a check: before `runOverflow` existed, a paragraph with longer runs of break opportunities than text-walker was built for started lines at the wrong segment, and no output showed the problem.

**Contract, long form, tests.** execution-model.md's [Static bounds](execution-model.md#static-bounds); differentiability.md's [Static bounds with named fallbacks](../lab/ui-exploration/guide/sections/differentiability.md#static-bounds-with-named-fallbacks), and executor.md's [Fixed capacities](../lab/ui-exploration/guide/sections/executor.md#fixed-capacities) and [How a frame's events are handled](../lab/ui-exploration/guide/sections/executor.md#how-a-frames-events-are-handled); tested by [spring-matrix.test.ts](../tests/runtime/spring-matrix.test.ts), e.g. "a 3 s stall snaps every object onto its destination once, no frame runs more than 300 steps, and the committed tables stay bit-identical across frame rates".

## Anchor the scroll position to the row at the top of the view

When the program computes the scroll position, e.g. of a virtualized list whose row heights change with the container width, the program moves the view by as much as the row at the top of the view moved, instead of keeping the scroll position in pixels, and the host turns off the browser's own scroll anchoring. chenguini's Scrolling.md documents scroll anchoring in plain JavaScript in its "Scroll Anchoring" section, and lists CSS `overflow-anchor` among the less preferred alternatives, since Safari lacks it.

```js
// familiar: keep scrollTop in pixels, so rows above the view that change height move the rows in view
spacer.style.height = `${totalHeight}px`
// the choice: move the view by as much as the row at its top moved, e.g. after a resize from 1200 to 400 px
const atBottom = scrollTop + viewportHeight >= previousTotalHeight // the view showed the end of the rows, like a chat log
const anchorRow = previousBottoms.findIndex(bottom => bottom > scrollTop)
scrollTop = atBottom ? maximumScroll : Math.min(scrollTop + tops[anchorRow] - previousTops[anchorRow], maximumScroll)
```

**What the user sees differently.** Rows above the view that get taller or shorter don't move the rows in view: after a resize, an edit above the view, or a scroll in the same frame as either, the row at the top of the view keeps its position on screen, and a view that showed the end of the rows keeps showing the end after an append. When the row at the top gets shorter than its part above the view, that row goes out of view and the next row comes first, e.g. after 6 of 120 random resizes at 1,000 rows in lists' browser check.

**Circuit version.** The program keeps every row's bottom from the last evaluation in state cells, and finds the anchor row with a binary search over those bottoms at the scrollTop the DOM reports now, which includes any scroll since the last evaluation. Storing only the first row and its top after each evaluation misses that scroll: in lists' first version, a scroll and a resize in one evaluation moved the view by the rows scrolled past times their change in height, 35,000 px in the review's example. The host writes the spacer's height before the scroll position, so the browser doesn't clamp the new scroll position to the old height, writes `scrollTop` only when it differs from the scroller's, and sets `overflow-anchor: none` on the scroller, so Chrome's own scroll anchoring doesn't also move the view.

**Cost.** In lists' text rows at 10,000 rows: 10,000 state cells for the bottoms, which the host copies back with one `Float32Array.set` in about 0.4 µs, 13 index reads and 14 comparisons for the anchor row, and 1,290 of the program's 111,271 live operations for the scroll position, the anchor row, the first row and the 64 DOM slots together.

**Why choose it.** One rule covers resizes, edits above the view, viewport height changes and a scroll in the same frame as any of them, and it's exact, since row tops are whole pixels.

**Don't use it when.** Row tops aren't whole pixels: each frame starts from the scrollTop that the browser rounded, so the rounding adds up. E.g. chenguini's Scrolling.md measured an anchor drifting 3 to 4 px over a 15-step continuous resize with this formula, and keeps the anchor's position on screen from when the anchor was picked instead.

**Contract, long form, tests.** execution-model.md's [Index reads](execution-model.md#index-reads) and [Grids](execution-model.md#grids); lists' README, [Anchoring](../lab/ui-exploration/lists/README.md#anchoring), with the program in [text-rows.ts](../lab/ui-exploration/lists/text-rows.ts) and the DOM writes in [text-rows-demo.ts](../lab/ui-exploration/lists/text-rows-demo.ts); tested by [text-rows.test.ts](../lab/ui-exploration/lists/text-rows.test.ts), whose random sessions check on 588 frames that the last frame's drawn row covering the DOM's scroll position keeps its position on screen, and by text-rows-browser.ts in headless Chrome.

## Scroll a list natively, and select a row at the release

HandwiredOS's Files list is a virtualized list in a native scroller. The program keeps no scroll position: the host reads the scroller's `scrollTop` at the top of each frame, the way ui.md's "State The Browser Keeps" treats state that the browser keeps, and the program computes which row each DOM slot shows. The program asks the host to scroll only after a key that moves the selection, or when the sidebar shows another location. A row is selected at a release over the list instead of at the press, and the list takes its six keys only while Files is the focused window. The entry above this one covers the other case, a list whose program computes the scroll position.

```js
// familiar: select at the press
row.addEventListener('pointerdown', () => { selectedRow = row.index })
// the choice: the browser scrolls, every frame reads where, and a release selects
const scrollTop = scroller.scrollTop // read at the top of the frame, e.g. 1000 px
const firstRow = Math.floor(scrollTop / rowHeight) // row 41, with rows of 24 px
if (released && pressStartedOnList && contains(listRect, releasePoint)) selectedRow = rowUnder(releasePoint, scrollTop)
if (key === 'ArrowDown' && focusedWindow === files) selectedRow++ // then the program asks for a scroll that shows the row
```

**What the user sees differently.** The browser moves the rows while the list scrolls, also between the page's frames. A press on a row selects nothing, and a release selects the row under it when the press started on the list too. So the press that starts a touch scroll, which the browser ends with a pointercancel, selects nothing, and a release while the list still moves selects the row under the scroll position that the frame read. After ArrowUp, ArrowDown, PageUp, PageDown, Home or End, the list scrolls just far enough to show the whole selected row, and the frame of the key already draws the rows at that position. While another window is focused, the six keys do nothing to the list.

**Circuit version.** `scrollTop` is an input cell that the machine writes before every evaluation, floored onto a 1/4 px grid and clamped into the cell's range. `buildFiles` in [files.ts](../src/handwiredos/files.ts) finds the first row in view with a floor division, draws row r in DOM slot r % 64, and outputs each slot's row, top, presence bit and selected bit. The program holds no row, so its size doesn't depend on the row count, up to the 100,000 rows that the scroll cell's range covers. A press on the list sets a state bit, and a release over the list while the bit is set is a click, like a release on Photos' content. `scrollTarget` and `scrollRequest` are outputs: the machine takes a request from the evaluation that applied the key, since the page only sees the frame's evaluation, the step's later evaluations compute the list at the requested position, and the host writes the scroller's position after its DOM writes.

**Cost.** A fixed number of operations at any row count, most of them the four outputs of each of the 64 DOM slots, and one evaluation in every frame where the scroll position changed.

**Why choose it.** The browser keeps the scrolling, e.g. its scrollbar and its wheel and touch handling, and the program gets one more input. Rows are positioned in the scroller's content coordinates, so a frame that arrives late still finds rows on screen, with 2 rows drawn past each edge of the view. A release, unlike a press, is never the start of a scroll.

**Don't use it when.** Stored state must not depend on the frame rate while the user scrolls: a scroll position has no timestamp, so the row under a release depends on the position that the frame read. The rows above the view can change height: keep the row at the top of the view in place, as in the entry above this one.

**Contract, long form, tests.** execution-model.md's [Grids](execution-model.md#grids) and [Rounding points](execution-model.md#rounding-points), which the floor division's round chain relies on; chenguini's ui.md, "State The Browser Keeps", and Scrolling.md, "Scroll Value & Quirks"; tested by [files.test.ts](../tests/handwiredos/files.test.ts), which compares every output with the same list in plain JavaScript on 60,000 random frames and at every quarter pixel around row tops of a 100,000 row list, and by window-manager.test.ts's session, which stays bit-identical across frame rates because it runs without a scroller.
