// Checks the index read instruction of numeric-ui-core.ts against plain JavaScript,
// against the one-hot masked sum, and against index-read's copy of the runtime in
// lab/ui-exploration/pixel-output.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/indexing
import {expect, test} from 'bun:test'
import {Circuit, validateIndexReads} from '../../../../../numeric-ui-core.ts'
import {buildIndexRead, buildLinearReadFromIndexReads} from './index-read-instruction.ts'
import {linearRead} from './linear-read.ts'
import {countMismatches, countProgram, createRandom, programStatistics} from './measure.ts'
import {buildOneHotRead, clampedRead, emitMaskedSum, emitTentWeights} from './one-hot-read.ts'
import {buildSharedIndexRead, buildSharedLinearRead, buildVisibleRowTops, visibleRowTopsReference} from './shared-runtime-index-read.ts'

const rowHeights = [28, 44, 28, 60, 36, 28, 52, 40]

function seedOutput(width: number, outputWire: number) {
  const outputGradients = new Float32Array(width)
  outputGradients[outputWire] = 1
  return outputGradients
}

function indexReadCount(program: ReturnType<ReturnType<typeof buildSharedIndexRead>['circuit']['compileTensorProgram']>) {
  let indexReads = 0
  for (const layer of program.layers) indexReads += layer.indexReads.length
  return indexReads
}

test('numeric-ui-core.ts reads table[floor(index)] in 1 operation, with the same values and counts as index-read\'s copy', () => {
  for (const count of [8, 64, 1024]) {
    const shared = buildSharedIndexRead(count)
    const program = shared.circuit.compileTensorProgram([shared.read])
    expect(countProgram(shared.circuit, [shared.read])).toEqual({liveOperations: 1, layers: 1, storedWeights: 1, gatherReads: 0})
    expect(indexReadCount(program)).toBe(1)
    const copy = buildIndexRead(count)
    const copyStatistics = programStatistics(copy.circuit.compileTensorProgram([copy.read]))
    expect([copyStatistics.liveOperations, copyStatistics.layers, copyStatistics.storedWeights]).toEqual([1, 1, 1])
  }
  const shared = buildSharedIndexRead(8)
  const copy = buildIndexRead(8)
  const random = createRandom(5)
  const tables = [rowHeights, Array.from({length: 8}, () => Math.fround((random() * 2 - 1) * 1e5))]
  for (const table of tables) {
    for (let index = -4; index <= 12; index++) {
      const source = shared.source(index, table)
      const {mismatches, reference} = countMismatches(shared.circuit, [shared.read], source)
      expect(mismatches).toBe(0)
      expect(countMismatches(shared.circuit, [shared.read], source, false).mismatches).toBe(0)
      expect(reference[shared.read]).toBe(clampedRead(table.map(value => Math.fround(value)), index))
      expect(Object.is(reference[shared.read], copy.circuit.evaluateReference(copy.source(index, table))[copy.read])).toBe(true)
      validateIndexReads(shared.circuit, reference)
    }
  }
})

test('the backward pass: the selected entry gets the gradient, and the index gradient throws unless the caller picks zero or backward-difference', () => {
  const shared = buildSharedIndexRead(8)
  const oneHot = buildOneHotRead(8, {declareOneHot: true})
  for (let index = -3; index <= 10; index++) {
    const values = shared.circuit.evaluateReference(shared.source(index, rowHeights))
    const outputGradients = seedOutput(values.length, shared.read)
    expect(() => shared.circuit.backpropagateReference(values, outputGradients)).toThrow('pass indexGradient')
    const zero = shared.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'zero'})
    const selected = Math.min(Math.max(index, 0), 7)
    expect(shared.table.map(wire => zero[wire])).toEqual(rowHeights.map((_, position) => position === selected ? 1 : 0))
    expect(zero[shared.index]).toBe(0)
    const backward = shared.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'backward-difference'})
    // What the plain backward pass gives the ReLU one-hot at a whole-number index.
    const oneHotValues = oneHot.circuit.evaluateReference(oneHot.source(index, rowHeights))
    const oneHotGradients = oneHot.circuit.backpropagateReference(oneHotValues, seedOutput(oneHotValues.length, oneHot.read))
    expect(backward[shared.index]).toBe(oneHotGradients[oneHot.index])
    expect(backward[shared.index]).toBe(clampedRead(rowHeights, index) - clampedRead(rowHeights, index - 1))
  }
})

test('linear interpolation from three index reads: 10 operations per read, and the same values as index-read\'s copy', () => {
  for (const count of [8, 64, 1024]) {
    const shared = buildSharedLinearRead(count)
    // count - 1 of the operations are the constant positions 0..count-2, each with no stored weight.
    const counts = countProgram(shared.circuit, [shared.read])
    expect([counts.liveOperations, counts.layers, counts.storedWeights]).toEqual([10 + count - 1, 6, 15])
  }
  const shared = buildSharedLinearRead(8)
  const copy = buildLinearReadFromIndexReads(8)
  for (const index of [-1, 0, 0.25, 2.5, 3, 3.7, 6.9, 7, 8]) {
    const values = shared.circuit.evaluateReference(shared.source(index, rowHeights))
    expect(Object.is(values[shared.read], copy.circuit.evaluateReference(copy.source(index, rowHeights))[copy.read])).toBe(true)
    expect(Math.abs(values[shared.read]! - linearRead(rowHeights, index))).toBeLessThan(1e-5)
    expect(countMismatches(shared.circuit, [shared.read], shared.source(index, rowHeights)).mismatches).toBe(0)
    const gradients = shared.circuit.backpropagateReference(values, seedOutput(values.length, shared.read), {indexGradient: 'zero'})
    const lowerPosition = Math.min(Math.floor(index), 6)
    const expectedSlope = index > 0 && index <= 7 ? rowHeights[lowerPosition + 1]! - rowHeights[lowerPosition]! : 0
    expect(gradients[shared.index]).toBe(expectedSlope)
  }
})

test('the contract: a declared index range, an integer index, a copy without rounding, and a table that can\'t change after a read', () => {
  // Building a read over an index cell without a declared range throws, and so does a range that reaches ±2^24.
  // Source table: [index, wideIndex, table[0], table[1]].
  const undeclared = new Circuit(4)
  expect(() => undeclared.indexRead(undeclared.source(0), [undeclared.source(2), undeclared.source(3)])).toThrow('index range declared strictly inside ±2^24')
  undeclared.assumeRange(undeclared.source(1), 0, 2 ** 25)
  expect(() => undeclared.indexRead(undeclared.source(1), [undeclared.source(2), undeclared.source(3)])).toThrow('index range declared strictly inside ±2^24')
  // An endpoint on 2^24 throws too, e.g. when FP32 rounds 2^24 + 1 onto 2^24.
  undeclared.assumeRange(undeclared.source(1), 0, 2 ** 24)
  expect(() => undeclared.indexReadAffine([[undeclared.source(1), 1]], 1, [undeclared.source(2), undeclared.source(3)], 'clamp', 'clamp')).toThrow('index range declared strictly inside ±2^24')

  // A fractional index makes the one-hot declaration false: the read floors, while the ReLU one-hot interpolates.
  const shared = buildSharedIndexRead(8)
  const fractional = shared.circuit.evaluateReference(shared.source(2.5, rowHeights))
  expect(fractional[shared.read]).toBe(28)
  const tent = buildOneHotRead(8, {declareOneHot: false})
  expect(tent.circuit.evaluateReference(tent.source(2.5, rowHeights))[tent.read]).toBe(44)
  expect(() => validateIndexReads(shared.circuit, fractional)).toThrow('needs an integer index')

  // An infinite entry comes through the read, while the masked sum turns into NaN. The
  // entries have no declared range, which the read doesn't need.
  // Source table: [index, table[0], ..., table[7]].
  const withInfinity = [...rowHeights]
  withInfinity[5] = Number.POSITIVE_INFINITY
  const infiniteCircuit = new Circuit(9)
  infiniteCircuit.assumeRange(infiniteCircuit.source(0), 0, 7)
  const entries = Array.from({length: 8}, (_, position) => infiniteCircuit.source(1 + position))
  const infiniteRead = infiniteCircuit.indexRead(infiniteCircuit.source(0), entries)
  const infiniteMaskedSum = emitMaskedSum(infiniteCircuit, emitTentWeights(infiniteCircuit, infiniteCircuit.source(0), 8), entries)
  const infiniteValues = (index: number) => infiniteCircuit.evaluateReference(Float32Array.from([index, ...withInfinity]))
  expect(infiniteValues(5)[infiniteRead]).toBe(Infinity)
  expect(infiniteValues(4)[infiniteRead]).toBe(36)
  expect(infiniteValues(4)[infiniteMaskedSum]).toBeNaN()

  // The builder freezes the candidates array, so changing it after a read throws.
  expect(() => {
    shared.table[2] = shared.circuit.source(7)
  }).toThrow()
})

test('a virtualized list reads rowTops[firstVisibleRow + k] with +0 past the last row, in 1 operation per DOM slot and no stored positions', () => {
  const rowCount = 10_000
  const slotCount = 24
  const list = buildVisibleRowTops(rowCount, slotCount)
  const program = list.circuit.compileTensorProgram(list.slotTops)
  expect(countProgram(list.circuit, list.slotTops)).toEqual({liveOperations: slotCount, layers: 1, storedWeights: slotCount, gatherReads: 0})
  expect(indexReadCount(program)).toBe(slotCount)
  // The row tops are a run of source cells, so each read stores a base position and a stride.
  for (const layer of program.layers) for (const read of layer.indexReads) expect(read.candidatePositions.length).toBe(0)
  const random = createRandom(11)
  const rowTops: number[] = []
  let top = 0
  for (let row = 0; row < rowCount; row++) {
    rowTops.push(top)
    top = Math.fround(top + 20 + Math.floor(random() * 80) + random())
  }
  for (const firstVisibleRow of [0, 1, 4_999, rowCount - slotCount, rowCount - slotCount + 1, rowCount - 1]) {
    const source = list.source(firstVisibleRow, rowTops)
    const {mismatches, reference} = countMismatches(list.circuit, list.slotTops, source)
    expect(mismatches).toBe(0)
    expect(list.slotTops.map(wire => reference[wire])).toEqual(visibleRowTopsReference(rowTops, firstVisibleRow, slotCount))
    validateIndexReads(list.circuit, reference)
    const evaluate = list.circuit.createTensorEvaluator(list.slotTops, {recomputeDepths: true})
    expect(Array.from(evaluate(source))).toEqual(visibleRowTopsReference(rowTops, firstVisibleRow, slotCount))
  }
})
