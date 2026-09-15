import {expect, test} from 'bun:test'
import {
  emitClampedOneHot,
  emitIntegerAtLeast,
  emitIntegerOneHot,
  emitMaskedRead,
  SourceLayout,
} from './constructions.ts'
import {compileModes, compileWith, countWireMismatches, createRandom, programStatistics} from './measure.ts'
import {type Circuit, type Terms, validateOneHotGroups, validateTensorProgram, type Wire} from './numeric-ui-core.ts'

// The compile pass that resolves a relu one-hot group from its index wire, so
// masked reads of the group stop depending on the N bits and the one-hot drops
// out of the compiled program.

type Style = 'clamped' | 'integer-strict' | 'integer-zero'

function expectedDenseRead(style: Style, index: number, values: ArrayLike<number>) {
  if (index <= 0) return values[0]!
  if (index >= values.length) return style === 'clamped' ? values[values.length - 1]! : 0
  return values[index]!
}

function buildStyle(style: Style, count: number) {
  const layout = new SourceLayout()
  const index = layout.cell(0, -4, count + 4)
  const values = layout.cells(count, position => Math.fround(position * 3.25 - 17), -1e6, 1e6)
  const circuit = layout.createCircuit()
  const members = style === 'clamped'
    ? emitClampedOneHot(circuit, index, count)
    : emitIntegerOneHot(circuit, [[index, 1]], 0, count, style === 'integer-zero')
  const forward = emitMaskedRead(circuit, members, values)
  const backward = emitMaskedRead(circuit, members, [...values].reverse())
  return {layout, index, values, circuit, members, reads: [forward, backward]}
}

test('both phase 1 one-hot styles resolve from the index wire and leave the compiled program', () => {
  for (const style of ['clamped', 'integer-strict', 'integer-zero'] as const) {
    for (const count of [2, 3, 8, 64, 257]) {
      const {layout, index, values, circuit, reads} = buildStyle(style, count)
      const dense = programStatistics(compileWith(circuit, reads, compileModes.dense))
      const gathered = programStatistics(compileWith(circuit, reads, compileModes.gather))
      const program = compileWith(circuit, reads, compileModes.lowered)
      validateTensorProgram(circuit, program)
      const lowered = programStatistics(program)
      expect(gathered.bitComputes).toBe(1)
      expect(lowered.indexComputes).toBe(1)
      expect(lowered.bitComputes).toBe(0)
      expect(lowered.gatherReads).toBe(2)
      // Only the two reads remain: no ramps, no members, no products.
      expect(lowered.liveOperations).toBe(2)
      expect(lowered.layers).toBe(1)
      expect(lowered.storedWeights).toBe(0)
      expect(dense.liveOperations).toBeGreaterThan(3 * count)
      const valueArray = values.map(wire => layout.values[wire]!)
      for (let at = -4; at <= count + 4; at++) {
        const source = layout.table()
        source[index] = at
        const {mismatches, reference} = countWireMismatches(circuit, program, source)
        expect(mismatches).toBe(0)
        expect(reference[reads[0]!]).toBe(Math.fround(expectedDenseRead(style, at, valueArray)))
      }
    }
  }
})

test('the windowed one-hot of pointer jumping (index minus start) is recognized with its offset', () => {
  const start = 37
  const span = 12
  const layout = new SourceLayout()
  const jump = layout.cell(start, start, start + span)
  const values = layout.cells(span + 1, position => start + position * 2, 0, 1000)
  const circuit = layout.createCircuit()
  const members = emitIntegerOneHot(circuit, [[jump, 1]], -start, span + 1, false)
  const read = emitMaskedRead(circuit, members, values)
  const program = compileWith(circuit, [read], compileModes.lowered)
  expect(programStatistics(program).indexComputes).toBe(1)
  expect(programStatistics(program).liveOperations).toBe(1)
  for (let at = start; at <= start + span; at++) {
    const source = layout.table()
    source[jump] = at
    const {mismatches, reference} = countWireMismatches(circuit, program, source)
    expect(mismatches).toBe(0)
    expect(reference[read]).toBe(start + (at - start) * 2)
  }
})

// Members p = [x >= p] - [x >= p + 1], member 0 = 1 - [x >= 1], not declared.
function buildHats(circuit: Circuit, terms: Terms, size: number, thresholdShift = 0): Wire[] {
  const atLeast = Array.from({length: size}, (_, threshold) =>
    emitIntegerAtLeast(circuit, terms, thresholdShift, threshold + 1))
  return Array.from({length: size}, (_, position) => {
    const member = position === 0
      ? circuit.roundAffine([[atLeast[0]!, -1]], 1)
      : circuit.roundAffine([[atLeast[position - 1]!, 1], [atLeast[position]!, -1]])
    circuit.assumeRange(member, 0, 1)
    return member
  })
}

test('recognition declines shapes it cannot prove, and those reads stay exact through the bit gather', () => {
  const count = 6
  const cases: {label: string, build: (circuit: Circuit, index: Wire) => Wire[], indexRange: [number, number], inputs: number[]}[] = [
    {
      label: 'index coefficient 2',
      build: (circuit, index) => buildHats(circuit, [[index, 2]], 2 * count - 1),
      indexRange: [0, count - 1],
      inputs: [0, 1, 2, 5],
    },
    {
      label: 'index range wider than 2^21',
      build: (circuit, index) => buildHats(circuit, [[index, 1]], count),
      indexRange: [-(2 ** 22), 2 ** 22],
      // Inputs past the last member break the strict one-hot contract, so stay inside.
      inputs: [0, 3, 5, -9],
    },
    {
      label: 'members declared out of order',
      build: (circuit, index) => {
        const members = buildHats(circuit, [[index, 1]], count)
        return [members[1]!, members[0]!, ...members.slice(2)]
      },
      indexRange: [0, count - 1],
      inputs: [0, 1, 4],
    },
    {
      // Members are [x + 0.5 == p], exact bits for half-integer x.
      label: 'thresholds at half integers',
      build: (circuit, index) => buildHats(circuit, [[index, 1]], count, 0.5),
      indexRange: [0, count - 1],
      inputs: [0.5, 2.5, 4.5],
    },
  ]
  for (const {label, build, indexRange, inputs} of cases) {
    const layout = new SourceLayout()
    const index = layout.cell(0, indexRange[0], indexRange[1])
    const circuit = layout.createCircuit()
    const members = build(circuit, index)
    circuit.assumeOneHot(members)
    // Every position reads the index cell itself: a finite source, so the bit
    // gather may lower the sum.
    const read = circuit.roundAffine(members.map(member => [circuit.multiply(member, index), 1] as const))
    const program = compileWith(circuit, [read], compileModes.lowered)
    const statistics = programStatistics(program)
    expect(statistics.indexComputes, label).toBe(0)
    expect(statistics.bitComputes, label).toBe(1)
    for (const at of inputs) {
      const source = layout.table()
      source[index] = at
      const {mismatches, reference} = countWireMismatches(circuit, program, source)
      validateOneHotGroups(circuit, reference)
      expect(mismatches, `${label} at ${at}`).toBe(0)
    }
  }
})

test('members read elsewhere stay live, but their reads still resolve from the index', () => {
  const {layout, index, circuit, members, reads} = buildStyle('integer-zero', 16)
  const exhausted = circuit.roundAffine(members.map(member => [member, -1] as const), 1)
  const program = compileWith(circuit, [...reads, exhausted], compileModes.lowered)
  const statistics = programStatistics(program)
  expect(statistics.indexComputes).toBe(1)
  expect(statistics.liveOperations).toBeGreaterThan(3 * 16)
  const random = createRandom(3)
  for (let trial = 0; trial < 50; trial++) {
    const source = layout.table()
    source[index] = Math.floor(random() * 24) - 4
    expect(countWireMismatches(circuit, program, source).mismatches).toBe(0)
  }
})

test('a violated contract, a fractional index, is where the lowered read and the dense sum part ways', () => {
  const {layout, index, values, circuit, reads} = buildStyle('clamped', 4)
  const program = compileWith(circuit, reads, compileModes.lowered)
  const source = layout.table()
  source[index] = 1.5
  const reference = circuit.evaluateReference(source)
  // The dense construction interpolates between rows 1 and 2.
  expect(reference[reads[0]!]).toBe(Math.fround(0.5 * source[values[1]!]! + 0.5 * source[values[2]!]!))
  expect(() => validateOneHotGroups(circuit, reference)).toThrow()
  expect(countWireMismatches(circuit, program, source).mismatches).toBeGreaterThan(0)
})
