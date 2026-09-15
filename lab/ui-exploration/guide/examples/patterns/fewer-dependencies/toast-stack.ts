// A stack of toasts, e.g. notifications. A press on a toast dismisses it, the toasts
// below slide up into its place, and a "Show all" press brings every toast back.
// Each toast is one animated object of the shared runtime, stepped by the spring
// matrix that JavaScript writes, and the host plans evaluations with advanceFrame.
//
// The hit test for a press uses one of two things:
// - 'destinations': each toast's destination, i.e. pitch × the number of present
//   toasts above it, which comes straight from stored state and lies on a grid.
// - 'drawn positions': where each toast is drawn at the press's timestamp, i.e. its
//   springs stepped to that timestamp, which comes out of spring arithmetic.
// Patterns: guide/patterns/hit-test-destinations.md and guide/patterns/commit-at-events.md.
import {
  Circuit,
  type SpringMatrixWires,
  type Wire,
  emitAnimatedObject,
  emitApplySpringMatrix,
  emitCompare,
  emitFirstActive,
  emitMultiply,
} from '../../../../../../numeric-ui-core.ts'
import {
  type EvaluationKind,
  type SpringMatrix,
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  quantizeTimeMs,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from '../../../../../../host-timing.ts'
import {type Evaluator, createEvaluator, emitAll} from './helpers.ts'

// 4 toasts of 320 × 40 px, 48 px apart, in a column whose left edge is at 16 px.
export const toastLayout = {count: 4, left: 16, width: 320, height: 40, pitch: 48} as const
export const toastSpring = {stiffness: 290, damping: 30} as const
// Declared ranges. The executors check source cells on every evaluation, so a trace
// that stored a displacement or velocity outside these ranges would throw.
export const pointerLimit = 16_384
export const displacementLimit = 1024
export const velocityLimit = 65_536

export const toastCell = {
  matrixStart: 0,
  settleCheck: 4,
  snap: 5,
  pressActive: 6,
  pressX: 7,
  pressY: 8,
  showAllActive: 9,
  // Then present, displacement and velocity, for each toast.
  firstToast: 10,
  size: 10 + 3 * toastLayout.count,
} as const

export function toastCells(index: number) {
  const base = toastCell.firstToast + 3 * index
  return {present: base, displacement: base + 1, velocity: base + 2}
}

// Positions in the evaluator's output: the next-state values first, then these.
export const toastOutput = {
  drawnTopStart: toastCell.size,
  activeStart: toastCell.size + toastLayout.count,
  pressedStart: toastCell.size + 2 * toastLayout.count,
} as const

export type HitTestSource = 'destinations' | 'drawn positions'

export function buildToastStack(hitTestSource: HitTestSource) {
  const {count, left, width, height, pitch} = toastLayout
  const circuit = new Circuit(toastCell.size)
  const bound = springMatrixBound(toastSpring)
  const {matrixStart} = toastCell
  const matrix: SpringMatrixWires = [matrixStart, matrixStart + 1, matrixStart + 2, matrixStart + 3]
  for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
  for (const bit of [toastCell.settleCheck, toastCell.snap, toastCell.pressActive, toastCell.showAllActive]) circuit.assumeRange(bit, 0, 1)
  // The host writes pointer coordinates on a 1/64 px grid.
  for (const coordinate of [toastCell.pressX, toastCell.pressY]) {
    circuit.assumeRange(coordinate, -pointerLimit, pointerLimit)
    circuit.assumeGrid(coordinate, 1 / 64)
  }
  const toasts = Array.from({length: count}, (_, index) => {
    const cells = toastCells(index)
    circuit.assumeRange(cells.present, 0, 1)
    circuit.assumeGrid(cells.present, 1)
    circuit.assumeRange(cells.displacement, -displacementLimit, displacementLimit)
    circuit.assumeRange(cells.velocity, -velocityLimit, velocityLimit)
    return cells
  })
  const constant = (value: number) => circuit.affine([], value)

  // JS: destinationTop = pitch * (number of present toasts above this one)
  const destinationTops = (present: readonly Wire[]) => present.map((_, index) =>
    circuit.affine(present.slice(0, index).map((bit): [Wire, number] => [bit, pitch])))
  const destinationsBefore = destinationTops(toasts.map(toast => toast.present))

  // JS: left <= pointerX && pointerX < left + width
  const insideColumn = emitAll(circuit, [
    emitCompare(circuit, toastCell.pressX, '>=', constant(left)),
    emitCompare(circuit, toastCell.pressX, '<', constant(left + width)),
  ])
  const hitTops = hitTestSource === 'destinations'
    ? destinationsBefore
    // The springs stepped to the press's timestamp, before the press applies.
    : toasts.map((toast, index) => circuit.roundAffine([
        [destinationsBefore[index]!, 1],
        [emitApplySpringMatrix(circuit, matrix, toast.displacement, toast.velocity).displacement, 1],
      ]))
  // JS: toast.present && insideColumn && top <= pointerY && pointerY < top + height
  const hits = toasts.map((toast, index) => {
    const top = hitTops[index]!
    const bottom = hitTestSource === 'destinations'
      ? circuit.affine([[top, 1]], height)
      : circuit.roundAffine([[top, 1]], height)
    return emitAll(circuit, [
      toast.present,
      insideColumn,
      emitCompare(circuit, toastCell.pressY, '>=', top),
      emitCompare(circuit, toastCell.pressY, '<', bottom),
    ])
  })
  // JS: const pressedIndex = press == null ? -1 : toasts.findIndex(...)
  const pressed = hitTestSource === 'destinations'
    // Present toasts' destinations don't overlap, so at most one hit bit is 1.
    ? hits.map(hit => emitMultiply(circuit, hit, toastCell.pressActive))
    // Drawn toasts can overlap while they move, so pick the first hit, like findIndex.
    : emitFirstActive(circuit, toastCell.pressActive, hits)

  // JS: toast.present = showAll || (toast.present && index !== pressedIndex)
  const nextPresent = toasts.map((toast, index) => {
    const afterPress = circuit.affine([[toast.present, 1], [pressed[index]!, -1]])
    return circuit.affine([[circuit.reglu([], 1, [[toastCell.showAllActive, -1], [afterPress, -1]], 1), -1]], 1)
  })
  const destinationsAfter = destinationTops(nextPresent)
  const objects = toasts.map((toast, index) => emitAnimatedObject(circuit, [{
    matrix,
    displacement: toast.displacement,
    velocity: toast.velocity,
    destination: destinationsAfter[index]!,
    // The steps simulate time before this evaluation's press, so they pull toward
    // the destination in effect before it.
    destinationDuringSteps: destinationsBefore[index]!,
  }], {settleCheck: toastCell.settleCheck, snap: toastCell.snap}))

  const zero = constant(0)
  const nextSource: Wire[] = Array.from({length: toastCell.size}, (_, wire) => wire)
  for (const latch of [toastCell.pressActive, toastCell.showAllActive, toastCell.snap]) nextSource[latch] = zero
  toasts.forEach((toast, index) => {
    nextSource[toast.present] = nextPresent[index]!
    nextSource[toast.displacement] = objects[index]!.displacements[0]!
    nextSource[toast.velocity] = objects[index]!.velocities[0]!
  })
  const roots = [
    ...nextSource,
    ...objects.map(object => object.positions[0]!),
    ...objects.map(object => object.active),
    ...pressed,
  ]
  return {circuit, roots, pressed}
}

export function initialToastTable(): Float32Array {
  const table = new Float32Array(toastCell.size)
  table.set([1, 0, 0, 1], toastCell.matrixStart)
  for (let index = 0; index < toastLayout.count; index++) table[toastCells(index).present] = 1
  return table
}

export type ToastEvent =
  | {timeStamp: number, kind: 'press', x: number, y: number}
  | {timeStamp: number, kind: 'show all'}

export type ToastRun = {
  // Each toast's drawn top at each frame's timestamp.
  drawnTops: Map<number, number[]>
  // Every evaluation that wrote state back: its kind, time and the table after it.
  commits: {kind: EvaluationKind, timeMs: number, table: Float32Array}[]
  // Each toast's active bit after every settle check that wrote state back.
  settleChecks: {timeMs: number, active: number[]}[]
  evaluationCounts: Record<EvaluationKind, number>
  finalState: Float32Array
}

// Runs frames the way a page would. For each frame, advanceFrame plans the
// evaluations, and the callback writes each evaluation's spring matrix, settle check
// bit, snap bit and events, evaluates, and writes next state back when evaluation.writesBack is true.
export function runToastStack(
  frameTimes: readonly number[],
  events: readonly ToastEvent[],
  writeBack: WriteBack,
  hitTestSource: HitTestSource = 'destinations',
  evaluator: Evaluator = 'compiled',
): ToastRun {
  const {circuit, roots} = buildToastStack(hitTestSource)
  const evaluate = createEvaluator(circuit, roots, evaluator)
  const step = springStepMatrix(toastSpring)
  const powers: SpringMatrix[] = Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(step, steps))
  const state = initialToastTable()
  const scratch = new Float32Array(toastCell.size)
  const run: ToastRun = {
    drawnTops: new Map(),
    commits: [],
    settleChecks: [],
    evaluationCounts: {'settle check': 0, events: 0, frame: 0, snap: 0},
    finalState: state,
  }
  let clock = stoppedSpringClock
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    const arrived: ToastEvent[] = []
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) arrived.push(events[nextEvent++]!)
    clock = advanceFrame(clock, frameTime, arrived, evaluation => {
      run.evaluationCounts[evaluation.kind]++
      // A frame that doesn't write back evaluates a copy of the table.
      const table = evaluation.writesBack ? state : scratch
      if (!evaluation.writesBack) scratch.set(state)
      table.set(powers[evaluation.steps]!, toastCell.matrixStart)
      table[toastCell.settleCheck] = evaluation.settleCheck ? 1 : 0
      table[toastCell.snap] = evaluation.snap ? 1 : 0
      for (const event of evaluation.events) {
        if (event.kind === 'press') {
          table[toastCell.pressActive] = 1
          table[toastCell.pressX] = event.x
          table[toastCell.pressY] = event.y
        } else {
          table[toastCell.showAllActive] = 1
        }
      }
      const outputs = evaluate(table)
      const active = Array.from(outputs.subarray(toastOutput.activeStart, toastOutput.activeStart + toastLayout.count))
      if (evaluation.writesBack) {
        state.set(outputs.subarray(0, toastCell.size))
        run.commits.push({kind: evaluation.kind, timeMs: evaluation.timeMs, table: Float32Array.from(state)})
        if (evaluation.kind === 'settle check') run.settleChecks.push({timeMs: evaluation.timeMs, active})
      }
      if (evaluation.kind === 'frame') {
        run.drawnTops.set(frameTime, Array.from(outputs.subarray(toastOutput.drawnTopStart, toastOutput.drawnTopStart + toastLayout.count)))
      }
      return active.some(bit => bit > 0)
    }, writeBack)
  }
  return run
}

// The JavaScript loops the circuits replace, over toasts described in plain JS.
export type ToastState = {present: boolean, destinationTop: number, drawnTop: number}

// JS: which toast a press dismisses, tested against the toasts' destinations.
export function pressedToastByDestination(toasts: readonly ToastState[], pointerX: number, pointerY: number): number {
  const {left, width, height} = toastLayout
  return toasts.findIndex(toast => toast.present
    && left <= pointerX && pointerX < left + width
    && toast.destinationTop <= pointerY && pointerY < toast.destinationTop + height)
}

// JS: which toast a press dismisses, tested against where toasts are drawn. The drawn
// top is an FP32 value, and so is its bottom edge, like the circuit's.
export function pressedToastByDrawnPosition(toasts: readonly ToastState[], pointerX: number, pointerY: number): number {
  const {left, width, height} = toastLayout
  return toasts.findIndex(toast => toast.present
    && left <= pointerX && pointerX < left + width
    && toast.drawnTop <= pointerY && pointerY < Math.fround(toast.drawnTop + height))
}

// Reads the toasts out of a source table, in plain JS: destinations in float64, and
// drawn tops at the press's timestamp as the FP32 sums the circuit computes, i.e.
// f(destinationTop + f(f(m0 × displacement) + f(m1 × velocity))).
export function toastsFromTable(table: Float32Array): ToastState[] {
  const m0 = table[toastCell.matrixStart]!
  const m1 = table[toastCell.matrixStart + 1]!
  let presentAbove = 0
  return Array.from({length: toastLayout.count}, (_, index) => {
    const cells = toastCells(index)
    const destinationTop = toastLayout.pitch * presentAbove
    const steppedDisplacement = Math.fround(Math.fround(m0 * table[cells.displacement]!) + Math.fround(m1 * table[cells.velocity]!))
    const present = table[cells.present] === 1
    if (present) presentAbove++
    return {present, destinationTop, drawnTop: Math.fround(destinationTop + steppedDisplacement)}
  })
}

// Plain JS in float64 with no frames, in the order advanceFrame follows: index.ts's
// 4 ms Euler steps from the moment the clock started, a settle check every 16 steps
// with index.ts's thresholds, and each event applied at its timestamp after stepping
// to it, with presses tested against destinations. A stopped clock starts at an event
// that moves a toast.
export function toastStackReference(frameTimes: readonly number[], events: readonly ToastEvent[]) {
  const {count, pitch, left, width, height} = toastLayout
  const threshold = Math.fround(0.01)
  const toasts = Array.from({length: count}, (_, index) => ({present: true, top: pitch * index, velocity: 0}))
  const destinationTop = (index: number) => pitch * toasts.slice(0, index).filter(toast => toast.present).length
  const drawnTops = new Map<number, number[]>()
  const settleChecks: {timeMs: number, active: number[]}[] = []
  let animatedUntilMs: number | null = null
  let originMs = 0
  // Snaps every toast within both thresholds onto its destination, and returns each toast's active bit.
  const checkSettled = () => toasts.map((toast, index) => {
    const destination = destinationTop(index)
    if (Math.abs(toast.top - destination) <= threshold && Math.abs(toast.velocity) <= threshold) {
      toast.top = destination
      toast.velocity = 0
      return 0
    }
    return 1
  })
  const advanceTo = (timeMs: number) => {
    while (animatedUntilMs !== null && animatedUntilMs + 4 <= timeMs) {
      toasts.forEach((toast, index) => {
        const displacement = toast.top - destinationTop(index)
        toast.velocity += (-toastSpring.stiffness * displacement - toastSpring.damping * toast.velocity) * 0.004
        toast.top = destinationTop(index) + displacement + toast.velocity * 0.004
      })
      const steppedMs: number = animatedUntilMs + 4
      animatedUntilMs = steppedMs
      if ((steppedMs - originMs) % 64 === 0) {
        const active = checkSettled()
        settleChecks.push({timeMs: steppedMs, active})
        if (active.every(bit => bit === 0)) animatedUntilMs = null
      }
    }
  }
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) {
      const eventMs = quantizeTimeMs(events[nextEvent]!.timeStamp)
      advanceTo(eventMs)
      // Events that share a timestamp apply together, a press before "Show all".
      const here: ToastEvent[] = []
      while (nextEvent < events.length && quantizeTimeMs(events[nextEvent]!.timeStamp) === eventMs && events[nextEvent]!.timeStamp <= frameTime) {
        here.push(events[nextEvent++]!)
      }
      const press = here.findLast(event => event.kind === 'press')
      if (press !== undefined) {
        // Moves toasts from where they're drawn onto new destinations, keeping their drawn tops.
        const pressedIndex = toasts.findIndex((toast, index) => toast.present
          && left <= press.x && press.x < left + width
          && destinationTop(index) <= press.y && press.y < destinationTop(index) + height)
        if (pressedIndex >= 0) toasts[pressedIndex]!.present = false
      }
      if (here.some(event => event.kind === 'show all')) for (const toast of toasts) toast.present = true
      if (animatedUntilMs === null && checkSettled().some(bit => bit === 1)) {
        animatedUntilMs = eventMs
        originMs = eventMs
      }
    }
    advanceTo(quantizeTimeMs(frameTime))
    drawnTops.set(frameTime, toasts.map(toast => toast.top))
  }
  return {drawnTops, settleChecks}
}
