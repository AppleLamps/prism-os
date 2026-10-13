// Names shared by the program, the page and the plain JavaScript reference in tests/json-highlighter/reference.ts: the
// capacity, the maximum nesting depth, what each character is shown as, and the kinds of the first error. This file
// holds only names and numbers. The program's tables are in tables.ts, which the reference doesn't read.

// The program's two limits. Both are fixed while building, and buildHighlighter takes them as a parameter.
export type Limits = {
  // The text box holds up to this many code points. Past the capacity, the program reads only the code points that
  // fit and reports tooLong.
  capacity: number
  // Containers nest up to this depth. An opening bracket at the maximum depth is the error tooDeep.
  maximumDepth: number
}
// The limits of a call without the parameter: 512 code points, and depth 16, where an opening bracket that would make
// the depth 17 is tooDeep.
export const capacity = 512
export const maximumDepth = 16
export const defaultLimits: Limits = {capacity, maximumDepth}
// The limits of the page, assets/json-highlighter.html: the largest power of two whose program Chrome 155 evaluates in
// about 1 ms per keystroke on an Apple M5 Max, at the largest depth where every comparison of the container kinds is
// an integer bit, since 2,048 × 2^12 is below 2^24 (highlighter.ts, stage 4).
export const pageLimits: Limits = {capacity: 2048, maximumDepth: 13}

// What a character is shown as. `key` is a string character in a key position, e.g. the "id" of {"id": 1}, found by the
// grammar before the first error. `pastEnd` is a cell after the text.
const displayKinds = ['whitespace', 'punctuation', 'string', 'escape', 'number', 'literal', 'error', 'pastEnd', 'key'] as const
type DisplayKind = typeof displayKinds[number]
export const displayKind = Object.fromEntries(displayKinds.map((name, index) => [name, index])) as {[Name in DisplayKind]: number}

// The kinds of the first error. Lexer errors come first, then grammar errors between tokens, then the named fallbacks.
export const errorKinds = [
  'none',
  // A character that can't start or continue a token, e.g. the x of [x] or the + of +1.
  'unexpectedCharacter',
  // A code point below U+0020 inside a string, e.g. a tab or a line feed typed between the quotes.
  'controlCharacterInString',
  // A backslash followed by a character other than " \ / b f n r t u, e.g. "\q".
  'badEscape',
  // A \u followed by fewer than 4 hex digits, e.g. "\u12x4".
  'badUnicodeEscape',
  // A number that breaks JSON's grammar, e.g. 01, -x, 1. or 1e.
  'badNumber',
  // A literal that isn't true, false or null, e.g. tru or nul!.
  'badLiteral',
  // A value was expected, e.g. the ] of [1,] or the : of [:].
  'expectedValue',
  // A string key or a closing brace was expected, e.g. the 1 of {1: 2}.
  'expectedKey',
  // A colon was expected after a key, e.g. the 2 of {"a" 2}.
  'expectedColon',
  // A comma or a closing bracket was expected after a value, e.g. the 2 of [1 2].
  'expectedCommaOrClose',
  // A closing bracket of the other kind, e.g. the } of [1}.
  'mismatchedBracket',
  // Anything but whitespace after the top-level value, e.g. the second 1 of 1 1, or the ] of 1].
  'extraAfterValue',
  // The named fallback for depth: an opening bracket at the maximum depth, e.g. at depth 16 with the default limits.
  'tooDeep',
  // The text ends inside a token or before the value is complete, e.g. [1, or "abc.
  'unexpectedEnd',
  // The named fallback for capacity: the text holds more code points than the capacity, e.g. more than 512, and no
  // error came before the first code point that doesn't fit.
  'tooLong',
] as const
type ErrorKind = typeof errorKinds[number]
export const errorKind = Object.fromEntries(errorKinds.map((name, index) => [name, index])) as {[Name in ErrorKind]: number}
