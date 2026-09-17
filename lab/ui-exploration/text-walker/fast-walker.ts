// The fast path of pretext's line walker (text, space and zero-width space segments, no letter
// spacing, every line at least as wide as the widest segment) as circuit arithmetic over runtime
// segment widths and runtime break-after bits. The widths and bits are source cells, so editing a
// width re-breaks the paragraph without recompiling.
//
// Shared tables, all computed in the circuit:
//   S[j]         inclusive prefix sum of widths, Brent-Kung network (exact for quarter-pixel widths)
//   T[j]         fit threshold: the prefix a line must stay within to keep segment j. Text counts its
//                own width; a space or zero-width break counts nothing, because it hangs.
//                T[j] = S[j] - breakAfter[j] * width[j], matching getWholeSegmentFitContribution.
//   paintEnd(j)  the painted prefix of a line that ends just before j. pretext excludes only the last
//                break-after segment, so paintEnd(j) = T[j-1] (and S[N-1] at the end of the text).
//   skip(j)      how many break-after segments a line starting at j skips, counted up to runLimit.
//                runLimit is a build option, by default the longest run of break-after segments in
//                the paragraph the circuit is built from. A longer run at runtime sets the
//                runOverflow output, because skip(j) would undercount it and lines would start at
//                the wrong segment.
//
// For a line starting at s, fits(o) = [T[s+o] - prefix(s) <= maxWidth + epsilon] is monotone in o
// (1..1 0..0), so "the first segment that does not fit" is a count. With fits(0) = 1 and sums that
// telescope over neighbors:
//   next(s)  = s + 1 + skip(s+1) + sum_o fits(o) * (1 + skip(s+o+1) - skip(s+o))
//   width(s) = width[s] + sum_o fits(o) * (paintEnd(s+o+1) - paintEnd(s+o))
// Every product has a fit bit as its gate and a start-independent difference as its value.
//
// Five ways to turn next(s) into lines:
//   buildSequentialLines  next(s) for all starts (N x window comparisons), then one integer one-hot
//                         per line slot to read next(start) and width(start)
//   buildSegmentScan      next(s) for all starts, then isLineStart[j] by scanning segments; no
//                         computed-index reads, but depth grows with the segment count
//   buildPointerJumping   next(s) for all starts, then jump tables next^(2^m) and binary lifting
//   buildGatheredLines    no table: per line slot, one one-hot of the start, gathered thresholds for
//                         the window after it, and comparisons against that line's own width
//   buildSegmentWalker    walkPreparedLinesSimple unrolled one segment at a time
import {Circuit, emitMaximum, invariant, type Terms, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {viewPrepared} from './fake-canvas.ts'
import {SourceTable, compile, fitBit, integerAtLeast, integerOneHot, maskedRead, relu, type Compiled, type OneHot} from './kit.ts'

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
    // Thresholds are nondecreasing, so walk until the first one that does not fit.
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
  source: SourceTable
  circuit: Circuit
  unit: Wire
  maxWidth: Wire
  startCursor: Wire
  widthCells: Wire[]
  breakAfterCells: Wire[]
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
  for (const wire of prefix) circuit.assumeRange(wire, 0, maximumParagraphWidth, {allowExistingReaders: true})
  return prefix
}

function longestBreakAfterRun(breakAfter: readonly number[]): number {
  let longest = 1
  let run = 0
  for (const bit of breakAfter) {
    run = bit === 1 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

export function createFastCircuit(
  paragraph: FastParagraph,
  epsilon: number,
  extraCells?: (source: SourceTable) => void,
  runLimit = longestBreakAfterRun(paragraph.breakAfter),
): FastCircuit {
  invariant(Number.isInteger(runLimit) && runLimit >= 1, 'runLimit must be a positive integer')
  const segmentCount = paragraph.widths.length
  const source = new SourceTable()
  const maxWidth = source.cell(320, 0, maximumLineWidth)
  // A runtime cell rather than a constant, so one-hots built from it don't fold into duplicates.
  const startCursor = source.cell(0, 0, segmentCount)
  const widthCells = source.cells(paragraph.widths, 0, maximumSegmentWidth)
  const breakAfterCells = source.cells(paragraph.breakAfter, 0, 1)
  extraCells?.(source)
  const circuit = source.createCircuit()
  const unit = source.unit
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
    source, circuit, unit, maxWidth, startCursor, widthCells, breakAfterCells, segmentCount, runLimit, epsilon, zero,
    prefixTerms, prefixWire, inclusivePrefix, threshold, widthHead, deltaPaint, skipTerms, deltaSkip, runOverflow,
  }
}

type NextTable = {next: Wire[], width: Wire[], windowOverflow: Wire[]}

// next(s) + nextBias(s) and width(s) for every start, from window - 1 comparisons each, plus one more
// comparison per start that reports a window too small for the text.
function buildNextTable(fc: FastCircuit, window: number, nextBias: (s: number) => number): NextTable {
  const {circuit, unit, segmentCount} = fc
  const next: Wire[] = []
  const width: Wire[] = []
  const windowOverflow: Wire[] = []
  for (let s = 0; s < segmentCount; s++) {
    const spanStart = fc.prefixTerms(s).map(([wire, coefficient]) => [wire, -coefficient] as const)
    const nextTerms: (readonly [Wire, number])[] = [...fc.skipTerms(s + 1)]
    const widthTerms: [Wire, number][] = [[fc.widthHead[s]!, 1]]
    for (let offset = 1; offset <= window && s + offset < segmentCount; offset++) {
      const fits = fitBit(circuit, unit, [[fc.threshold[s + offset]!, 1], ...spanStart], fc.maxWidth, fc.epsilon)
      if (offset === window) {
        windowOverflow.push(fits)
        break
      }
      nextTerms.push([fits, 1])
      const deltaSkip = fc.deltaSkip(s + offset)
      if (deltaSkip !== fc.zero) nextTerms.push([circuit.multiply(deltaSkip, fits), 1])
      widthTerms.push([circuit.multiply(fc.deltaPaint(s + offset), fits), 1])
    }
    const nextWire = circuit.roundAffine(nextTerms, s + 1 + nextBias(s))
    circuit.assumeRange(nextWire, s + 1 + nextBias(s), segmentCount + nextBias(s))
    next.push(nextWire)
    const widthWire = circuit.roundAffine(widthTerms)
    circuit.assumeRange(widthWire, 0, maximumLineWidth + maximumSegmentWidth)
    width.push(widthWire)
  }
  return {next, width, windowOverflow}
}

// Every build outputs lineCount, maxLineWidth and the three overflow counts. The per-line and
// per-segment arrays are empty when a build doesn't output them.
export type FastOutputs = {
  lineCount: number
  maxLineWidth: number
  windowOverflow: number
  moreLinesThanSlots: number
  runOverflow: number
  // Per line slot: start segment and painted width (sequential and gathered lines).
  starts: number[]
  widths: number[]
  // Per segment: line index and x within the line (gathered lines with segment geometry, segment walker).
  lineIndex: number[]
  x: number[]
  // Per segment: whether a line starts there, and that line's painted width or 0 (segment scan).
  isLineStart: number[]
  startWidths: number[]
}

export type FastBuild = {
  fc: FastCircuit
  compiled: Compiled
  decode: (values: Float32Array) => FastOutputs
}

type RootLayout = {
  lineCount: Wire
  maxLineWidth: Wire
  windowOverflow: Wire
  moreLinesThanSlots: Wire
  runOverflow: Wire
  starts?: Wire[]
  widths?: Wire[]
  lineIndex?: Wire[]
  x?: Wire[]
  isLineStart?: Wire[]
  startWidths?: Wire[]
}

function finish(fc: FastCircuit, layout: RootLayout): FastBuild {
  const roots = [layout.lineCount, layout.maxLineWidth, layout.windowOverflow, layout.moreLinesThanSlots, layout.runOverflow]
  const offsets = {starts: 0, widths: 0, lineIndex: 0, x: 0, isLineStart: 0, startWidths: 0}
  for (const name of ['starts', 'widths', 'lineIndex', 'x', 'isLineStart', 'startWidths'] as const) {
    offsets[name] = roots.length
    roots.push(...layout[name] ?? [])
  }
  const compiled = compile(fc.circuit, roots)
  const slice = (values: Float32Array, name: keyof typeof offsets) =>
    Array.from(values.subarray(offsets[name], offsets[name] + (layout[name]?.length ?? 0)))
  return {
    fc,
    compiled,
    decode: values => ({
      lineCount: values[0]!,
      maxLineWidth: values[1]!,
      windowOverflow: values[2]!,
      moreLinesThanSlots: values[3]!,
      runOverflow: values[4]!,
      starts: slice(values, 'starts'),
      widths: slice(values, 'widths'),
      lineIndex: slice(values, 'lineIndex'),
      x: slice(values, 'x'),
      isLineStart: slice(values, 'isLineStart'),
      startWidths: slice(values, 'startWidths'),
    }),
  }
}

function anyBit(fc: FastCircuit, bits: readonly Wire[]): Wire {
  return bits.length === 0 ? fc.zero : fc.circuit.roundAffine(bits.map(bit => [bit, 1] as const))
}

export function maximumTournament(circuit: Circuit, values: readonly Wire[]): Wire {
  let level = [...values]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? emitMaximum(circuit, level[index]!, level[index + 1]!) : level[index]!)
    }
    level = next
  }
  return level[0]!
}

export type FastBuildOptions = {
  window: number
  lineSlots: number
  epsilon: number
  // The longest run of break-after segments the circuit handles; see skip(j) above.
  runLimit?: number
}

export function buildSequentialLines(paragraph: FastParagraph, options: FastBuildOptions): FastBuild {
  const fc = createFastCircuit(paragraph, options.epsilon, undefined, options.runLimit)
  const {circuit, unit, segmentCount} = fc
  // Stored minus N, so an exhausted start that reads zeros moves to N again.
  const table = buildNextTable(fc, options.window, () => -segmentCount)
  let start: Wire = fc.startCursor
  const starts: Wire[] = []
  const widths: Wire[] = []
  const countTerms: [Wire, number][] = []
  for (let line = 0; line < options.lineSlots; line++) {
    const oneHot = integerOneHot(circuit, unit, start, 0, segmentCount, true)
    starts.push(start)
    widths.push(maskedRead(circuit, oneHot.members, table.width))
    for (const [wire, coefficient] of oneHot.atLeast(segmentCount)) countTerms.push([wire, -coefficient])
    start = circuit.roundAffine([[maskedRead(circuit, oneHot.members, table.next), 1]], segmentCount)
    circuit.assumeRange(start, 0, segmentCount)
  }
  const lineCount = circuit.roundAffine(countTerms, options.lineSlots)
  const moreLinesThanSlots = circuit.roundAffine([[integerAtLeast(circuit, [[start, 1]], 0, segmentCount), -1]], 1)
  return finish(fc, {
    lineCount,
    maxLineWidth: maximumTournament(circuit, widths),
    windowOverflow: anyBit(fc, table.windowOverflow),
    moreLinesThanSlots,
    runOverflow: fc.runOverflow,
    starts,
    widths,
  })
}

export function buildSegmentScan(paragraph: FastParagraph, options: FastBuildOptions): FastBuild {
  const fc = createFastCircuit(paragraph, options.epsilon, undefined, options.runLimit)
  const {circuit, unit, segmentCount, runLimit} = fc
  // next(s) - s, in 1..window + runLimit.
  const table = buildNextTable(fc, options.window, s => -s)
  const reach = options.window + runLimit
  const isLineStart: Wire[] = [unit]
  // pointer(s) = s + isLineStart[s] * (next(s) - s): only a line start points past itself.
  // relus of pointer(s) - j, shared by the hat functions of every target j after s.
  const pointerRelus: Map<number, Wire>[] = []
  const pointers: Wire[] = []
  const hatTerms = (s: number, j: number): [Wire, number][] => {
    const r = (k: number): [Wire, number][] => k <= s ? [[pointers[s]!, 1], [unit, -k]] : [[pointerRelus[s]!.get(k)!, 1]]
    return [...r(j - 1), ...r(j).map(([wire, coefficient]) => [wire, -2 * coefficient] as [Wire, number]), ...r(j + 1)]
  }
  for (let s = 0; s < segmentCount; s++) {
    if (s > 0) {
      const terms: [Wire, number][] = []
      for (let from = Math.max(0, s - reach); from < s; from++) terms.push(...hatTerms(from, s))
      const bit = circuit.roundAffine(terms)
      circuit.assumeRange(bit, 0, 1)
      isLineStart.push(bit)
    }
    const pointer = circuit.roundAffine([[circuit.multiply(table.next[s]!, isLineStart[s]!), 1]], s)
    circuit.assumeRange(pointer, s, s + reach)
    pointers.push(pointer)
    const relus = new Map<number, Wire>()
    for (let k = s + 1; k <= Math.min(segmentCount, s + reach) + 1; k++) relus.set(k, relu(circuit, [[pointer, 1]], -k))
    pointerRelus.push(relus)
  }
  const startWidths = isLineStart.map((bit, s) => circuit.multiply(table.width[s]!, bit))
  return finish(fc, {
    lineCount: circuit.roundAffine(isLineStart.map(bit => [bit, 1] as const)),
    maxLineWidth: maximumTournament(circuit, startWidths),
    windowOverflow: anyBit(fc, table.windowOverflow),
    moreLinesThanSlots: fc.zero,
    runOverflow: fc.runOverflow,
    isLineStart,
    startWidths,
  })
}

// Outputs only lineCount and maxLineWidth. Line starts would need a binary lifting walk per line slot.
export function buildPointerJumping(paragraph: FastParagraph, options: FastBuildOptions): FastBuild & {levels: number} {
  const fc = createFastCircuit(paragraph, options.epsilon, undefined, options.runLimit)
  const {circuit, unit, segmentCount, runLimit} = fc
  const table = buildNextTable(fc, options.window, () => 0)
  const end = circuit.roundAffine([[unit, segmentCount]])
  circuit.assumeRange(end, segmentCount, segmentCount)
  // Level m: jump[m][s] = the start 2^m lines after s; widest[m][s] = the widest of those lines.
  let jump: Wire[] = [...table.next, end]
  let widest: Wire[] = [...table.width, fc.zero]
  const jumps = [jump]
  const widests = [widest]
  const levels = Math.max(1, Math.ceil(Math.log2(options.lineSlots)))
  for (let level = 1; level < levels; level++) {
    const reach = (options.window + runLimit) * 2 ** (level - 1)
    const nextJump: Wire[] = []
    const nextWidest: Wire[] = []
    for (let s = 0; s < segmentCount; s++) {
      const high = Math.min(segmentCount, s + reach)
      const oneHot = integerOneHot(circuit, unit, jump[s]!, s + 1, high - s, false)
      const composed = maskedRead(circuit, oneHot.members, jump.slice(s + 1, high + 1))
      circuit.assumeRange(composed, s + 1, segmentCount)
      nextJump.push(composed)
      nextWidest.push(emitMaximum(circuit, widest[s]!, maskedRead(circuit, oneHot.members, widest.slice(s + 1, high + 1))))
    }
    jump = [...nextJump, end]
    widest = [...nextWidest, fc.zero]
    jumps.push(jump)
    widests.push(widest)
  }
  let cursor: Wire = fc.startCursor
  const countTerms: [Wire, number][] = []
  let best: Wire = fc.zero
  for (let level = levels - 1; level >= 0; level--) {
    const oneHot = integerOneHot(circuit, unit, cursor, 0, segmentCount + 1, false)
    const candidate = maskedRead(circuit, oneHot.members, jumps[level]!)
    const candidateWidest = maskedRead(circuit, oneHot.members, widests[level]!)
    // take = [candidate <= N - 1]: the jump lands on a real line start.
    const take = circuit.roundAffine([[integerAtLeast(circuit, [[candidate, 1]], 0, segmentCount), -1]], 1)
    circuit.assumeRange(take, 0, 1)
    countTerms.push([take, 2 ** level])
    best = emitMaximum(circuit, best, circuit.multiply(candidateWidest, take))
    cursor = circuit.select(take, cursor, candidate)
    circuit.assumeRange(cursor, 0, segmentCount)
  }
  const last = integerOneHot(circuit, unit, cursor, 0, segmentCount + 1, false)
  best = emitMaximum(circuit, best, maskedRead(circuit, last.members, widests[0]!))
  // Binary lifting takes at most 2^levels - 1 jumps, so it counts at most 2^levels lines. When the
  // line after the cursor still starts before the end, the text has more lines than that.
  const nextAfterLast = maskedRead(circuit, last.members, jumps[0]!)
  const moreLinesThanSlots = circuit.roundAffine([[integerAtLeast(circuit, [[nextAfterLast, 1]], 0, segmentCount), -1]], 1)
  circuit.assumeRange(moreLinesThanSlots, 0, 1)
  return {
    ...finish(fc, {
      lineCount: circuit.roundAffine(countTerms, 1),
      maxLineWidth: best,
      windowOverflow: anyBit(fc, table.windowOverflow),
      moreLinesThanSlots,
      runOverflow: fc.runOverflow,
    }),
    levels,
  }
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
  // Past the end of the text the threshold is the whole paragraph plus the offset, so no start fits
  // it. An exhausted start reads zeros, which gives the offset alone against a start prefix of zero.
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

// Per segment: the index of its line slot, its x within the paragraph (slot left edge plus the width
// before it on its line), its y, and whether any slot laid it out. All come from the integer one-hot
// relus the walker already built:
//   [start_k <= j] = 1 - [start_k >= j + 1]
//   lineIndex(j)  = sum over slots k >= 1 of [start_k <= j]
//   x(j)          = prefix(j) + sum over k of [start_k <= j] * ((left_k - startPrefix_k) - (left_(k-1) - startPrefix_(k-1)))
// A skipped band keeps the start, so it counts toward lineIndex and adds nothing to x.
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

export type GatheredLinesOptions = FastBuildOptions & {
  // One width cell per line slot instead of the shared maxWidth cell.
  perLineWidths: boolean
  // Also output each segment's line index and x within its line.
  segmentGeometry: boolean
}

export type GatheredBuild = FastBuild & {lineWidthCells: Wire[]}

export function buildGatheredLines(paragraph: FastParagraph, options: GatheredLinesOptions): GatheredBuild {
  let lineWidthCells: Wire[] = []
  const fc = createFastCircuit(paragraph, options.epsilon, source => {
    if (options.perLineWidths) lineWidthCells = Array.from({length: options.lineSlots}, () => source.cell(320, 0, maximumLineWidth))
  }, options.runLimit)
  if (!options.perLineWidths) lineWidthCells = Array.from({length: options.lineSlots}, () => fc.maxWidth)
  const walk = walkGatheredLines(fc, options.window, lineWidthCells, null)
  const layout: RootLayout = {
    lineCount: walk.lineCount,
    maxLineWidth: maximumTournament(fc.circuit, walk.widths),
    windowOverflow: walk.windowOverflow,
    moreLinesThanSlots: fc.circuit.roundAffine([[integerAtLeast(fc.circuit, [[walk.finalStart, 1]], 0, fc.segmentCount), -1]], 1),
    runOverflow: fc.runOverflow,
    starts: walk.starts,
    widths: walk.widths,
  }
  if (options.segmentGeometry) {
    const geometry = segmentGeometry(fc, walk, null, 0, 1)
    layout.lineIndex = geometry.lineIndex
    layout.x = geometry.x
  }
  return {...finish(fc, layout), lineWidthCells}
}

// Carries a "skipping break-after segments" bit instead of skip(j), so it has no run limit.
export function buildSegmentWalker(paragraph: FastParagraph, options: {epsilon: number}): FastBuild {
  const fc = createFastCircuit(paragraph, options.epsilon)
  const {circuit, unit, segmentCount} = fc
  let lineStartPrefix: Wire = fc.zero
  let skipping: Wire = fc.zero
  let lineIndex: Wire = fc.zero
  let widest: Wire = fc.zero
  const lineIndexOut: Wire[] = [fc.zero]
  const xOut: Wire[] = [fc.zero]
  for (let j = 1; j < segmentCount; j++) {
    const fits = fitBit(circuit, unit, [[fc.threshold[j]!, 1], [lineStartPrefix, -1]], fc.maxWidth, fc.epsilon)
    const skippingAndFits = circuit.multiply(skipping, fits)
    // A line break is pending at j: either still skipping, or j did not fit.
    const pendingBreak = circuit.roundAffine([[fits, -1], [skippingAndFits, 1]], 1)
    circuit.assumeRange(pendingBreak, 0, 1)
    const nextSkipping = circuit.multiply(pendingBreak, fc.breakAfterCells[j]!)
    circuit.assumeRange(nextSkipping, 0, 1)
    const isLineStart = circuit.roundAffine([[pendingBreak, 1], [nextSkipping, -1]])
    circuit.assumeRange(isLineStart, 0, 1)
    // The current line ends at j when j fails while not skipping. Its painted width is paintEnd(j) - start prefix.
    const endsLine = circuit.roundAffine([[fits, -1], [skipping, -1], [skippingAndFits, 1]], 1)
    circuit.assumeRange(endsLine, 0, 1)
    const endingWidth = circuit.roundAffine([[fc.threshold[j - 1]!, 1], [lineStartPrefix, -1]])
    circuit.assumeRange(endingWidth, 0, maximumParagraphWidth)
    widest = emitMaximum(circuit, widest, circuit.multiply(endingWidth, endsLine))
    const advance = circuit.roundAffine([[fc.inclusivePrefix[j - 1]!, 1], [lineStartPrefix, -1]])
    circuit.assumeRange(advance, 0, maximumParagraphWidth)
    lineStartPrefix = circuit.roundAffine([[lineStartPrefix, 1], [circuit.multiply(advance, isLineStart), 1]])
    circuit.assumeRange(lineStartPrefix, 0, maximumParagraphWidth)
    skipping = nextSkipping
    lineIndex = circuit.roundAffine([[lineIndex, 1], [isLineStart, 1]])
    circuit.assumeRange(lineIndex, 0, segmentCount)
    lineIndexOut.push(lineIndex)
    xOut.push(circuit.roundAffine([[fc.inclusivePrefix[j - 1]!, 1], [lineStartPrefix, -1]]))
  }
  const lastWidth = circuit.roundAffine([[fc.inclusivePrefix[segmentCount - 1]!, 1], [lineStartPrefix, -1]])
  circuit.assumeRange(lastWidth, 0, maximumParagraphWidth)
  return finish(fc, {
    lineCount: circuit.roundAffine([[lineIndex, 1]], 1),
    maxLineWidth: emitMaximum(circuit, widest, lastWidth),
    windowOverflow: fc.zero,
    moreLinesThanSlots: fc.zero,
    runOverflow: fc.zero,
    lineIndex: lineIndexOut,
    x: xOut,
  })
}
