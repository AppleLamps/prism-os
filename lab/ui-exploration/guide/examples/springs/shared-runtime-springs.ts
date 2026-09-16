// A selection highlight built with the spring helpers of the repo root runtime,
// numeric-ui-core.ts, and the host timing in host-timing.ts, which Cheng decided on
// September 14, 2026 to make the default:
// - JavaScript writes the spring matrix for each evaluation's fixed 4 ms steps into
//   4 cells, and times on a 1/64 ms grid,
// - each animated object has one settle bit,
// - springs step to each event's timestamp before the event is applied,
// - settling is checked at fixed simulated times,
// - each spring stores its displacement from its destination, not a position, and
// - when a frame would need more than 300 steps, every animated object snaps onto
//   its destination instead of carrying the backlog into later frames.
// The other files in this folder build each piece by hand; this file uses the
// shared helpers, and shared-runtime-springs.test.ts checks it against plain
// float64 springs with no frames.
import {Circuit, type SpringMatrixWires, type Wire, asWire, emitAnimatedObject, emitSelect} from '../../../../../numeric-ui-core.ts'
import {
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  quantizeTimeMs,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from '../../../../../host-timing.ts'
import {seededRandom} from './frame-rate-check.ts'

export const highlightConstants = {stiffness: 290, damping: 30}
export const rowHeight = 28
export const rowCount = 12

// Cells: the spring matrix, the settle check and snap bits, a select event latch
// next to its row, and the highlight's displacement from the destination in effect,
// its velocity and that destination. The drawn top is destination + displacement,
// which the program computes for display and doesn't store.
export const highlightCell = {
  matrixStart: 0,
  settleCheck: asWire(4),
  snap: asWire(5),
  selectActive: asWire(6),
  selectedRow: asWire(7),
  displacement: asWire(8),
  velocity: asWire(9),
  destination: asWire(10),
  size: 11,
} as const
// Positions in the evaluator's output: the next-state values first, then these.
export const highlightOutput = {top: highlightCell.size, active: highlightCell.size + 1, settled: highlightCell.size + 2} as const

export function buildHighlight() {
  const circuit = new Circuit(highlightCell.size)
  // Every FP32 matrix entry the host writes for up to 300 steps stays within this bound.
  const bound = springMatrixBound(highlightConstants)
  const {matrixStart} = highlightCell
  const matrix: SpringMatrixWires = [circuit.source(matrixStart), circuit.source(matrixStart + 1), circuit.source(matrixStart + 2), circuit.source(matrixStart + 3)]
  for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
  circuit.assumeRange(highlightCell.settleCheck, 0, 1)
  circuit.assumeRange(highlightCell.snap, 0, 1)
  circuit.assumeRange(highlightCell.selectActive, 0, 1)
  circuit.assumeRange(highlightCell.selectedRow, 0, rowCount - 1)
  // JS: if (selectEvent) destination = selectEvent.row * rowHeight
  const destination = emitSelect(
    circuit,
    highlightCell.selectActive,
    highlightCell.destination,
    circuit.affine([[highlightCell.selectedRow, rowHeight]]),
  )
  const highlight = emitAnimatedObject(circuit, [{
    matrix,
    displacement: highlightCell.displacement,
    velocity: highlightCell.velocity,
    destination,
    // The steps simulate time before this evaluation's event, so they pull toward
    // the destination the previous evaluation wrote back.
    destinationDuringSteps: highlightCell.destination,
  }], {settleCheck: highlightCell.settleCheck, snap: highlightCell.snap})
  const nextSource: Wire[] = Array.from({length: highlightCell.size}, (_, wire) => circuit.source(wire))
  const zero = circuit.affine([], 0)
  nextSource[highlightCell.selectActive] = zero
  nextSource[highlightCell.snap] = zero
  nextSource[highlightCell.displacement] = highlight.displacements[0]!
  nextSource[highlightCell.velocity] = highlight.velocities[0]!
  nextSource[highlightCell.destination] = destination
  const roots = [...nextSource, highlight.positions[0]!, highlight.active, highlight.settled]
  return {circuit, roots}
}

export type SelectRow = {timeStamp: number, row: number}

export type HighlightRun = {
  // The top drawn at each frame's timestamp.
  tops: Map<number, number>
  // Every settle check that wrote state back: its time, and 1 when the highlight settled.
  settles: {timeMs: number, settled: number}[]
}

// What runHighlight also records about the planned evaluations.
export type CircuitHighlightRun = HighlightRun & {
  // The spring steps that each frame's evaluations ran together.
  stepsPerFrame: number[]
  // The time of every planned snap.
  snapTimes: number[]
  // The table after the last frame.
  finalState: Float32Array
}

// Runs frames the way a page would. For each frame, advanceFrame plans the
// evaluations, and the callback writes each evaluation's spring matrix, settle check
// bit, snap bit and event, evaluates, and writes next state back when evaluation.writesBack is true.
export function runHighlight(frameTimes: readonly number[], events: readonly SelectRow[], writeBack: WriteBack): CircuitHighlightRun {
  const {circuit, roots} = buildHighlight()
  const evaluate = circuit.createTensorEvaluator(roots)
  const step = springStepMatrix(highlightConstants)
  const powers = Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(step, steps))
  const state = new Float32Array(highlightCell.size)
  const scratch = new Float32Array(highlightCell.size)
  const run: CircuitHighlightRun = {tops: new Map(), settles: [], stepsPerFrame: [], snapTimes: [], finalState: state}
  let clock = stoppedSpringClock
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    const arrived: SelectRow[] = []
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) arrived.push(events[nextEvent++]!)
    let stepsThisFrame = 0
    clock = advanceFrame(clock, frameTime, arrived, evaluation => {
      stepsThisFrame += evaluation.steps
      if (evaluation.snap) run.snapTimes.push(evaluation.timeMs)
      // An evaluation that doesn't write back runs on a copy of the table.
      const table = evaluation.writesBack ? state : scratch
      if (!evaluation.writesBack) scratch.set(state)
      table.set(powers[evaluation.steps]!, highlightCell.matrixStart)
      table[highlightCell.settleCheck] = evaluation.settleCheck ? 1 : 0
      // A planned snap, when a frame would need more than 300 steps, lands the highlight on its destination.
      table[highlightCell.snap] = evaluation.snap ? 1 : 0
      for (const event of evaluation.events) {
        table[highlightCell.selectActive] = 1
        table[highlightCell.selectedRow] = event.row
      }
      const outputs = evaluate(table)
      if (evaluation.writesBack) {
        state.set(outputs.subarray(0, highlightCell.size))
        if (evaluation.settleCheck && evaluation.kind !== 'frame') {
          run.settles.push({timeMs: evaluation.timeMs, settled: outputs[highlightOutput.settled]!})
        }
      }
      if (evaluation.kind === 'frame') run.tops.set(frameTime, outputs[highlightOutput.top]!)
      return outputs[highlightOutput.active]! > 0
    }, writeBack)
    run.stepsPerFrame.push(stepsThisFrame)
  }
  return run
}

// Plain JS in float64 with no frames: index.ts's 4 ms Euler steps from the moment
// the clock started, a settle check every 16 steps with index.ts's thresholds, and
// each select event applied at its timestamp after stepping to it. A stopped clock
// starts at an event that moves the highlight. Times are rounded to the 1/64 ms
// grid, like the host rounds them.
export function highlightReference(frameTimes: readonly number[], events: readonly SelectRow[]): HighlightRun {
  const threshold = Math.fround(0.01)
  let top = 0
  let velocity = 0
  let destination = 0
  let animatedUntilMs: number | null = null
  let originMs = 0
  const run: HighlightRun = {tops: new Map(), settles: []}
  const checkSettled = (timeMs: number) => {
    const settled = Math.abs(top - destination) <= threshold && Math.abs(velocity) <= threshold
    if (settled) {
      top = destination
      velocity = 0
    }
    run.settles.push({timeMs, settled: settled ? 1 : 0})
    return settled
  }
  const advanceTo = (timeMs: number) => {
    while (animatedUntilMs !== null && animatedUntilMs + 4 <= timeMs) {
      const displacement = top - destination
      velocity += (-highlightConstants.stiffness * displacement - highlightConstants.damping * velocity) * 0.004
      top = destination + displacement + velocity * 0.004
      const steppedMs: number = animatedUntilMs + 4
      animatedUntilMs = (steppedMs - originMs) % 64 === 0 && checkSettled(steppedMs) ? null : steppedMs
    }
  }
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) {
      const eventMs = quantizeTimeMs(events[nextEvent]!.timeStamp)
      advanceTo(eventMs)
      // Events that share a timestamp apply together, and the last one sets the destination, like a latch.
      while (nextEvent < events.length && quantizeTimeMs(events[nextEvent]!.timeStamp) === eventMs && events[nextEvent]!.timeStamp <= frameTime) {
        destination = events[nextEvent++]!.row * rowHeight
      }
      if (animatedUntilMs === null && !checkSettled(eventMs)) {
        animatedUntilMs = eventMs
        originMs = eventMs
      }
    }
    advanceTo(quantizeTimeMs(frameTime))
    run.tops.set(frameTime, top)
  }
  return run
}

// 12 select events between frames on the 1/64 ms grid, 90 to 700 ms apart, so most
// of them move a highlight that is still moving.
export function selectEvents(seed: number): SelectRow[] {
  const random = seededRandom(seed)
  const events: SelectRow[] = []
  let time = 100
  for (let index = 0; index < 12; index++) {
    time += 90 + random() * 610
    events.push({timeStamp: Math.round(time * 64) / 64, row: Math.floor(random() * rowCount)})
  }
  return events
}
