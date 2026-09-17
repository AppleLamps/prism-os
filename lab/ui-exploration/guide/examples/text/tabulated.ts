// Idea 1, tabulation. JavaScript calls the walker at many widths and finds every width where the
// layout changes. The circuit holds no text at all: it compares the runtime width with those thresholds.
import {Circuit, invariant, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {layoutLines, type Paragraph} from './paragraph.ts'

export type LayoutSummary = {
  lineCount: number
  maxLineWidth: number
  // lineEnds[slot] is where line `slot` ends, or the segment count for a slot with no line.
  lineEnds: number[]
}

export function summarizeLayout(paragraph: Paragraph, maxWidth: number, lineSlots: number): LayoutSummary {
  const lines = layoutLines(paragraph, maxWidth)
  const segmentCount = paragraph.segmentWidths.length
  return {
    lineCount: lines.length,
    maxLineWidth: Math.max(0, ...lines.map(line => line.paintedWidth)),
    lineEnds: Array.from({length: lineSlots}, (_, slot) => lines[slot]?.end ?? segmentCount),
  }
}

function sameSummary(left: LayoutSummary, right: LayoutSummary): boolean {
  return left.lineCount === right.lineCount
    && left.maxLineWidth === right.maxLineWidth
    && left.lineEnds.every((end, slot) => end === right.lineEnds[slot])
}

// For positive FP32 values, a larger bit pattern is a larger value, so bisecting over bit patterns
// ends at two neighboring FP32 values.
const scratchFloat = new Float32Array(1)
const scratchBits = new Uint32Array(scratchFloat.buffer)

export function float32Bits(value: number): number {
  scratchFloat[0] = value
  return scratchBits[0]!
}

export function float32FromBits(bits: number): number {
  scratchBits[0] = bits
  return scratchFloat[0]!
}

export type WidthTable = {
  // Ascending. thresholds[k] is the smallest FP32 width at which summaries[k + 1] holds.
  thresholds: number[]
  // One summary per interval of widths between neighboring thresholds, so one more entry than thresholds.
  // summaries[0] holds from the start of the tabulated range up to just below thresholds[0].
  summaries: LayoutSummary[]
  lineSlots: number
  walkerCalls: number
}

// Samples the walker every `sampleStep` px, and bisects between neighboring samples that differ, the way
// text-tabulated/tabulate.ts treats pretext as a black box. Sampling can miss a change that is undone
// before the next sample. For greedy line breaking over nonnegative widths, line ends only move to later
// segments as the width grows, so that can't happen here.
export function tabulateWidths(paragraph: Paragraph, fromWidth: number, toWidth: number, sampleStep: number, lineSlots: number): WidthTable {
  let walkerCalls = 0
  const summaryAt = (bits: number) => {
    walkerCalls++
    return summarizeLayout(paragraph, float32FromBits(bits), lineSlots)
  }
  const thresholds: number[] = []
  const summaries: LayoutSummary[] = []
  // The summaries at lowBits and highBits differ.
  const refine = (lowBits: number, low: LayoutSummary, highBits: number, high: LayoutSummary): void => {
    if (highBits - lowBits === 1) {
      thresholds.push(float32FromBits(highBits))
      summaries.push(high)
      return
    }
    const middleBits = Math.floor((lowBits + highBits) / 2)
    const middle = summaryAt(middleBits)
    if (!sameSummary(middle, low)) refine(lowBits, low, middleBits, middle)
    if (!sameSummary(middle, high)) refine(middleBits, middle, highBits, high)
  }
  let lowBits = float32Bits(Math.fround(fromWidth))
  let low = summaryAt(lowBits)
  summaries.push(low)
  for (let sample = 1; ; sample++) {
    const highWidth = Math.fround(Math.min(toWidth, fromWidth + sample * sampleStep))
    const highBits = float32Bits(highWidth)
    if (highBits <= lowBits) break
    const high = summaryAt(highBits)
    if (!sameSummary(high, low)) refine(lowBits, low, highBits, high)
    lowBits = highBits
    low = high
    if (highWidth >= toWidth) break
  }
  return {thresholds, summaries, lineSlots, walkerCalls}
}

// The same table with only the thresholds where the line count changes: enough for block heights.
// The other fields of the kept summaries no longer describe their merged intervals.
export function restrictToLineCount(table: WidthTable): WidthTable {
  const keptIntervals = [0]
  for (let interval = 1; interval < table.summaries.length; interval++) {
    if (table.summaries[interval]!.lineCount !== table.summaries[interval - 1]!.lineCount) keptIntervals.push(interval)
  }
  return {
    ...table,
    thresholds: keptIntervals.slice(1).map(interval => table.thresholds[interval - 1]!),
    summaries: keptIntervals.map(interval => table.summaries[interval]!),
  }
}

// [width >= threshold] as an exact bit for every FP32 width in 0..8192, when the threshold is 0 or between
// 2^-10 and 8192 (text-tabulated/step-circuit.ts explains why). Two ReLUs compute
// clamp(512 * (width - threshold) + 0.5) into 0..1, and the boolean atom rounds it. At the threshold the
// score is exactly 0.5, which rounds up to 1. One FP32 step below the threshold it's below 0.5.
// 4 operations, 3 layers.
export function emitWidthAtLeast(circuit: Circuit, width: Wire, threshold: number): Wire {
  const rounded = Math.fround(threshold)
  invariant(rounded === 0 || (rounded >= 2 ** -10 && rounded <= 8192), 'threshold is outside the range where the comparison is exact')
  const upper = circuit.reglu([], 1, [[width, 512]], 0.5 - 512 * rounded)
  const lower = circuit.reglu([], 1, [[width, 512]], -0.5 - 512 * rounded)
  const clamped = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// output = value on interval 0 + sum over k of [width >= thresholds[k]] * (value on interval k + 1 - value on interval k).
// The deltas are constant weights, so there are no products, and only nonzero deltas are stored.
export function emitDeltaSum(circuit: Circuit, bits: readonly Wire[], valueByInterval: readonly number[]): Wire {
  const terms: [Wire, number][] = []
  bits.forEach((bit, threshold) => {
    const delta = valueByInterval[threshold + 1]! - valueByInterval[threshold]!
    if (delta !== 0) terms.push([bit, delta])
  })
  return circuit.roundAffine(terms, valueByInterval[0]!)
}

export type TabulatedCircuit = {
  circuit: Circuit
  roots: Wire[]
  evaluate: (maxWidth: number) => LayoutSummary
}

// Source cell 0 is the runtime width. Outputs: line count, widest line, and every line slot's end.
export function buildTabulatedCircuit(table: WidthTable): TabulatedCircuit {
  const circuit = new Circuit(1)
  const width = circuit.source(0)
  circuit.assumeRange(width, 0, 8192)
  const bits = table.thresholds.map(threshold => emitWidthAtLeast(circuit, width, threshold))
  const rows = [
    table.summaries.map(summary => summary.lineCount),
    table.summaries.map(summary => summary.maxLineWidth),
    ...Array.from({length: table.lineSlots}, (_, slot) => table.summaries.map(summary => summary.lineEnds[slot]!)),
  ]
  const roots = rows.map(valueByPiece => emitDeltaSum(circuit, bits, valueByPiece))
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(1)
  return {
    circuit,
    roots,
    evaluate: maxWidth => {
      source[0] = maxWidth
      const outputs = evaluateRoots(source)
      return {lineCount: outputs[0]!, maxLineWidth: outputs[1]!, lineEnds: Array.from(outputs.subarray(2))}
    },
  }
}

// Only the line count, from a table restricted with restrictToLineCount.
export function buildLineCountCircuit(table: WidthTable): {circuit: Circuit, roots: Wire[], evaluate: (maxWidth: number) => number} {
  const circuit = new Circuit(1)
  circuit.assumeRange(circuit.source(0), 0, 8192)
  const bits = table.thresholds.map(threshold => emitWidthAtLeast(circuit, circuit.source(0), threshold))
  const roots = [emitDeltaSum(circuit, bits, table.summaries.map(summary => summary.lineCount))]
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(1)
  return {
    circuit,
    roots,
    evaluate: maxWidth => {
      source[0] = maxWidth
      return evaluateRoots(source)[0]!
    },
  }
}
