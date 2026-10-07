import {expect, test} from 'bun:test'
import {
  type SettlePolicy,
  compareCommitLogs,
  compareDisplays,
  createCommitter,
  replayCommitPerEvent,
  sequentialSettleProbe,
} from './commits.ts'
import {createEventTimeScene} from './demo-model.ts'
import {type EventTimeOptions, createEventTimeMachine} from './event-machine.ts'
import {animationTiming, createTracks, trackKeyframes} from './keyframes.ts'
import {compareScreens, holdLastFrame, screenGroups, simulateKeyframePresenter, staleWindow, stallWindow} from './playback.ts'
import {createPredictor, sampleCount} from './prediction.ts'
import {checkCommitSprings, createDisplaySpringCheck} from './springs-check.ts'
import {
  type FrameSchedule,
  type TraceEvent,
  createHandwiredOSTrace,
  offsetPresses,
  randomPressOffsets,
  replayTrace,
  scheduleFrameTimes,
} from './trace.ts'
import {createWgslInterpreter} from '../codegen/wgsl-interpreter.ts'
import {emitInstanceWgsl, packSharedBuffer} from '../codegen/wgsl.ts'
import {bankOptions, createWindowManagerMachine, sourceField, windowCount} from './window-manager.ts'

const resizeTrace = createHandwiredOSTrace({liveResize: true})
// Every press moves off the 30 fps grid by its own random offset, and Photos is
// resized by hand, so thumbnail destinations also change between frames.
const betweenFrames = offsetPresses(resizeTrace.events, randomPressOffsets(7, 30))
const durationMs = resizeTrace.durationMs + 2000
const stall500 = {startMs: 2701, durationMs: 500}
const stall2s = {startMs: 7001, durationMs: 2000}
const schedule = (fps: number, stall?: FrameSchedule['stall']): FrameSchedule =>
  stall === undefined ? {fps, durationMs} : {fps, durationMs, stall}

function replay(options: Partial<EventTimeOptions>, events: readonly TraceEvent[], frames: FrameSchedule, settle: SettlePolicy) {
  return replayCommitPerEvent(createEventTimeMachine(options), events, scheduleFrameTimes(frames), {settle, durationMs})
}

const referenceMachine = createEventTimeMachine({springs: 'source-matrix'})
const reference = replayCommitPerEvent(referenceMachine, betweenFrames, scheduleFrameTimes(schedule(240)), {settle: 'predicted', durationMs})

test('committed tables are bit for bit identical at 10, 30 and 240 fps and through stalls, and so are displays at shared timestamps', () => {
  expect(reference.counts.event).toBeGreaterThan(100)
  expect(reference.counts.settle).toBeGreaterThan(3)
  for (const frames of [schedule(10), schedule(30), schedule(60, stall500), schedule(60, stall2s)]) {
    const other = replay({springs: 'source-matrix'}, betweenFrames, frames, 'predicted')
    const commits = compareCommitLogs(reference.commits, other.commits)
    expect(commits.sameSchedule).toBe(true)
    expect(commits.differingCells).toBe(0)
    const displays = compareDisplays(reference.displays, other.displays)
    expect(displays.sharedFrames).toBeGreaterThan(50)
    expect(displays.bitMismatchFrames).toBe(0)
  }
})

test('split-table springs with interval settle commits: identical committed tables across frame rates', () => {
  const events = offsetPresses(createHandwiredOSTrace().events, () => 1)
  const splitReference = replay({springs: 'split-table'}, events, schedule(240), 'interval')
  for (const frames of [schedule(10), schedule(120, stall500)]) {
    const other = replay({springs: 'split-table'}, events, frames, 'interval')
    expect(compareCommitLogs(splitReference.commits, other.commits)).toMatchObject({sameSchedule: true, differingCells: 0})
    expect(compareDisplays(splitReference.displays, other.displays).bitMismatchFrames).toBe(0)
  }
})

test('generated JavaScript commits and displays match the validating executor bit for bit', () => {
  const executor = replay({springs: 'source-matrix', evaluator: 'executor', validate: true}, betweenFrames, schedule(30), 'predicted')
  expect(compareCommitLogs(reference.commits, executor.commits)).toMatchObject({sameSchedule: true, differingCells: 0})
  const displays = compareDisplays(reference.displays, executor.displays)
  expect(displays.sharedFrames).toBeGreaterThan(300)
  expect(displays.bitMismatchFrames).toBe(0)
})

test('for contrast: when frames write back, even with event-time evaluations, written-back tables differ in bits across rates', () => {
  const tablesAt = (fps: number) => {
    const machine = createWindowManagerMachine({...bankOptions, springs: 'source-matrix'})
    const tables = new Map<number, Float32Array>()
    replayTrace(machine, betweenFrames, scheduleFrameTimes(schedule(fps)), {
      evaluateAtEventTimes: true,
      afterStep: (_, time) => tables.set(time, Float32Array.from(machine.source)),
    })
    return tables
  }
  const fast = tablesAt(120)
  const slow = tablesAt(30)
  const positionCells = Array.from({length: windowCount * 5}, (_, index) => sourceField.springStart + Math.floor(index / 5) * 10 + (index % 5))
  let differingCells = 0
  let maxPositionDifference = 0
  for (const [time, table] of slow) {
    const match = fast.get(time)
    if (match === undefined) continue
    table.forEach((value, cell) => {
      if (!Object.is(value, match[cell])) differingCells++
    })
    for (const cell of positionCells) maxPositionDifference = Math.max(maxPositionDifference, Math.abs(table[cell]! - match[cell]!))
  }
  expect(differingCells).toBeGreaterThan(0)
  expect(maxPositionDifference).toBeLessThan(0.05)
})

test('an event that arrives after settle commits already ran undoes them: same table, settle time and displays right after the event', () => {
  const sameBits = (left: Float32Array, right: Float32Array) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  // Minimize Files at 200 ms, then restore it from the dock, either mid-animation
  // at 400 ms or exactly at the minimize's settle commit time (840 ms). The late
  // run first runs settle commits past that time, e.g. a timer task ran them
  // before the browser delivered the press.
  const run = (restoreAt: 'mid-animation' | 'settle time', late: boolean) => {
    const machine = createEventTimeMachine({springs: 'source-matrix'})
    const committer = createCommitter(machine, {settle: 'predicted'})
    machine.setViewport(1280, 800)
    committer.mount(0)
    committer.commitEvents(200, () => {
      machine.base.pointerDown(499, 76)
      machine.base.pointerUp(499, 76)
    })
    const firstSettleTime = committer.nextSettleTime!
    const restoreTime = restoreAt === 'mid-animation' ? 400 : firstSettleTime
    if (late) committer.settleUntil(restoreAt === 'mid-animation' ? 3000 : firstSettleTime)
    committer.commitEvents(restoreTime, () => {
      machine.base.pointerDown(547, 762)
      machine.base.pointerUp(547, 762)
    })
    const table = Float32Array.from(machine.table)
    const lastCommitTime = machine.lastCommitTime
    const nextSettleTime = committer.nextSettleTime!
    const displays = [1, 2, 3, 4].map(part => {
      const evaluation = machine.display(restoreTime + (nextSettleTime - restoreTime) * part / 5)
      return Float32Array.from(machine.displayPositions, position => evaluation.values[position]!)
    })
    committer.settleUntil(3000)
    return {firstSettleTime, table, lastCommitTime, nextSettleTime, displays, final: Float32Array.from(machine.table), counts: {...committer.counts}}
  }
  for (const restoreAt of ['mid-animation', 'settle time'] as const) {
    const inOrder = run(restoreAt, false)
    const late = run(restoreAt, true)
    expect(inOrder.counts.settle).toBeGreaterThan(0)
    expect(late.counts.undoneSettles).toBeGreaterThan(0)
    expect(late.counts.lateEvents).toBe(0)
    expect(late.lastCommitTime).toBe(inOrder.lastCommitTime)
    expect(late.nextSettleTime).toBe(inOrder.nextSettleTime)
    expect(sameBits(late.table, inOrder.table)).toBe(true)
    late.displays.forEach((display, index) => expect(sameBits(display, inOrder.displays[index]!)).toBe(true))
    expect(sameBits(late.final, inOrder.final)).toBe(true)
  }
})

test('window springs match float64 doctrine loops on commits and on displays', () => {
  const machine = createEventTimeMachine({springs: 'source-matrix', evaluator: 'executor', debugOutputs: true})
  const commits = checkCommitSprings(machine)
  const displays = createDisplaySpringCheck(machine)
  replayCommitPerEvent(machine, betweenFrames, scheduleFrameTimes(schedule(60)), {
    settle: 'predicted',
    durationMs,
    recordTables: false,
    recordDisplays: false,
    afterDisplay: (evaluation, time) => displays.check(evaluation, time),
  })
  expect(commits.stepFrames).toBeGreaterThan(20)
  expect(commits.maxPositionError).toBeLessThan(1e-3)
  expect(commits.settleMismatches).toBe(0)
  expect(displays.result.displays).toBeGreaterThan(600)
  expect(displays.result.maxPositionError).toBeLessThan(1e-3)
  expect(displays.result.settleMismatches).toBe(0)
})

test('a prediction equals whole-circuit displays at all 301 samples, and its settle step equals the sequential probe', () => {
  const machine = createEventTimeMachine({springs: 'source-matrix'})
  const predictor = createPredictor(machine)
  let checkedPredictions = 0
  let mismatches = 0
  replayCommitPerEvent(machine, betweenFrames, [], {
    settle: 'predicted',
    durationMs,
    recordTables: false,
    afterCommit(kind) {
      if (kind !== 'event' || !machine.running() || checkedPredictions >= 3) return
      checkedPredictions++
      const prediction = predictor.predict()
      for (let sample = 0; sample < sampleCount; sample++) {
        const evaluation = machine.display(prediction.originTime + sample * 4)
        for (let root = 0; root < prediction.rootCount; root++) {
          if (!Object.is(evaluation.values[machine.displayPositions[root]!], prediction.samples[sample * prediction.rootCount + root])) mismatches++
        }
      }
      expect(prediction.settleStep).toBe(sequentialSettleProbe(machine))
    },
  })
  expect(checkedPredictions).toBe(3)
  expect(mismatches).toBe(0)
})

test('emitted keyframes show what 240 fps displays show; through a stall, transform and opacity keep playing while width and height wait', () => {
  const times = scheduleFrameTimes(schedule(240))
  const groups = screenGroups(createTracks(referenceMachine), referenceMachine.displayRoots.length)
  const presenter = (events: readonly TraceEvent[], stall?: typeof stall500) => {
    const machine = createEventTimeMachine({springs: 'source-matrix'})
    return simulateKeyframePresenter(machine, createPredictor(machine), events, times, stall === undefined ? {durationMs} : {durationMs, stall})
  }
  // No stall: every output matches, and no animation's interpolation blends two samples.
  const smooth = presenter(betweenFrames)
  const smoothScreen = compareScreens(reference.displays, smooth.rows, groups)
  expect(smoothScreen.frames).toBeGreaterThan(2500)
  expect(smoothScreen.groups.all.differingFrames).toBe(0)
  expect(smooth.stats.blendedFrames).toBe(0)
  expect(smooth.stats.keyframes).toBeGreaterThan(100_000)

  // A press arrives inside the 500 ms stall: transform and opacity only differ
  // inside the stale interval, and nothing differs outside the stall.
  const stalled = presenter(betweenFrames, stall500).rows
  expect(compareScreens(reference.displays, stalled, groups, staleWindow(betweenFrames, times, stall500)).groups.composited.differingFramesOutsideWindow).toBe(0)
  expect(compareScreens(reference.displays, stalled, groups, stallWindow(stall500)).groups.all.differingFramesOutsideWindow).toBe(0)

  // Presses on 30 fps frame times, which 240 fps renders, so the press that
  // restores Photos mid-animation at 2,700 ms reaches the compositor before the
  // 500 ms stall at 2,701 ms: transform and opacity match through the stall,
  // width and height wait, and held 60 fps display frames are far off in
  // transform too.
  const framePresses = createHandwiredOSTrace().events
  const framePressesReference = replayCommitPerEvent(createEventTimeMachine({springs: 'source-matrix'}), framePresses, times, {settle: 'predicted', durationMs}).displays
  expect(staleWindow(framePresses, times, stall500)).toBeNull()
  const restore = compareScreens(framePressesReference, presenter(framePresses, stall500).rows, groups, stallWindow(stall500))
  expect(restore.groups.composited.differingFrames).toBe(0)
  expect(restore.groups.all.differingFramesOutsideWindow).toBe(0)
  expect(restore.groups.layout.maxPxInsideWindow).toBeGreaterThan(100)
  const frozen = replay({springs: 'source-matrix'}, framePresses, schedule(60, stall500), 'predicted')
  const frozenScreen = compareScreens(framePressesReference, holdLastFrame(frozen.displays, times), groups, stallWindow(stall500))
  expect(frozenScreen.groups.composited.maxPxInsideWindow).toBeGreaterThan(100)

  // Every event 1 ms later: the same press arrives at 2,701 ms, after the last
  // main-thread frame (2,700 ms) and as the stall starts. JS commits it, but its
  // animations only reach the compositor after the stall, so transform is far
  // off inside the stale interval and exact outside it.
  const laterEvents = offsetPresses(createHandwiredOSTrace().events, () => 1)
  const laterReference = replayCommitPerEvent(createEventTimeMachine({springs: 'source-matrix'}), laterEvents, times, {settle: 'predicted', durationMs}).displays
  const laterStale = staleWindow(laterEvents, times, stall500)
  expect(laterStale).toEqual([2701, 3201])
  const later = compareScreens(laterReference, presenter(laterEvents, stall500).rows, groups, laterStale)
  expect(later.groups.composited.differingFramesOutsideWindow).toBe(0)
  expect(later.groups.composited.maxPxInsideWindow).toBeGreaterThan(100)
})

test('demo scene: minimizing Files animates only Files, and the settle commit ends every animation', () => {
  const scene = createEventTimeScene()
  scene.mount(0, 1280, 800)
  expect(scene.plan.animatedTrackCount).toBe(0)
  scene.pointerDown(200, 499, 76)
  scene.pointerUp(200, 499, 76)
  const {plan, prediction} = scene
  const animated = plan.tracks
    .filter(entry => entry.animated.composited || entry.animated.layout)
    .map(entry => `${entry.track.kind} ${entry.track.index}`)
  expect(animated).toEqual(['window 0'])
  expect(prediction.settleStep).not.toBeNull()
  expect(plan.lastSample).toBe(prediction.settleStep!)
  const windowTrack = plan.tracks[0]!.track
  expect(plan.tracks[0]!.animated.composited).toBe(true)
  expect(trackKeyframes(prediction, plan, windowTrack, 'composited')).toHaveLength(plan.lastSample + 1)
  expect(animationTiming(plan)).toEqual({duration: 4 * plan.lastSample, easing: `steps(${plan.lastSample}, end)`, fill: 'forwards'})
  const settleTime = scene.committer.nextSettleTime!
  expect(plan.startTime).toBe(prediction.originTime - 1 / 128)
  expect(settleTime).toBe(prediction.originTime + 4 * plan.lastSample)
  expect(scene.settleUntil(settleTime)).toBe(true)
  expect(scene.plan.animatedTrackCount).toBe(0)
  expect(scene.committer.nextSettleTime).toBeNull()
})

test('the per-sample WGSL, interpreted with strict f32 rounding, reproduces the CPU prediction', () => {
  const machine = createEventTimeMachine({springs: 'source-matrix'})
  const predictor = createPredictor(machine, {blockSize: 32})
  const committer = createCommitter(machine, {settle: 'predicted'})
  machine.setViewport(1280, 800)
  committer.mount(0)
  // Maximize Photos, so the Photos layout reads animating window sizes.
  committer.commitEvents(100, () => {
    machine.base.pointerDown(1163, 212)
    machine.base.pointerUp(1163, 212)
  })
  expect(machine.running()).toBe(true)
  const count = 32
  const outputCount = predictor.plan.outputs.length
  const cpu = new Float32Array(count * outputCount)
  predictor.runner.runShared(machine.table)
  predictor.runner.runInstances(predictor.powers(), count, cpu)
  const module = emitInstanceWgsl(predictor.plan, {guard: 'max'})
  const interpreted = new Float32Array(count * outputCount)
  createWgslInterpreter(module.code)(packSharedBuffer(module, predictor.runner), predictor.powers(), count, interpreted)
  let mismatches = 0
  cpu.forEach((value, index) => {
    if (value !== interpreted[index]) mismatches++
  })
  expect(mismatches).toBe(0)
})
