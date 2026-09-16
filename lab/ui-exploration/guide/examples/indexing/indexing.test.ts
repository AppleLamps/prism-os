// Checks every example in this folder against a plain JS reference.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/indexing
import {expect, test} from 'bun:test'
import {buildHardAttentionRead, buildRuntimeKeyHardAttention, nearestPositionRead, nearestTargetReference} from './hard-attention.ts'
import {buildIndexRead, buildLinearReadFromIndexReads} from './index-read-instruction.ts'
import {
  authoredWeights,
  buildSnapCircuit,
  countSnapMatches,
  decayFriction,
  learnQueryWeights,
  learnQueryWeightsBySquaredError,
  releaseGrid,
} from './learned-query.ts'
import {buildLinearRead, linearRead, linearReadGradient} from './linear-read.ts'
import {centralDifference, countMismatches, countProgram, createRandom, programStatistics} from './measure.ts'
import {buildOneHotRead, clampedRead} from './one-hot-read.ts'
import {descendLinearRead, descendSoftAttention, matchLoss, sharpnessSchedule} from './query-descent.ts'
import {
  buildSoftAttentionRead,
  maximumSharpness,
  minimumSharpness,
  softAttentionGradient,
  softAttentionRead,
  softAttentionWeights,
} from './soft-attention.ts'

const rowHeights = [28, 44, 28, 60, 36, 28, 52, 40]

// A gradient array with 1 on the output wire, for backpropagateReference.
function seedOutput(width: number, outputWire: number) {
  const outputGradients = new Float32Array(width)
  outputGradients[outputWire] = 1
  return outputGradients
}

test('a one-hot masked sum reads table[index], and gather lowering removes the products', () => {
  const reader = buildOneHotRead(8, {declareOneHot: true})
  for (let index = -3; index <= 10; index++) {
    const source = reader.source(index, rowHeights)
    const lowered = countMismatches(reader.circuit, [reader.read], source, true)
    const dense = countMismatches(reader.circuit, [reader.read], source, false)
    expect(lowered.reference[reader.read]).toBe(clampedRead(rowHeights, index))
    expect(lowered.mismatches).toBe(0)
    expect(dense.mismatches).toBe(0)
  }
  expect(countProgram(reader.circuit, [reader.read], false)).toEqual({liveOperations: 32, layers: 5, storedWeights: 60, gatherReads: 0})
  expect(countProgram(reader.circuit, [reader.read], true)).toEqual({liveOperations: 24, layers: 4, storedWeights: 36, gatherReads: 1})
  const larger = buildOneHotRead(64, {declareOneHot: true})
  expect(countProgram(larger.circuit, [larger.read], false)).toEqual({liveOperations: 256, layers: 5, storedWeights: 508, gatherReads: 0})
  expect(countProgram(larger.circuit, [larger.read], true)).toEqual({liveOperations: 192, layers: 4, storedWeights: 316, gatherReads: 1})
})

test('a declared one-hot is not checked during evaluation: with a fractional index, the gather reads floor(index) and the reference interpolates', () => {
  const declared = buildOneHotRead(8, {declareOneHot: true})
  const source = declared.source(2.5, rowHeights)
  const lowered = countMismatches(declared.circuit, [declared.read], source, true)
  expect(lowered.reference[declared.read]).toBe(44)
  expect(lowered.compiled[declared.read]).toBe(28)
  expect(lowered.mismatches).toBeGreaterThan(0)
  const undeclared = buildLinearRead(8)
  const dense = countMismatches(undeclared.circuit, [undeclared.read], undeclared.source(2.5, rowHeights), true)
  expect(dense.compiled[undeclared.read]).toBe(44)
  expect(dense.mismatches).toBe(0)
})

test('the backward pass of a one-hot read: the selected entry gets the gradient, the index a backward difference', () => {
  const reader = buildOneHotRead(8, {declareOneHot: true})
  for (let index = 0; index < 8; index++) {
    const values = reader.circuit.evaluateReference(reader.source(index, rowHeights))
    const gradients = reader.circuit.backpropagateReference(values, seedOutput(values.length, reader.read))
    expect(reader.table.map(wire => gradients[wire])).toEqual(rowHeights.map((_, position) => position === index ? 1 : 0))
    expect(gradients[reader.index]).toBe(clampedRead(rowHeights, index) - clampedRead(rowHeights, index - 1))
  }
})

test('the index read instruction: 1 operation at any table size, and its three index gradient options', () => {
  for (const count of [8, 64, 1024]) {
    const reader = buildIndexRead(count)
    const statistics = programStatistics(reader.circuit.compileTensorProgram([reader.read]))
    expect([statistics.liveOperations, statistics.layers, statistics.storedWeights]).toEqual([1, 1, 1])
  }
  const reader = buildIndexRead(8)
  for (let index = -3; index <= 10; index++) {
    const values = reader.circuit.evaluateReference(reader.source(index, rowHeights))
    expect(values[reader.read]).toBe(clampedRead(rowHeights, index))
    const outputGradients = seedOutput(values.length, reader.read)
    expect(() => reader.circuit.backpropagateReference(values, outputGradients)).toThrow('pass indexGradient')
    const zero = reader.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'zero'})
    const selected = Math.min(Math.max(index, 0), 7)
    expect(reader.table.map(wire => zero[wire])).toEqual(rowHeights.map((_, position) => position === selected ? 1 : 0))
    expect(zero[reader.index]).toBe(0)
    const backward = reader.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'backward-difference'})
    expect(backward[reader.index]).toBe(clampedRead(rowHeights, index) - clampedRead(rowHeights, index - 1))
  }
})

test('linear interpolation: values, and gradients against the derivative and central differences', () => {
  const reader = buildLinearRead(8)
  const evaluateAt = (index: number) => reader.circuit.evaluateReference(reader.source(index, rowHeights))[reader.read]!
  for (const index of [0.25, 1.5, 2.5, 3.7, 5.125, 6.9]) {
    const source = reader.source(index, rowHeights)
    const {mismatches, reference} = countMismatches(reader.circuit, [reader.read], source)
    expect(mismatches).toBe(0)
    expect(Math.abs(reference[reader.read]! - linearRead(rowHeights, index))).toBeLessThan(1e-5)
    const gradients = reader.circuit.backpropagateReference(reference, seedOutput(reference.length, reader.read))
    const expected = linearReadGradient(rowHeights, index)
    expect(gradients[reader.index]).toBe(expected.index)
    expect(Math.abs(centralDifference(evaluateAt, index, 0.01) - expected.index)).toBeLessThan(1e-3)
    reader.table.forEach((wire, position) => {
      expect(Math.abs(gradients[wire]! - expected.table[position]!)).toBeLessThan(1e-6)
    })
  }
  // At a whole-number index the read has a corner. The ReLU's zero slope at its
  // corner makes the backward pass report the slope on the left side.
  for (let index = 1; index < 8; index++) {
    const values = reader.circuit.evaluateReference(reader.source(index, rowHeights))
    const gradients = reader.circuit.backpropagateReference(values, seedOutput(values.length, reader.read))
    expect(gradients[reader.index]).toBe(rowHeights[index]! - rowHeights[index - 1]!)
  }
})

test('linear interpolation from index reads: 10 operations per read, the same values, and the slope as the index gradient', () => {
  for (const count of [8, 64, 1024]) {
    const reader = buildLinearReadFromIndexReads(count)
    const statistics = programStatistics(reader.circuit.compileTensorProgram([reader.read]))
    // count - 1 of the operations are the constant positions 0..count-2, each a
    // constant with no stored weight.
    expect([statistics.liveOperations, statistics.layers, statistics.storedWeights]).toEqual([10 + count - 1, 6, 15])
  }
  const reader = buildLinearReadFromIndexReads(8)
  for (const index of [-1, 0, 0.25, 2.5, 3, 3.7, 6.9, 7, 8]) {
    const values = reader.circuit.evaluateReference(reader.source(index, rowHeights))
    expect(Math.abs(values[reader.read]! - linearRead(rowHeights, index))).toBeLessThan(1e-5)
    const outputGradients = seedOutput(values.length, reader.read)
    expect(() => reader.circuit.backpropagateReference(values, outputGradients)).toThrow('pass indexGradient')
    const gradients = reader.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'zero'})
    const lowerPosition = Math.min(Math.floor(index), 6)
    const expectedSlope = index > 0 && index <= 7 ? rowHeights[lowerPosition + 1]! - rowHeights[lowerPosition]! : 0
    expect(gradients[reader.index]).toBe(expectedSlope)
  }
})

test('soft attention with parabola keys: values against float64 softmax, gradients against the derivative and central differences', () => {
  const reader = buildSoftAttentionRead(8)
  for (const sharpness of [minimumSharpness, 1, 4, maximumSharpness]) {
    for (let query = 0; query <= 7; query += 0.25) {
      const values = reader.circuit.evaluateReference(reader.source(query, sharpness, rowHeights))
      // The declared range of the sum, which the Newton reciprocal relies on.
      expect(values[reader.total]!).toBeGreaterThanOrEqual(0.25)
      expect(values[reader.total]!).toBeLessThanOrEqual(4)
      expect(Math.abs(values[reader.read]! - softAttentionRead(rowHeights, query, sharpness))).toBeLessThan(1e-4)
      const gradients = reader.circuit.backpropagateReference(values, seedOutput(values.length, reader.read))
      const expected = softAttentionGradient(rowHeights, query, sharpness)
      expect(Math.abs(gradients[reader.query]! - expected.query)).toBeLessThan(1e-3)
      expect(Math.abs(gradients[reader.sharpness]! - expected.sharpness)).toBeLessThan(1e-3)
      reader.table.forEach((wire, position) => {
        expect(Math.abs(gradients[wire]! - expected.table[position]!)).toBeLessThan(1e-5)
      })
    }
  }
  for (const query of [0.5, 2.3, 3.5, 6.1]) {
    const sharpness = 1
    const values = reader.circuit.evaluateReference(reader.source(query, sharpness, rowHeights))
    const gradients = reader.circuit.backpropagateReference(values, seedOutput(values.length, reader.read))
    const evaluateQuery = (at: number) => reader.circuit.evaluateReference(reader.source(at, sharpness, rowHeights))[reader.read]!
    const evaluateSharpness = (at: number) => reader.circuit.evaluateReference(reader.source(query, at, rowHeights))[reader.read]!
    expect(Math.abs(centralDifference(evaluateQuery, query, 0.01) - gradients[reader.query]!)).toBeLessThan(5e-3)
    expect(Math.abs(centralDifference(evaluateSharpness, sharpness, 0.01) - gradients[reader.sharpness]!)).toBeLessThan(5e-3)
  }
  expect(countProgram(reader.circuit, [reader.read])).toEqual({liveOperations: 154, layers: 35, storedWeights: 310, gatherReads: 0})
  const larger = buildSoftAttentionRead(64)
  expect(countProgram(larger.circuit, [larger.read])).toEqual({liveOperations: 1106, layers: 35, storedWeights: 2270, gatherReads: 0})
})

test('hard attention with parabola keys reads the nearest position, lowers to a gather, and has no gradient', () => {
  const reader = buildHardAttentionRead(8)
  for (let query = 0; query <= 7; query += 1 / 64) {
    const {mismatches, reference} = countMismatches(reader.circuit, [reader.read], reader.source(query, rowHeights))
    expect(mismatches).toBe(0)
    expect(reference[reader.read]).toBe(nearestPositionRead(rowHeights, query))
  }
  expect(countProgram(reader.circuit, [reader.read], false)).toEqual({liveOperations: 63, layers: 18, storedWeights: 117, gatherReads: 0})
  expect(countProgram(reader.circuit, [reader.read], true)).toEqual({liveOperations: 55, layers: 17, storedWeights: 93, gatherReads: 1})
  const larger = buildHardAttentionRead(64)
  expect(countProgram(larger.circuit, [larger.read], true)).toEqual({liveOperations: 503, layers: 35, storedWeights: 909, gatherReads: 1})
  const values = reader.circuit.evaluateReference(reader.source(2.3, rowHeights))
  expect(() => reader.circuit.backpropagateReference(values, seedOutput(values.length, reader.read))).toThrow('boolean atom')
  // The softmax weights approach the hard one-hot as the sharpness grows, e.g. at
  // query 2.25 the nearest position is 2.
  expect(softAttentionWeights(8, 2.25, 1)[2]!).toBeLessThan(0.6)
  expect(softAttentionWeights(8, 2.25, 8)[2]!).toBeGreaterThan(0.98)
  expect(softAttentionWeights(8, 2.25, 64)[2]!).toBeGreaterThan(0.9999)
})

test('hard attention with runtime keys snaps to the nearest target position, and lowers to a gather', () => {
  const reader = buildRuntimeKeyHardAttention(8, 256)
  const random = createRandom(11)
  for (let layout = 0; layout < 4; layout++) {
    const targetPositions = Array.from({length: 8}, () => Math.floor(random() * 257))
    for (let pointerX = 0; pointerX <= 256; pointerX += 0.25) {
      const source = reader.source(pointerX, targetPositions)
      const values = reader.circuit.evaluateReference(source)
      expect(values[reader.snapX]).toBe(nearestTargetReference(targetPositions, pointerX))
      if (pointerX % 8 === 0) expect(countMismatches(reader.circuit, [reader.snapX], source).mismatches).toBe(0)
    }
  }
  expect(countProgram(reader.circuit, [reader.snapX], true)).toEqual({liveOperations: 71, layers: 18, storedWeights: 133, gatherReads: 1})
  const larger = buildRuntimeKeyHardAttention(64, 256)
  expect(countProgram(larger.circuit, [larger.snapX], true)).toEqual({liveOperations: 631, layers: 36, storedWeights: 1229, gatherReads: 1})
})

test('toy: learning the weights that compute a query, with a soft read while training and argmax in the circuit that runs', () => {
  // The authored weights give the plain JS page on every release of the grid.
  expect(countSnapMatches(authoredWeights)).toEqual({matches: 10976, total: 10976, largestMismatchDistance: 0})
  const snap = buildSnapCircuit()
  releaseGrid().filter((_, item) => item % 97 === 0).forEach(release => {
    expect(countMismatches(snap.circuit, [snap.snapPage], snap.source(release, authoredWeights)).mismatches).toBe(0)
  })
  const options = {steps: 400, batchSize: 16, learningRate: 0.05, seed: 1}
  // From "nearest page, ignoring velocity" and from "always the middle page".
  for (const start of [{weightRelease: 1, weightVelocity: 0, bias: 3.5}, {weightRelease: 0, weightVelocity: 0, bias: 3.5}]) {
    const weights = learnQueryWeights({...options, start})
    expect(Math.abs(weights.weightRelease - 1)).toBeLessThan(0.02)
    expect(Math.abs(weights.weightVelocity - 1 / decayFriction)).toBeLessThan(0.01)
    expect(Math.abs(weights.bias - 3.5)).toBeLessThan(0.02)
    const result = countSnapMatches(weights)
    expect(result.matches).toBeGreaterThan(0.99 * result.total)
    expect(result.largestMismatchDistance).toBeLessThan(0.05)
  }
  // The control learns similar weights with no read at all.
  const controlWeights = learnQueryWeightsBySquaredError({...options, start: {weightRelease: 1, weightVelocity: 0, bias: 3.5}, learningRate: 0.02})
  expect(Math.abs(controlWeights.weightVelocity - 1 / decayFriction)).toBeLessThan(0.02)
  expect(countSnapMatches(controlWeights).matches).toBeGreaterThan(0.95 * 10976)
})

test('toy: descent moves the query onto the entry holding the target id with a soft read that starts wide', () => {
  const itemIds = [41, 7, 23, 88, 15, 64, 30, 52]
  const targetId = 64
  const entryLosses = matchLoss(itemIds, targetId)
  const schedule = sharpnessSchedule(minimumSharpness, maximumSharpness, 80, 40)
  for (const startQuery of [0, 1.2, 2.7, 4, 6.5, 7]) {
    const queries = descendSoftAttention(entryLosses, {startQuery, steps: 140, learningRate: 1, maximumStep: 0.5, sharpnessAt: schedule})
    const finalQuery = queries.at(-1)!
    expect(Math.abs(finalQuery - 5)).toBeLessThan(0.01)
    expect(softAttentionWeights(8, finalQuery, maximumSharpness)[5]!).toBeGreaterThan(0.99)
  }
  // Sharp from the start: the far entries' weights are too small to move the query.
  const sharpOnly = descendSoftAttention(entryLosses, {startQuery: 1.2, steps: 140, learningRate: 1, maximumStep: 0.5, sharpnessAt: () => maximumSharpness})
  expect(Math.abs(sharpOnly.at(-1)! - 1.2)).toBeLessThan(0.01)
  // Linear interpolation only involves the two neighbors: from 1.2 both have loss 1, so the query doesn't move.
  const linearFar = descendLinearRead(entryLosses, {startQuery: 1.2, steps: 140, learningRate: 0.2, maximumStep: 0.5, loss: 'read'})
  expect(linearFar.at(-1)).toBe(1.2)
  const linearNear = descendLinearRead(entryLosses, {startQuery: 4.3, steps: 140, learningRate: 0.2, maximumStep: 0.5, loss: 'read'})
  expect(Math.round(linearNear.at(-1)!)).toBe(5)
  // A loss on the blended value is satisfied by a blend of two wrong entries: ids 23 and 88 mix into 64.
  const blended = descendLinearRead(itemIds, {startQuery: 1.2, steps: 140, learningRate: 0.2, maximumStep: 0.5, loss: {target: targetId, scale: 100}})
  const blendedQuery = blended.at(-1)!
  expect(Math.abs(linearRead(itemIds, blendedQuery) - targetId)).toBeLessThan(1e-3)
  expect(itemIds[Math.round(blendedQuery)]).toBe(88)
})
