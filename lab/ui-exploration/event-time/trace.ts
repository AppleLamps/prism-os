// A timestamped HandwiredOS input trace, replayed at any frame rate, plus a
// float64 doctrine reference for the window springs inside the circuit.
import {itemCount as photoCount, photoField} from './photo-gallery.ts'
import {
  type WindowManagerOptions,
  dragSourceField,
  photoFocusSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowDestinationSourceField,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from './window-manager.ts'
import {
  type ReferenceClock,
  type ReferenceLane,
  advanceReferenceClock,
  createFrameDeltaTracker,
  defaultClockConfig,
  referenceBoxStep,
} from './spring-math.ts'

export type TraceEvent =
  | {time: number, kind: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'photoClick', x: number, y: number}
  | {time: number, kind: 'photoNext' | 'photoPrevious' | 'photoClose'}

// Both the original window-manager.ts machine and this folder's copy fit.
export type ReplayMachine = {
  source: Float32Array
  output: {
    windows: readonly number[]
    animationActive: number
    photos: {photos: readonly number[], thumbnails: readonly number[]}
  }
  step(viewportWidth: number, viewportHeight: number, frameTime: number): Float32Array
  pointerDown(x: number, y: number): void
  pointerMove(x: number, y: number): void
  pointerUp(x: number, y: number): void
  photoClick(x: number, y: number): void
  photoNext(): void
  photoPrevious(): void
  photoClose(): void
}

export const traceViewport = {width: 1280, height: 800} as const

export function frameIndexTime(index: number, fps: number) {
  // Integer numerator over the rate, so 30, 60 and 120 fps produce identical
  // doubles at their shared timestamps.
  return (index * 1000) / fps
}

const at = (thirtyFpsFrame: number) => frameIndexTime(thirtyFpsFrame, 30)

// Presses sit on 30 fps frame times. 30, 60 and 120 fps render every one of
// those times, so they process each press in a frame at the press's own time.
// 10 fps renders only every third one: the drag release (1833.3 ms), the resize
// grip press and release (5333.3 and 5666.7 ms), and the lightbox close
// (6666.7 ms) fall between its frames. Pointer moves during the drag and the
// resize fall between frames at every rate. `offsetPresses` moves presses off
// the frame grid. Coordinates come from the initial window layout at 1280x800
// (window-manager.ts createWindowManagerMachine).
export function createHandwiredOSTrace(options: {liveResize?: boolean} = {}) {
  const events: TraceEvent[] = []
  const click = (time: number, x: number, y: number) => {
    events.push({time, kind: 'pointerDown', x, y}, {time, kind: 'pointerUp', x, y})
  }
  const segments: {label: string, time: number}[] = []
  const segment = (label: string, time: number) => segments.push({label, time})

  // Files minimize button: left 54 + width 520 - 19 - 56, title center y 54 + 22.
  segment('minimize Files to the dock', at(6))
  click(at(6), 499, 76)
  // Dock item 0 center, while the minimize animation is still running.
  segment('restore Files from the dock mid-animation', at(12))
  click(at(12), 547, 762)
  // Drag the Notes title bar by (-100, +80), with moves every 5 ms between frames.
  segment('drag Notes', at(45))
  events.push({time: at(45), kind: 'pointerDown', x: 700, y: 120})
  for (let move = 1; move <= 60; move++) {
    events.push({time: at(45) + move * 5, kind: 'pointerMove', x: 700 - move * (100 / 60), y: 120 + move * (80 / 60)})
  }
  events.push({time: at(55), kind: 'pointerUp', x: 600, y: 200})
  // Photos maximize button: left 650 + width 560 - 19 - 28, y 190 + 22.
  segment('maximize Photos', at(75))
  click(at(75), 1163, 212)
  // The maximized title bar's maximize button, while still animating.
  segment('restore Photos size mid-animation', at(81))
  click(at(81), 1221, 70)
  // Photos grid cell 0, then next twice (the second one mid-animation), close.
  segment('open photo 0 in the lightbox', at(120))
  events.push({time: at(120), kind: 'photoClick', x: 60, y: 60})
  segment('next photo', at(150))
  events.push({time: at(150), kind: 'photoNext'})
  segment('next photo mid-animation', at(153))
  events.push({time: at(153), kind: 'photoNext'})
  if (options.liveResize === true) {
    // Drag the Photos resize grip (the bottom-right 24 px square) by (-100, -60)
    // with the lightbox open, so thumbnail destinations move every frame.
    segment('resize Photos by hand with the lightbox open', at(160))
    events.push({time: at(160), kind: 'pointerDown', x: 1198, y: 608})
    for (let move = 1; move <= 60; move++) {
      events.push({time: at(160) + move * 5, kind: 'pointerMove', x: 1198 - move * (100 / 60), y: 608 - move})
    }
    events.push({time: at(170), kind: 'pointerUp', x: 1098, y: 548})
  }
  segment('close the lightbox', at(200))
  events.push({time: at(200), kind: 'photoClose'})
  // Files close button: 54 + 520 - 19.
  segment('close Files', at(210))
  click(at(210), 555, 76)
  events.sort((left, right) => left.time - right.time)
  return {events, segments, durationMs: at(270)}
}

// Moves each press by its own offset, together with the pointer moves and the
// release that follow it, keeping the event order. E.g. `offsetPresses(events,
// () => 1)` moves every event 1 ms after its 30 fps frame time, so no tested
// frame rate renders a frame at a press's time.
export function offsetPresses(events: readonly TraceEvent[], nextOffsetMs: () => number) {
  const moved: TraceEvent[] = []
  let offsetMs = 0
  for (const event of events) {
    if (event.kind !== 'pointerMove' && event.kind !== 'pointerUp') offsetMs = nextOffsetMs()
    moved.push({...event, time: event.time + offsetMs})
  }
  // The sort is stable, so a click's pointerDown stays before its pointerUp.
  return moved.sort((left, right) => left.time - right.time)
}

// Repeatable offsets in 0..maxMs on the 1/64 ms time grid.
export function randomPressOffsets(seed: number, maxMs: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return Math.floor((state / 2 ** 32) * maxMs * 64) / 64
  }
}

export type FrameSchedule = {
  fps: number
  durationMs: number
  // No frames are rendered strictly inside this interval.
  stall?: {startMs: number, durationMs: number}
}

export function scheduleFrameTimes(schedule: FrameSchedule) {
  const times: number[] = []
  for (let index = 0; ; index++) {
    const time = frameIndexTime(index, schedule.fps)
    if (time > schedule.durationMs) break
    const stall = schedule.stall
    if (stall !== undefined && time > stall.startMs && time < stall.startMs + stall.durationMs) continue
    times.push(time)
  }
  return times
}

export function applyEvent(machine: ReplayMachine, event: TraceEvent) {
  switch (event.kind) {
    case 'pointerDown': machine.pointerDown(event.x, event.y); break
    case 'pointerMove': machine.pointerMove(event.x, event.y); break
    case 'pointerUp': machine.pointerUp(event.x, event.y); break
    case 'photoClick': machine.photoClick(event.x, event.y); break
    case 'photoNext': machine.photoNext(); break
    case 'photoPrevious': machine.photoPrevious(); break
    case 'photoClose': machine.photoClose(); break
  }
}

export type FrameRecord = {
  time: number
  // Projected window geometry, then Photos photos and thumbnails.
  continuous: Float32Array
  // Focus, stacking, open, minimized, maximized, drag and resize owners, photo focus.
  discrete: Float32Array
  present: Float32Array
  animationActive: number
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

export function recordFrame(machine: ReplayMachine, values: Float32Array, time: number): FrameRecord {
  const continuous: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of windowContinuousFields) {
      continuous.push(values[machine.output.windows[windowIndex * windowOutputField.size + field]!]!)
    }
  }
  for (const wires of [machine.output.photos.photos, machine.output.photos.thumbnails]) {
    for (let item = 0; item < photoCount; item++) {
      for (const field of photoContinuousFields) continuous.push(values[wires[item * photoField.size + field]!]!)
    }
  }
  const discrete: number[] = []
  const present: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    discrete.push(values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!]!)
    for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized]) {
      discrete.push(machine.source[windowSourceField(windowIndex, field)]!)
    }
    discrete.push(machine.source[dragSourceField(windowIndex)]!, machine.source[resizeSourceField(windowIndex)]!)
    for (let rank = 0; rank < windowCount; rank++) discrete.push(machine.source[stackSourceField(rank, windowIndex)]!)
    present.push(machine.source[windowSourceField(windowIndex, windowStateField.present)]!)
  }
  for (let item = 0; item < photoCount; item++) discrete.push(machine.source[photoFocusSourceField(item)]!)
  return {
    time,
    continuous: Float32Array.from(continuous),
    discrete: Float32Array.from(discrete),
    present: Float32Array.from(present),
    animationActive: values[machine.output.animationActive]!,
  }
}

export type ReplayOptions = {
  // Also evaluate the circuit at each event's own timestamp, without recording
  // a frame. With deferred retargeting, a new destination then applies from the
  // event's time instead of from the next rendered frame's time, and an
  // animation that starts from rest starts at the event's time. Events that
  // share a timestamp share one evaluation; an event at a rendered frame's
  // timestamp gets no extra evaluation.
  evaluateAtEventTimes?: boolean
  // Called around every evaluation, including evaluations at event times.
  beforeStep?: (time: number) => void
  afterStep?: (values: Float32Array, time: number) => void
}

export function replayTrace(
  machine: ReplayMachine,
  events: readonly TraceEvent[],
  times: readonly number[],
  options: ReplayOptions = {},
) {
  const records: FrameRecord[] = []
  const evaluate = (time: number) => {
    options.beforeStep?.(time)
    const values = machine.step(traceViewport.width, traceViewport.height, time)
    options.afterStep?.(values, time)
    return values
  }
  let nextEvent = 0
  for (const time of times) {
    while (nextEvent < events.length && events[nextEvent]!.time <= time) {
      const eventTime = events[nextEvent]!.time
      while (nextEvent < events.length && events[nextEvent]!.time === eventTime) applyEvent(machine, events[nextEvent++]!)
      if (options.evaluateAtEventTimes === true && eventTime < time) evaluate(eventTime)
    }
    records.push(recordFrame(machine, evaluate(time), time))
  }
  return records
}

export type SharedTimeComparison = {
  sharedFrames: number
  maxContinuousDifference: number
  worstTime: number
  discreteMismatchFrames: number
  animationActiveMismatchFrames: number
}

// Compare two replays at the timestamps both rendered.
export function compareAtSharedTimes(reference: readonly FrameRecord[], other: readonly FrameRecord[]): SharedTimeComparison {
  const byTime = new Map(other.map(record => [record.time, record]))
  let sharedFrames = 0
  let maxContinuousDifference = 0
  let worstTime = -1
  let discreteMismatchFrames = 0
  let animationActiveMismatchFrames = 0
  for (const record of reference) {
    const match = byTime.get(record.time)
    if (match === undefined) continue
    sharedFrames++
    for (let index = 0; index < record.continuous.length; index++) {
      const difference = Math.abs(record.continuous[index]! - match.continuous[index]!)
      if (difference > maxContinuousDifference) {
        maxContinuousDifference = difference
        worstTime = record.time
      }
    }
    if (record.discrete.some((value, index) => value !== match.discrete[index])) discreteMismatchFrames++
    if ((record.animationActive > 0) !== (match.animationActive > 0)) animationActiveMismatchFrames++
  }
  return {sharedFrames, maxContinuousDifference, worstTime, discreteMismatchFrames, animationActiveMismatchFrames}
}

// Times where an animation finished: animationActive went from positive to 0.
export function settleTimes(records: readonly FrameRecord[]) {
  const times: number[] = []
  for (let index = 1; index < records.length; index++) {
    if (records[index - 1]!.animationActive > 0 && records[index]!.animationActive === 0) times.push(records[index]!.time)
  }
  return times
}

type BankReplayMachine = ReplayMachine & {
  options: WindowManagerOptions
  output: ReplayMachine['output'] & {windowSnap: readonly number[]}
}

const laneCount = 5
const springFieldCount = 10

// Checks the window springs inside this folder's bank HandwiredOS against plain
// float64 doctrine loops. Each frame starts the reference from the circuit's own
// FP32 state, takes the destinations and snap bits the circuit computed, steps
// with the reference clock, and compares the written-back state. Needs a
// machine built with debugOutputs.
export function createWindowSpringCheck(machine: BankReplayMachine) {
  const clock: ReferenceClock = {leftoverMs: 0, running: false}
  const frameDelta = createFrameDeltaTracker(defaultClockConfig)
  let before = new Float32Array(machine.source.length)
  const result = {frames: 0, maxPositionError: 0, maxVelocityError: 0, settleMismatches: 0, stepFrames: 0}
  return {
    result,
    beforeStep() {
      before = Float32Array.from(machine.source)
    },
    afterStep(values: Float32Array, time: number) {
      const {steps, leftoverMs} = advanceReferenceClock(clock, frameDelta(time), defaultClockConfig)
      if (steps > 0) result.stepFrames++
      for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
        const springStart = sourceField.springStart + windowIndex * springFieldCount
        const lanes: ReferenceLane[] = Array.from({length: laneCount}, (_, lane) => ({
          position: before[springStart + lane]!,
          velocity: before[springStart + 5 + lane]!,
          previousDestination: before[windowDestinationSourceField(windowIndex, lane)]!,
          constants: {
            stiffness: before[sourceField.springStiffness]!,
            damping: before[sourceField.springDamping]!,
          },
        }))
        // The circuit writes this frame's destinations back as next frame's
        // previous destinations.
        const destinations = lanes.map((_, lane) => machine.source[windowDestinationSourceField(windowIndex, lane)]!)
        const snap = values[machine.output.windowSnap[windowIndex]!]! > 0
        const reference = referenceBoxStep(lanes, destinations, steps, {
          snap,
          settleDistance: before[sourceField.springSettleDistance]!,
          settleSpeed: before[sourceField.springSettleSpeed]!,
          stepMs: defaultClockConfig.stepMs,
          retarget: machine.options.retarget,
        })
        // The scale lane is clamped to 0..1 before writeback, as in the original.
        lanes[4]!.position = Math.min(1, Math.max(0, lanes[4]!.position))
        for (let lane = 0; lane < laneCount; lane++) {
          result.maxPositionError = Math.max(result.maxPositionError, Math.abs(machine.source[springStart + lane]! - lanes[lane]!.position))
          result.maxVelocityError = Math.max(result.maxVelocityError, Math.abs(machine.source[springStart + 5 + lane]! - lanes[lane]!.velocity))
        }
        // The window's stack output adds 40 while its springs are active.
        const circuitActive = values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.stack]!]! >= 40
        if (circuitActive !== reference.active) result.settleMismatches++
      }
      clock.running = values[machine.output.animationActive]! > 0
      clock.leftoverMs = leftoverMs
      result.frames++
    },
  }
}
