import {expect, test} from 'bun:test'
import {checkBuildOrder} from './build-order.ts'
import {
  checkAppFreeRunning,
  checkAppRestartedEveryFrame,
  checkCatchUpForm,
  checkClock,
  checkGoToEnd,
  checkSpringStep,
  checkStepSpringTo,
  measureDigitOrderDepth,
} from './checks.ts'
import {catchUpForms} from './costs.ts'
import {worstOverSeeds} from './frame-rate-check.ts'
import {settleDistance} from './spring-catch-up.ts'

test('level 1: one step matches float64, and a chain of 300 steps compiles to one layer of two operations', () => {
  const result = checkSpringStep(500)
  expect(result.oneStepSize.liveOperations).toBe(2)
  expect(result.chainedSize.liveOperations).toBe(2)
  expect(result.chainedSize.layers).toBe(1)
  expect(result.maxOneStepError).toBeLessThan(1e-3)
  expect(result.maxChainedError).toBeLessThan(1e-3)
})

test('level 2: stepping a runtime number of steps and snapping matches index.ts stepSpringTo', () => {
  const result = checkStepSpringTo(5, 3000)
  expect(result.snappedSamples).toBeGreaterThan(100)
  expect(result.settleMismatches - result.settleMismatchesNearThreshold).toBe(0)
  expect(result.maxPositionError).toBeLessThan(1e-3)
  expect(result.maxVelocityError).toBeLessThan(1e-2)
})

test('level 2: goToEnd lands on the destination and stops animating', () => {
  expect(checkGoToEnd(8, 2000).mismatches).toBe(0)
})

test('the clock counts min(300, floor(pending / 4)) steps exactly and carries the leftover', () => {
  expect(checkClock(3).mismatches).toBe(0)
})

test('applying the most significant digit first makes the clock plus steps shallower', () => {
  const result = measureDigitOrderDepth()
  expect(result.mostSignificantFirst.layers).toBeLessThan(result.leastSignificantFirst.layers)
})

test('level 3: one frame of the app matches index.ts render() started from the circuit state', () => {
  for (const seed of [1, 2]) {
    const result = checkAppRestartedEveryFrame(seed, 1500)
    expect(result.animatingFrames).toBeGreaterThan(300)
    expect(result.cappedFrames).toBeGreaterThan(0)
    expect(result.stepCountMismatches).toBe(0)
    expect(result.leftoverMismatches).toBe(0)
    expect(result.selectionMismatches).toBe(0)
    expect(result.settleMismatches).toBe(0)
    expect(result.maxPositionError).toBeLessThan(1e-3)
    expect(result.maxVelocityError).toBeLessThan(1e-2)
  }
})

test('level 3: the app free-running stays close to float64 while both animate', () => {
  const result = checkAppFreeRunning(1, 1500)
  expect(result.maxPositionErrorWhileBothAnimate).toBeLessThan(1e-2)
})

test('every catch-up form matches float64 stepping', () => {
  for (const form of catchUpForms) {
    const result = checkCatchUpForm(form, 9, 200)
    expect(result.maxDisplacementError).toBeLessThan(1e-3)
    expect(result.maxVelocityError).toBeLessThan(1e-2)
  }
})

test('statement order: a late range declaration costs operations, and creation order changes FP32 sums', () => {
  const result = checkBuildOrder(4, 2000)
  expect(result.productBeforeSize.liveOperations).toBe(1)
  expect(result.productAfterSize.liveOperations).toBe(3)
  expect(result.productDifferences).toBe(0)
  expect(result.sumDifferences).toBeGreaterThan(0)
  expect(result.referenceMismatches).toBe(0)
})

test("index.ts's order depends on frame rate; stepping to each press first, with settling per step, doesn't", () => {
  expect(worstOverSeeds('index.ts', 30, {stall: false}).maxDifferencePx).toBeGreaterThan(50)
  expect(worstOverSeeds('index.ts', 30, {stall: false, pressesOnFramesOfHz: 30}).maxDifferencePx).toBeGreaterThan(50)
  for (const hz of [10, 30, 60]) {
    for (const stall of [false, true]) {
      expect(worstOverSeeds('event time, settle per step', hz, {stall}).maxDifferencePx).toBe(0)
    }
  }
})

test("index.ts's order matches across frame rates when presses only arrive at rest, on frame times every rate renders", () => {
  for (const hz of [10, 30, 60]) {
    const onSharedFrames = worstOverSeeds('index.ts', hz, {stall: false, pressesOnFramesOfHz: 10, spacing: 'only at rest'})
    // Only a spring that one run has snapped and the other hasn't yet can differ.
    expect(onSharedFrames.maxDifferencePx).toBeLessThan(settleDistance)
  }
  const betweenFrames = worstOverSeeds('index.ts', 30, {stall: false, spacing: 'only at rest'})
  expect(betweenFrames.maxDifferencePx).toBeGreaterThan(50)
})
