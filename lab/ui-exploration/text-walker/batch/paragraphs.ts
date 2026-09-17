// Generated paragraphs for the batch line breaking programs, measured by npm @chenglou/pretext with a deterministic fake
// canvas and turned into the walker's cells: one width and one break-after bit per segment.
//
// The text is word soup with some hyphenated words, e.g. "state-of-the-art", which pretext splits into text segments
// that a line can break between, and some zero-width spaces, e.g. " ​​" gives a run of 3 break-after segments.
// Every paragraph is on pretext's fast path (text, spaces and zero-width spaces, no letter spacing).
import {type PreparedTextWithSegments, layout, prepareWithSegments} from '@chenglou/pretext'
import {longestBreakAfterRun} from '../../../../src/indirectos/notes-walker.ts'
import {invariant} from '../../../../src/runtime/numeric-ui-core.ts'
import {fakeTextWidth} from '../fake-canvas.ts'
import {type FastParagraph, fastWindow, maximumSegmentWidth} from '../fast-walker.ts'

// At 16 px the fake canvas measures every character in multiples of 1/4 px, so widths and prefix sums are exact in FP32.
export const batchFont = '16px Test Sans'
export const lineHeight = 20
// pretext's line fit epsilon is 1/64 px on Safari and 0.005 px on every other engine. Bun's navigator isn't Safari's.
// The tested widths are on a 1/8 px grid, so a span minus a width is a multiple of 1/8 px, and the two epsilons can't
// give different lines even if another module set a Safari user agent first.
export const lineFitEpsilon = 0.005

// pretext creates its measuring context at its first measurement, so this runs before the first prepare call. Under
// `bun test`, modules are shared between test files, e.g. tests/indirectos/notes.test.ts sets its own fake canvas with
// the same rule for letters, spaces and punctuation. Either way, the circuit and the reference read the same prepared
// widths, and prepareBatchParagraph checks that they are on the 1/64 px grid.
export function installBatchCanvas() {
  if (Reflect.get(globalThis, 'OffscreenCanvas') !== undefined) return
  class FakeContext {
    font = ''
    measureText(text: string) {
      return {width: fakeTextWidth(text, this.font)}
    }
  }
  Reflect.set(globalThis, 'OffscreenCanvas', class {
    getContext() {
      return new FakeContext()
    }
  })
}

const words = (
  'the quick brown fox jumps over a lazy dog while seven wizards quietly hex every jolly gnome ' +
  'pack my box with five dozen liquor jugs sphinx of black quartz judge my vow how vexingly ' +
  'quick daft zebras jump bright vixens jump dozy fowl quack'
).split(' ')
const hyphenatedWords = ['well-known', 'state-of-the-art', 'long-term', 'twenty-five', 'self-aware', 'jack-in-the-box']

export type ParagraphSize = 'short' | 'long'

export const wordCounts: Record<ParagraphSize, {minimum: number, maximum: number}> = {
  short: {minimum: 14, maximum: 26},
  long: {minimum: 170, maximum: 230},
}

export function batchText(size: ParagraphSize, seed: number): string {
  let state = Math.imul(seed + 1, 2654435761) >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const {minimum, maximum} = wordCounts[size]
  const count = minimum + Math.floor(next() * (maximum - minimum + 1))
  let text = ''
  for (let index = 0; index < count; index++) {
    let word = next() < 0.05 ? hyphenatedWords[Math.floor(next() * hyphenatedWords.length)]! : words[Math.floor(next() * words.length)]!
    const punctuation = next()
    if (punctuation < 0.08) word += ','
    else if (punctuation < 0.13) word += '.'
    if (index > 0) {
      const separator = next()
      text += separator < 0.02 ? ' ​' : separator < 0.03 ? ' ​​' : separator < 0.05 ? '​' : ' '
    }
    text += word
  }
  return text
}

export type BatchParagraph = {
  text: string
  prepared: PreparedTextWithSegments
  paragraph: FastParagraph
}

export function prepareBatchParagraph(text: string): BatchParagraph {
  installBatchCanvas()
  const prepared = prepareWithSegments(text, batchFont)
  invariant(prepared.simpleLineWalkFastPath && prepared.letterSpacing === 0, 'a batch paragraph must be on pretext\'s fast path')
  const breakAfter = prepared.kinds.map(kind => kind === 'space' || kind === 'zero-width-break' ? 1 : 0)
  invariant(breakAfter[0] === 0 && breakAfter[breakAfter.length - 1] === 0, 'a batch paragraph must start and end with text')
  const widths = [...prepared.widths]
  invariant(widths.every(width => width >= 0 && width <= maximumSegmentWidth && Math.round(width * 64) / 64 === width), 'segment widths must be on the 1/64 px grid')
  return {text, prepared, paragraph: {widths, breakAfter}}
}

export function batchParagraphs(size: ParagraphSize, count: number, firstSeed = 0): BatchParagraph[] {
  return Array.from({length: count}, (_, index) => prepareBatchParagraph(batchText(size, firstSeed + index)))
}

// The seeds that batchCapacities covers, 0 to 65,535.
export const capacitySeedCount = 65_536

// The paragraphs of the timings and of the GPU page: paragraph i has seed i mod 65,536, so every paragraph fits
// batchCapacities at any count. E.g. 100,000 paragraphs are seeds 0 to 65,535, then seeds 0 to 34,463 again. Up to 65,536
// paragraphs, this is batchParagraphs. Seeds past 65,535 aren't covered: 1 of the long paragraphs with seeds 65,536 to
// 99,999 needs 85 line slots.
export function timingParagraphs(size: ParagraphSize, count: number, firstIndex = 0): BatchParagraph[] {
  return Array.from({length: count}, (_, index) => prepareBatchParagraph(batchText(size, (firstIndex + index) % capacitySeedCount)))
}

// pretext's layout(): the line count the programs must reproduce.
export function expectedLineCount(paragraph: BatchParagraph, maxWidth: number): number {
  return layout(paragraph.prepared, maxWidth, lineHeight).lineCount
}

// What a program has to hold for every paragraph of a set at every width in minimumWidth..maximumWidth:
// - segments: the most segments of any paragraph
// - lineSlots: the most lines at the narrowest width
// - window: the segments compared after a line start, from fastWindow at the widest width
// - runLimit: the longest run of break-after segments
// Every width must also be at least the widest segment, since the fast walker has no breaks inside a segment.
export type BatchCapacity = {
  size: ParagraphSize
  segments: number
  lineSlots: number
  window: number
  runLimit: number
  minimumWidth: number
  maximumWidth: number
  epsilon: number
}

// The capacities of the timed and exported programs, for widths from 160 to 480 px. Each value is the largest need over
// the first 65,536 paragraphs of each size (seeds 0 to 65,535), see the README.
export const batchCapacities: Record<ParagraphSize, BatchCapacity> = {
  short: {size: 'short', segments: 68, lineSlots: 12, window: 38, runLimit: 3, minimumWidth: 160, maximumWidth: 480, epsilon: lineFitEpsilon},
  long: {size: 'long', segments: 517, lineSlots: 83, window: 39, runLimit: 3, minimumWidth: 160, maximumWidth: 480, epsilon: lineFitEpsilon},
}

export function paragraphNeeds(paragraph: BatchParagraph, minimumWidth: number, maximumWidth: number) {
  return {
    segments: paragraph.paragraph.widths.length,
    lineSlots: expectedLineCount(paragraph, minimumWidth),
    window: fastWindow(paragraph.paragraph, maximumWidth, lineFitEpsilon),
    runLimit: longestBreakAfterRun(paragraph.paragraph.breakAfter),
    widestSegment: Math.max(...paragraph.paragraph.widths),
  }
}

export function assertFits(capacity: BatchCapacity, paragraph: BatchParagraph) {
  const needs = paragraphNeeds(paragraph, capacity.minimumWidth, capacity.maximumWidth)
  invariant(
    needs.segments <= capacity.segments && needs.lineSlots <= capacity.lineSlots && needs.window <= capacity.window
      && needs.runLimit <= capacity.runLimit && needs.widestSegment <= capacity.minimumWidth,
    `a ${capacity.size} paragraph needs ${JSON.stringify(needs)}, more than the capacity ${JSON.stringify(capacity)}`,
  )
}
