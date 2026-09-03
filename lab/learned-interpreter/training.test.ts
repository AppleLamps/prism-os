import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createCertificationCases, primitiveTasks} from './oracle.ts'
import {buildProgram, encodeCoordinateProgram, writeInputs, writeProgram} from './program.ts'
import {
  defaultTrainingConfig,
  softmaxProgram,
  trainProgram,
  verifyProgram,
} from './training.ts'

test('softmax respects each instruction and the allowed operation set', () => {
  const {layout} = buildProgram(2)
  const logits = Float64Array.from({length: layout.programCellCount}, (_, index) => Math.sin(index))
  const probabilities = softmaxProgram(layout, logits, 0.5, ['add'])
  for (const group of layout.instructionGroups) {
    let total = 0
    for (let candidate = 0; candidate < group.candidates.length; candidate++) {
      const probability = probabilities[group.parameterOffset + candidate]!
      assert.ok(Number.isFinite(probability) && probability >= 0)
      if (group.candidates[candidate]!.operation !== 'add') assert.equal(probability, 0)
      total += probability
    }
    assert.ok(Math.abs(total - 1) < 1e-6)
  }
})

test('the composed coordinate program has the correct input gradient at zero displacement', () => {
  const build = buildProgram(2)
  const source = new Float32Array(build.layout.sourceSize)
  writeProgram(source, build.layout, encodeCoordinateProgram(build.layout))
  writeInputs(source, build.layout, {pointerX: 0, panelLeft: 0, scale: 3, distractor: 7})
  const values = build.circuit.evaluateReference(source)
  const outputGradients = new Float32Array(values.length)
  outputGradients[build.outputWire] = 1
  const gradients = build.circuit.backpropagateReference(values, outputGradients)
  assert.equal(gradients[build.layout.inputWires[0]!], 3)
  assert.equal(gradients[build.layout.inputWires[1]!], -3)
  assert.equal(gradients[build.layout.inputWires[2]!], 0)
  assert.equal(gradients[build.layout.inputWires[3]!], 0)
})

test('one-instruction training recovers the primitive controls', () => {
  const cases = createCertificationCases()
  for (const task of primitiveTasks) {
    const run = trainProgram(201, task)
    const verification = verifyProgram(run.hardenedProgram, task, cases)
    assert.equal(verification.referenceMismatches, 0, JSON.stringify(run.decodedProgram))
    assert.equal(verification.tensorMismatches, 0)
    assert.ok(run.phases.every(phase => Number.isFinite(phase.finalLoss)))
  }
}, 30_000)

test('soft two-instruction training produces a finite program both evaluators agree on', () => {
  const task = {kind: 'coordinate'} as const
  const run = trainProgram(101, task, 'connected', {
    ...defaultTrainingConfig,
    phases: [{steps: 10, temperature: 1, learningRate: 0.02}],
  })
  assert.ok(run.softProgram.every(Number.isFinite))
  assert.equal(run.trainingSteps, 10)
  const verification = verifyProgram(run.hardenedProgram, task, createCertificationCases())
  assert.equal(verification.tensorMismatches, 0)
})

test('the authored composition depends on the intermediate result', () => {
  const {layout} = buildProgram(2)
  const program = encodeCoordinateProgram(layout)
  const removed = verifyProgram(program, {kind: 'coordinate'}, createCertificationCases(), 'removed')
  assert.ok(removed.referenceMismatches > 0)
  assert.equal(removed.tensorMismatches, 0)
})
