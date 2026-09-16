// Checks the highlight in shared-runtime-springs.ts, built with emitAnimatedObject and
// advanceFrame, against plain float64 springs with no frames, and across frame rates.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/springs
import {expect, test} from 'bun:test'
import {Circuit, type Wire, emitApplySpringMatrix, asWire} from '../../../../../numeric-ui-core.ts'
import {quantizeFrameTiming} from '../../../../../host-timing.ts'
import {frameTimesAt} from './frame-rate-check.ts'
import {type SelectRow, buildHighlight, highlightReference, rowHeight, runHighlight, selectEvents} from './shared-runtime-springs.ts'

const seeds = [1, 2, 3, 4, 5, 6, 7, 8]

function counts(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  return {operations: program.valueCount - program.sourceSize, layers: program.layers.length}
}

// 120 fps as the baseline, then 10, 30 and 60 fps, and 60 and 120 fps with a 500 ms
// stall that starts 100 ms before the third event.
function schedules(events: readonly SelectRow[]) {
  const durationMs = events.at(-1)!.timeStamp + 2000
  const stall = {startMs: events[2]!.timeStamp - 100, lengthMs: 500}
  return {
    baseline: frameTimesAt(120, durationMs),
    others: [
      frameTimesAt(10, durationMs),
      frameTimesAt(30, durationMs),
      frameTimesAt(60, durationMs),
      frameTimesAt(60, durationMs, stall),
      frameTimesAt(120, durationMs, stall),
    ],
  }
}

// The largest difference between two runs' drawn tops at the timestamps both rendered.
function maxTopDifference(left: ReadonlyMap<number, number>, right: ReadonlyMap<number, number>) {
  let worst = 0
  let shared = 0
  for (const [time, top] of left) {
    const other = right.get(time)
    if (other === undefined) continue
    shared++
    worst = Math.max(worst, Math.abs(top - other))
  }
  expect(shared).toBeGreaterThan(20)
  return worst
}

test('costs: one spring matrix is 14 operations in 3 layers, and a matrix cell needs a declared range', () => {
  const circuit = new Circuit(6)
  for (let entry = 0; entry < 4; entry++) circuit.assumeRange(asWire(entry), -7, 7)
  const stepped = emitApplySpringMatrix(circuit, [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3)], circuit.source(4), circuit.source(5))
  expect(counts(circuit, [stepped.displacement, stepped.velocity])).toEqual({operations: 14, layers: 3})
  // The whole highlight: the select event's destination, one animated object of one
  // spring with a separate destination during steps and a snap bit, and the latch resets.
  const {circuit: highlight, roots} = buildHighlight()
  expect(counts(highlight, roots)).toEqual({operations: 38, layers: 13})
  const undeclared = new Circuit(6)
  expect(() => emitApplySpringMatrix(undeclared, [undeclared.source(0), undeclared.source(1), undeclared.source(2), undeclared.source(3)], undeclared.source(4), undeclared.source(5))).toThrow('finite declared ranges')
})

test("with 'events and settle checks', the drawn top is bit-identical at 10, 30, 60 and 120 fps and through 500 ms stalls, and settles like frame-free float64 springs", () => {
  for (const seed of seeds) {
    const events = selectEvents(seed)
    const {baseline, others} = schedules(events)
    const baselineRun = runHighlight(baseline, events, 'events and settle checks')
    for (const frameTimes of [baseline, ...others]) {
      const run = frameTimes === baseline ? baselineRun : runHighlight(frameTimes, events, 'events and settle checks')
      let differingTops = 0
      for (const [time, top] of run.tops) {
        const other = baselineRun.tops.get(time)
        if (other !== undefined && !Object.is(top, other)) differingTops++
      }
      expect(differingTops).toBe(0)
      expect(run.settles).toEqual(baselineRun.settles)
      const reference = highlightReference(frameTimes, events)
      expect(run.settles).toEqual(reference.settles)
      expect(maxTopDifference(run.tops, reference.tops)).toBeLessThan(5e-4)
    }
  }
})

test('writing back every evaluation stays within 2e-3 px of frame-free float64 springs and of 120 fps', () => {
  let runsWithDifferentSettles = 0
  for (const seed of seeds) {
    const events = selectEvents(seed)
    const {baseline, others} = schedules(events)
    const baselineRun = runHighlight(baseline, events, 'every evaluation')
    for (const frameTimes of [baseline, ...others]) {
      const run = frameTimes === baseline ? baselineRun : runHighlight(frameTimes, events, 'every evaluation')
      const reference = highlightReference(frameTimes, events)
      expect(maxTopDifference(run.tops, reference.tops)).toBeLessThan(2e-3)
      expect(maxTopDifference(run.tops, baselineRun.tops)).toBeLessThan(2e-3)
      if (JSON.stringify(run.settles) !== JSON.stringify(reference.settles)) runsWithDifferentSettles++
    }
  }
  expect(runsWithDifferentSettles).toBe(0)
})

test("the host writes the frame's duration and event times relative to the frame on a 1/64 ms grid, with 0 after idle and at most 1,200 ms after a stall", () => {
  // The first frame after idle has duration 0, and an event 3.5 ms before the frame reads about -3.5.
  const first = quantizeFrameTiming(1016.6667, null, [1013.2])
  expect(first).toEqual({frameTimeMs: 1016.671875, durationMs: 0, eventTimesMs: [-3.46875]})
  // An event after the frame's timestamp reads 0.
  const second = quantizeFrameTiming(1033.3333, first.frameTimeMs, [1020, 1040])
  expect(second).toEqual({frameTimeMs: 1033.328125, durationMs: 16.65625, eventTimesMs: [-13.328125, 0]})
  // Timestamps are rounded before subtracting, so durations add up to the rounded span.
  let previousFrameTimeMs: number | null = null
  let totalMs = 0
  for (const timeStamp of [1000, 1016.6667, 1033.3333, 1050, 1066.6667]) {
    const timing = quantizeFrameTiming(timeStamp, previousFrameTimeMs, [])
    totalMs += timing.durationMs
    previousFrameTimeMs = timing.frameTimeMs
  }
  expect(totalMs).toBe(66.671875)
  // After a 100 s stall, the duration and an older event's time are clamped at the
  // 300-step cap, 1,200 ms, since springs snap past it.
  const stalled = quantizeFrameTiming(101_000, 1000, [500])
  expect(stalled.durationMs).toBe(1200)
  expect(stalled.eventTimesMs).toEqual([-1200])
})

test('after a stall longer than 1.2 s, a snap lands the highlight on its destination, no frame runs more than 300 steps, and the committed table is bit-identical at 10, 30, 60 and 120 fps', () => {
  // A select event starts a move at 100 ms, and every rate stops rendering from 150 ms
  // until 3,200 ms, a frame time that 10, 30, 60 and 120 fps all render. A second
  // select event after the stall starts a new move from rest.
  const events: SelectRow[] = [{timeStamp: 100, row: 11}, {timeStamp: 3300.5, row: 2}]
  const stall = {startMs: 150, lengthMs: 3050}
  const runs = [120, 60, 30, 10].map(hz => runHighlight(frameTimesAt(hz, 5500, stall), events, 'events and settle checks'))
  const baseline = runs[0]!
  for (const run of runs) {
    expect(Math.max(...run.stepsPerFrame)).toBeLessThanOrEqual(300)
    // The springs last stepped at 148 ms or earlier, so reaching 3,200 ms would take more than 300 steps.
    expect(run.snapTimes).toEqual([3200])
    expect(run.tops.get(3200)).toBe(11 * rowHeight)
    expect(run.settles).toEqual(baseline.settles)
    expect(Array.from(run.finalState)).toEqual(Array.from(baseline.finalState))
    let differingTops = 0
    for (const [time, top] of run.tops) {
      const other = baseline.tops.get(time)
      if (other !== undefined && !Object.is(top, other)) differingTops++
    }
    expect(differingTops).toBe(0)
  }
  // From the snap on, the drawn top follows frame-free float64 springs, which settled long before the stall ended.
  const reference = highlightReference(frameTimesAt(120, 5500, stall), events)
  for (const [time, top] of baseline.tops) {
    if (time >= 3200) expect(Math.abs(top - reference.tops.get(time)!)).toBeLessThan(5e-4)
  }
  // Writing back every evaluation snaps at the same time, onto the same destination.
  const everyEvaluation = runHighlight(frameTimesAt(60, 5500, stall), events, 'every evaluation')
  expect(everyEvaluation.snapTimes).toEqual([3200])
  expect(everyEvaluation.tops.get(3200)).toBe(11 * rowHeight)
})
