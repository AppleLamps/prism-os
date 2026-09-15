// Checks that the example paragraph is what pretext's prepare produces, and that paragraph.ts's walker lays it
// out like pretext's own walkLineRanges and layout. pretext here is text-tabulated's unmodified copy of
// pretext's src/ (revision 477510e), measured with text-tabulated's fake canvas: every character's advance is
// a multiple of fontSize/64 px, so these widths are multiples of 1/4 px at 16px.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/text
import {describe, expect, test} from 'bun:test'
import {installFakeCanvas} from '../../../text-tabulated/fake-canvas.ts'
import {layout, prepareWithSegments, walkLineRanges, type LayoutLineRange} from '../../../text-tabulated/pretext/layout.ts'
import {exampleParagraph, layoutLines} from './paragraph.ts'
import {float32Bits, float32FromBits, tabulateWidths} from './tabulated.ts'

// pretext creates its measuring context and reads the engine profile on first use, not at import time.
installFakeCanvas('blink')
const prepared = prepareWithSegments('The quick brown fox jumps over the lazy dog.', '16px Test Sans')

describe('pretext agreement', () => {
  test('prepare produces the example\'s segments, widths and break kinds, on pretext\'s fast path', () => {
    expect(prepared.segments).toEqual([...exampleParagraph.labels])
    expect(prepared.widths).toEqual([...exampleParagraph.segmentWidths])
    expect(prepared.kinds.map((kind): number => kind === 'space' ? 1 : 0)).toEqual([...exampleParagraph.breaksAfter])
    expect(prepared.simpleLineWalkFastPath).toBe(true)
  })

  test('the plain JavaScript walker matches walkLineRanges and layout at every 1/16 px from 43 to 360 px, and next to every threshold', () => {
    const widths: number[] = []
    for (let width = 43; width <= 360; width += 1 / 16) widths.push(width)
    for (const threshold of tabulateWidths(exampleParagraph, 43, 360, 1, 9).thresholds) {
      for (let step = -3; step <= 3; step++) widths.push(float32FromBits(float32Bits(threshold) + step))
    }
    const mismatches = widths.filter(width => {
      const pretextLines: LayoutLineRange[] = []
      walkLineRanges(prepared, width, line => pretextLines.push(line))
      const exampleLines = layoutLines(exampleParagraph, width)
      const sameLines = pretextLines.length === exampleLines.length && pretextLines.every((line, index) => {
        const exampleLine = exampleLines[index]!
        return line.start.segmentIndex === exampleLine.start && line.start.graphemeIndex === 0
          && line.end.segmentIndex === exampleLine.end && line.end.graphemeIndex === 0
          && line.width === exampleLine.paintedWidth
      })
      return !sameLines || layout(prepared, width, 20).lineCount !== exampleLines.length
    })
    expect(mismatches.slice(0, 3)).toEqual([])
  })
})
