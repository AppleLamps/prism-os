import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Relation,
  type Terms,
  type Wire,
  emitClampExact,
  emitCompare,
  emitMaximumExact,
  emitMinimum,
  emitMinimumExact,
  inlineCircuit,
  validateCircuit,
  validateGrids,
  validateTensorProgram,
  asWire,
} from './numeric-ui-core.ts'

// Tests for emitCompare, grids and rounding points, ported from
// lab/ui-exploration/guide/examples/comparisons and
// lab/ui-exploration/numeric-library, and checked against native JavaScript
// comparisons.

const f = Math.fround
const smallestSubnormal = 2 ** -149
const smallestNormal = 2 ** -126
const largestFinite = f(3.4028234663852886e38)
const relations: readonly Relation[] = ['>', '>=', '<', '<=', '===']

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

const scratchFloat = new Float32Array(1)
const scratchBits = new Uint32Array(scratchFloat.buffer)

function float32FromBits(bits: number) {
  scratchBits[0] = bits
  return scratchFloat[0]!
}

// The neighboring FP32 value above `value`, e.g. nextUp(1) is 1 + 2^-23.
function nextUp(value: number) {
  const rounded = f(value)
  if (rounded === 0) return smallestSubnormal
  scratchFloat[0] = rounded
  scratchBits[0] = rounded > 0 ? scratchBits[0]! + 1 : scratchBits[0]! - 1
  return scratchFloat[0]
}

function nextDown(value: number) {
  return -nextUp(-value)
}

// A random finite FP32 bit pattern: every exponent is equally likely, so tiny
// and huge values show up as often as ordinary ones.
function randomFiniteFloat32(random: () => number) {
  for (;;) {
    const value = float32FromBits(Math.floor(random() * 4_294_967_296))
    if (Number.isFinite(value)) return value
  }
}

function nativeCompare(a: number, relation: Relation, b: number) {
  switch (relation) {
    case '>': return a > b ? 1 : 0
    case '>=': return a >= b ? 1 : 0
    case '<': return a < b ? 1 : 0
    case '<=': return a <= b ? 1 : 0
    case '===': return a === b ? 1 : 0
  }
}

// Differences a comparison has to get right, grouped by where FP32 behaves
// differently, from lab/ui-exploration/guide/examples/comparisons/fp32.ts.
function differenceClasses(bound: number, random: () => number, randomCount: number) {
  const bothSigns = (values: number[]) => values.flatMap(value => [value, -value])
  const values = [
    0,
    -0,
    ...bothSigns([smallestSubnormal, 2 * smallestSubnormal, 3 * smallestSubnormal, f(2 ** -140), f(2 ** -126 - 2 ** -149)]),
    ...bothSigns([smallestNormal, nextUp(smallestNormal), f(2 ** -100)]),
    ...bothSigns([f(2 ** -40), nextDown(1), 1, nextUp(1), f(0.3)]),
    ...bothSigns([nextDown(2 ** 14), 2 ** 14, nextDown(2 ** 24), 2 ** 24, nextUp(2 ** 24), 2 ** 25]),
    ...bothSigns([2 ** 60, 2 ** 100, nextDown(largestFinite), largestFinite]),
  ]
  for (let index = 0; index < randomCount; index++) {
    values.push(randomFiniteFloat32(random), f((2 * random() - 1) * bound))
  }
  return values.filter(value => Math.abs(value) <= bound)
}

// Operand pairs within minimum..maximum, which contains 0: every class of
// difference against 0, equal and adjacent operands, and random bit patterns.
function operandPairs(minimum: number, maximum: number, seed: number, randomCount: number): [number, number][] {
  const random = createRandom(seed)
  const inRange = (value: number) => value >= minimum && value <= maximum
  const pairs: [number, number][] = []
  for (const difference of differenceClasses(maximum - minimum, random, randomCount)) {
    if (inRange(difference)) pairs.push([difference, 0])
    if (inRange(-difference)) pairs.push([0, -difference])
  }
  const pick = (uniform: boolean) => {
    for (;;) {
      const value = uniform ? f(minimum + random() * (maximum - minimum)) : randomFiniteFloat32(random)
      if (inRange(value)) return value
    }
  }
  for (let index = 0; index < randomCount; index++) {
    const a = pick(index % 2 === 0)
    pairs.push([a, a], [a, pick(index % 3 === 0)])
    for (const neighbor of [nextUp(a), nextDown(a)]) {
      if (inRange(neighbor)) pairs.push([a, neighbor], [neighbor, a])
    }
  }
  return pairs
}

function cost(circuit: Circuit, root: Wire) {
  const program = circuit.compileTensorProgram([root])
  return {operations: program.valueCount - circuit.sourceSize, layers: program.layers.length}
}

// Every finite float is an integer times a power of two, so sums and products
// can be computed exactly with BigInt. Ported from
// lab/ui-exploration/guide/examples/comparisons/exact-arithmetic.ts.
type Dyadic = {mantissa: bigint, exponent: number}
const float64View = new DataView(new ArrayBuffer(8))

function toDyadic(value: number): Dyadic {
  if (value === 0) return {mantissa: 0n, exponent: 0}
  float64View.setFloat64(0, value)
  const high = float64View.getUint32(0)
  const low = float64View.getUint32(4)
  const biasedExponent = (high >>> 20) & 0x7ff
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low) | (biasedExponent === 0 ? 0n : 1n << 52n)
  return {
    mantissa: high >>> 31 === 1 ? -mantissa : mantissa,
    exponent: biasedExponent === 0 ? -1074 : biasedExponent - 1075,
  }
}

function addDyadic(left: Dyadic, right: Dyadic): Dyadic {
  const exponent = Math.min(left.exponent, right.exponent)
  return {
    mantissa: (left.mantissa << BigInt(left.exponent - exponent)) + (right.mantissa << BigInt(right.exponent - exponent)),
    exponent,
  }
}

function multiplyDyadic(left: Dyadic, right: Dyadic): Dyadic {
  return {mantissa: left.mantissa * right.mantissa, exponent: left.exponent + right.exponent}
}

function exactSum(values: Float32Array, terms: Terms, bias: number) {
  let sum = toDyadic(f(bias))
  for (const [wire, coefficient] of terms) {
    sum = addDyadic(sum, multiplyDyadic(toDyadic(f(coefficient)), toDyadic(values[wire]!)))
  }
  return sum
}

// The operations among `operationIndices` whose FP32 result differs from the
// exact result of their arithmetic on the same FP32 inputs. For a ReGLU product
// only the result counts, e.g. a gate sum of -1 + 2^-100 rounds to -1, but the
// ReLU returns 0 either way.
function countRoundedOperations(circuit: Circuit, values: Float32Array, operationIndices: readonly number[]) {
  let rounded = 0
  for (const operationIndex of operationIndices) {
    const operation = circuit.operations[operationIndex]!
    let exact = exactSum(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      const gate = exactSum(values, operation.gateTerms, operation.gateBias)
      exact = gate.mantissa > 0n ? multiplyDyadic(exact, gate) : {mantissa: 0n, exponent: 0}
    }
    const output = values[circuit.sourceSize + operationIndex]!
    if (addDyadic(exact, multiplyDyadic(toDyadic(output), {mantissa: -1n, exponent: 0})).mantissa !== 0n) rounded++
  }
  return rounded
}

// Evaluators that add terms differently, standing in for what a backend may do,
// from lab/ui-exploration/guide/examples/comparisons/rewrites.ts.
type ExecutorMode = 'float64' | 'reversedTerms' | 'sumsRoundedOnce' | 'flushSubnormals'
const executorModes: readonly ExecutorMode[] = ['float64', 'reversedTerms', 'sumsRoundedOnce', 'flushSubnormals']

function evaluateWithMode(circuit: Circuit, source: Float32Array, mode: ExecutorMode) {
  const flush = (value: number) => (Math.abs(f(value)) < smallestNormal ? 0 : f(value))
  const round = mode === 'float64' ? (value: number) => value : mode === 'flushSubnormals' ? flush : f
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(mode === 'flushSubnormals' ? source.map(flush) : source)
  const sum = (terms: Terms, bias: number) => {
    if (mode === 'sumsRoundedOnce') {
      let unrounded = f(bias)
      for (const [wire, coefficient] of terms) unrounded += f(coefficient) * values[wire]!
      return f(unrounded)
    }
    if (mode === 'reversedTerms') {
      let value = 0
      for (let index = terms.length - 1; index >= 0; index--) {
        const [wire, coefficient] = terms[index]!
        value = f(value + f(f(coefficient) * values[wire]!))
      }
      return f(value + f(bias))
    }
    let value = round(bias)
    for (const [wire, coefficient] of terms) value = round(value + round(round(coefficient) * values[wire]!))
    return value
  }
  circuit.operations.forEach((operation, operationIndex) => {
    let value = sum(operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') value = round(value * Math.max(0, sum(operation.gateTerms, operation.gateBias)))
    else if (operation.kind === 'boolean') value = round(round(round(value) + 8_388_609) - 8_388_609)
    values[circuit.sourceSize + operationIndex] = value
  })
  return values
}

// Two source cells within minimum..maximum, with every relation built on them.
function buildPairCircuit(minimum: number, maximum: number, options: {grid?: number, endWithBoolean?: boolean} = {}) {
  const circuit = new Circuit(2)
  for (const wire of [0, 1]) {
    circuit.assumeRange(asWire(wire), minimum, maximum)
    if (options.grid !== undefined) circuit.assumeGrid(asWire(wire), options.grid)
  }
  const bits = relations.map(relation => emitCompare(circuit, circuit.source(0), relation, circuit.source(1), {endWithBoolean: options.endWithBoolean === true}))
  return {circuit, bits}
}

// Compile with and without gather lowering and check every live wire against
// the reference evaluator bit for bit.
function checkTensorAgreement(circuit: Circuit, roots: readonly Wire[], sources: readonly Float32Array[]) {
  validateCircuit(circuit)
  for (const lowerGathers of [true, false]) {
    const program = circuit.compileTensorProgram(roots, lowerGathers)
    validateTensorProgram(circuit, program)
    circuit.tensorProgram = program
    for (const source of sources) {
      const reference = circuit.evaluateReference(source)
      const tensor = circuit.evaluateTensor(source)
      for (const wire of program.wireOrder) {
        if (!Object.is(tensor[wire], reference[wire])) throw new Error(`wire ${wire}: tensor ${tensor[wire]}, reference ${reference[wire]}`)
      }
    }
  }
  circuit.tensorProgram = null
}

describe('sign cascade', () => {
  test('equals JavaScript over every class of FP32 difference, and no operation between the kept difference and the bit or score rounds', () => {
    const configurations = [
      {minimum: 0, maximum: 16_384, seed: 1},
      {minimum: -(2 ** 24), maximum: 2 ** 24, seed: 2},
      {minimum: -f(largestFinite / 2), maximum: f(largestFinite / 2), seed: 3},
      {minimum: -(2 ** -120), maximum: 2 ** -120, seed: 4},
      {minimum: -1, maximum: 1, seed: 5},
    ]
    for (const {minimum, maximum, seed} of configurations) {
      const pairs = operandPairs(minimum, maximum, seed, 150)
      for (const endWithBoolean of [false, true]) {
        const {circuit, bits} = buildPairCircuit(minimum, maximum, {endWithBoolean})
        // Every operation emitCompare built, except two kinds that may round by design:
        // the kept difference, which reads the two operand cells, e.g. f(16384 - 2^-20)
        // is 16384 but keeps the sign, and the score a final boolean atom reads, which
        // only has to land on the right side of 0.5. So the check covers each clamp
        // stage's affine x - relu(x - limit), whose exactness the cascade depends on.
        const atomOperands = new Set(circuit.operations
          .filter(operation => operation.kind === 'boolean')
          .flatMap(operation => operation.leftTerms.map(([wire]) => wire)))
        const stageOperations = circuit.operations
          .map((operation, operationIndex) => ({operation, operationIndex}))
          .filter(({operation, operationIndex}) =>
            operation.roundingPoint === 'sign cascade'
            && !(operation.kind === 'affine' && operation.leftTerms.every(([wire]) => wire < circuit.sourceSize))
            && !atomOperands.has(asWire(circuit.sourceSize + operationIndex)))
          .map(({operationIndex}) => operationIndex)
        expect(stageOperations.some(operationIndex => circuit.operations[operationIndex]!.kind === 'affine')).toBe(true)
        let wrong = 0
        let rounded = 0
        for (const [a, b] of pairs) {
          const values = circuit.evaluateReference(Float32Array.of(a, b))
          relations.forEach((relation, index) => {
            if (values[bits[index]!] !== nativeCompare(a, relation, b)) wrong++
          })
          rounded += countRoundedOperations(circuit, values, stageOperations)
        }
        expect({minimum, endWithBoolean, wrong, rounded}).toEqual({minimum, endWithBoolean, wrong: 0, rounded: 0})
        checkTensorAgreement(circuit, bits, pairs.filter((_, index) => index % 5 === 0).map(([a, b]) => Float32Array.of(a, b)))
      }
    }
  })

  test('costs for operands within 0..16,384, and the stage count for the largest bound', () => {
    const {circuit, bits} = buildPairCircuit(0, 16_384)
    expect(bits.map(bit => cost(circuit, bit))).toEqual([
      {operations: 16, layers: 15},
      {operations: 15, layers: 14},
      {operations: 16, layers: 15},
      {operations: 15, layers: 14},
      {operations: 28, layers: 14},
    ])
    const rounding = buildPairCircuit(0, 16_384, {endWithBoolean: true})
    expect(rounding.bits.map(bit => cost(rounding.circuit, bit))).toEqual([
      {operations: 15, layers: 13},
      {operations: 14, layers: 13},
      {operations: 15, layers: 13},
      {operations: 14, layers: 13},
      {operations: 25, layers: 13},
    ])
    // Operands within ±largestFinite / 2: 12 stages, 11 of them clamps.
    const largest = buildPairCircuit(-f(largestFinite / 2), f(largestFinite / 2))
    expect(cost(largest.circuit, largest.bits[1]!)).toEqual({operations: 1 + 3 + 10 * 2 + 1, layers: 1 + 11 * 2 + 1})
  })

  test('a comparison against 0 reads its operand directly, constants fold, and a wire equals itself', () => {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -16_384, 16_384)
    const zero = circuit.affine([], 0)
    const positive = emitCompare(circuit, circuit.source(0), '>', zero)
    const notNegative = emitCompare(circuit, zero, '<=', circuit.source(0))
    expect(cost(circuit, positive)).toEqual({operations: 15, layers: 14})
    for (const value of [0, -0, smallestSubnormal, -smallestSubnormal, 1, -16_384, nextDown(16_384)]) {
      const values = circuit.evaluateReference(Float32Array.of(value))
      expect([values[positive], values[notNegative]]).toEqual([value > 0 ? 1 : 0, value >= 0 ? 1 : 0])
    }
    // A threshold that isn't 0 keeps its difference as an operation.
    const threshold = f(0.3)
    const aboveThreshold = emitCompare(circuit, circuit.source(0), '>=', circuit.affine([], threshold))
    for (const value of [threshold, nextDown(threshold), nextUp(threshold), 0.3]) {
      expect(circuit.evaluateReference(Float32Array.of(value))[aboveThreshold]).toBe(f(value) >= threshold ? 1 : 0)
    }
    const seven = circuit.affine([], 7)
    const constantBit = emitCompare(circuit, seven, '>', circuit.affine([], 3))
    expect(circuit.constants[constantBit]).toBe(1)
    expect(circuit.constants[emitCompare(circuit, circuit.source(0), '===', circuit.source(0))]).toBe(1)
    expect(circuit.constants[emitCompare(circuit, circuit.source(0), '<', circuit.source(0))]).toBe(0)
  })

  test('refuses open ranges, overflowing differences and unknown relations', () => {
    const circuit = new Circuit(3)
    circuit.assumeRange(circuit.source(0), 0, 16_384)
    circuit.assumeRange(circuit.source(1), 0, Number.POSITIVE_INFINITY)
    circuit.assumeRange(circuit.source(2), -largestFinite, largestFinite)
    expect(() => emitCompare(circuit, circuit.source(0), '>', circuit.source(1))).toThrow('finite declared ranges')
    const unrangedCircuit = new Circuit(2)
    unrangedCircuit.assumeRange(unrangedCircuit.source(0), 0, 1)
    expect(() => emitCompare(unrangedCircuit, unrangedCircuit.source(0), '>=', unrangedCircuit.source(1))).toThrow('finite declared ranges')
    // A wire compared with itself folds to a constant only with a finite declared
    // range: a product of undeclared cells can be NaN, e.g. Infinity × 0, and NaN >= NaN is false.
    const productCircuit = new Circuit(2)
    const product = productCircuit.multiply(productCircuit.source(0), productCircuit.source(1))
    for (const relation of relations) {
      expect(() => emitCompare(productCircuit, product, relation, product)).toThrow('finite declared ranges')
    }
    // f(largestFinite - -largestFinite) is Infinity.
    expect(() => emitCompare(circuit, circuit.source(2), '>', circuit.affine([[circuit.source(2), -1]]))).toThrow('can overflow FP32')
    expect(() => emitCompare(circuit, circuit.source(0), '!==' as Relation, circuit.source(2))).toThrow('comparison relation')
  })

  test('the 1732 px column boundary reads the FP32 value, not float64', () => {
    // lab/trace-compiler: f(f(1732 - 24) × f(1/244)) is one FP32 step below 7, while float64 gives exactly 7.
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), 0, 16_384)
    const widthMinusGutter = circuit.roundAffine([[circuit.source(0), 1]], -24)
    const columnsReal = circuit.roundAffine([[widthMinusGutter, f(1 / 244)]])
    const atLeastSeven = emitCompare(circuit, columnsReal, '>=', circuit.affine([], 7))
    const values = circuit.evaluateReference(Float32Array.of(1732))
    expect(values[columnsReal]).toBe(nextDown(7))
    expect(values[atLeastSeven]).toBe(0)
  })
})

describe('grids', () => {
  test('operands on a grid get integer bits that equal JavaScript', () => {
    const random = createRandom(11)
    for (const endWithBoolean of [false, true]) {
      const {circuit, bits} = buildPairCircuit(-8192, 8192, {grid: 1 / 64, endWithBoolean})
      const pairs: [number, number][] = [[0, 0], [-0, 0], [8192, -8192], [-8192, 8192], [100, 100 + 1 / 64], [100 + 1 / 64, 100], [-1 / 64, 0]]
      for (let index = 0; index < 3000; index++) {
        const a = Math.round((2 * random() - 1) * 8192 * 64) / 64
        const b = index % 3 === 0 ? a : index % 3 === 1 ? Math.max(-8192, Math.min(8192, a + (random() < 0.5 ? 1 : -1) / 64)) : Math.round((2 * random() - 1) * 8192 * 64) / 64
        pairs.push([a, b])
      }
      let wrong = 0
      for (const [a, b] of pairs) {
        const values = circuit.evaluateReference(Float32Array.of(a, b))
        validateGrids(circuit, values)
        relations.forEach((relation, index) => {
          if (values[bits[index]!] !== nativeCompare(a, relation, b)) wrong++
        })
      }
      expect(wrong).toBe(0)
      checkTensorAgreement(circuit, bits, pairs.slice(0, 200).map(([a, b]) => Float32Array.of(a, b)))
    }
  })

  test('costs, mixed grids, thresholds, and the fallback to the cascade', () => {
    const {circuit, bits} = buildPairCircuit(-8192, 8192, {grid: 1 / 64})
    expect(bits.map(bit => cost(circuit, bit))).toEqual([
      {operations: 2, layers: 2},
      {operations: 2, layers: 2},
      {operations: 2, layers: 2},
      {operations: 2, layers: 2},
      {operations: 3, layers: 2},
    ])
    const rounding = buildPairCircuit(-8192, 8192, {grid: 1 / 64, endWithBoolean: true})
    expect(rounding.bits.map(bit => cost(rounding.circuit, bit))).toEqual([
      {operations: 1, layers: 1},
      {operations: 1, layers: 1},
      {operations: 1, layers: 1},
      {operations: 1, layers: 1},
      {operations: 3, layers: 2},
    ])
    // A 1/64 grid against a 1/4 grid resolves on the finer grid, and a constant threshold on the grid folds into the bias.
    const mixed = new Circuit(2)
    mixed.assumeRange(mixed.source(0), 0, 4096)
    mixed.assumeGrid(mixed.source(0), 1 / 64)
    mixed.assumeRange(mixed.source(1), 0, 4096)
    mixed.assumeGrid(mixed.source(1), 1 / 4)
    const pointerPastEdge = emitCompare(mixed, mixed.source(0), '>', mixed.source(1))
    const pointerPastHalf = emitCompare(mixed, mixed.source(0), '>=', mixed.affine([], 7.5))
    expect([cost(mixed, pointerPastEdge), cost(mixed, pointerPastHalf)]).toEqual([{operations: 2, layers: 2}, {operations: 2, layers: 2}])
    for (const [pointer, edge] of [[10, 10], [10 + 1 / 64, 10], [7.5 - 1 / 64, 0], [7.5, 4096], [4096, 4096]] as const) {
      const values = mixed.evaluateReference(Float32Array.of(pointer, edge))
      expect([values[pointerPastEdge], values[pointerPastHalf]]).toEqual([pointer > edge ? 1 : 0, pointer >= 7.5 ? 1 : 0])
    }
    // f(0.3) sits on a grid of 2^-25, so operands up to 16,384 are too many grid steps: the cascade takes over.
    const threshold = mixed.affine([], f(0.3))
    expect(cost(mixed, emitCompare(mixed, mixed.source(0), '>=', threshold))).toEqual({operations: 15, layers: 14})
    // Operands within 0..2^17 on a 1/64 grid fit 2^24 grid steps; 0..2^18 doesn't.
    expect(cost(buildPairCircuit(0, 2 ** 17, {grid: 1 / 64}).circuit, asWire(3))).toEqual({operations: 2, layers: 2})
    const wide = buildPairCircuit(0, 2 ** 18, {grid: 1 / 64})
    expect(cost(wide.circuit, wide.bits[1]!)).toEqual({operations: 15, layers: 14})
    const wideRounding = buildPairCircuit(0, 2 ** 18, {grid: 1 / 64, endWithBoolean: true})
    expect(cost(wideRounding.circuit, wideRounding.bits[1]!).operations).toBeGreaterThan(1)
  })

  test('grid bits need no FP32 rounding; atoms do; subnormal values matter only to the cascade', () => {
    const random = createRandom(12)
    const gridPairs: [number, number][] = Array.from({length: 1500}, (_, index) => {
      const a = Math.round(random() * 4096 * 64) / 64
      return [a, index % 2 === 0 ? a : Math.round(random() * 4096 * 64) / 64]
    })
    const countWrong = (circuit: Circuit, bits: readonly Wire[], pairs: readonly [number, number][], mode: ExecutorMode) => {
      let wrong = 0
      for (const [a, b] of pairs) {
        const values = evaluateWithMode(circuit, Float32Array.of(a, b), mode)
        relations.forEach((relation, index) => {
          if (values[bits[index]!] !== nativeCompare(a, relation, b)) wrong++
        })
      }
      return wrong
    }
    const grid = buildPairCircuit(0, 4096, {grid: 1 / 64})
    expect(executorModes.map(mode => countWrong(grid.circuit, grid.bits, gridPairs, mode))).toEqual([0, 0, 0, 0])
    const gridRounding = buildPairCircuit(0, 4096, {grid: 1 / 64, endWithBoolean: true})
    expect(countWrong(gridRounding.circuit, gridRounding.bits, gridPairs, 'reversedTerms')).toBe(0)
    expect(countWrong(gridRounding.circuit, gridRounding.bits, gridPairs, 'float64')).toBeGreaterThan(0)
    const cascadePairs = operandPairs(0, 4096, 13, 300)
    const cascade = buildPairCircuit(0, 4096)
    const [float64Wrong, reversedWrong, fusedWrong, flushWrong] = executorModes.map(mode => countWrong(cascade.circuit, cascade.bits, cascadePairs, mode))
    expect([float64Wrong, reversedWrong, fusedWrong]).toEqual([0, 0, 0])
    // Setting subnormal values to 0 breaks differences below 2^-126, and native comparisons on the same hardware.
    const subnormalPairs = cascadePairs.filter(([a, b]) => a !== b && Math.abs(f(a - b)) < smallestNormal).length
    expect(subnormalPairs).toBeGreaterThan(0)
    expect(flushWrong).toBeGreaterThan(0)
    expect(countWrong(cascade.circuit, cascade.bits, cascadePairs.filter(([a, b]) => a === b || Math.abs(f(a - b)) >= smallestNormal), 'flushSubnormals')).toBe(0)
  })

  test('grids are inferred through sums and products that cannot round', () => {
    const circuit = new Circuit(4)
    circuit.assumeRange(circuit.source(0), 0, 16_384)
    circuit.assumeGrid(circuit.source(0), 1 / 64)
    circuit.assumeRange(circuit.source(1), -8, 8)
    circuit.assumeGrid(circuit.source(1), 1 / 4)
    circuit.assumeRange(circuit.source(2), 0, 1)
    circuit.assumeRange(circuit.source(3), 0, 1)
    expect(circuit.grids[circuit.affine([[circuit.source(0), 1], [circuit.source(1), -1]], 3)]).toBe(1 / 64)
    expect(circuit.grids[circuit.affine([[circuit.source(0), 0.5], [circuit.source(1), 3]])]).toBe(1 / 128)
    expect(circuit.grids[circuit.reglu([], 1, [[circuit.source(0), 1]], -100)]).toBe(1 / 64)
    // f(1/3) is 11184811 × 2^-25, so 16,384 / 3 needs more than 2^24 steps of 2^-31.
    expect(circuit.grids[circuit.affine([[circuit.source(0), 1 / 3]])]).toBeUndefined()
    // 8 × 16,384 = 2^17 isn't a multiple of 1/256 within 2^24 steps.
    expect(circuit.grids[circuit.multiply(circuit.source(0), circuit.source(1))]).toBeUndefined()
    expect(circuit.grids[circuit.affine([[circuit.source(0), 1], [circuit.source(2), 1]])]).toBeUndefined()
    circuit.assumeRange(circuit.source(3), 0, 1)
    expect(circuit.grids[circuit.boolean(circuit.source(3))]).toBe(1)
    expect(circuit.grids[circuit.indexRead(circuit.affine([], 0), [circuit.source(0), circuit.source(1)])]).toBe(1 / 64)
    circuit.assumeRange(circuit.source(2), 0, 1)
    expect(circuit.grids[circuit.indexRead(emitCompare(circuit, circuit.source(0), '>', circuit.affine([], 5)), [circuit.source(0), circuit.source(1)])]).toBeUndefined()
    // A coarser declaration is kept. Operations already read source 0, so the late declaration needs the opt-out.
    circuit.assumeGrid(circuit.source(0), 1, {allowExistingReaders: true})
    circuit.assumeGrid(circuit.source(0), 1 / 64)
    expect(circuit.grids[0]).toBe(1)
    expect(() => circuit.assumeGrid(circuit.source(1), 0.3)).toThrow('power of two')
    expect(() => circuit.assumeGrid(circuit.source(1), 0)).toThrow('power of two')
    expect(() => validateGrids(circuit, circuit.evaluateReference(Float32Array.of(100.5, 0.25, 0, 0)))).toThrow('multiple of 1')
  })

  test('random circuits over grid sources hold the grids they infer', () => {
    const random = createRandom(21)
    const coefficients = [1, -1, 0.5, 2, 3, -0.25, 1 / 3, 64]
    // Products grow ranges quickly, so a circuit can end with no provable grid; count over all circuits.
    let inferred = 0
    for (let circuitIndex = 0; circuitIndex < 40; circuitIndex++) {
      const sourceGrids = [1 / 64, 1 / 4, 1, 2 ** -10]
      const circuit = new Circuit(sourceGrids.length)
      sourceGrids.forEach((grid, wire) => {
        circuit.assumeRange(asWire(wire), -512, 512)
        circuit.assumeGrid(asWire(wire), grid)
      })
      const pickWire = () => asWire(Math.floor(random() * (circuit.sourceSize + circuit.operations.length)))
      const pickTerms = (): Terms => Array.from({length: 1 + Math.floor(random() * 3)}, () => [pickWire(), coefficients[Math.floor(random() * coefficients.length)]!] as const)
      for (let operationIndex = 0; operationIndex < 30; operationIndex++) {
        const choice = Math.floor(random() * 4)
        if (choice === 0) circuit.affine(pickTerms(), Math.round(random() * 8) / 8)
        else if (choice === 1) circuit.roundAffine(pickTerms())
        else if (choice === 2) circuit.reglu(pickTerms(), 0, pickTerms(), Math.round(random() * 4) / 4)
        else circuit.multiply(pickWire(), pickWire())
      }
      inferred += circuit.grids.slice(circuit.sourceSize).filter(grid => grid !== undefined).length
      for (let sample = 0; sample < 30; sample++) {
        const source = Float32Array.from(sourceGrids, grid => Math.round((2 * random() - 1) * 512 / grid) * grid)
        validateGrids(circuit, circuit.evaluateReference(source))
      }
    }
    expect(inferred).toBeGreaterThan(100)
  })
})

describe('backward pass', () => {
  const gradientsAt = (circuit: Circuit, bit: Wire, source: Float32Array, options?: {booleanGradient: 'straight-through'}) => {
    const values = circuit.evaluateReference(source)
    const seeds = new Float32Array(values.length)
    seeds[bit] = 1
    return circuit.backpropagateReference(values, seeds, options)
  }

  test('the cascade runs without a special case and gives the operands 0', () => {
    const {circuit, bits} = buildPairCircuit(0, 16_384)
    for (const difference of [-100, -1, -smallestSubnormal, 0, smallestSubnormal, 2 ** -30, 0.3, 100]) {
      const source = difference >= 0 ? Float32Array.of(difference, 0) : Float32Array.of(0, -difference)
      for (const bit of bits) {
        const gradients = gradientsAt(circuit, bit, source)
        expect([gradients[0], gradients[1]]).toEqual([0, 0])
      }
    }
  })

  test('grid bits have slope 1 on fractional inputs, and atoms throw without straight-through', () => {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -1000, 1000)
    circuit.assumeGrid(circuit.source(0), 1)
    const atLeastFive = emitCompare(circuit, circuit.source(0), '>=', circuit.affine([], 5))
    expect([3, 4, 4.5, 5, 6].map(value => gradientsAt(circuit, atLeastFive, Float32Array.of(value))[0])).toEqual([0, 0, 1, 0, 0])
    expect(circuit.evaluateReference(Float32Array.of(4.5))[atLeastFive]).toBe(0.5)
    for (const grid of [1, undefined]) {
      const rounding = new Circuit(2)
      for (const wire of [0, 1]) {
        rounding.assumeRange(asWire(wire), 0, 16_384)
        if (grid !== undefined) rounding.assumeGrid(asWire(wire), grid)
      }
      const bit = emitCompare(rounding, rounding.source(0), '>', rounding.source(1), {endWithBoolean: true})
      expect(() => gradientsAt(rounding, bit, Float32Array.of(3, 2))).toThrow('cannot backpropagate through a boolean atom')
      expect(Number.isFinite(gradientsAt(rounding, bit, Float32Array.of(3, 2), {booleanGradient: 'straight-through'})[0])).toBe(true)
    }
  })
})

describe('rounding points', () => {
  test('every operation emitCompare builds is recorded, as integer bits on grids and sign cascade stages otherwise, and atoms are recorded as booleans', () => {
    for (const grid of [undefined, 1 / 64]) {
      for (const endWithBoolean of [false, true]) {
        for (const relation of relations) {
          const circuit = new Circuit(2)
          for (const wire of [0, 1]) {
            circuit.assumeRange(asWire(wire), 0, 4096)
            if (grid !== undefined) circuit.assumeGrid(asWire(wire), grid)
          }
          const bit = emitCompare(circuit, circuit.source(0), relation, circuit.source(1), {endWithBoolean})
          const recorded = new Map(circuit.roundingPoints().map(({wire, kind}) => [wire, kind]))
          const program = circuit.compileTensorProgram([bit])
          for (let packed = circuit.sourceSize; packed < program.valueCount; packed++) {
            const wire = program.wireOrder[packed]!
            const operation = circuit.operations[wire - circuit.sourceSize]!
            // Operands within 0..4096 on a 1/64 grid are 2^18 grid steps, so every grid comparison builds integer bits.
            expect(recorded.get(asWire(wire))).toBe(operation.kind === 'boolean' ? 'boolean' : grid === undefined ? 'sign cascade' : 'integer bit')
          }
          // The only unrecorded operation is the score the atom of a strict rounding stage copies in.
          expect(circuit.operations.length - recorded.size).toBe(grid === undefined && endWithBoolean && (relation === '>' || relation === '<') ? 1 : 0)
        }
      }
    }
  })

  test('marking, and inlining keeps records, grids and values', () => {
    const child = new Circuit(3)
    child.assumeRange(child.source(0), 0, 4096)
    child.assumeRange(child.source(1), 0, 4096)
    child.assumeGrid(child.source(0), 1 / 64)
    child.assumeGrid(child.source(1), 1 / 64)
    child.assumeRange(child.source(2), -100, 100)
    const roundChain = child.roundAffine([[child.source(2), 1]], 2 ** 23 + 2 ** 22)
    child.markRoundingPoint(roundChain)
    expect(() => child.markRoundingPoint(child.source(2))).toThrow('not a source cell')
    const roots = [
      emitCompare(child, child.source(0), '>=', child.source(1)),
      emitCompare(child, child.source(0), '===', child.source(1), {endWithBoolean: true}),
      emitCompare(child, child.source(2), '<', child.affine([], f(0.3))),
      emitMinimumExact(child, child.source(2), child.affine([], 1.5)),
    ]
    const parent = new Circuit(3)
    const wireMap = inlineCircuit(parent, child, [parent.source(1), parent.source(0), parent.source(2)])
    const parentKinds = new Map(parent.roundingPoints().map(({wire, kind}) => [wire, kind]))
    for (const {wire, kind} of child.roundingPoints()) expect(parentKinds.get(wireMap[wire]!)).toBe(kind)
    expect(parentKinds.get(wireMap[roundChain]!)).toBe('marked')
    expect([parent.grids[0], parent.grids[1], parent.grids[wireMap[roots[0]!]!]]).toEqual([1 / 64, 1 / 64, 1])
    for (const [a, b, c] of [[5, 5, 0.3], [5 + 1 / 64, 5, -0.3], [0, 4096, 100], [4096, 0, f(0.3)]] as const) {
      const childValues = child.evaluateReference(Float32Array.of(a, b, c))
      const parentValues = parent.evaluateReference(Float32Array.of(b, a, c))
      for (const root of roots) expect(Object.is(parentValues[wireMap[root]!], childValues[root])).toBe(true)
    }
    checkTensorAgreement(parent, roots.map(root => wireMap[root]!), [Float32Array.of(5, 5, 0.3), Float32Array.of(0, 17, -2)])
  })
})

describe('exact minimum, maximum and clamp', () => {
  test('return exactly Math.min, Math.max and the clamp, including mixed magnitudes and subnormal values', () => {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), -16_384, 16_384)
    circuit.assumeRange(circuit.source(1), -16_384, 16_384)
    const minimum = emitMinimumExact(circuit, circuit.source(0), circuit.source(1))
    const maximum = emitMaximumExact(circuit, circuit.source(0), circuit.source(1))
    const drifting = emitMinimum(circuit, circuit.source(0), circuit.source(1))
    expect([circuit.ranges[minimum], circuit.ranges[maximum]]).toEqual([{minimum: -16_384, maximum: 16_384}, {minimum: -16_384, maximum: 16_384}])
    const pairs = [...operandPairs(-16_384, 16_384, 31, 300), [f(1000.37), f(0.3)] as [number, number]]
    let wrong = 0
    for (const [a, b] of pairs) {
      const values = circuit.evaluateReference(Float32Array.of(a, b))
      if (values[minimum] !== Math.min(a, b) || values[maximum] !== Math.max(a, b)) wrong++
    }
    expect(wrong).toBe(0)
    const mixedMagnitudes = circuit.evaluateReference(Float32Array.of(f(1000.37), f(0.3)))
    expect(mixedMagnitudes[minimum]).toBe(f(0.3))
    expect(mixedMagnitudes[drifting]).not.toBe(f(0.3))
    checkTensorAgreement(circuit, [minimum, maximum], pairs.slice(0, 50).map(([a, b]) => Float32Array.of(a, b)))

    const clampCircuit = new Circuit(3)
    clampCircuit.assumeRange(clampCircuit.source(0), -100, 100)
    clampCircuit.assumeRange(clampCircuit.source(1), -50, 50)
    clampCircuit.assumeRange(clampCircuit.source(2), -50, 50)
    const clamped = emitClampExact(clampCircuit, clampCircuit.source(0), clampCircuit.source(1), clampCircuit.source(2))
    const toSixteen = emitClampExact(clampCircuit, clampCircuit.source(0), clampCircuit.affine([], 0), clampCircuit.affine([], 16))
    expect(clampCircuit.ranges[toSixteen]).toEqual({minimum: 0, maximum: 16})
    const random = createRandom(32)
    for (let sample = 0; sample < 2000; sample++) {
      const [value, low, high] = [f((2 * random() - 1) * 100), f((2 * random() - 1) * 50), f((2 * random() - 1) * 50)]
      const values = clampCircuit.evaluateReference(Float32Array.of(value, low, high))
      expect(values[clamped]).toBe(Math.min(Math.max(value, low), high))
      expect(values[toSixteen]).toBe(Math.min(Math.max(value, 0), 16))
    }
  })
})
