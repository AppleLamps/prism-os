import {expect, test} from 'bun:test'
import {checkSpec, compareBankWithReference, onGrid, seededRandom} from './bank-check.ts'
import {bankField, createBankMachine, laneField} from './bank-machine.ts'
import {
  createPredictiveScene,
  keyframesForBox,
  predictSerial,
  predictiveBoxSize,
  predictiveLanesPerBox,
  predictiveSampleCount,
  predictiveSpec,
} from './predictive.ts'
import type {SpringPowers} from './spring-bank.ts'
import {type ReferenceLane, advanceReferenceClock, defaultClockConfig, referenceBoxStep} from './spring-math.ts'

const variants: SpringPowers[] = ['split-table', 'binary-powers', 'source-table', 'source-matrix']

test('the circuit clock counts min(300, floor(pending / 4)) steps exactly and carries the leftover', () => {
  const machine = createBankMachine(checkSpec, {powers: 'split-table', retarget: 'deferred'})
  const table = new Float32Array(machine.source.length)
  const random = seededRandom(3)
  const pendingValues: number[] = []
  for (let steps = 0; steps <= 305; steps++) {
    for (const offset of [-1 / 64, 0, 1 / 64]) if (4 * steps + offset >= 0) pendingValues.push(4 * steps + offset)
  }
  for (let sample = 0; sample < 500; sample++) pendingValues.push(onGrid(random() * 120_000))
  for (const pending of pendingValues) {
    // Both cells stay within their declared 0..65536 ms ranges.
    const lower = Math.max(0, pending - defaultClockConfig.maxFrameDeltaMs)
    const upper = Math.min(pending, defaultClockConfig.maxFrameDeltaMs)
    const leftover = onGrid(lower + (upper - lower) * random())
    const delta = pending - leftover
    table.set(machine.source)
    table[bankField.running] = 1
    table[bankField.leftoverMs] = leftover
    const values = machine.evaluateFrame(table, delta)
    const expected = advanceReferenceClock({leftoverMs: leftover, running: true}, delta, defaultClockConfig)
    expect(values[machine.output.stepCount]).toBe(expected.steps)
    expect(values[bankField.leftoverMs]).toBe(expected.leftoverMs)
  }
  // A clock that stopped last frame starts from zero, like animatedUntilTime = null.
  table.set(machine.source)
  table[bankField.running] = 0
  table[bankField.leftoverMs] = 3
  const values = machine.evaluateFrame(table, 500)
  expect(values[machine.output.stepCount]).toBe(0)
  expect(values[bankField.leftoverMs]).toBe(0)
})

test('every power variant matches float64 doctrine springs frame by frame, and settles exactly', () => {
  for (const powers of variants) {
    for (const retarget of ['doctrine', 'deferred'] as const) {
      const machine = createBankMachine(checkSpec, {powers, retarget})
      const result = compareBankWithReference(machine, retarget, checkSpec.groups, 400)
      expect(result.maxPositionError).toBeLessThan(1e-3)
      expect(result.settleMismatchFrames).toBe(0)
      expect(result.settledBoxFrames).toBeGreaterThan(50)
      expect(result.inexactSettledLanes).toBe(0)
    }
  }
})

test('source-table and source-matrix take new stiffness and damping at runtime', () => {
  const edited = [{stiffness: 1800, damping: 30}, {stiffness: 120, damping: 9}]
  for (const powers of ['source-table', 'source-matrix'] as const) {
    const machine = createBankMachine(checkSpec, {powers, retarget: 'deferred'})
    edited.forEach((constants, group) => machine.setGroupConstants(group, constants))
    const result = compareBankWithReference(machine, 'deferred', edited, 300)
    expect(result.maxPositionError).toBeLessThan(1e-3)
    expect(result.settleMismatchFrames).toBe(0)
    expect(result.inexactSettledLanes).toBe(0)
  }
})

test('predicted samples are independent evaluations that match stepping forward in float64', () => {
  const scene = createPredictiveScene('split-table')
  scene.arrange(1280, 800)
  scene.render(0, 'serial')
  scene.fling(1280, 800)
  const {samples, animationActive} = scene.render(16, 'serial')
  expect(animationActive).toBe(true)
  expect(samples.length).toBe(predictiveSampleCount * scene.machine.laneCount)
  const batch = scene.batch.predict(scene.machine)
  const machine = scene.machine
  let maxSerialError = 0
  let maxBatchDifference = 0
  for (let sample = 0; sample < predictiveSampleCount; sample += 7) {
    let lane = 0
    for (const box of predictiveSpec.boxes) {
      const lanes: ReferenceLane[] = box.lanes.map((laneSpec, index) => ({
        position: machine.source[machine.laneCell(lane + index, laneField.position)]!,
        velocity: machine.source[machine.laneCell(lane + index, laneField.velocity)]!,
        previousDestination: machine.source[machine.laneCell(lane + index, laneField.previousDestination)]!,
        constants: predictiveSpec.groups[laneSpec.group]!,
      }))
      const destinations = lanes.map((_, index) => machine.source[machine.laneCell(lane + index, laneField.destination)]!)
      referenceBoxStep(lanes, destinations, sample, {
        snap: false,
        settleDistance: machine.source[bankField.settleDistance]!,
        settleSpeed: machine.source[bankField.settleSpeed]!,
        stepMs: defaultClockConfig.stepMs,
        retarget: 'deferred',
      })
      lanes.forEach((referenceLane, index) => {
        const offset = sample * machine.laneCount + lane + index
        maxSerialError = Math.max(maxSerialError, Math.abs(samples[offset]! - referenceLane.position))
        maxBatchDifference = Math.max(maxBatchDifference, Math.abs(samples[offset]! - batch[offset]!))
      })
      lane += box.lanes.length
    }
  }
  expect(maxSerialError).toBeLessThan(1e-3)
  expect(maxBatchDifference).toBeLessThan(1e-3)
  // Sample 0 is the current state.
  expect(Array.from(predictSerial(machine, 1))).toEqual(
    Array.from({length: machine.laneCount}, (_, lane) => machine.source[machine.laneCell(lane, laneField.position)]!),
  )
  const keyframes = keyframesForBox(samples, machine.laneCount, 2 * predictiveLanesPerBox, predictiveBoxSize)
  expect(keyframes.length).toBe(predictiveSampleCount)
  expect(keyframes[0]!['transform']).toMatch(/^translate3d\(.*px,.*px,0\) scale\(.*\)$/)
})
