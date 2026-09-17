// The index read instruction as first built in lab/ui-exploration/index-read: read
// candidates[floor(index)] directly. This file imports that prototype's copy of the
// runtime, which moved into lab/ui-exploration/pixel-output on September 16, 2026,
// so shared-runtime-index-read.test.ts can compare the copy with the runtime in src/runtime/.
import {Circuit, type Wire} from '../../../pixel-output/numeric-ui-core.ts'

// Source table: [index, table[0], ..., table[count - 1]].
export function buildIndexRead(count: number) {
  const circuit = new Circuit(1 + count)
  const index = 0
  const table = Array.from({length: count}, (_, position) => 1 + position)
  circuit.assumeRange(index, -4, count + 4)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const read = circuit.indexRead(index, table)
  const source = (indexValue: number, tableValues: readonly number[]) => Float32Array.from([indexValue, ...tableValues])
  return {circuit, index, table, read, source}
}

// Linear interpolation with a constant number of operations per read:
// 1. clamp the index to 0..count-1 with two ReLUs,
// 2. read floor(index) from a table of constant positions 0..count-2, which
//    gives the whole-number part as a wire,
// 3. read the entries on both sides of the index,
// 4. mix them with the fractional part.
// With indexGradient 'zero', the index gets its gradient only through the
// fractional part, which is exactly the slope between the two neighbors.
export function buildLinearReadFromIndexReads(count: number) {
  if (count < 2) throw new Error('a table read needs at least two entries')
  const circuit = new Circuit(1 + count)
  const index = 0
  const table = Array.from({length: count}, (_, position) => 1 + position)
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
