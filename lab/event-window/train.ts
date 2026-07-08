// Feedforward training of the behavior parameter cells: the slop threshold,
// the title-bar boundary, and the four relation cells mapping regions to
// actions. Supervision pairs are harvested from oracle traces one frame at a
// time; every pair is (one frame's source table -> that frame's expected
// decision bits). The training loop below contains no sequence dimension and
// no unrolling: gradients never cross a frame boundary, because the event
// window turns multi-frame behavior into a single-frame function.
//
// Training runs on the soft circuit (no boolean atoms), then hardens: relation
// cells round to exact bits, thresholds stay as learned. The hardened circuit
// is only accepted if it is closed-loop bit-exact on held-out traces.

import {
  type BehaviorParameterValues,
  type EventWindowBuild,
  behaviorParameterCells,
  buildEventWindowCircuit,
  createEventWindowMachine,
  rectangleStateCell,
  rectangleStateField,
  sourceField,
  sourceSize,
  writeConfigConstants,
  writeFrameInputToSource,
  writeOracleStateToSource,
} from './circuit.ts'
import {runClosedLoop} from './harness.ts'
import {
  type BehaviorConfig,
  createOracleState,
  oracleTick,
  rectangleCount,
} from './oracle.ts'
import {createRandom, generateTrace} from './trace.ts'

// The next-frame decision bits the trainer supervises. Every one is a state
// cell of the next source table except drag ownership, which is a per-frame
// output. Geometry needs no supervision: once the decision bits are right, the
// positions are authored arithmetic over latched values.
const supervisedCells = [
  sourceField.pressActive,
  sourceField.pressRectangleStart,
  sourceField.pressRectangleStart + 1,
  sourceField.pressRectangleStart + 2,
  sourceField.pressRectangleStart + 3,
  sourceField.pressOnTitle,
  sourceField.pressWasFocused,
  sourceField.pressOnMaximized,
  sourceField.slopLatch,
  ...Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.maximized)),
  ...Array.from({length: rectangleCount}, (_, index) =>
    rectangleStateCell(index, rectangleStateField.focused)),
] as const

export const supervisedBitCount = supervisedCells.length + rectangleCount

export type TrainingPair = {
  source: Float32Array
  targets: Float32Array
}

// One pair per kept frame: the source table the circuit would see (behavior
// parameter cells left for the trainer to fill), and the oracle's expected
// decision bits for that same frame.
export function harvestTrainingPairs(
  config: BehaviorConfig,
  traceSeed: number,
  frameCount: number,
): TrainingPair[] {
  const trace = generateTrace(config, traceSeed, frameCount)
  const state = createOracleState(config)
  const random = createRandom(traceSeed ^ 0x9e37_79b9)
  const pairs: TrainingPair[] = []
  const postState = new Float32Array(sourceSize(1))
  for (const input of trace) {
    const pressedBefore = state.pressed
    const source = new Float32Array(sourceSize(1))
    writeConfigConstants(source, config)
    writeOracleStateToSource(state, source)
    writeFrameInputToSource(input, source)
    const output = oracleTick(config, state, input)
    // Event frames and pressed frames carry the decisions; idle released
    // frames are trivial keep-state cases, so only a sample of them stays.
    if (input === null && !pressedBefore && random() >= 0.05) continue
    writeOracleStateToSource(state, postState)
    const targets = new Float32Array(supervisedBitCount)
    for (let index = 0; index < supervisedCells.length; index++) {
      targets[index] = postState[supervisedCells[index]!]!
    }
    for (let index = 0; index < rectangleCount; index++) {
      targets[supervisedCells.length + index] = output.dragOwner === index ? 1 : 0
    }
    pairs.push({source, targets})
  }
  return pairs
}

export type TrainingOptions = {
  seed: number
  initial: BehaviorParameterValues
  steps?: number
  batchSize?: number
  learningRate?: number
  // When set, trains with this fixed threshold sharpness and no learning-rate
  // annealing or optimizer resets. This retains the fixed-ramp failure mode
  // documented in the README as reproducible code; the default is the
  // annealed schedule below.
  constantSharpness?: number
}

export type TrainingResult = {
  learned: BehaviorParameterValues
  hardened: BehaviorParameterValues
  steps: number
  finalLoss: number
}

export function scrambledParameterValues(seed: number): BehaviorParameterValues {
  const random = createRandom(seed)
  return {
    slopBoundary: random() * 48,
    titleBoundary: random() * 120,
    dragFromTitle: random(),
    dragFromBody: random(),
    clickTogglesFromTitle: random(),
    clickTogglesFromBody: random(),
  }
}

const parameterBounds: Record<keyof BehaviorParameterValues, [number, number]> = {
  slopBoundary: [0, 64],
  titleBoundary: [0, 256],
  dragFromTitle: [0, 1],
  dragFromBody: [0, 1],
  clickTogglesFromTitle: [0, 1],
  clickTogglesFromBody: [0, 1],
}

const parameterNames = Object.keys(parameterBounds) as (keyof BehaviorParameterValues)[]

// The soft threshold ramp anneals from wide to narrow. A wide ramp (sharpness
// 1/32 spans 32 pixels) lets a boundary that starts far away see gradient from
// many examples; a narrow ramp (sharpness 4 spans a quarter pixel) has a
// zero-loss plateau strictly inside the correct integer band, so the boundary
// settles there regardless of how unevenly the examples straddle it. The
// learning rate shrinks alongside, so one late rare example cannot knock the
// boundary out of the plateau, and the optimizer moments reset at each phase
// change so stale momentum does not either.
type AnnealingPhase = {untilProgress: number, sharpness: number, learningRateScale: number}

const annealingPhases: readonly AnnealingPhase[] = [
  {untilProgress: 0.4, sharpness: 1 / 32, learningRateScale: 1},
  {untilProgress: 0.65, sharpness: 0.25, learningRateScale: 1},
  {untilProgress: 0.85, sharpness: 1, learningRateScale: 0.3},
  {untilProgress: 1, sharpness: 4, learningRateScale: 0.1},
]

function phaseAt(schedule: readonly AnnealingPhase[], progress: number) {
  for (const phase of schedule) {
    if (progress < phase.untilProgress) return phase
  }
  return schedule[schedule.length - 1]!
}

export function trainBehaviorParameters(
  build: EventWindowBuild,
  pairs: readonly TrainingPair[],
  options: TrainingOptions,
): TrainingResult {
  const steps = options.steps ?? 2_400
  const batchSize = options.batchSize ?? 32
  const learningRate = options.learningRate ?? 1
  const {circuit, output} = build
  const supervisedWires = [
    ...supervisedCells.map(cell => output.nextSource[cell]!),
    ...output.dragOwner,
  ]
  const random = createRandom(options.seed)
  const parameters = parameterNames.map(name => options.initial[name])
  // Thresholds travel tens of pixels; relation cells travel at most one unit.
  const parameterLearningRates: Record<keyof BehaviorParameterValues, number> = {
    slopBoundary: 0.5,
    titleBoundary: 0.5,
    dragFromTitle: 0.08,
    dragFromBody: 0.08,
    clickTogglesFromTitle: 0.08,
    clickTogglesFromBody: 0.08,
  }
  const schedule: readonly AnnealingPhase[] = options.constantSharpness === undefined
    ? annealingPhases
    : [{untilProgress: 1, sharpness: options.constantSharpness, learningRateScale: 1}]
  const firstMoment = new Float64Array(parameters.length)
  const secondMoment = new Float64Array(parameters.length)
  const width = circuit.sourceSize + circuit.operations.length
  let finalLoss = 0
  let phaseStep = 0
  let previousPhase = phaseAt(schedule, 0)

  for (let step = 0; step < steps; step++) {
    const phase = phaseAt(schedule, step / steps)
    if (phase !== previousPhase) {
      firstMoment.fill(0)
      secondMoment.fill(0)
      phaseStep = 0
      previousPhase = phase
    }
    phaseStep++
    const sharpness = phase.sharpness
    const gradients = new Float64Array(parameters.length)
    let batchLoss = 0
    for (let sample = 0; sample < batchSize; sample++) {
      const pair = pairs[Math.floor(random() * pairs.length)]!
      const source = pair.source
      for (let index = 0; index < parameters.length; index++) {
        source[behaviorParameterCells[index]!] = parameters[index]!
      }
      source[sourceField.thresholdSharpness] = sharpness
      const values = circuit.evaluateReference(source)
      const outputGradients = new Float32Array(width)
      for (let index = 0; index < supervisedWires.length; index++) {
        const error = values[supervisedWires[index]!]! - pair.targets[index]!
        outputGradients[supervisedWires[index]!] = error
        batchLoss += 0.5 * error * error
      }
      const sourceGradients = circuit.backpropagateReference(values, outputGradients)
      for (let index = 0; index < parameters.length; index++) {
        gradients[index] = gradients[index]! + sourceGradients[behaviorParameterCells[index]!]!
      }
    }
    finalLoss = batchLoss / batchSize
    const firstDecay = 0.9
    const secondDecay = 0.999
    const firstCorrection = 1 - firstDecay ** phaseStep
    const secondCorrection = 1 - secondDecay ** phaseStep
    for (let index = 0; index < parameters.length; index++) {
      const gradient = gradients[index]! / batchSize
      firstMoment[index] = firstDecay * firstMoment[index]! + (1 - firstDecay) * gradient
      secondMoment[index] =
        secondDecay * secondMoment[index]! + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[index]! / firstCorrection
      const correctedSecond = secondMoment[index]! / secondCorrection
      const bounds = parameterBounds[parameterNames[index]!]
      const stepSize = learningRate
        * parameterLearningRates[parameterNames[index]!]
        * phase.learningRateScale
      parameters[index] = Math.min(
        bounds[1],
        Math.max(
          bounds[0],
          parameters[index]! - stepSize * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8),
        ),
      )
    }
  }

  const learned = Object.fromEntries(
    parameterNames.map((name, index) => [name, parameters[index]!]),
  ) as BehaviorParameterValues
  return {learned, hardened: hardenParameterValues(learned), steps, finalLoss}
}

// Hardening: relation cells round to exact bits; the two thresholds stay as
// learned (their exactness is a band condition, checked closed-loop).
export function hardenParameterValues(learned: BehaviorParameterValues): BehaviorParameterValues {
  return {
    slopBoundary: learned.slopBoundary,
    titleBoundary: learned.titleBoundary,
    dragFromTitle: learned.dragFromTitle >= 0.5 ? 1 : 0,
    dragFromBody: learned.dragFromBody >= 0.5 ? 1 : 0,
    clickTogglesFromTitle: learned.clickTogglesFromTitle >= 0.5 ? 1 : 0,
    clickTogglesFromBody: learned.clickTogglesFromBody >= 0.5 ? 1 : 0,
  }
}

export type RecoveryReport = {
  divergences: number
  frames: number
  firstDivergenceFrame: number
  recovered: boolean
}

// Runs the hardened parameters closed-loop against the oracle on held-out
// traces; recovery means zero divergence everywhere.
export function verifyHardenedParameters(
  config: BehaviorConfig,
  hardened: BehaviorParameterValues,
  heldOutSeeds: readonly number[],
  framesPerTrace: number,
): RecoveryReport {
  let divergences = 0
  let frames = 0
  let firstDivergenceFrame = -1
  for (const seed of heldOutSeeds) {
    const trace = generateTrace(config, seed, framesPerTrace)
    const machine = createEventWindowMachine(config, {parameters: hardened})
    const result = runClosedLoop(config, trace, machine, createOracleState(config))
    if (result.divergences > 0 && firstDivergenceFrame === -1) {
      firstDivergenceFrame = frames + result.firstDivergenceFrame
    }
    divergences += result.divergences
    frames += result.frames
  }
  return {divergences, frames, firstDivergenceFrame, recovered: divergences === 0}
}

export function createSoftTrainingBuild(): EventWindowBuild {
  return buildEventWindowCircuit('soft', 1)
}

// Mean supervised loss over a whole pair set at the given parameters and
// threshold sharpness. Used to map the fixed-ramp loss landscape directly:
// scanning one parameter over a grid exposes where the MSE optimum actually
// sits, independent of any optimizer.
export function measureMeanLoss(
  build: EventWindowBuild,
  pairs: readonly TrainingPair[],
  parameters: BehaviorParameterValues,
  sharpness: number,
): number {
  const {circuit, output} = build
  const supervisedWires = [
    ...supervisedCells.map(cell => output.nextSource[cell]!),
    ...output.dragOwner,
  ]
  let loss = 0
  for (const pair of pairs) {
    const source = pair.source
    for (let index = 0; index < parameterNames.length; index++) {
      source[behaviorParameterCells[index]!] = parameters[parameterNames[index]!]
    }
    source[sourceField.thresholdSharpness] = sharpness
    const values = circuit.evaluateReference(source)
    for (let index = 0; index < supervisedWires.length; index++) {
      const error = values[supervisedWires[index]!]! - pair.targets[index]!
      loss += 0.5 * error * error
    }
  }
  return loss / pairs.length
}
