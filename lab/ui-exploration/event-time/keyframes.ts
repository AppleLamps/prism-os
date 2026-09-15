// Web Animations keyframes from a prediction (vibescript docs/Animation.md's
// predictive keyframes, for all of IndirectOS). Sample i is on screen for 4 ms
// from originTime + 4 i (less half a clock grid step, see planKeyframes), so the
// keyframes step instead of interpolating, the animation's start time is the
// prediction's origin, and the last keyframe is the settle sample, held by
// fill: 'forwards'.
//
// Each element gets up to two animations. Chrome runs an animation on the
// compositor only when every property in it can be composited, which transform
// and opacity can and width, height and z-index can't. Keeping them apart lets
// motion and fades keep playing while the main thread is blocked; size and
// stacking changes wait for the main thread.
import {invariant} from '../../../numeric-ui-core.ts'
import {type EventTimeMachine, displayLayout} from './event-machine.ts'
import {controlField, itemCount as photoCount, photoField} from './photo-gallery.ts'
import {type Prediction, lastPlayedSample, sampleIndexAt} from './prediction.ts'
import {defaultClockConfig} from './spring-math.ts'
import {windowCount, windowOutputField} from './window-manager.ts'

export type TrackKind = 'window' | 'photo' | 'thumbnail' | 'previousControl' | 'nextControl' | 'backdrop'
export type TrackPart = 'composited' | 'layout'

// One element's animated properties. `columns` are offsets into displayRoots in
// keyframeStyle's value order; `parts` name which of those values feed the
// composited animation and which feed the layout animation.
export type Track = {
  kind: TrackKind
  index: number
  columns: readonly number[]
  parts: Record<TrackPart, readonly number[]>
}

export function createTracks(machine: Pick<EventTimeMachine, 'output'>): Track[] {
  const layout = displayLayout(machine)
  const tracks: Track[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const start = layout.windows + windowIndex * windowOutputField.size
    tracks.push({
      kind: 'window',
      index: windowIndex,
      // x, y, width, height, scale, opacity, stack
      columns: [
        windowOutputField.translateX,
        windowOutputField.translateY,
        windowOutputField.width,
        windowOutputField.height,
        windowOutputField.scale,
        windowOutputField.opacity,
        windowOutputField.stack,
      ].map(field => start + field),
      parts: {composited: [0, 1, 4, 5], layout: [2, 3, 6]},
    })
  }
  // left, top, width, height, opacity
  const geometryParts = {composited: [0, 1, 4], layout: [2, 3]}
  const geometry = [photoField.left, photoField.top, photoField.width, photoField.height, photoField.opacity]
  for (const [kind, start] of [['photo', layout.photos], ['thumbnail', layout.thumbnails]] as const) {
    for (let item = 0; item < photoCount; item++) {
      tracks.push({kind, index: item, columns: geometry.map(field => start + item * photoField.size + field), parts: geometryParts})
    }
  }
  const controlGeometry = [controlField.left, controlField.top, controlField.width, controlField.height, controlField.opacity]
  tracks.push({kind: 'previousControl', index: 0, columns: controlGeometry.map(field => layout.previousControl + field), parts: geometryParts})
  tracks.push({kind: 'nextControl', index: 0, columns: controlGeometry.map(field => layout.nextControl + field), parts: geometryParts})
  tracks.push({kind: 'backdrop', index: 0, columns: [layout.backdropOpacity], parts: {composited: [0], layout: []}})
  return tracks
}

export type PlannedTrack = {
  track: Track
  // Whether some played sample differs in any bit from sample 0, per part. When
  // neither part changes, the page writes the style once and starts nothing.
  animated: Record<TrackPart, boolean>
  // Photos and thumbnails exist in the DOM only while some played sample has
  // positive width, height and opacity, as in photo-gallery.ts's renderer.
  visible: boolean
}

export type KeyframePlan = {
  startTime: number
  // Index of the last keyframe: the settle sample, or 300 at the cap, or 0.
  lastSample: number
  durationMs: number
  tracks: PlannedTrack[]
  // Elements with at least one animated part.
  animatedTrackCount: number
  compositedAnimationCount: number
  layoutAnimationCount: number
}

export function planKeyframes(prediction: Prediction, tracks: readonly Track[]): KeyframePlan {
  const lastSample = prediction.running ? lastPlayedSample(prediction) : 0
  const {rootCount, samples} = prediction
  const changes = (track: Track, part: TrackPart) => {
    for (let sample = 1; sample <= lastSample; sample++) {
      for (const value of track.parts[part]) {
        const column = track.columns[value]!
        if (!Object.is(samples[sample * rootCount + column], samples[column])) return true
      }
    }
    return false
  }
  const planned = tracks.map(track => {
    let visible = track.kind !== 'photo' && track.kind !== 'thumbnail'
    for (let sample = 0; sample <= lastSample && !visible; sample++) {
      const values = trackValues(prediction, track, sample)
      visible = values[2]! > 0 && values[3]! > 0 && values[4]! > 0
    }
    return {track, animated: {composited: changes(track, 'composited'), layout: changes(track, 'layout')}, visible}
  })
  return {
    // Half a clock grid step before the origin. Displays round frame times to the
    // nearest 1/64 ms, so a display shows sample i from originTime + 4 i - 1/128 ms.
    // Web Animations don't round, so without this shift a frame up to 1/128 ms
    // before a sample boundary showed the previous sample (5 of 2,641 frames at
    // 240 fps in the live resize trace, up to 10.8 px).
    startTime: prediction.originTime - 0.5 / defaultClockConfig.timeGrid,
    lastSample,
    durationMs: defaultClockConfig.stepMs * lastSample,
    tracks: planned,
    animatedTrackCount: planned.filter(entry => entry.animated.composited || entry.animated.layout).length,
    compositedAnimationCount: planned.filter(entry => entry.animated.composited).length,
    layoutAnimationCount: planned.filter(entry => entry.animated.layout).length,
  }
}

export function trackValues(prediction: Prediction, track: Track, sample: number) {
  return track.columns.map(column => prediction.samples[sample * prediction.rootCount + column]!)
}

// The values the keyframes show at `time`.
export function playbackValues(prediction: Prediction, track: Track, time: number) {
  return trackValues(prediction, track, sampleIndexAt(prediction, time))
}

export function compositedStyle(kind: TrackKind, values: readonly number[]): Keyframe {
  if (kind === 'backdrop') return {opacity: `${values[0]}`}
  if (kind === 'window') {
    const [x, y, , , scale, opacity] = values
    return {transform: `translate3d(${x}px,${y}px,0) scale(${scale})`, opacity: `${opacity}`}
  }
  const [left, top, , , opacity] = values
  return {transform: `translate3d(${left}px,${top}px,0)`, opacity: `${opacity}`}
}

export function layoutStyle(kind: TrackKind, values: readonly number[]): Keyframe {
  if (kind === 'backdrop') return {}
  const width = `${values[2]}px`
  const height = `${values[3]}px`
  return kind === 'window' ? {width, height, zIndex: `${10 + values[6]!}`} : {width, height}
}

export function keyframeStyle(kind: TrackKind, values: readonly number[]): Keyframe {
  return {...compositedStyle(kind, values), ...layoutStyle(kind, values)}
}

export function trackKeyframes(prediction: Prediction, plan: KeyframePlan, track: Track, part: TrackPart): Keyframe[] {
  const style = part === 'composited' ? compositedStyle : layoutStyle
  const keyframes: Keyframe[] = []
  for (let sample = 0; sample <= plan.lastSample; sample++) keyframes.push(style(track.kind, trackValues(prediction, track, sample)))
  return keyframes
}

export function animationTiming(plan: KeyframePlan): KeyframeAnimationOptions {
  return {duration: plan.durationMs, easing: `steps(${plan.lastSample}, end)`, fill: 'forwards'}
}

export type KeyframeInterval = {start: number, end: number, distance: number}

// Which keyframes an animation started by demo.ts shows at timeline time `time`,
// following the Web Animations Level 1 timing model and CSS Easing Level 1 in
// doubles: `startTime` at plan.startTime, one iteration, no delay,
// `fill: 'forwards'`, effect easing steps(n, end) with n = plan.lastSample, and
// n + 1 keyframes without explicit offsets, whose computed offsets are k / n.
// Returns null before the start time, where the animation has no effect and the
// underlying style shows. Otherwise returns the interval's keyframe indices and
// the interpolation distance: 0 shows `start`, 1 shows `end`, and anything in
// between blends two samples. This models the specification, not a browser:
// e.g. Chrome keeps animation times in whole microseconds, which isn't modeled.
export function keyframeIntervalAt(plan: KeyframePlan, time: number): KeyframeInterval | null {
  invariant(plan.lastSample > 0, 'a plan without samples to play starts no animations')
  // Read the timing demo.ts passes to element.animate().
  const timing = animationTiming(plan)
  const easing = /^steps\((\d+), end\)$/.exec(String(timing.easing))
  invariant(easing !== null && timing.fill === 'forwards' && typeof timing.duration === 'number', 'unexpected animation timing')
  const steps = Number(easing[1])
  const duration = timing.duration
  const localTime = time - plan.startTime
  // Before phase: fill 'forwards' doesn't apply there.
  if (localTime < 0) return null
  // Active phase, or the after phase, where fill 'forwards' holds the active duration.
  const activeTime = Math.min(localTime, duration)
  const overallProgress = activeTime / duration
  let iterationProgress = overallProgress % 1
  if (iterationProgress === 0 && activeTime === duration) iterationProgress = 1
  // steps(n, end). The before flag only matters in the before phase.
  let currentStep = Math.floor(iterationProgress * steps)
  if (currentStep < 0) currentStep = 0
  if (currentStep > steps) currentStep = steps
  const easedProgress = currentStep / steps
  const offset = (index: number) => index / steps
  // The last keyframe whose offset is at most the progress and below 1. Only
  // one keyframe has offset 1, so progress 1 uses the last interval with distance 1.
  let start = 0
  for (let index = 1; index < steps; index++) {
    if (offset(index) <= easedProgress) start = index
  }
  const end = start + 1
  return {start, end, distance: (easedProgress - offset(start)) / (offset(end) - offset(start))}
}

// Reads the numbers back out of a style from compositedStyle or layoutStyle,
// into `values` in the track's value order (see createTracks). Values the style
// doesn't carry are left as they were.
export function readStyle(kind: TrackKind, style: Keyframe, values: number[]) {
  const opacity = style['opacity']
  if (opacity !== undefined && opacity !== null) values[kind === 'window' ? 5 : kind === 'backdrop' ? 0 : 4] = Number(opacity)
  const transform = style['transform']
  if (transform !== undefined && transform !== null) {
    const match = /^translate3d\((.+)px,(.+)px,0\)(?: scale\((.+)\))?$/.exec(String(transform))
    invariant(match !== null, 'unexpected transform string')
    values[0] = Number(match[1])
    values[1] = Number(match[2])
    if (kind === 'window') values[4] = Number(match[3])
  }
  const width = style['width']
  if (width !== undefined && width !== null) values[2] = Number.parseFloat(String(width))
  const height = style['height']
  if (height !== undefined && height !== null) values[3] = Number.parseFloat(String(height))
  const zIndex = style['zIndex']
  if (zIndex !== undefined && zIndex !== null) values[6] = Number(zIndex) - 10
}
