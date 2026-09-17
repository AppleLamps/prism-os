// Running totals of a list, e.g. every row's top from the row heights, built three
// ways over the runtime in src/runtime/: a chain of additions, one wide sum per total, and
// a Brent-Kung network. Every form returns totals[row] = heights[0] + ... + heights[row],
// so rowTops[row + 1] is totals[row], and the last total is the content height.
import {Circuit, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix} from '../../../../../../src/runtime/prefix-networks.ts'

// The loop, with every addition rounded to FP32, as the circuit rounds it.
export function runningTotalsLoop(heights: ArrayLike<number>): number[] {
  const totals: number[] = []
  let total = 0
  for (let row = 0; row < heights.length; row++) {
    total = Math.fround(total + heights[row]!)
    totals.push(total)
  }
  return totals
}

// The Brent-Kung network in plain JS, with every addition rounded to FP32. The tests
// use it to show that the circuit's network only changes the grouping of additions.
export function runningTotalsBrentKungLoop(heights: ArrayLike<number>): number[] {
  return brentKungPrefix(Array.from(heights, height => Math.fround(height)), (earlier, later) => Math.fround(earlier + later))
}

export type RunningTotalsForm = 'chain' | 'wide sums' | 'brent-kung'

export function emitRunningTotals(circuit: Circuit, heights: readonly Wire[], form: RunningTotalsForm): Wire[] {
  if (form === 'chain') {
    // Each total adds one height to the previous total, in the loop's order. roundAffine
    // keeps each total as its own operation. An ordinary affine sum of fewer than 4 terms
    // would be copied into the next total, which regroups the additions.
    const totals: Wire[] = [heights[0]!]
    for (let row = 1; row < heights.length; row++) {
      totals.push(circuit.roundAffine([[totals[row - 1]!, 1], [heights[row]!, 1]]))
    }
    return totals
  }
  if (form === 'wide sums') {
    // One sum per total, with its terms in loop order. An affine sum adds its terms one
    // at a time in stored order, and roundAffine stores the caller's order, so each total
    // takes the loop's rounding steps. No total reads another.
    return heights.map((height, row) =>
      row === 0 ? height : circuit.roundAffine(heights.slice(0, row + 1).map(wire => [wire, 1] as const)))
  }
  // Pairs of heights, then pairs of pairs, then the totals in between.
  return brentKungPrefix(heights, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]))
}

// Declared height range: large enough for the tests' totals past 2^24.
export const heightLimit = 2 ** 25

// A circuit whose source cells are the row heights.
export function buildRunningTotals(rowCount: number, form: RunningTotalsForm) {
  const circuit = new Circuit(rowCount)
  const heights = Array.from({length: rowCount}, (_, row) => circuit.source(row))
  for (const height of heights) circuit.assumeRange(height, 0, heightLimit)
  return {circuit, heights, totals: emitRunningTotals(circuit, heights, form)}
}
