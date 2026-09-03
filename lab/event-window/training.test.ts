// Training recovery: from scrambled behavior parameters, feedforward training
// over single-frame supervision pairs (no unrolling anywhere) recovers
// parameters that harden to closed-loop bit-exactness on held-out traces.
// Also pinned here: the fixed-ramp failure mode that motivated the annealed
// sharpness schedule.

import {expect, test} from 'bun:test'
import {createOracleState} from './oracle.ts'
import {createBehaviorConfig, generateTrace} from './trace.ts'
import {
  createSoftTrainingBuild,
  harvestTrainingPairs,
  hardenParameterValues,
  measureMeanLoss,
  scrambledParameterValues,
  supervisedBitCount,
  trainBehaviorParameters,
  verifyHardenedParameters,
} from './train.ts'
import {authoredParameterValues, createEventWindowMachine, sourceSize} from './circuit.ts'
import {runClosedLoop} from './harness.ts'
import {measureCircuitCost} from './stats.ts'

test('supervision pairs are frame-local: one standalone single-frame source table each', () => {
  const config = createBehaviorConfig(300)
  const pairs = harvestTrainingPairs(config, 301, 2_000)
  expect(pairs.length).toBeGreaterThan(500)
  for (const pair of pairs) {
    // Exactly the single-frame source layout, backed by its own buffer — not a
    // view into any longer sequence. Together with the training loop indexing
    // one pair at a time, no gradient can cross a frame boundary.
    expect(pair.source.length).toBe(sourceSize(1))
    expect(pair.source.byteOffset).toBe(0)
    expect(pair.source.buffer.byteLength).toBe(pair.source.length * 4)
    expect(pair.targets.length).toBe(supervisedBitCount)
  }
})

test('the soft training circuit contains zero boolean atoms', () => {
  // The reference backward pass throws on a boolean atom only when a gradient
  // actually reaches one, so a boolean atom off the supervised path would slip
  // through silently. This pins the stronger claim: none exist at all.
  const cost = measureCircuitCost(createSoftTrainingBuild())
  expect(cost.boolean).toBe(0)
})

test('training recovers scrambled behavior parameters to closed-loop exactness', () => {
  const config = createBehaviorConfig(12_345)
  const pairs = [
    ...harvestTrainingPairs(config, 1_001, 10_000),
    ...harvestTrainingPairs(config, 1_002, 10_000),
  ]
  const build = createSoftTrainingBuild()
  const heldOutSeeds = [9_001, 9_002]
  let recovered = 0
  const attempts = 6
  for (let seed = 1; seed <= attempts; seed++) {
    const initial = scrambledParameterValues(seed * 77 + 5)
    const result = trainBehaviorParameters(build, pairs, {seed, initial})
    const report = verifyHardenedParameters(config, result.hardened, heldOutSeeds, 10_000)
    if (report.recovered) {
      recovered++
      // The thresholds must land inside the integer bands the oracle's rules
      // quantize to: slop 4 means the boundary belongs in (4, 5]; titleHeight
      // 30 puts the boundary in [29, 30).
      expect(result.hardened.slopBoundary).toBeGreaterThan(4)
      expect(result.hardened.slopBoundary).toBeLessThanOrEqual(5)
      expect(result.hardened.titleBoundary).toBeGreaterThanOrEqual(29)
      expect(result.hardened.titleBoundary).toBeLessThan(30)
      expect(result.hardened.dragFromTitle).toBe(1)
      expect(result.hardened.dragFromBody).toBe(0)
      expect(result.hardened.clickTogglesFromTitle).toBe(0)
      expect(result.hardened.clickTogglesFromBody).toBe(1)
    }
  }
  expect(recovered).toBeGreaterThanOrEqual(5)
}, 120_000)

test('fixed-ramp training fails: the MSE optimum sits outside the correct integer band', () => {
  const config = createBehaviorConfig(12_345)
  const pairs = [
    ...harvestTrainingPairs(config, 1_001, 10_000),
    ...harvestTrainingPairs(config, 1_002, 10_000),
  ]
  const build = createSoftTrainingBuild()
  const authored = authoredParameterValues(config)

  // The loss landscape itself, no optimizer involved: scanning the title
  // boundary over the full pair set at fixed sharpness 0.25 puts the minimum
  // at 30.0 — outside the correct band [29, 30). Title presses are denser per
  // pixel row than body presses, so the wide-ramp MSE balance point shifts
  // toward the body side.
  const grid = [29, 29.25, 29.5, 29.75, 30, 30.25, 30.5]
  const losses = grid.map(titleBoundary =>
    measureMeanLoss(build, pairs, {...authored, titleBoundary}, 0.25))
  const minimumIndex = losses.indexOf(Math.min(...losses))
  expect(grid[minimumIndex]).toBe(30)
  expect(losses[grid.indexOf(30)]!).toBeLessThan(losses[grid.indexOf(29.5)]!)

  // Training at that fixed sharpness, even STARTING from the authored truth,
  // drifts the title boundary out of band and fails closed-loop verification.
  const drift = trainBehaviorParameters(build, pairs, {
    seed: 1,
    initial: authored,
    constantSharpness: 0.25,
  })
  expect(drift.learned.titleBoundary).toBeGreaterThanOrEqual(30)
  expect(drift.learned.titleBoundary).toBeLessThan(30.2)
  const driftReport = verifyHardenedParameters(config, drift.hardened, [9_001], 10_000)
  expect(driftReport.recovered).toBe(false)

  // And from a far scrambled start, the slop boundary sees no in-band example
  // at all and never moves: the fixed ramp both stalls far away and settles
  // wrong up close. The annealed schedule fixes both.
  const initial = scrambledParameterValues(82)
  const stall = trainBehaviorParameters(build, pairs, {
    seed: 2,
    initial,
    constantSharpness: 0.25,
  })
  expect(stall.learned.slopBoundary).toBe(initial.slopBoundary)
  expect(verifyHardenedParameters(config, stall.hardened, [9_001], 10_000).recovered).toBe(false)
}, 120_000)

test('hardening a wrong relation cell is caught by the closed-loop verifier', () => {
  const config = createBehaviorConfig(12_345)
  const wrong = {...authoredParameterValues(config), dragFromBody: 1}
  const report = verifyHardenedParameters(config, wrong, [9_001], 10_000)
  expect(report.recovered).toBe(false)
  expect(report.divergences).toBeGreaterThan(0)
}, 30_000)

test('an out-of-band threshold is caught by the closed-loop verifier', () => {
  const config = createBehaviorConfig(12_345)
  // slopBoundary 5.5 misclassifies Chebyshev distance 5 as within slop.
  const wrong = {...authoredParameterValues(config), slopBoundary: 5.5}
  const trace = generateTrace(config, 9_001, 10_000)
  const machine = createEventWindowMachine(config, {parameters: wrong})
  const result = runClosedLoop(config, trace, machine, createOracleState(config))
  expect(result.divergences).toBeGreaterThan(0)
}, 30_000)

test('hardenParameterValues rounds relations and keeps thresholds', () => {
  const hardened = hardenParameterValues({
    slopBoundary: 4.3,
    titleBoundary: 29.9,
    dragFromTitle: 0.51,
    dragFromBody: 0.49,
    clickTogglesFromTitle: 0.1,
    clickTogglesFromBody: 0.9,
  })
  expect(hardened).toEqual({
    slopBoundary: 4.3,
    titleBoundary: 29.9,
    dragFromTitle: 1,
    dragFromBody: 0,
    clickTogglesFromTitle: 0,
    clickTogglesFromBody: 1,
  })
})
