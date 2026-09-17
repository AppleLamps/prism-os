// The clock of index.ts's render(), which counts how many 4 ms steps this frame
// runs. index.ts keeps an absolute `animatedUntilTime`, or null when nothing
// animates. The circuit keeps the same information relative to the frame:
// - leftoverMs = now - animatedUntilTime after this frame's steps
// - running = 0 when animatedUntilTime is null
// JS keeps absolute timestamps in float64, rounds them to 1/64 ms, and writes
// only this frame's delta into a cell, so every time value below is a multiple
// of 1/64 ms under 2^17 ms and exact in FP32.
import {type Circuit, type Wire, emitRelu} from '../../../../../src/runtime/numeric-ui-core.ts'
import {stepMs} from './spring-step.ts'

export const maxSteps = 300
export const timeGrid = 64
export const maxCarriedMs = 65_536

// [value >= threshold] as an exact bit, when value - threshold is a multiple of
// 1 / grid and grid * |value - threshold| stays below 2^23. Then
// k = grid * (value - threshold) is an integer, and relu(k + 1) - relu(k) is
// exactly 1 for k >= 0 and exactly 0 for k <= -1.
// The bit is kept as its own rounded wire (`roundAffine`). An ordinary `affine`
// would be copied into every sum that reads the bit, and the digit weights below
// would scale ReLU values of up to 2^16 past 2^24, where FP32 stops holding every
// integer.
export function emitAtLeastOnGrid(circuit: Circuit, value: Wire, threshold: number, grid: number): Wire {
  const reluPlusOne = circuit.reglu([], 1, [[value, grid]], 1 - grid * threshold)
  const relu = circuit.reglu([], 1, [[value, grid]], -grid * threshold)
  const bit = circuit.roundAffine([[reluPlusOne, 1], [relu, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// Binary digits of floor(value / unit), least significant first, for a
// nonnegative value on a 1/grid grid below unit * 2^digitCount. This is long
// division, most significant digit first: each digit is one threshold test on
// what's left, so the digitCount tests run one after another.
export function emitBinaryDigits(circuit: Circuit, value: Wire, unit: number, digitCount: number, grid: number): Wire[] {
  const digits = Array<Wire>(digitCount)
  let remaining = value
  for (let digit = digitCount - 1; digit >= 0; digit--) {
    const chunk = unit * 2 ** digit
    const bit = emitAtLeastOnGrid(circuit, remaining, chunk, grid)
    digits[digit] = bit
    remaining = circuit.roundAffine([[remaining, 1], [bit, -chunk]])
  }
  return digits
}

export type ClockCells = {frameDeltaMs: Wire, leftoverMs: Wire, running: Wire}

export const stepDigitCount = Math.ceil(Math.log2(maxSteps + 1))

// Call before anything reads these cells. A range declared after an operation
// already reads a wire doesn't change that operation.
export function declareClockRanges(circuit: Circuit, cells: ClockCells) {
  circuit.assumeRange(cells.frameDeltaMs, 0, maxCarriedMs)
  circuit.assumeRange(cells.leftoverMs, 0, maxCarriedMs)
  circuit.assumeRange(cells.running, 0, 1)
}

export function emitSpringClock(circuit: Circuit, cells: ClockCells) {
  const carriedMs = circuit.roundAffine([[cells.leftoverMs, 1], [cells.frameDeltaMs, 1]])
  // index.ts: `animatedUntilTime ?? now`. A clock that stopped counts no time.
  const pendingMs = circuit.multiply(carriedMs, cells.running)
  // Math.min(300, Math.floor(pending / 4)) equals Math.floor(Math.min(pending, 1200) / 4).
  const capMs = stepMs * maxSteps
  const cappedMs = circuit.roundAffine([
    [pendingMs, 1],
    [emitRelu(circuit, circuit.affine([[pendingMs, 1]], -capMs)), -1],
  ])
  const stepBits = emitBinaryDigits(circuit, cappedMs, stepMs, stepDigitCount, timeGrid)
  const stepCount = circuit.roundAffine(stepBits.map((bit, digit) => [bit, 2 ** digit]))
  const unclampedLeftoverMs = circuit.roundAffine([[pendingMs, 1], [stepCount, -stepMs]])
  const nextLeftoverMs = circuit.roundAffine([
    [unclampedLeftoverMs, 1],
    [emitRelu(circuit, circuit.affine([[unclampedLeftoverMs, 1]], -maxCarriedMs)), -1],
  ])
  circuit.assumeRange(nextLeftoverMs, 0, maxCarriedMs)
  return {stepBits, stepCount, nextLeftoverMs}
}
