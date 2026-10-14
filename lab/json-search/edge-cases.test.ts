// Documents and searches at the limits of both programs (edge-cases.ts), through the demo page's module, against the
// programs that have every position written out, on the CPU executor: the looped steps have to give the values of
// the full programs at exactly the capacity, at the maximum depth, on an empty text, and for patterns that fill a
// program's states, classes and class boundaries. The module runs on the CPU, and as the page runs it on the GPU, with
// each pass run by the WGSL interpreter (interpreted-gpu.ts). gpu/review-run.ts runs the same comparison on a GPU.
// Run from the repo root: bun test lab/json-search/edge-cases.test.ts
import {describe, expect, test} from 'bun:test'
import {capacity, errorKind, maximumDepth} from '../../src/json-highlighter/kinds.ts'
import {compilePattern} from '../regex-search/pattern.ts'
import {
  compareSearchers, compareWithWrittenOutPrograms, createSearchOnTheExecutor, edgePatterns, edgeSearches, handWrittenDocuments, highlighterOnTheExecutor,
  stateCapacityOf,
} from './edge-cases.ts'
import {generateDocuments} from './documents.ts'
import {createInterpretedDevice} from './interpreted-gpu.ts'
import {summaryCount} from './program.ts'
import {boundaryCapacity, classCapacity} from './search-step.ts'
import {createCpuSearcher, createGpuSearcher, defaultSelfCheckSearches} from './searcher.ts'

const documents = handWrittenDocuments()
const texts = documents.map(document => document.text)
const rowOf = (name: string) => {
  const row = documents.findIndex(document => document.name === name)
  if (row < 0) throw new Error(`no document is named ${name}`)
  return row
}
// The documents of more than one code point, which every search runs over.
const longer = documents.filter(document => !document.name.startsWith('one code point')).map(document => document.text)

describe('documents and searches at the limits', () => {
  test('the documents and the patterns reach the limits, by the written-out programs\' values on the executor', () => {
    expect(new Set(documents.map(document => document.name)).size).toBe(documents.length)
    const lengths = texts.map(text => Array.from(text).length)
    for (const length of [0, 1, capacity - 1, capacity, capacity + 1]) expect(lengths).toContain(length)

    const expected = highlighterOnTheExecutor(texts)
    const summaryOf = (name: string) => [...expected.summary.subarray(rowOf(name) * summaryCount, (rowOf(name) + 1) * summaryCount), expected.errorKinds[rowOf(name)]]
    // valid, firstErrorPosition, truncated, firstErrorKind.
    expect(summaryOf(`a string of ${capacity} code points`)).toEqual([1, -1, 0, errorKind.none])
    expect(summaryOf(`a string of ${capacity + 1} code points`)).toEqual([0, capacity, 1, errorKind.tooLong])
    expect(summaryOf(`a number at the last of ${capacity} code points`)).toEqual([1, -1, 0, errorKind.none])
    expect(summaryOf(`an error at the last of ${capacity} code points`).slice(0, 3)).toEqual([0, capacity - 1, 0])
    expect(summaryOf(`${capacity} spaces`).slice(0, 3)).toEqual([0, capacity, 0])
    expect(summaryOf(`arrays nested ${maximumDepth} deep`)).toEqual([1, -1, 0, errorKind.none])
    expect(summaryOf(`arrays nested ${maximumDepth + 1} deep`)).toEqual([0, maximumDepth, 0, errorKind.tooDeep])
    expect(summaryOf(`objects nested ${maximumDepth} deep`)).toEqual([1, -1, 0, errorKind.none])
    expect(summaryOf(`${maximumDepth} deep with ${capacity} code points`)).toEqual([1, -1, 0, errorKind.none])
    expect(summaryOf(`${maximumDepth + 1} openers at the end of ${capacity} code points`)).toEqual([0, capacity - 1, 0, errorKind.tooDeep])
    expect(summaryOf('empty').slice(0, 3)).toEqual([0, 0, 0])

    // The patterns fill each program's states, and one of each capacity fills the classes and the class boundaries.
    for (const states of [8, 16, 32] as const) {
      const compiled = edgePatterns[states].map(pattern => compilePattern(pattern))
      expect(compiled.map(stateCapacityOf)).toEqual(compiled.map(() => states))
      expect(Math.max(...compiled.map(entry => entry.automaton.stateCount))).toBe(states)
      expect(compiled.some(entry => entry.partition.classCount === classCapacity && entry.partition.boundaries.length === boundaryCapacity && (states === 8 || entry.automaton.stateCount === states))).toBe(true)
    }

    const search = createSearchOnTheExecutor(8)
    const marks = new Float32Array(capacity)
    const countOf = (pattern: string, name: string) => {
      search.setSearch(compilePattern(pattern), 'everything')
      return search.run(expected.cells, expected.kinds, rowOf(name), marks, 0)
    }
    // Every code point is a match, the whole text is one match, nothing matches, and the empty match is never reported.
    expect([countOf('[^]', `${capacity} times a`), countOf('[^]', `${capacity + 1} times a`), countOf('[^]', 'empty')]).toEqual([capacity, capacity, 0])
    expect([countOf('[^]+', `${capacity} times a`), countOf('[]', `${capacity} times a`), countOf('', `${capacity} times a`), countOf('a*', `${capacity - 1} times a, then b`)]).toEqual([1, 0, 0, 1])
    expect(countOf('a', `b, then ${capacity - 1} times a`)).toBe(capacity - 1)
    // A match on the last 7 positions, and none when the capacity cuts its last code point.
    expect([countOf('abcdefg', `abcdefg at the end of ${capacity} code points`), [...marks.subarray(capacity - 8)]]).toEqual([1, [0, 2, 1, 1, 1, 1, 1, 1]])
    expect(countOf('abcdefg', `abcdefg at the end of ${capacity + 1} code points`)).toBe(0)
    expect([countOf('(the|an?) [a-z]+', `the tide at both ends of ${capacity} code points`), marks[0], marks[capacity - 1]]).toEqual([2, 2, 1])
  }, 60_000)

  test('the searcher as generated JavaScript gives the written-out programs\' values: every document\'s validation and kinds, and every 8-state search', async () => {
    const all = await compareWithWrittenOutPrograms(createCpuSearcher(texts, {windowCapacity: texts.length}), texts, [{pattern: '[^]', scope: 'everything'}, {pattern: '"', scope: 'strings'}], {windowDocuments: texts.length, maxWrittenOutStates: 8})
    expect([all.documents, all.validationValues, all.validationMismatches, all.searchMismatches, all.examples]).toEqual([texts.length, texts.length * (4 + capacity), 0, 0, []])
    expect(all.expectedValidDocuments).toBeGreaterThan(20)
    expect(all.expectedValidDocuments).toBeLessThan(texts.length / 2)

    // Every pattern in every document, and each other scope with 6 of the patterns.
    const searches = edgeSearches(8).filter((search, index) => search.scope === 'everything' || index % 6 === 1)
    const some = await compareWithWrittenOutPrograms(createCpuSearcher(longer, {windowCapacity: longer.length}), longer, searches, {windowDocuments: longer.length, maxWrittenOutStates: 8})
    expect([some.searches, some.validationMismatches, some.searchMismatches, some.examples]).toEqual([searches.length, 0, 0, []])
    // The patterns that can match find something: all but the empty class, the empty pattern, and the searches of no kind.
    expect(some.searchesWithMatches).toBeGreaterThanOrEqual(searches.length - 4)
    expect(some.expectedMatches).toBeGreaterThan(20_000)
    expect(some.expectedMarkedPositions).toBeGreaterThan(100_000)
  }, 120_000)

  test('the searcher on the CPU executor gives them too, a window at a time', async () => {
    const sample = longer.filter((_, index) => index % 4 === 0)
    const searches = edgeSearches(8).filter((_, index) => index % 5 === 0)
    const comparison = await compareWithWrittenOutPrograms(createCpuSearcher(sample, {windowCapacity: 16, backend: 'executor'}), sample, searches, {windowDocuments: 16, maxWrittenOutStates: 8})
    expect([comparison.searches, comparison.validationMismatches, comparison.searchMismatches, comparison.examples]).toEqual([searches.length, 0, 0, []])
    expect(comparison.expectedMatches).toBeGreaterThan(1000)
  }, 120_000)

  test('16 states: the searcher gives the written-out program\'s values, and 32 states: generated JavaScript gives the executor\'s', async () => {
    const sample = longer.filter((_, index) => index % 2 === 1)
    const comparison = await compareWithWrittenOutPrograms(createCpuSearcher(sample, {windowCapacity: 32}), sample, edgeSearches(16), {windowDocuments: 32, maxWrittenOutStates: 16})
    expect([comparison.searches, comparison.validationMismatches, comparison.searchMismatches, comparison.examples]).toEqual([edgeSearches(16).length, 0, 0, []])
    expect(comparison.searchesWithMatches).toBeGreaterThanOrEqual(6)

    // The program of 32 states with every position written out is 1,167,392 operations, so here the two CPU backends of
    // the loop are compared. bun lab/json-search/report.ts edge-cases compares it with the written-out program.
    const few = documents.filter(document => /times a$|isolated letters|both ends|emoji around/.test(document.name)).map(document => document.text).slice(0, 14)
    const searches = edgeSearches(32).filter(search => search.scope === 'everything')
    const backends = await compareSearchers(createCpuSearcher(few, {windowCapacity: 8}), createCpuSearcher(few, {windowCapacity: 8, backend: 'executor'}), searches, [{firstDocument: 0, documentCount: 8}, {firstDocument: 8, documentCount: few.length - 8}])
    expect([backends.searches, backends.validationMismatches, backends.searchMismatches, backends.examples]).toEqual([searches.length, 0, 0, []])
    expect(backends.expectedMatches).toBeGreaterThan(30)
  }, 180_000)

  test('the searcher on the GPU, each pass through the WGSL interpreter, gives the written-out programs\' values at 8 states, and the CPU searcher\'s at 16 and 32', async () => {
    // Every 3rd document of more than one code point, among them texts of exactly the capacity, matches at the first
    // and at the last position, and nesting at the maximum depth, and every 3rd search.
    const sample = longer.filter((_, index) => index % 3 === 2)
    const searches = edgeSearches(8).filter((_, index) => index % 3 === 0)
    const gpu = await createGpuSearcher(createInterpretedDevice(), sample, {windowCapacity: 16})
    expect(gpu.programs().map(program => program.statements)).toEqual([107, 147, 171, 219])
    const comparison = await compareWithWrittenOutPrograms(gpu, sample, searches, {windowDocuments: 16, maxWrittenOutStates: 8})
    expect([comparison.documents, comparison.searches, comparison.validationMismatches, comparison.searchMismatches, comparison.examples]).toEqual([sample.length, searches.length, 0, 0, []])
    expect(comparison.expectedValidDocuments).toBeGreaterThan(5)
    expect(comparison.expectedMatches).toBeGreaterThan(4000)
    expect(comparison.expectedMarkedPositions).toBeGreaterThan(20_000)
    // 4 of the 12 searches can't match: the empty class, the empty pattern, and two that read no kind of character.
    expect(comparison.searchesWithMatches).toBe(8)

    // The patterns that fill 16 and 32 states, among them the ones with 16 classes and 32 class boundaries, over the
    // documents whose matches touch the first and the last position.
    const few = documents.filter(document => /times a$|isolated letters|both ends|a date at the end|emoji around/.test(document.name)).map(document => document.text)
    const larger = [...edgeSearches(16), ...edgeSearches(32)].filter(search => search.scope === 'everything')
    const windows = Array.from({length: Math.ceil(few.length / 8)}, (_, index) => ({firstDocument: index * 8, documentCount: Math.min(8, few.length - index * 8)}))
    const backends = await compareSearchers(await createGpuSearcher(createInterpretedDevice(), few, {windowCapacity: 8}), createCpuSearcher(few, {windowCapacity: 8}), larger, windows)
    expect([backends.documents, backends.searches, backends.validationMismatches, backends.searchMismatches, backends.examples]).toEqual([few.length, larger.length, 0, 0, []])
    expect(backends.expectedMatches).toBeGreaterThan(100)
  }, 180_000)

  test('what a self check expects is mostly not zero, so a GPU that returned zeros would fail it', async () => {
    // The first 300 generated documents, which the measurement pages' self check runs: 268 are valid, 91% of their
    // display kinds aren't 0, and each of the self check's eleven searches finds matches, e.g. `東京` 6 and the one of
    // 32 states 32.
    const searcher = createCpuSearcher(generateDocuments(300).map(document => document.text))
    const kinds = await searcher.kinds({firstDocument: 0, documentCount: 300})
    const found: [matches: number, documentsWithMatches: number][] = []
    for (const {pattern, scope} of defaultSelfCheckSearches) {
      const result = await searcher.search({pattern, scope})
      if (result?.status !== 'searched') throw new Error(`the self check's pattern ${pattern} wasn't searched`)
      found.push([result.matches, result.documentsWithMatches])
    }
    expect([searcher.validation.validCount, kinds.filter(kind => kind !== 0).length, kinds.length, found]).toEqual([268, 140_525, 300 * capacity, [[8705, 300], [133, 78], [2868, 251], [1482, 224], [57, 55], [4, 4], [32, 31], [6, 6], [1178, 300], [3723, 300], [2301, 295]]])
  }, 60_000)
})
