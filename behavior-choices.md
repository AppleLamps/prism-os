# Behavior choices

These choices change what the user sees, to shorten dependency chains, to make stored state independent of the frame rate, or to keep each frame's work under a fixed maximum. Constructions that replace one familiar expression are in [expressions.md](expressions.md), and loops rewritten without changing what the user sees are in [patterns.md](patterns.md). Contracts stay in [execution-model.md](execution-model.md), and each entry links the sections it depends on.

IndirectOS's render loop follows vibescript's `ui.md` ([doctrine notes](lab/ui-exploration/notes/doctrine.md)), except that since September 15, 2026, IndirectOS uses the second choice below, and snaps where ui.md carries leftover steps into later frames. ui.md already documents the first choice in its "Hit Testing" section, and one case of the last, a cap of 300 spring steps per frame, in its "Render Loop" section. The other choices come from this repo's measurements. ui.md's "Render Loop" handles a frame's inputs before its animation tick and commits state on every render, and in a float64 copy of that order, stored state depends on the frame rate when an event changes a destination between frames. ui.md mentions last frame's value only as "needing to see prev layout", in a TODO under "State Management".

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

**Contract, long form, tests.** execution-model.md's [Comparisons](execution-model.md#comparisons) and [Grids](execution-model.md#grids); [hit-test-destinations.md](lab/ui-exploration/guide/patterns/hit-test-destinations.md), tested by [hit-test-destinations.test.ts](lab/ui-exploration/guide/examples/patterns/fewer-dependencies/hit-test-destinations.test.ts). window-manager.ts lays out Photos at the window's destination size, and reads a Photos click relative to the content box at the window's destination, as [indirect-os-2](lab/ui-exploration/indirect-os-2/README.md) does.

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

**Contract, long form, tests.** execution-model.md's [The ordering rule](execution-model.md#the-ordering-rule), [Settling at fixed simulated times](execution-model.md#settling-at-fixed-simulated-times), [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back) and [Static bounds](execution-model.md#static-bounds); [commit-at-events.md](lab/ui-exploration/guide/patterns/commit-at-events.md), and springs.md's [ui.md's render order is frame-rate dependent](lab/ui-exploration/guide/sections/springs.md#uimds-render-order-is-frame-rate-dependent-when-a-destination-changes-between-frames); tested by [commit-at-events.test.ts](lab/ui-exploration/guide/examples/patterns/fewer-dependencies/commit-at-events.test.ts) and [spring-matrix.test.ts](spring-matrix.test.ts). window-manager.ts runs this way, and window-manager.test.ts replays a timestamped session at 10, 30, 60 and 120 fps and through 500 ms stalls, with identical committed tables and drawn outputs at shared times.

## Read last frame's value

A stage reads a stored copy of a value from the previous frame instead of this frame's value, so the stage's layers no longer come after the chain that computes the value. ui.md doesn't document this choice. The guide's [decision 6](lab/ui-exploration/guide/review-and-decisions.md#6-should-depth-be-optimized-now) recommends no automatic one-frame delays: a delay goes only on outputs that a written list marks as tolerant of one frame of lag.

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

**Contract, long form, tests.** execution-model.md's [In the program](execution-model.md#in-the-program), for the position right after the steps, and [Which evaluations write state back](execution-model.md#which-evaluations-write-state-back); [read-last-frame.md](lab/ui-exploration/guide/patterns/read-last-frame.md), and chains.md's [way 4](lab/ui-exploration/guide/sections/chains.md#way-4-read-last-frames-value), which covers retiming's measurements in IndirectOS; tested by [read-last-frame.test.ts](lab/ui-exploration/guide/examples/patterns/fewer-dependencies/read-last-frame.test.ts).

## A fixed maximum with a named fallback

A program's size is fixed while building, so every count that JavaScript keeps in a growing array or a loop variable becomes a maximum, and what the program does past the maximum is part of the behavior. ui.md caps a frame's spring steps at 300 in "Render Loop", following Animation.md's "Spiral of Death Prevention", and carries the rest of the backlog into later frames, while host-timing.ts snaps instead. When every occurrence counts, ui.md's "Event Handling" pushes events onto an array with no maximum.

```js
const steps = Math.floor((now - animatedUntilTime) / msPerStep) // e.g. every catch-up step after a stalled tab
st.events.keydowns.push(event) // every key event before the next render
const visibleRows = rows.filter(isVisible) // one DOM node per visible row
```

**What the user sees differently.** Only at the maximum, where the named fallback runs. E.g. past 300 steps, every animated object snaps onto its destination, which shows after a stall of about 1.2 s while something still moves. A text field's lines past 12 aren't laid out, and text-editing's demo hides the caret and says why. Extra events in a frame go to another evaluation, which the user never sees.

**Circuit version.** Give each quantity a maximum and one of these fallbacks: snap, e.g. `advanceFrame` runs a snap evaluation when a frame would need more than `maxStepsPerFrame` steps; carry, e.g. ui.md's backlog of steps; split, e.g. input's JavaScript splits a frame's events into several evaluations; report, e.g. hn-thread's `slotOverflow` output; drop, e.g. rows past the last DOM slot get no node; clamp, e.g. lists' release velocity at ±2^16 px/s; or throw, e.g. the range check on every source cell.

**Cost.** Every capacity is paid on every evaluation, whether or not it's used, e.g. about 210 operations per text cell in text-editing, and about 2,200 operations and 40 layers per press session per evaluation in indirect-os-2.

**Why choose it.** The program keeps a fixed size, and so does its backward pass, e.g. 562 operations per frame for differentiability.md's spring built on a matrix power, whether the frame runs 2 steps or 300. A fallback turns a limit into defined behavior that a JavaScript reference can reproduce, e.g. lists' JavaScript reference clamps the release velocity the way the circuit does.

**Choosing the maximum.** Pick it from the quantity's measured distribution, so normal use doesn't reach it, e.g. 300 steps against about 4 per frame at 60 fps, or hn-thread's 48 DOM slots against at most 32 needed in its measured states. Give every maximum an output or a check: before `runOverflow` existed, a paragraph with longer runs of break opportunities than text-walker was built for started lines at the wrong segment, and no output showed the problem.

**Contract, long form, tests.** execution-model.md's [Static bounds](execution-model.md#static-bounds); differentiability.md's [Static bounds with named fallbacks](lab/ui-exploration/guide/sections/differentiability.md#static-bounds-with-named-fallbacks), and executor.md's [Fixed capacities](lab/ui-exploration/guide/sections/executor.md#fixed-capacities) and [How a frame's events are handled](lab/ui-exploration/guide/sections/executor.md#how-a-frames-events-are-handled); tested by [spring-matrix.test.ts](spring-matrix.test.ts), e.g. "a 3 s stall snaps every object onto its destination once, no frame runs more than 300 steps, and the committed tables stay bit-identical across frame rates".
