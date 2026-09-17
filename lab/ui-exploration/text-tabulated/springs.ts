// Fixed-step springs as powers of one step matrix, following vibescript's Animation.md: 4ms
// semi-implicit Euler steps, a variable number of steps per frame, capped. One step on
// (displacement, velocity) is a constant 2x2 matrix M, so N steps is M^N. JS writes the bits of N
// into source cells; the circuit multiplies the selected constant powers M^(2^j) once per frame,
// and every spring with the same stiffness and damping reads that one runtime matrix.

import {emitRelu, type Circuit, type Wire} from '../../../src/runtime/numeric-ui-core.ts'

export const springStepSeconds = 0.004
export const stepBitCount = 9 // 0..511 steps; JS caps the count at 300

export type SpringConstants = {stiffness: number, damping: number}

type Matrix = [number, number, number, number]

export function stepMatrix({stiffness, damping}: SpringConstants): Matrix {
  const dt = springStepSeconds
  return [1 - stiffness * dt * dt, dt * (1 - damping * dt), -stiffness * dt, 1 - damping * dt]
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[1] * right[2], left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2], left[2] * right[1] + left[3] * right[3],
  ]
}

export function stepMatrixPowers(constants: SpringConstants): Matrix[] {
  const powers: Matrix[] = [stepMatrix(constants)]
  for (let bit = 1; bit < stepBitCount; bit++) powers.push(multiplyMatrices(powers[bit - 1]!, powers[bit - 1]!))
  return powers
}

// The runtime matrix M^N from the step bits: selected factors I + bit_j (M^(2^j) - I), multiplied
// as a balanced tree.
export function emitStepMatrix(circuit: Circuit, stepBits: readonly Wire[], constants: SpringConstants): Wire[] {
  const powers = stepMatrixPowers(constants)
  const identity = [1, 0, 0, 1]
  // Bound every entry by the largest magnitude any product of the selected powers reaches.
  let entryBound = 1
  for (let count = 0; count < 2 ** stepBitCount; count++) {
    let product: Matrix = [1, 0, 0, 1]
    for (let bit = 0; bit < stepBitCount; bit++) if ((count >> bit) & 1) product = multiplyMatrices(product, powers[bit]!)
    for (const entry of product) entryBound = Math.max(entryBound, Math.abs(entry))
  }
  entryBound = Math.ceil(entryBound * 1.01)
  let level: Wire[][] = stepBits.map((bit, index) => powers[index]!.map((entry, position) => {
    const wire = circuit.roundAffine([[bit, entry - identity[position]!]], identity[position]!)
    circuit.assumeRange(wire, -entryBound, entryBound)
    return wire
  }))
  const product = (left: Wire, right: Wire) => circuit.multiply(left, right)
  while (level.length > 1) {
    const next: Wire[][] = []
    for (let index = 0; index < level.length; index += 2) {
      const a = level[index]!
      const b = level[index + 1]
      if (b === undefined) {
        next.push(a)
        continue
      }
      const entries = [
        circuit.roundAffine([[product(a[0]!, b[0]!), 1], [product(a[1]!, b[2]!), 1]]),
        circuit.roundAffine([[product(a[0]!, b[1]!), 1], [product(a[1]!, b[3]!), 1]]),
        circuit.roundAffine([[product(a[2]!, b[0]!), 1], [product(a[3]!, b[2]!), 1]]),
        circuit.roundAffine([[product(a[2]!, b[1]!), 1], [product(a[3]!, b[3]!), 1]]),
      ]
      for (const entry of entries) circuit.assumeRange(entry, -entryBound, entryBound)
      next.push(entries)
    }
    level = next
  }
  return level[0]!
}

export const settleDistance = 0.01
export const settleSpeed = 0.01

// One spring stepped by the shared matrix, with the same settle rule as emitSpring: once distance and
// speed are both under 0.01, snap to the destination with zero velocity.
export function emitMatrixSpring(circuit: Circuit, matrix: readonly Wire[], position: Wire, velocity: Wire, destination: Wire) {
  const displacement = circuit.roundAffine([[position, 1], [destination, -1]])
  const nextDisplacement = circuit.roundAffine([[circuit.multiply(matrix[0]!, displacement), 1], [circuit.multiply(matrix[1]!, velocity), 1]])
  const nextVelocity = circuit.roundAffine([[circuit.multiply(matrix[2]!, displacement), 1], [circuit.multiply(matrix[3]!, velocity), 1]])
  const absolute = (value: Wire) => circuit.affine([[emitRelu(circuit, value), 1], [emitRelu(circuit, circuit.affine([[value, -1]])), 1]])
  const score = circuit.affine([
    [emitRelu(circuit, circuit.affine([[absolute(nextDisplacement), 1 / settleDistance]], -1)), 1],
    [emitRelu(circuit, circuit.affine([[absolute(nextVelocity), 1 / settleSpeed]], -1)), 1],
  ])
  const positive = emitRelu(circuit, score)
  const aboveOne = emitRelu(circuit, circuit.affine([[score, 1]], -1))
  const active = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(active, 0, 1)
  const nextPosition = circuit.roundAffine([[destination, 1], [circuit.multiply(nextDisplacement, active), 1]])
  return {position: nextPosition, velocity: circuit.multiply(nextVelocity, active), active}
}

// Float64 reference for the same spring, stepping one 4ms step at a time.
export function referenceSpringStep(position: number, velocity: number, destination: number, steps: number, {stiffness, damping}: SpringConstants) {
  let displacement = position - destination
  let currentVelocity = velocity
  for (let step = 0; step < steps; step++) {
    currentVelocity += (-stiffness * displacement - damping * currentVelocity) * springStepSeconds
    displacement += currentVelocity * springStepSeconds
  }
  const active = Math.min(1, Math.max(0, Math.abs(displacement) / settleDistance - 1) + Math.max(0, Math.abs(currentVelocity) / settleSpeed - 1))
  return {position: destination + displacement * active, velocity: currentVelocity * active, active}
}
