// Threshold counts instead of floor and division. A responsive grid's column count is 1 plus how many of 6 fixed
// widths the container reaches, and each item's row and column are sums over the column count's one-hot, with
// floor(item / c) and item % c computed for every possible c while building.
//
// Host contract: the container width is a whole number of pixels within 0..16,384.
import {Circuit, emitCompare, type Wire} from '../../../../../../numeric-ui-core.ts'

export const boxesGapX = 24
export const boxMinSizeX = 220
export const maximumColumns = 7

// columnCount >= c exactly when containerWidth - 24 >= 244 c, so for c = 2..7 the thresholds are 512, 756,
// 1,000, 1,244, 1,488 and 1,732 px.
export const columnThresholds = Array.from(
  {length: maximumColumns - 1},
  (_, index) => boxesGapX + (boxMinSizeX + boxesGapX) * (index + 2),
)

// JS, from chenglou.github.io's photo gallery (index.ts, colsBoxMaxSizeXF), then per item.
export function columnLayoutReference(containerWidth: number, itemCount: number) {
  const columnCount = Math.min(Math.max(1, Math.floor((containerWidth - boxesGapX) / (boxMinSizeX + boxesGapX))), maximumColumns)
  const rows = Array.from({length: itemCount}, (_, item) => Math.floor(item / columnCount))
  const columns = Array.from({length: itemCount}, (_, item) => item % columnCount)
  return {columnCount, rows, columns}
}

// Source table: [containerWidth].
export function buildColumnLayout(itemCount: number) {
  const circuit = new Circuit(1)
  const containerWidth = circuit.source(0)
  circuit.assumeRange(containerWidth, 0, 16_384)
  circuit.assumeGrid(containerWidth, 1)

  // [containerWidth >= threshold] for every threshold, all in the same layers, as an integer bit on the whole-pixel grid.
  const reached = columnThresholds.map(threshold => emitCompare(circuit, containerWidth, '>=', circuit.affine([], threshold)))
  // The clamp to 1..7 costs nothing: the count starts at 1, and there are only 6 thresholds.
  const columnCount = circuit.affine(reached.map(bit => [bit, 1] as const), 1)

  // hasColumns[c - 1] = [columnCount == c] = [columnCount >= c] - [columnCount >= c + 1]. The threshold bits never
  // go from 0 back to 1 as c grows, so each difference is 0 or 1, and exactly one of them is 1.
  const hasColumns = Array.from({length: maximumColumns}, (_, index) => {
    if (index === maximumColumns - 1) return reached[index - 1]!
    const terms: [Wire, number][] = index === 0 ? [[reached[0]!, -1]] : [[reached[index - 1]!, 1], [reached[index]!, -1]]
    const bit = circuit.roundAffine(terms, index === 0 ? 1 : 0)
    circuit.assumeRange(bit, 0, 1)
    return bit
  })
  circuit.assumeOneHot(hasColumns)

  // For each possible column count c, floor(item / c) and item % c are numbers known while building, so an
  // item's row and column are each one sum over the 7 bits, with no division at runtime.
  const rows = Array.from({length: itemCount}, (_, item) =>
    circuit.affine(hasColumns.map((bit, index) => [bit, Math.floor(item / (index + 1))] as const)))
  const columns = Array.from({length: itemCount}, (_, item) =>
    circuit.affine(hasColumns.map((bit, index) => [bit, item % (index + 1)] as const)))
  return {circuit, containerWidth, reached, columnCount, hasColumns, rows, columns}
}
