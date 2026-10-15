// Documents and searches at the limits of both programs, and the comparison of a searcher (searcher.ts, on the CPU or
// on the GPU) with the plain JavaScript references. The review of JSON search added them: the measurements run
// generated documents, which are ordinary JSON.
//
// What the comparison reads as the definition of each value:
// - valid, firstErrorPosition, truncated, firstErrorKind and the 512 display kinds: highlighter/reference.ts, a scanner
//   and a parser written from JSON's grammar.
// - a search's match count and marks: regex/reference.ts's automaton simulator over the document's first 512 code
//   points, with -1, the value of a cell past the text's end, in place of every code point whose display kind the
//   search doesn't read. The kinds are the reference highlighter's.
import {capacity, displayKind, maximumDepth} from '../../src/json-search/highlighter/kinds.ts'
import {createCorpus} from './highlighter/corpus.ts'
import {highlightReference} from './highlighter/reference.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../../src/json-search/regex/pattern.ts'
import {automatonMatches} from './regex/reference.ts'
import {generateDocuments} from '../../src/json-search/documents.ts'
import {cellsPerDocument, writeDocumentCells} from '../../src/json-search/program.ts'
import {type SearchScope, boundaryCapacity, classCapacity, searchableKinds} from '../../src/json-search/search-step.ts'
import type {Searcher} from '../../src/json-search/searcher.ts'

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

// The four values that a searcher's validation holds per document, in the order of the reference's array below.
export const validationNames = ['valid', 'firstErrorPosition', 'truncated', 'firstErrorKind'] as const

// The reference highlighter for each text: the text's cells, the four validation values, and the 512 display kinds,
// which are small integers, so every document's kinds fit one array of bytes, e.g. 51 MB for 100,000 documents.
export function referenceHighlights(texts: readonly string[]) {
  const cells = new Float32Array(texts.length * cellsPerDocument)
  const validation = new Float32Array(texts.length * validationNames.length)
  const kinds = new Uint8Array(texts.length * positions)
  texts.forEach((text, row) => {
    writeDocumentCells(cells, row * cellsPerDocument, text)
    const reference = highlightReference(text)
    validationNames.forEach((name, column) => {
      validation[row * validationNames.length + column] = reference[name]
    })
    kinds.set(reference.displayKinds, row * positions)
  })
  return {cells, validation, kinds}
}

// The reference for a search: the automaton simulator over the code points of the searched kinds. A pattern of any
// number of states runs, since the simulator has no capacity.
export function createReferenceSearch() {
  let pattern: CompiledPattern | undefined
  let searchable = new Set<number>()
  const masked = Array<number>(positions).fill(-1)
  return {
    setSearch(compiled: CompiledPattern, scope: SearchScope) {
      pattern = compiled
      searchable = new Set(searchableKinds(scope))
    },
    // Document `row`'s match count, and its marks written at marks[marksOffset]: 0 outside a match, 1 inside one, and 2
    // at a match's first code point. `cells` and `kinds` are referenceHighlights' arrays.
    run(cells: Float32Array, kinds: ArrayLike<number>, row: number, marks: Float32Array, marksOffset: number) {
      if (pattern === undefined) throw new Error('setSearch comes before run')
      for (let position = 0; position < positions; position++) masked[position] = searchable.has(kinds[row * positions + position]!) ? cells[row * cellsPerDocument + position]! : -1
      const found = automatonMatches(pattern, masked)
      marks.fill(0, marksOffset, marksOffset + positions)
      for (const match of found) {
        marks.fill(1, marksOffset + match.start, marksOffset + match.end)
        marks[marksOffset + match.start] = 2
      }
      return found.length
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
  // The time the references took.
  referenceMs: number
}

// Compares a searcher over `texts` with the plain JavaScript references. The searcher's window capacity must be at
// least `windowDocuments`. Each search runs over every document, with the marks of the first window, and then over
// each later window alone, so both of a searcher's ways to search are compared. A search whose pattern no program of
// the searcher holds is left out.
export async function compareWithReferences(searcher: Searcher, texts: readonly string[], searches: readonly EdgeSearch[], options: {windowDocuments: number}): Promise<Comparison> {
  const count = texts.length
  const result: Comparison = {
    documents: count, validationValues: 0, validationMismatches: 0, searches: 0, searchValues: 0, searchMismatches: 0,
    expectedValidDocuments: 0, expectedMatches: 0, expectedMarkedPositions: 0, searchesWithMatches: 0, examples: [], referenceMs: 0,
  }
  const note = (text: string) => {
    if (result.examples.length < 8) result.examples.push(text)
  }
  let started = performance.now()
  const expected = referenceHighlights(texts)
  result.referenceMs += performance.now() - started

  const {validation} = searcher
  for (let row = 0; row < count; row++) {
    result.expectedValidDocuments += expected.validation[row * validationNames.length]!
    result.validationValues += validationNames.length
    validationNames.forEach((name, column) => {
      const wanted = expected.validation[row * validationNames.length + column]
      if (validation[name][row] === wanted) return
      result.validationMismatches++
      note(`document ${row}, ${name}: ${validation[name][row]} instead of ${wanted}`)
    })
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

  const reference = createReferenceSearch()
  const expectedCounts = new Float32Array(count)
  const expectedMarks = new Float32Array(count * positions)
  const window = Math.min(options.windowDocuments, count)
  for (const {pattern, scope} of searches) {
    const compiled = compilePattern(pattern)
    // The program that the searcher runs the pattern on.
    const states = stateCapacityOf(compiled)
    if (states === undefined) continue
    started = performance.now()
    reference.setSearch(compiled, scope)
    let matches = 0
    for (let row = 0; row < count; row++) matches += expectedCounts[row] = reference.run(expected.cells, expected.kinds, row, expectedMarks, row * positions)
    result.referenceMs += performance.now() - started
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
