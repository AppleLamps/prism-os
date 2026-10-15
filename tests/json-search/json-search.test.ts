// The code that both shader writers and the generated JavaScript start from (emit.ts, generated-js.ts), on a small
// program with every kind of row; a document's cells; the plain JavaScript table loop; and the generated documents
// against their labels. search.test.ts and json-step.test.ts compare the page's two programs with their references.
// Run from the repo root: bun test tests/json-search/json-search.test.ts
import {describe, expect, test} from 'bun:test'
import type {Wire} from '../../src/runtime/numeric-ui-core.ts'
import {constant, createSourceTable, input, list} from '../../src/runtime/cells.ts'
import {capacity, displayKind, errorKind} from '../../src/json-search/highlighter/kinds.ts'
import {createCorpus} from './highlighter/corpus.ts'
import {highlightReference} from './highlighter/reference.ts'
import {emitBitLoopWgsl, packWords} from '../../src/json-search/bit-emit.ts'
import {codePointLength, defaultSeed, defects, describeDocuments, documentAt, generateDocuments, shapes} from '../../src/json-search/documents.ts'
import {flattenProgram, wgslFloat} from '../../src/json-search/emit.ts'
import {emitLoopWgsl} from '../../src/json-search/loop-emit.ts'
import {type Binding, type LoopProgram, createLoopRunner, createStage} from '../../src/json-search/loop-program.ts'
import {cellsPerDocument, writeDocumentCells} from '../../src/json-search/program.ts'
import {highlightWithTables, tableLoopResult} from '../../src/json-search/table-loop.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'

// The highlighter's test texts (highlighter/corpus.ts): edge cases, random JSON, random edits, and texts around the
// capacity, 2,509 in all.
const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80}).all

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
const hash2 = (a: number, b: number) => (lowbias32(lowbias32(a) ^ b) >>> 0) / 0x100000000

describe('a program\'s rows as shader statements and as JavaScript statements', () => {
  test('a program with every kind of row and every index read rule gives the executor\'s values: as generated JavaScript, and as both writers\' shaders through the WGSL interpreter', () => {
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
      // table[index] with each pair of rules, a reversed table, and one repeated candidate.
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'clamp', 'clamp'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'zero', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'clamp', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, lookup, 'zero', 'clamp'),
      circuit.indexReadAffine([[index, 0.5], [items[0]!, 0.125]], 1.25, lookup, 'zero', 'clamp'),
      circuit.indexReadAffine([[index, 1]], 2, [...lookup].reverse(), 'clamp', 'zero'),
      circuit.indexReadAffine([[index, 1]], 0, [lookup[2]!, lookup[2]!, lookup[2]!], 'zero', 'zero'),
      // Products and sums that round, a ReGLU, a boolean atom, a shared cell read directly, and a sum of 40 terms, which
      // continues in a second statement.
      circuit.affine([[items[0]!, 0.1], [items[1]!, -0.7], [items[2]!, 3], [cells.factor, 1]], 0.3),
      circuit.reglu([[items[3]!, 0.3], [items[4]!, -1]], 0.1, [[items[5]!, 1], [items[6]!, -0.5]], 0.25),
      circuit.reglu([], 1, [[items[7]!, 1]], -2),
      circuit.boolean(cells.fraction),
      circuit.affine(items.map((item, position) => [item, position % 3 === 0 ? -1.1 : 0.37 * (position + 1)] as const), -5),
    ]
    // A read among the document's own cells, which generated JavaScript runs and a shader writer refuses.
    const readOfOwnCells = circuit.indexReadAffine([[index, 1]], 3, items.slice(4, 30), 'zero', 'clamp')
    const {initialSource} = table.finish()

    // The rows as a loop program of one stage that runs once per document: every document cell is a column of the
    // document's buffer, and every output a column of the document's output.
    const documentCells = [...items, index, cells.fraction]
    const loopOf = (wires: readonly Wire[]): LoopProgram => ({
      positions: 1,
      buffers: [{name: 'documents', cellsPerDocument: documentCells.length}],
      registers: [],
      fields: [],
      outputGroups: [{name: 'values', kind: 'document', valuesPerDocument: wires.length, fill: 0}],
      stages: [createStage({
        name: 'rows', repeat: 'once', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>(documentCells.map((wire, column) => [wire, {kind: 'cell', buffer: 0, column}])),
        outputs: wires.map((wire, column) => ({wire, write: {kind: 'document', group: 0, column}})),
      })],
      results: [],
      sharedValues: new Float32Array(initialSource),
      lengthCell: undefined,
    })

    const count = 600
    const documents = new Float32Array(count * documentCells.length)
    for (let row = 0; row < count; row++) {
      const base = row * documentCells.length
      items.forEach((_, position) => {
        documents[base + position] = Math.round((hash2(row, position) * 128 - 64) * 8) / 8
      })
      // Whole indices below, inside and above the tables, and fractional ones, which the read floors.
      documents[base + items.length] = row % 2 === 0 ? Math.floor(hash2(row, 100) * 33) - 12 : hash2(row, 101) * 32 - 12
      documents[base + items.length + 1] = row % 7 === 0 ? 0.5 : hash2(row, 102)
    }
    const valuesOf = (loop: LoopProgram, backend: 'executor' | 'generated') => {
      const runner = createLoopRunner(loop, backend)
      const values = new Float32Array(count * loop.outputGroups[0]!.valuesPerDocument)
      for (let row = 0; row < count; row++) runner.run([documents], row, [values], row, -1)
      return values
    }

    // Generated JavaScript, with the read among the document's own cells.
    const withOwnCells = loopOf([...outputs, readOfOwnCells])
    const expectedWithOwnCells = valuesOf(withOwnCells, 'executor')
    expect(new Set(expectedWithOwnCells).size).toBeGreaterThan(1000)
    expect([...valuesOf(withOwnCells, 'generated')]).toEqual([...expectedWithOwnCells])
    expect(() => emitLoopWgsl(withOwnCells)).toThrow('an index read\'s candidates are shared cells')

    // Both writers' shaders, without that read.
    const loop = loopOf(outputs)
    const expected = valuesOf(loop, 'executor')
    const fromLoopEmit = emitLoopWgsl(loop)
    expect([fromLoopEmit.rowCounts.index, fromLoopEmit.rowCounts.boolean]).toEqual([7, 1])
    const fromBitEmit = emitBitLoopWgsl(loop)
    for (const [shader, packed] of [[fromLoopEmit, undefined], [fromBitEmit, packWords(fromBitEmit.packedCells, loop.sharedValues)]] as const) {
      const values = new Float32Array(expected.length)
      createWgslInterpreter(shader.code)(loop.sharedValues, documents, count, [values], packed === undefined ? {} : {packed})
      expect([...values]).toEqual([...expected])
    }
  })

  test('refuses an index read whose candidates are computed values, e.g. a read among sums', () => {
    const table = createSourceTable()
    const cells = table.declare({prices: list(4, () => input([0, 8], {grid: 1})), quantities: list(4, () => input([0, 8], {grid: 1})), index: input([0, 3], {grid: 1})})
    const circuit = table.createCircuit()
    // JS: totals[index], where totals[item] = prices[item] × quantities[item] is computed from cells.
    const totals = cells.prices.map((price, item) => circuit.reglu([[price, 1]], 0, [[cells.quantities[item]!, 1]], 0))
    const total = circuit.indexRead(cells.index, totals)
    table.finish()
    // A shader writes one `let` per value, and a `let` can't be indexed. Every writer reads a program through
    // flattenProgram, so every writer refuses such a read.
    expect(() => flattenProgram(circuit.compileTensorProgram([total]))).toThrow('candidates are computed values')
  })

  test('literals are exact float32 values', () => {
    expect([1, -3, 0.5, 2 ** 24, -(2 ** 24), 16_777_218, 0.1, -0, 1e-40].map(value => wgslFloat(Math.fround(value)))).toEqual([
      '1.0f', '(-3.0f)', '0x1.000000p-1f', '0x1.000000p24f', '(-0x1.000000p24f)', '0x1.000002p24f', '0x1.99999ap-4f', '(-0.0f)', '0x0.022d84p-126f',
    ])
  })
})

describe('a document\'s cells', () => {
  test('writeDocumentCells writes the text\'s first 512 code points, -1 after them, and the text\'s length in code points', () => {
    const cells = new Float32Array(cellsPerDocument)
    // The test texts, an emoji, a lone high surrogate and a lone low one, and 300 emoji, which are 600 UTF-16 code units.
    for (const text of [...corpus, '😀', 'a\ud83d', '\ude00b', `"${'😀'.repeat(300)}"`]) {
      writeDocumentCells(cells, 0, text)
      // Array.from reads a string by code points: a surrogate pair is one code point, and a lone surrogate is its own.
      const codePoints = Array.from(text, character => character.codePointAt(0)!)
      const expected = [...Array.from({length: capacity}, (_, position) => codePoints[position] ?? -1), codePoints.length]
      if (expected.some((value, column) => cells[column] !== value)) expect({text, cells: [...cells]}).toEqual({text, cells: expected})
    }
    expect([...cells.subarray(0, 3), cells[capacity]]).toEqual([0x22, 0x1f600, 0x1f600, 302])
    // A text of more than 1,048,576 code points writes that length, which still reads as longer than 512.
    writeDocumentCells(cells, 0, 'a'.repeat(1_048_600))
    expect([cells[0], cells[capacity - 1], cells[capacity]]).toEqual([0x61, 0x61, 1_048_576])
  })
})

describe('the table loop', () => {
  test('gives the reference\'s kinds, first error and truncated on the test texts and on generated documents', () => {
    const kinds = new Uint8Array(capacity)
    const texts = [...corpus, ...generateDocuments(3000).map(document => document.text)]
    for (const text of texts) {
      highlightWithTables(text, kinds, 0)
      const reference = highlightReference(text)
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
      const reference = highlightReference(document.text)
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
    const kindsSeen = new Set(documents.slice(0, 500).flatMap(document => highlightReference(document.text).displayKinds))
    expect([...kindsSeen].sort((left, right) => left - right)).toEqual(Object.values(displayKind).sort((left, right) => left - right))
  })
})

const pinnedDocumentsHash = 3_798_448_091
