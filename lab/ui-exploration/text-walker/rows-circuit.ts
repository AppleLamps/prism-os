// A circuit that walks lines over candidate rows (rows.ts), one line slot at a time.
//
// Per line slot: an integer one-hot of the start unit, gathered reads of that start's row, one
// comparison per candidate against the slot's own width, and sums of deltas gated by the fit bits.
// Every width the walker compares is prepared data, so the same circuit covers chunks, emergency
// breaks, soft hyphens, letter spacing and tabs; what changes per feature is how rows.ts derives
// the candidates and how many cursor units the text needs.
import {type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {type PreparedView} from './fake-canvas.ts'
import {SourceTable, compile, fitBit, integerAtLeast, integerOneHot, maskedRead, type Compiled} from './kit.ts'
import {buildUnits, unitRow, type RowOptions, type UnitRow, type Units} from './rows.ts'

export type RowTable = {units: Units, rows: UnitRow[], steps: number}

// Candidates above the largest tested width can never be the first failure, so they are dropped.
export function buildRowTable(view: PreparedView, options: RowOptions & {maximumWidth: number, epsilon: number}): RowTable {
  const units = buildUnits(view, options)
  const rows: UnitRow[] = []
  for (let unit = 0; unit < units.count; unit++) {
    const row = unitRow(view, units, unit, options)
    rows.push({base: row.base, steps: row.steps.filter(step => step.threshold <= options.maximumWidth + options.epsilon)})
  }
  return {units, rows, steps: Math.max(1, ...rows.map(row => row.steps.length))}
}

// Added to every threshold read, so an exhausted start (reading zeros) and padded steps never fit.
const thresholdOffset = 8192
export const maximumRowLineWidth = 4096

export type RowLine = {start: number, end: number, width: number}

export type RowsOutputs = {lineCount: number, moreLinesThanSlots: number, lines: RowLine[]}

export type RowsBuild = {
  source: SourceTable
  compiled: Compiled
  table: RowTable
  maxWidth: Wire
  startCursor: Wire
  lineWidthCells: Wire[]
  decode: (values: Float32Array) => RowsOutputs
}

export type RowsCircuitOptions = {lineSlots: number, epsilon: number, perLineWidths: boolean}

export function buildRowsCircuit(table: RowTable, options: RowsCircuitOptions): RowsBuild {
  const unitCount = table.units.count
  const stepCount = table.steps
  const source = new SourceTable()
  const unit = source.unit
  const maxWidth = source.cell(320, 0, maximumRowLineWidth)
  const startCursor = source.cell(0, 0, unitCount)
  const lineWidthCells = options.perLineWidths
    ? Array.from({length: options.lineSlots}, () => source.cell(320, 0, maximumRowLineWidth))
    : Array.from({length: options.lineSlots}, () => maxWidth)
  // Start, next start and end are stored minus the unit count, so an exhausted start reads zeros
  // and lands on the end again.
  const baseStart = source.cells(table.rows.map(row => row.base.lineStart - unitCount), -unitCount, 0)
  const baseNext = source.cells(table.rows.map(row => row.base.next - unitCount), -unitCount, 0)
  const baseEnd = source.cells(table.rows.map(row => row.base.end - unitCount), -unitCount, 0)
  const baseWidth = source.cells(table.rows.map(row => row.base.width), -maximumRowLineWidth, 2 * maximumRowLineWidth)
  const thresholds: Wire[][] = []
  const deltaNext: Wire[][] = []
  const deltaEnd: Wire[][] = []
  const deltaWidth: Wire[][] = []
  for (let step = 0; step < stepCount; step++) {
    thresholds.push(source.cells(table.rows.map(row => (row.steps[step]?.threshold ?? thresholdOffset) - thresholdOffset), -thresholdOffset, 0))
    deltaNext.push(source.cells(table.rows.map(row => row.steps[step]?.delta.next ?? 0), -unitCount, unitCount))
    deltaEnd.push(source.cells(table.rows.map(row => row.steps[step]?.delta.end ?? 0), -unitCount, unitCount))
    deltaWidth.push(source.cells(table.rows.map(row => row.steps[step]?.delta.width ?? 0), -2 * maximumRowLineWidth, 2 * maximumRowLineWidth))
  }
  const circuit = source.createCircuit()
  let start: Wire = startCursor
  const lineWires: Wire[] = []
  const countTerms: [Wire, number][] = []
  for (let line = 0; line < options.lineSlots; line++) {
    const oneHot = integerOneHot(circuit, unit, start, 0, unitCount, true)
    const read = (cells: readonly Wire[]) => maskedRead(circuit, oneHot.members, cells)
    const lineStart = circuit.roundAffine([[read(baseStart), 1]], unitCount)
    circuit.assumeRange(lineStart, 0, unitCount)
    const nextTerms: [Wire, number][] = [[read(baseNext), 1]]
    const endTerms: [Wire, number][] = [[read(baseEnd), 1]]
    const widthTerms: [Wire, number][] = [[read(baseWidth), 1]]
    for (let step = 0; step < stepCount; step++) {
      const fits = fitBit(circuit, unit, [[read(thresholds[step]!), 1], [unit, thresholdOffset]], lineWidthCells[line]!, options.epsilon)
      nextTerms.push([circuit.multiply(read(deltaNext[step]!), fits), 1])
      endTerms.push([circuit.multiply(read(deltaEnd[step]!), fits), 1])
      widthTerms.push([circuit.multiply(read(deltaWidth[step]!), fits), 1])
    }
    const end = circuit.roundAffine(endTerms, unitCount)
    const width = circuit.roundAffine(widthTerms)
    lineWires.push(lineStart, end, width)
    // lineCount = slots - number of slots whose start is the end of the text.
    countTerms.push([integerAtLeast(circuit, [[lineStart, 1]], 0, unitCount), -1])
    start = circuit.roundAffine(nextTerms, unitCount)
    circuit.assumeRange(start, 0, unitCount)
  }
  const lineCount = circuit.roundAffine(countTerms, options.lineSlots)
  const moreLinesThanSlots = circuit.roundAffine([[integerAtLeast(circuit, [[start, 1]], 0, unitCount), -1]], 1)
  const compiled = compile(circuit, [lineCount, moreLinesThanSlots, ...lineWires])
  return {
    source,
    compiled,
    table,
    maxWidth,
    startCursor,
    lineWidthCells,
    decode: values => ({
      lineCount: values[0]!,
      moreLinesThanSlots: values[1]!,
      lines: Array.from({length: options.lineSlots}, (_, line) => ({
        start: values[2 + line * 3]!,
        end: values[3 + line * 3]!,
        width: values[4 + line * 3]!,
      })),
    }),
  }
}
