// Row tops, rowTops[r] = heights[0] + ... + heights[r - 1], written three ways. Every form returns
// rowCount + 1 wires: rowTops[0] is 0 and rowTops[rowCount] is the content height.
import {Circuit, type Wire, asWire} from '../../../../../numeric-ui-core.ts'

// The plain JS loop, in FP32 like the circuit. Its accumulation order,
// ((heights[0] + heights[1]) + heights[2]) + ..., is the order the chain and the wide sums keep.
export function rowTopsReference(heights: ArrayLike<number>): Float32Array {
  const rowTops = new Float32Array(heights.length + 1)
  let top = 0
  for (let row = 0; row < heights.length; row++) {
    top = Math.fround(top + heights[row]!)
    rowTops[row + 1] = top
  }
  return rowTops
}

// A chain: each top adds one height to the previous top. rowCount - 1 operations in rowCount - 1
// layers. roundAffine keeps each sum as its own wire. A plain affine would be composed into the
// next sum, which regroups the additions and changes the rounding.
export function emitRowTopsChain(circuit: Circuit, heights: readonly Wire[]): Wire[] {
  const rowTops: Wire[] = [circuit.affine([], 0)]
  for (let row = 0; row < heights.length; row++) {
    rowTops.push(row === 0 ? heights[0]! : circuit.roundAffine([[rowTops[row]!, 1], [heights[row]!, 1]]))
  }
  return rowTops
}

// One wide sum per top, with its terms in loop order. An affine adds its terms one at a time in
// stored order, and roundAffine stores the caller's order, so each sum takes exactly the rounding
// steps of the loop. rowCount - 1 operations in 1 layer, about rowCount²/2 stored weights.
export function emitRowTopsWide(circuit: Circuit, heights: readonly Wire[]): Wire[] {
  const rowTops: Wire[] = [circuit.affine([], 0)]
  for (let row = 0; row < heights.length; row++) {
    rowTops.push(row === 0 ? heights[0]! : circuit.roundAffine(heights.slice(0, row + 1).map(height => [height, 1] as const)))
  }
  return rowTops
}

// A Brent-Kung prefix network. The up-sweep adds neighboring blocks of 1, 2, 4, ... heights, which
// completes the tops after rows 1, 3, 7, 15, ... The down-sweep completes every other top by adding
// one completed top to one block. About 2 rowCount additions in about 2 log2(rowCount) layers.
// Each top groups its additions differently from the loop, so fractional heights can round
// differently in the last bits. Heights on a coarse grid, e.g. quarter pixels, give identical results.
export function emitRowTopsBrentKung(circuit: Circuit, heights: readonly Wire[]): Wire[] {
  const inclusive = [...heights]
  const count = heights.length
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) {
      inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
    }
  }
  for (span /= 4; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) {
      inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
    }
  }
  return [circuit.affine([], 0), ...inclusive]
}

export type RowTopsForm = 'chain' | 'wide' | 'brent-kung'

export function emitRowTops(circuit: Circuit, heights: readonly Wire[], form: RowTopsForm): Wire[] {
  if (form === 'chain') return emitRowTopsChain(circuit, heights)
  if (form === 'wide') return emitRowTopsWide(circuit, heights)
  return emitRowTopsBrentKung(circuit, heights)
}

// A circuit whose source cells are the row heights, for tests and measurements.
export function buildRowTops(rowCount: number, form: RowTopsForm) {
  const circuit = new Circuit(rowCount)
  const heights = Array.from({length: rowCount}, (_, row) => circuit.source(row))
  for (const height of heights) circuit.assumeRange(height, 0, 1024)
  return {circuit, heights, rowTops: emitRowTops(circuit, heights, form)}
}

export type PrefixAddition = {
  layer: number
  // The heights each operand adds up, as [firstRow, lastRow].
  operands: [firstRow: number, lastRow: number][]
  firstRow: number
  lastRow: number
}

// Which heights each addition covers and the layer it runs in, in the order the builder appended
// them. Assumes source cell r holds heights[r], as in buildRowTops. Used to print a small network.
export function describeAdditions(circuit: Circuit): PrefixAddition[] {
  const covered = new Map<Wire, [number, number]>()
  for (let wire = 0; wire < circuit.sourceSize; wire++) covered.set(asWire(wire), [wire, wire])
  const additions: PrefixAddition[] = []
  circuit.operations.forEach((operation, index) => {
    const operands: [number, number][] = []
    for (const [wire] of operation.leftTerms) {
      const range = covered.get(wire)
      if (range !== undefined) operands.push(range)
    }
    if (operands.length === 0) return
    const firstRow = Math.min(...operands.map(([first]) => first))
    const lastRow = Math.max(...operands.map(([, last]) => last))
    covered.set(asWire(circuit.sourceSize + index), [firstRow, lastRow])
    additions.push({layer: operation.depth, operands, firstRow, lastRow})
  })
  return additions
}
