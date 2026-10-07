// Screen models, for comparing two ways of putting commit-per-event HandwiredOS
// on screen at display times:
// - Display frames: the main thread evaluates a display at each frame time, and
//   the screen keeps the last rendered frame until the next one, so it freezes
//   through a main-thread stall.
// - Keyframes: the main thread commits and predicts at event and settle times,
//   and starts the Web Animations that demo.ts starts. The screen is what those
//   emitted keyframe lists and the underlying styles show at each time, read
//   back from their strings (keyframes.ts's keyframeIntervalAt and readStyle).
//   During a stall JS doesn't run, so an event or settle commit inside a stall
//   is committed at its own timestamp once the stall ends. Only composited
//   animations (transform, opacity) keep playing during a stall, and only the
//   ones the last main-thread frame before the stall sent to the compositor.
//   Everything else, including width, height and z-index animations, which need
//   main-thread style and layout, shows the last main-thread frame until the
//   stall ends.
import {type DisplayRecord, createCommitter} from './commits.ts'
import type {EventTimeMachine} from './event-machine.ts'
import {
  type KeyframeInterval,
  type KeyframePlan,
  type PlannedTrack,
  type Track,
  type TrackPart,
  createTracks,
  keyframeIntervalAt,
  keyframeStyle,
  planKeyframes,
  readStyle,
  trackKeyframes,
  trackValues,
} from './keyframes.ts'
import {type Prediction, type Predictor, lastPlayedSample, sampleIndexAt} from './prediction.ts'
import {defaultClockConfig} from './spring-math.ts'
import {type TraceEvent, applyEvent, traceViewport} from './trace.ts'

export type Stall = {startMs: number, durationMs: number}

export type ScreenRow = {time: number, outputs: Float32Array}

export function insideStall(stall: Stall | undefined, time: number) {
  return stall !== undefined && time > stall.startMs && time < stall.startMs + stall.durationMs
}

const trackParts: readonly TrackPart[] = ['composited', 'layout']

// What demo.ts installs after one commit: the underlying style of every element
// (the last played sample), and a keyframe list per animated part.
type Installation = {
  prediction: Prediction
  plan: KeyframePlan
  tracks: {
    planned: PlannedTrack
    underlying: Keyframe
    keyframes: Record<TrackPart, Keyframe[] | null>
  }[]
}

function install(prediction: Prediction, plan: KeyframePlan): Installation {
  return {
    prediction,
    plan,
    tracks: plan.tracks.map(planned => ({
      planned,
      underlying: keyframeStyle(planned.track.kind, trackValues(prediction, planned.track, plan.lastSample)),
      keyframes: {
        composited: planned.animated.composited ? trackKeyframes(prediction, plan, planned.track, 'composited') : null,
        layout: planned.animated.layout ? trackKeyframes(prediction, plan, planned.track, 'layout') : null,
      },
    })),
  }
}

// The display roots an installation shows at `time`. Outputs no element draws
// (animationActive, content sizes) and the style writes made at commits (focus,
// dock) come from the prediction's sample at that time; so do photos and
// thumbnails that have no element. Returns whether some animation's
// interpolation blends two samples.
function screenAt(installation: Installation, time: number, outputs: Float32Array, values: number[], blended: number[]) {
  const {prediction, plan} = installation
  const sample = sampleIndexAt(prediction, time)
  outputs.set(prediction.samples.subarray(sample * prediction.rootCount, (sample + 1) * prediction.rootCount))
  const interval: KeyframeInterval | null = plan.lastSample > 0 ? keyframeIntervalAt(plan, time) : null
  let blends = false
  for (const entry of installation.tracks) {
    const {track} = entry.planned
    if (!entry.planned.visible) continue
    values.length = track.columns.length
    readStyle(track.kind, entry.underlying, values)
    for (const part of trackParts) {
      const keyframes = entry.keyframes[part]
      if (keyframes === null || interval === null) continue
      if (interval.distance === 0 || interval.distance === 1) {
        readStyle(track.kind, keyframes[interval.distance === 0 ? interval.start : interval.end]!, values)
        continue
      }
      blends = true
      readStyle(track.kind, keyframes[interval.start]!, values)
      blended.length = values.length
      for (let index = 0; index < values.length; index++) blended[index] = values[index]!
      readStyle(track.kind, keyframes[interval.end]!, blended)
      for (const value of track.parts[part]) values[value] = values[value]! + (blended[value]! - values[value]!) * interval.distance
    }
    for (let value = 0; value < track.columns.length; value++) outputs[track.columns[value]!] = values[value]!
  }
  return blends
}

export function simulateKeyframePresenter(
  machine: EventTimeMachine,
  predictor: Predictor,
  events: readonly TraceEvent[],
  times: readonly number[],
  options: {durationMs: number, stall?: Stall},
) {
  const tracks = createTracks(machine)
  const rootCount = machine.displayRoots.length
  const composited = new Uint8Array(rootCount)
  for (const track of tracks) for (const value of track.parts.composited) composited[track.columns[value]!] = 1
  let latest: Installation | null = null
  const stats = {
    predictions: 0,
    eventCommits: 0,
    // Event commits that arrive before the previous prediction's last played sample.
    invalidatedWhileAnimating: 0,
    predictionsWithAnimatedTracks: 0,
    animatedTracks: 0,
    maxAnimatedTracks: 0,
    // Web Animations started: up to one composited and one layout animation per element.
    animations: 0,
    // Keyframe objects in the started animations' keyframe lists.
    keyframes: 0,
    // Frames where some animation's interpolation distance is neither 0 nor 1,
    // so the screen would blend two samples.
    blendedFrames: 0,
  }
  const committer = createCommitter(machine, {
    settle: 'predicted',
    probe: () => latest!.prediction.settleStep,
    afterCommit(kind, time) {
      const previous = latest?.prediction ?? null
      const prediction = predictor.predict()
      stats.predictions++
      if (kind === 'event') {
        stats.eventCommits++
        const previousEnd = previous === null ? -Infinity : previous.originTime + defaultClockConfig.stepMs * lastPlayedSample(previous)
        if (previous !== null && previous.running && time < previousEnd) stats.invalidatedWhileAnimating++
      }
      const plan = planKeyframes(prediction, tracks)
      latest = install(prediction, plan)
      if (plan.animatedTrackCount > 0) {
        stats.predictionsWithAnimatedTracks++
        stats.animatedTracks += plan.animatedTrackCount
        stats.maxAnimatedTracks = Math.max(stats.maxAnimatedTracks, plan.animatedTrackCount)
        const animations = plan.compositedAnimationCount + plan.layoutAnimationCount
        stats.animations += animations
        stats.keyframes += animations * (plan.lastSample + 1)
      }
    },
  })
  machine.setViewport(traceViewport.width, traceViewport.height)
  committer.mount(0)
  const rows: ScreenRow[] = []
  // What the last main-thread frame rendered and sent to the compositor.
  let rendered: Installation | null = null
  let lastMainThreadRow: Float32Array | null = null
  let nextEvent = 0
  const values: number[] = []
  const blended: number[] = []
  for (const time of times) {
    if (time > options.durationMs) break
    const stalled = insideStall(options.stall, time)
    const jsTime = stalled ? options.stall!.startMs : time
    while (nextEvent < events.length && events[nextEvent]!.time <= jsTime) {
      const eventTime = events[nextEvent]!.time
      committer.commitEvents(eventTime, () => {
        while (nextEvent < events.length && events[nextEvent]!.time === eventTime) applyEvent(machine.base, events[nextEvent++]!)
      })
    }
    committer.settleUntil(jsTime)
    if (!stalled || rendered === null) rendered = latest!
    const outputs = new Float32Array(rootCount)
    if (screenAt(rendered, time, outputs, values, blended)) stats.blendedFrames++
    if (stalled && lastMainThreadRow !== null) {
      for (let offset = 0; offset < rootCount; offset++) {
        if (composited[offset] === 0) outputs[offset] = lastMainThreadRow[offset]!
      }
    }
    rows.push({time, outputs})
    if (!stalled) lastMainThreadRow = outputs
  }
  return {rows, stats, counts: committer.counts}
}

// The screen of a display-frame presenter at each time: the last frame at or before it.
export function holdLastFrame(records: readonly DisplayRecord[], times: readonly number[]): ScreenRow[] {
  const rows: ScreenRow[] = []
  let index = -1
  for (const time of times) {
    while (index + 1 < records.length && records[index + 1]!.time <= time) index++
    if (index >= 0) rows.push({time, outputs: records[index]!.outputs})
  }
  return rows
}

// From the first event after the last main-thread frame before a stall until
// the stall ends, the compositor plays animations installed before that event.
// JS may commit an event that arrives just before the stall begins, but the
// animations it starts only reach the compositor with the next main-thread
// frame, after the stall.
export function staleWindow(events: readonly TraceEvent[], frameTimes: readonly number[], stall: Stall | undefined): [number, number] | null {
  if (stall === undefined) return null
  let lastFrame = -Infinity
  for (const time of frameTimes) if (time <= stall.startMs) lastFrame = time
  const end = stall.startMs + stall.durationMs
  const first = events.find(event => event.time > lastFrame && event.time < end)
  return first === undefined ? null : [first.time, end]
}

export function stallWindow(stall: Stall | undefined): [number, number] | null {
  return stall === undefined ? null : [stall.startMs, stall.startMs + stall.durationMs]
}

// Display-root offsets compared as one group, and the offsets whose differences
// are reported in px.
export type ColumnGroup = {columns: readonly number[], pxColumns: readonly number[]}

export type ScreenGroups = {
  // translate (or left and top), scale and opacity: what composited animations carry.
  composited: ColumnGroup
  // width, height and window z-index: what layout animations carry.
  layout: ColumnGroup
  // Every display root, drawn or not.
  all: ColumnGroup
}

export function screenGroups(tracks: readonly Track[], rootCount: number): ScreenGroups {
  const composited: number[] = []
  const compositedPx: number[] = []
  const layout: number[] = []
  const layoutPx: number[] = []
  for (const track of tracks) {
    for (const value of track.parts.composited) {
      composited.push(track.columns[value]!)
      if (track.kind !== 'backdrop' && (value === 0 || value === 1)) compositedPx.push(track.columns[value]!)
    }
    for (const value of track.parts.layout) {
      layout.push(track.columns[value]!)
      if (value === 2 || value === 3) layoutPx.push(track.columns[value]!)
    }
  }
  return {
    composited: {columns: composited, pxColumns: compositedPx},
    layout: {columns: layout, pxColumns: layoutPx},
    all: {columns: Array.from({length: rootCount}, (_, offset) => offset), pxColumns: []},
  }
}

export type GroupComparison = {
  differingFrames: number
  differingFramesOutsideWindow: number
  differingFramesInsideWindow: number
  maxPx: number
  maxPxOutsideWindow: number
  maxPxInsideWindow: number
}

// Compares screens with reference displays at shared times, per column group.
// Values compare with ===, so -0 and 0 count as the same value: a CSS string
// can't carry the sign of zero.
export function compareScreens<Name extends string>(
  reference: readonly DisplayRecord[],
  rows: readonly ScreenRow[],
  groups: Record<Name, ColumnGroup>,
  window: [number, number] | null = null,
) {
  const byTime = new Map(reference.map(record => [record.time, record]))
  const names = Object.keys(groups) as Name[]
  const comparisons = Object.fromEntries(names.map(name => [name, {
    differingFrames: 0,
    differingFramesOutsideWindow: 0,
    differingFramesInsideWindow: 0,
    maxPx: 0,
    maxPxOutsideWindow: 0,
    maxPxInsideWindow: 0,
  }])) as Record<Name, GroupComparison>
  let frames = 0
  let framesInsideWindow = 0
  for (const row of rows) {
    const match = byTime.get(row.time)
    if (match === undefined) continue
    frames++
    const inside = window !== null && row.time >= window[0] && row.time < window[1]
    if (inside) framesInsideWindow++
    for (const name of names) {
      const group = groups[name]
      const comparison = comparisons[name]
      const differs = group.columns.some(offset => row.outputs[offset] !== match.outputs[offset])
      let px = 0
      for (const offset of group.pxColumns) px = Math.max(px, Math.abs(row.outputs[offset]! - match.outputs[offset]!))
      if (differs) comparison.differingFrames++
      comparison.maxPx = Math.max(comparison.maxPx, px)
      if (inside) {
        if (differs) comparison.differingFramesInsideWindow++
        comparison.maxPxInsideWindow = Math.max(comparison.maxPxInsideWindow, px)
      } else {
        if (differs) comparison.differingFramesOutsideWindow++
        comparison.maxPxOutsideWindow = Math.max(comparison.maxPxOutsideWindow, px)
      }
    }
  }
  return {frames, framesInsideWindow, groups: comparisons}
}
