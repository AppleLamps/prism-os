// Form (a): the pattern as data. The automaton's transition matrix for each character class, its accepting states, and
// the class of every code point sit in cells, so a new pattern writes cells and changes no program. The program runs
// two passes over the text, one step per code point, and each step multiplies the code point's transition matrix with a
// 0/1 state vector:
// - The reverse pass, from the end of the text: reach[j][s] is 1 when some path from state s at position j reads at
//   least one code point and ends in an accepting state.
// - The forward pass, from the start: reached[j][s] is 1 when the match in progress has reached state s by position j.
//   Code point j continues the match when reached[j][s] && reach[j][s] for some state s, and when no match continues,
//   a match starts at j when reach[j][initial state]. So the forward pass knows at every position whether a longer
//   match exists, and never has to go back to where a longest match ended.
import {type Circuit, type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {type CellWires, type WireValues, constant, createEvaluator, createSourceTable, input, inputBit, list} from '../../src/runtime/cells.ts'
import {type Bit, andNot, bitWire, noneOf, not, orExclusive} from './bits.ts'
import {writeText} from './host.ts'
import {type CompiledPattern, type SearchCapacity, capacityErrors, codePointLimit, maxCodePoint} from './pattern.ts'

export type DataCapacity = SearchCapacity & {textLength: number}

export function dataSearchCells({states, classes, boundaries, textLength}: DataCapacity) {
  return {
    // The text's code points, and -1 in every cell past the end of the text.
    text: list(textLength, () => input([-1, maxCodePoint], {initial: -1, grid: 1})),
    // Where the class changes, ascending. An unused boundary holds 0x110000, past every code point.
    boundaries: list(boundaries, () => input([1, codePointLimit], {initial: codePointLimit, grid: 1})),
    // regionClasses[r] is the class of the code points that reach r - 1 boundaries, e.g. regionClasses[1] is the class of
    // the code points below the first boundary. Cell 0 is for -1, past the end of the text. A region that no step reads
    // holds `classes`, one past the last class, which reads +0 from every transition table.
    regionClasses: list(boundaries + 2, index => index === 0
      ? constant(classes, [classes, classes], {grid: 1})
      : input([0, classes], {initial: classes, grid: 1})),
    // transitions[c][s][t] is 1 when a step from state s reads a code point of class c and goes to state t. State 0 is
    // where every match starts.
    transitions: list(classes, () => list(states, () => list(states, () => inputBit()))),
    accepting: list(states, () => inputBit()),
  }
}

export type DataSearchCells = CellWires<ReturnType<typeof dataSearchCells>>

// The class of each code point. JS: regionClasses[[codePoint >= 0] + boundaries.filter(boundary => codePoint >= boundary).length]
export function emitClasses(circuit: Circuit, cells: DataSearchCells): Wire[] {
  const zero = circuit.constant(0)
  return cells.text.map(codePoint => {
    const region = circuit.affine([
      [emitCompare(circuit, codePoint, '>=', zero), 1],
      ...cells.boundaries.map(boundary => [emitCompare(circuit, codePoint, '>=', boundary), 1] as const),
    ])
    return circuit.indexRead(region, cells.regionClasses)
  })
}

// JS: transitions[codePointClass][from][to] && bit, as one index read at codePointClass + classes × (1 - bit), which reads
// +0 past the table.
export function createStepAnd(circuit: Circuit, cells: DataSearchCells) {
  const states = cells.accepting.length
  const classes = cells.transitions.length
  // stepTables[s][t][c] is the cell transitions[c][s][t].
  const stepTables = list(states, from => list(states, to => cells.transitions.map(byClass => byClass[from]![to]!)))
  return (codePointClass: Wire, from: number, to: number, bit: Bit): Bit => {
    if (bit === false) return false
    const indexTerms = bit === true ? [[codePointClass, 1] as const] : [[codePointClass, 1], [bit, -classes]] as const
    return circuit.indexReadAffine(indexTerms, bit === true ? 0 : classes, stepTables[from]![to]!, 'clamp', 'zero')
  }
}

export function buildDataSearch(capacity: DataCapacity) {
  const {states, textLength} = capacity
  const table = createSourceTable()
  const cells = table.declare(dataSearchCells(capacity))
  const circuit = table.createCircuit()
  const classOf = emitClasses(circuit, cells)
  const stepAnd = createStepAnd(circuit, cells)

  // The reverse pass. notReachAt[j][s] is !reach[j][s]. JS: reach[j][s] = states.some(t =>
  // transitions[classOf(text[j])][s][t] && (accepting[t] || reach[j + 1][t])), where reach past the last cell is false.
  const notReachAt = Array<Bit[]>(textLength)
  // JS: notFinish[t] = !(accepting[t] || reach[j + 1][t])
  let notFinish: Bit[] = cells.accepting.map(accepting => not(circuit, accepting))
  for (let position = textLength - 1; position >= 0; position--) {
    const codePointClass = classOf[position]!
    const notReach = list(states, from => noneOf(circuit, list(states, to => stepAnd(codePointClass, from, to, not(circuit, notFinish[to]!)))))
    notReachAt[position] = notReach
    notFinish = list(states, state => andNot(circuit, notReach[state]!, cells.accepting[state]!))
  }

  // The forward pass. JS: reached = states.map(() => false) before the first code point.
  let reached: Bit[] = list(states, () => false)
  const highlighted: Wire[] = []
  const starts: Wire[] = []
  for (let position = 0; position < textLength; position++) {
    const notReach = notReachAt[position]!
    // JS: continuing[s] = reached[s] && reach[j][s], the states from which the match in progress can still read code
    // point j and end in an accepting state.
    const continuing = list(states, state => andNot(circuit, reached[state]!, notReach[state]!))
    const notContinuing = noneOf(circuit, continuing)
    // JS: start = !continuing.some(Boolean) && reach[j][0]
    const start = andNot(circuit, notContinuing, notReach[0]!)
    const live = continuing.map((bit, state) => state === 0 ? orExclusive(circuit, bit, start) : bit)
    highlighted.push(bitWire(circuit, orExclusive(circuit, not(circuit, notContinuing), start)))
    starts.push(bitWire(circuit, start))
    // JS: reached[t] = states.some(s => live[s] && transitions[classOf(text[j])][s][t])
    const codePointClass = classOf[position]!
    reached = list(states, to => not(circuit, noneOf(circuit, list(states, from => stepAnd(codePointClass, from, to, live[from]!)))))
  }

  const output = {highlighted, starts, matchCount: circuit.affine(starts.map(start => [start, 1] as const))}
  // notReachAt is for tests, e.g. comparing the reverse pass with form (c)'s longest ends.
  return {cells, capacity, output, notReachAt, ...table.finish()}
}

export type DataSearch = ReturnType<typeof buildDataSearch>
export type SearchOutput = WireValues<DataSearch['output']>

// Writes a compiled pattern into the cells of form (a) or form (c). Throws when the pattern doesn't fit, which the page
// checks first with capacityErrors.
export function writePattern(values: Float32Array, {cells, capacity}: {cells: DataSearchCells, capacity: DataCapacity}, {automaton, partition}: CompiledPattern) {
  const errors = capacityErrors({pattern: '', automaton, partition}, capacity)
  if (errors.length > 0) throw new Error(errors.map(error => error.message).join('; '))
  cells.boundaries.forEach((wire, index) => {
    values[wire] = partition.boundaries[index] ?? codePointLimit
  })
  cells.regionClasses.forEach((wire, index) => {
    if (index === 0) return
    const classIndex = partition.regionClasses[index - 1] ?? -1
    values[wire] = classIndex === -1 ? capacity.classes : classIndex
  })
  const targets = automaton.targets.map(stateTargets => new Set(stateTargets))
  cells.transitions.forEach((byClass, classIndex) => byClass.forEach((byFrom, from) => byFrom.forEach((wire, to) => {
    const reads = partition.classReads[classIndex]?.[to] === true
    values[wire] = reads && targets[from]?.has(to) === true ? 1 : 0
  })))
  cells.accepting.forEach((wire, state) => {
    values[wire] = automaton.accepting[state] === true ? 1 : 0
  })
}

export function createDataSearch(capacity: DataCapacity) {
  const built = buildDataSearch(capacity)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  return {
    built,
    source,
    setPattern(compiled: CompiledPattern) {
      writePattern(source, built, compiled)
    },
    run(codePoints: readonly number[]): SearchOutput {
      writeText(source, built.cells.text, codePoints)
      return evaluate(source).output
    },
  }
}
