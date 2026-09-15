// Linear interpolation between the two entries around a fractional index, like
// linear texture filtering. These are the same wires as one-hot-read.ts, built
// without declaring a one-hot, so the compiler keeps the masked sum dense and the
// compiled program interpolates exactly like the reference evaluator.
import {buildOneHotRead} from './one-hot-read.ts'

// Plain JS: the index is clamped to 0..count-1, then the two neighbors are mixed.
export function linearRead(table: readonly number[], index: number): number {
  const last = table.length - 1
  const clampedIndex = Math.min(Math.max(index, 0), last)
  const lowerPosition = Math.min(Math.floor(clampedIndex), last - 1)
  const fraction = clampedIndex - lowerPosition
  return table[lowerPosition]! * (1 - fraction) + table[lowerPosition + 1]! * fraction
}

// Derivatives of linearRead for an index strictly between two whole numbers:
// with respect to the index, the slope between the two neighbors (0 outside the
// table, where the index is clamped); with respect to each entry, its weight.
export function linearReadGradient(table: readonly number[], index: number): {index: number, table: number[]} {
  const last = table.length - 1
  const tableGradient = table.map(() => 0)
  if (index <= 0) {
    tableGradient[0] = 1
    return {index: 0, table: tableGradient}
  }
  if (index >= last) {
    tableGradient[last] = 1
    return {index: 0, table: tableGradient}
  }
  const lowerPosition = Math.floor(index)
  const fraction = index - lowerPosition
  tableGradient[lowerPosition] = 1 - fraction
  tableGradient[lowerPosition + 1] = fraction
  return {index: table[lowerPosition + 1]! - table[lowerPosition]!, table: tableGradient}
}

export function buildLinearRead(count: number) {
  return buildOneHotRead(count, {declareOneHot: false})
}
