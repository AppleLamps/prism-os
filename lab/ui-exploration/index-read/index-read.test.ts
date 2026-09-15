import {expect, test} from 'bun:test'
import {
  emitClampedOneHot,
  emitIntegerOneHot,
  emitMaskedRead,
  SourceLayout,
} from './constructions.ts'
import {
  compileModes,
  compileWith,
  countWireMismatches,
  createRandom,
  programStatistics,
  sameNumericValue,
} from './measure.ts'
import {
  Circuit,
  inlineCircuit,
  type OutOfRange,
  validateIndexReads,
  validateTensorProgram,
  type Wire,
} from './numeric-ui-core.ts'

// The instruction's definition, written independently of the runtime.
function expectedRead(index: number, values: readonly number[], below: OutOfRange, above: OutOfRange): number {
  if (Number.isNaN(index)) return Number.NaN
  const position = Math.floor(index)
  if (position < 0) return below === 'zero' ? 0 : values[0]!
  if (position > values.length - 1) return above === 'zero' ? 0 : values[values.length - 1]!
  return values[position]!
}

function expectSame(actual: number, expected: number, label: string) {
  if (!Object.is(actual, expected)) throw new Error(`${label}: got ${actual}, expected ${expected}`)
}

test('an index read returns candidates[floor(index)], with clamp or zero outside, in both evaluators', () => {
  // Sources: index, then candidates with extreme, signed-zero, infinite values.
  const candidateValues = [
    Math.fround(-7.25),
    -0,
    Number.POSITIVE_INFINITY,
    Math.fround(3.4028234663852886e38),
    Number.NEGATIVE_INFINITY,
    Math.fround(1e-45),
    Math.fround(42.5),
  ]
  const circuit = new Circuit(1 + candidateValues.length)
  const candidates = candidateValues.map((_, position) => 1 + position)
  const clampRead = circuit.indexRead(0, candidates)
  const zeroRead = circuit.indexRead(0, candidates, {outOfRange: 'zero'})
  const mixedRead = circuit.indexReadAffine([[0, 1]], 0, candidates, 'zero', 'clamp')
  const roots = [clampRead, zeroRead, mixedRead]
  for (const mode of Object.values(compileModes)) {
    const program = compileWith(circuit, roots, mode)
    validateTensorProgram(circuit, program)
    const indices = [
      Number.NEGATIVE_INFINITY, -1e30, -3, -1, -0.5, -0, 0, 0.25, 1, 2, 3.999, 4, 5, 6, 6.5, 7, 8, 1e30,
      Number.POSITIVE_INFINITY,
    ]
    for (const index of indices) {
      const source = Float32Array.from([index, ...candidateValues])
      const {mismatches, reference, tensor} = countWireMismatches(circuit, program, source)
      expect(mismatches).toBe(0)
      const at = Math.fround(index)
      for (const [wire, below, above] of [
        [clampRead, 'clamp', 'clamp'],
        [zeroRead, 'zero', 'zero'],
        [mixedRead, 'zero', 'clamp'],
      ] as const) {
        const expected = Math.fround(expectedRead(at, candidateValues, below, above))
        expectSame(reference[wire]!, expected, `reference ${below}/${above} at ${index}`)
        expectSame(tensor[wire]!, expected, `tensor ${below}/${above} at ${index}`)
      }
    }
  }
})

test('a NaN index reads NaN in both evaluators', () => {
  const circuit = new Circuit(4)
  // index = a - b, which is NaN when both are infinite.
  const index = circuit.roundAffine([[0, 1], [1, -1]])
  const read = circuit.indexRead(index, [2, 3], {outOfRange: 'zero'})
  const program = circuit.compileTensorProgram([read])
  const {mismatches, reference} = countWireMismatches(
    circuit,
    program,
    Float32Array.from([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1, 2]),
  )
  expect(mismatches).toBe(0)
  expect(Number.isNaN(reference[read]!)).toBe(true)
})

test('duplicate candidates, composed index forms, and chained reads agree in both evaluators', () => {
  const random = createRandom(7)
  const layout = new SourceLayout()
  const start = layout.cell(0, 0, 9)
  const next = layout.cells(10, index => Math.min(9, index + 1 + (index % 3)), 0, 9)
  const payload = layout.cells(4, index => index * 11, -1000, 1000)
  const circuit = layout.createCircuit()
  // next[next[next[start]]], then a composed index (third + 2), then a table
  // that repeats candidates.
  let cursor: Wire = start
  const cursors: Wire[] = []
  for (let hop = 0; hop < 3; hop++) {
    cursor = circuit.indexRead(cursor, next)
    cursors.push(cursor)
  }
  const shifted = circuit.indexReadAffine([[cursor, 1]], -7, [payload[0]!, payload[0]!, payload[2]!, payload[1]!, payload[0]!], 'clamp', 'zero')
  const roots = [...cursors, shifted]
  const program = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, program)
  for (let trial = 0; trial < 200; trial++) {
    const source = layout.table()
    source[start] = Math.floor(random() * 10)
    for (let index = 0; index < 10; index++) source[next[index]!] = Math.floor(random() * 10)
    for (let index = 0; index < 4; index++) source[payload[index]!] = Math.fround((random() * 2 - 1) * 1000)
    const {mismatches, reference} = countWireMismatches(circuit, program, source)
    expect(mismatches).toBe(0)
    validateIndexReads(circuit, reference)
    let expectedCursor = source[start]!
    for (let hop = 0; hop < 3; hop++) {
      expectedCursor = source[next[expectedCursor]!]!
      expect(reference[cursors[hop]!]).toBe(expectedCursor)
    }
    const table = [0, 0, 2, 1, 0].map(position => source[payload[position]!]!)
    expectSame(reference[shifted]!, expectedRead(expectedCursor - 7, table, 'clamp', 'zero'), 'shifted read')
  }
})

test('evenly spaced tables store a base and a stride; a scattered table stores one position per candidate', () => {
  const count = 1024
  const layout = new SourceLayout()
  const index = layout.cell(0, 0, count - 1)
  const values = layout.cells(count, position => position, -1e6, 1e6)
  const circuit = layout.createCircuit()
  const contiguous = circuit.indexRead(index, values)
  const reversed = circuit.indexRead(index, [...values].reverse())
  const everyOther = circuit.indexRead(index, values.filter((_, position) => position % 2 === 1))
  const random = createRandom(3)
  const shuffled = [...values].sort(() => random() - 0.5)
  const scattered = circuit.indexRead(index, shuffled)
  const contiguousStats = programStatistics(circuit.compileTensorProgram([contiguous]))
  expect(contiguousStats.liveOperations).toBe(1)
  expect(contiguousStats.layers).toBe(1)
  // The index form [[index, 1]] is one projection row with one weight.
  expect(contiguousStats.storedWeights).toBe(1)
  expect(contiguousStats.candidateTableEntries).toBe(0)
  const roots = [contiguous, reversed, everyOther, scattered]
  const program = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, program)
  expect(programStatistics(program).candidateTableEntries).toBe(count)
  for (const at of [0, 1, 511, 512, 1023]) {
    const source = layout.table()
    source[index] = at
    const {mismatches, reference} = countWireMismatches(circuit, program, source)
    expect(mismatches).toBe(0)
    expect(reference[reversed]).toBe(count - 1 - at)
    expect(reference[everyOther]).toBe(Math.min(2 * at + 1, count - 1))
    expect(reference[scattered]).toBe(shuffled[at]! - 1)
  }
})

test('constant indices fold at build time and repeated reads share one wire', () => {
  const circuit = new Circuit(5)
  const constantIndex = circuit.affine([], 3)
  expect(circuit.indexRead(constantIndex, [1, 2, 3, 4])).toBe(4)
  const beyond = circuit.indexRead(circuit.affine([], 9), [1, 2, 3, 4], {outOfRange: 'zero'})
  expect(circuit.constants[beyond]).toBe(0)
  const first = circuit.indexRead(0, [1, 2, 3, 4])
  expect(circuit.indexRead(0, [1, 2, 3, 4])).toBe(first)
  expect(circuit.indexRead(0, [1, 2, 3, 4], {outOfRange: 'zero'})).not.toBe(first)
})

type Style = 'clamped' | 'integer-strict' | 'integer-zero'

// The same table read built two ways over one source layout: the relu one-hot
// plus a masked sum, and the index read instruction.
function buildPair(count: number, style: Style, valueRange: number) {
  const layout = new SourceLayout()
  const index = layout.cell(0, -8, count + 8)
  const values = layout.cells(count, () => 0, -valueRange, valueRange)
  const dense = layout.createCircuit()
  let denseRead: Wire
  if (style === 'clamped') {
    const members = emitClampedOneHot(dense, index, count)
    denseRead = dense.affine(members.map((bit, position) => [dense.multiply(bit, values[position]!), 1]))
  } else {
    const members = emitIntegerOneHot(dense, [[index, 1]], 0, count, style === 'integer-zero')
    denseRead = emitMaskedRead(dense, members, values)
  }
  const instruction = layout.createCircuit()
  const above: OutOfRange = style === 'clamped' ? 'clamp' : 'zero'
  const instructionRead = instruction.indexReadAffine([[index, 1]], 0, values, 'clamp', above)
  return {layout, index, values, dense, denseRead, instruction, instructionRead}
}

test('differential: the instruction equals the relu one-hot construction on 600 random tables', () => {
  const random = createRandom(0x1dea)
  const extremes = [-0, Math.fround(3.4028234663852886e38), -Math.fround(3.4028234663852886e38), Math.fround(1e-45)]
  let comparisons = 0
  let loweredIndexComputes = 0
  for (let trial = 0; trial < 600; trial++) {
    const style = (['clamped', 'integer-strict', 'integer-zero'] as const)[trial % 3]!
    const count = 1 + Math.floor(random() * 40)
    const pair = buildPair(count, style, 3.4028234663852886e38)
    const denseModes = [compileModes.dense, compileModes.gather, compileModes.lowered].map(mode =>
      compileWith(pair.dense, [pair.denseRead], mode))
    loweredIndexComputes += programStatistics(denseModes[2]!).indexComputes
    const instructionProgram = pair.instruction.compileTensorProgram([pair.instructionRead])
    for (const program of [...denseModes, instructionProgram]) {
      validateTensorProgram(program === instructionProgram ? pair.instruction : pair.dense, program)
    }
    const indices = [0, count - 1, Math.floor(random() * count), -1, -8, count, count + 8]
    for (const indexValue of indices) {
      // A strict group promises exactly one member, which fails once the index
      // passes the table; the shared runtime's bit gather assumes that promise.
      const contractHolds = style !== 'integer-strict' || indexValue <= count - 1
      const source = pair.layout.table()
      source[pair.index] = indexValue
      for (let position = 0; position < count; position++) {
        source[pair.values[position]!] = random() < 0.1
          ? extremes[Math.floor(random() * extremes.length)]!
          : Math.fround((random() * 2 - 1) * 1000)
      }
      const denseReference = pair.dense.evaluateReference(source)
      const instructionReference = pair.instruction.evaluateReference(source)
      expect(sameNumericValue(instructionReference[pair.instructionRead]!, denseReference[pair.denseRead]!)).toBe(true)
      denseModes.forEach((program, modeIndex) => {
        if (modeIndex === 1 && !contractHolds) return
        expect(countWireMismatches(pair.dense, program, source).mismatches).toBe(0)
      })
      expect(countWireMismatches(pair.instruction, instructionProgram, source).mismatches).toBe(0)
      comparisons++
    }
  }
  expect(comparisons).toBe(4200)
  // Every dense construction with more than one member was recognized.
  expect(loweredIndexComputes).toBeGreaterThan(560)
})

test('infinite candidates: the instruction reads the selected value; the dense sum turns into NaN and stays dense', () => {
  const pair = buildPair(4, 'integer-strict', Number.POSITIVE_INFINITY)
  const loweredProgram = compileWith(pair.dense, [pair.denseRead], compileModes.lowered)
  expect(programStatistics(loweredProgram).gatherReads).toBe(0)
  const source = pair.layout.table()
  source[pair.index] = 1
  source[pair.values[0]!] = Number.POSITIVE_INFINITY
  source[pair.values[1]!] = 5
  const denseReference = pair.dense.evaluateReference(source)
  expect(Number.isNaN(denseReference[pair.denseRead]!)).toBe(true)
  const instructionProgram = pair.instruction.compileTensorProgram([pair.instructionRead])
  const {mismatches, reference} = countWireMismatches(pair.instruction, instructionProgram, source)
  expect(mismatches).toBe(0)
  expect(reference[pair.instructionRead]).toBe(5)
})

test('backward pass: the selected candidate gets the gradient; backward-difference matches the dense construction', () => {
  for (const style of ['clamped', 'integer-zero'] as const) {
    const count = 6
    const pair = buildPair(count, style, 1000)
    for (let indexValue = -3; indexValue <= count + 2; indexValue++) {
      const source = pair.layout.table()
      source[pair.index] = indexValue
      for (let position = 0; position < count; position++) source[pair.values[position]!] = 10 * (position + 1) + position * position
      const denseValues = pair.dense.evaluateReference(source)
      const denseGradients = new Float32Array(denseValues.length)
      denseGradients[pair.denseRead] = 1
      const denseResult = pair.dense.backpropagateReference(denseValues, denseGradients)
      const instructionValues = pair.instruction.evaluateReference(source)
      const instructionGradients = new Float32Array(instructionValues.length)
      instructionGradients[pair.instructionRead] = 1
      expect(() => pair.instruction.backpropagateReference(instructionValues, instructionGradients)).toThrow()
      const instructionResult = pair.instruction.backpropagateReference(
        instructionValues,
        instructionGradients,
        {indexGradient: 'backward-difference'},
      )
      for (let wire = 0; wire < pair.layout.values.length; wire++) {
        expect(instructionResult[wire]).toBe(denseResult[wire]!)
      }
      const zeroResult = pair.instruction.backpropagateReference(instructionValues, instructionGradients, {indexGradient: 'zero'})
      expect(zeroResult[pair.index]).toBe(0)
    }
  }
})

test('validateIndexReads rejects a fractional index; inlining carries index reads', () => {
  const layout = new SourceLayout()
  const index = layout.cell(0, -10, 10)
  const values = layout.cells(3, position => position, -10, 10)
  const child = layout.createCircuit()
  const read = child.indexRead(index, values)
  const source = layout.table()
  source[index] = 1.5
  expect(() => validateIndexReads(child, child.evaluateReference(source))).toThrow()
  const parent = new Circuit(layout.values.length)
  const wireMap = inlineCircuit(parent, child, Array.from({length: layout.values.length}, (_, wire) => wire))
  const inlinedRead = wireMap[read]!
  source[index] = 2
  const {mismatches, reference} = countWireMismatches(parent, parent.compileTensorProgram([inlinedRead]), source)
  expect(mismatches).toBe(0)
  expect(reference[inlinedRead]).toBe(2)
})
