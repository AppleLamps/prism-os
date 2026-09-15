// When to commit, and a replay that commits per event and samples per frame.
//
// Commits happen at event timestamps and at settle times derived from the
// committed table, never at frame times:
// - 'interval': while the committed clock runs, commit again 1,200 ms after the
//   last commit (the 300-step cap), until a commit reports that nothing animates.
// - 'predicted': while the committed clock runs, find the first step count in
//   16, 32, ..., 288 whose display reports that nothing animates, and commit at
//   that step's simulated time, lastCommit - leftover + 4 ms × steps. When no
//   checked step settles, commit 1,200 ms later.
// Events that share a timestamp share one commit. Settle commits strictly
// before an event run before the event's commit, and an event commit at a
// settle time replaces that settle commit. Settle commits are derived from the
// last event commit, so when an event arrives with a timestamp at or before
// settle commits that already ran, e.g. a pointer event delivered after the
// timer task that ran a settle commit, they're undone by restoring that event
// commit's table. An event with a timestamp before the last event commit can't
// be undone this way: it's committed with zero elapsed time and counted in
// `lateEvents`.
import {invariant} from '../../../numeric-ui-core.ts'
import {type EventTimeMachine, type Evaluation, type MachineSnapshot, displayLayout, readWire} from './event-machine.ts'
import {itemCount as photoCount, photoField} from '../spring-bank/photo-gallery.ts'
import {defaultClockConfig, quantizeFrameTime} from '../spring-bank/spring-math.ts'
import {type TraceEvent, applyEvent, traceViewport} from '../spring-bank/trace.ts'
import {
  dragSourceField,
  photoFocusSourceField,
  resizeSourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../spring-bank/window-manager.ts'

export type CommitKind = 'mount' | 'event' | 'settle'
export type SettlePolicy = 'interval' | 'predicted'

export const settleIntervalMs = defaultClockConfig.stepMs * defaultClockConfig.maxSteps
export const settleCheckStepMultiple = 16
export const lastSettleCheckSteps = Math.floor(defaultClockConfig.maxSteps / settleCheckStepMultiple) * settleCheckStepMultiple

// The first step count in 16, 32, ..., 288 whose display from the committed
// table reports that nothing animates, or null.
export type SettleProbe = (machine: EventTimeMachine) => number | null

export function sequentialSettleProbe(machine: EventTimeMachine): number | null {
  const commitTime = machine.lastCommitTime
  invariant(commitTime !== null, 'no commit yet')
  const originTime = commitTime - machine.leftoverMs()
  for (let steps = settleCheckStepMultiple; steps <= lastSettleCheckSteps; steps += settleCheckStepMultiple) {
    const evaluation = machine.display(originTime + steps * defaultClockConfig.stepMs)
    if (readWire(evaluation, machine.output.animationActive) === 0) return steps
  }
  return null
}

export type CommitterOptions = {
  settle: SettlePolicy
  probe?: SettleProbe
  // Called after every commit, before the next settle time is computed. With
  // the executor, commits and displays share one evaluation object, so copy
  // what you need.
  afterCommit?: (kind: CommitKind, time: number, evaluation: Evaluation) => void
}

export function createCommitter(machine: EventTimeMachine, options: CommitterOptions) {
  const probe = options.probe ?? sequentialSettleProbe
  let nextSettleTime: number | null = null
  let checkpoint: {snapshot: MachineSnapshot, nextSettleTime: number | null} | null = null
  let settlesSinceCheckpoint = 0
  const counts = {mount: 0, event: 0, settle: 0, undoneSettles: 0, lateEvents: 0}

  function scheduleSettle(): number | null {
    if (!machine.running()) return null
    const commitTime = machine.lastCommitTime!
    if (options.settle === 'interval') return commitTime + settleIntervalMs
    const steps = probe(machine)
    return steps === null
      ? commitTime + settleIntervalMs
      : commitTime - machine.leftoverMs() + steps * defaultClockConfig.stepMs
  }

  function commit(kind: CommitKind, time: number) {
    const evaluation = machine.commit(time)
    counts[kind]++
    options.afterCommit?.(kind, machine.lastCommitTime!, evaluation)
    nextSettleTime = scheduleSettle()
  }

  function settleWhile(due: (settleTime: number) => boolean) {
    while (nextSettleTime !== null && due(nextSettleTime)) {
      commit('settle', nextSettleTime)
      settlesSinceCheckpoint++
    }
  }

  function saveCheckpoint() {
    checkpoint = {snapshot: machine.snapshot(), nextSettleTime}
    settlesSinceCheckpoint = 0
  }

  return {
    counts,
    get nextSettleTime() {
      return nextSettleTime
    },
    mount(time: number) {
      commit('mount', time)
      saveCheckpoint()
    },
    // Run settle commits due at or before `time`, e.g. before displaying `time`.
    settleUntil(time: number) {
      settleWhile(settleTime => settleTime <= time)
    },
    // `applyEvents` latches this timestamp's events into the committed table.
    commitEvents(time: number, applyEvents: () => void) {
      invariant(checkpoint !== null, 'mount first')
      const quantized = quantizeFrameTime(time, defaultClockConfig)
      const checkpointTime = checkpoint.snapshot.lastCommitTime!
      // In timestamp order, a settle commit at the event's own timestamp wouldn't
      // have run (settleWhile below runs strictly earlier ones), so undo at equality too.
      if (settlesSinceCheckpoint > 0 && quantized <= machine.lastCommitTime! && quantized >= checkpointTime) {
        machine.restore(checkpoint.snapshot)
        nextSettleTime = checkpoint.nextSettleTime
        counts.undoneSettles += settlesSinceCheckpoint
        settlesSinceCheckpoint = 0
      }
      if (quantized < machine.lastCommitTime!) counts.lateEvents++
      settleWhile(settleTime => settleTime < quantized)
      applyEvents()
      commit('event', quantized)
      saveCheckpoint()
    },
  }
}

export type Committer = ReturnType<typeof createCommitter>

export type DisplayRecord = {
  time: number
  // For each window: translate x, translate y, width, height, scale, opacity.
  // Then Photos photos and thumbnails: left, top, width, height, opacity.
  continuous: Float32Array
  // Focus output, then committed flags, drag and resize owners, stacking and photo focus.
  discrete: Float32Array
  animationActive: number
  // Every display root, for bit comparisons.
  outputs: Float32Array
}

const windowContinuousFields = [
  windowOutputField.translateX,
  windowOutputField.translateY,
  windowOutputField.width,
  windowOutputField.height,
  windowOutputField.scale,
  windowOutputField.opacity,
] as const
const photoContinuousFields = [photoField.left, photoField.top, photoField.width, photoField.height, photoField.opacity] as const

// Offsets into displayRoots of the continuous values a DisplayRecord keeps.
export function continuousOffsets(machine: Pick<EventTimeMachine, 'output'>) {
  const layout = displayLayout(machine)
  const offsets: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of windowContinuousFields) offsets.push(layout.windows + windowIndex * windowOutputField.size + field)
  }
  for (const start of [layout.photos, layout.thumbnails]) {
    for (let item = 0; item < photoCount; item++) {
      for (const field of photoContinuousFields) offsets.push(start + item * photoField.size + field)
    }
  }
  return Int32Array.from(offsets)
}

export function createDisplayRecorder(machine: EventTimeMachine) {
  const layout = displayLayout(machine)
  const continuous = continuousOffsets(machine)
  const positions = machine.displayPositions
  return function record(evaluation: Evaluation, time: number): DisplayRecord {
    const outputs = new Float32Array(positions.length)
    for (let index = 0; index < positions.length; index++) outputs[index] = evaluation.values[positions[index]!]!
    const discrete: number[] = []
    const {table} = machine
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      discrete.push(outputs[layout.windows + windowIndex * windowOutputField.size + windowOutputField.focused]!)
      for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized]) {
        discrete.push(table[windowSourceField(windowIndex, field)]!)
      }
      discrete.push(table[dragSourceField(windowIndex)]!, table[resizeSourceField(windowIndex)]!)
      for (let rank = 0; rank < windowCount; rank++) discrete.push(table[stackSourceField(rank, windowIndex)]!)
    }
    for (let item = 0; item < photoCount; item++) discrete.push(table[photoFocusSourceField(item)]!)
    return {
      time,
      continuous: Float32Array.from(continuous, offset => outputs[offset]!),
      discrete: Float32Array.from(discrete),
      animationActive: outputs[layout.animationActive]!,
      outputs,
    }
  }
}

export type CommitRecord = {time: number, kind: CommitKind, table: Float32Array}

export type CommitReplayOptions = {
  settle: SettlePolicy
  durationMs: number
  probe?: SettleProbe
  recordTables?: boolean
  recordDisplays?: boolean
  afterCommit?: (kind: CommitKind, time: number, evaluation: Evaluation) => void
  afterDisplay?: (evaluation: Evaluation, time: number) => void
}

// Mount at time 0, commit at every distinct event timestamp and at settle times,
// display at every frame time. The commits are the same for any frame times.
export function replayCommitPerEvent(
  machine: EventTimeMachine,
  events: readonly TraceEvent[],
  frameTimes: readonly number[],
  options: CommitReplayOptions,
) {
  const commits: CommitRecord[] = []
  const displays: DisplayRecord[] = []
  const record = createDisplayRecorder(machine)
  const committer = createCommitter(machine, {
    settle: options.settle,
    ...(options.probe === undefined ? {} : {probe: options.probe}),
    afterCommit(kind, time, evaluation) {
      if (options.recordTables !== false) commits.push({time, kind, table: Float32Array.from(machine.table)})
      options.afterCommit?.(kind, time, evaluation)
    },
  })
  machine.setViewport(traceViewport.width, traceViewport.height)
  committer.mount(0)
  let nextEvent = 0
  const commitEventsUntil = (time: number) => {
    while (nextEvent < events.length && events[nextEvent]!.time <= time) {
      const eventTime = events[nextEvent]!.time
      committer.commitEvents(eventTime, () => {
        while (nextEvent < events.length && events[nextEvent]!.time === eventTime) applyEvent(machine.base, events[nextEvent++]!)
      })
    }
  }
  for (const frameTime of frameTimes) {
    if (frameTime > options.durationMs) break
    commitEventsUntil(frameTime)
    committer.settleUntil(frameTime)
    const evaluation = machine.display(frameTime)
    options.afterDisplay?.(evaluation, frameTime)
    if (options.recordDisplays !== false) displays.push(record(evaluation, frameTime))
  }
  commitEventsUntil(options.durationMs)
  committer.settleUntil(options.durationMs)
  // null when the committed clock is stopped, so no later commit would ever run.
  return {commits, displays, counts: committer.counts, nextSettleTime: committer.nextSettleTime}
}

export function compareCommitLogs(reference: readonly CommitRecord[], other: readonly CommitRecord[]) {
  let sameSchedule = reference.length === other.length
  let differingCommits = 0
  let differingCells = 0
  const count = Math.min(reference.length, other.length)
  for (let index = 0; index < count; index++) {
    const left = reference[index]!
    const right = other[index]!
    if (left.time !== right.time || left.kind !== right.kind) sameSchedule = false
    let cells = 0
    for (let cell = 0; cell < left.table.length; cell++) {
      if (!Object.is(left.table[cell], right.table[cell])) cells++
    }
    if (cells > 0) differingCommits++
    differingCells += cells
  }
  return {commits: reference.length, otherCommits: other.length, sameSchedule, differingCommits, differingCells}
}

export function compareDisplays(reference: readonly DisplayRecord[], other: readonly DisplayRecord[]) {
  const byTime = new Map(other.map(record => [record.time, record]))
  let sharedFrames = 0
  let bitMismatchFrames = 0
  let maxContinuousDifference = 0
  let discreteMismatchFrames = 0
  let animationActiveMismatchFrames = 0
  for (const record of reference) {
    const match = byTime.get(record.time)
    if (match === undefined) continue
    sharedFrames++
    if (record.outputs.some((value, index) => !Object.is(value, match.outputs[index]))) bitMismatchFrames++
    maxContinuousDifference = Math.max(maxContinuousDifference, maxDifference(record.continuous, match.continuous))
    if (record.discrete.some((value, index) => value !== match.discrete[index])) discreteMismatchFrames++
    if ((record.animationActive > 0) !== (match.animationActive > 0)) animationActiveMismatchFrames++
  }
  return {sharedFrames, bitMismatchFrames, maxContinuousDifference, discreteMismatchFrames, animationActiveMismatchFrames}
}

export function maxDifference(left: ArrayLike<number>, right: ArrayLike<number>) {
  let maximum = 0
  for (let index = 0; index < left.length; index++) maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!))
  return maximum
}

// Browsers deliver at most one pointermove per display frame unless a page
// asks for getCoalescedEvents(). This keeps the last move of every run of moves
// within one 1000 / hz ms bucket, at its own timestamp.
export function coalescePointerMoves(events: readonly TraceEvent[], hz: number): TraceEvent[] {
  const kept: TraceEvent[] = []
  events.forEach((event, index) => {
    const next = events[index + 1]
    if (event.kind === 'pointerMove' && next?.kind === 'pointerMove'
      && Math.floor(next.time * hz / 1000) === Math.floor(event.time * hz / 1000)) return
    kept.push(event)
  })
  return kept
}
