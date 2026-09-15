// Checks the card row examples: the staged program and the duplicated circuit give bit-identical outputs,
// both match the plain JavaScript loops where float64 and FP32 give the same numbers, the staged program's
// size doesn't depend on the card count, Brent-Kung prefix sums drift less at 10,000 photos, the order of
// combining maxima changes FP32 bits, and the prototype's executor runs a map stage as a loop over cards.
import {expect, test} from 'bun:test'
import {compareAllVersions, createRandom, integerBetween, randomCards, randomInput} from './card-traces.ts'
import {buildDuplicatedRow, createDuplicatedRunner, duplicatedRoots, type PrefixLowering} from './cards-duplicated.ts'
import {layoutRowReference} from './cards-reference.ts'
import {buildStagedRow, evaluateStagedRow, stagedStageSizes} from './cards-staged.ts'
import {createHitTestRunner, generatedCode, hitTestReference} from './generated-loop.ts'
import {measureCircuit} from './map-stage.ts'
import {buildMaximumCircuit, maximumAsTree, maximumInItemOrder} from './max-order.ts'
import {brentKungThrough, float64Through, measurePrefixDrift, sequentialThrough, syntheticStripSteps} from './prefix-precision.ts'

const staged = buildStagedRow()

test('the staged row and the duplicated row give bit-identical outputs on fractional inputs', () => {
  const total = compareAllVersions(staged)
  expect(total.frames).toBe(320)
  expect(total.differingValues).toBe(0)
  expect(total.valuesCompared).toBeGreaterThan(10000)
  expect(total.hoveredFrames).toBeGreaterThan(100)
  expect(total.overlappingFrames).toBeGreaterThan(10)
})

test('both versions match the plain JavaScript loops on exactly representable inputs', () => {
  let hoveredFrames = 0
  let overlappingFrames = 0
  for (const count of [1, 5, 64]) {
    const random = createRandom(2000 + count)
    const cards = randomCards(random, count, true)
    const duplicated = createDuplicatedRunner(buildDuplicatedRow(cards))
    for (let frame = 0; frame < 60; frame++) {
      const input = randomInput(random, cards, true)
      const reference = layoutRowReference(cards, input)
      for (const outputs of [duplicated(input), evaluateStagedRow(staged, cards, input)]) {
        expect([...outputs.widths]).toEqual(reference.widths)
        expect([...outputs.heights]).toEqual(reference.heights)
        expect([...outputs.lefts]).toEqual(reference.lefts)
        expect([...outputs.tops]).toEqual(reference.tops)
        expect(outputs.tallest).toBe(reference.tallest)
        expect(outputs.hoverPresent).toBe(reference.hoveredIndex === null ? 0 : 1)
        expect(outputs.hoveredIndex).toBe(reference.hoveredIndex ?? 0)
        expect([...outputs.hovered]).toEqual(cards.map((_, index) => index === reference.hoveredIndex ? 1 : 0))
      }
      if (reference.hoveredIndex !== null) hoveredFrames++
      if (input.pointerPresent && reference.cardsUnderPointer >= 2) overlappingFrames++
    }
  }
  expect(hoveredFrames).toBeGreaterThan(60)
  expect(overlappingFrames).toBeGreaterThan(5)
})

test('the staged program keeps the same size per card; the duplicated circuit grows with the card count', () => {
  expect(stagedStageSizes(staged).map(stage => [stage.name, stage.liveOperations, stage.layers])).toEqual([
    ['sizes', 3, 2],
    ['placement and hit test', 11, 5],
    ['hovered', 4, 2],
  ])
  // Fractional sizes, so no two cards share an operation through the builder's expression table.
  const sizeAt = (count: number, prefixLowering: PrefixLowering) => {
    const row = buildDuplicatedRow(randomCards(createRandom(3000 + count), count, false), {prefixLowering})
    return measureCircuit(row.circuit, duplicatedRoots(row))
  }
  expect(sizeAt(64, 'chain')).toEqual({liveOperations: 1465, layers: 227, storedWeights: 2836})
  expect(sizeAt(512, 'chain')).toEqual({liveOperations: 11769, layers: 1586, storedWeights: 22804})
  expect(sizeAt(512, 'triangle')).toEqual({liveOperations: 11770, layers: 1586, storedWeights: 153110})
})

test('prefix sums: exact on integers in any order; Brent-Kung drifts less at 10,000 strip widths', () => {
  const random = createRandom(4000)
  const integerSteps = Float32Array.from({length: 10000}, () => integerBetween(random, 100, 900))
  const exact = [...float64Through(integerSteps)]
  expect([...sequentialThrough(integerSteps)]).toEqual(exact)
  expect([...brentKungThrough(integerSteps)]).toEqual(exact)

  // Fractional steps, like the strip's 0.7 × width.
  const drift = measurePrefixDrift(syntheticStripSteps(10000))
  expect(drift.total).toBeGreaterThan(2 ** 22)
  expect(drift.brentKungDrift * 10).toBeLessThan(drift.sequentialDrift)
})

test('maxima: each circuit equals its loop, item order and a tree differ on some fractional heights, and both equal Math.max on integers', () => {
  const random = createRandom(5000)
  for (const count of [7, 64]) {
    const inItemOrder = buildMaximumCircuit(count, 'item order')
    const asTree = buildMaximumCircuit(count, 'tree')
    let differing = 0
    for (let trial = 0; trial < 200; trial++) {
      const zoom = 0.25 + random() * 1.75
      const heights = Float32Array.from({length: count}, () => Math.fround(zoom * (40 + random() * 360) + 52))
      const ordered = inItemOrder.evaluate(heights)
      const balanced = asTree.evaluate(heights)
      expect(ordered).toBe(maximumInItemOrder(heights))
      expect(balanced).toBe(maximumAsTree(heights))
      if (ordered !== balanced) differing++
      const integerHeights = Float32Array.from({length: count}, () => integerBetween(random, 1, 8000))
      expect(inItemOrder.evaluate(integerHeights)).toBe(Math.max(...integerHeights))
      expect(asTree.evaluate(integerHeights)).toBe(Math.max(...integerHeights))
    }
    expect(differing).toBeGreaterThan(0)
  }
})

test('the prototype executor runs a map stage as a loop over cards, and its hit bits and first hit equal plain loops', () => {
  const {counts} = generatedCode()
  expect([counts.sharedRows, counts.instanceRows]).toEqual([1, 6])
  const random = createRandom(6000)
  let hitFrames = 0
  for (const count of [1, 5, 64]) {
    const run = createHitTestRunner(count)
    for (let frame = 0; frame < 60; frame++) {
      const lefts = Float32Array.from({length: count}, () => integerBetween(random, -400, 400))
      const widths = Float32Array.from({length: count}, () => integerBetween(random, 0, 300))
      const target = integerBetween(random, 0, count - 1)
      const choice = random()
      // Quarter pixels, often exactly on a card's left or right edge.
      const pointerX = choice < 0.2 ? lefts[target]! : choice < 0.4 ? lefts[target]! + widths[target]! : Math.round((lefts[target]! + random() * widths[target]!) * 4) / 4
      const scrollX = integerBetween(random, -8, 8)
      const input = {pointerX: pointerX - scrollX, scrollX, pointerPresent: random() < 0.9, lefts, widths}
      const circuit = run(input)
      const reference = hitTestReference(input)
      expect([...circuit.bits]).toEqual(reference.bits)
      expect([circuit.index, circuit.present]).toEqual([reference.index, reference.present])
      if (reference.present === 1) hitFrames++
    }
  }
  expect(hitFrames).toBeGreaterThan(60)
})
