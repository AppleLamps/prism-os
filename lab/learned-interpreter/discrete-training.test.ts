import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  buildProgramLossMatrix,
  coordinateDescentOnLossMatrix,
  defaultDiscreteTrainingConfig,
  enumerateLossMatrix,
  evaluateExpectedProgramLoss,
  hardProgramLoss,
  trainJointProgramDistribution,
  trainWithExpectedProgramLoss,
} from './discrete-training.ts'
import {
  type TrainingTask,
  createCertificationCases,
  createIntegerCertificationCases,
} from './oracle.ts'
import {verifyProgram} from './training.ts'

function softmax(logits: readonly number[], temperature: number) {
  const maximum = Math.max(...logits.map(logit => logit / temperature))
  const probabilities = logits.map(logit => Math.exp(logit / temperature - maximum))
  const total = probabilities.reduce((sum, probability) => sum + probability, 0)
  return Float64Array.from(probabilities, probability => probability / total)
}

test('the loss matrices score every hard program over the full training domain', () => {
  const twoAdd = buildProgramLossMatrix({kind: 'two-add', thirdAddend: 'distractor'})
  const coordinate = buildProgramLossMatrix({kind: 'coordinate'})
  assert.equal(twoAdd.exampleCount, 14_739)
  assert.equal(twoAdd.losses.length, 3_600)
  assert.equal(twoAdd.exactProgramCount, 12)
  assert.equal(twoAdd.minimumLoss, 0)
  assert.equal(coordinate.exampleCount, 14_739)
  assert.equal(coordinate.losses.length, 3_600)
  assert.equal(coordinate.exactProgramCount, 2)
  assert.equal(coordinate.minimumLoss, 0)
})

test('both factorized expected-loss gradients match finite differences across temperatures', () => {
  const matrix = buildProgramLossMatrix({kind: 'two-add', thirdAddend: 'distractor'})
  const firstLogits = Array.from(
    {length: matrix.firstInstructionCount},
    (_, index) => Math.sin(index * 1.7) * 0.1,
  )
  const secondLogits = Array.from(
    {length: matrix.secondInstructionCount},
    (_, index) => Math.cos(index * 1.3) * 0.1,
  )
  const epsilon = 1e-5
  for (const temperature of [2, 0.7, 0.25]) {
    const firstProbabilities = softmax(firstLogits, temperature)
    const secondProbabilities = softmax(secondLogits, temperature)
    const evaluation = evaluateExpectedProgramLoss(
      matrix,
      firstProbabilities,
      secondProbabilities,
    )
    const firstGradients = Float64Array.from(
      firstProbabilities,
      (probability, index) => probability
        * (evaluation.firstMarginalLosses[index]! - evaluation.loss)
        / temperature,
    )
    const secondGradients = Float64Array.from(
      secondProbabilities,
      (probability, index) => probability
        * (evaluation.secondMarginalLosses[index]! - evaluation.loss)
        / temperature,
    )
    assert.ok(Math.abs(firstGradients.reduce((sum, gradient) => sum + gradient, 0)) < 1e-12)
    assert.ok(Math.abs(secondGradients.reduce((sum, gradient) => sum + gradient, 0)) < 1e-12)

    for (const [group, parameter, logits, otherProbabilities] of [
      ['first', 7, firstLogits, secondProbabilities],
      ['second', 11, secondLogits, firstProbabilities],
    ] as const) {
      const lowerLogits = [...logits]
      const upperLogits = [...logits]
      lowerLogits[parameter] = lowerLogits[parameter]! - epsilon
      upperLogits[parameter] = upperLogits[parameter]! + epsilon
      const lower = group === 'first'
        ? evaluateExpectedProgramLoss(
            matrix,
            softmax(lowerLogits, temperature),
            otherProbabilities,
          ).loss
        : evaluateExpectedProgramLoss(
            matrix,
            otherProbabilities,
            softmax(lowerLogits, temperature),
          ).loss
      const upper = group === 'first'
        ? evaluateExpectedProgramLoss(
            matrix,
            softmax(upperLogits, temperature),
            otherProbabilities,
          ).loss
        : evaluateExpectedProgramLoss(
            matrix,
            otherProbabilities,
            softmax(upperLogits, temperature),
          ).loss
      const numerical = (upper - lower) / (2 * epsilon)
      const analytic = group === 'first'
        ? firstGradients[parameter]!
        : secondGradients[parameter]!
      assert.ok(Math.abs(analytic - numerical) < 1e-8, `${analytic} versus ${numerical}`)
    }
  }
})

test('loss normalization scales every score without changing exact programs', () => {
  const task = {kind: 'coordinate'} as const
  const original = buildProgramLossMatrix(task, 256)
  const rescaled = buildProgramLossMatrix(task, 128)
  assert.equal(original.lossScale, 256)
  assert.equal(rescaled.lossScale, 128)
  assert.equal(original.exactProgramCount, rescaled.exactProgramCount)
  for (let pair = 0; pair < original.losses.length; pair++) {
    assert.equal(rescaled.losses[pair], original.losses[pair]! * 4)
  }
  assert.throws(() => buildProgramLossMatrix(task, 0))
})

test('direct Adam epsilon and equivalent loss scaling agree without mutating cached scores', () => {
  const tasks: TrainingTask[] = [
    {kind: 'two-add', thirdAddend: 'distractor'},
    {kind: 'coordinate'},
  ]
  for (const task of tasks) {
    const matrix = buildProgramLossMatrix(task)
    const originalLosses = matrix.losses.slice()
    const direct = trainWithExpectedProgramLoss(1001, task)
    const rescaled = trainWithExpectedProgramLoss(1001, task, {
      ...defaultDiscreteTrainingConfig,
      adamEpsilon: 1e-8,
      lossMultiplier: 1e6,
    })
    assert.equal(hardProgramLoss(matrix, direct.hardenedProgram), 0)
    assert.deepEqual(rescaled.hardenedProgram, direct.hardenedProgram)
    for (let parameter = 0; parameter < direct.softProgram.length; parameter++) {
      assert.ok(Math.abs(direct.softProgram[parameter]! - rescaled.softProgram[parameter]!) < 1e-7)
    }
    assert.deepEqual(matrix.losses, originalLosses)
    const verification = verifyProgram(direct.hardenedProgram, task, createIntegerCertificationCases())
    assert.equal(verification.referenceMismatches, 0)
    assert.equal(verification.tensorMismatches, 0)
  }
})

test('joint optimization and exact search produce correct integer-domain programs', () => {
  const task = {kind: 'two-add', thirdAddend: 'distractor'} as const
  const matrix = buildProgramLossMatrix(task)
  const joint = trainJointProgramDistribution(521, task)
  const enumeration = enumerateLossMatrix(matrix)
  assert.equal(enumeration.lossLookups, 3_600)
  for (const run of [joint, enumeration]) {
    assert.equal(hardProgramLoss(matrix, run.hardenedProgram), 0)
    const verification = verifyProgram(run.hardenedProgram, task, createIntegerCertificationCases())
    assert.equal(verification.referenceMismatches, 0)
    assert.equal(verification.tensorMismatches, 0)
  }
})

test('exact coordinate updates never worsen loss and count their table accesses', () => {
  for (const task of [{kind: 'coordinate'}, {kind: 'two-add', thirdAddend: 'distractor'}] as const) {
    const matrix = buildProgramLossMatrix(task)
    const initial = trainWithExpectedProgramLoss(1001, task, {
      ...defaultDiscreteTrainingConfig,
      adamEpsilon: 1e-8,
    })
    const refined = coordinateDescentOnLossMatrix(matrix, initial.hardenedProgram)
    assert.ok(refined.loss <= hardProgramLoss(matrix, initial.hardenedProgram))
    assert.equal(refined.loss, 0)
    assert.equal(refined.lossLookups, 1 + refined.sweeps * (48 + 75))
    const unchanged = coordinateDescentOnLossMatrix(matrix, refined.hardenedProgram)
    assert.equal(unchanged.sweeps, 0)
    assert.equal(unchanged.lossLookups, 1)
    assert.deepEqual(unchanged.hardenedProgram, refined.hardenedProgram)
    const verification = verifyProgram(refined.hardenedProgram, task, createCertificationCases())
    assert.equal(verification.tensorMismatches, 0)
    assert.equal(verification.mismatchesByFamily.unseen, 0)
    assert.equal(verification.mismatchesByFamily.extrapolation, 0)
    assert.equal(verification.mismatchesByFamily.translation, 0)
  }
})

test('invalid numerical settings fail explicitly', () => {
  const task = {kind: 'coordinate'} as const
  for (const config of [
    {...defaultDiscreteTrainingConfig, adamEpsilon: 0},
    {...defaultDiscreteTrainingConfig, lossMultiplier: -1},
    {...defaultDiscreteTrainingConfig, lossScale: Number.POSITIVE_INFINITY},
  ]) assert.throws(() => trainWithExpectedProgramLoss(1001, task, config))
})
