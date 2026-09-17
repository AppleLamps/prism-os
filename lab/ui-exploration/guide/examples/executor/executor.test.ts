import {expect, test} from 'bun:test'
import {type Circuit, type Wire, validateOneHotGroups} from '../../../../../src/runtime/numeric-ui-core.ts'
import {
  buildCloseButtonHitTest,
  buttonInset,
  buttonSize,
  describeProgram,
  hitTestReference,
  hitTestSource,
  titleHeight,
} from './anatomy.ts'
import {
  buildFixedTimestepProduct,
  buildRanksFromCells,
  buildRanksFromConstants,
  buildVelocityStep,
  fixedTimestep,
  rankReference,
} from './builder-steps.ts'
import {
  buildIntegerIndexRead,
  buildStoredOneHotRead,
  integerIndexSource,
  storedOneHotSource,
} from './masked-read.ts'
import {
  brentKungNetwork,
  buildChain,
  buildNetwork,
  buildOrdinaryAffineChain,
  buildTriangle,
  koggeStoneNetwork,
  networkReference,
  sequentialReference,
} from './prefix-sums.ts'
import {
  buildCopiedTotal,
  buildSharedTotal,
  copiedTotalReference,
  float64Reference,
  sharedTotalReference,
} from './shared-sum.ts'
import {evaluateCompiled, measureProgram} from './stats.ts'
import {
  addBalanced,
  addFused,
  addInReversedOrder,
  addInStoredOrder,
  buildDifference,
  buildRound,
  buildScaledCount,
  buildTermOrders,
  roundInFloat32,
  roundInFloat64,
} from './sum-order.ts'

// Mulberry32: a small seeded generator, so failures reproduce.
function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const f = Math.fround

function sizes(circuit: Circuit, roots: readonly Wire[], lowerGathers = true) {
  const {operations, layers, storedWeights, tableEntries} = measureProgram(circuit, roots, lowerGathers)
  return {operations, layers, storedWeights, tableEntries}
}

test('a shared wide sum and a copied one give the float64 result on quarter pixels, and their own FP32 steps otherwise', () => {
  const random = createRandom(1)
  const itemCount = 64
  const shared = buildSharedTotal(itemCount)
  const copied = buildCopiedTotal(itemCount)
  const evaluateShared = shared.circuit.createTensorEvaluator(shared.labelTops)
  const evaluateCopied = copied.circuit.createTensorEvaluator(copied.labelTops)
  for (let trial = 0; trial < 50; trial++) {
    const quarterPixels = trial % 2 === 0
    const heights = Float32Array.from({length: itemCount}, () =>
      quarterPixels ? Math.floor(random() * 256) / 4 : random() * 64)
    const offsets = Float32Array.from({length: itemCount}, () =>
      quarterPixels ? Math.floor(random() * 256) / 4 : random() * 64)
    const source = new Float32Array(2 * itemCount)
    source.set(heights, 0)
    source.set(offsets, itemCount)
    const sharedTops = Array.from(evaluateShared(source))
    const copiedTops = Array.from(evaluateCopied(source))
    expect(sharedTops).toEqual(Array.from(sharedTotalReference(heights, offsets)))
    expect(copiedTops).toEqual(Array.from(copiedTotalReference(heights, offsets)))
    if (quarterPixels) {
      expect(sharedTops).toEqual(Array.from(float64Reference(heights, offsets)))
      expect(copiedTops).toEqual(Array.from(float64Reference(heights, offsets)))
    }
  }
})

test('reading rowTops[selectedIndex] gives the same value dense and with gather lowering', () => {
  const random = createRandom(2)
  const rowCount = 64
  const rowTops = Float32Array.from({length: rowCount}, () => f(random() * 16_000))
  const integerIndex = buildIntegerIndexRead(rowCount)
  const storedOneHot = buildStoredOneHotRead(rowCount)
  for (let selectedIndex = 0; selectedIndex < rowCount; selectedIndex++) {
    const integerSource = integerIndexSource(rowTops, selectedIndex)
    const storedSource = storedOneHotSource(rowTops, selectedIndex)
    validateOneHotGroups(integerIndex.circuit, integerIndex.circuit.evaluateReference(integerSource))
    validateOneHotGroups(storedOneHot.circuit, storedOneHot.circuit.evaluateReference(storedSource))
    for (const lowerGathers of [false, true]) {
      expect(evaluateCompiled(integerIndex.circuit, [integerIndex.selectedTop], integerSource, lowerGathers)[0])
        .toBe(rowTops[selectedIndex]!)
      expect(evaluateCompiled(storedOneHot.circuit, [storedOneHot.selectedTop], storedSource, lowerGathers)[0])
        .toBe(rowTops[selectedIndex]!)
    }
  }
})

test('every prefix form adds quarter pixels exactly, and each keeps its own FP32 steps on fractional heights', () => {
  const random = createRandom(3)
  const rowCount = 64
  const chain = buildChain(rowCount)
  const triangle = buildTriangle(rowCount)
  const ordinaryChain = buildOrdinaryAffineChain(rowCount)
  const brentKung = brentKungNetwork(rowCount)
  const koggeStone = koggeStoneNetwork(rowCount)
  const brentKungCircuit = buildNetwork(rowCount, brentKung)
  const koggeStoneCircuit = buildNetwork(rowCount, koggeStone)
  const evaluate = {
    chain: chain.circuit.createTensorEvaluator(chain.rowBottoms),
    triangle: triangle.circuit.createTensorEvaluator(triangle.rowBottoms),
    ordinaryChain: ordinaryChain.circuit.createTensorEvaluator(ordinaryChain.rowBottoms),
    brentKung: brentKungCircuit.circuit.createTensorEvaluator(brentKungCircuit.rowBottoms),
    koggeStone: koggeStoneCircuit.circuit.createTensorEvaluator(koggeStoneCircuit.rowBottoms),
  }
  let ordinaryChainDifferences = 0
  let brentKungDifferences = 0
  for (let trial = 0; trial < 40; trial++) {
    const quarterPixels = trial % 2 === 0
    const heights = Float32Array.from({length: rowCount}, () =>
      quarterPixels ? Math.floor(random() * 4096) / 4 : random() * 1000)
    const outputs = {
      chain: Array.from(evaluate.chain(heights)),
      triangle: Array.from(evaluate.triangle(heights)),
      ordinaryChain: Array.from(evaluate.ordinaryChain(heights)),
      brentKung: Array.from(evaluate.brentKung(heights)),
      koggeStone: Array.from(evaluate.koggeStone(heights)),
    }
    if (quarterPixels) {
      let total = 0
      const float64 = Array.from(heights, height => (total += height))
      for (const values of Object.values(outputs)) expect(values).toEqual(float64)
    } else {
      const sequential = Array.from(sequentialReference(heights))
      expect(outputs.chain).toEqual(sequential)
      expect(outputs.triangle).toEqual(sequential)
      expect(outputs.brentKung).toEqual(Array.from(networkReference(heights, brentKung)))
      expect(outputs.koggeStone).toEqual(Array.from(networkReference(heights, koggeStone)))
      const referenceValues = ordinaryChain.circuit.evaluateReference(heights)
      expect(outputs.ordinaryChain).toEqual(ordinaryChain.rowBottoms.map(wire => referenceValues[wire]!))
      for (let row = 0; row < rowCount; row++) {
        if (outputs.ordinaryChain[row] !== sequential[row]) ordinaryChainDifferences++
        if (outputs.brentKung[row] !== sequential[row]) brentKungDifferences++
      }
    }
  }
  // Composing small sums, and a balanced network, both add in another order than a loop.
  expect(ordinaryChainDifferences).toBeGreaterThan(0)
  expect(brentKungDifferences).toBeGreaterThan(0)
})

test('term order and fusion change a sum, a difference is the same in every order, and float64 breaks round', () => {
  const orders = buildTermOrders()
  const values = orders.circuit.evaluateTensor(Float32Array.of(1256, 0.0001, 1256))
  const step = f(0.0001)
  expect(values[orders.addThenSubtract]).toBe(addInStoredOrder(0, [[1, 1256], [1, step], [-1, 1256]]))
  expect(values[orders.addThenSubtract]).toBe(0.0001220703125)
  expect(values[orders.subtractThenAdd]).toBe(addInStoredOrder(0, [[1, 1256], [-1, 1256], [1, step]]))
  expect(values[orders.subtractThenAdd]).toBe(step)

  const scaledCount = buildScaledCount()
  const scaled = scaledCount.circuit.evaluateTensor(Float32Array.of(9))[scaledCount.scaled]
  expect(scaled).toBe(addInStoredOrder(1, [[0.1, 9]]))
  expect(scaled).toBe(1.9000000953674316)
  expect(addFused(1, [[0.1, 9]])).toBe(1.899999976158142)

  const random = createRandom(4)
  const difference = buildDifference()
  const evaluateDifference = difference.circuit.createTensorEvaluator([difference.difference])
  for (let trial = 0; trial < 1000; trial++) {
    const left = f((random() - 0.5) * 32_000)
    const right = f((random() - 0.5) * 32_000)
    const terms = [[1, left], [-1, right]] as const
    const stored = addInStoredOrder(0, terms)
    expect(evaluateDifference(Float32Array.of(left, right))[0]).toBe(stored)
    expect(addInReversedOrder(0, terms)).toBe(stored)
    expect(addFused(0, terms)).toBe(stored)
    expect(addBalanced(0, terms)).toBe(stored)
  }

  const round = buildRound()
  const evaluateRound = round.circuit.createTensorEvaluator([round.rounded])
  for (const x of [2.4, 2.5, 3.5, -1.5, 17.25, 1000.75]) {
    expect(evaluateRound(Float32Array.of(x))[0]).toBe(roundInFloat32(x))
    expect(Number.isInteger(roundInFloat32(x))).toBe(true)
  }
  expect(roundInFloat32(2.5)).toBe(2)
  expect(roundInFloat64(2.5)).toBe(2.5)
})

test('ranks from constant widths fold away, ranks from width cells compare every pair, and velocity × timestep is exact with the timestep range declared before or after the product', () => {
  const random = createRandom(5)
  const itemCount = 16
  const widths = Array.from({length: itemCount}, () => Math.floor(random() * 100))
  const constants = buildRanksFromConstants(widths)
  expect(Array.from(constants.circuit.createTensorEvaluator(constants.ranks)(new Float32Array(1))))
    .toEqual(rankReference(widths))
  const cells = buildRanksFromCells(itemCount)
  const evaluateCells = cells.circuit.createTensorEvaluator(cells.ranks)
  for (let trial = 0; trial < 50; trial++) {
    const cellWidths = Float32Array.from({length: itemCount}, () => Math.floor(random() * 40))
    expect(Array.from(evaluateCells(cellWidths))).toEqual(rankReference(cellWidths))
  }

  for (const declareTimestepFirst of [true, false]) {
    const velocityStep = buildVelocityStep(declareTimestepFirst)
    const evaluateStep = velocityStep.circuit.createTensorEvaluator([velocityStep.distance])
    for (let trial = 0; trial < 200; trial++) {
      const velocity = f((random() - 0.5) * 8000)
      const timestep = f(random() * 0.032)
      expect(evaluateStep(Float32Array.of(velocity, timestep))[0]).toBe(f(velocity * timestep))
    }
  }
})

test('the sizes quoted in sections/executor.md', () => {
  // At 3 items the total has 3 terms, the builder copies it, and both builds are identical.
  const threeShared = buildSharedTotal(3)
  const threeCopied = buildCopiedTotal(3)
  expect(sizes(threeShared.circuit, threeShared.labelTops)).toEqual(sizes(threeCopied.circuit, threeCopied.labelTops))
  const sharedSizes = [
    {itemCount: 4, shared: {operations: 5, layers: 2, storedWeights: 12}, copied: {operations: 4, layers: 1, storedWeights: 20}},
    {itemCount: 64, shared: {operations: 65, layers: 2, storedWeights: 192}, copied: {operations: 64, layers: 1, storedWeights: 4160}},
    {itemCount: 256, shared: {operations: 257, layers: 2, storedWeights: 768}, copied: {operations: 256, layers: 1, storedWeights: 65_792}},
  ]
  for (const {itemCount, shared: sharedExpected, copied: copiedExpected} of sharedSizes) {
    const shared = buildSharedTotal(itemCount)
    const copied = buildCopiedTotal(itemCount)
    expect(sizes(shared.circuit, shared.labelTops)).toEqual({...sharedExpected, tableEntries: 0})
    expect(sizes(copied.circuit, copied.labelTops)).toEqual({...copiedExpected, tableEntries: 0})
  }

  const integerIndex = buildIntegerIndexRead(1024)
  expect(sizes(integerIndex.circuit, [integerIndex.selectedTop], false))
    .toEqual({operations: 3075, layers: 4, storedWeights: 7170, tableEntries: 0})
  expect(sizes(integerIndex.circuit, [integerIndex.selectedTop]))
    .toEqual({operations: 2051, layers: 3, storedWeights: 4098, tableEntries: 2048})
  const storedOneHot = buildStoredOneHotRead(1024)
  expect(sizes(storedOneHot.circuit, [storedOneHot.selectedTop], false))
    .toEqual({operations: 1025, layers: 2, storedWeights: 3072, tableEntries: 0})
  expect(sizes(storedOneHot.circuit, [storedOneHot.selectedTop]))
    .toEqual({operations: 1, layers: 1, storedWeights: 0, tableEntries: 2048})

  const rowCount = 1024
  const prefixSizes = [
    [buildChain(rowCount), 1023, 1023, 2046],
    [buildTriangle(rowCount), 1023, 1, 524_799],
    [buildOrdinaryAffineChain(rowCount), 1023, 341, 3069],
    [buildNetwork(rowCount, brentKungNetwork(rowCount)), 2036, 18, 4072],
    [buildNetwork(rowCount, koggeStoneNetwork(rowCount)), 9217, 10, 18_434],
  ] as const
  for (const [prefix, operations, layers, storedWeights] of prefixSizes) {
    expect(sizes(prefix.circuit, prefix.rowBottoms)).toEqual({operations, layers, storedWeights, tableEntries: 0})
  }

  const widths = Array.from({length: 64}, (_, item) => (item * 37) % 101)
  const constantRanks = buildRanksFromConstants(widths)
  expect(sizes(constantRanks.circuit, constantRanks.ranks))
    .toEqual({operations: 64, layers: 1, storedWeights: 0, tableEntries: 0})
  const cellRanks = buildRanksFromCells(64)
  expect(sizes(cellRanks.circuit, cellRanks.ranks))
    .toEqual({operations: 8128, layers: 2, storedWeights: 24_192, tableEntries: 0})

  const declaredFirst = buildVelocityStep(true)
  expect(sizes(declaredFirst.circuit, [declaredFirst.distance]))
    .toEqual({operations: 1, layers: 1, storedWeights: 2, tableEntries: 0})
  const declaredAfter = buildVelocityStep(false)
  expect(sizes(declaredAfter.circuit, [declaredAfter.distance]))
    .toEqual({operations: 3, layers: 2, storedWeights: 6, tableEntries: 0})
})

test('the close button hit test equals plain JS in both builds, and copying the edges saves two operations and a layer', () => {
  const windows = [
    {windowLeft: 100, windowTop: 50, windowWidth: 400},
    {windowLeft: 0, windowTop: 0, windowWidth: 22},
    {windowLeft: 16_000, windowTop: 16_000, windowWidth: 300},
  ]
  for (const keepButtonEdges of [false, true]) {
    const hitTest = buildCloseButtonHitTest(keepButtonEdges)
    const evaluate = hitTest.circuit.createTensorEvaluator([hitTest.pressed])
    let pressedCount = 0
    for (const {windowLeft, windowTop, windowWidth} of windows) {
      const buttonLeft = windowLeft + windowWidth - buttonInset - buttonSize
      const buttonTop = windowTop + (titleHeight - buttonSize) / 2
      for (let pointerX = buttonLeft - 17; pointerX < buttonLeft + 33; pointerX++) {
        for (let pointerY = buttonTop - 17; pointerY < buttonTop + 33; pointerY++) {
          if (pointerX < 0 || pointerY < 0) continue
          const input = {pointerX, pointerY, windowLeft, windowTop, windowWidth}
          const expected = hitTestReference(input)
          expect(evaluate(hitTestSource(input))[0]).toBe(expected)
          pressedCount += expected
        }
      }
    }
    // Every window's 16 by 16 px button lies inside the sampled square.
    expect(pressedCount).toBe(3 * 256)
    expect(hitTest.circuit.operations.length).toBe(16)
  }

  const copied = buildCloseButtonHitTest(false)
  expect(sizes(copied.circuit, [copied.pressed]))
    .toEqual({operations: 9, layers: 2, storedWeights: 28, tableEntries: 0})
  expect(sizes(copied.circuit, [copied.pressed, copied.buttonCenterX]).operations).toBe(10)
  const copiedLines = describeProgram(copied.circuit, [copied.pressed], copied.names, true)
  expect(copiedLines[0]).toBe('layer 1: 8 operations, reads 5 values, 16 matrix rows (8 output rows + 8 gate rows), 20 stored weights')
  expect(copiedLines).toContain('  rightOfLeftEdge.lower = relu(pointerX - windowLeft - windowWidth + 22)')
  expect(copiedLines).toContain('  rowOffsets [0, 0, 8]')
  expect(copiedLines).toContain('  bias       [1, -3]')

  const kept = buildCloseButtonHitTest(true)
  expect(sizes(kept.circuit, [kept.pressed]))
    .toEqual({operations: 11, layers: 3, storedWeights: 27, tableEntries: 0})
})

test('a known timestep as a weight and as a constant value give the same bits, and the constant value costs an operation and a layer', () => {
  const random = createRandom(6)
  const weight = buildFixedTimestepProduct('weight')
  const constantWire = buildFixedTimestepProduct('constant wire')
  const evaluateWeight = weight.circuit.createTensorEvaluator([weight.distance])
  const evaluateConstantWire = constantWire.circuit.createTensorEvaluator([constantWire.distance])
  for (let trial = 0; trial < 500; trial++) {
    const velocity = f((random() - 0.5) * 8000)
    const expected = f(f(fixedTimestep) * velocity)
    expect(evaluateWeight(Float32Array.of(velocity))[0]).toBe(expected)
    expect(evaluateConstantWire(Float32Array.of(velocity))[0]).toBe(expected)
  }
  expect(sizes(weight.circuit, [weight.distance]))
    .toEqual({operations: 1, layers: 1, storedWeights: 1, tableEntries: 0})
  expect(sizes(constantWire.circuit, [constantWire.distance]))
    .toEqual({operations: 2, layers: 2, storedWeights: 2, tableEntries: 0})
})
