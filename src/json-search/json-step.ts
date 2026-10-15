// The JSON highlighter as the work of one position, for loop-program.ts. JavaScript writes a document's first 512
// code points and its length into cells (program.ts), and the program computes, for every code point, what it's shown
// as, then whether the text is valid, the first error's position and kind, and whether the text is too long.
//
// What one position computes, from the tables of highlighter/tables.ts and from values carried from the position
// before:
// 1. The character's class, read from a table of 129 cells (patterns.md, "A loop over data that rarely changes").
// 2. The tokenizer's event, e.g. stringStart or badNumber, and its next state, each as one read at (state, class)
//    (patterns.md, "A state machine over queued events").
// 3. The depth after the character, a running total of +1 and −1 (patterns.md, "Running totals").
// 4. The container kinds as one integer, the container code: a running total of ±2^depth for braces. Whether the
//    innermost container is an object is one comparison of the code with 2^(depth − 1) (expressions.md, "a >= b" on
//    grids). Before the first error every container is still open at its depth, so the code's bits below the depth
//    are the open containers' kinds, and the comparison reads the top bit. After the first error the code may be
//    wrong, and the grammar stays in its error state whatever the comparison says.
// 5. The grammar between tokens, a state machine of 8 states over (token, depth class, container kind), as one read.
// 6. The display kind, one read at (event, grammar state), and the error kind of this position: the tokenizer's kind
//    of the event plus the grammar's kind of the step.
//
// The stages of the loop program:
//   step   positions 0 to 511: the six parts above
//   end    position 512, the end of the text or the 513th code point of a longer one: the last event and grammar step,
//          then valid, the first error's position and kind, and truncated
// The tokenizer's state, the depth, the container code, the grammar's state, the count of positions in the error state
// and the first error's kind are registers carried from one position to the next.
//
// What follows from running one step at every position:
// - `inObject` compares the container code with a level weight. A step has one code cell for every position, whose
//   range is ±511 × 2^15, so the difference with a level weight can reach 2^24, where emitCompare builds a sign
//   cascade of 17 operations instead of integer bits. Both are exact comparisons of integers.
// - At position 0 the comparison needs no special case: the code starts at 0 and the smallest level weight is 1, so
//   [0 >= levelWeight[0]] is 0.
// - The first error's position is a count: the grammar's error state never goes back, so the positions before it are
//   513 minus the positions in it (patterns.md, "findIndex when the test flips once along the items"). The first
//   error's kind is carried: the step adds the position's error kind where the grammar enters the error state, which
//   happens at most once.
// tests/json-search/json-step.test.ts compares every output with a plain JavaScript reference, on 2,509 test texts, on
// documents at the limits, and on an object and an array at every depth.
import {type Circuit, type Terms, type Wire, emitCompare} from '../runtime/numeric-ui-core.ts'
import {constant, createSourceTable, input} from '../runtime/cells.ts'
import {capacity, displayKind, errorKinds, maximumDepth} from './highlighter/kinds.ts'
import {
  classCount, classTable, contextCount, depthChangeTable, depthClassTable, displayTable, eventCount, grammarErrorTable, grammarNextTable,
  grammarStateCount, grammarStates, grammarTokenTable, levelWeightTable, lexerErrorKindTable, lexerEventTable, lexerNextTable, lexerStateCount,
  objectWeightTable, symbolCount,
} from './highlighter/tables.ts'
import {type Binding, type LoopProgram, createStage} from './loop-program.ts'

// The largest text length that program.ts's writeDocumentCells writes.
const lengthLimit = 1_048_576
export const stepSummaryNames = ['valid', 'firstErrorPosition', 'truncated', 'firstErrorKind'] as const

// A table that JavaScript writes once, as constant cells within the table's own range, on a grid of 1.
const tableCells = (values: readonly number[]) => {
  const range = [Math.min(...values), Math.max(...values)] as const
  return values.map(value => constant(value, range, {grid: 1}))
}
const read = (circuit: Circuit, terms: Terms, bias: number, candidates: readonly Wire[], outOfRange: 'clamp' | 'zero' = 'clamp') =>
  circuit.indexReadAffine(terms, bias, candidates, outOfRange, outOfRange)
const onGrid = (circuit: Circuit, wire: Wire) => {
  circuit.assumeGrid(wire, 1)
  return wire
}

// `cellsPerDocument` is the layout of buffer 0: 512 code points, then the text's length.
export function buildJsonLoop(cellsPerDocument = capacity + 1) {
  const table = createSourceTable()
  const positions = capacity + 1
  // The container code is a running total of ±2^depth over at most 511 positions before the last one that reads it.
  const codeLimit = (capacity - 1) * 2 ** (maximumDepth - 1)
  const cells = table.declare({
    codePoint: input([-1, 0x10ffff], {initial: -1, grid: 1}),
    textLength: input([0, lengthLimit], {grid: 1}),
    // The registers, each with the range its value has after any number of positions.
    lexerState: input([0, lexerStateCount - 1], {grid: 1}),
    depth: input([-capacity, capacity], {grid: 1}),
    code: input([-codeLimit, codeLimit], {grid: 1}),
    grammarState: input([0, grammarStateCount - 1], {grid: 1}),
    errorCount: input([0, positions], {grid: 1}),
    firstErrorKind: input([0, errorKinds.length - 1], {grid: 1}),
    tables: {
      classes: tableCells(classTable),
      lexerNext: tableCells(lexerNextTable),
      lexerEvent: tableCells(lexerEventTable),
      grammarToken: tableCells(grammarTokenTable),
      lexerErrorKind: tableCells(lexerErrorKindTable),
      depthChange: tableCells(depthChangeTable),
      objectWeight: tableCells(objectWeightTable),
      levelWeight: tableCells(levelWeightTable),
      depthClass: tableCells(depthClassTable),
      grammarNext: tableCells(grammarNextTable),
      grammarError: tableCells(grammarErrorTable),
      display: tableCells(displayTable),
    },
  })
  const circuit = table.createCircuit()
  const {tables} = cells
  const errorState = grammarStates.indexOf('error')
  // JS: inError = grammarState === 'error', the last state.
  const inError = (state: Wire) => circuit.reglu([], 1, [[state, 1]], 1 - errorState)
  const errorBefore = inError(cells.grammarState)

  // What both stages do after the character's class is known. `inObject` is undefined where the position reads no
  // container kind.
  function emitPosition(characterClass: Terms, inObject: Wire | undefined) {
    // JS: event = lexerEvent[state][characterClass]; state = lexerNext[state][characterClass]
    const event = read(circuit, [[cells.lexerState, classCount], ...characterClass], 0, tables.lexerEvent)
    const lexerNext = read(circuit, [[cells.lexerState, classCount], ...characterClass], 0, tables.lexerNext)
    const depthClass = read(circuit, [[cells.depth, 1]], 0, tables.depthClass)
    const grammarToken = read(circuit, [[event, 1]], 0, tables.grammarToken)
    // JS: symbol = grammarToken × 8 + depthClass × 2 + inObject
    const symbol: Terms = [[grammarToken, contextCount], [depthClass, 2], ...(inObject === undefined ? [] : [[inObject, 1] as const])]
    const grammarNext = circuit.indexReadAffine([[cells.grammarState, symbolCount], ...symbol], 0, tables.grammarNext, 'clamp', 'clamp')
    const errorKindHere = circuit.roundAffine([
      [read(circuit, [[event, 1]], 0, tables.lexerErrorKind), 1],
      [circuit.indexReadAffine([[cells.grammarState, symbolCount], ...symbol], 0, tables.grammarError, 'clamp', 'clamp'), 1],
    ])
    const errorAfter = inError(grammarNext)
    // JS: if (errorAfter && !errorBefore) firstErrorKind = errorKindHere
    const firstErrorKind = circuit.roundAffine([[cells.firstErrorKind, 1], [circuit.reglu([[errorKindHere, 1]], 0, [[errorAfter, 1], [errorBefore, -1]], 0), 1]])
    return {event, lexerNext, grammarNext, errorAfter, firstErrorKind}
  }

  // step, the six parts of the header for one of the positions 0 to 511.
  const characterClass = read(circuit, [[cells.codePoint, 1]], 1, tables.classes)
  const inObject = emitCompare(circuit, cells.code, '>=', onGrid(circuit, read(circuit, [[cells.depth, 1]], -1, tables.levelWeight)))
  const step = emitPosition([[characterClass, 1]], inObject)
  const depthChange = onGrid(circuit, read(circuit, [[step.event, 1]], 0, tables.depthChange))
  const objectWeight = onGrid(circuit, read(circuit, [[cells.depth, eventCount], [step.event, 1]], 0, tables.objectWeight, 'zero'))
  const stepOutputs = {
    lexerState: step.lexerNext,
    depth: circuit.roundAffine([[cells.depth, 1], [depthChange, 1]]),
    code: circuit.roundAffine([[cells.code, 1], [objectWeight, 1]]),
    grammarState: step.grammarNext,
    errorCount: circuit.roundAffine([[cells.errorCount, 1], [step.errorAfter, 1]]),
    firstErrorKind: step.firstErrorKind,
    displayKind: read(circuit, [[step.event, grammarStateCount], [step.grammarNext, 1]], 0, tables.display),
  }

  // end, position 512. JS: truncated = textLength > 512, and its class is end or truncatedEnd, classes 0 and 1.
  const truncated = emitCompare(circuit, cells.textLength, '>', circuit.constant(capacity))
  const end = emitPosition([[truncated, 1]], undefined)
  // JS: errorFreeCount = the positions before the grammar's error state, of 513
  const errorFreeCount = circuit.roundAffine([[cells.errorCount, -1], [end.errorAfter, -1]], positions)
  const valid = circuit.roundAffine([[end.errorAfter, -1]], 1)
  const endOutputs = {
    valid,
    firstErrorPosition: circuit.roundAffine([[errorFreeCount, 1], [valid, -(positions + 1)]]),
    truncated: circuit.roundAffine([[truncated, 1]]),
    firstErrorKind: end.firstErrorKind,
  }

  const {initialSource} = table.finish()
  const registerNames = ['lexerState', 'depth', 'code', 'grammarState', 'errorCount', 'firstErrorKind'] as const
  const registerOf = (name: typeof registerNames[number]) => registerNames.indexOf(name)
  const registerBindings = registerNames.map((name): [Wire, Binding] => [cells[name], {kind: 'register', register: registerOf(name)}])
  const loop: LoopProgram = {
    positions: capacity,
    buffers: [{name: 'documents', cellsPerDocument}],
    registers: registerNames.map(name => ({name, initial: 0})),
    fields: [],
    outputGroups: [
      {name: 'summary', kind: 'document', valuesPerDocument: stepSummaryNames.length, fill: 0},
      {name: 'displayKinds', kind: 'position', valuesPerDocument: capacity, fill: displayKind.pastEnd},
    ],
    stages: [
      createStage({
        name: 'step', repeat: 'forward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([[cells.codePoint, {kind: 'item', buffer: 0}], ...registerBindings]),
        outputs: [
          {wire: stepOutputs.displayKind, write: {kind: 'position', group: 1}},
          ...registerNames.map(name => ({wire: stepOutputs[name], write: {kind: 'register', register: registerOf(name)} as const})),
        ],
      }),
      createStage({
        name: 'end', repeat: 'once', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([[cells.textLength, {kind: 'cell', buffer: 0, column: cellsPerDocument - 1}], ...registerBindings]),
        outputs: stepSummaryNames.map((name, column) => ({wire: endOutputs[name], write: {kind: 'document', group: 0, column} as const})),
      }),
    ],
    results: [],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {loop, circuit}
}
