// The independent check of bit-emit.ts's shaders on a real GPU: what the search step returns as bit-emit.ts writes it
// (writer-answers-page.ts, in a fresh headless Chrome) against RegExp over the documents' texts, computed here in Bun.
// For the searches, this file shares the document generator with the lab and nothing else: no automaton, no table
// loop, no code of expected.ts, and no shader of loop-emit.ts. Where independent.ts compares one bit per document for the hand-written
// kernels, this compares both outputs of the program's step: the match count of every document and the mark of every
// position. The page evaluates each search a window of 10,000 documents at a time, and each search with a scope once
// more as searcher.ts does for the demo page: every document in one pass, with the marks of 64 documents.
//
//   bun lab/json-search/million/writer-independent.ts --out <new folder> --profile <new folder> [--count 100000] [--window 10000] [--port 4511] [--devtools-port 9511]
//
// What the program's step computes, stated without its code: the matches of a text are found from left to right, each
// the longest match that starts at the first position where a match of 1 or more code points starts, and the next
// search starts after its last code point. A mark is 2 at a match's first code point, 1 at its other code points and 0
// elsewhere, and the match count is the number of matches. A match of no code points isn't one. With a scope, each run
// of neighboring code points of the scope's display kinds is searched as a text of its own, e.g. the characters of one
// string value between two escapes.
//
// RegExp takes the first alternative that matches and not the longest, e.g. /re|reset/ finds "re" in "reset". For a
// pattern where the two differ, the entry below gives RegExp the same language with the longest alternative first.
// Before the GPU runs, `longestMatches` checks every entry's RegExp against the definition above on a sample of
// documents, with anchored tests of the pattern as written.
//
// The highlighter's step as bit-emit.ts writes it is compared twice. Its display kinds of the generated documents,
// which the searches with a scope read, against this file's own reading of each text, which is valid JSON. And, since
// no generated document is broken, its summary and display kinds of the texts of tests/json-search/highlighter/corpus.ts,
// most of them broken JSON, against the repo's plain JavaScript highlighter, tests/json-search/highlighter/reference.ts.
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createCorpus} from '../../../tests/json-search/highlighter/corpus.ts'
import {highlightReference} from '../../../tests/json-search/highlighter/reference.ts'
import {argument, required, runPage} from '../gpu/chrome.ts'
import {documentText} from '../../../src/json-search/demo-text.ts'
import page from './writer-answers-page.html'
import type {SearchForm, WriterAnswersConfig, WriterSearch} from './writer-answers-page.ts'

// The program reads a document's first 512 code points.
const positions = 512
const capacities = [8, 16, 32]
// The display kinds as numbers, as src/json-search/highlighter/kinds.ts lists them.
const kind = {whitespace: 0, punctuation: 1, string: 2, escape: 3, number: 4, literal: 5, pastEnd: 7, key: 8} as const

// `states` is the pattern's size in the lab's count, its characters and classes plus one, e.g. 8 for `example`. The
// page must run the pattern at every capacity from there up, which this file checks.
type Chosen = {source: string, states: number, why: string, oracle?: string}
const chosen: Chosen[] = [
  {source: 'example', states: 8, why: 'exactly 8 states'},
  {source: '"[A-Z][a-z]+ [A-Z][a-zü]+"', states: 8, why: 'exactly 8 states, with classes and repeats'},
  {source: '\\w+@\\w+\\.com', states: 8, why: 'exactly 8 states, with \\w'},
  {source: '"level": "warn"', states: 16, why: 'exactly 16 states'},
  {source: 'connection rese', states: 16, why: 'exactly 16 states'},
  {source: 'tLogin": ?"\\d\\d\\d\\d-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ"', states: 32, why: 'exactly 32 states'},
  {source: ': ?"\\d\\d\\d\\d-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ"[,}\n\t ]+"[a-z]+": ?[-\\d"tfn]', states: 32, why: 'exactly 32 states, with repeats, across two members of an object'},
  {source: '\\d*', states: 2, why: 'matches the empty text: only the runs of digits count'},
  {source: '(error)?', states: 6, why: 'matches the empty text, with a group'},
  {source: '[}\\]]', states: 2, why: 'matches at every document\'s last character'},
  {source: '[^,]+', states: 2, why: 'long matches, and one that ends at every document\'s last character'},
  {source: '[^]+', states: 2, why: 'one match over the whole document: the cells past the text\'s end must stay 0'},
  {source: '.+', states: 2, why: 'every line'},
  {source: '東京', states: 3, why: 'characters above U+00FF'},
  {source: '[ø-東]+', states: 2, why: 'a class from U+00F8 to U+6771'},
  {source: '[^ -~\t\n]+', states: 2, why: 'every run of characters outside ASCII'},
  {source: 'M[uü]ller|Garc[ií]a|咲|李', states: 15, why: 'alternatives, some above U+00FF'},
  {source: '(re|reset|res)', states: 11, why: 'the longest alternative isn\'t the first', oracle: 'reset|res|re'},
  {source: '"(name|city)": ?"[A-Z]\\w*( \\w+)?"', states: 19, why: 'groups, ?, * and + in one pattern'},
  {source: '"[^"]*"', states: 4, why: 'every string as written, with its quotes'},
]

const out = required('--out')
mkdirSync(out, {recursive: true})
const count = Number(argument('--count') ?? 100_000)
const windowDocuments = Number(argument('--window') ?? 10_000)
const thousands = (value: number) => value.toLocaleString('en-US')

// The documents, and for each the runs of code points that a scope reads: [start, end) pairs, one after the other.
type Described = {text: string, stringRuns: number[], keyRuns: number[]}
// The display kind of every position of a valid JSON text, and the runs of string characters between escapes, split
// into keys (a string followed by a colon) and string values. `kinds` is filled when given.
function describe(text: string, kinds?: Uint8Array): Described {
  const stringRuns: number[] = []
  const keyRuns: number[] = []
  kinds?.fill(kind.pastEnd)
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (' \n\t\r'.includes(character)) {
      if (kinds !== undefined) kinds[index] = kind.whitespace
      index++
    } else if ('{}[]:,'.includes(character)) {
      if (kinds !== undefined) kinds[index] = kind.punctuation
      index++
    } else if (character === '"') {
      // The token's end, and its escapes: a backslash with one character, or \u with four hex digits.
      const escapes: number[] = []
      let end = index + 1
      while (text[end] !== '"') {
        if (end >= text.length) throw new Error(`a string of ${JSON.stringify(text)} never ends`)
        if (text[end] === '\\') {
          const length = text[end + 1] === 'u' ? 6 : 2
          escapes.push(end, end + length)
          end += length
        } else end++
      }
      end++
      let after = end
      while (' \n\t\r'.includes(text[after] ?? 'x')) after++
      const isKey = text[after] === ':'
      const runs = isKey ? keyRuns : stringRuns
      let runStart = index
      for (let escape = 0; escape < escapes.length; escape += 2) {
        if (escapes[escape]! > runStart) runs.push(runStart, escapes[escape]!)
        runStart = escapes[escape + 1]!
      }
      runs.push(runStart, end)
      if (kinds !== undefined) {
        kinds.fill(isKey ? kind.key : kind.string, index, end)
        for (let escape = 0; escape < escapes.length; escape += 2) kinds.fill(kind.escape, escapes[escape], escapes[escape + 1])
      }
      index = end
    } else if ('-0123456789'.includes(character)) {
      const start = index
      while ('-+.eE0123456789'.includes(text[index] ?? 'x')) index++
      kinds?.fill(kind.number, start, index)
    } else if (character >= 'a' && character <= 'z') {
      const start = index
      while ((text[index] ?? ' ') >= 'a' && (text[index] ?? ' ') <= 'z') index++
      kinds?.fill(kind.literal, start, index)
    } else throw new Error(`${JSON.stringify(character)} at ${index} of ${JSON.stringify(text)} starts no JSON token`)
  }
  return {text, stringRuns, keyRuns}
}

const documents: Described[] = []
for (let index = 0; index < count; index++) {
  const text = documentText(index)
  JSON.parse(text)
  // A position is a code point, and below every position is read as one UTF-16 code unit.
  if (text.length > positions || /[\ud800-\udfff]/.test(text)) throw new Error(`document ${index} is longer than ${positions} code points or holds a surrogate`)
  documents.push(describe(text))
}

// The matches of 1 or more code points that a global RegExp finds in text[start, end), as [first, end) pairs.
function matchesIn(oracle: RegExp, text: string, start: number, end: number, found: number[], skipped: {empty: number}) {
  const piece = start === 0 && end === text.length ? text : text.slice(start, end)
  oracle.lastIndex = 0
  for (let match = oracle.exec(piece); match !== null; match = oracle.exec(piece)) {
    if (match[0].length === 0) {
      skipped.empty++
      oracle.lastIndex++
    } else found.push(start + match.index, start + match.index + match[0].length)
  }
}

// The definition at the top of this file, by anchored tests of the pattern as written: the longest match of 1 or more
// code points at the first position that has one, then on from its end. Quadratic, so only for a sample.
function longestMatches(anchored: RegExp, text: string) {
  const found: number[] = []
  let position = 0
  while (position < text.length) {
    let end = text.length
    while (end > position && !anchored.test(text.slice(position, end))) end--
    if (end > position) {
      found.push(position, end)
      position = end
    } else position++
  }
  return found
}

const oracles = chosen.map(entry => new RegExp(entry.oracle ?? entry.source, 'gu'))
const sampleEvery = Math.max(1, Math.floor(count / 48))
const sample = {documents: 0, matches: 0, differ: 0}
for (const [patternIndex, entry] of chosen.entries()) {
  const anchored = new RegExp(`^(?:${entry.source})$`, 'u')
  for (let index = 0; index < count; index += sampleEvery) {
    const {text} = documents[index]!
    const fast: number[] = []
    matchesIn(oracles[patternIndex]!, text, 0, text.length, fast, {empty: 0})
    const slow = longestMatches(anchored, text)
    sample.documents++
    sample.matches += slow.length / 2
    if (fast.join(',') !== slow.join(',')) {
      sample.differ++
      console.log(`RegExp and the longest matches differ for ${entry.source} in document ${index}: ${fast.join(',')} against ${slow.join(',')}`)
    }
  }
}
console.log(`The RegExp of each of the ${chosen.length} patterns against the longest matches by anchored tests, ${thousands(sample.documents)} texts, ${thousands(sample.matches)} matches: ${sample.differ} texts differ.`)
if (sample.differ > 0) throw new Error('a RegExp below doesn\'t find the longest matches, so it can\'t be what the program is compared with')

type Tally = {
  search: WriterSearch
  // The documents whose match count was compared, and the documents whose 512 marks were.
  documents: number
  markedDocuments: number
  // The documents whose match count differs, and the positions whose mark differs.
  countsDiffer: number
  marksDiffer: number
  matchesByRegExp: number
  matchesReturned: number
  // What the matches cover: how many end at a text's last character, how many of those at position 511, how many code
  // points above U+00FF lie inside a match, and how many empty matches RegExp found, which aren't counted.
  endAtLastCharacter: number
  endAtLastPosition: number
  codePointsAbove255: number
  emptyMatches: number
}
// The searches a window at a time, and the passes over every document with the marks of 64 documents.
const tallies = new Map<string, Tally>()
const wholeTallies = new Map<string, Tally>()
const differences: string[] = []
const kindsTally = {positions: 0, differ: 0, documents: 0}
// `!==` takes -0 for 0, so the values that are -0 are counted from their bits: an integer statement can't write one,
// and an f32 statement can, e.g. -1 × 0.
let negativeZeros = 0
function countNegativeZeros(values: Float32Array) {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length)
  for (let index = 0; index < words.length; index++) if (words[index] === 0x80000000) negativeZeros++
}
const expectedKinds = new Uint8Array(positions)
const expectedMarks = new Uint8Array(positions)
const keyOf = (search: WriterSearch) => `${search.patternIndex} ${search.states} ${search.form} ${search.scope}`

// One body of the page against RegExp: the match counts of the documents from `firstCount` on, then the marks of the
// documents from `firstMarked` on. A window's body holds the same documents twice. The body of a pass over every
// document holds every count, and the marks of the 64 documents that were on screen.
function compare(tally: Tally, firstCount: number, countDocuments: number, firstMarked: number, values: Float32Array) {
  const {search} = tally
  const markedDocuments = (values.length - countDocuments) / positions
  const oracle = oracles[search.patternIndex]!
  const skipped = {empty: 0}
  const found: number[] = []
  for (let row = 0; row < countDocuments; row++) {
    const index = firstCount + row
    const {text, stringRuns, keyRuns} = documents[index]!
    found.length = 0
    switch (search.scope) {
      case 'everything':
        matchesIn(oracle, text, 0, text.length, found, skipped)
        break
      case 'strings': case 'keys': case 'stringsAndKeys': {
        const runs = search.scope === 'strings' ? stringRuns : search.scope === 'keys' ? keyRuns : [...stringRuns, ...keyRuns]
        for (let run = 0; run < runs.length; run += 2) matchesIn(oracle, text, runs[run]!, runs[run + 1]!, found, skipped)
        break
      }
    }
    expectedMarks.fill(0)
    for (let match = 0; match < found.length; match += 2) {
      const start = found[match]!
      const end = found[match + 1]!
      expectedMarks[start] = 2
      expectedMarks.fill(1, start + 1, end)
      if (end === text.length) {
        tally.endAtLastCharacter++
        if (end === positions) tally.endAtLastPosition++
      }
      for (let index = start; index < end; index++) if (text.charCodeAt(index) > 0xff) tally.codePointsAbove255++
    }
    const matches = found.length / 2
    const returned = values[row]!
    tally.documents++
    tally.matchesByRegExp += matches
    tally.matchesReturned += returned
    let marksDiffer = 0
    if (index >= firstMarked && index < firstMarked + markedDocuments) {
      const base = countDocuments + (index - firstMarked) * positions
      for (let position = 0; position < positions; position++) if (values[base + position] !== expectedMarks[position]) marksDiffer++
      tally.markedDocuments++
    }
    tally.marksDiffer += marksDiffer
    if (returned !== matches) tally.countsDiffer++
    if ((returned !== matches || marksDiffer > 0) && differences.length < 20) {
      differences.push(`${chosen[search.patternIndex]!.source} at ${search.states} states, ${search.form}, ${search.scope}, document ${index}: the GPU returned ${returned} matches and RegExp finds ${matches}, ${marksDiffer} marks differ`)
    }
  }
  tally.emptyMatches += skipped.empty
}
const tallyOf = (all: Map<string, Tally>, search: WriterSearch) => {
  let tally = all.get(keyOf(search))
  if (tally === undefined) {
    tally = {search, documents: 0, markedDocuments: 0, countsDiffer: 0, marksDiffer: 0, matchesByRegExp: 0, matchesReturned: 0, endAtLastCharacter: 0, endAtLastPosition: 0, codePointsAbove255: 0, emptyMatches: 0}
    all.set(keyOf(search), tally)
  }
  return tally
}

function compareKinds(first: number, values: Float32Array) {
  const documentCount = values.length / positions
  for (let row = 0; row < documentCount; row++) {
    describe(documents[first + row]!.text, expectedKinds)
    let differ = 0
    for (let position = 0; position < positions; position++) if (values[row * positions + position] !== expectedKinds[position]) differ++
    kindsTally.positions += positions
    kindsTally.differ += differ
    kindsTally.documents++
    if (differ > 0 && differences.length < 20) differences.push(`document ${first + row}: ${differ} display kinds differ from this file's reading of the text`)
  }
}

// The other texts for the highlighter's step: the edge cases, random JSON, mutated JSON and texts past 512 code points.
const brokenTexts = createCorpus(20261014, {random: 2000, mutated: 6000, long: 400}).all
const brokenTally = {texts: 0, valid: 0, truncated: 0, values: 0, summariesDiffer: 0, kindsDiffer: 0}
// One text's summary, as json-step.ts lists it: valid, the first error's position, truncated, the first error's kind.
function compareBroken(values: Float32Array) {
  const summaryValues = 4
  const kindsBase = brokenTexts.length * summaryValues
  for (const [row, text] of brokenTexts.entries()) {
    const expected = highlightReference(text, 0)
    const summary = [expected.valid, expected.firstErrorPosition, expected.truncated, expected.firstErrorKind]
    let differ = 0
    for (let column = 0; column < summaryValues; column++) if (values[row * summaryValues + column] !== summary[column]) differ++
    brokenTally.summariesDiffer += differ
    let kindsDiffer = 0
    for (let position = 0; position < positions; position++) if (values[kindsBase + row * positions + position] !== (expected.displayKinds[position] ?? kind.pastEnd)) kindsDiffer++
    brokenTally.kindsDiffer += kindsDiffer
    brokenTally.texts++
    brokenTally.valid += expected.valid
    brokenTally.truncated += expected.truncated
    brokenTally.values += summaryValues + positions
    if (differ + kindsDiffer > 0 && differences.length < 20) differences.push(`the highlighter on ${JSON.stringify(text.slice(0, 60))}: ${differ} summary values and ${kindsDiffer} display kinds differ from the reference`)
  }
}

const config: WriterAnswersConfig = {count, windowDocuments, patterns: chosen.map(entry => entry.source), capacities, shaderSalt: Math.floor(Math.random() * 1e9), brokenTexts}
const forms: readonly SearchForm[] = ['plain', 'stop', 'scope']
const scopes: readonly WriterSearch['scope'][] = ['everything', 'strings', 'keys', 'stringsAndKeys']
const loadAverage = () => Number(Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim().split(/\s+/)[1])
const loadBefore = loadAverage()
await runPage({
  page, config, label: `bit-emit.ts's answers for ${count} documents`, profile: required('--profile'), out: join(out, 'writer-answers.json'),
  port: Number(argument('--port') ?? 4511), devToolsPort: Number(argument('--devtools-port') ?? 9511), timeoutMs: 3600 * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  routes: {
    '/kinds': async request => {
      const query = new URL(request.url).searchParams
      const values = new Float32Array(await request.arrayBuffer())
      if (values.length !== Number(query.get('documents')) * positions) return new Response('the body holds 512 kinds per document', {status: 400})
      countNegativeZeros(values)
      compareKinds(Number(query.get('first')), values)
      return new Response('ok')
    },
    '/broken': async request => {
      const values = new Float32Array(await request.arrayBuffer())
      if (values.length !== brokenTexts.length * (4 + positions)) return new Response('the body holds 4 summary values and 512 kinds per text', {status: 400})
      countNegativeZeros(values)
      compareBroken(values)
      return new Response('ok')
    },
    '/window': async request => {
      const query = new URL(request.url).searchParams
      const search: WriterSearch = {patternIndex: Number(query.get('pattern')), states: Number(query.get('states')), form: query.get('form') as SearchForm, scope: query.get('scope') as WriterSearch['scope']}
      const values = new Float32Array(await request.arrayBuffer())
      const windowDocuments = Number(query.get('documents'))
      if (chosen[search.patternIndex] === undefined || !forms.includes(search.form) || !scopes.includes(search.scope) || values.length !== windowDocuments * (1 + positions)) return new Response('an unknown search, or a body that isn\'t 513 values per document', {status: 400})
      countNegativeZeros(values)
      compare(tallyOf(tallies, search), Number(query.get('first')), windowDocuments, Number(query.get('first')), values)
      return new Response('ok')
    },
    '/whole': async request => {
      const query = new URL(request.url).searchParams
      const search: WriterSearch = {patternIndex: Number(query.get('pattern')), states: Number(query.get('states')), form: query.get('form') as SearchForm, scope: query.get('scope') as WriterSearch['scope']}
      const values = new Float32Array(await request.arrayBuffer())
      if (chosen[search.patternIndex] === undefined || search.form !== 'scope' || !scopes.includes(search.scope) || values.length !== count + Number(query.get('documents')) * positions) return new Response('an unknown search, or a body that isn\'t every count and 512 marks per document on screen', {status: 400})
      countNegativeZeros(values)
      compare(tallyOf(wholeTallies, search), 0, count, Number(query.get('first')), values)
      return new Response('ok')
    },
  },
})
const loadAfter = loadAverage()

// Every search that this file expects: each pattern at every capacity that holds it, in the three forms, with the
// four scopes for the form that has one. A search that the page left out, or a window that never arrived, is a failure.
const missing: string[] = []
for (const [patternIndex, entry] of chosen.entries()) {
  for (const states of capacities.filter(capacity => capacity >= entry.states)) {
    for (const form of forms) {
      for (const scope of form === 'scope' ? scopes : ['everything'] as const) {
        const tally = tallies.get(keyOf({patternIndex, states, form, scope}))
        if (tally?.documents !== count || tally.markedDocuments !== count) missing.push(`${entry.source} at ${states} states, ${form}, ${scope}: ${tally?.documents ?? 0} of ${count} documents arrived`)
        const whole = wholeTallies.get(keyOf({patternIndex, states, form, scope}))
        if (form === 'scope' && (whole?.documents !== count || whole.markedDocuments !== 64)) missing.push(`${entry.source} at ${states} states, ${scope}: the pass over every document didn't arrive`)
      }
    }
  }
}
if (kindsTally.documents !== count) missing.push(`the display kinds of ${kindsTally.documents} of ${count} documents arrived`)
if (brokenTally.texts !== brokenTexts.length) missing.push(`the highlighter's answers for ${brokenTally.texts} of ${brokenTexts.length} other texts arrived`)

const all = [...tallies.values()]
const wholes = [...wholeTallies.values()]
const sum = (entries: readonly Tally[], field: 'documents' | 'markedDocuments' | 'countsDiffer' | 'marksDiffer' | 'matchesByRegExp' | 'matchesReturned') => entries.reduce((total, entry) => total + entry[field], 0)
const rows = [
  '| Pattern | States | Why it is here | Searches | Match counts compared | Marks compared | Match counts that differ | Marks that differ | Matches by RegExp: everything, string values, keys | Matches that end at a text\'s last character, and of those at position 511 | Code points above U+00FF inside matches | Empty matches that RegExp finds, not counted |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
]
for (const [patternIndex, entry] of chosen.entries()) {
  const mine = all.filter(tally => tally.search.patternIndex === patternIndex)
  // The same text is searched by every search of a scope, so one search of each scope gives the scope's matches.
  const one = (form: SearchForm, scope: WriterSearch['scope']) => mine.find(tally => tally.search.form === form && tally.search.scope === scope)
  const plain = one('plain', 'everything')
  rows.push(`| \`${entry.source.replaceAll('|', '\\|').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}\` | ${entry.states} | ${entry.why} | ${mine.length} | ${thousands(sum(mine, 'documents'))} | ${thousands(sum(mine, 'documents') * positions)} | ${thousands(sum(mine, 'countsDiffer'))} | ${thousands(sum(mine, 'marksDiffer'))} | ${thousands(plain?.matchesByRegExp ?? 0)}, ${thousands(one('scope', 'strings')?.matchesByRegExp ?? 0)}, ${thousands(one('scope', 'keys')?.matchesByRegExp ?? 0)} | ${thousands(plain?.endAtLastCharacter ?? 0)}, ${thousands(plain?.endAtLastPosition ?? 0)} | ${thousands(plain?.codePointsAbove255 ?? 0)} | ${thousands(plain?.emptyMatches ?? 0)} |`)
}
const summary = [
  `${thousands(count)} documents, load average ${loadBefore} before and ${loadAfter} after. A pattern runs at every state capacity that holds it, in three forms: without a scope, without a scope with the loops stopping at the text's end, and with a scope, once for each of everything, string values, keys, and string values and keys.`,
  '',
  ...rows,
  '',
  `In all: ${thousands(all.length)} searches, ${thousands(sum(all, 'documents'))} match counts and ${thousands(sum(all, 'markedDocuments') * positions)} marks from bit-emit.ts's shaders on the GPU against RegExp in Bun. ${thousands(sum(all, 'countsDiffer'))} match counts differ, ${thousands(sum(all, 'marksDiffer'))} marks differ. RegExp finds ${thousands(sum(all, 'matchesByRegExp'))} matches over these searches and the shaders return ${thousands(sum(all, 'matchesReturned'))}.`,
  `As searcher.ts calls the shader for the demo page, every document in one pass with the marks of 64 documents in the middle: ${thousands(wholes.length)} searches with a scope, ${thousands(sum(wholes, 'documents'))} match counts and ${thousands(sum(wholes, 'markedDocuments') * positions)} marks. ${thousands(sum(wholes, 'countsDiffer'))} match counts differ, ${thousands(sum(wholes, 'marksDiffer'))} marks differ. RegExp finds ${thousands(sum(wholes, 'matchesByRegExp'))} matches and the shaders return ${thousands(sum(wholes, 'matchesReturned'))}.`,
  `The display kinds from bit-emit.ts's shader of the highlighter's step, which the searches with a scope read: ${thousands(kindsTally.positions)} positions against this file's reading of each valid JSON text, ${thousands(kindsTally.differ)} differ.`,
  `The same shader on ${thousands(brokenTally.texts)} other texts, of which ${thousands(brokenTally.texts - brokenTally.valid)} are broken JSON and ${thousands(brokenTally.truncated)} are longer than 512 code points: ${thousands(brokenTally.values)} summary values and display kinds against the repo's plain JavaScript highlighter, ${thousands(brokenTally.summariesDiffer)} summary values and ${thousands(brokenTally.kindsDiffer)} display kinds differ.`,
  `Of all the values above, ${thousands(negativeZeros)} are -0, which the comparisons take for 0.`,
  `Before the run: the RegExp of each pattern against the longest matches by anchored tests on ${thousands(sample.documents)} texts, ${thousands(sample.matches)} matches, ${sample.differ} texts differ.`,
  ...(missing.length === 0 ? [] : ['', 'Missing:', ...missing]),
  ...(differences.length === 0 ? [] : ['', 'The first differences:', ...differences]),
].join('\n')
console.log(summary)
writeFileSync(join(out, 'writer-independent.txt'), `${summary}\n`)
if (missing.length > 0 || sum([...all, ...wholes], 'countsDiffer') > 0 || sum([...all, ...wholes], 'marksDiffer') > 0 || kindsTally.differ > 0 || brokenTally.summariesDiffer + brokenTally.kindsDiffer > 0) process.exit(1)
