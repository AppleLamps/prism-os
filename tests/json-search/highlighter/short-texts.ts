// Short texts that put the highlighter in each of its situations, written from JSON's grammar and not from the
// program's tables: every tokenizer state followed by every kind of character, and then by one more character that
// shows which state the tokenizer went to, every ASCII character in the places where its kind matters, and short texts
// inside containers at every nesting depth. The corpus's random texts reach only some of these pairs, e.g. `nu1`, a
// digit inside null, or `-]`, a bracket after a minus sign. json-step.test.ts compares the page's step with the plain
// reference on them.

// One character of every kind that JSON's grammar tells apart, and three past ASCII.
const characters = [
  ' ', '\t', '\r', '\n', '\u0001', '"', '\\', '/', '{', '}', '[', ']', ':', ',', '-', '+', '.', '0', '7',
  'a', 'b', 'e', 'E', 'f', 'l', 'n', 'r', 's', 't', 'u', 'c', 'D', 'x', '\u007f', 'é', '😀',
]
// A start of a token that leaves the tokenizer in each of its states, e.g. `"\u00` inside a \u escape and `1e+` after
// an exponent's sign, and a few whole tokens.
const tokenStarts = [
  '', '"', '"\\', '"\\u', '"\\u0', '"\\u00', '"\\u000', '"\\u0000', '"a', '"a"', '-', '0', '1', '12', '1.', '1.5', '1e',
  '1e+', '1e5', '-0', 't', 'tr', 'tru', 'true', 'f', 'fa', 'fal', 'fals', 'false', 'n', 'nu', 'nul', 'null', 'x', 'x\n', ' ',
]
// What comes before the token: nothing, an array's value, and an opened object.
const tokenContexts = ['', '[1', '{']
// What comes after: the end of the text, a new line, and one more token.
const tokenTails = ['', '\n', ' 1']
// One more character right after, which continues some tokens and breaks others, so that two tokenizer states show
// different kinds for it, e.g. `l` continues `nu` and is an error after `t`.
const nextCharacters = ['0', '.', 'e', '+', 'l', 'u', 'r', 's', 'a', '"', '\\', '{']
// Short texts that go inside containers, some valid there and some not, e.g. a key without an object.
const insideContainers = ['1', '"a"', '[]', '{}', '{"a":1}', '[1,2]', 'true', '1,', '"a":1', '{"a":[', '[{', '{},{}', '[],[]', '{"a":{}}']
// Past the maximum depth of 16, so that the 17th and the 18th opener are there too.
const deepestNesting = 18

// `depth` openers and their closers: arrays, objects, and both alternations.
function nestings(depth: number): {open: string, close: string}[] {
  const levels = Array.from({length: depth}, (_, level) => level)
  const alternating = (firstIsArray: boolean) => {
    const isArray = levels.map(level => (level % 2 === 0) === firstIsArray)
    return {open: isArray.map(array => array ? '[' : '{"k":').join(''), close: isArray.toReversed().map(array => array ? ']' : '}').join('')}
  }
  return [{open: '['.repeat(depth), close: ']'.repeat(depth)}, {open: '{"k":'.repeat(depth), close: '}'.repeat(depth)}, alternating(true), alternating(false)]
}

export function shortTexts(): string[] {
  const texts = new Set<string>()
  // Every tokenizer state, then every kind of character.
  for (const context of tokenContexts) {
    for (const start of tokenStarts) {
      for (const character of ['', ...characters]) for (const tail of tokenTails) texts.add(context + start + character + tail)
    }
  }
  // The same pairs, then one more character.
  for (const start of tokenStarts) {
    for (const character of characters) for (const next of nextCharacters) texts.add(start + character + next)
  }
  // Every ASCII character and U+0080 where a token starts, inside a string, after a backslash, inside a \u escape,
  // inside a number and inside a literal.
  for (let codePoint = 0; codePoint <= 0x80; codePoint++) {
    for (const start of ['', '"', '"\\', '"\\u0', '0', '1e', 't']) for (const tail of ['', ' 1']) texts.add(start + String.fromCodePoint(codePoint) + tail)
  }
  for (let depth = 0; depth <= deepestNesting; depth++) {
    for (const {open, close} of nestings(depth)) {
      // Every kind of character at this depth, in an array and in an object, alone and after one more opener.
      for (const character of ['', ...characters]) {
        texts.add(open + character)
        texts.add(open + character + close)
        for (const opener of ['[', '{']) texts.add(open + opener + character)
      }
      // A short text at this depth, then the closers, one closer too few, one too many, a closer of either kind, and
      // a second value.
      for (const inside of insideContainers) {
        for (const tail of ['', close, close.slice(1), `${close} `, `${close}]`, `${close}}`, `,${inside}${close}`]) texts.add(open + inside + tail)
      }
    }
  }
  return [...texts]
}
