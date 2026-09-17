// FP32 helpers shared by the comparison examples: neighboring values, powers of two,
// classes of differences to test, seeded random values, and operation and layer counts.
import type {Circuit, Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

export const f = Math.fround
export const smallestSubnormal = 2 ** -149
export const smallestNormal = 2 ** -126
export const largestSubnormal = f(2 ** -126 - 2 ** -149)
export const largestFinite = f(3.4028234663852886e38)
// Every integer with at most this magnitude is representable in FP32.
export const exactIntegerLimit = 2 ** 24

const scratchFloat = new Float32Array(1)
const scratchBits = new Uint32Array(scratchFloat.buffer)

export function float32FromBits(bits: number): number {
  scratchBits[0] = bits
  return scratchFloat[0]!
}

// The neighboring FP32 value above `value`, e.g. nextUp(1) is 1 + 2^-23.
export function nextUp(value: number): number {
  const rounded = f(value)
  if (rounded === 0) return smallestSubnormal
  scratchFloat[0] = rounded
  scratchBits[0] = rounded > 0 ? scratchBits[0]! + 1 : scratchBits[0]! - 1
  return scratchFloat[0]!
}

export function nextDown(value: number): number {
  return -nextUp(-value)
}

// The smallest integer e with 2^e >= value.
export function powerOfTwoExponentAtLeast(value: number): number {
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`expected a finite positive value, got ${value}`)
  let exponent = Math.ceil(Math.log2(value))
  while (2 ** exponent < value) exponent++
  while (exponent > -149 && 2 ** (exponent - 1) >= value) exponent--
  return exponent
}

// The largest integer e >= -149 with 2^e <= value.
export function powerOfTwoExponentAtMost(value: number): number {
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`expected a finite positive value, got ${value}`)
  let exponent = Math.max(-149, Math.floor(Math.log2(value)))
  while (exponent > -149 && 2 ** exponent > value) exponent--
  while (2 ** (exponent + 1) <= value) exponent++
  return exponent
}

// mulberry32, so every run tests the same values.
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// A random finite FP32 bit pattern: every exponent is equally likely, so tiny and huge values
// show up as often as ordinary ones.
export function randomFiniteFloat32(random: () => number): number {
  for (;;) {
    const value = float32FromBits(Math.floor(random() * 4294967296))
    if (Number.isFinite(value)) return value
  }
}

export type ValueClass = {label: string, values: number[]}

// Differences a comparison has to get right, grouped by where FP32 behaves differently.
// Values above the bound are dropped.
export function differenceClasses(differenceBound: number, random: () => number, randomCount: number): ValueClass[] {
  const bothSigns = (values: number[]) => values.flatMap(value => [value, -value])
  const randomBits: number[] = []
  while (randomBits.length < randomCount) {
    const value = randomFiniteFloat32(random)
    if (Math.abs(value) <= differenceBound) randomBits.push(value)
  }
  const randomUniform = Array.from({length: randomCount}, () => f((2 * random() - 1) * differenceBound))
  const classes: ValueClass[] = [
    {label: 'zero', values: [0, -0]},
    {label: 'subnormal', values: bothSigns([smallestSubnormal, 2 * smallestSubnormal, 3 * smallestSubnormal, f(2 ** -140), largestSubnormal])},
    {label: 'smallest normal', values: bothSigns([smallestNormal, nextUp(smallestNormal), nextUp(nextUp(smallestNormal)), f(2 ** -100)])},
    {label: 'near 1', values: bothSigns([f(2 ** -40), nextDown(1), 1, nextUp(1), f(0.3)])},
    {label: 'near 2^14', values: bothSigns([nextDown(2 ** 14), 2 ** 14])},
    {label: 'near 2^24', values: bothSigns([nextDown(2 ** 24), 2 ** 24, nextUp(2 ** 24), 2 ** 25])},
    {label: 'huge', values: bothSigns([2 ** 60, 2 ** 100, nextDown(largestFinite), largestFinite])},
    {label: 'random bit patterns', values: randomBits},
    {label: 'random uniform', values: randomUniform},
  ]
  return classes
    .map(({label, values}) => ({label, values: values.filter(value => Math.abs(value) <= differenceBound)}))
    .filter(({values}) => values.length > 0)
}

// Live operations and layers of the compiled program that computes `roots`.
export function measureCost(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  return {operations: program.valueCount - circuit.sourceSize, layers: program.layers.length}
}
