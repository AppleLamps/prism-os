import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from './numeric-ui-core.ts'
import {createRectangleMachine, itemCount, rectangleField} from './numeric-ui-rectangles.ts'

test('odd viewport clicks no longer produce an invalid scalar focus id', () => {
  const machine = createRectangleMachine()
  machine.click(652, 30)

  assert.doesNotThrow(() => machine.step(1281, 720))
})

test('tiny viewports no longer produce negative geometry', () => {
  const machine = createRectangleMachine()

  const values = machine.step(40, 40)
  for (let item = 0; item < itemCount; item++) {
    const outputStart = machine.output.rectangleStart + item * rectangleField.size
    assert.ok(values[outputStart + rectangleField.width]! >= 0)
    assert.ok(values[outputStart + rectangleField.height]! >= 0)
  }
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
