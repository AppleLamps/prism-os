// Soft attention over table positions with parabola keys.
//
// The query is (query, 1) and position j's key is (2j, -j²), so their dot
// product is score[j] = 2 * query * j - j² = query² - (query - j)², which is
// largest at the position nearest the query. Softmax turns the scores into
// weights, and the read is the weighted sum of the entries:
//   weight[j] = exp(sharpness * score[j]) / sum over k of exp(sharpness * score[k])
//   read = sum over j of weight[j] * table[j]
// Subtracting query² from every score leaves the weights unchanged, and turns
// every exponent into -sharpness * (query - j)², which is at most 0. The weights
// are then a Gaussian bump centered on the query.
//
// Every operation here is an affine sum or a ReLU-gated product, with no boolean
// atom, so Circuit.backpropagateReference differentiates the whole read.
import {Circuit, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {planNewtonSteps} from '../../../numeric-library/arithmetic.ts'
import {emitExp} from '../../../numeric-library/shaping.ts'

// Exponents below this are raised to it: exp(-16) is about 1.1e-7, which stands
// in for 0. emitExp is only defined for inputs within -16..16.
export const exponentFloor = -16
export const minimumSharpness = 0.25
export const maximumSharpness = 8
// Over query in 0..count-1 and sharpness in 0.25..8, the sum of the exponentials
// stays between 2 * exp(-2), about 0.27, and sqrt(pi / 0.25), about 3.54.
const totalMinimum = 0.25
const totalMaximum = 4

// 1 / value for value in [minimum, maximum], minimum > 0, by Newton's method from
// one constant first guess. Each step is estimate * relu(2 - value * estimate),
// which squares the relative error 1 - value * estimate. No comparisons are
// involved, so the backward pass can go through it.
export function emitReciprocalWithoutBits(circuit: Circuit, value: Wire, minimum: number, maximum: number): Wire {
  const seed = 2 / (minimum + maximum)
  const initialError = (maximum - minimum) / (maximum + minimum)
  const steps = planNewtonSteps(initialError, error => error * error)
  // The first step multiplies by the constant seed, so it's one ReLU-gated
  // product instead of a product followed by a ReLU-gated product.
  let estimate = circuit.reglu([], seed, [[value, -seed]], 2)
  circuit.assumeRange(estimate, 0, Math.fround(1.001 / minimum))
  for (let step = 1; step < steps; step++) {
    const product = circuit.multiply(value, estimate)
    estimate = circuit.reglu([[estimate, 1]], 0, [[product, -1]], 2)
    circuit.assumeRange(estimate, 0, Math.fround(1.001 / minimum))
  }
  return estimate
}

export function emitSoftAttentionRead(circuit: Circuit, query: Wire, sharpness: Wire, table: readonly Wire[]) {
  const querySquared = circuit.multiply(query, query)
  const exponentials = table.map((_, position) => {
    // With constant keys, a score is an affine function of the query.
    const score = circuit.affine([[query, 2 * position]], -position * position)
    const shiftedScore = circuit.affine([[score, 1], [querySquared, -1]])
    const exponent = circuit.multiply(sharpness, shiftedScore)
    const aboveFloor = circuit.reglu([], 1, [[exponent, 1]], -exponentFloor)
    const flooredExponent = circuit.affine([[aboveFloor, 1]], exponentFloor)
    circuit.assumeRange(flooredExponent, exponentFloor, 1)
    return emitExp(circuit, flooredExponent)
  })
  const total = circuit.roundAffine(exponentials.map(exponential => [exponential, 1] as const))
  circuit.assumeRange(total, totalMinimum, totalMaximum)
  const reciprocal = emitReciprocalWithoutBits(circuit, total, totalMinimum, totalMaximum)
  const weights = exponentials.map(exponential => circuit.multiply(exponential, reciprocal))
  const read = circuit.roundAffine(weights.map((weight, position) =>
    [circuit.multiply(weight, table[position]!), 1] as const))
  return {read, weights, total}
}

// Source table: [query, sharpness, table[0], ..., table[count - 1]].
export function buildSoftAttentionRead(count: number) {
  const circuit = new Circuit(2 + count)
  const query = circuit.source(0)
  const sharpness = circuit.source(1)
  const table = Array.from({length: count}, (_, position) => circuit.source(2 + position))
  circuit.assumeRange(query, 0, count - 1)
  circuit.assumeRange(sharpness, minimumSharpness, maximumSharpness)
  for (const wire of table) circuit.assumeRange(wire, -1e6, 1e6)
  const {read, weights, total} = emitSoftAttentionRead(circuit, query, sharpness, table)
  const source = (queryValue: number, sharpnessValue: number, tableValues: readonly number[]) =>
    Float32Array.from([queryValue, sharpnessValue, ...tableValues])
  return {circuit, query, sharpness, table, read, weights, total, source}
}

// Plain JS reference, in float64, with the same exponent floor.
function exponentsFor(count: number, query: number, sharpness: number) {
  return Array.from({length: count}, (_, position) => {
    const shiftedScore = 2 * query * position - position * position - query * query
    const raw = sharpness * shiftedScore
    return {value: Math.max(exponentFloor, raw), aboveFloor: raw > exponentFloor, shiftedScore}
  })
}

export function softAttentionWeights(count: number, query: number, sharpness: number): number[] {
  const exponentials = exponentsFor(count, query, sharpness).map(exponent => Math.exp(exponent.value))
  const total = exponentials.reduce((sum, exponential) => sum + exponential, 0)
  return exponentials.map(exponential => exponential / total)
}

export function softAttentionRead(table: readonly number[], query: number, sharpness: number): number {
  const weights = softAttentionWeights(table.length, query, sharpness)
  return weights.reduce((sum, weight, position) => sum + weight * table[position]!, 0)
}

// Derivatives of softAttentionRead. For read = sum w[j] * table[j] with
// w = softmax(e): d read / d table[j] = w[j], and for any parameter p,
// d read / d p = sum over j of w[j] * table[j] * (de[j]/dp - sum over k of w[k] * de[k]/dp).
export function softAttentionGradient(table: readonly number[], query: number, sharpness: number) {
  const count = table.length
  const weights = softAttentionWeights(count, query, sharpness)
  const exponents = exponentsFor(count, query, sharpness)
  const derivativeFor = (exponentDerivative: (position: number) => number) => {
    const derivatives = exponents.map((exponent, position) => exponent.aboveFloor ? exponentDerivative(position) : 0)
    const meanDerivative = weights.reduce((sum, weight, position) => sum + weight * derivatives[position]!, 0)
    return weights.reduce((sum, weight, position) =>
      sum + weight * table[position]! * (derivatives[position]! - meanDerivative), 0)
  }
  return {
    query: derivativeFor(position => sharpness * (2 * position - 2 * query)),
    sharpness: derivativeFor(position => exponents[position]!.shiftedScore),
    table: weights,
  }
}
