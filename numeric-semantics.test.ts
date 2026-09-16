import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, asWire, emitCompare, emitMaximum, emitMinimum, emitMultiply, emitSelect, inlineCircuit, validateNoNaN} from './numeric-ui-core.ts'

test('explicit rounding survives consumers, duplicate terms, and circuit inlining', () => {
  const circuit = new Circuit(2)
  const sum = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), 1]])
  const difference = circuit.affine([[sum, 1], [circuit.source(0), -1]])
  const duplicate = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(0), 1], [circuit.source(0), 1]])
  const parent = new Circuit(2)
  const mapping = inlineCircuit(parent, circuit, [parent.source(0), parent.source(1)])
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
  const sum = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), 1], [circuit.source(2), 1]])
  const parent = new Circuit(3)
  const mapping = inlineCircuit(parent, circuit, [parent.source(0), parent.source(2), parent.source(1)])
  const original = new Float32Array([2 ** 24, 1, -(2 ** 24)])
  const permuted = new Float32Array([2 ** 24, -(2 ** 24), 1])
  assert.equal(circuit.evaluateReference(original)[sum], 0)
  assert.equal(parent.evaluateReference(permuted)[mapping[sum]!], 0)
  assert.equal(parent.evaluateTensor(permuted)[mapping[sum]!], 0)
  const reordered = parent.roundAffine([[parent.source(0), 1], [parent.source(1), 1], [parent.source(2), 1]])
  assert.notEqual(reordered, mapping[sum])
  assert.equal(parent.evaluateReference(permuted)[reordered], 1)
})

test('range bounds include rounded endpoints and FP32 overflow', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(circuit.source(0), 0, 1 - 2 ** -24)
  circuit.assumeRange(circuit.source(1), 0, 2 ** -25)
  circuit.assumeRange(circuit.source(2), 0, 3.4e38)
  const sum = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), 1]])
  const overflow = circuit.roundAffine([[circuit.source(2), 2]])
  const zero = circuit.roundAffine([], 0)
  const poisoned = circuit.append('reglu', [[overflow, 1]], 0, [[zero, 1]], 0, {preserveRounding: true})
  assert.equal(circuit.ranges[sum]!.maximum, 1)
  assert.equal(circuit.ranges[overflow]!.maximum, Infinity)
  assert.equal(circuit.ranges[poisoned]!.maximum, Infinity)
})

test('overflowing unselected candidates do not lower to gather', () => {
  const circuit = new Circuit(4)
  circuit.assumeOneHot([circuit.source(0), circuit.source(1)])
  circuit.assumeRange(circuit.source(2), 5, 5)
  circuit.assumeRange(circuit.source(3), 0, 3.4e38)
  const twice = circuit.roundAffine([[circuit.source(3), 2]])
  const output = circuit.affine([[emitMultiply(circuit, circuit.source(2), circuit.source(0)), 1], [emitMultiply(circuit, twice, circuit.source(1)), 1]])
  circuit.tensorProgram = circuit.compileTensorProgram([output])
  assert.equal(circuit.tensorProgram.gatherSlotCount, 0)
  const source = new Float32Array([1, 0, 5, 3e38])
  assert.ok(Number.isNaN(circuit.evaluateReference(source)[output]))
  assert.ok(Number.isNaN(circuit.evaluateTensor(source)[output]))
})

test('min and max ranges describe their arithmetic, not mathematical bounds', () => {
  for (const emit of [emitMinimum, emitMaximum]) {
    const circuit = new Circuit(5)
    circuit.assumeOneHot([circuit.source(0), circuit.source(1)])
    circuit.assumeRange(circuit.source(2), 5, 5)
    circuit.assumeRange(circuit.source(3), -3.4e38, 3.4e38)
    circuit.assumeRange(circuit.source(4), -3.4e38, 3.4e38)
    const extreme = emit(circuit, circuit.source(3), circuit.source(4))
    const output = circuit.roundAffine([[circuit.multiply(circuit.source(2), circuit.source(0)), 1], [circuit.multiply(extreme, circuit.source(1)), 1]])
    circuit.tensorProgram = circuit.compileTensorProgram([output])
    assert.equal(circuit.tensorProgram.gatherSlotCount, 0)
    const source = new Float32Array([1, 0, 5, 3e38, -3e38])
    assert.ok(Number.isNaN(circuit.evaluateReference(source)[output]))
    assert.ok(Number.isNaN(circuit.evaluateTensor(source)[output]))
  }
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), 1, 1)
  circuit.assumeRange(circuit.source(1), 2 ** -25, 2 ** -25)
  const minimum = emitMinimum(circuit, circuit.source(0), circuit.source(1))
  const value = circuit.evaluateReference(new Float32Array([1, 2 ** -25]))[minimum]!
  assert.equal(value, 0)
  assert.ok(circuit.ranges[minimum]!.minimum <= value)
})

test('the weaker min and max bounds hold across unit-interval FP32 values', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), 0, 1)
  circuit.assumeRange(circuit.source(1), 0, 1)
  const minimum = emitMinimum(circuit, circuit.source(0), circuit.source(1))
  const maximum = emitMaximum(circuit, circuit.source(0), circuit.source(1))
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
      if (nonnegative) circuit.assumeRange(circuit.source(1), 0, 1)
      const product = emitMultiply(circuit, circuit.source(left), circuit.source(right))
      const output = circuit.affine([[product, 2]])
      const values = circuit.evaluateReference(new Float32Array([3, 0]))
      const seeds = new Float32Array(values.length)
      seeds[output] = 1
      const gradients = circuit.backpropagateReference(values, seeds)
      assert.equal(gradients[1], 6)
      assert.equal(gradients[0], 0)
      const parent = new Circuit(2)
      const map = inlineCircuit(parent, circuit, [parent.source(0), parent.source(1)])
      const parentValues = parent.evaluateReference(new Float32Array([3, 0]))
      const parentSeeds = new Float32Array(parentValues.length)
      parentSeeds[map[output]!] = 1
      assert.equal(parent.backpropagateReference(parentValues, parentSeeds)[1], 6)
    }
  }
})

test('selection preserves finite extreme operands and its intended derivative', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(circuit.source(0), 0, 1)
  const output = emitSelect(circuit, circuit.source(0), circuit.source(1), circuit.source(2))
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
  circuit.assumeRange(circuit.source(0), 0, 1)
  const output = circuit.boolean(circuit.source(0))
  const values = circuit.evaluateReference(new Float32Array([0.25]))
  const seeds = new Float32Array(values.length)
  seeds[output] = 1
  assert.throws(() => circuit.backpropagateReference(values, seeds), /boolean atom/)
  assert.equal(circuit.backpropagateReference(values, seeds, {booleanGradient: 'straight-through'})[0], 1)
})

test('reusable tensor evaluation returns only roots and refreshes every call', () => {
  const circuit = new Circuit(4)
  circuit.assumeOneHot([circuit.source(0), circuit.source(1)], true)
  circuit.assumeRange(circuit.source(2), -100, 100)
  circuit.assumeRange(circuit.source(3), -100, 100)
  const picked = circuit.affine([[circuit.multiply(circuit.source(0), circuit.source(2)), 1], [circuit.multiply(circuit.source(1), circuit.source(3)), 1]])
  const run = circuit.createTensorEvaluator([picked, circuit.source(2), picked])
  const first = run(new Float32Array([1, 0, 7, -3]))
  assert.deepEqual([...first], [7, 7, 7])
  const second = run(new Float32Array([0, 1, 9, -5]))
  assert.equal(first, second)
  assert.deepEqual([...second], [-5, 9, -5])
  assert.deepEqual([...run(new Float32Array([0, 0, 9, -5]))], [0, 9, 0])
  assert.throws(() => run(new Float32Array(3)), /wrong length/)
})

test('source cells, constants and hand-counted positions become wires only through checked helpers', () => {
  const circuit = new Circuit(2)
  assert.equal(circuit.source(1), 1)
  assert.throws(() => circuit.source(2), /outside the source table/)
  assert.throws(() => asWire(-1), /nonnegative integer/)
  assert.throws(() => asWire(0.5), /nonnegative integer/)
  assert.equal(circuit.constant(3), circuit.affine([], 3))
  assert.equal(circuit.constants[circuit.constant(3)], 3)
})

test('a range declared after operations read the wire throws, unless the caller opts in', () => {
  const circuit = new Circuit(2)
  const [velocity, timestep] = [circuit.source(0), circuit.source(1)]
  circuit.assumeRange(velocity, -100, 100)
  const distance = circuit.multiply(velocity, timestep)
  // The product was built for a timestep that may be negative: 3 operations.
  assert.equal(circuit.operations.length, 3)
  assert.throws(() => circuit.assumeRange(timestep, 0, 0.032), /already read wire 1/)
  // Declaring the range it already has, or a wider one, changes nothing and doesn't throw.
  circuit.assumeRange(velocity, -1000, 1000)
  circuit.assumeRange(timestep, 0, 0.032, {allowExistingReaders: true})
  assert.equal(circuit.ranges[timestep]!.minimum, 0)
  assert.equal(circuit.operations[distance - circuit.sourceSize]!.kind, 'affine')
  // A source circuit's declared ranges landing on target wires that already have readers.
  const child = new Circuit(1)
  child.assumeRange(child.source(0), 0, 1)
  const parent = new Circuit(1)
  parent.multiply(parent.source(0), parent.source(0))
  assert.throws(() => inlineCircuit(parent, child, [parent.source(0)]), /already read wire 0/)
  inlineCircuit(parent, child, [parent.source(0)], {allowExistingReaders: true})
  assert.equal(parent.ranges[0]!.maximum, 1)
})

test('a grid declared after operations read the wire throws, unless the caller opts in', () => {
  const circuit = new Circuit(2)
  const [pointerX, windowLeft] = [circuit.source(0), circuit.source(1)]
  circuit.assumeRange(pointerX, 0, 1024)
  circuit.assumeRange(windowLeft, 0, 1024)
  circuit.assumeGrid(windowLeft, 1)
  // pointerX has no grid, so emitCompare builds a sign cascade, and declaring the grid afterwards doesn't turn it into integer bits.
  emitCompare(circuit, pointerX, '>=', windowLeft)
  assert.throws(() => circuit.assumeGrid(pointerX, 1 / 64), /already read wire 0 were built without a grid/)
  // A finer grid than the wire already has changes nothing and doesn't throw.
  circuit.assumeGrid(windowLeft, 1 / 64)
  circuit.assumeGrid(pointerX, 1 / 64, {allowExistingReaders: true})
  assert.equal(circuit.grids[pointerX], 1 / 64)
})

test('a declaration after operations that folded to constants or dropped a zero coefficient does not throw, since nothing reads the wire', () => {
  const circuit = new Circuit(3)
  const [x, y, z] = [circuit.source(0), circuit.source(1), circuit.source(2)]
  // JS: x * Math.max(0, -1), which is 0 for every x, so the operation is the constant 0 and doesn't read x.
  circuit.reglu([[x, 1]], 0, [], -1)
  // A term with a zero coefficient is dropped, so the operation is the constant 5.
  circuit.affine([[y, 0]], 5)
  // JS: z * 2 + y * 0, where the zero coefficient is dropped next to a live term, so the operation only reads z.
  circuit.affine([[z, 2], [y, 0]])
  circuit.assumeRange(x, 0, 1)
  circuit.assumeGrid(x, 1)
  circuit.assumeRange(y, 0, 1)
  circuit.affine([[y, 1], [x, 2]])
  assert.throws(() => circuit.assumeRange(x, 0, 0.5), /already read wire 0/)
})

test('an index read reads the wires of its index form and its candidates, so a later declaration on them throws', () => {
  const circuit = new Circuit(5)
  const [row, offset, first, second, third] = [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)]
  circuit.assumeRange(row, 0, 2)
  // JS: [first, second, third][row + offset * 0]. The zero coefficient is dropped, so the read doesn't read offset.
  circuit.indexReadAffine([[row, 1], [offset, 0]], 0, [first, second, third], 'clamp', 'clamp')
  assert.throws(() => circuit.assumeRange(row, 0, 1), /already read wire 0/)
  assert.throws(() => circuit.assumeRange(second, 0, 1), /already read wire 3/)
  assert.throws(() => circuit.assumeGrid(third, 1), /already read wire 4/)
  circuit.assumeRange(offset, 0, 1)
})

test('validateNoNaN names the select whose unpicked side overflowed', () => {
  const circuit = new Circuit(3)
  const [gate, off, on] = [circuit.source(0), circuit.source(1), circuit.source(2)]
  circuit.assumeRange(gate, 0, 1)
  circuit.assumeRange(off, 0, 3.4e38)
  circuit.assumeRange(on, -100, 100)
  const doubledOff = circuit.roundAffine([[off, 2]])
  const output = emitSelect(circuit, gate, doubledOff, on)
  validateNoNaN(circuit, circuit.evaluateReference(new Float32Array([1, 3, 7])))
  const overflowing = circuit.evaluateReference(new Float32Array([1, 3e38, 7]))
  assert.ok(Number.isNaN(overflowing[output]))
  assert.throws(
    () => validateNoNaN(circuit, overflowing),
    /wire 6 is the first NaN: f\(left × max\(0, gate\)\) with left = 0 and gate = Infinity, in multiply\(wire 4 = 0, wire 3 = Infinity\), in select\(gate wire 0 = 1, off wire 3 = Infinity, on wire 2 = 7\)/,
  )
})

test('validateNoNaN with roots checks only the wires they read, and a NaN operand of a select or multiply gets no context', () => {
  const circuit = new Circuit(3)
  const [gate, width, scale] = [circuit.source(0), circuit.source(1), circuit.source(2)]
  circuit.assumeRange(gate, 0, 1)
  circuit.assumeRange(width, 0, 3.4e38)
  circuit.assumeRange(scale, 0, 2)
  const doubled = circuit.roundAffine([[width, 2]])
  // The side the gate doesn't pick overflows, so this select is NaN, and the roots below don't read it.
  const unused = emitSelect(circuit, gate, doubled, circuit.constant(7))
  // JS: width * 2 + width * -2, which is Infinity - Infinity at width 3e38.
  const negated = circuit.roundAffine([[width, -2]])
  const difference = circuit.roundAffine([[doubled, 1], [negated, 1]])
  const picked = emitSelect(circuit, gate, circuit.constant(7), difference)
  const scaled = emitMultiply(circuit, difference, scale)
  const values = circuit.evaluateReference(new Float32Array([1, 3e38, 1]))
  assert.ok([unused, picked, scaled].every(wire => Number.isNaN(values[wire])))
  assert.throws(() => validateNoNaN(circuit, values), /with left = 0 and gate = Infinity, in multiply\(.*\), in select\(/)
  // The NaN comes from the sum on the side the gate picks, which is an operand of the select and of the multiply.
  const differenceMessage = new RegExp(`wire ${difference} is the first NaN: a sum of wire ${doubled} = Infinity, wire ${negated} = -Infinity$`)
  assert.throws(() => validateNoNaN(circuit, values, [picked]), differenceMessage)
  assert.throws(() => validateNoNaN(circuit, values, [scaled]), differenceMessage)
  validateNoNaN(circuit, values, [scale])
})
