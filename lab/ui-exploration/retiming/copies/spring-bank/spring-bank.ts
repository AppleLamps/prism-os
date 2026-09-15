// Spring bank builder: fixed-step springs with vibescript's catch-up clock,
// written as shared 2x2 matrix powers.
//
// One frame of the bank:
// 1. Clock (once per circuit). JS writes the frame delta in milliseconds,
//    rounded to a 1/64 ms grid. The circuit carries the leftover time, counts
//    steps = min(maxSteps, floor(pending / stepMs)) with exact threshold bits,
//    and writes back the new leftover. A clock that stopped last frame (nothing
//    animating) starts from zero, like `animatedUntilTime = null`.
// 2. Group (once per stiffness and damping pair). The frame matrix M^steps is
//    read from constant tables by one-hot bits of the step count, then shared by
//    every lane in the group.
// 3. Lane (per animated value). (displacement, velocity) times the frame matrix:
//    four products, each written as ReLU arms so the product is exact FP32.
// 4. Box (per animated object). One exact settle bit over all of the box's
//    lanes; when it fires, every lane lands exactly on its destination with zero
//    velocity.
import {Circuit, type Wire, invariant} from '../../../../../numeric-ui-core.ts'
import {
  type Matrix2,
  type RetargetTiming,
  type SpringClockConfig,
  type SpringConstants,
  defaultClockConfig,
  eulerStepMatrix,
  identityMatrix,
  matrixPower,
} from './spring-math.ts'

export type SpringPowers = 'binary-powers' | 'split-table' | 'source-table' | 'source-matrix'

export type WireMatrix = readonly [Wire, Wire, Wire, Wire]

// Operation index ranges created inside a labeled builder call, so reports can
// count how many live operations each part of the bank costs.
type Section = {label: string, start: number, end: number}
const sectionsByCircuit = new WeakMap<Circuit, Section[]>()

export function withSection<T>(circuit: Circuit, label: string, build: () => T): T {
  const start = circuit.operations.length
  const result = build()
  let sections = sectionsByCircuit.get(circuit)
  if (sections === undefined) {
    sections = []
    sectionsByCircuit.set(circuit, sections)
  }
  sections.push({label, start, end: circuit.operations.length})
  return result
}

export function sectionRanges(circuit: Circuit): readonly Section[] {
  return sectionsByCircuit.get(circuit) ?? []
}

// [value >= threshold] as an exact bit when value - threshold is a multiple of
// 1 / grid and grid * |value - threshold| stays below 2^22. The difference is
// scaled so a gap of one grid step moves the score by a full 0.5, then clamped
// to 0..1 and rounded by the boolean atom. Cost: 2 ReLUs and 1 boolean.
export function emitAtLeastOnGrid(circuit: Circuit, value: Wire, threshold: number, grid: number) {
  const scale = grid / 2
  const upper = circuit.reglu([], 1, [[value, scale]], 0.5 - scale * threshold)
  const lower = circuit.reglu([], 1, [[value, scale]], -0.5 - scale * threshold)
  const clamped = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

function oneHotFromThermometer(circuit: Circuit, thermometer: readonly Wire[]) {
  const bits = thermometer.map((bit, index) => {
    const next = thermometer[index + 1]
    const oneHot = next === undefined
      ? circuit.roundAffine([[bit, 1]])
      : circuit.roundAffine([[bit, 1], [next, -1]])
    circuit.assumeRange(oneHot, 0, 1)
    return oneHot
  })
  circuit.assumeOneHot(bits)
  return bits
}

// Binary digit `digit` of a thermometer count: sum over m of
// t[(2m + 1) 2^digit] - t[(2m + 2) 2^digit]. One affine row of exact bits.
function binaryDigitFromThermometer(circuit: Circuit, thermometer: readonly Wire[], digit: number) {
  const terms: [Wire, number][] = []
  for (let m = 0; ; m++) {
    const low = (2 * m + 1) * 2 ** digit
    const high = (2 * m + 2) * 2 ** digit
    if (low >= thermometer.length) break
    terms.push([thermometer[low]!, 1])
    if (high < thermometer.length) terms.push([thermometer[high]!, -1])
  }
  if (terms.length === 0) return undefined
  const bit = circuit.roundAffine(terms)
  circuit.assumeRange(bit, 0, 1)
  return bit
}

export type SpringClockCells = {
  frameDeltaMs: Wire
  leftoverMs: Wire
  running: Wire
  unit: Wire
}

export type SpringClock = {
  config: SpringClockConfig
  pendingMs: Wire
  stepCount: Wire
  nextLeftoverMs: Wire
  // stepCount = fineSteps * coarse + fine
  coarseOneHot: Wire[]
  fineOneHot: Wire[]
  // Least significant first.
  binaryDigits: Wire[]
}

export function createSpringClock(
  circuit: Circuit,
  cells: SpringClockCells,
  config: SpringClockConfig = defaultClockConfig,
): SpringClock {
  const {stepMs, maxSteps, fineSteps, timeGrid, maxFrameDeltaMs} = config
  const capMs = stepMs * maxSteps
  invariant(Number.isInteger(stepMs * timeGrid), 'the step must lie on the time grid')
  invariant(Number.isInteger(Math.log2(fineSteps)), 'fineSteps must be a power of two')
  invariant(timeGrid * capMs < 2 ** 22, 'threshold scores must stay far below 2^23')
  invariant(2 * maxFrameDeltaMs * timeGrid <= 2 ** 24, 'carried time must stay exact in FP32')
  return withSection(circuit, 'clock', () => {
    circuit.assumeRange(cells.frameDeltaMs, 0, maxFrameDeltaMs)
    circuit.assumeRange(cells.leftoverMs, 0, maxFrameDeltaMs)
    circuit.assumeRange(cells.running, 0, 1)
    // Every value below is a multiple of 1/64 ms under 2^17, so it is exact.
    const carriedMs = circuit.roundAffine([[cells.leftoverMs, 1], [cells.frameDeltaMs, 1]])
    const pendingMs = circuit.multiply(carriedMs, cells.running)
    const overCap = circuit.reglu([], 1, [[pendingMs, 1]], -capMs)
    const cappedMs = circuit.roundAffine([[pendingMs, 1], [overCap, -1]])
    circuit.assumeRange(cappedMs, 0, capMs)

    const chunkMs = stepMs * fineSteps
    const coarseCount = Math.floor(maxSteps / fineSteps)
    const coarseThermometer: Wire[] = [cells.unit]
    for (let chunk = 1; chunk <= coarseCount; chunk++) {
      coarseThermometer.push(emitAtLeastOnGrid(circuit, cappedMs, chunk * chunkMs, timeGrid))
    }
    const remainderMs = circuit.roundAffine([
      [cappedMs, 1],
      ...coarseThermometer.slice(1).map(bit => [bit, -chunkMs] as [Wire, number]),
    ])
    circuit.assumeRange(remainderMs, 0, chunkMs)
    const fineThermometer: Wire[] = [cells.unit]
    for (let step = 1; step < fineSteps; step++) {
      fineThermometer.push(emitAtLeastOnGrid(circuit, remainderMs, step * stepMs, timeGrid))
    }
    const stepCount = circuit.roundAffine([
      ...coarseThermometer.slice(1).map(bit => [bit, fineSteps] as [Wire, number]),
      ...fineThermometer.slice(1).map(bit => [bit, 1] as [Wire, number]),
    ])
    circuit.assumeRange(stepCount, 0, maxSteps)
    const unclampedLeftoverMs = circuit.roundAffine([[pendingMs, 1], [stepCount, -stepMs]])
    const overLeftover = circuit.reglu([], 1, [[unclampedLeftoverMs, 1]], -maxFrameDeltaMs)
    const nextLeftoverMs = circuit.roundAffine([[unclampedLeftoverMs, 1], [overLeftover, -1]])
    circuit.assumeRange(nextLeftoverMs, 0, maxFrameDeltaMs)

    const fineDigitCount = Math.log2(fineSteps)
    const digitCount = Math.ceil(Math.log2(maxSteps + 1))
    const binaryDigits: Wire[] = []
    for (let digit = 0; digit < digitCount; digit++) {
      const bit = digit < fineDigitCount
        ? binaryDigitFromThermometer(circuit, fineThermometer, digit)
        : binaryDigitFromThermometer(circuit, coarseThermometer, digit - fineDigitCount)
      if (bit !== undefined) binaryDigits.push(bit)
    }
    return {
      config,
      pendingMs,
      stepCount,
      nextLeftoverMs,
      coarseOneHot: oneHotFromThermometer(circuit, coarseThermometer),
      fineOneHot: oneHotFromThermometer(circuit, fineThermometer),
      binaryDigits,
    }
  })
}

export type SpringGroup = {
  frame: WireMatrix
  // Largest magnitude of any frame matrix entry this group can produce.
  bound: number
}

// Terms whose sum is exactly fround(value * gate): max(0, gate) and max(0, -gate)
// can't both be nonzero, so one ReLU arm is always an exact zero.
export function signedProductTerms(circuit: Circuit, value: Wire, gate: Wire): [Wire, number][] {
  if (circuit.isNonNegative(gate)) return [[circuit.reglu([[value, 1]], 0, [[gate, 1]], 0), 1]]
  if (circuit.isNonNegative(value)) return [[circuit.reglu([[gate, 1]], 0, [[value, 1]], 0), 1]]
  return [
    [circuit.reglu([[value, 1]], 0, [[gate, 1]], 0), 1],
    [circuit.reglu([[value, 1]], 0, [[gate, -1]], 0), -1],
  ]
}

export function emitMatrixProduct(circuit: Circuit, left: WireMatrix, right: WireMatrix): WireMatrix {
  const entry = (a: Wire, b: Wire, c: Wire, d: Wire) => circuit.roundAffine([
    ...signedProductTerms(circuit, a, b),
    ...signedProductTerms(circuit, c, d),
  ])
  return [
    entry(left[0], right[0], left[1], right[2]),
    entry(left[0], right[1], left[1], right[3]),
    entry(left[2], right[0], left[3], right[2]),
    entry(left[2], right[1], left[3], right[3]),
  ]
}

export function powerTables(constants: SpringConstants, config: SpringClockConfig) {
  const step = eulerStepMatrix(constants, config.stepMs)
  const chunk = matrixPower(step, config.fineSteps)
  const coarseCount = Math.floor(config.maxSteps / config.fineSteps)
  return {
    coarse: Array.from({length: coarseCount + 1}, (_, coarse) => matrixPower(chunk, coarse)),
    fine: Array.from({length: config.fineSteps}, (_, fine) => matrixPower(step, fine)),
  }
}

export function frameMatrixBound(constants: SpringConstants, config: SpringClockConfig) {
  const step = eulerStepMatrix(constants, config.stepMs)
  let power = identityMatrix
  let bound = 1
  for (let steps = 1; steps <= config.maxSteps; steps++) {
    power = [
      power[0] * step[0] + power[1] * step[2],
      power[0] * step[1] + power[1] * step[3],
      power[2] * step[0] + power[3] * step[2],
      power[2] * step[1] + power[3] * step[3],
    ]
    for (const entry of power) bound = Math.max(bound, Math.abs(entry))
  }
  return bound
}

function declareFrame(circuit: Circuit, frame: WireMatrix, bound: number) {
  // A little headroom for FP32 rounding in the table product.
  const limit = bound * (1 + 1e-4)
  for (const entry of frame) circuit.assumeRange(entry, -limit, limit)
}

function readConstantTable(circuit: Circuit, oneHot: readonly Wire[], table: readonly Matrix2[]): WireMatrix {
  const entry = (index: number) => circuit.roundAffine(
    oneHot
      .map((bit, row) => [bit, table[row]![index]!] as [Wire, number])
      .filter(([, coefficient]) => coefficient !== 0),
  )
  return [entry(0), entry(1), entry(2), entry(3)]
}

// A sum of one-hot bits times table cells. The compiler lowers it to one gather
// read per entry, so a runtime table costs no stored weights.
function readRuntimeTable(circuit: Circuit, oneHot: readonly Wire[], table: readonly WireMatrix[]): WireMatrix {
  const entry = (index: number) => circuit.affine(
    oneHot.map((bit, row) => [circuit.multiply(bit, table[row]![index]!), 1] as [Wire, number]),
  )
  return [entry(0), entry(1), entry(2), entry(3)]
}

export function createConstantPowerGroup(
  circuit: Circuit,
  clock: SpringClock,
  constants: SpringConstants,
  powers: 'binary-powers' | 'split-table',
): SpringGroup {
  return withSection(circuit, 'group', () => {
    const {config} = clock
    const bound = frameMatrixBound(constants, config)
    let frame: WireMatrix
    if (powers === 'split-table') {
      const tables = powerTables(constants, config)
      frame = emitMatrixProduct(
        circuit,
        readConstantTable(circuit, clock.coarseOneHot, tables.coarse),
        readConstantTable(circuit, clock.fineOneHot, tables.fine),
      )
    } else {
      const step = eulerStepMatrix(constants, config.stepMs)
      let level: WireMatrix[] = clock.binaryDigits.map((digit, index) => {
        const power = matrixPower(step, 2 ** index)
        const entry = (entryIndex: number) => circuit.affine(
          [[digit, power[entryIndex]! - identityMatrix[entryIndex]!]],
          identityMatrix[entryIndex]!,
        )
        return [entry(0), entry(1), entry(2), entry(3)]
      })
      while (level.length > 1) {
        const next: WireMatrix[] = []
        for (let index = 0; index < level.length; index += 2) {
          const right = level[index + 1]
          next.push(right === undefined ? level[index]! : emitMatrixProduct(circuit, level[index]!, right))
        }
        level = next
      }
      frame = level[0]!
    }
    declareFrame(circuit, frame, bound)
    return {frame, bound}
  })
}

export type PowerTableCells = {
  coarse: readonly WireMatrix[]
  fine: readonly WireMatrix[]
}

// JS writes M^(fineSteps * c) and M^f into source cells whenever stiffness or
// damping change; the circuit keeps the clock and reads the tables by gather.
export function createSourceTableGroup(
  circuit: Circuit,
  clock: SpringClock,
  cells: PowerTableCells,
  bound: number,
): SpringGroup {
  return withSection(circuit, 'group', () => {
    invariant(cells.coarse.length === clock.coarseOneHot.length, 'coarse table size mismatch')
    invariant(cells.fine.length === clock.fineOneHot.length, 'fine table size mismatch')
    for (const matrix of [...cells.coarse, ...cells.fine]) {
      for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
    }
    const frame = emitMatrixProduct(
      circuit,
      readRuntimeTable(circuit, clock.coarseOneHot, cells.coarse),
      readRuntimeTable(circuit, clock.fineOneHot, cells.fine),
    )
    declareFrame(circuit, frame, bound)
    return {frame, bound}
  })
}

// JS computes the step count and M^steps in float64 and writes 4 cells.
export function createSourceMatrixGroup(circuit: Circuit, cells: WireMatrix, bound: number): SpringGroup {
  for (const entry of cells) circuit.assumeRange(entry, -bound, bound)
  return {frame: cells, bound}
}

export type SpringLane = {
  group: SpringGroup
  position: Wire
  velocity: Wire
  destination: Wire
  // The destination this lane stepped toward last frame. Read only with
  // deferred retargeting.
  previousDestination: Wire
}

export type SpringBoxOptions = {
  unit: Wire
  settleDistance: Wire
  settleSpeed: Wire
  retarget: RetargetTiming
  // A bit that pins every lane to its destination this frame, e.g. while the
  // user drags the object.
  snap?: Wire
}

export type SpringBox = {
  positions: Wire[]
  velocities: Wire[]
  // Each lane's position after stepping, before the settle snap. With deferred
  // retargeting it depends only on source cells and the frame matrix, so it sits
  // early in the circuit, before any destination logic.
  steppedPositions: Wire[]
  nextPreviousDestinations: Wire[]
  settled: Wire
  active: Wire
}

export function emitSpringBox(circuit: Circuit, lanes: readonly SpringLane[], options: SpringBoxOptions): SpringBox {
  return withSection(circuit, 'box', () => {
    const exceedanceTerms: [Wire, number][] = []
    const stepped = lanes.map(lane => {
      const base = options.retarget === 'deferred' ? lane.previousDestination : lane.destination
      const displacement = circuit.affine([[lane.position, 1], [base, -1]])
      const [fromDisplacement, fromVelocity, velocityFromDisplacement, velocityFromVelocity] = lane.group.frame
      const nextDisplacement = circuit.roundAffine([
        ...signedProductTerms(circuit, displacement, fromDisplacement),
        ...signedProductTerms(circuit, lane.velocity, fromVelocity),
      ])
      const nextVelocity = circuit.roundAffine([
        ...signedProductTerms(circuit, displacement, velocityFromDisplacement),
        ...signedProductTerms(circuit, lane.velocity, velocityFromVelocity),
      ])
      const steppedPosition = circuit.affine([[base, 1], [nextDisplacement, 1]])
      // Distance from the stepped position to this frame's destination.
      const check = options.retarget === 'deferred'
        ? circuit.affine([[base, 1], [nextDisplacement, 1], [lane.destination, -1]])
        : nextDisplacement
      // relu(|x| - threshold) written as two ReLUs, so no absolute value wire.
      exceedanceTerms.push(
        [circuit.reglu([], 1, [[check, 1], [options.settleDistance, -1]], 0), 1],
        [circuit.reglu([], 1, [[check, -1], [options.settleDistance, -1]], 0), 1],
        [circuit.reglu([], 1, [[nextVelocity, 1], [options.settleSpeed, -1]], 0), 1],
        [circuit.reglu([], 1, [[nextVelocity, -1], [options.settleSpeed, -1]], 0), 1],
      )
      return {check, nextVelocity, steppedPosition}
    })
    // A sum of nonnegative FP32 terms is exactly 0 only when every term is 0, so
    // `exceedance === 0` means every lane is within both thresholds. The large
    // scale sends any positive exceedance below 0.5, and the negative side
    // saturates at 0, so no magnitude can overflow the boolean atom.
    const exceedance = circuit.affine(exceedanceTerms)
    const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
    circuit.assumeRange(settledScore, 0, 1)
    const settled = circuit.boolean(settledScore)
    const active = options.snap === undefined
      ? circuit.affine([[options.unit, 1], [settled, -1]])
      : circuit.reglu([[options.unit, 1], [settled, -1]], 0, [[options.unit, 1], [options.snap, -1]], 0)
    circuit.assumeRange(active, 0, 1)
    const positions = lanes.map((lane, index) => circuit.roundAffine([
      [lane.destination, 1],
      [circuit.reglu([[stepped[index]!.check, 1]], 0, [[active, 1]], 0), 1],
    ]))
    const velocities = stepped.map(({nextVelocity}) => circuit.reglu([[nextVelocity, 1]], 0, [[active, 1]], 0))
    return {
      positions,
      velocities,
      steppedPositions: stepped.map(({steppedPosition}) => steppedPosition),
      nextPreviousDestinations: lanes.map(lane => lane.destination),
      settled,
      active,
    }
  })
}
