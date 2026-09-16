// Checks the editor's wrapping rules against pretext's pre-wrap line walker on the same texts and
// widths, twice: before, with text-editing's grapheme codes where only spaces and newlines open break
// opportunities, and after, with code point cells, the class table and the pair table. The fake
// canvas gives every character a whole number of quarter pixels, so both sides see identical widths.
// Run from the repo root:
//   bun lab/ui-exploration/code-points/pretext-agreement.ts          (line starts per text family)
//   bun lab/ui-exploration/code-points/pretext-agreement.ts census   (also where the pair table and
//                                                                     pretext's segments disagree)
// The pretext source it measures against isn't in the repo: set PRETEXT_SRC to a folder holding
// pretext's src/ files (https://github.com/chenglou/pretext). The numbers in README.md came from the
// phase 1 scratch copy of pretext at commit 477510e4, never a live checkout;
// lab/ui-exploration/text-tabulated/pretext/ holds the same files, so
//   PRETEXT_SRC=lab/ui-exploration/text-tabulated/pretext bun lab/ui-exploration/code-points/pretext-agreement.ts
// reproduces them.

import {resolve} from 'node:path'
import {referenceLayout as baselineLayout, type EditorState as BaselineState} from '../text-editing/reference.ts'
import {createWidthTable, encodeText} from '../text-editing/width-table.ts'
import {fakeTextWidth, installFakeCanvas} from '../text-editing/fake-canvas.ts'
import {breaksBetween, classNames, classOfCodePoint, codePointsOf, LB, pairRuleFor} from './line-break-classes.ts'
import {type CharacterModel, type EditorState, type PretextExperiment, referenceLayout} from './reference.ts'
import {createRandom} from './test-support.ts'

installFakeCanvas('blink')
const pretextSource = process.env['PRETEXT_SRC']
if (pretextSource === undefined) throw new Error("set PRETEXT_SRC to a folder holding pretext's src/ files (layout.ts and the modules it imports), e.g. PRETEXT_SRC=lab/ui-exploration/text-tabulated/pretext")
const pretext = await import(`${resolve(pretextSource)}/layout.ts`)

type Cursor = {segmentIndex: number, graphemeIndex: number}
type Line = {start: Cursor}
type Prepared = {segments: string[], kinds: string[]}

const font = '16px Test Sans'
const unitsPerPixel = 4
const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'})

export const characterModel: CharacterModel = {
  advanceOf: codePoint => codePoint === 0x0A ? 0 : Math.min(1023, Math.max(0, Math.round(fakeTextWidth(String.fromCodePoint(codePoint), font) * unitsPerPixel))),
}

// The first seven families are text-editing's, with the same seeds and generators.
const words = 'the quick brown fox jumps over a lazy dog while seven wizards quietly hex every jolly gnome pack my box with five dozen liquor jugs sphinx of black quartz judge vow'.split(' ')
const longWords = ['antidisestablishmentarianism', 'pneumonoultramicroscopic', 'supercalifragilistic']
const ideographs = '中文字体排版测试日本語の文章한국어'
const noBreakSpace = '\u00A0'
const narrowNoBreakSpace = '\u202F'

function pickWord(random: () => number) {
  return random() < 0.06 ? longWords[Math.floor(random() * longWords.length)]! : words[Math.floor(random() * words.length)]!
}

function pickFrom<T>(random: () => number, choices: readonly T[]) {
  return choices[Math.floor(random() * choices.length)]!
}

function integerBelow(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

type Family = {name: string, seed: number, texts: number, makeText: (random: () => number) => string}

const hanzi = [...'中文字体排版测试日本語の文章我们今天去学校天气很好读书写作']
const numberTokens: ((random: () => number) => string)[] = [
  random => `$${integerBelow(random, 1000)}`,
  random => `${integerBelow(random, 100)}%`,
  random => `${integerBelow(random, 24)}:${String(integerBelow(random, 60)).padStart(2, '0')}`,
  random => `${integerBelow(random, 1000)}.${integerBelow(random, 100)}`,
  random => `${2000 + integerBelow(random, 30)}年${1 + integerBelow(random, 12)}月${1 + integerBelow(random, 28)}日`,
  random => `${1 + integerBelow(random, 999)},${String(integerBelow(random, 1000)).padStart(3, '0')}`,
  random => `-${integerBelow(random, 10)}`,
  random => `${integerBelow(random, 50)}-${50 + integerBelow(random, 50)}`,
  random => `No.${integerBelow(random, 20)}`,
  random => `${integerBelow(random, 500)}km`,
  random => `¥${integerBelow(random, 9000)}`,
  random => `${integerBelow(random, 9000)}円`,
]
const punctuatedTokens = ['well-known', 'and/or', '(see below)', '[1]', '"quoted"', "it's", '“curly”', '‘single’', 'wait…what', 'yes—no', 'really?!', 'hello,world', 'e.g.', 'U.S.A.', '3rd', '#tag', '@user', 'a+b=c', '50/50', 'semi;colon', 'key:value', 'end.', 'what?', 'ok!', 'x-ray', '(a)(b)', 'don’t']
const kanaWords = ['ラーメン', 'キャッシュ', 'コーヒー', 'ショッピング', 'パーティー', 'ちょっと', 'きょう', 'がっこう', 'ひとびと', 'ときどき', 'ゆっくり', 'ニュース', 'データ']
const hangulWords = ['안녕하세요', '세계', '한국어', '텍스트', '입니다', '그리고', '우리는', '오늘', '날씨가', '좋아요']

export const families: Family[] = [
  {
    name: 'words, commas, spaces, double spaces and newlines',
    seed: 2024,
    texts: 300,
    makeText: random => {
      const parts: string[] = []
      const count = 5 + Math.floor(random() * 40)
      for (let index = 0; index < count; index++) {
        let word = pickWord(random)
        if (random() < 0.1) word += ','
        parts.push(word)
        const separatorRoll = random()
        parts.push(separatorRoll < 0.07 ? '\n' : separatorRoll < 0.12 ? '  ' : separatorRoll < 0.14 ? '\n\n' : ' ')
      }
      if (random() < 0.5) parts.pop()
      return parts.join('')
    },
  },
  {
    name: 'leading spaces after newlines',
    seed: 1,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 5 + Math.floor(random() * 20); index < count; index++) {
        parts.push(pickWord(random))
        parts.push(random() < 0.3 ? '\n' + ' '.repeat(1 + Math.floor(random() * 6)) : ' ')
      }
      return parts.join('')
    },
  },
  {
    name: 'long space runs',
    seed: 2,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 3 + Math.floor(random() * 12); index < count; index++) {
        parts.push(pickWord(random))
        parts.push(' '.repeat(1 + Math.floor(random() * 60)))
      }
      return parts.join('')
    },
  },
  {
    name: 'lines holding only spaces',
    seed: 3,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 3 + Math.floor(random() * 10); index < count; index++) {
        parts.push(pickWord(random))
        parts.push(random() < 0.4 ? '\n' + ' '.repeat(1 + Math.floor(random() * 80)) + '\n' : ' ')
      }
      return parts.join('')
    },
  },
  {
    name: 'text starting with spaces',
    seed: 4,
    texts: 60,
    makeText: random => ' '.repeat(1 + Math.floor(random() * 30)) + Array.from({length: 3 + Math.floor(random() * 10)}, () => pickWord(random)).join(' '),
  },
  {
    name: 'no-break spaces (U+00A0, U+202F) between words, mixed with spaces',
    seed: 5,
    texts: 60,
    makeText: random => {
      const separators = [' ', ' ', ' ', noBreakSpace, noBreakSpace, narrowNoBreakSpace, ' ' + noBreakSpace, noBreakSpace + ' ', noBreakSpace + noBreakSpace]
      const parts: string[] = []
      for (let index = 0, count = 5 + Math.floor(random() * 25); index < count; index++) {
        parts.push(pickWord(random))
        parts.push(pickFrom(random, separators))
      }
      if (random() < 0.5) parts.pop()
      return parts.join('')
    },
  },
  {
    name: 'CJK ideographs, kana and Hangul next to Latin words',
    seed: 6,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 4 + Math.floor(random() * 10); index < count; index++) {
        parts.push(random() < 0.5 ? Array.from({length: 2 + Math.floor(random() * 10)}, () => pickFrom(random, [...ideographs])).join('') : pickWord(random))
        if (random() < 0.4) parts.push(' ')
      }
      return parts.join('')
    },
  },
  {
    name: 'Chinese and Japanese sentences with CJK punctuation',
    seed: 7,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 3 + integerBelow(random, 8); index < count; index++) {
        const bracket = random() < 0.2 ? integerBelow(random, 4) : -1
        if (bracket >= 0) parts.push('「『（【'[bracket]!)
        parts.push(Array.from({length: 1 + integerBelow(random, 8)}, () => pickFrom(random, hanzi)).join(''))
        if (bracket >= 0) parts.push('」』）】'[bracket]!)
        parts.push(pickFrom(random, ['、', '。', '，', '！', '？', '・', '', '', '']))
        if (random() < 0.08) parts.push('\n')
      }
      return parts.join('')
    },
  },
  {
    name: 'CJK next to Latin words and punctuation, with and without spaces',
    seed: 8,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 4 + integerBelow(random, 10); index < count; index++) {
        if (random() < 0.5) {
          parts.push(Array.from({length: 1 + integerBelow(random, 6)}, () => pickFrom(random, hanzi)).join(''))
          if (random() < 0.3) parts.push(pickFrom(random, ['、', '。', '，']))
        } else {
          parts.push(pickWord(random))
          if (random() < 0.2) parts.push(pickFrom(random, [',', '.', '!', '?']))
        }
        if (random() < 0.5) parts.push(' ')
      }
      return parts.join('')
    },
  },
  {
    name: 'numbers: prices, percents, times, decimals, dates, signs and ranges',
    seed: 9,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 4 + integerBelow(random, 12); index < count; index++) {
        parts.push(random() < 0.5 ? pickFrom(random, numberTokens)(random) : random() < 0.7 ? pickWord(random) : Array.from({length: 1 + integerBelow(random, 3)}, () => pickFrom(random, hanzi)).join(''))
        parts.push(random() < 0.8 ? ' ' : '')
      }
      return parts.join('')
    },
  },
  {
    name: 'Latin punctuation without spaces: hyphens, slashes, brackets, quotes, apostrophes, ellipses, dashes',
    seed: 10,
    texts: 60,
    makeText: random => Array.from({length: 4 + integerBelow(random, 12)}, () => random() < 0.6 ? pickFrom(random, punctuatedTokens) : pickWord(random)).join(' '),
  },
  {
    name: 'Japanese kana with small kana, prolonged sound marks and iteration marks',
    seed: 11,
    texts: 60,
    makeText: random => {
      const parts: string[] = []
      for (let index = 0, count = 3 + integerBelow(random, 10); index < count; index++) {
        parts.push(pickFrom(random, kanaWords))
        if (random() < 0.15) parts.push('々')
        parts.push(pickFrom(random, ['', '', '、', '。', '・', 'ー', ' ']))
      }
      return parts.join('')
    },
  },
  {
    name: 'Korean words with spaces and punctuation',
    seed: 12,
    texts: 60,
    makeText: random => Array.from({length: 3 + integerBelow(random, 12)}, () => pickFrom(random, hangulWords) + pickFrom(random, ['', '', ',', '.', '!', '?'])).join(' '),
  },
]

export const widthsInQuarterPixels: number[] = []
for (let quarterPixels = 120; quarterPixels <= 1600; quarterPixels += 37) widthsInQuarterPixels.push(quarterPixels)

function graphemeCount(text: string) {
  return Array.from(graphemeSegmenter.segment(text)).length
}

function codePointCount(text: string) {
  return Array.from(text).length
}

// A pretext cursor as an offset, counting either graphemes or code points.
function pretextStarts(prepared: Prepared, lines: readonly Line[], unit: 'grapheme' | 'code point'): number[] {
  const segmentOffsets: number[] = []
  let offset = 0
  for (const segment of prepared.segments) {
    segmentOffsets.push(offset)
    offset += unit === 'grapheme' ? graphemeCount(segment) : codePointCount(segment)
  }
  const starts = lines.map(line => {
    const segment = prepared.segments[line.start.segmentIndex] ?? ''
    const inside = Array.from(graphemeSegmenter.segment(segment)).slice(0, line.start.graphemeIndex).map(part => part.segment).join('')
    return segmentOffsets[line.start.segmentIndex]! + (unit === 'grapheme' ? line.start.graphemeIndex : codePointCount(inside))
  })
  if (starts.length === 0) starts.push(0)
  return starts
}

// The editor keeps an empty last line after a trailing newline, so the caret has a place to sit.
// pretext's layoutWithLines doesn't report that line.
function dropTrailingNewlineLine(text: string, starts: number[], length: number) {
  if (text.endsWith('\n') && starts.length > 1 && starts.at(-1) === length) {
    starts.pop()
    return 1
  }
  return 0
}

export type MismatchCause = {layouts: number, example: string}

export type FamilyResult = {
  name: string
  texts: number
  layouts: number
  trailingNewlineLines: number
  before: number
  after: number
  afterWhole: number
  examples: string[]
  // Only filled when runAgreement attributes causes: mismatches with CJK runs kept whole by cause (see
  // pretextChanges), and layouts that matched pretext but mismatch after one of the changes.
  causes: Map<string, MismatchCause>
  matchesBrokenByChanges: number
}

type PretextChange = {cause: string, experiment: PretextExperiment}

// Three changes to the JS walker for one text, each making it do what pretext does in one case where
// the editor differs. The circuit implements none of them. A mismatch counts under the change that
// fixes it by itself.
function pretextChanges(prepared: Prepared, codePoints: readonly number[]): {alone: PretextChange[], together: PretextExperiment} {
  const opportunities = pretextOpportunities(prepared)
  const classes = [...codePoints.map(classOfCodePoint), LB.empty]
  const followPretextAt = (pairs: readonly string[]) => (cell: number, pairTableBreaks: boolean) =>
    pairs.includes(`${classNames[classes[cell]!]} ÷ ${classNames[classes[cell + 1]!]}`) ? opportunities.has(cell + 1) : pairTableBreaks
  // What comes before the hyphens where pretext breaks at HY ÷ NU and the pair table doesn't.
  const hyphenContexts = new Set<string>()
  for (let cell = 1; cell + 1 < codePoints.length; cell++) {
    if (classes[cell] !== LB.HY || classes[cell + 1] !== LB.NU || !opportunities.has(cell + 1)) continue
    const before = classes[cell - 1]!
    hyphenContexts.add(before === LB.NU ? 'between digits, e.g. 0-|93' : before === LB.AL || before === LB.HL ? 'after a word, e.g. pneumonoultramicroscopic-|7471' : `after ${classNames[before]}`)
  }
  return {
    alone: [
      {cause: `HY ÷ NU: pretext breaks after a hyphen ${[...hyphenContexts].sort().join(', and ')}`, experiment: {breaksAfter: followPretextAt(['HY ÷ NU'])}},
      {cause: 'EX ÷ AL: pretext doesn\'t break after ! before an ASCII letter, e.g. wizards!|black', experiment: {breaksAfter: followPretextAt(['EX ÷ AL'])}},
      {cause: 'pretext starts the next line at the space after an overflowing CJK unit, e.g. 试、| ', experiment: {spaceAfterWholeRunStartsLine: true}},
    ],
    together: {breaksAfter: followPretextAt(['HY ÷ NU', 'EX ÷ AL']), spaceAfterWholeRunStartsLine: true},
  }
}

// With attributeCauses, also attributes each mismatch with CJK runs kept whole to a cause.
export function runAgreement(attributeCauses = false): FamilyResult[] {
  const results: FamilyResult[] = []
  for (const family of families) {
    const random = createRandom(family.seed)
    const result: FamilyResult = {name: family.name, texts: family.texts, layouts: 0, trailingNewlineLines: 0, before: 0, after: 0, afterWhole: 0, examples: [], causes: new Map(), matchesBrokenByChanges: 0}
    for (let trial = 0; trial < family.texts; trial++) {
      const text = family.makeText(random)
      const prepared = pretext.prepareWithSegments(text, font, {whiteSpace: 'pre-wrap'}) as Prepared
      // Before: text-editing's grapheme table, whose only break opportunities are spaces and newlines.
      const table = createWidthTable(512, unitsPerPixel, grapheme => fakeTextWidth(grapheme, font))
      const codes = encodeText(table, text)
      const baselineState: BaselineState = {cells: codes.map(code => table.packed[code]!), length: codes.length, caret: 0, anchor: 0, preferredX: 0, hasPreferredX: 0}
      // After: one code point per cell.
      const codePoints = codePointsOf(text)
      const state: EditorState = {cells: codePoints, length: codePoints.length, caret: 0, anchor: 0, preferredX: 0, hasPreferredX: 0}
      const changes = attributeCauses ? pretextChanges(prepared, codePoints) : null
      for (const quarterPixels of widthsInQuarterPixels) {
        const lines = (pretext.layoutWithLines(prepared, quarterPixels / unitsPerPixel, 20) as {lines: Line[]}).lines
        result.layouts++
        const beforeStarts = baselineLayout(baselineState, quarterPixels).starts
        dropTrailingNewlineLine(text, beforeStarts, codes.length)
        if (JSON.stringify(beforeStarts) !== JSON.stringify(pretextStarts(prepared, lines, 'grapheme'))) result.before++
        const expected = pretextStarts(prepared, lines, 'code point')
        const afterStarts = referenceLayout(state, characterModel, quarterPixels, 'anywhere').starts
        result.trailingNewlineLines += dropTrailingNewlineLine(text, afterStarts, codePoints.length)
        if (JSON.stringify(afterStarts) !== JSON.stringify(expected)) result.after++
        const wholeStarts = referenceLayout(state, characterModel, quarterPixels, 'cjk whole').starts
        dropTrailingNewlineLine(text, wholeStarts, codePoints.length)
        const wholeMatches = JSON.stringify(wholeStarts) === JSON.stringify(expected)
        if (!wholeMatches) {
          result.afterWhole++
          if (result.examples.length < 2) result.examples.push(`${JSON.stringify(text)} at ${quarterPixels / unitsPerPixel}px: pretext ${JSON.stringify(expected)}, editor ${JSON.stringify(wholeStarts)}`)
        }
        if (changes === null) continue
        const matchesWith = (experiment: PretextExperiment) => {
          const starts = referenceLayout(state, characterModel, quarterPixels, 'cjk whole', experiment).starts
          dropTrailingNewlineLine(text, starts, codePoints.length)
          return JSON.stringify(starts) === JSON.stringify(expected)
        }
        if (wholeMatches) {
          if (changes.alone.some(change => !matchesWith(change.experiment)) || !matchesWith(changes.together)) result.matchesBrokenByChanges++
          continue
        }
        const fixing = changes.alone.filter(change => matchesWith(change.experiment))
        const cause = fixing.length === 1 ? fixing[0]!.cause
          : fixing.length > 1 ? `each of these changes fixes it: ${fixing.map(change => change.cause).join('; ')}`
          : matchesWith(changes.together) ? 'more than one cause in the same layout: only all three changes together fix it'
          : 'unexplained: no change fixes it'
        // A snippet around the first line start that differs.
        let line = 0
        while (line < Math.max(wholeStarts.length, expected.length) && wholeStarts[line] === expected[line]) line++
        const differsAt = Math.min(expected[line] ?? codePoints.length, wholeStarts[line] ?? codePoints.length)
        const snippet = Array.from(text).slice(Math.max(0, differsAt - 12), differsAt + 6).join('')
        const entry = result.causes.get(cause) ?? {layouts: 0, example: `${JSON.stringify(snippet)} at ${quarterPixels / unitsPerPixel}px`}
        entry.layouts++
        result.causes.set(cause, entry)
      }
    }
    results.push(result)
  }
  return results
}

// Break opportunities pretext's analysis puts between neighboring code points: a boundary between
// two segments, unless the second one is a space, tab, newline, zero width space or soft hyphen (the
// line breaks after those instead), or the first one is a newline.
function pretextOpportunities(prepared: Prepared): Set<number> {
  const opportunities = new Set<number>()
  let offset = 0
  prepared.segments.forEach((segment, index) => {
    const kind = prepared.kinds[index]!
    const previousKind = index > 0 ? prepared.kinds[index - 1]! : null
    if (index > 0 && previousKind !== 'hard-break' && !['space', 'preserved-space', 'tab', 'hard-break', 'zero-width-break', 'soft-hyphen'].includes(kind)) opportunities.add(offset)
    offset += codePointCount(segment)
  })
  return opportunities
}

export type CensusRow = {pair: string, rule: string, pretextBreaksOnly: number, pairTableBreaksOnly: number, agree: number, example: string}

// Compares, boundary by boundary, where pretext's segments allow a break and where the pair table
// does, and groups the boundaries by the pair of classes around them.
export function runCensus(): {rows: CensusRow[], boundaries: number, disagreements: number} {
  const rows = new Map<string, CensusRow>()
  let boundaries = 0
  let disagreements = 0
  for (const family of families) {
    const random = createRandom(family.seed)
    for (let trial = 0; trial < family.texts; trial++) {
      const text = family.makeText(random)
      const prepared = pretext.prepareWithSegments(text, font, {whiteSpace: 'pre-wrap'}) as Prepared
      const opportunities = pretextOpportunities(prepared)
      const codePoints = codePointsOf(text)
      const classes = codePoints.map(classOfCodePoint)
      for (let boundary = 1; boundary < codePoints.length; boundary++) {
        const before = classes[boundary - 1]!
        const after = classes[boundary]!
        if (after === LB.SP || after === LB.LF || after === LB.ZW || after === LB.SHY || before === LB.LF) continue
        boundaries++
        const pretextBreaks = opportunities.has(boundary)
        const tableBreaks = breaksBetween(before, after)
        const key = `${classNames[before]} ÷ ${classNames[after]}`
        const row = rows.get(key) ?? {pair: key, rule: pairRuleFor(before, after).name, pretextBreaksOnly: 0, pairTableBreaksOnly: 0, agree: 0, example: ''}
        if (pretextBreaks === tableBreaks) {
          row.agree++
        } else {
          disagreements++
          if (pretextBreaks) row.pretextBreaksOnly++
          else row.pairTableBreaksOnly++
          if (row.example === '') row.example = JSON.stringify(Array.from(text).slice(Math.max(0, boundary - 6), boundary).join('') + '|' + Array.from(text).slice(boundary, boundary + 6).join(''))
        }
        rows.set(key, row)
      }
    }
  }
  return {rows: [...rows.values()].sort((left, right) => (right.pretextBreaksOnly + right.pairTableBreaksOnly) - (left.pretextBreaksOnly + left.pairTableBreaksOnly)), boundaries, disagreements}
}

if (import.meta.main) {
  const format = (value: number) => value.toLocaleString('en-US')
  console.log(`Line starts against pretext layoutWithLines in pre-wrap mode, ${widthsInQuarterPixels.length} widths per text from 30px to 400px.\n`)
  console.log('| text family | texts | layouts | line start mismatches before (grapheme codes, breaks at spaces and newlines) | after (code points, pair table, runs break anywhere) | after, CJK runs kept whole | empty last lines after a trailing newline, dropped before comparing |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  const withCensus = process.argv.includes('census')
  const results = runAgreement(withCensus)
  for (const result of results) {
    console.log(`| ${result.name} | ${result.texts} | ${format(result.layouts)} | ${format(result.before)} | ${format(result.after)} | ${format(result.afterWhole)} | ${format(result.trailingNewlineLines)} |`)
  }
  const total = (field: 'layouts' | 'before' | 'after' | 'afterWhole') => format(results.reduce((sum, result) => sum + result[field], 0))
  console.log(`| all families | ${format(results.reduce((sum, result) => sum + result.texts, 0))} | ${total('layouts')} | ${total('before')} | ${total('after')} | ${total('afterWhole')} | |`)
  const examples = results.flatMap(result => result.examples.map(example => `- ${result.name}: ${example}`))
  if (examples.length > 0) console.log(`\nFirst mismatches with CJK runs kept whole, per family:\n${examples.join('\n')}`)
  if (withCensus) {
    const escapeBars = (text: string) => text.replaceAll('|', '\\|')
    console.log('\nWhere the mismatches with CJK runs kept whole come from. Each change makes the JS walker do what pretext does in one case, and a mismatch counts under the change that fixes it by itself. The circuit implements none of these changes.\n')
    console.log('| text family | cause | layouts | first example |')
    console.log('| --- | --- | ---: | --- |')
    for (const result of results) {
      for (const [cause, entry] of result.causes) console.log(`| ${result.name} | ${escapeBars(cause)} | ${format(entry.layouts)} | ${escapeBars(entry.example)} |`)
    }
    console.log(`\nLayouts that matched pretext and mismatch after at least one of the changes: ${format(results.reduce((sum, result) => sum + result.matchesBrokenByChanges, 0))}.`)
    const census = runCensus()
    console.log(`\nBoundaries between two code points, excluding boundaries before spaces, newlines, zero width spaces and soft hyphens and after newlines: ${format(census.boundaries)}. The pair table and pretext's segments disagree on ${format(census.disagreements)}.\n`)
    console.log('| classes around the boundary | pretext breaks, pair table doesn\'t | pair table breaks, pretext doesn\'t | agree | deciding pair rule | first example (the boundary is at the bar) |')
    console.log('| --- | ---: | ---: | ---: | --- | --- |')
    for (const row of census.rows.filter(row => row.pretextBreaksOnly + row.pairTableBreaksOnly > 0)) {
      console.log(`| ${row.pair} | ${format(row.pretextBreaksOnly)} | ${format(row.pairTableBreaksOnly)} | ${format(row.agree)} | ${row.rule} | ${row.example} |`)
    }
  }
}
