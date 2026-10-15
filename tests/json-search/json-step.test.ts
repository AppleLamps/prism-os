// The page's highlighter program against the plain JavaScript reference. The program is json-step.ts's step, run once per
// position by loop-program.ts. The reference, highlighter/reference.ts, is a scanner and a parser written from JSON's
// grammar, and it doesn't read the tables that the step reads, so a wrong table cell that changes a text's result fails
// here. Both CPU forms of the program run: the CPU executor, which defines a program's values, and generated JavaScript,
// which the page's CPU search runs. The last test runs the step on the literal evaluator, which computes every operation
// as built, and checks what the step declares about its values at every position.
// Run from the repo root: bun test tests/json-search/json-step.test.ts
import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads, validateNoNaN} from '../../src/runtime/numeric-ui-core.ts'
import {capacity, displayKind, errorKinds, maximumDepth} from '../../src/json-search/highlighter/kinds.ts'
import {buildJsonLoop, stepSummaryNames} from '../../src/json-search/json-step.ts'
import {createLoopRunner} from '../../src/json-search/loop-program.ts'
import {cellsPerDocument, writeDocumentCells} from '../../src/json-search/program.ts'
import {handWrittenDocuments} from './edge-cases.ts'
import {createCorpus} from './highlighter/corpus.ts'
import {highlightReference} from './highlighter/reference.ts'

const built = buildJsonLoop()
const backends = ['executor', 'generated'] as const
const backendName = {executor: 'the CPU executor', generated: 'generated JavaScript'}

// Runs every text through the loop program, and throws at the first text whose summary (valid, firstErrorPosition,
// truncated, firstErrorKind) or 512 display kinds aren't the reference's, with the text, both summaries, and the first
// position whose display kind differs. Returns the references.
function expectTheReference(backend: typeof backends[number], texts: readonly string[]) {
  const runner = createLoopRunner(built.loop, backend)
  const cells = new Float32Array(cellsPerDocument)
  const summary = new Float32Array(stepSummaryNames.length)
  const kinds = new Float32Array(capacity)
  return texts.map(text => {
    writeDocumentCells(cells, 0, text)
    runner.run([cells], 0, [summary, kinds], 0, 0)
    const reference = highlightReference(text, 0)
    const expectedSummary = stepSummaryNames.map(name => reference[name])
    const differingKind = reference.displayKinds.findIndex((kind, position) => kinds[position] !== kind)
    if (differingKind !== -1 || expectedSummary.some((value, column) => summary[column] !== value)) {
      const kindsMessage = differingKind === -1 ? 'the display kinds are the same' : `the display kind at position ${differingKind} is ${kinds[differingKind]}, and the reference's is ${reference.displayKinds[differingKind]}`
      throw new Error(`${JSON.stringify(text)} on ${backendName[backend]}: ${stepSummaryNames.join(', ')} are ${summary.join(', ')}, and the reference's are ${expectedSummary.join(', ')}; ${kindsMessage}`)
    }
    return reference
  })
}

describe('the highlighter\'s step, run over a document\'s positions, gives the reference\'s summary, first error kind and display kinds', () => {
  // Edge cases written by hand, random JSON, random edits of random JSON, and texts around the capacity: 2,509 in all.
  const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80}).all
  // The documents at the page's limits: lengths around 512 code points, nesting around depth 16, container codes at
  // their largest, and characters at the class boundaries.
  const edgeTexts = handWrittenDocuments().map(document => document.text)
  // For every depth, the two texts whose container code is nearest the depth's level weight, 2^(depth − 1). An object
  // inside arrays, e.g. [[{"a":1}]] at depth 3, has a code of exactly the weight, so the step calls the container an
  // array when the table's weight is larger. An array inside objects, e.g. {"k":{"k":[1]}}, has a code of the weight
  // minus 1, so the step calls the container an object when the table's weight is smaller.
  const depths = Array.from({length: maximumDepth}, (_, index) => index + 1)
  const nestedTexts = depths.flatMap(depth => [
    `${'['.repeat(depth - 1)}{"a":1}${']'.repeat(depth - 1)}`,
    `${'{"k":'.repeat(depth - 1)}[1]${'}'.repeat(depth - 1)}`,
  ])

  for (const backend of backends) {
    test(`on ${backendName[backend]}, for the ${corpus.length.toLocaleString('en-US')} test texts`, () => {
      const references = expectTheReference(backend, corpus)
      expect(corpus.length).toBe(2509)
      // The texts reach every kind of first error, and none, so every kind is compared.
      expect(new Set(references.map(reference => reference.firstErrorKind)).size).toBe(errorKinds.length)
    }, 60_000)

    test(`on ${backendName[backend]}, for the hand-written documents at the limits`, () => {
      const references = expectTheReference(backend, edgeTexts)
      expect(references.length).toBeGreaterThan(250)
      expect(references.some(reference => reference.truncated === 1)).toBe(true)
    }, 60_000)

    test(`on ${backendName[backend]}, for an object and an array at every depth, which are valid`, () => {
      const references = expectTheReference(backend, nestedTexts)
      expect(references.map(reference => reference.valid)).toEqual(nestedTexts.map(() => 1))
    })
  }

  test('on the literal evaluator, with every declared grid and index read holding at every position', () => {
    // The nested texts, every tenth document at the limits, and for each kind of first error, and for none, the first
    // three test texts that have it.
    const textsOfKind = errorKinds.map(() => [] as string[])
    for (const text of corpus) {
      const ofKind = textsOfKind[highlightReference(text, 0).firstErrorKind]!
      if (ofKind.length < 3) ofKind.push(text)
    }
    const texts = [...nestedTexts, ...edgeTexts.filter((_, index) => index % 10 === 0), ...textsOfKind.flat()]
    const {loop} = built
    const cells = new Float32Array(cellsPerDocument)
    for (const text of texts) {
      writeDocumentCells(cells, 0, text)
      // JS: what loop-program.ts's runner does, with circuit.evaluateReference in place of the compiled stage.
      let registers = loop.registers.map(register => register.initial)
      const summary = Array<number>(stepSummaryNames.length).fill(0)
      const kinds = Array<number>(capacity).fill(displayKind.pastEnd)
      for (const stage of loop.stages) {
        const source = loop.sharedValues.slice(stage.sharedOffset, stage.sharedOffset + stage.program.sourceSize)
        const count = stage.repeat === 'once' ? 1 : loop.positions
        for (let position = 0; position < count; position++) {
          for (const [wire, binding] of stage.bindings) {
            if (binding.kind === 'field') throw new Error('the highlighter\'s step reads no field')
            source[wire] = binding.kind === 'item' ? cells[position]! : binding.kind === 'cell' ? cells[binding.column]! : registers[binding.register]!
          }
          const values = stage.circuit.evaluateReference(source)
          validateIndexReads(stage.circuit, values)
          validateGrids(stage.circuit, values)
          validateNoNaN(stage.circuit, values)
          const nextRegisters = [...registers]
          for (const {wire, write} of stage.outputs) {
            if (write.kind === 'register') nextRegisters[write.register] = values[wire]!
            else if (write.kind === 'position') kinds[position] = values[wire]!
            else if (write.kind === 'document') summary[write.column] = values[wire]!
          }
          registers = nextRegisters
        }
      }
      const reference = highlightReference(text, 0)
      if (JSON.stringify({summary, kinds}) !== JSON.stringify({summary: stepSummaryNames.map(name => reference[name]), kinds: reference.displayKinds})) {
        expect({text, summary, kinds}).toEqual({text, summary: stepSummaryNames.map(name => reference[name]), kinds: reference.displayKinds})
      }
    }
    expect(texts.length).toBe(nestedTexts.length + 28 + 3 * errorKinds.length)
  }, 60_000)
})
