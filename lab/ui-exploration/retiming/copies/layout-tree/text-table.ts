// Text heights as staircases of the text's width. A prepare step turns a text into
// its natural width, its widest word, and the widths at which its line count drops.
// The circuit then only compares the text's width against those thresholds.
import type {TextTable} from './tree.ts'

// Black-box tabulation: sample lineCountAt every `step` px from `fromWidth` to `toWidth`,
// then bisect every interval whose counts differ until it is narrower than `precision`.
// A drop by k lines records the threshold k times. Requires a count that never grows
// with width, which holds for greedy breaking over nonnegative widths.
export function tabulateLineCounts(
  lineCountAt: (width: number) => number,
  fromWidth: number,
  toWidth: number,
  step: number,
  precision = 1e-4,
): {baseLines: number, thresholds: number[]} {
  const thresholds: number[] = []
  const refine = (low: number, high: number, lowCount: number, highCount: number) => {
    if (highCount > lowCount) throw new Error(`line count grows from ${lowCount} to ${highCount} between ${low} and ${high}`)
    if (high - low < precision) {
      for (let drop = highCount; drop < lowCount; drop++) thresholds.push(high)
      return
    }
    const middle = (low + high) / 2
    const middleCount = lineCountAt(middle)
    if (middleCount !== lowCount) refine(low, middle, lowCount, middleCount)
    if (middleCount !== highCount) refine(middle, high, middleCount, highCount)
  }
  let previousWidth = fromWidth
  let previousCount = lineCountAt(fromWidth)
  for (let index = 1; fromWidth + index * step <= toWidth + step; index++) {
    const width = Math.min(toWidth, fromWidth + index * step)
    const count = lineCountAt(width)
    if (count !== previousCount) refine(previousWidth, width, previousCount, count)
    previousWidth = width
    previousCount = count
    if (width === toWidth) break
  }
  return {baseLines: lineCountAt(toWidth), thresholds}
}

// A plain greedy word wrap, used by the browser demo's prepare step with canvas
// measurements: a word joins the line when the line plus a space plus the word fits,
// the first word of a line always stays, and trailing spaces hang.
export function greedyLineCount(wordWidths: readonly number[], spaceWidth: number, maxWidth: number, epsilon = 0.005): number {
  if (wordWidths.length === 0) return 0
  let lines = 1
  let used = wordWidths[0]!
  for (let index = 1; index < wordWidths.length; index++) {
    const word = wordWidths[index]!
    if (used + spaceWidth + word <= maxWidth + epsilon) used += spaceWidth + word
    else {
      lines++
      used = word
    }
  }
  return lines
}

export function greedyTextTable(wordWidths: readonly number[], spaceWidth: number, step = 0.5): TextTable {
  const naturalWidth = wordWidths.reduce((sum, width) => sum + width, 0) + spaceWidth * Math.max(0, wordWidths.length - 1)
  const minWidth = Math.max(0, ...wordWidths)
  const {baseLines, thresholds} = tabulateLineCounts(
    width => greedyLineCount(wordWidths, spaceWidth, width),
    0,
    Math.ceil(naturalWidth) + 1,
    step,
  )
  return {naturalWidth, minWidth, baseLines, thresholds}
}
