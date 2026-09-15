// pretext's line walkers restated as candidate rows, for the feature ladder.
//
// For a fixed start cursor, a line walker's state (line width, pending break, line end) evolves
// the same way whatever maxWidth is, until the first comparison against maxWidth + epsilon fails.
// So each start has a static, ordered list of candidates: the value a comparison checks, and the
// line the walker would produce if that comparison were the first to fail. The circuit only has
// to find the first failing candidate for the current width of that line.
//
// Raw candidate values can decrease along a line (with letter spacing, text charges its trailing
// gap and a following space does not), so thresholds are replaced by their running maximum: the
// first value above the width is also the first running maximum above it. With monotone bits,
//   outcome = outcome_0 + sum_c [threshold_c <= width] * (outcome_(c+1) - outcome_c)
// which is the same row shape phase 1 tabulated by sweeping pretext, derived here from the walker.
//
// The restatement mirrors line-break.ts for the Gecko profile: no return from an unfit soft hyphen,
// no WebKit NEL rule, no narrow tab stop skipping, and no entry geometry.
import {invariant} from '../../../numeric-ui-core.ts'
import {type PreparedView} from './fake-canvas.ts'

export type Cursor = {segmentIndex: number, graphemeIndex: number}

export type Outcome = {end: Cursor, width: number}

export type Candidate = {threshold: number, outcome: Outcome}

type SegmentKind = 'text' | 'space' | 'preserved-space' | 'tab' | 'glue' | 'zero-width-break' | 'soft-hyphen' | 'hard-break' | 'control'

function breaksAfter(kind: string): boolean {
  return kind === 'space' || kind === 'preserved-space' || kind === 'tab' || kind === 'zero-width-break' || kind === 'soft-hyphen'
}

function consumesAtLineStart(kind: string, atChunkStart: boolean): boolean {
  return kind === 'space' || kind === 'soft-hyphen' || (kind === 'zero-width-break' && !atChunkStart)
}

function getTabAdvance(lineWidth: number, tabStopAdvance: number, minimumAdvance: number): number {
  if (tabStopAdvance <= 0) return 0
  const remainder = lineWidth % tabStopAdvance
  if (Math.abs(remainder) <= 1e-6) return tabStopAdvance
  const advance = tabStopAdvance - remainder
  return advance < minimumAdvance ? advance + tabStopAdvance : advance
}

function getNextPreferredBreakIndex(preferredBreaks: number[], preferredBreakIndex: number, graphemeEnd: number): number {
  let low = preferredBreakIndex
  if (low >= preferredBreaks.length || preferredBreaks[low]! >= graphemeEnd) return low
  let high = preferredBreaks.length
  low++
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (preferredBreaks[middle]! < graphemeEnd) low = middle + 1
    else high = middle
  }
  return low
}

export const exhausted: unique symbol = Symbol('exhausted')

export type NormalizedStart = {cursor: Cursor, chunkIndex: number} | typeof exhausted

// normalizePreparedLineStart: skip consumable segments and consumed-only chunks, keep empty chunks.
export function normalizeStart(view: PreparedView, cursor: Cursor): NormalizedStart {
  const segmentCount = view.widths.length
  if (cursor.segmentIndex >= segmentCount) return exhausted
  let low = 0
  let high = view.chunks.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (cursor.segmentIndex < view.chunks[middle]!.consumedEndSegmentIndex) high = middle
    else low = middle + 1
  }
  if (low >= view.chunks.length) return exhausted
  if (cursor.graphemeIndex > 0) return {cursor, chunkIndex: low}
  let segmentIndex = cursor.segmentIndex
  for (let chunkIndex = low; chunkIndex < view.chunks.length; chunkIndex++) {
    const chunk = view.chunks[chunkIndex]!
    if (chunk.startSegmentIndex === chunk.endSegmentIndex && segmentIndex === chunk.startSegmentIndex) {
      return {cursor: {segmentIndex, graphemeIndex: 0}, chunkIndex}
    }
    if (segmentIndex < chunk.startSegmentIndex) segmentIndex = chunk.startSegmentIndex
    const atChunkStart = segmentIndex === chunk.startSegmentIndex
    while (segmentIndex < chunk.endSegmentIndex && consumesAtLineStart(view.kinds[segmentIndex]!, atChunkStart)) segmentIndex++
    if (segmentIndex < chunk.endSegmentIndex) return {cursor: {segmentIndex, graphemeIndex: 0}, chunkIndex}
    if (chunk.consumedEndSegmentIndex >= segmentCount) return exhausted
    segmentIndex = chunk.consumedEndSegmentIndex
  }
  return exhausted
}

function terminalLetterSpacing(view: PreparedView, start: Cursor, end: Cursor): number {
  const letterSpacing = view.letterSpacing
  if (letterSpacing === 0) return 0
  if (end.graphemeIndex > 0) return (view.spacingGraphemeCounts[end.segmentIndex] ?? 0) > 0 ? letterSpacing : 0
  if (end.graphemeIndex === 0 && end.segmentIndex > 0 && end.segmentIndex < view.kinds.length && view.kinds[end.segmentIndex - 1] === 'soft-hyphen') return 0
  for (let index = end.segmentIndex - 1; index >= start.segmentIndex; index--) {
    const kind = view.kinds[index]!
    if (kind === 'space' || kind === 'zero-width-break' || kind === 'hard-break' || kind === 'soft-hyphen') continue
    if (index === start.segmentIndex && start.graphemeIndex > 0) return letterSpacing
    return (view.spacingGraphemeCounts[index] ?? 0) > 0 ? letterSpacing : 0
  }
  return 0
}

function sameOutcome(left: Outcome, right: Outcome): boolean {
  return left.end.segmentIndex === right.end.segmentIndex && left.end.graphemeIndex === right.end.graphemeIndex && left.width === right.width
}

export type LineRow = {
  start: Cursor
  candidates: Candidate[]
  // The line if every candidate fits: the chunk or text ends first.
  final: Outcome
}

export type RowOptions = {
  // Segments at most this wide never take emergency breaks in the tested widths, so their
  // graphemes get no cursor units.
  emergencyFromWidth: number
}

function canEmergencyBreak(view: PreparedView, segmentIndex: number, options: RowOptions): boolean {
  const advances = view.breakableFitAdvances[segmentIndex]
  // A segment's fit at a line start includes its trailing letter spacing gap.
  const fitAtLineStart = view.widths[segmentIndex]! + Math.abs(view.letterSpacing)
  return advances !== null && advances !== undefined && advances.length > 1 && fitAtLineStart >= options.emergencyFromWidth
}

// One line of walkPreparedLinesSimple (the fast path), as candidates.
function simpleLineRow(view: PreparedView, start: Cursor, options: RowOptions): LineRow {
  const {widths, kinds} = view
  const candidates: Candidate[] = []
  let lineW = 0
  let hasContent = false
  let lineEnd: Cursor = {...start}
  let pendingBreakSegmentIndex = -1
  let pendingBreakPaintWidth = 0
  // appendBreakableSegmentFrom with every comparison passing; each grapheme after the first adds a candidate.
  const fill = (segmentIndex: number, startGraphemeIndex: number) => {
    const fitAdvances = view.breakableFitAdvances[segmentIndex]!
    const preferredBreaks = view.breakablePreferredBreaks[segmentIndex] ?? null
    let preferredBreakIndex = preferredBreaks === null ? -1 : getNextPreferredBreakIndex(preferredBreaks, 0, startGraphemeIndex + 1)
    let lastPreferredBreakEnd = -1
    let lastPreferredBreakWidth = 0
    for (let g = startGraphemeIndex; g < fitAdvances.length; g++) {
      const gw = fitAdvances[g]!
      if (!hasContent) {
        hasContent = true
        lineEnd = {segmentIndex, graphemeIndex: g + 1}
        lineW = gw
      } else {
        candidates.push({
          threshold: lineW + gw,
          outcome: preferredBreaks !== null && lastPreferredBreakEnd > startGraphemeIndex
            ? {end: {segmentIndex, graphemeIndex: lastPreferredBreakEnd}, width: lastPreferredBreakWidth}
            : {end: {...lineEnd}, width: lineW},
        })
        lineW += gw
        lineEnd = {segmentIndex, graphemeIndex: g + 1}
      }
      if (preferredBreaks !== null && preferredBreaks[preferredBreakIndex] === g + 1) {
        lastPreferredBreakEnd = g + 1
        lastPreferredBreakWidth = lineW
        preferredBreakIndex++
      }
    }
    if (hasContent && lineEnd.segmentIndex === segmentIndex && lineEnd.graphemeIndex === fitAdvances.length) {
      lineEnd = {segmentIndex: segmentIndex + 1, graphemeIndex: 0}
    }
  }
  for (let i = start.segmentIndex; i < widths.length; i++) {
    const w = widths[i]!
    const kind = kinds[i]!
    const breakAfter = breaksAfter(kind)
    if (!hasContent) {
      if (start.graphemeIndex > 0 && i === start.segmentIndex) fill(i, start.graphemeIndex)
      else if (canEmergencyBreak(view, i, options)) {
        fill(i, 0)
        // Merged with the whole-segment admission: the segment fits whole exactly when every
        // grapheme candidate fits, and then the line state matches starting with the whole segment.
        invariant(lineW === w && (candidates.length === 0 || candidates[candidates.length - 1]!.threshold === w), 'grapheme advances must add up to the segment width')
      } else {
        hasContent = true
        lineEnd = {segmentIndex: i + 1, graphemeIndex: 0}
        lineW = w
      }
      if (breakAfter) {
        pendingBreakSegmentIndex = i + 1
        pendingBreakPaintWidth = lineW - w
      }
      continue
    }
    let outcome: Outcome
    if (breakAfter) outcome = {end: {segmentIndex: i + 1, graphemeIndex: 0}, width: lineW}
    else if (pendingBreakSegmentIndex >= 0) {
      outcome = lineEnd.segmentIndex > pendingBreakSegmentIndex || (lineEnd.segmentIndex === pendingBreakSegmentIndex && lineEnd.graphemeIndex > 0)
        ? {end: {...lineEnd}, width: lineW}
        : {end: {segmentIndex: pendingBreakSegmentIndex, graphemeIndex: 0}, width: pendingBreakPaintWidth}
    } else outcome = {end: {...lineEnd}, width: lineW}
    candidates.push({threshold: lineW + w, outcome})
    lineW += w
    lineEnd = {segmentIndex: i + 1, graphemeIndex: 0}
    if (breakAfter) {
      pendingBreakSegmentIndex = i + 1
      pendingBreakPaintWidth = lineW - w
    }
  }
  return {start, candidates, final: {end: {...lineEnd}, width: lineW}}
}

// One line of walkPreparedComplexLines, as candidates.
function complexLineRow(view: PreparedView, start: Cursor, chunkIndex: number, options: RowOptions): LineRow {
  const {widths, kinds, letterSpacing, spacingGraphemeCounts, discretionaryHyphenWidth} = view
  invariant(view.entryGeometry === null || view.entryGeometry === undefined, 'entry geometry is not restated')
  const chunk = view.chunks[chunkIndex]!
  const candidates: Candidate[] = []
  if (chunk.startSegmentIndex === chunk.endSegmentIndex) {
    return {start, candidates, final: {end: {segmentIndex: chunk.consumedEndSegmentIndex, graphemeIndex: 0}, width: 0}}
  }
  let lineW = 0
  let hasContent = false
  let lineEnd: Cursor = {...start}
  let pendingBreakSegmentIndex = -1
  // The walker ends a line at the pending break only when this fit width fits. The rows always take
  // that branch, and the invariant at each candidate checks that the choice can't change the line.
  let pendingBreakFitWidth = 0
  let pendingBreakPaintWidth = 0
  let pendingBreakKind: string | null = null
  let zeroWidthPrefix = true
  let afterUnspacedControl = false
  const finish = (end: Cursor, width: number): Outcome => ({end: {...end}, width: width + terminalLetterSpacing(view, start, end)})
  const currentPaintWidth = () =>
    pendingBreakKind === 'soft-hyphen' && pendingBreakSegmentIndex === lineEnd.segmentIndex && lineEnd.graphemeIndex === 0 ? pendingBreakPaintWidth : lineW
  const lineEndContribution = (leading: number, contribution: number) => contribution === 0 ? 0 : leading + contribution
  const paintContribution = (kind: string, leading: number, w: number) => kind === 'space' || kind === 'zero-width-break' ? 0 : lineEndContribution(leading, w)
  const updatePending = (kind: string, breakAfter: boolean, i: number, w: number, leading: number, advance: number) => {
    if (!breakAfter) return
    pendingBreakSegmentIndex = i + 1
    pendingBreakFitWidth = lineW - advance
    pendingBreakPaintWidth = lineW - advance + paintContribution(kind, leading, w)
    pendingBreakKind = kind
  }
  const fill = (segmentIndex: number, startGraphemeIndex: number) => {
    const fitAdvances = view.breakableFitAdvances[segmentIndex]!
    const preferredBreaks = view.breakablePreferredBreaks[segmentIndex] ?? null
    let preferredBreakIndex = preferredBreaks === null ? -1 : getNextPreferredBreakIndex(preferredBreaks, 0, startGraphemeIndex + 1)
    let lastPreferredBreakEnd = -1
    let lastPreferredBreakWidth = 0
    for (let g = startGraphemeIndex; g < fitAdvances.length; g++) {
      const baseGw = fitAdvances[g]!
      if (!hasContent) {
        hasContent = true
        lineEnd = {segmentIndex, graphemeIndex: g + 1}
        lineW = baseGw
      } else {
        const gw = letterSpacing !== 0 ? baseGw + letterSpacing : baseGw
        const candidatePaintWidth = lineW + gw
        candidates.push({
          threshold: letterSpacing === 0 ? candidatePaintWidth : candidatePaintWidth + letterSpacing,
          outcome: preferredBreaks !== null && lastPreferredBreakEnd > startGraphemeIndex
            ? finish({segmentIndex, graphemeIndex: lastPreferredBreakEnd}, lastPreferredBreakWidth)
            : finish(lineEnd, currentPaintWidth()),
        })
        lineW = candidatePaintWidth
        lineEnd = {segmentIndex, graphemeIndex: g + 1}
      }
      if (preferredBreaks !== null && preferredBreaks[preferredBreakIndex] === g + 1) {
        lastPreferredBreakEnd = g + 1
        lastPreferredBreakWidth = lineW
        preferredBreakIndex++
      }
    }
    if (hasContent && lineEnd.segmentIndex === segmentIndex && lineEnd.graphemeIndex === fitAdvances.length) {
      lineEnd = {segmentIndex: segmentIndex + 1, graphemeIndex: 0}
    }
  }
  for (let i = start.segmentIndex; i < chunk.endSegmentIndex; i++) {
    const kind = kinds[i]! as SegmentKind
    invariant(kind !== 'control', 'the WebKit NEL rule is not restated')
    const breakAfter = breaksAfter(kind)
    const startGraphemeIndex = i === start.segmentIndex ? start.graphemeIndex : 0
    let leadingSpacing = 0
    if (letterSpacing !== 0 && (spacingGraphemeCounts[i] ?? 0) > 0) {
      if (hasContent && !zeroWidthPrefix && !afterUnspacedControl) leadingSpacing = letterSpacing
      afterUnspacedControl = spacingGraphemeCounts[i] === 0
    }
    if (kind !== 'zero-width-break') zeroWidthPrefix = false
    const w = kind === 'tab' ? getTabAdvance(lineW + leadingSpacing, view.tabStopAdvance, 0) : widths[i]!
    const advance = leadingSpacing + w
    if (kind === 'soft-hyphen' && startGraphemeIndex === 0) {
      if (hasContent) {
        lineEnd = {segmentIndex: i + 1, graphemeIndex: 0}
        if (i + 1 < chunk.endSegmentIndex) {
          pendingBreakSegmentIndex = i + 1
          pendingBreakFitWidth = lineW + discretionaryHyphenWidth
          pendingBreakPaintWidth = lineW + discretionaryHyphenWidth
          pendingBreakKind = kind
        }
      }
      continue
    }
    const trailingSpacing = letterSpacing !== 0 && (spacingGraphemeCounts[i] ?? 0) > 0 ? letterSpacing : 0
    const fitAdvance = (breakAfter ? kind !== 'tab' : w === 0) ? 0 : lineEndContribution(leadingSpacing, w + trailingSpacing)
    if (!hasContent) {
      if (startGraphemeIndex > 0) fill(i, startGraphemeIndex)
      else if (canEmergencyBreak(view, i, options)) {
        fill(i, 0)
        invariant(lineW === w && (candidates.length === 0 || candidates[candidates.length - 1]!.threshold === fitAdvance), 'grapheme advances must add up to the segment width')
      } else {
        hasContent = true
        lineEnd = {segmentIndex: i + 1, graphemeIndex: 0}
        lineW = w
      }
      updatePending(kind, breakAfter, i, w, leadingSpacing, advance)
      continue
    }
    // The line ends at the pending break or before i. pretext ends it at the pending break only when
    // pendingBreakFitWidth fits. Otherwise, without Blink's return from an unfit hyphen, it ends the
    // line at lineEnd with getCurrentLinePaintWidth.
    const atLineEnd = finish(lineEnd, currentPaintWidth())
    let notHanging = atLineEnd
    if (pendingBreakSegmentIndex >= 0) {
      const atPendingBreak = lineEnd.segmentIndex > pendingBreakSegmentIndex || (lineEnd.segmentIndex === pendingBreakSegmentIndex && lineEnd.graphemeIndex > 0)
        ? finish(lineEnd, currentPaintWidth())
        : finish({segmentIndex: pendingBreakSegmentIndex, graphemeIndex: 0}, pendingBreakPaintWidth)
      // The rows take the fitting branch. When this candidate is the first to fail, every earlier
      // candidate fits, so a fit width no larger than an earlier threshold (or than 0) fits as well.
      // Otherwise both branches must give the same line. For a soft hyphen right at the line end they
      // do, because currentPaintWidth, like pretext's getCurrentLinePaintWidth, already paints the
      // hyphen there. For a space right at the line end they don't, so its fit width must be proven.
      const provenToFit = candidates.reduce((largest, candidate) => Math.max(largest, candidate.threshold), 0)
      invariant(
        pendingBreakFitWidth <= provenToFit || sameOutcome(atPendingBreak, atLineEnd),
        'the line depends on whether the pending break fits, which the rows do not restate',
      )
      notHanging = atPendingBreak
    }
    if (breakAfter) {
      // A break-after segment that overflows hangs when the line before it fits: two candidates,
      // first "the line before it overflows", then "the segment itself overflows".
      candidates.push({threshold: lineW, outcome: notHanging})
      candidates.push({threshold: lineW + fitAdvance, outcome: finish({segmentIndex: i + 1, graphemeIndex: 0}, lineW + paintContribution(kind, leadingSpacing, w))})
    } else {
      candidates.push({threshold: lineW + fitAdvance, outcome: notHanging})
    }
    lineW += advance
    lineEnd = {segmentIndex: i + 1, graphemeIndex: 0}
    updatePending(kind, breakAfter, i, w, leadingSpacing, advance)
  }
  const consumedEnd = {segmentIndex: chunk.consumedEndSegmentIndex, graphemeIndex: 0}
  const final = pendingBreakSegmentIndex === chunk.consumedEndSegmentIndex && lineEnd.graphemeIndex === 0
    ? finish(consumedEnd, pendingBreakPaintWidth)
    : finish(consumedEnd, lineW)
  return {start, candidates, final}
}

export function lineRow(view: PreparedView, cursor: Cursor, options: RowOptions): LineRow | typeof exhausted {
  const normalized = normalizeStart(view, cursor)
  if (normalized === exhausted) return exhausted
  return view.simpleLineWalkFastPath
    ? simpleLineRow(view, normalized.cursor, options)
    : complexLineRow(view, normalized.cursor, normalized.chunkIndex, options)
}

// The line for a given width, read from the row the way the circuit reads it.
export function evaluateRow(row: LineRow, width: number, epsilon: number): Outcome {
  let running = -Infinity
  for (const candidate of row.candidates) {
    running = Math.max(running, candidate.threshold)
    if (running > width + epsilon) return candidate.outcome
  }
  return row.final
}

// Cursor positions a line can start or end at: every segment start, the graphemes of segments that
// can take emergency breaks, and the end of the text.
export type Units = {
  count: number
  cursors: Cursor[]
  index: (cursor: Cursor) => number
}

export function buildUnits(view: PreparedView, options: RowOptions): Units {
  const cursors: Cursor[] = []
  const bySegment: number[] = []
  for (let segmentIndex = 0; segmentIndex < view.widths.length; segmentIndex++) {
    bySegment.push(cursors.length)
    cursors.push({segmentIndex, graphemeIndex: 0})
    if (canEmergencyBreak(view, segmentIndex, options)) {
      for (let g = 1; g < view.breakableFitAdvances[segmentIndex]!.length; g++) cursors.push({segmentIndex, graphemeIndex: g})
    }
  }
  const count = cursors.length
  return {
    count,
    cursors,
    index: cursor => {
      if (cursor.segmentIndex >= view.widths.length) return count
      const unit = bySegment[cursor.segmentIndex]! + cursor.graphemeIndex
      invariant(
        cursors[unit]?.segmentIndex === cursor.segmentIndex && cursors[unit]?.graphemeIndex === cursor.graphemeIndex,
        `cursor ${cursor.segmentIndex}:${cursor.graphemeIndex} is inside a segment without grapheme units (width ${view.widths[cursor.segmentIndex]})`,
      )
      return unit
    },
  }
}

// A row in unit coordinates, with running-maximum thresholds, merged equal thresholds, and dropped
// candidates that change nothing. Outcomes are (lineStart, next start, end, width); an exhausted
// start produces (count, count, count, 0).
export type UnitOutcome = {lineStart: number, next: number, end: number, width: number}

export type UnitRow = {base: UnitOutcome, steps: {threshold: number, delta: UnitOutcome}[]}

// The row read the way the circuit reads it: the base outcome plus every step whose threshold fits.
export function evaluateUnitRow(row: UnitRow, width: number, epsilon: number): UnitOutcome {
  const outcome = {...row.base}
  for (const step of row.steps) {
    if (step.threshold > width + epsilon) break
    outcome.next += step.delta.next
    outcome.end += step.delta.end
    outcome.width += step.delta.width
  }
  return outcome
}

export function unitRow(view: PreparedView, units: Units, unit: number, options: RowOptions): UnitRow {
  const row = lineRow(view, units.cursors[unit] ?? {segmentIndex: view.widths.length, graphemeIndex: 0}, options)
  if (row === exhausted) return {base: {lineStart: units.count, next: units.count, end: units.count, width: 0}, steps: []}
  const lineStart = units.index(row.start)
  const toUnits = (outcome: Outcome): UnitOutcome => {
    const next = normalizeStart(view, outcome.end)
    return {lineStart, next: next === exhausted ? units.count : units.index(next.cursor), end: units.index(outcome.end), width: outcome.width}
  }
  const outcomes = [...row.candidates.map(candidate => toUnits(candidate.outcome)), toUnits(row.final)]
  const steps: {threshold: number, delta: UnitOutcome}[] = []
  let running = -Infinity
  for (let c = 0; c < row.candidates.length; c++) {
    running = Math.max(running, row.candidates[c]!.threshold)
    const from = outcomes[c]!
    const to = outcomes[c + 1]!
    const delta = {lineStart: 0, next: to.next - from.next, end: to.end - from.end, width: to.width - from.width}
    const last = steps[steps.length - 1]
    if (last !== undefined && last.threshold === running) {
      last.delta.next += delta.next
      last.delta.end += delta.end
      last.delta.width += delta.width
    } else steps.push({threshold: running, delta})
  }
  return {base: outcomes[0]!, steps: steps.filter(step => step.delta.next !== 0 || step.delta.end !== 0 || step.delta.width !== 0)}
}
