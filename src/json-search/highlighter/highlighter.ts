// A JSON highlighter as one numeric program. JavaScript writes up to `capacity` code points, e.g. 512, the text's
// length and the caret into cells, and the program computes, for every code point, what it's shown as, then the first
// error's position and kind, whether the text is too long, whether the first error is nesting past the maximum depth,
// and the bracket that matches the bracket at the caret. The capacity and the maximum depth are parameters of
// buildHighlighter, and the numbers in the comments below are for the defaults, 512 and 16.
//
// The stages, each over 513 positions, where position 512 is the end of the text, or the 513th code point of a longer
// text:
// 1. A character class per position, read from a table of 129 cells (patterns.md, "A loop over data that rarely changes").
// 2. The tokenizer's state before every position, as a loop of one index read per position, or as a prefix scan over
//    transition tables (patterns.md, "A state machine over queued events"). Then the event per position, e.g.
//    stringStart or badNumber, as one read at (state before, class).
// 3. Depth before every position as running totals of +1 and −1 (patterns.md, "Running totals").
// 4. The container kinds as one integer, running totals of ±2^depth for braces, and the kind at the current depth as one
//    comparison with 2^(depth − 1) (expressions.md, "a >= b" on grids). It's exact before the first error, the only
//    place the grammar reads it.
// 5. The grammar between tokens, a state machine of 8 states over (token, depth class, container kind), as a loop or a
//    prefix scan like stage 2.
// 6. Outputs: the first error as a count of positions before the grammar's error state (patterns.md, "findIndex when
//    the test flips once along the items"), its kind as one read at that count, and the matching bracket as a first
//    hit among depth comparisons (patterns.md, "findIndex when passing items can be anywhere").
import {type Circuit, type Terms, type Wire, emitCompare, invariant} from '../../runtime/numeric-ui-core.ts'
import {type WireValues, constant, createSourceTable, input, list} from '../../runtime/cells.ts'
import {brentKungPrefix, sklanskyPrefix} from '../../runtime/prefix-networks.ts'
import {type Limits, defaultLimits, errorKind} from './kinds.ts'
import {
  bracketTable, classCount, classTable, closerTable, contextCount, depthChangeTable, depthTables, displayTable, eventCount,
  grammarErrorTable, grammarNextTable, grammarStateCount, grammarStates, grammarTokenTable, lexerErrorKindTable,
  lexerEventTable, lexerNextTable, lexerStateCount, openerTable, symbolCount,
} from './tables.ts'

// The largest text length the host writes. A longer text writes this length, which still reads as too long.
const lengthLimit = 1_048_576

// A table JavaScript writes once, as constant cells within the table's own range, on a grid of 1.
const tableCells = (values: readonly number[]) => {
  const range = [Math.min(...values), Math.max(...values)] as const
  return values.map(value => constant(value, range, {grid: 1}))
}

function highlighterCells({capacity, maximumDepth}: Limits) {
  const {objectWeight, levelWeight, depthClass} = depthTables(maximumDepth)
  return {
    // A code point per cell, and -1 after the text.
    codePoints: list(capacity, () => input([-1, 0x10ffff], {initial: -1, grid: 1})),
    // The whole text's length in code points, up to lengthLimit. The program compares it with the capacity, so a text
    // that doesn't fit is reported as truncated.
    textLength: input([0, lengthLimit], {grid: 1}),
    // The caret as a code point index, clamped to 0..513. A caret at 513 or further is past code point 512, so neither
    // the code point before it nor the one at it is in the cells, and no bracket is at the caret.
    caret: input([0, capacity + 1], {grid: 1}),
    tables: {
      classes: tableCells(classTable),
      lexerNext: tableCells(lexerNextTable),
      lexerEvent: tableCells(lexerEventTable),
      grammarToken: tableCells(grammarTokenTable),
      lexerErrorKind: tableCells(lexerErrorKindTable),
      depthChange: tableCells(depthChangeTable),
      opener: tableCells(openerTable),
      closer: tableCells(closerTable),
      bracket: tableCells(bracketTable),
      objectWeight: tableCells(objectWeight),
      levelWeight: tableCells(levelWeight),
      depthClass: tableCells(depthClass),
      grammarNext: tableCells(grammarNextTable),
      grammarError: tableCells(grammarErrorTable),
      display: tableCells(displayTable),
    },
  }
}

// 'loop' carries each state machine's state and each running total from one position to the next. 'brent-kung' and
// 'sklansky' build the same stages as prefix networks, with the same outputs.
export type ScanForm = 'loop' | 'brent-kung' | 'sklansky'
export const scanForms: readonly ScanForm[] = ['loop', 'brent-kung', 'sklansky']

// The loop: every prefix combines the previous prefix with the next item, a chain of k − 1 combines.
function chainPrefix<T>(items: readonly T[], combine: (earlier: T, later: T) => T): T[] {
  const prefixes = [...items]
  for (let index = 1; index < prefixes.length; index++) prefixes[index] = combine(prefixes[index - 1]!, prefixes[index]!)
  return prefixes
}

const networks = {'loop': chainPrefix, 'brent-kung': brentKungPrefix, 'sklansky': sklanskyPrefix} as const

// The states after every position of a state machine whose transition table is `next`, flattened as
// next[state × symbolCount + symbol], from state 0. `symbols[position]` is an index form, e.g. the class's wire.
function runStateMachine(circuit: Circuit, form: ScanForm, next: readonly Wire[], stateCount: number, symbolsPerState: number, symbols: readonly Terms[]): Wire[] {
  if (form === 'loop') {
    // JS: for (const symbol of symbols) { state = next[state * symbolsPerState + symbol]; statesAfter.push(state) }
    const statesAfter: Wire[] = []
    let state = circuit.constant(0)
    for (const symbol of symbols) {
      state = circuit.indexReadAffine([[state, symbolsPerState], ...symbol], 0, next, 'clamp', 'clamp')
      statesAfter.push(state)
    }
    return statesAfter
  }
  // Each position as a table from state to next state, S reads in the first layer. Two positions combine as
  // later[earlier[state]], one read per state, and each prefix, read at state 0, is the state after that position.
  const positionTables = symbols.map(symbol => Array.from({length: stateCount}, (_, state) =>
    circuit.indexReadAffine(symbol, state * symbolsPerState, next, 'clamp', 'clamp')))
  const prefixes = networks[form](positionTables, (earlier, later) => earlier.map(middle => circuit.indexRead(middle, later)))
  return prefixes.map(prefix => prefix[0]!)
}

// JS: let total = 0; for (const change of changes) { totalsBefore.push(total); total += change }, with every change an
// integer, so any grouping of the additions gives the same totals.
function runningTotalsBefore(circuit: Circuit, form: ScanForm, changes: readonly Wire[]): Wire[] {
  const totalsAfter = networks[form](changes, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]))
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

export function buildHighlighter(form: ScanForm = 'loop', limits: Limits = defaultLimits) {
  const {capacity, maximumDepth} = limits
  invariant(Number.isInteger(capacity) && capacity >= 1 && capacity < lengthLimit, `the capacity must be an integer from 1 to ${lengthLimit - 1}, got ${capacity}`)
  // At depth 1 the same table entry would have to mean both "inside a top-level container" and "at the maximum depth".
  // Past depth 24 the container kinds no longer fit in one FP32 integer, e.g. 2^24 + 1 rounds to 2^24.
  invariant(Number.isInteger(maximumDepth) && maximumDepth >= 2 && maximumDepth <= 24, `the maximum depth must be an integer from 2 to 24, got ${maximumDepth}`)
  const table = createSourceTable()
  const cells = table.declare(highlighterCells(limits))
  const circuit = table.createCircuit()
  const tables = cells.tables
  const positions = capacity + 1
  // The positions whose states come out of the scan: a power of two by default, so the prefix networks have their
  // usual shapes. Position 512 gets one more read after the scan.
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
  const lexerStatesAfter = runStateMachine(circuit, form, tables.lexerNext, lexerStateCount, classCount, classSymbols.slice(0, scanned))
  const lexerStatesBefore = [circuit.constant(0), ...lexerStatesAfter]
  const events = classes.map((characterClass, position) =>
    read(circuit, [[lexerStatesBefore[position]!, classCount], [characterClass, 1]], 0, tables.lexerEvent))

  // Stage 3. JS: depthBefore[position] = sum of depthChange[event] over earlier positions, where position 512 changes nothing.
  const depthChanges = events.slice(0, scanned).map(event => onGrid(circuit, read(circuit, [[event, 1]], 0, tables.depthChange)))
  const depthBefore = runningTotalsBefore(circuit, form, depthChanges)
  depthBefore.push(circuit.roundAffine([[depthBefore[scanned - 1]!, 1], [depthChanges[scanned - 1]!, 1]]))

  // Stage 4. JS: codeBefore[position] = sum of objectWeight[depthBefore][event] over earlier positions, and
  // inObject = codeBefore >= 2^(depth − 1). Before the first error every container is still open at its depth, so the
  // code's bits below the depth are the open containers' kinds, and the comparison reads the top bit. Position 512 only
  // reads the end or truncatedEnd class, so it needs no container kind, and the totals stop at 511 positions, whose
  // code stays within ±511 × 2^15. The difference with a level weight of up to 2^15 stays below 2^24 at positions 1 to
  // 510, where emitCompare builds integer bits, 2 operations each. At position 511 it can reach exactly 2^24, and
  // emitCompare builds a sign cascade of 17 operations, which is also exact. The tests count both constructions with
  // circuit.roundingPoints(). With other limits, every comparison is an integer bit while capacity × 2^(maximumDepth − 1)
  // is below 2^24, e.g. 2,048 code points at depth 13. Past that, the positions from 2^(25 − maximumDepth) − 1 on get
  // sign cascades, e.g. 1,537 of the 2,047 comparisons at 2,048 code points and depth 16, with the same outputs.
  const objectWeights = events.slice(0, scanned).map((event, position) =>
    onGrid(circuit, read(circuit, [[depthBefore[position]!, eventCount], [event, 1]], 0, tables.objectWeight, 'zero')))
  const codeBefore = runningTotalsBefore(circuit, form, objectWeights)
  const inObject = codeBefore.map((code, position) => position === 0
    ? circuit.constant(0)
    : emitCompare(circuit, code, '>=', onGrid(circuit, read(circuit, [[depthBefore[position]!, 1]], -1, tables.levelWeight))))
  inObject.push(circuit.constant(0))
  const depthClasses = depthBefore.map(depth => read(circuit, [[depth, 1]], 0, tables.depthClass))
  const grammarTokens = events.map(event => read(circuit, [[event, 1]], 0, tables.grammarToken))
  // JS: symbol = grammarToken × 8 + depthClass × 2 + inObject
  const symbols = events.map((_, position): Terms => [[grammarTokens[position]!, contextCount], [depthClasses[position]!, 2], [inObject[position]!, 1]])

  // Stage 5. JS: for (const symbol of symbols) { grammarError = errorTable[state][symbol]; state = grammarNext[state][symbol] }
  const grammarAfter = runStateMachine(circuit, form, tables.grammarNext, grammarStateCount, symbolCount, symbols.slice(0, scanned))
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
  // JS: depthExceeded = firstErrorKind === tooDeep, so it's 1 when the first error is an opening bracket at depth 16.
  // An earlier error hides nesting past the maximum depth, e.g. x followed by 17 [ gives unexpectedCharacter and 0.
  const depthExceeded = emitCompare(circuit, firstErrorKind, '===', circuit.constant(errorKind.tooDeep))

  // JS: displayKind[event][grammarAfter] per cell.
  const displayKinds = events.slice(0, capacity).map((event, position) =>
    read(circuit, [[event, grammarStateCount], [grammarAfter[position]!, 1]], 0, tables.display))

  // The bracket at the caret: the character before the caret when it's a bracket, otherwise the character at the caret.
  const bracketBefore = onGrid(circuit, read(circuit, [[read(circuit, [[cells.caret, 1]], -1, events, 'zero'), 1]], 0, tables.bracket))
  const bracketPosition = circuit.roundAffine([[cells.caret, 1], [bracketBefore, -1]])
  const eventAtBracket = read(circuit, [[bracketPosition, 1]], 0, events, 'zero')
  const isOpener = onGrid(circuit, read(circuit, [[eventAtBracket, 1]], 0, tables.opener))
  const isCloser = onGrid(circuit, read(circuit, [[eventAtBracket, 1]], 0, tables.closer))
  const hasBracket = circuit.roundAffine([[isOpener, 1], [isCloser, 1]])
  // Brackets pair by depth. An opener's match is the closer just before the first later position whose depth before it
  // is at most the opener's depth before it, and a closer's match is the last earlier position whose depth before it is
  // below the closer's. JS: threshold = depthBefore[bracket] − (isCloser ? 1 : 0)
  const threshold = circuit.roundAffine([[onGrid(circuit, read(circuit, [[bracketPosition, 1]], 0, depthBefore)), 1], [isCloser, -1]])
  const all = (bits: Wire[]) => circuit.reglu([], 1, bits.map(bit => [bit, 1] as const), 1 - bits.length)
  // A hit is a position at or below the threshold, after an opener or before a closer. At most one of isOpener and
  // isCloser is 1, so every hit belongs to one direction.
  const hits = depthBefore.map((depth, position) => {
    const shallow = emitCompare(circuit, depth, '<=', threshold)
    const index = circuit.constant(position)
    return circuit.roundAffine([
      [all([shallow, isOpener, emitCompare(circuit, bracketPosition, '<', index)]), 1],
      [all([shallow, isCloser, emitCompare(circuit, index, '<', bracketPosition)]), 1],
    ])
  })
  // JS: hitsThrough[position] = the hits up to and including the position. The bits [hitsThrough < 1] and
  // [hitsThrough < totalHits] read 1...1 0...0, so their counts are the positions of the first hit and of the last hit.
  const hitsThrough = networks[form](hits, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]))
  const totalHits = hitsThrough.at(-1)!
  const noHitsThrough = hitsThrough.map(count => circuit.reglu([], 1, [[count, -1]], 1))
  const firstHit = circuit.roundAffine(noHitsThrough.map(bit => [bit, 1] as const))
  const lastHit = circuit.roundAffine(hitsThrough.map(count => [emitCompare(circuit, count, '<', totalHits), 1] as const))
  const found = circuit.roundAffine([[noHitsThrough.at(-1)!, -1]], 1)
  // JS: matchingBracket = !found ? -1 : isOpener ? firstHit - 1 : lastHit
  const matchedPosition = circuit.roundAffine([[circuit.multiply(isOpener, firstHit), 1], [isOpener, -1], [circuit.multiply(isCloser, lastHit), 1]], 1)
  const matchingBracket = circuit.roundAffine([[circuit.multiply(found, matchedPosition), 1]], -1)
  const caretBracket = circuit.roundAffine([[circuit.multiply(hasBracket, circuit.roundAffine([[bracketPosition, 1]], 1)), 1]], -1)

  const output = {displayKinds, firstErrorPosition, firstErrorKind, valid, truncated, depthExceeded, caretBracket, matchingBracket}
  // Wires between stages, for measuring a stage on its own.
  const stages = {events, grammarAfter}
  return {cells, limits, output, stages, ...table.finish()}
}

type HighlighterProgram = ReturnType<typeof buildHighlighter>
/** @public */
export type HighlighterOutput = WireValues<HighlighterProgram['output']>

// Writes the text's first 512 code points, -1 after them, the text's length and the caret, a code point index clamped to
// 0..513.
export function writeText(cells: HighlighterProgram['cells'], source: Float32Array, text: string, caret: number) {
  const capacity = cells.codePoints.length
  let length = 0
  for (const character of text) {
    if (length < capacity) source[cells.codePoints[length]!] = character.codePointAt(0)!
    length++
  }
  for (let index = Math.min(length, capacity); index < capacity; index++) source[cells.codePoints[index]!] = -1
  source[cells.textLength] = Math.min(length, lengthLimit)
  source[cells.caret] = Math.min(Math.max(0, caret), capacity + 1)
}

// The host: writes the text and the caret, checks every cell against its declaration, runs the program, and returns
// the outputs. The program keeps no state, so it's compiled for its outputs only, once. The tests in
// tests/json-search/highlighter run every form of the program through this host.
/** @public */
export function createHighlighterMachine(form: ScanForm = 'loop', limits: Limits = defaultLimits) {
  const built = buildHighlighter(form, limits)
  const {capacity} = limits
  const {output} = built
  const program = built.circuit.compileTensorProgram([
    ...output.displayKinds, output.firstErrorPosition, output.firstErrorKind, output.valid, output.truncated, output.depthExceeded,
    output.caretBracket, output.matchingBracket,
  ])
  const evaluate = built.circuit.createTensorProgramEvaluator(program)
  const source = new Float32Array(built.initialSource)
  return {
    built,
    source,
    run(text: string, caret: number): HighlighterOutput {
      writeText(built.cells, source, text, caret)
      built.validate(source)
      // The values are in the order of the roots above, in an array that the next call overwrites.
      const values = evaluate(source)
      for (const value of values) {
        // The message is built only when the check fails, not once per output.
        if (!Number.isFinite(value)) invariant(false, `every output must be finite, got ${value}`)
      }
      return {
        displayKinds: Array.from(values.subarray(0, capacity)),
        firstErrorPosition: values[capacity]!,
        firstErrorKind: values[capacity + 1]!,
        valid: values[capacity + 2]!,
        truncated: values[capacity + 3]!,
        depthExceeded: values[capacity + 4]!,
        caretBracket: values[capacity + 5]!,
        matchingBracket: values[capacity + 6]!,
      }
    },
  }
}
