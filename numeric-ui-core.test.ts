import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from './numeric-ui-core.ts'

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
