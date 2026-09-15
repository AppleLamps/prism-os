// Training across frames: one evaluation of spring-power.ts per frame, with the
// frame's position and velocity copied back into the cells, and a loss over the
// positions of every frame. The backward pass then runs once per frame, from the
// last frame to the first, and passes the gradient of the incoming position and
// velocity cells to the previous frame's outputs. This is backpropagation through
// time with one step per frame.
import {
  type ParameterName,
  type SpringParameters,
  buildSpringPowerCircuit,
  centralDifference,
  parameterNames,
  referenceSpringPower,
  withParameter,
  writeSpringSource,
} from './spring-power.ts'

// Steps per frame: a 60 fps stretch (4 steps of 4 ms, with a fifth now and then from
// the carried leftover), a 120 fps stretch, a 150 ms hitch, a 30 fps stretch, and a
// stall that hits the 300-step cap.
export const frameSchedule: readonly number[] = [
  ...Array.from({length: 12}, (_, frame) => (frame % 4 === 3 ? 5 : 4)),
  ...Array.from({length: 8}, () => 2),
  37,
  ...Array.from({length: 10}, () => 8),
  300,
]

export const recordedParameters: SpringParameters = {stiffness: 290, damping: 30, stepSeconds: 0.004, destination: 100, position: 0, velocity: 0}

export function referenceTrajectory(parameters: SpringParameters, schedule: readonly number[]) {
  const positions: number[] = []
  let state = parameters
  for (const stepCount of schedule) {
    const stepped = referenceSpringPower(state, stepCount)
    positions.push(stepped.position)
    state = {...state, position: stepped.position, velocity: stepped.velocity}
  }
  return positions
}

export function referenceLoss(parameters: SpringParameters, schedule: readonly number[], recorded: readonly number[]) {
  return referenceTrajectory(parameters, schedule).reduce((sum, position, frame) => sum + (position - recorded[frame]!) ** 2, 0)
}

export type ThroughFrames = {
  loss: number
  gradients: Record<ParameterName, number>
  frames: number
  operationsPerFrame: number
  storedValuesPerFrame: number
}

export function lossAndGradientsThroughFrames(
  parameters: SpringParameters,
  schedule: readonly number[],
  recorded: readonly number[],
  built = buildSpringPowerCircuit(),
): ThroughFrames {
  const {circuit, cells, stepped} = built
  const source = new Float32Array(circuit.sourceSize)
  const valuesByFrame: Float32Array[] = []
  let state = parameters
  let loss = 0
  for (let frame = 0; frame < schedule.length; frame++) {
    writeSpringSource(source, cells, state, schedule[frame]!)
    const values = circuit.evaluateReference(source)
    valuesByFrame.push(values)
    loss += (values[stepped.position]! - recorded[frame]!) ** 2
    state = {...state, position: values[stepped.position]!, velocity: values[stepped.velocity]!}
  }
  const totals: Record<ParameterName, number> = {stiffness: 0, damping: 0, stepSeconds: 0, destination: 0, position: 0, velocity: 0}
  let positionGradient = 0
  let velocityGradient = 0
  for (let frame = schedule.length - 1; frame >= 0; frame--) {
    const values = valuesByFrame[frame]!
    const seeds = new Float32Array(values.length)
    seeds[stepped.position] = 2 * (values[stepped.position]! - recorded[frame]!) + positionGradient
    seeds[stepped.velocity] = velocityGradient
    const gradients = circuit.backpropagateReference(values, seeds)
    for (const name of ['stiffness', 'damping', 'stepSeconds', 'destination'] as const) totals[name] += gradients[cells[name]]!
    positionGradient = gradients[cells.position]!
    velocityGradient = gradients[cells.velocity]!
  }
  totals.position = positionGradient
  totals.velocity = velocityGradient
  return {
    loss,
    gradients: totals,
    frames: schedule.length,
    operationsPerFrame: circuit.operations.length,
    storedValuesPerFrame: circuit.sourceSize + circuit.operations.length,
  }
}

export type FramesGradientRow = {name: ParameterName, backward: number, finiteDifference: number}

export function framesGradientRows(start: SpringParameters): FramesGradientRow[] {
  const recorded = referenceTrajectory(recordedParameters, frameSchedule)
  const {gradients} = lossAndGradientsThroughFrames(start, frameSchedule, recorded)
  return parameterNames.map(name => ({
    name,
    backward: gradients[name],
    finiteDifference: centralDifference(value => referenceLoss(withParameter(start, name, value), frameSchedule, recorded), start[name]),
  }))
}

export type SpringFit = {iterations: number, lossBefore: number, lossAfter: number, stiffness: number, damping: number}

// A toy fit: Adam on stiffness and damping, starting from 200 and 20, toward the
// recorded trajectory of 290 and 30. Every iteration runs every frame forward and back.
export function fitSpringToRecording(iterations: number): SpringFit {
  const recorded = referenceTrajectory(recordedParameters, frameSchedule)
  const built = buildSpringPowerCircuit()
  let parameters: SpringParameters = {...recordedParameters, stiffness: 200, damping: 20}
  const learningRates = {stiffness: 4, damping: 0.4}
  const moments = {stiffness: {first: 0, second: 0}, damping: {first: 0, second: 0}}
  let lossBefore = 0
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const {loss, gradients} = lossAndGradientsThroughFrames(parameters, frameSchedule, recorded, built)
    if (iteration === 1) lossBefore = loss
    const next = {...parameters}
    for (const name of ['stiffness', 'damping'] as const) {
      const moment = moments[name]
      moment.first = 0.9 * moment.first + 0.1 * gradients[name]
      moment.second = 0.999 * moment.second + 0.001 * gradients[name] ** 2
      const firstCorrected = moment.first / (1 - 0.9 ** iteration)
      const secondCorrected = moment.second / (1 - 0.999 ** iteration)
      const decay = 1 / (1 + iteration / 100)
      next[name] = parameters[name] - learningRates[name] * decay * firstCorrected / (Math.sqrt(secondCorrected) + 1e-12)
    }
    parameters = next
  }
  const lossAfter = lossAndGradientsThroughFrames(parameters, frameSchedule, recorded, built).loss
  return {iterations, lossBefore, lossAfter, stiffness: parameters.stiffness, damping: parameters.damping}
}
