// Standalone audit probes. These report observations without changing the implementation.
import {Circuit, emitMultiply} from '../numeric-ui-core.ts'
import {
  buildProgramLossMatrix,
  defaultDiscreteTrainingConfig,
  trainWithExpectedProgramLoss,
} from './learned-interpreter/discrete-training.ts'
import {type TrainingTask} from './learned-interpreter/oracle.ts'
import {compileFunctionFromSource} from './trace-compiler/compile.ts'
import {functionTrialRunner, runEquivalence} from './trace-compiler/harness.ts'

function report(name: string, result: object) {
  console.log(JSON.stringify({name, ...result}))
}

function probeLossScaling() {
  const tasks: TrainingTask[] = [
    {kind: 'two-add', thirdAddend: 'distractor'},
    {kind: 'coordinate'},
  ]
  for (const task of tasks) {
    const matrix = buildProgramLossMatrix(task)
    const originalLosses = new Float64Array(matrix.losses)
    try {
      for (const multiplier of [1, 10, 100, 1_000, 10_000, 1_000_000]) {
        // The trainer reads this same cached matrix; restore it after the probe.
        for (let index = 0; index < matrix.losses.length; index++) {
          matrix.losses[index] = originalLosses[index]! * multiplier
        }
        let exactOnTrainingGrid = 0
        for (let seed = 3001; seed <= 3020; seed++) {
          const run = trainWithExpectedProgramLoss(seed, task, {...defaultDiscreteTrainingConfig, adamEpsilon: 1e-8})
          const first = run.hardenedProgram.subarray(0, matrix.firstInstructionCount).indexOf(1)
          const second = run.hardenedProgram.subarray(matrix.firstInstructionCount).indexOf(1)
          if (originalLosses[first * matrix.secondInstructionCount + second] === 0) {
            exactOnTrainingGrid++
          }
        }
        report('loss scaling', {task, multiplier, exactOnTrainingGrid, total: 20})
      }
    } finally {
      matrix.losses.set(originalLosses)
    }
  }
}

function probeMultiplicationGradient() {
  for (const [left, right] of [[0, 1], [1, 0]] as const) {
    const circuit = new Circuit(2)
    const output = emitMultiply(circuit, left, right)
    const source = new Float32Array([3, 0])
    const values = circuit.evaluateReference(source)
    const outputGradients = new Float32Array(values.length)
    outputGradients[output] = 1
    const gradients = circuit.backpropagateReference(values, outputGradients)
    const step = 2 ** -10
    source[1] = step
    const upper = circuit.evaluateReference(source)[output]!
    source[1] = -step
    const lower = circuit.evaluateReference(source)[output]!
    report('multiply at zero', {
      operandOrder: [left, right],
      derivativeSecondInput: gradients[1],
      finiteDifferenceSecondInput: (upper - lower) / (2 * step),
    })
  }
}

function probeCompiler() {
  const sourceText = 'function example(x) { if (true) { return x + 1 } return x + 2 }'
  const result = compileFunctionFromSource(sourceText, 'example', {
    inputs: {x: {minimum: 0, maximum: 10}},
  })
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostic))
  const {program} = result
  const source = new Float32Array(program.circuit.sourceSize)
  source[program.oneWire] = 1
  source[program.inputs[0]!.wire] = 2
  const values = program.circuit.evaluateReference(source)
  const output = program.outputs[0]!.num
  const comparison = runEquivalence(
    program,
    result.sourceFile,
    functionTrialRunner(result.declaration, 'example'),
    {trials: 1, seed: 1, generateInputs: () => new Map([['x', 2]])},
  )
  // Execute the same literal source natively to avoid sharing interpreter semantics.
  // oxlint-disable-next-line typescript/no-implied-eval
  const nativeExample = new Function(`${sourceText}; return example(2)`) as () => number
  report('early return', {
    native: nativeExample(),
    compiled: output.kind === 'constant' ? output.value : values[output.wire],
    harnessMismatches: comparison.mismatches.length,
    harnessDrift: comparison.drift.maxAbsoluteDrift,
  })

  const x = 1 - 2 ** -24
  const y = 2 ** -25
  const floor = compileFunctionFromSource(
    'function example(x, y) { return Math.floor(x + y) }',
    'example',
    {inputs: {x: {minimum: 0, maximum: x}, y: {minimum: 0, maximum: y}}},
  )
  if (!floor.ok) throw new Error(JSON.stringify(floor.diagnostic))
  report('rounded range', {
    compiledOutput: floor.program.outputs[0]!.num,
    expectedFP32: Math.floor(Math.fround(x + y)),
  })
}

function probeGatherOverflow() {
  const circuit = new Circuit(4)
  circuit.assumeRange(0, 0, 1)
  circuit.assumeRange(1, 0, 1)
  circuit.assumeOneHot([0, 1])
  circuit.assumeRange(2, 5, 5)
  circuit.assumeRange(3, 0, 3.4e38)
  const twice = circuit.reglu([[3, 2]], 0, [], 1)
  const output = circuit.affine([
    [emitMultiply(circuit, 2, 0), 1],
    [emitMultiply(circuit, twice, 1), 1],
  ])
  circuit.tensorProgram = circuit.compileTensorProgram([output])
  const source = new Float32Array([1, 0, 5, 3e38])
  report('gather overflow', {
    range: circuit.ranges[twice],
    reference: String(circuit.evaluateReference(source)[output]),
    tensor: String(circuit.evaluateTensor(source)[output]),
    gatherSlots: circuit.tensorProgram.gatherSlotCount,
  })
}

probeLossScaling()
probeMultiplicationGradient()
probeCompiler()
probeGatherOverflow()
