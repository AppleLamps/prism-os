// The hand-written cases and the seeded random patterns and texts of regex search's tests: regex-search.test.ts in
// this folder, for the program that JSON search runs, and lab/regex-search/regex-search.test.ts, for the forms that
// stayed in lab/. Both files draw the same patterns and texts from the same seeds.
import {type Match, codePointsOf} from '../../../src/json-search/regex/host.ts'
import {type CompiledPattern, maxCodePoint} from '../../../src/json-search/regex/pattern.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

export const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!
export const pairs = (matches: readonly Match[]) => matches.map(({start, end}) => [start, end])

// A pattern, a text, and the matches that every version has to find, as [start, end] pairs.
export const handWrittenCases: [pattern: string, text: string, expected: number[][]][] = [
  ['a', 'baaab', [[1, 2], [2, 3], [3, 4]]], // adjacent matches stay separate
  ['a*', 'baab', [[1, 3]]], // the empty match isn't reported
  ['', 'abc', []],
  ['()*', 'abc', []],
  ['a|ab', 'xabx', [[1, 3]]], // longest, where RegExp's own search returns a
  ['(a|ab)(c|bcd)', 'abcd abc', [[0, 4], [5, 8]]],
  ['a+b|a', 'aaac aab', [[0, 1], [1, 2], [2, 3], [5, 8]]], // a longest match needs code points past its end to decide
  ['aba', 'ababa', [[0, 3]]], // the overlapping aba at 2 isn't reported
  ['a(bc)*', 'abcbcbx', [[0, 5]]],
  ['.+', 'ab\ncd\re f', [[0, 2], [3, 5], [6, 7], [8, 9]]], // . doesn't match line terminators
  ['[^a]+', 'b\ncad', [[0, 3], [4, 5]]], // a negated class does
  ['.', 'a b', [[0, 1], [2, 3]]],
  ['[^a]', '\u{10FFFF}\u{10FFFE}', [[0, 1], [1, 2]]], // up to the last code point
  ['[^\u{10FFFE}]', '\u{10FFFE}\u{10FFFF}', [[1, 2]]], // a negated set whose last interval is only the last code point
  ['.+', '\u{10FFFF}', [[0, 1]]],
  ['\\w+', '-_aZ09-', [[1, 6]]],
  ['\\d+', '/0189:', [[1, 5]]],
  ['😀+', 'x😀😀y😀', [[1, 3], [4, 5]]], // one code point per cell
  ['[]', 'abc', []],
  ['[^]', 'ab', [[0, 1], [1, 2]]],
  ['[^]*', 'ab\nc', [[0, 4]]],
  ['\\d+\\.\\d+', 'pi 3.14, e 2.7.', [[3, 7], [11, 14]]],
  ['[a-c-]+', 'x-ab-cd', [[1, 6]]],
  ['(x|y)*z', 'xxyzyz zz', [[0, 4], [4, 6], [7, 8], [8, 9]]],
  ['abc', 'ab', []], // a match that would run past the end of the text
  ['b+', 'aaaaaaaaaaaaaabb', [[14, 16]]], // a match that ends on the last cell
]

// Random patterns over a small alphabet that includes syntax characters, line terminators and an emoji.
type Rendered = {source: string, precedence: 0 | 1 | 2 | 3} // 0 alternation, 1 sequence, 2 repeat, 3 atom or group
const wrap = (node: Rendered, minimum: number) => node.precedence >= minimum ? node.source : `(${node.source})`
const classCharacters = ['a', 'b', 'c', '0', '9', 'é', '😀', '\u{10FFFE}', '\n', '.', '\\-', '\\]']

function randomAtom(random: () => number): Rendered {
  const roll = random()
  if (roll < 0.4) return {source: pick(random, ['a', 'b', 'c', '0', '\\.', '-', '\n', 'é', '😀']), precedence: 3}
  if (roll < 0.52) return {source: '.', precedence: 3}
  if (roll < 0.58) return {source: pick(random, ['\\d', '\\w']), precedence: 3}
  if (roll < 0.62) return {source: '()', precedence: 3}
  const items = Array.from({length: Math.floor(random() * 4)}, () => {
    const low = pick(random, classCharacters)
    if (random() < 0.3 && !low.startsWith('\\')) {
      const high = pick(random, classCharacters.filter(character => !character.startsWith('\\') && character.codePointAt(0)! >= low.codePointAt(0)!))
      return `${low}-${high}`
    }
    return random() < 0.1 ? '\\d' : low
  })
  return {source: `[${random() < 0.3 ? '^' : ''}${items.join('')}]`, precedence: 3}
}

export function randomNode(random: () => number, depth: number): Rendered {
  const roll = random()
  if (depth <= 0 || roll < 0.4) return randomAtom(random)
  if (roll < 0.62) return {source: Array.from({length: 2 + Math.floor(random() * 2)}, () => wrap(randomNode(random, depth - 1), 1)).join(''), precedence: 1}
  if (roll < 0.8) return {source: Array.from({length: 2}, () => random() < 0.1 ? '' : wrap(randomNode(random, depth - 1), 1)).join('|'), precedence: 0}
  return {source: wrap(randomNode(random, depth - 1), 3) + pick(random, ['?', '*', '+']), precedence: 2}
}

// '9', 'Z', '_', U+2028, U+2029 and U+10FFFF are where \d, \w, . and negated classes start or stop.
const textAlphabet = ['a', 'b', 'c', '0', '9', 'Z', '_', '-', '.', '\n', '\r', ' ', ' ', 'é', '😀', '\u{10FFFF}', 'x', ' ', ']']
export const randomText = (random: () => number, maximumLength: number) =>
  Array.from({length: Math.floor(random() * (maximumLength + 1))}, () => pick(random, textAlphabet)).join('')

// A text of the code points just below, at and above each of the pattern's class boundaries, plus 0 and U+10FFFF, e.g.
// for [a-c]+, a text over `, a, b, c, d, NUL and U+10FFFF.
export function boundaryText(random: () => number, {partition}: CompiledPattern, length: number) {
  const nearBoundaries = [0, maxCodePoint, ...partition.boundaries.flatMap(boundary => [boundary - 1, boundary, boundary + 1])]
    .filter(codePoint => codePoint <= maxCodePoint)
  return Array.from({length}, () => pick(random, nearBoundaries))
}

// A text of exactly `length` code points over the random text alphabet.
export const fullText = (random: () => number, length: number) => Array.from({length}, () => codePointsOf(pick(random, textAlphabet))[0]!)
