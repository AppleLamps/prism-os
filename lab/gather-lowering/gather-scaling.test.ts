import {expect, test} from 'bun:test'
import {validateTensorProgram} from '../../numeric-ui-core.ts'
import {buildLibraryCircuit, fillLibrarySource} from './library-circuit.ts'
import {gatherStatistics, sameNumericValue} from './measure.ts'

// Structural asymptotics of the lowering on the library benchmark shape, kept
// small enough for the test suite; the timing dimension lives in benchmark.ts.

test('stored weights per read drop from 3N to zero under lowering', () => {
  for (const slotCount of [64, 256]) {
    for (const readCount of [1, 4]) {
      const {circuit, reads} = buildLibraryCircuit(slotCount, readCount)
      const lowered = circuit.compileTensorProgram(reads, true)
      const plain = circuit.compileTensorProgram(reads, false)
      validateTensorProgram(circuit, lowered)
      validateTensorProgram(circuit, plain)
      const loweredStats = gatherStatistics(lowered)
      const plainStats = gatherStatistics(plain)

      // Dense form: per read, N products of 2 stored weights each plus an
      // N-term sum. Lowered form: no stored weights at all — the products are
      // dead and each read is one gather row.
      expect(plainStats.storedWeightCount).toBe(3 * slotCount * readCount)
      expect(loweredStats.storedWeightCount).toBe(0)
      expect(loweredStats.readCount).toBe(readCount)
      expect(loweredStats.computeCount).toBe(1)
      // Only the read outputs survive past the sources.
      expect(lowered.valueCount).toBe(circuit.sourceSize + readCount)
      expect(plain.valueCount).toBe(circuit.sourceSize + readCount + slotCount * readCount)

      // What remains proportional to N: the shared bit table (N entries) and
      // one candidate table per read (N entries each), as index bookkeeping
      // rather than FP32 weights.
      expect(loweredStats.gatherBytes).toBeGreaterThan(0)
      expect(loweredStats.gatherBytes).toBeLessThanOrEqual(
        4 * slotCount * (readCount + 1) + 16 * readCount + 4,
      )
    }
  }
})

test('lowered and dense programs agree with the reference across selections', () => {
  const slotCount = 128
  const readCount = 4
  const {circuit, reads, valueWire} = buildLibraryCircuit(slotCount, readCount)
  const lowered = circuit.compileTensorProgram(reads, true)
  const plain = circuit.compileTensorProgram(reads, false)
  const source = new Float32Array(circuit.sourceSize)
  for (const selectedSlot of [0, 1, 63, 64, 126, 127]) {
    fillLibrarySource(source, slotCount, readCount, selectedSlot)
    const reference = circuit.evaluateReference(source)
    circuit.tensorProgram = lowered
    const tensorLowered = circuit.evaluateTensor(source)
    circuit.tensorProgram = plain
    const tensorPlain = circuit.evaluateTensor(source)
    for (let field = 0; field < readCount; field++) {
      const read = reads[field]!
      expect(reference[read]).toBe(source[valueWire(field, selectedSlot)])
      expect(sameNumericValue(tensorLowered[read]!, reference[read]!)).toBe(true)
      expect(sameNumericValue(tensorPlain[read]!, reference[read]!)).toBe(true)
    }
  }
})
