// Regex search as a loop over positions (search-step.ts) against regex search's form (a) with every position written
// out, on the CPU executor: the loop program on the executor, on generated JavaScript, and its WGSL text through the
// strict interpreter, as loop-emit.ts writes it and as bit-emit.ts writes it. The demo page's searches run bit-emit.ts's
// shaders, so where a test samples its cases, bit-emit.ts's shader runs on more of them. A real GPU compiler may fuse
// or regroup operations; gpu/search-run.ts and million/run.ts's 'writers' mode, in lab/json-search, check the same outputs in headless Chrome.
// Run from the repo root: bun test tests/json-search/search.test.ts
import {describe, expect, test} from 'bun:test'
import {buildDataSearch, writePattern} from '../../src/json-search/regex/data-program.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../../src/json-search/regex/pattern.ts'
import {automatonMatches} from './regex/reference.ts'
import {displayKind, errorKind} from '../../src/json-search/highlighter/kinds.ts'
import {createCorpus} from './highlighter/corpus.ts'
import {emitBitLoopWgsl, packWords} from '../../src/json-search/bit-emit.ts'
import {bitRowTables, createBitRowSearch} from './bit-rows.ts'
import {expectedOutputs} from '../../src/json-search/check.ts'
import {generateDocuments} from '../../src/json-search/documents.ts'
import {buildJsonLoop, stepSummaryNames} from '../../src/json-search/json-step.ts'
import {emitLoopWgsl} from '../../src/json-search/loop-emit.ts'
import {type LoopProgram, createLoopRunner, describeLoop, operationsPerDocument} from '../../src/json-search/loop-program.ts'
import {buildBatchPrograms, kindCount as kindsPerDocument, cellsPerDocument as storeCells, summaryCount, writeDocumentCells} from '../../src/json-search/program.ts'
import {type SearchScope, boundaryCapacity, buildMaskedSearch, buildSearchLoop, classCapacity, searchScopes, searchableKinds} from '../../src/json-search/search-step.ts'
import {type WgslInterpreter, createWgslInterpreter} from './wgsl-interpreter.ts'

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
function createRandom(seed: number) {
  let counter = 0
  return () => (lowbias32(lowbias32(seed) ^ counter++) >>> 0) / 0x100000000
}
const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!

// 16 letters with a letter between each two, so each one is a region of its own: a pattern that tells all 16 apart has
// 16 classes and 32 class boundaries, the capacities.
const isolatedLetters = Array.from('acegikmoqsuwyACE')
// Atom k holds the letters whose number, from 1, has bit k set, which gives every letter its own set of atoms.
const lettersOfBit = (bit: number) => isolatedLetters.filter((_, index) => ((index + 1) >> bit) & 1).join('')
const fullClassesPattern = `([${lettersOfBit(0)}]|[${lettersOfBit(1)}]|[${lettersOfBit(2)}]|[${lettersOfBit(3)}]|[${lettersOfBit(4)}]|a|c)+`

// Patterns for a capacity of 8 states: regex/test-patterns.ts's edge cases, the capacities, and the measurement's patterns.
const handPatterns = [
  'a', 'a*', '', '()*', 'a|ab', '(a|ab)(c|bcd)', 'a+b|a', 'aba', 'a(bc)*', '.+', '[^a]+', '.', '\\w+', '\\d+', '😀+', '[]', '[^]', '[^]*',
  '\\d+\\.\\d+', '[a-c-]+', '(x|y)*z', 'abc', 'b+', '(the|an?) [a-z]+', 'abcdefg', fullClassesPattern, 'error', '[a-z0-9.]+@[a-z.]+',
  '"[a-z]+":', '[A-Z][a-z]+ [A-Z][a-z]+', '([a-z]+)+x',
]
const textAlphabet = ['a', 'b', 'c', 'x', 'y', 'z', '0', '9', 'Z', '_', '-', '.', '\n', ' ', ' ', 'é', '😀', '\u{10FFFF}', 't', 'h', 'e', 'n', '"', ':', '@', ...isolatedLetters]

// Random patterns over a small alphabet, like regex/test-patterns.ts's: literals, classes, groups, alternation, repeats.
function randomPattern(random: () => number, depth: number): string {
  const roll = random()
  if (depth <= 0 || roll < 0.35) {
    const atom = random()
    if (atom < 0.5) return pick(random, ['a', 'b', 'c', 'x', '0', '\\.', '-', 'é', '😀', ' '])
    if (atom < 0.6) return '.'
    if (atom < 0.7) return pick(random, ['\\d', '\\w'])
    const items = Array.from({length: 1 + Math.floor(random() * 3)}, () => pick(random, ['a', 'b', 'c', 'a-c', 'x-z', '0-9', 'é', '😀', '_']))
    return `[${random() < 0.3 ? '^' : ''}${items.join('')}]`
  }
  if (roll < 0.6) return Array.from({length: 2 + Math.floor(random() * 2)}, () => randomPattern(random, depth - 1)).map(part => part.includes('|') ? `(${part})` : part).join('')
  if (roll < 0.8) return `${randomPattern(random, depth - 1)}|${randomPattern(random, depth - 1)}`
  return `(${randomPattern(random, depth - 1)})${pick(random, ['?', '*', '+'])}`
}

type Case = {compiled: CompiledPattern, texts: string[]}

// The patterns that fit the capacity, each with texts: empty, random, as long as the program holds, longer than that,
// and one with a match on the last position.
function createCases(states: number, positions: number, randomPatterns: number, textsPerPattern: number, extraPatterns: readonly string[] = []): Case[] {
  const random = createRandom(20261013 + states)
  const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
  const patterns = [...handPatterns, ...extraPatterns, ...Array.from({length: randomPatterns}, () => randomPattern(random, 3))]
  const cases: Case[] = []
  for (const pattern of patterns) {
    const compiled = compilePattern(pattern)
    if (capacityErrors(compiled, capacity).length > 0) continue
    const randomText = (length: number) => Array.from({length}, () => pick(random, textAlphabet)).join('')
    const texts = ['', randomText(positions), randomText(positions + 9), `${randomText(positions - 3)}abc`, `${randomText(positions - 9)} the tide`]
    while (texts.length < textsPerPattern) texts.push(randomText(Math.floor(random() * positions)))
    cases.push({compiled, texts})
  }
  return cases
}

// A document's cells in the layout the loop reads: `positions` code points, -1 after the text, then the text's length.
function writeCells(cells: Float32Array, row: number, positions: number, text: string) {
  const codePoints = Array.from(text, character => character.codePointAt(0)!)
  const base = row * (positions + 1)
  for (let position = 0; position < positions; position++) cells[base + position] = codePoints[position] ?? -1
  cells[base + positions] = codePoints.length
}

// What form (a) with every position written out gives on the CPU executor for each case and text: the match count, and
// highlighted + start per position, i.e. 0 outside a match, 1 inside one and 2 at a match's first code point.
function expectedFromFullProgram(states: number, positions: number, cases: readonly Case[], cells: Float32Array) {
  const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity, textLength: positions}
  const full = buildDataSearch(capacity)
  const evaluate = full.circuit.createTensorEvaluator([...full.output.highlighted, ...full.output.starts, full.output.matchCount])
  const source = new Float32Array(full.initialSource)
  const counts: number[] = []
  const marks: number[] = []
  let row = 0
  for (const {compiled, texts} of cases) {
    writePattern(source, full, compiled)
    for (let index = 0; index < texts.length; index++, row++) {
      for (let position = 0; position < positions; position++) source[full.cells.text[position]!] = cells[row * (positions + 1) + position]!
      const values = evaluate(source)
      counts.push(values[2 * positions]!)
      for (let position = 0; position < positions; position++) marks.push(values[position]! + values[positions + position]!)
    }
  }
  return {counts, marks}
}

// A loop program's shader through the strict interpreter, as one of the two writers writes it. bit-emit.ts's shader
// also reads words that are packed from the shared values, as a runner packs them at each upload.
type ShaderWriter = 'loop-emit' | 'bit-emit'
function interpreterOf(loop: LoopProgram, writer: ShaderWriter, order: 'use' | 'layers' = 'use'): WgslInterpreter {
  if (writer === 'loop-emit') return createWgslInterpreter(emitLoopWgsl(loop, {order}).code)
  const shader = emitBitLoopWgsl(loop)
  const interpret = createWgslInterpreter(shader.code)
  return (shared, sources, count, outputs, options = {}) => interpret(shared, sources, count, outputs, {...options, packed: packWords(shader.packedCells, shared)})
}

function mismatchCount(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  let mismatches = actual.length === expected.length ? 0 : 1
  for (let index = 0; index < expected.length; index++) if (actual[index] !== expected[index]) mismatches++
  return mismatches
}

describe('regex search as a loop over positions', () => {
  const states = 8
  const positions = 40
  const cases = createCases(states, positions, 260, 8)
  const rows = cases.reduce((total, entry) => total + entry.texts.length, 0)
  const cells = new Float32Array(rows * (positions + 1))
  cases.flatMap(entry => entry.texts).forEach((text, row) => writeCells(cells, row, positions, text))
  const expected = expectedFromFullProgram(states, positions, cases, cells)
  const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
  const loopOptions = {positions, cellsPerDocument: positions + 1, masked: false, stopAtLength: false}

  test('the cases cover the capacities, and the full program finds what the automaton simulator finds', () => {
    // The hand-written patterns and the random ones that fit 8 states, 16 classes and 32 class boundaries, with 8 texts each.
    expect([cases.length, rows]).toEqual([274, 2192])
    const partitions = cases.map(entry => entry.compiled)
    expect(Math.max(...partitions.map(compiled => compiled.automaton.stateCount))).toBe(states)
    const fullClasses = compilePattern(fullClassesPattern)
    expect([fullClasses.automaton.stateCount, fullClasses.partition.classCount, fullClasses.partition.boundaries.length]).toEqual([8, classCapacity, boundaryCapacity])
    expect(partitions).toContainEqual(fullClasses)
    let row = 0
    let matches = 0
    for (const {compiled, texts} of cases) {
      for (const text of texts) {
        const codePoints = Array.from(text, character => character.codePointAt(0)!).slice(0, positions)
        const found = automatonMatches(compiled, codePoints)
        matches += found.length
        const marks = Array<number>(positions).fill(0)
        for (const match of found) {
          marks.fill(1, match.start, match.end)
          marks[match.start] = 2
        }
        const actual = {pattern: compiled.pattern, text, count: expected.counts[row], marks: expected.marks.slice(row * positions, (row + 1) * positions)}
        if (actual.count !== found.length || mismatchCount(actual.marks, marks) > 0) expect(actual).toEqual({pattern: compiled.pattern, text, count: found.length, marks})
        row++
      }
    }
    expect(matches).toBeGreaterThan(3000)
    // A text that is as long as the program holds and ends with a match, for a pattern that finds it.
    const lastPosition = cases.find(entry => entry.compiled.pattern === 'abc')!
    const lastRow = cases.slice(0, cases.indexOf(lastPosition)).reduce((total, entry) => total + entry.texts.length, 0) + 3
    expect(expected.marks.slice(lastRow * positions + positions - 3, (lastRow + 1) * positions)).toEqual([2, 1, 1])
  })

  test('the step has the sizes the README gives', () => {
    const sizes = [8, 16, 32].map(count => {
      const {loop, patternCells} = buildSearchLoop({states: count, classes: classCapacity, boundaries: boundaryCapacity}, {...loopOptions, positions: 512, cellsPerDocument: 513})
      const shader = emitLoopWgsl(loop)
      return [describeLoop(loop).map(stage => stage.operations), operationsPerDocument(loop), loop.sharedValues.length, patternCells, shader.statementCount]
    })
    expect(sizes).toEqual([
      [[8, 148, 92], 122_888, 1125, 1097, 496],
      [[16, 356, 308], 339_984, 4229, 4177, 1368],
      [[32, 1156, 1124], 1_167_392, 16_581, 16_481, 4648],
    ])
  })

  for (const backend of ['executor', 'generated'] as const) {
    test(`the loop program on ${backend === 'executor' ? 'the CPU executor' : 'generated JavaScript'} gives form (a)'s match count and marks`, () => {
      for (const stopAtLength of [false, true]) {
        const built = buildSearchLoop(capacity, {...loopOptions, stopAtLength})
        const runner = createLoopRunner(built.loop, backend)
        const shared = new Float32Array(built.loop.sharedValues)
        const counts = new Float32Array(rows)
        const marks = new Float32Array(rows * positions).fill(9)
        let row = 0
        for (const {compiled, texts} of cases) {
          built.writePattern(shared, compiled)
          runner.setShared(shared)
          for (let index = 0; index < texts.length; index++, row++) runner.run([cells], row, [counts, marks], row, row)
        }
        expect([mismatchCount(counts, expected.counts), mismatchCount(marks, expected.marks)]).toEqual([0, 0])
      }
    }, 60_000)
  }

  test('both writers\' loop shaders give them through the WGSL interpreter: in both statement orders, with either kind of field, and stopping at the text\'s end', () => {
    const variants = [
      {every: 1, options: {}, order: 'use', writer: 'loop-emit'},
      {every: 5, options: {}, order: 'layers', writer: 'loop-emit'},
      {every: 5, options: {bitFields: false}, order: 'use', writer: 'loop-emit'},
      {every: 3, options: {stopAtLength: true}, order: 'use', writer: 'loop-emit'},
      {every: 1, options: {}, order: 'use', writer: 'bit-emit'},
      {every: 5, options: {bitFields: false}, order: 'use', writer: 'bit-emit'},
      {every: 3, options: {stopAtLength: true}, order: 'use', writer: 'bit-emit'},
    ] as const
    for (const variant of variants) {
      const built = buildSearchLoop(capacity, {...loopOptions, ...variant.options})
      const interpret = interpreterOf(built.loop, variant.writer, variant.order)
      const shared = new Float32Array(built.loop.sharedValues)
      let row = 0
      let checked = 0
      for (const [caseIndex, {compiled, texts}] of cases.entries()) {
        if (caseIndex % variant.every === 0) {
          built.writePattern(shared, compiled)
          // The case's documents, with a window over all but the first one.
          const counts = new Float32Array(texts.length)
          const marks = new Float32Array((texts.length - 1) * positions).fill(9)
          interpret(shared, cells.subarray(row * (positions + 1), (row + texts.length) * (positions + 1)), texts.length, [counts, marks], {window: {first: 1, count: texts.length - 1}})
          const actual = {pattern: compiled.pattern, counts: [...counts], marks: [...marks]}
          const wanted = {pattern: compiled.pattern, counts: expected.counts.slice(row, row + texts.length), marks: expected.marks.slice((row + 1) * positions, (row + texts.length) * positions)}
          if (mismatchCount(actual.counts, wanted.counts) + mismatchCount(actual.marks, wanted.marks) > 0) expect(actual).toEqual(wanted)
          checked += texts.length
        }
        row += texts.length
      }
      expect(checked).toBeGreaterThan(200)
    }
  }, 120_000)

  test('a document outside the window writes no marks, and a window past the documents writes nothing', () => {
    const built = buildSearchLoop(capacity, loopOptions)
    for (const writer of ['loop-emit', 'bit-emit'] as const) {
      const interpret = interpreterOf(built.loop, writer)
      const shared = new Float32Array(built.loop.sharedValues)
      built.writePattern(shared, compilePattern('a'))
      const documents = new Float32Array(3 * (positions + 1))
      for (const [row, text] of ['aa', 'a', 'baab'].entries()) writeCells(documents, row, positions, text)
      const counts = new Float32Array(3)
      const marks = new Float32Array(positions).fill(9)
      interpret(shared, documents, 3, [counts, marks], {window: {first: 2, count: 1}})
      expect([...counts]).toEqual([2, 1, 2])
      expect([...marks.subarray(0, 5)]).toEqual([0, 2, 2, 0, 0])
      marks.fill(9)
      interpret(shared, documents, 3, [counts, marks], {window: {first: 7, count: 1}})
      expect(marks.every(mark => mark === 9)).toBe(true)
      // One document from document 2 on: only its count and its marks are written.
      counts.fill(9)
      interpret(shared, documents, 1, [counts, marks], {window: {first: 2, count: 1}, first: 2})
      expect([[...counts], [...marks.subarray(0, 5)]]).toEqual([[9, 9, 2], [0, 2, 2, 0, 0]])
    }
  })
})

describe('regex search as a loop, at the measured capacities', () => {
  test('16 and 32 states: the loop program and both writers\' shaders give form (a)\'s outputs, including patterns with exactly that many states', () => {
    const positions = 24
    for (const [states, exact] of [[16, '(the|an?|some) [a-z]+(ing)?s?'], [32, '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ']] as const) {
      const cases = createCases(states, positions, 12, 5, [exact, 'a'.repeat(states - 1), '\\d\\d\\d\\d-\\d\\d-\\d\\d']).filter((_, index) => index % 4 === 0 || index > 30)
      expect(cases.some(entry => entry.compiled.automaton.stateCount === states)).toBe(true)
      cases.push({compiled: compilePattern(exact), texts: ['the tides these waves ', 'an owling some pier ', 'a boats']})
      const rows = cases.reduce((total, entry) => total + entry.texts.length, 0)
      const cells = new Float32Array(rows * (positions + 1))
      cases.flatMap(entry => entry.texts).forEach((text, row) => writeCells(cells, row, positions, text))
      const expected = expectedFromFullProgram(states, positions, cases, cells)
      expect(expected.counts.reduce((total, count) => total + count, 0)).toBeGreaterThan(40)
      const built = buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument: positions + 1, masked: false, stopAtLength: false})
      const runner = createLoopRunner(built.loop, 'generated')
      const shaders = (['loop-emit', 'bit-emit'] as const).map(writer => ({interpret: interpreterOf(built.loop, writer), counts: new Float32Array(rows), marks: new Float32Array(rows * positions)}))
      const shared = new Float32Array(built.loop.sharedValues)
      const counts = new Float32Array(rows)
      const marks = new Float32Array(rows * positions)
      let row = 0
      for (const {compiled, texts} of cases) {
        built.writePattern(shared, compiled)
        runner.setShared(shared)
        for (let index = 0; index < texts.length; index++) runner.run([cells], row + index, [counts, marks], row + index, row + index)
        for (const shader of shaders) {
          shader.interpret(shared, cells.subarray(row * (positions + 1), (row + texts.length) * (positions + 1)), texts.length, [shader.counts.subarray(row), shader.marks.subarray(row * positions)], {window: {first: 0, count: texts.length}})
        }
        row += texts.length
      }
      expect([states, mismatchCount(counts, expected.counts), mismatchCount(marks, expected.marks)]).toEqual([states, 0, 0])
      expect(shaders.map(shader => [mismatchCount(shader.counts, expected.counts), mismatchCount(shader.marks, expected.marks)])).toEqual([[0, 0], [0, 0]])
    }
  }, 120_000)

  test('512 positions over generated documents in the store\'s layout: the loop program and both writers\' shaders give form (a)\'s outputs, and so does the plain JavaScript loop over 32-bit rows', () => {
    const states = 8
    const positions = 512
    const texts = generateDocuments(60).map(document => document.text)
    const cells = new Float32Array(texts.length * storeCells)
    texts.forEach((text, row) => writeDocumentCells(cells, row * storeCells, text))
    const full = buildDataSearch({states, classes: classCapacity, boundaries: boundaryCapacity, textLength: positions})
    const evaluate = full.circuit.createTensorEvaluator([...full.output.highlighted, ...full.output.starts, full.output.matchCount])
    const source = new Float32Array(full.initialSource)
    const variants = [false, true].map(stopAtLength => {
      const built = buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument: storeCells, masked: false, stopAtLength})
      return {built, runner: createLoopRunner(built.loop, 'generated'), shared: new Float32Array(built.loop.sharedValues)}
    })
    // loop-emit.ts's shader on every 6th document, and bit-emit.ts's, which the page runs, on every 2nd.
    const interpreters = ([['loop-emit', 6], ['bit-emit', 2]] as const).map(([writer, every]) => ({interpret: interpreterOf(variants[0]!.built.loop, writer), every}))
    const count = new Float32Array(1)
    const marks = new Float32Array(positions)
    const rowMarks = new Uint8Array(positions)
    let matches = 0
    for (const pattern of ['(the|an?) [a-z]+', '"[a-z]+":', '[a-z0-9.]+@[a-z.]+', '([a-z]+)+x']) {
      const compiled = compilePattern(pattern)
      writePattern(source, full, compiled)
      const search = createBitRowSearch(bitRowTables(compiled, states), positions)
      for (const variant of variants) {
        variant.built.writePattern(variant.shared, compiled)
        variant.runner.setShared(variant.shared)
      }
      texts.forEach((text, row) => {
        for (let position = 0; position < positions; position++) source[full.cells.text[position]!] = cells[row * storeCells + position]!
        const values = evaluate(source)
        const wanted = {pattern, text, count: values[2 * positions]!, marks: Array.from({length: positions}, (_, position) => values[position]! + values[positions + position]!)}
        matches += wanted.count
        for (const variant of variants) {
          variant.runner.run([cells], row, [count, marks], 0, 0)
          if (count[0] !== wanted.count || mismatchCount(marks, wanted.marks) > 0) expect({pattern, text, count: count[0], marks: [...marks]}).toEqual(wanted)
        }
        for (const {interpret, every} of interpreters) {
          if (row % every !== 0) continue
          // Not the answer that the runner left in the arrays, so that a shader which wrote nothing fails.
          count.fill(9)
          marks.fill(9)
          interpret(variants[0]!.shared, cells.subarray(row * storeCells, (row + 1) * storeCells), 1, [count, marks], {window: {first: 0, count: 1}})
          if (count[0] !== wanted.count || mismatchCount(marks, wanted.marks) > 0) expect({pattern, text, count: count[0], marks: [...marks]}).toEqual(wanted)
        }
        const loopCount = search(text, rowMarks)
        if (loopCount !== wanted.count || mismatchCount(rowMarks, wanted.marks) > 0) expect({pattern, text, count: loopCount, marks: [...rowMarks]}).toEqual(wanted)
      })
    }
    expect(matches).toBeGreaterThan(600)
  }, 120_000)
})

describe('the JSON highlighter as a loop over positions', () => {
  // The highlighter's test texts (highlighter/corpus.ts), 2,509 in all, and what the highlighter with every position
  // written out gives for them on the CPU executor.
  const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80}).all
  const batch = buildBatchPrograms(['display'])
  const cells = new Float32Array(corpus.length * storeCells)
  corpus.forEach((text, row) => writeDocumentCells(cells, row * storeCells, text))
  const [summary, kinds] = expectedOutputs(batch.programs[0]!, cells, corpus.length) as [Float32Array, Float32Array]
  const evaluateErrorKind = batch.built.circuit.createTensorEvaluator([batch.built.output.firstErrorKind])
  const source = new Float32Array(batch.built.initialSource)
  const errorKinds = corpus.map(text => {
    batch.writeText(source, text)
    return evaluateErrorKind(source)[0]!
  })
  const built = buildJsonLoop()
  const shader = emitLoopWgsl(built.loop)
  // The loop's summary is valid, firstErrorPosition, truncated and firstErrorKind.
  const summaryMismatches = (actual: Float32Array, rows: number) => {
    let mismatches = 0
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < summaryCount; column++) if (actual[row * stepSummaryNames.length + column] !== summary[row * summaryCount + column]) mismatches++
      if (actual[row * stepSummaryNames.length + summaryCount] !== errorKinds[row]) mismatches++
    }
    return mismatches
  }

  test('the step is 37 operations, and its shader 107 statements', () => {
    expect(describeLoop(built.loop).map(stage => [stage.name, stage.operations, stage.indexReads])).toEqual([['step', 37, 12], ['end', 17, 6]])
    expect([operationsPerDocument(built.loop), built.loop.sharedValues.length, shader.statementCount, shader.outputCounts, shader.windowedGroups]).toEqual([18_961, 3994, 107, [4, 512], [false, true]])
    // The test texts reach every error kind except none at all: the first error's kind is carried, not read.
    expect(new Set(errorKinds).size).toBe(Object.keys(errorKind).length)
  })

  for (const backend of ['executor', 'generated'] as const) {
    test(`the loop program on ${backend === 'executor' ? 'the CPU executor' : 'generated JavaScript'} gives the highlighter's summary, first error kind and display kinds on every test text`, () => {
      const runner = createLoopRunner(built.loop, backend)
      const outputs = [new Float32Array(corpus.length * stepSummaryNames.length), new Float32Array(corpus.length * kindsPerDocument)]
      for (let row = 0; row < corpus.length; row++) runner.run([cells], row, outputs, row, row)
      expect([summaryMismatches(outputs[0]!, corpus.length), mismatchCount(outputs[1]!, kinds)]).toEqual([0, 0])
    }, 60_000)
  }

  test('both writers\' loop shaders give them through the WGSL interpreter, loop-emit.ts\'s in both statement orders', () => {
    for (const [writer, order, every] of [['loop-emit', 'use', 1], ['loop-emit', 'layers', 6], ['bit-emit', 'use', 1]] as const) {
      const texts = corpus.filter((_, row) => row % every === 0)
      const rows = texts.length
      const documents = new Float32Array(rows * storeCells)
      texts.forEach((text, row) => writeDocumentCells(documents, row * storeCells, text))
      const outputs = [new Float32Array(rows * stepSummaryNames.length), new Float32Array(rows * kindsPerDocument)]
      interpreterOf(built.loop, writer, order)(built.loop.sharedValues, documents, rows, outputs, {window: {first: 0, count: rows}})
      let mismatches = 0
      for (let row = 0; row < rows; row++) {
        const original = row * every
        for (let column = 0; column < summaryCount; column++) if (outputs[0]![row * stepSummaryNames.length + column] !== summary[original * summaryCount + column]) mismatches++
        if (outputs[0]![row * stepSummaryNames.length + summaryCount] !== errorKinds[original]) mismatches++
        for (let position = 0; position < kindsPerDocument; position++) if (outputs[1]![row * kindsPerDocument + position] !== kinds[original * kindsPerDocument + position]) mismatches++
      }
      expect([writer, order, rows > 400, mismatches]).toEqual([writer, order, true, 0])
    }
  }, 120_000)
})

describe('searching only some kinds of characters', () => {
  const states = 8
  const positions = 512
  const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
  // Generated documents, 1 in 10 broken, and records whose keys and values hold the same words.
  const words = ['the harbor', 'an owl', 'a ferry', 'the', 'an', 'error 42', 'xyz', 'tide\\nthe pier']
  const random = createRandom(7)
  const records = Array.from({length: 40}, () => {
    const entries = Array.from({length: 1 + Math.floor(random() * 4)}, () => `"${pick(random, words)}": ${pick(random, [`"${pick(random, words)} ${pick(random, words)}"`, `["${pick(random, words)}", 12]`, '3.5', 'true', 'the harbor', '"an owl'])}`)
    return `{${entries.join(', ')}}`
  })
  const texts = [...generateDocuments(50).map(document => document.text), ...records, '', '"the tide"', 'the tide']
  const cells = new Float32Array(texts.length * storeCells)
  texts.forEach((text, row) => writeDocumentCells(cells, row * storeCells, text))
  const [, kinds] = expectedOutputs(buildBatchPrograms(['display']).programs[0]!, cells, texts.length) as [Float32Array, Float32Array]
  const patterns = ['(the|an?) [a-z]+', '[a-z]+', '"[a-z ]+"', 'a+b|a', '\\d+', 'e'].map(pattern => compilePattern(pattern))
  const scopes: SearchScope[] = [...searchScopes, [displayKind.number, displayKind.literal]]
  // Which scope each pattern and text is checked with: every scope for the first pattern, and one in turn for the rest.
  const scopesOf = (patternIndex: number, row: number) => patternIndex === 0 ? scopes : [scopes[(patternIndex + row) % scopes.length]!]

  // The masked search with every position written out, on the CPU executor.
  const full = buildMaskedSearch({...capacity, textLength: positions})
  const evaluateFull = full.circuit.createTensorEvaluator([...full.output.highlighted, ...full.output.starts, full.output.matchCount])
  const fullSource = new Float32Array(full.initialSource)
  const expected: {pattern: string, scope: SearchScope, row: number, count: number, marks: number[]}[] = []
  patterns.forEach((compiled, patternIndex) => {
    writePattern(fullSource, {cells: full.cells.search, capacity: full.capacity}, compiled)
    texts.forEach((_, row) => {
      for (let position = 0; position < positions; position++) {
        fullSource[full.cells.search.text[position]!] = cells[row * storeCells + position]!
        fullSource[full.cells.kinds[position]!] = kinds[row * kindsPerDocument + position]!
      }
      for (const scope of scopesOf(patternIndex, row)) {
        const searchable = new Set(searchableKinds(scope))
        full.cells.searchable.forEach((wire, kind) => {
          fullSource[wire] = searchable.has(kind) ? 1 : 0
        })
        const values = evaluateFull(fullSource)
        expected.push({pattern: compiled.pattern, scope, row, count: values[2 * positions]!, marks: Array.from({length: positions}, (_, position) => values[position]! + values[positions + position]!)})
      }
    })
  })

  test('the program with every position written out finds what the automaton simulator finds in the masked code points', () => {
    let matches = 0
    const matchesByScope = new Map<string, number>()
    for (const entry of expected) {
      const searchable = new Set(searchableKinds(entry.scope))
      const masked = Array.from({length: positions}, (_, position) => searchable.has(kinds[entry.row * kindsPerDocument + position]!) ? cells[entry.row * storeCells + position]! : -1)
      const found = automatonMatches(patterns.find(compiled => compiled.pattern === entry.pattern)!, masked)
      const marks = Array<number>(positions).fill(0)
      for (const match of found) {
        marks.fill(1, match.start, match.end)
        marks[match.start] = 2
      }
      if (entry.count !== found.length || mismatchCount(entry.marks, marks) > 0) expect(entry).toEqual({...entry, count: found.length, marks})
      matches += found.length
      matchesByScope.set(String(entry.scope), (matchesByScope.get(String(entry.scope)) ?? 0) + found.length)
    }
    expect(matches).toBeGreaterThan(2000)
    // Every scope finds something, and a narrower scope finds less.
    for (const scope of scopes) expect(matchesByScope.get(String(scope))).toBeGreaterThan(20)
    expect(matchesByScope.get('strings')! + 0).toBeLessThan(matchesByScope.get('everything')!)
    // "the tide" in quotes is one string value, and without quotes it is an error that no string scope reads.
    const countOf = (text: string, scope: SearchScope) => expected.find(entry => entry.pattern === '(the|an?) [a-z]+' && entry.scope === scope && entry.row === texts.indexOf(text))!.count
    expect([countOf('"the tide"', 'strings'), countOf('"the tide"', 'keys'), countOf('the tide', 'strings'), countOf('the tide', 'everything')]).toEqual([1, 0, 0, 1])
  })

  test('with every kind searchable, the masked program gives form (a)\'s outputs', () => {
    const plain = buildDataSearch({...capacity, textLength: positions})
    const evaluatePlain = plain.circuit.createTensorEvaluator([...plain.output.highlighted, ...plain.output.starts, plain.output.matchCount])
    const plainSource = new Float32Array(plain.initialSource)
    writePattern(plainSource, plain, patterns[0]!)
    for (const entry of expected) {
      if (entry.pattern !== patterns[0]!.pattern || entry.scope !== 'everything') continue
      for (let position = 0; position < positions; position++) plainSource[plain.cells.text[position]!] = cells[entry.row * storeCells + position]!
      const values = evaluatePlain(plainSource)
      const marks = Array.from({length: positions}, (_, position) => values[position]! + values[positions + position]!)
      if (entry.count !== values[2 * positions] || mismatchCount(entry.marks, marks) > 0) expect(entry).toEqual({...entry, count: values[2 * positions]!, marks})
    }
  })

  test('the masked loop program gives the masked program\'s outputs, on generated JavaScript and as both writers\' shaders through the WGSL interpreter', () => {
    const built = buildSearchLoop(capacity, {positions, cellsPerDocument: storeCells, masked: true, stopAtLength: false})
    expect(describeLoop(built.loop).map(stage => stage.operations)).toEqual([8, 151, 92])
    const runner = createLoopRunner(built.loop, 'generated')
    const shader = emitLoopWgsl(built.loop)
    expect([shader.inputCells, shader.cellsPerInstance]).toEqual([[positions], storeCells])
    // loop-emit.ts's shader on every 9th case, and bit-emit.ts's, which is the shader of the page's 8-state program, on
    // every 3rd.
    const interpreters = ([['loop-emit', 9], ['bit-emit', 3]] as const).map(([writer, every]) => ({interpret: interpreterOf(built.loop, writer), every}))
    const shared = new Float32Array(built.loop.sharedValues)
    const count = new Float32Array(1)
    const marks = new Float32Array(positions)
    let interpreted = 0
    for (const [index, entry] of expected.entries()) {
      built.writePattern(shared, patterns.find(compiled => compiled.pattern === entry.pattern)!)
      built.writeScope(shared, entry.scope)
      runner.setShared(shared)
      runner.run([cells, kinds], entry.row, [count, marks], 0, 0)
      if (count[0] !== entry.count || mismatchCount(marks, entry.marks) > 0) expect({...entry, count: count[0], marks: [...marks]}).toEqual(entry)
      for (const {interpret, every} of interpreters) {
        if (index % every !== 0) continue
        // Not the answer that the runner left in the arrays, so that a shader which wrote nothing fails.
        count.fill(9)
        marks.fill(9)
        interpret(shared, cells.subarray(entry.row * storeCells, (entry.row + 1) * storeCells), 1, [count, marks], {inputs: [kinds.subarray(entry.row * kindsPerDocument, (entry.row + 1) * kindsPerDocument)], window: {first: 0, count: 1}})
        if (count[0] !== entry.count || mismatchCount(marks, entry.marks) > 0) expect({...entry, count: count[0], marks: [...marks]}).toEqual(entry)
        interpreted++
      }
    }
    // 104 cases through loop-emit.ts's shader and 310 through bit-emit.ts's.
    expect(interpreted).toBeGreaterThan(400)
  }, 120_000)
})
