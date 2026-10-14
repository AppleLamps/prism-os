// The highlighter as one plain JavaScript loop over the same tables the program reads (src/json-search/highlighter/tables.ts), as
// typed arrays: the fastest plain JavaScript baseline here for a display kind per character and the first error.
// tests/json-search/highlighter/reference.ts, the other baseline, is a hand-written scanner and parser that was written to be
// read, not to be fast. Like the batch programs, this loop leaves out the bracket at the caret.
//
// Where the program keeps the container kinds as running totals of ±2^depth, the loop keeps one bit per depth, and it
// stops running the grammar at the first error, which the program can't.
import {capacity, displayKind} from './highlighter/kinds.ts'
import {
  classCount, classTable, contextCount, depthChangeTable, depthClassTable, displayTable, eventCount, grammarErrorTable, grammarNextTable,
  grammarStateCount, grammarStates, grammarTokenTable, lexerErrorKindTable, lexerEventTable, lexerNextTable, objectWeightTable, symbolCount,
} from './highlighter/tables.ts'

const classes = Uint8Array.from(classTable)
const lexerNext = Uint8Array.from(lexerNextTable)
const lexerEvent = Uint8Array.from(lexerEventTable)
const grammarToken = Uint8Array.from(grammarTokenTable)
const lexerErrorKind = Uint8Array.from(lexerErrorKindTable)
const depthChange = Int8Array.from(depthChangeTable)
const depthClass = Uint8Array.from(depthClassTable)
const grammarNext = Uint8Array.from(grammarNextTable)
const grammarError = Uint8Array.from(grammarErrorTable)
const display = Uint8Array.from(displayTable)
const errorState = grammarStates.indexOf('error')
// The event of an opening brace: the one whose object weight at depth 0 is 2^0.
const openObjectEvent = objectWeightTable.slice(0, eventCount).indexOf(1)
const otherClass = classes[128]!
if (openObjectEvent < 0) throw new Error('the tables have another form than this loop expects')

// The last call's results. firstErrorPosition is -1 for a valid text.
export const tableLoopResult = {firstErrorPosition: -1, firstErrorKind: 0, truncated: 0}

// Writes the display kinds of the text's first 512 code points at kinds[kindsOffset], pastEnd after the text, and sets
// tableLoopResult.
export function highlightWithTables(text: string, kinds: Uint8Array, kindsOffset: number) {
  const unitCount = text.length
  let unit = 0
  let lexerState = 0
  let grammarState = 0
  let depth = 0
  // Bit d is 1 when the container opened at depth d is an object. The depth stays below 16 before the first error.
  let containerBits = 0
  let firstErrorPosition = -1
  let firstErrorKind = 0
  let truncated = 0
  let position = 0
  for (; ; position++) {
    // Class 0 is the end of the text, and class 1 the 513th code point of a longer text.
    let characterClass = 0
    const ended = unit >= unitCount
    if (!ended) {
      if (position === capacity) {
        characterClass = 1
        truncated = 1
      } else {
        const codeUnit = text.charCodeAt(unit++)
        if (codeUnit < 128) {
          characterClass = classes[codeUnit + 1]!
        } else {
          characterClass = otherClass
          // A surrogate pair is one code point.
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && unit < unitCount) {
            const low = text.charCodeAt(unit)
            if (low >= 0xdc00 && low <= 0xdfff) unit++
          }
        }
      }
    }
    const lexerIndex = lexerState * classCount + characterClass
    const event = lexerEvent[lexerIndex]!
    lexerState = lexerNext[lexerIndex]!
    if (grammarState !== errorState) {
      const inObject = depth > 0 ? (containerBits >>> (depth - 1)) & 1 : 0
      const grammarIndex = grammarState * symbolCount + grammarToken[event]! * contextCount + depthClass[depth]! * 2 + inObject
      grammarState = grammarNext[grammarIndex]!
      if (grammarState === errorState) {
        firstErrorPosition = position
        firstErrorKind = lexerErrorKind[event]! + grammarError[grammarIndex]!
      } else {
        const change = depthChange[event]!
        if (change === 1) containerBits = event === openObjectEvent ? containerBits | (1 << depth) : containerBits & ~(1 << depth)
        depth += change
      }
    }
    if (ended || position === capacity) break
    kinds[kindsOffset + position] = display[event * grammarStateCount + grammarState]!
  }
  for (; position < capacity; position++) kinds[kindsOffset + position] = displayKind.pastEnd
  tableLoopResult.firstErrorPosition = firstErrorPosition
  tableLoopResult.firstErrorKind = firstErrorKind
  tableLoopResult.truncated = truncated
}
