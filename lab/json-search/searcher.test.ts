// The demo page's module on the CPU (searcher.ts), against plain JavaScript written from the definitions: the
// highlighter's reference in tests/json-highlighter/reference.ts and lab/regex-search's automaton simulator over the
// code points of the searched kinds. The GPU version runs the same loop programs through loop-emit.ts's shaders, which
// search.test.ts checks through the WGSL interpreter and gpu/combined-run.ts checks in headless Chrome.
// Run from the repo root: bun test lab/json-search/searcher.test.ts
import {describe, expect, test} from 'bun:test'
import {capacity, displayKind} from '../../src/json-highlighter/kinds.ts'
import {highlightReference} from '../../tests/json-highlighter/reference.ts'
import {compilePattern} from '../regex-search/pattern.ts'
import {automatonMatches} from '../regex-search/reference.ts'
import {generateDocuments} from './documents.ts'
import {createPlainSearch} from './plain-search.ts'
import {type SearchScope, searchScopes, searchableKinds} from './search-step.ts'
import {type SearchResult, createCpuSearcher} from './searcher.ts'

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

  test('a pattern runs on the smallest state capacity that holds it, and one that fits none says what it needs', async () => {
    expect(searched(await searcher.search({pattern: 'abcdefg'})).states).toBe(8)
    const larger = searched(await searcher.search({pattern: 'connection reset'}))
    expect([larger.states, larger.patternStates]).toEqual([32, 17])
    expect(searched(await searcher.search({pattern: 'example\\.com'})).states).toBe(16)
    expect(larger.matchCounts.length).toBe(texts.length)
    expect(await searcher.search({pattern: 'a'.repeat(32)})).toEqual({status: 'tooLarge', pattern: 'a'.repeat(32), messages: ['the pattern needs 33 states, and the program holds 32']})
    expect(await searcher.search({pattern: '(a'})).toEqual({status: 'syntaxError', pattern: '(a', message: 'unterminated group', position: 0})
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
    const check = await createCpuSearcher(texts.slice(0, 12), {stateCapacities: [8]}).selfCheck(12)
    expect([check.documents, check.searches, check.mismatches]).toEqual([12, 4, 0])
    expect(check.values).toBe(4 * 12 + 4 * (12 + 12 * capacity))
  }, 60_000)
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
