import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type OutOfRange,
  type Wire,
  emitArgmax,
  emitCompare,
  emitFirstActive,
  inlineCircuit,
  validateCircuit,
  validateIndexReads,
  validateOneHotGroups,
  validateTensorProgram,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'

// Tests for the index read instruction, ported from index-read's index-read.test.ts
// (https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/index-read/index-read.test.ts)
// and extended to every compile mode of the shared runtime.

// Seeded hash, copied from numeric-ui-core.test.ts so the suite stays deterministic.
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

const largestFloat32 = Math.fround(3.4028234663852886e38)
const smallestSubnormalFloat32 = Math.fround(1e-45)

// The instruction's definition in plain JavaScript, written independently of the runtime.
function expectedIndexRead(index: number, values: readonly number[], below: OutOfRange, above: OutOfRange): number {
  if (Number.isNaN(index)) return Number.NaN
  const position = Math.floor(index)
  if (position < 0) return below === 'zero' ? 0 : values[0]!
  if (position > values.length - 1) return above === 'zero' ? 0 : values[values.length - 1]!
  return values[position]!
}

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

const compileModes: {label: string, compile: (circuit: Circuit, roots: readonly Wire[]) => TensorProgram}[] = [
  {label: 'gather lowering, build-time depths', compile: (circuit, roots) => circuit.compileTensorProgram(roots)},
  {label: 'no gather lowering', compile: (circuit, roots) => circuit.compileTensorProgram(roots, false)},
  {
    label: 'gather lowering, recomputed depths',
    compile: (circuit, roots) => circuit.compileTensorProgram(roots, true, {recomputeDepths: true}),
  },
  {
    label: 'no gather lowering, recomputed depths',
    compile: (circuit, roots) => circuit.compileTensorProgram(roots, false, {recomputeDepths: true}),
  },
  {label: 'every wire as a root', compile: circuit => circuit.compileTensorProgram()},
]

// Compile the circuit in every mode, and check that every compiled program
// returns the reference evaluator's bits on every live wire for every source
// table, including the sign of zero and NaN. Also checks both reusable
// evaluators on the roots. Returns the reference values.
function checkEveryCompileMode(
  circuit: Circuit,
  roots: readonly Wire[],
  sources: readonly Float32Array[],
): Float32Array[] {
  validateCircuit(circuit)
  const references = sources.map(source => circuit.evaluateReference(source))
  for (const mode of compileModes) {
    const program = mode.compile(circuit, roots)
    validateTensorProgram(circuit, program)
    const previousProgram = circuit.tensorProgram
    circuit.tensorProgram = program
    sources.forEach((source, sourceIndex) => {
      const tensorValues = circuit.evaluateTensor(source)
      const reference = references[sourceIndex]!
      for (const wire of program.wireOrder) {
        if (!Object.is(tensorValues[wire], reference[wire])) {
          throw new Error(`${mode.label}: wire ${wire} got ${tensorValues[wire]}, reference ${reference[wire]}`)
        }
      }
    })
    circuit.tensorProgram = previousProgram
  }
  for (const options of [{}, {recomputeDepths: true}]) {
    const evaluate = circuit.createTensorEvaluator(roots, options)
    sources.forEach((source, sourceIndex) => {
      const outputs = evaluate(source)
      roots.forEach((root, rootIndex) => {
        if (!Object.is(outputs[rootIndex], references[sourceIndex]![root])) {
          throw new Error(`reusable evaluator: root ${root} got ${outputs[rootIndex]}, reference ${references[sourceIndex]![root]}`)
        }
      })
    })
  }
  return references
}

function programCounts(program: TensorProgram) {
  let storedWeights = 0
  let gatherReads = 0
  let indexReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    indexReads += layer.indexReads.length
  }
  return {liveOperations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights, gatherReads, indexReads}
}

// [index >= threshold] for an integer index, as relu(index - threshold + 1) -
// relu(index - threshold), kept as its own rounding point.
function emitIntegerAtLeast(circuit: Circuit, index: Wire, threshold: number): Wire {
  const upper = circuit.reglu([], 1, [[index, 1]], 1 - threshold)
  const lower = circuit.reglu([], 1, [[index, 1]], -threshold)
  const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// The one-hot masked sum an index read replaces, in the two styles the
// prototypes built. 'clamp' selects the first member for every index <= 0 and
// the last member for every index >= count - 1. 'zero-above' selects the first
// member for every index <= 0, and no member once index >= count.
type DenseStyle = 'clamp' | 'zero-above'

function emitOneHotMaskedRead(circuit: Circuit, index: Wire, values: readonly Wire[], style: DenseStyle) {
  const count = values.length
  const atLeast: Wire[] = [circuit.affine([], 1)]
  const lastThreshold = style === 'clamp' ? count - 1 : count
  for (let threshold = 1; threshold <= lastThreshold; threshold++) {
    atLeast.push(emitIntegerAtLeast(circuit, index, threshold))
  }
  if (style === 'clamp') atLeast.push(circuit.affine([], 0))
  const members = values.map((_, position) => {
    const member = circuit.roundAffine([[atLeast[position]!, 1], [atLeast[position + 1]!, -1]])
    circuit.assumeRange(member, 0, 1)
    return member
  })
  circuit.assumeOneHot(members, style === 'zero-above')
  const read = circuit.roundAffine(members.map((member, position) =>
    [circuit.multiply(member, values[position]!), 1] as const))
  return {members, read}
}

// One source layout shared by a dense construction and the instruction: an
// index cell, then one cell per table entry.
function buildPair(count: number, style: DenseStyle, valueRange: number) {
  const sourceSize = 1 + count
  const index = asWire(0)
  const values = Array.from({length: count}, (_, position) => 1 + position)
  const declareRanges = (circuit: Circuit) => {
    circuit.assumeRange(index, -8, count + 8)
    for (const value of values) circuit.assumeRange(asWire(value), -valueRange, valueRange)
  }
  const dense = new Circuit(sourceSize)
  declareRanges(dense)
  const {members, read: denseRead} = emitOneHotMaskedRead(dense, index, values.map(asWire), style)
  const instruction = new Circuit(sourceSize)
  declareRanges(instruction)
  const above: OutOfRange = style === 'clamp' ? 'clamp' : 'zero'
  const instructionRead = instruction.indexReadAffine([[index, 1]], 0, ([...values]).map(asWire), 'clamp', above)
  return {sourceSize, index, values, dense, members, denseRead, instruction, instructionRead, above}
}

describe('index read instruction', () => {
  test('reads candidates[floor(index)] with clamp or +0 outside the table, in every compile mode', () => {
    const candidateValues = [
      Math.fround(-7.25),
      -0,
      Number.POSITIVE_INFINITY,
      largestFloat32,
      Number.NEGATIVE_INFINITY,
      smallestSubnormalFloat32,
      Math.fround(42.5),
    ]
    const count = candidateValues.length
    const circuit = new Circuit(1 + count)
    circuit.assumeRange(circuit.source(0), -8, count + 8)
    const candidates = candidateValues.map((_, position) => 1 + position)
    const sideRules = [['clamp', 'clamp'], ['zero', 'zero'], ['zero', 'clamp'], ['clamp', 'zero']] as const
    const reads = sideRules.map(([below, above]) => circuit.indexReadAffine([[circuit.source(0), 1]], 0, candidates.map(asWire), below, above))
    const indices = [-8, -3, -1, -0.5, -0, 0, 0.25, 1, 2, 3.999, 4, 5, 6, 6.5, 7, 8, count + 8]
    const sources = indices.map(index => Float32Array.from([index, ...candidateValues]))
    const references = checkEveryCompileMode(circuit, reads, sources)
    indices.forEach((index, sourceIndex) => {
      sideRules.forEach(([below, above], readIndex) => {
        const expected = expectedIndexRead(Math.fround(index), candidateValues, below, above)
        expect(Object.is(references[sourceIndex]![reads[readIndex]!], expected)).toBe(true)
      })
    })
    // evaluateTensor compiles every wire when no program was set.
    circuit.tensorProgram = null
    expect(circuit.evaluateTensor(sources[0]!)[reads[1]!]).toBe(0)
    const program = circuit.compileTensorProgram(reads)
    expect(programCounts(program)).toEqual({liveOperations: 4, layers: 1, storedWeights: 4, gatherReads: 0, indexReads: 4})
  })

  test('a broken range promise: NaN and infinite indices read the same in every compile mode', () => {
    const circuit = new Circuit(5)
    // difference is NaN when both cells hold Infinity, although its range was declared.
    const difference = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), -1]])
    circuit.assumeRange(difference, 0, 2)
    const candidates = [2, 3, 4]
    const clampRead = circuit.indexRead(difference, candidates.map(asWire))
    const zeroRead = circuit.indexRead(difference, candidates.map(asWire), {outOfRange: 'zero'})
    const cellPairs = [
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [1e30, 0],
      [-1e30, 0],
      [5, 0],
      [-1, 0],
    ]
    const sources = cellPairs.map(([left, right]) => Float32Array.from([left!, right!, 10, 20, 30]))
    const references = checkEveryCompileMode(circuit, [clampRead, zeroRead], sources)
    cellPairs.forEach(([left, right], sourceIndex) => {
      const index = Math.fround(Math.fround(left!) - Math.fround(right!))
      expect(Object.is(references[sourceIndex]![clampRead], expectedIndexRead(index, [10, 20, 30], 'clamp', 'clamp'))).toBe(true)
      expect(Object.is(references[sourceIndex]![zeroRead], expectedIndexRead(index, [10, 20, 30], 'zero', 'zero'))).toBe(true)
    })
    expect(Number.isNaN(references[0]![clampRead]!)).toBe(true)
    expect(() => validateIndexReads(circuit, references[3]!)).toThrow()
    expect(() => validateIndexReads(circuit, references[0]!)).toThrow()
  })

  test('differential: equals the dense one-hot masked sum on random tables, at both ends and out of range', () => {
    const random = createRandom(0x1dea)
    const extremes = [-0, 0, largestFloat32, -largestFloat32, smallestSubnormalFloat32]
    let comparisons = 0
    let loweredDenseReads = 0
    let tablesWithSeveralEntries = 0
    for (let trial = 0; trial < 240; trial++) {
      const style: DenseStyle = trial % 2 === 0 ? 'clamp' : 'zero-above'
      const count = 1 + randomInteger(random, 40)
      const pair = buildPair(count, style, largestFloat32)
      loweredDenseReads += programCounts(pair.dense.compileTensorProgram([pair.denseRead])).gatherReads
      if (count > 1) tablesWithSeveralEntries++
      const tableValues = Array.from({length: count}, () => random() < 0.15
        ? extremes[randomInteger(random, extremes.length)]!
        : Math.fround((random() * 2 - 1) * 1000))
      const indices = [
        0,
        count - 1,
        randomInteger(random, count),
        -1,
        -8,
        -randomInteger(random, 8),
        count,
        count + 8,
        count + randomInteger(random, 8),
      ]
      const sources = indices.map(index => Float32Array.from([index, ...tableValues]))
      const denseReferences = checkEveryCompileMode(pair.dense, [pair.denseRead], sources)
      const instructionReferences = checkEveryCompileMode(pair.instruction, [pair.instructionRead], sources)
      indices.forEach((index, sourceIndex) => {
        const expected = expectedIndexRead(index, tableValues, 'clamp', pair.above)
        const instructionValue = instructionReferences[sourceIndex]![pair.instructionRead]!
        const denseValue = denseReferences[sourceIndex]![pair.denseRead]!
        expect(Object.is(instructionValue, expected)).toBe(true)
        // The masked sum starts from +0, so a selected -0 comes out as +0.
        expect(Object.is(denseValue, expected === 0 ? 0 : expected)).toBe(true)
        expect(instructionValue === denseValue).toBe(true)
        validateIndexReads(pair.instruction, instructionReferences[sourceIndex]!)
        validateOneHotGroups(pair.dense, denseReferences[sourceIndex]!)
        comparisons++
      })
    }
    expect(comparisons).toBe(240 * 9)
    // Every dense table with more than one entry lowered to a gather, so the
    // comparison also covers the shared runtime's gather reads.
    expect(loweredDenseReads).toBeGreaterThanOrEqual(tablesWithSeveralEntries)
  })

  test('signed zero: a selected -0 comes through the read, while the masked sum returns +0', () => {
    const pair = buildPair(3, 'zero-above', 100)
    const sources = [Float32Array.from([0, -0, 5, 7]), Float32Array.from([3, -0, 5, 7])]
    const instructionReferences = checkEveryCompileMode(pair.instruction, [pair.instructionRead], sources)
    const denseReferences = checkEveryCompileMode(pair.dense, [pair.denseRead], sources)
    expect(Object.is(instructionReferences[0]![pair.instructionRead], -0)).toBe(true)
    expect(Object.is(denseReferences[0]![pair.denseRead], 0)).toBe(true)
    // Past the end, the 'zero' side reads +0.
    expect(Object.is(instructionReferences[1]![pair.instructionRead], 0)).toBe(true)
  })

  test('infinite candidates: the read returns the selected value; the masked sum turns into NaN and stays dense', () => {
    const pair = buildPair(4, 'clamp', Number.POSITIVE_INFINITY)
    expect(programCounts(pair.dense.compileTensorProgram([pair.denseRead])).gatherReads).toBe(0)
    const sources = [
      Float32Array.from([1, Number.POSITIVE_INFINITY, 5, 6, 7]),
      Float32Array.from([0, Number.POSITIVE_INFINITY, 5, 6, 7]),
      Float32Array.from([2, 1, 2, Number.NEGATIVE_INFINITY, 7]),
    ]
    const instructionReferences = checkEveryCompileMode(pair.instruction, [pair.instructionRead], sources)
    const denseReferences = checkEveryCompileMode(pair.dense, [pair.denseRead], sources)
    expect(instructionReferences.map(values => values[pair.instructionRead])).toEqual([5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    expect(Number.isNaN(denseReferences[0]![pair.denseRead]!)).toBe(true)
    // A selected infinity survives the masked sum when every other candidate is finite.
    expect(denseReferences[1]![pair.denseRead]).toBe(Number.POSITIVE_INFINITY)
  })

  test('fractional indices: the read floors, while the ReLU one-hot interpolates', () => {
    const rowHeights = [28, 44, 28, 60, 36, 28, 52, 40]
    const pair = buildPair(rowHeights.length, 'clamp', 1000)
    const fractionalIndices = [2.5, 2.25, 0.5, 6.75]
    const sources = fractionalIndices.map(index => Float32Array.from([index, ...rowHeights]))
    const instructionReferences = checkEveryCompileMode(pair.instruction, [pair.instructionRead], sources)
    fractionalIndices.forEach((index, sourceIndex) => {
      const lowerPosition = Math.floor(index)
      const fraction = index - lowerPosition
      const interpolated = rowHeights[lowerPosition]! * (1 - fraction) + rowHeights[lowerPosition + 1]! * fraction
      expect(instructionReferences[sourceIndex]![pair.instructionRead]).toBe(rowHeights[lowerPosition])
      expect(pair.dense.evaluateReference(sources[sourceIndex]!)[pair.denseRead]).toBe(interpolated)
      expect(() => validateIndexReads(pair.instruction, instructionReferences[sourceIndex]!)).toThrow()
      expect(() => validateOneHotGroups(pair.dense, pair.dense.evaluateReference(sources[sourceIndex]!))).toThrow()
    })
    // The guide's example: 44 from the masked sum against 28 from the read.
    expect(pair.dense.evaluateReference(sources[0]!)[pair.denseRead]).toBe(44)
  })

  test('duplicate candidates, composed index forms, and chained reads match plain JavaScript', () => {
    const random = createRandom(7)
    const start = asWire(0)
    const nextStarts = Array.from({length: 10}, (_, position) => 1 + position)
    const payload = Array.from({length: 4}, (_, position) => 11 + position)
    const circuit = new Circuit(15)
    circuit.assumeRange(start, 0, 9)
    for (const wire of nextStarts) circuit.assumeRange(asWire(wire), 0, 9)
    for (const wire of payload) circuit.assumeRange(asWire(wire), -1000, 1000)
    const cursors: Wire[] = []
    let cursor: Wire = start
    for (let hop = 0; hop < 3; hop++) {
      cursor = circuit.indexRead(cursor, nextStarts.map(asWire))
      cursors.push(cursor)
    }
    // A small affine producer composes into the index form.
    const cursorPlusTwo = circuit.affine([[cursor, 1]], 2)
    const composedRead = circuit.indexRead(cursorPlusTwo, nextStarts.map(asWire), {outOfRange: 'zero'})
    const composedOperation = circuit.operations[composedRead - circuit.sourceSize]!
    expect(composedOperation.gateTerms).toEqual([[cursor, 1]])
    expect(composedOperation.gateBias).toBe(2)
    const repeatedTable = [payload[0]!, payload[0]!, payload[2]!, payload[1]!, payload[0]!]
    const shifted = circuit.indexReadAffine([[cursor, 1]], -7, repeatedTable.map(asWire), 'clamp', 'zero')
    const sameWire = circuit.indexReadAffine([[circuit.indexRead(cursors[1]!, nextStarts.map(asWire)), 1]], -7, ([...repeatedTable]).map(asWire), 'clamp', 'zero')
    expect(sameWire).toBe(shifted)
    const roots = [...cursors, composedRead, shifted]
    const sources = Array.from({length: 200}, () => {
      const source = new Float32Array(circuit.sourceSize)
      source[start] = randomInteger(random, 10)
      for (const wire of nextStarts) source[wire] = randomInteger(random, 10)
      for (const wire of payload) source[wire] = Math.fround((random() * 2 - 1) * 1000)
      return source
    })
    const references = checkEveryCompileMode(circuit, roots, sources)
    sources.forEach((source, sourceIndex) => {
      const values = references[sourceIndex]!
      validateIndexReads(circuit, values)
      let expectedCursor = source[start]!
      for (let hop = 0; hop < 3; hop++) {
        expectedCursor = source[nextStarts[expectedCursor]!]!
        expect(values[cursors[hop]!]).toBe(expectedCursor)
      }
      const nextStartValues = nextStarts.map(wire => source[wire]!)
      expect(values[composedRead]).toBe(expectedIndexRead(expectedCursor + 2, nextStartValues, 'zero', 'zero'))
      const repeatedValues = repeatedTable.map(wire => source[wire]!)
      expect(values[shifted]).toBe(expectedIndexRead(expectedCursor - 7, repeatedValues, 'clamp', 'zero'))
    })
  })

  test('evenly spaced tables store a base and a stride; other tables store positions shared by every read', () => {
    const count = 1024
    const circuit = new Circuit(1 + count)
    circuit.assumeRange(circuit.source(0), 0, count - 1)
    const values = Array.from({length: count}, (_, position) => 1 + position)
    for (const wire of values) circuit.assumeRange(asWire(wire), -1e6, 1e6)
    const contiguous = circuit.indexRead(circuit.source(0), values.map(asWire))
    const reversed = circuit.indexRead(circuit.source(0), [...values].reverse().map(asWire))
    const everyOther = circuit.indexRead(circuit.source(0), values.filter((_, position) => position % 2 === 1).map(asWire))
    const repeatedWire = circuit.indexRead(circuit.source(0), [asWire(values[5]!), asWire(values[5]!), asWire(values[5]!)])
    const random = createRandom(3)
    const shuffled = [...values].sort(() => random() - 0.5)
    const scattered = circuit.indexRead(circuit.source(0), shuffled.map(asWire))
    const scatteredNext = circuit.indexReadAffine([[circuit.source(0), 1]], 1, shuffled.map(asWire), 'clamp', 'zero')
    const contiguousProgram = circuit.compileTensorProgram([contiguous])
    expect(programCounts(contiguousProgram)).toEqual({liveOperations: 1, layers: 1, storedWeights: 1, gatherReads: 0, indexReads: 1})
    expect(contiguousProgram.layers[0]!.indexReads[0]!).toMatchObject({candidateCount: count, candidateBase: 1, candidateStride: 1})
    expect(contiguousProgram.layers[0]!.indexReads[0]!.candidatePositions.length).toBe(0)
    const roots = [contiguous, reversed, everyOther, repeatedWire, scattered, scatteredNext]
    const program = circuit.compileTensorProgram(roots)
    const readsByRow = new Map(program.layers[0]!.indexReads.map(read => [program.wireOrder[circuit.sourceSize + read.row], read]))
    expect(readsByRow.get(reversed)).toMatchObject({candidateBase: count, candidateStride: -1})
    expect(readsByRow.get(everyOther)).toMatchObject({candidateBase: 2, candidateStride: 2, candidateCount: count / 2})
    expect(readsByRow.get(repeatedWire)).toMatchObject({candidateBase: 6, candidateStride: 0, candidateCount: 3})
    for (const wire of [reversed, everyOther, repeatedWire]) {
      expect(readsByRow.get(wire)!.candidatePositions.length).toBe(0)
    }
    expect(readsByRow.get(scattered)!.candidatePositions.length).toBe(count)
    expect(readsByRow.get(scatteredNext)!.candidatePositions).toBe(readsByRow.get(scattered)!.candidatePositions)
    const sources = [0, 1, 511, 512, 1022, 1023].map(at => {
      const source = new Float32Array(circuit.sourceSize)
      source[0] = at
      for (let position = 0; position < count; position++) source[values[position]!] = position
      return source
    })
    const references = checkEveryCompileMode(circuit, roots, sources)
    sources.forEach((source, sourceIndex) => {
      const at = source[0]!
      const reference = references[sourceIndex]!
      expect(reference[contiguous]).toBe(at)
      expect(reference[reversed]).toBe(count - 1 - at)
      expect(reference[everyOther]).toBe(Math.min(2 * at + 1, count - 1))
      expect(reference[repeatedWire]).toBe(5)
      expect(reference[scattered]).toBe(shuffled[at]! - 1)
      expect(reference[scatteredNext]).toBe(at + 1 < count ? shuffled[at + 1]! - 1 : 0)
    })
  })

  test('candidate tables are registered once, frozen, and shared by arrays with the same content', () => {
    const circuit = new Circuit(6)
    circuit.assumeRange(circuit.source(0), 0, 3)
    const candidates = [1, 2, 3, 4].map(asWire)
    const first = circuit.indexRead(circuit.source(0), candidates)
    expect(circuit.indexRead(circuit.source(0), candidates)).toBe(first)
    expect(circuit.indexRead(circuit.source(0), [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)])).toBe(first)
    expect(circuit.indexRead(circuit.source(0), candidates, {outOfRange: 'zero'})).not.toBe(first)
    expect(circuit.indexRead(circuit.source(0), [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(5)])).not.toBe(first)
    expect(Object.isFrozen(candidates)).toBe(true)
    expect(() => candidates.push(circuit.source(5))).toThrow(TypeError)
  })

  test('a constant index selects its candidate while building', () => {
    const circuit = new Circuit(5)
    const three = circuit.affine([], 3)
    const nine = circuit.affine([], 9)
    expect(circuit.indexRead(three, [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)])).toBe(asWire(4))
    expect(circuit.indexRead(nine, [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)])).toBe(asWire(4))
    expect(circuit.indexReadAffine([[three, -1]], 1, [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)], 'clamp', 'zero')).toBe(asWire(1))
    const beyond = circuit.indexRead(nine, [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)], {outOfRange: 'zero'})
    expect(circuit.constants[beyond]).toBe(0)
    const belowZero = circuit.indexReadAffine([[three, 1]], -5, [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)], 'zero', 'clamp')
    expect(circuit.constants[belowZero]).toBe(0)
  })

  test('the builder refuses reads that break the contract', () => {
    const circuit = new Circuit(4)
    circuit.assumeRange(circuit.source(1), 0, 2 ** 24 - 1)
    circuit.assumeRange(circuit.source(2), -(2 ** 25), 0)
    // An index cell with no declared range, and one declared past -2^24.
    expect(() => circuit.indexRead(circuit.source(0), [circuit.source(3)])).toThrow('index range')
    expect(() => circuit.indexRead(circuit.source(2), [circuit.source(3)])).toThrow('index range')
    // Both endpoints must lie strictly inside ±2^24: 0..2^24 - 1 builds, and adding 1 reaches 2^24.
    expect(circuit.indexRead(circuit.source(1), [circuit.source(3)])).toBe(asWire(4))
    expect(() => circuit.indexReadAffine([[circuit.source(1), 1]], 1, [circuit.source(3)], 'clamp', 'clamp')).toThrow('strictly inside ±2^24')
    expect(() => circuit.indexRead(circuit.source(1), [])).toThrow('at least one candidate')
    expect(() => circuit.indexRead(circuit.source(1), [asWire(1000)])).toThrow('wire is outside')
    expect(() => circuit.indexRead(circuit.source(1), [circuit.source(3)], {outOfRange: 'wrap' as OutOfRange})).toThrow('clamp or zero')
    expect(() => circuit.indexReadAffine([[circuit.source(1), Number.NaN]], 0, [circuit.source(3)], 'clamp', 'clamp')).toThrow('finite')
    const positiveInfinity = circuit.affine([], Number.POSITIVE_INFINITY)
    const negativeInfinity = circuit.affine([], Number.NEGATIVE_INFINITY)
    expect(() => circuit.indexReadAffine([[positiveInfinity, 1], [negativeInfinity, 1]], 0, [circuit.source(3)], 'clamp', 'clamp'))
      .toThrow('must not be NaN')
  })

  test('an index range is accepted only strictly inside ±2^24, so an endpoint that FP32 rounded onto 2^24 is refused', () => {
    const circuit = new Circuit(4)
    circuit.assumeRange(circuit.source(0), 0, 2 ** 24)
    circuit.assumeRange(circuit.source(1), -(2 ** 24), 0)
    circuit.assumeRange(circuit.source(2), 0, 2 ** 24 - 2)
    // f(2^24 + 1) = 2^24, so the form's range ends on 2^24, and at cell value 2^24
    // the read would land one position early.
    expect(Math.fround(2 ** 24 + 1)).toBe(2 ** 24)
    expect(() => circuit.indexReadAffine([[circuit.source(0), 1]], 1, [circuit.source(3)], 'clamp', 'clamp')).toThrow('strictly inside ±2^24')
    expect(() => circuit.indexRead(circuit.source(0), [circuit.source(3)])).toThrow('strictly inside ±2^24')
    // The negative mirror: f(-2^24 - 1) = -2^24.
    expect(() => circuit.indexReadAffine([[circuit.source(1), 1]], -1, [circuit.source(3)], 'clamp', 'clamp')).toThrow('strictly inside ±2^24')
    expect(() => circuit.indexRead(circuit.source(1), [circuit.source(3)])).toThrow('strictly inside ±2^24')
    // One position inside the limit on either side builds.
    const upper = circuit.indexReadAffine([[circuit.source(2), 1]], 1, [circuit.source(3)], 'clamp', 'clamp')
    expect(circuit.operations[upper - circuit.sourceSize]!.indexRead!.indexRange).toEqual({minimum: 1, maximum: 2 ** 24 - 1})
    const lower = circuit.indexReadAffine([[circuit.source(2), -1]], -1, [circuit.source(3)], 'clamp', 'clamp')
    expect(circuit.operations[lower - circuit.sourceSize]!.indexRead!.indexRange).toEqual({minimum: -(2 ** 24 - 1), maximum: -1})
    // A range declared on the form can't put an endpoint on the limit either.
    expect(() => circuit.indexReadAffine([[circuit.source(0), 1]], 0, [circuit.source(3)], 'clamp', 'clamp', {indexRange: {minimum: 0, maximum: 2 ** 24}})).toThrow('strictly inside ±2^24')
    validateCircuit(circuit)
    const operation = circuit.operations[upper - circuit.sourceSize]!
    operation.indexRead = {...operation.indexRead!, indexRange: {minimum: 0, maximum: 2 ** 24}}
    expect(() => validateCircuit(circuit)).toThrow('strictly inside ±2^24')
  })

  test('the read range is the union of the reachable candidates, plus 0 where a zero side is reachable', () => {
    const circuit = new Circuit(9)
    const candidateRanges = [[0.5, 1], [2, 3], [-5, -4], [10, 20]] as const
    candidateRanges.forEach(([minimum, maximum], position) => circuit.assumeRange(asWire(1 + position), minimum, maximum))
    const candidates = [1, 2, 3, 4]
    const indexCell = (wire: Wire, minimum: number, maximum: number) => {
      circuit.assumeRange(wire, minimum, maximum)
      return wire
    }
    const inside = circuit.indexRead(indexCell(circuit.source(5), 1, 2), candidates.map(asWire))
    expect(circuit.ranges[inside]).toEqual({minimum: -5, maximum: 3})
    const zeroBelow = circuit.indexReadAffine([[indexCell(circuit.source(6), -3, 1), 1]], 0, candidates.map(asWire), 'zero', 'clamp')
    expect(circuit.ranges[zeroBelow]).toEqual({minimum: 0, maximum: 3})
    const clampBelow = circuit.indexReadAffine([[circuit.source(6), 1]], 0, candidates.map(asWire), 'clamp', 'clamp')
    expect(circuit.ranges[clampBelow]).toEqual({minimum: 0.5, maximum: 3})
    const zeroAbove = circuit.indexReadAffine([[indexCell(circuit.source(7), 2, 9), 1]], 0, candidates.map(asWire), 'clamp', 'zero')
    expect(circuit.ranges[zeroAbove]).toEqual({minimum: -5, maximum: 20})
    // Index ranges entirely below the table reach only the 'zero' side, whatever
    // their distance; they share one cached union, and each read gets its own object.
    const justBelow = circuit.indexReadAffine([[circuit.source(6), 1]], -2, candidates.map(asWire), 'zero', 'clamp')
    const fartherBelow = circuit.indexReadAffine([[circuit.source(6), 1]], -50, candidates.map(asWire), 'zero', 'clamp')
    expect(circuit.ranges[justBelow]).toEqual({minimum: 0, maximum: 0})
    expect(circuit.ranges[fartherBelow]).toEqual({minimum: 0, maximum: 0})
    expect(circuit.ranges[fartherBelow]).not.toBe(circuit.ranges[justBelow])
    const clampedFartherBelow = circuit.indexReadAffine([[circuit.source(6), 1]], -50, candidates.map(asWire), 'clamp', 'clamp')
    expect(circuit.ranges[clampedFartherBelow]).toEqual({minimum: 0.5, maximum: 1})
    // Cell 8 has no declared range. It opens the read's range only where the index can reach it.
    const unreachableUnknown = circuit.indexRead(circuit.source(5), [circuit.source(8), circuit.source(1)])
    expect(circuit.ranges[unreachableUnknown]).toEqual({minimum: 0.5, maximum: 1})
    const reachableUnknown = circuit.indexRead(circuit.source(5), [circuit.source(1), circuit.source(8)])
    expect(circuit.ranges[reachableUnknown]).toEqual({minimum: Number.NEGATIVE_INFINITY, maximum: Number.POSITIVE_INFINITY})
  })

  test('backward pass: the selected candidate gets the gradient; the index gradient is rejected by default', () => {
    const circuit = new Circuit(4)
    circuit.assumeRange(circuit.source(0), -2, 5)
    const candidates = [1, 2, 3]
    const read = circuit.indexRead(circuit.source(0), candidates.map(asWire), {outOfRange: 'zero'})
    const readAgain = circuit.indexReadAffine([[circuit.source(0), 1]], 0, candidates.map(asWire), 'clamp', 'clamp')
    const sum = circuit.roundAffine([[read, 3], [readAgain, 1]])
    const outputGradients = (values: Float32Array) => {
      const gradients = new Float32Array(values.length)
      gradients[sum] = 1
      return gradients
    }
    const values = circuit.evaluateReference(Float32Array.from([1, 10, 20, 40]))
    expect(() => circuit.backpropagateReference(values, outputGradients(values))).toThrow('indexGradient')
    const zeroGradients = circuit.backpropagateReference(values, outputGradients(values), {indexGradient: 'zero'})
    // Both reads select candidate 1, so its gradient adds, like a scatter-add.
    expect([...zeroGradients.subarray(0, 4)]).toEqual([0, 0, 4, 0])
    const differenceGradients = circuit.backpropagateReference(values, outputGradients(values), {indexGradient: 'backward-difference'})
    expect([...differenceGradients.subarray(0, 4)]).toEqual([3 * (20 - 10) + (20 - 10), 0, 4, 0])
    // Past the end, the 'zero' read selects nothing and the clamped read selects the last candidate.
    const pastEnd = circuit.evaluateReference(Float32Array.from([4, 10, 20, 40]))
    const pastEndGradients = circuit.backpropagateReference(pastEnd, outputGradients(pastEnd), {indexGradient: 'backward-difference'})
    expect([...pastEndGradients.subarray(0, 4)]).toEqual([0, 0, 0, 1])
    const atEnd = circuit.evaluateReference(Float32Array.from([3, 10, 20, 40]))
    const atEndGradients = circuit.backpropagateReference(atEnd, outputGradients(atEnd), {indexGradient: 'backward-difference'})
    expect([...atEndGradients.subarray(0, 4)]).toEqual([3 * (0 - 40) + (40 - 40), 0, 0, 1])
    // A zero output gradient never reaches the read, so it doesn't throw.
    expect(() => circuit.backpropagateReference(values, new Float32Array(values.length))).not.toThrow()
  })

  test('backward-difference equals the reference backward pass of both dense constructions', () => {
    const random = createRandom(0xbac4)
    for (const style of ['clamp', 'zero-above'] as const) {
      const count = 6
      const pair = buildPair(count, style, 1000)
      for (const tableKind of ['integer', 'fractional'] as const) {
        const tableValues = Array.from({length: count}, (_, position) => tableKind === 'integer'
          ? 10 * (position + 1) + position * position
          : Math.fround((random() * 2 - 1) * 100))
        for (let index = -3; index <= count + 2; index++) {
          const source = Float32Array.from([index, ...tableValues])
          const denseValues = pair.dense.evaluateReference(source)
          const denseOutputGradients = new Float32Array(denseValues.length)
          denseOutputGradients[pair.denseRead] = 1
          const denseGradients = pair.dense.backpropagateReference(denseValues, denseOutputGradients)
          const instructionValues = pair.instruction.evaluateReference(source)
          const instructionOutputGradients = new Float32Array(instructionValues.length)
          instructionOutputGradients[pair.instructionRead] = 1
          const instructionGradients = pair.instruction.backpropagateReference(
            instructionValues,
            instructionOutputGradients,
            {indexGradient: 'backward-difference'},
          )
          for (let wire = 0; wire < pair.sourceSize; wire++) {
            if (tableKind === 'integer' || wire !== pair.index) {
              expect(instructionGradients[wire]).toBe(denseGradients[wire])
            } else {
              // The dense pass adds and cancels one pair of terms per step, which
              // rounds in FP32 when the table holds fractions.
              expect(Math.abs(instructionGradients[wire]! - denseGradients[wire]!)).toBeLessThan(1e-3)
            }
          }
        }
      }
    }
  })

  test('recomputed depths: a lowered gather read stops waiting for the products it replaced', () => {
    const scoreCount = 5
    const circuit = new Circuit(2 * scoreCount + 1)
    const unit = 2 * scoreCount
    circuit.assumeRange(asWire(unit), 1, 1)
    const scores = Array.from({length: scoreCount}, (_, item) => item)
    const values = Array.from({length: scoreCount}, (_, item) => scoreCount + item)
    for (const score of scores) circuit.assumeRange(asWire(score), 0, 1)
    for (const value of values) circuit.assumeRange(asWire(value), -100, 100)
    const {selected} = emitArgmax(circuit, scores.map(asWire), asWire(unit))
    const selectedValue = circuit.roundAffine(selected.map((bit, item) => [circuit.multiply(bit, asWire(values[item]!)), 1] as const))
    const downstream = circuit.roundAffine([[selectedValue, 2]], 1)
    // The compiled program skips depths with no live operation, so the removed
    // products only cost a layer while another live operation shares their depth.
    const deepestBit = selected.reduce((deepest, bit) => (circuit.depths[bit]! > circuit.depths[deepest]! ? bit : deepest))
    const bitCopy = circuit.roundAffine([[deepestBit, 3]])
    const roots = [downstream, bitCopy]
    const buildTimeProgram = circuit.compileTensorProgram(roots)
    const recomputedProgram = circuit.compileTensorProgram(roots, true, {recomputeDepths: true})
    expect(programCounts(buildTimeProgram).gatherReads).toBe(1)
    expect(programCounts(recomputedProgram).layers).toBe(programCounts(buildTimeProgram).layers - 1)
    expect(programCounts(recomputedProgram).liveOperations).toBe(programCounts(buildTimeProgram).liveOperations)
    // Without bitCopy, the empty depth is already skipped and both give the same layer count.
    expect(programCounts(circuit.compileTensorProgram([downstream], true, {recomputeDepths: true})).layers)
      .toBe(programCounts(circuit.compileTensorProgram([downstream])).layers)
    // Off by default.
    expect(circuit.compileTensorProgram(roots, true, {recomputeDepths: false})).toEqual(buildTimeProgram)
    const random = createRandom(11)
    const sources = Array.from({length: 40}, () => {
      const source = new Float32Array(circuit.sourceSize)
      for (const score of scores) source[score] = randomInteger(random, 5) / 4
      for (const value of values) source[value] = Math.fround((random() * 2 - 1) * 100)
      source[unit] = 1
      return source
    })
    checkEveryCompileMode(circuit, [...roots, selectedValue], sources)
  })

  test('random circuits mixing index reads, products, selects and gathers agree in every compile mode', () => {
    const random = createRandom(0x51de)
    const coefficients = [1 / 3, -0.7, 2, -1, 12_345.6789, 0.1]
    let indexReadsChecked = 0
    let loweredGatherReads = 0
    for (let circuitIndex = 0; circuitIndex < 120; circuitIndex++) {
      const integerCellCount = 2 + randomInteger(random, 3)
      const valueCellCount = 2 + randomInteger(random, 4)
      const extremeCellCount = 1 + randomInteger(random, 2)
      const unitCellCount = 3
      const sourceSize = integerCellCount + valueCellCount + extremeCellCount + unitCellCount + 1
      const unit = sourceSize - 1
      const circuit = new Circuit(sourceSize)
      const integerLimit = 12
      const integerWires: Wire[] = []
      const finiteWires: Wire[] = []
      const anyWires: Wire[] = []
      const unitWires: Wire[] = []
      let cell = 0
      for (let item = 0; item < integerCellCount; item++, cell++) {
        circuit.assumeRange(asWire(cell), -integerLimit, integerLimit)
        integerWires.push(asWire(cell))
        finiteWires.push(asWire(cell))
      }
      for (let item = 0; item < valueCellCount; item++, cell++) {
        circuit.assumeRange(asWire(cell), -100, 100)
        finiteWires.push(asWire(cell))
      }
      for (let item = 0; item < extremeCellCount; item++, cell++) anyWires.push(asWire(cell))
      for (let item = 0; item < unitCellCount; item++, cell++) {
        circuit.assumeRange(asWire(cell), 0, 1)
        unitWires.push(asWire(cell))
      }
      circuit.assumeRange(asWire(unit), 1, 1)
      anyWires.push(...finiteWires)
      const pick = <Item>(items: readonly Item[]) => items[randomInteger(random, items.length)]!
      // Plain JavaScript intent for every index read, checked against the reference evaluator.
      const intents: {wire: Wire, indexWire: Wire, bias: number, candidates: Wire[], below: OutOfRange, above: OutOfRange}[] = []
      const readTable = (candidates: Wire[]) => {
        const indexWire = pick(integerWires)
        const bias = randomInteger(random, 7) - 3
        const below: OutOfRange = random() < 0.5 ? 'clamp' : 'zero'
        const above: OutOfRange = random() < 0.5 ? 'clamp' : 'zero'
        const wire = circuit.indexReadAffine([[indexWire, 1]], bias, candidates, below, above)
        intents.push({wire, indexWire, bias, candidates, below, above})
        return wire
      }
      const operationCount = 8 + randomInteger(random, 12)
      for (let operation = 0; operation < operationCount; operation++) {
        const choice = randomInteger(random, 7)
        if (choice === 0) {
          const wire = circuit.affine([[pick(finiteWires), pick(coefficients)], [pick(finiteWires), pick(coefficients)]], pick(coefficients))
          anyWires.push(wire)
        } else if (choice === 1) {
          anyWires.push(circuit.multiply(pick(anyWires), pick(anyWires)))
        } else if (choice === 2) {
          const bit = circuit.boolean(pick(unitWires))
          anyWires.push(circuit.select(bit, pick(finiteWires), pick(finiteWires)))
        } else if (choice === 3) {
          // A table of integer wires reads an integer, which can index again.
          const table = Array.from({length: 1 + randomInteger(random, 8)}, () => pick(integerWires))
          const wire = readTable(table)
          integerWires.push(wire)
          finiteWires.push(wire)
          anyWires.push(wire)
        } else if (choice === 4) {
          anyWires.push(readTable(Array.from({length: 1 + randomInteger(random, 10)}, () => pick(anyWires))))
        } else if (choice === 5) {
          const wire = readTable(Array.from({length: 1 + randomInteger(random, 10)}, () => pick(finiteWires)))
          finiteWires.push(wire)
          anyWires.push(wire)
        } else {
          // An argmax selection whose masked sum reads finite wires, e.g. index reads, and lowers to a gather.
          const scores = Array.from({length: 2 + randomInteger(random, 3)}, () => pick(unitWires))
          const {selected} = emitArgmax(circuit, scores, asWire(unit))
          const wire = circuit.roundAffine(selected.map(bit => [circuit.multiply(bit, pick(finiteWires)), 1] as const))
          finiteWires.push(wire)
          anyWires.push(wire)
        }
      }
      const roots = anyWires.filter(wire => wire >= sourceSize && random() < 0.6)
      if (roots.length === 0) roots.push(anyWires.at(-1)!)
      loweredGatherReads += programCounts(circuit.compileTensorProgram(roots)).gatherReads
      const extremes = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, largestFloat32, smallestSubnormalFloat32]
      const sources = Array.from({length: 6}, () => {
        const source = new Float32Array(sourceSize)
        let sourceCell = 0
        for (let item = 0; item < integerCellCount; item++) source[sourceCell++] = randomInteger(random, 2 * integerLimit + 1) - integerLimit
        for (let item = 0; item < valueCellCount; item++) source[sourceCell++] = Math.fround((random() * 2 - 1) * 100)
        for (let item = 0; item < extremeCellCount; item++) source[sourceCell++] = pick(extremes)
        for (let item = 0; item < unitCellCount; item++) source[sourceCell++] = randomInteger(random, 5) / 4
        source[unit] = 1
        return source
      })
      const references = checkEveryCompileMode(circuit, roots, sources)
      for (const values of references) {
        validateIndexReads(circuit, values)
        for (const intent of intents) {
          const expected = expectedIndexRead(
            values[intent.indexWire]! + intent.bias,
            intent.candidates.map(candidate => values[candidate]!),
            intent.below,
            intent.above,
          )
          if (!Object.is(values[intent.wire], expected)) {
            throw new Error(`circuit ${circuitIndex}: read ${intent.wire} got ${values[intent.wire]}, expected ${expected}`)
          }
          indexReadsChecked++
        }
      }
    }
    expect(indexReadsChecked).toBeGreaterThan(2000)
    expect(loweredGatherReads).toBeGreaterThan(20)
  })

  test('recomputing depths without lowered gathers reproduces the build-time program', () => {
    const random = createRandom(0xdee9)
    for (let circuitIndex = 0; circuitIndex < 40; circuitIndex++) {
      const circuit = new Circuit(6)
      for (let wire = 0; wire < 3; wire++) circuit.assumeRange(asWire(wire), 0, 7)
      const integerWires: Wire[] = [asWire(0), asWire(1), asWire(2)]
      const wires: Wire[] = [asWire(0), asWire(1), asWire(2), asWire(3), asWire(4), asWire(5)]
      for (let operation = 0; operation < 25; operation++) {
        const choice = randomInteger(random, 3)
        if (choice === 0) {
          const table = Array.from({length: 1 + randomInteger(random, 6)}, () => integerWires[randomInteger(random, integerWires.length)]!)
          const wire = circuit.indexRead(integerWires[randomInteger(random, integerWires.length)]!, table)
          integerWires.push(wire)
          wires.push(wire)
        } else if (choice === 1) {
          wires.push(circuit.reglu([[wires[randomInteger(random, wires.length)]!, 1]], 0.5, [[wires[randomInteger(random, wires.length)]!, -1]], 2))
        } else {
          wires.push(circuit.roundAffine([[wires[randomInteger(random, wires.length)]!, 3], [wires[randomInteger(random, wires.length)]!, 1]]))
        }
      }
      const roots = wires.filter(wire => wire >= circuit.sourceSize && random() < 0.5)
      expect(circuit.compileTensorProgram(roots, false, {recomputeDepths: true})).toEqual(circuit.compileTensorProgram(roots, false))
    }
  })

  test('a range declared on the index wire counts, also when the builder copies a small affine index into the read', () => {
    // Cells 0 and 1 (firstRow and offset) have no declared ranges. Candidate cell k is within 10k..10k + 5.
    const circuit = new Circuit(6)
    for (let wire = 2; wire < 6; wire++) circuit.assumeRange(asWire(wire), 10 * wire, 10 * wire + 5)
    const candidates = [2, 3, 4, 5]
    const row = circuit.affine([[circuit.source(0), 1], [circuit.source(1), 1]])
    expect(() => circuit.indexRead(row, candidates.map(asWire))).toThrow('index range')
    circuit.assumeRange(row, 0, 3)
    const read = circuit.indexRead(row, candidates.map(asWire), {outOfRange: 'zero'})
    // The read copies firstRow + offset, so the affine row isn't live.
    expect(circuit.operations[read - circuit.sourceSize]!.gateTerms).toEqual([[circuit.source(0), 1], [circuit.source(1), 1]])
    expect(programCounts(circuit.compileTensorProgram([read])).liveOperations).toBe(1)
    // The declared range 0..3 can't reach the zero sides.
    expect(circuit.ranges[read]).toEqual({minimum: 20, maximum: 55})
    const sources = [[0, 0], [1, 2], [3, 0], [-1, 2], [2, 2], [-3, 1]].map(([firstRow, offset]) => Float32Array.from([firstRow!, offset!, 20, 30, 40, 50]))
    const references = checkEveryCompileMode(circuit, [read], sources)
    references.forEach((values, sourceIndex) => {
      const index = sources[sourceIndex]![0]! + sources[sourceIndex]![1]!
      expect(Object.is(values[read], expectedIndexRead(index, [20, 30, 40, 50], 'zero', 'zero'))).toBe(true)
      // validateIndexReads checks the declared range: firstRow + offset = 4 or -2 fails, although both cells are undeclared.
      if (index >= 0 && index <= 3) validateIndexReads(circuit, values)
      else expect(() => validateIndexReads(circuit, values)).toThrow('index read wire')
    })
    // indexReadAffine takes the same promise as an option. Without it, the same form is refused, although a read of it exists.
    expect(() => circuit.indexReadAffine([[circuit.source(0), 1], [circuit.source(1), 1]], 0, candidates.map(asWire), 'zero', 'zero')).toThrow('index range')
    expect(circuit.indexReadAffine([[circuit.source(0), 1], [circuit.source(1), 1]], 0, candidates.map(asWire), 'zero', 'zero', {indexRange: {minimum: 0, maximum: 3}})).toBe(read)
    expect(() => circuit.indexReadAffine([[circuit.source(0), 1], [circuit.source(1), 1]], 0, candidates.map(asWire), 'zero', 'zero', {indexRange: {minimum: 0, maximum: 2 ** 25}}))
      .toThrow('index range')
    // Inlining keeps the accepted range, although the target infers the copied form from undeclared cells again.
    const parent = new Circuit(6)
    const wireMap = inlineCircuit(parent, circuit, [parent.source(0), parent.source(1), parent.source(2), parent.source(3), parent.source(4), parent.source(5)])
    expect(parent.ranges[wireMap[read]!]).toEqual({minimum: 20, maximum: 55})
    const parentReferences = checkEveryCompileMode(parent, [wireMap[read]!], sources)
    parentReferences.forEach((values, sourceIndex) => expect(Object.is(values[wireMap[read]!], references[sourceIndex]![read])).toBe(true))

    // A declared range narrows which candidates the read can reach, and operands with wide ranges don't matter.
    const wide = new Circuit(6)
    wide.assumeRange(wide.source(0), 0, 2 ** 30)
    wide.assumeRange(wide.source(1), 0, 2 ** 30)
    for (let wire = 2; wire < 6; wire++) wide.assumeRange(asWire(wire), 10 * wire, 10 * wire + 5)
    const difference = wide.affine([[wide.source(0), 1], [wide.source(1), -1]])
    expect(() => wide.indexRead(difference, candidates.map(asWire))).toThrow('index range')
    wide.assumeRange(difference, 1, 2)
    const narrowRead = wide.indexRead(difference, candidates.map(asWire))
    expect(wide.ranges[narrowRead]).toEqual({minimum: 30, maximum: 45})
    // FP32 holds each operand exactly, e.g. not 2^30 - 1, which rounds to 2^30.
    const wideSources = [[2 ** 24 - 1, 2 ** 24 - 3], [2 ** 23 + 2, 2 ** 23 + 1], [7, 6]].map(([left, right]) => Float32Array.from([left!, right!, 20, 30, 40, 50]))
    for (const values of checkEveryCompileMode(wide, [narrowRead], wideSources)) {
      validateIndexReads(wide, values)
      expect(values[narrowRead]).toBe(values[0]! - values[1]! === 1 ? 30 : 40)
    }
    // A declared range that contradicts the inferred one is refused.
    const contradiction = new Circuit(3)
    contradiction.assumeRange(contradiction.source(0), 0, 3)
    expect(() => contradiction.indexReadAffine([[contradiction.source(0), 1]], 0, [contradiction.source(1), contradiction.source(2)], 'clamp', 'clamp', {indexRange: {minimum: 5, maximum: 9}}))
      .toThrow('contradicts')
  })

  test('inlining carries index reads, and the inlined circuit agrees with the original', () => {
    const child = new Circuit(5)
    child.assumeRange(child.source(0), 0, 3)
    for (let wire = 1; wire < 5; wire++) child.assumeRange(asWire(wire), -10, 10)
    const doubled = Array.from({length: 4}, (_, position) => child.roundAffine([[asWire(1 + position), 2]]))
    const readSource = child.indexRead(child.source(0), [child.source(1), child.source(2), child.source(3), child.source(4)], {outOfRange: 'zero'})
    const readComputed = child.indexReadAffine([[child.source(0), 1]], 1, doubled, 'clamp', 'zero')
    const parent = new Circuit(5)
    const sourceWires = [4, 3, 2, 1, 0]
    const wireMap = inlineCircuit(parent, child, sourceWires.map(asWire))
    expect(inlineCircuit(parent, child, sourceWires.map(asWire))).toEqual(wireMap)
    const random = createRandom(5)
    for (let trial = 0; trial < 50; trial++) {
      const childSource = Float32Array.from([randomInteger(random, 4), ...Array.from({length: 4}, () => randomInteger(random, 21) - 10)])
      const parentSource = new Float32Array(5)
      sourceWires.forEach((parentWire, childWire) => {
        parentSource[parentWire] = childSource[childWire]!
      })
      const childValues = child.evaluateReference(childSource)
      const parentValues = checkEveryCompileMode(parent, [wireMap[readSource]!, wireMap[readComputed]!], [parentSource])[0]!
      expect(parentValues[wireMap[readSource]!]).toBe(childValues[readSource])
      expect(parentValues[wireMap[readComputed]!]).toBe(childValues[readComputed])
    }
  })

  test('validators reject malformed index read programs and circuits', () => {
    const circuit = new Circuit(8)
    circuit.assumeRange(circuit.source(0), 0, 5)
    const gate = circuit.reglu([[circuit.source(1), 1]], 0, [[circuit.source(2), 1]], 0)
    const contiguousRead = circuit.indexRead(circuit.source(0), [circuit.source(1), circuit.source(2), circuit.source(3), circuit.source(4)])
    const scatteredRead = circuit.indexRead(circuit.source(0), [circuit.source(5), circuit.source(1), circuit.source(7), circuit.source(6)])
    const roots = [gate, contiguousRead, scatteredRead]
    const program = circuit.compileTensorProgram(roots)
    validateTensorProgram(circuit, program)
    const corrupt = (change: (layer: TensorProgram['layers'][number]) => void) => {
      const copy = structuredClone(program)
      change(copy.layers[0]!)
      return () => validateTensorProgram(circuit, copy)
    }
    const contiguousIndex = program.layers[0]!.indexReads.findIndex(read => read.candidatePositions.length === 0)
    const scatteredIndex = 1 - contiguousIndex
    expect(corrupt(layer => {
      layer.indexReads[0]!.indexRow = layer.outputSize
    })).toThrow('index row must follow the gate rows')
    expect(corrupt(layer => {
      layer.indexReads[1]!.indexRow = layer.indexReads[0]!.indexRow
    })).toThrow('index row must be unique')
    expect(corrupt(layer => {
      layer.indexReads[1]!.row = layer.indexReads[0]!.row
    })).toThrow('output row must be unique')
    expect(corrupt(layer => {
      layer.indexReads[contiguousIndex]!.candidateBase = 7
    })).toThrow('not available')
    expect(corrupt(layer => {
      layer.indexReads[contiguousIndex]!.candidateStride = -2
    })).toThrow('not available')
    expect(corrupt(layer => {
      layer.indexReads[scatteredIndex]!.candidatePositions = Uint8Array.from([5, 1, 8, 6])
    })).toThrow('not available')
    expect(corrupt(layer => {
      layer.indexReads[scatteredIndex]!.candidateCount = 3
    })).toThrow('size mismatch')
    expect(corrupt(layer => {
      layer.indexReads.pop()
    })).toThrow('projection bias shape mismatch')
    const operation = circuit.operations[contiguousRead - circuit.sourceSize]!
    const table = operation.indexRead!.table
    operation.indexRead = {...operation.indexRead!, table: {...table, candidates: [asWire(1), contiguousRead]}}
    expect(() => validateCircuit(circuit)).toThrow('earlier wires')
    operation.indexRead = {...operation.indexRead, table}
    validateCircuit(circuit)
  })
})

describe('proven bits', () => {
  test('emitFirstActive declares a one-hot group over comparison bits and index reads of proven bits, and not over a sign cascade stage or a reachable fraction', () => {
    const circuit = new Circuit(8)
    // Cells 0 and 1: pointer coordinates on a 1/64 grid. Cells 2 and 3: widths with
    // no grid. Cell 4: a row index. Cell 5: a fraction. Cell 6: a bit the host writes.
    for (const wire of [0, 1]) {
      circuit.assumeRange(asWire(wire), -1024, 1024)
      circuit.assumeGrid(asWire(wire), 1 / 64)
    }
    circuit.assumeRange(circuit.source(2), 0, 16_384)
    circuit.assumeRange(circuit.source(3), 0, 16_384)
    circuit.assumeRange(circuit.source(4), 0, 2)
    circuit.assumeRange(circuit.source(5), 0, 1)
    circuit.assumeRange(circuit.source(6), 0, 1)
    const groupCount = () => circuit.oneHotGroups.length
    const gridBit = emitCompare(circuit, circuit.source(0), '>=', circuit.source(1))
    const cascadeBit = emitCompare(circuit, circuit.source(2), '>', circuit.source(3))
    const atomBit = emitCompare(circuit, circuit.source(2), '===', circuit.source(3), {endWithBoolean: true})
    const active = circuit.boolean(circuit.source(6))
    emitFirstActive(circuit, active, [gridBit, cascadeBit, atomBit])
    expect(groupCount()).toBe(1)
    // A clamp stage's output within 0..1 is recorded as a sign cascade rounding point, and isn't a bit.
    const stage = circuit.operations
      .map((operation, operationIndex) => ({operation, wire: circuit.sourceSize + operationIndex}))
      .find(({operation, wire}) =>
        operation.roundingPoint === 'sign cascade' && operation.kind === 'affine'
        && circuit.ranges[wire]!.minimum === 0 && circuit.ranges[wire]!.maximum === 1)
    expect(stage).toBeDefined()
    emitFirstActive(circuit, active, [gridBit, asWire(stage!.wire)])
    expect(groupCount()).toBe(1)
    // Reads of bits, a side that reads +0, and a read of reads.
    const table = [gridBit, cascadeBit, atomBit]
    const clampedRead = circuit.indexRead(circuit.source(4), table)
    const zeroRead = circuit.indexReadAffine([[circuit.source(4), 1]], 1, table, 'zero', 'zero')
    const readOfReads = circuit.indexReadAffine([[circuit.source(4), 1]], -1, [clampedRead, zeroRead], 'zero', 'clamp')
    emitFirstActive(circuit, active, [clampedRead, zeroRead, readOfReads])
    expect(groupCount()).toBe(2)
    // A fraction in the table only matters when the index can reach it.
    const withFraction = [gridBit, cascadeBit, 5]
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], 1, withFraction.map(asWire), 'clamp', 'clamp')])
    expect(groupCount()).toBe(2)
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], -2, withFraction.map(asWire), 'zero', 'clamp')])
    expect(groupCount()).toBe(3)
    // Index -1..1 over 2 candidates reaches the fraction directly at position 0, and
    // through the clamp below. The +0 side above can't be reached.
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], -1, [circuit.source(5), cascadeBit], 'clamp', 'zero')])
    expect(groupCount()).toBe(3)
    // Index 2..4 over 2 candidates only reaches past the end: 'clamp' above reads the
    // last candidate, a fraction, and 'zero' above reads +0.
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], 2, [gridBit, circuit.source(5)], 'zero', 'clamp')])
    expect(groupCount()).toBe(3)
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], 2, [gridBit, circuit.source(5)], 'clamp', 'zero')])
    expect(groupCount()).toBe(4)
    // The mirror: index -4..-2 only reaches before the start.
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], -4, [circuit.source(5), gridBit], 'clamp', 'zero')])
    expect(groupCount()).toBe(4)
    emitFirstActive(circuit, active, [gridBit, circuit.indexReadAffine([[circuit.source(4), 1]], -4, [circuit.source(5), gridBit], 'zero', 'clamp')])
    expect(groupCount()).toBe(5)
    // Inlining keeps the comparison bits proven.
    const parent = new Circuit(8)
    const wireMap = inlineCircuit(parent, circuit, [parent.source(0), parent.source(1), parent.source(2), parent.source(3), parent.source(4), parent.source(5), parent.source(6), parent.source(7)])
    const parentGroups = parent.oneHotGroups.length
    emitFirstActive(parent, wireMap[active]!, [wireMap[gridBit]!, wireMap[cascadeBit]!, wireMap[zeroRead]!])
    expect(parent.oneHotGroups.length).toBe(parentGroups + 1)
  })

  test('gather lowering gives the same values as the dense compile over random circuits whose selections read comparison bits and index reads of bits', () => {
    const random = createRandom(0xb175)
    const relations = ['>', '>=', '<', '<=', '==='] as const
    let groupsOverComparisonsOrReads = 0
    let undeclaredSelections = 0
    let loweredGatherReads = 0
    let readsOnlyThroughASide = 0
    let sourcesChecked = 0
    for (let circuitIndex = 0; circuitIndex < 80; circuitIndex++) {
      // Integer cells within -6..6 on a grid of 1, pointer cells within ±512 on a 1/64
      // grid, widths within 0..4,096 with no grid, fractions within 0..1, and values within ±100.
      const integerCells = [0, 1, 2]
      const pointerCells = [3, 4]
      const widthCells = [5, 6]
      const fractionCells = [7, 8, 9]
      const valueCells = [10, 11, 12]
      const circuit = new Circuit(13)
      for (const wire of integerCells) {
        circuit.assumeRange(asWire(wire), -6, 6)
        circuit.assumeGrid(asWire(wire), 1)
      }
      for (const wire of pointerCells) {
        circuit.assumeRange(asWire(wire), -512, 512)
        circuit.assumeGrid(asWire(wire), 1 / 64)
      }
      for (const wire of widthCells) circuit.assumeRange(asWire(wire), 0, 4096)
      for (const wire of fractionCells) circuit.assumeRange(asWire(wire), 0, 1)
      for (const wire of valueCells) circuit.assumeRange(asWire(wire), -100, 100)
      const pick = <Item>(items: readonly Item[]) => items[randomInteger(random, items.length)]!
      // What the test knows to be bits, and wires within 0..1 that can hold fractions.
      const bits: Wire[] = []
      const unitWires: Wire[] = fractionCells.map(asWire)
      const comparisonsAndReads = new Set<Wire>()
      const values: Wire[] = valueCells.map(asWire)
      const roots: Wire[] = []
      const operationCount = 12 + randomInteger(random, 12)
      for (let operation = 0; operation < operationCount; operation++) {
        const choice = randomInteger(random, 6)
        if (choice === 0 || bits.length < 2) {
          const operands = random() < 0.4 ? pointerCells : random() < 0.5 ? widthCells : integerCells
          const bit = emitCompare(circuit, asWire(pick(operands)), pick(relations), asWire(pick(operands)), {endWithBoolean: random() < 0.25})
          bits.push(bit)
          comparisonsAndReads.add(bit)
        } else if (choice === 1) {
          bits.push(circuit.boolean(asWire(pick(fractionCells))))
        } else if (choice === 2) {
          // A table of bits, sometimes with a fraction, read at an integer cell with random sides.
          const table = Array.from({length: 1 + randomInteger(random, 5)}, () => (random() < 0.15 ? pick(unitWires) : pick(bits)))
          const indexCell = pick(integerCells)
          // Biases within -9..9 over integer cells within -6..6, so some reads reach
          // their table only through a side, e.g. bias 9 over a table of 2 bits.
          const bias = randomInteger(random, 19) - 9
          const below: OutOfRange = random() < 0.5 ? 'clamp' : 'zero'
          const above: OutOfRange = random() < 0.5 ? 'clamp' : 'zero'
          const read = circuit.indexReadAffine([[asWire(indexCell), 1]], bias, table, below, above)
          if (-6 + bias > table.length - 1 || 6 + bias < 0) readsOnlyThroughASide++
          // The two pools never share a wire, so a table of bits only holds wires from `bits`.
          if (table.every(wire => bits.includes(wire))) bits.push(read)
          else unitWires.push(read)
          comparisonsAndReads.add(read)
        } else if (choice === 3) {
          // A selection over bits, sometimes with a fraction, and a masked sum over it.
          const candidates = Array.from({length: 2 + randomInteger(random, 4)}, () => (random() < 0.85 ? pick(bits) : pick(unitWires)))
          const active = random() < 0.85 ? pick(bits) : pick(unitWires)
          const groupsBefore = circuit.oneHotGroups.length
          const selected = emitFirstActive(circuit, active, candidates)
          if (circuit.oneHotGroups.length > groupsBefore) {
            if ([active, ...candidates].some(wire => comparisonsAndReads.has(wire))) groupsOverComparisonsOrReads++
          } else {
            undeclaredSelections++
          }
          const sum = circuit.roundAffine(selected.map(member => [circuit.multiply(member, pick(values)), 1] as const))
          values.push(sum)
          roots.push(sum)
          unitWires.push(...selected)
        } else if (choice === 4) {
          values.push(circuit.indexRead(asWire(pick(integerCells)), Array.from({length: 1 + randomInteger(random, 4)}, () => pick(values))))
        } else {
          roots.push(circuit.select(pick(bits), pick(values), pick(values)))
        }
      }
      if (roots.length === 0) roots.push(values.at(-1)!)
      roots.push(...bits.filter(() => random() < 0.3))
      loweredGatherReads += programCounts(circuit.compileTensorProgram(roots)).gatherReads
      const sources = Array.from({length: 8}, () => {
        const source = new Float32Array(13)
        for (const wire of integerCells) source[wire] = randomInteger(random, 13) - 6
        // A few pointer and width values, so equal operands happen often.
        for (const wire of pointerCells) source[wire] = pick([-3.5, 0, 12.25, 12.265625, 511.984375])
        for (const wire of widthCells) source[wire] = pick([0, Math.fround(300.1), Math.fround(300.10001), 4096])
        for (const wire of fractionCells) source[wire] = pick([0, 1, 0.25, 0.5, Math.fround(random())])
        for (const wire of valueCells) source[wire] = Math.fround((random() * 2 - 1) * 100)
        return source
      })
      // Every compile mode, with and without gather lowering, returns the reference
      // evaluator's bits, and every declared group holds on the values.
      for (const values of checkEveryCompileMode(circuit, roots, sources)) {
        validateOneHotGroups(circuit, values)
        validateIndexReads(circuit, values)
        sourcesChecked++
      }
    }
    expect(sourcesChecked).toBe(640)
    expect(groupsOverComparisonsOrReads).toBeGreaterThan(50)
    expect(undeclaredSelections).toBeGreaterThan(10)
    expect(loweredGatherReads).toBeGreaterThan(50)
    // Measured: 46 reads whose index range reaches only past one end of the table.
    expect(readsOnlyThroughASide).toBeGreaterThan(20)
  })
})
