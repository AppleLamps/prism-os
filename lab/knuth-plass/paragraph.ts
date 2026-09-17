// A paragraph as break points, the line cost that both the reference and the programs compute, and paragraphs for tests
// and timings.
//
// Break point 0 is the start of the paragraph and break point n is its end. A line from break point `from` to break point
// `to` holds the boxes from + 1 to `to`, e.g. words or the parts of a word between soft hyphens. Positions are whole
// pixels:
// - lineStarts[from], for from = 0..n - 1: where a line that starts after break point `from` begins, i.e. after the
//   space that follows a space break
// - lineEnds[to - 1], for to = 1..n: where a line that ends at break point `to` ends, i.e. before the space of a space
//   break, and after the hyphen that a soft hyphen break draws
// So a line's natural width is lineEnds[to - 1] - lineStarts[from].
import type {PreparedTextWithSegments} from '@chenglou/pretext'
import {invariant} from '../../src/runtime/numeric-ui-core.ts'

export type Paragraph = {
  lineStarts: readonly number[]
  lineEnds: readonly number[]
}

// The line cost, in whole pixels: min(slack, 63)² for a line that fits, where slack = maxWidth - naturalWidth, and 0 for
// the paragraph's last line when it fits. A line that doesn't fit costs `infeasible`, except a line of one box, which
// costs lineCostCap, so that a box wider than the column still gets a line of its own and every paragraph has a
// solution. pretext's demo scores justified lines by (maxWidth - wordWidth) / spaceCount, a division by a runtime count,
// so this variant uses squared slack instead, which is the demo's cost of a ragged line divided by 10.
export const slackLimit = 63
export const lineCostCap = slackLimit * slackLimit
// Every total along a path is at most breakCapacity × lineCostCap, which stays below `infeasible`, so a path with a line
// that doesn't fit never ties with one that fits. Sums of two costs stay within 2^23 and every comparison of two such
// sums within 2^24, where FP32 holds every integer.
export const infeasible = 2 ** 22
export const largestBreakCapacity = Math.floor((infeasible - 1) / lineCostCap)
export const maxWidthLimit = 4096
// Positions are within 0..positionLimit. Past the end of a paragraph, the programs' cells hold lineStarts 0 and lineEnds
// positionLimit, so every line that reaches past the end is wider than any maxWidth. That needs every position of the
// paragraph to stay below positionLimit - maxWidthLimit.
export const positionLimit = 2 ** 20

export const naturalWidth = (paragraph: Paragraph, from: number, to: number) => paragraph.lineEnds[to - 1]! - paragraph.lineStarts[from]!

export function checkParagraph(paragraph: Paragraph) {
  const {lineStarts, lineEnds} = paragraph
  const breakCount = lineEnds.length
  invariant(breakCount >= 1 && lineStarts.length === breakCount, 'a paragraph needs as many line starts as line ends, and at least one')
  for (let index = 0; index < breakCount; index++) {
    const start = lineStarts[index]!
    const end = lineEnds[index]!
    invariant(Number.isInteger(start) && Number.isInteger(end), 'positions must be whole pixels')
    invariant(start >= 0 && start <= end && end < positionLimit - maxWidthLimit, `break point ${index + 1}: need 0 <= lineStart <= lineEnd < ${positionLimit - maxWidthLimit}, got ${start} and ${end}`)
    if (index > 0) invariant(start >= lineStarts[index - 1]! && end >= lineEnds[index - 1]!, 'positions must not decrease')
  }
}

// A deterministic generator of numbers within 0..1.
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

export type BoxOptions = {minimumBox: number, maximumBox: number, space: number, hyphen: number, hyphenChance: number}
export const defaultBoxes: BoxOptions = {minimumBox: 20, maximumBox: 90, space: 5, hyphen: 6, hyphenChance: 0.15}

// Boxes of random whole-pixel widths. A break is a soft hyphen with probability hyphenChance, and a space otherwise.
export function randomParagraph(random: () => number, breakCount: number, options: BoxOptions = defaultBoxes): Paragraph {
  const lineStarts: number[] = []
  const lineEnds: number[] = []
  let x = 0
  for (let to = 1; to <= breakCount; to++) {
    lineStarts.push(x)
    x += options.minimumBox + Math.floor(random() * (options.maximumBox - options.minimumBox + 1))
    const hyphen = to < breakCount && random() < options.hyphenChance
    lineEnds.push(x + (hyphen ? options.hyphen : 0))
    if (!hyphen) x += options.space
  }
  return {lineStarts, lineEnds}
}

// The paragraphs of the timings and of the export: boxes of 34 to 96 px at 300 px, so no line holds more than 8 boxes.
export const timingWidth = 300
export const timingBoxes: BoxOptions = {minimumBox: 34, maximumBox: 96, space: 5, hyphen: 6, hyphenChance: 0.1}
export const timingParagraph = (breakCount: number, seed = breakCount) => randomParagraph(createRandom(seed), breakCount, timingBoxes)

export const softHyphen = '­'
const isSpaceText = (text: string) => text.trim().length === 0

export type BreakKind = 'start' | 'space' | 'soft-hyphen' | 'end'
export type BreakCandidate = {segmentIndex: number, kind: BreakKind}

// Break points from pretext's segments, like buildBreakCandidates in pretext's justification demo: after every space
// and every soft hyphen, except at the end, plus the start and the end. A space counts spaceWidth, as the demo counts
// normalSpaceWidth, and a line that ends at a soft hyphen adds hyphenWidth. The demo's positions are float64 pixels,
// and these round them to whole pixels, so a line's natural width can differ from the demo's by less than 1 px.
export function breakPointsOfPrepared(prepared: PreparedTextWithSegments, spaceWidth: number, hyphenWidth: number) {
  const {segments, widths} = prepared
  const candidates: BreakCandidate[] = [{segmentIndex: 0, kind: 'start'}]
  // The float64 x position of each candidate, where the demo's naturalWidth is x[to] - x[from], minus a trailing space,
  // plus a trailing hyphen.
  const positions = [0]
  let x = 0
  segments.forEach((text, index) => {
    if (text === softHyphen) {
      if (index + 1 < segments.length) {
        candidates.push({segmentIndex: index + 1, kind: 'soft-hyphen'})
        positions.push(x)
      }
    } else if (isSpaceText(text)) {
      x += spaceWidth
      if (index + 1 < segments.length) {
        candidates.push({segmentIndex: index + 1, kind: 'space'})
        positions.push(x)
      }
    } else {
      x += widths[index]!
    }
  })
  candidates.push({segmentIndex: segments.length, kind: 'end'})
  positions.push(x)
  const breakCount = candidates.length - 1
  const lineStarts = positions.slice(0, breakCount).map(position => Math.round(position))
  const lineEnds = candidates.slice(1).map(({kind}, index) => {
    const end = positions[index + 1]! - (kind === 'space' ? spaceWidth : 0) + (kind === 'soft-hyphen' ? hyphenWidth : 0)
    return Math.round(end)
  })
  const paragraph = {lineStarts, lineEnds}
  checkParagraph(paragraph)
  return {paragraph, candidates, positions}
}
