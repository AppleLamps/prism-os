import {expect, test} from 'bun:test'
import {Circuit, validateOneHotGroups} from '../../../numeric-ui-core.ts'
import {
  type Relation,
  compareCost,
  emitCeil,
  emitClampExact,
  emitCompare,
  emitDivide,
  emitExp,
  emitFloor,
  emitFloorOnGrid,
  emitFract,
  emitHash,
  emitIntegerOneHot,
  emitMaximumExact,
  emitMinimumExact,
  emitMinimumOf,
  emitMix,
  emitReciprocal,
  emitRemap,
  emitRemapRuntime,
  emitRound,
  emitSinCos,
  emitSmoothstep,
  emitSmoothstepRuntime,
  emitSqrt,
  hashReference,
  planCompare,
  reciprocalPlan,
} from './library.ts'
import {chiSquarePValue, chiSquareStatistic, createRandom, f, measureProgram, randomLogUniform, roundHalfEven, stepFloat32} from './measure.ts'

const relations: Relation[] = ['>=', '>', '<=', '<']

function nativeRelation(a: number, b: number, relation: Relation) {
  if (relation === '>=') return Number(a >= b)
  if (relation === '>') return Number(a > b)
  if (relation === '<=') return Number(a <= b)
  return Number(a < b)
}

function comparisonCircuit(magnitude: number, resolution?: number) {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, -magnitude, magnitude)
  circuit.assumeRange(1, -magnitude, magnitude)
  const options = resolution === undefined ? {} : {resolution}
  const roots = [
    ...relations.map(relation => emitCompare(circuit, 0, 1, relation, options)),
    emitMinimumExact(circuit, 0, 1, options),
    emitMaximumExact(circuit, 0, 1, options),
  ]
  return {circuit, run: circuit.createTensorEvaluator(roots)}
}

function checkPairs(magnitude: number, resolution: number | undefined, pairs: Iterable<[number, number]>) {
  const {run} = comparisonCircuit(magnitude, resolution)
  const input = new Float32Array(2)
  let checked = 0
  for (const [a, b] of pairs) {
    if (!(Math.abs(a) <= magnitude && Math.abs(b) <= magnitude)) continue
    input[0] = a
    input[1] = b
    const output = run(input)
    for (let index = 0; index < relations.length; index++) {
      if (output[index] !== nativeRelation(a, b, relations[index]!)) {
        throw new Error(`[${a} ${relations[index]} ${b}] returned ${output[index]}`)
      }
    }
    if (output[4] !== Math.min(a, b) || output[5] !== Math.max(a, b)) {
      throw new Error(`min/max of ${a}, ${b} returned ${output[4]}, ${output[5]}`)
    }
    checked++
  }
  return checked
}

function* adjacentPairs(random: () => number, count: number, minimumExponent: number, maximumExponent: number): Generator<[number, number]> {
  for (let trial = 0; trial < count; trial++) {
    const a = randomLogUniform(random, minimumExponent, maximumExponent, true)
    yield [a, stepFloat32(a, Math.floor(random() * 5) - 2)]
  }
}

test('comparison plans pick the stage count from the bound and resolution', () => {
  expect(compareCost(planCompare(2 ** 15, 1))).toEqual({operations: 4, layers: 3})
  expect(compareCost(planCompare(2 ** 15, 2 ** -30))).toEqual({operations: 4, layers: 3})
  expect(compareCost(planCompare(2 ** 15, 2 ** -31))).toEqual({operations: 7, layers: 5})
  expect(compareCost(planCompare(2 ** 15))).toEqual({operations: 22, layers: 15})
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 16_384)
  circuit.assumeRange(1, 0, 16_384)
  expect(measureProgram(circuit, [emitCompare(circuit, 0, 1, '>=', {resolution: 2 ** -30})])).toEqual({liveOperations: 4, layers: 3, storedWeights: 6, gatherReads: 0, booleans: 1})
})

test('one-stage comparison is exact on integers and at the bound', () => {
  const random = createRandom(1)
  const pairs: [number, number][] = []
  for (let trial = 0; trial < 20_000; trial++) {
    const a = Math.round((random() * 2 - 1) * 2 ** 20)
    pairs.push([a, Math.max(-(2 ** 20), Math.min(2 ** 20, a + Math.round((random() * 2 - 1) * 3)))])
  }
  pairs.push([2 ** 20, -(2 ** 20)], [-(2 ** 20), 2 ** 20], [2 ** 20, 2 ** 20 - 1], [0, 0])
  expect(checkPairs(2 ** 20, 1, pairs)).toBe(pairs.length)
})

test('one-stage comparison over pixel ranges resolves every FP32 pair with magnitudes at least 2^-7', () => {
  const random = createRandom(2)
  const pairs = [...adjacentPairs(random, 30_000, -7, 14)]
  for (let trial = 0; trial < 10_000; trial++) {
    pairs.push([f((random() * 2 - 1) * 16_384), f((random() * 2 - 1) * 16_384)])
  }
  pairs.push([16_384, -16_384], [-16_384, 16_384], [16_384, stepFloat32(16_384, -1)], [2 ** -7, 0], [0, -(2 ** -7)])
  expect(checkPairs(16_384, 2 ** -30, pairs)).toBe(pairs.length)
})

test('the default comparison resolves every pair of distinct finite FP32 values', () => {
  const random = createRandom(3)
  const pairs = [
    ...adjacentPairs(random, 15_000, -149, 14),
    ...adjacentPairs(random, 5_000, -149, -140),
  ]
  pairs.push([2 ** -149, 0], [0, -(2 ** -149)], [-(2 ** -149), 2 ** -149], [16_384, -16_384])
  expect(checkPairs(16_384, undefined, pairs)).toBe(pairs.length)
})

test('exact clamp and counting minimum return operands exactly', () => {
  const circuit = new Circuit(5)
  for (let wire = 0; wire < 5; wire++) circuit.assumeRange(wire, -4096, 4096)
  const clamped = emitClampExact(circuit, 0, 1, 2)
  const {minimum, winners} = emitMinimumOf(circuit, [0, 1, 2, 3, 4])
  const run = circuit.createTensorEvaluator([clamped, minimum, ...winners])
  const random = createRandom(4)
  for (let trial = 0; trial < 5_000; trial++) {
    const values = Array.from({length: 5}, () => random() < 0.3 ? Math.round(random() * 4) : f((random() * 2 - 1) * 4096))
    const output = run(Float32Array.from(values))
    expect(output[0]).toBe(Math.min(Math.max(values[0]!, values[1]!), values[2]!))
    const smallest = Math.min(...values)
    expect(output[1]).toBe(smallest)
    expect([...output.slice(2)].indexOf(1)).toBe(values.indexOf(smallest))
    if (trial < 50) validateOneHotGroups(circuit, circuit.evaluateReference(Float32Array.from(values)))
  }
  expect(circuit.ranges[clamped]).toEqual({minimum: -4096, maximum: 4096})
})

test('round sends ties to even for |x| < 2^22', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, -(2 ** 22) + 1, 2 ** 22 - 1)
  const run = circuit.createTensorEvaluator([emitRound(circuit, 0)])
  const random = createRandom(5)
  for (let trial = 0; trial < 30_000; trial++) {
    const value = trial < 10_000
      ? stepFloat32(Math.round((random() * 2 - 1) * 5000) + 0.5, Math.floor(random() * 5) - 2)
      : f((random() * 2 - 1) * (random() < 0.5 ? 100 : 2 ** 22 - 1))
    expect(run(Float32Array.of(value))[0]).toBe(roundHalfEven(value))
  }
})

test('floor on a 1/64 grid matches Math.floor for every grid value in [-1024, 1024] and at the domain edge', () => {
  const circuit = new Circuit(1)
  const limit = 2 ** 16 - 2 ** -6
  circuit.assumeRange(0, -limit, limit)
  const floor = emitFloorOnGrid(circuit, 0, 6)
  expect(measureProgram(circuit, [floor]).liveOperations).toBe(3)
  const run = circuit.createTensorEvaluator([floor])
  for (let step = -1024 * 64; step <= 1024 * 64; step++) {
    const value = step / 64
    if (run(Float32Array.of(value))[0] !== Math.floor(value)) throw new Error(`floor(${value})`)
  }
  for (let step = 0; step < 2000; step++) {
    for (const value of [limit - step / 64, -limit + step / 64]) {
      expect(run(Float32Array.of(value))[0]).toBe(Math.floor(value))
    }
  }
})

test('floor, ceil, and fract match native results for any FP32 value', () => {
  for (const [minimum, maximum, operations] of [[0, 2 ** 22 - 1, 7], [-(2 ** 22) + 1, 2 ** 22 - 1, 22]] as const) {
    const circuit = new Circuit(1)
    circuit.assumeRange(0, minimum, maximum)
    const floor = emitFloor(circuit, 0)
    expect(measureProgram(circuit, [floor]).liveOperations).toBe(operations)
    const ceil = emitCeil(circuit, 0)
    const fraction = emitFract(circuit, 0)
    const run = circuit.createTensorEvaluator([floor, ceil, fraction])
    const random = createRandom(6)
    for (let trial = 0; trial < 20_000; trial++) {
      let value: number
      if (trial % 4 === 0) value = stepFloat32(Math.round((random() * 2 - 1) * 5000), Math.floor(random() * 7) - 3)
      else if (trial % 4 === 1) value = randomLogUniform(random, -149, 0, minimum < 0)
      else if (trial % 4 === 2) value = stepFloat32(Math.round(random() * 4) * 0.5 * (minimum < 0 && random() < 0.5 ? -1 : 1), Math.floor(random() * 7) - 3)
      else value = f(minimum + random() * (maximum - minimum))
      if (value < minimum || value > maximum) continue
      const [floorValue, ceilValue, fractionValue] = run(Float32Array.of(value))
      if (floorValue !== Math.floor(value) || ceilValue !== Math.ceil(value) || fractionValue !== f(value - Math.floor(value))) {
        throw new Error(`floor/ceil/fract of ${value}: ${floorValue}, ${ceilValue}, ${fractionValue}`)
      }
    }
  }
})

test('integer one-hot declares an exact group', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, -5, 9)
  const members = emitIntegerOneHot(circuit, 0, -5, 9)
  expect(measureProgram(circuit, members).liveOperations).toBe(2 * 15 - 1)
  const run = circuit.createTensorEvaluator(members)
  for (let value = -5; value <= 9; value++) {
    expect([...run(Float32Array.of(value))]).toEqual(Array.from({length: 15}, (_, index) => Number(index === value + 5)))
  }
})

test('reciprocal and division stay within 2.5e-7 and 3e-7 relative error', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(0, 1, 16_384)
  circuit.assumeRange(1, -16_384, 16_384)
  circuit.assumeRange(2, -300, -0.5)
  const reciprocal = emitReciprocal(circuit, 0)
  const quotient = emitDivide(circuit, 1, 0)
  const negativeReciprocal = emitReciprocal(circuit, 2)
  const run = circuit.createTensorEvaluator([reciprocal, quotient, negativeReciprocal])
  const plan = reciprocalPlan(1, 16_384)
  const random = createRandom(7)
  let worstReciprocal = 0
  let worstQuotient = 0
  let worstNegative = 0
  for (let trial = 0; trial < 30_000; trial++) {
    const divisor = trial < 3_000
      ? Math.min(16_384, Math.max(1, stepFloat32(plan.thresholds[trial % plan.thresholds.length]!, (trial % 5) - 2)))
      : f(2 ** (random() * 14))
    const numerator = f((random() * 2 - 1) * 16_384)
    const negativeDivisor = f(-0.5 * 2 ** (random() * Math.log2(600)))
    const [reciprocalValue, quotientValue, negativeValue] = run(Float32Array.of(divisor, numerator, negativeDivisor))
    worstReciprocal = Math.max(worstReciprocal, Math.abs(reciprocalValue! * divisor - 1))
    if (numerator !== 0) worstQuotient = Math.max(worstQuotient, Math.abs(quotientValue! * divisor / numerator - 1))
    worstNegative = Math.max(worstNegative, Math.abs(negativeValue! * negativeDivisor - 1))
  }
  expect(worstReciprocal).toBeLessThan(2.5e-7)
  expect(worstNegative).toBeLessThan(2.5e-7)
  expect(worstQuotient).toBeLessThan(3e-7)
})

test('square root is exact at zero and within 2.5e-7 relative error on [1, 2^22]', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 2 ** 22)
  const root = emitSqrt(circuit, 0, {minimumPositive: 1})
  const run = circuit.createTensorEvaluator([root])
  expect(run(Float32Array.of(0))[0]).toBe(0)
  const random = createRandom(8)
  let worst = 0
  for (let trial = 0; trial < 30_000; trial++) {
    const value = trial < 1000 ? Math.min(2 ** 22, Math.max(1, stepFloat32(2 ** (trial % 23), (trial % 5) - 2))) : f(2 ** (random() * 22))
    worst = Math.max(worst, Math.abs(run(Float32Array.of(value))[0]! / Math.sqrt(value) - 1))
  }
  expect(worst).toBeLessThan(2.5e-7)
})

test('sine and cosine stay within 1.5e-7 over |angle| <= 190', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, -190, 190)
  const {sin, cos} = emitSinCos(circuit, 0)
  const run = circuit.createTensorEvaluator([sin, cos])
  const random = createRandom(9)
  let worst = 0
  for (let trial = 0; trial < 30_000; trial++) {
    // The quadrant round(angle * 2 / pi) switches at odd multiples of pi / 4, so the first
    // 5,000 angles sit within 4 FP32 steps of a switch, the next 200 near the endpoints.
    let angle = trial < 5000
      ? stepFloat32((Math.round((random() * 2 - 1) * 121) + 0.5) * Math.PI / 2, (trial % 9) - 4)
      : trial < 5200
        ? stepFloat32(trial % 2 === 0 ? 190 : -190, trial % 2 === 0 ? -(trial % 7) : trial % 7)
        : f((random() * 2 - 1) * 190)
    angle = Math.max(-190, Math.min(190, angle))
    const [sinValue, cosValue] = run(Float32Array.of(angle))
    worst = Math.max(worst, Math.abs(sinValue! - Math.sin(angle)), Math.abs(cosValue! - Math.cos(angle)))
  }
  expect(worst).toBeLessThan(1.5e-7)
})

test('exp error grows with the squarings its range needs', () => {
  for (const [limit, bound] of [[0.5, 2e-7], [8, 3e-6]] as const) {
    const circuit = new Circuit(1)
    circuit.assumeRange(0, -limit, limit)
    const run = circuit.createTensorEvaluator([emitExp(circuit, 0)])
    const random = createRandom(10)
    let worst = 0
    for (let trial = 0; trial < 20_000; trial++) {
      const x = f((random() * 2 - 1) * limit)
      worst = Math.max(worst, Math.abs(run(Float32Array.of(x))[0]! / Math.exp(x) - 1))
    }
    expect(worst).toBeLessThan(bound)
  }
})

test('smoothstep, remap, and mix keep exact endpoints and small interior error', () => {
  const circuit = new Circuit(4)
  circuit.assumeRange(0, -2000, 2000)
  circuit.assumeRange(1, -100, 100)
  circuit.assumeRange(2, 100, 200)
  circuit.assumeRange(3, 0, 1)
  const constant = emitSmoothstep(circuit, -40, 120, 0)
  const runtime = emitSmoothstepRuntime(circuit, 1, 2, 0, {minimum: 1, maximum: 300})
  const mixed = emitMix(circuit, 1, 2, 3)
  const remapped = emitRemap(circuit, 0, -2000, 2000, 0, 1)
  const run = circuit.createTensorEvaluator([constant, runtime, mixed, remapped])
  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }
  const random = createRandom(11)
  for (let trial = 0; trial < 20_000; trial++) {
    const x = f((random() * 2 - 1) * 2000)
    const edge0 = f((random() * 2 - 1) * 100)
    const edge1 = f(Math.min(200, Math.max(100, edge0 + 1 + random() * 199)))
    const t = trial % 10 === 0 ? trial % 20 === 0 ? 0 : 1 : f(random())
    const [constantValue, runtimeValue, mixValue, remapValue] = run(Float32Array.of(x, edge0, edge1, t))
    expect(Math.abs(constantValue! - smoothstep(-40, 120, x))).toBeLessThan(2e-7)
    expect(Math.abs(runtimeValue! - smoothstep(edge0, edge1, x))).toBeLessThan(3e-7)
    expect(Math.abs(remapValue! - (x + 2000) / 4000)).toBeLessThan(1e-7)
    if (x <= -40) expect(constantValue).toBe(0)
    if (x >= 120) expect(constantValue).toBe(1)
    if (t === 0) expect(mixValue).toBe(edge0)
    if (t === 1) expect(mixValue).toBe(edge1)
  }
})

test('runtime remap stays within 5e-7 of max(1, |result|, |(x - inMinimum) * outSpan / inSpan|)', () => {
  const circuit = new Circuit(5)
  circuit.assumeRange(0, -1000, 1000)
  circuit.assumeRange(1, -500, 0)
  circuit.assumeRange(2, 1, 500)
  circuit.assumeRange(3, -100, 100)
  circuit.assumeRange(4, -100, 100)
  const remapped = emitRemapRuntime(circuit, 0, 1, 2, 3, 4, {minimum: 1, maximum: 1000})
  const run = circuit.createTensorEvaluator([remapped])
  const random = createRandom(12)
  for (let trial = 0; trial < 20_000; trial++) {
    const inMinimum = f(-random() * 500)
    const inMaximum = f(1 + random() * 499)
    // Half the inputs inside the input span, half anywhere in [-1000, 1000].
    const x = trial % 2 === 0 ? f(inMinimum + random() * (inMaximum - inMinimum)) : f((random() * 2 - 1) * 1000)
    const outMinimum = f((random() * 2 - 1) * 100)
    const outMaximum = f((random() * 2 - 1) * 100)
    const term = (x - inMinimum) / (inMaximum - inMinimum) * (outMaximum - outMinimum)
    const expected = outMinimum + term
    // The error scales with the larger of the result and the scaled span term. Inputs far
    // outside a small input span make that term, and so the absolute error, large.
    const scale = Math.max(1, Math.abs(expected), Math.abs(term))
    expect(Math.abs(run(Float32Array.of(x, inMinimum, inMaximum, outMinimum, outMaximum))[0]! - expected) / scale).toBeLessThan(5e-7)
  }
})

test('the float hash equals its FP32 reference; keys 0..1023 pass a 5% chi-square test, keys 0..16383 only a 0.1% test', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 2 ** 20)
  const run = circuit.createTensorEvaluator([emitHash(circuit, 0)])
  const buckets: number[] = new Array(64).fill(0)
  let smallKeySetPValue = 0
  for (let key = 0; key < 16_384; key++) {
    const value = run(Float32Array.of(key))[0]!
    if (value !== hashReference(key)) throw new Error(`hash(${key})`)
    const bucket = Math.floor(value * 64)
    buckets[bucket] = buckets[bucket]! + 1
    if (key === 1023) smallKeySetPValue = chiSquarePValue(chiSquareStatistic(buckets), 63)
  }
  for (const key of [2 ** 20, 2 ** 20 - 1, 777_777]) expect(run(Float32Array.of(key))[0]).toBe(hashReference(key))
  // An even spread gives a p-value below 0.05 one time in 20. At 16,384 keys the hash
  // is already borderline (chi-square 88.7, p about 0.018), so that check is only at 0.001.
  expect(smallKeySetPValue).toBeGreaterThan(0.05)
  expect(chiSquarePValue(chiSquareStatistic(buckets), 63)).toBeGreaterThan(0.001)
})
