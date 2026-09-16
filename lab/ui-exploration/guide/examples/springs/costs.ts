// Five ways to run a runtime number of fixed 4 ms steps (0..300), for
// `springCount` springs that share stiffness and damping. JS writes the step
// count into one cell. In 'JS writes the digits', JS writes the step count's 9
// binary digits into 9 cells instead, and in 'JS writes the matrix', JS writes
// M^steps into 4 cells. There's no settle snap here; spring-catch-up.ts adds one.
import {Circuit, type Wire, emitSelect, emitSpring, asWire} from '../../../../../numeric-ui-core.ts'
import {emitSpringSteps} from './spring-catch-up.ts'
import {emitAtLeastOnGrid, emitBinaryDigits, maxSteps, stepDigitCount} from './spring-clock.ts'
import {
  type Matrix2,
  type RelativeSpring,
  type SpringConstants,
  emitSpringStep,
  identityMatrix,
  matrixPower,
  springStepMatrix,
  stepMs,
} from './spring-step.ts'

export type CatchUpForm =
  | 'unrolled, one mask per step'
  | 'binary digits, per spring'
  | 'binary digits, shared matrix'
  | 'JS writes the digits'
  | 'JS writes the matrix'

export const catchUpForms: readonly CatchUpForm[] = [
  'unrolled, one mask per step',
  'binary digits, per spring',
  'binary digits, shared matrix',
  'JS writes the digits',
  'JS writes the matrix',
]

export type WireMatrix = readonly [Wire, Wire, Wire, Wire]

export const stepCountCell = asWire(0)
export const matrixCells: WireMatrix = [asWire(1), asWire(2), asWire(3), asWire(4)]
export function springCells(springIndex: number): RelativeSpring {
  return {displacement: asWire(5 + 2 * springIndex), velocity: asWire(6 + 2 * springIndex)}
}
// The step count's binary digits, least significant first, after every spring's cells.
export function digitCells(springCount: number): Wire[] {
  return Array.from({length: stepDigitCount}, (_, digit) => asWire(5 + 2 * springCount + digit))
}

// Largest |entry| of M^n over n = 0..300, for declared ranges.
export function frameMatrixBound(constants: SpringConstants): number {
  const step = springStepMatrix(constants)
  let power: Matrix2 = identityMatrix
  let bound = 1
  for (let steps = 1; steps <= maxSteps; steps++) {
    power = [
      power[0] * step[0] + power[1] * step[2],
      power[0] * step[1] + power[1] * step[3],
      power[2] * step[0] + power[3] * step[2],
      power[2] * step[1] + power[3] * step[3],
    ]
    for (const entry of power) bound = Math.max(bound, Math.abs(entry))
  }
  return bound
}

function emitMatrixProduct(circuit: Circuit, left: WireMatrix, right: WireMatrix): WireMatrix {
  const entry = (a: Wire, b: Wire, c: Wire, d: Wire) =>
    circuit.roundAffine([[circuit.multiply(a, b), 1], [circuit.multiply(c, d), 1]])
  return [
    entry(left[0], right[0], left[1], right[2]),
    entry(left[0], right[1], left[1], right[3]),
    entry(left[2], right[0], left[3], right[2]),
    entry(left[2], right[1], left[3], right[3]),
  ]
}

// M^steps as the product over digits of (digit ? M^(2^digit) : I). Each factor's
// entry is affine in its digit, I + digit * (M^(2^digit) - I), and a balanced
// tree multiplies the factors.
export function emitSharedFrameMatrix(circuit: Circuit, digits: readonly Wire[], constants: SpringConstants): WireMatrix {
  const step = springStepMatrix(constants)
  let level: WireMatrix[] = digits.map((digit, index) => {
    const power = matrixPower(step, 2 ** index)
    const entry = (entryIndex: number) =>
      circuit.roundAffine([[digit, power[entryIndex]! - identityMatrix[entryIndex]!]], identityMatrix[entryIndex]!)
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

export function emitApplyMatrix(circuit: Circuit, frame: WireMatrix, spring: RelativeSpring): RelativeSpring {
  return {
    displacement: circuit.roundAffine([
      [circuit.multiply(frame[0], spring.displacement), 1],
      [circuit.multiply(frame[1], spring.velocity), 1],
    ]),
    velocity: circuit.roundAffine([
      [circuit.multiply(frame[2], spring.displacement), 1],
      [circuit.multiply(frame[3], spring.velocity), 1],
    ]),
  }
}

export function buildCatchUp(form: CatchUpForm, springCount: number, constants: SpringConstants) {
  const circuit = new Circuit(5 + 2 * springCount + stepDigitCount)
  circuit.assumeRange(stepCountCell, 0, maxSteps)
  const bound = frameMatrixBound(constants)
  for (const matrixCell of matrixCells) circuit.assumeRange(matrixCell, -bound, bound)
  const digitsFromJs = digitCells(springCount)
  for (const digit of digitsFromJs) circuit.assumeRange(digit, 0, 1)
  const springs = Array.from({length: springCount}, (_, springIndex) => springCells(springIndex))
  let outputs: RelativeSpring[]
  if (form === 'JS writes the digits') {
    outputs = springs.map(spring => emitSpringSteps(circuit, spring, digitsFromJs, constants))
  } else if (form === 'unrolled, one mask per step') {
    // [steps >= i] for i = 1..300: a thermometer of the step count.
    const thermometer = Array.from({length: maxSteps}, (_, index) => emitAtLeastOnGrid(circuit, stepCountCell, index + 1, 1))
    outputs = springs.map(spring => {
      let current = spring
      for (const runsThisStep of thermometer) {
        const advanced = emitSpringStep(circuit, current, constants)
        current = {
          displacement: emitSelect(circuit, runsThisStep, current.displacement, advanced.displacement),
          velocity: emitSelect(circuit, runsThisStep, current.velocity, advanced.velocity),
        }
      }
      return current
    })
  } else if (form === 'binary digits, per spring') {
    const digits = emitBinaryDigits(circuit, stepCountCell, 1, stepDigitCount, 1)
    outputs = springs.map(spring => emitSpringSteps(circuit, spring, digits, constants))
  } else {
    let frame = matrixCells
    if (form === 'binary digits, shared matrix') {
      frame = emitSharedFrameMatrix(circuit, emitBinaryDigits(circuit, stepCountCell, 1, stepDigitCount, 1), constants)
      for (const entry of frame) circuit.assumeRange(entry, -bound * (1 + 1e-4), bound * (1 + 1e-4))
    }
    outputs = springs.map(spring => emitApplyMatrix(circuit, frame, spring))
  }
  return {circuit, springs, roots: outputs.flatMap(spring => [spring.displacement, spring.velocity])}
}

// The per-spring forms again, with stiffness and damping in source cells instead
// of weights. The step now multiplies runtime values, so it isn't affine, and a
// chain of steps no longer collapses.
export function buildCatchUpWithConstantCells(form: 'unrolled, one mask per step' | 'binary digits, per spring', springCount: number) {
  const stiffnessCell = 5 + 2 * springCount
  const dampingCell = stiffnessCell + 1
  const circuit = new Circuit(7 + 2 * springCount)
  circuit.assumeRange(stepCountCell, 0, maxSteps)
  circuit.assumeRange(asWire(stiffnessCell), 0, 10_000)
  circuit.assumeRange(asWire(dampingCell), 0, 1_000)
  const dt = stepMs / 1000
  const step = (spring: RelativeSpring): RelativeSpring => {
    const acceleration = circuit.affine([
      [circuit.multiply(spring.displacement, asWire(stiffnessCell)), -1],
      [circuit.multiply(spring.velocity, asWire(dampingCell)), -1],
    ])
    const velocity = circuit.affine([[spring.velocity, 1], [acceleration, dt]])
    const displacement = circuit.affine([[spring.displacement, 1], [velocity, dt]])
    return {displacement, velocity}
  }
  const select = (bit: Wire, off: RelativeSpring, on: RelativeSpring): RelativeSpring => ({
    displacement: emitSelect(circuit, bit, off.displacement, on.displacement),
    velocity: emitSelect(circuit, bit, off.velocity, on.velocity),
  })
  const springs = Array.from({length: springCount}, (_, springIndex) => springCells(springIndex))
  let outputs: RelativeSpring[]
  if (form === 'unrolled, one mask per step') {
    const thermometer = Array.from({length: maxSteps}, (_, index) => emitAtLeastOnGrid(circuit, stepCountCell, index + 1, 1))
    outputs = springs.map(spring => thermometer.reduce((current, bit) => select(bit, current, step(current)), spring))
  } else {
    const digits = emitBinaryDigits(circuit, stepCountCell, 1, stepDigitCount, 1)
    outputs = springs.map(spring => {
      let current = spring
      for (let digit = digits.length - 1; digit >= 0; digit--) {
        let advanced = current
        for (let index = 0; index < 2 ** digit; index++) advanced = step(advanced)
        current = select(digits[digit]!, current, advanced)
      }
      return current
    })
  }
  return {circuit, roots: outputs.flatMap(spring => [spring.displacement, spring.velocity])}
}

// IndirectOS's emitSpring for one spring, with every parameter declared nonnegative.
export function buildIndirectOsSpring() {
  const circuit = new Circuit(11)
  const position = circuit.source(0)
  const destination = circuit.source(1)
  const velocity = circuit.source(2)
  const stiffness = circuit.source(3)
  const damping = circuit.source(4)
  const timestep = circuit.source(5)
  const settleDistance = circuit.source(6)
  const settleSpeed = circuit.source(7)
  const distanceScale = circuit.source(8)
  const speedScale = circuit.source(9)
  const unit = circuit.source(10)
  for (const parameter of [stiffness, damping, timestep, settleDistance, settleSpeed, distanceScale, speedScale]) {
    circuit.assumeRange(parameter, 0, Number.POSITIVE_INFINITY)
  }
  circuit.assumeRange(unit, 1, 1)
  const spring = emitSpring(circuit, position, destination, velocity, stiffness, damping, timestep, settleDistance, settleSpeed, distanceScale, speedScale, unit)
  return {circuit, roots: [spring.position, spring.velocity, spring.active]}
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  for (const layer of program.layers) storedWeights += layer.weights.length
  return {
    createdOperations: circuit.operations.length,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
  }
}
