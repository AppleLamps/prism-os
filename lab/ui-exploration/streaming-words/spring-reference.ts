// The float64 reference for every spring in a stream circuit: the same fixed steps iterated one at a
// time, the same settle rule, and the same gates (an invisible word starts at its target and at rest;
// with spawn 'from-previous', an arriving word starts at the previous segment's position).
//
// Targets come from the circuit's outputs, which the layout checks already compare with pretext, so
// this reference checks only the spring dynamics and gates.
import {opacitySettleThreshold, visibleOpacity, type SpawnMode, type StreamBuild, type StreamOutputs} from './stream-circuit.ts'
import {iterateSpring, type SpringConfig} from '../text-walker/word-springs.ts'

export type SpringStep = {position: number, velocity: number, active: number}

// n fixed steps, then the circuit's settle rule: activity is 1024 times how far distance and speed
// exceed the threshold, clamped to 1, and the position is the target plus the displacement times it.
export function referenceSpringStep(position: number, velocity: number, target: number, steps: number, config: SpringConfig, threshold = config.settleThreshold): SpringStep {
  const [displacement, nextVelocity] = iterateSpring(position - target, velocity, steps, config)
  const excess = (value: number) => Math.max(0, value - threshold)
  const score = 1024 * (excess(displacement) + excess(-displacement) + excess(nextVelocity) + excess(-nextVelocity))
  const active = Math.min(1, score)
  return {position: target + displacement * active, velocity: nextVelocity * active, active}
}

export type ReferenceWords = {
  x: Float64Array
  y: Float64Array
  velocityX: Float64Array
  velocityY: Float64Array
  opacity: Float64Array
  opacityVelocity: Float64Array
}

export function referenceWordsFromTable(build: StreamBuild, table: Float32Array): ReferenceWords {
  const words = build.cells.words!
  const read = (wires: readonly number[]) => Float64Array.from(wires, wire => table[wire]!)
  return {x: read(words.x), y: read(words.y), velocityX: read(words.velocityX), velocityY: read(words.velocityY), opacity: read(words.opacity), opacityVelocity: read(words.opacityVelocity)}
}

// One evaluation of every word spring. `arrivedCount` and `previousArrivedCount` are this
// evaluation's and the previous one's.
export function referenceWordsStep(
  state: ReferenceWords,
  outputs: StreamOutputs,
  arrivedCount: number,
  previousArrivedCount: number,
  steps: number,
  config: SpringConfig,
  spawn: SpawnMode,
): {next: ReferenceWords, active: number} {
  const count = state.x.length
  const next: ReferenceWords = {
    x: new Float64Array(count), y: new Float64Array(count), velocityX: new Float64Array(count),
    velocityY: new Float64Array(count), opacity: new Float64Array(count), opacityVelocity: new Float64Array(count),
  }
  let active = 0
  for (let j = 0; j < count; j++) {
    const visible = state.opacity[j]! >= visibleOpacity
    const targetX = outputs.targetX[j]!
    const targetY = outputs.targetY[j]!
    let sourceX = visible ? state.x[j]! : targetX
    let sourceY = visible ? state.y[j]! : targetY
    if (spawn === 'from-previous' && j > 0 && j < arrivedCount && j >= previousArrivedCount) {
      sourceX = state.x[j - 1]!
      sourceY = state.y[j - 1]!
    }
    const springX = referenceSpringStep(sourceX, visible ? state.velocityX[j]! : 0, targetX, steps, config)
    const springY = referenceSpringStep(sourceY, visible ? state.velocityY[j]! : 0, targetY, steps, config)
    const fade = referenceSpringStep(state.opacity[j]!, state.opacityVelocity[j]!, j < arrivedCount ? 1 : 0, steps, config, opacitySettleThreshold)
    next.x[j] = springX.position
    next.y[j] = springY.position
    next.velocityX[j] = springX.velocity
    next.velocityY[j] = springY.velocity
    next.opacity[j] = fade.position
    next.opacityVelocity[j] = fade.velocity
    active += springX.active + springY.active + fade.active
  }
  return {next, active}
}

// The largest difference between the circuit's spring outputs and the reference, over positions and
// opacities.
export function wordDrift(outputs: StreamOutputs, reference: ReferenceWords): {position: number, opacity: number} {
  let position = 0
  let opacity = 0
  for (let j = 0; j < reference.x.length; j++) {
    position = Math.max(position, Math.abs(outputs.springX[j]! - reference.x[j]!), Math.abs(outputs.springY[j]! - reference.y[j]!))
    opacity = Math.max(opacity, Math.abs(outputs.opacity[j]! - reference.opacity[j]!))
  }
  return {position, opacity}
}
