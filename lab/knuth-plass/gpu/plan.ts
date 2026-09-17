// Plain JavaScript around the GPU tree, shared by the page, the Bun scripts and the tests:
// - gpuPlan: Brent-Kung's network over a paragraph's W × W min-plus matrices, as slots and one list of combines per level.
// - writeLineCosts, writePositions: what JavaScript uploads per evaluation, for many paragraphs at once.
// - runPlanInJavaScript: the kernels' arithmetic in JavaScript, for checking a plan without a GPU.
// - knuthPlassTyped: a faster plain JavaScript loop than reference.ts's knuthPlass, over typed arrays.
//
// The GPU stores every entry as a u32 and clamps every product at noPath = 2^30, where reference.ts's product tree clamps
// at infeasible = 2^22 in float64. An entry of noPath stands for no path, e.g. a line that would start before break point
// 0. Every sum of two entries is at most 2^31, so u32 arithmetic is exact whatever the grouping. A paragraph of n break
// points has a path of one-box lines between any two break points, of at most n × lineCostCap, so every entry that has a
// path stays below noPath while n × lineCostCap < 2^30, i.e. up to largestGpuBreakCount = 270,532 break points, and the
// costs and pointers equal reference.ts's knuthPlass. That's far past the programs' 1,056, which comes from FP32 sums.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix} from '../../../src/runtime/prefix-networks.ts'
import {type Paragraph, infeasible, lineCostCap, slackLimit, timingParagraph} from '../paragraph.ts'
import {lineCost} from '../reference.ts'

export const noPath = 2 ** 30
export const largestGpuBreakCount = Math.floor((noPath - 1) / lineCostCap)

// How a kernel multiplies two blocks of break points:
// - 'full': every entry of both W × W matrices, W³ sums per product, like minPlusProduct in reference.ts.
// - 'dense-rows': only the rows that hold costs. A block of B break points, B < W, has B such rows, and each row r >= B
//   holds 0 at column r - B and noPath elsewhere, which only moves a cost B places down. So a product computes
//   min(B_later, W) rows × W columns × (min(B_earlier, W) + 1) sums, and never stores or reads the other rows, e.g. a
//   leaf stores only row 0, its line costs. docs: README.md, "The min-plus tree on the GPU".
export type Kernel = 'full' | 'dense-rows'

// Matrix slots, per paragraph: slot i, for i = 0..n - 1, is the leaf M[i + 1], and slots n..n + productSlots - 1 hold the
// results of matrix products. Vector slot i holds the state s[i + 1]. Vector slot 0 is s[1], which a first dispatch copies
// from M[1], and every other vector slot is the result of one product of a matrix with a vector.
// A level's matrix products are [later slot, earlier slot, result slot, later break count, earlier break count] in
// matrixTriples, and its products of a matrix with a vector are [later matrix slot, earlier vector slot, result vector
// slot, later break count] in vectorTriples, from offset to offset + count. A combine reads only slots written by earlier
// levels, so one dispatch per kind runs all of a level's combines, for every paragraph of a batch.
export type GpuLevel = {matrixOffset: number, matrixCount: number, vectorOffset: number, vectorCount: number}
export type GpuPlan = {breaks: number, productSlots: number, levels: GpuLevel[], matrixTriples: Uint32Array, vectorTriples: Uint32Array}
export const matrixTripleSize = 5
export const vectorTripleSize = 4

export function gpuPlan(breaks: number): GpuPlan {
  invariant(Number.isInteger(breaks) && breaks >= 1 && breaks <= largestGpuBreakCount, `breaks must be within 1..${largestGpuBreakCount}, got ${breaks}`)
  type Block = {kind: 'vector' | 'matrix', slot: number, end: number, breakCount: number, depth: number}
  type Combine = {earlier: Block, later: Block, result: Block}
  const items = Array.from({length: breaks}, (_, index): Block => ({kind: index === 0 ? 'vector' : 'matrix', slot: index, end: index, breakCount: 1, depth: 0}))
  const combines: Combine[] = []
  let productSlots = 0
  // A combine runs at the level after its inputs' levels, which gives Brent-Kung's longest chain as the level count.
  const prefixes = brentKungPrefix(items, (earlier, later) => {
    invariant(later.kind === 'matrix', 'a vector can only be the earlier block')
    const shape = {end: later.end, breakCount: earlier.breakCount + later.breakCount, depth: Math.max(earlier.depth, later.depth) + 1}
    const result: Block = earlier.kind === 'vector' ? {kind: 'vector', slot: later.end, ...shape} : {kind: 'matrix', slot: breaks + productSlots++, ...shape}
    combines.push({earlier, later, result})
    return result
  })
  prefixes.forEach((prefix, index) => invariant(prefix.kind === 'vector' && prefix.slot === index && prefix.breakCount === index + 1, `prefix ${index} is the state after break point ${index + 1}`))
  // A loop rather than Math.max(...combines), since V8 throws a RangeError when a call spreads the 2n combines of a
  // paragraph past about 50,000 break points.
  let depth = 0
  for (const {result} of combines) depth = Math.max(depth, result.depth)
  const matrixTriples: number[] = []
  const vectorTriples: number[] = []
  const levels: GpuLevel[] = []
  for (let level = 1; level <= depth; level++) {
    const matrixOffset = matrixTriples.length / matrixTripleSize
    const vectorOffset = vectorTriples.length / vectorTripleSize
    for (const {earlier, later, result} of combines.filter(combine => combine.result.depth === level)) {
      if (result.kind === 'vector') vectorTriples.push(later.slot, earlier.slot, result.slot, later.breakCount)
      else matrixTriples.push(later.slot, earlier.slot, result.slot, later.breakCount, earlier.breakCount)
    }
    levels.push({matrixOffset, matrixCount: matrixTriples.length / matrixTripleSize - matrixOffset, vectorOffset, vectorCount: vectorTriples.length / vectorTripleSize - vectorOffset})
  }
  invariant(vectorTriples.length / vectorTripleSize === breaks - 1, 'every state but s[1] is the result of one product with a vector')
  return {breaks, productSlots, levels, matrixTriples: Uint32Array.from(matrixTriples), vectorTriples: Uint32Array.from(vectorTriples)}
}

// JS: lineCosts[(p × n + to - 1) × W + m] = lineCost(paragraph p, to - 1 - m, to, widths[p]), or noPath where
// to - 1 - m < 0, i.e. row 0 of every leaf M[to]. Every paragraph has n break points.
export function writeLineCosts(paragraphs: readonly Paragraph[], widths: ArrayLike<number>, window: number, lineCosts: Uint32Array) {
  const breaks = paragraphs[0]!.lineEnds.length
  invariant(lineCosts.length === paragraphs.length * breaks * window, 'lineCosts holds W costs per break point per paragraph')
  paragraphs.forEach(({lineStarts, lineEnds}, paragraph) => {
    invariant(lineEnds.length === breaks, 'every paragraph of a batch has the same break count')
    const width = widths[paragraph]!
    for (let to = 1; to <= breaks; to++) {
      const end = lineEnds[to - 1]!
      const row = (paragraph * breaks + to - 1) * window
      for (let m = 0; m < window; m++) {
        const from = to - 1 - m
        if (from < 0) {
          lineCosts[row + m] = noPath
          continue
        }
        const slack = width - (end - lineStarts[from]!)
        lineCosts[row + m] = slack < 0 ? (m === 0 ? lineCostCap : infeasible) : to === breaks ? 0 : Math.min(slack, slackLimit) ** 2
      }
    }
  })
}

// JS: positions[p × 2n + i] = lineStarts[i] and positions[p × 2n + n + i] = lineEnds[i], for i = 0..n - 1.
export function writePositions(paragraphs: readonly Paragraph[], positions: Int32Array) {
  const breaks = paragraphs[0]!.lineEnds.length
  invariant(positions.length === paragraphs.length * 2 * breaks, 'positions holds 2n values per paragraph')
  paragraphs.forEach(({lineStarts, lineEnds}, paragraph) => {
    const base = paragraph * 2 * breaks
    for (let index = 0; index < breaks; index++) {
      positions[base + index] = lineStarts[index]!
      positions[base + breaks + index] = lineEnds[index]!
    }
  })
}

// The kernels' arithmetic, with the GPU's buffer layout: every paragraph's leaves first, then every paragraph's products.
// Entries that no dispatch writes hold `unwritten`, so a test can show that the 'dense-rows' kernel never reads them.
// Returns out, P × (n + 1) values of [total cost, pointer of break point 1, ..., pointer of break point n] per paragraph,
// what the GPU reads back, and states, P × n × W values of s[1..n], which the page reads back only in its check mode.
export function runPlanInJavaScript(plan: GpuPlan, kernel: Kernel, window: number, paragraphCount: number, lineCosts: Uint32Array, unwritten = 0) {
  const {breaks, productSlots, levels, matrixTriples, vectorTriples} = plan
  const area = window * window
  const matrices = new Uint32Array(paragraphCount * (breaks + productSlots) * area).fill(unwritten)
  const vectors = new Uint32Array(paragraphCount * breaks * window).fill(unwritten)
  const out = new Uint32Array(paragraphCount * (breaks + 1))
  const slotStart = (paragraph: number, slot: number) => (slot < breaks ? paragraph * breaks + slot : paragraphCount * breaks + paragraph * productSlots + slot - breaks) * area
  for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
    // The leaves: row 0 from the line costs, and for the full kernel, rows r >= 1 with 0 at column r - 1.
    for (let slot = 0; slot < breaks; slot++) {
      const start = slotStart(paragraph, slot)
      matrices.set(lineCosts.subarray((paragraph * breaks + slot) * window, (paragraph * breaks + slot + 1) * window), start)
      if (kernel === 'full') for (let row = 1; row < window; row++) for (let column = 0; column < window; column++) matrices[start + row * window + column] = column === row - 1 ? 0 : noPath
    }
    // s[1] = M[1] ⊗ s[0] = [lineCost(0, 1), 0, noPath, ...]
    const first = paragraph * breaks * window
    for (let row = 0; row < window; row++) vectors[first + row] = row === 0 ? matrices[slotStart(paragraph, 0)]! : row === 1 ? 0 : noPath
  }
  for (const {matrixOffset, matrixCount, vectorOffset, vectorCount} of levels) {
    for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
      for (let combine = matrixOffset; combine < matrixOffset + matrixCount; combine++) {
        const triple = combine * matrixTripleSize
        const later = slotStart(paragraph, matrixTriples[triple]!)
        const earlier = slotStart(paragraph, matrixTriples[triple + 1]!)
        const result = slotStart(paragraph, matrixTriples[triple + 2]!)
        const laterBreaks = matrixTriples[triple + 3]!
        const earlierBreaks = matrixTriples[triple + 4]!
        for (let row = 0; row < window; row++) {
          if (kernel === 'full') {
            for (let column = 0; column < window; column++) {
              let best = noPath
              for (let middle = 0; middle < window; middle++) best = Math.min(best, matrices[later + row * window + middle]! + matrices[earlier + middle * window + column]!)
              matrices[result + row * window + column] = best
            }
          } else if (row >= laterBreaks + earlierBreaks) {
            // A row that only moves costs, which isn't stored.
          } else if (row >= laterBreaks) {
            for (let column = 0; column < window; column++) matrices[result + row * window + column] = matrices[earlier + (row - laterBreaks) * window + column]!
          } else {
            const middleRows = Math.min(earlierBreaks, window)
            for (let column = 0; column < window; column++) {
              // The earlier block's rows m >= earlierBreaks hold 0 only at column m - earlierBreaks.
              let best = column + earlierBreaks < window ? matrices[later + row * window + column + earlierBreaks]! : noPath
              for (let middle = 0; middle < middleRows; middle++) best = Math.min(best, matrices[later + row * window + middle]! + matrices[earlier + middle * window + column]!)
              matrices[result + row * window + column] = best
            }
          }
        }
      }
      for (let combine = vectorOffset; combine < vectorOffset + vectorCount; combine++) {
        const triple = combine * vectorTripleSize
        const later = slotStart(paragraph, vectorTriples[triple]!)
        const earlier = (paragraph * breaks + vectorTriples[triple + 1]!) * window
        const result = (paragraph * breaks + vectorTriples[triple + 2]!) * window
        const laterBreaks = vectorTriples[triple + 3]!
        for (let row = 0; row < window; row++) {
          if (kernel === 'dense-rows' && row >= laterBreaks) {
            vectors[result + row] = vectors[earlier + row - laterBreaks]!
            continue
          }
          let best = noPath
          for (let middle = 0; middle < window; middle++) best = Math.min(best, matrices[later + row * window + middle]! + vectors[earlier + middle]!)
          vectors[result + row] = best
        }
      }
    }
  }
  // The pointers: for break point `to`, the smallest boxes = 1..W of the smallest s[to - 1][boxes - 1] + M[to][0][boxes - 1].
  // A candidate that starts before break point 0 sums two noPath entries, 2^31, above every total that has a path.
  for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
    const base = paragraph * (breaks + 1)
    out[base] = vectors[(paragraph * breaks + breaks - 1) * window]!
    out[base + 1] = 0
    for (let to = 2; to <= breaks; to++) {
      const state = (paragraph * breaks + to - 2) * window
      const leaf = slotStart(paragraph, to - 1)
      let best = 2 ** 32
      let pointer = to - 1
      for (let boxes = 1; boxes <= window; boxes++) {
        const total = vectors[state + boxes - 1]! + matrices[leaf + boxes - 1]!
        if (total < best) {
          best = total
          pointer = to - boxes
        }
      }
      out[base + to] = pointer
    }
  }
  return {out, states: vectors}
}

// The breaks of paragraph p from what the GPU reads back, like reference.ts's backtrack.
export function breaksOf(out: Uint32Array, paragraph: number, breaks: number): number[] {
  const base = paragraph * (breaks + 1)
  const result: number[] = []
  for (let at = breaks; at > 0; at = out[base + at]!) result.push(at)
  return result.reverse()
}

// Writes every paragraph's breaks into breakPoints, and each paragraph's line count into lineCounts, from out. Returns
// how many values it wrote. The page times this as part of an evaluation.
export function backtrackAll(out: Uint32Array, paragraphCount: number, breaks: number, breakPoints: Int32Array, lineCounts: Int32Array) {
  let written = 0
  for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
    const base = paragraph * (breaks + 1)
    let lines = 0
    for (let at = breaks; at > 0; at = out[base + at]!) breakPoints[written + lines++] = at
    lineCounts[paragraph] = lines
    written += lines
  }
  return written
}

// The expected readback of one paragraph from reference.ts's Solution: the total cost, then predecessors[1..n].
export const expectedOut = (costs: readonly number[], predecessors: readonly number[]) => [costs.at(-1)!, ...predecessors.slice(1)]

// The expected states s[1..n] of one paragraph: s[to][k] = cost[to - k], or noPath where to - k < 0.
export function expectedStates(costs: readonly number[], window: number): Uint32Array {
  const breaks = costs.length - 1
  const states = new Uint32Array(breaks * window)
  for (let to = 1; to <= breaks; to++) for (let k = 0; k < window; k++) states[(to - 1) * window + k] = to - k >= 0 ? costs[to - k]! : noPath
  return states
}

// Whether some step has two starts with the smallest total.
export function hasTie(paragraph: Paragraph, maxWidth: number, window: number, costs: readonly number[]) {
  for (let to = 1; to < costs.length; to++) {
    let equal = 0
    for (let boxes = 1; boxes <= Math.min(window, to); boxes++) {
      if (costs[to - boxes]! + lineCost(paragraph, to - boxes, to, maxWidth) === costs[to]) equal++
    }
    if (equal > 1) return true
  }
  return false
}

// The paragraphs of the GPU timings: paragraph p of a batch is timingParagraph(n, n + p), so a batch of 1 is the CPU
// timings' paragraph, timingParagraph(n).
export const batchParagraphs = (breaks: number, count: number) => Array.from({length: count}, (_, index) => timingParagraph(breaks, breaks + index))

// knuthPlassTyped over every paragraph of a batch at one width, writing each total into totals and every paragraph's
// breaks, from the last, into breakPoints. costs and predecessors hold n + 1 values and are reused.
export function layOutTyped(positions: Int32Array, paragraphCount: number, breaks: number, maxWidth: number, window: number, costs: Float64Array, predecessors: Int32Array, breakPoints: Int32Array, totals: Float64Array) {
  let written = 0
  for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
    totals[paragraph] = knuthPlassTyped(positions, paragraph * 2 * breaks, breaks, maxWidth, window, costs, predecessors)
    for (let at = breaks; at > 0; at = predecessors[at]!) breakPoints[written++] = at
  }
  return written
}

// reference.ts's knuthPlass over typed arrays, with the line cost inlined, writing into preallocated arrays: the same W
// candidates per break point, and the same tie rule. positions is writePositions' layout, from `offset`. Writes
// costs[0..n] and predecessors[0..n], and returns the total cost. It doesn't compute windowOverflowCount.
export function knuthPlassTyped(positions: Int32Array, offset: number, breaks: number, maxWidth: number, window: number, costs: Float64Array, predecessors: Int32Array) {
  costs[0] = 0
  predecessors[0] = 0
  for (let to = 1; to <= breaks; to++) {
    const end = positions[offset + breaks + to - 1]!
    const lowest = Math.max(0, to - window)
    let best = Number.POSITIVE_INFINITY
    let predecessor = -1
    for (let from = to - 1; from >= lowest; from--) {
      const slack = maxWidth - (end - positions[offset + from]!)
      const cost = slack < 0 ? (to - from === 1 ? lineCostCap : infeasible) : to === breaks ? 0 : slack < slackLimit ? slack * slack : lineCostCap
      const total = costs[from]! + cost
      if (total < best) {
        best = total
        predecessor = from
      }
    }
    costs[to] = best
    predecessors[to] = predecessor
  }
  return costs[breaks]!
}
