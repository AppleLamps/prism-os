// The emitted shaders through the strict WGSL interpreter against the CPU executor, the other CPU versions of the
// highlighter against each other, and the generated documents against their labels. A real GPU compiler may fuse or
// regroup operations; gpu/run.ts checks the same outputs in headless Chrome.
// Run from the repo root: bun test lab/json-search
import {describe, expect, test} from 'bun:test'
import {constant, createSourceTable, input, list} from '../../src/runtime/cells.ts'
import {writeText} from '../../src/json-highlighter/highlighter.ts'
import {capacity, displayKind, errorKind} from '../../src/json-highlighter/kinds.ts'
import {createCorpus} from '../../tests/json-highlighter/corpus.ts'
import {highlightReference} from '../../tests/json-highlighter/reference.ts'
import {countMismatches, expectedOutputs} from './check.ts'
import {codePointLength, defaultSeed, defects, describeDocuments, documentAt, generateDocuments, shapes} from './documents.ts'
import {emitWgsl, packSharedValues, wgslFloat} from './emit.ts'
import {emitJavaScript} from './generated-js.ts'
import {buildBatchPrograms, cellsPerDocument, kindCount, summaryCount, writeDocumentCells} from './program.ts'
import {highlightWithTables, tableLoopResult} from './table-loop.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'

// The texts of tests/json-highlighter/highlighter.test.ts: edge cases, random JSON, random edits, and texts around the
// capacity, 2,509 in all.
const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80}).all
const batch = buildBatchPrograms()
const [summaryProgram, displayProgram] = batch.programs as [typeof batch.programs[number], typeof batch.programs[number]]
const corpusCells = new Float32Array(corpus.length * cellsPerDocument)
corpus.forEach((text, index) => writeDocumentCells(corpusCells, index * cellsPerDocument, text))
// The executor's outputs for every corpus text, per root set.
const corpusExpected = new Map(batch.programs.map(program => [program.rootSet, expectedOutputs(program, corpusCells, corpus.length)]))

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
const hash2 = (a: number, b: number) => (lowbias32(lowbias32(a) ^ b) >>> 0) / 0x100000000

describe('the emitter', () => {
  test('a program with every kind of row and every index read rule gives the executor\'s values, with and without guards', () => {
    const table = createSourceTable()
    const cells = table.declare({
      items: list(40, () => input([-64, 64])),
      index: input([-12, 20]),
      fraction: input([0, 1]),
      lookup: [3.5, -2, 7.25, 0.5, 11].map(value => constant(value, [-20, 20])),
      factor: constant(0.3, [0, 1]),
    })
    const circuit = table.createCircuit()
    const {items, index, lookup} = cells
    const outputs = [
      // table[index] with each pair of rules, a reversed table, one repeated candidate, and the instance's own cells.
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'clamp', 'clamp'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'zero', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'clamp', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'zero', 'clamp'),
      circuit.indexReadAffine([[index, 0.5], [items[0]!, 0.125]], 1.25, lookup, 'zero', 'clamp'),
      circuit.indexReadAffine([[index, 1]], 2, [...lookup].reverse(), 'clamp', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, [lookup[2]!, lookup[2]!, lookup[2]!], 'zero', 'zero'),
      circuit.indexReadAffine([[index, 1]], 3, items.slice(4, 30), 'zero', 'clamp'),
      // Products and sums that round, a ReGLU, a boolean atom, a shared cell read directly, and a sum of 40 terms, which
      // continues in a second statement.
      circuit.affine([[items[0]!, 0.1], [items[1]!, -0.7], [items[2]!, 3], [cells.factor, 1]], 0.3),
      circuit.reglu([[items[3]!, 0.3], [items[4]!, -1]], 0.1, [[items[5]!, 1], [items[6]!, -0.5]], 0.25),
      circuit.reglu([], 1, [[items[7]!, 1]], -2),
      circuit.boolean(cells.fraction),
      circuit.affine(items.map((item, position) => [item, position % 3 === 0 ? -1.1 : 0.37 * (position + 1)] as const), -5),
    ]
    const {initialSource} = table.finish()
    const program = circuit.compileTensorProgram(outputs)
    const evaluate = circuit.createTensorProgramEvaluator(program)
    const instanceCells = [...items, index, cells.fraction]
    const count = 600
    const instances = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const base = instance * instanceCells.length
      items.forEach((_, position) => {
        instances[base + position] = Math.round((hash2(instance, position) * 128 - 64) * 8) / 8
      })
      // Whole indices below, inside and above the tables, and fractional ones, which the read floors.
      instances[base + items.length] = instance % 2 === 0 ? Math.floor(hash2(instance, 100) * 33) - 12 : hash2(instance, 101) * 32 - 12
      instances[base + items.length + 1] = instance % 7 === 0 ? 0.5 : hash2(instance, 102)
    }
    const source = new Float32Array(initialSource)
    const expected = new Float32Array(count * outputs.length)
    for (let instance = 0; instance < count; instance++) {
      instanceCells.forEach((wire, column) => {
        source[wire] = instances[instance * instanceCells.length + column]!
      })
      expected.set(evaluate(source), instance * outputs.length)
    }
    expect(new Set(expected).size).toBeGreaterThan(1000)
    for (const guard of ['none', 'max'] as const) {
      // Two output groups: the reads, then the rest.
      const shader = emitWgsl(program, {instanceCells, outputGroups: [outputs.slice(0, 8), outputs.slice(8)], guard})
      expect(shader.rowCounts.index).toBe(8)
      expect(shader.rowCounts.boolean).toBe(1)
      expect(shader.guards > 0).toBe(guard === 'max')
      const groups = [new Float32Array(count * 8), new Float32Array(count * (outputs.length - 8))]
      createWgslInterpreter(shader.code)(packSharedValues(shader, new Float32Array(initialSource)), instances, count, groups)
      for (let instance = 0; instance < count; instance++) {
        const row = [...groups[0]!.subarray(instance * 8, instance * 8 + 8), ...groups[1]!.subarray(instance * (outputs.length - 8), (instance + 1) * (outputs.length - 8))]
        expect(row).toEqual([...expected.subarray(instance * outputs.length, (instance + 1) * outputs.length)])
      }
    }
    const generated = emitJavaScript(program, {instanceCells, outputGroups: [outputs]})
    const fromJavaScript = new Float32Array(count * outputs.length)
    generated.run(new Float32Array(initialSource), instances, count, [fromJavaScript])
    expect(countMismatches(fromJavaScript, expected, expected.length)).toBe(0)
  })

  test('refuses an index read whose candidates are computed per instance, e.g. the highlighter\'s firstErrorKind', () => {
    const {circuit, output, cells} = batch.built
    const program = circuit.compileTensorProgram([output.firstErrorKind])
    expect(() => emitWgsl(program, {instanceCells: [...cells.codePoints, cells.textLength], outputGroups: [[output.firstErrorKind]]})).toThrow('candidates are computed values')
  })

  test('literals are exact float32 values', () => {
    expect([1, -3, 0.5, 2 ** 24, -(2 ** 24), 16_777_218, 0.1, -0, 1e-40].map(value => wgslFloat(Math.fround(value)))).toEqual([
      '1.0f', '(-3.0f)', '0x1.000000p-1f', '0x1.000000p24f', '(-0x1.000000p24f)', '0x1.000002p24f', '0x1.99999ap-4f', '(-0.0f)', '0x0.022d84p-126f',
    ])
  })
})

describe('the highlighter\'s batch programs', () => {
  test('have the sizes the README gives', () => {
    expect(summaryProgram.sizes).toMatchObject({sourceCells: 4575, operations: 7186, layers: 536, indexReads: 4609})
    expect(displayProgram.sizes).toMatchObject({sourceCells: 4575, operations: 7698, layers: 536, indexReads: 5121})
    const summaryShader = summaryProgram.emitShader()
    const displayShader = displayProgram.emitShader()
    expect([summaryShader.statementCount, summaryShader.outputCounts, summaryShader.cellsPerInstance]).toEqual([11_814, [summaryCount], cellsPerDocument])
    expect([displayShader.statementCount, displayShader.outputCounts, displayShader.cellsPerInstance]).toEqual([13_350, [summaryCount, kindCount], cellsPerDocument])
    // Every weight and bias is an integer. The 12 of 2^24 or more belong to the sign cascade at position 511.
    expect([summaryShader.fractionalLiterals, summaryShader.largeIntegerLiterals, summaryShader.rowCounts.boolean]).toEqual([0, 12, 0])
    expect(displayProgram.emitShader({guard: 'max'}).guards).toBe(9737)
  })

  test('writeDocumentCells writes what the highlighter\'s writeText writes', () => {
    const source = new Float32Array(batch.built.initialSource)
    const cells = new Float32Array(cellsPerDocument)
    for (const text of [...corpus, '😀', 'a\ud83d', '\ude00b', `"${'😀'.repeat(300)}"`]) {
      writeText(batch.built.cells, source, text, 0)
      writeDocumentCells(cells, 0, text)
      const expected = [...batch.built.cells.codePoints, batch.built.cells.textLength].map(wire => source[wire]!)
      if (countMismatches(cells, expected, cellsPerDocument) > 0) expect({text, cells: [...cells]}).toEqual({text, cells: expected})
    }
  })

  test('the executor\'s summary and display kinds are the plain JavaScript reference\'s, on the highlighter\'s test texts', () => {
    const [summary, kinds] = corpusExpected.get('display')!
    corpus.forEach((text, index) => {
      const reference = highlightReference(text, 0)
      const actual = {text, summary: [...summary!.subarray(index * summaryCount, (index + 1) * summaryCount)], kinds: [...kinds!.subarray(index * kindCount, (index + 1) * kindCount)]}
      const expected = {text, summary: [reference.valid, reference.firstErrorPosition, reference.truncated], kinds: reference.displayKinds}
      if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual).toEqual(expected)
    })
    // The summary program computes the same three values.
    expect(countMismatches(corpusExpected.get('summary')![0]!, summary!, summary!.length)).toBe(0)
  })

  for (const program of batch.programs) {
    test(`${program.rootSet}: the shader without guards gives the executor's outputs through the WGSL interpreter, on every test text`, () => {
      const shader = program.emitShader()
      const outputs = program.outputCounts.map(count => new Float32Array(corpus.length * count))
      createWgslInterpreter(shader.code)(program.packShared(shader), corpusCells, corpus.length, outputs)
      const expected = corpusExpected.get(program.rootSet)!
      outputs.forEach((group, groupIndex) => expect(countMismatches(group, expected[groupIndex]!, group.length)).toBe(0))
    }, 60_000)

    test(`${program.rootSet}: the shader with guards does too, on every fifth test text`, () => {
      const texts = corpus.filter((_, index) => index % 5 === 0)
      const cells = new Float32Array(texts.length * cellsPerDocument)
      texts.forEach((text, index) => writeDocumentCells(cells, index * cellsPerDocument, text))
      const shader = program.emitShader({guard: 'max'})
      const outputs = program.outputCounts.map(count => new Float32Array(texts.length * count))
      createWgslInterpreter(shader.code)(program.packShared(shader), cells, texts.length, outputs)
      const expected = expectedOutputs(program, cells, texts.length)
      outputs.forEach((group, groupIndex) => expect(countMismatches(group, expected[groupIndex]!, group.length)).toBe(0))
    }, 60_000)

    test(`${program.rootSet}: generated JavaScript gives the executor's outputs on every test text`, () => {
      const generated = program.emitJavaScript()
      const outputs = program.outputCounts.map(count => new Float32Array(corpus.length * count))
      generated.run(program.sharedValues, corpusCells, corpus.length, outputs)
      const expected = corpusExpected.get(program.rootSet)!
      outputs.forEach((group, groupIndex) => expect(countMismatches(group, expected[groupIndex]!, group.length)).toBe(0))
    }, 60_000)
  }

  test('countMismatches counts zeros of either sign as equal, and a NaN as a mismatch', () => {
    expect(countMismatches(Float32Array.of(0, -0, 1, Number.NaN), [-0, 0, 1, Number.NaN], 4)).toBe(1)
    expect(countMismatches(Float32Array.of(1, 2, 3), [1, 5, 3], 3)).toBe(1)
  })
})

describe('the table loop', () => {
  test('gives the reference\'s kinds, first error and truncated on the test texts and on generated documents', () => {
    const kinds = new Uint8Array(capacity)
    const texts = [...corpus, ...generateDocuments(3000).map(document => document.text)]
    for (const text of texts) {
      highlightWithTables(text, kinds, 0)
      const reference = highlightReference(text, 0)
      const actual = {text, ...tableLoopResult, kinds: [...kinds]}
      const expected = {text, firstErrorPosition: reference.firstErrorPosition, firstErrorKind: reference.firstErrorKind, truncated: reference.truncated, kinds: reference.displayKinds}
      if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual).toEqual(expected)
    }
  })
})

describe('the generated documents', () => {
  const documents = generateDocuments(20_000)

  test('a document depends only on the seed and its index', () => {
    for (const index of [0, 1, 7, 19_999]) expect(documentAt(defaultSeed, index)).toEqual(documents[index]!)
    expect(documentAt(defaultSeed + 1, 7).text).not.toBe(documents[7]!.text)
    // A hash of the first 2,000 texts, so a change to the generator, which would change every timing's input, fails here.
    let hash = 0
    for (const {text} of documents.slice(0, 2000)) for (let index = 0; index < text.length; index++) hash = lowbias32(hash ^ text.charCodeAt(index))
    expect(hash >>> 0).toBe(pinnedDocumentsHash)
  })

  test('a document is valid exactly when it has no defect, and JSON.parse agrees except past the depth or the capacity', () => {
    for (const document of documents) {
      let parses = true
      try {
        JSON.parse(document.text)
      } catch {
        parses = false
      }
      const reference = highlightReference(document.text, 0)
      const expectValid = document.defect === 'none'
      const expectParses = expectValid || document.defect === 'tooDeep' || document.defect === 'tooLong'
      const fits = codePointLength(document.text) <= capacity
      if (reference.valid !== Number(expectValid) || parses !== expectParses || fits !== (document.defect !== 'tooLong')) {
        expect({document, valid: reference.valid, parses, fits}).toEqual({document, valid: Number(expectValid), parses: expectParses, fits: document.defect !== 'tooLong'})
      }
      if (document.defect === 'tooDeep') expect(reference.firstErrorKind).toBe(errorKind.tooDeep)
      if (document.defect === 'tooLong') expect([reference.firstErrorKind, reference.firstErrorPosition, reference.truncated]).toEqual([errorKind.tooLong, capacity, 1])
    }
  })

  test('every shape and every defect appears, about 1 document in 10 is broken, and the lengths spread up to the capacity', () => {
    const description = describeDocuments(documents)
    for (const shape of shapes) expect(description.shapes[shape]).toBeGreaterThan(2000)
    for (const defect of defects) expect(description.defects[defect]).toBeGreaterThan(60)
    expect(description.invalid).toBe(1979)
    expect(description.lengths).toEqual({minimum: 5, quartile1: 215, median: 300, quartile3: 387, maximum: 1382, mean: 301.8})
    expect(description.histogram.reduce((total, bucket) => total + bucket, 0)).toBe(documents.length)
    expect(description.histogram.at(-1)).toBe(description.defects.tooLong)
    // Some documents hold characters past U+007F, and some a display kind of every sort except pastEnd-only texts.
    expect(description.nonAscii).toBeGreaterThan(4000)
    const kindsSeen = new Set(documents.slice(0, 500).flatMap(document => highlightReference(document.text, 0).displayKinds))
    expect([...kindsSeen].sort((left, right) => left - right)).toEqual(Object.values(displayKind).sort((left, right) => left - right))
  })
})

const pinnedDocumentsHash = 3_798_448_091
