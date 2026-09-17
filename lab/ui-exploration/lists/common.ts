// Shared constructions for the collection prototypes: exact integer bits, exact
// comparisons on bounded continuous values, rounding and floors, spring matrix
// powers, and compiled-size measurement.
import {Circuit, emitMinimum, emitRelu, type Terms, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix} from '../../../src/runtime/prefix-networks.ts'

export type ProgramSize = {
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
  maximumLayerWidth: number
}

export function measure(circuit: Circuit, roots: readonly Wire[], lowerGathers = true): ProgramSize {
  const program = circuit.compileTensorProgram(roots, lowerGathers)
  let storedWeights = 0
  let gatherReads = 0
  let maximumLayerWidth = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    maximumLayerWidth = Math.max(maximumLayerWidth, layer.outputSize)
  }
  return {
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    maximumLayerWidth,
  }
}

export function constant(circuit: Circuit, value: number): Wire {
  return circuit.affine([], value)
}

// Exact bit of `sum(terms) + bias >= 1` when that sum is an integer below 2^24:
// relu(v) - relu(v - 1) cannot land strictly between 0 and 1.
export function integerAtLeastOne(circuit: Circuit, terms: Terms, bias: number): Wire {
  const upper = circuit.reglu([], 1, terms, bias)
  const lower = circuit.reglu([], 1, terms, bias - 1)
  const bit = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// Exact `sum(terms) + bias >= 0` for an integer-valued sum.
export function integerAtLeastZero(circuit: Circuit, terms: Terms, bias: number): Wire {
  return integerAtLeastOne(circuit, terms, bias + 1)
}

// Exact AND of bits: [a + b + ... >= count].
export function andBits(circuit: Circuit, bits: readonly Wire[]): Wire {
  if (bits.length === 1) return bits[0]!
  return integerAtLeastOne(circuit, bits.map(bit => [bit, 1] as const), 1 - bits.length)
}

// Exact OR of bits: [a + b + ... >= 1].
export function orBits(circuit: Circuit, bits: readonly Wire[]): Wire {
  if (bits.length === 1) return bits[0]!
  return integerAtLeastOne(circuit, bits.map(bit => [bit, 1] as const), 0)
}

export function notBit(circuit: Circuit, bit: Wire): Wire {
  const result = circuit.affine([[bit, -1]], 1)
  circuit.assumeRange(result, 0, 1)
  return result
}

// [a >= b] for continuous FP32 operands. The difference is materialized, so its
// sign is exact; the score 0.5 + scale * difference is materialized too, so both
// relus of the clamp read one rounded score. Exact while scale * |a - b| <= 2^23
// and the nonzero differences are at least 2^-25 / scale (for scale 2^9 and
// operand magnitudes above 2^-11, that holds for adjacent FP32 values).
export function atLeastContinuous(circuit: Circuit, terms: Terms, bias: number, scale: number): Wire {
  const difference = circuit.roundAffine(terms, bias)
  const score = circuit.roundAffine([[difference, scale]], 0.5)
  const clamped = circuit.affine([[emitRelu(circuit, score), 1], [circuit.reglu([], 1, [[score, 1]], -1), -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

export function absolute(circuit: Circuit, value: Wire): Wire {
  const result = circuit.affine([[emitRelu(circuit, value), 1], [circuit.reglu([], 1, [[value, -1]], 0), 1]])
  return result
}

// FP32 steps are exactly 1 in [2^23, 2^24), so adding this base and removing it
// again rounds to the nearest integer (ties to even) for |x| < 2^22.
const roundingBase = 2 ** 23 + 2 ** 22

export function emitRound(circuit: Circuit, value: Wire): Wire {
  const shifted = circuit.roundAffine([[value, 1]], roundingBase)
  return circuit.roundAffine([[shifted, 1]], -roundingBase)
}

// floor(coefficient * value) when coefficient * value is a multiple of
// 2^-gridBits and below 2^(22 - gridBits) in magnitude (coefficient must be a
// power of two so the scaling is exact). Shifting by half a grid step below 0.5
// means the rounding never meets a tie.
export function emitFloorOnGrid(circuit: Circuit, value: Wire, coefficient: number, gridBits: number): Wire {
  const shifted = circuit.roundAffine([[value, coefficient]], 2 ** -(gridBits + 1) - 0.5)
  return emitRound(circuit, shifted)
}

// Every running sum values[0] + ... + values[i]. All modes are exact when the
// values sit on a power-of-two grid and every partial sum is representable
// (e.g. quarter pixels below 2^22); they differ in depth and width.
export type PrefixMode = 'brentKung' | 'chain' | 'wide' | 'blocked'

export function emitPrefixSums(circuit: Circuit, values: readonly Wire[], mode: PrefixMode): Wire[] {
  const count = values.length
  if (mode === 'chain') {
    const sums: Wire[] = [values[0]!]
    for (let index = 1; index < count; index++) sums.push(circuit.roundAffine([[sums[index - 1]!, 1], [values[index]!, 1]]))
    return sums
  }
  if (mode === 'wide') {
    return values.map((_, index) => index === 0 ? values[0]! : circuit.roundAffine(values.slice(0, index + 1).map(value => [value, 1] as const)))
  }
  if (mode === 'blocked') {
    const blockSize = Math.max(1, Math.round(Math.sqrt(count)))
    const blockCount = Math.ceil(count / blockSize)
    const blockSums: Wire[] = []
    for (let block = 0; block < blockCount; block++) {
      blockSums.push(circuit.roundAffine(values.slice(block * blockSize, Math.min(count, (block + 1) * blockSize)).map(value => [value, 1] as const)))
    }
    const sums: Wire[] = []
    for (let block = 0; block < blockCount; block++) {
      const before = block === 0 ? undefined : circuit.roundAffine(blockSums.slice(0, block).map(value => [value, 1] as const))
      for (let index = block * blockSize; index < Math.min(count, (block + 1) * blockSize); index++) {
        const inside = index === block * blockSize ? values[index]! : circuit.roundAffine(values.slice(block * blockSize, index + 1).map(value => [value, 1] as const))
        sums.push(before === undefined ? inside : circuit.roundAffine([[before, 1], [inside, 1]]))
      }
    }
    return sums
  }
  // Brent-Kung: an up-sweep over power-of-two spans, then a down-sweep that
  // fills in the remaining positions. About 2n additions at 2 log2(n) depth.
  return brentKungPrefix(values, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]))
}

// Names source cells and their ranges before the circuit exists.
export class SourceLayout {
  ranges: [minimum: number, maximum: number][] = []

  cell(minimum: number, maximum: number): Wire {
    this.ranges.push([minimum, maximum])
    return this.ranges.length - 1
  }

  cells(count: number, minimum: number, maximum: number): Wire[] {
    return Array.from({length: count}, () => this.cell(minimum, maximum))
  }

  createCircuit(): Circuit {
    const circuit = new Circuit(this.ranges.length)
    this.ranges.forEach(([minimum, maximum], wire) => circuit.assumeRange(wire, minimum, maximum))
    return circuit
  }
}

// floor(value / divisor) for a value on a 1/grid px grid, with an integer divisor.
// q = fround(value * fround(1 / divisor)) is within 1e-7 relative of the true
// quotient, so round(q) is floor or floor + 1; one exact integer comparison of
// round(q) * divisor against value removes the extra one.
export function emitFloorByInteger(circuit: Circuit, value: Wire, divisor: number, grid: number): Wire {
  const quotient = circuit.roundAffine([[value, 1 / divisor]])
  const rounded = emitRound(circuit, quotient)
  const tooLarge = integerAtLeastOne(circuit, [[rounded, divisor * grid], [value, -grid]], 0)
  const floor = circuit.roundAffine([[rounded, 1], [tooLarge, -1]])
  return floor
}

export function integerMinimum(circuit: Circuit, value: Wire, maximum: Wire): Wire {
  return emitMinimum(circuit, value, maximum)
}

// ---------- springs as matrix powers ----------

export type Matrix = [[number, number], [number, number]]

export function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    [left[0][0] * right[0][0] + left[0][1] * right[1][0], left[0][0] * right[0][1] + left[0][1] * right[1][1]],
    [left[1][0] * right[0][0] + left[1][1] * right[1][0], left[1][0] * right[0][1] + left[1][1] * right[1][1]],
  ]
}

// vibescript's springStep: v' = v + (-k e - b v) t, then e' = e + v' t, with e = pos - dest.
export function eulerStepMatrix(stiffness: number, damping: number, stepSeconds: number): Matrix {
  const velocityKeep = 1 - damping * stepSeconds
  return [
    [1 - stiffness * stepSeconds * stepSeconds, stepSeconds * velocityKeep],
    [-stiffness * stepSeconds, velocityKeep],
  ]
}

export function stagePowers(step: Matrix, stageCount: number): Matrix[] {
  const powers: Matrix[] = [step]
  for (let stage = 1; stage < stageCount; stage++) powers.push(multiplyMatrices(powers[stage - 1]!, powers[stage - 1]!))
  return powers
}

// Binary digits of an integer step count 0..2^bitCount-1, each from exact floors.
export function emitStepBits(circuit: Circuit, steps: Wire, bitCount: number): Wire[] {
  const quotients: Wire[] = [steps]
  for (let bitIndex = 1; bitIndex <= bitCount; bitIndex++) {
    quotients.push(emitFloorOnGrid(circuit, steps, 2 ** -bitIndex, bitIndex))
  }
  const bits: Wire[] = []
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const bit = circuit.roundAffine([[quotients[bitIndex]!, 1], [quotients[bitIndex + 1]!, -2]])
    circuit.assumeRange(bit, 0, 1)
    bits.push(bit)
  }
  return bits
}

// Apply M^steps to (displacement, velocity): stage j applies the constant
// M^(2^j) when bit j is set, written as e + bit * ((M^(2^j) - I) (e, v)).
export function emitSpringPowers(
  circuit: Circuit,
  displacement: Wire,
  velocity: Wire,
  bits: readonly Wire[],
  powers: readonly Matrix[],
): {displacement: Wire, velocity: Wire} {
  let e = displacement
  let v = velocity
  for (let stage = 0; stage < bits.length; stage++) {
    const power = powers[stage]!
    const deltaE = circuit.roundAffine([[e, Math.fround(power[0][0] - 1)], [v, power[0][1]]])
    const deltaV = circuit.roundAffine([[e, power[1][0]], [v, Math.fround(power[1][1] - 1)]])
    const nextE = circuit.roundAffine([[e, 1], [circuit.multiply(bits[stage]!, deltaE), 1]])
    const nextV = circuit.roundAffine([[v, 1], [circuit.multiply(bits[stage]!, deltaV), 1]])
    e = nextE
    v = nextV
  }
  return {displacement: e, velocity: v}
}

// [value >= threshold] for a nonnegative FP32 value of any magnitude up to 2^24
// and a small positive threshold. The difference is clamped at 1 before scaling,
// so the clamp plateau never sees a score above 2^24, and the scale 2^9 still
// resolves adjacent FP32 values near the threshold.
export function atLeastSmallThreshold(circuit: Circuit, value: Wire, threshold: number): Wire {
  const difference = circuit.roundAffine([[value, 1]], -threshold)
  const clampedDifference = emitMinimum(circuit, difference, constant(circuit, 1))
  const score = circuit.roundAffine([[clampedDifference, 512]], 0.5)
  const clamped = circuit.affine([[emitRelu(circuit, score), 1], [circuit.reglu([], 1, [[score, 1]], -1), -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// vibescript's settle rule: |v| < 0.01 and |dest - pos| < 0.01 snaps to dest.
// Returns the displacement and velocity after snapping, plus the active bit.
export function emitSettle(circuit: Circuit, displacement: Wire, velocity: Wire) {
  const speedAtLeast = atLeastSmallThreshold(circuit, absolute(circuit, velocity), 0.01)
  const distanceAtLeast = atLeastSmallThreshold(circuit, absolute(circuit, displacement), 0.01)
  const active = orBits(circuit, [speedAtLeast, distanceAtLeast])
  return {
    displacement: circuit.multiply(active, displacement),
    velocity: circuit.multiply(active, velocity),
    active,
  }
}

// vibescript's catch-up clock (Animation.md): steps = min(300, floor(elapsed / 4)),
// where elapsed = backlog + frameDelta while animating and 0 otherwise, clamped
// to 2^15 ms. Returns the step count and its binary digits for the matrix-power
// stages.
export function emitCatchUpClock(circuit: Circuit, animating: Wire, backlog: Wire, frameDelta: Wire, stageCount: number) {
  const elapsedRaw = circuit.multiply(animating, circuit.roundAffine([[backlog, 1], [frameDelta, 1]]))
  const elapsed = emitMinimum(circuit, elapsedRaw, constant(circuit, 2 ** 15))
  circuit.assumeRange(elapsed, 0, 2 ** 15)
  const steps = emitMinimum(circuit, emitFloorOnGrid(circuit, elapsed, 1 / 4, 8), constant(circuit, 300))
  circuit.assumeRange(steps, 0, 300)
  const stepBits = emitStepBits(circuit, steps, stageCount)
  return {elapsed, steps, stepBits}
}

// One spring lane toward a destination: the step count's matrix powers applied
// to (position - destination, velocity), then the settle rule.
export function emitSpringLane(circuit: Circuit, position: Wire, destination: Wire, velocity: Wire, stepBits: readonly Wire[], powers: readonly Matrix[]) {
  const displacement = circuit.roundAffine([[position, 1], [destination, -1]])
  const stepped = emitSpringPowers(circuit, displacement, velocity, stepBits, powers)
  const settled = emitSettle(circuit, stepped.displacement, stepped.velocity)
  return {position: circuit.roundAffine([[destination, 1], [settled.displacement, 1]]), velocity: settled.velocity, active: settled.active}
}

// clamp(value, -limit, limit) = value - relu(value - limit) + relu(-value - limit).
// Not exact at the limit (FP32 rounding of value - limit), which is fine for a
// velocity that only feeds springs.
export function emitSymmetricClamp(circuit: Circuit, value: Wire, limit: number): Wire {
  const above = circuit.reglu([], 1, [[value, 1]], -limit)
  const below = circuit.reglu([], 1, [[value, -1]], -limit)
  return circuit.roundAffine([[value, 1], [above, -1], [below, 1]])
}

// ---------- deterministic randomness ----------

export function hash(seed: number) {
  let n = seed | 0
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (((n >>> 15) ^ n) >>> 0) / 0x100000000
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

export function sourceOf(circuit: Circuit) {
  return new Float32Array(circuit.sourceSize)
}
