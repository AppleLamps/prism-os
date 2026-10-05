// A spring whose 2x2 step matrix is computed from stiffness, damping and step
// duration cells, raised to a runtime step count by repeated squaring, and
// applied to position and velocity. Every number a training loop might change is
// a cell, so the reference backward pass reports a gradient for each of them.
//
// One semi-implicit Euler step on (displacement, velocity), displacement =
// position - destination:
//   velocity'     = velocity + (-stiffness * displacement - damping * velocity) * dt
//   displacement' = displacement + velocity' * dt
// is the matrix
//   [1 - stiffness * dt * dt,  dt * (1 - damping * dt)]
//   [-stiffness * dt,          1 - damping * dt       ]
// so n steps are that matrix to the power n.
import {Circuit, type Wire, emitSelect, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'

// Step counts 0..511, which covers chenguini's 300-step cap.
export const stepBitCount = 9

export type SpringCells = {
  stiffness: Wire
  damping: Wire
  stepSeconds: Wire
  destination: Wire
  position: Wire
  velocity: Wire
  // The step count's binary digits, least significant first, written by JS.
  stepBits: readonly Wire[]
}

export type SpringParameters = {
  stiffness: number
  damping: number
  stepSeconds: number
  destination: number
  position: number
  velocity: number
}

export const parameterNames = ['stiffness', 'damping', 'stepSeconds', 'destination', 'position', 'velocity'] as const
export type ParameterName = typeof parameterNames[number]

export type WireMatrix = readonly [Wire, Wire, Wire, Wire]

export const springCells: SpringCells = {
  stiffness: asWire(0),
  damping: asWire(1),
  stepSeconds: asWire(2),
  destination: asWire(3),
  position: asWire(4),
  velocity: asWire(5),
  stepBits: Array.from({length: stepBitCount}, (_, digit) => 6 + digit).map(asWire),
}
export const springSourceSize = 6 + stepBitCount

export function declareSpringRanges(circuit: Circuit, cells: SpringCells) {
  circuit.assumeRange(cells.stiffness, 0, 2000)
  circuit.assumeRange(cells.damping, 0, 200)
  circuit.assumeRange(cells.stepSeconds, 0, 0.016)
  circuit.assumeRange(cells.destination, -16384, 16384)
  circuit.assumeRange(cells.position, -16384, 16384)
  circuit.assumeRange(cells.velocity, -65536, 65536)
  for (const bit of cells.stepBits) circuit.assumeRange(bit, 0, 1)
}

export function emitStepMatrix(circuit: Circuit, cells: SpringCells): WireMatrix {
  const stiffnessTimesStep = circuit.multiply(cells.stiffness, cells.stepSeconds)
  const stiffnessTimesStepSquared = circuit.multiply(stiffnessTimesStep, cells.stepSeconds)
  const dampingTimesStep = circuit.multiply(cells.damping, cells.stepSeconds)
  const velocityKeep = circuit.roundAffine([[dampingTimesStep, -1]], 1)
  return [
    circuit.roundAffine([[stiffnessTimesStepSquared, -1]], 1),
    circuit.multiply(cells.stepSeconds, velocityKeep),
    circuit.roundAffine([[stiffnessTimesStep, -1]]),
    velocityKeep,
  ]
}

// Entries use circuit.multiply, so the backward pass differentiates each product
// as a whole instead of through its two ReLU-gated products.
export function emitMatrixProduct(circuit: Circuit, left: WireMatrix, right: WireMatrix): WireMatrix {
  const entry = (a: Wire, b: Wire, c: Wire, d: Wire) =>
    circuit.roundAffine([[circuit.multiply(a, b), 1], [circuit.multiply(c, d), 1]])
  return [
    entry(left[0], right[0], left[1], right[2]),
    entry(left[0], right[1], left[1], right[3]),
    entry(left[2], right[0], left[3], right[2]),
    entry(left[2], right[1], left[3], right[3]),
  ]
}

// M^steps, where steps = sum over digits of stepBits[digit] * 2^digit. The
// squares M, M^2, M^4, ... come from repeated squaring. The select on digit j gives
// M^(2^j) when its bit is 1 and the identity when its bit is 0, and a balanced tree
// of products combines the selected factors.
export function emitMatrixPower(circuit: Circuit, step: WireMatrix, stepBits: readonly Wire[]): WireMatrix {
  const zero = circuit.affine([], 0)
  const one = circuit.affine([], 1)
  const identity: WireMatrix = [one, zero, zero, one]
  let square = step
  let level: WireMatrix[] = stepBits.map((bit, digit) => {
    if (digit > 0) square = emitMatrixProduct(circuit, square, square)
    const power = square
    const entry = (index: number) => emitSelect(circuit, bit, identity[index]!, power[index]!)
    return [entry(0), entry(1), entry(2), entry(3)]
  })
  while (level.length > 1) {
    const next: WireMatrix[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : emitMatrixProduct(circuit, level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

export type SteppedSpring = {displacement: Wire, velocity: Wire, position: Wire}

export function emitApplyFrameMatrix(
  circuit: Circuit,
  frame: WireMatrix,
  spring: Pick<SpringCells, 'position' | 'destination' | 'velocity'>,
): SteppedSpring {
  const displacement = circuit.roundAffine([[spring.position, 1], [spring.destination, -1]])
  const nextDisplacement = circuit.roundAffine([
    [circuit.multiply(frame[0], displacement), 1],
    [circuit.multiply(frame[1], spring.velocity), 1],
  ])
  const nextVelocity = circuit.roundAffine([
    [circuit.multiply(frame[2], displacement), 1],
    [circuit.multiply(frame[3], spring.velocity), 1],
  ])
  const position = circuit.roundAffine([[spring.destination, 1], [nextDisplacement, 1]])
  return {displacement: nextDisplacement, velocity: nextVelocity, position}
}

export function buildSpringPowerCircuit() {
  const circuit = new Circuit(springSourceSize)
  declareSpringRanges(circuit, springCells)
  const frame = emitMatrixPower(circuit, emitStepMatrix(circuit, springCells), springCells.stepBits)
  const stepped = emitApplyFrameMatrix(circuit, frame, springCells)
  return {circuit, cells: springCells, frame, stepped}
}

export function writeSpringSource(source: Float32Array, cells: SpringCells, parameters: SpringParameters, stepCount: number) {
  for (const name of parameterNames) source[cells[name]] = parameters[name]
  for (let digit = 0; digit < cells.stepBits.length; digit++) {
    source[cells.stepBits[digit]!] = Math.floor(stepCount / 2 ** digit) % 2
  }
}

// ---------------------------------------------------------------------------
// Float64 twin, with the same products in the same tree.

export type Matrix2 = readonly [number, number, number, number]
const identityMatrix: Matrix2 = [1, 0, 0, 1]

export function multiplyMatrix2(left: Matrix2, right: Matrix2): Matrix2 {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ]
}

export function referenceStepMatrix(stiffness: number, damping: number, stepSeconds: number): Matrix2 {
  const velocityKeep = 1 - damping * stepSeconds
  return [1 - stiffness * stepSeconds * stepSeconds, stepSeconds * velocityKeep, -stiffness * stepSeconds, velocityKeep]
}

export function referenceMatrixPower(step: Matrix2, stepCount: number): Matrix2 {
  let square = step
  let level: Matrix2[] = []
  for (let digit = 0; digit < stepBitCount; digit++) {
    if (digit > 0) square = multiplyMatrix2(square, square)
    level.push(Math.floor(stepCount / 2 ** digit) % 2 === 1 ? square : identityMatrix)
  }
  while (level.length > 1) {
    const next: Matrix2[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : multiplyMatrix2(level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

export function applyFrameMatrix(frame: Matrix2, parameters: SpringParameters) {
  const displacement = parameters.position - parameters.destination
  const nextDisplacement = frame[0] * displacement + frame[1] * parameters.velocity
  const nextVelocity = frame[2] * displacement + frame[3] * parameters.velocity
  return {displacement: nextDisplacement, velocity: nextVelocity, position: parameters.destination + nextDisplacement}
}

export function referenceSpringPower(parameters: SpringParameters, stepCount: number) {
  const step = referenceStepMatrix(parameters.stiffness, parameters.damping, parameters.stepSeconds)
  return applyFrameMatrix(referenceMatrixPower(step, stepCount), parameters)
}

// Central finite difference in float64. The step is relative to the value, so a
// stiffness of 290 moves by 2.9e-4 and a position of 0 moves by 1e-6.
export function centralDifference(evaluate: (value: number) => number, value: number, relativeStep = 1e-6) {
  const step = relativeStep * Math.max(1, Math.abs(value))
  return (evaluate(value + step) - evaluate(value - step)) / (2 * step)
}

export function withParameter(parameters: SpringParameters, name: ParameterName, value: number): SpringParameters {
  return {...parameters, [name]: value}
}

// A small seeded generator, so tests and the report use the same samples.
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function randomSpringParameters(random: () => number): SpringParameters {
  return {
    stiffness: 100 + 600 * random(),
    damping: 10 + 40 * random(),
    stepSeconds: 0.004,
    destination: Math.round(800 * random()),
    position: Math.round(800 * random()),
    velocity: Math.round(4000 * random() - 2000),
  }
}

// Central differences smaller than this aren't compared for sign.
export const signFloor = 1e-5

export type PowerGradientCheck = {
  stepCounts: readonly number[]
  pairs: number
  // Largest |backward − central difference| / max(|central difference|, 1e-3), per parameter.
  largestErrorByParameter: Record<ParameterName, number>
  // That error compares gradients below 1e-3 absolutely, so on its own it would pass a tiny
  // gradient with the wrong sign. By step count: the pairs where a negated gradient would still
  // have an error below 1e-3, and the pairs whose central difference is below signFloor.
  negatedStillPassesByStepCount: Record<number, number>
  belowSignFloorByStepCount: Record<number, number>
  // Pairs whose central difference is at least signFloor in size, where the backward pass has a
  // different sign.
  signMismatches: number
}

// The position after stepCount steps, differentiated by the circuit's backward pass and by a
// central difference of the float64 twin, for random springs.
export function checkSpringPowerGradients(
  stepCounts: readonly number[] = [1, 2, 3, 7, 16, 64, 100, 255, 300],
  samplesPerCount = 20,
  seed = 7,
): PowerGradientCheck {
  const {circuit, cells, stepped} = buildSpringPowerCircuit()
  const random = createRandom(seed)
  const source = new Float32Array(circuit.sourceSize)
  const largestErrorByParameter: Record<ParameterName, number> = {stiffness: 0, damping: 0, stepSeconds: 0, destination: 0, position: 0, velocity: 0}
  const negatedStillPassesByStepCount: Record<number, number> = {}
  const belowSignFloorByStepCount: Record<number, number> = {}
  let signMismatches = 0
  let pairs = 0
  const relativeError = (backward: number, difference: number) => Math.abs(backward - difference) / Math.max(Math.abs(difference), 1e-3)
  for (const stepCount of stepCounts) {
    for (let sample = 0; sample < samplesPerCount; sample++) {
      const parameters = randomSpringParameters(random)
      writeSpringSource(source, cells, parameters, stepCount)
      const values = circuit.evaluateReference(source)
      const seeds = new Float32Array(values.length)
      seeds[stepped.position] = 1
      const gradients = circuit.backpropagateReference(values, seeds)
      for (const name of parameterNames) {
        const difference = centralDifference(value => referenceSpringPower(withParameter(parameters, name, value), stepCount).position, parameters[name])
        const backward = gradients[cells[name]]!
        largestErrorByParameter[name] = Math.max(largestErrorByParameter[name], relativeError(backward, difference))
        if (backward !== 0 && relativeError(-backward, difference) < 1e-3) {
          negatedStillPassesByStepCount[stepCount] = (negatedStillPassesByStepCount[stepCount] ?? 0) + 1
        }
        if (Math.abs(difference) < signFloor) {
          belowSignFloorByStepCount[stepCount] = (belowSignFloorByStepCount[stepCount] ?? 0) + 1
        } else if (Math.sign(backward) !== Math.sign(difference)) {
          signMismatches++
        }
        pairs++
      }
    }
  }
  return {stepCounts, pairs, largestErrorByParameter, negatedStillPassesByStepCount, belowSignFloorByStepCount, signMismatches}
}
