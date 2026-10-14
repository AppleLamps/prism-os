// Names shared by the program, the code that shows its outputs, e.g. JSON search's page, and the plain JavaScript
// reference in tests/json-search/highlighter/reference.ts: the capacity, the maximum nesting depth, what each character is
// shown as, and the kinds of the first error. This file holds only names and numbers. The program's tables are in
// tables.ts, which the reference doesn't read.

// The program reads up to this many code points of a text. Past it, the program reads only the first 512 and reports
// tooLong.
export const capacity = 512
// Containers nest up to this depth. An opening bracket that would make the depth 17 is the error tooDeep.
export const maximumDepth = 16

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
  // The named fallback for depth: an opening bracket at depth 16.
  'tooDeep',
  // The text ends inside a token or before the value is complete, e.g. [1, or "abc.
  'unexpectedEnd',
  // The named fallback for capacity: the text holds more than 512 code points, and no error came before the 512th.
  'tooLong',
] as const
type ErrorKind = typeof errorKinds[number]
export const errorKind = Object.fromEntries(errorKinds.map((name, index) => [name, index])) as {[Name in ErrorKind]: number}
