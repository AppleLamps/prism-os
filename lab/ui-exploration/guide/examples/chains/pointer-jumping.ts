// Every line start of a paragraph from a next-start table, by following the table
// one line at a time, and by pointer jumping. nextStart[s] is the first segment of
// the next line when a line starts at segment s. Following it from segment 0 gives
// every line's start.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'

// Greedy line breaking over segment widths, only to make realistic tables for the tests.
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

// The familiar loop. starts[line] is that line's first segment, or segmentCount for
// a line slot the paragraph doesn't use.
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

// The same result by pointer jumping, in plain JS. jumps[level][s] is where 2^level
// lines starting at segment s end. Position segmentCount means past the end, and a
// line starting there ends there.
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
  return {starts, lineCount: starts.filter(lineStart => lineStart < segmentCount).length}
}

// [value >= threshold] for an integer-valued wire: relu(value - threshold + 1) - relu(value - threshold)
// is exactly 0 or 1.
function atLeast(circuit: Circuit, value: Wire, threshold: number): Wire {
  return circuit.affine([
    [circuit.reglu([], 1, [[value, 1]], 1 - threshold), 1],
    [circuit.reglu([], 1, [[value, 1]], -threshold), -1],
  ])
}

// table[index] for an integer-valued index in 0..table.length - 1. The shared runtime
// has no instruction that reads at a computed index, so this builds the index's
// one-hot, member j = [index >= j] - [index >= j + 1], and the masked sum
// table[0] × member 0 + table[1] × member 1 + ... Declaring the members as a one-hot
// group lets the compiler replace the masked sum with one gather read, but the
// one-hot itself still costs about 3 operations per table entry.
export function readAtIndex(circuit: Circuit, table: readonly Wire[], index: Wire): Wire {
  const reached = (threshold: number) =>
    threshold <= 0 || threshold >= table.length ? null : atLeast(circuit, index, threshold)
  const members = table.map((_, position) => {
    const terms: [Wire, number][] = []
    const atOrAbove = reached(position)
    const above = reached(position + 1)
    if (atOrAbove !== null) terms.push([atOrAbove, 1])
    if (above !== null) terms.push([above, -1])
    return circuit.affine(terms, position === 0 ? 1 : 0)
  })
  circuit.assumeOneHot(members)
  const read = circuit.affine(members.map((member, position): [Wire, number] => [
    circuit.multiply(table[position]!, member),
    1,
  ]))
  circuit.assumeRange(read, 0, table.length - 1)
  return read
}

export type LineStartsCircuit = {
  circuit: Circuit
  nextStartCells: Wire[]
  // The start of every line slot, then the line count.
  roots: Wire[]
}

export function buildLineStarts(
  segmentCount: number,
  lineSlots: number,
  form: 'sequential' | 'pointer jumping',
): LineStartsCircuit {
  const circuit = new Circuit(segmentCount)
  const nextStartCells = Array.from({length: segmentCount}, (_, segment) => circuit.source(segment))
  for (const cell of nextStartCells) circuit.assumeRange(cell, 1, segmentCount)
  const pastTheEnd = circuit.affine([], segmentCount)
  const jumps: Wire[][] = [[...nextStartCells, pastTheEnd]]
  if (form === 'pointer jumping') {
    for (let level = 1; 2 ** level < lineSlots; level++) {
      const previous = jumps[level - 1]!
      // Where 2^level lines starting at `start` end: jump 2^(level - 1) lines, twice.
      jumps.push(previous.map((target, start) =>
        start === segmentCount ? pastTheEnd : readAtIndex(circuit, previous, target)))
    }
  }
  const starts: Wire[] = [circuit.affine([], 0)]
  for (let line = 1; line < lineSlots; line++) {
    const level = form === 'sequential' ? 0 : Math.floor(Math.log2(line))
    const earlierLine = line - 2 ** level
    // Reading at the constant index 0 needs no one-hot.
    starts.push(earlierLine === 0
      ? jumps[level]![0]!
      : readAtIndex(circuit, jumps[level]!, starts[earlierLine]!))
  }
  // [start < segmentCount] for an integer start is relu(n - start) - relu(n - 1 - start).
  const lineCountTerms: [Wire, number][] = []
  for (const start of starts.slice(1)) {
    lineCountTerms.push(
      [circuit.reglu([], 1, [[start, -1]], segmentCount), 1],
      [circuit.reglu([], 1, [[start, -1]], segmentCount - 1), -1],
    )
  }
  // Line 0 always exists.
  const lineCount = circuit.affine(lineCountTerms, 1)
  return {circuit, nextStartCells, roots: [...starts, lineCount]}
}
