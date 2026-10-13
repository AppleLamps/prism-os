// Documents and searches at the limits of both programs, and the comparison of a searcher (searcher.ts, on the CPU or
// on the GPU) with the programs that have every position written out, on the CPU executor. The review of this folder
// added them: the measurements compare the GPU with the executor on generated documents, which are ordinary JSON, and
// with a plain JavaScript loop for the searches.
//
// What the comparison reads as the definition of each value:
// - valid, firstErrorPosition, truncated, firstErrorKind and the 512 display kinds: src/json-highlighter/highlighter.ts,
//   compiled as it is, on the CPU executor.
// - a search's match count and marks: search-step.ts's buildMaskedSearch, i.e. lab/regex-search's form (a) with every
//   position written out over the code points of the searched kinds, on the CPU executor, with the executor's kinds.
import {capacity, displayKind, maximumDepth} from '../../src/json-highlighter/kinds.ts'
import {createCorpus} from '../../tests/json-highlighter/corpus.ts'
import {writePattern} from '../regex-search/data-program.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../regex-search/pattern.ts'
import {expectedOutputs} from './check.ts'
import {generateDocuments} from './documents.ts'
import {buildBatchPrograms, cellsPerDocument, summaryCount, writeDocumentCells} from './program.ts'
import {type SearchScope, boundaryCapacity, buildMaskedSearch, classCapacity, searchableKinds} from './search-step.ts'
import type {Searcher} from './searcher.ts'

const positions = capacity

export type EdgeDocument = {name: string, text: string}

// 16 letters with a letter between each two, so a pattern that tells all 16 apart has 16 classes and 32 class
// boundaries, the capacities. Atom k holds the letters whose number, from 1, has bit k set.
const isolatedLetters = Array.from('acegikmoqsuwyACE')
const lettersOfBit = (bit: number) => isolatedLetters.filter((_, index) => ((index + 1) >> bit) & 1).join('')
// One more state that reads any of the 16 letters, which adds no class and no boundary.
const anyIsolatedLetter = `[${isolatedLetters.join('')}]`
export const fullClassesPattern = `([${lettersOfBit(0)}]|[${lettersOfBit(1)}]|[${lettersOfBit(2)}]|[${lettersOfBit(3)}]|[${lettersOfBit(4)}]|a|c)+`

const nested = (depth: number, inner = '') => '['.repeat(depth) + inner + ']'.repeat(depth)
const objects = (depth: number, inner = '1') => '{"k":'.repeat(depth) + inner + '}'.repeat(depth)
// A text of exactly `length` code points that ends with `ending`, padded in front with `padding`.
const endingWith = (length: number, ending: string, padding = ' ') => padding.repeat(length - Array.from(ending).length) + ending

// The hand-written documents: every length around the capacity, nesting around the maximum depth, texts whose matches
// touch the first and the last position, and characters past U+FFFF.
export function handWrittenDocuments(): EdgeDocument[] {
  const documents: EdgeDocument[] = []
  const add = (name: string, text: string) => documents.push({name, text})
  add('empty', '')
  // One code point: every ASCII character, and a few others.
  for (let codePoint = 0; codePoint < 128; codePoint++) add(`one code point, U+${codePoint.toString(16).padStart(4, '0')}`, String.fromCodePoint(codePoint))
  for (const character of ['é', '字', '😀', '\ud800', '\udc00', '\u{10ffff}', ' ', '﻿']) add(`one code point, U+${character.codePointAt(0)!.toString(16)}`, character)

  // Exactly at the capacity, one under and one over.
  for (const length of [capacity - 1, capacity, capacity + 1, capacity + 2]) {
    add(`a string of ${length} code points`, `"${'a'.repeat(length - 2)}"`)
    add(`an array of ${length} code points`, `[${'1,'.repeat((length - 4) / 2)}${length % 2 === 0 ? '11' : '111'}]`)
    add(`${length} spaces`, ' '.repeat(length))
    add(`a number at the last of ${length} code points`, endingWith(length, '1'))
    add(`an error at the last of ${length} code points`, endingWith(length, 'x'))
    add(`brackets at the end of ${length} code points`, endingWith(length, '[]'))
    add(`an open bracket at the end of ${length} code points`, endingWith(length, '[1'))
    add(`a string of ${length} emoji and quotes`, `"${'😀'.repeat(length - 2)}"`)
    add(`a lone surrogate at the last of ${length} code points`, `"${'a'.repeat(length - 2)}\ud800`)
    add(`an open string up to ${length} code points`, `"${'the tide '.repeat(60)}`.slice(0, length))
    add(`an escape cut at ${length} code points`, `"${'a'.repeat(length - 3)}\\u00e9"`)
    add(`a key and a value up to ${length} code points`, `{"the pier": "${'an owl '.repeat(80)}`.slice(0, length - 2) + '"}')
  }
  add('a text of 2,000 code points', `[${'"the tide", '.repeat(180)}1]`)
  add('a text of 1,200 emoji', '😀'.repeat(1200))

  // Nesting around the maximum depth of 16.
  for (const depth of [1, 2, maximumDepth - 1, maximumDepth, maximumDepth + 1, maximumDepth + 2, 40]) {
    add(`arrays nested ${depth} deep`, nested(depth))
    add(`arrays nested ${depth} deep around a number`, nested(depth, '1'))
    add(`objects nested ${depth} deep`, objects(depth))
    add(`objects and arrays in turn, ${depth} deep`, Array.from({length: depth}, (_, level) => level % 2 === 0 ? '{"k":' : '[').join('') + '"the tide"' + Array.from({length: depth}, (_, level) => (depth - 1 - level) % 2 === 0 ? '}' : ']').join(''))
    add(`${depth} openers at the end of ${capacity} code points`, endingWith(capacity, '['.repeat(depth)))
    add(`${depth} openers at the end of ${capacity + 1} code points`, endingWith(capacity + 1, '['.repeat(depth)))
    add(`${depth} braces, closed by brackets`, '{"k":'.repeat(depth) + '1' + ']'.repeat(depth))
  }
  add(`${maximumDepth} deep with ${capacity} code points`, '['.repeat(maximumDepth) + ' '.repeat(capacity - 2 * maximumDepth) + ']'.repeat(maximumDepth))
  add(`${maximumDepth + 1} deep with ${capacity} code points`, '['.repeat(maximumDepth + 1) + ' '.repeat(capacity - 2 * maximumDepth - 2) + ']'.repeat(maximumDepth + 1))
  // Closers below depth 0, and openers that never close: after the first error the totals keep running.
  add('closers only', ']'.repeat(capacity))
  add('closing braces only', '}'.repeat(capacity))
  add('openers only', '['.repeat(capacity))
  add('opening braces only', '{'.repeat(capacity))
  add('closers, then openers', ']'.repeat(40) + '['.repeat(40) + '}'.repeat(40) + '{'.repeat(40))
  // The container code's largest totals: a brace at depth 15 adds 2^15, and a bracket closes it without subtracting.
  add('braces at depth 15, closed by brackets', '['.repeat(maximumDepth - 1) + '{]'.repeat((capacity - maximumDepth) / 2))
  add('brackets at depth 15, closed by braces', '['.repeat(maximumDepth - 1) + '[}'.repeat((capacity - maximumDepth) / 2))
  add('objects in an array up to the capacity', `[${'{},'.repeat(169)}{}] `)
  add('16 braces and 16 brackets in turn', ('{'.repeat(maximumDepth) + ']'.repeat(maximumDepth)).repeat(16))

  // Matches at the first and the last position, and a match that the capacity cuts.
  for (const length of [capacity - 1, capacity, capacity + 1]) {
    add(`${length} times a`, 'a'.repeat(length))
    add(`b, then ${length - 1} times a`, `b${'a'.repeat(length - 1)}`)
    add(`${length - 1} times a, then b`, `${'a'.repeat(length - 1)}b`)
    add(`the tide at both ends of ${length} code points`, `the tide${endingWith(length - 8, 'an owl')}`)
    add(`the tide in quotes at both ends of ${length} code points`, `["the tide",${endingWith(length - 12, '"an owl"]')}`)
    add(`a date at the end of ${length} code points`, endingWith(length, '2026-10-13', '1'))
    add(`abcdefg at the end of ${length} code points`, endingWith(length, 'abcdefg', 'x'))
    add(`the isolated letters up to ${length} code points`, isolatedLetters.join('').repeat(40).slice(0, length))
    add(`${length} digits`, '0123456789'.repeat(60).slice(0, length))
  }
  add('emoji around a match', `"${'😀'.repeat(200)} the tide ${'😀'.repeat(200)} an owl"`)
  add('an escape inside a string value and a key', '{"the\\ntide": "an\\towl the pier", "the pier": ["a\\u00e9b the tide", "an owl"]}')
  add('the same words as key, value, and outside strings', '{"the tide": "the tide", "a": the tide}')
  add('numbers and literals', '[12.5, -3e10, true, false, null, 2026-10-13, 0.5, 1e, tru]')
  add('a raw line feed in a string', '["the tide\nan owl", "the pier"]')
  add('every code point at a class boundary', isolatedLetters.flatMap(letter => [String.fromCodePoint(letter.codePointAt(0)! - 1), letter, String.fromCodePoint(letter.codePointAt(0)! + 1)]).join(''))
  return documents
}

// The hand-written documents, then generated documents of which every one is broken, generated documents with the
// usual 1 in 10 broken, and the highlighter's own kinds of test texts with another seed than its tests use.
export function edgeDocuments(sizes: {broken: number, generated: number, random: number, mutated: number, long: number}): EdgeDocument[] {
  const corpus = createCorpus(20261014, sizes)
  return [
    ...handWrittenDocuments(),
    ...generateDocuments(sizes.broken, 977, 1).map((document, index) => ({name: `generated, broken, ${document.defect}, ${index}`, text: document.text})),
    ...generateDocuments(sizes.generated, 978).map((document, index) => ({name: `generated, ${document.defect}, ${index}`, text: document.text})),
    ...corpus.all.map((text, index) => ({name: `highlighter test text ${index}`, text})),
  ]
}

export type EdgeSearch = {pattern: string, scope: SearchScope}

const everyScope: SearchScope[] = ['everything', 'strings', 'keys', 'stringsAndKeys']
// Patterns at the limits: as many states, classes and class boundaries as a program holds, patterns that match nothing,
// every code point, or the whole text, and patterns that may match the empty text, which the search never reports.
export const edgePatterns: Record<8 | 16 | 32, readonly string[]> = {
  8: [
    'a', 'abcdefg', '(the|an?) [a-z]+', fullClassesPattern, '[]', '[^]', '[^]+', '.+', '', 'a*', '(a|ab)(c|bcd)', '"[a-z ]+"', '\\d+', '😀+', '[^a]+', 'tide', '"', '\\d\\d\\d\\d-',
  ],
  16: ['a'.repeat(15), '(the|an?|some) [a-z]+(ing)?s?', '\\d\\d\\d\\d-\\d\\d-\\d\\d', 'the tide', `${fullClassesPattern}${anyIsolatedLetter.repeat(8)}`],
  32: ['a'.repeat(31), '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', 'connection reset', `${fullClassesPattern}${anyIsolatedLetter.repeat(24)}`],
}

// Every pattern with 'everything', and the scopes in turn, so that every scope meets several patterns. The last two
// scopes are lists of kinds: numbers and literals, and no kind at all, which finds nothing.
export function edgeSearches(states: 8 | 16 | 32): EdgeSearch[] {
  const otherScopes: SearchScope[] = [...everyScope.slice(1), [displayKind.number, displayKind.literal], []]
  return edgePatterns[states].flatMap((pattern, index): EdgeSearch[] => [{pattern, scope: 'everything'}, {pattern, scope: otherScopes[index % otherScopes.length]!}])
}

export const stateCapacityOf = (compiled: CompiledPattern) => ([8, 16, 32] as const).find(states => capacityErrors(compiled, {states, classes: classCapacity, boundaries: boundaryCapacity}).length === 0)

// The highlighter with every position written out, on the CPU executor: each text's cells, the summary (valid,
// firstErrorPosition, truncated), the first error's kind, and the 512 display kinds.
export function highlighterOnTheExecutor(texts: readonly string[]) {
  const batch = buildBatchPrograms(['display'])
  const cells = new Float32Array(texts.length * cellsPerDocument)
  texts.forEach((text, row) => writeDocumentCells(cells, row * cellsPerDocument, text))
  const [summary, kinds] = expectedOutputs(batch.programs[0]!, cells, texts.length) as [Float32Array, Float32Array]
  const evaluateErrorKind = batch.built.circuit.createTensorEvaluator([batch.built.output.firstErrorKind])
  const source = new Float32Array(batch.built.initialSource)
  const errorKinds = new Float32Array(texts.length)
  texts.forEach((text, row) => {
    batch.writeText(source, text)
    errorKinds[row] = evaluateErrorKind(source)[0]!
  })
  return {cells, summary, kinds, errorKinds}
}

// The masked search with every position written out, on the CPU executor, for one state capacity: 127,414 operations at
// 8 states, and about 2 ms per document.
export function createSearchOnTheExecutor(states: number) {
  const full = buildMaskedSearch({states, classes: classCapacity, boundaries: boundaryCapacity, textLength: positions})
  const evaluate = full.circuit.createTensorEvaluator([...full.output.highlighted, ...full.output.starts, full.output.matchCount])
  const source = new Float32Array(full.initialSource)
  return {
    operations: full.circuit.operations.length,
    setSearch(compiled: CompiledPattern, scope: SearchScope) {
      writePattern(source, {cells: full.cells.search, capacity: full.capacity}, compiled)
      const searchable = new Set(searchableKinds(scope))
      full.cells.searchable.forEach((wire, kind) => {
        source[wire] = searchable.has(kind) ? 1 : 0
      })
    },
    // Document `row`'s match count, and its marks written at marks[marksOffset]: highlighted + start per position.
    run(cells: Float32Array, kinds: ArrayLike<number>, row: number, marks: Float32Array, marksOffset: number) {
      for (let position = 0; position < positions; position++) {
        source[full.cells.search.text[position]!] = cells[row * cellsPerDocument + position]!
        source[full.cells.kinds[position]!] = kinds[row * positions + position]!
      }
      const values = evaluate(source)
      for (let position = 0; position < positions; position++) marks[marksOffset + position] = values[position]! + values[positions + position]!
      return values[2 * positions]!
    },
  }
}

export type Comparison = {
  documents: number
  // The highlighter's values: 4 per document and 512 kinds per document.
  validationValues: number
  validationMismatches: number
  searches: number
  searchValues: number
  searchMismatches: number
  // What the expected values hold, so that a comparison of zeros with zeros can't pass unnoticed.
  expectedValidDocuments: number
  expectedMatches: number
  expectedMarkedPositions: number
  searchesWithMatches: number
  // The first few differences, e.g. to print.
  examples: string[]
  executorMs: number
}

// Compares a searcher over `texts` with the programs that have every position written out, on the CPU executor. The
// searcher's window capacity must be at least `windowDocuments`. Each search runs over every document, with the marks
// of the first window, and then over each later window alone, so both of a searcher's ways to search are compared.
// `maxWrittenOutStates` leaves out the searches whose program would be too large to build with every position written
// out, e.g. 1,167,392 operations at 32 states.
export async function compareWithWrittenOutPrograms(searcher: Searcher, texts: readonly string[], searches: readonly EdgeSearch[], options: {windowDocuments: number, maxWrittenOutStates: number}): Promise<Comparison> {
  const count = texts.length
  const result: Comparison = {
    documents: count, validationValues: 0, validationMismatches: 0, searches: 0, searchValues: 0, searchMismatches: 0,
    expectedValidDocuments: 0, expectedMatches: 0, expectedMarkedPositions: 0, searchesWithMatches: 0, examples: [], executorMs: 0,
  }
  const note = (text: string) => {
    if (result.examples.length < 8) result.examples.push(text)
  }
  let started = performance.now()
  const expected = highlighterOnTheExecutor(texts)
  result.executorMs += performance.now() - started

  const {validation} = searcher
  for (let row = 0; row < count; row++) {
    const actual = [validation.valid[row]!, validation.firstErrorPosition[row]!, validation.truncated[row]!, validation.firstErrorKind[row]!]
    const wanted = [expected.summary[row * summaryCount]!, expected.summary[row * summaryCount + 1]!, expected.summary[row * summaryCount + 2]!, expected.errorKinds[row]!]
    result.expectedValidDocuments += wanted[0]!
    result.validationValues += 4
    for (let column = 0; column < 4; column++) {
      if (actual[column] === wanted[column]) continue
      result.validationMismatches++
      note(`document ${row}, validation value ${column}: ${actual[column]} instead of ${wanted[column]}`)
    }
  }
  const chunk = 2048
  for (let first = 0; first < count; first += chunk) {
    const documentCount = Math.min(chunk, count - first)
    const kinds = await searcher.kinds({firstDocument: first, documentCount})
    result.validationValues += kinds.length
    for (let index = 0; index < kinds.length; index++) {
      if (kinds[index] === expected.kinds[first * positions + index]) continue
      result.validationMismatches++
      note(`document ${first + Math.floor(index / positions)}, kind at ${index % positions}: ${kinds[index]} instead of ${expected.kinds[first * positions + index]}`)
    }
  }

  const programs = new Map<number, ReturnType<typeof createSearchOnTheExecutor>>()
  const expectedCounts = new Float32Array(count)
  const expectedMarks = new Float32Array(count * positions)
  const window = Math.min(options.windowDocuments, count)
  for (const {pattern, scope} of searches) {
    const compiled = compilePattern(pattern)
    const states = stateCapacityOf(compiled)
    if (states === undefined || states > options.maxWrittenOutStates) continue
    started = performance.now()
    let program = programs.get(states)
    if (program === undefined) {
      program = createSearchOnTheExecutor(states)
      programs.set(states, program)
    }
    program.setSearch(compiled, scope)
    let matches = 0
    for (let row = 0; row < count; row++) matches += expectedCounts[row] = program.run(expected.cells, expected.kinds, row, expectedMarks, row * positions)
    result.executorMs += performance.now() - started
    result.searches++
    result.expectedMatches += matches
    if (matches > 0) result.searchesWithMatches++
    for (let index = 0; index < expectedMarks.length; index++) if (expectedMarks[index] !== 0) result.expectedMarkedPositions++

    const compare = (counts: Float32Array, marks: Float32Array, firstCount: number, firstMarked: number, marked: number) => {
      result.searchValues += counts.length + marks.length
      for (let index = 0; index < counts.length; index++) {
        if (counts[index] === expectedCounts[firstCount + index]) continue
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}, document ${firstCount + index}: ${counts[index]} matches instead of ${expectedCounts[firstCount + index]}`)
      }
      if (marks.length !== marked * positions) {
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}: ${marks.length} marks instead of ${marked * positions}`)
      }
      for (let index = 0; index < marks.length; index++) {
        if (marks[index] === expectedMarks[firstMarked * positions + index]) continue
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}, document ${firstMarked + Math.floor(index / positions)}, mark at ${index % positions}: ${marks[index]} instead of ${expectedMarks[firstMarked * positions + index]}`)
      }
    }
    const all = await searcher.search({pattern, scope, window: {firstDocument: 0, documentCount: window}})
    if (all?.status !== 'searched' || all.states !== states) {
      result.searchMismatches++
      note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}: no result from the ${states}-state program, ${JSON.stringify(all?.status)}`)
      continue
    }
    compare(all.matchCounts, all.marks, 0, 0, window)
    for (let first = window; first < count; first += window) {
      const documentCount = Math.min(window, count - first)
      const some = await searcher.search({pattern, scope, window: {firstDocument: first, documentCount}, documents: 'window'})
      if (some?.status !== 'searched') {
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}: no result for the window at ${first}`)
        continue
      }
      compare(some.matchCounts, some.marks, first, first, documentCount)
    }
  }
  return result
}

// Compares two searchers over the same documents, e.g. the GPU with the same loop programs on the CPU: the validation
// and the kinds of every document, and for each search every match count and the marks of the given windows.
export async function compareSearchers(actual: Searcher, reference: Searcher, searches: readonly EdgeSearch[], windows: readonly {firstDocument: number, documentCount: number}[]) {
  const count = Math.min(actual.documentCount, reference.documentCount)
  // referenceSearchMs is the reference's time for each search of every document, e.g. to tell what the CPU takes.
  const result = {documents: count, validationValues: 0, validationMismatches: 0, searches: 0, searchValues: 0, searchMismatches: 0, expectedMatches: 0, referenceSearchMs: [] as number[], examples: [] as string[]}
  const note = (text: string) => {
    if (result.examples.length < 8) result.examples.push(text)
  }
  for (const name of ['valid', 'firstErrorPosition', 'firstErrorKind', 'truncated'] as const) {
    result.validationValues += count
    for (let row = 0; row < count; row++) {
      if (actual.validation[name][row] === reference.validation[name][row]) continue
      result.validationMismatches++
      note(`document ${row}, ${name}: ${actual.validation[name][row]} instead of ${reference.validation[name][row]}`)
    }
  }
  const chunk = 2048
  for (let first = 0; first < count; first += chunk) {
    const range = {firstDocument: first, documentCount: Math.min(chunk, count - first)}
    const [kinds, wanted] = [await actual.kinds(range), await reference.kinds(range)]
    result.validationValues += kinds.length
    for (let index = 0; index < kinds.length; index++) {
      if (kinds[index] === wanted[index]) continue
      result.validationMismatches++
      note(`document ${first + Math.floor(index / positions)}, kind at ${index % positions}: ${kinds[index]} instead of ${wanted[index]}`)
    }
  }
  for (const {pattern, scope} of searches) {
    for (const [index, window] of windows.entries()) {
      // The first window comes with a search of every document, and the others search their documents alone.
      const request = {pattern, scope, window, ...(index === 0 ? {} : {documents: 'window' as const})}
      const [got, wanted] = [await actual.search(request), await reference.search(request)]
      if (got?.status !== 'searched' || wanted?.status !== 'searched' || got.states !== wanted.states) {
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}: ${JSON.stringify(got?.status)} and ${JSON.stringify(wanted?.status)}`)
        continue
      }
      if (index === 0) {
        result.searches++
        result.expectedMatches += wanted.matches
        result.referenceSearchMs.push(Math.round(wanted.timings.totalMs * 100) / 100)
      }
      const counts = Math.min(got.matchCounts.length, wanted.matchCounts.length, index === 0 ? count : window.documentCount)
      result.searchValues += counts + wanted.marks.length
      for (let row = 0; row < counts; row++) {
        if (got.matchCounts[row] === wanted.matchCounts[row]) continue
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}, document ${(index === 0 ? 0 : window.firstDocument) + row}: ${got.matchCounts[row]} matches instead of ${wanted.matchCounts[row]}`)
      }
      if (got.marks.length !== wanted.marks.length) result.searchMismatches++
      for (let position = 0; position < wanted.marks.length; position++) {
        if (got.marks[position] === wanted.marks[position]) continue
        result.searchMismatches++
        note(`${JSON.stringify(pattern)} in ${JSON.stringify(scope)}, document ${window.firstDocument + Math.floor(position / positions)}, mark at ${position % positions}: ${got.marks[position]} instead of ${wanted.marks[position]}`)
      }
    }
  }
  return result
}
