// Checks every circuit in this folder against the plain JavaScript walker in paragraph.ts, over a sweep
// of widths. Run from the repo root: bun test lab/ui-exploration/guide/examples/text
import {describe, expect, test} from 'bun:test'
import {buildCandidateCircuit, deriveCandidates, lineFromCandidates} from './candidates.ts'
import {buildWalkerCircuit} from './counting.ts'
import {exampleParagraph, layoutLineFrom, layoutLines, type Paragraph} from './paragraph.ts'
import {programSize} from './size.ts'
import {buildLineCountCircuit, buildTabulatedCircuit, float32Bits, float32FromBits, restrictToLineCount, summarizeLayout, tabulateWidths} from './tabulated.ts'

// "brown" is the widest word. Below 43 px it would overflow its line, where pretext breaks words between graphemes.
const narrowestWidth = 43
// The whole paragraph is 343.75 px wide.
const widestWidth = 360
const lineSlots = layoutLines(exampleParagraph, narrowestWidth).length

// Every 1/16 px. The walker circuit's comparison is exact for widths on a 1/64 px grid.
const sweepWidths: number[] = []
for (let width = narrowestWidth; width <= widestWidth; width += 1 / 16) sweepWidths.push(width)

// The same paragraph with "quick" in bold, e.g. 44.25 px instead of 40.25 px.
const boldQuick: Paragraph = {
  ...exampleParagraph,
  segmentWidths: exampleParagraph.segmentWidths.map((width, index) => exampleParagraph.labels[index] === 'quick' ? 44.25 : width),
}

describe('tabulation', () => {
  const table = tabulateWidths(exampleParagraph, narrowestWidth, widestWidth, 1, lineSlots)
  const tabulated = buildTabulatedCircuit(table)

  test('matches the walker at every sampled width, and 1 to 3 FP32 steps on either side of every threshold', () => {
    const widths = sweepWidths.map(width => Math.fround(width))
    for (const threshold of table.thresholds) {
      for (let step = -3; step <= 3; step++) widths.push(float32FromBits(float32Bits(threshold) + step))
    }
    const mismatches = widths.filter(width => {
      const circuit = tabulated.evaluate(width)
      const reference = summarizeLayout(exampleParagraph, width, lineSlots)
      return JSON.stringify(circuit) !== JSON.stringify(reference)
    })
    expect(mismatches.slice(0, 3)).toEqual([])
  })

  test('only the thresholds where the line count changes are enough for heights', () => {
    const heights = buildLineCountCircuit(restrictToLineCount(table))
    const mismatches = sweepWidths.filter(width => heights.evaluate(Math.fround(width)) !== layoutLines(exampleParagraph, Math.fround(width)).length)
    expect(mismatches.slice(0, 3)).toEqual([])
  })

  test('the circuit is 4 layers deep whatever the text', () => {
    expect(programSize(tabulated.circuit, tabulated.roots).layers).toBe(4)
  })

  test('the text is stored in the thresholds and weights, so an edited word needs a new table', () => {
    const disagreeWithEdit = (circuit: ReturnType<typeof buildTabulatedCircuit>) => sweepWidths.filter(width => {
      const rounded = Math.fround(width)
      return JSON.stringify(circuit.evaluate(rounded)) !== JSON.stringify(summarizeLayout(boldQuick, rounded, lineSlots))
    }).length
    expect(disagreeWithEdit(tabulated)).toBeGreaterThan(0)
    const retabulated = buildTabulatedCircuit(tabulateWidths(boldQuick, narrowestWidth, widestWidth, 1, lineSlots))
    expect(disagreeWithEdit(retabulated)).toBe(0)
  })
})

describe('the walker as counting', () => {
  const walker = buildWalkerCircuit(exampleParagraph, lineSlots)

  // Like text-walker's fast path, the counting circuit needs lines at least as wide as the widest word. When a
  // line's first word overflows, e.g. the bold "quick" at 43 px, the bit for the space after it is 0, so the
  // circuit ends the line at that space, while the walker ends it after the space.
  const mismatchesFor = (paragraph: Paragraph) => sweepWidths.filter(width => width >= Math.max(...paragraph.segmentWidths)).filter(width => {
    const outputs = walker.evaluate(paragraph.segmentWidths, width)
    const lines = layoutLines(paragraph, width)
    const segmentCount = paragraph.segmentWidths.length
    const slotsMatch = outputs.slotStarts.every((start, slot) => start === (lines[slot]?.start ?? segmentCount))
      && outputs.slotWidths.every((paintedWidth, slot) => paintedWidth === (lines[slot]?.paintedWidth ?? 0))
    const tableMatches = walker.wordStarts.every((wordStart, word) => {
      const line = layoutLineFrom(paragraph, wordStart, width)
      return outputs.lineEnds[word] === line.end && outputs.paintedWidths[word] === line.paintedWidth
    })
    return !(slotsMatch && tableMatches && outputs.lineCount === lines.length && outputs.finalStart === segmentCount)
  })

  test('every word\'s line end and painted width, and the chained line slots, match the walker', () => {
    expect(mismatchesFor(exampleParagraph).slice(0, 3)).toEqual([])
  })

  test('an edited word width only changes a source cell: the same circuit matches the walker on the edited paragraph', () => {
    expect(mismatchesFor(boldQuick).slice(0, 3)).toEqual([])
  })

  test('the one-hots cost 2 operations per position per line slot', () => {
    const segmentCount = exampleParagraph.segmentWidths.length
    expect(programSize(walker.circuit, walker.roots, walker.oneHotWires).trackedOperations).toBe(lineSlots * 2 * segmentCount)
  })
})

describe('candidates derived in JavaScript', () => {
  const wordStarts = exampleParagraph.breaksAfter.flatMap((breakAfter, segment) => breakAfter === 0 ? [segment] : [])
  const capacity = Math.max(...wordStarts.map(start => deriveCandidates(exampleParagraph, start).candidates.length))
  const candidateCircuit = buildCandidateCircuit(exampleParagraph.segmentWidths.length, capacity)

  // Every line start gets every width in the sweep, as if each line had its own width.
  const mismatchesFor = (paragraph: Paragraph) => {
    const mismatches: string[] = []
    for (const start of wordStarts) {
      const list = deriveCandidates(paragraph, start)
      for (const width of sweepWidths) {
        const reference = layoutLineFrom(paragraph, start, width)
        const fromList = lineFromCandidates(list, width)
        const fromCircuit = candidateCircuit.evaluate(list, width)
        const matches = fromList.end === reference.end && fromList.paintedWidth === reference.paintedWidth
          && fromCircuit.lineEnd === reference.end && fromCircuit.paintedWidth === reference.paintedWidth
        if (!matches) mismatches.push(`start ${start}, width ${width}`)
      }
    }
    return mismatches
  }

  test('the first candidate that doesn\'t fit gives the walker\'s line, in JavaScript and in the circuit, for every line start', () => {
    expect(mismatchesFor(exampleParagraph).slice(0, 3)).toEqual([])
  })

  test('an edited word width means deriving the lists again in JavaScript, but the same circuit', () => {
    expect(mismatchesFor(boldQuick).slice(0, 3)).toEqual([])
  })
})
