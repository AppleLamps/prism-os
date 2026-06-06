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
      {inputSize: 2, outputSize: 2, matrixSize: 4},
      {inputSize: 4, outputSize: 1, matrixSize: 4},
    ],
  )
  assert.deepEqual([...program.wireOrder], [0, 1, 2, 4, 3])
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
