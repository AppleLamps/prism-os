// A hardened per-tremor-segment table: the circuit measures each user's hand
// tremor during holds, keeps an estimate in runtime cells, and selects the slop
// and double click distance for the frame from a table of cells.
//
// Measurement. For every press, the circuit records which of 3 levels (e.g.
// 2, 3 and 5 px) the pointer reached, as a Chebyshev distance from the press
// point, among moves at most `holdWindow` ms after the down. The levels are
// bits `holdLevel[level]`, carried across frames while the press lasts.
//
// Estimate. At each release, counter `tremorCount[level]` goes up by 1 when the
// press reached that level and down by 1 otherwise, clamped to 0..8. A counter
// at 4 or more means that more than half of recent presses reached the level,
// i.e. the median hold excursion is at least that level. Because a press that
// reaches a higher level also reaches every lower one, the counters never
// cross: count[0] >= count[1] >= count[2] holds for every legal starting state,
// so the bits [count >= 4] read as a thermometer, and the segment is their sum.
//
// Selection. The segment's one-hot reads `segmentSlop[segment]` and
// `segmentDistance[segment]` through gather reads, once per evaluation, from
// the counters at the start of the frame. A press never sees its threshold
// change, because counters only change at a release.
//
// `adaptiveOracleFrame` is the one-event-at-a-time reference; it never calls
// circuit code.

import {invariant} from '../../../numeric-ui-core.ts'
import {allocateEventQueue, eventTimeLimit, isOnTimeGrid, type QueuedEvent} from './events.ts'
import {createKit, SourceLayout, type Term, type Wire} from './kit.ts'
import type {Population, PopulationCircuit, PopulationOracle} from './population.ts'
import {segmentCount} from './user-model.ts'
import {
  allocateWindowsCells,
  allocateWindowsConstants,
  buildFoldedWindowsFrame,
  createSectionRecorder,
  createWindowsState,
  declareWindowsOneHots,
  flattenWindowsCells,
  lastClickTimeLimit,
  validateWindowsConfig,
  windowsAgeClickTime,
  windowsDisplay,
  windowsOracleDisplay,
  windowsOracleEvent,
  windowsOracleFrameStart,
  writeWindowsConstants,
  writeWindowsState,
  type WindowsCells,
  type WindowsConfig,
  type WindowsState,
} from './windows.ts'

export const tremorCountLimit = 8
export const tremorCountThreshold = 4
export const levelCount = segmentCount - 1

export type AdaptiveTable = {
  holdWindow: number
  // Increasing whole pixels, one per boundary between segments.
  levelThresholds: readonly number[]
  segmentSlop: readonly number[]
  segmentDistance: readonly number[]
  doubleClickInterval: number
  // The segment the counters start in.
  initialSegment: number
}

export function validateAdaptiveTable(table: AdaptiveTable) {
  invariant(isOnTimeGrid(table.holdWindow) && table.holdWindow >= 0 && table.holdWindow <= eventTimeLimit, 'the hold window must sit on the 1/16 ms grid inside 0..4096')
  invariant(table.levelThresholds.length === levelCount, `one level threshold per segment boundary (${levelCount})`)
  table.levelThresholds.forEach((threshold, level) => {
    invariant(Number.isInteger(threshold) && threshold >= 1 && threshold <= 64, 'level thresholds must be whole pixels in 1..64')
    if (level > 0) invariant(threshold > table.levelThresholds[level - 1]!, 'level thresholds must increase, so the counters never cross')
  })
  invariant(table.segmentSlop.length === segmentCount && table.segmentDistance.length === segmentCount, 'one slop and one distance per segment')
  for (const value of [...table.segmentSlop, ...table.segmentDistance]) invariant(Number.isInteger(value) && value >= 0 && value <= 64, 'table values must be whole pixels in 0..64')
  invariant(Number.isInteger(table.initialSegment) && table.initialSegment >= 0 && table.initialSegment < segmentCount, 'the initial segment must exist')
}

export function initialTremorCounts(initialSegment: number) {
  return Array.from({length: levelCount}, (_, level) => (level < initialSegment ? tremorCountThreshold : tremorCountThreshold - 1))
}

export function segmentOfCounts(counts: ArrayLike<number>) {
  let segment = 0
  for (let level = 0; level < counts.length; level++) if (counts[level]! >= tremorCountThreshold) segment++
  return segment
}

export function configForSegment(config: WindowsConfig, table: AdaptiveTable, segment: number): WindowsConfig {
  return {...config, slop: table.segmentSlop[segment]!, doubleClickDistance: table.segmentDistance[segment]!, doubleClickInterval: table.doubleClickInterval}
}

// ---------------------------------------------------------------------------
// Oracle

export type AdaptiveState = {windows: WindowsState, pressTime: number, holdLevel: boolean[], tremorCount: number[]}

export function createAdaptiveState(config: WindowsConfig, table: AdaptiveTable): AdaptiveState {
  validateAdaptiveTable(table)
  return {
    windows: createWindowsState(configForSegment(config, table, table.initialSegment)),
    pressTime: -lastClickTimeLimit,
    holdLevel: Array.from({length: levelCount}, () => false),
    tremorCount: initialTremorCounts(table.initialSegment),
  }
}

export function adaptiveOracleFrame(config: WindowsConfig, table: AdaptiveTable, state: AdaptiveState, frameDelta: number, events: readonly QueuedEvent[]) {
  windowsOracleFrameStart(state.windows, frameDelta)
  state.pressTime = Math.max(state.pressTime - frameDelta, -lastClickTimeLimit)
  // The slop and distance for this frame come from the counters at its start.
  const frameConfig = configForSegment(config, table, segmentOfCounts(state.tremorCount))
  for (const event of events) {
    if (event.kind === 'down') {
      state.pressTime = event.time
      state.holdLevel.fill(false)
    } else if (event.kind === 'move') {
      if (state.windows.pressed && event.time - state.pressTime <= table.holdWindow) {
        const distance = Math.max(Math.abs(event.x - state.windows.pressX), Math.abs(event.y - state.windows.pressY))
        table.levelThresholds.forEach((threshold, level) => {
          if (distance >= threshold) state.holdLevel[level] = true
        })
      }
    } else if (event.kind === 'up' && state.windows.pressed) {
      state.tremorCount = state.tremorCount.map((count, level) => Math.min(tremorCountLimit, Math.max(0, count + (state.holdLevel[level] ? 1 : -1))))
      state.holdLevel.fill(false)
    }
    windowsOracleEvent(frameConfig, state.windows, event)
  }
  return windowsOracleDisplay(frameConfig, state.windows)
}

// ---------------------------------------------------------------------------
// Circuit

export function buildAdaptiveWindowsCircuit(config: WindowsConfig, capacity = 16, maximumDowns = 2) {
  validateWindowsConfig(config)
  const count = config.windows.length
  const layout = new SourceLayout()
  const frameDelta = layout.cell('frameDelta', 0, eventTimeLimit)
  const constants = allocateWindowsConstants(layout, count)
  const tableCells = {
    holdWindow: layout.cell('holdWindow', 0, eventTimeLimit),
    levelThresholds: layout.cells('levelThreshold', levelCount, 1, 64),
    segmentSlop: layout.cells('segmentSlop', segmentCount, 0, 64),
    segmentDistance: layout.cells('segmentDistance', segmentCount, 0, 64),
  }
  const cells = allocateWindowsCells(layout, count)
  const estimator = {
    pressTime: layout.cell('pressTime', -lastClickTimeLimit, 0),
    holdLevel: layout.cells('holdLevel', levelCount, 0, 1),
    tremorCount: layout.cells('tremorCount', levelCount, 0, tremorCountLimit),
  }
  const slots = allocateEventQueue(layout, capacity)
  const circuit = layout.createCircuit()
  const kit = createKit(circuit)
  const recorder = createSectionRecorder(kit)
  declareWindowsOneHots(kit, cells)

  recorder.mark('age the last click time and the press time')
  const initial: WindowsCells = {...cells, lastClickTime: windowsAgeClickTime(kit, cells.lastClickTime, frameDelta)}
  const pressTimeAged = windowsAgeClickTime(kit, estimator.pressTime, frameDelta)

  recorder.mark('tremor segment, selected slop and distance')
  const segmentBits = estimator.tremorCount.map(countWire => kit.atLeast([[countWire, 1]], tremorCountThreshold))
  const segmentOneHot = Array.from({length: segmentCount}, (_, segment) => {
    const terms: Term[] = []
    if (segment > 0) terms.push([segmentBits[segment - 1]!, 1])
    if (segment < levelCount) terms.push([segmentBits[segment]!, -1])
    return kit.bitAffine(terms, segment === 0 ? 1 : 0)
  })
  kit.declareOneHot(segmentOneHot, false)
  const selectedSlop = kit.dot(segmentOneHot, tableCells.segmentSlop)
  const selectedDistance = kit.dot(segmentOneHot, tableCells.segmentDistance)
  circuit.assumeRange(selectedSlop, 0, 64)
  circuit.assumeRange(selectedDistance, 0, 64)
  const frameConstants = {...constants, slop: selectedSlop, doubleClickDistance: selectedDistance}

  const folded = buildFoldedWindowsFrame(kit, frameConstants, initial, slots, maximumDowns, 'session', recorder.mark)
  const {info} = folded

  recorder.mark('tremor estimate: hold moves and the levels they reach')
  const pressTimes = info.sessions.map((session, index) => (index === 0 ? pressTimeAged : session.downTime))
  const reach = slots.map((slot, index) => {
    const pressTimeAt = kit.dot(info.sessionBits[index]!, pressTimes)
    // time - pressTime <= holdWindow, scaled by 16 so grid values are integers.
    const withinWindow = kit.atLeast([[pressTimeAt, 16], [tableCells.holdWindow, 16], [slot.time, -16]], 0)
    const holdMove = kit.atLeast([[slot.move, 1], ...info.pressedBefore[index]!, [withinWindow, 1]], 3)
    const holdDistance = kit.gated(holdMove, info.pressDistance[index]!)
    return tableCells.levelThresholds.map(threshold => kit.atLeast([[holdDistance, 1], [threshold, -1]], 0))
  })
  const sessionLevels = info.sessions.map((_, session) => tableCells.levelThresholds.map((_, level) => kit.atLeast([
    ...(session === 0 ? [[estimator.holdLevel[level]!, 1] as const] : []),
    ...slots.map((_, index) => [kit.mask(info.sessionBits[index]![session]!, reach[index]![level]!), 1] as const),
  ], 1)))

  recorder.mark('tremor estimate: counters at each release')
  let counts: Wire[] = estimator.tremorCount
  info.sessions.forEach((session, index) => {
    counts = counts.map((countWire, level) => kit.clamp(
      [[countWire, 1], [kit.gated(session.hasUp, [[sessionLevels[index]![level]!, 2]], -1), 1]],
      kit.zero,
      [[kit.one, tremorCountLimit]],
    ))
  })
  const nextHoldLevel = tableCells.levelThresholds.map((_, level) => kit.atLeast([
    [info.finalPressActive, 1],
    ...info.lastSession.map((bit, session) => [kit.mask(bit, sessionLevels[session]![level]!), 1] as const),
  ], 2))
  const nextPressTime = kit.dot(info.lastSession, pressTimes)

  recorder.mark('display (drag owner, dragged position, maximized rectangles)')
  const display = windowsDisplay(kit, constants, folded.state)
  const sections = recorder.finish()
  const stateCells = [...flattenWindowsCells(cells), estimator.pressTime, ...estimator.holdLevel, ...estimator.tremorCount]
  const roots = [
    ...flattenWindowsCells(folded.state), nextPressTime, ...nextHoldLevel, ...counts,
    ...display.rectangles.flatMap(rectangle => [rectangle.left, rectangle.top, rectangle.width, rectangle.height]),
    ...display.dragOwner,
  ]
  return {config, capacity, layout, circuit, kit, frameDelta, constants, tableCells, cells, estimator, slots, stateCells, roots, sections}
}

export type AdaptiveBuild = ReturnType<typeof buildAdaptiveWindowsCircuit>

export function writeAdaptiveTable(source: Float32Array, build: AdaptiveBuild, table: AdaptiveTable) {
  validateAdaptiveTable(table)
  writeWindowsConstants(source, build.constants, configForSegment(build.config, table, table.initialSegment))
  source[build.tableCells.holdWindow] = table.holdWindow
  table.levelThresholds.forEach((threshold, level) => {
    source[build.tableCells.levelThresholds[level]!] = threshold
  })
  table.segmentSlop.forEach((slop, segment) => {
    source[build.tableCells.segmentSlop[segment]!] = slop
    source[build.tableCells.segmentDistance[segment]!] = table.segmentDistance[segment]!
  })
}

export function writeAdaptiveState(source: Float32Array, build: AdaptiveBuild, state: AdaptiveState) {
  writeWindowsState(source, build.cells, state.windows)
  source[build.estimator.pressTime] = state.pressTime
  state.holdLevel.forEach((bit, level) => {
    source[build.estimator.holdLevel[level]!] = bit ? 1 : 0
    source[build.estimator.tremorCount[level]!] = state.tremorCount[level]!
  })
}

export function adaptivePopulationCircuit(build: AdaptiveBuild, table: AdaptiveTable): PopulationCircuit {
  return {
    label: `adaptive windows, ${build.capacity} slots`,
    config: configForSegment(build.config, table, table.initialSegment),
    circuit: build.circuit,
    layout: build.layout,
    frameDelta: build.frameDelta,
    slots: build.slots,
    cells: build.cells,
    stateCells: build.stateCells,
    roots: build.roots,
    writeShared: source => writeAdaptiveTable(source, build, table),
    writeInitialState: source => writeAdaptiveState(source, build, createAdaptiveState(build.config, table)),
  }
}

export function createAdaptiveOracle(build: AdaptiveBuild, table: AdaptiveTable): PopulationOracle {
  const state = createAdaptiveState(build.config, table)
  const scratch = new Float32Array(build.layout.size)
  const stateCount = build.stateCells.length
  const windowCount = build.config.windows.length
  return {
    frame(events, frameDelta, target) {
      const display = adaptiveOracleFrame(build.config, table, state, frameDelta, events)
      writeAdaptiveState(scratch, build, state)
      for (let index = 0; index < stateCount; index++) target[index] = scratch[build.stateCells[index]!]!
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

// Every frame over every user: counters are whole numbers in 0..8 that never
// cross, hold levels are exact bits, and how many user-frames each true tremor
// segment spends in each estimated segment.
export function createAdaptiveTracker(population: Population, build: AdaptiveBuild, trueSegmentOfUser: Uint8Array) {
  const countColumns = build.estimator.tremorCount.map(population.columnOf)
  const levelColumns = build.estimator.holdLevel.map(population.columnOf)
  const confusion = new Float64Array(segmentCount * segmentCount)
  const result = {userFrames: 0, counterViolations: 0, crossedCounters: 0, holdLevelBitErrors: 0}
  function track(recordConfusion = true) {
    const {table, width, userCount} = population
    for (let user = 0; user < userCount; user++) {
      const base = user * width
      let segment = 0
      let previous = Infinity
      for (let level = 0; level < levelCount; level++) {
        const countValue = table[base + countColumns[level]!]!
        if (!(Number.isInteger(countValue) && countValue >= 0 && countValue <= tremorCountLimit)) result.counterViolations++
        if (countValue > previous) result.crossedCounters++
        previous = countValue
        if (countValue >= tremorCountThreshold) segment++
        const bit = table[base + levelColumns[level]!]!
        if (bit !== 0 && bit !== 1) result.holdLevelBitErrors++
      }
      if (recordConfusion) confusion[trueSegmentOfUser[user]! * segmentCount + segment]!++
      result.userFrames++
    }
  }
  return {result, confusion, track}
}
