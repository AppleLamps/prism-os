// pretext's fast-path line walker (text, space and zero-width break segments, no
// letter spacing, every line at least as wide as the widest segment) as circuit
// arithmetic over runtime segment widths and break-after bits, plus the circuit
// helpers it builds on: exact integer comparisons, integer one-hots and masked
// reads. Ported from lab/ui-exploration/text-walker's fast-walker.ts and its helpers,
// through indirect-os-2's trimmed copies, fast-walker.ts and text-kit.ts, which were
// validated line for line against pretext's layoutNextLineRange; notes.ts builds the
// Notes flow on it. indirect-os-2 was removed on September 16, 2026, and stays at
// https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2
//
// Shared tables, all computed in the circuit:
//   S[j]         inclusive prefix sum of widths, a Brent-Kung network (exact for widths on a 1/64 px grid)
//   T[j]         fit threshold: the prefix a line must stay within to keep segment j. Text counts its
//                own width; a space or zero-width break counts nothing, because it hangs.
//   paintEnd(j)  the painted prefix of a line that ends just before j: T[j-1]
//   skip(j)      how many break-after segments a line starting at j skips, counted up to runLimit.
//
// For a line starting at s, fits(o) = [T[s+o] - prefix(s) <= maxWidth + epsilon] is monotone in o
// (1..1 0..0), so "the first segment that does not fit" is a count.
import {type Circuit, type Terms, type Wire, invariant} from './numeric-ui-core.ts'

// A paragraph as the walker sees it: one width per segment, and 1 for each
// segment that breaks after itself (a space or a zero-width break), which hangs
// at a line end, paints nothing there, and is skipped at the start of the next
// line. Every other segment is text.
export type FastParagraph = {
  widths: number[]
  breakAfter: number[]
}

// The largest segment count window a paragraph needs: over every start, how far the line reaches
// at the widest width, plus one comparison that reports a window too small.
export function fastWindow(paragraph: FastParagraph, maximumWidth: number, epsilon: number): number {
  const segmentCount = paragraph.widths.length
  let widest = 1
  for (let start = 0; start < segmentCount; start++) {
    let lineWidth = paragraph.widths[start]!
    let offset = 1
    while (start + offset < segmentCount) {
      const threshold = lineWidth + (paragraph.breakAfter[start + offset] === 1 ? 0 : paragraph.widths[start + offset]!)
      if (threshold > maximumWidth + epsilon) break
      lineWidth += paragraph.widths[start + offset]!
      offset++
    }
    widest = Math.max(widest, offset)
  }
  return widest + 1
}

export function longestBreakAfterRun(breakAfter: readonly number[]): number {
  let longest = 1
  let run = 0
  for (const bit of breakAfter) {
    run = bit === 1 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

export const maximumSegmentWidth = 2048
const maximumLineWidth = 4096
// FP32 bound for the comparison score: 64 * span must stay within 2^23.
const maximumParagraphWidth = 2 ** 17
// Added to thresholds read for an exhausted start, so nothing fits and the start stays at the end.
const exhaustedThresholdOffset = 8192

function relu(circuit: Circuit, terms: Terms, bias = 0): Wire {
  return circuit.reglu([], 1, terms, bias)
}

// [spanTerms <= limit + epsilon], rounded into an exact bit by the boolean atom.
// The score is 64 * (limit + epsilon - span) + 0.5, accumulated span first, then the limit, then
// the offset through the unit cell, so large prefix terms cancel before small ones are added.
// Exact whenever |limit + epsilon - span| >= 1/128 plus FP32 rounding of the terms, which holds
// for spans and limits on a 1/64 px grid because every such difference is at least epsilon = 0.005.
// With epsilon = 1/64 (Safari), a span exactly 1/64 past the limit scores exactly 0.5, which the
// boolean rounds up to 1: the span fits, like pretext's strict `span > limit + epsilon` test.
// Costs 4 live operations and 3 layers: the score, two relus, and the boolean with the clamp
// composed into its terms.
function fitBit(circuit: Circuit, unit: Wire, spanTerms: Terms, limit: Wire, epsilon: number): Wire {
  const terms: [Wire, number][] = spanTerms.map(([wire, coefficient]) => [wire, -64 * coefficient])
  terms.push([limit, 64], [unit, 64 * epsilon + 0.5])
  const score = circuit.roundAffine(terms)
  const positive = relu(circuit, [[score, 1]])
  const aboveOne = relu(circuit, [[score, 1]], -1)
  const clamped = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// [terms + bias >= threshold] for an integer-valued affine expression, exact below 2^24. 2 relus,
// composes into consumers.
export function integerAtLeast(circuit: Circuit, terms: Terms, bias: number, threshold: number): Wire {
  const upper = relu(circuit, terms, bias - threshold + 1)
  const lower = relu(circuit, terms, bias - threshold)
  const bit = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

type OneHot = {
  // members[p] = [x == low + p]
  members: Wire[]
  // [x >= j] as an affine form over the shared relus, for j in low..low + count.
  atLeast: (j: number) => Terms
}

// One-hot of an integer wire x over positions low..low+count-1. x must lie in low..low+count-1, or
// equal low+count when allowAllZero is set, which gives all zeros. Uses the hat function
// relu(x-p+1) - 2 relu(x-p) + relu(x-p-1), so neighboring members share relus: count relus plus
// count members, about 2 atoms per position.
function integerOneHot(circuit: Circuit, unit: Wire, x: Wire, low: number, count: number, allowAllZero: boolean): OneHot {
  // r(j) = relu(x - j) as terms. For j <= low it is x - j itself, because x >= low.
  const relus = new Map<number, Wire>()
  const r = (j: number): Terms => {
    if (j <= low) return j === 0 ? [[x, 1]] : [[x, 1], [unit, -j]]
    let wire = relus.get(j)
    if (wire === undefined) {
      wire = relu(circuit, [[x, 1]], -j)
      relus.set(j, wire)
    }
    return [[wire, 1]]
  }
  const scale = (terms: Terms, coefficient: number): [Wire, number][] =>
    terms.map(([wire, value]) => [wire, value * coefficient])
  const members: Wire[] = []
  for (let position = low; position < low + count; position++) {
    const member = circuit.roundAffine([
      ...scale(r(position - 1), 1),
      ...scale(r(position), -2),
      ...scale(r(position + 1), 1),
    ])
    circuit.assumeRange(member, 0, 1)
    members.push(member)
  }
  circuit.assumeOneHot(members, allowAllZero)
  return {
    members,
    atLeast: j => [...scale(r(j - 1), 1), ...scale(r(j), -1)],
  }
}

// Sum of bit * value over a declared one-hot group. The compiler lowers it to a gather read.
function maskedRead(circuit: Circuit, members: readonly Wire[], values: readonly Wire[]): Wire {
  return circuit.roundAffine(members.map((bit, position) => [circuit.multiply(values[position]!, bit), 1] as const))
}

function brentKungPrefix(circuit: Circuit, values: readonly Wire[]): Wire[] {
  const prefix = [...values]
  const count = values.length
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) {
      prefix[index] = circuit.roundAffine([[prefix[index - span]!, 1], [prefix[index]!, 1]])
    }
  }
  for (span = span / 4; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) {
      prefix[index] = circuit.roundAffine([[prefix[index - span]!, 1], [prefix[index]!, 1]])
    }
  }
  for (const wire of prefix) circuit.assumeRange(wire, 0, maximumParagraphWidth, {allowExistingReaders: true})
  return prefix
}

export type FastCircuit = {
  circuit: Circuit
  unit: Wire
  startCursor: Wire
  widthCells: readonly Wire[]
  segmentCount: number
  runLimit: number
  epsilon: number
  zero: Wire
  prefixTerms: (s: number) => Terms
  prefixWire: (s: number) => Wire
  inclusivePrefix: Wire[]
  threshold: Wire[]
  widthHead: Wire[]
  deltaPaint: (j: number) => Wire
  skipTerms: (j: number) => Terms
  deltaSkip: (j: number) => Wire
  // How many positions start a run of break-after segments longer than runLimit; 0 when skip(j) is exact.
  runOverflow: Wire
}

// The shared tables over existing source cells: the paragraph's width cells, its
// break-after bit cells, and the cell holding the segment index the first line
// starts at.
export function attachFastCircuit(
  circuit: Circuit,
  unit: Wire,
  cells: {startCursor: Wire, widthCells: readonly Wire[], breakAfterCells: readonly Wire[]},
  epsilon: number,
  runLimit: number,
): FastCircuit {
  invariant(Number.isInteger(runLimit) && runLimit >= 1, 'runLimit must be a positive integer')
  const {startCursor, widthCells, breakAfterCells} = cells
  const segmentCount = widthCells.length
  invariant(segmentCount >= 1 && breakAfterCells.length === segmentCount, 'a paragraph needs one break-after bit per segment')
  const zero = circuit.roundAffine([[unit, 0]])
  circuit.assumeRange(zero, 0, 0)

  const inclusivePrefix = brentKungPrefix(circuit, widthCells)
  const prefixTerms = (s: number): Terms => s === 0 ? [] : [[inclusivePrefix[s - 1]!, 1]]
  const prefixWire = (s: number): Wire => s === 0 ? zero : inclusivePrefix[s - 1]!

  const hangingWidth = widthCells.map((width, index) => circuit.multiply(width, breakAfterCells[index]!))
  const threshold = inclusivePrefix.map((prefix, index) => {
    const wire = circuit.roundAffine([[prefix, 1], [hangingWidth[index]!, -1]])
    circuit.assumeRange(wire, 0, maximumParagraphWidth)
    return wire
  })
  const widthHead = widthCells.map((width, index) => {
    const wire = circuit.roundAffine([[width, 1], [hangingWidth[index]!, -1]])
    circuit.assumeRange(wire, 0, maximumSegmentWidth)
    return wire
  })
  const paintEnd = (j: number): Wire => j >= segmentCount ? inclusivePrefix[segmentCount - 1]! : threshold[j - 1]!
  const deltaPaintCache = new Map<number, Wire>()
  const deltaPaint = (j: number): Wire => {
    let wire = deltaPaintCache.get(j)
    if (wire === undefined) {
      wire = circuit.roundAffine([[paintEnd(j + 1), 1], [paintEnd(j), -1]])
      circuit.assumeRange(wire, 0, maximumSegmentWidth)
      deltaPaintCache.set(j, wire)
    }
    return wire
  }
  // run(j, k) = breakAfter[j] * ... * breakAfter[j + k - 1]
  const runCache = new Map<string, Wire>()
  const run = (j: number, k: number): Wire => {
    if (k === 1) return breakAfterCells[j]!
    const key = `${j}:${k}`
    let wire = runCache.get(key)
    if (wire === undefined) {
      wire = circuit.multiply(run(j, k - 1), breakAfterCells[j + k - 1]!)
      circuit.assumeRange(wire, 0, 1)
      runCache.set(key, wire)
    }
    return wire
  }
  const skipTerms = (j: number): Terms => {
    const terms: [Wire, number][] = []
    for (let k = 1; k <= runLimit && j + k - 1 < segmentCount; k++) terms.push([run(j, k), 1])
    return terms
  }
  const deltaSkipCache = new Map<number, Wire>()
  const deltaSkip = (j: number): Wire => {
    let wire = deltaSkipCache.get(j)
    if (wire === undefined) {
      const terms = [...skipTerms(j + 1), ...skipTerms(j).map(([bit, coefficient]) => [bit, -coefficient] as const)]
      wire = terms.length === 0 ? zero : circuit.roundAffine(terms)
      circuit.assumeRange(wire, -runLimit, runLimit)
      deltaSkipCache.set(j, wire)
    }
    return wire
  }
  // run(j, runLimit + 1) is 1 exactly where a run longer than runLimit starts.
  const overflowTerms: [Wire, number][] = []
  for (let j = 0; j + runLimit < segmentCount; j++) overflowTerms.push([run(j, runLimit + 1), 1])
  const runOverflow = overflowTerms.length === 0 ? zero : circuit.roundAffine(overflowTerms)
  circuit.assumeRange(runOverflow, 0, segmentCount)
  return {
    circuit, unit, startCursor, widthCells, segmentCount, runLimit, epsilon, zero,
    prefixTerms, prefixWire, inclusivePrefix, threshold, widthHead, deltaPaint, skipTerms, deltaSkip, runOverflow,
  }
}

function anyBit(fc: FastCircuit, bits: readonly Wire[]): Wire {
  return bits.length === 0 ? fc.zero : fc.circuit.roundAffine(bits.map(bit => [bit, 1] as const))
}

type GatheredWalk = {
  starts: Wire[]
  // Painted width of each slot's line; 0 for exhausted slots and for unusable bands.
  widths: Wire[]
  startPrefixes: Wire[]
  oneHots: OneHot[]
  finalStart: Wire
  lineCount: Wire
  windowOverflow: Wire
}

// The line walker with one integer one-hot per line slot and comparisons against that slot's own
// width. A band whose usable gate is 0 lays out nothing and the start stays put.
export function walkGatheredLines(fc: FastCircuit, window: number, lineWidths: readonly Wire[], usable: readonly Wire[]): GatheredWalk {
  const {circuit, unit, segmentCount} = fc
  invariant(Number.isInteger(window) && window >= 2, 'the walker window must be at least 2 segments')
  invariant(usable.length === lineWidths.length, 'one usable bit per line slot')
  const thresholdMinusOffset = fc.threshold.map(wire => {
    const shifted = circuit.roundAffine([[wire, 1]], -exhaustedThresholdOffset)
    circuit.assumeRange(shifted, -exhaustedThresholdOffset, maximumParagraphWidth - exhaustedThresholdOffset)
    return shifted
  })
  const pastEnd = fc.inclusivePrefix[segmentCount - 1]!
  const shiftedThreshold: Wire[][] = []
  const shiftedDeltaSkip: Wire[][] = []
  const shiftedDeltaPaint: Wire[][] = []
  for (let offset = 1; offset <= window; offset++) {
    const positions = Array.from({length: segmentCount}, (_, s) => s + offset)
    shiftedThreshold.push(positions.map(j => j < segmentCount ? thresholdMinusOffset[j]! : pastEnd))
    shiftedDeltaSkip.push(positions.map(j => j < segmentCount ? fc.deltaSkip(j) : fc.zero))
    shiftedDeltaPaint.push(positions.map(j => j < segmentCount ? fc.deltaPaint(j) : fc.zero))
  }
  const nextHead = Array.from({length: segmentCount}, (_, s) => {
    const wire = circuit.roundAffine(fc.skipTerms(s + 1), s + 1 - segmentCount)
    circuit.assumeRange(wire, s + 1 - segmentCount, fc.runLimit)
    return wire
  })
  const prefixAtStart = Array.from({length: segmentCount}, (_, s) => fc.prefixWire(s))
  let start: Wire = fc.startCursor
  const starts: Wire[] = []
  const widths: Wire[] = []
  const startPrefixes: Wire[] = []
  const oneHots: OneHot[] = []
  const countTerms: [Wire, number][] = []
  const overflowBits: Wire[] = []
  for (let line = 0; line < lineWidths.length; line++) {
    const oneHot = integerOneHot(circuit, unit, start, 0, segmentCount, true)
    oneHots.push(oneHot)
    starts.push(start)
    const startPrefix = maskedRead(circuit, oneHot.members, prefixAtStart)
    startPrefixes.push(startPrefix)
    const nextTerms: [Wire, number][] = [[maskedRead(circuit, oneHot.members, nextHead), 1]]
    const widthTerms: [Wire, number][] = [[maskedRead(circuit, oneHot.members, fc.widthHead), 1]]
    for (let offset = 1; offset <= window; offset++) {
      const threshold = maskedRead(circuit, oneHot.members, shiftedThreshold[offset - 1]!)
      const fits = fitBit(circuit, unit, [[threshold, 1], [unit, exhaustedThresholdOffset], [startPrefix, -1]], lineWidths[line]!, fc.epsilon)
      if (offset === window) {
        overflowBits.push(circuit.multiply(fits, usable[line]!))
        break
      }
      nextTerms.push([fits, 1], [circuit.multiply(maskedRead(circuit, oneHot.members, shiftedDeltaSkip[offset - 1]!), fits), 1])
      widthTerms.push([circuit.multiply(maskedRead(circuit, oneHot.members, shiftedDeltaPaint[offset - 1]!), fits), 1])
    }
    const width = circuit.roundAffine(widthTerms)
    circuit.assumeRange(width, 0, maximumLineWidth + maximumSegmentWidth)
    // notExhausted = [start <= N - 1]
    const notExhausted = circuit.roundAffine(oneHot.atLeast(segmentCount).map(([wire, coefficient]) => [wire, -coefficient] as const), 1)
    circuit.assumeRange(notExhausted, 0, 1)
    const gate = usable[line]!
    widths.push(circuit.multiply(width, gate))
    countTerms.push([circuit.multiply(notExhausted, gate), 1])
    const advance = circuit.roundAffine([...nextTerms, [start, -1]], segmentCount)
    circuit.assumeRange(advance, 0, window + fc.runLimit)
    start = circuit.roundAffine([[start, 1], [circuit.multiply(advance, gate), 1]])
    circuit.assumeRange(start, 0, segmentCount)
  }
  return {
    starts,
    widths,
    startPrefixes,
    oneHots,
    finalStart: start,
    lineCount: circuit.roundAffine(countTerms),
    windowOverflow: anyBit(fc, overflowBits),
  }
}

type SegmentGeometry = {x: Wire[], y: Wire[], visible: Wire[]}

// Per segment: its x (its slot's left edge plus the width before it on its line), its y, and
// whether any slot laid it out, from the integer one-hot relus the walker built:
//   [start_k <= j] = 1 - [start_k >= j + 1]
//   lineIndex(j)  = sum over slots k >= 1 of [start_k <= j]
//   x(j)          = prefix(j) + sum over k of [start_k <= j] * ((left_k - startPrefix_k) - (left_(k-1) - startPrefix_(k-1)))
export function segmentGeometry(fc: FastCircuit, walk: GatheredWalk, lefts: readonly Wire[], top: number, lineHeight: number): SegmentGeometry {
  const {circuit, segmentCount} = fc
  invariant(lefts.length === walk.oneHots.length, 'one left edge per line slot')
  const offsets = walk.startPrefixes.map((prefix, line) => {
    const terms: [Wire, number][] = [[prefix, -1], [lefts[line]!, 1]]
    if (line > 0) terms.push([walk.startPrefixes[line - 1]!, 1], [lefts[line - 1]!, -1])
    const step = circuit.roundAffine(terms)
    circuit.assumeRange(step, -maximumParagraphWidth - maximumLineWidth, maximumParagraphWidth + maximumLineWidth)
    return step
  })
  const x: Wire[] = []
  const y: Wire[] = []
  const visible: Wire[] = []
  const slotCount = walk.oneHots.length - 1
  for (let j = 0; j < segmentCount; j++) {
    const indexTerms: [Wire, number][] = []
    const xTerms: (readonly [Wire, number])[] = [...fc.prefixTerms(j)]
    for (let line = 0; line < walk.oneHots.length; line++) {
      const atLeastNext = walk.oneHots[line]!.atLeast(j + 1)
      if (line > 0) for (const [wire, coefficient] of atLeastNext) indexTerms.push([wire, -coefficient])
      const reached = circuit.roundAffine(atLeastNext.map(([wire, coefficient]) => [wire, -coefficient] as const), 1)
      circuit.assumeRange(reached, 0, 1)
      xTerms.push([circuit.multiply(offsets[line]!, reached), 1])
    }
    y.push(circuit.roundAffine(indexTerms.map(([wire, coefficient]) => [wire, coefficient * lineHeight] as const), top + slotCount * lineHeight))
    x.push(circuit.roundAffine(xTerms))
    visible.push(integerAtLeast(circuit, [[walk.finalStart, 1]], 0, j + 1))
  }
  return {x, y, visible}
}
