// Predictive keyframes (vibescript docs/Animation.md): simulate ahead with a
// pure step function and hand the frames to Web Animations. With the spring
// bank, the frame after i fixed steps is the same circuit evaluated at step
// count i, so the next N samples are N independent evaluations instead of a
// loop that carries state from one sample to the next.
import {Circuit, type Wire, validateCircuit, validateTensorProgram} from '../../../numeric-ui-core.ts'
import {type BankMachine, type BankSpec, bankField, createBankMachine, laneField} from './bank-machine.ts'
import type {SpringPowers} from './spring-bank.ts'
import {type SpringClockConfig, defaultClockConfig, eulerStepMatrix, matrixPower} from './spring-math.ts'

// Sample i evaluates a copy of the machine's table as if i * stepMs had passed
// with the clock running from zero leftover. Returns positions as
// [sample * laneCount + lane].
export function predictSerial(machine: BankMachine, sampleCount: number) {
  const table = new Float32Array(machine.source.length)
  const samples = new Float32Array(sampleCount * machine.laneCount)
  for (let sample = 0; sample < sampleCount; sample++) {
    table.set(machine.source)
    table[bankField.running] = 1
    table[bankField.leftoverMs] = 0
    const values = machine.evaluateFrame(table, sample * machine.config.stepMs)
    for (let lane = 0; lane < machine.laneCount; lane++) {
      samples[sample * machine.laneCount + lane] = values[machine.output.positionStart + lane]!
    }
  }
  return samples
}

// All samples in one evaluation. Every sample's step count is a build-time
// constant, so its frame matrix is a constant too: each predicted position is
// an affine row over (displacement, velocity), plus the box's settle snap.
export function createPredictionBatch(spec: BankSpec, sampleCount: number, config: SpringClockConfig = defaultClockConfig) {
  const laneGroups = spec.boxes.flatMap(box => box.lanes.map(lane => lane.group))
  const laneCount = laneGroups.length
  const unit = 0
  const settleDistance = 1
  const settleSpeed = 2
  const cell = (lane: number, field: 0 | 1 | 2) => 3 + lane * 3 + field
  const circuit = new Circuit(3 + laneCount * 3)
  circuit.assumeRange(unit, 1, 1)
  circuit.assumeRange(settleDistance, 0, 1)
  circuit.assumeRange(settleSpeed, 0, 1)
  const powersByGroup = spec.groups.map(constants => {
    const step = eulerStepMatrix(constants, config.stepMs)
    return Array.from({length: sampleCount}, (_, sample) => matrixPower(step, sample))
  })
  const displacements = laneGroups.map((_, lane) => circuit.roundAffine([[cell(lane, 0), 1], [cell(lane, 2), -1]]))
  const positions: Wire[] = Array(sampleCount * laneCount)
  for (let sample = 0; sample < sampleCount; sample++) {
    let lane = 0
    for (const box of spec.boxes) {
      const exceedanceTerms: [Wire, number][] = []
      const stepped = box.lanes.map(laneSpec => {
        const index = lane++
        const power = powersByGroup[laneSpec.group]![sample]!
        const check = circuit.affine([[displacements[index]!, power[0]], [cell(index, 1), power[1]]])
        const velocity = circuit.affine([[displacements[index]!, power[2]], [cell(index, 1), power[3]]])
        exceedanceTerms.push(
          [circuit.reglu([], 1, [[check, 1], [settleDistance, -1]], 0), 1],
          [circuit.reglu([], 1, [[check, -1], [settleDistance, -1]], 0), 1],
          [circuit.reglu([], 1, [[velocity, 1], [settleSpeed, -1]], 0), 1],
          [circuit.reglu([], 1, [[velocity, -1], [settleSpeed, -1]], 0), 1],
        )
        return {index, check}
      })
      const exceedance = circuit.affine(exceedanceTerms)
      const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
      circuit.assumeRange(settledScore, 0, 1)
      const settled = circuit.boolean(settledScore)
      const active = circuit.affine([[unit, 1], [settled, -1]])
      circuit.assumeRange(active, 0, 1)
      for (const {index, check} of stepped) {
        positions[sample * laneCount + index] = circuit.roundAffine([
          [cell(index, 2), 1],
          [circuit.reglu([[check, 1]], 0, [[active, 1]], 0), 1],
        ])
      }
    }
  }
  validateCircuit(circuit)
  const program = circuit.compileTensorProgram(positions)
  validateTensorProgram(circuit, program)
  circuit.tensorProgram = program
  const evaluate = circuit.createTensorEvaluator(positions)
  const source = new Float32Array(circuit.sourceSize)
  return {
    circuit,
    program,
    sampleCount,
    laneCount,
    // Reads the lanes of a bank machine that has already stepped this frame, so
    // each lane's previous destination equals its destination. The returned
    // array is reused by the next call.
    predict(machine: BankMachine) {
      source[unit] = 1
      source[settleDistance] = machine.source[bankField.settleDistance]!
      source[settleSpeed] = machine.source[bankField.settleSpeed]!
      for (let index = 0; index < laneCount; index++) {
        source[cell(index, 0)] = machine.source[machine.laneCell(index, laneField.position)]!
        source[cell(index, 1)] = machine.source[machine.laneCell(index, laneField.velocity)]!
        source[cell(index, 2)] = machine.source[machine.laneCell(index, laneField.destination)]!
      }
      return evaluate(source)
    },
  }
}

export type BoxSize = {width: number, height: number}

// One keyframe per 4 ms sample. Lane 0 is the center x, lane 1 the center y,
// lane 2 the scale.
export function keyframesForBox(samples: Float32Array, laneCount: number, firstLane: number, size: BoxSize): Keyframe[] {
  const sampleCount = samples.length / laneCount
  const keyframes: Keyframe[] = []
  for (let sample = 0; sample < sampleCount; sample++) {
    const x = samples[sample * laneCount + firstLane]!
    const y = samples[sample * laneCount + firstLane + 1]!
    const scale = samples[sample * laneCount + firstLane + 2]!
    keyframes.push({transform: `translate3d(${x - size.width / 2}px,${y - size.height / 2}px,0) scale(${scale})`})
  }
  return keyframes
}

// These frames are already the smallest unit of time, so step between them
// instead of interpolating (Animation.md).
export function animationTiming(sampleCount: number, config: SpringClockConfig = defaultClockConfig): KeyframeAnimationOptions {
  return {
    duration: config.stepMs * (sampleCount - 1),
    easing: `steps(${sampleCount - 1}, end)`,
    fill: 'forwards',
  }
}

export const predictiveSpec: BankSpec = {
  groups: [{stiffness: 290, damping: 24}, {stiffness: 333, damping: 12}],
  boxes: Array.from({length: 5}, () => ({lanes: [{group: 0}, {group: 0}, {group: 1}]})),
}
export const predictiveLanesPerBox = 3
export const predictiveSampleCount = defaultClockConfig.maxSteps + 1
export const predictiveBoxSize: BoxSize = {width: 72, height: 72}

// Wellons lowbias32, as in the vibescript demos. Runs in JS at event time; the
// results enter the table as destinations.
function hash(seed: number) {
  let value = seed | 0
  value = Math.imul((value >>> 16) ^ value, 0x21f0aaad)
  value = Math.imul((value >>> 15) ^ value, 0xd35a2d97)
  return (((value >>> 15) ^ value) >>> 0) / 0x100000000
}

export type PredictionMode = 'serial' | 'batch'

export function createPredictiveScene(powers: SpringPowers = 'split-table') {
  const machine = createBankMachine(predictiveSpec, {powers, retarget: 'deferred'})
  const batch = createPredictionBatch(predictiveSpec, predictiveSampleCount, machine.config)
  const boxCount = predictiveSpec.boxes.length
  let flingCount = 0

  function place(lane: number, value: number) {
    machine.source[machine.laneCell(lane, laneField.position)] = value
    machine.source[machine.laneCell(lane, laneField.destination)] = value
    machine.source[machine.laneCell(lane, laneField.previousDestination)] = value
  }

  return {
    machine,
    batch,
    boxCount,
    arrange(viewportWidth: number, viewportHeight: number) {
      for (let box = 0; box < boxCount; box++) {
        const firstLane = box * predictiveLanesPerBox
        place(firstLane, viewportWidth / 2 + (box - (boxCount - 1) / 2) * 96)
        place(firstLane + 1, viewportHeight / 2)
        place(firstLane + 2, 1)
      }
    },
    fling(viewportWidth: number, viewportHeight: number) {
      flingCount++
      const margin = 80
      for (let box = 0; box < boxCount; box++) {
        const firstLane = box * predictiveLanesPerBox
        const seed = flingCount * 16 + box
        machine.setDestination(firstLane, margin + hash(seed * 3 + 1) * Math.max(0, viewportWidth - margin * 2))
        machine.setDestination(firstLane + 1, margin + hash(seed * 3 + 2) * Math.max(0, viewportHeight - margin * 2))
        machine.setDestination(firstLane + 2, 0.6 + hash(seed * 3 + 3) * 0.8)
      }
    },
    render(now: number, mode: PredictionMode) {
      const values = machine.step(now)
      const animationActive = values[machine.output.animationActive]! > 0
      const started = performance.now()
      const samples = mode === 'serial'
        ? predictSerial(machine, predictiveSampleCount)
        : Float32Array.from(batch.predict(machine))
      const microsecondsPerSample = (performance.now() - started) * 1000 / predictiveSampleCount
      return {samples, animationActive, microsecondsPerSample}
    },
  }
}
