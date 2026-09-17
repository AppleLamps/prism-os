// Form (c): the pattern as data, in the same cells as form (a), with the steps over the text combined in a tree of 0/1
// matrix products instead of two loops. Two parts:
// - The longest ends, from the end of the text. Where form (a)'s reverse pass keeps one bit per state per position, "some
//   path from here ends in an accepting state", this form keeps the end of the longest such path, an integer:
//   JS: longestEnd[j][s] = Math.max(0, ...states.filter(t => step[j][s][t]).map(t => Math.max(accepting[t] ? j + 1 : 0, longestEnd[j + 1][t])))
//   The step at position j is a map from the vector longestEnd[j + 1] to longestEnd[j], and a block of neighboring
//   positions has a map of the same kind: a 0/1 matrix, whether some path reads the whole block from state s and ends in
//   state t, and a vector, the longest end within the block. Two blocks combine into one map with one clamped matrix
//   product, so a prefix network gives longestEnd at every position in O(log N) levels of products.
// - Picking the matches. longestEnd[p][0] is the end of the longest match that starts at p, or 0 when none starts there,
//   so the scan position after p is known for every p at once: JS: next[p] = Math.max(longestEnd[p][0], p + 1). Doubling
//   these links gives, for every position, the last scan position at or before it, and whether that scan position starts
//   a match that covers the position.
import {type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {type WireValues, createEvaluator, createSourceTable, list} from '../../src/runtime/cells.ts'
import {type Bit, and, bitWire, noneOf, not} from './bits.ts'
import {type DataCapacity, createStepAnd, dataSearchCells, emitClasses, writePattern} from './data-program.ts'
import {writeText} from './host.ts'
import type {CompiledPattern} from './pattern.ts'
import {brentKungPrefix, sklanskyPrefix} from './prefix-networks.ts'

export type PrefixNetwork = 'brent-kung' | 'sklansky'

// The map of a block of positions. matrix[s][t] is 1 when some path from state s reads every code point of the block and
// ends in state t. ends[s] is the end of the longest path from s that ends in an accepting state within the block, or 0.
// A suffix, a block that reaches the end of the text, only needs its ends, and has matrix null.
type BlockMap = {matrix: Bit[][], ends: Wire[]}
type Suffix = {matrix: null, ends: Wire[]}

export function buildTreeSearch(capacity: DataCapacity, network: PrefixNetwork = 'brent-kung') {
  const {states, textLength} = capacity
  const table = createSourceTable()
  const cells = table.declare(dataSearchCells(capacity))
  const circuit = table.createCircuit()
  const classOf = emitClasses(circuit, cells)
  const stepAnd = createStepAnd(circuit, cells)
  const zero = circuit.constant(0)

  // Every end is an integer within 0..textLength. The builder infers the range of a sum from its terms, which would
  // double with every level of a maximum and grow with every level of the tree, so the operations that hold ends declare
  // the range. A wire can already have readers when the builder returns an existing identical operation, and then the
  // declaration only affects operations built afterwards.
  const declareInteger = (wire: Wire, grid: boolean) => {
    const {minimum, maximum} = circuit.ranges[wire]!
    if (minimum < 0 || maximum > textLength) circuit.assumeRange(wire, 0, textLength, {allowExistingReaders: true})
    if (grid && circuit.grids[wire] !== 1) circuit.assumeGrid(wire, 1, {allowExistingReaders: true})
    return wire
  }

  // JS: bit ? end : 0, as end × max(0, bit).
  const gate = (end: Wire, bit: Bit): Wire | undefined => {
    if (bit === false || circuit.constants[end] === 0) return undefined
    if (bit === true) return end
    return declareInteger(circuit.reglu([[end, 1]], 0, [[bit, 1]], 0), false)
  }

  // JS: Math.max(0, ...ends), for integers within 0..textLength, as a tournament of larger = a + relu(b - a).
  const maximum = (ends: readonly Wire[]): Wire => {
    let level = ends.filter(end => circuit.constants[end] !== 0)
    if (level.length === 0) return zero
    while (level.length > 1) {
      const nextLevel: Wire[] = []
      for (let index = 0; index + 1 < level.length; index += 2) {
        const a = level[index]!
        const b = level[index + 1]!
        const difference = declareInteger(circuit.reglu([], 1, [[b, 1], [a, -1]], 0), false)
        nextLevel.push(declareInteger(circuit.affine([[a, 1], [difference, 1]]), false))
      }
      if (level.length % 2 === 1) nextLevel.push(level.at(-1)!)
      level = nextLevel
    }
    return level[0]!
  }

  // The block `earlier`, then the block `later` right after it in the text.
  // JS: matrix[s][t] = states.some(u => earlier.matrix[s][u] && later.matrix[u][t])
  //     ends[s] = Math.max(earlier.ends[s], ...states.map(u => earlier.matrix[s][u] ? later.ends[u] : 0))
  const followedBy = (earlier: BlockMap, later: BlockMap | Suffix): BlockMap | Suffix => {
    const ends = list(states, from => maximum([
      earlier.ends[from]!,
      ...list(states, middle => gate(later.ends[middle]!, earlier.matrix[from]![middle]!)).filter(end => end !== undefined),
    ]))
    if (later.matrix === null) return {matrix: null, ends}
    const laterMatrix = later.matrix
    const matrix = list(states, from => list(states, to =>
      not(circuit, noneOf(circuit, list(states, middle => and(circuit, earlier.matrix[from]![middle]!, laterMatrix[middle]![to]!))))))
    return {matrix, ends}
  }

  // One map per code point.
  // JS: matrix[s][t] = transitions[class][s][t], ends[s] = states.some(t => transitions[class][s][t] && accepting[t]) ? position + 1 : 0
  const leaves = classOf.map((codePointClass, position): BlockMap => ({
    matrix: list(states, from => list(states, to => stepAnd(codePointClass, from, to, true))),
    ends: list(states, from => {
      const finishes = not(circuit, noneOf(circuit, list(states, to => stepAnd(codePointClass, from, to, cells.accepting[to]!))))
      return typeof finishes === 'boolean' ? circuit.constant(finishes ? position + 1 : 0) : circuit.affine([[finishes, position + 1]])
    }),
  }))

  // The network runs from the end of the text: item k is the leaf of position textLength - 1 - k, and prefix k covers
  // positions textLength - 1 - k to the end. Item 0 is a suffix, so every prefix is one.
  const items: (BlockMap | Suffix)[] = leaves.toReversed()
  items[0] = {matrix: null, ends: leaves.at(-1)!.ends}
  const prefix = network === 'sklansky' ? sklanskyPrefix : brentKungPrefix
  const suffixes = prefix(items, (laterInText, earlierInText) => {
    if (earlierInText.matrix === null) throw new Error('a combine reads a suffix as its earlier block')
    return followedBy(earlierInText, laterInText)
  }).toReversed()
  // longestEnds[j][s] is JS's longestEnd[j][s] above.
  const longestEnds = suffixes.map(suffix => suffix.ends)

  // JS: longest[p] = longestEnd[p][0], the end of the longest match that starts at p, or 0
  const longest = longestEnds.map(ends => declareInteger(ends[0]!, true))
  // JS: next[p] = Math.max(longest[p], p + 1), and textLength past the end
  const next = [
    ...longest.map((end, position) => declareInteger(circuit.affine([[circuit.reglu([], 1, [[end, 1]], -(position + 1)), 1]], position + 1), true)),
    declareInteger(circuit.constant(textLength), true),
  ]
  // jumps[k][p] is next applied 2^k times to p. JS: jumps[k + 1][p] = jumps[k][jumps[k][p]]
  const jumpLevels = Math.max(1, Math.ceil(Math.log2(textLength)))
  const jumps = [next]
  for (let level = 1; level < jumpLevels; level++) {
    const previous = jumps[level - 1]!
    jumps.push(previous.map(target => declareInteger(circuit.indexRead(target, previous), true)))
  }

  const highlighted: Wire[] = []
  const starts: Wire[] = []
  longest.forEach((end, position) => {
    const threshold = circuit.constant(position)
    // The last scan position at or before this position. Scan positions increase, and at most textLength - 1 steps
    // come before this position, so one binary descent over the jump tables finds it.
    // JS: scan = 0; for (k = jumpLevels - 1; k >= 0; k--) if (jumps[k][scan] <= position) scan = jumps[k][scan]
    let scan = zero
    for (let level = jumpLevels - 1; level >= 0; level--) {
      const candidate = declareInteger(circuit.indexRead(scan, jumps[level]!), true)
      const advances = emitCompare(circuit, candidate, '<=', threshold)
      scan = declareInteger(circuit.indexRead(advances, [scan, candidate]), true)
    }
    // JS: start = scan === position && longest[position] > 0
    const start = and(circuit, emitCompare(circuit, scan, '>=', threshold), emitCompare(circuit, end, '>', zero))
    starts.push(bitWire(circuit, start))
    // JS: highlighted = longest[scan] > position, i.e. the match that starts at the scan position covers this position
    highlighted.push(emitCompare(circuit, declareInteger(circuit.indexRead(scan, longest), true), '>', threshold))
  })

  const output = {highlighted, starts, matchCount: circuit.affine(starts.map(start => [start, 1] as const))}
  return {cells, capacity, network, output, longestEnds, ...table.finish()}
}

export type TreeSearch = ReturnType<typeof buildTreeSearch>
export type TreeOutput = WireValues<TreeSearch['output']>

export function createTreeSearch(capacity: DataCapacity, network: PrefixNetwork = 'brent-kung') {
  const built = buildTreeSearch(capacity, network)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  return {
    built,
    source,
    setPattern(compiled: CompiledPattern) {
      writePattern(source, built, compiled)
    },
    run(codePoints: readonly number[]): TreeOutput {
      writeText(source, built.cells.text, codePoints)
      return evaluate(source).output
    },
  }
}
