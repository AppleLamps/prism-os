// Checks each comparison example against plain JavaScript, and pins the measurements that
// guide/sections/comparisons.md quotes. report.ts prints the full tables.
import {expect, test} from 'bun:test'
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitCompare} from '../../../numeric-library/comparison.ts'
import {emitAtLeastByRounding, emitAtLeastIntegerByRounding, emitGreaterByRounding, emitPositiveBitByRounding, emitRoundingStage, planRoundingCompare} from './boolean-atom.ts'
import {buildLineFill, type ChainForm, countLineFillMismatches} from './chain.ts'
import {createRandom, differenceClasses, largestFinite, measureCost, nextDown, smallestNormal, smallestSubnormal} from './fp32.ts'
import {emitAtLeastInteger, emitAtLeastOnGrid} from './integer-bit.ts'
import {cascadeSignTest, checkDifferenceClasses, columnsAtLeastSevenAt1732, differenceCell, pairWithDifference, pixelPair, randomPixelPairs, roundingSignTest, traceCompilerSignTest} from './measure.ts'
import {evaluateWithMode, type ExecutorMode, executorModes} from './rewrites.ts'
import {emitAtLeast, emitEqual, emitGreater, emitPositiveBitWithScales, emitTraceCompilerCascade, planSignCascade} from './sign-cascade.ts'

function costOf(build: (circuit: Circuit) => Wire) {
  const circuit = pixelPair()
  return measureCost(circuit, [build(circuit)])
}

test('integer bit equals value >= threshold for integers within 2^23', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(circuit.source(0), -(2 ** 23), 2 ** 23)
  const thresholds = [-3, 0, 1, 7, 2 ** 22]
  const bits = thresholds.map(threshold => emitAtLeastInteger(circuit, circuit.source(0), threshold))
  const values = [...Array.from({length: 41}, (_, index) => index - 20), 2 ** 22 - 1, 2 ** 22, 2 ** 22 + 1, 2 ** 23, -(2 ** 23)]
  for (const value of values) {
    const wires = circuit.evaluateReference(Float32Array.of(value))
    thresholds.forEach((threshold, index) => expect(wires[bits[index]!]).toBe(value >= threshold ? 1 : 0))
  }
})

test('integer bit on a 1/64 grid equals a >= b, in 3 operations and 2 layers', () => {
  const circuit = pixelPair()
  const bit = emitAtLeastOnGrid(circuit, circuit.source(0), circuit.source(1), 1 / 64)
  const random = createRandom(1)
  const pairs: [number, number][] = [[100, 100], [100, 100 + 1 / 64], [100 + 1 / 64, 100], [0, 16384], [16384, 0]]
  for (let index = 0; index < 4000; index++) pairs.push([Math.round(random() * 16384 * 64) / 64, Math.round(random() * 16384 * 64) / 64])
  for (const [a, b] of pairs) expect(circuit.evaluateReference(Float32Array.of(a, b))[bit]).toBe(a >= b ? 1 : 0)
  expect(measureCost(circuit, [bit])).toEqual({operations: 3, layers: 2})
})

test('one boolean atom equals a >= b for integers in [0, 2^22], in 1 operation and 1 layer', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), 0, 2 ** 22)
  circuit.assumeRange(circuit.source(1), 0, 2 ** 22)
  const bit = emitAtLeastIntegerByRounding(circuit, circuit.source(0), circuit.source(1))
  const random = createRandom(2)
  const pairs: [number, number][] = [[0, 0], [0, 1], [1, 0], [2 ** 22, 0], [0, 2 ** 22], [2 ** 22, 2 ** 22]]
  for (let index = 0; index < 3000; index++) {
    const a = Math.floor(random() * 2 ** 22)
    pairs.push([a, index % 3 === 0 ? a : index % 3 === 1 ? a + 1 : Math.floor(random() * 2 ** 22)])
  }
  for (const [a, b] of pairs) expect(circuit.evaluateReference(Float32Array.of(a, b))[bit]).toBe(a >= b ? 1 : 0)
  expect(measureCost(circuit, [bit])).toEqual({operations: 1, layers: 1})
})

test('cost of [a > b] for a, b in [0, 16384]', () => {
  // Every pair of distinct FP32 values, by how far a later stage may multiply.
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {stageExponent: 1}))).toEqual({operations: 282, layers: 281})
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {stageExponent: 8}))).toEqual({operations: 40, layers: 39})
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {stageExponent: 23}))).toEqual({operations: 18, layers: 17})
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1)))).toEqual({operations: 16, layers: 15})
  const traceLayout = (stageExponent: number) => costOf(circuit => emitTraceCompilerCascade(circuit, circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), -1]]), 16384, stageExponent).bit)
  expect(traceLayout(1)).toEqual({operations: 428, layers: 428})
  expect(traceLayout(8)).toEqual({operations: 59, layers: 59})
  expect(traceLayout(23)).toEqual({operations: 26, layers: 26})
  expect(costOf(circuit => emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1)))).toEqual({operations: 15, layers: 13})
  // With a stated resolution.
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -60}))).toEqual({operations: 10, layers: 9})
  expect(costOf(circuit => emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -60}))).toEqual({operations: 9, layers: 7})
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -30}))).toEqual({operations: 6, layers: 5})
  expect(costOf(circuit => emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -30}))).toEqual({operations: 4, layers: 3})
  expect(costOf(circuit => emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -10}))).toEqual({operations: 4, layers: 3})
  expect(costOf(circuit => emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -10}))).toEqual({operations: 4, layers: 3})
  // The negation for [a >= b] is copied into the product that reads it.
  expect(costOf(circuit => circuit.reglu([[circuit.source(0), 1]], 0, [[emitAtLeast(circuit, circuit.source(0), circuit.source(1), {resolution: 1 / 64}), 1]], 0))).toEqual({operations: 5, layers: 4})
  // Equality shares the difference between its two cascades.
  expect(costOf(circuit => emitEqual(circuit, circuit.source(0), circuit.source(1)))).toEqual({operations: 32, layers: 16})
})

test('every cascade plan keeps each stage inside the exact range and reaches the resolution', () => {
  for (const differenceBound of [2 ** -3, 1, 16384, 2 ** 24, 2 ** 30, largestFinite]) {
    for (const resolution of [smallestSubnormal, 2 ** -30, 1 / 64, 1, 2 ** 10]) {
      for (const stageExponent of [1, 8, 23, 24]) {
        const plan = planSignCascade({differenceBound, resolution, stageExponent})
        let previousLimit = plan.differenceBound
        let gain = 1
        for (const {scale, limit} of plan.stages) {
          expect(scale * previousLimit).toBeLessThanOrEqual(2 ** 24 * limit)
          expect(scale).toBeGreaterThanOrEqual(1)
          previousLimit = limit
          gain *= scale
        }
        expect(previousLimit).toBe(1)
        expect(plan.resolution * gain).toBeGreaterThanOrEqual(Math.min(1, plan.resolution))
      }
    }
  }
})

test('the cascade is exact over every class of FP32 difference, and none of its operations rounds', () => {
  const configurations = [
    [cascadeSignTest(largestFinite, 24), 300, true],
    [cascadeSignTest(largestFinite, 8), 300, true],
    [cascadeSignTest(16384, 1), 100, false],
    [traceCompilerSignTest(16384, 23), 300, true],
    [traceCompilerSignTest(16384, 1), 100, false],
  ] as const
  for (const [signTest, randomCount, exactCheck] of configurations) {
    const result = checkDifferenceClasses(signTest, {seed: 5, randomCount, exactCheck})
    expect(result.tested).toBeGreaterThan(200)
    expect(result.largestStageRatio).toBeLessThanOrEqual(1)
    expect({wrong: result.wrong, fractional: result.fractional, stageViolations: result.stageViolations, roundedResults: result.roundedResults, tensorMismatches: result.tensorMismatches})
      .toEqual({wrong: 0, fractional: 0, stageViolations: 0, roundedResults: 0, tensorMismatches: 0})
  }
})

test('the shortened cascade in the section gives the same bits and cost as emitPositiveBit', () => {
  const plan = planSignCascade({differenceBound: 16384})
  expect(plan.stages.map(({scale}) => Math.log2(scale))).toEqual([10, 24, 24, 24, 24, 24, 19])
  const planned = cascadeSignTest(16384)
  const shortened = differenceCell(16384)
  const shortenedBit = emitPositiveBitWithScales(shortened, shortened.source(0), plan.stages.map(({scale}) => scale))
  expect(measureCost(shortened, [shortenedBit])).toEqual(measureCost(planned.circuit, [planned.bit]))
  for (const {values} of differenceClasses(16384, createRandom(9), 300)) {
    for (const difference of values) {
      const source = Float32Array.of(difference)
      expect(shortened.evaluateReference(source)[shortenedBit]).toBe(planned.circuit.evaluateReference(source)[planned.bit]!)
    }
  }
})

test('copying each stage output into the next stage makes partial sums round and breaks the cascade', () => {
  const result = checkDifferenceClasses(cascadeSignTest(16384, 24, true), {seed: 5, randomCount: 300, exactCheck: true})
  expect(result.wrong).toBeGreaterThan(0)
  expect(result.roundedResults).toBeGreaterThan(0)
})

test('[a > b], [a >= b] and [a === b] equal JavaScript on pairs with equal, adjacent, and tiny operands', () => {
  const pairs = randomPixelPairs(11, 5000)
  for (const build of [
    (circuit: Circuit) => [emitGreater(circuit, circuit.source(0), circuit.source(1)), emitAtLeast(circuit, circuit.source(0), circuit.source(1)), emitEqual(circuit, circuit.source(0), circuit.source(1))] as const,
    (circuit: Circuit) => [emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1)), emitAtLeastByRounding(circuit, circuit.source(0), circuit.source(1)), null] as const,
  ]) {
    const circuit = pixelPair()
    const [greater, atLeast, equal] = build(circuit)
    let wrong = 0
    for (const [a, b] of pairs) {
      const wires = circuit.evaluateReference(Float32Array.of(a, b))
      if (wires[greater] !== (a > b ? 1 : 0) || wires[atLeast] !== (a >= b ? 1 : 0)) wrong++
      if (equal !== null && wires[equal] !== (a === b ? 1 : 0)) wrong++
    }
    expect(wrong).toBe(0)
  }
})

test('a cascade planned for a coarser resolution returns fractions below that resolution', () => {
  const circuit = pixelPair()
  const bit = emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -10})
  expect(circuit.evaluateReference(pairWithDifference(2 ** -20))[bit]).toBe(2 ** -10)
  expect(circuit.evaluateReference(pairWithDifference(2 ** -10))[bit]).toBe(1)
})

test('one rounding stage always returns a bit, and returns 0 for positive differences below 2^-34', () => {
  const circuit = differenceCell(16384)
  const plan = planRoundingCompare({differenceBound: 16384, resolution: 2 ** -31})
  expect(plan.clampStages).toBeNull()
  expect(plan.finalScale).toBe(2 ** 8)
  const bit = emitPositiveBitByRounding(circuit, circuit.source(0), plan)
  expect(measureCost(circuit, [bit])).toEqual({operations: 3, layers: 2})
  expect(circuit.evaluateReference(Float32Array.of(2 ** -34))[bit]).toBe(1)
  expect(circuit.evaluateReference(Float32Array.of(nextDown(2 ** -34)))[bit]).toBe(0)
  for (const {values} of differenceClasses(16384, createRandom(2), 1000)) {
    for (const difference of values) {
      const output = circuit.evaluateReference(Float32Array.of(difference))[bit]
      expect(output === 0 || output === 1).toBe(true)
      if (Math.abs(difference) >= 2 ** -31 || difference <= 0) expect(output).toBe(difference > 0 ? 1 : 0)
    }
  }
})

test('the column boundary at viewport width 1732', () => {
  const roundingStageWithScale = (scale: number) => (circuit: Circuit, columnsReal: Wire, seven: Wire) => {
    const difference = circuit.roundAffine([[seven, 1], [columnsReal, -1]])
    return circuit.affine([[emitRoundingStage(circuit, difference, scale), -1]], 1)
  }
  const cascade = columnsAtLeastSevenAt1732((circuit, columnsReal, seven) => emitAtLeast(circuit, columnsReal, seven))
  expect(cascade.columnsReal).toBe(nextDown(7))
  expect((1732 - 24) / 244 >= 7).toBe(true)
  expect(cascade.bit).toBe(0)
  expect(columnsAtLeastSevenAt1732((circuit, columnsReal, seven) => emitAtLeastByRounding(circuit, columnsReal, seven, {resolution: 2 ** -30})).bit).toBe(0)
  expect(columnsAtLeastSevenAt1732(roundingStageWithScale(2 ** -5)).bit).toBe(0)
  expect(columnsAtLeastSevenAt1732(roundingStageWithScale(2 ** -6)).bit).toBe(1)
})

test('numeric-library emitCompare returns 0 for [2^-149 > 0] once the declared difference bound passes 2^23', () => {
  const greaterAtSmallestSubnormal = (bound: number) => {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), -bound / 2, bound / 2)
    circuit.assumeRange(circuit.source(1), -bound / 2, bound / 2)
    const bit = emitCompare(circuit, circuit.source(0), circuit.source(1), '>')
    return circuit.evaluateReference(Float32Array.of(smallestSubnormal, 0))[bit]
  }
  expect(greaterAtSmallestSubnormal(2 ** 23)).toBe(1)
  expect(greaterAtSmallestSubnormal(2 ** 30)).toBe(0)
})

test('executor modes: integer bits and the cascade need no rounding; the boolean atom needs rounding; subnormals matter to both', () => {
  const differences = differenceClasses(16384, createRandom(3), 1000).flatMap(({values}) => values)
  const differenceCases = differences.map(difference => ({source: Float32Array.of(difference), expected: difference > 0 ? 1 : 0}))
  const positiveSubnormals = differences.filter(difference => difference > 0 && difference < smallestNormal).length
  const countWrong = (circuit: Circuit, bit: Wire, cases: readonly {source: Float32Array, expected: number}[]) =>
    Object.fromEntries(executorModes.map(mode => [mode, cases.filter(({source, expected}) => evaluateWithMode(circuit, source, mode)[bit] !== expected).length])) as Record<ExecutorMode, number>
  {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -1000, 1000)
    const bit = emitAtLeastInteger(circuit, circuit.source(0), 7)
    const cases = Array.from({length: 2001}, (_, index) => ({source: Float32Array.of(index - 1000), expected: index - 1000 >= 7 ? 1 : 0}))
    expect(Object.values(countWrong(circuit, bit, cases))).toEqual(executorModes.map(() => 0))
  }
  {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), 0, 2 ** 22)
    circuit.assumeRange(circuit.source(1), 0, 2 ** 22)
    const bit = emitAtLeastIntegerByRounding(circuit, circuit.source(0), circuit.source(1))
    const cases = Array.from({length: 1000}, (_, index) => ({source: Float32Array.of(index, 500), expected: index >= 500 ? 1 : 0}))
    const wrong = countWrong(circuit, bit, cases)
    expect([wrong.stored, wrong.reversedTerms, wrong.sumsRoundedOnce, wrong.flushSubnormals]).toEqual([0, 0, 0, 0])
    expect([wrong.float64, wrong.atomRewrittenToScore]).toEqual([1000, 1000])
  }
  {
    const signTest = cascadeSignTest(16384)
    const wrong = countWrong(signTest.circuit, signTest.bit, differenceCases)
    expect([wrong.stored, wrong.float64, wrong.atomRewrittenToScore, wrong.reversedTerms, wrong.sumsRoundedOnce]).toEqual([0, 0, 0, 0, 0])
    expect(positiveSubnormals).toBeGreaterThan(0)
    expect(wrong.flushSubnormals).toBe(positiveSubnormals)
  }
  {
    const signTest = roundingSignTest(16384)
    const wrong = countWrong(signTest.circuit, signTest.bit, differenceCases)
    expect([wrong.stored, wrong.reversedTerms, wrong.sumsRoundedOnce]).toEqual([0, 0, 0])
    expect(wrong.flushSubnormals).toBe(positiveSubnormals)
    // Without rounding, the atom returns its score: every false decision reads 0.49999997.
    expect(evaluateWithMode(signTest.circuit, Float32Array.of(-1), 'float64')[signTest.bit]).toBe(Math.fround(0.5 - 2 ** -25))
    expect(wrong.float64).toBeGreaterThanOrEqual(differenceCases.filter(({expected}) => expected === 0).length)
    expect(wrong.atomRewrittenToScore).toBeGreaterThanOrEqual(differenceCases.filter(({expected}) => expected === 0).length)
  }
  {
    const signTest = cascadeSignTest(16384, 24, true)
    expect(countWrong(signTest.circuit, signTest.bit, differenceCases).stored).toBeGreaterThan(0)
  }
  {
    // The stored mode is the reference semantics.
    const circuit = pixelPair()
    emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1))
    const source = Float32Array.of(123.25, 123.5)
    expect([...evaluateWithMode(circuit, source, 'stored')]).toEqual([...circuit.evaluateReference(source)])
  }
})

test('backpropagateReference through each form', () => {
  const gradients = (circuit: Circuit, bit: Wire, source: Float32Array, options?: {booleanGradient: 'straight-through'}) => {
    const values = circuit.evaluateReference(source)
    const seeds = new Float32Array(values.length)
    seeds[bit] = 1
    return circuit.backpropagateReference(values, seeds, options)
  }
  // Cascade: no special case, but the operands get 0, except at the plan's resolution, where the
  // last stage lands exactly on its ReLU's corner and the product of the scales, 2^149, overflows.
  {
    const circuit = pixelPair()
    const bit = emitGreater(circuit, circuit.source(0), circuit.source(1))
    for (const difference of [-1, 0, 2 ** -148, 2 ** -30, 0.3, 100]) {
      expect(gradients(circuit, bit, pairWithDifference(difference))[0]).toBe(0)
    }
    expect(gradients(circuit, bit, pairWithDifference(smallestSubnormal))[0]).toBe(Number.POSITIVE_INFINITY)
    const internal = gradients(circuit, bit, pairWithDifference(-1)).subarray(circuit.sourceSize)
    expect(internal.some(gradient => !Number.isFinite(gradient))).toBe(true)
  }
  // The same code at resolution 1 is a single clamp: a ramp with slope 1 between 0 and 1.
  {
    const circuit = pixelPair()
    const bit = emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 1})
    expect([-0.5, 0.5, 1, 2].map(difference => gradients(circuit, bit, pairWithDifference(difference))[0])).toEqual([0, 1, 1, 0])
  }
  // Boolean atom: rejected unless straight-through; then the score's slope, 256 while the score is inside 0..1.
  {
    const circuit = pixelPair()
    const bit = emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -31})
    expect(() => gradients(circuit, bit, pairWithDifference(0.25))).toThrow('cannot backpropagate through a boolean atom')
    expect(gradients(circuit, bit, pairWithDifference(0), {booleanGradient: 'straight-through'})[0]).toBe(256)
    expect(gradients(circuit, bit, pairWithDifference(2 ** -10), {booleanGradient: 'straight-through'})[0]).toBe(256)
    expect(gradients(circuit, bit, pairWithDifference(0.25), {booleanGradient: 'straight-through'})[0]).toBe(0)
  }
  // Clamp stages then a rounding stage, straight-through: the product of every unclamped scale, 2^126.
  {
    const circuit = pixelPair()
    const bit = emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1))
    expect(gradients(circuit, bit, pairWithDifference(smallestSubnormal), {booleanGradient: 'straight-through'})[0]).toBe(2 ** 126)
    expect(gradients(circuit, bit, pairWithDifference(0.3), {booleanGradient: 'straight-through'})[0]).toBe(0)
  }
  // Integer bit: slope 1 on the ramp, and at exactly the threshold.
  {
    const circuit = differenceCell(1000)
    const bit = emitAtLeastInteger(circuit, circuit.source(0), 5)
    expect([4, 4.5, 5, 6].map(value => gradients(circuit, bit, Float32Array.of(value))[0])).toEqual([0, 1, 1, 0])
  }
})

test('toolbar line fill: depth per item by form, and which forms match JavaScript', () => {
  const expectedCost: Record<ChainForm, {operations: number, layers: number}> = {
    atomOnGrid: {operations: 60, layers: 60},
    integerBitOnGrid: {operations: 100, layers: 80},
    roundingStageAtGridStep: {operations: 120, layers: 100},
    cascadeAtGridStep: {operations: 120, layers: 100},
    roundingEndEveryValue: {operations: 340, layers: 300},
    cascadeEveryValue: {operations: 360, layers: 340},
  }
  for (const form of Object.keys(expectedCost) as ChainForm[]) {
    const {circuit, lineWidth} = buildLineFill(form, 20)
    expect(measureCost(circuit, [lineWidth])).toEqual(expectedCost[form])
    // On 1/64 px widths every form matches plain JavaScript.
    const grid = countLineFillMismatches(form, 20, 150, true, 21)
    expect([grid.wrongDecisions, grid.fractionalDecisions, grid.wrongWidths]).toEqual([0, 0, 0])
    const float = countLineFillMismatches(form, 20, 150, false, 22)
    if (form === 'cascadeEveryValue' || form === 'roundingEndEveryValue') {
      expect([float.wrongDecisions, float.fractionalDecisions, float.wrongWidths]).toEqual([0, 0, 0])
    } else if (form !== 'roundingStageAtGridStep') {
      // Differences smaller than 1/64 px give wrong bits or fractions.
      expect(float.wrongDecisions).toBeGreaterThan(0)
    }
  }
})
