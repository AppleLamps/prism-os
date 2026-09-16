// Checks emitCompare, grids, rounding points and emitMinimumExact from numeric-ui-core.ts
// against native JavaScript comparisons and against this folder's hand-built sign cascade.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/comparisons
import {expect, test} from 'bun:test'
import {Circuit, type Relation, emitCompare, emitMinimumExact, validateGrids, asWire} from '../../../../../numeric-ui-core.ts'
import {createRandom, differenceClasses, f, measureCost} from './fp32.ts'
import {pairWithDifference, randomPixelPairs} from './measure.ts'
import {buildMinimums, buildSharedCompare, relations} from './shared-runtime-compare.ts'
import {emitAtLeast, emitEqual, emitGreater} from './sign-cascade.ts'

function nativeCompare(a: number, relation: Relation, b: number) {
  switch (relation) {
    case '>': return a > b ? 1 : 0
    case '>=': return a >= b ? 1 : 0
    case '<': return a < b ? 1 : 0
    case '<=': return a <= b ? 1 : 0
    case '===': return a === b ? 1 : 0
  }
}

test('emitCompare equals JavaScript on every class of FP32 difference, as a sign cascade and ending with the atom', () => {
  const random = createRandom(7)
  const sources = [
    ...differenceClasses(16_384, random, 300).flatMap(({values}) => values.map(pairWithDifference)),
    ...randomPixelPairs(8, 2_000).map(([a, b]) => Float32Array.of(a, b)),
  ]
  for (const endWithBoolean of [false, true]) {
    const {circuit, bits} = buildSharedCompare({endWithBoolean})
    const evaluate = circuit.createTensorEvaluator(bits)
    let wrong = 0
    for (const source of sources) {
      const values = circuit.evaluateReference(source)
      const compiled = evaluate(source)
      relations.forEach((relation, index) => {
        const expected = nativeCompare(source[0]!, relation, source[1]!)
        if (values[bits[index]!] !== expected || compiled[index] !== expected) wrong++
      })
    }
    expect({endWithBoolean, wrong}).toEqual({endWithBoolean, wrong: 0})
  }
})

test('without a grid, the helper gives the same bits as the hand-built sign cascade in sign-cascade.ts', () => {
  const {circuit, bits} = buildSharedCompare()
  const greater = emitGreater(circuit, circuit.source(0), circuit.source(1))
  const atLeast = emitAtLeast(circuit, circuit.source(0), circuit.source(1))
  const equal = emitEqual(circuit, circuit.source(0), circuit.source(1))
  for (const [a, b] of randomPixelPairs(9, 3_000)) {
    const values = circuit.evaluateReference(Float32Array.of(a, b))
    expect([values[bits[0]!], values[bits[1]!], values[bits[4]!]]).toEqual([values[greater], values[atLeast], values[equal]])
  }
})

test('costs: integer bits on a grid, the sign cascade otherwise, and the atom at the end only with endWithBoolean', () => {
  const costs = (options: {grid?: number, endWithBoolean?: boolean}) => {
    const {circuit, bits} = buildSharedCompare(options)
    return bits.map(bit => measureCost(circuit, [bit]))
  }
  // For >, >=, <, <= and ===.
  expect(costs({})).toEqual([
    {operations: 16, layers: 15},
    {operations: 15, layers: 14},
    {operations: 16, layers: 15},
    {operations: 15, layers: 14},
    {operations: 28, layers: 14},
  ])
  expect(costs({endWithBoolean: true})).toEqual([
    {operations: 15, layers: 13},
    {operations: 14, layers: 13},
    {operations: 15, layers: 13},
    {operations: 14, layers: 13},
    {operations: 25, layers: 13},
  ])
  expect(costs({grid: 1 / 64})).toEqual([
    {operations: 2, layers: 2},
    {operations: 2, layers: 2},
    {operations: 2, layers: 2},
    {operations: 2, layers: 2},
    {operations: 3, layers: 2},
  ])
  expect(costs({grid: 1 / 64, endWithBoolean: true})).toEqual([
    {operations: 1, layers: 1},
    {operations: 1, layers: 1},
    {operations: 1, layers: 1},
    {operations: 1, layers: 1},
    {operations: 3, layers: 2},
  ])
})

test('grid bits equal JavaScript on 1/64 px operands, and validateGrids catches a value off the grid', () => {
  const random = createRandom(10)
  const onGrid = () => Math.round(random() * 16_384 * 64) / 64
  const pairs: [number, number][] = [[100, 100], [100, 100 + 1 / 64], [100 + 1 / 64, 100], [0, 16_384], [16_384, 0]]
  for (let index = 0; index < 3_000; index++) {
    const a = onGrid()
    pairs.push([a, index % 3 === 0 ? a : index % 3 === 1 ? Math.min(16_384, a + 1 / 64) : onGrid()])
  }
  for (const endWithBoolean of [false, true]) {
    const {circuit, bits} = buildSharedCompare({grid: 1 / 64, endWithBoolean})
    let wrong = 0
    for (const [a, b] of pairs) {
      const values = circuit.evaluateReference(Float32Array.of(a, b))
      relations.forEach((relation, index) => {
        if (values[bits[index]!] !== nativeCompare(a, relation, b)) wrong++
      })
      validateGrids(circuit, values)
    }
    expect({endWithBoolean, wrong}).toEqual({endWithBoolean, wrong: 0})
  }
  const {circuit} = buildSharedCompare({grid: 1 / 64})
  expect(() => validateGrids(circuit, circuit.evaluateReference(Float32Array.of(100.01, 3)))).toThrow('must be a multiple of')
})

test('rounding points: every live operation emitCompare builds is recorded, as integer bits on a grid and sign cascade stages otherwise, and a closing atom is recorded as a boolean', () => {
  for (const grid of [undefined, 1 / 64]) {
    for (const endWithBoolean of [false, true]) {
      const {circuit, bits} = buildSharedCompare(grid === undefined ? {endWithBoolean} : {grid, endWithBoolean})
      const kinds = new Map(circuit.roundingPoints().map(({wire, kind}) => [wire, kind]))
      for (const bit of bits) {
        const program = circuit.compileTensorProgram([bit])
        for (let packed = circuit.sourceSize; packed < program.valueCount; packed++) {
          const wire = program.wireOrder[packed]!
          const operation = circuit.operations[wire - circuit.sourceSize]!
          // Operands within 0..16,384 on a 1/64 grid are 2^20 grid steps, so the grid comparisons build integer bits.
          expect(kinds.get(asWire(wire))).toBe(operation.kind === 'boolean' ? 'boolean' : grid === undefined ? 'sign cascade' : 'integer bit')
        }
      }
    }
  }
})

test("emitCompare throws unless both operands have finite declared ranges and their difference can't overflow FP32", () => {
  const open = new Circuit(2)
  open.assumeRange(open.source(0), 0, 16_384)
  expect(() => emitCompare(open, open.source(0), '>=', open.source(1))).toThrow('finite declared ranges')
  const huge = new Circuit(2)
  huge.assumeRange(huge.source(0), -3.4e38, 3.4e38)
  huge.assumeRange(huge.source(1), -3.4e38, 3.4e38)
  expect(() => emitCompare(huge, huge.source(0), '>', huge.source(1))).toThrow('can overflow FP32')
})

test('emitMinimumExact returns one operand exactly where emitMinimum drifts', () => {
  const {circuit, drifting, exact} = buildMinimums()
  const mixedMagnitudes = circuit.evaluateReference(Float32Array.of(f(1000.37), f(0.3)))
  expect(mixedMagnitudes[drifting]).toBe(0.29998779296875)
  expect(mixedMagnitudes[exact]).toBe(f(0.3))
  let wrong = 0
  for (const [a, b] of randomPixelPairs(12, 3_000)) {
    if (circuit.evaluateReference(Float32Array.of(a, b))[exact] !== Math.min(a, b)) wrong++
  }
  expect(wrong).toBe(0)
  expect(measureCost(circuit, [drifting])).toEqual({operations: 3, layers: 3})
  expect(measureCost(circuit, [exact])).toEqual({operations: 18, layers: 16})
})

test('emitMinimumExact on operands declared on a 1/64 grid is 5 operations in 4 layers', () => {
  const circuit = new Circuit(2)
  for (const wire of [0, 1]) {
    circuit.assumeRange(asWire(wire), 0, 16_384)
    circuit.assumeGrid(asWire(wire), 1 / 64)
  }
  const exact = emitMinimumExact(circuit, circuit.source(0), circuit.source(1))
  const random = createRandom(13)
  const gridValue = () => Math.floor(random() * 16_384 * 64) / 64
  let wrong = 0
  for (let pair = 0; pair < 3_000; pair++) {
    const a = gridValue()
    // Every third pair differs by one grid step, the smallest difference the bit has to resolve.
    const b = pair % 3 === 0 ? a + 1 / 64 : gridValue()
    const source = pair % 2 === 0 ? Float32Array.of(a, b) : Float32Array.of(b, a)
    if (circuit.evaluateReference(source)[exact] !== Math.min(a, b)) wrong++
  }
  expect(wrong).toBe(0)
  expect(measureCost(circuit, [exact])).toEqual({operations: 5, layers: 4})
})
