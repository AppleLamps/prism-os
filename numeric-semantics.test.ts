import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, emitMaximum, emitMinimum, emitMultiply, emitSelect, inlineCircuit} from './numeric-ui-core.ts'

test('explicit rounding survives consumers, duplicate terms, and circuit inlining', () => {
  const circuit = new Circuit(2)
  const sum = circuit.roundAffine([[0, 1], [1, 1]])
  const difference = circuit.affine([[sum, 1], [0, -1]])
  const duplicate = circuit.roundAffine([[0, 1], [0, 1], [0, 1]])
  const parent = new Circuit(2)
  const mapping = inlineCircuit(parent, circuit, [0, 1])
  const source = new Float32Array([16_777_216, 1])
  for (const values of [circuit.evaluateReference(source), circuit.evaluateTensor(source)]) {
    assert.equal(values[difference], 0)
    assert.equal(values[duplicate], Math.fround(Math.fround(source[0]! + source[0]!) + source[0]!))
  }
  assert.equal(parent.evaluateReference(source)[mapping[difference]!], 0)
  assert.equal(parent.evaluateTensor(source)[mapping[difference]!], 0)
})

test('explicit term order survives source permutation during inlining', () => {
  const circuit = new Circuit(3)
  const sum = circuit.roundAffine([[0, 1], [1, 1], [2, 1]])
  const parent = new Circuit(3)
  const mapping = inlineCircuit(parent, circuit, [0, 2, 1])
  const original = new Float32Array([2 ** 24, 1, -(2 ** 24)])
  const permuted = new Float32Array([2 ** 24, -(2 ** 24), 1])
  assert.equal(circuit.evaluateReference(original)[sum], 0)
  assert.equal(parent.evaluateReference(permuted)[mapping[sum]!], 0)
  assert.equal(parent.evaluateTensor(permuted)[mapping[sum]!], 0)
  const reordered = parent.roundAffine([[0, 1], [1, 1], [2, 1]])
  assert.notEqual(reordered, mapping[sum])
  assert.equal(parent.evaluateReference(permuted)[reordered], 1)
})

test('range bounds include rounded endpoints and FP32 overflow', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(0, 0, 1 - 2 ** -24)
  circuit.assumeRange(1, 0, 2 ** -25)
  circuit.assumeRange(2, 0, 3.4e38)
  const sum = circuit.roundAffine([[0, 1], [1, 1]])
  const overflow = circuit.roundAffine([[2, 2]])
  const zero = circuit.roundAffine([], 0)
  const poisoned = circuit.append('reglu', [[overflow, 1]], 0, [[zero, 1]], 0, {preserveRounding: true})
  assert.equal(circuit.ranges[sum]!.maximum, 1)
  assert.equal(circuit.ranges[overflow]!.maximum, Infinity)
  assert.equal(circuit.ranges[poisoned]!.maximum, Infinity)
})

test('overflowing unselected candidates do not lower to gather', () => {
  const circuit = new Circuit(4)
  circuit.assumeOneHot([0, 1])
  circuit.assumeRange(2, 5, 5)
  circuit.assumeRange(3, 0, 3.4e38)
  const twice = circuit.roundAffine([[3, 2]])
  const output = circuit.affine([[emitMultiply(circuit, 2, 0), 1], [emitMultiply(circuit, twice, 1), 1]])
  circuit.tensorProgram = circuit.compileTensorProgram([output])
  assert.equal(circuit.tensorProgram.gatherSlotCount, 0)
  const source = new Float32Array([1, 0, 5, 3e38])
  assert.ok(Number.isNaN(circuit.evaluateReference(source)[output]))
  assert.ok(Number.isNaN(circuit.evaluateTensor(source)[output]))
})

test('min and max ranges describe their arithmetic, not mathematical bounds', () => {
  for (const emit of [emitMinimum, emitMaximum]) {
    const circuit = new Circuit(5)
    circuit.assumeOneHot([0, 1])
    circuit.assumeRange(2, 5, 5)
    circuit.assumeRange(3, -3.4e38, 3.4e38)
    circuit.assumeRange(4, -3.4e38, 3.4e38)
    const extreme = emit(circuit, 3, 4)
    const output = circuit.roundAffine([[circuit.multiply(2, 0), 1], [circuit.multiply(extreme, 1), 1]])
    circuit.tensorProgram = circuit.compileTensorProgram([output])
    assert.equal(circuit.tensorProgram.gatherSlotCount, 0)
    const source = new Float32Array([1, 0, 5, 3e38, -3e38])
    assert.ok(Number.isNaN(circuit.evaluateReference(source)[output]))
    assert.ok(Number.isNaN(circuit.evaluateTensor(source)[output]))
  }
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 1, 1)
  circuit.assumeRange(1, 2 ** -25, 2 ** -25)
  const minimum = emitMinimum(circuit, 0, 1)
  const value = circuit.evaluateReference(new Float32Array([1, 2 ** -25]))[minimum]!
  assert.equal(value, 0)
  assert.ok(circuit.ranges[minimum]!.minimum <= value)
})

test('the weaker min and max bounds hold across unit-interval FP32 values', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 1)
  circuit.assumeRange(1, 0, 1)
  const minimum = emitMinimum(circuit, 0, 1)
  const maximum = emitMaximum(circuit, 0, 1)
  const words = new Uint32Array(2)
  const source = new Float32Array(words.buffer)
  const edges = [0, 1, 0x007fffff, 0x00800000, 0x33000000, 0x3effffff, 0x3f000000, 0x3f000001, 0x3f7fffff, 0x3f800000]
  function check() {
    const values = circuit.evaluateReference(source)
    for (const wire of [minimum, maximum]) {
      assert.ok(values[wire]! >= circuit.ranges[wire]!.minimum)
      assert.ok(values[wire]! <= circuit.ranges[wire]!.maximum)
    }
  }
  for (const left of edges) for (const right of edges) {
    words.set([left, right])
    check()
  }
  let seed = 317
  for (let sample = 0; sample < 5_000; sample++) {
    for (let index = 0; index < 2; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      words[index] = seed % 0x3f800001
    }
    check()
  }
})

test('whole multiplication has the correct derivative at zero in either order', () => {
  for (const nonnegative of [false, true]) {
    for (const [left, right] of [[0, 1], [1, 0]] as const) {
      const circuit = new Circuit(2)
      if (nonnegative) circuit.assumeRange(1, 0, 1)
      const product = emitMultiply(circuit, left, right)
      const output = circuit.affine([[product, 2]])
      const values = circuit.evaluateReference(new Float32Array([3, 0]))
      const seeds = new Float32Array(values.length)
      seeds[output] = 1
      const gradients = circuit.backpropagateReference(values, seeds)
      assert.equal(gradients[1], 6)
      assert.equal(gradients[0], 0)
      const parent = new Circuit(2)
      const map = inlineCircuit(parent, circuit, [0, 1])
      const parentValues = parent.evaluateReference(new Float32Array([3, 0]))
      const parentSeeds = new Float32Array(parentValues.length)
      parentSeeds[map[output]!] = 1
      assert.equal(parent.backpropagateReference(parentValues, parentSeeds)[1], 6)
    }
  }
})

test('selection preserves finite extreme operands and its intended derivative', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(0, 0, 1)
  const output = emitSelect(circuit, 0, 1, 2)
  for (const gate of [0, 1]) {
    const source = new Float32Array([gate, 3e38, -3e38])
    assert.equal(circuit.evaluateReference(source)[output], source[gate === 0 ? 1 : 2])
    assert.equal(circuit.evaluateTensor(source)[output], source[gate === 0 ? 1 : 2])
  }
  const values = circuit.evaluateReference(new Float32Array([0.25, 3, 7]))
  const seeds = new Float32Array(values.length)
  seeds[output] = 1
  assert.deepEqual([...circuit.backpropagateReference(values, seeds).subarray(0, 3)], [4, 0.75, 0.25])
})

test('boolean surrogate derivatives must be requested explicitly', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 1)
  const output = circuit.boolean(0)
  const values = circuit.evaluateReference(new Float32Array([0.25]))
  const seeds = new Float32Array(values.length)
  seeds[output] = 1
  assert.throws(() => circuit.backpropagateReference(values, seeds), /boolean atom/)
  assert.equal(circuit.backpropagateReference(values, seeds, {booleanGradient: 'straight-through'})[0], 1)
})

test('reusable tensor evaluation returns only roots and refreshes every call', () => {
  const circuit = new Circuit(4)
  circuit.assumeOneHot([0, 1], true)
  circuit.assumeRange(2, -100, 100)
  circuit.assumeRange(3, -100, 100)
  const picked = circuit.affine([[circuit.multiply(0, 2), 1], [circuit.multiply(1, 3), 1]])
  const run = circuit.createTensorEvaluator([picked, 2, picked])
  const first = run(new Float32Array([1, 0, 7, -3]))
  assert.deepEqual([...first], [7, 7, 7])
  const second = run(new Float32Array([0, 1, 9, -5]))
  assert.equal(first, second)
  assert.deepEqual([...second], [-5, 9, -5])
  assert.deepEqual([...run(new Float32Array([0, 0, 9, -5]))], [0, 9, 0])
  assert.throws(() => run(new Float32Array(3)), /wrong length/)
})
