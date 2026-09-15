// Runs the toast stack in toast-stack.ts through advanceFrame with both write-back
// policies, at several frame rates and through stalls, against frame-free float64
// JavaScript and in both evaluators, and pins the numbers that
// guide/patterns/commit-at-events.md quotes. Run from the repo root:
// bun test lab/ui-exploration/guide/examples/patterns/fewer-dependencies
import {expect, test} from 'bun:test'
import {frameTimesAt, seededRandom} from './helpers.ts'
import {type ToastEvent, type ToastRun, runToastStack, toastStackReference} from './toast-stack.ts'

// 16 events between frames on the 1/64 ms grid, 40 to 540 ms apart, so most of them
// land while toasts are still moving: presses around the stack, and "Show all" about
// one time in five.
function randomToastEvents(seed: number): ToastEvent[] {
  const random = seededRandom(seed)
  const events: ToastEvent[] = []
  let time = 100
  for (let index = 0; index < 16; index++) {
    time += 40 + random() * 500
    const timeStamp = Math.round(time * 64) / 64
    if (random() < 0.2) events.push({timeStamp, kind: 'show all'})
    else events.push({timeStamp, kind: 'press', x: Math.round((random() * 400 - 20) * 64) / 64, y: Math.round((random() * 200 - 10) * 64) / 64})
  }
  return events
}

// Events on the moments where timing rules differ: a press that starts the clock at
// 1,000 ms, a press exactly on the settle check at 1,064 ms, a press and "Show all"
// sharing the 1,200 ms timestamp, which every frame rate renders, a press on the
// column's left edge between frames, and one just inside its right edge.
const scriptedEvents: ToastEvent[] = [
  {timeStamp: 1000, kind: 'press', x: 116, y: 4},
  {timeStamp: 1064, kind: 'press', x: 116, y: 4},
  {timeStamp: 1200, kind: 'press', x: 116, y: 60},
  {timeStamp: 1200, kind: 'show all'},
  {timeStamp: 1203.015625, kind: 'press', x: 16, y: 100},
  {timeStamp: 1500, kind: 'press', x: 335.984375, y: 50},
  {timeStamp: 2400, kind: 'show all'},
]

const traces = [...[1, 2, 3, 4, 5, 6].map(randomToastEvents), scriptedEvents]

// 120 fps as the baseline, then 10, 30 and 60 fps, and 60 and 120 fps with a 500 ms
// stall that starts 100 ms before the fourth event.
function schedules(events: readonly ToastEvent[]) {
  const durationMs = events.at(-1)!.timeStamp + 2000
  const stall = {startMs: events[3]!.timeStamp - 100, lengthMs: 500}
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

function sameCommits(left: ToastRun, right: ToastRun) {
  return left.commits.length === right.commits.length && left.commits.every((commit, index) => {
    const other = right.commits[index]!
    return commit.kind === other.kind && commit.timeMs === other.timeMs && commit.table.every((value, cell) => Object.is(value, other.table[cell]))
  })
}

// Frames rendered by both runs, and how many of them drew any top with different bits.
function compareDrawnTops(left: ToastRun, right: ToastRun) {
  let shared = 0
  let differing = 0
  for (const [time, tops] of left.drawnTops) {
    const other = right.drawnTops.get(time)
    if (other === undefined) continue
    shared++
    if (tops.some((top, index) => !Object.is(top, other[index]))) differing++
  }
  return {shared, differing}
}

function maxTopDifference(left: ReadonlyMap<number, readonly number[]>, right: ReadonlyMap<number, readonly number[]>) {
  let worst = 0
  for (const [time, tops] of left) {
    const other = right.get(time)
    if (other === undefined) continue
    tops.forEach((top, index) => { worst = Math.max(worst, Math.abs(top - other[index]!)) })
  }
  return worst
}

test("with 'events and settle checks', every committed table and every drawn top is bit-identical at 10, 30, 60 and 120 fps and through 500 ms stalls, and settles like frame-free float64 JavaScript", () => {
  for (const events of traces) {
    const {baseline, others} = schedules(events)
    const baselineRun = runToastStack(baseline, events, 'events and settle checks')
    const reference = toastStackReference(baseline, events)
    expect(baselineRun.settleChecks).toEqual(reference.settleChecks)
    expect(maxTopDifference(baselineRun.drawnTops, reference.drawnTops)).toBeLessThan(1e-4)
    for (const frameTimes of others) {
      const run = runToastStack(frameTimes, events, 'events and settle checks')
      expect(sameCommits(run, baselineRun)).toBe(true)
      const drawn = compareDrawnTops(run, baselineRun)
      expect(drawn.shared).toBeGreaterThan(20)
      expect(drawn.differing).toBe(0)
      expect(run.settleChecks).toEqual(toastStackReference(frameTimes, events).settleChecks)
    }
  }
})

test('writing back every evaluation draws within 1e-4 px of 120 fps and of float64, but about half the stored tables at shared frame timestamps differ in bits', () => {
  for (const events of traces) {
    const {baseline, others} = schedules(events)
    const baselineRun = runToastStack(baseline, events, 'every evaluation')
    for (const frameTimes of [baseline, ...others]) {
      const run = frameTimes === baseline ? baselineRun : runToastStack(frameTimes, events, 'every evaluation')
      const reference = toastStackReference(frameTimes, events)
      expect(maxTopDifference(run.drawnTops, baselineRun.drawnTops)).toBeLessThan(1e-4)
      expect(maxTopDifference(run.drawnTops, reference.drawnTops)).toBeLessThan(1e-4)
      expect(run.settleChecks).toEqual(reference.settleChecks)
    }
  }
  // Seed 1: tables stored by frames at timestamps that 120 fps also renders.
  const events = randomToastEvents(1)
  const durationMs = events.at(-1)!.timeStamp + 2000
  const storedByFrames = (run: ToastRun) => new Map(run.commits.filter(commit => commit.kind === 'frame').map(commit => [commit.timeMs, commit.table]))
  const baselineTables = storedByFrames(runToastStack(frameTimesAt(120, durationMs), events, 'every evaluation'))
  const differingTables = [10, 30, 60].map(hz => {
    let shared = 0
    let differing = 0
    for (const [time, table] of storedByFrames(runToastStack(frameTimesAt(hz, durationMs), events, 'every evaluation'))) {
      const other = baselineTables.get(time)
      if (other === undefined) continue
      shared++
      if (table.some((value, cell) => !Object.is(value, other[cell]))) differing++
    }
    return {hz, shared, differing}
  })
  expect(differingTables).toEqual([
    {hz: 10, shared: 64, differing: 33},
    {hz: 30, shared: 192, differing: 94},
    {hz: 60, shared: 383, differing: 192},
  ])
})

test('both evaluators give the same committed tables and drawn tops', () => {
  const {others} = schedules(scriptedEvents)
  const frameTimes = others[3]!
  const compiled = runToastStack(frameTimes, scriptedEvents, 'events and settle checks', 'destinations', 'compiled')
  const reference = runToastStack(frameTimes, scriptedEvents, 'events and settle checks', 'destinations', 'reference')
  expect(sameCommits(compiled, reference)).toBe(true)
  expect(compareDrawnTops(compiled, reference).differing).toBe(0)
})

test('cost: the same program and the same evaluations with either policy, e.g. 383 frames, 16 event evaluations and 51 settle checks at 60 fps over 6.4 s', () => {
  const events = randomToastEvents(1)
  const frameTimes = frameTimesAt(60, events.at(-1)!.timeStamp + 2000)
  const expected = {frame: 383, events: 16, 'settle check': 51, snap: 0}
  expect(runToastStack(frameTimes, events, 'events and settle checks').evaluationCounts).toEqual(expected)
  expect(runToastStack(frameTimes, events, 'every evaluation').evaluationCounts).toEqual(expected)
})
