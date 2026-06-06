import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from './numeric-ui-core.ts'

test('tensor layers append only their new values', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[0, 2]])
  circuit.affine([[first, 4]])
  circuit.affine([[1, 3]])
  const program = circuit.compileTensorProgram()

  assert.deepEqual(
    program.layers.map(layer => ({
      inputSize: layer.inputSize,
      outputSize: layer.leftBias.length,
      matrixSize: layer.leftWeights.length,
    })),
    [
      {inputSize: 2, outputSize: 3, matrixSize: 6},
    ],
  )
  assert.deepEqual([...program.wireOrder], [0, 1, 2, 3, 4])
  assert.deepEqual([...circuit.evaluateTensor(new Float64Array([5, 7]))], [5, 7, 10, 40, 21])
})

test('tensor and readable evaluators both reject a wrong-sized source table', () => {
  const circuit = new Circuit(2)
  circuit.affine([[0, 1], [1, 1]])

  for (const source of [
    new Float64Array([7]),
    new Float64Array([7, 8, 9]),
  ]) {
    assert.throws(
      () => circuit.evaluateTensor(source),
      /source table has the wrong length/,
    )
    assert.throws(
      () => circuit.evaluateReadable(source),
      /source table has the wrong length/,
    )
  }
})

test('weighted sums normalize duplicate, zero, and unordered terms', () => {
  const circuit = new Circuit(3)
  circuit.affine([
    [2, 0],
    [1, 4],
    [0, 3],
    [1, -1],
    [0, -3],
    [2, 5],
  ], 7)

  assert.deepEqual(circuit.operations[0]!.leftTerms, [[1, 3], [2, 5]])
  assert.equal(circuit.evaluateTensor(new Float64Array([11, 13, 17]))[3], 131)
})

test('constant terms and constant gates fold before compilation', () => {
  const circuit = new Circuit(1)
  const three = circuit.affine([], 3)
  circuit.affine([[0, 4], [three, 2]], 1)
  circuit.reglu([[0, 2]], 5, [[three, 1]], -1)
  circuit.reglu([[0, 7]], 11, [[three, -1]], 2)

  assert.deepEqual(circuit.operations.map(operation => ({
    kind: operation.kind,
    leftTerms: operation.leftTerms,
    leftBias: operation.leftBias,
  })), [
    {kind: 'affine', leftTerms: [], leftBias: 3},
    {kind: 'affine', leftTerms: [[0, 4]], leftBias: 7},
    {kind: 'affine', leftTerms: [[0, 4]], leftBias: 10},
    {kind: 'affine', leftTerms: [], leftBias: 0},
  ])
  assert.deepEqual(
    [...circuit.evaluateTensor(new Float64Array([13]))].slice(1),
    [3, 59, 62, 0],
  )
})

test('identity affine operations return an alias without allocating a wire', () => {
  const circuit = new Circuit(2)
  const alias = circuit.affine([[1, 1]])

  assert.equal(alias, 1)
  assert.equal(circuit.operations.length, 0)
  assert.equal(circuit.compileTensorProgram().width, 2)
})

test('affine forms compose through affine producers', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[0, 2], [1, -1]], 3)
  const second = circuit.affine([[first, 4], [1, 5]], -2)
  circuit.reglu([[second, 2]], 1, [[first, -3]], 7)

  assert.deepEqual(circuit.operations[1], {
    kind: 'affine',
    leftTerms: [[0, 8], [1, 1]],
    leftBias: 10,
    gateTerms: [],
    gateBias: 0,
    depth: 1,
  })
  assert.deepEqual(circuit.operations[2]!.leftTerms, [[0, 16], [1, 2]])
  assert.deepEqual(circuit.operations[2]!.gateTerms, [[0, -6], [1, 3]])
})

test('identical normalized expressions share one wire', () => {
  const circuit = new Circuit(2)
  const firstAffine = circuit.affine([[1, 3], [0, 2]], 4)
  const secondAffine = circuit.affine([[0, 1], [1, 3], [0, 1]], 4)
  const firstReglu = circuit.reglu([[firstAffine, 2]], 1, [[1, -1]], 3)
  const secondReglu = circuit.reglu([[secondAffine, 2]], 1, [[1, -1]], 3)

  assert.equal(secondAffine, firstAffine)
  assert.equal(secondReglu, firstReglu)
  assert.equal(circuit.operations.length, 2)
})

test('tensor roots remove operations that cannot affect an output', () => {
  const circuit = new Circuit(2)
  const liveDependency = circuit.reglu([[0, 2]], 0, [[1, 1]], 0)
  const liveOutput = circuit.affine([[liveDependency, 1]], 3)
  circuit.reglu([[0, 7]], 11, [[1, -2]], 5)
  const program = circuit.compileTensorProgram([liveOutput])

  assert.equal(program.width, 5)
  assert.equal(program.valueCount, 4)
  assert.deepEqual([...program.wireOrder], [0, 1, liveDependency, liveOutput])
  assert.equal(evaluateOutput(circuit, program, [13, 17], liveOutput), 445)
})

test('tensor layers gather only the values they read', () => {
  const circuit = new Circuit(2)
  const first = circuit.reglu([[0, 1]], 0, [[1, 1]], 0)
  const second = circuit.reglu([[first, 2]], 1, [[first, -1]], 5)
  const program = circuit.compileTensorProgram([second])

  assert.deepEqual(program.layers.map(layer => ({
    inputIndices: [...layer.inputIndices],
    inputSize: layer.inputSize,
    outputSize: layer.leftBias.length,
  })), [
    {inputIndices: [0, 1], inputSize: 2, outputSize: 1},
    {inputIndices: [2], inputSize: 1, outputSize: 1},
  ])
})

function evaluateOutput(
  circuit: Circuit,
  program: ReturnType<Circuit['compileTensorProgram']>,
  source: number[],
  wire: number,
) {
  circuit.tensorProgram = program
  return circuit.evaluateTensor(Float64Array.from(source))[wire]
}
