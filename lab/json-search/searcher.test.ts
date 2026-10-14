// The demo page's module (searcher.ts). On the CPU, against plain JavaScript written from the definitions: the
// highlighter's reference in tests/json-highlighter/reference.ts and lab/regex-search's automaton simulator over the
// code points of the searched kinds. On the GPU, against the CPU version: `createGpuSearcher` runs here on a device
// whose compute pass is the WGSL interpreter (interpreted-gpu.ts), so the test covers what the page calls, i.e. the
// shaders as bit-emit.ts writes them for a search and as loop-emit.ts writes the highlighter's, gpu/host.ts's buffers
// and packed words, and the readbacks. The interpreter says nothing about a GPU's compiler: gpu/combined-run.ts and
// gpu/review-run.ts run the same searcher in headless Chrome.
// Run from the repo root: bun test lab/json-search/searcher.test.ts
import {describe, expect, test} from 'bun:test'
import {capacity, displayKind} from '../../src/json-highlighter/kinds.ts'
import {highlightReference} from '../../tests/json-highlighter/reference.ts'
import {compilePattern} from '../regex-search/pattern.ts'
import {automatonMatches} from '../regex-search/reference.ts'
import {generateDocuments} from './documents.ts'
import {createInterpretedDevice} from './interpreted-gpu.ts'
import {createPlainSearch} from './plain-search.ts'
import {type SearchScope, searchScopes, searchableKinds} from './search-step.ts'
import {type SearchResult, type Searcher, type ShaderWriter, createCpuSearcher, createGpuSearcher, defaultSelfCheckSearches} from './searcher.ts'

const texts = [...generateDocuments(60).map(document => document.text), '{"the tide": "an owl", "a": ["the pier", 12]}', '', '"😀 the tide"', `["${'the harbor '.repeat(60)}"]`]
const references = texts.map(text => highlightReference(text, 0))
const searcher = createCpuSearcher(texts)

// What the definitions give: the automaton simulator over the first 512 code points, with -1 for every code point
// whose display kind isn't searched.
function expectedSearch(pattern: string, scope: SearchScope, row: number) {
  const searchable = new Set(searchableKinds(scope))
  const codePoints = Array.from(texts[row]!, character => character.codePointAt(0)!).slice(0, capacity)
  const masked = Array.from({length: capacity}, (_, position) => position < codePoints.length && searchable.has(references[row]!.displayKinds[position]!) ? codePoints[position]! : -1)
  const found = automatonMatches(compilePattern(pattern), masked)
  const marks = Array<number>(capacity).fill(0)
  for (const match of found) {
    marks.fill(1, match.start, match.end)
    marks[match.start] = 2
  }
  return {count: found.length, marks}
}
const searched = (result: SearchResult | undefined) => {
  if (result?.status !== 'searched') throw new Error(`expected a search result, got ${JSON.stringify(result)}`)
  return result
}

describe('the searcher on the CPU', () => {
  test('validates every document as the reference highlighter does, with the first error\'s kind and the display kinds', async () => {
    const {validation} = searcher
    references.forEach((reference, row) => {
      const actual = [validation.valid[row], validation.firstErrorPosition[row], validation.firstErrorKind[row], validation.truncated[row]]
      expect([texts[row], ...actual]).toEqual([texts[row], reference.valid, reference.firstErrorPosition, reference.firstErrorKind, reference.truncated])
    })
    expect(validation.validCount).toBe(references.filter(reference => reference.valid === 1).length)
    expect(validation.validCount).toBeLessThan(texts.length)
    const kinds = await searcher.kinds({firstDocument: 3, documentCount: 20})
    expect([...kinds]).toEqual(references.slice(3, 23).flatMap(reference => reference.displayKinds))
  })

  test('counts and marks the matches of each scope as the automaton simulator does on the searched kinds', async () => {
    const window = {firstDocument: 40, documentCount: texts.length - 40}
    let matches = 0
    for (const scope of [...searchScopes, [displayKind.number]] as SearchScope[]) {
      for (const pattern of ['(the|an?) [a-z]+', '[a-z]+', '\\d+', '"[a-z]+":']) {
        const result = searched(await searcher.search({pattern, scope, window}))
        expect([result.documents, result.states, result.matchCounts.length, result.marks.length]).toEqual(['all', 8, texts.length, window.documentCount * capacity])
        texts.forEach((_, row) => {
          const expected = expectedSearch(pattern, scope, row)
          if (result.matchCounts[row] !== expected.count) expect({pattern, scope, row, count: result.matchCounts[row]}).toEqual({pattern, scope, row, count: expected.count})
          if (row >= window.firstDocument) expect([...result.marks.subarray((row - window.firstDocument) * capacity, (row - window.firstDocument + 1) * capacity)]).toEqual(expected.marks)
          matches += expected.count
        })
        expect([result.matches, result.documentsWithMatches]).toEqual([result.matchCounts.reduce((total, count) => total + count, 0), result.matchCounts.filter(count => count > 0).length])
      }
    }
    expect(matches).toBeGreaterThan(5000)
    // A key, a string value and an array's string: 'strings' finds the two values, 'keys' the key.
    const row = texts.indexOf('{"the tide": "an owl", "a": ["the pier", 12]}')
    const countOf = async (scope: SearchScope) => searched(await searcher.search({pattern: '(the|an?) [a-z]+', scope})).matchCounts[row]
    expect([await countOf('everything'), await countOf('strings'), await countOf('keys'), await countOf('stringsAndKeys')]).toEqual([3, 2, 1, 3])
  })

  test('searching only the window\'s documents gives the same counts and marks for them', async () => {
    const window = {firstDocument: 17, documentCount: 9}
    const all = searched(await searcher.search({pattern: '@[a-z]+', scope: 'strings', window}))
    const some = searched(await searcher.search({pattern: '@[a-z]+', scope: 'strings', window, documents: 'window'}))
    expect([some.documents, [...some.matchCounts], [...some.marks]]).toEqual(['window', [...all.matchCounts.subarray(17, 26)], [...all.marks]])
    expect(all.matches).toBeGreaterThan(0)
  })

  test('a searcher that runs the highlighter when a document is first read answers as one that runs it at creation', async () => {
    const everyDocument = {firstDocument: 0, documentCount: texts.length}
    const pattern = '(the|an?) [a-z]+'
    const atCreation = searched(await searcher.search({pattern, scope: 'strings', window: everyDocument}))
    expect(atCreation.matches).toBeGreaterThan(0)
    // A few documents at a time, as a page does in a worker: the search of a piece runs the highlighter on it first.
    const whenFirstRead = createCpuSearcher(texts, {highlight: 'whenFirstRead'})
    for (let first = 0; first < texts.length; first += 24) {
      const window = {firstDocument: first, documentCount: Math.min(24, texts.length - first)}
      const piece = searched(await whenFirstRead.search({pattern, scope: 'strings', window, documents: 'window'}))
      expect([...piece.matchCounts]).toEqual([...atCreation.matchCounts.subarray(first, first + window.documentCount)])
      expect([...piece.marks]).toEqual([...atCreation.marks.subarray(first * capacity, (first + window.documentCount) * capacity)])
    }
    // Reading the kinds or the validation before any search runs the highlighter too.
    const unread = createCpuSearcher(texts, {highlight: 'whenFirstRead'})
    expect([...await unread.kinds({firstDocument: 3, documentCount: 20})]).toEqual([...await searcher.kinds({firstDocument: 3, documentCount: 20})])
    expect(unread.validation).toEqual(searcher.validation)
    expect(whenFirstRead.validation).toEqual(searcher.validation)
  })

  test('a pattern runs on the smallest state capacity that holds it, and one that fits none says what it needs', async () => {
    expect(searched(await searcher.search({pattern: 'abcdefg'})).states).toBe(8)
    const larger = searched(await searcher.search({pattern: 'connection reset'}))
    expect([larger.states, larger.patternStates]).toEqual([32, 17])
    expect(searched(await searcher.search({pattern: 'example\\.com'})).states).toBe(16)
    expect(larger.matchCounts.length).toBe(texts.length)
    expect(await searcher.search({pattern: 'a'.repeat(32)})).toEqual({status: 'tooLarge', pattern: 'a'.repeat(32), messages: ['the pattern needs 33 states, and the program holds 32']})
    expect(await searcher.search({pattern: '(a'})).toEqual({status: 'syntaxError', pattern: '(a', message: 'this group is never closed', position: 0})
    expect(searcher.programs().map(program => [program.name, program.operations])).toEqual([
      ['JSON highlighter', [37, 17]], ['regex search, 8 states', [8, 151, 92]], ['regex search, 32 states', [32, 1159, 1124]], ['regex search, 16 states', [16, 359, 308]],
    ])
  })

  test('only the newest request gets a result', async () => {
    const first = searcher.search({pattern: 'a'})
    const second = searcher.search({pattern: 'b'})
    const third = searcher.search({pattern: 'c'})
    expect([await first, await second, searched(await third).pattern]).toEqual([undefined, undefined, 'c'])
    // A request that needs no evaluation replaces the ones before it too.
    const waiting = searcher.search({pattern: 'a'})
    const broken = searcher.search({pattern: '['})
    expect([await waiting, (await broken)?.status]).toEqual([undefined, 'syntaxError'])
    // And a request made after the earlier ones are done gets its result.
    expect(searched(await searcher.search({pattern: 'a'})).pattern).toBe('a')
  })

  test('the self check finds no difference between generated JavaScript and the CPU executor', async () => {
    // The 7 of the self check's 9 searches that the program of 8 states holds.
    const check = await createCpuSearcher(texts.slice(0, 12), {stateCapacities: [8]}).selfCheck(12)
    expect([check.documents, check.searches, check.mismatches]).toEqual([12, 7, 0])
    expect(check.values).toBe(4 * 12 + 7 * (12 + 12 * capacity))
  }, 60_000)

  test('the self check\'s searches fill each program\'s states, read characters above U+00FF, and match at a document\'s last character', () => {
    const statesOf = (pattern: string) => compilePattern(pattern).automaton.stateCount
    const patterns = defaultSelfCheckSearches.map(search => search.pattern)
    for (const states of [8, 16, 32]) expect(patterns.map(statesOf)).toContain(states)
    expect(patterns.some(pattern => Array.from(pattern).every(character => character.codePointAt(0)! > 0xff))).toBe(true)
    // Every generated document that is valid JSON ends with a bracket, which `[}\\]]` matches.
    expect(patterns).toContain('[}\\]]')
    const closing = compilePattern('[}\\]]')
    for (const text of generateDocuments(40, undefined, 0).map(document => document.text)) {
      const codePoints = Array.from(text, character => character.codePointAt(0)!)
      expect(automatonMatches(closing, codePoints).at(-1)?.end).toBe(codePoints.length)
    }
  })
})

// The GPU version over a device that runs each pass through the WGSL interpreter, about 30 ms per document and
// search for bit-emit.ts's shaders, and 0.1, 0.3 and 1 s at 8, 16 and 32 states for loop-emit.ts's. So these tests
// hold a few documents: six generated ones, then the four written by hand above, one of them empty and one longer
// than a program holds.
describe('the searcher on the GPU, with every pass run by the WGSL interpreter', () => {
  const few = [...texts.slice(0, 6), ...texts.slice(60)]
  const everyDocument = {firstDocument: 0, documentCount: few.length}
  const cpu = createCpuSearcher(few, {windowCapacity: few.length})
  // The four documents written by hand.
  const window = {firstDocument: 6, documentCount: 4}
  // A pattern that fills each program's states, and one of 2 states. `states` is the program that the pattern runs on.
  const searches: {pattern: string, scope: SearchScope, states: number}[] = [
    {pattern: '(the|an?) [a-z]+', scope: 'strings', states: 8},
    {pattern: '[a-z]+', scope: 'keys', states: 8},
    {pattern: '(the|an?|some) [a-z]+(ing)?s?', scope: 'everything', states: 16},
    {pattern: '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', scope: 'stringsAndKeys', states: 32},
  ]

  // A GPU searcher's validation, kinds, and each search's counts and marks, against the CPU searcher's: with every
  // document in one pass and the marks of a window, as a page searches at a keystroke, and with the window's
  // documents alone, as a page reads the marks of the document that it shows.
  async function expectTheCpuSearchersValues(gpu: Searcher, wanted: typeof searches) {
    expect(gpu.validation).toEqual(cpu.validation)
    expect(gpu.validation.validCount).toBeLessThan(few.length)
    expect([...await gpu.kinds(everyDocument)]).toEqual([...await cpu.kinds(everyDocument)])
    let matches = 0
    for (const {pattern, scope, states} of wanted) {
      const expected = searched(await cpu.search({pattern, scope, window}))
      const all = searched(await gpu.search({pattern, scope, window}))
      expect([pattern, all.states, all.patternStates, [...all.matchCounts], [...all.marks]]).toEqual([pattern, states, expected.patternStates, [...expected.matchCounts], [...expected.marks]])
      const some = searched(await gpu.search({pattern, scope, window, documents: 'window'}))
      expect([pattern, [...some.matchCounts], [...some.marks]]).toEqual([pattern, [...expected.matchCounts.subarray(window.firstDocument, window.firstDocument + window.documentCount)], [...expected.marks]])
      expect(expected.marks.some(mark => mark === 2)).toBe(true)
      matches += expected.matches
    }
    expect(matches).toBeGreaterThan(wanted.length * 10)
    expect(wanted.map(search => compilePattern(search.pattern).automaton.stateCount)).toContain(wanted.at(-1)!.states)
  }
  const statementsOf = (searcher: Searcher) => searcher.programs().map(program => [program.name, program.statements])

  test('as a page creates it: the search programs\' shaders are bit-emit.ts\'s and the highlighter\'s is loop-emit.ts\'s, all compiled at creation, and every value is the CPU searcher\'s', async () => {
    const gpu = await createGpuSearcher(createInterpretedDevice(), few)
    expect([gpu.backend, gpu.stateCapacities]).toEqual(['gpu', [8, 16, 32]])
    // loop-emit.ts writes the same search programs as 503, 1,375 and 4,655 statements.
    expect(statementsOf(gpu)).toEqual([['JSON highlighter', 107], ['regex search, 8 states', 147], ['regex search, 16 states', 171], ['regex search, 32 states', 219]])
    expect(await gpu.prepare(32)).toBe(0)
    await expectTheCpuSearchersValues(gpu, searches)
    gpu.destroy()
  }, 60_000)

  test('only the newest of several requests gets a result, while the one before it is in flight', async () => {
    const gpu = await createGpuSearcher(createInterpretedDevice(), few, {stateCapacities: [8]})
    const first = gpu.search({pattern: 'a'})
    const second = gpu.search({pattern: 'b'})
    const third = gpu.search({pattern: 'the', scope: 'strings'})
    const expected = searched(await cpu.search({pattern: 'the', scope: 'strings'}))
    expect([await first, await second, [...searched(await third).matchCounts]]).toEqual([undefined, undefined, [...expected.matchCounts]])
    expect(expected.matches).toBeGreaterThan(5)
    // A pattern that the largest program of this searcher doesn't hold.
    expect((await gpu.search({pattern: 'connection reset'}))?.status).toBe('tooLarge')
  }, 30_000)

  test('with the other writer for each shader, every value is the same: loop-emit.ts\'s search shaders at 8 and 16 states, and bit-emit.ts\'s shader for the highlighter', async () => {
    const writers: {search: ShaderWriter, highlighter: ShaderWriter} = {search: 'loop-emit', highlighter: 'bit-emit'}
    const gpu = await createGpuSearcher(createInterpretedDevice(), few, {writers, stateCapacities: [8, 16]})
    expect(statementsOf(gpu)).toEqual([['JSON highlighter', 103], ['regex search, 8 states', 503], ['regex search, 16 states', 1375]])
    await expectTheCpuSearchersValues(gpu, searches.filter(search => search.states <= 16))
  }, 120_000)

  test('the self check finds no difference between the shaders and generated JavaScript: every search on every program that holds it', async () => {
    const sample = 4
    const gpu = await createGpuSearcher(createInterpretedDevice(), few, {windowCapacity: 3})
    const check = await gpu.selfCheck(sample)
    // 7 of the 9 searches fit 8 states, 8 fit 16, and all fit 32.
    expect([check.documents, check.searches, check.mismatches]).toEqual([sample, 7 + 8 + 9, 0])
    expect(check.values).toBe(4 * sample + sample * capacity + 24 * (sample + sample * capacity))
    // The same with loop-emit.ts's shader at 8 states.
    const other = await (await createGpuSearcher(createInterpretedDevice(), few, {writers: {search: 'loop-emit'}, stateCapacities: [8]})).selfCheck(sample)
    expect([other.searches, other.mismatches, other.values]).toEqual([7, 0, 4 * sample + sample * capacity + 7 * (sample + sample * capacity)])
  }, 120_000)
})

describe('the plain JavaScript baseline', () => {
  const plain = createPlainSearch(texts)

  test('its table loop gives the reference\'s valid, first error and display kinds', () => {
    references.forEach((reference, row) => {
      const {valid, firstErrorPosition, firstErrorKind, truncated} = plain.validation
      expect([texts[row], valid[row], firstErrorPosition[row], firstErrorKind[row], truncated[row]]).toEqual([texts[row], reference.valid, reference.firstErrorPosition, reference.firstErrorKind, reference.truncated])
      expect([...plain.kinds.subarray(row * capacity, (row + 1) * capacity)]).toEqual(reference.displayKinds)
    })
  })

  test('RegExp on each run of searched characters counts what the program counts, for patterns where the first and the longest match agree', async () => {
    for (const scope of searchScopes) {
      for (const pattern of ['(the|an?) [a-z]+', '\\d+', '"[a-z]+":', '[a-z0-9.]+@[a-z.]+']) {
        const program = searched(await searcher.search({pattern, scope}))
        const {matchCounts, matches} = plain.search(pattern, scope)
        expect([pattern, scope, [...matchCounts], matches]).toEqual([pattern, scope, [...program.matchCounts], program.matches])
      }
    }
    // Where they differ: RegExp takes the first alternative, and the program the longest match.
    const row = texts.length
    const both = createCpuSearcher([...texts, 'xabab'])
    expect([searched(await both.search({pattern: 'a|ab'})).matchCounts[row], createPlainSearch([...texts, 'xabab']).search('a|ab').matchCounts[row]]).toEqual([2, 2])
    expect([searched(await both.search({pattern: 'a|abab'})).matchCounts[row], createPlainSearch([...texts, 'xabab']).search('a|abab').matchCounts[row]]).toEqual([1, 2])
  })
})
