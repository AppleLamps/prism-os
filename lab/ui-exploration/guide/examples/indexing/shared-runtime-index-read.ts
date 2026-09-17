// The index read instruction in the runtime, src/runtime/numeric-ui-core.ts, which
// Cheng decided on September 14, 2026 to add. index-read-instruction.ts builds the
// first two circuits below over index-read's copy of the runtime, where the
// instruction was first built, which is lab/ui-exploration/pixel-output/numeric-ui-core.ts
// since September 16, 2026. shared-runtime-index-read.test.ts checks that both
// runtimes give the same values and counts.
import {Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

// Source table: [index, table[0], ..., table[count - 1]]. The index needs a
// declared range strictly inside ±2^24, or the builder throws.
export function buildSharedIndexRead(count: number) {
  const circuit = new Circuit(1 + count)
  const index = circuit.source(0)
  const table = Array.from({length: count}, (_, position) => circuit.source(1 + position))
  circuit.assumeRange(index, -4, count + 4)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const read = circuit.indexRead(index, table)
  const source = (indexValue: number, tableValues: readonly number[]) => Float32Array.from([indexValue, ...tableValues])
  return {circuit, index, table, read, source}
}

// Linear interpolation from three index reads, the same construction as
// buildLinearReadFromIndexReads in index-read-instruction.ts:
// 1. clamp the index to 0..count-1 with two ReLUs,
// 2. read floor(index) from a table of constant positions 0..count-2,
// 3. read the entries on both sides of the index,
// 4. mix them with the fractional part.
// With {indexGradient: 'zero'}, the index gets its gradient only through the
// fractional part, which is the slope between the two neighbors.
export function buildSharedLinearRead(count: number) {
  if (count < 2) throw new Error('a table read needs at least two entries')
  const circuit = new Circuit(1 + count)
  const index = circuit.source(0)
  const table = Array.from({length: count}, (_, position) => circuit.source(1 + position))
  circuit.assumeRange(index, -4, count + 4)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const last = count - 1
  const clampedIndex = circuit.roundAffine([
    [circuit.reglu([], 1, [[index, 1]], 0), 1],
    [circuit.reglu([], 1, [[index, 1]], -last), -1],
  ])
  circuit.assumeRange(clampedIndex, 0, last)
  const positions: Wire[] = Array.from({length: last}, (_, position) => circuit.affine([], position))
  const lowerPosition = circuit.indexRead(clampedIndex, positions)
  const fraction = circuit.roundAffine([[clampedIndex, 1], [lowerPosition, -1]])
  circuit.assumeRange(fraction, 0, 1)
  const lowerValue = circuit.indexRead(clampedIndex, table.slice(0, last))
  const upperValue = circuit.indexRead(clampedIndex, table.slice(1))
  const difference = circuit.roundAffine([[upperValue, 1], [lowerValue, -1]])
  const read = circuit.roundAffine([[lowerValue, 1], [circuit.multiply(fraction, difference), 1]])
  const source = (indexValue: number, tableValues: readonly number[]) => Float32Array.from([indexValue, ...tableValues])
  return {circuit, index, table, read, source}
}

// A virtualized list: DOM slot k shows row firstVisibleRow + k, and its top is
// rowTops[firstVisibleRow + k], or +0 past the last row. In JavaScript:
//   slotTops[slot] = rowTops[firstVisibleRow + slot] ?? 0
// Each slot is one indexReadAffine with the index form firstVisibleRow + slot,
// 'clamp' below the table and 'zero' above it. The row tops are a run of source
// cells, so every read stores a base position and a stride instead of rowCount positions.
// Source table: [firstVisibleRow, rowTops[0], ..., rowTops[rowCount - 1]].
export function buildVisibleRowTops(rowCount: number, slotCount: number) {
  const circuit = new Circuit(1 + rowCount)
  const firstVisibleRow = circuit.source(0)
  const rowTops = Array.from({length: rowCount}, (_, row) => circuit.source(1 + row))
  circuit.assumeRange(firstVisibleRow, 0, rowCount - 1)
  const slotTops = Array.from({length: slotCount}, (_, slot) =>
    circuit.indexReadAffine([[firstVisibleRow, 1]], slot, rowTops, 'clamp', 'zero'))
  const source = (firstVisibleRowValue: number, rowTopValues: readonly number[]) =>
    Float32Array.from([firstVisibleRowValue, ...rowTopValues])
  return {circuit, firstVisibleRow, rowTops, slotTops, source}
}

// Plain JS for buildVisibleRowTops.
export function visibleRowTopsReference(rowTops: readonly number[], firstVisibleRow: number, slotCount: number): number[] {
  return Array.from({length: slotCount}, (_, slot) => rowTops[firstVisibleRow + slot] ?? 0)
}
