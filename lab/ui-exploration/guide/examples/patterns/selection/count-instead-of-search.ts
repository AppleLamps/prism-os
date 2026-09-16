// Count instead of search: the row under the pointer in a list of rows with different heights, as
// hn-thread finds the pointed comment.
//
// JS, from hn.js's pointer handling (hn.js 328-341, trimmed):
//   let rowTop = 0
//   for (let row = 0; row < rowHeights.length; row++) {
//     if (rowTop <= pointerY && pointerY < rowTop + rowHeights[row]) return row
//     rowTop += rowHeights[row]
//   }
//   return -1
//
// Row bottoms never decrease down the list, so [rowBottom[row] <= pointerY] reads 1...1 0...0 along the
// rows. The loop steps over the 1s and stops at the first 0, so the pointed row is the count of 1s,
// and the differences of neighboring bits give the pointed row's one-hot.
import {Circuit, emitCompare, emitFirstActive, type Wire} from '../../../../../../numeric-ui-core.ts'

export function pointedRowReference(rowHeights: ArrayLike<number>, pointerY: number): number {
  let rowTop = 0
  for (let row = 0; row < rowHeights.length; row++) {
    if (rowTop <= pointerY && pointerY < rowTop + rowHeights[row]!) return row
    rowTop += rowHeights[row]!
  }
  return -1
}

export type PointedRowForm = 'count' | 'tree'

export const positionLimit = 65_536

// Source table: [pointerY, then each row's bottom in top-to-bottom order]. JavaScript writes the
// bottoms, i.e. the running totals of the row heights, whenever the layout changes. Host contract:
// pointerY is a multiple of 1/64 px within ±65,536 px, and row bottoms are multiples of 1/4 px within
// 0..65,536 px that never decrease.
export function buildPointedRow(rowCount: number, form: PointedRowForm) {
  const circuit = new Circuit(1 + rowCount)
  const pointerY = circuit.source(0)
  circuit.assumeRange(pointerY, -positionLimit, positionLimit)
  circuit.assumeGrid(pointerY, 1 / 64)
  const rowBottoms = Array.from({length: rowCount}, (_, row) => circuit.source(1 + row))
  for (const bottom of rowBottoms) {
    circuit.assumeRange(bottom, 0, positionLimit)
    circuit.assumeGrid(bottom, 1 / 4)
  }
  const zero = circuit.affine([], 0)
  const rowTops = [zero, ...rowBottoms.slice(0, -1)]
  // [pointerY >= 0]: the pointer is at or below the first row's top.
  const belowStart = emitCompare(circuit, pointerY, '>=', zero)

  let rowAbove: Wire[] = []
  let pointedRow: Wire
  let isPointedRow: Wire[]
  let onRows: Wire
  if (form === 'count') {
    // rowAbove[row] = [rowBottom[row] <= pointerY], one integer bit per row, all in the same 2 layers.
    rowAbove = rowBottoms.map(bottom => emitCompare(circuit, bottom, '<=', pointerY))
    // The pointed row is the number of 1s. A sum of exact bits is exact in any order.
    pointedRow = circuit.roundAffine(rowAbove.map(bit => [bit, 1] as const))
    // The previous row's bit minus this row's bit, with belowStart before row 0: 1 only where the run
    // of 1s ends, because monotone bits never go from 0 back to 1.
    isPointedRow = rowAbove.map((bit, row) => circuit.roundAffine([[row === 0 ? belowStart : rowAbove[row - 1]!, 1], [bit, -1]]))
    // All zeros when the pointer is above the first row, or at or below the last row's bottom.
    circuit.assumeOneHot(isPointedRow, true)
    onRows = circuit.roundAffine([[belowStart, 1], [rowAbove[rowCount - 1]!, -1]])
  } else {
    // The search as a tree instead: the first row whose bottom is below the pointer, gated by
    // belowStart. emitFirstActive declares the one-hot group itself, since every candidate and the
    // gate are emitCompare bits.
    const rowBelow = rowBottoms.map(bottom => emitCompare(circuit, bottom, '>', pointerY))
    isPointedRow = emitFirstActive(circuit, belowStart, rowBelow)
    pointedRow = circuit.roundAffine(isPointedRow.map((bit, row) => [bit, row] as const))
    onRows = circuit.roundAffine(isPointedRow.map(bit => [bit, 1] as const))
  }
  // The pointed row's top, e.g. where a hover highlight goes: a masked sum over the one-hot, which the
  // compiler lowers to one gather.
  const pointedRowTop = circuit.affine(isPointedRow.map((bit, row) => [circuit.multiply(rowTops[row]!, bit), 1] as const))
  return {circuit, pointerY, rowBottoms, belowStart, rowAbove, pointedRow, isPointedRow, onRows, pointedRowTop}
}
