// Knuth-Plass line breaking as a program, in two forms that give the same costs and breaks:
// - 'chain': one step per break point, cost[to] = min over the last W starts of cost[from] + lineCost(from, to). Each
//   step reads the costs of earlier steps, so the program is about 2 log2 W layers per break point deep.
// - 'tree': each step as a W × W min-plus matrix (reference.ts's leafMatrices), combined with Brent-Kung's prefix network
//   from src/runtime/prefix-networks.ts, so every state s[to] = [cost[to], ..., cost[to - W + 1]] comes out of about
//   2 log2 n combines. One more step per break point, in the same layers for every break point, picks the argmin.
// Both forms then follow the argmin pointers by doubling (docs/patterns.md, "Following links one at a time") to mark the
// chosen break points.
//
// Every value is an integer: positions and widths in whole pixels, costs within 0..infeasible, pointers within 0..n. The
// minimum of two costs is left - relu(left - right), and the test checks that no sum of any operation can pass 2^24
// under the declared ranges, so FP32 computes every value exactly.
import {type Terms, type Wire, invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type WireValues, createEvaluator, createSourceTable, input, inputBit, list, oneHot} from '../../src/runtime/cells.ts'
import {brentKungPrefix} from '../../src/runtime/prefix-networks.ts'
import {type Paragraph, checkParagraph, infeasible, largestBreakCapacity, lineCostCap, maxWidthLimit, positionLimit, slackLimit} from './paragraph.ts'
import type {Solution} from './reference.ts'

export type ProgramForm = 'chain' | 'tree'

// breakCapacity: the most break points of a paragraph, n. window: the most boxes on a line, W.
export type Capacity = {breakCapacity: number, window: number}

// A paragraph of n break points is written into the first n cells of each list. Past it, lineStarts hold 0 and lineEnds
// positionLimit, so every line that reaches past the paragraph overflows. endsParagraph[n - 1] is 1.
export const knuthPlassCells = ({breakCapacity}: Capacity) => ({
  maxWidth: input([0, maxWidthLimit], {grid: 1}),
  // lineStarts[from] for from = 0..n - 1, see paragraph.ts
  lineStarts: list(breakCapacity, () => input([0, positionLimit], {grid: 1})),
  // lineEnds[to - 1] for to = 1..n
  lineEnds: list(breakCapacity, () => input([0, positionLimit], {grid: 1})),
  endsParagraph: oneHot(list(breakCapacity, index => inputBit(index === 0 ? 1 : 0)), {declareToCircuit: false}),
})

// An affine sum that builder code keeps as terms, so that sums of costs are added inside the operations that compare
// them, with `bound`, a static upper bound of its value. Every sum here is at least 0.
type Sum = {terms: Terms, bias: number, bound: number}
type Candidate = {sum: Sum, pointer: Wire | undefined}
// A matrix entry or a vector entry. null is an entry that is infeasible for every input, e.g. a line that would start
// before break point 0, which products skip instead of adding infeasible.
type Entry = Sum | null
type Block = {kind: 'vector', entries: Entry[]} | {kind: 'matrix', rows: Entry[][]}

const zeroSum: Sum = {terms: [], bias: 0, bound: 0}
const addSums = (a: Sum, b: Sum): Sum => ({terms: [...a.terms, ...b.terms], bias: a.bias + b.bias, bound: a.bound + b.bound})

export function buildKnuthPlass(capacity: Capacity, form: ProgramForm) {
  const {breakCapacity, window} = capacity
  invariant(Number.isInteger(breakCapacity) && breakCapacity >= 2 && breakCapacity <= largestBreakCapacity, `breakCapacity must be within 2..${largestBreakCapacity}, got ${breakCapacity}`)
  invariant(Number.isInteger(window) && window >= 2, `window must be at least 2, got ${window}`)
  const table = createSourceTable()
  const cells = table.declare(knuthPlassCells(capacity))
  const circuit = table.createCircuit()

  const declareBound = (wire: Wire, bound: number) => {
    const {minimum, maximum} = circuit.ranges[wire]!
    if (minimum < 0 || maximum > bound) circuit.assumeRange(wire, 0, bound, {allowExistingReaders: true})
    return wire
  }
  const asSum = (wire: Wire, bound: number): Sum => ({terms: [[wire, 1]], bias: 0, bound})
  const materialize = (sum: Sum): Wire => {
    if (sum.terms.length === 0) return circuit.constant(sum.bias)
    if (sum.terms.length === 1 && sum.terms[0]![1] === 1 && sum.bias === 0) return sum.terms[0]![0]
    return declareBound(circuit.roundAffine(sum.terms, sum.bias), sum.bound)
  }
  // Sums passed from one product to the next without a minimum grow by concatenation, so long ones become an operation.
  const compact = (sum: Sum): Sum => sum.terms.length > 4 ? asSum(materialize(sum), sum.bound) : sum

  // JS: Math.min(slack, 63) ** 2 for slack = 0..63, and 63 ** 2 above through the read's clamp.
  const squares = list(slackLimit + 1, slack => circuit.constant(slack * slack))
  // Subtracted from the read's index on the paragraph's last line, which pushes it below the table.
  const lastLineOffset = maxWidthLimit + positionLimit + 1
  const lineCosts = new Map<number, Sum>()
  // JS: lineCost(paragraph, from, to, maxWidth) in reference.ts
  const lineCost = (from: number, to: number): Sum => {
    const key = from * (breakCapacity + 1) + to
    let cost = lineCosts.get(key)
    if (cost === undefined) {
      const start = cells.lineStarts[from]!
      const end = cells.lineEnds[to - 1]!
      // JS: squared = lastLine || slack < 0 ? 0 : Math.min(slack, 63) ** 2, where slack = maxWidth - (end - start), as one
      // read that returns +0 below the table
      const squared = circuit.indexReadAffine([[cells.maxWidth, 1], [start, 1], [end, -1], [cells.endsParagraph[to - 1]!, -lastLineOffset]], 0, squares, 'zero', 'clamp')
      // JS: overflows = end - start - maxWidth >= 1, as relu(1 - relu(1 - D)) on the integer D = end - start - maxWidth
      const ramp = circuit.reglu([], 1, [[cells.maxWidth, 1], [start, 1], [end, -1]], 1)
      const overflows = circuit.reglu([], 1, [[ramp, -1]], 1)
      const penalty = to - from === 1 ? lineCostCap : infeasible
      cost = {terms: [[squared, 1], [overflows, penalty]], bias: 0, bound: penalty}
      lineCosts.set(key, cost)
    }
    return cost
  }

  // JS: the smallest candidate, the first of equal ones, and its pointer, in a balanced tournament. Each pair is
  // excess = relu(left - right), then left - excess, and the left pointer when excess is 0.
  const minimum = (candidates: readonly Candidate[]): Candidate => {
    invariant(candidates.length > 0, 'a minimum needs a candidate')
    let level = candidates
    while (level.length > 1) {
      const next: Candidate[] = []
      for (let index = 0; index + 1 < level.length; index += 2) {
        const left = level[index]!
        const right = level[index + 1]!
        const excess = circuit.reglu([], 1, [...left.sum.terms, ...right.sum.terms.map(([wire, coefficient]) => [wire, -coefficient] as const)], left.sum.bias - right.sum.bias)
        const bound = Math.min(left.sum.bound, right.sum.bound)
        const value = declareBound(circuit.roundAffine([...left.sum.terms, [excess, -1]], left.sum.bias), bound)
        let pointer: Wire | undefined
        if (left.pointer !== undefined && right.pointer !== undefined) {
          // JS: left <= right ? left.pointer : right.pointer, where left <= right exactly when excess is 0
          const leftWins = circuit.reglu([], 1, [[excess, -1]], 1)
          pointer = circuit.indexRead(leftWins, [right.pointer, left.pointer])
        }
        next.push({sum: asSum(value, bound), pointer})
      }
      if (level.length % 2 === 1) next.push(level.at(-1)!)
      level = next
    }
    return level[0]!
  }

  // JS: Math.min(infeasible, sum), as sum - relu(sum - infeasible), only where the sum can pass infeasible.
  const clampInfeasible = (sum: Sum): Sum => {
    if (sum.bound <= infeasible) return sum
    const excess = circuit.reglu([], 1, sum.terms, sum.bias - infeasible)
    return asSum(declareBound(circuit.roundAffine([...sum.terms, [excess, -1]], sum.bias), infeasible), infeasible)
  }

  // One step. JS: for boxes = 1..min(W, to): total = costBefore(to - boxes) + lineCost(to - boxes, to), keeping the
  // smallest total, and the latest start on a tie
  const step = (to: number, costBefore: (from: number) => Sum) => minimum(list(Math.min(window, to), index => {
    const from = to - 1 - index
    return {sum: addSums(costBefore(from), lineCost(from, to)), pointer: circuit.constant(from)}
  }))

  const costs: Sum[] = [zeroSum]
  const predecessors: Wire[] = [circuit.constant(0)]
  if (form === 'chain') {
    for (let to = 1; to <= breakCapacity; to++) {
      const best = step(to, from => costs[from]!)
      costs.push(compact(best.sum))
      predecessors.push(best.pointer!)
    }
  } else {
    // (later ⊗ earlier) for one row of the later matrix, where earlierColumn(m) is the earlier block's entry in row m.
    const minPlusEntry = (laterRow: readonly Entry[], earlierColumn: (m: number) => Entry): Entry => {
      const candidates: Candidate[] = []
      laterRow.forEach((laterEntry, m) => {
        const earlierEntry = earlierColumn(m)
        if (laterEntry !== null && earlierEntry !== null) candidates.push({sum: addSums(laterEntry, earlierEntry), pointer: undefined})
      })
      return candidates.length === 0 ? null : compact(clampInfeasible(minimum(candidates).sum))
    }
    const initialState: Entry[] = list(window, index => index === 0 ? zeroSum : null)
    // M[to]: row 0 holds the line costs into break point `to`, and row r >= 1 moves cost r - 1 to place r.
    const leaf = (to: number): Entry[][] => list(window, row => list(window, column =>
      row === 0 ? (to - 1 - column >= 0 ? lineCost(to - 1 - column, to) : null) : (column === row - 1 ? zeroSum : null)))
    // Item 0 is M[1] applied to s[0], a vector, so every prefix is a vector and only combines of two later blocks are
    // matrix products.
    const items: Block[] = list(breakCapacity, index => index === 0
      ? {kind: 'vector', entries: leaf(1).map(row => minPlusEntry(row, m => initialState[m]!))}
      : {kind: 'matrix', rows: leaf(index + 1)})
    const states = brentKungPrefix(items, (earlier, later): Block => {
      if (later.kind === 'vector') throw new Error('a vector can only be the earlier block')
      if (earlier.kind === 'vector') return {kind: 'vector', entries: later.rows.map(row => minPlusEntry(row, m => earlier.entries[m]!))}
      return {kind: 'matrix', rows: later.rows.map(row => list(window, column => minPlusEntry(row, m => earlier.rows[m]![column]!)))}
    }).map(state => {
      if (state.kind !== 'vector') throw new Error('every prefix is a vector')
      return state.entries
    })
    const stateAfter = (to: number) => to === 0 ? initialState : states[to - 1]!
    for (let to = 1; to <= breakCapacity; to++) {
      // s[to - 1][m] is cost[to - 1 - m]
      const best = step(to, from => {
        const entry = stateAfter(to - 1)[to - 1 - from]
        invariant(entry !== undefined && entry !== null, `the state after break point ${to - 1} has no cost of break point ${from}`)
        return entry
      })
      const cost = stateAfter(to)[0]
      invariant(cost !== undefined && cost !== null, `the state after break point ${to} has no cost`)
      costs.push(cost)
      predecessors.push(best.pointer!)
    }
  }
  const costWires = costs.map(materialize)

  // JS: breakCount = endsParagraph.indexOf(1) + 1
  const breakCount = circuit.affine(cells.endsParagraph.map((bit, index) => [bit, index + 1] as const))
  circuit.assumeRange(breakCount, 1, breakCapacity, {allowExistingReaders: true})
  // JS: totalCost = costs[breakCount]
  const totalCost = circuit.indexRead(breakCount, costWires)

  // jumps[level][at] is predecessors applied 2^level times to `at`, and break point 0 links to itself.
  const levels = Math.max(1, Math.ceil(Math.log2(breakCapacity)))
  const jumps = [predecessors]
  for (let level = 1; level < levels; level++) {
    const previous = jumps[level - 1]!
    jumps.push(previous.map(target => circuit.indexRead(target, previous)))
  }
  // chosen[to - 1]: whether `to` is on the path from breakCount back to 0. The descent finds the smallest break point at
  // or above `to` on that path, which is `to` exactly when `to` is chosen.
  // JS: scan = breakCount; for (level = levels - 1; level >= 0; level--) if (jumps[level][scan] >= to) scan = jumps[level][scan]
  const chosen = list(breakCapacity, index => {
    const to = index + 1
    let scan = breakCount
    for (let level = levels - 1; level >= 0; level--) {
      const candidate = circuit.indexRead(scan, jumps[level]!)
      // JS: candidate >= to, as relu(1 - relu(to - candidate))
      const ramp = circuit.reglu([], 1, [[candidate, -1]], to)
      const advances = circuit.reglu([], 1, [[ramp, -1]], 1)
      scan = circuit.indexRead(advances, [scan, candidate])
    }
    // JS: scan === to, as relu(1 - relu(scan - to) - relu(to - scan))
    const above = circuit.reglu([], 1, [[scan, 1]], -to)
    const below = circuit.reglu([], 1, [[scan, -1]], to)
    return circuit.reglu([], 1, [[above, -1], [below, -1]], 1)
  })

  // JS: windowOverflowCount in reference.ts, how many lines of W + 1 boxes fit. Lines past the paragraph never fit.
  const windowFits = list(Math.max(0, breakCapacity - window), index => {
    const to = window + 1 + index
    // JS: end - start <= maxWidth, as relu(1 - relu(D)) on the integer D = end - start - maxWidth
    const ramp = circuit.reglu([], 1, [[cells.lineEnds[to - 1]!, 1], [cells.lineStarts[to - window - 1]!, -1], [cells.maxWidth, -1]], 0)
    return circuit.reglu([], 1, [[ramp, -1]], 1)
  })
  const windowOverflowCount = windowFits.length === 0 ? circuit.constant(0) : circuit.roundAffine(windowFits.map(bit => [bit, 1] as const))

  const output = {totalCost, windowOverflowCount, chosen, costs: costWires, predecessors}
  return {cells, capacity, form, output, ...table.finish()}
}

export type KnuthPlass = ReturnType<typeof buildKnuthPlass>
export type ProgramOutput = WireValues<KnuthPlass['output']>

export function writeParagraph(source: Float32Array, built: Pick<KnuthPlass, 'cells' | 'capacity'>, paragraph: Paragraph, maxWidth: number) {
  checkParagraph(paragraph)
  const breakCount = paragraph.lineEnds.length
  const {breakCapacity} = built.capacity
  invariant(breakCount <= breakCapacity, `the paragraph has ${breakCount} break points, and the program holds ${breakCapacity}`)
  invariant(Number.isInteger(maxWidth) && maxWidth >= 0 && maxWidth <= maxWidthLimit, `maxWidth must be a whole number within 0..${maxWidthLimit}, got ${maxWidth}`)
  const {cells} = built
  source[cells.maxWidth] = maxWidth
  for (let index = 0; index < breakCapacity; index++) {
    source[cells.lineStarts[index]!] = index < breakCount ? paragraph.lineStarts[index]! : 0
    source[cells.lineEnds[index]!] = index < breakCount ? paragraph.lineEnds[index]! : positionLimit
    source[cells.endsParagraph[index]!] = index === breakCount - 1 ? 1 : 0
  }
}

// The reference's shape from the program's output, for a paragraph of breakCount break points.
export function solutionOf(output: ProgramOutput, breakCount: number): Solution {
  return {
    costs: output.costs.slice(0, breakCount + 1),
    predecessors: output.predecessors.slice(0, breakCount + 1),
    breaks: output.chosen.flatMap((bit, index) => bit === 1 ? [index + 1] : []),
    totalCost: output.totalCost,
    windowOverflowCount: output.windowOverflowCount,
  }
}

export function createKnuthPlass(capacity: Capacity, form: ProgramForm) {
  const built = buildKnuthPlass(capacity, form)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  return {
    built,
    source,
    run(paragraph: Paragraph, maxWidth: number): Solution {
      writeParagraph(source, built, paragraph, maxWidth)
      return solutionOf(evaluate(source).output, paragraph.lineEnds.length)
    },
  }
}
