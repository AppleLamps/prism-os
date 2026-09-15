// A tiny paragraph with made-up segment widths, and a plain JavaScript greedy line walker that the
// circuits are checked against. The walker follows pretext's fast path (walkPreparedLinesSimple in
// pretext's src/line-break.ts) for word and space segments, without emergency breaks: a word wider
// than the line starts its own line whole and overflows, where pretext would break it between graphemes.
//
// In an app, pretext's prepare step produces these arrays: Intl.Segmenter splits the text into
// segments, and canvas measureText measures each segment. Here they're written by hand, and
// pretext-agreement.test.ts checks that pretext's prepareWithSegments, with text-tabulated's fake canvas,
// produces exactly these arrays, and that layoutLines gives the same lines as pretext's walkLineRanges.

export type Paragraph = {
  labels: readonly string[]
  // Advance of each segment in px. Every width is a multiple of 1/4 px, so sums are exact in float64 and FP32.
  segmentWidths: readonly number[]
  // 1 for a space. A line may break after a space, a space at the end of a line hangs past the line's
  // edge (it never causes a break and isn't painted), and a line never starts with a space.
  breaksAfter: readonly number[]
}

// pretext's lineFitEpsilon in its Blink and Gecko profiles: a line fits when its width is at most maxWidth + 0.005.
export const lineFitEpsilon = 0.005

export function makeParagraph(words: readonly string[], wordWidths: readonly number[], spaceWidth: number): Paragraph {
  const labels: string[] = []
  const segmentWidths: number[] = []
  const breaksAfter: number[] = []
  words.forEach((word, index) => {
    if (index > 0) {
      labels.push(' ')
      segmentWidths.push(spaceWidth)
      breaksAfter.push(1)
    }
    labels.push(word)
    segmentWidths.push(wordWidths[index]!)
    breaksAfter.push(0)
  })
  return {labels, segmentWidths, breaksAfter}
}

// The widths pretext's fake canvas gives at 16px, e.g. "quick" is 40.25 px and a space is 5 px.
export const exampleParagraph = makeParagraph(
  ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog.'],
  [25, 40.25, 43, 26.25, 41.5, 35, 26.5, 32.75, 33.5],
  5,
)

export type Line = {
  start: number
  // The first segment after the line: the next line's start, or the segment count after the last line.
  end: number
  // The line's width without its trailing space.
  paintedWidth: number
}

// One line starting at the word `lineStart`.
export function layoutLineFrom(paragraph: Paragraph, lineStart: number, maxWidth: number): Line {
  const {segmentWidths, breaksAfter} = paragraph
  const fitLimit = maxWidth + lineFitEpsilon
  // The first word always stays on its line, even when it's wider than the line.
  let lineWidth = segmentWidths[lineStart]!
  let segment = lineStart + 1
  for (; segment < segmentWidths.length; segment++) {
    const width = segmentWidths[segment]!
    // A space hangs, so it's never the segment that overflows.
    if (breaksAfter[segment] === 0 && lineWidth + width > fitLimit) break
    lineWidth += width
  }
  const lastSegment = segment - 1
  const paintedWidth = breaksAfter[lastSegment] === 1 ? lineWidth - segmentWidths[lastSegment]! : lineWidth
  return {start: lineStart, end: segment, paintedWidth}
}

export function layoutLines(paragraph: Paragraph, maxWidth: number): Line[] {
  const segmentCount = paragraph.segmentWidths.length
  const lines: Line[] = []
  let start = 0
  while (start < segmentCount) {
    while (start < segmentCount && paragraph.breaksAfter[start] === 1) start++
    if (start >= segmentCount) break
    const line = layoutLineFrom(paragraph, start, maxWidth)
    lines.push(line)
    start = line.end
  }
  return lines
}
