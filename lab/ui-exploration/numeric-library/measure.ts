// Shared helpers for tests and the report: compiled size of a circuit, a seeded
// random generator, and stepping to neighboring FP32 values.
import {type Circuit, type Wire} from '../../../numeric-ui-core.ts'

export const f = Math.fround

export type ProgramSize = {
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
  booleans: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  let booleans = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    booleans += layer.booleanRows.length
  }
  return {
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    booleans,
  }
}

export function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

const scratchFloat = new Float32Array(1)
const scratchWord = new Uint32Array(scratchFloat.buffer)

// The FP32 value `steps` representable values above `value` (negative steps go
// below). Crosses zero correctly, e.g. one step below 0 is -2^-149.
export function stepFloat32(value: number, steps: number): number {
  let current = f(value)
  const direction = steps > 0 ? 1 : -1
  for (let step = 0; step < Math.abs(steps); step++) {
    if (current === 0) {
      current = direction * 2 ** -149
      continue
    }
    scratchFloat[0] = current
    const awayFromZero = (current > 0) === (direction > 0)
    scratchWord[0] = scratchWord[0]! + (awayFromZero ? 1 : -1)
    current = scratchFloat[0]!
  }
  return current
}

// A random FP32 value whose magnitude is log-uniform in [2^minimumExponent,
// 2^maximumExponent), with a random sign when `signed` is set.
export function randomLogUniform(
  random: () => number,
  minimumExponent: number,
  maximumExponent: number,
  signed: boolean,
): number {
  const magnitude = f(2 ** (minimumExponent + random() * (maximumExponent - minimumExponent)))
  return signed && random() < 0.5 ? -magnitude : magnitude
}

// The smallest FP32 value at or above `value`. For an FP32 x and a threshold t,
// x >= t exactly when x >= ceilFloat32(t), so a circuit comparing against this
// constant matches the float64 comparison, e.g. progress >= 5 / 24.
export function ceilFloat32(value: number): number {
  const rounded = f(value)
  return rounded < value ? stepFloat32(rounded, 1) : rounded
}

// Pearson's chi-square statistic of bucket counts against an even spread.
export function chiSquareStatistic(buckets: readonly number[]) {
  const total = buckets.reduce((sum, bucket) => sum + bucket, 0)
  const expected = total / buckets.length
  return buckets.reduce((sum, bucket) => sum + (bucket - expected) ** 2 / expected, 0)
}

function logGamma(value: number): number {
  // Lanczos approximation with g = 7.
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (value < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value)
  const shifted = value - 1
  let sum = 0.99999999999980993
  for (let index = 0; index < coefficients.length; index++) sum += coefficients[index]! / (shifted + index + 1)
  const t = shifted + coefficients.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum)
}

// The probability that an even spread gives a chi-square statistic at least this
// large, e.g. 88.7 with 63 degrees of freedom gives about 0.018. This is the upper
// regularized gamma function Q(degrees / 2, statistic / 2), by its series below
// a + 1 and by its continued fraction above, as in Numerical Recipes.
export function chiSquarePValue(statistic: number, degrees: number): number {
  const a = degrees / 2
  const x = statistic / 2
  const scale = Math.exp(-x + a * Math.log(x) - logGamma(a))
  if (x < a + 1) {
    let term = 1 / a
    let sum = term
    for (let n = 1; n < 1000 && term > sum * 1e-15; n++) {
      term *= x / (a + n)
      sum += term
    }
    return 1 - sum * scale
  }
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let fraction = d
  for (let index = 1; index < 1000; index++) {
    const numerator = -index * (index - a)
    b += 2
    d = numerator * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + numerator / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    fraction *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return scale * fraction
}

export function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction > 0.5) return floor + 1
  if (fraction < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

export function formatCount(value: number) {
  return value.toLocaleString('en-US')
}
