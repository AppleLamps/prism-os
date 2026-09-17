// A drawer whose width springs between 320 px (closed) and 760 px (open) when a
// toggle button is pressed. Inside it, 12 square thumbnails lay out in as many
// columns of at least 120 px as the drawer's width allows, at most 5, and each
// thumbnail's size is the width divided by the column count, so the grid reflows
// from 2 to 5 columns while the drawer opens. Neither resting width sits next to a
// column threshold, so a spring's small overshoot doesn't flip the column count.
//
// The layout reads the drawer's width from one of three places:
// - 'this evaluation': the width this evaluation draws, after the springs step and
//   settle. The layout's layers come after the springs' layers.
// - 'last evaluation': a source cell holding the width that the last evaluation
//   that wrote state back drew, i.e. last frame's value when every frame writes
//   back. The layout doesn't read the springs' outputs, and lags behind them.
// - 'stepped springs': this evaluation's springs right after their steps, before
//   they settle, i.e. an earlier value from the same evaluation.
// Pattern: guide/patterns/read-last-frame.md.
import {
  Circuit,
  type SpringMatrixWires,
  type Wire,
  asWire,
  emitAnimatedObject,
  emitApplySpringMatrix,
  emitCompare,
  emitMultiply,
} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {
  type EvaluationKind,
  type SpringMatrix,
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from '../../../../../../src/runtime/host-timing.ts'
import {type Evaluator, createEvaluator} from './helpers.ts'

export const drawerLayout = {closedWidth: 320, openWidth: 760, minimumCellWidth: 120, maximumColumns: 5, thumbnailCount: 12} as const
export const drawerSpring = {stiffness: 290, damping: 30} as const
// Declared ranges, which the executors check on source cells on every evaluation.
export const widthLimit = 1024
export const displacementLimit = 1024
export const velocityLimit = 65_536

export const drawerCell = {
  matrixStart: 0,
  settleCheck: asWire(4),
  snap: asWire(5),
  toggleActive: asWire(6),
  open: asWire(7),
  displacement: asWire(8),
  velocity: asWire(9),
  // Only the 'last evaluation' layout reads this cell; every variant writes it back.
  previousWidth: asWire(10),
  size: 11,
} as const

// Positions in the evaluator's output: the next-state values first, then these.
export const drawerOutput = {
  columnCount: drawerCell.size,
  leftStart: drawerCell.size + 1,
  topStart: drawerCell.size + 1 + drawerLayout.thumbnailCount,
  drawnWidth: drawerCell.size + 1 + 2 * drawerLayout.thumbnailCount,
  layoutWidth: drawerCell.size + 2 + 2 * drawerLayout.thumbnailCount,
  active: drawerCell.size + 3 + 2 * drawerLayout.thumbnailCount,
} as const

export type WidthSource = 'this evaluation' | 'last evaluation' | 'stepped springs'

export function buildDrawerGrid(widthSource: WidthSource) {
  const {closedWidth, openWidth, minimumCellWidth, maximumColumns, thumbnailCount} = drawerLayout
  const circuit = new Circuit(drawerCell.size)
  const bound = springMatrixBound(drawerSpring)
  const {matrixStart} = drawerCell
  const matrix: SpringMatrixWires = [circuit.source(matrixStart), circuit.source(matrixStart + 1), circuit.source(matrixStart + 2), circuit.source(matrixStart + 3)]
  for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
  for (const bit of [drawerCell.settleCheck, drawerCell.snap, drawerCell.toggleActive, drawerCell.open]) circuit.assumeRange(bit, 0, 1)
  circuit.assumeRange(drawerCell.displacement, -displacementLimit, displacementLimit)
  circuit.assumeRange(drawerCell.velocity, -velocityLimit, velocityLimit)
  circuit.assumeRange(drawerCell.previousWidth, 0, widthLimit)
  const constant = (value: number) => circuit.affine([], value)

  // JS: if (toggle) open = !open
  const nextOpen = circuit.affine([
    [drawerCell.open, 1],
    [drawerCell.toggleActive, 1],
    [emitMultiply(circuit, drawerCell.open, drawerCell.toggleActive), -2],
  ])
  // JS: destinationWidth = open ? openWidth : closedWidth
  const destinationWidth = (open: Wire) => circuit.affine([[open, openWidth - closedWidth]], closedWidth)
  const widthBefore = destinationWidth(drawerCell.open)
  const drawer = emitAnimatedObject(circuit, [{
    matrix,
    displacement: drawerCell.displacement,
    velocity: drawerCell.velocity,
    destination: destinationWidth(nextOpen),
    destinationDuringSteps: widthBefore,
  }], {settleCheck: drawerCell.settleCheck, snap: drawerCell.snap})
  const drawnWidth = drawer.positions[0]!

  const layoutWidth = widthSource === 'this evaluation'
    ? drawnWidth
    : widthSource === 'last evaluation'
      ? drawerCell.previousWidth
      : circuit.roundAffine([
          [widthBefore, 1],
          [emitApplySpringMatrix(circuit, matrix, drawerCell.displacement, drawerCell.velocity).displacement, 1],
        ])
  // An assumed range for computed widths, like the cell's declared range; the tests
  // check it on every evaluation.
  circuit.assumeRange(layoutWidth, 0, widthLimit)

  // JS: columnCount = Math.min(5, Math.max(1, Math.floor(width / 120)))
  // widthReaches[c - 2] is [width >= 120 × c] for c = 2..5.
  const widthReaches = Array.from({length: maximumColumns - 1}, (_, index) =>
    emitCompare(circuit, layoutWidth, '>=', constant((index + 2) * minimumCellWidth)))
  const columnCount = circuit.affine(widthReaches.map((bit): [Wire, number] => [bit, 1]), 1)
  // A value that depends on the column count c is a sum over those bits: with
  // v(c) for c = 1..5, v(columnCount) = v(1) + Σ (v(c) - v(c - 1)) × [width >= 120 × c].
  const byColumnCount = (value: (columns: number) => number) => circuit.affine(
    widthReaches.map((bit, index): [Wire, number] => [bit, value(index + 2) - value(index + 1)]),
    value(1),
  )
  // JS: cellSize = width / columnCount
  const cellSize = emitMultiply(circuit, layoutWidth, byColumnCount(columns => 1 / columns))
  // JS: for (let index = 0; index < 12; index++) {
  //   left = (index % columnCount) * cellSize; top = Math.floor(index / columnCount) * cellSize }
  const lefts = Array.from({length: thumbnailCount}, (_, index) =>
    emitMultiply(circuit, byColumnCount(columns => index % columns), cellSize))
  const tops = Array.from({length: thumbnailCount}, (_, index) =>
    emitMultiply(circuit, byColumnCount(columns => Math.floor(index / columns)), cellSize))

  const zero = constant(0)
  const nextSource: Wire[] = Array.from({length: drawerCell.size}, (_, wire) => circuit.source(wire))
  nextSource[drawerCell.toggleActive] = zero
  nextSource[drawerCell.snap] = zero
  nextSource[drawerCell.open] = nextOpen
  nextSource[drawerCell.displacement] = drawer.displacements[0]!
  nextSource[drawerCell.velocity] = drawer.velocities[0]!
  // The stored copy: one more next-state value, copied back with the others.
  nextSource[drawerCell.previousWidth] = drawnWidth
  const roots = [...nextSource, columnCount, ...lefts, ...tops, drawnWidth, layoutWidth, drawer.active]
  return {circuit, roots, layoutRoots: [columnCount, ...lefts, ...tops]}
}

export function initialDrawerTable(): Float32Array {
  const table = new Float32Array(drawerCell.size)
  table.set([1, 0, 0, 1], drawerCell.matrixStart)
  table[drawerCell.previousWidth] = drawerLayout.closedWidth
  return table
}

export type DrawerLayout = {columnCount: number, lefts: number[], tops: number[]}

// The JavaScript loop the layout replaces.
export function layoutThumbnails(width: number): DrawerLayout {
  const {minimumCellWidth, maximumColumns, thumbnailCount} = drawerLayout
  const columnCount = Math.min(maximumColumns, Math.max(1, Math.floor(width / minimumCellWidth)))
  const cellSize = width / columnCount
  const lefts: number[] = []
  const tops: number[] = []
  for (let index = 0; index < thumbnailCount; index++) {
    lefts.push((index % columnCount) * cellSize)
    tops.push(Math.floor(index / columnCount) * cellSize)
  }
  return {columnCount, lefts, tops}
}

export function readDrawerLayout(outputs: Float32Array): DrawerLayout {
  const {thumbnailCount} = drawerLayout
  return {
    columnCount: outputs[drawerOutput.columnCount]!,
    lefts: Array.from(outputs.subarray(drawerOutput.leftStart, drawerOutput.leftStart + thumbnailCount)),
    tops: Array.from(outputs.subarray(drawerOutput.topStart, drawerOutput.topStart + thumbnailCount)),
  }
}

export type DrawerEvaluation = {
  kind: EvaluationKind
  timeMs: number
  writesBack: boolean
  // The previousWidth cell this evaluation read.
  previousWidth: number
  drawnWidth: number
  layoutWidth: number
  layout: DrawerLayout
}

export type DrawerRun = {
  // What each frame draws.
  frames: Map<number, DrawerEvaluation>
  evaluations: DrawerEvaluation[]
}

// Runs frames the way a page would, with advanceFrame planning each frame's
// evaluations, like runToastStack in toast-stack.ts.
export function runDrawerGrid(
  frameTimes: readonly number[],
  toggleTimes: readonly number[],
  writeBack: WriteBack,
  widthSource: WidthSource,
  evaluator: Evaluator = 'compiled',
): DrawerRun {
  const {circuit, roots} = buildDrawerGrid(widthSource)
  const evaluate = createEvaluator(circuit, roots, evaluator)
  const step = springStepMatrix(drawerSpring)
  const powers: SpringMatrix[] = Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(step, steps))
  const state = initialDrawerTable()
  const scratch = new Float32Array(drawerCell.size)
  const run: DrawerRun = {frames: new Map(), evaluations: []}
  let clock = stoppedSpringClock
  let nextToggle = 0
  for (const frameTime of frameTimes) {
    const arrived: {timeStamp: number}[] = []
    while (nextToggle < toggleTimes.length && toggleTimes[nextToggle]! <= frameTime) arrived.push({timeStamp: toggleTimes[nextToggle++]!})
    clock = advanceFrame(clock, frameTime, arrived, evaluation => {
      const table = evaluation.writesBack ? state : scratch
      if (!evaluation.writesBack) scratch.set(state)
      table.set(powers[evaluation.steps]!, drawerCell.matrixStart)
      table[drawerCell.settleCheck] = evaluation.settleCheck ? 1 : 0
      table[drawerCell.snap] = evaluation.snap ? 1 : 0
      // Toggles that share a timestamp flip the drawer once per toggle, like a count
      // of presses; the traces never deliver two at one timestamp.
      if (evaluation.events.length > 0) table[drawerCell.toggleActive] = 1
      const previousWidth = table[drawerCell.previousWidth]!
      const outputs = evaluate(table)
      const record: DrawerEvaluation = {
        kind: evaluation.kind,
        timeMs: evaluation.timeMs,
        writesBack: evaluation.writesBack,
        previousWidth,
        drawnWidth: outputs[drawerOutput.drawnWidth]!,
        layoutWidth: outputs[drawerOutput.layoutWidth]!,
        layout: readDrawerLayout(outputs),
      }
      run.evaluations.push(record)
      if (evaluation.kind === 'frame') run.frames.set(frameTime, record)
      if (evaluation.writesBack) state.set(outputs.subarray(0, drawerCell.size))
      return outputs[drawerOutput.active]! > 0
    }, writeBack)
  }
  return run
}
