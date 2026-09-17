// The tables that JavaScript writes into the program's source table once: a character class per code point, the
// tokenizer's transition and event tables, small tables per event, and the grammar's transition and error tables.
// Each table comes from a transition function written from JSON's grammar (RFC 8259) and the rules in kinds.ts, e.g.
// lexerStep(state, characterClass). reference.ts implements the same rules as a hand-written scanner and parser,
// without these tables, and highlighter.test.ts compares the two.
import {displayKind, errorKind, maximumDepth} from './kinds.ts'

// Character classes. Letters that matter to one or more tokens get their own class, e.g. `e` is a hex digit, an
// exponent and a letter of true and false. Every code point from U+0080 up, and U+007F, is `other`, which is only
// allowed inside strings. `end` marks a cell after the text, and `truncatedEnd` the position after the 512th code point
// when the text is longer.
export const characterClasses = [
  'end', 'truncatedEnd', 'space', 'tabOrCarriageReturn', 'lineFeed', 'control', 'quote', 'backslash', 'slash',
  'openBrace', 'closeBrace', 'openBracket', 'closeBracket', 'colon', 'comma', 'minus', 'plus', 'dot', 'zero', 'digit',
  'a', 'b', 'e', 'capitalE', 'f', 'l', 'n', 'r', 's', 't', 'u', 'otherHexLetter', 'other',
] as const
export type CharacterClass = typeof characterClasses[number]
export const classCount = characterClasses.length
const classIndex = (name: CharacterClass) => characterClasses.indexOf(name)

// The class of a code point below U+0080. The program reads classOfAscii[codePoint + 1], where entry 0 is `end` for the
// empty cell value -1, and a code point past the table clamps to its last entry, U+007F, which is `other`.
export function classOfCodePoint(codePoint: number): CharacterClass {
  if (codePoint === -1) return 'end'
  if (codePoint === 0x20) return 'space'
  if (codePoint === 0x09 || codePoint === 0x0d) return 'tabOrCarriageReturn'
  if (codePoint === 0x0a) return 'lineFeed'
  if (codePoint < 0x20) return 'control'
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint === 0x30 ? 'zero' : 'digit'
  const character = String.fromCodePoint(codePoint)
  const punctuation: {[character: string]: CharacterClass} = {
    '"': 'quote', '\\': 'backslash', '/': 'slash', '{': 'openBrace', '}': 'closeBrace', '[': 'openBracket',
    ']': 'closeBracket', ':': 'colon', ',': 'comma', '-': 'minus', '+': 'plus', '.': 'dot', 'E': 'capitalE',
  }
  const named = punctuation[character]
  if (named !== undefined) return named
  if ('abeflnrstu'.includes(character)) return character as CharacterClass
  if ('cdABCDF'.includes(character)) return 'otherHexLetter'
  return 'other'
}

export const classTable: readonly number[] = Array.from({length: 129}, (_, entry) => classIndex(classOfCodePoint(entry - 1)))

// Tokenizer states. `hex4` expects 4 more hex digits of a \u escape, and `hex1` the last one. `t`, `tr` and `tru` are
// the letters of true read so far. `errorLine` follows a lexer error up to the next line feed, where tokenizing starts
// again, so later lines keep their colors.
export const lexerStates = [
  'between', 'string', 'escape', 'hex4', 'hex3', 'hex2', 'hex1', 'minus', 'zero', 'integer', 'dot', 'fraction',
  'exponent', 'exponentSign', 'exponentDigits', 't', 'tr', 'tru', 'f', 'fa', 'fal', 'fals', 'n', 'nu', 'nul', 'errorLine',
] as const
export type LexerState = typeof lexerStates[number]
export const lexerStateCount = lexerStates.length

// What one character does, from the tokenizer state before it and its class.
export const lexerEvents = [
  'whitespace', 'stringStart', 'stringContent', 'stringEnd', 'escape', 'numberStart', 'numberContent', 'literalStart',
  'literalContent', 'openObject', 'openArray', 'closeObject', 'closeArray', 'colon', 'comma', 'unexpectedCharacter',
  'controlCharacterInString', 'badEscape', 'badUnicodeEscape', 'badNumber', 'badLiteral', 'errorContinuation', 'end',
  'endInsideToken', 'truncatedEnd',
] as const
export type LexerEvent = typeof lexerEvents[number]
export const eventCount = lexerEvents.length

type Step = readonly [next: LexerState, event: LexerEvent]

const isDigit = (characterClass: CharacterClass) => characterClass === 'zero' || characterClass === 'digit'
const isHexDigit = (characterClass: CharacterClass) =>
  isDigit(characterClass) || ['a', 'b', 'e', 'capitalE', 'f', 'otherHexLetter'].includes(characterClass)

// A lexer error at a character. A line feed starts tokenizing again right away, and any other character starts an
// error line.
const lexerError = (characterClass: CharacterClass, event: LexerEvent): Step =>
  [characterClass === 'lineFeed' ? 'between' : 'errorLine', event]

// A character that starts a token, or whitespace between tokens.
function startToken(characterClass: CharacterClass): Step {
  switch (characterClass) {
    case 'space': case 'tabOrCarriageReturn': case 'lineFeed': return ['between', 'whitespace']
    case 'quote': return ['string', 'stringStart']
    case 'openBrace': return ['between', 'openObject']
    case 'closeBrace': return ['between', 'closeObject']
    case 'openBracket': return ['between', 'openArray']
    case 'closeBracket': return ['between', 'closeArray']
    case 'colon': return ['between', 'colon']
    case 'comma': return ['between', 'comma']
    case 'minus': return ['minus', 'numberStart']
    case 'zero': return ['zero', 'numberStart']
    case 'digit': return ['integer', 'numberStart']
    case 't': return ['t', 'literalStart']
    case 'f': return ['f', 'literalStart']
    case 'n': return ['n', 'literalStart']
    case 'end': return ['between', 'end']
    case 'truncatedEnd': return ['between', 'truncatedEnd']
    case 'control': case 'backslash': case 'slash': case 'plus': case 'dot': case 'a': case 'b': case 'e':
    case 'capitalE': case 'l': case 'r': case 's': case 'u': case 'otherHexLetter': case 'other':
      return lexerError(characterClass, 'unexpectedCharacter')
  }
}

// Inside a token that isn't complete yet, e.g. after `-` or `tr`: the end of the text is unexpectedEnd, the 513th code
// point is tooLong, and every other character that doesn't continue the token is an error of the given kind.
function continueOr(characterClass: CharacterClass, continued: Step | null, error: LexerEvent): Step {
  if (continued !== null) return continued
  if (characterClass === 'end') return ['between', 'endInsideToken']
  if (characterClass === 'truncatedEnd') return ['between', 'truncatedEnd']
  return lexerError(characterClass, error)
}

// A letter of a literal: `expected` continues to `next`, where `between` means the literal is complete.
const literalLetter = (characterClass: CharacterClass, expected: CharacterClass, next: LexerState): Step =>
  continueOr(characterClass, characterClass === expected ? [next, 'literalContent'] : null, 'badLiteral')

export function lexerStep(state: LexerState, characterClass: CharacterClass): Step {
  const digit = isDigit(characterClass)
  const exponentLetter = characterClass === 'e' || characterClass === 'capitalE'
  switch (state) {
    case 'between': return startToken(characterClass)
    case 'string': {
      if (characterClass === 'quote') return ['between', 'stringEnd']
      if (characterClass === 'backslash') return ['escape', 'escape']
      const isControl = characterClass === 'control' || characterClass === 'tabOrCarriageReturn' || characterClass === 'lineFeed'
      return continueOr(characterClass, isControl || characterClass === 'end' || characterClass === 'truncatedEnd' ? null : ['string', 'stringContent'], 'controlCharacterInString')
    }
    case 'escape': {
      const simple = ['quote', 'backslash', 'slash', 'b', 'f', 'n', 'r', 't'].includes(characterClass)
      return continueOr(characterClass, simple ? ['string', 'escape'] : characterClass === 'u' ? ['hex4', 'escape'] : null, 'badEscape')
    }
    case 'hex4': case 'hex3': case 'hex2': case 'hex1': {
      const next: LexerState = state === 'hex4' ? 'hex3' : state === 'hex3' ? 'hex2' : state === 'hex2' ? 'hex1' : 'string'
      return continueOr(characterClass, isHexDigit(characterClass) ? [next, 'escape'] : null, 'badUnicodeEscape')
    }
    case 'minus':
      return continueOr(characterClass, characterClass === 'zero' ? ['zero', 'numberContent'] : characterClass === 'digit' ? ['integer', 'numberContent'] : null, 'badNumber')
    case 'zero':
      if (digit) return lexerError(characterClass, 'badNumber')
      if (characterClass === 'dot') return ['dot', 'numberContent']
      if (exponentLetter) return ['exponent', 'numberContent']
      return startToken(characterClass)
    case 'integer':
      if (digit) return ['integer', 'numberContent']
      if (characterClass === 'dot') return ['dot', 'numberContent']
      if (exponentLetter) return ['exponent', 'numberContent']
      return startToken(characterClass)
    case 'dot': return continueOr(characterClass, digit ? ['fraction', 'numberContent'] : null, 'badNumber')
    case 'fraction':
      if (digit) return ['fraction', 'numberContent']
      if (exponentLetter) return ['exponent', 'numberContent']
      return startToken(characterClass)
    case 'exponent': {
      const sign = characterClass === 'plus' || characterClass === 'minus'
      return continueOr(characterClass, sign ? ['exponentSign', 'numberContent'] : digit ? ['exponentDigits', 'numberContent'] : null, 'badNumber')
    }
    case 'exponentSign': return continueOr(characterClass, digit ? ['exponentDigits', 'numberContent'] : null, 'badNumber')
    case 'exponentDigits': return digit ? ['exponentDigits', 'numberContent'] : startToken(characterClass)
    case 't': return literalLetter(characterClass, 'r', 'tr')
    case 'tr': return literalLetter(characterClass, 'u', 'tru')
    case 'tru': return literalLetter(characterClass, 'e', 'between')
    case 'f': return literalLetter(characterClass, 'a', 'fa')
    case 'fa': return literalLetter(characterClass, 'l', 'fal')
    case 'fal': return literalLetter(characterClass, 's', 'fals')
    case 'fals': return literalLetter(characterClass, 'e', 'between')
    case 'n': return literalLetter(characterClass, 'u', 'nu')
    case 'nu': return literalLetter(characterClass, 'l', 'nul')
    case 'nul': return literalLetter(characterClass, 'l', 'between')
    case 'errorLine':
      if (characterClass === 'lineFeed') return ['between', 'whitespace']
      if (characterClass === 'end') return ['between', 'end']
      if (characterClass === 'truncatedEnd') return ['between', 'truncatedEnd']
      return ['errorLine', 'errorContinuation']
  }
}

// lexerNext[state × classCount + class] and lexerEvent[state × classCount + class].
export const lexerNextTable: readonly number[] = lexerStates.flatMap(state =>
  characterClasses.map(characterClass => lexerStates.indexOf(lexerStep(state, characterClass)[0])))
export const lexerEventTable: readonly number[] = lexerStates.flatMap(state =>
  characterClasses.map(characterClass => lexerEvents.indexOf(lexerStep(state, characterClass)[1])))

// What the grammar sees of an event: nothing, the start of a string or of a number or literal, a punctuation mark, a
// lexer error, or the end of the text.
export const grammarTokens = ['none', 'string', 'scalar', 'openObject', 'openArray', 'closeObject', 'closeArray', 'colon', 'comma', 'lexerError', 'end'] as const
export type GrammarToken = typeof grammarTokens[number]

export function grammarTokenOf(event: LexerEvent): GrammarToken {
  switch (event) {
    case 'whitespace': case 'stringContent': case 'stringEnd': case 'escape': case 'numberContent': case 'literalContent': return 'none'
    case 'stringStart': return 'string'
    case 'numberStart': case 'literalStart': return 'scalar'
    case 'openObject': case 'openArray': case 'closeObject': case 'closeArray': case 'colon': case 'comma': return event
    case 'unexpectedCharacter': case 'controlCharacterInString': case 'badEscape': case 'badUnicodeEscape': case 'badNumber':
    case 'badLiteral': case 'errorContinuation': case 'endInsideToken': case 'truncatedEnd': return 'lexerError'
    case 'end': return 'end'
  }
}

// The error kind a lexer event reports, which the program adds to the grammar's error kind. errorContinuation only
// follows an earlier lexer error, so it reports nothing.
export function lexerErrorKindOf(event: LexerEvent): number {
  switch (event) {
    case 'unexpectedCharacter': case 'controlCharacterInString': case 'badEscape': case 'badUnicodeEscape': case 'badNumber': case 'badLiteral':
      return errorKind[event]
    case 'endInsideToken': return errorKind.unexpectedEnd
    case 'truncatedEnd': return errorKind.tooLong
    case 'whitespace': case 'stringStart': case 'stringContent': case 'stringEnd': case 'escape': case 'numberStart':
    case 'numberContent': case 'literalStart': case 'literalContent': case 'openObject': case 'openArray': case 'closeObject':
    case 'closeArray': case 'colon': case 'comma': case 'errorContinuation': case 'end':
      return errorKind.none
  }
}

export const grammarTokenTable: readonly number[] = lexerEvents.map(event => grammarTokens.indexOf(grammarTokenOf(event)))
export const lexerErrorKindTable: readonly number[] = lexerEvents.map(lexerErrorKindOf)
export const depthChangeTable: readonly number[] = lexerEvents.map(event =>
  event === 'openObject' || event === 'openArray' ? 1 : event === 'closeObject' || event === 'closeArray' ? -1 : 0)
export const openerTable: readonly number[] = lexerEvents.map(event => Number(event === 'openObject' || event === 'openArray'))
export const closerTable: readonly number[] = lexerEvents.map(event => Number(event === 'closeObject' || event === 'closeArray'))
export const bracketTable: readonly number[] = lexerEvents.map((_, index) => openerTable[index]! + closerTable[index]!)

// The container kinds as one integer, before the first error: bit d − 1 is 1 when the container at depth d is an object.
// An opening brace at depth d − 1 adds 2^(d − 1), and a closing brace at depth d subtracts it, so
// objectWeight[depthBefore × eventCount + event] is 2^depthBefore for `{` and −2^(depthBefore − 1) for `}`. Depths
// outside 0..16 read 0.
export const objectWeightTable: readonly number[] = Array.from({length: (maximumDepth + 1) * eventCount}, (_, entry) => {
  const depthBefore = Math.floor(entry / eventCount)
  const event = lexerEvents[entry % eventCount]!
  if (event === 'openObject' && depthBefore < maximumDepth) return 2 ** depthBefore
  if (event === 'closeObject' && depthBefore >= 1) return -(2 ** (depthBefore - 1))
  return 0
})
// levelWeight[depth − 1] is 2^(depth − 1), the bit of the container at that depth, e.g. 1 for a top-level container.
export const levelWeightTable: readonly number[] = Array.from({length: maximumDepth}, (_, level) => 2 ** level)
// depthClass[depth]: 0 at the top level, 1 inside a top-level container, 2 deeper, and 3 at the maximum depth, where an
// opening bracket is tooDeep. Depths past the table clamp to its ends.
export const depthClassTable: readonly number[] = Array.from({length: maximumDepth + 1}, (_, depth) =>
  depth === 0 ? 0 : depth === 1 ? 1 : depth === maximumDepth ? 3 : 2)
export const depthClassCount = 4
// The grammar's context for a character: depthClass × 2 + [the container at the current depth is an object].
export const contextCount = depthClassCount * 2

// Grammar states: what may come next. The initial state is `value`. `error` absorbs everything after the first error.
export const grammarStates = ['value', 'valueOrClose', 'keyOrClose', 'key', 'colon', 'commaOrClose', 'end', 'error'] as const
export type GrammarState = typeof grammarStates[number]
export const grammarStateCount = grammarStates.length
export const symbolCount = grammarTokens.length * contextCount

type GrammarStep = readonly [next: GrammarState, error: number]

// The grammar between tokens, from the state before a character, what the grammar sees of it, the depth class before it,
// and whether the container at that depth is an object. Only string starts, scalar starts and punctuation change the
// state, and strings in a key position lead to `colon`.
export function grammarStep(state: GrammarState, token: GrammarToken, depthClass: number, inObject: boolean): GrammarStep {
  if (state === 'error') return ['error', errorKind.none]
  if (token === 'none') return [state, errorKind.none]
  if (token === 'lexerError') return ['error', errorKind.none]
  if (token === 'end') return state === 'end' ? ['end', errorKind.none] : ['error', errorKind.unexpectedEnd]
  // What's wrong with a token that this state doesn't accept, e.g. a number where a key should be.
  const unexpected = (): GrammarStep => {
    switch (state) {
      case 'value': case 'valueOrClose': return ['error', errorKind.expectedValue]
      case 'keyOrClose': case 'key': return ['error', errorKind.expectedKey]
      case 'colon': return ['error', errorKind.expectedColon]
      case 'commaOrClose': return ['error', errorKind.expectedCommaOrClose]
      case 'end': return ['error', errorKind.extraAfterValue]
    }
  }
  const expectsValue = state === 'value' || state === 'valueOrClose'
  // After a complete value at this depth: the end of the text at the top level, otherwise a comma or a closing bracket.
  const afterValue: GrammarStep = [depthClass === 0 ? 'end' : 'commaOrClose', errorKind.none]
  switch (token) {
    case 'string':
      if (state === 'keyOrClose' || state === 'key') return ['colon', errorKind.none]
      return expectsValue ? afterValue : unexpected()
    case 'scalar': return expectsValue ? afterValue : unexpected()
    case 'openObject': case 'openArray':
      if (!expectsValue) return unexpected()
      if (depthClass === 3) return ['error', errorKind.tooDeep]
      return [token === 'openObject' ? 'keyOrClose' : 'valueOrClose', errorKind.none]
    case 'closeObject': case 'closeArray': {
      const closesObject = token === 'closeObject'
      const mayClose = closesObject ? state === 'keyOrClose' || state === 'commaOrClose' : state === 'valueOrClose' || state === 'commaOrClose'
      const otherKindMayClose = closesObject ? state === 'valueOrClose' || state === 'commaOrClose' : state === 'keyOrClose' || state === 'commaOrClose'
      if (mayClose && inObject === closesObject) return [depthClass === 1 ? 'end' : 'commaOrClose', errorKind.none]
      if (otherKindMayClose) return ['error', errorKind.mismatchedBracket]
      return unexpected()
    }
    case 'colon': return state === 'colon' ? ['value', errorKind.none] : unexpected()
    case 'comma': return state === 'commaOrClose' ? [inObject ? 'key' : 'value', errorKind.none] : unexpected()
  }
}

// grammarNext[state × symbolCount + token × contextCount + context] and the same for grammarError.
function grammarTable(field: 0 | 1): number[] {
  return grammarStates.flatMap(state => grammarTokens.flatMap(token => Array.from({length: contextCount}, (_, context) => {
    const step = grammarStep(state, token, Math.floor(context / 2), context % 2 === 1)
    return field === 0 ? grammarStates.indexOf(step[0]) : step[1]
  })))
}
export const grammarNextTable: readonly number[] = grammarTable(0)
export const grammarErrorTable: readonly number[] = grammarTable(1)

// display[event × grammarStateCount + grammar state after the character]: a string character is a key when the grammar
// expects a colon after it, which only happens inside a key.
export function displayKindOf(event: LexerEvent, grammarAfter: GrammarState): number {
  switch (event) {
    case 'whitespace': return displayKind.whitespace
    case 'stringStart': case 'stringContent': case 'stringEnd': return grammarAfter === 'colon' ? displayKind.key : displayKind.string
    case 'escape': return displayKind.escape
    case 'numberStart': case 'numberContent': return displayKind.number
    case 'literalStart': case 'literalContent': return displayKind.literal
    case 'openObject': case 'openArray': case 'closeObject': case 'closeArray': case 'colon': case 'comma': return displayKind.punctuation
    case 'unexpectedCharacter': case 'controlCharacterInString': case 'badEscape': case 'badUnicodeEscape': case 'badNumber':
    case 'badLiteral': case 'errorContinuation': return displayKind.error
    case 'end': case 'endInsideToken': case 'truncatedEnd': return displayKind.pastEnd
  }
}
export const displayTable: readonly number[] = lexerEvents.flatMap(event => grammarStates.map(state => displayKindOf(event, state)))
