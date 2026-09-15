// Circuit builders for step tables: one runtime width in, layout results out.
//
// Two representations of the same table:
// - delta rows: output = base + sum over thresholds of bit_k * delta_k, with deltas as constant
//   weights. No products. Only nonzero deltas are stored. Changing the text means rebuilding the circuit.
// - gathered rows: the bits become a one-hot over pieces (neighbor differences), and every output
//   is a masked read of table cells in the source table, which the compiler lowers to one gather
//   read per output. Changing the text within the table's capacity means rewriting cells.

import {Circuit, type Wire} from '../../../numeric-ui-core.ts'
import type {BlockTable} from './tabulate.ts'

// ---------------------------------------------------------------- source table allocation

export class SourceLayout {
  values: number[] = []
  ranges: [number, number][] = []
  names: string[] = []

  cell(name: string, value: number, minimum: number, maximum: number): Wire {
    this.values.push(value)
    this.ranges.push([minimum, maximum])
    this.names.push(name)
    return this.values.length - 1
  }

  createCircuit(): Circuit {
    const circuit = new Circuit(this.values.length)
    for (let wire = 0; wire < this.values.length; wire++) circuit.assumeRange(wire, this.ranges[wire]![0], this.ranges[wire]![1])
    return circuit
  }

  table(): Float32Array {
    return Float32Array.from(this.values)
  }
}

// ---------------------------------------------------------------- comparisons

// Widths and thresholds live in [0, maximumWidth]. The scale keeps scale * maximumWidth below 2^23,
// where the composed clamp plateau is still exact.
export const maximumWidth = 8192
export const comparisonScale = 512

// [width >= threshold] as an exact bit, for an FP32 width in [0, 8192] and an FP32 threshold that is 0
// or in [2^-10, 8192]. Both ReLU gates evaluate 512 * (width - threshold) +/- 0.5 in FP32. Multiplying
// by a power of two is exact, and for these thresholds the bias 0.5 - 512 * threshold is representable
// and so is 0.5 - 512 * ulp(threshold). So the score is 0.5 exactly at equality (the boolean atom rounds
// 0.5 to 1) and below 0.5 one ulp under the threshold. Far from the threshold, rounding can't move the
// score across 0.5. Smaller thresholds break this. E.g. for 1e-4 the bias rounds, and a width one ulp
// under the threshold reads as 1. At exactly 2^-11, the width one ulp under gives 0.5 - 2^-26, which
// isn't representable and rounds up to 0.5.
// 4 atoms, 3 layers.
export const smallestExactThreshold = 2 ** -10

export function emitAtLeast(circuit: Circuit, width: Wire, threshold: number): Wire {
  const rounded = Math.fround(threshold)
  if (!(rounded === 0 || (rounded >= smallestExactThreshold && rounded <= maximumWidth))) {
    throw new Error(`threshold ${threshold} is outside 0 and ${smallestExactThreshold}..${maximumWidth}, where the comparison is exact`)
  }
  const positive = circuit.reglu([], 1, [[width, comparisonScale]], 0.5 - comparisonScale * rounded)
  const aboveOne = circuit.reglu([], 1, [[width, comparisonScale]], -0.5 - comparisonScale * rounded)
  const clamped = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// The same comparison with a runtime uniform font scale: when every advance scales linearly with the
// font size, pretext at font size scale * base breaks where scale * fitWidth > width + epsilon. The
// base-size threshold is fitWidth - epsilon, so this compares width + epsilon >= scale * (threshold + epsilon).
// Not exact at the ulp level: the product rounds, and real fonts aren't exactly linear in size.
export function emitAtLeastScaled(circuit: Circuit, width: Wire, fontScale: Wire, threshold: number, lineFitEpsilon: number): Wire {
  const fitWidth = threshold + lineFitEpsilon
  const bias = comparisonScale * lineFitEpsilon
  const positive = circuit.reglu([], 1, [[width, comparisonScale], [fontScale, -comparisonScale * fitWidth]], bias + 0.5)
  const aboveOne = circuit.reglu([], 1, [[width, comparisonScale], [fontScale, -comparisonScale * fitWidth]], bias - 0.5)
  const clamped = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// ---------------------------------------------------------------- delta rows

export function emitDeltaRow(circuit: Circuit, bits: readonly Wire[], values: readonly number[]): Wire {
  const terms: [Wire, number][] = []
  for (let threshold = 0; threshold < bits.length; threshold++) {
    const delta = values[threshold + 1]! - values[threshold]!
    if (delta !== 0) terms.push([bits[threshold]!, delta])
  }
  return circuit.roundAffine(terms, values[0]!)
}

// ---------------------------------------------------------------- gathered rows

// piece_k = bit_k - bit_(k+1), with bit_0 = 1. Declared as a one-hot group so masked reads lower to gathers.
export function emitPieceOneHot(circuit: Circuit, bits: readonly Wire[]): Wire[] {
  const members: Wire[] = []
  for (let piece = 0; piece <= bits.length; piece++) {
    const member = piece === 0
      ? (bits.length === 0 ? circuit.roundAffine([], 1) : circuit.roundAffine([[bits[0]!, -1]], 1))
      : piece === bits.length
        ? circuit.roundAffine([[bits[piece - 1]!, 1]])
        : circuit.roundAffine([[bits[piece - 1]!, 1], [bits[piece]!, -1]])
    circuit.assumeRange(member, 0, 1)
    members.push(member)
  }
  circuit.assumeOneHot(members)
  return members
}

export function emitGatherRow(circuit: Circuit, members: readonly Wire[], cells: readonly Wire[]): Wire {
  return circuit.roundAffine(members.map((member, piece) => [circuit.multiply(cells[piece]!, member), 1] as const))
}

// ---------------------------------------------------------------- block tables

export type BlockOutputs = {
  lineCount: boolean
  maxLineWidth: boolean
  layoutWidth: boolean
  cursors: boolean
  lineWidths: boolean
}

export type BlockWires = {
  bits: Wire[]
  lineCount: Wire | null
  maxLineWidth: Wire | null
  layoutWidth: Wire | null
  starts: Wire[]
  ends: Wire[]
  lineWidths: Wire[]
}

function selectedRows(table: BlockTable, outputs: BlockOutputs, cursorCapacity = table.cursors.length) {
  const rows: {name: string, values: number[], minimum: number, maximum: number}[] = []
  const cursorMaximum = cursorCapacity - 1
  if (outputs.lineCount) rows.push({name: 'lineCount', values: table.lineCount, minimum: 0, maximum: 1_000_000})
  if (outputs.maxLineWidth) rows.push({name: 'maxLineWidth', values: table.maxLineWidth, minimum: 0, maximum: 1_000_000})
  if (outputs.layoutWidth) rows.push({name: 'layoutWidth', values: table.layoutWidth, minimum: 0, maximum: 1_000_000})
  for (let slot = 0; slot < table.slotCount; slot++) {
    if (outputs.cursors) {
      rows.push({name: `start${slot}`, values: table.startIds.map(row => row[slot]!), minimum: 0, maximum: cursorMaximum})
      rows.push({name: `end${slot}`, values: table.endIds.map(row => row[slot]!), minimum: 0, maximum: cursorMaximum})
    }
    if (outputs.lineWidths) rows.push({name: `width${slot}`, values: table.lineWidths.map(row => row[slot]!), minimum: 0, maximum: 1_000_000})
  }
  return rows
}

function assignRows(table: BlockTable, outputs: BlockOutputs, bits: Wire[], wires: Wire[]): BlockWires {
  let index = 0
  const take = (enabled: boolean) => enabled ? wires[index++]! : null
  const lineCount = take(outputs.lineCount)
  const maxLineWidth = take(outputs.maxLineWidth)
  const layoutWidth = take(outputs.layoutWidth)
  const starts: Wire[] = []
  const ends: Wire[] = []
  const lineWidths: Wire[] = []
  for (let slot = 0; slot < table.slotCount; slot++) {
    if (outputs.cursors) {
      starts.push(wires[index++]!)
      ends.push(wires[index++]!)
    }
    if (outputs.lineWidths) lineWidths.push(wires[index++]!)
  }
  return {bits, lineCount, maxLineWidth, layoutWidth, starts, ends, lineWidths}
}

export function emitBlockDeltaRows(circuit: Circuit, width: Wire, table: BlockTable, outputs: BlockOutputs): BlockWires {
  const bits = table.thresholds.map(threshold => emitAtLeast(circuit, width, threshold))
  const wires = selectedRows(table, outputs).map(row => {
    const wire = emitDeltaRow(circuit, bits, row.values)
    circuit.assumeRange(wire, row.minimum, row.maximum)
    return wire
  })
  return assignRows(table, outputs, bits, wires)
}

// Allocates table cells before the circuit exists; returns a builder to call once it does.
// `capacity` bounds the threshold count and `cursorCapacity` the cursor ids, so a later edit of the text
// can be written into the same cells.
export function allocateBlockGatherCells(source: SourceLayout, name: string, table: BlockTable, outputs: BlockOutputs, capacity = table.thresholds.length, cursorCapacity = table.cursors.length) {
  if (capacity < table.thresholds.length) throw new Error('table capacity is below its threshold count')
  if (cursorCapacity < table.cursors.length) throw new Error('cursor capacity is below the table cursor count')
  const rows = selectedRows(table, outputs, cursorCapacity)
  // Unused threshold slots sit above every width, so their bits stay 0 and their pieces are never read.
  const thresholdCells = Array.from({length: capacity}, (_, index) =>
    source.cell(`${name}.threshold${index}`, table.thresholds[index] ?? maximumWidth, 0, maximumWidth))
  const valueCells = rows.map(row => Array.from({length: capacity + 1}, (_, piece) =>
    source.cell(`${name}.${row.name}.${piece}`, row.values[Math.min(piece, row.values.length - 1)]!, row.minimum, row.maximum)))
  return {
    rows,
    thresholdCells,
    valueCells,
    emit(circuit: Circuit, width: Wire): BlockWires {
      const bits = thresholdCells.map(cell => emitAtLeastCell(circuit, width, cell))
      const members = emitPieceOneHot(circuit, bits)
      const wires = valueCells.map((cells, row) => {
        const wire = emitGatherRow(circuit, members, cells)
        circuit.assumeRange(wire, rows[row]!.minimum, rows[row]!.maximum)
        return wire
      })
      return assignRows(table, outputs, bits, wires)
    },
  }
}

// [width >= threshold cell], with the difference preserved first so the threshold can be a runtime
// value. For FP32 width and threshold within a factor of two of each other the subtraction is exact;
// otherwise the difference is large and its sign survives rounding.
export function emitAtLeastCell(circuit: Circuit, width: Wire, threshold: Wire): Wire {
  const difference = circuit.roundAffine([[width, 1], [threshold, -1]])
  const positive = circuit.reglu([], 1, [[difference, comparisonScale]], 0.5)
  const aboveOne = circuit.reglu([], 1, [[difference, comparisonScale]], -0.5)
  const clamped = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// ---------------------------------------------------------------- program statistics

export function programStats(circuit: Circuit, roots: readonly Wire[]) {
  const started = performance.now()
  const program = circuit.compileTensorProgram(roots)
  const compileMilliseconds = performance.now() - started
  let storedWeights = 0
  let gatherReads = 0
  let gatherTableEntries = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    for (const read of layer.gatherReads) gatherTableEntries += read.candidatePositions.length
  }
  return {
    sourceCells: circuit.sourceSize,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    gatherTableEntries,
    compileMilliseconds,
  }
}
