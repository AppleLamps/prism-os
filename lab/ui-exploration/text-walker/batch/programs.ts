// The per-paragraph programs: greedy line breaking of one paragraph of up to `capacity.segments` segments at a runtime
// width, the way pretext's layout() breaks plain text, built from this folder's fast walker (fast-walker.ts). One compiled
// program serves every paragraph of a set: a paragraph's cells are written into the same source table layout, and the
// program's line count is pretext's lineCount.
//
// Every formulation reads the same cells, in this order after the unit cell:
//   maxWidth, startCursor, widths[0..segments - 1], breakAfter[0..segments - 1]
// A paragraph of n segments is written at the end of the widths and break-after cells, with zero-width text before it,
// and startCursor = segments - n. The walkers with line slots start the first line at startCursor, so they never read
// the padding. The segment walker starts at segment 0, and the padding adds 0 px to its first line.
//
// maxWidth is a float32 cell, while pretext compares in float64. Widths on the 1/64 px grid are exact in float32 and give
// pretext's line counts. A width off that grid, within float32 rounding of pretext's fit limit (span <= maxWidth +
// epsilon), can give one more line: e.g. float32 stores 272.99501 px as 272.9949951, so a 273 px span fits for pretext
// but not for the program.
//
// Formulations:
//   one-hot         walkGatheredLines without obstacles, the walker IndirectOS's Notes flow uses: per line slot, an
//                   integer one-hot of the line's start, masked reads that the compiler lowers to gathers, and one
//                   comparison per window position
//   index-read      the same walk, with circuit.indexRead at the line's start instead of the one-hot and masked reads
//   segment-walker  buildSegmentWalker, pretext's walker unrolled one segment at a time: no line slots, no window and
//                   no run limit, and depth that grows with the segment count
import {type Wire, invariant} from '../../../../src/runtime/numeric-ui-core.ts'
import {type FastCircuit, buildSegmentWalker, createFastCircuit, maximumParagraphWidth, walkGatheredLines} from '../fast-walker.ts'
import {type Compiled, compile, fitBit, integerAtLeast} from '../kit.ts'
import type {BatchCapacity, BatchParagraph} from './paragraphs.ts'

export type Formulation = 'one-hot' | 'index-read' | 'segment-walker'
export const allFormulations: readonly Formulation[] = ['one-hot', 'index-read', 'segment-walker']

// lineCount: pretext's line count. moreLinesThanSlots: 1 when text is left after the last line slot. windowOverflow: how
// many line slots have a line that reaches past the window. runOverflow: how many positions start a run of break-after
// segments longer than the run limit. The segment walker outputs only lineCount.
export type OutputName = 'lineCount' | 'moreLinesThanSlots' | 'windowOverflow' | 'runOverflow'

export type BatchOutputs = Record<OutputName, number>

export type BatchProgram = {
  formulation: Formulation
  capacity: BatchCapacity
  fc: FastCircuit
  compiled: Compiled
  // Output names in root order.
  outputNames: readonly OutputName[]
  // Every source cell except the unit cell, in the order above. Written once per paragraph.
  instanceSourceWires: Wire[]
  indexReads: {reads: number, storedPositions: number}
  buildMilliseconds: number
  compileMilliseconds: number
}

// Added to the threshold past the end of the text, so no line start fits it.
const neverFitsOffset = 8192

// The index-read walk. The same arithmetic as walkGatheredLines without obstacles, where each line slot reads its
// start's tables with index reads:
//   startPrefix = prefix(start)                         +0 for an exhausted start (start = segments)
//   fits(o)     = [threshold[start + o] - startPrefix <= maxWidth + epsilon]
//   next        = nextHead(start) + sum over o of fits(o) * (1 + deltaSkip(start + o)) + segments
// Positions past the end read a threshold of the paragraph's whole width plus 8192 px, so nothing fits there, even
// for an exhausted start whose prefix reads +0. An exhausted start reads nextHead = +0 and no fits, so it stays at the end.
function walkIndexedLines(fc: FastCircuit, window: number, lineSlots: number) {
  const {circuit, unit, segmentCount} = fc
  invariant(Number.isInteger(window) && window >= 2, 'the walker window must be at least 2 segments')
  const prefixTable = Array.from({length: segmentCount}, (_, s) => fc.prefixWire(s))
  const nextHeadTable = Array.from({length: segmentCount}, (_, s) => {
    const wire = circuit.roundAffine(fc.skipTerms(s + 1), s + 1 - segmentCount)
    circuit.assumeRange(wire, s + 1 - segmentCount, fc.runLimit)
    return wire
  })
  const neverFits = circuit.roundAffine([[fc.inclusivePrefix[segmentCount - 1]!, 1]], neverFitsOffset)
  circuit.assumeRange(neverFits, neverFitsOffset, maximumParagraphWidth + neverFitsOffset)
  const thresholdTable = [...fc.threshold, neverFits]
  const deltaSkipTable = [...Array.from({length: segmentCount}, (_, j) => fc.deltaSkip(j)), fc.zero]
  let start: Wire = fc.startCursor
  const countTerms: [Wire, number][] = []
  const overflowBits: Wire[] = []
  for (let line = 0; line < lineSlots; line++) {
    const startPrefix = circuit.indexRead(start, prefixTable, {outOfRange: 'zero'})
    const nextTerms: [Wire, number][] = [[circuit.indexRead(start, nextHeadTable, {outOfRange: 'zero'}), 1]]
    for (let offset = 1; offset <= window; offset++) {
      const threshold = circuit.indexReadAffine([[start, 1]], offset, thresholdTable, 'clamp', 'clamp')
      const fits = fitBit(circuit, unit, [[threshold, 1], [startPrefix, -1]], fc.maxWidth, fc.epsilon)
      if (offset === window) {
        overflowBits.push(fits)
        break
      }
      nextTerms.push([fits, 1])
      const deltaSkip = circuit.indexReadAffine([[start, 1]], offset, deltaSkipTable, 'clamp', 'clamp')
      nextTerms.push([circuit.multiply(deltaSkip, fits), 1])
    }
    // lineCount adds 1 - [start >= segments] per slot.
    countTerms.push([integerAtLeast(circuit, [[start, 1]], 0, segmentCount), -1])
    start = circuit.roundAffine(nextTerms, segmentCount)
    circuit.assumeRange(start, 0, segmentCount)
  }
  const lineCount = circuit.roundAffine(countTerms, lineSlots)
  circuit.assumeRange(lineCount, 0, lineSlots)
  return {
    lineCount,
    finalStart: start,
    windowOverflow: overflowBits.length === 0 ? fc.zero : circuit.roundAffine(overflowBits.map(bit => [bit, 1] as const)),
  }
}

// 1 when the start after the last line slot is still inside the text.
function moreLinesThanSlots(fc: FastCircuit, finalStart: Wire): Wire {
  const wire = fc.circuit.roundAffine([[integerAtLeast(fc.circuit, [[finalStart, 1]], 0, fc.segmentCount), -1]], 1)
  fc.circuit.assumeRange(wire, 0, 1)
  return wire
}

function countIndexReads(compiled: Compiled) {
  const program = compiled.circuit.tensorProgram!
  let reads = 0
  const tables = new Set<ArrayLike<number>>()
  for (const layer of program.layers) {
    reads += layer.indexReads.length
    for (const read of layer.indexReads) tables.add(read.candidatePositions)
  }
  let storedPositions = 0
  for (const table of tables) storedPositions += table.length
  return {reads, storedPositions}
}

export function buildBatchProgram(formulation: Formulation, capacity: BatchCapacity): BatchProgram {
  const buildStarted = performance.now()
  const template = {widths: Array<number>(capacity.segments).fill(0), breakAfter: Array<number>(capacity.segments).fill(0)}
  let fc: FastCircuit
  let roots: Wire[]
  let outputNames: OutputName[]
  switch (formulation) {
    case 'one-hot': {
      fc = createFastCircuit(template, capacity.epsilon, undefined, capacity.runLimit)
      const walk = walkGatheredLines(fc, capacity.window, Array.from({length: capacity.lineSlots}, () => fc.maxWidth), null)
      roots = [walk.lineCount, moreLinesThanSlots(fc, walk.finalStart), walk.windowOverflow, fc.runOverflow]
      outputNames = ['lineCount', 'moreLinesThanSlots', 'windowOverflow', 'runOverflow']
      break
    }
    case 'index-read': {
      fc = createFastCircuit(template, capacity.epsilon, undefined, capacity.runLimit)
      const walk = walkIndexedLines(fc, capacity.window, capacity.lineSlots)
      roots = [walk.lineCount, moreLinesThanSlots(fc, walk.finalStart), walk.windowOverflow, fc.runOverflow]
      outputNames = ['lineCount', 'moreLinesThanSlots', 'windowOverflow', 'runOverflow']
      break
    }
    case 'segment-walker': {
      // buildSegmentWalker compiles every output it has, e.g. each segment's x. This program keeps only lineCount,
      // the first root, so the build time below includes that first compile.
      const build = buildSegmentWalker(template, {epsilon: capacity.epsilon})
      fc = build.fc
      roots = [build.compiled.roots[0]!]
      outputNames = ['lineCount']
      break
    }
  }
  const buildMilliseconds = performance.now() - buildStarted
  const compileStarted = performance.now()
  // compile() compiles twice: once for the sizes, and once inside createTensorEvaluator.
  const compiled = compile(fc.circuit, roots)
  const compileMilliseconds = performance.now() - compileStarted
  const instanceSourceWires = [fc.maxWidth, fc.startCursor, ...fc.widthCells, ...fc.breakAfterCells]
  invariant(instanceSourceWires.every((wire, index) => wire === index + 1) && fc.circuit.sourceSize === 2 * capacity.segments + 3, 'the cells must follow the unit cell in the documented order')
  return {
    formulation, capacity, fc, compiled, outputNames, instanceSourceWires,
    indexReads: countIndexReads(compiled), buildMilliseconds, compileMilliseconds,
  }
}

// One paragraph's instance cells, maxWidth first, at `offset` in `target`.
export function writeInstanceCells(target: Float32Array, offset: number, capacity: BatchCapacity, paragraph: BatchParagraph, maxWidth: number) {
  const {widths, breakAfter} = paragraph.paragraph
  const segments = capacity.segments
  const padding = segments - widths.length
  invariant(padding >= 0, `a paragraph of ${widths.length} segments doesn't fit ${segments} segment cells`)
  target[offset] = maxWidth
  target[offset + 1] = padding
  target.fill(0, offset + 2, offset + 2 + padding)
  target.fill(0, offset + 2 + segments, offset + 2 + segments + padding)
  for (let j = 0; j < widths.length; j++) {
    target[offset + 2 + padding + j] = widths[j]!
    target[offset + 2 + segments + padding + j] = breakAfter[j]!
  }
}

export const instanceCellCount = (capacity: BatchCapacity) => 2 * capacity.segments + 2

// A whole source table for one paragraph: the unit cell, then its instance cells.
export function paragraphSourceTable(program: BatchProgram, paragraph: BatchParagraph, maxWidth: number, target = new Float32Array(program.fc.circuit.sourceSize)) {
  target[0] = 1
  writeInstanceCells(target, 1, program.capacity, paragraph, maxWidth)
  return target
}

export function decodeOutputs(program: BatchProgram, values: ArrayLike<number>, offset = 0): BatchOutputs {
  const outputs: BatchOutputs = {lineCount: 0, moreLinesThanSlots: 0, windowOverflow: 0, runOverflow: 0}
  program.outputNames.forEach((name, index) => {
    outputs[name] = values[offset + index]!
  })
  return outputs
}
