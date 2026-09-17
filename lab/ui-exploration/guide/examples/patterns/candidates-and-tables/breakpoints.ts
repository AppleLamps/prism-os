// Breakpoints found ahead of time. A list of chat messages whose bubble heights, shrink-wrapped bubble
// widths and tops change only at a few container widths. While preparing, JavaScript calls the plain
// layout function as a black box and finds every width where some output changes. The circuit compares
// the runtime width with those widths and adds up constants, so its only input is the container width.
//
// Host contract: the container width is a multiple of 1/64 px within 160..1280 px, e.g. a sidebar width
// that springs, which the host rounds onto the grid before writing it.
import {Circuit, type Wire, emitCompare, invariant} from '../../../../../../src/runtime/numeric-ui-core.ts'

export const widthGridSteps = 64
export const minimumContainerWidth = 160
export const maximumContainerWidth = 1280
const lineHeight = 20
const bubblePadding = 12
const bubbleGap = 8

export const messageTexts = [
  'Are we still on for lunch tomorrow?',
  'Yes, the place by the river at noon.',
  'Perfect. I will bring the photos from the trip so we can pick the ones for the album.',
  'Sounds good',
  'Can you send the address again? My phone deleted our old thread when it updated last night.',
] as const

export type PreparedMessage = {segmentWidths: number[], isSpace: boolean[]}

// A stand-in for measuring text: 7.5 px per character and 4 px per space, so widths are exact in FP32.
export function prepareMessage(text: string): PreparedMessage {
  const segments = text.split(/( )/).filter(segment => segment.length > 0)
  return {
    segmentWidths: segments.map(segment => (segment === ' ' ? 4 : segment.length * 7.5)),
    isSpace: segments.map(segment => segment === ' '),
  }
}

// Greedy line breaking, like pretext's fast path: add words to a line until the next word doesn't fit.
// A space hangs, so it never overflows a line, and a line's painted width leaves out its trailing spaces.
export function layoutParagraph(message: PreparedMessage, maxWidth: number) {
  const {segmentWidths, isSpace} = message
  let lineCount = 0
  let widestLine = 0
  let segment = 0
  while (segment < segmentWidths.length) {
    // A line starts at a word, which stays on its line even when the word is wider than the line.
    let lineWidth = segmentWidths[segment]!
    let paintedWidth = lineWidth
    segment++
    while (segment < segmentWidths.length) {
      const width = segmentWidths[segment]!
      if (!isSpace[segment] && lineWidth + width > maxWidth) break
      lineWidth += width
      if (!isSpace[segment]) paintedWidth = lineWidth
      segment++
    }
    lineCount++
    widestLine = Math.max(widestLine, paintedWidth)
  }
  return {lineCount, widestLine}
}

export type MessageListLayout = {bubbleTops: number[], bubbleHeights: number[], bubbleWidths: number[], contentHeight: number}

// The layout the circuit replaces, which the host would otherwise call on every frame.
export function layoutMessageList(messages: readonly PreparedMessage[], containerWidth: number): MessageListLayout {
  // A bubble takes 3/4 of the container, at most 480 px, and its text sits inside 12 px of padding.
  const textWidth = Math.min(480, containerWidth * 0.75) - 2 * bubblePadding
  const layout: MessageListLayout = {bubbleTops: [], bubbleHeights: [], bubbleWidths: [], contentHeight: 0}
  let top = 0
  for (const message of messages) {
    const {lineCount, widestLine} = layoutParagraph(message, textWidth)
    const height = lineCount * lineHeight + 2 * bubblePadding
    layout.bubbleTops.push(top)
    layout.bubbleHeights.push(height)
    layout.bubbleWidths.push(widestLine + 2 * bubblePadding)
    top += height + bubbleGap
  }
  layout.contentHeight = top - bubbleGap
  return layout
}

export function flattenMessageList(layout: MessageListLayout): number[] {
  return [...layout.bubbleTops, ...layout.bubbleHeights, ...layout.bubbleWidths, layout.contentHeight]
}

export type BreakpointTable = {
  // Ascending, on the width grid. thresholds[k] is the smallest width at which valuesByInterval[k + 1] holds.
  thresholds: number[]
  // Every output's value on each interval between neighboring thresholds, so one more entry than thresholds.
  valuesByInterval: number[][]
  layoutCalls: number
}

// Samples the layout every 1 px, and wherever two neighboring samples differ, bisects over grid steps
// until the two widths are one grid step apart. A change that is undone before the next sample leaves
// both samples equal, so it's never bisected; a greedy walker's lines only get fewer or wider as the width
// grows, so that doesn't happen here.
export function findBreakpoints(layoutAt: (containerWidth: number) => number[], fromWidth: number, toWidth: number): BreakpointTable {
  invariant(Number.isInteger(fromWidth) && Number.isInteger(toWidth) && fromWidth < toWidth, 'the tabulated range must be whole pixels')
  let layoutCalls = 0
  const valuesAt = (steps: number) => {
    layoutCalls++
    return layoutAt(steps / widthGridSteps)
  }
  const same = (left: readonly number[], right: readonly number[]) => left.every((value, index) => value === right[index])
  const thresholds: number[] = []
  const valuesByInterval: number[][] = []
  // The values at lowSteps and highSteps differ.
  const refine = (lowSteps: number, low: number[], highSteps: number, high: number[]): void => {
    if (highSteps - lowSteps === 1) {
      thresholds.push(highSteps / widthGridSteps)
      valuesByInterval.push(high)
      return
    }
    const middleSteps = Math.floor((lowSteps + highSteps) / 2)
    const middle = valuesAt(middleSteps)
    if (!same(middle, low)) refine(lowSteps, low, middleSteps, middle)
    if (!same(middle, high)) refine(middleSteps, middle, highSteps, high)
  }
  let lowSteps = fromWidth * widthGridSteps
  let low = valuesAt(lowSteps)
  valuesByInterval.push(low)
  for (let width = fromWidth + 1; width <= toWidth; width++) {
    const highSteps = width * widthGridSteps
    const high = valuesAt(highSteps)
    if (!same(high, low)) refine(lowSteps, low, highSteps, high)
    lowSteps = highSteps
    low = high
  }
  return {thresholds, valuesByInterval, layoutCalls}
}

export function buildBreakpointLayout(table: BreakpointTable) {
  // Source cell 0: the container width.
  const circuit = new Circuit(1)
  const containerWidth = circuit.source(0)
  circuit.assumeRange(containerWidth, minimumContainerWidth, maximumContainerWidth)
  circuit.assumeGrid(containerWidth, 1 / widthGridSteps)
  // [containerWidth >= threshold]. Both operands lie on the 1/64 px grid, so emitCompare builds an
  // integer bit, 2 operations in 2 layers.
  const bits = table.thresholds.map(threshold => emitCompare(circuit, containerWidth, '>=', circuit.affine([], threshold)))
  // Every output is its value on the first interval, plus how much it changes at each threshold the width reaches.
  const outputCount = table.valuesByInterval[0]!.length
  const roots = Array.from({length: outputCount}, (_, output) => {
    const terms: [Wire, number][] = []
    bits.forEach((bit, threshold) => {
      const change = table.valuesByInterval[threshold + 1]![output]! - table.valuesByInterval[threshold]![output]!
      if (change !== 0) terms.push([bit, change])
    })
    return circuit.roundAffine(terms, table.valuesByInterval[0]![output]!)
  })
  return {circuit, containerWidth, bits, roots}
}
