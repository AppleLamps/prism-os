import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {
  adaptiveOracleFrame,
  adaptivePopulationCircuit,
  buildAdaptiveWindowsCircuit,
  createAdaptiveOracle,
  createAdaptiveState,
  createAdaptiveTracker,
  segmentOfCounts,
  writeAdaptiveState,
  writeAdaptiveTable,
  type AdaptiveTable,
} from './adaptive.ts'
import {writeEventQueue, type QueuedEvent} from '../input/events.ts'
import {testWindowsConfig as config} from './fixtures.ts'
import {generateWindowsTrace, randomEventTimes, type Frame} from './input-traces.ts'
import {createRandom, randomInteger} from '../input/kit.ts'
import {runPopulation} from './population.ts'
import {segmentCount} from './user-model.ts'

const table: AdaptiveTable = {
  holdWindow: 100,
  levelThresholds: [2, 3, 5],
  segmentSlop: [2, 4, 6, 9],
  segmentDistance: [3, 5, 8, 12],
  doubleClickInterval: 400,
  initialSegment: 1,
}

// Presses whose jitter amplitude changes every 200 frames (0, 1, 3, 5 and 8 px),
// so the counters walk through every segment. Some presses are title presses
// near the previous one, so double clicks happen with the selected distance.
function jitterTrace(seed: number, frames: number): Frame[] {
  const random = createRandom(seed)
  const amplitudes = [0, 1, 3, 5, 8]
  const result: Frame[] = []
  let pressed = false
  let pressX = 0
  let pressY = 0
  for (let frame = 0; frame < frames; frame++) {
    const amplitude = amplitudes[Math.floor(frame / 200) % amplitudes.length]!
    const frameDelta = [4, 16.6875, 16.6875, 33.375, 120][randomInteger(random, 0, 4)]!
    const times = randomEventTimes(random, randomInteger(random, 0, 4), Math.min(frameDelta, 60))
    const events: QueuedEvent[] = []
    let downs = 0
    for (const time of times) {
      if (!pressed) {
        if (downs >= 2 || random() < 0.4) continue
        const onTitle = random() < 0.5
        pressX = onTitle && random() < 0.5 ? pressX + randomInteger(random, -4, 4) : randomInteger(random, 100, 1100)
        pressY = onTitle ? randomInteger(random, 5, 22) : randomInteger(random, 40, 700)
        events.push({kind: 'down', x: pressX, y: pressY, time})
        pressed = true
        downs++
      } else if (random() < 0.3) {
        events.push({kind: 'up', x: pressX + randomInteger(random, -amplitude, amplitude), y: pressY + randomInteger(random, -amplitude, amplitude), time})
        pressed = false
      } else {
        events.push({kind: 'move', x: pressX + randomInteger(random, -amplitude, amplitude), y: pressY + randomInteger(random, -amplitude, amplitude), time})
      }
    }
    result.push({frameDelta, events})
  }
  return result
}

function runAgainstOracle(frames: readonly Frame[]) {
  const build = buildAdaptiveWindowsCircuit(config, 16, 2)
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const source = new Float32Array(build.layout.size)
  writeAdaptiveTable(source, build, table)
  const oracle = createAdaptiveState(config, table)
  writeAdaptiveState(source, build, oracle)
  const scratch = new Float32Array(build.layout.size)
  const segmentFrames = new Array<number>(segmentCount).fill(0)
  let mismatchedFrames = 0
  let firstMismatch: string | null = null
  frames.forEach((frame, frameIndex) => {
    source[build.frameDelta] = frame.frameDelta
    writeEventQueue(source, build.slots, frame.events)
    if (frameIndex % 50 === 0) validateOneHotGroups(build.circuit, build.circuit.evaluateTensor(source))
    const outputs = evaluate(source)
    const display = adaptiveOracleFrame(config, table, oracle, frame.frameDelta, frame.events)
    writeAdaptiveState(scratch, build, oracle)
    let mismatched = false
    for (let index = 0; index < build.stateCells.length; index++) {
      const cell = build.stateCells[index]!
      if (!Object.is(outputs[index], scratch[cell])) {
        mismatched = true
        firstMismatch ??= `frame ${frameIndex}, state ${build.layout.names[cell]}: circuit ${outputs[index]}, oracle ${scratch[cell]}`
      }
    }
    for (let index = 0; index < display.rectangles.length; index++) {
      const rectangle = display.rectangles[index]!
      const base = build.stateCells.length + index * 4
      if (outputs[base] !== rectangle.left || outputs[base + 1] !== rectangle.top || outputs[base + 2] !== rectangle.width || outputs[base + 3] !== rectangle.height) mismatched = true
    }
    if (mismatched) mismatchedFrames++
    for (let index = 0; index < build.stateCells.length; index++) source[build.stateCells[index]!] = outputs[index]!
    segmentFrames[segmentOfCounts(oracle.tremorCount)]!++
  })
  return {build, mismatchedFrames, firstMismatch, segmentFrames, oracle}
}

describe('the adaptive slop table', () => {
  test('the circuit matches its oracle over jitter traces that visit every segment', () => {
    const result = runAgainstOracle(jitterTrace(21, 2000))
    expect(result.firstMismatch).toBeNull()
    expect(result.mismatchedFrames).toBe(0)
    for (const frames of result.segmentFrames) expect(frames).toBeGreaterThan(50)
  })

  test('the circuit matches its oracle over input\'s random window trace', () => {
    const result = runAgainstOracle(generateWindowsTrace(config, {seed: 1002, frames: 1500, capacity: 16, maximumDowns: 2}))
    expect(result.firstMismatch).toBeNull()
    expect(result.mismatchedFrames).toBe(0)
  })

  test('a population running the adaptive circuit matches the oracle for every user, and the counters never cross', () => {
    const build = buildAdaptiveWindowsCircuit(config, 16, 2)
    const circuit = adaptivePopulationCircuit(build, table)
    let tracker: ReturnType<typeof createAdaptiveTracker> | null = null
    const run = runPopulation({
      circuit,
      perUserCells: [],
      groupCount: 1,
      usersPerGroup: 24,
      writeGroup: () => {},
      frames: 900,
      seed: 4,
      checkedUsers: 24,
      jankProbability: 0.05,
      createOracle: () => createAdaptiveOracle(build, table),
      onFrame: (_, population) => {
        tracker ??= createAdaptiveTracker(population, build, Uint8Array.from({length: population.userCount}, (_, user) => user % segmentCount))
        tracker.track()
      },
    })
    expect(run.oracle.firstMismatch).toBeNull()
    expect(run.oracle.mismatches).toBe(0)
    expect(run.oracle.users.length).toBe(24)
    expect(run.checks.oneHotMassError).toBe(0)
    expect(tracker!.result.counterViolations).toBe(0)
    expect(tracker!.result.crossedCounters).toBe(0)
    expect(tracker!.result.holdLevelBitErrors).toBe(0)
  })
})
