// One program per item. A list of rows is written as map stages, i.e. programs written once and run once per
// row, with reductions between them for the lines that carry a value from row to row. The same stages written
// out once per row, with each reduction as operations, form the duplicated circuit, the one program the staged
// form has to match bit for bit.
//
// Host contract: headerHeight, lineHeight, scrollTop, viewportHeight and pointerY are multiples of 1/4 px,
// lineCount is an integer, expanded is 0 or 1, and the list stays below 2^21 px tall. Every sum is then an exact
// FP32 value, so plain float64 JavaScript computes the same numbers as the circuits.
import {Circuit, emitCompare, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'

export type ListShared = {headerHeight: number, lineHeight: number, scrollTop: number, viewportHeight: number, pointerY: number}
export type ListRow = {lineCount: number, expanded: number}
export type ListOutputs = {
  rowHeights: number[]
  rowTops: number[]
  visible: number[]
  hovered: number[]
  visibleCount: number
  hoveredRow: number
  anyHovered: number
}

type Range = readonly [minimum: number, maximum: number, grid: number]

export const sharedRanges = {
  headerHeight: [0, 256, 1 / 4],
  lineHeight: [0, 64, 1 / 4],
  scrollTop: [0, 2 ** 21, 1 / 4],
  viewportHeight: [0, 16_384, 1 / 4],
  pointerY: [-16_384, 2 ** 21, 1 / 4],
} as const satisfies Record<keyof ListShared, Range>
export const rowRanges = {lineCount: [0, 256, 1], expanded: [0, 1, 1]} as const satisfies Record<keyof ListRow, Range>
const placementRanges = {rowTop: [0, 2 ** 21, 1 / 4], rowHeight: [0, 16_640, 1 / 4]} as const satisfies Record<string, Range>

// JS: one loop, where some lines only read row `row` and shared values, and others carry a value to the next row.
export function listReference(shared: ListShared, rows: readonly ListRow[]): ListOutputs {
  const outputs: ListOutputs = {rowHeights: [], rowTops: [], visible: [], hovered: [], visibleCount: 0, hoveredRow: 0, anyHovered: 0}
  let rowTop = 0
  for (let row = 0; row < rows.length; row++) {
    const {lineCount, expanded} = rows[row]!
    // Only this row and shared values:
    const rowHeight = shared.headerHeight + (expanded === 1 ? lineCount * shared.lineHeight : 0)
    const rowBottom = rowTop + rowHeight
    const visible = rowBottom > shared.scrollTop && rowTop < shared.scrollTop + shared.viewportHeight
    const hovered = shared.pointerY >= rowTop && shared.pointerY < rowBottom
    outputs.rowHeights.push(rowHeight)
    outputs.rowTops.push(rowTop)
    outputs.visible.push(visible ? 1 : 0)
    outputs.hovered.push(hovered ? 1 : 0)
    // Carried from row to row:
    if (visible) outputs.visibleCount++
    if (hovered) {
      outputs.hoveredRow = row
      outputs.anyHovered = 1
    }
    rowTop = rowBottom
  }
  return outputs
}

// Map stage 1, written once: a row's height, from the row's own fields and shared values.
export function emitRowHeight(circuit: Circuit, shared: {headerHeight: Wire, lineHeight: Wire}, row: {lineCount: Wire, expanded: Wire}): Wire {
  const bodyHeight = circuit.multiply(row.lineCount, shared.lineHeight)
  return circuit.roundAffine([[shared.headerHeight, 1], [circuit.multiply(row.expanded, bodyHeight), 1]])
}

// Map stage 2, written once: a row's visibility and hover, from its top and height and shared values.
export function emitRowPlacement(
  circuit: Circuit,
  shared: {scrollTop: Wire, viewportHeight: Wire, pointerY: Wire},
  row: {rowTop: Wire, rowHeight: Wire},
) {
  const and = (left: Wire, right: Wire) => {
    const bit = circuit.reglu([], 1, [[left, 1], [right, 1]], -1)
    circuit.assumeRange(bit, 0, 1)
    return bit
  }
  const rowBottom = circuit.roundAffine([[row.rowTop, 1], [row.rowHeight, 1]])
  const viewportBottom = circuit.roundAffine([[shared.scrollTop, 1], [shared.viewportHeight, 1]])
  return {
    visible: and(emitCompare(circuit, rowBottom, '>', shared.scrollTop), emitCompare(circuit, row.rowTop, '<', viewportBottom)),
    hovered: and(emitCompare(circuit, shared.pointerY, '>=', row.rowTop), emitCompare(circuit, shared.pointerY, '<', rowBottom)),
  }
}

// A map stage: one Circuit whose source cells are the shared values it reads, then one row's fields. This runner
// compiles the stage once and evaluates it once per row, which is a simplified version of instanced-items'
// executor, where each stage becomes one generated loop over rows and the part that reads no field runs once.
export type MapStage<S extends string, F extends string, O extends string> = {
  circuit: Circuit
  shared: Record<S, Wire>
  fields: Record<F, Wire>
  outputs: Record<O, Wire>
  roots: Wire[]
  evaluateCompiled: (source: Float32Array) => Float32Array
}

export function buildMapStage<S extends string, F extends string, O extends string>(
  sharedCells: Record<S, Range>,
  fieldCells: Record<F, Range>,
  build: (circuit: Circuit, shared: Record<S, Wire>, row: Record<F, Wire>) => Record<O, Wire>,
): MapStage<S, F, O> {
  const sharedNames = Object.keys(sharedCells) as S[]
  const fieldNames = Object.keys(fieldCells) as F[]
  const circuit = new Circuit(sharedNames.length + fieldNames.length)
  const declare = (wire: Wire, [minimum, maximum, grid]: Range) => {
    circuit.assumeRange(wire, minimum, maximum)
    circuit.assumeGrid(wire, grid)
  }
  const shared = {} as Record<S, Wire>
  sharedNames.forEach((name, wire) => {
    shared[name] = circuit.source(wire)
    declare(shared[name], sharedCells[name])
  })
  const fields = {} as Record<F, Wire>
  fieldNames.forEach((name, position) => {
    fields[name] = circuit.source(sharedNames.length + position)
    declare(fields[name], fieldCells[name])
  })
  const outputs = build(circuit, shared, fields)
  const roots = (Object.keys(outputs) as O[]).map(name => outputs[name])
  return {circuit, shared, fields, outputs, roots, evaluateCompiled: circuit.createTensorEvaluator(roots)}
}

export type Evaluator = 'reference' | 'compiled'

export function runMapStage<S extends string, F extends string, O extends string>(
  stage: MapStage<S, F, O>,
  sharedValues: Record<S, number>,
  columns: Record<F, readonly number[]>,
  rowCount: number,
  evaluator: Evaluator,
): Record<O, number[]> {
  const source = new Float32Array(stage.circuit.sourceSize)
  for (const name of Object.keys(stage.shared) as S[]) source[stage.shared[name]] = sharedValues[name]
  const outputNames = Object.keys(stage.outputs) as O[]
  const results = {} as Record<O, number[]>
  for (const name of outputNames) results[name] = []
  for (let row = 0; row < rowCount; row++) {
    for (const name of Object.keys(stage.fields) as F[]) source[stage.fields[name]] = columns[name][row]!
    if (evaluator === 'reference') {
      const values = stage.circuit.evaluateReference(source)
      for (const name of outputNames) results[name].push(values[stage.outputs[name]]!)
    } else {
      const values = stage.evaluateCompiled(source)
      outputNames.forEach((name, position) => results[name].push(values[position]!))
    }
  }
  return results
}

export function buildListStages() {
  const rowHeightStage = buildMapStage(
    {headerHeight: sharedRanges.headerHeight, lineHeight: sharedRanges.lineHeight},
    rowRanges,
    (circuit, shared, row) => ({rowHeight: emitRowHeight(circuit, shared, row)}),
  )
  const placementStage = buildMapStage(
    {scrollTop: sharedRanges.scrollTop, viewportHeight: sharedRanges.viewportHeight, pointerY: sharedRanges.pointerY},
    placementRanges,
    (circuit, shared, row) => emitRowPlacement(circuit, shared, row),
  )
  return {rowHeightStage, placementStage}
}

export function runListStages(stages: ReturnType<typeof buildListStages>, shared: ListShared, rows: readonly ListRow[], evaluator: Evaluator): ListOutputs {
  const rowCount = rows.length
  const lineCount = rows.map(row => row.lineCount)
  const expanded = rows.map(row => row.expanded)
  const {rowHeight: rowHeights} = runMapStage(stages.rowHeightStage, shared, {lineCount, expanded}, rowCount, evaluator)
  // Reduction: row tops as a prefix sum in row order, rounded to FP32 after every addition, like a chain of
  // roundAffine operations.
  const rowTops: number[] = []
  let runningTop = 0
  for (const rowHeight of rowHeights) {
    rowTops.push(runningTop)
    runningTop = Math.fround(runningTop + rowHeight)
  }
  const {visible, hovered} = runMapStage(stages.placementStage, shared, {rowTop: rowTops, rowHeight: rowHeights}, rowCount, evaluator)
  // Reductions: sums of bits. Rows don't overlap, so at most one row is hovered, and its index is a sum.
  let visibleCount = 0
  let hoveredRow = 0
  let anyHovered = 0
  for (let row = 0; row < rowCount; row++) {
    visibleCount += visible[row]!
    hoveredRow += row * hovered[row]!
    anyHovered += hovered[row]!
  }
  return {rowHeights, rowTops, visible, hovered, visibleCount, hoveredRow, anyHovered}
}

// Source table: headerHeight, lineHeight, scrollTop, viewportHeight, pointerY, then lineCount and expanded for
// every row. The stages are the same builder functions, called once per row, and the prefix sum is a chain.
export function buildDuplicatedList(rowCount: number) {
  const circuit = new Circuit(5 + 2 * rowCount)
  const shared = {
    headerHeight: circuit.source(0),
    lineHeight: circuit.source(1),
    scrollTop: circuit.source(2),
    viewportHeight: circuit.source(3),
    pointerY: circuit.source(4),
  }
  const declare = (wire: Wire, [minimum, maximum, grid]: Range) => {
    circuit.assumeRange(wire, minimum, maximum)
    circuit.assumeGrid(wire, grid)
  }
  for (const name of Object.keys(shared) as (keyof ListShared)[]) declare(shared[name], sharedRanges[name])
  const rows = Array.from({length: rowCount}, (_, row) => ({lineCount: circuit.source(5 + 2 * row), expanded: circuit.source(6 + 2 * row)}))
  for (const row of rows) {
    declare(row.lineCount, rowRanges.lineCount)
    declare(row.expanded, rowRanges.expanded)
  }
  const rowHeights = rows.map(row => emitRowHeight(circuit, shared, row))
  // The prefix sum as a chain, in row order like the staged reduction. Each total after row `row` is the same
  // expression as that row's bottom in emitRowPlacement, so the builder shares the wire, and the declaration
  // below gives every row's bottom the range and grid that the placement stage's fields have.
  const rowTopsThrough: Wire[] = [circuit.affine([], 0)]
  for (let row = 1; row <= rowCount; row++) {
    const rowTop = circuit.roundAffine([[rowTopsThrough[row - 1]!, 1], [rowHeights[row - 1]!, 1]])
    declare(rowTop, placementRanges.rowTop)
    rowTopsThrough.push(rowTop)
  }
  const rowTops = rowTopsThrough.slice(0, rowCount)
  const placements = rows.map((_, row) => emitRowPlacement(circuit, shared, {rowTop: rowTops[row]!, rowHeight: rowHeights[row]!}))
  const visibleCount = circuit.roundAffine(placements.map(placement => [placement.visible, 1]))
  const anyHovered = circuit.roundAffine(placements.map(placement => [placement.hovered, 1]))
  const hoveredRow = circuit.affine(placements.map((placement, row) => [placement.hovered, row] as const))
  const roots = [
    ...rowHeights,
    ...rowTops,
    ...placements.map(placement => placement.visible),
    ...placements.map(placement => placement.hovered),
    visibleCount,
    hoveredRow,
    anyHovered,
  ]
  return {circuit, shared, rows, rowHeights, rowTops, placements, visibleCount, hoveredRow, anyHovered, roots}
}

// The duplicated circuit's outputs, in the order of buildDuplicatedList's roots.
export function unpackDuplicatedOutputs(outputs: readonly number[], rowCount: number): ListOutputs {
  const column = (index: number) => outputs.slice(index * rowCount, (index + 1) * rowCount)
  return {
    rowHeights: column(0),
    rowTops: column(1),
    visible: column(2),
    hovered: column(3),
    visibleCount: outputs[4 * rowCount]!,
    hoveredRow: outputs[4 * rowCount + 1]!,
    anyHovered: outputs[4 * rowCount + 2]!,
  }
}
