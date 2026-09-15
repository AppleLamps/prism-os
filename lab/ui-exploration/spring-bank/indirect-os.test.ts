import {expect, test} from 'bun:test'
import {createWindowManagerMachine as createOriginalMachine} from '../../../window-manager.ts'
import {type WindowManagerOptions, bankOptions, createWindowManagerMachine, originalOptions} from './window-manager.ts'
import {
  type FrameRecord,
  type FrameSchedule,
  type ReplayMachine,
  compareAtSharedTimes,
  createIndirectOSTrace,
  createWindowSpringCheck,
  offsetPresses,
  randomPressOffsets,
  replayTrace,
  scheduleFrameTimes,
} from './trace.ts'

const trace = createIndirectOSTrace()

type Program = {valueCount: number, sourceSize: number, layers: {weights: Float32Array}[]}
function sizes(program: Program) {
  return {
    live: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
  }
}

const replays = new Map<string, FrameRecord[]>()
function replay(label: string, create: () => ReplayMachine, schedule: FrameSchedule) {
  const key = `${label} ${JSON.stringify(schedule)}`
  let records = replays.get(key)
  if (records === undefined) {
    records = replayTrace(create(), trace.events, scheduleFrameTimes(schedule))
    replays.set(key, records)
  }
  return records
}
const at = (fps: number, stall?: FrameSchedule['stall']): FrameSchedule =>
  stall === undefined ? {fps, durationMs: trace.durationMs} : {fps, durationMs: trace.durationMs, stall}
const stall = {startMs: 2701, durationMs: 500}
const bank = (options: Partial<WindowManagerOptions> = {}) => () => createWindowManagerMachine({...bankOptions, ...options})

test('springs: original rebuilds the original IndirectOS circuit, and its outputs match bit for bit', () => {
  const original = createOriginalMachine()
  const copy = createWindowManagerMachine(originalOptions)
  expect(sizes(copy.tensorProgram)).toEqual(sizes(original.tensorProgram))
  const left = replay('original file', () => original, at(60))
  const right = replay('copy with original springs', () => copy, at(60))
  expect(right.length).toBe(left.length)
  left.forEach((record, index) => {
    expect(Array.from(right[index]!.continuous)).toEqual(Array.from(record.continuous))
    expect(Array.from(right[index]!.discrete)).toEqual(Array.from(record.discrete))
    expect(right[index]!.animationActive).toBe(record.animationActive)
  })
})

test('the spring bank cuts live operations, layers, and stored weights', () => {
  const original = sizes(createOriginalMachine().tensorProgram)
  const banked = sizes(createWindowManagerMachine(bankOptions).tensorProgram)
  expect(banked.live).toBeLessThan(original.live * 0.7)
  expect(banked.layers).toBeLessThan(original.layers)
  expect(banked.weights).toBeLessThan(original.weights * 0.75)
})

test('window springs inside IndirectOS match float64 doctrine springs along the trace', () => {
  const machine = createWindowManagerMachine({...bankOptions, debugOutputs: true})
  const check = createWindowSpringCheck(machine)
  replayTrace(machine, trace.events, scheduleFrameTimes(at(60)), {
    beforeStep: () => check.beforeStep(),
    afterStep: (values, time) => check.afterStep(values, time),
  })
  expect(check.result.stepFrames).toBeGreaterThan(150)
  expect(check.result.maxPositionError).toBeLessThan(1e-3)
  expect(check.result.settleMismatches).toBe(0)
})

test('with presses on frame times that every rate renders, 30, 60 and 120 fps and a 500 ms stall agree at shared timestamps', () => {
  const reference = replay('bank', bank(), at(120))
  for (const schedule of [at(30), at(60), at(60, stall)]) {
    const comparison = compareAtSharedTimes(reference, replay('bank', bank(), schedule))
    expect(comparison.sharedFrames).toBeGreaterThan(250)
    expect(comparison.maxContinuousDifference).toBeLessThan(0.01)
    expect(comparison.discreteMismatchFrames).toBe(0)
    expect(comparison.animationActiveMismatchFrames).toBe(0)
  }
})

test('with presses between frames, deferred retargeting agrees across frame rates only with event-time evaluations', () => {
  // Every press moves by its own random offset off the 30 fps grid, and Photos
  // is resized by hand, so thumbnail destinations also change between frames.
  const events = offsetPresses(createIndirectOSTrace({liveResize: true}).events, randomPressOffsets(7, 30))
  const replayEvents = (options: Partial<WindowManagerOptions>, schedule: FrameSchedule, evaluateAtEventTimes: boolean) =>
    replayTrace(createWindowManagerMachine({...bankOptions, ...options}), events, scheduleFrameTimes(schedule), {evaluateAtEventTimes})
  const reference = replayEvents({}, at(120), true)
  for (const schedule of [at(10), at(30), at(60, stall)]) {
    const comparison = compareAtSharedTimes(reference, replayEvents({}, schedule, true))
    expect(comparison.maxContinuousDifference).toBeLessThan(0.01)
    expect(comparison.discreteMismatchFrames).toBe(0)
    expect(comparison.animationActiveMismatchFrames).toBe(0)
  }
  // Without them, the first frame after a press decides when the press's
  // animation starts or retargets.
  const withoutEventTimes = compareAtSharedTimes(replayEvents({}, at(120), false), replayEvents({}, at(30), false))
  expect(withoutEventTimes.maxContinuousDifference).toBeGreaterThan(10)
  // Doctrine timing still pulls toward a new destination from the previous
  // evaluation's time, which depends on the frame rate.
  const doctrine = compareAtSharedTimes(
    replayEvents({retarget: 'doctrine'}, at(120), true),
    replayEvents({retarget: 'doctrine'}, at(30), true),
  )
  expect(doctrine.maxContinuousDifference).toBeGreaterThan(10)
})

test('for contrast: doctrine retargeting and the original springs diverge across frame rates', () => {
  const doctrine = compareAtSharedTimes(
    replay('bank doctrine', bank({retarget: 'doctrine'}), at(120)),
    replay('bank doctrine', bank({retarget: 'doctrine'}), at(30)),
  )
  expect(doctrine.maxContinuousDifference).toBeGreaterThan(10)
  const original = compareAtSharedTimes(
    replay('original file', createOriginalMachine, at(120)),
    replay('original file', createOriginalMachine, at(60, stall)),
  )
  expect(original.maxContinuousDifference).toBeGreaterThan(100)
})

test('focus, stacking, window flags, and photo focus match the original frame by frame', () => {
  const original = replay('original file', createOriginalMachine, at(60))
  const banked = replay('bank', bank(), at(60))
  original.forEach((record, index) => {
    expect(Array.from(banked[index]!.discrete)).toEqual(Array.from(record.discrete))
  })
})

test('Photos reading early inputs removes layers, and stepped springs avoid the lag during animations', () => {
  const current = sizes(createWindowManagerMachine(bankOptions).tensorProgram)
  for (const photosInputs of ['previous-frame', 'stepped-springs'] as const) {
    const early = sizes(createWindowManagerMachine({...bankOptions, photosInputs}).tensorProgram)
    expect(early.layers).toBeLessThan(current.layers - 30)
  }
  // The trace maximizes and restores Photos with animations but never resizes it
  // by hand, so stepped springs give Photos this frame's layout while last
  // frame's state lags visibly.
  const currentRecords = replay('bank', bank(), at(60))
  const maxDifference = (records: FrameRecord[]) => {
    let maximum = 0
    records.forEach((record, index) => {
      record.continuous.forEach((value, offset) => {
        maximum = Math.max(maximum, Math.abs(value - currentRecords[index]!.continuous[offset]!))
      })
    })
    return maximum
  }
  expect(maxDifference(replay('bank stepped springs', bank({photosInputs: 'stepped-springs'}), at(60)))).toBeLessThan(0.05)
  expect(maxDifference(replay('bank previous frame', bank({photosInputs: 'previous-frame'}), at(60)))).toBeGreaterThan(10)
})
