// Float64 spring math shared by the circuit builder (to compute constant
// tables) and by the independent JS references (to check the circuit).
//
// A spring lane is (displacement from its destination, velocity). One
// semi-implicit Euler step of `stepMs` milliseconds is the linear map
//   v' = v + (-stiffness * e - damping * v) * dt
//   e' = e + v' * dt
// which is the 2x2 matrix below. N steps are that matrix to the power N.

export type Matrix2 = readonly [
  displacementFromDisplacement: number,
  displacementFromVelocity: number,
  velocityFromDisplacement: number,
  velocityFromVelocity: number,
]

export type SpringConstants = {
  stiffness: number
  damping: number
}

export const identityMatrix: Matrix2 = [1, 0, 0, 1]

export function multiplyMatrix2(left: Matrix2, right: Matrix2): Matrix2 {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ]
}

export function eulerStepMatrix(constants: SpringConstants, stepMs: number): Matrix2 {
  const dt = stepMs / 1000
  const velocityKeep = 1 - constants.damping * dt
  return [
    1 - constants.stiffness * dt * dt,
    dt * velocityKeep,
    -constants.stiffness * dt,
    velocityKeep,
  ]
}

export function matrixPower(step: Matrix2, count: number): Matrix2 {
  let result = identityMatrix
  let square = step
  let remaining = count
  while (remaining > 0) {
    if (remaining % 2 === 1) result = multiplyMatrix2(result, square)
    remaining = Math.floor(remaining / 2)
    if (remaining > 0) square = multiplyMatrix2(square, square)
  }
  return result
}

// The vibescript clock contract. JS rounds requestAnimationFrame timestamps to
// this grid before subtracting, so every frame delta is exact in FP32 and the
// sum of deltas over any partition of time is the same number.
export type SpringClockConfig = {
  stepMs: number
  maxSteps: number
  // Steps per coarse chunk of the step count, see createSpringClock.
  fineSteps: number
  // Frame times are rounded to 1 / timeGrid milliseconds.
  timeGrid: number
  // JS clamps each frame delta, and the circuit clamps the carried leftover, to
  // this many milliseconds.
  maxFrameDeltaMs: number
}

export const defaultClockConfig: SpringClockConfig = {
  stepMs: 4,
  maxSteps: 300,
  fineSteps: 16,
  timeGrid: 64,
  maxFrameDeltaMs: 65_536,
}

export function quantizeFrameTime(frameTime: number, config: SpringClockConfig) {
  return Math.round(frameTime * config.timeGrid) / config.timeGrid
}

// JS side of the clock: turns absolute frame times into frame deltas. Absolute
// timestamps stay in float64 here, so long sessions don't lose resolution the
// way an FP32 cell holding `performance.now()` would after a few hours.
export function createFrameDeltaTracker(config: SpringClockConfig) {
  let previousFrameTime: number | null = null
  return function frameDelta(frameTime: number) {
    const quantized = quantizeFrameTime(frameTime, config)
    const delta = previousFrameTime === null
      ? 0
      : Math.min(config.maxFrameDeltaMs, Math.max(0, quantized - previousFrameTime))
    previousFrameTime = quantized
    return delta
  }
}

// The vibescript `animatedUntilTime` clock in leftover form. `running` is
// false when the previous frame ended with nothing animating, which the
// doctrine writes as `animatedUntilTime = null`.
export type ReferenceClock = {
  leftoverMs: number
  running: boolean
}

export function advanceReferenceClock(clock: ReferenceClock, frameDeltaMs: number, config: SpringClockConfig) {
  const pendingMs = clock.running ? clock.leftoverMs + frameDeltaMs : 0
  const steps = Math.min(config.maxSteps, Math.floor(pendingMs / config.stepMs))
  const leftoverMs = Math.min(config.maxFrameDeltaMs, pendingMs - steps * config.stepMs)
  return {steps, leftoverMs}
}

export type ReferenceLane = {
  position: number
  velocity: number
  // Only read with deferred retargeting.
  previousDestination: number
  constants: SpringConstants
}

export type RetargetTiming = 'doctrine' | 'deferred'

// Doctrine springs for one box: every lane is stepped `steps` times with plain
// float64 Euler loops, then all lanes snap together once every lane is mostly
// done (`|destination - position| <= settleDistance && |velocity| <=
// settleSpeed`), or when `snap` pins the box to its destinations.
//
// Retarget timing:
// - doctrine: the new destination applies to this frame's steps, as in the
//   vibescript demos, where "handle inputs" runs before the animation tick.
// - deferred: this frame's steps still move toward the previous destination,
//   because those steps simulate time before this frame's timestamp. The new
//   destination applies from the next frame's first step.
export function referenceBoxStep(
  lanes: ReferenceLane[],
  destinations: readonly number[],
  steps: number,
  options: {
    snap: boolean
    settleDistance: number
    settleSpeed: number
    stepMs: number
    retarget: RetargetTiming
  },
) {
  const dt = options.stepMs / 1000
  const checks: number[] = []
  let settled = true
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const lane = lanes[laneIndex]!
    const destination = destinations[laneIndex]!
    const base = options.retarget === 'deferred' ? lane.previousDestination : destination
    let displacement = lane.position - base
    let velocity = lane.velocity
    for (let step = 0; step < steps; step++) {
      const acceleration = -lane.constants.stiffness * displacement - lane.constants.damping * velocity
      velocity += acceleration * dt
      displacement += velocity * dt
    }
    const check = base + displacement - destination
    checks.push(check)
    lane.velocity = velocity
    if (Math.abs(check) > options.settleDistance || Math.abs(velocity) > options.settleSpeed) settled = false
  }
  const active = !settled && !options.snap
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const lane = lanes[laneIndex]!
    const destination = destinations[laneIndex]!
    lane.position = active ? destination + checks[laneIndex]! : destination
    if (!active) lane.velocity = 0
    lane.previousDestination = destination
  }
  return {active, settled}
}
