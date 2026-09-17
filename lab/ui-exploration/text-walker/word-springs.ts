// Springs with fixed 4ms steps and a runtime step count, as one shared 2x2 matrix per frame.
//
// One semi-implicit Euler step on displacement d = position - target and velocity v is linear:
//   v' = -k dt d + (1 - b dt) v,   d' = d + dt v' = (1 - k dt^2) d + dt (1 - b dt) v
// so n steps are M^n. With the bits of n, M^n = product over j of (bit_j ? M^(2^j) : I), and every
// M^(2^j) is a constant matrix. The product is computed once per frame; each spring then costs four
// products, plus a settle check that snaps it to its target once distance and speed are tiny.
import {Circuit, emitMultiply, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {integerAtLeast, relu} from './kit.ts'

export type SpringConfig = {
  stiffness: number
  damping: number
  stepSeconds: number
  // The step count per frame lies in 0..2^stepBits - 1.
  stepBits: number
  settleThreshold: number
}

export const defaultSpringConfig: SpringConfig = {stiffness: 290, damping: 30, stepSeconds: 0.004, stepBits: 8, settleThreshold: 0.01}

type Matrix = [number, number, number, number]

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ]
}

export function stepMatrixPowers(config: SpringConfig): Matrix[] {
  const {stiffness: k, damping: b, stepSeconds: dt} = config
  const powers: Matrix[] = [[1 - k * dt * dt, dt * (1 - b * dt), -k * dt, 1 - b * dt]]
  for (let bit = 1; bit < config.stepBits; bit++) powers.push(multiplyMatrices(powers[bit - 1]!, powers[bit - 1]!))
  return powers
}

// The float64 reference: the same steps, iterated.
export function iterateSpring(displacement: number, velocity: number, steps: number, config: SpringConfig): [number, number] {
  let d = displacement
  let v = velocity
  for (let step = 0; step < steps; step++) {
    v += (-config.stiffness * d - config.damping * v) * config.stepSeconds
    d += v * config.stepSeconds
  }
  return [d, v]
}

export type StepMatrix = [Wire, Wire, Wire, Wire]

export function emitStepMatrix(circuit: Circuit, unit: Wire, stepCount: Wire, config: SpringConfig): StepMatrix {
  const powers = stepMatrixPowers(config)
  let remaining = stepCount
  const factors: StepMatrix[] = []
  for (let bit = config.stepBits - 1; bit >= 0; bit--) {
    const bitWire = circuit.roundAffine([[integerAtLeast(circuit, [[remaining, 1]], 0, 2 ** bit), 1]])
    circuit.assumeRange(bitWire, 0, 1)
    remaining = circuit.roundAffine([[remaining, 1], [bitWire, -(2 ** bit)]])
    circuit.assumeRange(remaining, 0, 2 ** bit - 1)
    const power = powers[bit]!
    const identity: Matrix = [1, 0, 0, 1]
    // I + bit * (M^(2^j) - I), one affine per entry.
    const factor = [0, 1, 2, 3].map(entry => {
      const wire = circuit.roundAffine([[bitWire, power[entry]! - identity[entry]!], [unit, identity[entry]!]])
      circuit.assumeRange(wire, Math.min(identity[entry]!, power[entry]!), Math.max(identity[entry]!, power[entry]!))
      return wire
    }) as StepMatrix
    factors.push(factor)
  }
  const multiply = (left: StepMatrix, right: StepMatrix): StepMatrix => {
    const entry = (a: Wire, b: Wire, c: Wire, d: Wire) => {
      const wire = circuit.roundAffine([[emitMultiply(circuit, a, b), 1], [emitMultiply(circuit, c, d), 1]])
      circuit.assumeRange(wire, -64, 64)
      return wire
    }
    return [
      entry(left[0], right[0], left[1], right[2]),
      entry(left[0], right[1], left[1], right[3]),
      entry(left[2], right[0], left[3], right[2]),
      entry(left[2], right[1], left[3], right[3]),
    ]
  }
  let level = factors
  while (level.length > 1) {
    const next: StepMatrix[] = []
    for (let index = 0; index < level.length; index += 2) next.push(index + 1 < level.length ? multiply(level[index]!, level[index + 1]!) : level[index]!)
    level = next
  }
  return level[0]!
}

export type SpringOutputs = {position: Wire, velocity: Wire, active: Wire}

export function emitWordSpring(circuit: Circuit, matrix: StepMatrix, position: Wire, velocity: Wire, target: Wire, config: SpringConfig): SpringOutputs {
  const displacement = circuit.roundAffine([[position, 1], [target, -1]])
  circuit.assumeRange(displacement, -32768, 32768)
  const nextDisplacement = circuit.roundAffine([[emitMultiply(circuit, matrix[0], displacement), 1], [emitMultiply(circuit, matrix[1], velocity), 1]])
  const nextVelocity = circuit.roundAffine([[emitMultiply(circuit, matrix[2], displacement), 1], [emitMultiply(circuit, matrix[3], velocity), 1]])
  circuit.assumeRange(nextDisplacement, -32768, 32768)
  circuit.assumeRange(nextVelocity, -1e6, 1e6)
  const threshold = config.settleThreshold
  // Distance and speed above the threshold, scaled so any visible motion keeps the spring active.
  const score = circuit.roundAffine([
    [relu(circuit, [[nextDisplacement, 1]], -threshold), 1024],
    [relu(circuit, [[nextDisplacement, -1]], -threshold), 1024],
    [relu(circuit, [[nextVelocity, 1]], -threshold), 1024],
    [relu(circuit, [[nextVelocity, -1]], -threshold), 1024],
  ])
  const active = circuit.roundAffine([[score, 1], [relu(circuit, [[score, 1]], -1), -1]])
  circuit.assumeRange(active, 0, 1)
  return {
    position: circuit.roundAffine([[target, 1], [circuit.multiply(nextDisplacement, active), 1]]),
    velocity: circuit.multiply(nextVelocity, active),
    active,
  }
}
