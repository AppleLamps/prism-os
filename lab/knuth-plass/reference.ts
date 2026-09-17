// The plain JavaScript references: dynamic programming over break points, and the same costs as products of W × W
// min-plus matrices, the form the tree program and the GPU step compute.
import {brentKungPrefix} from '../../src/runtime/prefix-networks.ts'
import {type Paragraph, infeasible, lineCostCap, naturalWidth, slackLimit} from './paragraph.ts'

export function lineCost(paragraph: Paragraph, from: number, to: number, maxWidth: number): number {
  const slack = maxWidth - naturalWidth(paragraph, from, to)
  if (slack < 0) return to - from === 1 ? lineCostCap : infeasible
  if (to === paragraph.lineEnds.length) return 0
  return Math.min(slack, slackLimit) ** 2
}

export type Solution = {
  // costs[to]: the smallest total cost of lines from break point 0 to break point `to`
  costs: number[]
  // predecessors[to]: the start of the last line of that best path, and 0 for break point 0
  predecessors: number[]
  // The chosen break points in increasing order, from the first line's end to break point n
  breaks: number[]
  totalCost: number
  // How many break points `to` have a line of window + 1 boxes ending there that fits, i.e. a line the programs don't
  // consider because the window is too small
  windowOverflowCount: number
}

// cost[to] = min over from of cost[from] + lineCost(from, to), for lines of at most `window` boxes. The loop tries the
// shortest line first and keeps a later candidate only when it costs strictly less, so of equal totals the latest start
// wins, like pretext's demo, which tries from = to - 1 down to 0 and replaces with `<`.
export function knuthPlass(paragraph: Paragraph, maxWidth: number, window: number): Solution {
  const breakCount = paragraph.lineEnds.length
  const costs = [0]
  const predecessors = [0]
  for (let to = 1; to <= breakCount; to++) {
    let best = Number.POSITIVE_INFINITY
    let predecessor = -1
    for (let boxes = 1; boxes <= Math.min(window, to); boxes++) {
      const from = to - boxes
      const total = costs[from]! + lineCost(paragraph, from, to, maxWidth)
      if (total < best) {
        best = total
        predecessor = from
      }
    }
    costs.push(best)
    predecessors.push(predecessor)
  }
  return {costs, predecessors, breaks: backtrack(predecessors, breakCount), totalCost: costs[breakCount]!, windowOverflowCount: windowOverflowCount(paragraph, maxWidth, window)}
}

export function backtrack(predecessors: readonly number[], breakCount: number) {
  const breaks: number[] = []
  for (let at = breakCount; at > 0; at = predecessors[at]!) breaks.push(at)
  return breaks.reverse()
}

export function windowOverflowCount(paragraph: Paragraph, maxWidth: number, window: number) {
  let count = 0
  for (let to = window + 1; to <= paragraph.lineEnds.length; to++) {
    if (naturalWidth(paragraph, to - window - 1, to) <= maxWidth) count++
  }
  return count
}

// The costs as min-plus matrix products. The state after break point `to` is the vector of the last W costs,
// s[to] = [cost[to], cost[to - 1], ..., cost[to - W + 1]], with `infeasible` for positions before 0, and one step is
// s[to] = M[to] ⊗ s[to - 1], where (A ⊗ v)[r] = min(infeasible, min over m of A[r][m] + v[m]):
// - row 0 of M[to]: M[to][0][m] = lineCost(to - 1 - m, to), or infeasible when to - 1 - m < 0
// - row r >= 1: M[to][r][r - 1] = 0, and infeasible elsewhere, which moves every cost one place down
// Clamping every sum at `infeasible` keeps the product associative, so any grouping of the matrices gives the same
// states, and every entry stays within 0..infeasible, where sums of two entries are exact in FP32.
export function leafMatrices(paragraph: Paragraph, maxWidth: number, window: number): Float64Array {
  const breakCount = paragraph.lineEnds.length
  const leaves = new Float64Array(breakCount * window * window).fill(infeasible)
  for (let to = 1; to <= breakCount; to++) {
    const offset = (to - 1) * window * window
    for (let m = 0; m < window && to - 1 - m >= 0; m++) leaves[offset + m] = lineCost(paragraph, to - 1 - m, to, maxWidth)
    for (let r = 1; r < window; r++) leaves[offset + r * window + r - 1] = 0
  }
  return leaves
}

export const initialState = (window: number) => Float64Array.from({length: window}, (_, index) => index === 0 ? 0 : infeasible)

// (later ⊗ earlier)[r][c] = min(infeasible, min over m of later[r][m] + earlier[m][c]), for W × W matrices in row order.
export function minPlusProduct(later: Float64Array, earlier: Float64Array, window: number) {
  const product = new Float64Array(window * window)
  for (let r = 0; r < window; r++) {
    for (let c = 0; c < window; c++) {
      let best = infeasible
      for (let m = 0; m < window; m++) best = Math.min(best, later[r * window + m]! + earlier[m * window + c]!)
      product[r * window + c] = best
    }
  }
  return product
}

export function minPlusApply(matrix: Float64Array, vector: Float64Array, window: number) {
  const result = new Float64Array(window)
  for (let r = 0; r < window; r++) {
    let best = infeasible
    for (let m = 0; m < window; m++) best = Math.min(best, matrix[r * window + m]! + vector[m]!)
    result[r] = best
  }
  return result
}

// Every state s[1..n] from the leaves, with Brent-Kung's network like the tree program: item 0 is M[1] ⊗ s[0], a vector,
// so every prefix is a vector, and the other combines are matrix products.
export function statesByProductTree(leaves: Float64Array, breakCount: number, window: number): Float64Array[] {
  const size = window * window
  type Item = {vector: Float64Array} | {matrix: Float64Array}
  const items: Item[] = Array.from({length: breakCount}, (_, index) => {
    const matrix = leaves.subarray(index * size, (index + 1) * size)
    return index === 0 ? {vector: minPlusApply(matrix, initialState(window), window)} : {matrix}
  })
  const prefixes = brentKungPrefix(items, (earlier, later) => {
    if (!('matrix' in later)) throw new Error('a vector can only be the earlier block')
    return 'vector' in earlier
      ? {vector: minPlusApply(later.matrix, earlier.vector, window)}
      : {matrix: minPlusProduct(later.matrix, earlier.matrix, window)}
  })
  return prefixes.map(prefix => {
    if (!('vector' in prefix)) throw new Error('every prefix is a vector')
    return prefix.vector
  })
}
