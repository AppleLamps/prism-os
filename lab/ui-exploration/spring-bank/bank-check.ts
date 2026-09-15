// Checks a standalone spring bank against float64 doctrine springs along random
// frame times with stalls and retargets. Shared by bank.test.ts and report.ts.
import {type BankMachine, bankField, laneField} from './bank-machine.ts'
import {
  type ReferenceLane,
  type RetargetTiming,
  type SpringConstants,
  advanceReferenceClock,
  defaultClockConfig,
  referenceBoxStep,
} from './spring-math.ts'

export const checkSpec = {
  groups: [{stiffness: 650, damping: 45}, {stiffness: 290, damping: 24}],
  boxes: [{lanes: [{group: 0}, {group: 0}, {group: 1}]}, {lanes: [{group: 1}, {group: 1}]}],
}

export function seededRandom(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export const onGrid = (value: number) => Math.round(value * 64) / 64

function readLanes(machine: BankMachine, table: Float32Array, groupConstants: readonly SpringConstants[]) {
  const lanes: ReferenceLane[] = []
  let lane = 0
  for (const box of checkSpec.boxes) {
    for (const laneSpec of box.lanes) {
      lanes.push({
        position: table[machine.laneCell(lane, laneField.position)]!,
        velocity: table[machine.laneCell(lane, laneField.velocity)]!,
        previousDestination: table[machine.laneCell(lane, laneField.previousDestination)]!,
        constants: groupConstants[laneSpec.group]!,
      })
      lane++
    }
  }
  return lanes
}

// - restart-every-frame: each frame starts the float64 loops from the circuit's
//   own FP32 state, so the comparison measures one frame's error.
// - free-running: float64 carries its own state from the first frame, so small
//   differences can accumulate, and a box can cross the settle thresholds in a
//   different frame than the circuit.
export type ReferenceMode = 'restart-every-frame' | 'free-running'

export function compareBankWithReference(
  machine: BankMachine,
  retarget: RetargetTiming,
  groupConstants: readonly SpringConstants[],
  frames: number,
  mode: ReferenceMode = 'restart-every-frame',
) {
  const random = seededRandom(11)
  const clock = {leftoverMs: 0, running: false}
  let lane = 0
  for (const box of checkSpec.boxes) {
    for (const _ of box.lanes) {
      const start = Math.round((random() - 0.5) * 2000)
      for (const field of [laneField.position, laneField.destination, laneField.previousDestination]) {
        machine.source[machine.laneCell(lane, field)] = start
      }
      lane++
    }
  }
  const freeRunningLanes = readLanes(machine, machine.source, groupConstants)
  const destinations = freeRunningLanes.map(freeRunningLane => freeRunningLane.position)
  let time = 1000
  let previousQuantized = onGrid(time)
  machine.step(time)
  const result = {
    frames,
    maxPositionError: 0,
    // Only frames where both the circuit and float64 still animate the box.
    maxPositionErrorWhileBothActive: 0,
    // Frames where some box's settle bit differs from float64.
    settleMismatchFrames: 0,
    // Box-frames where float64 settled.
    settledBoxFrames: 0,
    // Lanes of settled boxes whose position isn't exactly the destination or
    // whose velocity isn't 0.
    inexactSettledLanes: 0,
  }
  for (let frame = 0; frame < frames; frame++) {
    const r = random()
    time += r < 0.02 ? 2000 : r < 0.05 ? 500 : 2 + random() * 38
    if (frame % 29 === 0) {
      for (let index = 0; index < machine.laneCount; index++) {
        if (random() < 0.5) {
          const destination = Math.fround((random() - 0.5) * 3000)
          machine.setDestination(index, destination)
          destinations[index] = destination
        }
      }
    }
    const before = Float32Array.from(machine.source)
    const values = machine.step(time)
    const quantized = onGrid(time)
    const {steps, leftoverMs} = advanceReferenceClock(clock, quantized - previousQuantized, defaultClockConfig)
    previousQuantized = quantized
    const lanes = mode === 'free-running' ? freeRunningLanes : readLanes(machine, before, groupConstants)
    let start = 0
    let anyActive = false
    let settleMismatch = false
    checkSpec.boxes.forEach((box, boxIndex) => {
      const boxLanes = lanes.slice(start, start + box.lanes.length)
      const boxDestinations = destinations.slice(start, start + box.lanes.length)
      const reference = referenceBoxStep(boxLanes, boxDestinations, steps, {
        snap: false,
        settleDistance: before[bankField.settleDistance]!,
        settleSpeed: before[bankField.settleSpeed]!,
        stepMs: defaultClockConfig.stepMs,
        retarget,
      })
      anyActive ||= reference.active
      if (!reference.active) result.settledBoxFrames++
      const circuitActive = values[machine.output.boxActiveStart + boxIndex]! > 0
      if (circuitActive !== reference.active) settleMismatch = true
      boxLanes.forEach((referenceLane, index) => {
        const position = values[machine.output.positionStart + start + index]!
        const error = Math.abs(position - referenceLane.position)
        result.maxPositionError = Math.max(result.maxPositionError, error)
        if (circuitActive && reference.active) {
          result.maxPositionErrorWhileBothActive = Math.max(result.maxPositionErrorWhileBothActive, error)
        }
        // A settled velocity may be -0 (a negative velocity times a zero gate).
        if (!circuitActive && (position !== boxDestinations[index]! || values[machine.output.velocityStart + start + index] !== 0)) {
          result.inexactSettledLanes++
        }
      })
      start += box.lanes.length
    })
    if (settleMismatch) result.settleMismatchFrames++
    clock.running = anyActive
    clock.leftoverMs = leftoverMs
  }
  return result
}
