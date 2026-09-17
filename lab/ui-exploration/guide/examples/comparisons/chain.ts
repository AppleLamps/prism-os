// A chain of decisions in which each decision reads the result of the one before, to measure how the
// comparison form sets the depth of a long dependency chain.
//
// The UI: a toolbar places its items on one line in order, and skips an item that doesn't fit in
// the width that's left. In plain JavaScript, with the FP32 rounding the circuit does:
//
//   let lineWidth = lineStart
//   for (const itemWidth of itemWidths) {
//     if (f(f(lineWidth + itemWidth) - maxWidth) <= 0) lineWidth = f(lineWidth + itemWidth)
//   }
//
// Whether item k fits depends on lineWidth after item k - 1, so the decisions can't run side by side.
import {Circuit, type Terms, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {emitPositiveBitByRounding, emitSumAtLeastZeroByRounding, planRoundingCompare} from './boolean-atom.ts'
import {createRandom, f, nextDown, nextUp} from './fp32.ts'
import {emitSumAtLeastZeroOnGrid} from './integer-bit.ts'
import {emitPositiveBit, planSignCascade} from './sign-cascade.ts'

export const chainForms = [
  'atomOnGrid',
  'integerBitOnGrid',
  'roundingStageAtGridStep',
  'cascadeAtGridStep',
  'roundingEndEveryValue',
  'cascadeEveryValue',
] as const

export type ChainForm = (typeof chainForms)[number]

export const chainFormLabels: Record<ChainForm, string> = {
  atomOnGrid: 'one boolean atom on 1/64 px widths (text-editing\'s form)',
  integerBitOnGrid: 'integer bit on 1/64 px widths',
  roundingStageAtGridStep: 'one rounding stage, resolution 1/64',
  cascadeAtGridStep: 'sign cascade, resolution 1/64',
  roundingEndEveryValue: 'clamp stages, then a rounding stage, every FP32 value',
  cascadeEveryValue: 'sign cascade, every FP32 value',
}

const gridStep = 1 / 64
const maxWidthLimit = 8192
const lineStartLimit = 1024
const itemWidthLimit = 1024

// Source cells: maxWidth, lineStart, then one width per item.
export function buildLineFill(form: ChainForm, itemCount: number) {
  const circuit = new Circuit(2 + itemCount)
  const maxWidth = circuit.source(0)
  const lineStart = circuit.source(1)
  circuit.assumeRange(maxWidth, 0, maxWidthLimit)
  circuit.assumeRange(lineStart, 0, lineStartLimit)
  const placed: Wire[] = []
  let lineWidth: Wire = lineStart
  for (let item = 0; item < itemCount; item++) {
    const itemWidth = circuit.source(2 + item)
    circuit.assumeRange(itemWidth, 0, itemWidthLimit)
    let placedWidth: Wire
    if (form === 'atomOnGrid' || form === 'integerBitOnGrid') {
      const remainingTerms: Terms = [[maxWidth, 1], [lineWidth, -1], [itemWidth, -1]]
      const fits = form === 'atomOnGrid'
        ? emitSumAtLeastZeroByRounding(circuit, remainingTerms, gridStep)
        : emitSumAtLeastZeroOnGrid(circuit, remainingTerms, gridStep)
      placed.push(fits)
      // itemWidth * fits
      placedWidth = circuit.reglu([[itemWidth, 1]], 0, [[fits, 1]], 0)
    } else {
      // f(f(lineWidth + itemWidth) - maxWidth), as its own operation, so it rounds like the reference.
      const overflow = circuit.roundAffine([[lineWidth, 1], [itemWidth, 1], [maxWidth, -1]])
      const {minimum, maximum} = circuit.ranges[overflow]!
      const differenceBound = Math.max(Math.abs(minimum), Math.abs(maximum))
      const resolution = form === 'roundingStageAtGridStep' || form === 'cascadeAtGridStep' ? {resolution: gridStep} : {}
      const overflows = form === 'roundingStageAtGridStep' || form === 'roundingEndEveryValue'
        ? emitPositiveBitByRounding(circuit, overflow, planRoundingCompare({differenceBound, ...resolution}))
        : emitPositiveBit(circuit, overflow, planSignCascade({differenceBound, ...resolution})).bit
      const fits = circuit.affine([[overflows, -1]], 1)
      circuit.assumeRange(fits, 0, 1)
      placed.push(fits)
      // itemWidth * (1 - overflows)
      placedWidth = circuit.reglu([[itemWidth, 1]], 0, [[overflows, -1]], 1)
    }
    lineWidth = circuit.roundAffine([[lineWidth, 1], [placedWidth, 1]])
    // A placed item keeps lineWidth at most maxWidth, and a skipped item leaves lineWidth unchanged.
    circuit.assumeRange(lineWidth, 0, maxWidthLimit)
  }
  return {circuit, placed, lineWidth}
}

export function lineFillReference(maxWidth: number, lineStart: number, itemWidths: readonly number[]) {
  let lineWidth = f(lineStart)
  const placed: number[] = []
  for (const itemWidth of itemWidths) {
    const fits = f(f(lineWidth + itemWidth) - maxWidth) <= 0
    placed.push(fits ? 1 : 0)
    if (fits) lineWidth = f(lineWidth + itemWidth)
  }
  return {placed, lineWidth}
}

// Random widths, either on the 1/64 px grid or arbitrary FP32 values. Two thirds of the cases put
// one item's decision exactly on the edge, or one step (a grid step or an FP32 step) to either side.
export function randomLineFillSource(random: () => number, itemCount: number, onGrid: boolean): Float32Array {
  const quantize = (value: number) => onGrid ? Math.round(value / gridStep) * gridStep : f(value)
  const lineStart = quantize(random() * lineStartLimit)
  const itemWidths = Array.from({length: itemCount}, () => quantize(random() * 350))
  let maxWidth = quantize(random() * maxWidthLimit)
  const edge = random()
  if (edge < 2 / 3) {
    const edgeItem = Math.floor(random() * itemCount)
    let lineEnd = lineStart
    for (let item = 0; item <= edgeItem; item++) lineEnd = f(lineEnd + itemWidths[item]!)
    const side = Math.floor(random() * 3) - 1
    maxWidth = onGrid
      ? lineEnd + side * gridStep
      : side === 0 ? lineEnd : side > 0 ? nextUp(lineEnd) : nextDown(lineEnd)
  }
  return Float32Array.from([Math.min(maxWidthLimit, Math.max(0, maxWidth)), lineStart, ...itemWidths])
}

export function countLineFillMismatches(form: ChainForm, itemCount: number, caseCount: number, onGrid: boolean, seed: number) {
  const {circuit, placed, lineWidth} = buildLineFill(form, itemCount)
  const random = createRandom(seed)
  let wrongDecisions = 0
  let fractionalDecisions = 0
  let wrongWidths = 0
  for (let index = 0; index < caseCount; index++) {
    const source = randomLineFillSource(random, itemCount, onGrid)
    const values = circuit.evaluateReference(source)
    const reference = lineFillReference(source[0]!, source[1]!, [...source.subarray(2)])
    placed.forEach((wire, item) => {
      const value = values[wire]!
      if (value !== 0 && value !== 1) fractionalDecisions++
      if (value !== reference.placed[item]) wrongDecisions++
    })
    if (values[lineWidth] !== reference.lineWidth) wrongWidths++
  }
  return {decisions: caseCount * itemCount, wrongDecisions, fractionalDecisions, cases: caseCount, wrongWidths}
}
