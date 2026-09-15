import {expect, test} from 'bun:test'
import {SourceTable, compile, fitBit, integerOneHot} from './kit.ts'

test('the hat-function one-hot is exact at every position and all zero past the end', () => {
  const size = 40
  const source = new SourceTable()
  const x = source.cell(0, 0, size)
  const circuit = source.createCircuit()
  const oneHot = integerOneHot(circuit, source.unit, x, 0, size, true)
  const atLeast = Array.from({length: size + 1}, (_, j) => circuit.roundAffine(oneHot.atLeast(j)))
  const compiled = compile(circuit, [...oneHot.members, ...atLeast])
  // size relus plus size members; the atLeast forms reuse the relus.
  expect(compiled.size.oneHotOperations).toBe(2 * size)
  const table = source.table()
  for (let value = 0; value <= size; value++) {
    table[x] = value
    const output = compiled.evaluate(table)
    for (let position = 0; position < size; position++) expect(output[position]).toBe(position === value ? 1 : 0)
    for (let j = 0; j <= size; j++) expect(output[size + j]).toBe(value >= j ? 1 : 0)
  }
})

test('fitBit decides span <= width + epsilon exactly for quarter-pixel values', () => {
  const source = new SourceTable()
  const threshold = source.cell(0, 0, 2 ** 17)
  const startPrefix = source.cell(0, 0, 2 ** 17)
  const width = source.cell(0, 0, 4096)
  const circuit = source.createCircuit()
  const bit = fitBit(circuit, source.unit, [[threshold, 1], [startPrefix, -1]], width, 0.005)
  const compiled = compile(circuit, [bit])
  expect(compiled.size.liveOperations).toBe(4)
  expect(compiled.size.layers).toBe(3)
  const table = source.table()
  let random = 5
  const nextRandom = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
  for (let trial = 0; trial < 3000; trial++) {
    const prefix = Math.floor(nextRandom() * 4 * 100_000) / 4
    const lineWidth = Math.floor(nextRandom() * 4 * 4000) / 4 + (trial % 3 === 0 ? 0.125 : 0)
    // Spans within a few quarter pixels of the width, where the epsilon decides.
    const span = Math.max(0, Math.round(lineWidth * 4) / 4 + Math.floor(nextRandom() * 5 - 2) / 4)
    table[threshold] = prefix + span
    table[startPrefix] = prefix
    table[width] = lineWidth
    expect(compiled.evaluate(table)[0]).toBe(span <= lineWidth + 0.005 ? 1 : 0)
  }
})
