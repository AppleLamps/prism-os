// What a programmer would write in plain JavaScript for the same answers, as the baseline next to searcher.ts: the
// table loop (table-loop.ts) for valid, the first error and the display kinds, once, and RegExp for the match counts,
// per search. For a scope other than 'everything' it runs RegExp on each run of searched characters, e.g. on each
// string value, so a match lies inside one run, as in search-step.ts. The runs of a scope are found once and kept as
// strings, since the documents don't change, so a search is only the RegExp calls.
//
// RegExp isn't the same search as the program: it takes the first alternative that matches where the program takes the
// longest match, e.g. a|ab finds a in xabx where the program finds ab, so the two counts can differ for some patterns.
// On the patterns of gpu/search-run.ts they are equal for every generated document.
import {capacity} from '../../src/json-highlighter/kinds.ts'
import {type SearchScope, kindCount, searchableKinds} from './search-step.ts'
import {highlightWithTables, tableLoopResult} from './table-loop.ts'

export function createPlainSearch(texts: readonly string[]) {
  const started = performance.now()
  const documentCount = texts.length
  const kinds = new Uint8Array(documentCount * capacity)
  const valid = new Uint8Array(documentCount)
  const firstErrorPosition = new Int16Array(documentCount)
  const firstErrorKind = new Uint8Array(documentCount)
  const truncated = new Uint8Array(documentCount)
  // Whether a text's code points are its code units, i.e. it has no surrogate pair, which is the usual case.
  const plainUnits = new Uint8Array(documentCount)
  for (let row = 0; row < documentCount; row++) {
    const text = texts[row]!
    highlightWithTables(text, kinds, row * capacity)
    valid[row] = tableLoopResult.firstErrorPosition === -1 ? 1 : 0
    firstErrorPosition[row] = tableLoopResult.firstErrorPosition
    firstErrorKind[row] = tableLoopResult.firstErrorKind
    truncated[row] = tableLoopResult.truncated
    let plain = 1
    for (let unit = 0; unit < text.length; unit++) {
      const codeUnit = text.charCodeAt(unit)
      if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) plain = 0
    }
    plainUnits[row] = plain
  }
  const validateMs = performance.now() - started
  const matchCounts = new Float32Array(documentCount)

  // The runs of searched characters of every document, as strings: document `row` has runs[firstRun[row]] up to
  // runs[firstRun[row + 1] - 1]. For 'everything' a document is one run, its first 512 code points, as the program reads.
  type Runs = {runs: string[], firstRun: Uint32Array, prepareMs: number}
  const runsOfScope = new Map<string, Runs>()
  function runsFor(scope: SearchScope): Runs {
    const kindsOfScope = searchableKinds(scope)
    const key = [...kindsOfScope].sort((left, right) => left - right).join(',')
    const existing = runsOfScope.get(key)
    if (existing !== undefined) return existing
    const prepareStarted = performance.now()
    const searchable = new Uint8Array(kindCount)
    for (const kind of kindsOfScope) searchable[kind] = 1
    const everything = kindsOfScope.length === kindCount
    const runs: string[] = []
    const firstRun = new Uint32Array(documentCount + 1)
    for (let row = 0; row < documentCount; row++) {
      const text = texts[row]!
      const base = row * capacity
      if (plainUnits[row] === 0) {
        // Rare: index the text by code points, as the kinds are.
        const codePoints = Array.from(text)
        const length = Math.min(codePoints.length, capacity)
        let run = ''
        for (let position = 0; position <= length; position++) {
          if (position < length && searchable[kinds[base + position]!] === 1) {
            run += codePoints[position]!
          } else if (run !== '') {
            runs.push(run)
            run = ''
          }
        }
      } else if (everything) {
        if (text !== '') runs.push(text.length > capacity ? text.slice(0, capacity) : text)
      } else {
        const length = Math.min(text.length, capacity)
        let runStart = -1
        for (let position = 0; position <= length; position++) {
          if (position < length && searchable[kinds[base + position]!] === 1) {
            if (runStart === -1) runStart = position
          } else if (runStart !== -1) {
            runs.push(text.slice(runStart, position))
            runStart = -1
          }
        }
      }
      firstRun[row + 1] = runs.length
    }
    const created = {runs, firstRun, prepareMs: performance.now() - prepareStarted}
    runsOfScope.set(key, created)
    return created
  }

  // The match count of the first `count` documents, in an array that the next call overwrites. `prepareMs` is the time
  // to find the scope's runs, which only the first search of a scope spends.
  function search(pattern: string, scope: SearchScope = 'everything', count = documentCount) {
    const {runs, firstRun, prepareMs} = runsFor(scope)
    const searchStarted = performance.now()
    const global = new RegExp(pattern, 'gu')
    let matches = 0
    for (let row = 0; row < count; row++) {
      let found = 0
      for (let run = firstRun[row]!; run < firstRun[row + 1]!; run++) found += runs[run]!.match(global)?.length ?? 0
      matchCounts[row] = found
      matches += found
    }
    return {matchCounts, matches, ms: performance.now() - searchStarted, prepareMs, runs: firstRun[count]!}
  }

  return {documentCount, validation: {valid, firstErrorPosition, firstErrorKind, truncated}, kinds, validateMs, search}
}
