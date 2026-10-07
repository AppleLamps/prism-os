Size: behavior choice. Short entry: [behavior-choices.md, "Apply events at their timestamps, and write state back only at events and settle checks"](../../../../docs/behavior-choices.md#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks).

# Commit state at events

Write state back only at each event's timestamp and at settle checks, and draw every frame from a copy of the table, so what's stored depends on the events and not on which frames ran.

```txt
one column per 8 ms from 1,000 ms; the clock starts at the first press

events        E                        E                commit: step to the event, apply it, write back
settle checks         C       C       C       C         commit: every 64 ms after the clock starts
60 fps        | | | | | | | | | | | | | | | | | | | |   evaluate a copy, draw, throw its next state away
10 fps        |           |            |           |    evaluate a copy, draw, throw its next state away
```

## What the user sees differently

Nothing, at a steady frame rate. In the example, drawn tops stay within 1e-4 px of float64 springs with either policy, and toasts settle at the same simulated times. What changes is what's stored. With commits at events, every stored table and every drawn top at a shared timestamp is identical in every bit at 10, 30, 60 and 120 fps and through 500 ms stalls, so replaying recorded events at another frame rate, e.g. in a screenshot test, reproduces the screen bit for bit. When every frame writes back, 192 of the 383 tables that 60 fps frames store differ in bits from the tables 120 fps stores at the same timestamps.

The cost the user can see: a value the program reads from stored state is as old as the last commit, up to about 64 ms while something moves, see [read last frame's value](read-last-frame.md).

## The loop it replaces

ui.md's render loop steps springs to the frame's timestamp and commits in every frame, so which frames ran becomes part of `st`:

```ts
function render(now) {
  // Handle inputs, then the animation tick
  let newAnimatedUntilTime = st.animatedUntilTime ?? now
  const steps = Math.min(300, Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep))
  for (let step = 0; step < steps; step++) stepSprings(st.toasts)
  // Commit state
  st.animatedUntilTime = stillAnimating ? newAnimatedUntilTime + steps * msPerAnimationStep : null
}
```

Committing at events applies each event at its own timestamp, and draws from a copy that's never assigned back:

```ts
window.addEventListener('pointerdown', event => {
  committed = applyPress(stepTo(committed, event.timeStamp), event)
  scheduleRender()
})
function render(now) {
  draw(stepTo(structuredClone(committed), now))
}
```

## The circuit

The program doesn't change. host-timing.ts's `advanceFrame` plans a frame's evaluations: one per distinct event timestamp, which steps springs to that timestamp and then applies the events, one per settle check, and one at the frame's timestamp. With `writeBack` set to `'events and settle checks'`, the frame's evaluation runs on a copy (toast-stack.ts, trimmed):

```ts
clock = advanceFrame(clock, frameTime, arrivedEvents, evaluation => {
  // A frame that doesn't write back evaluates a copy of the table.
  const table = evaluation.writesBack ? state : scratch
  if (!evaluation.writesBack) scratch.set(state)
  table.set(powers[evaluation.steps], toastCell.matrixStart)
  table[toastCell.settleCheck] = evaluation.settleCheck ? 1 : 0
  table[toastCell.snap] = evaluation.snap ? 1 : 0
  // ... each event's latch and coordinates
  const outputs = evaluate(table)
  if (evaluation.writesBack) state.set(outputs.subarray(0, toastCell.size))
  return anyToastStillMoving(outputs)
}, 'events and settle checks')
```

Two options of `emitAnimatedObject` keep commits independent of frames: an object not exactly at rest settles only while the `settleCheck` cell holds 1, i.e. at fixed simulated times, and its steps pull toward `destinationDuringSteps`, the destination before this evaluation's events.

## Cost

The same program, at the same size and depth. The evaluations are the same as when every evaluation writes back, one per distinct event timestamp, one per 64 ms of simulated time while something moves, and one per frame, and each frame first copies the table, O(source cells). Pinned by [commit-at-events.test.ts](../examples/patterns/fewer-dependencies/commit-at-events.test.ts): over 6.4 s of random presses at 60 fps, 383 frames, 16 event evaluations and 51 settle checks with either policy, and each frame copies 22 cells.

## When it's exact

- Every input that changes state reaches `advanceFrame` as a timestamped event, e.g. a viewport resize too, since a frame's copy stores nothing.
- The program reads time only through the spring matrix and the settle check and snap bits, e.g. not through a frame duration cell, and the host quantizes timestamps to 1/64 ms.
- No snap runs. A frame's steps count from the last commit, so a frame gap from just above 1,140 ms can snap every object onto its destination at one frame rate and not at another ([host-timing.ts](../../../../src/runtime/host-timing.ts)).
- Events arrive in timestamp order. An event with a timestamp before the last commit applies at that commit's time.

## When not to use it

- When a stage reads the previous evaluation's value on purpose, since the previous evaluation becomes the last commit. The drawer in [read last frame's value](read-last-frame.md) lays out for a width up to 174 px behind at 60 fps with commits at events, against 60 px when every evaluation writes back, and event-time's Photos reading the last commit was 507 px off during a maximize.
- When bit-identical stored state doesn't matter, e.g. nothing replays sessions. Writing back every evaluation stayed within 1e-4 px of float64 in the example, with the same evaluations and one table copy less per frame.

## Where it's used

- `advanceFrame` in [host-timing.ts](../../../../src/runtime/host-timing.ts), whose `'events and settle checks'` policy [spring-matrix.test.ts](../../../../tests/runtime/spring-matrix.test.ts) checks: every stored table identical in every bit at 10, 30, 60 and 120 fps and through 500 ms stalls.
- [event-time](../../event-time/README.md) committed HandwiredOS at events: committed tables identical in every bit at 10 to 240 fps and through 500 ms and 2 s stalls over 6 traces, where frames that wrote back held different bits in 15% to 18% of shared frames.
- [Springs](../sections/springs.md#5-commit-state-only-at-event-timestamps), form 5, and [decision 3](../review-and-decisions.md#3-how-should-time-enter-the-program-and-which-spring-should-be-the-default) in the guide's decision record. The springs section's [selection highlight](../examples/springs/shared-runtime-springs.ts) runs the same host loop.
- [Hit-test destinations instead of drawn positions](hit-test-destinations.md) builds the toast stack this example runs.
- Example and test: [toast-stack.ts](../examples/patterns/fewer-dependencies/toast-stack.ts) (`runToastStack`) and [commit-at-events.test.ts](../examples/patterns/fewer-dependencies/commit-at-events.test.ts).
