// Reciprocal, division, and square root over declared ranges: a constant seed per
// bucket of the input, chosen by threshold bits, then Newton steps built from
// products and additions.
import {type Circuit, type Wire, invariant} from '../../../src/runtime/numeric-ui-core.ts'

export type NewtonOptions = {
  // Buckets per octave of the input. More buckets make a better seed and fewer
  // Newton steps, at 3 operations per bucket.
  bucketsPerOctave?: number
  // Overrides the planned Newton step count.
  newtonSteps?: number
}

// Threshold bits [x >= threshold] for a positive x, as boolean(clamp01(x /
// threshold - 0.5)). The score is composed into both relus, which keeps the
// plateau exact while x / threshold <= 2^22. A bit that resolves the wrong way
// within one FP32 step of its threshold only picks the neighboring bucket's seed,
// which the planned Newton steps also absorb.
function emitThresholdBits(circuit: Circuit, value: Wire, thresholds: readonly number[]) {
  return thresholds.map(threshold => {
    const positive = circuit.reglu([], 1, [[value, 1 / threshold]], -0.5)
    const aboveOne = circuit.reglu([], 1, [[value, 1 / threshold]], -1.5)
    const clamped = circuit.affine([[positive, 1], [aboveOne, -1]])
    circuit.assumeRange(clamped, 0, 1)
    return circuit.boolean(clamped)
  })
}

// A piecewise-constant seed: the bucket's constant plus first differences over the
// threshold bits, as one affine.
function emitBucketSeed(circuit: Circuit, bits: readonly Wire[], seedForBucket: (bucket: number) => number) {
  const seed = circuit.affine(
    bits.map((bit, index) => [bit, seedForBucket(index + 1) - seedForBucket(index)]),
    seedForBucket(0),
  )
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let bucket = 0; bucket <= bits.length; bucket++) {
    minimum = Math.min(minimum, seedForBucket(bucket))
    maximum = Math.max(maximum, seedForBucket(bucket))
  }
  circuit.assumeRange(seed, Math.fround(minimum * 0.999), Math.fround(maximum * 1.001))
  return seed
}

function bucketsFor(minimum: number, maximum: number, bucketsPerOctave: number) {
  const octaves = Math.log2(maximum / minimum)
  const bucketCount = Math.max(1, Math.ceil(octaves * bucketsPerOctave - 1e-9))
  const thresholds = Array.from({length: bucketCount - 1}, (_, index) => minimum * 2 ** ((index + 1) / bucketsPerOctave))
  return {bucketCount, thresholds, middle: (bucket: number) => minimum * 2 ** ((bucket + 0.5) / bucketsPerOctave)}
}

// Steps until the planned relative error reaches 2^-26, below FP32's rounding floor.
export function planNewtonSteps(initialError: number, update: (error: number) => number) {
  let error = initialError
  let steps = 0
  while (error > 2 ** -26) {
    error = update(error)
    steps++
    invariant(steps <= 12, 'Newton iteration does not converge from this seed')
  }
  return steps
}

function positiveDomain(circuit: Circuit, value: Wire, label: string) {
  const range = circuit.ranges[value]!
  invariant(range.minimum > 0 && Number.isFinite(range.maximum), `${label} needs a declared positive finite range`)
  invariant(range.maximum / range.minimum <= 2 ** 22, `${label} supports a ratio of at most 2^22 between the range endpoints`)
  return range
}

export function reciprocalPlan(minimum: number, maximum: number, options: NewtonOptions = {}) {
  const bucketsPerOctave = options.bucketsPerOctave ?? 1
  const buckets = bucketsFor(minimum, maximum, bucketsPerOctave)
  // A seed for the bucket's geometric middle leaves x * seed within 2^(±1/(2p)).
  const initialError = 2 ** (1 / (2 * bucketsPerOctave)) - 1
  // Newton's step x * (2 - b * x) squares the relative error 1 - b * x.
  const newtonSteps = options.newtonSteps ?? planNewtonSteps(initialError, error => error * error)
  return {...buckets, bucketsPerOctave, initialError, newtonSteps}
}

// 1 / x for x in the declared range [minimum, maximum] with minimum > 0, or with
// maximum < 0 (negated). Costs 3 operations per threshold and 2 per Newton step.
export function emitReciprocal(circuit: Circuit, value: Wire, options: NewtonOptions = {}): Wire {
  const range = circuit.ranges[value]!
  if (range.maximum < 0) {
    const negated = circuit.roundAffine([[value, -1]])
    const reciprocal = circuit.roundAffine([[emitReciprocal(circuit, negated, options), -1]])
    circuit.assumeRange(reciprocal, Math.fround(-2 / -range.maximum), 0)
    return reciprocal
  }
  positiveDomain(circuit, value, 'reciprocal')
  const plan = reciprocalPlan(range.minimum, range.maximum, options)
  const bits = emitThresholdBits(circuit, value, plan.thresholds)
  let estimate = emitBucketSeed(circuit, bits, bucket => 1 / plan.middle(bucket))
  for (let step = 0; step < plan.newtonSteps; step++) {
    const product = circuit.multiply(value, estimate)
    // estimate * max(0, 2 - x * estimate); the gate stays inside (0, 2).
    estimate = circuit.reglu([[estimate, 1]], 0, [[product, -1]], 2)
    circuit.assumeRange(estimate, 0, Math.fround(1.001 / range.minimum))
  }
  return estimate
}

// numerator / denominator as numerator * reciprocal(denominator).
export function emitDivide(circuit: Circuit, numerator: Wire, denominator: Wire, options: NewtonOptions = {}): Wire {
  return circuit.multiply(numerator, emitReciprocal(circuit, denominator, options))
}

export type SquareRootOptions = NewtonOptions & {
  // The smallest positive input the error bound covers, required when the declared
  // range starts at zero. Zero itself returns exactly zero.
  minimumPositive?: number
}

export function squareRootPlan(minimum: number, maximum: number, options: NewtonOptions = {}) {
  const bucketsPerOctave = options.bucketsPerOctave ?? 1
  const buckets = bucketsFor(minimum, maximum, bucketsPerOctave)
  // The seed leaves x * r^2 within 2^(±1/(2p)); track e = 1 - x * r^2.
  const initialError = 2 ** (1 / (2 * bucketsPerOctave)) - 1
  const update = (error: number) => {
    const worst = (epsilon: number) => Math.abs(1 - (1 - epsilon) * (1 + epsilon / 2) ** 2)
    return Math.max(worst(error), worst(-error))
  }
  const newtonSteps = options.newtonSteps ?? planNewtonSteps(initialError, update)
  return {...buckets, bucketsPerOctave, initialError, newtonSteps}
}

// Math.sqrt(x) for x = 0 or x in [minimumPositive, maximum]. Computes 1 / sqrt(x)
// with Newton's step r * (1.5 - 0.5 * x * r^2), then multiplies by x. Costs 3
// operations per threshold, 3 per Newton step, and 1 final product.
export function emitSqrt(circuit: Circuit, value: Wire, options: SquareRootOptions = {}): Wire {
  const range = circuit.ranges[value]!
  invariant(range.minimum >= 0 && Number.isFinite(range.maximum), 'square root needs a declared nonnegative finite range')
  const minimumPositive = range.minimum > 0 ? range.minimum : options.minimumPositive
  invariant(minimumPositive !== undefined && minimumPositive > 0, 'square root over a range starting at zero needs minimumPositive')
  invariant(range.maximum / minimumPositive <= 2 ** 22, 'square root supports a ratio of at most 2^22 between the range endpoints')
  const plan = squareRootPlan(minimumPositive, range.maximum, options)
  const bits = emitThresholdBits(circuit, value, plan.thresholds)
  let inverseRoot = emitBucketSeed(circuit, bits, bucket => 1 / Math.sqrt(plan.middle(bucket)))
  const inverseRootMaximum = Math.fround(1.5 ** plan.newtonSteps * circuit.ranges[inverseRoot]!.maximum)
  for (let step = 0; step < plan.newtonSteps; step++) {
    const squared = circuit.multiply(inverseRoot, inverseRoot)
    const scaled = circuit.multiply(value, squared)
    inverseRoot = circuit.reglu([[inverseRoot, 1]], 0, [[scaled, -0.5]], 1.5)
    circuit.assumeRange(inverseRoot, 0, inverseRootMaximum)
  }
  const root = circuit.multiply(value, inverseRoot)
  circuit.assumeRange(root, 0, Math.fround(Math.sqrt(range.maximum) * 1.001))
  return root
}
