// The plain JavaScript reference on its own: against JSON.parse, against the definitions of the first error on texts cut
// short, and against first errors and display kinds written by hand. JSON search's tests compare the page's programs
// with this reference, so these tests are what checks the reference itself on broken texts.
// Run from the repo root: bun test tests/json-search/highlighter/reference.test.ts
import {describe, expect, test} from 'bun:test'
import {capacity, displayKind, errorKind, errorKinds, maximumDepth} from '../../../src/json-search/highlighter/kinds.ts'
import {createCorpus} from './corpus.ts'
import {highlightReference} from './reference.ts'

const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80})
const codePointLength = (text: string) => Array.from(text).length

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
      const result = highlightReference(text)
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
    expect(highlightReference(text)).toMatchObject({valid: 0, firstErrorKind: errorKind.tooDeep, firstErrorPosition: 5 + 15})
  })

  test('every prefix of a valid text is incomplete or valid, and a text cut at its first error has no earlier error', () => {
    for (const text of corpus.all.slice(0, 1200)) {
      const codePoints = Array.from(text)
      const result = highlightReference(text)
      if (result.valid === 1) {
        for (let cut = 0; cut < codePoints.length; cut++) {
          const prefix = highlightReference(codePoints.slice(0, cut).join(''))
          if (prefix.valid !== 1) expect([prefix.firstErrorKind, prefix.firstErrorPosition]).toEqual([errorKind.unexpectedEnd, cut])
        }
      } else if (result.firstErrorPosition <= codePoints.length) {
        const cut = result.firstErrorPosition
        const prefix = highlightReference(codePoints.slice(0, cut).join(''))
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
      expect([text, highlightReference(text).firstErrorPosition, errorKinds[highlightReference(text).firstErrorKind]]).toEqual([text, position, kind])
    }
  })

  test('shows each character as the kind that the rules say', () => {
    // One letter per code point, written by hand from the rules at the top of reference.ts and in kinds.ts.
    const letters = {w: 'whitespace', p: 'punctuation', s: 'string', k: 'key', e: 'escape', n: 'number', l: 'literal', x: 'error'} as const
    const letterOfKind = new Map(Object.entries(letters).map(([letter, name]) => [displayKind[name], letter]))
    const cases: [text: string, kinds: string][] = [
      // A string in a key position is a key, and a string value is a string.
      ['{"a": "b"}', 'pkkkpwsssp'],
      ['["a"]', 'psssp'],
      ['[1, true, null, -2.5e3]', 'pnpwllllpwllllpwnnnnnnp'],
      [' \t\r\n1', 'wwwwn'],
      // An escape is its own kind, in a value and in a key.
      ['"a\\n\\u00e9"', 'sseeeeeeees'],
      ['{"a\\tb": 1}', 'pkkeekkpwnp'],
      // After a lexer error, the rest of the line is an error, and the next line is tokenized again.
      ['[x y\n1]', 'pxxxwnp'],
      ['[01]', 'pnxx'],
      ['[nul!]', 'plllxx'],
      ['"\\u12x4"', 'seeeexxx'],
      ['"\\q"', 'sexx'],
      // A line feed that is itself the error starts tokenizing again right away, here at a `b` that starts no token.
      ['"a\nb"', 'ssxxx'],
      // A key is found only before the first error, which is the second string here.
      ['{"a": 1 "b": 2, "c": 3}', 'pkkkpwnwssspwnpwssspwnp'],
    ]
    for (const [text, kinds] of cases) {
      const result = highlightReference(text)
      const length = Array.from(text).length
      const shown = result.displayKinds.slice(0, length).map(kind => letterOfKind.get(kind) ?? '?').join('')
      // The cell after the text is pastEnd.
      expect([text, shown, result.displayKinds[length]]).toEqual([text, kinds, displayKind.pastEnd])
    }
  })
})
