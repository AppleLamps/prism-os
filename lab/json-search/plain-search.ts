// What a programmer would write in plain JavaScript for the same answers, as the baseline next to searcher.ts: the
// table loop (table-loop.ts) for valid, the first error and the display kinds, once, and RegExp for the match counts,
// per search. For a scope other than 'everything' it runs RegExp on each run of searched characters, e.g. on each
// string value, so a match lies inside one run, as in search-step.ts.
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
  const searchable = new Uint8Array(kindCount)

  // The match count of the first `count` documents, in an array that the next call overwrites.
  function search(pattern: string, scope: SearchScope = 'everything', count = documentCount) {
    const searchStarted = performance.now()
    const global = new RegExp(pattern, 'gu')
    const kindsOfScope = searchableKinds(scope)
    const everything = kindsOfScope.length === kindCount
    searchable.fill(0)
    for (const kind of kindsOfScope) searchable[kind] = 1
    let matches = 0
    for (let row = 0; row < count; row++) {
      let text = texts[row]!
      let found = 0
      if (plainUnits[row] === 0) {
        // Rare: index the text by code points, as the kinds are.
        const codePoints = Array.from(text)
        const base = row * capacity
        let run = ''
        for (let position = 0; position <= Math.min(codePoints.length, capacity); position++) {
          if (position < Math.min(codePoints.length, capacity) && searchable[kinds[base + position]!] === 1) {
            run += codePoints[position]!
          } else if (run !== '') {
            found += run.match(global)?.length ?? 0
            run = ''
          }
        }
      } else if (everything) {
        // The program reads the first 512 code points.
        if (text.length > capacity) text = text.slice(0, capacity)
        found = text.match(global)?.length ?? 0
      } else {
        const base = row * capacity
        const length = Math.min(text.length, capacity)
        let runStart = -1
        for (let position = 0; position <= length; position++) {
          if (position < length && searchable[kinds[base + position]!] === 1) {
            if (runStart === -1) runStart = position
          } else if (runStart !== -1) {
            found += text.slice(runStart, position).match(global)?.length ?? 0
            runStart = -1
          }
        }
      }
      matchCounts[row] = found
      matches += found
    }
    return {matchCounts, matches, ms: performance.now() - searchStarted}
  }

  return {documentCount, validation: {valid, firstErrorPosition, firstErrorKind, truncated}, kinds, validateMs, search}
}
