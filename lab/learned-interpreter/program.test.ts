import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createCertificationCases,
  createIntegerCertificationCases,
  coordinateOracle,
  primitiveTasks,
  taskOracle,
  twoAddOracle,
} from './oracle.ts'
import {
  buildProgram,
  decodeProgram,
  encodeCoordinateProgram,
  encodePrimitiveProgram,
  encodeTwoAddProgram,
  executeDecodedProgram,
  writeInputs,
  writeProgram,
} from './program.ts'
import {searchProgramSpace} from './search.ts'
import {verifyProgram} from './training.ts'

test('certification includes integer holdouts, fractional cancellation, and input rounding', () => {
  const cases = createCertificationCases()
  assert.equal(cases.length, 39_605)
  assert.equal(cases.filter(item => item.family === 'unseen').length, 12_288)
  assert.equal(cases.filter(item => item.family === 'extrapolation').length, 324)
  assert.equal(cases.filter(item => item.family === 'translation').length, 24_576)
  assert.equal(cases.filter(item => item.family === 'fractional').length, 2_401)
  assert.equal(cases.filter(item => item.family === 'input-rounding').length, 16)
})

test('oracles round incoming JS numbers before arithmetic, like the source table', () => {
  const inputs = {pointerX: 1 + 2 ** -24, panelLeft: 1, scale: 1, distractor: -1}
  assert.equal(coordinateOracle(inputs), 0)
  assert.equal(twoAddOracle(inputs, 'distractor'), 1)
  assert.equal(taskOracle({kind: 'primitive', operation: 'subtract', left: 'pointerX', right: 'panelLeft'}, inputs), 0)
  assert.equal(executeDecodedProgram([
    {operation: 'add', left: 'pointerX', right: 'panelLeft'},
    {operation: 'subtract', left: 'instruction0', right: 'pointerX'},
  ], {...inputs, distractor: 1 + 2 ** -24}, 'removed'), 0)
})

test('the soft interpreter is a fixed affine and ReGLU circuit with 123 program cells', () => {
  const build = buildProgram(2, 'soft')
  const kinds = build.circuit.operations.map(operation => operation.kind)
  assert.equal(build.layout.programCellCount, 123)
  assert.deepEqual(
    build.layout.instructionGroups.map(group => group.candidates.length),
    [48, 75],
  )
  assert.equal(build.circuit.sourceSize, 127)
  assert.ok(kinds.includes('affine'))
  assert.ok(kinds.includes('reglu'))
  assert.ok(kinds.every(kind => kind === 'affine' || kind === 'reglu'))
  assert.ok(build.circuit.tensorProgram!.layers.length > 0)
})

test('the authored coordinate program is exact through both evaluators', () => {
  const cases = createCertificationCases()
  const build = buildProgram(2, 'hard')
  const program = encodeCoordinateProgram(build.layout)
  const verification = verifyProgram(program, {kind: 'coordinate'}, cases)
  assert.deepEqual(verification, {
    caseCount: 39_605,
    referenceMismatches: 0,
    tensorMismatches: 0,
    mismatchesByFamily: {unseen: 0, extrapolation: 0, translation: 0, fractional: 0, 'input-rounding': 0},
    maximumAbsoluteError: 0,
  })
})

test('the authored two-add program is exact through both evaluators', () => {
  const cases = createCertificationCases()
  for (const thirdAddend of ['scale', 'distractor'] as const) {
    const build = buildProgram(2, 'hard')
    const program = encodeTwoAddProgram(build.layout, thirdAddend)
    const verification = verifyProgram(
      program,
      {kind: 'two-add', thirdAddend},
      cases,
    )
    assert.equal(verification.referenceMismatches, 0)
    assert.equal(verification.tensorMismatches, 0)
  }
})

test('enumeration finds the two coordinate programs on integer and fractional holdouts', () => {
  const result = searchProgramSpace(createCertificationCases())
  assert.equal(result.candidateProgramCount, 3_600)
  assert.equal(result.exactPrograms.length, 2)
  assert.deepEqual(result.exactPrograms, [
    [
      {operation: 'subtract', left: 'pointerX', right: 'panelLeft'},
      {operation: 'multiply', left: 'scale', right: 'instruction0'},
    ],
    [
      {operation: 'subtract', left: 'pointerX', right: 'panelLeft'},
      {operation: 'multiply', left: 'instruction0', right: 'scale'},
    ],
  ])
  assert.deepEqual(result.bestOneInstruction, {
    operation: 'subtract',
    left: 'pointerX',
    right: 'panelLeft',
  })
  assert.ok(result.bestOneInstructionMismatches > 23_310)
})

test('two-add reassociations pass integers but fail the specified FP32 grouping', () => {
  for (const thirdAddend of ['scale', 'distractor'] as const) {
    const task = {kind: 'two-add', thirdAddend} as const
    const integerResult = searchProgramSpace(createIntegerCertificationCases(), task)
    assert.equal(integerResult.candidateProgramCount, 3_600)
    assert.equal(integerResult.exactPrograms.length, 12)
    const fullResult = searchProgramSpace(createCertificationCases(), task)
    assert.equal(fullResult.exactPrograms.length, 4)
    for (const program of fullResult.exactPrograms) {
      assert.equal(program[0]!.operation, 'add')
      assert.deepEqual([program[0]!.left, program[0]!.right].sort(), ['panelLeft', 'pointerX'])
      assert.equal(program[1]!.operation, 'add')
      assert.deepEqual([program[1]!.left, program[1]!.right].sort(), ['instruction0', thirdAddend].sort())
    }
  }
  const inputs = {pointerX: 1, panelLeft: 2 ** -24, scale: 1, distractor: -1}
  const reassociated = executeDecodedProgram([
    {operation: 'add', left: 'panelLeft', right: 'distractor'},
    {operation: 'add', left: 'instruction0', right: 'pointerX'},
  ], inputs)
  assert.equal(twoAddOracle(inputs, 'distractor'), 0)
  assert.equal(reassociated, 2 ** -24)
})

test('the three authored primitive controls are exact', () => {
  const cases = createCertificationCases()
  for (const task of primitiveTasks) {
    const build = buildProgram(1, 'hard')
    const program = encodePrimitiveProgram(build.layout, task.operation, task.left, task.right)
    const verification = verifyProgram(program, task, cases)
    assert.equal(verification.referenceMismatches, 0)
    assert.equal(verification.tensorMismatches, 0)
  }
})

test('every hard instruction pair preserves FP32 steps on fractional probes', () => {
  const build = buildProgram(2, 'hard')
  const source = new Float32Array(build.layout.sourceSize)
  const program = new Float32Array(build.layout.programCellCount)
  const firstGroup = build.layout.instructionGroups[0]!
  const secondGroup = build.layout.instructionGroups[1]!
  const probes = [
    {pointerX: 1, panelLeft: 2 ** -24, scale: 1, distractor: -1},
    {pointerX: 63.75, panelLeft: -1, scale: 2 ** -24, distractor: -63.75},
    {pointerX: 2 ** -149, panelLeft: -(2 ** -149), scale: 1, distractor: 0},
    {pointerX: 1 + 2 ** -24, panelLeft: 1, scale: 1 + 3 * 2 ** -24, distractor: -1},
  ]
  for (let first = 0; first < firstGroup.candidates.length; first++) {
    for (let second = 0; second < secondGroup.candidates.length; second++) {
      program.fill(0)
      program[firstGroup.parameterOffset + first] = 1
      program[secondGroup.parameterOffset + second] = 1
      const instructions = decodeProgram(build.layout, program)
      writeProgram(source, build.layout, program)
      for (const inputs of probes) {
        writeInputs(source, build.layout, inputs)
        const expected = executeDecodedProgram(instructions, inputs)
        const reference = build.circuit.evaluateReference(source)[build.outputWire]!
        const tensor = build.circuit.evaluateTensor(source)[build.outputWire]!
        assert.ok(reference === expected, JSON.stringify({instructions, inputs, expected, reference}))
        assert.ok(tensor === expected, JSON.stringify({instructions, inputs, expected, tensor}))
      }
    }
  }
})
