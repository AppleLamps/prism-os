// text-walker's feature ladder in miniature. For a fixed line start, the greedy walker's state (the line's
// width so far, and where the line would end) changes the same way whatever maxWidth is, until the first
// comparison against maxWidth + lineFitEpsilon fails. So JavaScript can follow the walker as if every
// comparison passes, and record each comparison as a candidate: the width the line would reach, and the line
// the walker would produce if that comparison were the first to fail. The circuit then only compares the
// recorded widths with this line's own width.
//
// text-walker/rows.ts derives the same lists from pretext's walkers, including hard breaks, long words, soft
// hyphens, letter spacing and tabs, and text-walker/rows-circuit.ts reads each line's list at that line's
// start through a one-hot, the way counting.ts reads line ends.
import {Circuit, invariant, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitFits} from './counting.ts'
import {lineFitEpsilon, type Line, type Paragraph} from './paragraph.ts'

export type Candidate = {
  // The line's width if this segment joins it. The comparison passes when fitWidth <= maxWidth + lineFitEpsilon.
  fitWidth: number
  // The line the walker produces when this comparison is the first to fail.
  lineIfFails: Line
}

export type CandidateList = {
  candidates: Candidate[]
  // The line when every comparison passes, i.e. the text ends first.
  lineIfAllFit: Line
}

// Follows paragraph.ts's layoutLineFrom with every comparison passing.
export function deriveCandidates(paragraph: Paragraph, lineStart: number): CandidateList {
  const {segmentWidths, breaksAfter} = paragraph
  const segmentCount = segmentWidths.length
  const candidates: Candidate[] = []
  let lineWidth = segmentWidths[lineStart]!
  // The line that ends just before `segment`, painted without its trailing space.
  const lineEndingBefore = (segment: number): Line => ({
    start: lineStart,
    end: segment,
    paintedWidth: breaksAfter[segment - 1] === 1 ? lineWidth - segmentWidths[segment - 1]! : lineWidth,
  })
  for (let segment = lineStart + 1; segment < segmentCount; segment++) {
    const width = segmentWidths[segment]!
    // A space hangs, so the walker never compares it, and it adds no candidate.
    if (breaksAfter[segment] === 0) candidates.push({fitWidth: lineWidth + width, lineIfFails: lineEndingBefore(segment)})
    lineWidth += width
  }
  return {candidates, lineIfAllFit: lineEndingBefore(segmentCount)}
}

// Plain JavaScript: the first candidate that doesn't fit gives the line.
export function lineFromCandidates(list: CandidateList, maxWidth: number): Line {
  for (const candidate of list.candidates) {
    if (candidate.fitWidth > maxWidth + lineFitEpsilon) return candidate.lineIfFails
  }
  return list.lineIfAllFit
}

export type CandidateSource = {
  sourceSize: number
  // Always 1.
  unit: Wire
  // This line's own width. Every line of a paragraph can have a different one.
  maxWidth: Wire
  // The line if the first candidate fails.
  firstEnd: Wire
  firstPaintedWidth: Wire
  // Per candidate: its fitWidth, and how much the line's end and painted width grow when it fits.
  fitWidths: Wire[]
  endChanges: Wire[]
  paintedWidthChanges: Wire[]
}

// Unused candidates get a fitWidth that no width in 0..4096 reaches, and changes of 0.
const unreachableWidth = 8192

export function writeCandidates(source: CandidateSource, list: CandidateList, maxWidth: number, table: Float32Array): void {
  const capacity = source.fitWidths.length
  invariant(list.candidates.length <= capacity, 'the line has more candidates than the circuit was built for')
  const outcomes = [...list.candidates.map(candidate => candidate.lineIfFails), list.lineIfAllFit]
  table[source.unit] = 1
  table[source.maxWidth] = maxWidth
  table[source.firstEnd] = outcomes[0]!.end
  table[source.firstPaintedWidth] = outcomes[0]!.paintedWidth
  for (let index = 0; index < capacity; index++) {
    const used = index < list.candidates.length
    table[source.fitWidths[index]!] = used ? list.candidates[index]!.fitWidth : unreachableWidth
    table[source.endChanges[index]!] = used ? outcomes[index + 1]!.end - outcomes[index]!.end : 0
    table[source.paintedWidthChanges[index]!] = used ? outcomes[index + 1]!.paintedWidth - outcomes[index]!.paintedWidth : 0
  }
}

// One line whose candidates are source cells. Any line start's list fits in the same circuit, and an edited
// word width means deriving the list again in JavaScript and rewriting cells, with no rebuild.
//   fits[c]      = [fitWidths[c] <= maxWidth + lineFitEpsilon]
//   lineEnd      = firstEnd          + sum over c of fits[c] * endChanges[c]
//   paintedWidth = firstPaintedWidth + sum over c of fits[c] * paintedWidthChanges[c]
// The fitWidths grow along the list, so the fitting candidates come first, and each sum adds the changes
// up to the first candidate that doesn't fit.
export function buildCandidateCircuit(segmentCount: number, capacity: number) {
  const source: CandidateSource = {
    sourceSize: 4 + 3 * capacity,
    unit: 0,
    maxWidth: 1,
    firstEnd: 2,
    firstPaintedWidth: 3,
    fitWidths: Array.from({length: capacity}, (_, index) => 4 + index),
    endChanges: Array.from({length: capacity}, (_, index) => 4 + capacity + index),
    paintedWidthChanges: Array.from({length: capacity}, (_, index) => 4 + 2 * capacity + index),
  }
  const circuit = new Circuit(source.sourceSize)
  circuit.assumeRange(source.unit, 1, 1)
  circuit.assumeRange(source.maxWidth, 0, 4096)
  circuit.assumeRange(source.firstEnd, 0, segmentCount)
  circuit.assumeRange(source.firstPaintedWidth, 0, 4096)
  for (const wire of source.fitWidths) circuit.assumeRange(wire, 0, unreachableWidth)
  for (const wire of source.endChanges) circuit.assumeRange(wire, 0, segmentCount)
  for (const wire of source.paintedWidthChanges) circuit.assumeRange(wire, 0, 4096)

  const endTerms: [Wire, number][] = [[source.firstEnd, 1]]
  const paintedTerms: [Wire, number][] = [[source.firstPaintedWidth, 1]]
  for (let index = 0; index < capacity; index++) {
    const fits = emitFits(circuit, source.unit, source.maxWidth, [[source.fitWidths[index]!, 1]])
    endTerms.push([circuit.multiply(source.endChanges[index]!, fits), 1])
    paintedTerms.push([circuit.multiply(source.paintedWidthChanges[index]!, fits), 1])
  }
  const lineEnd = circuit.roundAffine(endTerms)
  const paintedWidth = circuit.roundAffine(paintedTerms)
  const roots = [lineEnd, paintedWidth]
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const table = new Float32Array(source.sourceSize)
  return {
    circuit,
    roots,
    source,
    evaluate: (list: CandidateList, maxWidth: number): {lineEnd: number, paintedWidth: number} => {
      writeCandidates(source, list, maxWidth, table)
      const outputs = evaluateRoots(table)
      return {lineEnd: outputs[0]!, paintedWidth: outputs[1]!}
    },
  }
}
