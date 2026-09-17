// The sign cascade: an exact bit of [difference > 0] built from ReLU, multiplication by powers of
// two, and clamps, with no rounding anywhere.
//
// Each stage multiplies its input by a power of two, x = scale * input, and returns min(limit, x),
// written as x - relu(x - limit). Both steps are exact in FP32 as long as x <= 2^24 * limit:
// multiplying by a power of two only changes the exponent, and x - limit is representable there.
// So after every stage the value is exactly min(limit, relu(difference) * the product of the scales
// so far). The last stage's limit is 1, and the planner picks scales whose product lifts the
// smallest positive difference that must give 1 up to at least 1.
import {type Circuit, type Wire, invariant} from '../../../../../src/runtime/numeric-ui-core.ts'
import {exactIntegerLimit, powerOfTwoExponentAtLeast, powerOfTwoExponentAtMost, smallestSubnormal} from './fp32.ts'

// One stage: output = min(limit, scale * max(0, input)).
export type CascadeStage = {scale: number, limit: number}

export type CascadePlan = {
  // A power of two at least as large as every |difference|.
  differenceBound: number
  // A power of two no larger than the smallest positive difference that must give exactly 1.
  resolution: number
  stages: CascadeStage[]
}

export type CascadeOptions = {
  differenceBound: number
  // Defaults to 2^-149, the smallest positive FP32 value, so every positive difference gives 1.
  resolution?: number
  // The largest power of two a stage after the first may multiply by, as an exponent from 1 to 24.
  // The first stage multiplies as far as the difference bound allows.
  stageExponent?: number
}

const exactRoomExponent = Math.log2(exactIntegerLimit)

export function planSignCascade(options: CascadeOptions): CascadePlan {
  const stageExponent = options.stageExponent ?? 24
  invariant(Number.isInteger(stageExponent) && stageExponent >= 1 && stageExponent <= 24, 'a stage may multiply by 2^1 to 2^24')
  const boundExponent = powerOfTwoExponentAtLeast(options.differenceBound)
  const resolutionExponent = powerOfTwoExponentAtMost(options.resolution ?? smallestSubnormal)
  invariant(boundExponent <= 128, 'the difference bound must be finite')
  const stages: CascadeStage[] = []
  let limitExponent = boundExponent
  // The exponent of the product of the scales so far.
  let gainExponent = 0
  while (stages.length === 0 || limitExponent > 0 || resolutionExponent + gainExponent < 0) {
    // A bound above 2^24 first comes down by up to 2^24 per stage without multiplying, because
    // multiplying by less than 1 would round the smallest differences to zero.
    const nextLimitExponent = Math.max(0, limitExponent - exactRoomExponent)
    const room = exactRoomExponent + nextLimitExponent - limitExponent
    const needed = Math.max(0, -(resolutionExponent + gainExponent))
    const scaleExponent = Math.min(room, needed, stages.length === 0 ? room : stageExponent)
    stages.push({scale: 2 ** scaleExponent, limit: 2 ** nextLimitExponent})
    limitExponent = nextLimitExponent
    gainExponent += scaleExponent
  }
  return {differenceBound: 2 ** boundExponent, resolution: 2 ** resolutionExponent, stages}
}

export type CascadeWires = {bit: Wire, stageOutputs: Wire[]}

// The scale sits inside each ReLU's gate, so a stage is 2 layers. inlineStageOutputs: true writes
// each stage output as an ordinary affine, which the builder copies into the next stage. That
// regroups the terms at larger magnitudes and breaks exactness; it exists only to measure that
// pitfall.
export function emitPositiveBit(
  circuit: Circuit,
  difference: Wire,
  plan: CascadePlan,
  options: {inlineStageOutputs?: boolean} = {},
): CascadeWires {
  const stageOutputs: Wire[] = []
  let input = difference
  plan.stages.forEach(({scale, limit}, index) => {
    // relu(scale * input - limit): how far the scaled input passes the limit.
    const aboveLimit = circuit.reglu([], 1, [[input, scale]], -limit)
    // The first stage reads the signed difference, so it takes relu(scale * difference) as the
    // scaled value. Later stages read a value that's already at least 0.
    const scaledTerms: [Wire, number][] = index === 0
      ? [[circuit.reglu([], 1, [[input, scale]], 0), 1]]
      : [[input, scale]]
    const terms: [Wire, number][] = [...scaledTerms, [aboveLimit, -1]]
    const output = options.inlineStageOutputs === true ? circuit.affine(terms) : circuit.roundAffine(terms)
    circuit.assumeRange(output, 0, limit)
    stageOutputs.push(output)
    input = output
  })
  return {bit: input, stageOutputs}
}

// The same cascade when the difference bound is at most 2^24, so every limit is 1, with the scales
// passed directly, e.g. [2^10, 2^24, 2^24, 2^24, 2^24, 2^24, 2^19] for a bound of 2^14. This is the
// version the guide section shows.
export function emitPositiveBitWithScales(circuit: Circuit, difference: Wire, scales: readonly number[]): Wire {
  const [firstScale, ...laterScales] = scales
  invariant(firstScale !== undefined, 'a cascade needs at least one stage')
  // The first stage reads the signed difference, so it keeps only the positive side.
  const scaledPositive = circuit.reglu([], 1, [[difference, firstScale]], 0)
  const scaledAboveOne = circuit.reglu([], 1, [[difference, firstScale]], -1)
  let clamped = circuit.roundAffine([[scaledPositive, 1], [scaledAboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  for (const scale of laterScales) {
    const aboveOne = circuit.reglu([], 1, [[clamped, scale]], -1)
    clamped = circuit.roundAffine([[clamped, scale], [aboveOne, -1]])
    circuit.assumeRange(clamped, 0, 1)
  }
  return clamped
}

// A bound on |f(a - b)| from the declared ranges of a and b.
export function differenceBoundFromRanges(circuit: Circuit, a: Wire, b: Wire): number {
  const aRange = circuit.ranges[a]!
  const bRange = circuit.ranges[b]!
  const bound = Math.fround(Math.max(
    Math.abs(aRange.maximum - bRange.minimum),
    Math.abs(aRange.minimum - bRange.maximum),
  ))
  invariant(Number.isFinite(bound), 'a comparison needs finite declared ranges on both operands')
  return Math.max(bound, smallestSubnormal)
}

type CompareOptions = {resolution?: number, stageExponent?: number}

// [a > b]. The difference is its own operation: for finite FP32 operands, f(a - b) is zero exactly
// when a === b, and otherwise has the sign of a - b.
export function emitGreater(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}): Wire {
  const plan = planSignCascade({differenceBound: differenceBoundFromRanges(circuit, a, b), ...options})
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  return emitPositiveBit(circuit, difference, plan).bit
}

// [a >= b] = 1 - [b > a]. The negation is an ordinary affine, so the builder copies it into the
// operations that read it, without an extra layer.
export function emitAtLeast(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}): Wire {
  const bit = circuit.affine([[emitGreater(circuit, b, a, options), -1]], 1)
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// [a === b] = 1 - [a > b] - [a < b]. Both cascades read one difference, and the two bits can't both
// be 1, so the sum is exact.
export function emitEqual(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}): Wire {
  const plan = planSignCascade({differenceBound: differenceBoundFromRanges(circuit, a, b), ...options})
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  const greater = emitPositiveBit(circuit, difference, plan).bit
  const less = emitPositiveBit(circuit, circuit.affine([[difference, -1]]), plan).bit
  const bit = circuit.affine([[greater, -1], [less, -1]], 1)
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// The layout lab/trace-compiler/compile.ts (exactPositiveBit) emits: relu(difference), one scaling
// operation that lifts the range to about 2^23, then clamp01 followed by a separate scaling by
// 2^stageExponent, repeated until the total exponent reaches 150, then a last clamp01. Each scaling
// is its own operation, so a stage costs 3 operations and 3 layers. The trace compiler always uses
// stageExponent 23; other values are here to measure the cost.
export function emitTraceCompilerCascade(
  circuit: Circuit,
  difference: Wire,
  magnitude: number,
  stageExponent = 23,
): {bit: Wire, clampInputs: Wire[], clampOutputs: Wire[]} {
  invariant(magnitude > 0 && magnitude < 2 ** 23, 'the trace compiler rejects magnitudes of 2^23 or more')
  invariant(Number.isInteger(stageExponent) && stageExponent >= 1 && stageExponent <= 23, 'a stage may multiply by 2^1 to 2^23')
  const clampInputs: Wire[] = []
  const clampOutputs: Wire[] = []
  const clamp01 = (value: Wire) => {
    const aboveOne = circuit.reglu([], 1, [[value, 1]], -1)
    const clamped = circuit.roundAffine([[value, 1], [aboveOne, -1]])
    circuit.assumeRange(clamped, 0, 1)
    clampInputs.push(value)
    clampOutputs.push(clamped)
    return clamped
  }
  const firstExponent = Math.min(23 - Math.ceil(Math.log2(magnitude)), 120)
  let value = circuit.roundAffine([[circuit.reglu([], 1, [[difference, 1]], 0), 2 ** firstExponent]])
  for (let totalExponent = firstExponent; totalExponent < 150; totalExponent += stageExponent) {
    value = circuit.roundAffine([[clamp01(value), 2 ** stageExponent]])
  }
  return {bit: clamp01(value), clampInputs, clampOutputs}
}
