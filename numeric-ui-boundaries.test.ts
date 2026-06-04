import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  emitAnd,
  emitEqualForInteger,
  emitGreaterThanForInteger,
  emitGreaterThanOrEqualForInteger,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitSelect,
  type Wire,
  validateTensorEvaluation,
} from './numeric-ui-core.ts'

type Rectangle = {
  left: Wire
  top: Wire
  right: Wire
  bottom: Wire
}

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

function rectangle(circuit: Circuit, left: number, top: number, right: number, bottom: number): Rectangle {
  return {
    left: constant(circuit, left),
    top: constant(circuit, top),
    right: constant(circuit, right),
    bottom: constant(circuit, bottom),
  }
}

function emitRectangleHit(circuit: Circuit, pointerX: Wire, pointerY: Wire, box: Rectangle): Wire {
  return emitAnd(circuit, [
    emitGreaterThanOrEqualForInteger(circuit, pointerX, box.left),
    emitGreaterThanForInteger(circuit, box.right, pointerX),
    emitGreaterThanOrEqualForInteger(circuit, pointerY, box.top),
    emitGreaterThanForInteger(circuit, box.bottom, pointerY),
  ])
}

test('integer comparisons change exactly at equality', () => {
  const circuit = new Circuit(2)
  const greaterThanOrEqual = emitGreaterThanOrEqualForInteger(circuit, 0, 1)
  const greaterThan = emitGreaterThanForInteger(circuit, 0, 1)
  const equal = emitEqualForInteger(circuit, 0, 1)

  const cases: [source: number[], expected: number[]][] = [
    [[4, 5], [0, 0, 0]],
    [[5, 5], [1, 0, 1]],
    [[6, 5], [1, 1, 0]],
    [[-1, -1], [1, 0, 1]],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(read(evaluate(circuit, source), [greaterThanOrEqual, greaterThan, equal]), expected)
  }
})

test('gated and signed math stay exact around zero', () => {
  const circuit = new Circuit(3)
  const gated = circuit.reglu([[0, 1]], 0, [[1, 1]], 0)
  const multiplied = emitMultiply(circuit, 0, 1)
  const minimum = emitMinimum(circuit, 0, 1)
  const maximum = emitMaximum(circuit, 0, 1)
  const selected = emitSelect(circuit, 2, 0, 1)

  const cases: [source: number[], expected: number[]][] = [
    [[7, -2, 0], [0, -14, -2, 7, -2]],
    [[7, 0, 1], [0, 0, 0, 7, 7]],
    [[-3, 2, 0], [-6, -6, -3, 2, 2]],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(read(evaluate(circuit, source), [gated, multiplied, minimum, maximum, selected]), expected)
  }
})

test('rectangle hit boxes include top-left and exclude bottom-right', () => {
  const circuit = new Circuit(2)
  const hit = emitRectangleHit(circuit, 0, 1, rectangle(circuit, 10, 20, 30, 40))

  const cases: [source: number[], expected: number][] = [
    [[10, 20], 1],
    [[29, 39], 1],
    [[30, 20], 0],
    [[10, 40], 0],
    [[9, 20], 0],
    [[10, 19], 0],
  ]
  for (const [source, expected] of cases) {
    assert.equal(evaluate(circuit, source)[hit], expected)
  }
})

test('the higher rectangle wins when hit boxes overlap', () => {
  const circuit = new Circuit(2)
  const lowerHit = emitRectangleHit(circuit, 0, 1, rectangle(circuit, 0, 0, 20, 20))
  const higherHit = emitRectangleHit(circuit, 0, 1, rectangle(circuit, 10, 10, 30, 30))
  const lowerWins = emitAnd(circuit, [lowerHit, circuit.affine([[higherHit, -1]], 1)])
  const higherWins = higherHit

  const cases: [source: number[], expected: number[]][] = [
    [[5, 5], [1, 0]],
    [[15, 15], [0, 1]],
    [[25, 25], [0, 1]],
    [[30, 30], [0, 0]],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(read(evaluate(circuit, source), [lowerWins, higherWins]), expected)
  }
})

test('column count changes only at the exact width breakpoints', () => {
  const circuit = new Circuit(3)
  const columnCountTerms: [Wire, number][] = []
  for (let columns = 2; columns <= 3; columns++) {
    const threshold = circuit.affine([
      [1, columns],
      [2, columns + 1],
    ])
    columnCountTerms.push([emitGreaterThanOrEqualForInteger(circuit, 0, threshold), 1])
  }
  const columnCount = circuit.affine(columnCountTerms, 1)

  const cases: [width: number, expected: number][] = [
    [371, 1],
    [372, 2],
    [545, 2],
    [546, 3],
  ]
  for (const [width, expected] of cases) {
    assert.equal(evaluate(circuit, [width, 150, 24])[columnCount], expected)
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
