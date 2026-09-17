// A population of simulated users running the shipped window circuit as
// instances, with each user's state carried across frames.
//
// The source table splits into per-user cells and shared cells:
// - per-user: every state cell (pointer, press record, window positions,
//   maximized bits, ranks, focus, last click), the behavior cells being
//   searched (slop, double click interval and distance), and the live cells of
//   the 16 event slots (kind bits, x, y, time);
// - shared: window sizes, the workspace, the title and button sizes, the frame
//   duration, and the unused key bits of the slots.
//
// codegen's generated instance loop (codegen/instance.ts) hoists
// shared values and runs the per-user part over blocks of users. After every
// frame the host copies each user's next-state outputs back into that user's
// state columns, which sit first in the per-user table in output order.

import {invariant, type Circuit} from '../../../src/runtime/numeric-ui-core.ts'
import type {EventSlot, QueuedEvent} from '../input/events.ts'
import {compileInstanceProgram, planInstances, type InstancePlan, type InstanceRunner} from '../codegen/instance.ts'
import {createRandom, type SourceLayout, type Wire} from '../input/kit.ts'
import {createUserModel, metricCount, segmentCount, type UserModelOptions} from './user-model.ts'
import {
  createWindowsState,
  windowsOracleFrame,
  writeWindowsConstants,
  writeWindowsState,
  type WindowsBuild,
  type WindowsCells,
  type WindowsConfig,
} from './windows.ts'

export type PopulationCircuit = {
  label: string
  config: WindowsConfig
  circuit: Circuit
  layout: SourceLayout
  frameDelta: Wire
  slots: readonly EventSlot[]
  cells: WindowsCells
  // Source cells that carry state from frame to frame, in the order of the
  // first stateCells.length roots.
  stateCells: readonly Wire[]
  // [...next state, ...rectangles (left, top, width, height per window), ...drag owner bits]
  roots: readonly Wire[]
  writeShared: (source: Float32Array) => void
  writeInitialState: (source: Float32Array) => void
}

export function liftedPopulationCircuit(build: WindowsBuild): PopulationCircuit {
  return {
    label: `lifted windows, ${build.capacity} slots`,
    config: build.config,
    circuit: build.circuit,
    layout: build.layout,
    frameDelta: build.frameDelta,
    slots: build.slots,
    cells: build.cells,
    stateCells: build.stateCells,
    roots: build.roots,
    writeShared: source => writeWindowsConstants(source, build.constants, build.config),
    writeInitialState: source => writeWindowsState(source, build.cells, createWindowsState(build.config)),
  }
}

export type SlotColumns = {down: number, move: number, up: number, x: number, y: number, time: number}

export type PopulationOptions = {
  userCount: number
  // Cells besides state and events that differ per user, e.g. behavior cells.
  perUserCells: readonly Wire[]
  frameDelta: number
  blockSize?: number
  rowsPerFunction?: number
  // Replaces the compiled program, e.g. with a corrupted copy (mutation.ts).
  program?: ReturnType<Circuit['compileTensorProgram']>
}

export type Population = ReturnType<typeof createPopulation>

export function createPopulation(circuit: PopulationCircuit, options: PopulationOptions) {
  const {userCount} = options
  const config = circuit.config
  const windowCount = config.windows.length
  const slotColumnsCells = circuit.slots.map(slot => [slot.down, slot.move, slot.up, slot.x, slot.y, slot.time])
  const instanceCells = [...circuit.stateCells, ...options.perUserCells, ...slotColumnsCells.flat()]
  invariant(new Set(instanceCells).size === instanceCells.length, 'per-user cells must be distinct')
  const width = instanceCells.length
  const column = new Int32Array(circuit.layout.size).fill(-1)
  instanceCells.forEach((cell, index) => {
    column[cell] = index
  })
  const columnOf = (cell: Wire) => {
    const found = column[cell]!
    invariant(found >= 0, `cell ${circuit.layout.names[cell]} is shared, not per user`)
    return found
  }
  const program = options.program ?? circuit.circuit.compileTensorProgram(circuit.roots)
  const plan: InstancePlan = planInstances(program, instanceCells, circuit.roots)
  const runner: InstanceRunner = compileInstanceProgram(plan, {rowsPerFunction: options.rowsPerFunction ?? 64, blockSize: options.blockSize ?? 1024})
  const sharedSource = new Float32Array(circuit.layout.size)
  circuit.writeShared(sharedSource)
  sharedSource[circuit.frameDelta] = options.frameDelta
  circuit.writeInitialState(sharedSource)
  runner.runShared(sharedSource)

  const table = new Float32Array(userCount * width)
  for (let user = 0; user < userCount; user++) {
    const base = user * width
    for (let index = 0; index < width; index++) table[base + index] = sharedSource[instanceCells[index]!]!
  }
  const stateCount = circuit.stateCells.length
  const outputCount = circuit.roots.length
  const outputs = new Float32Array(userCount * outputCount)
  const slotColumns: SlotColumns[] = slotColumnsCells.map(cells => ({
    down: columnOf(cells[0]!), move: columnOf(cells[1]!), up: columnOf(cells[2]!),
    x: columnOf(cells[3]!), y: columnOf(cells[4]!), time: columnOf(cells[5]!),
  }))
  const windowColumns = {
    left: circuit.cells.left.map(columnOf),
    top: circuit.cells.top.map(columnOf),
    maximized: circuit.cells.maximized.map(columnOf),
    rank: circuit.cells.rank.map(columnOf),
    focus: circuit.cells.focus.map(columnOf),
    pressWindow: circuit.cells.pressWindow.map(columnOf),
    lastClickWindow: circuit.cells.lastClickWindow.map(columnOf),
    pressActive: columnOf(circuit.cells.pressActive),
  }
  const rectangleOutputBase = stateCount
  const dragOwnerOutputs = Array.from({length: windowCount}, (_, index) => stateCount + windowCount * 4 + index)

  const timing = {circuitMilliseconds: 0, writebackMilliseconds: 0, frames: 0}

  // The frame duration is a shared cell, so shared values are computed again.
  function setFrameDelta(frameDelta: number) {
    sharedSource[circuit.frameDelta] = frameDelta
    runner.runShared(sharedSource)
  }

  function step() {
    const circuitStart = performance.now()
    runner.runInstances(table, userCount, outputs)
    const writebackStart = performance.now()
    for (let user = 0, tableBase = 0, outputBase = 0; user < userCount; user++, tableBase += width, outputBase += outputCount) {
      for (let index = 0; index < stateCount; index++) table[tableBase + index] = outputs[outputBase + index]!
    }
    timing.circuitMilliseconds += writebackStart - circuitStart
    timing.writebackMilliseconds += performance.now() - writebackStart
    timing.frames++
  }

  // The events written into a user's slots this frame, as objects.
  function eventsOf(user: number): QueuedEvent[] {
    const base = user * width
    const events: QueuedEvent[] = []
    for (const slot of slotColumns) {
      const kind = table[base + slot.down] === 1 ? 'down' : table[base + slot.move] === 1 ? 'move' : table[base + slot.up] === 1 ? 'up' : null
      if (kind === null) break
      events.push({kind, x: table[base + slot.x]!, y: table[base + slot.y]!, time: table[base + slot.time]!})
    }
    return events
  }

  // A user's whole source table, e.g. to check against the executor.
  function sourceOf(user: number) {
    const source = new Float32Array(sharedSource)
    const base = user * width
    instanceCells.forEach((cell, index) => {
      source[cell] = table[base + index]!
    })
    return source
  }

  return {
    circuit, config, userCount, windowCount, width, stateCount, outputCount, instanceCells, columnOf,
    program, plan, runner, sharedSource, table, outputs, slotColumns, windowColumns, rectangleOutputBase, dragOwnerOutputs,
    timing, setFrameDelta, step, eventsOf, sourceOf,
  }
}

// ---------------------------------------------------------------------------
// Checks over every user and frame

export type PopulationChecks = {
  userFrames: number
  // Largest distance of a one-hot member from 0 or 1, and largest mass above 1,
  // over pressWindow, focus, lastClickWindow and the drag owner outputs.
  oneHotBitError: number
  oneHotMassError: number
  oneHotViolatingUserFrames: number
  // User-frames whose ranks are not a permutation of 0..windowCount-1.
  rankViolatingUserFrames: number
  // Largest distance in pixels by which a displayed window leaves the workspace.
  outsideWorkspacePixels: number
  outsideWorkspaceUserFrames: number
}

export function createPopulationChecks(population: Population) {
  const {table, outputs, width, outputCount, userCount, windowCount, windowColumns, rectangleOutputBase, dragOwnerOutputs, config} = population
  const result: PopulationChecks = {userFrames: 0, oneHotBitError: 0, oneHotMassError: 0, oneHotViolatingUserFrames: 0, rankViolatingUserFrames: 0, outsideWorkspacePixels: 0, outsideWorkspaceUserFrames: 0}
  const groups = [windowColumns.pressWindow, windowColumns.focus, windowColumns.lastClickWindow]
  const workspace = config.workspace
  function check() {
    for (let user = 0; user < userCount; user++) {
      const base = user * width
      const outputBase = user * outputCount
      let violating = false
      for (const group of groups) {
        let mass = 0
        for (const columnIndex of group) {
          const value = table[base + columnIndex]!
          const bitError = Math.min(Math.abs(value), Math.abs(value - 1))
          if (bitError > result.oneHotBitError) result.oneHotBitError = bitError
          if (bitError !== 0) violating = true
          mass += value
        }
        const massError = mass > 1 ? mass - 1 : mass < 0 ? -mass : 0
        if (massError > result.oneHotMassError) result.oneHotMassError = massError
        if (massError !== 0) violating = true
      }
      let ownerMass = 0
      for (const output of dragOwnerOutputs) {
        const value = outputs[outputBase + output]!
        const bitError = Math.min(Math.abs(value), Math.abs(value - 1))
        if (bitError > result.oneHotBitError) result.oneHotBitError = bitError
        if (bitError !== 0) violating = true
        ownerMass += value
      }
      if (ownerMass > 1) {
        result.oneHotMassError = Math.max(result.oneHotMassError, ownerMass - 1)
        violating = true
      }
      if (violating) result.oneHotViolatingUserFrames++
      let seenRanks = 0
      for (const columnIndex of windowColumns.rank) {
        const rank = table[base + columnIndex]!
        if (Number.isInteger(rank) && rank >= 0 && rank < windowCount) seenRanks |= 1 << rank
      }
      if (seenRanks !== (1 << windowCount) - 1) result.rankViolatingUserFrames++
      let outside = 0
      for (let index = 0; index < windowCount; index++) {
        const rectangleBase = outputBase + rectangleOutputBase + index * 4
        const left = outputs[rectangleBase]!
        const top = outputs[rectangleBase + 1]!
        const right = left + outputs[rectangleBase + 2]!
        const bottom = top + outputs[rectangleBase + 3]!
        outside = Math.max(outside, workspace.left - left, right - (workspace.left + workspace.width), workspace.top - top, bottom - (workspace.top + workspace.height))
      }
      if (!(outside <= 0)) {
        result.outsideWorkspaceUserFrames++
        result.outsideWorkspacePixels = Math.max(result.outsideWorkspacePixels, Number.isNaN(outside) ? Infinity : outside)
      }
      result.userFrames++
    }
  }
  return {result, check}
}

// ---------------------------------------------------------------------------
// One-event-at-a-time oracles for sampled users

export type PopulationOracle = {
  // Runs one frame and writes the expected outputs (next state, rectangles,
  // drag owner bits) into target.
  frame: (events: readonly QueuedEvent[], frameDelta: number, target: Float64Array) => void
}

export function createLiftedOracle(circuit: PopulationCircuit, config: WindowsConfig): PopulationOracle {
  const state = createWindowsState(config)
  const scratch = new Float32Array(circuit.layout.size)
  const stateCount = circuit.stateCells.length
  const windowCount = config.windows.length
  return {
    frame(events, frameDelta, target) {
      const display = windowsOracleFrame(config, state, frameDelta, events)
      writeWindowsState(scratch, circuit.cells, state)
      for (let index = 0; index < stateCount; index++) target[index] = scratch[circuit.stateCells[index]!]!
      display.rectangles.forEach((rectangle, index) => {
        const base = stateCount + index * 4
        target[base] = rectangle.left
        target[base + 1] = rectangle.top
        target[base + 2] = rectangle.width
        target[base + 3] = rectangle.height
      })
      for (let index = 0; index < windowCount; index++) target[stateCount + windowCount * 4 + index] = display.dragOwner === index ? 1 : 0
    },
  }
}

export type OracleComparison = {users: number[], comparisons: number, mismatches: number, mismatchedUserFrames: number, firstMismatch: string | null}

export function createOracleSampler(population: Population, users: readonly number[], createOracle: (user: number) => PopulationOracle) {
  const oracles = users.map(createOracle)
  const expected = new Float64Array(population.outputCount)
  const captured: QueuedEvent[][] = users.map(() => [])
  const result: OracleComparison = {users: [...users], comparisons: 0, mismatches: 0, mismatchedUserFrames: 0, firstMismatch: null}
  let frame = 0
  // Call after the events are written and before the circuit runs.
  function capture() {
    users.forEach((user, index) => {
      captured[index] = population.eventsOf(user)
    })
  }
  // Call after the circuit ran.
  function compare(frameDelta: number) {
    users.forEach((user, index) => {
      oracles[index]!.frame(captured[index]!, frameDelta, expected)
      const base = user * population.outputCount
      let mismatched = false
      for (let output = 0; output < population.outputCount; output++) {
        result.comparisons++
        const actual = population.outputs[base + output]!
        if (!Object.is(actual, expected[output])) {
          result.mismatches++
          mismatched = true
          result.firstMismatch ??= `frame ${frame}, user ${user}, output ${output}: circuit ${actual}, oracle ${expected[output]}`
        }
      }
      if (mismatched) result.mismatchedUserFrames++
    })
    frame++
  }
  return {result, capture, compare}
}

// Distinct users spread over settings and tremor strata: index × stride modulo
// the user count, with a stride near the golden ratio of the count that shares
// no factor with it, so no two indices give the same user.
export function sampleUsers(userCount: number, sampleCount: number) {
  const greatestCommonDivisor = (a: number, b: number): number => (b === 0 ? a : greatestCommonDivisor(b, a % b))
  let stride = Math.max(1, Math.round(userCount * 0.6180339887))
  while (greatestCommonDivisor(stride, userCount) !== 1) stride++
  return Array.from({length: Math.min(sampleCount, userCount)}, (_, index) => (index * stride) % userCount)
}

// ---------------------------------------------------------------------------
// A whole run: users grouped by setting, simulated for a number of frames.

export type PopulationRunOptions = {
  circuit: PopulationCircuit
  perUserCells: readonly Wire[]
  groupCount: number
  usersPerGroup: number
  // Writes a group's per-user cells into a user's columns.
  writeGroup: (table: Float32Array, base: number, columnOf: (cell: Wire) => number, group: number, user: number) => void
  frames: number
  seed: number
  checkedUsers: number
  createOracle: (user: number, group: number) => PopulationOracle
  userModel?: Partial<UserModelOptions>
  runChecks?: boolean
  // Share of frames that last 3 to 7 normal frames, e.g. while the page is busy.
  // Janky frames carry more events, and sometimes 2 downs.
  jankProbability?: number
  blockSize?: number
  rowsPerFunction?: number
  // Runs once after the users are created and before the first frame.
  onStart?: (population: Population, model: ReturnType<typeof createUserModel>) => void
  onFrame?: (frame: number, population: Population) => void
}

export const populationFrameDelta = 16.6875

// Frame durations for a run: normal frames, and janky ones that last 3 to 7
// normal frames, on the 1/16 ms grid.
export function frameSchedule(frames: number, jankProbability: number, seed: number) {
  const random = createRandom(seed ^ 0x5bd1e995)
  return Float64Array.from({length: frames}, () => (jankProbability > 0 && random() < jankProbability ? populationFrameDelta * (3 + Math.floor(random() * 5)) : populationFrameDelta))
}

export function runPopulation(options: PopulationRunOptions) {
  invariant(options.usersPerGroup % segmentCount === 0, 'users per group must be a multiple of the tremor segment count')
  const userCount = options.groupCount * options.usersPerGroup
  const buildStart = performance.now()
  const population = createPopulation(options.circuit, {
    userCount,
    perUserCells: options.perUserCells,
    frameDelta: populationFrameDelta,
    ...(options.blockSize === undefined ? {} : {blockSize: options.blockSize}),
    ...(options.rowsPerFunction === undefined ? {} : {rowsPerFunction: options.rowsPerFunction}),
  })
  const buildMilliseconds = performance.now() - buildStart
  const groupOfUser = new Uint32Array(userCount)
  for (let user = 0; user < userCount; user++) {
    groupOfUser[user] = user % options.groupCount
    options.writeGroup(population.table, user * population.width, population.columnOf, groupOfUser[user]!, user)
  }
  const model = createUserModel(population, {
    groupCount: options.groupCount,
    groupOfUser,
    seed: options.seed,
    ...options.userModel,
  })
  // Before the oracles are created, so oracles can read what onStart set up.
  options.onStart?.(population, model)
  const checks = createPopulationChecks(population)
  const checkedUsers = sampleUsers(userCount, options.checkedUsers)
  const sampler = createOracleSampler(population, checkedUsers, user => options.createOracle(user, groupOfUser[user]!))
  const lateFrames = Math.min(100, options.frames)
  const schedule = frameSchedule(options.frames, options.jankProbability ?? 0, options.seed)
  let frameEnd = 0
  let currentFrameDelta = populationFrameDelta
  let jankFrames = 0
  let lateCircuitMilliseconds = 0
  let policyMilliseconds = 0
  let checksMilliseconds = 0
  let oracleMilliseconds = 0
  for (let frame = 0; frame < options.frames; frame++) {
    const frameDelta = schedule[frame]!
    frameEnd += frameDelta
    if (frameDelta !== populationFrameDelta) jankFrames++
    if (frameDelta !== currentFrameDelta) {
      population.setFrameDelta(frameDelta)
      currentFrameDelta = frameDelta
    }
    const policyStart = performance.now()
    model.emitFrame(frame, frameEnd)
    policyMilliseconds += performance.now() - policyStart
    const captureStart = performance.now()
    sampler.capture()
    oracleMilliseconds += performance.now() - captureStart
    const circuitBefore = population.timing.circuitMilliseconds
    population.step()
    if (frame >= options.frames - lateFrames) lateCircuitMilliseconds += population.timing.circuitMilliseconds - circuitBefore
    const compareStart = performance.now()
    sampler.compare(frameDelta)
    const checksStart = performance.now()
    oracleMilliseconds += checksStart - compareStart
    if (options.runChecks !== false) checks.check()
    const observeStart = performance.now()
    checksMilliseconds += observeStart - checksStart
    model.observeFrame(frame)
    policyMilliseconds += performance.now() - observeStart
    options.onFrame?.(frame, population)
  }
  const userFrames = userCount * options.frames
  return {
    userCount,
    frames: options.frames,
    userFrames,
    jankFrames,
    groupCount: options.groupCount,
    usersPerGroup: options.usersPerGroup,
    population,
    model,
    metrics: model.metrics,
    lateMetrics: model.lateMetrics,
    metricCount,
    checks: checks.result,
    oracle: sampler.result,
    counts: {
      liveValues: population.plan.flat.valueCount,
      layers: population.plan.flat.layerCount,
      storedWeights: population.plan.flat.storedWeights,
      perUserColumns: population.width,
      ...population.plan.counts,
    },
    timing: {
      buildMilliseconds,
      generatedCodeCompileMilliseconds: population.runner.compileMilliseconds,
      circuitNanosecondsPerUserFrame: population.timing.circuitMilliseconds * 1e6 / userFrames,
      circuitNanosecondsPerUserFrameLastFrames: lateCircuitMilliseconds * 1e6 / (userCount * lateFrames),
      writebackNanosecondsPerUserFrame: population.timing.writebackMilliseconds * 1e6 / userFrames,
      policyNanosecondsPerUserFrame: policyMilliseconds * 1e6 / userFrames,
      checksNanosecondsPerUserFrame: checksMilliseconds * 1e6 / userFrames,
      oracleMilliseconds,
    },
  }
}
