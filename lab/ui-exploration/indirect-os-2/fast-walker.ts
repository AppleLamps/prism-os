// pretext's fast-path line walker (text, space and zero-width space segments, no
// letter spacing, every line at least as wide as the widest segment) as circuit
// arithmetic over runtime segment widths and break-after bits. Copied from
// text-walker/fast-walker.ts and trimmed to the gathered-lines formulation, with
// `attachFastCircuit` building the shared tables inside an existing circuit over
// existing source cells instead of creating its own source table.
//
// Shared tables, all computed in the circuit:
//   S[j]         inclusive prefix sum of widths, Brent-Kung network (exact for quarter-pixel widths)
//   T[j]         fit threshold: the prefix a line must stay within to keep segment j. Text counts its
//                own width; a space or zero-width break counts nothing, because it hangs.
//   paintEnd(j)  the painted prefix of a line that ends just before j: T[j-1]
//   skip(j)      how many break-after segments a line starting at j skips, counted up to runLimit.
//
// For a line starting at s, fits(o) = [T[s+o] - prefix(s) <= maxWidth + epsilon] is monotone in o
// (1..1 0..0), so "the first segment that does not fit" is a count.
import {type Circuit, type Terms, type Wire, invariant} from '../../../numeric-ui-core.ts'
import {viewPrepared} from './fake-canvas.ts'
import {type OneHot, fitBit, integerAtLeast, integerOneHot, maskedRead} from './text-kit.ts'

export type FastParagraph = {
  widths: number[]
  // 1 for space and zero-width break: they break after themselves, hang at a line end, paint
  // nothing there, and are skipped at the start of the next line.
  breakAfter: number[]
}

export function fastParagraph(prepared: object): FastParagraph {
  const view = viewPrepared(prepared)
  invariant(view.simpleLineWalkFastPath && view.letterSpacing === 0, 'fast walker needs pretext fast-path text')
  const breakAfter = view.kinds.map(kind => kind === 'space' || kind === 'zero-width-break' ? 1 : 0)
  invariant(breakAfter[0] === 0 && breakAfter[breakAfter.length - 1] === 0, 'paragraph must start and end with text')
  return {widths: [...view.widths], breakAfter}
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

export const maximumSegmentWidth = 2048
export const maximumLineWidth = 4096
// FP32 bound for the comparison score: 64 * span must stay within 2^23.
export const maximumParagraphWidth = 2 ** 17
// Added to thresholds read for an exhausted start, so nothing fits and the start stays at the end.
const exhaustedThresholdOffset = 8192

export type FastCircuit = {
  circuit: Circuit
  unit: Wire
  startCursor: Wire
  widthCells: readonly Wire[]
  breakAfterCells: readonly Wire[]
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
  for (const wire of prefix) circuit.assumeRange(wire, 0, maximumParagraphWidth)
  return prefix
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
    circuit, unit, startCursor, widthCells, breakAfterCells, segmentCount, runLimit, epsilon, zero,
    prefixTerms, prefixWire, inclusivePrefix, threshold, widthHead, deltaPaint, skipTerms, deltaSkip, runOverflow,
  }
}

function anyBit(fc: FastCircuit, bits: readonly Wire[]): Wire {
  return bits.length === 0 ? fc.zero : fc.circuit.roundAffine(bits.map(bit => [bit, 1] as const))
}

export type GatheredWalk = {
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
// width. With usable gates, a band whose gate is 0 lays out nothing and the start stays put.
export function walkGatheredLines(fc: FastCircuit, window: number, lineWidths: readonly Wire[], usable: readonly Wire[] | null): GatheredWalk {
  const {circuit, unit, segmentCount} = fc
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
        overflowBits.push(usable === null ? fits : circuit.multiply(fits, usable[line]!))
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
    if (usable === null) {
      widths.push(width)
      countTerms.push([notExhausted, 1])
      start = circuit.roundAffine(nextTerms, segmentCount)
    } else {
      const gate = usable[line]!
      widths.push(circuit.multiply(width, gate))
      countTerms.push([circuit.multiply(notExhausted, gate), 1])
      const advance = circuit.roundAffine([...nextTerms, [start, -1]], segmentCount)
      circuit.assumeRange(advance, 0, window + fc.runLimit)
      start = circuit.roundAffine([[start, 1], [circuit.multiply(advance, gate), 1]])
    }
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

export type SegmentGeometry = {lineIndex: Wire[], x: Wire[], y: Wire[], visible: Wire[]}

// Per segment: the index of its line slot, its x (slot left edge plus the width before it on its
// line), its y, and whether any slot laid it out, from the integer one-hot relus the walker built:
//   [start_k <= j] = 1 - [start_k >= j + 1]
//   lineIndex(j)  = sum over slots k >= 1 of [start_k <= j]
//   x(j)          = prefix(j) + sum over k of [start_k <= j] * ((left_k - startPrefix_k) - (left_(k-1) - startPrefix_(k-1)))
export function segmentGeometry(fc: FastCircuit, walk: GatheredWalk, lefts: readonly Wire[] | null, top: number, lineHeight: number): SegmentGeometry {
  const {circuit, segmentCount} = fc
  const offsets = walk.startPrefixes.map((prefix, line) => {
    const terms: [Wire, number][] = [[prefix, -1]]
    if (lefts !== null) terms.push([lefts[line]!, 1])
    if (line > 0) {
      terms.push([walk.startPrefixes[line - 1]!, 1])
      if (lefts !== null) terms.push([lefts[line - 1]!, -1])
    }
    const step = circuit.roundAffine(terms)
    circuit.assumeRange(step, -maximumParagraphWidth - maximumLineWidth, maximumParagraphWidth + maximumLineWidth)
    return step
  })
  const lineIndex: Wire[] = []
  const x: Wire[] = []
  const y: Wire[] = []
  const visible: Wire[] = []
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
    const slotCount = walk.oneHots.length - 1
    const index = circuit.roundAffine(indexTerms, slotCount)
    circuit.assumeRange(index, 0, slotCount)
    lineIndex.push(index)
    y.push(circuit.roundAffine(indexTerms.map(([wire, coefficient]) => [wire, coefficient * lineHeight] as const), top + slotCount * lineHeight))
    x.push(circuit.roundAffine(xTerms))
    visible.push(integerAtLeast(circuit, [[walk.finalStart, 1]], 0, j + 1))
  }
  return {lineIndex, x, y, visible}
}
