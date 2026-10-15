// Regex search as the work of one code point, for loop-program.ts: the class of the code point, one step of a reverse
// pass, and one step of a forward pass, 240 operations at 8 states, whatever the number of positions. The pattern is
// data (regex/data-program.ts): its automaton and its character classes sit in cells, so a new pattern writes cells
// and changes no program. With the same work written once per code point, a program for 256 code points at 8 states
// is 58,920 operations, and one shader with a statement per operation took 107 to 130 s to compile.
//
// The search runs two passes over a document's code points, and each step multiplies the code point's transition
// matrix with a 0/1 state vector:
// - The reverse pass, from the end of the text: reach[j][s] is 1 when some path from state s at position j reads at
//   least one code point and ends in an accepting state.
// - The forward pass, from the start: reached[j][s] is 1 when the match in progress has reached state s by position j.
//   Code point j continues the match when reached[j][s] && reach[j][s] for some state s, and when no match continues,
//   a match starts at j when reach[j][initial state]. So the forward pass knows at every position whether a longer
//   match exists, and never has to go back to where a longest match ended.
//
// The stages of the loop program, each built with data-program.ts's emitClasses and createStepAnd:
//   start    once: notFinish[s] = !accepting[s], the reverse pass's bits before the last code point
//   reverse  from the last position down: the code point's class, notReach[s], and the next notFinish[s]
//   forward  from position 0 up: whether a match continues or starts here, the next reached[s], and the match count
// The class and the notReach bits of every position are fields that the forward loop reads back.
//
// With `masked`, a stage also reads the display kind of the code point, which the JSON highlighter computed, and nine
// cells that say which kinds the search reads. A code point of another kind is replaced by -1, the value of a cell past
// the text's end, which no step reads, so a match lies inside one run of searched characters, e.g. inside one string.
//
// Every value is an integer: bits, classes up to 16, code points and boundaries up to 0x110000, and a count up to the
// number of positions. So every operation is exact in FP32 in any order.
import {type Circuit, type Wire, invariant} from '../runtime/numeric-ui-core.ts'
import {createSourceTable, input, inputBit, list} from '../runtime/cells.ts'
import {displayKind} from './highlighter/kinds.ts'
import {type Bit, andNot, bitWire, noneOf, not, orExclusive} from './regex/bits.ts'
import {type DataSearchCells, createStepAnd, dataSearchCells, emitClasses, writePattern} from './regex/data-program.ts'
import type {CompiledPattern, SearchCapacity} from './regex/pattern.ts'
import {type Binding, type LoopProgram, createStage} from './loop-program.ts'

export const kindCount = Object.keys(displayKind).length
// How many character classes and class boundaries a pattern may have, at every state capacity.
export const classCapacity = 16
export const boundaryCapacity = 32

// Which display kinds a masked search reads: a named scope, or a list of display kinds, e.g. [displayKind.number].
// 'strings' is the characters the highlighter shows as string values, with their quotes, and 'keys' the ones it shows as
// keys. An escape such as \n is a kind of its own, so no match of 'strings' or 'keys' crosses one, and after the first
// error the highlighter shows every later key as a string.
export type SearchScope = 'everything' | 'strings' | 'keys' | 'stringsAndKeys' | readonly number[]
/** @public */
export const searchScopes = ['everything', 'strings', 'keys', 'stringsAndKeys'] as const
export function searchableKinds(scope: SearchScope): readonly number[] {
  switch (scope) {
    case 'everything': return Array.from({length: kindCount}, (_, kind) => kind)
    case 'strings': return [displayKind.string]
    case 'keys': return [displayKind.key]
    case 'stringsAndKeys': return [displayKind.string, displayKind.key]
    default: return scope
  }
}

// JS: searched = searchable[kind] ? codePoint : -1, as (codePoint + 1) × bit − 1.
function emitMaskedCodePoint(circuit: Circuit, codePoint: Wire, kind: Wire, searchable: readonly Wire[]) {
  const bit = circuit.indexReadAffine([[kind, 1]], 0, searchable, 'clamp', 'clamp')
  // An index read gets no grid by itself, and without one the class comparisons below would be sign cascades.
  circuit.assumeGrid(bit, 1)
  const searched = circuit.roundAffine([[circuit.reglu([[codePoint, 1]], 1, [[bit, 1]], 0), 1]], -1)
  invariant(circuit.grids[searched] === 1, 'the searched code point is on a grid of 1')
  return searched
}

type SearchLoopOptions = {
  // How many positions the loops run, e.g. 512. The search reads a document's first `positions` code points.
  positions: number
  // The cells per document of buffer 0: the code points, then the text's length in the last cell.
  cellsPerDocument: number
  masked: boolean
  // Both loops stop at the text's end instead of running every position. A position past the end holds -1, whose class
  // has no steps, so the reverse loop's bits stay what `start` wrote and the forward loop finds nothing there.
  stopAtLength: boolean
  // false keeps the reverse pass's bits as one f32 each in the WGSL instead of one 32-bit word per position, to measure
  // the difference.
  bitFields?: boolean
}

export type SearchLoop = ReturnType<typeof buildSearchLoop>

export function buildSearchLoop(capacity: SearchCapacity, options: SearchLoopOptions) {
  const {states} = capacity
  const {positions, masked} = options
  invariant(positions < options.cellsPerDocument, 'the text\'s length sits after the code points')
  const table = createSourceTable()
  const cells = table.declare({
    // regex/data-program.ts's cells for a text of one code point: the code point at the loop's position, then the
    // pattern's tables.
    search: dataSearchCells({...capacity, textLength: 1}),
    // With `masked`: the display kind of the code point, and searchable[kind], whether the search reads that kind.
    mask: list(masked ? 1 : 0, () => ({kind: input([0, kindCount - 1], {initial: displayKind.pastEnd, grid: 1}), searchable: list(kindCount, () => inputBit(1))})),
    // Carried from one position of the reverse loop to the next: notFinish[t] = !(accepting[t] || reach[t]).
    notFinish: list(states, () => inputBit(1)),
    // What the forward loop reads back from the reverse loop, and what it carries.
    codePointClass: input([0, capacity.classes], {initial: capacity.classes, grid: 1}),
    notReach: list(states, () => inputBit(1)),
    reached: list(states, () => inputBit()),
    matchCount: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const pattern = cells.search
  const codePoint = pattern.text[0]!
  const stepAnd = createStepAnd(circuit, pattern)

  // start. JS: notFinish = accepting.map(isAccepting => !isAccepting)
  const startNotFinish = pattern.accepting.map(accepting => bitWire(circuit, not(circuit, accepting)))

  // reverse. notReach[s] is !reach[s] at this position, and the carried notFinish[t] is !(accepting[t] || reach[t]) at
  // the position after it. JS: reach[s] = states.some(t => transitions[classOf(codePoint)][s][t] && (accepting[t] || reachAfter[t]))
  const mask = cells.mask[0]
  const searched = mask === undefined ? codePoint : emitMaskedCodePoint(circuit, codePoint, mask.kind, mask.searchable)
  const classOf = emitClasses(circuit, {...pattern, text: [searched]})[0]!
  const notFinish: Bit[] = cells.notFinish
  const notReach = list(states, from => bitWire(circuit, noneOf(circuit, list(states, to => stepAnd(classOf, from, to, not(circuit, notFinish[to]!))))))
  const nextNotFinish = list(states, state => bitWire(circuit, andNot(circuit, notReach[state]!, pattern.accepting[state]!)))

  // forward. JS: continuing[s] = reached[s] && reach[s], the states from which the match in progress can still read
  // this code point and end in an accepting state.
  const continuing = list(states, state => andNot(circuit, cells.reached[state]!, cells.notReach[state]!))
  const notContinuing = noneOf(circuit, continuing)
  // JS: start = !continuing.some(Boolean) && reach[0]
  const start = andNot(circuit, notContinuing, cells.notReach[0]!)
  const live = continuing.map((bit, state) => state === 0 ? orExclusive(circuit, bit, start) : bit)
  const highlighted = orExclusive(circuit, not(circuit, notContinuing), start)
  // 0 outside a match, 1 inside one, and 2 at a match's first code point: highlighted + start.
  const mark = circuit.affine([[bitWire(circuit, highlighted), 1], [bitWire(circuit, start), 1]])
  // JS: reached[t] = states.some(s => live[s] && transitions[codePointClass][s][t])
  const nextReached = list(states, to => bitWire(circuit, not(circuit, noneOf(circuit, list(states, from => stepAnd(cells.codePointClass, from, to, live[from]!))))))
  const nextMatchCount = circuit.affine([[cells.matchCount, 1], [bitWire(circuit, start), 1]])

  const {initialSource} = table.finish()
  const registers = [
    ...list(states, state => ({name: `notFinish[${state}]`, initial: 1})),
    ...list(states, state => ({name: `reached[${state}]`, initial: 0})),
    {name: 'matchCount', initial: 0},
  ]
  const notFinishRegister = (state: number) => state
  const reachedRegister = (state: number) => states + state
  const matchCountRegister = 2 * states
  const classField = 0
  const notReachField = 1
  const itemBindings: [Wire, Binding][] = mask === undefined
    ? [[codePoint, {kind: 'item', buffer: 0}]]
    : [[codePoint, {kind: 'item', buffer: 0}], [mask.kind, {kind: 'item', buffer: 1}]]
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'documents', cellsPerDocument: options.cellsPerDocument}, ...(masked ? [{name: 'kinds', cellsPerDocument: positions}] : [])],
    registers,
    fields: [{name: 'codePointClass', width: 1, bits: false}, {name: 'notReach', width: states, bits: options.bitFields ?? true}],
    outputGroups: [
      {name: 'matchCount', kind: 'document', valuesPerDocument: 1, fill: 0},
      {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0},
    ],
    stages: [
      createStage({
        name: 'start', repeat: 'once', circuit, sharedOffset: 0, bindings: new Map(),
        outputs: startNotFinish.map((wire, state) => ({wire, write: {kind: 'register', register: notFinishRegister(state)}})),
      }),
      createStage({
        name: 'reverse', repeat: 'backward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([...itemBindings, ...cells.notFinish.map((wire, state): [Wire, Binding] => [wire, {kind: 'register', register: notFinishRegister(state)}])]),
        outputs: [
          {wire: classOf, write: {kind: 'field', field: classField, component: 0}},
          ...notReach.map((wire, state) => ({wire, write: {kind: 'field', field: notReachField, component: state} as const})),
          ...nextNotFinish.map((wire, state) => ({wire, write: {kind: 'register', register: notFinishRegister(state)} as const})),
        ],
      }),
      createStage({
        name: 'forward', repeat: 'forward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([
          [cells.codePointClass, {kind: 'field', field: classField, component: 0}],
          ...cells.notReach.map((wire, state): [Wire, Binding] => [wire, {kind: 'field', field: notReachField, component: state}]),
          ...cells.reached.map((wire, state): [Wire, Binding] => [wire, {kind: 'register', register: reachedRegister(state)}]),
          [cells.matchCount, {kind: 'register', register: matchCountRegister}],
        ]),
        outputs: [
          {wire: mark, write: {kind: 'position', group: 1}},
          ...nextReached.map((wire, state) => ({wire, write: {kind: 'register', register: reachedRegister(state)} as const})),
          {wire: nextMatchCount, write: {kind: 'register', register: matchCountRegister}},
        ],
      }),
    ],
    results: [{group: 0, column: 0, register: matchCountRegister}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: options.stopAtLength ? {buffer: 0, column: options.cellsPerDocument - 1} : undefined,
  }
  const dataCells: DataSearchCells = pattern
  const searchableCells = mask?.searchable
  return {
    loop, capacity, options, circuit,
    // Writes a pattern's cells into a copy of loop.sharedValues. Throws when the pattern doesn't fit the capacity.
    writePattern(shared: Float32Array, compiled: CompiledPattern) {
      writePattern(shared, {cells: dataCells, capacity: {...capacity, textLength: 1}}, compiled)
    },
    // Writes which kinds a masked search reads.
    writeScope(shared: Float32Array, scope: SearchScope) {
      invariant(searchableCells !== undefined, 'only a masked search has a scope')
      const kinds = new Set(searchableKinds(scope))
      searchableCells.forEach((wire, kind) => {
        shared[wire] = kinds.has(kind) ? 1 : 0
      })
    },
    // How many shared cells a new pattern writes: the boundaries, the region classes, the transitions and the accepting bits.
    patternCells: capacity.boundaries + capacity.boundaries + 1 + capacity.classes * states * states + states,
  }
}
