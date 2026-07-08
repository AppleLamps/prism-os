// The boundary probe: which behavior genuinely cannot be a function of a
// bounded event window?
//
// The committed rectangle position is the counterexample. It is a sum over
// every drag that ever happened, so no function of the last K raw inputs can
// produce it, for any fixed K. The proof is by construction: two traces that
// end with the same K inputs but whose correct outputs differ. Any map from
// (current input, last K inputs) to outputs would have to give both answers to
// the same argument.
//
// The construction works in two framings: the last K frames (suffix of empty
// frames), and the last K non-empty events (suffix of identical hover moves) —
// so neither "window of frames" nor "window of events" escapes it.
//
// What makes the event-window design work anyway is that its latches hold
// event-triggered AGGREGATES (the committed position, written once per
// release), not raw events. That single write is the irreducible recurrence:
// it runs on events only, never per frame, which is why training needs no
// backpropagation through time. Continuous per-frame integration (springs,
// inertia) is the other genuine recurrence and is excluded from this behavior
// set by design.

import {expect, test} from 'bun:test'
import {createEventWindowMachine} from './circuit.ts'
import {runClosedLoop} from './harness.ts'
import {type BehaviorConfig, type FrameInput, createOracleState, oracleTick} from './oracle.ts'
import {authoredRelations} from './trace.ts'

// Rectangle 0 sits far from the viewport edges so drags in these constructions
// never clamp; the expected positions stay plain sums.
function probeConfig(): BehaviorConfig {
  return {
    viewportWidth: 1280,
    viewportHeight: 800,
    slop: 4,
    titleHeight: 30,
    rectangles: [
      {width: 300, height: 200, initialLeft: 400, initialTop: 300},
      {width: 250, height: 180, initialLeft: 900, initialTop: 100},
      {width: 200, height: 150, initialLeft: 100, initialTop: 550},
      {width: 320, height: 240, initialLeft: 850, initialTop: 480},
    ],
    relations: {...authoredRelations},
  }
}

function finalDisplayedLeft(config: BehaviorConfig, trace: FrameInput[]) {
  const state = createOracleState(config)
  let lastLeft = -1
  for (const input of trace) {
    lastLeft = oracleTick(config, state, input).displayed[0]!.left
  }
  return lastLeft
}

test('no bounded window of raw inputs determines the outputs', () => {
  const config = probeConfig()
  const rectangle = config.rectangles[0]!
  const titlePoint = {
    x: rectangle.initialLeft + 10,
    y: rectangle.initialTop + 5,
  }
  const dragSession: FrameInput[] = [
    {kind: 'down', ...titlePoint},
    {kind: 'move', x: titlePoint.x + 60, y: titlePoint.y},
    {kind: 'up', x: titlePoint.x + 60, y: titlePoint.y},
  ]

  for (const suffixLength of [1, 4, 16, 64, 256]) {
    for (const framing of ['frames', 'events'] as const) {
      const suffix: FrameInput[] = framing === 'frames'
        ? Array<FrameInput>(suffixLength).fill(null)
        : Array.from({length: suffixLength}, (): FrameInput => ({kind: 'move', x: 5, y: 5}))
      const withDrag = [...dragSession, ...suffix]
      const withoutDrag = [
        ...Array<FrameInput>(dragSession.length).fill(null),
        ...suffix,
      ]
      expect(withDrag.length).toBe(withoutDrag.length)
      // The two traces end with the exact same K inputs...
      expect(withDrag.slice(-suffixLength)).toEqual(withoutDrag.slice(-suffixLength))
      // ...but their correct final outputs differ.
      const draggedLeft = finalDisplayedLeft(config, withDrag)
      const untouchedLeft = finalDisplayedLeft(config, withoutDrag)
      expect(draggedLeft).toBe(rectangle.initialLeft + 60)
      expect(untouchedLeft).toBe(rectangle.initialLeft)
    }
  }
})

test('the latched aggregate carries the unbounded dependence through one event-time write', () => {
  // Run arbitrarily many sequential drags: the circuit's press window never
  // grows (one live record), yet the position reflects every drag. The
  // dependence on unboundedly old events funnels entirely through the commit
  // write at each release.
  const config = probeConfig()
  const rectangle = config.rectangles[0]!
  const machine = createEventWindowMachine(config)
  const state = createOracleState(config)
  const dragCount = 200
  const trace: FrameInput[] = []
  let left = rectangle.initialLeft
  let top = rectangle.initialTop
  for (let drag = 0; drag < dragCount; drag++) {
    // Alternate small right and left drags, staying inside the viewport.
    const step = drag % 2 === 0 ? 7 : -6
    const grabX = left + 10
    const grabY = top + 5
    trace.push(
      {kind: 'down', x: grabX, y: grabY},
      {kind: 'move', x: grabX + step, y: grabY},
      {kind: 'up', x: grabX + step, y: grabY},
      null,
    )
    left += step
  }
  const result = runClosedLoop(config, trace, machine, state)
  expect(result.divergences).toBe(0)
  expect(state.rectangleLeft[0]).toBe(rectangle.initialLeft + dragCount / 2)
})
