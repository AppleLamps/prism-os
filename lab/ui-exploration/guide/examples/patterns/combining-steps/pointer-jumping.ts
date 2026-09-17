// Every line's start in a paragraph, from a next-start table, over the runtime in
// src/runtime/. nextStart[s] is the first segment of the next line when a line starts at
// segment s, and segmentCount means past the end. The walk follows the table one line
// at a time. Pointer jumping builds "where the line 2, 4, 8, ... lines later starts" by
// reading each table at the positions it holds, then reaches line L in about log2(L) reads.
import {Circuit, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'

// Greedy line breaking over segment widths, to make realistic tables for the tests.
export function greedyNextStarts(widths: readonly number[], maxLineWidth: number): number[] {
  return widths.map((width, start) => {
    let end = start + 1
    let lineWidth = width
    while (end < widths.length && lineWidth + widths[end]! <= maxLineWidth) {
      lineWidth += widths[end]!
      end++
    }
    return end
  })
}

// The loop. starts[line] is that line's first segment, or segmentCount for a line slot
// the paragraph doesn't use.
export function walkLineStarts(nextStart: readonly number[], lineSlots: number) {
  const segmentCount = nextStart.length
  const starts: number[] = []
  let start = 0
  for (let line = 0; line < lineSlots; line++) {
    starts.push(start)
    if (start < segmentCount) start = nextStart[start]!
  }
  return {starts, lineCount: starts.filter(lineStart => lineStart < segmentCount).length}
}

// The same result by pointer jumping in plain JS. jumps[level][s] is where the line
// 2^level lines after a line starting at s starts. A line starting past the end ends there.
export function jumpLineStarts(nextStart: readonly number[], lineSlots: number) {
  const segmentCount = nextStart.length
  const jumps: number[][] = [[...nextStart, segmentCount]]
  for (let level = 1; 2 ** level < lineSlots; level++) {
    const previous = jumps[level - 1]!
    jumps.push(previous.map(target => previous[target]!))
  }
  const starts = [0]
  for (let line = 1; line < lineSlots; line++) {
    // Line `line` is 2^level lines after line `line - 2^level`.
    const level = Math.floor(Math.log2(line))
    starts.push(jumps[level]![starts[line - 2 ** level]!]!)
  }
  return {starts, lineCount: starts.filter(lineStart => lineStart < segmentCount).length, jumps}
}

export type LineStartsForm = 'walk' | 'pointer jumping'

// Cells: nextStart[0] to nextStart[segmentCount - 1], each within 1..segmentCount, and
// nextStart[segmentCount - 1] must be segmentCount, as greedy line breaking gives.
export function buildLineStarts(segmentCount: number, lineSlots: number, form: LineStartsForm) {
  const circuit = new Circuit(segmentCount)
  const nextStart = Array.from({length: segmentCount}, (_, segment) => circuit.source(segment))
  for (const cell of nextStart) circuit.assumeRange(cell, 1, segmentCount)
  // Position segmentCount lies past the table and clamps to the last segment, whose
  // next start is always segmentCount, so no past-the-end entry is needed.
  const jumps: Wire[][] = [nextStart]
  if (form === 'pointer jumping') {
    for (let level = 1; 2 ** level < lineSlots; level++) {
      const previous = jumps[level - 1]!
      // Where the line 2^level lines later starts: jump 2^(level - 1) lines, twice.
      jumps.push(previous.map(target => circuit.indexRead(target, previous)))
    }
  }
  const starts: Wire[] = [circuit.affine([], 0)]
  for (let line = 1; line < lineSlots; line++) {
    const level = form === 'walk' ? 0 : Math.floor(Math.log2(line))
    // When the index is a constant, e.g. line 0's start, the builder picks the entry while building.
    starts.push(circuit.indexRead(starts[line - 2 ** level]!, jumps[level]!))
  }
  // [start < segmentCount] for an integer start within 0..segmentCount is
  // relu(segmentCount - start) - relu(segmentCount - 1 - start). Line 0 always exists.
  const lineCountTerms: [Wire, number][] = []
  for (const start of starts.slice(1)) {
    lineCountTerms.push(
      [circuit.reglu([], 1, [[start, -1]], segmentCount), 1],
      [circuit.reglu([], 1, [[start, -1]], segmentCount - 1), -1],
    )
  }
  const lineCount = circuit.affine(lineCountTerms, 1)
  return {circuit, nextStart, jumps, starts, lineCount, roots: [...starts, lineCount]}
}
