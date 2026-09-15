// Checks every spring bank box inside the IndirectOS circuit against plain
// float64 doctrine springs (spring-math.ts). Each evaluation starts the reference
// from the circuit's own FP32 state, takes the destinations and snap bits the
// circuit computed, steps with the reference clock, and compares the written-back
// state. Needs a machine built with the bank and debugOutputs.
import type {Wire} from '../../../numeric-ui-core.ts'
import {type IndirectOSMachine, type MachineObserver, springField, windowSpringConstants} from './indirect-os.ts'
import {type ReferenceLane, type SpringConstants, advanceReferenceClock, defaultClockConfig, referenceBoxStep} from '../spring-bank/spring-math.ts'

export type BoxLane = {
  position: Wire
  velocity: Wire
  previousDestination: Wire
  // The circuit clamps some lanes before writeback, e.g. a window's scale to 0..1.
  clamp?: (position: number, values: Float32Array) => number
}
export type BoxDescription = {label: string, lanes: BoxLane[], constants: SpringConstants, snap: Wire, active: Wire}

export type BoxCheckResult = {
  evaluations: number
  evaluationsWithSteps: number
  boxesChecked: number
  maxPositionError: number
  maxVelocityError: number
  settleMismatches: number
  clockMismatches: number
  firstSettleMismatch: string | null
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value))

export function windowAndPhotoBoxes(machine: IndirectOSMachine): BoxDescription[] {
  const {cells, debug, photoInputs} = machine
  const bank = cells.bank
  if (bank === null || cells.photoDestinations === null) throw new Error('the box check needs the spring bank')
  const windows: BoxDescription[] = cells.windowSprings.map((springs, index) => ({
    label: `window ${index}`,
    lanes: springField.map(field => ({
      position: springs.position[field],
      velocity: springs.velocity[field],
      previousDestination: bank.windowDestinations[index]![field],
      ...(field === 'scale' ? {clamp: clampUnit} : {}),
    })),
    constants: windowSpringConstants,
    snap: debug.windows.snap[index]!,
    active: debug.windows.active[index]!,
  }))
  const destinations = cells.photoDestinations
  const thumbnails: BoxDescription[] = cells.photoState.thumbnails.map((thumbnail, item) => ({
    label: `thumbnail ${item}`,
    lanes: [
      {position: thumbnail.centerX, velocity: thumbnail.centerXVelocity, previousDestination: destinations[item]!.centerX, clamp: (value, values) => Math.min(Math.max(0, value), values[photoInputs.viewport.x]!)},
      {position: thumbnail.scale, velocity: thumbnail.scaleVelocity, previousDestination: destinations[item]!.scale, clamp: clampUnit},
    ],
    constants: windowSpringConstants,
    snap: debug.photos.snap,
    active: debug.photos.active[item]!,
  }))
  return [...windows, ...thumbnails]
}

// One box of two lanes per Notes word, in the words' own spring group.
export function wordBoxes(machine: IndirectOSMachine): BoxDescription[] {
  const {cells, debug, options} = machine
  if (cells.notes === null || options.notes === null || debug.notes === undefined) throw new Error('the word check needs the Notes flow')
  const notesCells = cells.notes
  const notesDebug = debug.notes
  return notesCells.words.map((word, index) => ({
    label: `word ${index}`,
    lanes: [
      {position: word.position.x, velocity: word.velocity.x, previousDestination: notesCells.destinations[index]!.x},
      {position: word.position.y, velocity: word.velocity.y, previousDestination: notesCells.destinations[index]!.y},
    ],
    constants: options.notes!.springConstants,
    snap: notesDebug.snap[index]!,
    active: notesDebug.active[index]!,
  }))
}

export function createBoxCheck(machine: IndirectOSMachine, boxes: readonly BoxDescription[]) {
  const bank = machine.cells.bank
  if (bank === null) throw new Error('the box check needs the spring bank')
  const {settleDistance, settleSpeed} = machine.cells.springConstants
  let before = new Float32Array(machine.source.length)
  const result: BoxCheckResult = {
    evaluations: 0, evaluationsWithSteps: 0, boxesChecked: 0, maxPositionError: 0, maxVelocityError: 0, settleMismatches: 0, clockMismatches: 0, firstSettleMismatch: null,
  }
  const observer: MachineObserver = {
    beforeEvaluate(source) {
      before = Float32Array.from(source)
    },
    afterEvaluate(values, source) {
      const {steps, leftoverMs} = advanceReferenceClock({leftoverMs: before[bank.leftoverMs]!, running: before[bank.running]! > 0}, before[bank.frameDeltaMs]!, defaultClockConfig)
      if (source[bank.leftoverMs] !== leftoverMs) result.clockMismatches++
      if (steps > 0) result.evaluationsWithSteps++
      for (const box of boxes) {
        const lanes: ReferenceLane[] = box.lanes.map(lane => ({
          position: before[lane.position]!,
          velocity: before[lane.velocity]!,
          previousDestination: before[lane.previousDestination]!,
          constants: box.constants,
        }))
        // The circuit writes this evaluation's destinations back as the next previous destinations.
        const destinations = box.lanes.map(lane => source[lane.previousDestination]!)
        const reference = referenceBoxStep(lanes, destinations, steps, {
          snap: values[box.snap]! > 0,
          settleDistance: before[settleDistance]!,
          settleSpeed: before[settleSpeed]!,
          stepMs: defaultClockConfig.stepMs,
          retarget: 'deferred',
        })
        box.lanes.forEach((lane, index) => {
          const expected = lane.clamp === undefined ? lanes[index]!.position : lane.clamp(lanes[index]!.position, values)
          result.maxPositionError = Math.max(result.maxPositionError, Math.abs(source[lane.position]! - expected))
          result.maxVelocityError = Math.max(result.maxVelocityError, Math.abs(source[lane.velocity]! - lanes[index]!.velocity))
        })
        if ((values[box.active]! > 0) !== reference.active) {
          result.settleMismatches++
          result.firstSettleMismatch ??= `evaluation ${result.evaluations}, ${box.label}: circuit ${values[box.active]}, reference ${reference.active}`
        }
        result.boxesChecked++
      }
      result.evaluations++
    },
  }
  machine.observe(observer)
  return result
}
