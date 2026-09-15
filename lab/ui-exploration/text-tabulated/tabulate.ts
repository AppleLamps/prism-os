// Prepare-time tabulation: layout results as step functions of one runtime width.
//
// pretext is treated as a black box. We sample a measure function over FP32 widths every `step` px,
// and whenever two neighboring samples differ, bisect over FP32 bit patterns until the two widths
// are adjacent FP32 values. Each threshold is therefore the smallest FP32 width at which its piece
// holds, and a circuit comparing an FP32 width against it reproduces pretext's decision at every
// FP32 width, including one ulp on either side of a threshold.
//
// A result that changes and changes back within one sampling step is missed. When every line cursor
// only moves forward as the width grows (checked for the content we measure, see monotone-search.ts),
// equal samples at both ends of an interval prove nothing changed inside it.

import {float32Bits, float32FromBits} from './float32.ts'
import {layout, walkLineRanges, type LayoutCursor, type PreparedTextWithSegments} from './pretext/layout.ts'

export type StepFunction<Sample> = {
  from: number
  to: number
  // thresholds[k] is the smallest FP32 width of piece k + 1. Piece 0 holds from `from`.
  thresholds: number[]
  samples: Sample[]
  measureCalls: number
}

export function tabulateOverWidths<Sample>(
  measure: (width: number) => Sample,
  equal: (left: Sample, right: Sample) => boolean,
  from: number,
  to: number,
  step: number,
): StepFunction<Sample> {
  const fromWidth = Math.fround(from)
  const toWidth = Math.fround(to)
  if (!(fromWidth > 0 && toWidth > fromWidth && step > 0)) throw new Error('tabulateOverWidths expects 0 < from < to and a positive step')
  let measureCalls = 0
  const measureAt = (bits: number) => {
    measureCalls++
    return measure(float32FromBits(bits))
  }
  const thresholds: number[] = []
  const samples: Sample[] = []
  // Invariant: the samples at lowBits and highBits differ.
  const refine = (lowBits: number, lowSample: Sample, highBits: number, highSample: Sample): void => {
    if (highBits - lowBits === 1) {
      thresholds.push(float32FromBits(highBits))
      samples.push(highSample)
      return
    }
    const middleBits = Math.floor((lowBits + highBits) / 2)
    const middleSample = measureAt(middleBits)
    if (!equal(middleSample, lowSample)) refine(lowBits, lowSample, middleBits, middleSample)
    if (!equal(middleSample, highSample)) refine(middleBits, middleSample, highBits, highSample)
  }
  let lowBits = float32Bits(fromWidth)
  let lowSample = measureAt(lowBits)
  samples.push(lowSample)
  for (let index = 1; ; index++) {
    const highWidth = Math.fround(Math.min(toWidth, fromWidth + index * step))
    const highBits = float32Bits(highWidth)
    if (highBits <= lowBits) break
    const highSample = measureAt(highBits)
    if (!equal(highSample, lowSample)) refine(lowBits, lowSample, highBits, highSample)
    lowBits = highBits
    lowSample = highSample
    if (highWidth >= toWidth) break
  }
  return {from: fromWidth, to: toWidth, thresholds, samples, measureCalls}
}

// Index of the piece that holds at `width`, by the same rule the circuit uses.
export function pieceAt(thresholds: readonly number[], width: number): number {
  let piece = 0
  const rounded = Math.fround(width)
  for (const threshold of thresholds) if (rounded >= threshold) piece++
  return piece
}

// ---------------------------------------------------------------- text blocks

export type LineRange = {
  startSegment: number
  startGrapheme: number
  endSegment: number
  endGrapheme: number
  width: number
}

export type BlockSample = {
  lineCount: number
  maxLineWidth: number
  // The width the painted lines were laid out at: the block's max width for a plain paragraph,
  // the narrowest integer width that keeps the line count for shrink-wrapped and balanced blocks.
  layoutWidth: number
  lines: LineRange[]
}

// plain: lay out at the block's max width.
// shrinkwrap: lay out at the smallest integer width that keeps the line count (pretext's bubbles demo).
//   Balanced text uses the same rule; only the painted x positions differ.
export type BlockMode = 'plain' | 'shrinkwrap'

export type BlockSpec = {
  prepared: PreparedTextWithSegments
  mode: BlockMode
  // Maps the shared runtime width (e.g. a window's content width) to this block's max width.
  // Any nondecreasing JS formula works, including floor, because the circuit never evaluates it:
  // thresholds are found in units of the shared width.
  maxWidthAt: (sharedWidth: number) => number
}

function walkRanges(prepared: PreparedTextWithSegments, maxWidth: number): {lineCount: number, maxLineWidth: number, lines: LineRange[]} {
  const lines: LineRange[] = []
  let maxLineWidth = 0
  const lineCount = walkLineRanges(prepared, maxWidth, line => {
    lines.push({
      startSegment: line.start.segmentIndex,
      startGrapheme: line.start.graphemeIndex,
      endSegment: line.end.segmentIndex,
      endGrapheme: line.end.graphemeIndex,
      width: line.width,
    })
    if (line.width > maxLineWidth) maxLineWidth = line.width
  })
  return {lineCount, maxLineWidth, lines}
}

// The smallest integer width in 1..ceil(maxWidth) whose line count is at most the count at maxWidth.
// A binary search, so it assumes the line count never grows with width.
function tightIntegerWidth(prepared: PreparedTextWithSegments, maxWidth: number): number {
  const lineCount = layout(prepared, maxWidth, 1).lineCount
  let low = 1
  let high = Math.max(1, Math.ceil(maxWidth))
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (layout(prepared, middle, 1).lineCount <= lineCount) high = middle
    else low = middle + 1
  }
  return low
}

export function measureBlock(spec: BlockSpec, sharedWidth: number): BlockSample {
  const maxWidth = spec.maxWidthAt(sharedWidth)
  if (spec.mode === 'plain') return {...walkRanges(spec.prepared, maxWidth), layoutWidth: maxWidth}
  const tightWidth = tightIntegerWidth(spec.prepared, maxWidth)
  return {...walkRanges(spec.prepared, tightWidth), layoutWidth: tightWidth}
}

export function sameLines(left: BlockSample, right: BlockSample): boolean {
  if (left.lineCount !== right.lineCount || left.maxLineWidth !== right.maxLineWidth || left.lines.length !== right.lines.length) return false
  for (let index = 0; index < left.lines.length; index++) {
    const a = left.lines[index]!
    const b = right.lines[index]!
    if (a.startSegment !== b.startSegment || a.startGrapheme !== b.startGrapheme || a.endSegment !== b.endSegment || a.endGrapheme !== b.endGrapheme || a.width !== b.width) return false
  }
  return true
}

// A plain block's layoutWidth equals its max width, which changes continuously, so it's left out of
// the comparison. For shrink-wrapped blocks it's an integer that changes only with the line count.
function equalForMode(mode: BlockMode): (left: BlockSample, right: BlockSample) => boolean {
  return mode === 'plain' ? sameLines : (left, right) => left.layoutWidth === right.layoutWidth && sameLines(left, right)
}

export type BlockTable = {
  mode: BlockMode
  from: number
  to: number
  thresholds: number[] // K
  lineCount: number[] // K + 1
  maxLineWidth: number[]
  layoutWidth: number[] // shrinkwrap only; plain blocks hold NaN
  slotCount: number
  // Distinct cursors, sorted; a cursor id is an index into this array. The last id is the text end,
  // which absent slots use for both their start and end.
  cursors: LayoutCursor[]
  startIds: number[][] // [piece][slot]
  endIds: number[][]
  lineWidths: number[][]
  measureCalls: number
  tabulateMilliseconds: number
}

export function tabulateBlock(spec: BlockSpec, from: number, to: number, step: number): BlockTable {
  const started = performance.now()
  const steps = tabulateOverWidths(width => measureBlock(spec, width), equalForMode(spec.mode), from, to, step)
  const tabulateMilliseconds = performance.now() - started
  const segmentCount = spec.prepared.segments.length
  const cursorKeys = new Map<string, LayoutCursor>()
  const addCursor = (segmentIndex: number, graphemeIndex: number) => {
    const key = `${segmentIndex}:${graphemeIndex}`
    if (!cursorKeys.has(key)) cursorKeys.set(key, {segmentIndex, graphemeIndex})
  }
  let slotCount = 0
  for (const sample of steps.samples) {
    slotCount = Math.max(slotCount, sample.lines.length)
    for (const line of sample.lines) {
      addCursor(line.startSegment, line.startGrapheme)
      addCursor(line.endSegment, line.endGrapheme)
    }
  }
  const cursors = [...cursorKeys.values()]
    .filter(cursor => !(cursor.segmentIndex === segmentCount && cursor.graphemeIndex === 0))
    .sort((left, right) => left.segmentIndex - right.segmentIndex || left.graphemeIndex - right.graphemeIndex)
  cursors.push({segmentIndex: segmentCount, graphemeIndex: 0})
  const idOf = new Map<string, number>()
  cursors.forEach((cursor, id) => idOf.set(`${cursor.segmentIndex}:${cursor.graphemeIndex}`, id))
  const endId = cursors.length - 1
  const startIds: number[][] = []
  const endIds: number[][] = []
  const lineWidths: number[][] = []
  for (const sample of steps.samples) {
    const starts: number[] = []
    const ends: number[] = []
    const widths: number[] = []
    for (let slot = 0; slot < slotCount; slot++) {
      const line = sample.lines[slot]
      starts.push(line === undefined ? endId : idOf.get(`${line.startSegment}:${line.startGrapheme}`)!)
      ends.push(line === undefined ? endId : idOf.get(`${line.endSegment}:${line.endGrapheme}`)!)
      widths.push(line === undefined ? 0 : line.width)
    }
    startIds.push(starts)
    endIds.push(ends)
    lineWidths.push(widths)
  }
  return {
    mode: spec.mode,
    from: steps.from,
    to: steps.to,
    thresholds: steps.thresholds,
    lineCount: steps.samples.map(sample => sample.lineCount),
    maxLineWidth: steps.samples.map(sample => sample.maxLineWidth),
    layoutWidth: steps.samples.map(sample => spec.mode === 'plain' ? Number.NaN : sample.layoutWidth),
    slotCount,
    cursors,
    startIds,
    endIds,
    lineWidths,
    measureCalls: steps.measureCalls,
    tabulateMilliseconds,
  }
}

// The same table with only the thresholds where a chosen output changes, e.g. just the line count
// for block heights. Painting outputs (cursors, line widths) are dropped.
export function restrictTable(table: BlockTable, keep: {maxLineWidth: boolean, layoutWidth: boolean}): BlockTable {
  const kept: number[] = [0]
  for (let piece = 1; piece < table.lineCount.length; piece++) {
    const changes = table.lineCount[piece] !== table.lineCount[piece - 1]
      || (keep.maxLineWidth && table.maxLineWidth[piece] !== table.maxLineWidth[piece - 1])
      || (keep.layoutWidth && !Object.is(table.layoutWidth[piece], table.layoutWidth[piece - 1]))
    if (changes) kept.push(piece)
  }
  return {
    ...table,
    thresholds: kept.slice(1).map(piece => table.thresholds[piece - 1]!),
    lineCount: kept.map(piece => table.lineCount[piece]!),
    maxLineWidth: kept.map(piece => table.maxLineWidth[piece]!),
    layoutWidth: kept.map(piece => table.layoutWidth[piece]!),
    slotCount: 0,
    startIds: kept.map(() => []),
    endIds: kept.map(() => []),
    lineWidths: kept.map(() => []),
  }
}

// How many times each kind of output changes across the table.
export function countChanges(values: readonly number[]): number {
  let changes = 0
  for (let piece = 1; piece < values.length; piece++) if (values[piece] !== values[piece - 1]) changes++
  return changes
}

export function tableStats(table: BlockTable) {
  let startChanges = 0
  let endChanges = 0
  let widthChanges = 0
  for (let slot = 0; slot < table.slotCount; slot++) {
    startChanges += countChanges(table.startIds.map(row => row[slot]!))
    endChanges += countChanges(table.endIds.map(row => row[slot]!))
    widthChanges += countChanges(table.lineWidths.map(row => row[slot]!))
  }
  return {
    thresholds: table.thresholds.length,
    lineCountChanges: countChanges(table.lineCount),
    maxLineWidthChanges: countChanges(table.maxLineWidth),
    slotCount: table.slotCount,
    cursorCount: table.cursors.length,
    startChanges,
    endChanges,
    widthChanges,
  }
}
