// The same highlighter in plain JavaScript: a hand-written scanner that consumes one token at a time, and a parser with
// a real stack, written from JSON's grammar (RFC 8259) and the rules in src/json-search/highlighter/kinds.ts. It doesn't read
// that folder's tables.ts.
//
// The rules that go past JSON's grammar:
// - The first error's position is the first code point at which the text stops being the start of some valid JSON text,
//   or the text's length when the text is such a start but isn't complete, e.g. 3 for [1 2] and 2 for [1.
// - After a lexer error, e.g. the x of [x], the rest of the line is shown as an error, and scanning starts again after
//   the next line feed. A line feed that is itself the error, e.g. inside a string, starts scanning again right away.
// - A string is shown as a key when the parser accepts it in a key position before the first error.
// - Brackets pair up as with a stack of openers, whatever their kinds, and a closer with an empty stack pairs with nothing.
// - The bracket at the caret is the code point before the caret when it's a bracket, otherwise the code point at the caret.
// - Text past the capacity, e.g. past 512 code points, isn't read, and the error is tooLong unless an error comes
//   first. An opening bracket at the maximum depth, e.g. at depth 16, is the error tooDeep, and depthExceeded is 1 only
//   when tooDeep is the first error.
import {type Limits, defaultLimits, displayKind, errorKind} from '../../../src/json-search/highlighter/kinds.ts'

export type HighlightResult = {
  displayKinds: number[]
  firstErrorPosition: number
  firstErrorKind: number
  valid: number
  truncated: number
  depthExceeded: number
  caretBracket: number
  matchingBracket: number
}

type Token = {type: 'string' | 'scalar' | '{' | '[' | '}' | ']' | ':' | ',', start: number, end: number}
type Found = {position: number, kind: number}

const lineFeed = 0x0a
const isDigit = (codePoint: number | undefined) => codePoint !== undefined && codePoint >= 0x30 && codePoint <= 0x39
const isHexDigit = (codePoint: number | undefined) =>
  isDigit(codePoint) || (codePoint !== undefined && /^[a-fA-F]$/.test(String.fromCodePoint(codePoint)))
const is = (codePoint: number | undefined, characters: string) =>
  codePoint !== undefined && characters.includes(String.fromCodePoint(codePoint))

// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)? from `start`. Returns where the number ends, and where a required digit
// is missing, e.g. after `-`, `.` or `e`, or where a digit follows a leading zero, or null.
function scanNumber(codePoints: readonly number[], start: number) {
  let index = start
  const stop = (missingDigitAt: number | null) => ({end: index, missingDigitAt})
  if (codePoints[index] === 0x2d) index++
  if (!isDigit(codePoints[index])) return stop(index)
  if (codePoints[index] === 0x30) {
    index++
    if (isDigit(codePoints[index])) return stop(index)
  } else {
    while (isDigit(codePoints[index])) index++
  }
  if (codePoints[index] === 0x2e) {
    index++
    if (!isDigit(codePoints[index])) return stop(index)
    while (isDigit(codePoints[index])) index++
  }
  if (is(codePoints[index], 'eE')) {
    index++
    if (is(codePoints[index], '+-')) index++
    if (!isDigit(codePoints[index])) return stop(index)
    while (isDigit(codePoints[index])) index++
  }
  return stop(null)
}

function scan(codePoints: readonly number[], capacity: number) {
  const length = codePoints.length
  const kinds = Array<number>(capacity).fill(displayKind.pastEnd)
  const tokens: Token[] = []
  let firstLexerError: Found | null = null
  let endsInsideToken = false
  let index = 0

  // Marks a lexer error and the rest of its line, and returns where scanning continues.
  const fail = (position: number, kind: number) => {
    firstLexerError ??= {position, kind}
    kinds[position] = displayKind.error
    if (codePoints[position] === lineFeed) return position + 1
    let next = position + 1
    while (next < length && codePoints[next] !== lineFeed) kinds[next++] = displayKind.error
    return next
  }
  // Marks code points from `from` up to `to` as one display kind.
  const mark = (from: number, to: number, kind: number) => {
    for (let position = from; position < to; position++) kinds[position] = kind
  }

  while (index < length) {
    const start = index
    const codePoint = codePoints[index]!
    if (is(codePoint, ' \t\n\r')) {
      kinds[index++] = displayKind.whitespace
    } else if (is(codePoint, '{}[]:,')) {
      kinds[index++] = displayKind.punctuation
      tokens.push({type: String.fromCodePoint(codePoint) as Token['type'], start, end: index})
    } else if (codePoint === 0x22) {
      tokens.push({type: 'string', start, end: length})
      kinds[index++] = displayKind.string
      let closed = false
      while (!closed) {
        if (index === length) { endsInsideToken = true; break }
        const character = codePoints[index]!
        if (character === 0x22) {
          kinds[index++] = displayKind.string
          closed = true
        } else if (character === 0x5c) {
          kinds[index++] = displayKind.escape
          if (index === length) { endsInsideToken = true; break }
          if (is(codePoints[index], '"\\/bfnrt')) {
            kinds[index++] = displayKind.escape
          } else if (codePoints[index] === 0x75) {
            kinds[index++] = displayKind.escape
            let digits = 0
            while (digits < 4 && index < length && isHexDigit(codePoints[index])) { kinds[index++] = displayKind.escape; digits++ }
            if (digits < 4) {
              if (index === length) { endsInsideToken = true; break }
              index = fail(index, errorKind.badUnicodeEscape)
              break
            }
          } else {
            index = fail(index, errorKind.badEscape)
            break
          }
        } else if (character < 0x20) {
          index = fail(index, errorKind.controlCharacterInString)
          break
        } else {
          kinds[index++] = displayKind.string
        }
      }
      tokens.at(-1)!.end = index
    } else if (codePoint === 0x2d || isDigit(codePoint)) {
      const number = scanNumber(codePoints, start)
      tokens.push({type: 'scalar', start, end: number.end})
      mark(start, number.end, displayKind.number)
      index = number.end
      if (number.missingDigitAt === length) endsInsideToken = true
      else if (number.missingDigitAt !== null) index = fail(number.missingDigitAt, errorKind.badNumber)
    } else if (is(codePoint, 'tfn')) {
      const word = codePoint === 0x74 ? 'true' : codePoint === 0x66 ? 'false' : 'null'
      tokens.push({type: 'scalar', start, end: length})
      kinds[index++] = displayKind.literal
      for (let letter = 1; letter < word.length; letter++) {
        if (index === length) { endsInsideToken = true; break }
        if (codePoints[index] !== word.codePointAt(letter)) { index = fail(index, errorKind.badLiteral); break }
        kinds[index++] = displayKind.literal
      }
      tokens.at(-1)!.end = Math.min(index, start + word.length)
    } else {
      index = fail(index, errorKind.unexpectedCharacter)
    }
  }
  return {kinds, tokens, firstLexerError: firstLexerError as Found | null, endsInsideToken}
}

// The grammar between tokens, up to the first lexer error. Returns the first grammar error and the key strings.
function parse(tokens: readonly Token[], limit: number, maximumDepth: number) {
  const stack: ('object' | 'array')[] = []
  let expected: 'value' | 'valueOrClose' | 'keyOrClose' | 'key' | 'colon' | 'commaOrClose' | 'end' = 'value'
  const keys: Token[] = []
  const unexpected = () => {
    switch (expected) {
      case 'value': case 'valueOrClose': return errorKind.expectedValue
      case 'keyOrClose': case 'key': return errorKind.expectedKey
      case 'colon': return errorKind.expectedColon
      case 'commaOrClose': return errorKind.expectedCommaOrClose
      case 'end': return errorKind.extraAfterValue
    }
  }
  const afterValue = () => (stack.length === 0 ? 'end' : 'commaOrClose') as typeof expected
  for (const token of tokens) {
    if (token.start >= limit) break
    const expectsValue = expected === 'value' || expected === 'valueOrClose'
    switch (token.type) {
      case 'string':
        if (expected === 'keyOrClose' || expected === 'key') {
          keys.push(token)
          expected = 'colon'
        } else if (expectsValue) {
          expected = afterValue()
        } else {
          return {error: {position: token.start, kind: unexpected()}, keys, expected}
        }
        break
      case 'scalar':
        if (!expectsValue) return {error: {position: token.start, kind: unexpected()}, keys, expected}
        expected = afterValue()
        break
      case '{': case '[':
        if (!expectsValue) return {error: {position: token.start, kind: unexpected()}, keys, expected}
        if (stack.length === maximumDepth) return {error: {position: token.start, kind: errorKind.tooDeep}, keys, expected}
        stack.push(token.type === '{' ? 'object' : 'array')
        expected = token.type === '{' ? 'keyOrClose' : 'valueOrClose'
        break
      case '}': case ']': {
        // A container may close right after its opener, or after a value.
        const mayClose = expected === 'commaOrClose' || expected === 'keyOrClose' || expected === 'valueOrClose'
        if (!mayClose) return {error: {position: token.start, kind: unexpected()}, keys, expected}
        if (stack.at(-1) !== (token.type === '}' ? 'object' : 'array')) return {error: {position: token.start, kind: errorKind.mismatchedBracket}, keys, expected}
        stack.pop()
        expected = afterValue()
        break
      }
      case ':':
        if (expected !== 'colon') return {error: {position: token.start, kind: unexpected()}, keys, expected}
        expected = 'value'
        break
      case ',':
        if (expected !== 'commaOrClose') return {error: {position: token.start, kind: unexpected()}, keys, expected}
        expected = stack.at(-1) === 'object' ? 'key' : 'value'
        break
    }
  }
  return {error: null, keys, expected}
}

export function highlightReference(text: string, caret: number, {capacity, maximumDepth}: Limits = defaultLimits): HighlightResult {
  const allCodePoints = Array.from(text, character => character.codePointAt(0)!)
  const truncated = allCodePoints.length > capacity
  const codePoints = allCodePoints.slice(0, capacity)
  const length = codePoints.length
  const {kinds, tokens, firstLexerError, endsInsideToken} = scan(codePoints, capacity)
  const {error: grammarError, keys, expected} = parse(tokens, firstLexerError?.position ?? length, maximumDepth)

  let firstError: Found | null = grammarError ?? firstLexerError
  if (firstError === null && truncated) firstError = {position: capacity, kind: errorKind.tooLong}
  if (firstError === null && (endsInsideToken || expected !== 'end')) firstError = {position: length, kind: errorKind.unexpectedEnd}

  const errorPosition = firstError?.position ?? Number.POSITIVE_INFINITY
  for (const key of keys) {
    for (let position = key.start; position < Math.min(key.end, errorPosition); position++) {
      if (kinds[position] === displayKind.string) kinds[position] = displayKind.key
    }
  }

  // Bracket pairs, with a stack of opener positions.
  const partner = Array<number>(length).fill(-1)
  const openers: number[] = []
  for (const token of tokens) {
    if (token.type === '{' || token.type === '[') openers.push(token.start)
    if (token.type === '}' || token.type === ']') {
      const opener = openers.pop()
      if (opener !== undefined) {
        partner[opener] = token.start
        partner[token.start] = opener
      }
    }
  }
  const isBracket = (position: number) =>
    position >= 0 && position < length && kinds[position] === displayKind.punctuation && is(codePoints[position], '{}[]')
  // A caret past the capacity, e.g. past code point 512, has neither neighbor among the code points read, so no
  // bracket is at the caret.
  const clampedCaret = Math.min(Math.max(0, caret), capacity + 1)
  const caretBracket = isBracket(clampedCaret - 1) ? clampedCaret - 1 : isBracket(clampedCaret) ? clampedCaret : -1

  return {
    displayKinds: kinds,
    firstErrorPosition: firstError?.position ?? -1,
    firstErrorKind: firstError?.kind ?? errorKind.none,
    valid: Number(firstError === null),
    truncated: Number(truncated),
    depthExceeded: Number(firstError?.kind === errorKind.tooDeep),
    caretBracket,
    matchingBracket: caretBracket === -1 ? -1 : partner[caretBracket]!,
  }
}
