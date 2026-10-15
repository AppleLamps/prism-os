// Compares the program with the plain JavaScript reference. reference.test.ts beside this file tests the reference itself.
// Run from the repo root: bun test tests/json-search/highlighter/highlighter.test.ts
import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads, validateNoNaN} from '../../../src/runtime/numeric-ui-core.ts'
import {createCorpus, createRandom, edgeCases} from './corpus.ts'
import {type HighlighterOutput, type ScanForm, createHighlighterMachine, scanForms} from '../../../src/json-search/highlighter/highlighter.ts'
import {capacity, errorKind} from '../../../src/json-search/highlighter/kinds.ts'
import {highlightReference} from './reference.ts'

const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80})
const codePointLength = (text: string) => Array.from(text).length
const machines = new Map(scanForms.map(form => [form, createHighlighterMachine(form)]))
const machineFor = (form: ScanForm) => machines.get(form)!

// Runs one text at one caret through the program and the reference, and throws with the text when they differ.
function expectAgreement(form: ScanForm, text: string, caret: number): HighlighterOutput {
  const output = machineFor(form).run(text, caret)
  const expected = highlightReference(text, caret)
  const actual = {...output, displayKinds: [...output.displayKinds]}
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    expect({form, text, caret, ...actual}).toEqual({form, text, caret, ...expected})
  }
  return output
}

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
    for (const form of scanForms) {
      const counts = new Map<string, number>()
      for (const point of machineFor(form).built.circuit.roundingPoints()) counts.set(point.kind, (counts.get(point.kind) ?? 0) + 1)
      expect(Object.fromEntries(counts)).toEqual({'integer bit': 5127, 'sign cascade': 17})
    }
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
