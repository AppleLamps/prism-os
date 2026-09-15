// Compares a fast-path circuit with pretext's walkLineRanges and measureLineStats, on whichever
// outputs the formulation has:
//   every formulation                   lineCount, maxLineWidth, and all overflow counts at 0
//   sequential and gathered lines       each line slot's start and painted width
//   segment geometry and segment walker each segment's line index and x within its line
//   segment scan                        each segment's isLineStart bit and the width of the line starting there
// Pointer jumping outputs only lineCount and maxLineWidth, so only those are compared for it.
import {type loadPretext} from './fake-canvas.ts'
import {type FastBuild, type FastParagraph} from './fast-walker.ts'

type Pretext = Awaited<ReturnType<typeof loadPretext>>
type Prepared = ReturnType<Pretext['prepareWithSegments']>

export function expectedFastLayout(pretext: Pretext, prepared: Prepared, widths: readonly number[], maxWidth: number) {
  const starts: number[] = []
  const lineWidths: number[] = []
  let emergencyBreaks = 0
  pretext.walkLineRanges(prepared, maxWidth, line => {
    if (line.start.graphemeIndex !== 0 || line.end.graphemeIndex !== 0) emergencyBreaks++
    starts.push(line.start.segmentIndex)
    lineWidths.push(line.width)
  })
  const prefix = [0]
  for (const width of widths) prefix.push(prefix[prefix.length - 1]! + width)
  const isLineStart = widths.map(() => 0)
  const startWidths = widths.map(() => 0)
  starts.forEach((start, line) => {
    isLineStart[start] = 1
    startWidths[start] = lineWidths[line]!
  })
  const lineIndex: number[] = []
  const x: number[] = []
  let line = 0
  for (let j = 0; j < widths.length; j++) {
    while (line + 1 < starts.length && starts[line + 1]! <= j) line++
    lineIndex.push(line)
    x.push(prefix[j]! - prefix[starts[line]!]!)
  }
  const maxLineWidth = pretext.measureLineStats(prepared, maxWidth).maxLineWidth
  return {lineCount: starts.length, maxLineWidth, emergencyBreaks, starts, lineWidths, lineIndex, x, isLineStart, startWidths}
}

export function fastMismatches(pretext: Pretext, build: FastBuild, table: Float32Array, prepared: Prepared, paragraph: FastParagraph, maxWidth: number): string[] {
  table[build.fc.maxWidth] = maxWidth
  const output = build.decode(build.compiled.evaluate(table))
  const expected = expectedFastLayout(pretext, prepared, paragraph.widths, maxWidth)
  const problems: string[] = []
  if (expected.emergencyBreaks !== 0) problems.push('pretext broke inside a segment, which the fast walker does not handle')
  if (output.lineCount !== expected.lineCount) problems.push(`lineCount ${output.lineCount} vs ${expected.lineCount}`)
  if (output.maxLineWidth !== Math.fround(expected.maxLineWidth)) problems.push(`maxLineWidth ${output.maxLineWidth} vs ${expected.maxLineWidth}`)
  if (output.windowOverflow !== 0) problems.push('window too small')
  if (output.moreLinesThanSlots !== 0) problems.push('more lines than slots')
  if (output.runOverflow !== 0) problems.push('run of break-after segments longer than the run limit')
  output.starts.forEach((start, line) => {
    const expectedStart = expected.starts[line] ?? paragraph.widths.length
    const expectedWidth = expected.lineWidths[line] ?? 0
    if (start !== expectedStart || output.widths[line] !== Math.fround(expectedWidth)) {
      problems.push(`line ${line}: ${start}/${output.widths[line]} vs ${expectedStart}/${expectedWidth}`)
    }
  })
  output.lineIndex.forEach((index, j) => {
    if (index !== expected.lineIndex[j] || output.x[j] !== Math.fround(expected.x[j]!)) {
      problems.push(`segment ${j}: line ${index} x ${output.x[j]} vs line ${expected.lineIndex[j]} x ${expected.x[j]}`)
    }
  })
  output.isLineStart.forEach((bit, j) => {
    if (bit !== expected.isLineStart[j] || output.startWidths[j] !== Math.fround(expected.startWidths[j]!)) {
      problems.push(`start at segment ${j}: ${bit}/${output.startWidths[j]} vs ${expected.isLineStart[j]}/${expected.startWidths[j]}`)
    }
  })
  return problems
}
