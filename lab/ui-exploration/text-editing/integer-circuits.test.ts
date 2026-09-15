import {expect, test} from 'bun:test'
import {Circuit, type Wire} from '../../../numeric-ui-core.ts'
import {
  atLeastZero,
  barrelShiftTowardEnd,
  barrelShiftTowardStart,
  floorByPowerOfTwo,
  gather,
  integerBits,
  integerMaximum,
  integerOneHot,
  measureCircuit,
  prefixScan,
  suffixScan,
  integerMinimum,
} from './integer-circuits.ts'

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

test('one boolean atom compares integers exactly up to 2^22', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 2 ** 22)
  circuit.assumeRange(1, 0, 2 ** 22)
  const bit = atLeastZero(circuit, [[0, 1], [1, -1]])
  const evaluate = circuit.createTensorEvaluator([bit])
  const random = createRandom(7)
  const source = new Float32Array(2)
  let mismatches = 0
  for (let trial = 0; trial < 20000; trial++) {
    const left = Math.floor(random() * 2 ** 22)
    const right = trial % 3 === 0 ? left + Math.floor(random() * 3) - 1 : Math.floor(random() * 2 ** 22)
    source[0] = left
    source[1] = Math.min(2 ** 22, Math.max(0, right))
    if (evaluate(source)[0] !== (source[0]! >= source[1]! ? 1 : 0)) mismatches++
  }
  expect(mismatches).toBe(0)
  expect(measureCircuit(circuit, [bit]).liveOperations).toBe(1)
})

test('comparisons refuse operands whose partial sums leave the exact window', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 2 ** 24)
  circuit.assumeRange(1, 0, 2 ** 24)
  expect(() => atLeastZero(circuit, [[0, 1], [1, -1]])).toThrow('too wide')
})

test('floor by a power of two is exact on every residue near the edges', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 2 ** 23 - 1)
  const quotient = floorByPowerOfTwo(circuit, 0, 12)
  const evaluate = circuit.createTensorEvaluator([quotient])
  const source = new Float32Array(1)
  let mismatches = 0
  for (const base of [0, 4096, 2 ** 22, 2 ** 23 - 8192]) {
    for (let offset = 0; offset < 8192; offset++) {
      source[0] = base + offset
      if (evaluate(source)[0] !== Math.floor((base + offset) / 4096)) mismatches++
    }
  }
  expect(mismatches).toBe(0)
})

test('integer bits and one-hot reads agree with plain indexing', () => {
  const circuit = new Circuit(1 + 13)
  circuit.assumeRange(0, 0, 12)
  for (let entry = 0; entry < 13; entry++) circuit.assumeRange(1 + entry, -50, 50)
  const bits = integerBits(circuit, 0, 4)
  const members = integerOneHot(circuit, 0, 13)
  const read = gather(circuit, members, Array.from({length: 13}, (_, entry) => 1 + entry))
  const roots = [...bits, read]
  const size = measureCircuit(circuit, roots)
  expect(size.gatherReads).toBe(1)
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(14)
  for (let entry = 0; entry < 13; entry++) source[1 + entry] = 3 * entry - 20
  for (let value = 0; value <= 12; value++) {
    source[0] = value
    const values = evaluate(source)
    expect(Array.from(values.subarray(0, 4))).toEqual([0, 1, 2, 3].map(weight => (value >> weight) & 1))
    expect(values[4]).toBe(3 * value - 20)
  }
})

test('both scan strategies match sequential prefix maxima, minima and sums', () => {
  for (const strategy of ['sklansky', 'brent-kung'] as const) {
    for (const count of [1, 2, 5, 8, 13, 16, 17]) {
      const circuit = new Circuit(count)
      for (let wire = 0; wire < count; wire++) circuit.assumeRange(wire, 0, 1000)
      const leaves = Array.from({length: count}, (_, index) => index)
      const maxima = prefixScan(leaves, (earlier, later) => integerMaximum(circuit, earlier, later), strategy)
      const minima = suffixScan(leaves, (earlier, later) => integerMinimum(circuit, earlier, later), strategy)
      const sums = prefixScan(leaves, (earlier, later) => circuit.roundAffine([[earlier, 1], [later, 1]]), strategy)
      const evaluate = circuit.createTensorEvaluator([...maxima, ...minima, ...sums])
      const random = createRandom(count)
      const source = new Float32Array(count)
      for (let trial = 0; trial < 30; trial++) {
        for (let wire = 0; wire < count; wire++) source[wire] = Math.floor(random() * 1000)
        const values = Array.from(evaluate(source))
        const input = Array.from(source)
        const expectedMaxima = input.map((_, index) => Math.max(...input.slice(0, index + 1)))
        const expectedMinima = input.map((_, index) => Math.min(...input.slice(index)))
        const expectedSums = input.map((_, index) => input.slice(0, index + 1).reduce((sum, value) => sum + value, 0))
        expect(values).toEqual([...expectedMaxima, ...expectedMinima, ...expectedSums])
      }
    }
  }
})

test('barrel shifts move every cell by a runtime amount in both directions', () => {
  const length = 11
  const circuit = new Circuit(length + 2)
  for (let wire = 0; wire < length; wire++) circuit.assumeRange(wire, 0, 2 ** 20)
  circuit.assumeRange(length, 0, 15)
  circuit.assumeRange(length + 1, 0, 15)
  const values: (Wire | null)[] = [null, ...Array.from({length}, (_, index) => index), null]
  const towardStart = barrelShiftTowardStart(circuit, values, integerBits(circuit, length, 4), 9)
  const towardEnd = barrelShiftTowardEnd(circuit, values.slice(1, 5), integerBits(circuit, length + 1, 4), 14)
  const roots = [...towardStart, ...towardEnd].filter((wire): wire is Wire => wire !== null)
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(length + 2)
  for (let wire = 0; wire < length; wire++) source[wire] = 1000 + 37 * wire
  const padded = [0, ...Array.from(source.subarray(0, length)), 0]
  for (let shift = 0; shift < 16; shift++) {
    source[length] = shift
    source[length + 1] = shift
    const values = evaluate(source)
    let cursor = 0
    const read = (wire: Wire | null) => wire === null ? 0 : values[cursor++]!
    const startResult = towardStart.map(read)
    const endResult = towardEnd.map(read)
    expect(startResult).toEqual(Array.from({length: 9}, (_, index) => padded[index + shift] ?? 0))
    expect(endResult).toEqual(Array.from({length: 14}, (_, index) => index - shift >= 0 && index - shift < 4 ? padded[1 + index - shift]! : 0))
  }
})
