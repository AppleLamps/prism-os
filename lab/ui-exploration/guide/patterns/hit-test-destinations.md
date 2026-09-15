Size: behavior choice. Short entry: [behavior-choices.md, "Hit-test destinations instead of drawn positions"](../../../../behavior-choices.md#hit-test-destinations-instead-of-drawn-positions).

# Hit-test destinations instead of drawn positions

Test a press against each element's destination, the position its spring is heading to, instead of where the element is drawn, so the hit test reads only stored state, and no spring has to run before it.

```txt
80 ms after a press dismissed toast 0, a second press lands 4 px below the top:

         destinations              drawn at 1,083 ms
  0 px   +----- toast 1 -----+                                <- press at 4 px
         |                   |
 27 px   |                   |     +----- toast 1 -----+
 40 px   +-------------------+     |                   |
 48 px   +----- toast 2 -----+     |                   |
 67 px                             +-------------------+

drawn positions:  stored springs -> step to the press -> drawn tops -> sign cascades -> first hit -> dismissed
destinations:     stored present bits -> destination tops -> integer bits -> dismissed
```

## What the user sees differently

In [toast-stack.ts](../examples/patterns/fewer-dependencies/toast-stack.ts), a press on a toast dismisses it and the toasts below slide up into its place. Three presses 80 ms apart, 4 px below the top of the stack, dismiss three toasts when the hit test uses destinations, like closing tabs in Safari by clicking the same spot. When the hit test uses drawn positions, the three presses dismiss one toast: the second and third presses land above toast 1, which is still sliding up, e.g. drawn at 26.65 px in the frame after the second press.

Testing destinations also has a downside on a single deliberate press: 80 ms after the first dismissal, a press at 60 px dismisses toast 2, whose destination is under the pointer, although toast 1 is the toast drawn there.

## The loop it replaces

vibescript's ui.md stores the press in `st.events`, and `render` handles it together with the other inputs:

```ts
// Handle inputs
if (st.events.press != null) {
  const {x, y} = st.events.press
  const pressedIndex = st.toasts.findIndex(toast => toast.present
    && left <= x && x < left + width
    && toast.top.dest <= y && y < toast.top.dest + height) // toast.top.pos tests where the toast is drawn
  if (pressedIndex >= 0) st.toasts[pressedIndex].present = false
}
```

## The circuit

A toast's destination top is 48 px times the number of present toasts above it, computed from stored state, so no spring has to run before the test. The host writes pointer coordinates on a 1/64 px grid, which the builder declares with `circuit.assumeGrid`, and a sum of present bits times 48 lies on a grid too, which the builder infers. So `emitCompare` builds integer bits, 2 operations in 2 layers each, and the springs of `emitAnimatedObject` read the new destinations afterwards (toast-stack.ts, trimmed):

```ts
// JS: destinationTop = pitch * (number of present toasts above this one)
const destinationsBefore = toasts.map((_, index) =>
  circuit.affine(toasts.slice(0, index).map(toast => [toast.present, pitch])))
// JS: toast.present && insideColumn && top <= pointerY && pointerY < top + height
const hits = toasts.map((toast, index) => emitAll(circuit, [
  toast.present,
  insideColumn,
  emitCompare(circuit, toastCell.pressY, '>=', destinationsBefore[index]),
  emitCompare(circuit, toastCell.pressY, '<', circuit.affine([[destinationsBefore[index], 1]], height)),
]))
// Present toasts' destinations don't overlap, so at most one hit bit is 1.
const pressed = hits.map(hit => emitMultiply(circuit, hit, toastCell.pressActive))
```

The drawn-position form in the same file first steps each toast's springs to the press's timestamp with `emitApplySpringMatrix`, adds the destination the steps pull toward, and compares the sum. Spring arithmetic doesn't keep values on a grid, so `emitCompare` builds sign cascades, and drawn toasts can overlap while they move, so `emitFirstActive` picks the first hit with a tournament.

## Cost

Testing n elements whose destinations don't overlap is O(n) operations at constant depth, with no tournament. The destination tops here are wide sums of present bits, O(n²) stored weights. Testing drawn positions adds the spring steps, a sign cascade per comparison, whose depth grows with the logarithm of the declared range over the smallest difference to detect, and a tournament of O(log n) layers. Pinned by [hit-test-destinations.test.ts](../examples/patterns/fewer-dependencies/hit-test-destinations.test.ts):

| Press tests | Up to the pressed bits | Whole app, with 4 toasts' springs |
| --- | --- | --- |
| destinations | 35 operations, 5 layers | 171 operations, 17 layers |
| drawn positions | 205 operations, 34 layers | 313 operations, 45 layers |

The drawn-position form spends 140 operations on sign cascades for its 8 comparisons of the pointer with toast edges, where the destination form spends 16 operations on integer bits for the same 8 comparisons.

## When it's exact

- Both operands of every comparison have finite declared ranges and lie on declared or inferred grids, within 2^24 grid steps of each other, e.g. pointers quantized to 1/64 px within ±16,384, and destinations built from whole pixels and bits. `emitCompare` then builds integer bits, which gave the right bit under every executor mode the [comparisons](../sections/comparisons.md) section tested.
- At most one hit bit is 1 when the destinations of present elements don't overlap, as a layout without overlaps guarantees. Otherwise pick one hit with `emitFirstActive`.
- The test compares both forms with the findIndex loops over 3,000 random tables each, and 2,304 tables each with pointers on every edge and one grid step or one FP32 step next to it, in both evaluators, with 0 mismatches.

## When not to use it

- For drag targets. ui.md keeps the drawn position there, so a draggable card can be grabbed where the card is drawn.
- When a press should act on what's drawn under the pointer, e.g. a single press on an element that's still moving far. chenglou.github.io's index.ts tests grid clicks against the rectangles it presented, in `hitTestPresented2DMode` ("Click the rectangles that were actually presented").

## Where it's used

- vibescript's `~/github/vibescript/docs/ui.md`, section "Hit Testing", recommends testing `dest` instead of `pos`, which prevents mis-clicks on moving elements and lets rapid repeated clicks work. chenglou.github.io's index.ts tests hover against layout targets in `hitTest2DTargets`, and in its one-photo mode lets clicks land during transitions in `hitTest1DMode`.
- [indirect-os-2](../../indirect-os-2/README.md) hit-tests clicks on Photos at the window's destination size. window-manager.ts tests them at the animated size, so which photo a click lands on depends on spring timing: with spring-bank's springs, a click during a Photos window animation landed on a different photo in 2 of 8 random 400-frame traces. indirect-os-2 also flows the Notes paragraph around the other windows' destinations: 19,854 operations and 343 layers, against 19,861 and 368 around their drawn geometry, and within 2.4e-4 px between 60 and 120 fps, against 25.4 px.
- [Long dependency chains](../sections/chains.md#way-5-change-what-the-app-computes), way 5, and [decision 6](../review-and-decisions.md#6-should-depth-be-optimized-now) in the guide's decision record.
- [Commit state at events](commit-at-events.md) runs the same toast stack at several frame rates.
- Example and test: [toast-stack.ts](../examples/patterns/fewer-dependencies/toast-stack.ts) and [hit-test-destinations.test.ts](../examples/patterns/fewer-dependencies/hit-test-destinations.test.ts).
