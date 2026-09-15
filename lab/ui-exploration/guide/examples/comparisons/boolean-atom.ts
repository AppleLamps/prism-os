// Comparisons that end in the boolean atom:
//   boolean(score) = f(f(score + 8,388,609) - 8,388,609)
// It returns 0 for a score below 0.5 and 1 for a score of 0.5 or more. Between 2^23 and 2^24 the
// FP32 values are whole numbers, so adding 8,388,609 rounds the score to a whole number, and
// subtracting 8,388,609 leaves exactly 0 or 1.
//
// A rounding stage scores clamp01(0.5 - 2^-25 + scale * value) and rounds the score. 0.5 - 2^-25 is
// the FP32 value just below 0.5, so a value of 0 gives 0, and any positive value that moves the
// score up by at least one FP32 step gives 1. The score doesn't have to be exact where the clamp
// holds it at 1, only at least 0.5, so one rounding stage handles a ratio of up to 2^45 between the
// largest value and the smallest positive value it must detect (numeric-library's contract), where
// a clamp stage handles 2^24.
import {type Circuit, type Terms, type Wire, invariant} from '../../../../../numeric-ui-core.ts'
import {powerOfTwoExponentAtLeast, powerOfTwoExponentAtMost, smallestSubnormal} from './fp32.ts'
import {type CascadePlan, differenceBoundFromRanges, emitPositiveBit, planSignCascade} from './sign-cascade.ts'

export const roundingStageRatioExponent = 45
const justBelowHalf = 0.5 - 2 ** -25

export type RoundingPlan = {
  // Clamp stages that run first when one rounding stage can't cover the ratio.
  clampStages: CascadePlan | null
  finalScale: number
}

export function planRoundingCompare(options: {differenceBound: number, resolution?: number}): RoundingPlan {
  const boundExponent = powerOfTwoExponentAtLeast(options.differenceBound)
  const resolutionExponent = powerOfTwoExponentAtMost(options.resolution ?? smallestSubnormal)
  if (boundExponent <= 22 && boundExponent - resolutionExponent <= roundingStageRatioExponent) {
    return {clampStages: null, finalScale: 2 ** (22 - boundExponent)}
  }
  // Clamp stages bring the value into 0..1 while every difference at or above the resolution stays
  // at least 2^-45, which the final rounding stage detects.
  const clampStages = planSignCascade({
    differenceBound: options.differenceBound,
    resolution: 2 ** Math.min(0, resolutionExponent + roundingStageRatioExponent),
  })
  return {clampStages, finalScale: 2 ** 22}
}

export function emitRoundingStage(circuit: Circuit, value: Wire, scale: number): Wire {
  const scoreAboveZero = circuit.reglu([], 1, [[value, scale]], justBelowHalf)
  const scoreAboveOne = circuit.reglu([], 1, [[value, scale]], justBelowHalf - 1)
  // An ordinary affine: the builder copies it into the boolean atom's operation.
  const score = circuit.affine([[scoreAboveZero, 1], [scoreAboveOne, -1]])
  circuit.assumeRange(score, 0, 1)
  return circuit.boolean(score)
}

// [difference > 0] with optional clamp stages first and a rounding stage at the end.
export function emitPositiveBitByRounding(circuit: Circuit, difference: Wire, plan: RoundingPlan): Wire {
  const value = plan.clampStages === null ? difference : emitPositiveBit(circuit, difference, plan.clampStages).bit
  return emitRoundingStage(circuit, value, plan.finalScale)
}

export function emitGreaterByRounding(circuit: Circuit, a: Wire, b: Wire, options: {resolution?: number} = {}): Wire {
  const plan = planRoundingCompare({differenceBound: differenceBoundFromRanges(circuit, a, b), ...options})
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  return emitPositiveBitByRounding(circuit, difference, plan)
}

export function emitAtLeastByRounding(circuit: Circuit, a: Wire, b: Wire, options: {resolution?: number} = {}): Wire {
  const bit = circuit.affine([[emitGreaterByRounding(circuit, b, a, options), -1]], 1)
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// text-editing's one-operation integer comparison: [sum >= 0] as one boolean atom on the score
// 0.5 + sum * 2^-24 / gridStep. The builder adds the bias first and then the terms in wire order.
// When every value is a multiple of gridStep and every partial sum stays within 2^22 grid steps,
// every partial score is a multiple of 2^-24 between 0.25 and 0.75, which FP32 represents exactly.
// So the score is exactly 0.5 when the sum is 0, which rounds to 1, and at most 0.5 - 2^-24 when the
// sum is negative, which rounds to 0. Contract: every value is a multiple of gridStep, and the terms
// read source cells or operations that the builder doesn't copy into readers (e.g. roundAffine).
export function emitSumAtLeastZeroByRounding(circuit: Circuit, terms: Terms, gridStep: number): Wire {
  invariant(gridStep > 0 && Number.isInteger(Math.log2(gridStep)), 'grid step must be a power of two')
  let partialMinimum = 0
  let partialMaximum = 0
  for (const [wire, coefficient] of [...terms].sort(([left], [right]) => left - right)) {
    const {minimum, maximum} = circuit.ranges[wire]!
    partialMinimum += Math.min(coefficient * minimum, coefficient * maximum) / gridStep
    partialMaximum += Math.max(coefficient * minimum, coefficient * maximum) / gridStep
    invariant(partialMinimum >= -(2 ** 22) && partialMaximum <= 2 ** 22, 'every partial sum must stay within 2^22 grid steps')
  }
  const scale = 2 ** -24 / gridStep
  const score = circuit.affine(terms.map(([wire, coefficient]) => [wire, coefficient * scale]), 0.5)
  return circuit.boolean(score)
}

// [a >= b] for integers a and b declared within [0, 2^22].
export function emitAtLeastIntegerByRounding(circuit: Circuit, a: Wire, b: Wire): Wire {
  return emitSumAtLeastZeroByRounding(circuit, [[a, 1], [b, -1]], 1)
}
