import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  type Wire,
  validateTensorEvaluation,
} from './numeric-ui-core.ts'

function evaluate(circuit: Circuit, sourceValues: number[]): Float64Array {
  const source = Float64Array.from(sourceValues)
  const tensor = circuit.evaluateTensor(source)
  validateTensorEvaluation(source, circuit, tensor)
  return tensor
}

function read(values: Float64Array, wires: Wire[]): number[] {
  return wires.map(wire => values[wire]!)
}

function constant(circuit: Circuit, value: number): Wire {
  return circuit.affine([], value)
}

test('gated and signed math stay exact around zero', () => {
  const circuit = new Circuit(2)
  const gated = circuit.reglu([[0, 1]], 0, [[1, 1]], 0)
  const multiplied = emitMultiply(circuit, 0, 1)
  const minimum = emitMinimum(circuit, 0, 1)
  const maximum = emitMaximum(circuit, 0, 1)

  const cases: [source: number[], expected: number[]][] = [
    [[7, -2], [0, -14, -2, 7]],
    [[7, 0], [0, 0, 0, 7]],
    [[-3, 2], [-6, -6, -3, 2]],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(read(evaluate(circuit, source), [gated, multiplied, minimum, maximum]), expected)
  }
})

test('four spring steps match ordinary math', () => {
  const circuit = new Circuit(5)
  const [positionSource, destination, velocitySource, stiffness, timestep] = [0, 1, 2, 3, 4]
  const damping = constant(circuit, 30)
  let position = positionSource
  let velocity = velocitySource

  for (let step = 0; step < 4; step++) {
    const displacement = circuit.affine([[position, 1], [destination, -1]])
    const springForce = emitMultiply(circuit, circuit.affine([[stiffness, -1]]), displacement)
    const dampingForce = emitMultiply(circuit, circuit.affine([[damping, -1]]), velocity)
    velocity = circuit.affine([
      [velocity, 1],
      [emitMultiply(circuit, circuit.affine([[springForce, 1], [dampingForce, 1]]), timestep), 1],
    ])
    position = circuit.affine([
      [position, 1],
      [emitMultiply(circuit, velocity, timestep), 1],
    ])
  }

  let expectedPosition = 10
  let expectedVelocity = -3
  for (let step = 0; step < 4; step++) {
    const force = -290 * (expectedPosition - 20) - 30 * expectedVelocity
    expectedVelocity += force * 0.004
    expectedPosition += expectedVelocity * 0.004
  }

  const values = evaluate(circuit, [10, 20, -3, 290, 0.004])
  assert.ok(Math.abs(values[position]! - expectedPosition) < 1e-12)
  assert.ok(Math.abs(values[velocity]! - expectedVelocity) < 1e-12)
})
