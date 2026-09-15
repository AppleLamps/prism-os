// Float64 doctrine springs as an independent reference for commits and displays.
//
// Commits: trace.ts's createWindowSpringCheck, wrapped around machine.commit.
// Displays: from the committed table, step every window lane with plain float64
// Euler loops for the display's step count, toward the destinations and snap
// bits the display computed, and compare with the display's stepped spring
// state (its next-source outputs, which a display otherwise discards).
import type {EventTimeMachine, Evaluation} from './event-machine.ts'
import {type ReferenceLane, referenceBoxStep} from '../spring-bank/spring-math.ts'
import {createWindowSpringCheck} from '../spring-bank/trace.ts'
import {sourceField, windowCount, windowDestinationSourceField, windowOutputField} from '../spring-bank/window-manager.ts'

const laneCount = 5
const springFieldCount = 10

// Needs an executor machine built with debugOutputs, so values are indexed by wire.
export function checkCommitSprings(machine: EventTimeMachine) {
  const check = createWindowSpringCheck(machine.base)
  const commit = machine.commit
  machine.commit = (time: number) => {
    check.beforeStep()
    const evaluation = commit(time)
    check.afterStep(evaluation.values, time)
    return evaluation
  }
  return check.result
}

export function createDisplaySpringCheck(machine: EventTimeMachine) {
  const result = {displays: 0, maxPositionError: 0, maxVelocityError: 0, settleMismatches: 0}
  const {table, output} = machine
  return {
    result,
    check(evaluation: Evaluation, time: number) {
      const values = evaluation.values
      const steps = machine.stepsAt(time)
      for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
        const springStart = sourceField.springStart + windowIndex * springFieldCount
        const lanes: ReferenceLane[] = Array.from({length: laneCount}, (_, lane) => ({
          position: table[springStart + lane]!,
          velocity: table[springStart + 5 + lane]!,
          previousDestination: table[windowDestinationSourceField(windowIndex, lane)]!,
          constants: {stiffness: table[sourceField.springStiffness]!, damping: table[sourceField.springDamping]!},
        }))
        const destinations = lanes.map((_, lane) => values[output.nextSource[windowDestinationSourceField(windowIndex, lane)]!]!)
        const reference = referenceBoxStep(lanes, destinations, steps, {
          snap: values[output.windowSnap[windowIndex]!]! > 0,
          settleDistance: table[sourceField.springSettleDistance]!,
          settleSpeed: table[sourceField.springSettleSpeed]!,
          stepMs: 4,
          retarget: 'deferred',
        })
        lanes[4]!.position = Math.min(1, Math.max(0, lanes[4]!.position))
        for (let lane = 0; lane < laneCount; lane++) {
          const position = values[output.nextSource[springStart + lane]!]!
          const velocity = values[output.nextSource[springStart + 5 + lane]!]!
          result.maxPositionError = Math.max(result.maxPositionError, Math.abs(position - lanes[lane]!.position))
          result.maxVelocityError = Math.max(result.maxVelocityError, Math.abs(velocity - lanes[lane]!.velocity))
        }
        const circuitActive = values[output.windows[windowIndex * windowOutputField.size + windowOutputField.stack]!]! >= 40
        if (circuitActive !== reference.active) result.settleMismatches++
      }
      result.displays++
    },
  }
}
