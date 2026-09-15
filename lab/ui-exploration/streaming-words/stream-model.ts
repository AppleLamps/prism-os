// The JavaScript side of streaming: chunking replies, laying out each turn's prefix with pretext,
// writing source cells, applying a Stop at the press's timestamp, and the float64 reference layout
// the circuit is compared against.
//
// pretext is passed in, so the same code runs headlessly with the fake canvas and in the browser with
// real fonts.
import {viewPrepared} from '../text-walker/fake-canvas.ts'
import {type FlowLayout, type StreamBuild} from './stream-circuit.ts'

type Pretext = typeof import('../text-walker/pretext-src/layout.ts')

// 1 and 3 are chunks of that many characters. 'word' chunks are a word with its leading space, the
// way a tokenizer's word tokens usually carry the space. 'whole' is one chunk, e.g. a sent message.
export type ChunkMode = 1 | 3 | 'word' | 'whole'

export function chunkText(text: string, mode: ChunkMode): string[] {
  if (mode === 'whole') return [text]
  if (mode === 'word') return text.split(' ').map((word, index) => index === 0 ? word : ` ${word}`)
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += mode) chunks.push(text.slice(index, index + mode))
  return chunks
}

export type Turn = {text: string, mode: ChunkMode}

// After this chunk, turn `turn` shows text.slice(0, end). Turns stream one after another.
export type ChunkEvent = {turn: number, end: number}

export function chunkEvents(turns: readonly Turn[]): ChunkEvent[] {
  const events: ChunkEvent[] = []
  turns.forEach((turn, index) => {
    let end = 0
    for (const chunk of chunkText(turn.text, turn.mode)) {
      end += chunk.length
      events.push({turn: index, end})
    }
  })
  return events
}

export type TurnLayout = {
  firstSegment: number
  segmentCount: number
  // pretext's lines on this turn's prefix: start segments (global indices) and painted widths.
  lineStarts: number[]
  lineWidths: number[]
  maxLineWidth: number
}

// The segments of a conversation state, and pretext's layout of every turn's prefix.
export type FlowState = {
  prefixLengths: number[]
  texts: string[]
  widths: number[]
  breakAfter: number[]
  turnStart: number[]
  turnOfSegment: number[]
  arrivedCount: number
  turns: TurnLayout[]
  emergencyBreaks: number
}

export function layoutFlow(pretext: Pretext, font: string, turns: readonly Turn[], prefixLengths: readonly number[], maxWidth: number): FlowState {
  const state: FlowState = {prefixLengths: [...prefixLengths], texts: [], widths: [], breakAfter: [], turnStart: [], turnOfSegment: [], arrivedCount: 0, turns: [], emergencyBreaks: 0}
  turns.forEach((turn, turnIndex) => {
    const length = prefixLengths[turnIndex] ?? 0
    const firstSegment = state.widths.length
    if (length === 0) {
      state.turns.push({firstSegment, segmentCount: 0, lineStarts: [], lineWidths: [], maxLineWidth: 0})
      return
    }
    const prepared = pretext.prepareWithSegments(turn.text.slice(0, length), font)
    const view = viewPrepared(prepared)
    if (!view.simpleLineWalkFastPath || view.letterSpacing !== 0) throw new Error('streamed text must stay on pretext fast path')
    const lineStarts: number[] = []
    const lineWidths: number[] = []
    pretext.walkLineRanges(prepared, maxWidth, line => {
      if (line.start.graphemeIndex !== 0 || line.end.graphemeIndex !== 0) state.emergencyBreaks++
      lineStarts.push(firstSegment + line.start.segmentIndex)
      lineWidths.push(line.width)
    })
    view.widths.forEach((width, j) => {
      state.texts.push(prepared.segments[j]!)
      state.widths.push(width)
      const kind = view.kinds[j]!
      state.breakAfter.push(kind === 'space' || kind === 'zero-width-break' ? 1 : 0)
      state.turnStart.push(j === 0 && turnIndex > 0 ? 1 : 0)
      state.turnOfSegment.push(turnIndex)
    })
    state.turns.push({firstSegment, segmentCount: view.widths.length, lineStarts, lineWidths, maxLineWidth: pretext.measureLineStats(prepared, maxWidth).maxLineWidth})
  })
  state.arrivedCount = state.widths.length
  return state
}

// Writes a state's segments into the table. Segments at or after the arrived count are written as
// absent: width 0, break-after 0, no turn start.
export function writeFlowState(build: StreamBuild, table: Float32Array, state: FlowState): void {
  const {cells} = build
  if (state.arrivedCount > build.options.capacity) throw new Error(`${state.arrivedCount} segments exceed the capacity of ${build.options.capacity}`)
  for (let j = 0; j < build.options.capacity; j++) {
    const arrived = j < state.arrivedCount
    table[cells.widths[j]!] = arrived ? state.widths[j]! : 0
    table[cells.breakAfter[j]!] = arrived ? state.breakAfter[j]! : 0
    if (cells.turnStart !== null) table[cells.turnStart[j]!] = arrived ? state.turnStart[j]! : 0
  }
  table[cells.arrivedCount] = state.arrivedCount
}

export type CellWrite = {cell: number, value: number}

// Only the cells that differ between two states: what a real page would write per chunk.
export function flowStateWrites(build: StreamBuild, table: Float32Array, state: FlowState): CellWrite[] {
  const {cells} = build
  const writes: CellWrite[] = []
  const write = (cell: number, value: number) => {
    if (table[cell] !== Math.fround(value)) writes.push({cell, value})
  }
  for (let j = 0; j < build.options.capacity; j++) {
    const arrived = j < state.arrivedCount
    write(cells.widths[j]!, arrived ? state.widths[j]! : 0)
    write(cells.breakAfter[j]!, arrived ? state.breakAfter[j]! : 0)
    if (cells.turnStart !== null) write(cells.turnStart[j]!, arrived ? state.turnStart[j]! : 0)
  }
  write(cells.arrivedCount, state.arrivedCount)
  return writes
}

// Stop at a press's timestamp. The table holds a later state; the reply stops at `pressState`, the
// state at the press. The one write that always happens is arrivedCount. Segments that arrived after
// the press keep their widths and fade out in place. When the press fell inside a word that kept
// growing afterwards, that word's width goes back to its width at the press, which is a second write.
export function stopWrites(build: StreamBuild, table: Float32Array, pressState: FlowState): CellWrite[] {
  const {cells} = build
  const writes: CellWrite[] = []
  for (let j = 0; j < pressState.arrivedCount; j++) {
    if (table[cells.widths[j]!] !== Math.fround(pressState.widths[j]!)) writes.push({cell: cells.widths[j]!, value: pressState.widths[j]!})
    if (table[cells.breakAfter[j]!] !== pressState.breakAfter[j]!) writes.push({cell: cells.breakAfter[j]!, value: pressState.breakAfter[j]!})
  }
  writes.push({cell: cells.arrivedCount, value: pressState.arrivedCount})
  return writes
}

export function applyWrites(table: Float32Array, writes: readonly CellWrite[]): void {
  for (const {cell, value} of writes) table[cell] = value
}

// The float64 reference for a state: each segment's line index and x from pretext's lines, the line
// count, and the bubble rectangles, with the same layout constants as the circuit.
export type ReferenceLayout = {
  lineIndex: number[]
  x: number[]
  lineCount: number
  targetX: number[]
  targetY: number[]
  turns: {present: number, lineCount: number, width: number, top: number, left: number, height: number}[]
}

export function referenceLayout(
  state: FlowState,
  options: {layout: FlowLayout, columnWidth: number, turnCapacity: number, rightAlignedTurns: (turn: number) => boolean},
): ReferenceLayout {
  const {layout} = options
  const lineIndex: number[] = []
  const x: number[] = []
  const targetX: number[] = []
  const targetY: number[] = []
  const turns: ReferenceLayout['turns'] = []
  let linesBefore = 0
  let top = layout.top
  let offsetY = layout.top + layout.paddingY
  for (let turn = 0; turn < options.turnCapacity; turn++) {
    const turnLayout = state.turns[turn]
    const lineCount = turnLayout?.lineStarts.length ?? 0
    const present = lineCount > 0 ? 1 : 0
    // Bubble width is the widest painted line; the circuit reduces it over words' right edges.
    const width = turnLayout === undefined ? 0 : Math.max(0, ...turnLayout.lineWidths)
    const left = options.rightAlignedTurns(turn) ? options.columnWidth - width - 2 * layout.paddingX - layout.left : layout.left
    const height = lineCount * layout.lineHeight + present * 2 * layout.paddingY
    turns.push({present, lineCount, width, top, left, height})
    if (turnLayout !== undefined) {
      let line = 0
      let prefix = 0
      for (let j = turnLayout.firstSegment; j < turnLayout.firstSegment + turnLayout.segmentCount; j++) {
        while (line + 1 < turnLayout.lineStarts.length && turnLayout.lineStarts[line + 1]! <= j) {
          line++
          prefix = 0
        }
        lineIndex.push(linesBefore + line)
        x.push(prefix)
        targetX.push(left + layout.paddingX + prefix)
        targetY.push(offsetY + (linesBefore + line) * layout.lineHeight)
        prefix += state.widths[j]!
      }
    }
    linesBefore += lineCount
    top += lineCount * layout.lineHeight + present * (2 * layout.paddingY + layout.gap)
    offsetY += present * (2 * layout.paddingY + layout.gap)
  }
  return {lineIndex, x, lineCount: linesBefore, targetX, targetY, turns}
}

// Compares the circuit's layout outputs with the reference on arrived segments, the line count, the
// overflow outputs, and (when built) every bubble. Returns problem strings; empty means equal.
// Headless checks use exact equality. With real browser fonts, widths aren't multiples of 1/4 px, so
// FP32 sums and pretext's float64 sums can differ in their last bits; `tolerance` then allows that
// much difference on x, targets and bubble widths, while line indices and counts stay exact.
export function layoutMismatches(build: StreamBuild, table: Float32Array, state: FlowState, reference: ReferenceLayout, tolerance = 0): string[] {
  const outputs = build.outputs(build.compiled.evaluate(table))
  const differ = (actual: number, expected: number) => tolerance === 0 ? actual !== Math.fround(expected) : !(Math.abs(actual - expected) <= tolerance)
  const problems: string[] = []
  if (state.emergencyBreaks !== 0) problems.push('pretext broke inside a segment, which the fast walker does not handle')
  if (outputs.lineCount !== reference.lineCount) problems.push(`lineCount ${outputs.lineCount} vs ${reference.lineCount}`)
  if (outputs.windowOverflow !== 0) problems.push(`windowOverflow ${outputs.windowOverflow}`)
  if (outputs.moreLinesThanSlots !== 0) problems.push('more lines than slots')
  if (outputs.runOverflow !== 0) problems.push('runOverflow')
  if (outputs.turnOverflow !== 0) problems.push('turnOverflow')
  const arrived = table[build.cells.arrivedCount]!
  for (let j = 0; j < arrived; j++) {
    if (outputs.lineIndex[j] !== reference.lineIndex[j] || differ(outputs.x[j]!, reference.x[j]!)) {
      problems.push(`segment ${j}: line ${outputs.lineIndex[j]} x ${outputs.x[j]} vs line ${reference.lineIndex[j]} x ${reference.x[j]}`)
    }
    if (differ(outputs.targetX[j]!, reference.targetX[j]!) || outputs.targetY[j] !== Math.fround(reference.targetY[j]!)) {
      problems.push(`segment ${j}: target ${outputs.targetX[j]},${outputs.targetY[j]} vs ${reference.targetX[j]},${reference.targetY[j]}`)
    }
  }
  if (build.options.bubbles) {
    reference.turns.forEach((turn, index) => {
      const actual = [outputs.turnPresent[index], outputs.turnLineCount[index], outputs.turnWidth[index], outputs.turnTop[index], outputs.turnLeft[index], outputs.turnHeight[index]]
      const expected = [turn.present, turn.lineCount, turn.width, turn.top, turn.left, turn.height]
      // Presence, line count, top and height are integer arithmetic; width and left carry measured widths.
      const exactField = [true, true, false, true, false, true]
      if (actual.some((value, field) => exactField[field] ? value !== expected[field] : differ(value!, expected[field]!))) problems.push(`turn ${index}: ${actual.join(',')} vs ${expected.join(',')}`)
    })
  }
  return problems
}

// Line changes of already visible segments between two consecutive states: a segment that existed
// before and is on another line now. Counted from pretext's layouts.
export function lineHops(previous: ReferenceLayout | null, next: ReferenceLayout): {hops: number, growingSegmentHops: number} {
  if (previous === null) return {hops: 0, growingSegmentHops: 0}
  let hops = 0
  let growingSegmentHops = 0
  for (let j = 0; j < previous.lineIndex.length; j++) {
    if (previous.lineIndex[j] !== next.lineIndex[j]) {
      hops++
      if (j === previous.lineIndex.length - 1) growingSegmentHops++
    }
  }
  return {hops, growingSegmentHops}
}

// The largest segment count window the texts need: over every start, how far a line reaches at the
// widest width, plus one comparison that reports a window too small. Each turn is its own paragraph.
export function windowForTurns(pretext: Pretext, font: string, texts: readonly string[], maximumWidth: number, epsilon: number): number {
  let widest = 1
  for (const text of texts) {
    const view = viewPrepared(pretext.prepareWithSegments(text, font))
    const segmentCount = view.widths.length
    for (let start = 0; start < segmentCount; start++) {
      let lineWidth = view.widths[start]!
      let offset = 1
      while (start + offset < segmentCount) {
        const isBreak = view.kinds[start + offset] === 'space' || view.kinds[start + offset] === 'zero-width-break'
        const threshold = lineWidth + (isBreak ? 0 : view.widths[start + offset]!)
        if (threshold > maximumWidth + epsilon) break
        lineWidth += view.widths[start + offset]!
        offset++
      }
      widest = Math.max(widest, offset)
    }
  }
  return widest + 1
}

export function segmentCountOf(pretext: Pretext, font: string, texts: readonly string[]): number {
  return texts.reduce((total, text) => total + viewPrepared(pretext.prepareWithSegments(text, font)).widths.length, 0)
}

export function lineCountOf(pretext: Pretext, font: string, texts: readonly string[], width: number): number {
  return texts.reduce((total, text) => total + pretext.walkLineRanges(pretext.prepareWithSegments(text, font), width, () => {}), 0)
}
