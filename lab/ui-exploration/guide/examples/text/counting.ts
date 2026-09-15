// Idea 2, the walker as arithmetic. The segment widths are source cells, so a word can change width,
// e.g. when it turns bold, without rebuilding the circuit.
//
// For a line that starts at the word lineStart, fits[j] = [the line from lineStart through segment j fits]
// reads 1, 1, ..., 1, 0, 0, ... as j grows, because widths are nonnegative. So the first segment that
// doesn't fit is lineStart + 1 + (the number of ones): a count, not a search.
import {Circuit, type Terms, type Wire} from '../../../../../numeric-ui-core.ts'
import {lineFitEpsilon, type Paragraph} from './paragraph.ts'

export type WalkerSource = {
  sourceSize: number
  // Always 1.
  unit: Wire
  maxWidth: Wire
  // The first line's start, as a runtime cell, even though it's always 0. The builder evaluates sums of
  // constants while building, so a one-hot built from a constant start would turn into duplicate wires,
  // which assumeOneHot rejects.
  firstLineStart: Wire
  segmentWidths: Wire[]
}

export function createWalkerSource(segmentCount: number): WalkerSource {
  return {
    sourceSize: 3 + segmentCount,
    unit: 0,
    maxWidth: 1,
    firstLineStart: 2,
    segmentWidths: Array.from({length: segmentCount}, (_, index) => 3 + index),
  }
}

export function writeWalkerSource(source: WalkerSource, segmentWidths: readonly number[], maxWidth: number): Float32Array {
  const table = new Float32Array(source.sourceSize)
  table[source.unit] = 1
  table[source.maxWidth] = maxWidth
  table[source.firstLineStart] = 0
  segmentWidths.forEach((width, index) => {
    table[source.segmentWidths[index]!] = width
  })
  return table
}

// [span <= maxWidth + lineFitEpsilon] as an exact bit (text-walker/kit.ts's fitBit). The score
// 64 * (maxWidth + epsilon - span) + 0.5 is clamped into 0..1 by two ReLUs and rounded by the boolean atom.
// The span terms come first, then maxWidth, then the constant, so large terms cancel before the small
// constant is added. When every width and maxWidth are multiples of 1/64 px, and 64 * span stays below
// 2^24, the sum before the constant is an exact integer k = 64 * (maxWidth - span), so the score is about
// k + 0.82: at least 0.75 when the line fits (k >= 0), and below 0 when it doesn't (k <= -1).
// 4 operations, 3 layers.
export function emitFits(circuit: Circuit, unit: Wire, maxWidth: Wire, spanTerms: Terms): Wire {
  const terms: [Wire, number][] = spanTerms.map(([wire, coefficient]) => [wire, -64 * coefficient])
  terms.push([maxWidth, 64], [unit, 64 * lineFitEpsilon + 0.5])
  const score = circuit.roundAffine(terms)
  const positive = circuit.reglu([], 1, [[score, 1]], 0)
  const aboveOne = circuit.reglu([], 1, [[score, 1]], -1)
  const clamped = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// The line that starts at the word `lineStart`:
//   fits[j]      = [widths lineStart..j, leaving out a space's own width, <= maxWidth + epsilon]
//   lineEnd      = lineStart + 1 + (sum over j of fits[j])
//   paintedWidth = width of the first word + sum over j of fits[j] * (what segment j adds to the painted width)
// A space adds nothing while it's the last segment on the line; its width is added with the word after it.
export function emitLineEnd(circuit: Circuit, source: WalkerSource, paragraph: Paragraph, lineStart: number): {lineEnd: Wire, paintedWidth: Wire} {
  const widths = source.segmentWidths
  const {breaksAfter} = paragraph
  const endTerms: [Wire, number][] = []
  const paintedTerms: [Wire, number][] = [[widths[lineStart]!, 1]]
  for (let segment = lineStart + 1; segment < widths.length; segment++) {
    const spanTerms: [Wire, number][] = []
    for (let index = lineStart; index < segment; index++) spanTerms.push([widths[index]!, 1])
    if (breaksAfter[segment] === 0) spanTerms.push([widths[segment]!, 1])
    const fits = emitFits(circuit, source.unit, source.maxWidth, spanTerms)
    endTerms.push([fits, 1])
    const addedTerms: [Wire, number][] = []
    if (breaksAfter[segment - 1] === 1) addedTerms.push([widths[segment - 1]!, 1])
    if (breaksAfter[segment] === 0) addedTerms.push([widths[segment]!, 1])
    if (addedTerms.length === 0) continue
    const added = addedTerms.length === 1 ? addedTerms[0]![0] : circuit.roundAffine(addedTerms)
    paintedTerms.push([circuit.multiply(added, fits), 1])
  }
  const lineEnd = circuit.roundAffine(endTerms, lineStart + 1)
  circuit.assumeRange(lineEnd, lineStart + 1, widths.length)
  const paintedWidth = circuit.roundAffine(paintedTerms)
  circuit.assumeRange(paintedWidth, 0, 65536)
  return {lineEnd, paintedWidth}
}

// members[p] = [x == p] for an integer wire x in 0..count, and all zeros when x == count. The hat
// relu(x - p + 1) - 2 relu(x - p) + relu(x - p - 1) is 1 at p and 0 at every other integer, and neighboring
// positions share their ReLUs, so this costs about 2 operations per position.
export function emitIntegerOneHot(circuit: Circuit, unit: Wire, x: Wire, count: number, createdWires: Set<Wire>): Wire[] {
  const relus = new Map<number, Wire>()
  // relu(x - j) as terms. For j <= 0 it's x - j itself, because x >= 0.
  const reluTerms = (j: number, factor: number): [Wire, number][] => {
    if (j <= 0) return j === 0 ? [[x, factor]] : [[x, factor], [unit, -j * factor]]
    let wire = relus.get(j)
    if (wire === undefined) {
      wire = circuit.reglu([], 1, [[x, 1]], -j)
      createdWires.add(wire)
      relus.set(j, wire)
    }
    return [[wire, factor]]
  }
  const members: Wire[] = []
  for (let position = 0; position < count; position++) {
    const member = circuit.roundAffine([...reluTerms(position - 1, 1), ...reluTerms(position, -2), ...reluTerms(position + 1, 1)])
    circuit.assumeRange(member, 0, 1)
    createdWires.add(member)
    members.push(member)
  }
  circuit.assumeOneHot(members, true)
  return members
}

// sum over p of members[p] * values[p]: reads `values` at the position the one-hot marks. The compiler
// lowers this sum to one gather read, so the products never run, but the one-hot itself still does.
export function emitMaskedRead(circuit: Circuit, members: readonly Wire[], values: readonly Wire[]): Wire {
  return circuit.roundAffine(members.map((member, position): [Wire, number] => [circuit.multiply(values[position]!, member), 1]))
}

export type WalkerOutputs = {
  // In word order: where a line that starts at that word ends, and that line's painted width.
  lineEnds: number[]
  paintedWidths: number[]
  // Per line slot: its start (the segment count once the text has ended), and its painted width.
  slotStarts: number[]
  slotWidths: number[]
  lineCount: number
  // The start after the last slot. Below the segment count, the text needs more slots than the circuit has.
  finalStart: number
}

export type WalkerCircuit = {
  circuit: Circuit
  wordStarts: number[]
  // The line ends and painted widths for every word start, without line slots.
  tableRoots: Wire[]
  roots: Wire[]
  oneHotWires: ReadonlySet<Wire>
  evaluate: (segmentWidths: readonly number[], maxWidth: number) => WalkerOutputs
}

export function buildWalkerCircuit(paragraph: Paragraph, lineSlots: number): WalkerCircuit {
  const segmentCount = paragraph.segmentWidths.length
  const source = createWalkerSource(segmentCount)
  const circuit = new Circuit(source.sourceSize)
  circuit.assumeRange(source.unit, 1, 1)
  circuit.assumeRange(source.maxWidth, 0, 4096)
  circuit.assumeRange(source.firstLineStart, 0, segmentCount)
  for (const cell of source.segmentWidths) circuit.assumeRange(cell, 0, 2048)
  const zero = circuit.roundAffine([[source.unit, 0]])
  circuit.assumeRange(zero, 0, 0)

  // The next-start table: every word's line end and painted width, computed in parallel.
  const wordStarts: number[] = []
  const lineEnds: Wire[] = []
  const paintedWidths: Wire[] = []
  // lineEnd - segmentCount per segment, so a slot past the end, whose one-hot is all zeros, reads 0 and stays at the end.
  const nextMinusCount: Wire[] = []
  const widthBySegment: Wire[] = []
  for (let segment = 0; segment < segmentCount; segment++) {
    if (paragraph.breaksAfter[segment] === 1) {
      // A line never starts at a space, so these entries are never read.
      nextMinusCount.push(zero)
      widthBySegment.push(zero)
      continue
    }
    const {lineEnd, paintedWidth} = emitLineEnd(circuit, source, paragraph, segment)
    wordStarts.push(segment)
    lineEnds.push(lineEnd)
    paintedWidths.push(paintedWidth)
    const shifted = circuit.roundAffine([[lineEnd, 1]], -segmentCount)
    circuit.assumeRange(shifted, -segmentCount, 0)
    nextMinusCount.push(shifted)
    widthBySegment.push(paintedWidth)
  }

  // Line slots: line k + 1 starts where line k ends, a runtime integer, so reading the table there needs a one-hot.
  const oneHotWires = new Set<Wire>()
  let start: Wire = source.firstLineStart
  const slotStarts: Wire[] = []
  const slotWidths: Wire[] = []
  const countTerms: [Wire, number][] = []
  for (let slot = 0; slot < lineSlots; slot++) {
    const members = emitIntegerOneHot(circuit, source.unit, start, segmentCount, oneHotWires)
    slotStarts.push(start)
    slotWidths.push(emitMaskedRead(circuit, members, widthBySegment))
    // The members add up to 1 while the start is inside the text, and to 0 once it reaches the end.
    for (const member of members) countTerms.push([member, 1])
    start = circuit.roundAffine([[emitMaskedRead(circuit, members, nextMinusCount), 1]], segmentCount)
    circuit.assumeRange(start, 0, segmentCount)
  }
  const lineCount = circuit.roundAffine(countTerms)

  const tableRoots = [...lineEnds, ...paintedWidths]
  const roots = [lineCount, start, ...slotStarts, ...slotWidths, ...tableRoots]
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const wordCount = wordStarts.length
  return {
    circuit,
    wordStarts,
    tableRoots,
    roots,
    oneHotWires,
    evaluate: (segmentWidths, maxWidth) => {
      const outputs = Array.from(evaluateRoots(writeWalkerSource(source, segmentWidths, maxWidth)))
      return {
        lineCount: outputs[0]!,
        finalStart: outputs[1]!,
        slotStarts: outputs.slice(2, 2 + lineSlots),
        slotWidths: outputs.slice(2 + lineSlots, 2 + 2 * lineSlots),
        lineEnds: outputs.slice(2 + 2 * lineSlots, 2 + 2 * lineSlots + wordCount),
        paintedWidths: outputs.slice(2 + 2 * lineSlots + wordCount),
      }
    },
  }
}
