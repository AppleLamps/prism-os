// Regex search as a loop over positions (search-step.ts) against lab/regex-search's form (a) with every position written
// out, on the CPU executor: the loop program on the executor, on generated JavaScript, and its WGSL text through the
// strict interpreter. A real GPU compiler may fuse or regroup operations; gpu/search-run.ts checks the same outputs in
// headless Chrome.
// Run from the repo root: bun test lab/json-search/search.test.ts
import {describe, expect, test} from 'bun:test'
import {buildDataSearch, writePattern} from '../regex-search/data-program.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../regex-search/pattern.ts'
import {automatonMatches} from '../regex-search/reference.ts'
import {bitRowTables, createBitRowSearch} from './bit-rows.ts'
import {generateDocuments} from './documents.ts'
import {emitLoopWgsl} from './loop-emit.ts'
import {createLoopRunner, describeLoop, operationsPerDocument} from './loop-program.ts'
import {cellsPerDocument as storeCells, writeDocumentCells} from './program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from './search-step.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'

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

// Patterns for a capacity of 8 states: lab/regex-search's edge cases, the capacities, and the measurement's patterns.
const handPatterns = [
  'a', 'a*', '', '()*', 'a|ab', '(a|ab)(c|bcd)', 'a+b|a', 'aba', 'a(bc)*', '.+', '[^a]+', '.', '\\w+', '\\d+', '😀+', '[]', '[^]', '[^]*',
  '\\d+\\.\\d+', '[a-c-]+', '(x|y)*z', 'abc', 'b+', '(the|an?) [a-z]+', 'abcdefg', fullClassesPattern, 'error', '[a-z0-9.]+@[a-z.]+',
  '"[a-z]+":', '[A-Z][a-z]+ [A-Z][a-z]+', '([a-z]+)+x',
]
const textAlphabet = ['a', 'b', 'c', 'x', 'y', 'z', '0', '9', 'Z', '_', '-', '.', '\n', ' ', ' ', 'é', '😀', '\u{10FFFF}', 't', 'h', 'e', 'n', '"', ':', '@', ...isolatedLetters]

// Random patterns over a small alphabet, like lab/regex-search's tests: literals, classes, groups, alternation, repeats.
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
    expect(cases.length).toBeGreaterThan(150)
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
      [[8, 148, 92], 122_888, 1125, 1097, 495],
      [[16, 356, 308], 339_984, 4229, 4177, 1367],
      [[32, 1156, 1124], 1_167_392, 16_581, 16_481, 4647],
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

  test('the loop shader gives them through the WGSL interpreter: in both statement orders, with either kind of field, and stopping at the text\'s end', () => {
    const variants = [
      {every: 1, options: {}, order: 'use'},
      {every: 5, options: {}, order: 'layers'},
      {every: 5, options: {bitFields: false}, order: 'use'},
      {every: 3, options: {stopAtLength: true}, order: 'use'},
    ] as const
    for (const variant of variants) {
      const built = buildSearchLoop(capacity, {...loopOptions, ...variant.options})
      const interpret = createWgslInterpreter(emitLoopWgsl(built.loop, {order: variant.order}).code)
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
    const interpret = createWgslInterpreter(emitLoopWgsl(built.loop).code)
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
  })
})

describe('regex search as a loop, at the measured capacities', () => {
  test('16 and 32 states: the loop program and its shader give form (a)\'s outputs, including patterns with exactly that many states', () => {
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
      const interpret = createWgslInterpreter(emitLoopWgsl(built.loop).code)
      const shared = new Float32Array(built.loop.sharedValues)
      const counts = new Float32Array(rows)
      const marks = new Float32Array(rows * positions)
      const shaderCounts = new Float32Array(rows)
      const shaderMarks = new Float32Array(rows * positions)
      let row = 0
      for (const {compiled, texts} of cases) {
        built.writePattern(shared, compiled)
        runner.setShared(shared)
        for (let index = 0; index < texts.length; index++) runner.run([cells], row + index, [counts, marks], row + index, row + index)
        interpret(shared, cells.subarray(row * (positions + 1), (row + texts.length) * (positions + 1)), texts.length, [shaderCounts.subarray(row), shaderMarks.subarray(row * positions)], {window: {first: 0, count: texts.length}})
        row += texts.length
      }
      expect([states, mismatchCount(counts, expected.counts), mismatchCount(marks, expected.marks), mismatchCount(shaderCounts, expected.counts), mismatchCount(shaderMarks, expected.marks)]).toEqual([states, 0, 0, 0, 0])
    }
  }, 120_000)

  test('512 positions over generated documents in the store\'s layout: the loop program gives form (a)\'s outputs, and so does the plain JavaScript loop over 32-bit rows', () => {
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
    const interpret = createWgslInterpreter(emitLoopWgsl(variants[0]!.built.loop).code)
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
        if (row % 6 === 0) {
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
