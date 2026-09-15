// Rounding to integers from FP32 rounding itself.
import {type Circuit, type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type CompareOptions, emitSignBit, planCompare, smallestFloat32} from './comparison.ts'

// FP32 steps are exactly 1 in [2^23, 2^24). Adding this base and subtracting it
// again rounds to the nearest integer, ties to even because the base is even.
const roundingBase = 2 ** 23 + 2 ** 22
export const roundDomain = 2 ** 22

function requireRange(circuit: Circuit, wire: Wire, limit: number, label: string) {
  const range = circuit.ranges[wire]!
  invariant(range.minimum > -limit && range.maximum < limit, `${label} needs a declared range inside (-${limit}, ${limit})`)
  return range
}

// Round to the nearest integer, ties to even (Math.round sends ties up instead).
// Domain |x| < 2^22. 2 operations, 2 layers.
export function emitRound(circuit: Circuit, value: Wire): Wire {
  const range = requireRange(circuit, value, roundDomain, 'round')
  const shifted = circuit.roundAffine([[value, 1]], roundingBase)
  const rounded = circuit.roundAffine([[shifted, 1]], -roundingBase)
  circuit.assumeRange(rounded, Math.floor(range.minimum), Math.ceil(range.maximum))
  return rounded
}

// Math.floor(x) for x on a grid of 2^-gridBits, e.g. gridBits 6 for 1/64 px.
// Shifting by half a grid step below 0.5 means the rounding never meets a tie.
// Domain |x| < 2^(22 - gridBits). 3 operations, 3 layers.
export function emitFloorOnGrid(circuit: Circuit, value: Wire, gridBits: number): Wire {
  invariant(Number.isInteger(gridBits) && gridBits >= 0 && gridBits <= 21, 'grid bits must be an integer in 0..21')
  const range = requireRange(circuit, value, 2 ** (22 - gridBits), 'floor on a grid')
  const shifted = circuit.roundAffine([[value, 1]], 2 ** -(gridBits + 1) - 0.5)
  const floor = emitRound(circuit, shifted)
  circuit.assumeRange(floor, Math.floor(range.minimum), Math.floor(range.maximum))
  return floor
}

// Math.floor(x) for any FP32 x with |x| < 2^22. r = round(x) and d = r - x are
// exact (|d| <= 0.5 and r is within a factor of two of x, or zero), and the floor
// is r - [d > 0]. A positive d is at least 2^-24 unless x is in (-0.5, 0), where
// d = -x. So a range with minimum >= 0 needs only the 4-operation sign test, and
// signed ranges default to the sign test that resolves every FP32 value.
// Pass `resolution` to resolve negative values only down to that magnitude.
export function emitFloor(circuit: Circuit, value: Wire, options: CompareOptions = {}): Wire {
  const range = requireRange(circuit, value, roundDomain, 'floor')
  const rounded = emitRound(circuit, value)
  const difference = circuit.roundAffine([[rounded, 1], [value, -1]])
  circuit.assumeRange(difference, -0.5, 0.5)
  const resolution = options.resolution ?? (range.minimum >= 0 ? 2 ** -24 : smallestFloat32)
  const plan = planCompare(0.5, Math.min(resolution, 2 ** -24))
  const roundedAbove = emitSignBit(circuit, difference, '>', plan)
  const floor = circuit.affine([[rounded, 1], [roundedAbove, -1]])
  circuit.assumeRange(floor, Math.floor(range.minimum), Math.floor(range.maximum))
  return floor
}

// Math.ceil(x) = -floor(-x).
export function emitCeil(circuit: Circuit, value: Wire, options: CompareOptions = {}): Wire {
  const negated = circuit.roundAffine([[value, -1]])
  const range = circuit.ranges[value]!
  const floorOptions = options.resolution === undefined && range.maximum <= 0 ? {resolution: 2 ** -24} : options
  const ceil = circuit.affine([[emitFloor(circuit, negated, floorOptions), -1]])
  circuit.assumeRange(ceil, Math.ceil(range.minimum), Math.ceil(range.maximum))
  return ceil
}

// x - floor(x), kept as its own rounding point. In 0..1; exact for x >= 0.
// A tiny negative x returns fround(1 - |x|), which can be exactly 1.
export function emitFract(circuit: Circuit, value: Wire, options: CompareOptions = {}): Wire {
  const fraction = circuit.roundAffine([[value, 1], [emitFloor(circuit, value, options), -1]])
  circuit.assumeRange(fraction, 0, 1)
  return fraction
}

// The one-hot of an integer wire n in minimum..maximum, declared as a group.
// With R_t = relu(n - t), [n >= j] = R_(j-1) - R_j, and each member is a
// difference of neighbors. Exact for integers below 2^23 in magnitude.
// 2K - 1 operations and 2 layers for K members.
export function emitIntegerOneHot(circuit: Circuit, value: Wire, minimum: number, maximum: number): Wire[] {
  invariant(Number.isInteger(minimum) && Number.isInteger(maximum) && minimum <= maximum, 'one-hot bounds must be integers')
  const range = circuit.ranges[value]!
  invariant(range.minimum >= minimum && range.maximum <= maximum, 'value range must lie inside the one-hot bounds')
  if (minimum === maximum) return [circuit.affine([], 1)]
  // atLeast[j - minimum] = [n >= j] as terms; [n >= minimum] = 1.
  const reluAt = new Map<number, Wire>()
  for (let threshold = minimum; threshold < maximum; threshold++) {
    reluAt.set(threshold, circuit.reglu([], 1, [[value, 1]], -threshold))
  }
  const atLeastTerms = (threshold: number): {terms: [Wire, number][], bias: number} => {
    if (threshold <= minimum) return {terms: [], bias: 1}
    if (threshold > maximum) return {terms: [], bias: 0}
    // [n >= j] = relu(n - (j - 1)) - relu(n - j); relu(n - (minimum - 1)) = n - minimum + 1.
    const upper = threshold - 1 === minimum - 1
      ? {terms: [[value, 1]] as [Wire, number][], bias: 1 - minimum}
      : {terms: [[reluAt.get(threshold - 1)!, 1]] as [Wire, number][], bias: 0}
    const lower = reluAt.get(threshold)
    return {
      terms: lower === undefined ? upper.terms : [...upper.terms, [lower, -1]],
      bias: upper.bias,
    }
  }
  const members: Wire[] = []
  for (let member = minimum; member <= maximum; member++) {
    const current = atLeastTerms(member)
    const next = atLeastTerms(member + 1)
    const terms: [Wire, number][] = [...current.terms, ...next.terms.map(([wire, coefficient]): [Wire, number] => [wire, -coefficient])]
    members.push(circuit.roundAffine(terms, current.bias - next.bias))
  }
  circuit.assumeOneHot(members)
  return members
}
