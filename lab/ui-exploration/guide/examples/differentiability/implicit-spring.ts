// Implicit differentiation of a spring's settled state.
//
// One semi-implicit Euler step, with stiffness k, damping b, step duration dt, the destination,
// and a constant acceleration g, e.g. gravity in screen coordinates, where y grows downward:
//   velocity' = velocity + (k (destination − position) − b velocity + g) dt
//   position' = position + velocity' dt
// which is
//   position' = (1 − k dt²) position + dt (1 − b dt) velocity + k dt² destination + dt² g
//   velocity' =      −k dt  position +     (1 − b dt) velocity + k dt  destination + dt g
// Write it as state' = step(state, parameters). A settled state satisfies
//   step(state*, parameters) − state* = 0.
// Differentiating that equation with respect to one parameter gives a 2×2 linear system:
//   (I − ∂step/∂state) × d state*/d parameter = ∂step/∂parameter, evaluated at state*.
// The loop that reached the settled state doesn't appear, so neither its history nor its step
// count is needed for the gradient.
//
// The solve needs I − ∂step/∂state to be invertible. Its determinant is k dt², so stiffness 0 or
// a step duration of 0 gives NaN. E.g. with stiffness 0, every position with zero velocity is a
// settled state, so the equation has no unique solution.
//
// The settled state is g / k below the destination, with zero velocity. With g = 0, every
// parameter slope except the destination's multiplies a distance or a velocity that is 0 at the
// settled state, so a check can only confirm gradients of 1 and 0. With g ≠ 0, the stiffness
// slope multiplies the distance g / k, and the settled position's gradient with respect to
// stiffness is −g / k². The settled velocity is 0 either way, so the result of the solve never
// depends on the second column of I − ∂step/∂state.
import {type SpringParameters, centralDifference} from './spring-power.ts'

// gravity: the constant acceleration g in px/s². spring-power.ts's springs have none.
export type SettlingSpring = SpringParameters & {gravity?: number}

export const settledParameterNames = ['stiffness', 'damping', 'stepSeconds', 'destination', 'gravity'] as const
export type SettledParameterName = typeof settledParameterNames[number]

type Vector2 = readonly [number, number]
type Matrix2 = readonly [number, number, number, number]
type SpringState = {position: number, velocity: number}

function solve2(matrix: Matrix2, right: Vector2): Vector2 {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]
  return [
    (right[0] * matrix[3] - matrix[1] * right[1]) / determinant,
    (matrix[0] * right[1] - right[0] * matrix[2]) / determinant,
  ]
}

// I − ∂step/∂state, where ∂step/∂state is the step matrix on (position, velocity).
function identityMinusStepMatrix({stiffness, damping, stepSeconds}: SettlingSpring): Matrix2 {
  return [stiffness * stepSeconds * stepSeconds, -stepSeconds * (1 - damping * stepSeconds), stiffness * stepSeconds, damping * stepSeconds]
}

// ∂step/∂parameter at a given state.
function stepParameterSlope(spring: SettlingSpring, name: SettledParameterName, state: SpringState): Vector2 {
  const {stiffness, damping, stepSeconds, destination} = spring
  const distanceToDestination = destination - state.position
  const acceleration = stiffness * distanceToDestination - damping * state.velocity + (spring.gravity ?? 0)
  switch (name) {
    case 'stiffness':
      return [stepSeconds * stepSeconds * distanceToDestination, stepSeconds * distanceToDestination]
    case 'damping':
      return [-stepSeconds * stepSeconds * state.velocity, -stepSeconds * state.velocity]
    case 'stepSeconds':
      // position' = position + dt × (velocity + acceleration × dt), velocity' = velocity + acceleration × dt
      return [state.velocity + 2 * stepSeconds * acceleration, acceleration]
    case 'destination':
      return [stiffness * stepSeconds * stepSeconds, stiffness * stepSeconds]
    case 'gravity':
      return [stepSeconds * stepSeconds, stepSeconds]
  }
}

// The settled state from the equation alone. The step is affine in the state, the destination
// and gravity, so (I − A) state* = ∂step/∂destination × destination + ∂step/∂gravity × gravity.
export function settledState(spring: SettlingSpring): SpringState {
  const origin = {position: 0, velocity: 0}
  const fromDestination = stepParameterSlope(spring, 'destination', origin)
  const fromGravity = stepParameterSlope(spring, 'gravity', origin)
  const gravity = spring.gravity ?? 0
  const [position, velocity] = solve2(identityMinusStepMatrix(spring), [
    fromDestination[0] * spring.destination + fromGravity[0] * gravity,
    fromDestination[1] * spring.destination + fromGravity[1] * gravity,
  ])
  return {position, velocity}
}

export type SettledGradients = Record<SettledParameterName | 'position' | 'velocity', number>

// d settledPosition / d parameter. The settled state doesn't depend on where the spring started,
// so the initial position and velocity get 0.
export function settledPositionGradients(spring: SettlingSpring): SettledGradients {
  const state = settledState(spring)
  const matrix = identityMinusStepMatrix(spring)
  const gradients: SettledGradients = {stiffness: 0, damping: 0, stepSeconds: 0, destination: 0, gravity: 0, position: 0, velocity: 0}
  for (const name of settledParameterNames) gradients[name] = solve2(matrix, stepParameterSlope(spring, name, state))[0]
  return gradients
}

// A plain float64 Euler loop: backward-cost.ts's referenceUnrolledSpring, plus gravity.
export function simulateSettlingSpring(spring: SettlingSpring, stepCount: number) {
  const gravity = spring.gravity ?? 0
  let displacement = spring.position - spring.destination
  let velocity = spring.velocity
  for (let step = 0; step < stepCount; step++) {
    const acceleration = -spring.stiffness * displacement - spring.damping * velocity + gravity
    velocity += acceleration * spring.stepSeconds
    displacement += velocity * spring.stepSeconds
  }
  return {displacement, velocity, position: spring.destination + displacement}
}

export type ImplicitCheck = {
  samples: number
  // Largest |implicit gradient − central difference of a long float64 simulation|.
  largestError: number
  // Largest |simulated position − settled position from the equation| after the long
  // simulation, to show the springs settled.
  largestDistanceFromSettledPosition: number
  // Largest |d settled position / d stiffness|, to show whether the stiffness slope affected the gradients.
  largestStiffnessGradient: number
}

export type ImplicitCheckOptions = {
  samples?: number
  stepCount?: number
  // Draws gravity between 0 and 4,000 px/s² for each spring, and checks the gravity gradient too.
  withGravity?: boolean
}

export function checkSettledGradients(random: () => number, options: ImplicitCheckOptions = {}): ImplicitCheck {
  const {samples = 20, stepCount = 4096, withGravity = false} = options
  const result: ImplicitCheck = {samples, largestError: 0, largestDistanceFromSettledPosition: 0, largestStiffnessGradient: 0}
  const names = withGravity
    ? ['stiffness', 'damping', 'stepSeconds', 'destination', 'gravity', 'position', 'velocity'] as const
    : ['stiffness', 'damping', 'stepSeconds', 'destination', 'position', 'velocity'] as const
  for (let sample = 0; sample < samples; sample++) {
    const spring: SettlingSpring = {
      stiffness: 100 + 600 * random(),
      damping: 10 + 40 * random(),
      stepSeconds: 0.004,
      destination: Math.round(800 * random()),
      position: Math.round(800 * random()),
      velocity: Math.round(4000 * random() - 2000),
    }
    if (withGravity) spring.gravity = 4000 * random()
    const implicit = settledPositionGradients(spring)
    const simulated = simulateSettlingSpring(spring, stepCount)
    result.largestDistanceFromSettledPosition = Math.max(result.largestDistanceFromSettledPosition, Math.abs(simulated.position - settledState(spring).position))
    result.largestStiffnessGradient = Math.max(result.largestStiffnessGradient, Math.abs(implicit.stiffness))
    for (const name of names) {
      const difference = centralDifference(value => simulateSettlingSpring({...spring, [name]: value}, stepCount).position, spring[name] ?? 0)
      result.largestError = Math.max(result.largestError, Math.abs(implicit[name] - difference))
    }
  }
  return result
}
