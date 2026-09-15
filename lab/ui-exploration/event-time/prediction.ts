// Time as an instance axis. With the source-matrix bank, JS counts steps and
// writes M^steps into 4 source cells. Making those 4 cells per-instance, and
// giving instance i the matrix M^i, computes the screen i fixed 4 ms steps after
// the committed simulated time, for all 301 samples until the 300-step cap, in
// one run of one program. Everything that doesn't read the 4 cells (hit tests,
// stacking, destinations, and the Photos layout when it reads early inputs) is
// computed once per prediction, like uniforms in a shader.
import {invariant} from '../../../numeric-ui-core.ts'
import {lastSettleCheckSteps, settleCheckStepMultiple} from './commits.ts'
import {type EventTimeMachine, displayLayout} from './event-machine.ts'
import {compileInstanceProgram, planInstances} from './instance.ts'
import {defaultClockConfig, eulerStepMatrix, matrixPower, quantizeFrameTime} from './spring-math.ts'
import {bankSourceField, sourceField} from './window-manager.ts'

export const sampleCount = defaultClockConfig.maxSteps + 1
export const frameCells = [0, 1, 2, 3].map(entry => bankSourceField.springFrameStart + entry)

export type Prediction = {
  // Simulated time of sample 0: the commit time minus the carried leftover.
  // Sample i is on screen from originTime + 4 i to originTime + 4 i + 4 ms.
  originTime: number
  running: boolean
  // The first step count in 16, 32, ..., 288 whose sample reports that nothing
  // animates. Later samples show this one. 0 when the committed clock is
  // stopped, null when no checked step settles (the samples run to the cap).
  settleStep: number | null
  rootCount: number
  // sampleCount × rootCount display outputs, before snapping.
  samples: Float32Array
}

export function lastPlayedSample(prediction: Prediction) {
  return prediction.settleStep ?? sampleCount - 1
}

// The sample on screen at `time`: the display's step count, snapped at the settle step.
export function sampleIndexAt(prediction: Prediction, time: number) {
  if (!prediction.running) return 0
  const elapsed = quantizeFrameTime(time, defaultClockConfig) - prediction.originTime
  const steps = Math.min(defaultClockConfig.maxSteps, Math.max(0, Math.floor(elapsed / defaultClockConfig.stepMs)))
  return Math.min(steps, lastPlayedSample(prediction))
}

export function createPredictor(machine: EventTimeMachine, options: {blockSize?: number, rowsPerFunction?: number} = {}) {
  invariant(machine.options.springs === 'source-matrix', 'predictions write M^i into the source-matrix cells')
  const roots = machine.displayRoots
  const program = machine.circuit.compileTensorProgram(roots)
  const plan = planInstances(program, frameCells, roots)
  const runner = compileInstanceProgram(plan, {
    rowsPerFunction: options.rowsPerFunction ?? 128,
    blockSize: options.blockSize ?? sampleCount,
  })
  const activeColumn = displayLayout(machine).animationActive
  const powers = new Float32Array(sampleCount * frameCells.length)
  let powersKey = ''

  function refreshPowers() {
    const stiffness = machine.table[sourceField.springStiffness]!
    const damping = machine.table[sourceField.springDamping]!
    const key = `${stiffness} ${damping}`
    if (key === powersKey) return
    powersKey = key
    const step = eulerStepMatrix({stiffness, damping}, defaultClockConfig.stepMs)
    for (let sample = 0; sample < sampleCount; sample++) {
      const power = matrixPower(step, sample)
      for (let entry = 0; entry < frameCells.length; entry++) powers[sample * frameCells.length + entry] = power[entry]!
    }
  }

  return {
    program,
    plan,
    runner,
    roots,
    activeColumn,
    // M^i for every sample, as written into the 4 per-instance cells.
    powers() {
      refreshPowers()
      return powers
    },
    predict(target?: Float32Array): Prediction {
      const commitTime = machine.lastCommitTime
      invariant(commitTime !== null, 'commit first')
      refreshPowers()
      const rootCount = roots.length
      const samples = target ?? new Float32Array(sampleCount * rootCount)
      invariant(samples.length === sampleCount * rootCount, 'prediction buffer has the wrong length')
      const running = machine.running()
      runner.runShared(machine.table)
      if (running) {
        runner.runInstances(powers, sampleCount, samples)
      } else {
        // A stopped clock runs 0 steps at every time, so every sample is sample 0.
        runner.runInstances(powers, 1, samples)
        for (let sample = 1; sample < sampleCount; sample++) samples.copyWithin(sample * rootCount, 0, rootCount)
      }
      let settleStep: number | null = running ? null : 0
      if (running) {
        for (let steps = settleCheckStepMultiple; steps <= lastSettleCheckSteps; steps += settleCheckStepMultiple) {
          if (samples[steps * rootCount + activeColumn] === 0) {
            settleStep = steps
            break
          }
        }
      }
      return {originTime: commitTime - machine.leftoverMs(), running, settleStep, rootCount, samples}
    },
  }
}

export type Predictor = ReturnType<typeof createPredictor>

// Samples after the settle step that the circuit itself still reports as
// animating, and the largest difference between those samples and the settle
// sample on the given output offsets. Each sample checks settling on its own,
// so a spring can be within both thresholds at one step and outside a few steps
// later, as position converts into velocity.
export function snapStatistics(prediction: Prediction, activeColumn: number, offsets: ArrayLike<number>) {
  let animatingAfterSettle = 0
  let maxSnapDifference = 0
  const {settleStep, rootCount, samples} = prediction
  if (!prediction.running || settleStep === null) return {animatingAfterSettle, maxSnapDifference}
  for (let sample = settleStep + 1; sample < sampleCount; sample++) {
    if (samples[sample * rootCount + activeColumn] !== 0) animatingAfterSettle++
    for (let index = 0; index < offsets.length; index++) {
      const offset = offsets[index]!
      maxSnapDifference = Math.max(maxSnapDifference, Math.abs(samples[sample * rootCount + offset]! - samples[settleStep * rootCount + offset]!))
    }
  }
  return {animatingAfterSettle, maxSnapDifference}
}
