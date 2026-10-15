// The pattern as data, for the search step (src/json-search/search-step.ts). The automaton's transition matrix for
// each character class, its accepting states, and the class of every code point sit in cells, so a new pattern writes
// cells and changes no program. This file declares those cells, writes a compiled pattern into them, and builds the
// two operations that read them: the class of a code point (emitClasses), and one entry of a class's transition
// matrix ANDed with a bit (createStepAnd), which is how a step multiplies the matrix with a 0/1 state vector.
import {type Circuit, type Wire, emitCompare} from '../../runtime/numeric-ui-core.ts'
import {type CellWires, constant, input, inputBit, list} from '../../runtime/cells.ts'
import type {Bit} from './bits.ts'
import {type CompiledPattern, type SearchCapacity, capacityErrors, codePointLimit, maxCodePoint} from './pattern.ts'

// `textLength` is how many code points the program reads at once: 1 for a step, which reads the code point at the
// loop's position.
type DataCapacity = SearchCapacity & {textLength: number}

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

// Writes a compiled pattern into the cells of dataSearchCells. Throws when the pattern doesn't fit, which a caller
// checks first with capacityErrors, e.g. JSON search's page.
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
