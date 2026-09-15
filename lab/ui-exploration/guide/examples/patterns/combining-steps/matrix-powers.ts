// A spring's fixed 4 ms steps as powers of one 2×2 matrix, over the repo root runtime
// and host-timing.ts. One semi-implicit Euler step with constant stiffness and damping
// is a matrix M on (displacement from the destination, velocity), so n steps are M^n.
// Three builds that apply the same runtime number of steps, for springs that share
// stiffness and damping:
// - 'host matrix': JavaScript computes M^steps in float64 with springMatrixPower and
//   writes its 4 entries into cells, which Cheng made the default on September 14, 2026.
// - 'digit powers': JavaScript writes the step count, the circuit extracts its binary
//   digits, each digit picks M^(2^digit) or the identity, and a balanced tree of 2×2
//   products multiplies the picked factors.
// - 'table of powers': JavaScript writes M^0 to M^300 into cells once per stiffness and
//   damping pair, and index reads pick M^i at a computed step count, e.g. to sample
//   where a spring will be i steps from now.
import {Circuit, type SpringMatrixWires, type Wire, emitApplySpringMatrix, emitCompare} from '../../../../../../numeric-ui-core.ts'
import {
  type SpringConstants,
  type SpringMatrix,
  defaultSpringClockConfig,
  identitySpringMatrix,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
} from '../../../../../../host-timing.ts'

// index.ts's default spring.
export const springConstants: SpringConstants = {stiffness: 290, damping: 30}
// A frame runs at most 300 steps, host-timing.ts's maxStepsPerFrame.
export const maxSteps = defaultSpringClockConfig.maxStepsPerFrame
// 2^9 = 512 > 300, so 9 binary digits hold every step count.
export const stepDigitCount = 9
export const displacementLimit = 2 ** 16
export const velocityLimit = 2 ** 20

// index.ts's stepSpringTo loop in float64, with the destination at 0, so the position
// is the displacement.
export function stepSpringLoop(displacement: number, velocity: number, steps: number, constants: SpringConstants) {
  const t = defaultSpringClockConfig.stepMs / 1000
  let pos = displacement
  let v = velocity
  for (let i = 0; i < steps; i++) {
    const springForce = -constants.stiffness * pos
    const damperForce = -constants.damping * v
    v += (springForce + damperForce) * t
    pos += v * t
  }
  return {displacement: pos, velocity: v}
}

export type SpringCells = {displacement: Wire, velocity: Wire}

function declareSprings(circuit: Circuit, firstCell: number, springCount: number): SpringCells[] {
  return Array.from({length: springCount}, (_, spring) => {
    const cells = {displacement: firstCell + 2 * spring, velocity: firstCell + 2 * spring + 1}
    circuit.assumeRange(cells.displacement, -displacementLimit, displacementLimit)
    circuit.assumeRange(cells.velocity, -velocityLimit, velocityLimit)
    return cells
  })
}

function roots(circuit: Circuit, matrix: SpringMatrixWires, springs: readonly SpringCells[]): Wire[] {
  return springs.flatMap(spring => {
    const stepped = emitApplySpringMatrix(circuit, matrix, spring.displacement, spring.velocity)
    return [stepped.displacement, stepped.velocity]
  })
}

// Cells: the 4 matrix entries, then each spring's displacement and velocity.
export function buildHostMatrix(springCount: number) {
  const circuit = new Circuit(4 + 2 * springCount)
  const matrix: SpringMatrixWires = [0, 1, 2, 3]
  const bound = springMatrixBound(springConstants)
  for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
  const springs = declareSprings(circuit, 4, springCount)
  return {circuit, matrix, springs, roots: roots(circuit, matrix, springs)}
}

function emitMatrixProduct(circuit: Circuit, left: SpringMatrixWires, right: SpringMatrixWires): SpringMatrixWires {
  const entry = (a: Wire, b: Wire, c: Wire, d: Wire) =>
    circuit.roundAffine([[circuit.multiply(a, b), 1], [circuit.multiply(c, d), 1]])
  return [
    entry(left[0], right[0], left[1], right[2]),
    entry(left[0], right[1], left[1], right[3]),
    entry(left[2], right[0], left[3], right[2]),
    entry(left[2], right[1], left[3], right[3]),
  ]
}

// M^steps from the step count's binary digits.
export function emitDigitPowers(circuit: Circuit, stepCount: Wire, constants: SpringConstants) {
  // Long division from the top digit: digit d is [remaining >= 2^d], and remaining loses
  // 2^d when the digit is 1. The step count is declared on a grid of 1, so emitCompare
  // builds integer bits.
  const digits: Wire[] = Array<Wire>(stepDigitCount)
  let remaining = stepCount
  for (let digit = stepDigitCount - 1; digit >= 0; digit--) {
    const bit = emitCompare(circuit, remaining, '>=', circuit.affine([], 2 ** digit))
    digits[digit] = bit
    remaining = circuit.roundAffine([[remaining, 1], [bit, -(2 ** digit)]])
  }
  // Factor d is M^(2^d) when digit d is 1 and the identity when it's 0, i.e.
  // I + digit × (M^(2^d) - I), with the powers computed in float64 while building.
  const step = springStepMatrix(constants)
  let level: SpringMatrixWires[] = digits.map((digit, index) => {
    const power = springMatrixPower(step, 2 ** index)
    const entry = (entryIndex: 0 | 1 | 2 | 3) =>
      circuit.roundAffine([[digit, power[entryIndex] - identitySpringMatrix[entryIndex]]], identitySpringMatrix[entryIndex])
    return [entry(0), entry(1), entry(2), entry(3)]
  })
  // A balanced tree of 2×2 products. Powers of one matrix commute, so any grouping and
  // order give the same real matrix, and FP32 rounds each grouping differently.
  while (level.length > 1) {
    const next: SpringMatrixWires[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : emitMatrixProduct(circuit, level[index]!, right))
    }
    level = next
  }
  return {digits, matrix: level[0]!}
}

// Cells: the step count, then each spring's displacement and velocity.
export function buildDigitPowers(springCount: number) {
  const circuit = new Circuit(1 + 2 * springCount)
  const stepCount = 0
  circuit.assumeRange(stepCount, 0, maxSteps)
  circuit.assumeGrid(stepCount, 1)
  const {digits, matrix} = emitDigitPowers(circuit, stepCount, springConstants)
  const springs = declareSprings(circuit, 1, springCount)
  return {circuit, stepCount, digits, matrix, springs, roots: roots(circuit, matrix, springs)}
}

export const tableSampleCount = maxSteps + 1

// Cells: the sample's step count, then 4 runs of 301 cells holding entry 0, 1, 2 and 3
// of M^0 to M^300, then one spring's displacement and velocity. Each run is a column of
// source cells, so every index read stores a base position and a stride.
export function buildTableOfPowers() {
  const circuit = new Circuit(1 + 4 * tableSampleCount + 2)
  const sampleSteps = 0
  circuit.assumeRange(sampleSteps, 0, maxSteps)
  const bound = springMatrixBound(springConstants)
  const entryTables = [0, 1, 2, 3].map(entry =>
    Array.from({length: tableSampleCount}, (_, steps) => 1 + entry * tableSampleCount + steps))
  for (const table of entryTables) {
    for (const cell of table) circuit.assumeRange(cell, -bound, bound)
  }
  const read = (entry: number) => circuit.indexRead(sampleSteps, entryTables[entry]!)
  const matrix: SpringMatrixWires = [read(0), read(1), read(2), read(3)]
  const springs = declareSprings(circuit, 1 + 4 * tableSampleCount, 1)
  return {circuit, sampleSteps, matrix, springs, roots: roots(circuit, matrix, springs)}
}

// What the host writes into the table's cells, once per stiffness and damping pair.
export function writeTableOfPowers(source: Float32Array, constants: SpringConstants) {
  const step = springStepMatrix(constants)
  let power: SpringMatrix = identitySpringMatrix
  for (let steps = 0; steps < tableSampleCount; steps++) {
    if (steps > 0) power = springMatrixPower(step, steps)
    for (let entry = 0; entry < 4; entry++) source[1 + entry * tableSampleCount + steps] = power[entry]!
  }
}
