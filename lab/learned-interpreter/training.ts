import {
  invariant,
  validateOneHotGroups,
  validateTensorEvaluation,
} from '../../src/runtime/numeric-ui-core.ts'
import {
  type CertificationCase,
  type TrainingTask,
  RandomSource,
  createTrainingInputs,
  taskOracle,
} from './oracle.ts'
import {
  type DecodedInstruction,
  type OperationName,
  type ProgramBuild,
  type ProgramLayout,
  buildProgram,
  decodeProgram,
  hardenProgram,
  writeInputs,
  writeProgram,
} from './program.ts'

export type TrainingPhase = {
  steps: number
  temperature: number
  learningRate: number
}

export type TrainingConfig = {
  batchSize: number
  lossScale: number
  adamEpsilon: number
  phases: TrainingPhase[]
  allowedOperations: readonly OperationName[]
}

export const defaultTrainingConfig: TrainingConfig = {
  batchSize: 64,
  lossScale: 256,
  adamEpsilon: 1e-8,
  allowedOperations: ['add', 'subtract', 'multiply'],
  phases: [
    {steps: 500, temperature: 2, learningRate: 0.02},
    {steps: 500, temperature: 1, learningRate: 0.02},
    {steps: 500, temperature: 0.5, learningRate: 0.01},
    {steps: 500, temperature: 0.25, learningRate: 0.005},
    {steps: 500, temperature: 0.125, learningRate: 0.002},
  ],
}

export const addOnlyTrainingConfig: TrainingConfig = {
  ...defaultTrainingConfig,
  allowedOperations: ['add'],
}

export type PhaseResult = {
  temperature: number
  finalLoss: number
  largestProbabilityByInstruction: number[]
}

export type TrainingRun = {
  seed: number
  task: TrainingTask
  intermediateMode: 'connected' | 'removed'
  softProgram: Float32Array
  hardenedProgram: Float32Array
  decodedProgram: DecodedInstruction[]
  phases: PhaseResult[]
  trainingSteps: number
}

function createInitialLogits(layout: ProgramLayout, random: RandomSource) {
  const logits = new Float64Array(layout.programCellCount)
  for (let parameter = 0; parameter < logits.length; parameter++) {
    logits[parameter] = (random.next() - 0.5) * 0.02
  }
  return logits
}

export function softmaxProgram(
  layout: ProgramLayout,
  logits: ArrayLike<number>,
  temperature: number,
  allowedOperations: readonly OperationName[] = ['add', 'subtract', 'multiply'],
): Float32Array {
  invariant(logits.length === layout.programCellCount, 'program logit count mismatch')
  invariant(temperature > 0 && Number.isFinite(temperature), 'temperature must be positive')
  const probabilities = new Float32Array(layout.programCellCount)
  for (const group of layout.instructionGroups) {
    const allowed = new Set(allowedOperations)
    let maximum = Number.NEGATIVE_INFINITY
    for (let index = 0; index < group.sourceWires.length; index++) {
      if (!allowed.has(group.candidates[index]!.operation)) continue
      maximum = Math.max(maximum, logits[group.parameterOffset + index]! / temperature)
    }
    invariant(Number.isFinite(maximum), 'at least one operation must be allowed')
    let total = 0
    for (let index = 0; index < group.sourceWires.length; index++) {
      if (!allowed.has(group.candidates[index]!.operation)) continue
      const probability = Math.exp(logits[group.parameterOffset + index]! / temperature - maximum)
      probabilities[group.parameterOffset + index] = probability
      total += probability
    }
    for (let index = 0; index < group.sourceWires.length; index++) {
      const parameter = group.parameterOffset + index
      probabilities[parameter] = probabilities[parameter]! / total
    }
  }
  return probabilities
}

function accumulateProbabilityGradients(
  build: ProgramBuild,
  sourceGradients: Float32Array,
  probabilityGradients: Float64Array,
) {
  for (const group of build.layout.instructionGroups) {
    for (let index = 0; index < group.sourceWires.length; index++) {
      const parameter = group.parameterOffset + index
      probabilityGradients[parameter] = probabilityGradients[parameter]!
        + sourceGradients[group.sourceWires[index]!]!
    }
  }
}

function convertToLogitGradients(
  layout: ProgramLayout,
  probabilities: Float32Array,
  probabilityGradients: Float64Array,
  temperature: number,
) {
  const logitGradients = new Float64Array(layout.programCellCount)
  for (const group of layout.instructionGroups) {
    let weightedGradient = 0
    for (let index = 0; index < group.sourceWires.length; index++) {
      const parameter = group.parameterOffset + index
      weightedGradient += probabilities[parameter]! * probabilityGradients[parameter]!
    }
    for (let index = 0; index < group.sourceWires.length; index++) {
      const parameter = group.parameterOffset + index
      logitGradients[parameter] = probabilities[parameter]!
        * (probabilityGradients[parameter]! - weightedGradient)
        / temperature
    }
  }
  return logitGradients
}

function largestProbabilities(layout: ProgramLayout, probabilities: Float32Array) {
  return layout.instructionGroups.map(group => {
    let maximum = 0
    for (let index = 0; index < group.sourceWires.length; index++) {
      maximum = Math.max(maximum, probabilities[group.parameterOffset + index]!)
    }
    return maximum
  })
}

export function trainProgram(
  seed: number,
  task: TrainingTask = {kind: 'coordinate'},
  intermediateMode: 'connected' | 'removed' = 'connected',
  config: TrainingConfig = defaultTrainingConfig,
): TrainingRun {
  invariant(config.lossScale > 0 && Number.isFinite(config.lossScale), 'loss scale must be positive and finite')
  invariant(config.adamEpsilon > 0 && Number.isFinite(config.adamEpsilon), 'Adam epsilon must be positive and finite')
  const instructionCount = task.kind === 'primitive' ? 1 : 2
  const build = buildProgram(instructionCount, 'soft', intermediateMode)
  const random = new RandomSource(seed)
  const logits = createInitialLogits(build.layout, random)
  const source = new Float32Array(build.circuit.sourceSize)
  const width = build.circuit.sourceSize + build.circuit.operations.length
  const outputGradients = new Float32Array(width)
  const phases: PhaseResult[] = []

  for (const phase of config.phases) {
    const firstMoment = new Float64Array(logits.length)
    const secondMoment = new Float64Array(logits.length)
    let finalLoss = 0
    for (let step = 1; step <= phase.steps; step++) {
      const probabilities = softmaxProgram(
        build.layout,
        logits,
        phase.temperature,
        config.allowedOperations,
      )
      writeProgram(source, build.layout, probabilities)
      const probabilityGradients = new Float64Array(build.layout.programCellCount)
      let batchLoss = 0
      for (let sample = 0; sample < config.batchSize; sample++) {
        const inputs = createTrainingInputs(random)
        const target = taskOracle(task, inputs)
        writeInputs(source, build.layout, inputs)
        const values = build.circuit.evaluateReference(source)
        const normalizedError = (values[build.outputWire]! - target) / config.lossScale
        batchLoss += 0.5 * normalizedError * normalizedError
        outputGradients.fill(0)
        outputGradients[build.outputWire] = normalizedError / config.lossScale
        const sourceGradients = build.circuit.backpropagateReference(values, outputGradients)
        accumulateProbabilityGradients(build, sourceGradients, probabilityGradients)
      }
      finalLoss = batchLoss / config.batchSize
      for (let parameter = 0; parameter < probabilityGradients.length; parameter++) {
        probabilityGradients[parameter] = probabilityGradients[parameter]! / config.batchSize
      }
      const logitGradients = convertToLogitGradients(
        build.layout,
        probabilities,
        probabilityGradients,
        phase.temperature,
      )
      const firstDecay = 0.9
      const secondDecay = 0.999
      const firstCorrection = 1 - firstDecay ** step
      const secondCorrection = 1 - secondDecay ** step
      for (let parameter = 0; parameter < logits.length; parameter++) {
        const gradient = logitGradients[parameter]!
        firstMoment[parameter] = firstDecay * firstMoment[parameter]!
          + (1 - firstDecay) * gradient
        secondMoment[parameter] = secondDecay * secondMoment[parameter]!
          + (1 - secondDecay) * gradient * gradient
        const correctedFirst = firstMoment[parameter]! / firstCorrection
        const correctedSecond = secondMoment[parameter]! / secondCorrection
        logits[parameter] = logits[parameter]! - phase.learningRate
          * correctedFirst
          / (Math.sqrt(correctedSecond) + config.adamEpsilon)
      }
    }
    const probabilities = softmaxProgram(
      build.layout,
      logits,
      phase.temperature,
      config.allowedOperations,
    )
    phases.push({
      temperature: phase.temperature,
      finalLoss,
      largestProbabilityByInstruction: largestProbabilities(build.layout, probabilities),
    })
  }

  const finalTemperature = config.phases[config.phases.length - 1]?.temperature ?? 1
  const softProgram = softmaxProgram(
    build.layout,
    logits,
    finalTemperature,
    config.allowedOperations,
  )
  const hardenedProgram = hardenProgram(build.layout, softProgram)
  return {
    seed,
    task,
    intermediateMode,
    softProgram,
    hardenedProgram,
    decodedProgram: decodeProgram(build.layout, hardenedProgram),
    phases,
    trainingSteps: config.phases.reduce((total, phase) => total + phase.steps, 0),
  }
}

export type VerificationResult = {
  caseCount: number
  referenceMismatches: number
  tensorMismatches: number
  mismatchesByFamily: Record<CertificationCase['family'], number>
  maximumAbsoluteError: number
}

export function verifyProgram(
  program: ArrayLike<number>,
  task: TrainingTask,
  cases: readonly CertificationCase[],
  intermediateMode: 'connected' | 'removed' = 'connected',
): VerificationResult {
  const instructionCount = task.kind === 'primitive' ? 1 : 2
  const build = buildProgram(instructionCount, 'hard', intermediateMode)
  const source = new Float32Array(build.circuit.sourceSize)
  writeProgram(source, build.layout, program)
  let referenceMismatches = 0
  let tensorMismatches = 0
  let maximumAbsoluteError = 0
  const mismatchesByFamily = {unseen: 0, extrapolation: 0, translation: 0, fractional: 0, 'input-rounding': 0}
  for (const certificationCase of cases) {
    writeInputs(source, build.layout, certificationCase.inputs)
    const target = taskOracle(task, certificationCase.inputs)
    const referenceValues = build.circuit.evaluateReference(source)
    const tensorValues = build.circuit.evaluateTensor(source)
    validateOneHotGroups(build.circuit, referenceValues)
    validateTensorEvaluation(source, build.circuit, tensorValues)
    const referenceOutput = referenceValues[build.outputWire]!
    const tensorOutput = tensorValues[build.outputWire]!
    if (referenceOutput !== target) {
      referenceMismatches++
      mismatchesByFamily[certificationCase.family]++
    }
    if (tensorOutput !== referenceOutput) tensorMismatches++
    maximumAbsoluteError = Math.max(maximumAbsoluteError, Math.abs(referenceOutput - target))
  }
  return {
    caseCount: cases.length,
    referenceMismatches,
    tensorMismatches,
    mismatchesByFamily,
    maximumAbsoluteError,
  }
}
