// A JSON highlighter as one numeric program, with every position written out. JavaScript writes up to 512 code points
// and the text's length into cells, and the program computes, for every code point, what it's shown as, then the first
// error's position and kind, and whether the text is too long.
//
// The stages, each over 513 positions, where position 512 is the end of the text, or the 513th code point of a longer
// text:
// 1. A character class per position, read from a table of 129 cells (patterns.md, "A loop over data that rarely changes").
// 2. The tokenizer's state before every position, as a loop of one index read per position (patterns.md, "A state
//    machine over queued events"). Then the event per position, e.g. stringStart or badNumber, as one read at
//    (state before, class).
// 3. Depth before every position as running totals of +1 and −1 (patterns.md, "Running totals").
// 4. The container kinds as one integer, running totals of ±2^depth for braces, and the kind at the current depth as one
//    comparison with 2^(depth − 1) (expressions.md, "a >= b" on grids). It's exact before the first error, the only
//    place the grammar reads it.
// 5. The grammar between tokens, a state machine of 8 states over (token, depth class, container kind), as a loop like
//    stage 2.
// 6. Outputs: the first error as a count of positions before the grammar's error state (patterns.md, "findIndex when
//    the test flips once along the items"), and its kind as one read at that count.
import {type Circuit, type Terms, type Wire, emitCompare} from '../../runtime/numeric-ui-core.ts'
import {constant, createSourceTable, input, list} from '../../runtime/cells.ts'
import {capacity} from './kinds.ts'
import {
  bracketTable, classCount, classTable, closerTable, contextCount, depthChangeTable, depthClassTable, displayTable, eventCount,
  grammarErrorTable, grammarNextTable, grammarStateCount, grammarStates, grammarTokenTable, levelWeightTable, lexerErrorKindTable,
  lexerEventTable, lexerNextTable, objectWeightTable, openerTable, symbolCount,
} from './tables.ts'

// The largest text length the host writes. A longer text writes this length, which still reads as too long.
const lengthLimit = 1_048_576

// A table JavaScript writes once, as constant cells within the table's own range, on a grid of 1.
const tableCells = (values: readonly number[]) => {
  const range = [Math.min(...values), Math.max(...values)] as const
  return values.map(value => constant(value, range, {grid: 1}))
}

// The cells are made in a function, so that a module that imports this file and builds no program, e.g. JSON search's
// page, makes none of them when it loads.
function highlighterCells() {
  return {
    // A code point per cell, and -1 after the text.
    codePoints: list(capacity, () => input([-1, 0x10ffff], {initial: -1, grid: 1})),
    // The whole text's length in code points, up to lengthLimit. The program compares it with the capacity, so a text
    // that doesn't fit is reported as truncated.
    textLength: input([0, lengthLimit], {grid: 1}),
    tables: {
      classes: tableCells(classTable),
      lexerNext: tableCells(lexerNextTable),
      lexerEvent: tableCells(lexerEventTable),
      grammarToken: tableCells(grammarTokenTable),
      lexerErrorKind: tableCells(lexerErrorKindTable),
      depthChange: tableCells(depthChangeTable),
      // No operation reads these three tables.
      opener: tableCells(openerTable),
      closer: tableCells(closerTable),
      bracket: tableCells(bracketTable),
      objectWeight: tableCells(objectWeightTable),
      levelWeight: tableCells(levelWeightTable),
      depthClass: tableCells(depthClassTable),
      grammarNext: tableCells(grammarNextTable),
      grammarError: tableCells(grammarErrorTable),
      display: tableCells(displayTable),
    },
  }
}

// The states after every position of a state machine whose transition table is `next`, flattened as
// next[state × symbolCount + symbol], from state 0. `symbols[position]` is an index form, e.g. the class's wire.
// JS: for (const symbol of symbols) { state = next[state * symbolsPerState + symbol]; statesAfter.push(state) }
function runStateMachine(circuit: Circuit, next: readonly Wire[], symbolsPerState: number, symbols: readonly Terms[]): Wire[] {
  const statesAfter: Wire[] = []
  let state = circuit.constant(0)
  for (const symbol of symbols) {
    state = circuit.indexReadAffine([[state, symbolsPerState], ...symbol], 0, next, 'clamp', 'clamp')
    statesAfter.push(state)
  }
  return statesAfter
}

// JS: let total = 0; for (const change of changes) { totalsBefore.push(total); total += change }, with every change an
// integer.
function runningTotalsBefore(circuit: Circuit, changes: readonly Wire[]): Wire[] {
  const totalsAfter = [...changes]
  for (let index = 1; index < totalsAfter.length; index++) totalsAfter[index] = circuit.roundAffine([[totalsAfter[index - 1]!, 1], [totalsAfter[index]!, 1]])
  return [circuit.constant(0), ...totalsAfter.slice(0, -1)]
}

// A read of a one-dimensional table at an index form, with the same rule on both sides.
const read = (circuit: Circuit, terms: Terms, bias: number, candidates: readonly Wire[], outOfRange: 'clamp' | 'zero' = 'clamp') =>
  circuit.indexReadAffine(terms, bias, candidates, outOfRange, outOfRange)

// Declares a wire read from an integer table on a grid of 1, so comparisons that read it build integer bits.
const onGrid = (circuit: Circuit, wire: Wire) => {
  circuit.assumeGrid(wire, 1)
  return wire
}

export function buildHighlighter() {
  const table = createSourceTable()
  const cells = table.declare(highlighterCells())
  const circuit = table.createCircuit()
  const tables = cells.tables
  const positions = capacity + 1
  // The positions whose states come out of the loops. Position 512 gets one more read after them.
  const scanned = capacity

  // Stage 1. JS: truncated = textLength > 512, then classOf(codePoint) per cell, and end or truncatedEnd at position 512.
  const truncated = emitCompare(circuit, cells.textLength, '>', circuit.constant(capacity))
  const classes = [
    ...cells.codePoints.map(codePoint => read(circuit, [[codePoint, 1]], 1, tables.classes)),
    // 'end' is class 0 and 'truncatedEnd' class 1.
    circuit.roundAffine([[truncated, 1]]),
  ]

  // Stage 2. JS: for (const characterClass of classes) { event = lexerEvent[state][characterClass]; state = lexerNext[state][characterClass] }
  const classSymbols = classes.map((characterClass): Terms => [[characterClass, 1]])
  const lexerStatesAfter = runStateMachine(circuit, tables.lexerNext, classCount, classSymbols.slice(0, scanned))
  const lexerStatesBefore = [circuit.constant(0), ...lexerStatesAfter]
  const events = classes.map((characterClass, position) =>
    read(circuit, [[lexerStatesBefore[position]!, classCount], [characterClass, 1]], 0, tables.lexerEvent))

  // Stage 3. JS: depthBefore[position] = sum of depthChange[event] over earlier positions, where position 512 changes nothing.
  const depthChanges = events.slice(0, scanned).map(event => onGrid(circuit, read(circuit, [[event, 1]], 0, tables.depthChange)))
  const depthBefore = runningTotalsBefore(circuit, depthChanges)
  depthBefore.push(circuit.roundAffine([[depthBefore[scanned - 1]!, 1], [depthChanges[scanned - 1]!, 1]]))

  // Stage 4. JS: codeBefore[position] = sum of objectWeight[depthBefore][event] over earlier positions, and
  // inObject = codeBefore >= 2^(depth − 1). Before the first error every container is still open at its depth, so the
  // code's bits below the depth are the open containers' kinds, and the comparison reads the top bit. Position 512 only
  // reads the end or truncatedEnd class, so it needs no container kind, and the totals stop at 511 positions, whose
  // code stays within ±511 × 2^15. The difference with a level weight of up to 2^15 stays below 2^24 at positions 1 to
  // 510, where emitCompare builds integer bits, 2 operations each. At position 511 it can reach exactly 2^24, and
  // emitCompare builds a sign cascade of 17 operations, which is also exact.
  const objectWeights = events.slice(0, scanned).map((event, position) =>
    onGrid(circuit, read(circuit, [[depthBefore[position]!, eventCount], [event, 1]], 0, tables.objectWeight, 'zero')))
  const codeBefore = runningTotalsBefore(circuit, objectWeights)
  const inObject = codeBefore.map((code, position) => position === 0
    ? circuit.constant(0)
    : emitCompare(circuit, code, '>=', onGrid(circuit, read(circuit, [[depthBefore[position]!, 1]], -1, tables.levelWeight))))
  inObject.push(circuit.constant(0))
  const depthClasses = depthBefore.map(depth => read(circuit, [[depth, 1]], 0, tables.depthClass))
  const grammarTokens = events.map(event => read(circuit, [[event, 1]], 0, tables.grammarToken))
  // JS: symbol = grammarToken × 8 + depthClass × 2 + inObject
  const symbols = events.map((_, position): Terms => [[grammarTokens[position]!, contextCount], [depthClasses[position]!, 2], [inObject[position]!, 1]])

  // Stage 5. JS: for (const symbol of symbols) { grammarError = errorTable[state][symbol]; state = grammarNext[state][symbol] }
  const grammarAfter = runStateMachine(circuit, tables.grammarNext, symbolCount, symbols.slice(0, scanned))
  grammarAfter.push(circuit.indexReadAffine([[grammarAfter[scanned - 1]!, symbolCount], ...symbols[scanned]!], 0, tables.grammarNext, 'clamp', 'clamp'))
  const grammarBefore = [circuit.constant(0), ...grammarAfter.slice(0, -1)]

  // Stage 6. Every position's error kind: the lexer's kind of its event plus the grammar's kind of its step. Both are
  // read at every position, and only the one at the first error is an output.
  const errorKinds = events.map((event, position) => circuit.roundAffine([
    [read(circuit, [[event, 1]], 0, tables.lexerErrorKind), 1],
    [circuit.indexReadAffine([[grammarBefore[position]!, symbolCount], ...symbols[position]!], 0, tables.grammarError, 'clamp', 'clamp'), 1],
  ]))
  // JS: errorAfter = grammarState === 'error', a state that never goes back, so the bits read 0...0 1...1 and the
  // count of zeros is the first error's position.
  const errorState = grammarStates.indexOf('error')
  const errorAfter = grammarAfter.map(state => circuit.reglu([], 1, [[state, 1]], 1 - errorState))
  const errorFreeCount = circuit.roundAffine(errorAfter.map(bit => [bit, -1] as const), positions)
  const valid = circuit.roundAffine([[errorAfter[positions - 1]!, -1]], 1)
  const firstErrorPosition = circuit.roundAffine([[errorFreeCount, 1], [valid, -(positions + 1)]])
  const firstErrorKind = onGrid(circuit, circuit.indexRead(errorFreeCount, errorKinds, {outOfRange: 'zero'}))

  // JS: displayKind[event][grammarAfter] per cell.
  const displayKinds = events.slice(0, capacity).map((event, position) =>
    read(circuit, [[event, grammarStateCount], [grammarAfter[position]!, 1]], 0, tables.display))

  const output = {displayKinds, firstErrorPosition, firstErrorKind, valid, truncated}
  return {cells, output, ...table.finish()}
}

type HighlighterProgram = ReturnType<typeof buildHighlighter>

// Writes the text's first 512 code points, -1 after them, and the text's length.
export function writeText(cells: HighlighterProgram['cells'], source: Float32Array, text: string) {
  let length = 0
  for (const character of text) {
    if (length < capacity) source[cells.codePoints[length]!] = character.codePointAt(0)!
    length++
  }
  for (let index = Math.min(length, capacity); index < capacity; index++) source[cells.codePoints[index]!] = -1
  source[cells.textLength] = Math.min(length, lengthLimit)
}
