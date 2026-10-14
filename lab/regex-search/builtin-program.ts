// Form (b): the pattern built into the program. The same two passes as data-program.ts, but the builder knows the
// automaton, so each step is a fixed sparse sum over the steps the pattern has, and a new pattern rebuilds and recompiles
// the program. The builder uses the position automaton's structure: every step into state t reads the same set of code
// points, so a step's matrix is the pattern's step structure times one membership bit per state, e.g. for (the|an?)
// [a-z]+, the state for [a-z] is reached from the space or from itself, when the code point is within a..z.
import {type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {type WireValues, createEvaluator, createSourceTable, input, list} from '../../src/runtime/cells.ts'
import {type Bit, and, andNot, bitWire, noneOf, not, orExclusive} from '../../src/json-search/regex/bits.ts'
import {writeText} from '../../src/json-search/regex/host.ts'
import {type CompiledPattern, codePointLimit, maxCodePoint} from '../../src/json-search/regex/pattern.ts'

export function buildBuiltInSearch({automaton}: CompiledPattern, textLength: number) {
  const {stateCount, targets, stateSets, accepting} = automaton
  const table = createSourceTable()
  const cells = table.declare({text: list(textLength, () => input([-1, maxCodePoint], {initial: -1, grid: 1}))})
  const circuit = table.createCircuit()

  // Every code point where some state's set starts or stops.
  const edges = [...new Set(stateSets.flatMap(set => set.flatMap(([low, high]) => [low, high + 1])))]
    .filter(edge => edge < codePointLimit)
    .sort((left, right) => left - right)
  const edgeWires = new Map(edges.map(edge => [edge, circuit.constant(edge)]))
  const predecessors = list(stateCount, to => list(stateCount, from => from).filter(from => targets[from]!.includes(to)))

  // JS: reads[t] = setContains(stateSets[t], codePoint), as a sum of [codePoint >= low] - [codePoint >= high + 1] over the
  // set's intervals.
  const readsAt = cells.text.map(codePoint => {
    const atLeast = new Map(edges.map(edge => [edge, emitCompare(circuit, codePoint, '>=', edgeWires.get(edge)!)]))
    return stateSets.map((set): Bit => {
      if (set.length === 0) return false
      const terms: [Wire, number][] = []
      for (const [low, high] of set) {
        terms.push([atLeast.get(low)!, 1])
        if (high + 1 < codePointLimit) terms.push([atLeast.get(high + 1)!, -1])
      }
      return circuit.affine(terms)
    })
  })

  // The reverse pass. JS: reach[j][s] = targets[s].some(t => reads(text[j])[t] && (accepting[t] || reach[j + 1][t]))
  const notReachAt = Array<Bit[]>(textLength)
  let notFinish: Bit[] = accepting.map(isAccepting => !isAccepting)
  for (let position = textLength - 1; position >= 0; position--) {
    const reads = readsAt[position]!
    const stepFinishes = list(stateCount, to => andNot(circuit, reads[to]!, notFinish[to]!))
    const notReach = list(stateCount, from => noneOf(circuit, targets[from]!.map(to => stepFinishes[to]!)))
    notReachAt[position] = notReach
    notFinish = list(stateCount, state => accepting[state]! ? false : notReach[state]!)
  }

  // The forward pass, as in data-program.ts.
  let reached: Bit[] = list(stateCount, () => false)
  const highlighted: Wire[] = []
  const starts: Wire[] = []
  for (let position = 0; position < textLength; position++) {
    const notReach = notReachAt[position]!
    const continuing = list(stateCount, state => andNot(circuit, reached[state]!, notReach[state]!))
    const notContinuing = noneOf(circuit, continuing)
    const start = andNot(circuit, notContinuing, notReach[0]!)
    const live = continuing.map((bit, state) => state === 0 ? orExclusive(circuit, bit, start) : bit)
    highlighted.push(bitWire(circuit, orExclusive(circuit, not(circuit, notContinuing), start)))
    starts.push(bitWire(circuit, start))
    // JS: reached[t] = reads(text[j])[t] && predecessors[t].some(s => live[s])
    const reads = readsAt[position]!
    reached = list(stateCount, to => and(circuit, reads[to]!, not(circuit, noneOf(circuit, predecessors[to]!.map(from => live[from]!)))))
  }

  const output = {highlighted, starts, matchCount: circuit.affine(starts.map(start => [start, 1] as const))}
  return {cells, output, ...table.finish()}
}

type BuiltInSearch = ReturnType<typeof buildBuiltInSearch>
export type BuiltInOutput = WireValues<BuiltInSearch['output']>

export function createBuiltInSearch(compiled: CompiledPattern, textLength: number) {
  const built = buildBuiltInSearch(compiled, textLength)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  return {
    built,
    source,
    run(codePoints: readonly number[]): BuiltInOutput {
      writeText(source, built.cells.text, codePoints)
      return evaluate(source).output
    },
  }
}
