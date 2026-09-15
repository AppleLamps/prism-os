// Integer bits: [value >= threshold] as relu(value - threshold + 1) - relu(value - threshold).
//
// The two ReLUs make a ramp, clamp01(value - threshold + 1), that is 0 at or below threshold - 1
// and 1 at or above threshold. An integer can't land strictly between threshold - 1 and threshold,
// so for integer values the ramp returns exactly 0 or 1. Every value in between is an integer, and
// FP32 represents every integer up to 2^24, so nothing rounds while the values stay within 2^23.
import {type Circuit, type Terms, type Wire, invariant} from '../../../../../numeric-ui-core.ts'

export function emitAtLeastInteger(circuit: Circuit, value: Wire, threshold: number): Wire {
  invariant(Number.isInteger(threshold) && Math.abs(threshold) <= 2 ** 23, 'threshold must be an integer within 2^23')
  const aboveThresholdMinusOne = circuit.reglu([], 1, [[value, 1]], 1 - threshold)
  const aboveThreshold = circuit.reglu([], 1, [[value, 1]], -threshold)
  // roundAffine keeps the bit as its own operation. As an ordinary affine, the builder would copy
  // both ReLUs into every sum that reads the bit, and a large weight there makes that sum round.
  const bit = circuit.roundAffine([[aboveThresholdMinusOne, 1], [aboveThreshold, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// [sum >= 0] for a weighted sum of values on a power-of-two grid, e.g. widths that the host
// quantized to 1/64 px. Dividing by the grid step makes the sum an integer, and the integer bit
// takes over. Contract: every value is a multiple of gridStep, and every partial sum divided by
// gridStep stays within 2^23.
export function emitSumAtLeastZeroOnGrid(circuit: Circuit, terms: Terms, gridStep: number): Wire {
  invariant(gridStep > 0 && Number.isInteger(Math.log2(gridStep)), 'grid step must be a power of two')
  const gridTerms: Terms = terms.map(([wire, coefficient]) => [wire, coefficient / gridStep])
  const aboveMinusOne = circuit.reglu([], 1, gridTerms, 1)
  const aboveZero = circuit.reglu([], 1, gridTerms, 0)
  const bit = circuit.roundAffine([[aboveMinusOne, 1], [aboveZero, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// [a >= b] for values on a power-of-two grid, e.g. pointer coordinates quantized to 1/64 px.
export function emitAtLeastOnGrid(circuit: Circuit, a: Wire, b: Wire, gridStep: number): Wire {
  return emitSumAtLeastZeroOnGrid(circuit, [[a, 1], [b, -1]], gridStep)
}
