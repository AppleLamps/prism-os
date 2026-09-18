// Texts for the tests and for the measurement scripts in scripts/: edge cases written by hand, random JSON, and random
// edits of random JSON.
import {capacity, maximumDepth} from '../../src/json-highlighter/kinds.ts'

// mulberry32, so tests are repeatable.
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!
const count = (random: () => number, minimum: number, maximum: number) => minimum + Math.floor(random() * (maximum - minimum + 1))
const nested = (depth: number, inner = '') => '['.repeat(depth) + inner + ']'.repeat(depth)

export const edgeCases: readonly string[] = [
  // Valid texts.
  '0', '-0', '12', '-12.5', '1e5', '1E+5', '2.5e-3', '0.0', '-0.0e0', 'true', 'false', 'null', '""', '"abc"', '[]', '{}',
  ' [ ] ', '\t{\r\n}\n', '[1,2,3]', '{"a":1,"b":[true,false,null]}', '{"a":{"b":{"c":[{}]}}}', '[[],[[]],{}]',
  '"\\" \\\\ \\/ \\b \\f \\n \\r \\t"', '"\\u00e9\\uD83D\\uDE00\\uABCD\\uabcd"', '"é字😀\u2028\u007f"', '"\ud800"',
  '{"":""}', '[-1,0.5,1e10,"x"]', nested(16), nested(16, '1'), `{"a":${nested(15)}}`,
  // Numbers.
  '01', '-01', '00', '1.', '.5', '+1', '1e', '1e+', '1e-x', '-', '--1', '-a', '1.2.3', '1e5e', '0x10', '1_000', '1.e5',
  'NaN', 'Infinity', '-Infinity',
  // Literals.
  'tru', 'trux', 'true1', 'truefalse', 'nul', 'nulll', 'fals', 'f', 'True', 'undefined',
  // Strings.
  '"abc', '"\\q"', '"\\', '"\\u12"', '"\\u12x4"', '"\\u"', '"a\tb"', '"a\nb"', '["a\nb"]', '"\u0000"', "'a'", '"\\U0041"',
  // Grammar between tokens.
  '[1 2]', '{"a" 1}', '{"a":}', '{"a"}', '{1:2}', '{,}', '[,1]', '[1,]', '{"a":1,}', '[1}', '{]', '{"a":1]', '[{]}',
  '1 1', '1]', ']', '}', ':', ',', '1,2', '[1,2]]', '{"a":1}}', '[:]', '{"a"::1}', '{"a":1:2}', '["a":1]', '{"a",1}',
  '[[1]', '[', '{', '{"a":', '{"a":1', '[1,', '', ' ', '\n',
  // Characters no token starts with, and the line feed that starts scanning again.
  '[x]', '/* */', '\ufeff1', '[1]\u00a0', '[x\n1]', '[x\n1, 2]', '{"a":\u0001}', '[1,\nx y z\n2]', '["ok"\n"a\\qb"\n]',
  // Nesting past the maximum depth.
  nested(17), nested(maximumDepth + 1, '1'), `{"a":${nested(16)}}`, nested(40),
  // Capacity.
  `[${'1,'.repeat(254)}1]`, `[${' '.repeat(capacity - 2)}]`, `[${' '.repeat(capacity - 1)}]`, `"${'a'.repeat(capacity)}"`,
  `${' '.repeat(capacity)}1`, `[${'"é字",'.repeat(80)}1]`, `x${' '.repeat(capacity + 20)}`,
]

function randomDigits(random: () => number, minimum: number, maximum: number) {
  return Array.from({length: count(random, minimum, maximum)}, () => String(Math.floor(random() * 10))).join('')
}

function randomNumber(random: () => number) {
  let text = random() < 0.3 ? '-' : ''
  text += random() < 0.2 ? '0' : String(count(random, 1, 9)) + randomDigits(random, 0, 4)
  if (random() < 0.3) text += `.${randomDigits(random, 1, 3)}`
  if (random() < 0.2) text += pick(random, ['e', 'E']) + pick(random, ['', '+', '-']) + randomDigits(random, 1, 3)
  return text
}

function randomString(random: () => number) {
  const parts = Array.from({length: count(random, 0, 6)}, () => {
    const roll = random()
    if (roll < 0.4) return pick(random, ['a', 'id', 'name', 'x y', ' ', 'true', '{', ']', ':', ',', '0'])
    if (roll < 0.6) return pick(random, ['\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t'])
    if (roll < 0.75) return `\\u${Array.from({length: 4}, () => pick(random, '0123456789abcdefABCDEF'.split(''))).join('')}`
    return pick(random, ['é', '字', '😀', '\u2028', '\u007f', '\ud800'])
  })
  return `"${parts.join('')}"`
}

function randomWhitespace(random: () => number) {
  return random() < 0.6 ? '' : pick(random, [' ', '  ', '\n', '\t', '\r\n', '\n  '])
}

function randomValue(random: () => number, depth: number, maximumNesting: number): string {
  const roll = random()
  if (depth < maximumNesting && roll < 0.35) {
    const items = Array.from({length: count(random, 0, 4)}, () => random)
    const space = () => randomWhitespace(random)
    if (random() < 0.5) return `[${space()}${items.map(() => randomValue(random, depth + 1, maximumNesting) + space()).join(`,${space()}`)}]`
    return `{${space()}${items.map(() => `${randomString(random)}${space()}:${space()}${randomValue(random, depth + 1, maximumNesting)}${space()}`).join(`,${space()}`)}}`
  }
  if (roll < 0.6) return randomNumber(random)
  if (roll < 0.85) return randomString(random)
  return pick(random, ['true', 'false', 'null'])
}

export function randomJson(random: () => number): string {
  // Mostly shallow texts, and some chains of containers near the maximum depth.
  if (random() < 0.08) {
    const openers = Array.from({length: count(random, maximumDepth - 2, maximumDepth + 3)}, () => random() < 0.5)
    // Each object opens with a key, and closes with a brace, and 1 chain in 5 closes every container with one kind.
    const matching = random() < 0.8
    const closers = openers.map(isObject => (matching ? isObject : random() < 0.5) ? '}' : ']').reverse().join('')
    return openers.map(isObject => (isObject ? '{"k":' : '[')).join('') + randomValue(random, 0, 1) + closers
  }
  return randomWhitespace(random) + randomValue(random, 0, count(random, 1, 5)) + randomWhitespace(random)
}

const editAlphabet = [...'{}[]:,"\\/ -+.0123456789eEtrufalsnxbu\n\t\r'.split(''), 'é', '😀', '\u0000', '\u001f']

// 1 to 3 random edits: insert, delete or replace a code point, duplicate a slice, or cut the text.
export function mutate(random: () => number, text: string): string {
  let codePoints = Array.from(text)
  const edits = count(random, 1, 3)
  for (let edit = 0; edit < edits; edit++) {
    const position = Math.floor(random() * (codePoints.length + 1))
    const roll = random()
    if (roll < 0.3) codePoints.splice(position, 0, pick(random, editAlphabet))
    else if (roll < 0.55) codePoints.splice(position, 1)
    else if (roll < 0.8) codePoints.splice(position, 1, pick(random, editAlphabet))
    else if (roll < 0.9) codePoints.splice(position, 0, ...codePoints.slice(position, position + count(random, 1, 8)))
    else codePoints = codePoints.slice(0, position)
  }
  return codePoints.join('')
}

// Longer texts, from under the capacity to past it.
export function randomLongJson(random: () => number): string {
  const items: string[] = []
  let length = 2
  const target = count(random, capacity - 40, capacity + 60)
  while (length < target) {
    const item = randomValue(random, 1, 3)
    items.push(item)
    length += Array.from(item).length + 1
  }
  return `[${items.join(',')}]`
}

export function createCorpus(seed: number, sizes: {random: number, mutated: number, long: number}) {
  const random = createRandom(seed)
  const randomTexts = Array.from({length: sizes.random}, () => randomJson(random))
  const mutatedTexts = Array.from({length: sizes.mutated}, () => mutate(random, randomJson(random)))
  const longTexts = Array.from({length: sizes.long}, () => random() < 0.5 ? randomLongJson(random) : mutate(random, randomLongJson(random)))
  return {randomTexts, mutatedTexts, longTexts, all: [...edgeCases, ...randomTexts, ...mutatedTexts, ...longTexts]}
}

// A valid JSON text of exactly 512 code points, with strings, numbers, literals, escapes and nesting, for timings.
export function timingText() {
  const item = '{"id": 12, "name": "caf\\u00e9 字 \\"q\\"", "tags": ["a", "b"], "ok": true, "score": -1.5e3, "next": null}'
  let text = '['
  while (Array.from(text).length + Array.from(item).length + 2 <= capacity) text += (text === '[' ? '' : ',') + item
  text += ' '.repeat(capacity - Array.from(text).length - 1) + ']'
  if (Array.from(text).length !== capacity) throw new Error('the timing text fills the capacity')
  JSON.parse(text)
  return text
}
