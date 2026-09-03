import {invariant} from '../../numeric-ui-core.ts'
import {
  type TrainingTask,
  RandomSource,
  createTrainingGrid,
  taskOracle,
} from './oracle.ts'
import {
  type DecodedInstruction,
  type InstructionCandidate,
  type ProgramLayout,
  createProgramLayout,
  decodeProgram,
  hardenProgram,
} from './program.ts'
import {defaultTrainingConfig, type TrainingPhase} from './training.ts'

export type ProgramLossMatrix = {
  task: TrainingTask
  lossScale: number
  exampleCount: number
  firstInstructionCount: number
  secondInstructionCount: number
  losses: Float64Array
  exactProgramCount: number
  minimumLoss: number
}

function evaluateCandidate(
  candidate: InstructionCandidate,
  registers: ArrayLike<number>,
): number {
  const left = registers[candidate.leftRegister]!
  const right = registers[candidate.rightRegister]!
  if (candidate.operation === 'add') return Math.fround(left + right)
  if (candidate.operation === 'subtract') return Math.fround(left - right)
  return Math.fround(left * right)
}

function taskKey(task: TrainingTask) {
  if (task.kind === 'coordinate') return 'coordinate'
  if (task.kind === 'two-add') return `two-add:${task.thirdAddend}`
  return `primitive:${task.operation}:${task.left}:${task.right}`
}

const lossMatrixCache = new Map<string, ProgramLossMatrix>()

export function buildProgramLossMatrix(
  task: TrainingTask,
  lossScale = defaultTrainingConfig.lossScale,
): ProgramLossMatrix {
  invariant(task.kind !== 'primitive', 'expected discrete training needs two instructions')
  invariant(lossScale > 0 && Number.isFinite(lossScale), 'loss scale must be positive and finite')
  const key = `${taskKey(task)}:${lossScale}`
  const cached = lossMatrixCache.get(key)
  if (cached !== undefined) return cached
  const layout = createProgramLayout(2)
  const firstCandidates = layout.instructionGroups[0]!.candidates
  const secondCandidates = layout.instructionGroups[1]!.candidates
  const losses = new Float64Array(firstCandidates.length * secondCandidates.length)
  const examples = createTrainingGrid()
  const registers = new Float32Array(5)
  const firstOutputs = new Float32Array(firstCandidates.length)

  for (const inputs of examples) {
    registers[0] = inputs.pointerX
    registers[1] = inputs.panelLeft
    registers[2] = inputs.scale
    registers[3] = inputs.distractor
    const target = taskOracle(task, inputs)
    for (let first = 0; first < firstCandidates.length; first++) {
      firstOutputs[first] = evaluateCandidate(firstCandidates[first]!, registers)
    }
    for (let first = 0; first < firstCandidates.length; first++) {
      registers[4] = firstOutputs[first]!
      const row = first * secondCandidates.length
      for (let second = 0; second < secondCandidates.length; second++) {
        const output = evaluateCandidate(secondCandidates[second]!, registers)
        const normalizedError = (output - target) / lossScale
        const program = row + second
        losses[program] = losses[program]! + 0.5 * normalizedError * normalizedError
      }
    }
  }

  let exactProgramCount = 0
  let minimumLoss = Number.POSITIVE_INFINITY
  for (let program = 0; program < losses.length; program++) {
    losses[program] = losses[program]! / examples.length
    invariant(Number.isFinite(losses[program]), 'hard-program loss must be finite')
    if (losses[program] === 0) exactProgramCount++
    minimumLoss = Math.min(minimumLoss, losses[program]!)
  }
  const result = {
    task,
    lossScale,
    exampleCount: examples.length,
    firstInstructionCount: firstCandidates.length,
    secondInstructionCount: secondCandidates.length,
    losses,
    exactProgramCount,
    minimumLoss,
  }
  lossMatrixCache.set(key, result)
  return result
}

function createInitialLogits(layout: ProgramLayout, random: RandomSource) {
  const logits = new Float64Array(layout.programCellCount)
  for (let parameter = 0; parameter < logits.length; parameter++) {
    logits[parameter] = (random.next() - 0.5) * 0.02
  }
  return logits
}

function softmaxGroup(
  logits: Float64Array,
  offset: number,
  size: number,
  temperature: number,
) {
  let maximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < size; index++) {
    maximum = Math.max(maximum, logits[offset + index]! / temperature)
  }
  const probabilities = new Float64Array(size)
  let total = 0
  for (let index = 0; index < size; index++) {
    const probability = Math.exp(logits[offset + index]! / temperature - maximum)
    probabilities[index] = probability
    total += probability
  }
  for (let index = 0; index < size; index++) {
    probabilities[index] = probabilities[index]! / total
  }
  return probabilities
}

export type ExpectedLossEvaluation = {
  loss: number
  firstMarginalLosses: Float64Array
  secondMarginalLosses: Float64Array
}

export function evaluateExpectedProgramLoss(
  matrix: ProgramLossMatrix,
  firstProbabilities: Float64Array,
  secondProbabilities: Float64Array,
): ExpectedLossEvaluation {
  invariant(
    firstProbabilities.length === matrix.firstInstructionCount,
    'first instruction probability count mismatch',
  )
  invariant(
    secondProbabilities.length === matrix.secondInstructionCount,
    'second instruction probability count mismatch',
  )
  const firstMarginalLosses = new Float64Array(matrix.firstInstructionCount)
  const secondMarginalLosses = new Float64Array(matrix.secondInstructionCount)
  let loss = 0
  for (let first = 0; first < matrix.firstInstructionCount; first++) {
    const row = first * matrix.secondInstructionCount
    let firstLoss = 0
    for (let second = 0; second < matrix.secondInstructionCount; second++) {
      const programLoss = matrix.losses[row + second]!
      firstLoss += secondProbabilities[second]! * programLoss
      secondMarginalLosses[second] = secondMarginalLosses[second]!
        + firstProbabilities[first]! * programLoss
    }
    firstMarginalLosses[first] = firstLoss
    loss += firstProbabilities[first]! * firstLoss
  }
  return {loss, firstMarginalLosses, secondMarginalLosses}
}

function logitGradients(
  probabilities: Float64Array,
  marginalLosses: Float64Array,
  expectedLoss: number,
  temperature: number,
) {
  const gradients = new Float64Array(probabilities.length)
  for (let index = 0; index < gradients.length; index++) {
    gradients[index] = probabilities[index]!
      * (marginalLosses[index]! - expectedLoss)
      / temperature
  }
  return gradients
}

export type DiscreteTrainingConfig = {
  phases: TrainingPhase[]
  lossScale: number
  lossMultiplier: number
  adamEpsilon: number
}

export const defaultDiscreteTrainingConfig: DiscreteTrainingConfig = {
  phases: defaultTrainingConfig.phases,
  lossScale: defaultTrainingConfig.lossScale,
  lossMultiplier: 1,
  adamEpsilon: 1e-14,
}

function validateConfig(config: DiscreteTrainingConfig) {
  invariant(config.adamEpsilon > 0 && Number.isFinite(config.adamEpsilon), 'Adam epsilon must be positive and finite')
  invariant(config.lossMultiplier > 0 && Number.isFinite(config.lossMultiplier), 'loss multiplier must be positive and finite')
  invariant(config.phases.length > 0, 'training needs at least one phase')
  for (const phase of config.phases) {
    invariant(phase.steps > 0 && Number.isInteger(phase.steps), 'phase steps must be a positive integer')
    invariant(phase.temperature > 0 && Number.isFinite(phase.temperature), 'temperature must be positive and finite')
    invariant(phase.learningRate > 0 && Number.isFinite(phase.learningRate), 'learning rate must be positive and finite')
  }
}

export type DiscretePhaseResult = {
  temperature: number
  expectedLoss: number
  largestProbabilityByInstruction: [number, number]
}

export type DiscreteTrainingRun = {
  seed: number
  task: TrainingTask
  softProgram: Float64Array
  hardenedProgram: Float32Array
  decodedProgram: DecodedInstruction[]
  phases: DiscretePhaseResult[]
  trainingSteps: number
}

export type JointDiscretePhaseResult = {
  temperature: number
  expectedLoss: number
  largestProgramProbability: number
}

export type JointDiscreteTrainingRun = {
  seed: number
  task: TrainingTask
  softProgramProbabilities: Float64Array
  hardenedProgram: Float32Array
  decodedProgram: DecodedInstruction[]
  phases: JointDiscretePhaseResult[]
  trainingSteps: number
}

export function trainWithExpectedProgramLoss(
  seed: number,
  task: TrainingTask,
  config: DiscreteTrainingConfig = defaultDiscreteTrainingConfig,
): DiscreteTrainingRun {
  invariant(task.kind !== 'primitive', 'expected discrete training needs two instructions')
  validateConfig(config)
  const matrix = buildProgramLossMatrix(task, config.lossScale)
  const layout = createProgramLayout(2)
  const firstGroup = layout.instructionGroups[0]!
  const secondGroup = layout.instructionGroups[1]!
  const random = new RandomSource(seed)
  const logits = createInitialLogits(layout, random)
  const phases: DiscretePhaseResult[] = []

  for (const phase of config.phases) {
    const firstMoment = new Float64Array(logits.length)
    const secondMoment = new Float64Array(logits.length)
    let evaluation: ExpectedLossEvaluation | null = null
    for (let step = 1; step <= phase.steps; step++) {
      const firstProbabilities = softmaxGroup(
        logits,
        firstGroup.parameterOffset,
        firstGroup.candidates.length,
        phase.temperature,
      )
      const secondProbabilities = softmaxGroup(
        logits,
        secondGroup.parameterOffset,
        secondGroup.candidates.length,
        phase.temperature,
      )
      evaluation = evaluateExpectedProgramLoss(
        matrix,
        firstProbabilities,
        secondProbabilities,
      )
      const firstGradients = logitGradients(
        firstProbabilities,
        evaluation.firstMarginalLosses,
        evaluation.loss,
        phase.temperature,
      )
      const secondGradients = logitGradients(
        secondProbabilities,
        evaluation.secondMarginalLosses,
        evaluation.loss,
        phase.temperature,
      )
      const gradients = new Float64Array(logits.length)
      gradients.set(firstGradients, firstGroup.parameterOffset)
      gradients.set(secondGradients, secondGroup.parameterOffset)
      const firstDecay = 0.9
      const secondDecay = 0.999
      const firstCorrection = 1 - firstDecay ** step
      const secondCorrection = 1 - secondDecay ** step
      for (let parameter = 0; parameter < logits.length; parameter++) {
        const gradient = gradients[parameter]! * config.lossMultiplier
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
    invariant(evaluation !== null, 'discrete training phase needs at least one step')
    const firstProbabilities = softmaxGroup(
      logits,
      firstGroup.parameterOffset,
      firstGroup.candidates.length,
      phase.temperature,
    )
    const secondProbabilities = softmaxGroup(
      logits,
      secondGroup.parameterOffset,
      secondGroup.candidates.length,
      phase.temperature,
    )
    evaluation = evaluateExpectedProgramLoss(matrix, firstProbabilities, secondProbabilities)
    phases.push({
      temperature: phase.temperature,
      expectedLoss: evaluation.loss * config.lossMultiplier,
      largestProbabilityByInstruction: [
        Math.max(...firstProbabilities),
        Math.max(...secondProbabilities),
      ],
    })
  }

  const finalTemperature = config.phases[config.phases.length - 1]?.temperature ?? 1
  const softProgram = new Float64Array(layout.programCellCount)
  softProgram.set(softmaxGroup(
    logits,
    firstGroup.parameterOffset,
    firstGroup.candidates.length,
    finalTemperature,
  ), firstGroup.parameterOffset)
  softProgram.set(softmaxGroup(
    logits,
    secondGroup.parameterOffset,
    secondGroup.candidates.length,
    finalTemperature,
  ), secondGroup.parameterOffset)
  const hardenedProgram = hardenProgram(layout, softProgram)
  return {
    seed,
    task,
    softProgram,
    hardenedProgram,
    decodedProgram: decodeProgram(layout, hardenedProgram),
    phases,
    trainingSteps: config.phases.reduce((total, phase) => total + phase.steps, 0),
  }
}

function softmaxAll(logits: Float64Array, temperature: number) {
  let maximum = Number.NEGATIVE_INFINITY
  for (const logit of logits) maximum = Math.max(maximum, logit / temperature)
  const probabilities = new Float64Array(logits.length)
  let total = 0
  for (let index = 0; index < logits.length; index++) {
    const probability = Math.exp(logits[index]! / temperature - maximum)
    probabilities[index] = probability
    total += probability
  }
  for (let index = 0; index < probabilities.length; index++) {
    probabilities[index] = probabilities[index]! / total
  }
  return probabilities
}

function evaluateJointExpectedLoss(
  losses: Float64Array,
  probabilities: Float64Array,
) {
  let expectedLoss = 0
  for (let program = 0; program < losses.length; program++) {
    expectedLoss += probabilities[program]! * losses[program]!
  }
  return expectedLoss
}

function hardProgramFromPair(
  layout: ProgramLayout,
  pair: number,
): Float32Array {
  const firstGroup = layout.instructionGroups[0]!
  const secondGroup = layout.instructionGroups[1]!
  const first = Math.floor(pair / secondGroup.candidates.length)
  const second = pair % secondGroup.candidates.length
  const program = new Float32Array(layout.programCellCount)
  program[firstGroup.parameterOffset + first] = 1
  program[secondGroup.parameterOffset + second] = 1
  return program
}

export function trainJointProgramDistribution(
  seed: number,
  task: TrainingTask,
  config: DiscreteTrainingConfig = defaultDiscreteTrainingConfig,
): JointDiscreteTrainingRun {
  invariant(task.kind !== 'primitive', 'joint discrete training needs two instructions')
  validateConfig(config)
  const matrix = buildProgramLossMatrix(task, config.lossScale)
  const layout = createProgramLayout(2)
  const random = new RandomSource(seed)
  const logits = new Float64Array(matrix.losses.length)
  for (let program = 0; program < logits.length; program++) {
    logits[program] = (random.next() - 0.5) * 0.02
  }
  const phases: JointDiscretePhaseResult[] = []

  for (const phase of config.phases) {
    const firstMoment = new Float64Array(logits.length)
    const secondMoment = new Float64Array(logits.length)
    for (let step = 1; step <= phase.steps; step++) {
      const probabilities = softmaxAll(logits, phase.temperature)
      const expectedLoss = evaluateJointExpectedLoss(matrix.losses, probabilities)
      const firstDecay = 0.9
      const secondDecay = 0.999
      const firstCorrection = 1 - firstDecay ** step
      const secondCorrection = 1 - secondDecay ** step
      for (let program = 0; program < logits.length; program++) {
        const gradient = probabilities[program]!
          * (matrix.losses[program]! - expectedLoss)
          / phase.temperature
          * config.lossMultiplier
        firstMoment[program] = firstDecay * firstMoment[program]!
          + (1 - firstDecay) * gradient
        secondMoment[program] = secondDecay * secondMoment[program]!
          + (1 - secondDecay) * gradient * gradient
        const correctedFirst = firstMoment[program]! / firstCorrection
        const correctedSecond = secondMoment[program]! / secondCorrection
        logits[program] = logits[program]! - phase.learningRate
          * correctedFirst
          / (Math.sqrt(correctedSecond) + config.adamEpsilon)
      }
    }
    const probabilities = softmaxAll(logits, phase.temperature)
    phases.push({
      temperature: phase.temperature,
      expectedLoss: evaluateJointExpectedLoss(matrix.losses, probabilities) * config.lossMultiplier,
      largestProgramProbability: Math.max(...probabilities),
    })
  }

  const finalTemperature = config.phases[config.phases.length - 1]?.temperature ?? 1
  const softProgramProbabilities = softmaxAll(logits, finalTemperature)
  let winner = 0
  for (let program = 1; program < softProgramProbabilities.length; program++) {
    if (softProgramProbabilities[program]! > softProgramProbabilities[winner]!) winner = program
  }
  const hardenedProgram = hardProgramFromPair(layout, winner)
  return {
    seed,
    task,
    softProgramProbabilities,
    hardenedProgram,
    decodedProgram: decodeProgram(layout, hardenedProgram),
    phases,
    trainingSteps: config.phases.reduce((total, phase) => total + phase.steps, 0),
  }
}

function selectedPair(layout: ProgramLayout, program: ArrayLike<number>): [number, number] {
  invariant(program.length === layout.programCellCount, 'program cell count mismatch')
  const selected = layout.instructionGroups.map(group => {
    let winner = 0
    for (let candidate = 1; candidate < group.candidates.length; candidate++) {
      if (program[group.parameterOffset + candidate]! > program[group.parameterOffset + winner]!) {
        winner = candidate
      }
    }
    return winner
  })
  return [selected[0]!, selected[1]!]
}

export function hardProgramLoss(matrix: ProgramLossMatrix, program: ArrayLike<number>): number {
  const [first, second] = selectedPair(createProgramLayout(2), program)
  return matrix.losses[first * matrix.secondInstructionCount + second]!
}

export type ExactSearchRun = {
  hardenedProgram: Float32Array
  decodedProgram: DecodedInstruction[]
  loss: number
  lossLookups: number
  sweeps: number
}

export function enumerateLossMatrix(matrix: ProgramLossMatrix): ExactSearchRun {
  let winner = 0
  let minimumLoss = matrix.losses[0]!
  for (let pair = 1; pair < matrix.losses.length; pair++) {
    const loss = matrix.losses[pair]!
    if (loss < minimumLoss) {
      winner = pair
      minimumLoss = loss
    }
  }
  const layout = createProgramLayout(2)
  const hardenedProgram = hardProgramFromPair(layout, winner)
  return {
    hardenedProgram,
    decodedProgram: decodeProgram(layout, hardenedProgram),
    loss: minimumLoss,
    lossLookups: matrix.losses.length,
    sweeps: 0,
  }
}

export function coordinateDescentOnLossMatrix(
  matrix: ProgramLossMatrix,
  initialProgram: ArrayLike<number>,
  maximumSweeps = 10,
): ExactSearchRun {
  invariant(maximumSweeps > 0 && Number.isInteger(maximumSweeps), 'maximum sweeps must be a positive integer')
  const layout = createProgramLayout(2)
  let [first, second] = selectedPair(layout, initialProgram)
  let loss = matrix.losses[first * matrix.secondInstructionCount + second]!
  let lossLookups = 1
  let sweeps = 0
  for (; sweeps < maximumSweeps && loss > 0;) {
    const previousLoss = loss
    for (let candidate = 0; candidate < matrix.secondInstructionCount; candidate++) {
      const candidateLoss = matrix.losses[first * matrix.secondInstructionCount + candidate]!
      lossLookups++
      if (candidateLoss < loss) {
        second = candidate
        loss = candidateLoss
      }
    }
    for (let candidate = 0; candidate < matrix.firstInstructionCount; candidate++) {
      const candidateLoss = matrix.losses[candidate * matrix.secondInstructionCount + second]!
      lossLookups++
      if (candidateLoss < loss) {
        first = candidate
        loss = candidateLoss
      }
    }
    sweeps++
    if (loss === previousLoss) break
  }
  const hardenedProgram = hardProgramFromPair(layout, first * matrix.secondInstructionCount + second)
  return {
    hardenedProgram,
    decodedProgram: decodeProgram(layout, hardenedProgram),
    loss,
    lossLookups,
    sweeps,
  }
}
