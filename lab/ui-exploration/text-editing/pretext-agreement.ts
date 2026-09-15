// Checks that the editor's wrapping rules agree with pretext's pre-wrap line walker on the same
// text and widths. The fake canvas gives every character a whole number of quarter pixels, so
// both sides see identical widths. Run from the repo root:
//   bun lab/ui-exploration/text-editing/pretext-agreement.ts
// It imports the phase 1 copy of pretext's source (never ~/github/pretext).
//
// The editor only opens a break opportunity after a space, a tab or a newline. The last text
// family, CJK ideographs next to Latin words, shows that gap: pretext breaks between ideographs and
// the editor doesn't, so most of those layouts are expected to disagree.

import {fakeTextWidth, installFakeCanvas} from './fake-canvas.ts'
import {type EditorState, referenceLayout} from './reference.ts'
import {createRandom} from './test-support.ts'
import {createWidthTable, encodeText} from './width-table.ts'

installFakeCanvas('blink')
const pretextPath = 'scratchpad/phase1/pretext/pretext-src/layout.ts'
const pretext = await import(pretextPath)

type Cursor = {segmentIndex: number, graphemeIndex: number}
type Line = {start: Cursor}

const font = '16px Test Sans'
const unitsPerPixel = 4
const words = 'the quick brown fox jumps over a lazy dog while seven wizards quietly hex every jolly gnome pack my box with five dozen liquor jugs sphinx of black quartz judge vow'.split(' ')
const longWords = ['antidisestablishmentarianism', 'pneumonoultramicroscopic', 'supercalifragilistic']
const ideographs = '中文字体排版测试日本語の文章한국어'
const noBreakSpace = '\u00A0'
const narrowNoBreakSpace = '\u202F'
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'})

function pickWord(random: () => number) {
  return random() < 0.06 ? longWords[Math.floor(random() * longWords.length)]! : words[Math.floor(random() * words.length)]!
}

function pickFrom<T>(random: () => number, choices: readonly T[]) {
  return choices[Math.floor(random() * choices.length)]!
}

type Family = {name: string, seed: number, texts: number, makeText: (random: () => number) => string}

const families: Family[] = [
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
    name: 'CJK ideographs, kana and Hangul next to Latin words (not supported, expected to disagree)',
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
]

const widthsInQuarterPixels: number[] = []
for (let quarterPixels = 120; quarterPixels <= 1600; quarterPixels += 37) widthsInQuarterPixels.push(quarterPixels)

console.log(`Line starts against pretext layoutWithLines in pre-wrap mode, ${widthsInQuarterPixels.length} widths per text from 30px to 400px.\n`)
console.log('| text family | texts | layouts | editor empty last lines after a trailing newline, dropped before comparing | line start mismatches |')
console.log('| --- | ---: | ---: | ---: | ---: |')
const examples: string[] = []
for (const family of families) {
  const random = createRandom(family.seed)
  let layouts = 0
  // The editor keeps an empty last line after a trailing newline, so the caret has a place to sit.
  // pretext's layoutWithLines doesn't report that line.
  let trailingNewlineLines = 0
  let mismatches = 0
  for (let trial = 0; trial < family.texts; trial++) {
    const text = family.makeText(random)
    const table = createWidthTable(256, unitsPerPixel, grapheme => fakeTextWidth(grapheme, font))
    const codes = encodeText(table, text)
    const state: EditorState = {cells: codes.map(code => table.packed[code]!), length: codes.length, caret: 0, anchor: 0, preferredX: 0, hasPreferredX: 0}
    const prepared = pretext.prepareWithSegments(text, font, {whiteSpace: 'pre-wrap'})
    const segmentOffsets: number[] = []
    let offset = 0
    for (const segment of prepared.segments as string[]) {
      segmentOffsets.push(offset)
      offset += Array.from(segmenter.segment(segment)).length
    }
    for (const quarterPixels of widthsInQuarterPixels) {
      const result = pretext.layoutWithLines(prepared, quarterPixels / unitsPerPixel, 20) as {lines: Line[]}
      const pretextStarts = result.lines.map(line => segmentOffsets[line.start.segmentIndex]! + line.start.graphemeIndex)
      if (pretextStarts.length === 0) pretextStarts.push(0)
      const editorStarts = referenceLayout(state, quarterPixels).starts
      layouts++
      if (text.endsWith('\n') && editorStarts.length > 1 && editorStarts.at(-1) === codes.length) {
        editorStarts.pop()
        trailingNewlineLines++
      }
      if (JSON.stringify(pretextStarts) !== JSON.stringify(editorStarts)) {
        mismatches++
        if (mismatches <= 2) examples.push(`${family.name}: ${JSON.stringify(text)} at ${quarterPixels / unitsPerPixel}px: pretext ${JSON.stringify(pretextStarts)}, editor ${JSON.stringify(editorStarts)}`)
      }
    }
  }
  console.log(`| ${family.name} | ${family.texts} | ${layouts.toLocaleString('en-US')} | ${trailingNewlineLines.toLocaleString('en-US')} | ${mismatches.toLocaleString('en-US')} |`)
}
if (examples.length > 0) console.log(`\nFirst mismatches per family:\n${examples.join('\n')}`)
