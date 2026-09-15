// A responsive column count, and each item's row and column, without floor or division.
//
// JS, from chenglou.github.io's photo gallery (index.ts, colsBoxMaxSizeXF):
//   const cols = clamp(1, Math.floor((containerSizeX - boxesGapX) / (boxMinSizeX + boxesGapX)), 7)
// and then, per photo, Math.floor(item / cols) and item % cols.
//
// Host contract: the container width is a whole number of pixels in 0..16,384.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitIntegerAtLeastZero} from './kit.ts'

export const boxesGapX = 24
export const boxMinSizeX = 220
export const maximumColumns = 7

export function columnLayoutReference(containerWidth: number, itemCount: number) {
  const columnCount = Math.min(Math.max(1, Math.floor((containerWidth - boxesGapX) / (boxMinSizeX + boxesGapX))), maximumColumns)
  const rows = Array.from({length: itemCount}, (_, item) => Math.floor(item / columnCount))
  const columns = Array.from({length: itemCount}, (_, item) => item % columnCount)
  return {columnCount, rows, columns}
}

// Source layout: cell 0 is the container width.
export function buildColumnLayout(itemCount: number) {
  const circuit = new Circuit(1)
  const containerWidth = 0
  circuit.assumeRange(containerWidth, 0, 16_384)

  // For x >= 0, floor(x / d) is how many multiples of d fit at or below x. So
  // floor((width - 24) / 244) >= c exactly when width - 24 - 244 c >= 0, an integer comparison.
  // atLeastColumns[c] = [columnCount >= c], which the clamp fixes at 1 for c = 1 and 0 for c = 8.
  const one = circuit.affine([], 1)
  const zero = circuit.affine([], 0)
  const atLeastColumns: Wire[] = [zero, one]
  for (let columns = 2; columns <= maximumColumns; columns++) {
    atLeastColumns.push(emitIntegerAtLeastZero(circuit, [[containerWidth, 1]], -(boxesGapX + (boxMinSizeX + boxesGapX) * columns)))
  }
  atLeastColumns.push(zero)
  // The column count is 1 plus how many thresholds the width reaches.
  const columnCount = circuit.affine(atLeastColumns.slice(2, maximumColumns + 1).map(bit => [bit, 1] as const), 1)

  // hasColumns[c - 1] = [columnCount == c] = atLeastColumns[c] - atLeastColumns[c + 1].
  const hasColumns = Array.from({length: maximumColumns}, (_, index) => {
    const columns = index + 1
    const bit = circuit.roundAffine([[atLeastColumns[columns]!, 1], [atLeastColumns[columns + 1]!, -1]])
    circuit.assumeRange(bit, 0, 1)
    return bit
  })
  circuit.assumeOneHot(hasColumns)

  // For each possible column count c, floor(item / c) and item % c are build-time constants, so an
  // item's row and column are each one affine over the 7 bits, with no division at runtime.
  const rows = Array.from({length: itemCount}, (_, item) =>
    circuit.affine(hasColumns.map((bit, index) => [bit, Math.floor(item / (index + 1))] as const)))
  const columns = Array.from({length: itemCount}, (_, item) =>
    circuit.affine(hasColumns.map((bit, index) => [bit, item % (index + 1)] as const)))
  return {circuit, containerWidth, columnCount, hasColumns, rows, columns}
}
