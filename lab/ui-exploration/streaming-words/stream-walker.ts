// pretext's fast-path line walker over a fixed capacity of segments, for text that streams in.
//
// Derived from lab/ui-exploration/text-walker/fast-walker.ts (createFastCircuit, walkGatheredLines,
// segmentGeometry). Read that file's header for the arithmetic: prefix sums, fit thresholds, painted
// prefixes, skip counts, and one integer one-hot per line slot that gathers the thresholds after the
// slot's start. The changes for streaming:
//
// - arrivedCount is a source cell. A segment that hasn't arrived has width 0 and break-after 0, so it
//   always fits and glues onto the end of the last arrived line. Arrived segments get pretext's line
//   index and x on the prefix text; only outputs that describe the whole text need the arrived count.
// - windowOverflow and moreLinesThanSlots are masked at the arrived count. A line whose window runs
//   past the last arrived segment only glues zero-width segments, so its overflow isn't real.
//   Likewise, lines that start at or after arrivedCount don't need a slot.
// - Turns. turnStart[j] is 1 at the first segment of a new speaker's turn. A forced break adds
//   turnOffset into the prefix sums at every turn start, the way code-points' grapheme-editor-circuit.ts adds a newline offset
//   into its position keys. For a line starting at s, the fit span of segment s + o then includes
//   turnOffset times the number of turn starts in s+1..s+o, so no line reaches past a turn start.
//   The prefix read at a line start, P(s), includes the start's own offset, so a line that begins
//   at a turn start still fits its own words:
//     W'[j] = width[j] + turnOffset * turnStart[j]
//     S'[j] = W'[0] + ... + W'[j]
//     T'[j] = S'[j] - breakAfter[j] * width[j]           (fit threshold)
//     P(j)  = S'[j - 1] + turnOffset * turnStart[j]        (prefix at the start of segment j)
//   Segments in one turn see the same offsets, so their x within a line is unchanged.
import {Circuit, invariant, type Terms, type Wire} from '../../../numeric-ui-core.ts'
import {fitBit, integerAtLeast, integerOneHot, integerSteps, maskedRead, type IntegerSteps, type OneHot} from './kit.ts'

export const maximumSegmentWidth = 2048
export const maximumLineWidth = 2048
// FP32 bound for the comparison score: 64 * span must stay within 2^23.
export const maximumParagraphWidth = 2 ** 17
// Larger than any line width, so a span that crosses a turn start never fits.
export const turnOffset = 4096
// Added to thresholds read for an exhausted start, so nothing fits and the start stays at the end.
const exhaustedThresholdOffset = 8192

export type WalkerCells = {
  unit: Wire
  maxWidth: Wire
  // A runtime cell rather than a constant, so one-hots built from it don't fold into duplicates.
  startCursor: Wire
  arrivedCount: Wire
  widths: Wire[]
  breakAfter: Wire[]
  // 1 at the first segment of each turn after the first, or null for a single reply. turnStart[0]
  // is never read, because segment 0 always starts a line.
  turnStart: Wire[] | null
}

export type WalkerOptions = {
  // How many segments after a line start get compared; must cover the longest arrived line.
  window: number
  lineSlots: number
  epsilon: number
  // The longest run of break-after segments handled; see fast-walker.ts's skip(j).
  runLimit: number
}

export type Walker = {
  segmentCount: number
  zero: Wire
  widthHead: Wire[]
  // Per segment: the line index across the whole flow, and x within its line.
  lineIndex: Wire[]
  x: Wire[]
  // Per line slot.
  starts: Wire[]
  lineWidths: Wire[]
  slotOneHots: OneHot[]
  finalStart: Wire
  // [arrivedCount >= j] over shared relus.
  arrivedSteps: IntegerSteps
  // Nonzero when a bound chosen at build time is too small for the arrived text.
  windowOverflow: Wire
  moreLinesThanSlots: Wire
  runOverflow: Wire
  // Per segment: how many turn starts are at or before it, i.e. its turn index. null without turns.
  turnIndex: Wire[] | null
}

function brentKungPrefix(circuit: Circuit, values: readonly Wire[], maximum: number): Wire[] {
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
  for (const wire of prefix) circuit.assumeRange(wire, 0, maximum, {allowExistingReaders: true})
  return prefix
}

function negate(terms: Terms): [Wire, number][] {
  return terms.map(([wire, coefficient]) => [wire, -coefficient])
}

// `mark` is called with a phase name before each part is built, so reports can count live
// operations per phase.
export function buildWalker(circuit: Circuit, cells: WalkerCells, options: WalkerOptions, mark: (name: string) => void = () => {}): Walker {
  const {unit, widths, breakAfter, turnStart} = cells
  const segmentCount = widths.length
  const {window, runLimit} = options
  invariant(Number.isInteger(runLimit) && runLimit >= 1, 'runLimit must be a positive integer')
  invariant(window >= 2 && options.lineSlots >= 1, 'window and line slots are too small')
  mark('walker: prefix sums, fit thresholds, skip counts')
  const zero = circuit.roundAffine([[unit, 0]])
  circuit.assumeRange(zero, 0, 0)

  const offsetWidths = turnStart === null ? widths : widths.map((width, j) => {
    if (j === 0) return width
    const wire = circuit.roundAffine([[width, 1], [turnStart[j]!, turnOffset]])
    circuit.assumeRange(wire, 0, maximumSegmentWidth + turnOffset)
    return wire
  })
  const inclusivePrefix = brentKungPrefix(circuit, offsetWidths, maximumParagraphWidth)
  const hangingWidth = widths.map((width, j) => circuit.multiply(width, breakAfter[j]!))
  const threshold = inclusivePrefix.map((prefix, j) => {
    const wire = circuit.roundAffine([[prefix, 1], [hangingWidth[j]!, -1]])
    circuit.assumeRange(wire, 0, maximumParagraphWidth)
    return wire
  })
  const widthHead = widths.map((width, j) => {
    const wire = circuit.roundAffine([[width, 1], [hangingWidth[j]!, -1]])
    circuit.assumeRange(wire, 0, maximumSegmentWidth)
    return wire
  })
  const prefixAtStart = widths.map((_, j) => {
    if (j === 0) return zero
    if (turnStart === null) return inclusivePrefix[j - 1]!
    const wire = circuit.roundAffine([[inclusivePrefix[j - 1]!, 1], [turnStart[j]!, turnOffset]])
    circuit.assumeRange(wire, 0, maximumParagraphWidth)
    return wire
  })
  const paintEnd = (j: number): Wire => j >= segmentCount ? inclusivePrefix[segmentCount - 1]! : threshold[j - 1]!
  const deltaPaintCache = new Map<number, Wire>()
  const deltaPaint = (j: number): Wire => {
    let wire = deltaPaintCache.get(j)
    if (wire === undefined) {
      wire = circuit.roundAffine([[paintEnd(j + 1), 1], [paintEnd(j), -1]])
      circuit.assumeRange(wire, 0, 2 * maximumSegmentWidth + turnOffset)
      deltaPaintCache.set(j, wire)
    }
    return wire
  }
  // run(j, k) = breakAfter[j] * ... * breakAfter[j + k - 1]
  const runCache = new Map<string, Wire>()
  const run = (j: number, k: number): Wire => {
    if (k === 1) return breakAfter[j]!
    const key = `${j}:${k}`
    let wire = runCache.get(key)
    if (wire === undefined) {
      wire = circuit.multiply(run(j, k - 1), breakAfter[j + k - 1]!)
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
      const terms = [...skipTerms(j + 1), ...negate(skipTerms(j))]
      wire = terms.length === 0 ? zero : circuit.roundAffine(terms)
      circuit.assumeRange(wire, -runLimit, runLimit)
      deltaSkipCache.set(j, wire)
    }
    return wire
  }
  const overflowTerms: [Wire, number][] = []
  for (let j = 0; j + runLimit < segmentCount; j++) overflowTerms.push([run(j, runLimit + 1), 1])
  const runOverflow = overflowTerms.length === 0 ? zero : circuit.roundAffine(overflowTerms)
  circuit.assumeRange(runOverflow, 0, segmentCount)

  // The line walk: one integer one-hot per slot, thresholds gathered for the window after it.
  mark('walker: line slots (one-hots, gathered thresholds, fit bits, overflow masks)')
  const thresholdMinusOffset = threshold.map(wire => {
    const shifted = circuit.roundAffine([[wire, 1]], -exhaustedThresholdOffset)
    circuit.assumeRange(shifted, -exhaustedThresholdOffset, maximumParagraphWidth - exhaustedThresholdOffset)
    return shifted
  })
  // Past the end of the capacity the threshold is the whole flow plus the offset, so nothing fits.
  // An exhausted start reads zeros, which gives the offset alone against a start prefix of zero.
  const pastEnd = inclusivePrefix[segmentCount - 1]!
  const shiftedThreshold: Wire[][] = []
  const shiftedDeltaSkip: Wire[][] = []
  const shiftedDeltaPaint: Wire[][] = []
  for (let offset = 1; offset <= window; offset++) {
    const positions = Array.from({length: segmentCount}, (_, s) => s + offset)
    shiftedThreshold.push(positions.map(j => j < segmentCount ? thresholdMinusOffset[j]! : pastEnd))
    shiftedDeltaSkip.push(positions.map(j => j < segmentCount ? deltaSkip(j) : zero))
    shiftedDeltaPaint.push(positions.map(j => j < segmentCount ? deltaPaint(j) : zero))
  }
  const nextHead = Array.from({length: segmentCount}, (_, s) => {
    const wire = circuit.roundAffine(skipTerms(s + 1), s + 1 - segmentCount)
    circuit.assumeRange(wire, s + 1 - segmentCount, runLimit)
    return wire
  })
  const arrivedSteps = integerSteps(circuit, unit, cells.arrivedCount, 0)
  let start: Wire = cells.startCursor
  const starts: Wire[] = []
  const lineWidths: Wire[] = []
  const startPrefixes: Wire[] = []
  const slotOneHots: OneHot[] = []
  const overflowBits: Wire[] = []
  for (let line = 0; line < options.lineSlots; line++) {
    const oneHot = integerOneHot(circuit, unit, start, 0, segmentCount, true)
    slotOneHots.push(oneHot)
    starts.push(start)
    const startPrefix = maskedRead(circuit, oneHot.members, prefixAtStart)
    startPrefixes.push(startPrefix)
    const nextTerms: [Wire, number][] = [[maskedRead(circuit, oneHot.members, nextHead), 1]]
    const widthTerms: [Wire, number][] = [[maskedRead(circuit, oneHot.members, widthHead), 1]]
    for (let offset = 1; offset <= window; offset++) {
      const gathered = maskedRead(circuit, oneHot.members, shiftedThreshold[offset - 1]!)
      const fits = fitBit(circuit, unit, [[gathered, 1], [unit, exhaustedThresholdOffset], [startPrefix, -1]], cells.maxWidth, options.epsilon)
      if (offset === window) {
        // Real only when segment start + window has arrived: arrivedCount - start >= window + 1.
        const arrivedPastWindow = integerAtLeast(circuit, [[cells.arrivedCount, 1], [start, -1]], 0, window + 1)
        overflowBits.push(circuit.multiply(fits, arrivedPastWindow))
        break
      }
      nextTerms.push([fits, 1], [circuit.multiply(maskedRead(circuit, oneHot.members, shiftedDeltaSkip[offset - 1]!), fits), 1])
      widthTerms.push([circuit.multiply(maskedRead(circuit, oneHot.members, shiftedDeltaPaint[offset - 1]!), fits), 1])
    }
    const width = circuit.roundAffine(widthTerms)
    circuit.assumeRange(width, 0, maximumParagraphWidth)
    lineWidths.push(width)
    start = circuit.roundAffine(nextTerms, segmentCount)
    circuit.assumeRange(start, 0, segmentCount)
  }
  const windowOverflow = overflowBits.length === 0 ? zero : circuit.roundAffine(overflowBits.map(bit => [bit, 1] as const))
  // Some arrived segment starts after the last slot's line: arrivedCount - finalStart >= 1.
  const moreLinesThanSlots = integerAtLeast(circuit, [[cells.arrivedCount, 1], [start, -1]], 0, 1)

  // Per segment geometry from the slot one-hots' shared relus:
  //   [start_k <= j] = 1 - [start_k >= j + 1]
  //   lineIndex(j)  = sum over slots k >= 1 of [start_k <= j]
  //   x(j)          = P(j) - P(start of j's line), written as a sum over slots that telescopes
  mark('walker: per-segment line index and x')
  const offsets = startPrefixes.map((prefix, line) => {
    const terms: [Wire, number][] = [[prefix, -1]]
    if (line > 0) terms.push([startPrefixes[line - 1]!, 1])
    const step = circuit.roundAffine(terms)
    circuit.assumeRange(step, -maximumParagraphWidth, maximumParagraphWidth)
    return step
  })
  const lineIndex: Wire[] = []
  const x: Wire[] = []
  const slotCount = slotOneHots.length - 1
  for (let j = 0; j < segmentCount; j++) {
    const indexTerms: [Wire, number][] = []
    const xTerms: [Wire, number][] = [[prefixAtStart[j]!, 1]]
    for (let line = 0; line < slotOneHots.length; line++) {
      const atLeastNext = slotOneHots[line]!.atLeast(j + 1)
      if (line > 0) indexTerms.push(...negate(atLeastNext))
      const reached = circuit.roundAffine(negate(atLeastNext), 1)
      circuit.assumeRange(reached, 0, 1)
      xTerms.push([circuit.multiply(offsets[line]!, reached), 1])
    }
    const index = circuit.roundAffine(indexTerms, slotCount)
    circuit.assumeRange(index, 0, slotCount)
    lineIndex.push(index)
    const xWire = circuit.roundAffine(xTerms)
    circuit.assumeRange(xWire, -maximumParagraphWidth, maximumParagraphWidth)
    x.push(xWire)
  }

  let turnIndex: Wire[] | null = null
  if (turnStart !== null) {
    mark('walker: turn index per segment')
    turnIndex = brentKungPrefix(circuit, [zero, ...turnStart.slice(1)], segmentCount)
  }
  return {
    segmentCount, zero, widthHead, lineIndex, x, starts, lineWidths, slotOneHots, finalStart: start,
    arrivedSteps, windowOverflow, moreLinesThanSlots, runOverflow, turnIndex,
  }
}
