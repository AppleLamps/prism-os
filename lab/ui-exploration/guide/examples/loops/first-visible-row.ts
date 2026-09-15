// The first visible row of a virtualized list with variable row heights, found by counting.
//
// JS:  let firstVisibleRow = 0
//      while (firstVisibleRow < rowCount && rowBottoms[firstVisibleRow] <= scrollTop) firstVisibleRow++
//
// Host contract: scrollTop and row heights are multiples of 1/4 px, heights are in 0..1024 px,
// scrollTop is in 0..2^20 px, and the content height stays below 2^20 px.
import {Circuit, invariant, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitIntegerAtLeastZero} from './kit.ts'
import {emitRowTopsBrentKung} from './row-tops.ts'

export function firstVisibleRowReference(heights: ArrayLike<number>, scrollTop: number, slotCount: number) {
  const rowCount = heights.length
  const rowTops = [0]
  for (let row = 0; row < rowCount; row++) rowTops.push(rowTops[row]! + heights[row]!)
  let firstVisibleRow = 0
  while (firstVisibleRow < rowCount && rowTops[firstVisibleRow + 1]! <= scrollTop) firstVisibleRow++
  // Slot k of the DOM shows row firstVisibleRow + k.
  const slotTops = Array.from({length: slotCount}, (_, slot) => rowTops[Math.min(firstVisibleRow + slot, rowCount)]!)
  return {firstVisibleRow, slotTops}
}

// Source layout: cell 0 is scrollTop, cells 1..rowCount are row heights.
export function buildFirstVisibleRow(rowCount: number, slotCount: number) {
  invariant(rowCount >= 1, 'a list needs at least one row')
  const circuit = new Circuit(1 + rowCount)
  const scrollTop = 0
  const heights = Array.from({length: rowCount}, (_, row) => 1 + row)
  circuit.assumeRange(scrollTop, 0, 2 ** 20)
  for (const height of heights) circuit.assumeRange(height, 0, 1024)
  const rowTops = emitRowTopsBrentKung(circuit, heights)

  // aboveViewport[r] = [rowBottom[r] <= scrollTop]. On the quarter-pixel grid,
  // 4 * (scrollTop - rowBottom[r]) is an integer, so the comparison is an exact integer bit.
  const aboveViewport = Array.from({length: rowCount}, (_, row) =>
    emitIntegerAtLeastZero(circuit, [[scrollTop, 4], [rowTops[row + 1]!, -4]], 0))

  // Bottoms never decrease, so these bits read 1...1 0...0 along the rows. The loop stops at the
  // first 0, and the index of the first 0 is the number of 1s.
  const firstVisibleRow = circuit.affine(aboveViewport.map(bit => [bit, 1] as const))

  // isFirstVisible[r] = aboveViewport[r - 1] - aboveViewport[r], with aboveViewport[-1] = 1 and
  // aboveViewport[rowCount] = 0. In a run 1...1 0...0 this difference is 1 only where the run of 1s
  // ends. Position rowCount means every row is above the viewport.
  const isFirstVisible = Array.from({length: rowCount + 1}, (_, row) => {
    if (row === rowCount) return aboveViewport[rowCount - 1]!
    const previous: [Wire, number][] = row === 0 ? [] : [[aboveViewport[row - 1]!, 1]]
    const member = circuit.roundAffine([...previous, [aboveViewport[row]!, -1]], row === 0 ? 1 : 0)
    circuit.assumeRange(member, 0, 1)
    return member
  })
  // Declares the one-hot to the compiler, which is true because the bits are sorted.
  // validateOneHotGroups checks the declaration in tests.
  circuit.assumeOneHot(isFirstVisible)

  // Slot k shows row firstVisibleRow + k. Its top is a masked sum over the one-hot, which the
  // compiler lowers to one indexed read per slot.
  const slotTops = Array.from({length: slotCount}, (_, slot) => circuit.affine(
    isFirstVisible.map((member, row) => [circuit.multiply(rowTops[Math.min(row + slot, rowCount)]!, member), 1] as const),
  ))
  return {circuit, scrollTop, heights, rowTops, aboveViewport, firstVisibleRow, isFirstVisible, slotTops}
}
