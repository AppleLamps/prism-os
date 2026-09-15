// Level 1 of three: one fixed 4 ms spring step, the body of the loop inside
// index.ts's stepSpringTo.
import type {Circuit, Wire} from '../../../../../numeric-ui-core.ts'

export const stepMs = 4

export type SpringConstants = {stiffness: number, damping: number}

// A spring measured relative to its destination: displacement = position - destination.
// The destination doesn't change during one frame's steps, so stepping the
// displacement is the same as stepping the position. FP32 rounding then scales
// with how far the spring is from rest, instead of with how far the position is
// from 0.
export type RelativeSpring = {displacement: Wire, velocity: Wire}

// Semi-implicit Euler, as in index.ts:
//   acceleration = -stiffness * displacement - damping * velocity
//   velocity' = velocity + acceleration * dt
//   displacement' = displacement + velocity' * dt
// stiffness, damping and dt are numbers known while building, so each line is an
// affine sum with constant weights: no products and no ReLUs. The builder copies
// small affine sums into the sums that read them, so the three lines end up as
// two affine sums over (displacement, velocity), and a chain of any number of
// these steps also ends up as two affine sums.
export function emitSpringStep(circuit: Circuit, spring: RelativeSpring, constants: SpringConstants): RelativeSpring {
  const dt = stepMs / 1000
  const acceleration = circuit.affine([
    [spring.displacement, -constants.stiffness],
    [spring.velocity, -constants.damping],
  ])
  const velocity = circuit.affine([[spring.velocity, 1], [acceleration, dt]])
  const displacement = circuit.affine([[spring.displacement, 1], [velocity, dt]])
  return {displacement, velocity}
}

// Plain float64 twin of emitSpringStep.
export function referenceSpringStep(displacement: number, velocity: number, constants: SpringConstants) {
  const dt = stepMs / 1000
  const acceleration = -constants.stiffness * displacement - constants.damping * velocity
  const nextVelocity = velocity + acceleration * dt
  return {displacement: displacement + nextVelocity * dt, velocity: nextVelocity}
}

// The same step as a 2x2 matrix in float64:
//   displacement' = m[0] * displacement + m[1] * velocity
//   velocity'     = m[2] * displacement + m[3] * velocity
export type Matrix2 = readonly [number, number, number, number]

export const identityMatrix: Matrix2 = [1, 0, 0, 1]

export function springStepMatrix(constants: SpringConstants): Matrix2 {
  const dt = stepMs / 1000
  const velocityKeep = 1 - constants.damping * dt
  return [1 - constants.stiffness * dt * dt, dt * velocityKeep, -constants.stiffness * dt, velocityKeep]
}

export function multiplyMatrix2(left: Matrix2, right: Matrix2): Matrix2 {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ]
}

export function matrixPower(matrix: Matrix2, count: number): Matrix2 {
  let result = identityMatrix
  let square = matrix
  let remaining = count
  while (remaining > 0) {
    if (remaining % 2 === 1) result = multiplyMatrix2(result, square)
    remaining = Math.floor(remaining / 2)
    if (remaining > 0) square = multiplyMatrix2(square, square)
  }
  return result
}
