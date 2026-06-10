import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitSpring,
  type Wire,
  validateTensorEvaluation,
} from './numeric-ui-core.ts'

function evaluate(circuit: Circuit, sourceValues: number[]): Float32Array {
  const source = Float32Array.from(sourceValues)
  const tensor = circuit.evaluateTensor(source)
  validateTensorEvaluation(source, circuit, tensor)
  return tensor
}

function read(values: Float32Array, wires: Wire[]): number[] {
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

test('proven nonnegative multiplication lowers to one ReGLU', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(1, 0, Number.POSITIVE_INFINITY)
  const multiplied = emitMultiply(circuit, 0, 1)

  assert.equal(circuit.operations.length, 1)
  assert.equal(circuit.operations[0]!.kind, 'reglu')
  assert.equal(evaluate(circuit, [-3, 2])[multiplied], -6)
  assert.throws(
    () => circuit.evaluateTensor(new Float32Array([-3, -2])),
    /outside its assumed range/,
  )
})

test('four spring steps match ordinary math', () => {
  const circuit = new Circuit(5)
  const [positionSource, destination, velocitySource, stiffness, timestep] = [0, 1, 2, 3, 4]
  const damping = constant(circuit, 30)
  const zero = constant(circuit, 0)
  const unit = constant(circuit, 1)
  const spring = emitSpring(
    circuit,
    positionSource,
    destination,
    velocitySource,
    stiffness,
    damping,
    timestep,
    zero,
    zero,
    unit,
    unit,
    unit,
  )

  let expectedPosition = 10
  let expectedVelocity = -3
  for (let step = 0; step < 4; step++) {
    const force = -290 * (expectedPosition - 20) - 30 * expectedVelocity
    expectedVelocity += force * 0.004
    expectedPosition += expectedVelocity * 0.004
  }

  const values = evaluate(circuit, [10, 20, -3, 290, 0.004])
  assert.ok(Math.abs(values[spring.position]! - expectedPosition) < 1e-4)
  assert.ok(Math.abs(values[spring.velocity]! - expectedVelocity) < 1e-4)
  assert.equal(values[spring.active], 1)
})
