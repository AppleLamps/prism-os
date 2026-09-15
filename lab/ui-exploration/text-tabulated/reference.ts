// Direct pretext calls that the circuit's outputs are checked against, independent of the tables.

import {layout, layoutWithLines, measureLineStats, walkLineRanges, type LayoutLine, type PreparedTextWithSegments} from './pretext/layout.ts'
import {materializeSlot, type BlockView, type NotesBlock} from './notes-machine.ts'

// Copied from pretext's pages/demos/bubbles-shared.ts (findTightWrapMetrics), without the line height.
export function findTightWrapWidth(prepared: PreparedTextWithSegments, maxWidth: number): {width: number, lineCount: number, maxLineWidth: number} {
  const initialLineCount = layout(prepared, maxWidth, 1).lineCount
  let lo = 1
  let hi = Math.max(1, Math.ceil(maxWidth))
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const midLineCount = layout(prepared, mid, 1).lineCount
    if (midLineCount <= initialLineCount) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  let maxLineWidth = 0
  const lineCount = walkLineRanges(prepared, lo, line => {
    if (line.width > maxLineWidth) maxLineWidth = line.width
  })
  return {width: lo, lineCount, maxLineWidth}
}

export type ReferenceBlock = {
  lineCount: number
  maxLineWidth: number
  layoutWidth: number
  lines: LayoutLine[]
}

export function referenceBlock(block: NotesBlock, contentWidth: number): ReferenceBlock {
  const maxWidth = block.spec.maxWidthAt(contentWidth)
  if (block.spec.mode === 'plain') {
    const stats = measureLineStats(block.prepared, maxWidth)
    const result = layoutWithLines(block.prepared, maxWidth, block.lineHeight)
    if (stats.lineCount !== result.lineCount) throw new Error('measureLineStats and layoutWithLines disagree on line count')
    return {lineCount: stats.lineCount, maxLineWidth: stats.maxLineWidth, layoutWidth: maxWidth, lines: result.lines}
  }
  const tight = findTightWrapWidth(block.prepared, maxWidth)
  const stats = measureLineStats(block.prepared, tight.width)
  const result = layoutWithLines(block.prepared, tight.width, block.lineHeight)
  return {lineCount: stats.lineCount, maxLineWidth: stats.maxLineWidth, layoutWidth: tight.width, lines: result.lines}
}

export type BlockComparison = {
  // Wrong line counts, tight widths, cursors, or line text. These outputs are decisions: each one is
  // either right or wrong.
  decisionProblems: string[]
  // |circuit maxLineWidth - pretext maxLineWidth|. Delta rows add up width deltas in FP32, so this is 0
  // only when every partial sum is exact, e.g. with the dyadic fake canvas.
  maxLineWidthDrift: number
  // Largest |circuit x - expected x| over a centered heading's lines, which also add up line widths.
  lineXDrift: number
}

// Compares a block's circuit outputs with pretext at the circuit's content width.
export function compareBlock(block: NotesBlock, view: BlockView, contentWidth: number): BlockComparison {
  const expected = referenceBlock(block, contentWidth)
  const decisionProblems: string[] = []
  if (view.lineCount !== expected.lineCount) decisionProblems.push(`lineCount ${view.lineCount} != ${expected.lineCount}`)
  if (view.layoutWidth !== null && view.layoutWidth !== expected.layoutWidth) decisionProblems.push(`layoutWidth ${view.layoutWidth} != ${expected.layoutWidth}`)
  if (expected.lines.length > view.slots.length) decisionProblems.push(`${expected.lines.length} lines but ${view.slots.length} slots`)
  const maxLineWidthDrift = Math.abs(view.maxLineWidth - Math.fround(expected.maxLineWidth))
  let lineXDrift = 0
  const endId = block.table.cursors.length - 1
  for (let index = 0; index < view.slots.length; index++) {
    const slot = view.slots[index]!
    const line = expected.lines[index]
    if (line === undefined) {
      if (slot.start !== endId || slot.end !== endId) decisionProblems.push(`slot ${index} should be empty`)
      continue
    }
    const start = block.table.cursors[slot.start]
    const end = block.table.cursors[slot.end]
    if (start === undefined || end === undefined) {
      decisionProblems.push(`slot ${index} has cursor ids ${slot.start}, ${slot.end} outside the table`)
      continue
    }
    if (start.segmentIndex !== line.start.segmentIndex || start.graphemeIndex !== line.start.graphemeIndex) decisionProblems.push(`slot ${index} start`)
    if (end.segmentIndex !== line.end.segmentIndex || end.graphemeIndex !== line.end.graphemeIndex) decisionProblems.push(`slot ${index} end`)
    const text = materializeSlot(block, slot.start, slot.end)
    if (text !== line.text) decisionProblems.push(`slot ${index} text ${JSON.stringify(text)} != ${JSON.stringify(line.text)}`)
    if (block.kind === 'heading') lineXDrift = Math.max(lineXDrift, Math.abs(slot.x! - Math.fround(contentWidth * 0.5 - line.width * 0.5)))
  }
  return {decisionProblems, maxLineWidthDrift, lineXDrift}
}
