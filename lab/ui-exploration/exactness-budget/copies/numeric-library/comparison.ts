// Exact comparisons with a cost chosen from declared ranges, and the exact
// minimum, maximum, and clamp built on them.
//
// A comparison first keeps d = fround(a - b) as its own rounding point. For finite
// FP32 operands, d is zero exactly when a equals b and has the sign of a - b, so
// every comparison becomes a sign test on d. The sign test runs in stages:
// - A clamp stage computes u = clamp01(s * d) with a power-of-two scale s. The
//   scale shifts the exponent without touching the mantissa, so u is positive
//   exactly when d is positive, and u is 1 for large d. Each clamp stage widens
//   the ratio between the largest and the smallest difference the next stage has
//   to tell apart by up to 2^23 (the clamp plateau stays exact while s * |d| is
//   at most 2^23).
// - The final stage rounds a score 0.5 + s * v with the boolean atom, which
//   returns [score >= 0.5] for any FP32 score in 0..1. It resolves any v whose
//   magnitude is at least 2^-23 / s, while s * |v| stays at most 2^22, so one
//   final stage covers a ratio of 2^45 between the bound and the resolution.
// One final stage costs 4 operations and 3 layers including d. Every clamp stage
// adds 3 operations and 2 layers.
import {type Circuit, type Wire, invariant} from '../../../../../numeric-ui-core.ts'

export type Relation = '>=' | '>' | '<=' | '<'

export type CompareOptions = {
  // The smallest nonzero |a - b| that must resolve correctly. Closer pairs may
  // resolve either way. Operands on a known grid can pass the grid step, e.g. 1
  // for integers or 1/64 for 26.6 fixed point. The default resolves every pair
  // of distinct finite FP32 values.
  resolution?: number
  // A caller promise that |a| and |b| stay at most this large, used only when a
  // declared range is open. Nothing checks it at evaluation time; a false promise
  // can return the wrong operand once the scaled difference passes 2^23.
  operandMagnitude?: number
}

export type ComparePlan = {
  // A power of two at least as large as every |a - b| within the declared ranges.
  differenceBound: number
  // A power of two no larger than the requested resolution.
  resolution: number
  clampScales: number[]
  finalScale: number
}

export const smallestFloat32 = 2 ** -149
const finalStageWindowExponent = 45
const clampStageWindowExponent = 23

export function powerOfTwoAtLeast(value: number) {
  invariant(Number.isFinite(value) && value > 0, 'expected a finite positive value')
  let exponent = Math.ceil(Math.log2(value))
  while (2 ** exponent < value) exponent++
  while (exponent > -149 && 2 ** (exponent - 1) >= value) exponent--
  return exponent
}

export function powerOfTwoAtMost(value: number) {
  invariant(Number.isFinite(value) && value > 0, 'expected a finite positive value')
  let exponent = Math.max(-149, Math.floor(Math.log2(value)))
  while (exponent > -149 && 2 ** exponent > value) exponent--
  while (2 ** (exponent + 1) <= value) exponent++
  return exponent
}

export function planCompare(differenceBound: number, resolution = smallestFloat32): ComparePlan {
  const boundExponent = powerOfTwoAtLeast(Math.max(differenceBound, resolution))
  const resolutionExponent = powerOfTwoAtMost(resolution)
  invariant(boundExponent <= 126, 'comparison bound is too large')
  const clampScales: number[] = []
  let currentBoundExponent = boundExponent
  let currentResolutionExponent = resolutionExponent
  while (currentBoundExponent - currentResolutionExponent > finalStageWindowExponent) {
    const scaleExponent = clampStageWindowExponent - currentBoundExponent
    clampScales.push(2 ** scaleExponent)
    currentResolutionExponent += scaleExponent
    currentBoundExponent = 0
  }
  // The largest allowed scale leaves the most room below the resolution.
  const finalScaleExponent = 22 - currentBoundExponent
  invariant(finalScaleExponent + currentResolutionExponent >= -23, 'comparison plan is inconsistent')
  return {
    differenceBound: 2 ** boundExponent,
    resolution: 2 ** resolutionExponent,
    clampScales,
    finalScale: 2 ** finalScaleExponent,
  }
}

export function compareCost(plan: ComparePlan) {
  return {
    operations: 4 + 3 * plan.clampScales.length,
    layers: 3 + 2 * plan.clampScales.length,
  }
}

// A bound on |fround(a - b)| from the declared ranges, or Infinity when either
// range is open.
export function differenceBound(circuit: Circuit, a: Wire, b: Wire) {
  const aRange = circuit.ranges[a]!
  const bRange = circuit.ranges[b]!
  const bound = Math.max(
    Math.abs(aRange.minimum - bRange.maximum),
    Math.abs(aRange.maximum - bRange.minimum),
  )
  return Number.isFinite(bound) ? Math.fround(bound) : Number.POSITIVE_INFINITY
}

function emitClampStage(circuit: Circuit, value: Wire, coefficient: number) {
  const positive = circuit.reglu([], 1, [[value, coefficient]], 0)
  const aboveOne = circuit.reglu([], 1, [[value, coefficient]], -1)
  const clamped = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return clamped
}

// The boolean of [coefficient * value >= 0], or of [coefficient * value > 0]
// when strict. The strict form lowers the bias by one FP32 step below 0.5.
function emitFinalStage(circuit: Circuit, value: Wire, coefficient: number, strict: boolean) {
  const bias = strict ? 0.5 - 2 ** -25 : 0.5
  const positive = circuit.reglu([], 1, [[value, coefficient]], bias)
  const aboveOne = circuit.reglu([], 1, [[value, coefficient]], bias - 1)
  const score = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(score, 0, 1)
  return circuit.boolean(score)
}

// The exact bit of `difference relation 0` for a materialized difference whose
// magnitude the plan bounds.
export function emitSignBit(circuit: Circuit, difference: Wire, relation: Relation, plan: ComparePlan): Wire {
  const sign = relation === '>=' || relation === '>' ? 1 : -1
  const strict = relation === '>' || relation === '<'
  if (plan.clampScales.length === 0) {
    return emitFinalStage(circuit, difference, sign * plan.finalScale, strict)
  }
  // Strict: u > 0 exactly when sign * d > 0, then test [u > 0].
  // Non-strict: u > 0 exactly when sign * d < 0, then test [-u >= 0].
  let stage = emitClampStage(circuit, difference, (strict ? sign : -sign) * plan.clampScales[0]!)
  for (let index = 1; index < plan.clampScales.length; index++) {
    stage = emitClampStage(circuit, stage, plan.clampScales[index]!)
  }
  return strict
    ? emitFinalStage(circuit, stage, plan.finalScale, true)
    : emitFinalStage(circuit, stage, -plan.finalScale, false)
}

export function emitDifference(circuit: Circuit, a: Wire, b: Wire) {
  return circuit.roundAffine([[a, 1], [b, -1]])
}

export function planCompareFromRanges(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}) {
  const declaredBound = differenceBound(circuit, a, b)
  const bound = Number.isFinite(declaredBound) || options.operandMagnitude === undefined
    ? declaredBound
    : Math.fround(2 * options.operandMagnitude)
  invariant(Number.isFinite(bound), 'exact comparison needs finite declared operand ranges or operandMagnitude')
  return planCompare(bound, options.resolution ?? smallestFloat32)
}

// [a relation b] as an exact bit. Exact for every pair of finite FP32 operands
// inside the declared ranges that differ by at least the resolution (or are equal).
export function emitCompare(circuit: Circuit, a: Wire, b: Wire, relation: Relation, options: CompareOptions = {}): Wire {
  const plan = planCompareFromRanges(circuit, a, b, options)
  return emitSignBit(circuit, emitDifference(circuit, a, b), relation, plan)
}

// on * [bit] + off * [1 - bit] for an exact bit, as two ReGLU products. At bit 0
// or 1 the unselected product is fround(off * 0) = ±0, so the sum returns the
// selected finite operand exactly. The sum is an ordinary affine, so an affine
// consumer composes it without changing any result.
export function emitSelectBit(circuit: Circuit, bit: Wire, off: Wire, on: Wire): Wire {
  const selectedOn = circuit.reglu([[on, 1]], 0, [[bit, 1]], 0)
  const selectedOff = circuit.reglu([[off, 1]], 0, [[bit, -1]], 1)
  return circuit.affine([[selectedOn, 1], [selectedOff, 1]])
}

function toleranceOf(options: CompareOptions) {
  const resolution = options.resolution ?? smallestFloat32
  return resolution <= smallestFloat32 ? 0 : resolution
}

function narrow(circuit: Circuit, wire: Wire, minimum: number, maximum: number) {
  const range = circuit.ranges[wire]!
  const lower = Math.max(range.minimum, Math.fround(minimum))
  const upper = Math.min(range.maximum, Math.fround(maximum))
  if (lower <= upper) circuit.assumeRange(wire, lower, upper)
}

// Math.min(a, b), returning exactly one of the operands. Ties return a.
export function emitMinimumExact(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}): Wire {
  const aIsSmaller = emitCompare(circuit, a, b, '<=', options)
  const result = emitSelectBit(circuit, aIsSmaller, b, a)
  const aRange = circuit.ranges[a]!
  const bRange = circuit.ranges[b]!
  narrow(
    circuit,
    result,
    Math.min(aRange.minimum, bRange.minimum),
    Math.min(aRange.maximum, bRange.maximum) + toleranceOf(options),
  )
  return result
}

// Math.max(a, b), returning exactly one of the operands. Ties return a.
export function emitMaximumExact(circuit: Circuit, a: Wire, b: Wire, options: CompareOptions = {}): Wire {
  const aIsLarger = emitCompare(circuit, a, b, '>=', options)
  const result = emitSelectBit(circuit, aIsLarger, b, a)
  const aRange = circuit.ranges[a]!
  const bRange = circuit.ranges[b]!
  narrow(
    circuit,
    result,
    Math.max(aRange.minimum, bRange.minimum) - toleranceOf(options),
    Math.max(aRange.maximum, bRange.maximum),
  )
  return result
}

// Math.min(Math.max(value, minimum), maximum).
export function emitClampExact(circuit: Circuit, value: Wire, minimum: Wire, maximum: Wire, options: CompareOptions = {}) {
  return emitMinimumExact(circuit, emitMaximumExact(circuit, value, minimum, options), maximum, options)
}

// The minimum of k values through counting instead of a tournament: one exact
// comparison per pair in one layer, a winner bit per value from the integer count
// of pairs it wins (first index wins ties), then a masked read declared as a
// one-hot group, which gather lowering turns into one indexed read.
export function emitMinimumOf(circuit: Circuit, values: readonly Wire[], options: CompareOptions = {}) {
  const count = values.length
  invariant(count > 0, 'minimum needs at least one value')
  if (count === 1) return {minimum: values[0]!, winners: [circuit.affine([], 1)]}
  const lessOrEqual: Wire[][] = Array.from({length: count}, () => Array<Wire>(count))
  for (let first = 0; first < count; first++) {
    for (let second = first + 1; second < count; second++) {
      lessOrEqual[first]![second] = emitCompare(circuit, values[first]!, values[second]!, '<=', options)
    }
  }
  const winners: Wire[] = []
  for (let item = 0; item < count; item++) {
    const terms: [Wire, number][] = []
    for (let other = 0; other < count; other++) {
      if (other > item) terms.push([lessOrEqual[item]![other]!, 1])
      if (other < item) terms.push([lessOrEqual[other]![item]!, -1])
    }
    // count_i = sum over later j of [v_i <= v_j] + sum over earlier j of [v_i < v_j],
    // an integer in 0..k-1, and v_i wins when it reaches k-1.
    const winner = circuit.reglu([], 1, terms, item - (count - 2))
    circuit.assumeRange(winner, 0, 1)
    winners.push(winner)
  }
  circuit.assumeOneHot(winners)
  const minimum = circuit.affine(values.map((value, item) => [circuit.multiply(value, winners[item]!), 1]))
  let lower = Number.POSITIVE_INFINITY
  let upper = Number.POSITIVE_INFINITY
  for (const value of values) {
    lower = Math.min(lower, circuit.ranges[value]!.minimum)
    upper = Math.min(upper, circuit.ranges[value]!.maximum)
  }
  narrow(circuit, minimum, lower, upper + toleranceOf(options))
  return {minimum, winners}
}
