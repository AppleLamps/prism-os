import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, emitMultiply} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {countOperationKinds, frameTimeScale, frameTimesPath} from '../../src/handwiredos/monitor.ts'

test('Monitor counts HandwiredOS\'s operations by kind as the circuit names them', () => {
  const machine = createWindowManagerMachine()
  const program = machine.tensorProgram
  // The kind of every operation that the compiler kept, read from the circuit.
  const built = {affine: 0, reglu: 0, boolean: 0, index: 0}
  for (let packed = program.sourceSize; packed < program.valueCount; packed++) {
    built[machine.circuit.operations[program.wireOrder[packed]! - program.sourceSize]!.kind]++
  }
  const kinds = countOperationKinds(program)
  // A gather read is an affine operation that the compiler turned into a read.
  assert.equal(kinds.affine + kinds.gatherReads, built.affine)
  assert.equal(kinds.reglu, built.reglu)
  assert.equal(kinds.boolean, built.boolean)
  assert.equal(kinds.indexReads, built.index)
  assert.ok(kinds.affine > 0 && kinds.gatherReads > 0 && kinds.reglu > 0 && kinds.boolean > 0)
})

test('Monitor counts index reads and gather reads apart from affine operations', () => {
  // 4 bits declared one-hot, 4 values, one sum of bit × value, which the compiler
  // turns into a gather read, one index read of the values, one boolean, and one
  // sum of the three.
  const circuit = new Circuit(10)
  const bits = [0, 1, 2, 3].map(slot => circuit.source(slot))
  const values = [4, 5, 6, 7].map(slot => circuit.source(slot))
  circuit.assumeOneHot(bits)
  for (const value of values) circuit.assumeRange(value, 0, 4096)
  const selected = circuit.affine(bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]))
  const index = circuit.source(8)
  circuit.assumeRange(index, 0, 3)
  const read = circuit.indexRead(index, values)
  const score = circuit.source(9)
  circuit.assumeRange(score, 0, 1)
  const rounded = circuit.boolean(score)
  const sum = circuit.roundAffine([[selected, 1], [read, 1], [rounded, 1]])
  const program = circuit.compileTensorProgram([sum])
  assert.deepEqual(countOperationKinds(program), {affine: 1, gatherReads: 1, reglu: 0, boolean: 1, indexReads: 1})

  // Without gather lowering, the masked sum and its 4 products stay.
  const dense = circuit.compileTensorProgram([sum], false)
  const denseKinds = countOperationKinds(dense)
  assert.equal(denseKinds.gatherReads, 0)
  assert.equal(denseKinds.indexReads, 1)
  assert.equal(denseKinds.boolean, 1)
  assert.equal(denseKinds.affine + denseKinds.reglu, dense.valueCount - dense.sourceSize - 2)
})

test('the frame time chart\'s scale is the smallest of 1, 2, 5, 10 ms and so on that holds the longest frame', () => {
  assert.equal(frameTimeScale(0), 1)
  assert.equal(frameTimeScale(0.4), 1)
  assert.equal(frameTimeScale(1), 1)
  assert.equal(frameTimeScale(1.1), 2)
  assert.equal(frameTimeScale(3.2), 5)
  assert.equal(frameTimeScale(5), 5)
  assert.equal(frameTimeScale(7), 10)
  assert.equal(frameTimeScale(16.7), 20)
  assert.equal(frameTimeScale(180), 200)
})

test('the frame time chart\'s line ends at the right edge, with 0 ms at the bottom', () => {
  assert.equal(frameTimesPath([0.5], 60, 1), 'M59 0.500')
  assert.equal(frameTimesPath([0.5, 1], 60, 1), 'M58 0.500L59 0.000')
  assert.equal(frameTimesPath([0, 0.25, 2], 60, 2), 'M57 1.000L58 0.875L59 0.000')
  // A time above the scale stays at the top.
  assert.equal(frameTimesPath([3], 60, 2), 'M59 0.000')
  // A full chart starts at the left edge.
  assert.ok(frameTimesPath(Array<number>(60).fill(0.1), 60, 1).startsWith('M0 0.900L1 0.900'))
})
