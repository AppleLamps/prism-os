// Compares the program with the plain JavaScript reference, and the reference with JSON.parse.
// Run from the repo root: bun test tests/json-highlighter
import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads, validateNoNaN} from '../../src/runtime/numeric-ui-core.ts'
import {createCorpus, createRandom, edgeCases, edgeCasesFor} from './corpus.ts'
import {type HighlighterOutput, type ScanForm, buildHighlighter, createHighlighterMachine, scanForms} from '../../src/json-highlighter/highlighter.ts'
import {type Limits, capacity, defaultLimits, errorKind, errorKinds, maximumDepth} from '../../src/json-highlighter/kinds.ts'
import {highlightReference} from './reference.ts'

const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80})
const codePointLength = (text: string) => Array.from(text).length
// One machine per form and limits, built when a test first asks for it.
const machines = new Map<string, ReturnType<typeof createHighlighterMachine>>()
function machineFor(form: ScanForm, limits: Limits = defaultLimits) {
  const key = `${form} ${limits.capacity} ${limits.maximumDepth}`
  let machine = machines.get(key)
  if (machine === undefined) machines.set(key, machine = createHighlighterMachine(form, limits))
  return machine
}

// Runs one text at one caret through the program and the reference, and throws with the text when they differ.
function expectAgreement(form: ScanForm, text: string, caret: number, limits: Limits = defaultLimits): HighlighterOutput {
  const output = machineFor(form, limits).run(text, caret)
  const expected = highlightReference(text, caret, limits)
  const actual = {...output, displayKinds: [...output.displayKinds]}
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    expect({form, limits, text, caret, ...actual}).toEqual({form, limits, text, caret, ...expected})
  }
  return output
}

const roundingPointCounts = (form: ScanForm, limits: Limits) => {
  const counts = new Map<string, number>()
  for (const point of machineFor(form, limits).built.circuit.roundingPoints()) counts.set(point.kind, (counts.get(point.kind) ?? 0) + 1)
  return Object.fromEntries(counts)
}

describe('the reference', () => {
  test('is valid exactly when JSON.parse succeeds, except past the maximum depth or the capacity', () => {
    const counts = {valid: 0, invalid: 0, tooDeep: 0, tooLong: 0}
    for (const text of corpus.all) {
      let parses = true
      try {
        JSON.parse(text)
      } catch {
        parses = false
      }
      const result = highlightReference(text, 0)
      if (result.firstErrorKind === errorKind.tooLong) {
        expect(codePointLength(text)).toBeGreaterThan(capacity)
        counts.tooLong++
      } else if (result.firstErrorKind === errorKind.tooDeep) {
        counts.tooDeep++
      } else {
        if (Boolean(result.valid) !== parses) throw new Error(`JSON.parse ${parses ? 'accepts' : 'rejects'} ${JSON.stringify(text)}, the reference says ${errorKinds[result.firstErrorKind]} at ${result.firstErrorPosition}`)
        counts[parses ? 'valid' : 'invalid']++
      }
    }
    // Enough of each kind for the agreement to mean something.
    expect(counts.valid).toBeGreaterThan(700)
    expect(counts.invalid).toBeGreaterThan(1200)
    expect(counts.tooDeep).toBeGreaterThan(30)
    expect(counts.tooLong).toBeGreaterThan(20)
  })

  test('texts that JSON.parse accepts but that nest past depth 16 report tooDeep at the 17th opener', () => {
    const text = `{"a":${'['.repeat(maximumDepth)}1${']'.repeat(maximumDepth)}}`
    expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(highlightReference(text, 0)).toMatchObject({valid: 0, firstErrorKind: errorKind.tooDeep, firstErrorPosition: 5 + 15, depthExceeded: 1})
  })

  test('every prefix of a valid text is incomplete or valid, and a text cut at its first error has no earlier error', () => {
    for (const text of corpus.all.slice(0, 1200)) {
      const codePoints = Array.from(text)
      const result = highlightReference(text, 0)
      if (result.valid === 1) {
        for (let cut = 0; cut < codePoints.length; cut++) {
          const prefix = highlightReference(codePoints.slice(0, cut).join(''), 0)
          if (prefix.valid !== 1) expect([prefix.firstErrorKind, prefix.firstErrorPosition]).toEqual([errorKind.unexpectedEnd, cut])
        }
      } else if (result.firstErrorPosition <= codePoints.length) {
        const cut = result.firstErrorPosition
        const prefix = highlightReference(codePoints.slice(0, cut).join(''), 0)
        if (prefix.valid !== 1) expect([prefix.firstErrorKind, prefix.firstErrorPosition]).toEqual([errorKind.unexpectedEnd, cut])
      }
    }
  })

  test('reports the first error where the definitions say', () => {
    const cases: [text: string, position: number, kind: typeof errorKinds[number]][] = [
      ['[1 2]', 3, 'expectedCommaOrClose'], ['{"a" 1}', 5, 'expectedColon'], ['[1}', 2, 'mismatchedBracket'],
      ['01', 1, 'badNumber'], ['1.', 2, 'unexpectedEnd'], ['1.]', 2, 'badNumber'], ['"\\q"', 2, 'badEscape'],
      ['"\\u12x4"', 5, 'badUnicodeEscape'], ['tru', 3, 'unexpectedEnd'], ['trux', 3, 'badLiteral'],
      ['[x]', 1, 'unexpectedCharacter'], ['"a\tb"', 2, 'controlCharacterInString'], ['1 1', 2, 'extraAfterValue'],
      ['[1,]', 3, 'expectedValue'], ['{1:2}', 1, 'expectedKey'], ['{"a":1,}', 7, 'expectedKey'], ['', 0, 'unexpectedEnd'],
      ['[x\n1]', 1, 'unexpectedCharacter'], [`${'['.repeat(17)}`, 16, 'tooDeep'], [`[${' '.repeat(capacity)}]`, capacity, 'tooLong'],
    ]
    for (const [text, position, kind] of cases) {
      expect([text, highlightReference(text, 0).firstErrorPosition, errorKinds[highlightReference(text, 0).firstErrorKind]]).toEqual([text, position, kind])
    }
  })
})

describe('the program', () => {
  for (const form of ['loop', 'brent-kung'] as const) {
    test(`${form}: matches the reference on edge cases, random JSON and random edits, at random carets`, () => {
      const random = createRandom(form === 'loop' ? 1 : 2)
      for (const text of corpus.all) expectAgreement(form, text, Math.floor(random() * (codePointLength(text) + 2)))
    })
  }

  test('sklansky: matches the reference on edge cases and some random texts', () => {
    const random = createRandom(3)
    for (const text of [...edgeCases, ...corpus.mutatedTexts.slice(0, 300)]) expectAgreement('sklansky', text, Math.floor(random() * (codePointLength(text) + 2)))
  })

  test('matches the reference at every caret position of nested and broken texts', () => {
    const texts = ['{"a": [1, {"b": []}], "c": {}}', '[}{]', '] [ ]', '[[x\n]]', '{"a":[1,2}', '"[" ]', `[${'['.repeat(20)}`]
    for (const form of scanForms) {
      for (const text of texts) {
        for (let caret = 0; caret <= codePointLength(text) + 1; caret++) expectAgreement(form, text, caret)
      }
    }
  })

  test('the named fallbacks: a text past the capacity, nesting past the maximum depth, and a text that exactly fits', () => {
    for (const form of scanForms) {
      const longText = `[${'1,'.repeat(300)}1]`
      expect(expectAgreement(form, longText, 0)).toMatchObject({truncated: 1, valid: 0, firstErrorPosition: capacity, firstErrorKind: errorKind.tooLong})
      expect(expectAgreement(form, '['.repeat(17) + ']'.repeat(17), 0)).toMatchObject({depthExceeded: 1, firstErrorPosition: 16, firstErrorKind: errorKind.tooDeep})
      const exactFit = `[${' '.repeat(capacity - 2)}]`
      expect(expectAgreement(form, exactFit, capacity)).toMatchObject({truncated: 0, valid: 1, firstErrorPosition: -1, caretBracket: capacity - 1, matchingBracket: 0})
      // The opener's match is found through the hit at position 512, the end of the text.
      for (const caret of [0, 1]) expect(expectAgreement(form, exactFit, caret)).toMatchObject({caretBracket: 0, matchingBracket: capacity - 1})
      // An earlier error hides nesting past the maximum depth.
      expect(expectAgreement(form, `x\n${'['.repeat(17)}${']'.repeat(17)}`, 0)).toMatchObject({depthExceeded: 0, firstErrorPosition: 0, firstErrorKind: errorKind.unexpectedCharacter})
    }
  })

  test('a caret past code point 512 has no bracket at the caret', () => {
    // Brackets at code points 0 and 511, then 187 more code points that the program doesn't read.
    const text = `[${' '.repeat(capacity - 2)}]${'x'.repeat(187)}`
    for (const form of scanForms) {
      for (const caret of [capacity - 1, capacity]) expect(expectAgreement(form, text, caret)).toMatchObject({caretBracket: capacity - 1, matchingBracket: 0})
      for (const caret of [capacity + 1, capacity + 2, 600, codePointLength(text), 10_000]) expect(expectAgreement(form, text, caret)).toMatchObject({caretBracket: -1, matchingBracket: -1})
    }
  })

  test('emitCompare builds integer bits everywhere except the container kind comparison at position 511', () => {
    // At position 511, the code minus the level weight can reach exactly 2^24, where emitCompare builds a sign cascade
    // of 17 operations instead of an integer bit.
    for (const form of scanForms) expect(roundingPointCounts(form, defaultLimits)).toEqual({'integer bit': 5127, 'sign cascade': 17})
  })

  test('the literal evaluator gives the compiled layers\' values, and every declared grid and index read holds', () => {
    const random = createRandom(4)
    for (const form of scanForms) {
      const machine = machineFor(form)
      const {circuit} = machine.built
      for (const text of [...edgeCases.slice(0, 40), ...corpus.mutatedTexts.slice(0, 20)]) {
        const output = machine.run(text, Math.floor(random() * (codePointLength(text) + 1)))
        const values = circuit.evaluateReference(machine.source)
        const leaves = machine.built.output
        expect(leaves.displayKinds.map(wire => values[wire])).toEqual(output.displayKinds)
        expect([leaves.firstErrorPosition, leaves.firstErrorKind, leaves.matchingBracket, leaves.caretBracket].map(wire => values[wire]))
          .toEqual([output.firstErrorPosition, output.firstErrorKind, output.matchingBracket, output.caretBracket])
        validateIndexReads(circuit, values)
        validateGrids(circuit, values)
        validateNoNaN(circuit, values)
      }
    }
  })
})

// buildHighlighter takes the capacity and the maximum depth as a parameter. The tests above run the defaults, 512 and
// 16. These run 2,048 code points at depth 13, four times the default capacity at the largest depth where every
// comparison of the container kinds is an integer bit, and limits that aren't powers of two.
describe('the program at other limits', () => {
  const larger: Limits = {capacity: 2048, maximumDepth: 13}
  // Edge cases, chains of containers and long texts made for the larger limits, e.g. `[`, 2,046 spaces and `]`.
  const largerCorpus = createCorpus(20261013, {random: 300, mutated: 600, long: 80}, larger)

  test('the reference at 2,048 code points and depth 13 is valid exactly when JSON.parse succeeds, except past the limits', () => {
    const counts = {valid: 0, invalid: 0, tooDeep: 0, tooLong: 0}
    for (const text of [...corpus.all, ...largerCorpus.all]) {
      let parses = true
      try {
        JSON.parse(text)
      } catch {
        parses = false
      }
      const result = highlightReference(text, 0, larger)
      if (result.firstErrorKind === errorKind.tooLong) {
        expect(codePointLength(text)).toBeGreaterThan(larger.capacity)
        counts.tooLong++
      } else if (result.firstErrorKind === errorKind.tooDeep) {
        counts.tooDeep++
      } else {
        if (Boolean(result.valid) !== parses) throw new Error(`JSON.parse ${parses ? 'accepts' : 'rejects'} ${JSON.stringify(text)}, the reference says ${errorKinds[result.firstErrorKind]} at ${result.firstErrorPosition}`)
        counts[parses ? 'valid' : 'invalid']++
      }
    }
    expect(counts.valid).toBeGreaterThan(1000)
    expect(counts.invalid).toBeGreaterThan(1700)
    expect(counts.tooDeep).toBeGreaterThan(100)
    expect(counts.tooLong).toBeGreaterThan(20)
  })

  test('loop at 2,048 code points and depth 13: matches the reference on the default corpus and on a corpus made for these limits, at random carets', () => {
    const random = createRandom(5)
    for (const text of [...corpus.all, ...largerCorpus.all]) expectAgreement('loop', text, Math.floor(random() * (codePointLength(text) + 2)), larger)
  })

  test('brent-kung and sklansky at 2,048 code points and depth 13: match the reference on the edge cases for these limits and some long texts', () => {
    const random = createRandom(6)
    const texts = [...edgeCasesFor(larger), ...largerCorpus.longTexts.slice(0, 30), ...largerCorpus.mutatedTexts.slice(0, 60)]
    for (const form of ['brent-kung', 'sklansky'] as const) {
      for (const text of texts) expectAgreement(form, text, Math.floor(random() * (codePointLength(text) + 2)), larger)
    }
  })

  test('the named fallbacks at 2,048 code points and depth 13, and carets around the capacity', () => {
    const longText = `[${'1,'.repeat(1200)}1]`
    expect(expectAgreement('loop', longText, 0, larger)).toMatchObject({truncated: 1, valid: 0, firstErrorPosition: 2048, firstErrorKind: errorKind.tooLong})
    // A text of 573 code points is too long for the default capacity and fits in this one.
    const fits = `[${'1,'.repeat(285)}1]`
    expect(expectAgreement('loop', fits, 0)).toMatchObject({truncated: 1, valid: 0, firstErrorKind: errorKind.tooLong})
    expect(expectAgreement('loop', fits, 0, larger)).toMatchObject({truncated: 0, valid: 1})
    expect(expectAgreement('loop', '['.repeat(14) + ']'.repeat(14), 0, larger)).toMatchObject({depthExceeded: 1, firstErrorPosition: 13, firstErrorKind: errorKind.tooDeep})
    expect(expectAgreement('loop', '['.repeat(13) + ']'.repeat(13), 0, larger)).toMatchObject({depthExceeded: 0, valid: 1})
    const exactFit = `[${' '.repeat(2046)}]`
    expect(expectAgreement('loop', exactFit, 2048, larger)).toMatchObject({truncated: 0, valid: 1, caretBracket: 2047, matchingBracket: 0})
    for (const caret of [0, 1]) expect(expectAgreement('loop', exactFit, caret, larger)).toMatchObject({caretBracket: 0, matchingBracket: 2047})
    const pastCapacity = `${exactFit}${'x'.repeat(187)}`
    for (const caret of [2047, 2048]) expect(expectAgreement('loop', pastCapacity, caret, larger)).toMatchObject({caretBracket: 2047, matchingBracket: 0})
    for (const caret of [2049, 2050, 2100, codePointLength(pastCapacity), 10_000]) expect(expectAgreement('loop', pastCapacity, caret, larger)).toMatchObject({caretBracket: -1, matchingBracket: -1})
  })

  test('emitCompare builds integer bits only while the capacity times 2^(maximum depth − 1) is below 2^24', () => {
    // 2,048 × 2^12 is 2^23. One more level reaches exactly 2^24 at position 2,047, like the defaults at position 511.
    for (const form of scanForms) expect(roundingPointCounts(form, larger)).toEqual({'integer bit': 20489})
    expect(roundingPointCounts('loop', {capacity: 2048, maximumDepth: 14})).toEqual({'integer bit': 20487, 'sign cascade': 17})
  })

  test('limits that aren\'t powers of two: 37 code points at depth 3, where most of the corpus is too long or too deep', () => {
    const small: Limits = {capacity: 37, maximumDepth: 3}
    const smallCorpus = createCorpus(20261014, {random: 100, mutated: 200, long: 40}, small)
    const random = createRandom(7)
    const kinds = new Map<number, number>()
    for (const form of scanForms) {
      for (const text of [...corpus.all.slice(0, form === 'loop' ? corpus.all.length : 600), ...smallCorpus.all]) {
        const output = expectAgreement(form, text, Math.floor(random() * (codePointLength(text) + 2)), small)
        if (form === 'loop') kinds.set(output.firstErrorKind, (kinds.get(output.firstErrorKind) ?? 0) + 1)
      }
    }
    expect(kinds.get(errorKind.tooLong)).toBeGreaterThan(300)
    expect(kinds.get(errorKind.tooDeep)).toBeGreaterThan(200)
    expect(kinds.get(errorKind.none)).toBeGreaterThan(1000)
  })

  test('the largest maximum depth is 24, where the container kinds still fit in one FP32 integer', () => {
    // An object at depth 1 and an object at the maximum depth, with arrays between them: the container kinds hold
    // bit 0 and bit maximumDepth − 1 at once, e.g. 2^23 + 1. At depth 25 that would be 2^24 + 1, which FP32 rounds to
    // 2^24, and the closing brace at depth 1 would be reported as an error.
    for (const maximumDepth of [2, 3, 16, 23, 24]) {
      const limits: Limits = {capacity: 128, maximumDepth}
      const text = `{"k":${'['.repeat(maximumDepth - 2)}{"k":1}${']'.repeat(maximumDepth - 2)},"m":2}`
      for (let caret = 0; caret <= codePointLength(text); caret += 7) expect(expectAgreement('loop', text, caret, limits)).toMatchObject({valid: 1})
      expect(expectAgreement('loop', `[${text}]`, 0, limits)).toMatchObject({depthExceeded: 1, firstErrorKind: errorKind.tooDeep})
    }
  })

  test('the builder refuses limits it can\'t build', () => {
    for (const limits of [{capacity: 0, maximumDepth: 16}, {capacity: 512.5, maximumDepth: 16}, {capacity: 1_048_576, maximumDepth: 16}, {capacity: 512, maximumDepth: 1}, {capacity: 512, maximumDepth: 25}]) {
      expect(() => buildHighlighter('loop', limits)).toThrow()
    }
    // The smallest limits build and run.
    const smallest: Limits = {capacity: 1, maximumDepth: 2}
    for (const text of ['', '1', '[', '[]', 'x', ' 1']) expectAgreement('loop', text, 1, smallest)
  })
})
