// Level 2 of three: index.ts's stepSpringTo(previous, dest, steps). Runs a
// runtime number of level 1 steps, then snaps to the destination once the spring's
// distance and speed are both within the settle thresholds.
import {type Circuit, type Wire, emitRelu, emitSelect} from '../../../../../src/runtime/numeric-ui-core.ts'
import {type RelativeSpring, type SpringConstants, emitSpringStep} from './spring-step.ts'

export type DigitOrder = 'most significant first' | 'least significant first'

// Runs `steps` level 1 steps, where steps = sum over digits of stepBits[digit] * 2^digit.
// For each binary digit, the builder writes a chain of 2^digit steps and keeps
// either the state before the chain or the state after it. The chain is affine,
// so it ends up as two affine sums however long it is, and each digit costs two
// selects.
// Every chain is a power of the same step matrix, so the digits can be applied
// in either order with the same float64 result. Most significant first lets the
// chain start as soon as the clock's long division produces its first digit,
// instead of after the division produces its last one.
export function emitSpringSteps(
  circuit: Circuit,
  spring: RelativeSpring,
  stepBits: readonly Wire[],
  constants: SpringConstants,
  digitOrder: DigitOrder = 'most significant first',
): RelativeSpring {
  const digits = Array.from(
    {length: stepBits.length},
    (_, index) => digitOrder === 'most significant first' ? stepBits.length - 1 - index : index,
  )
  let current = spring
  for (const digit of digits) {
    let advanced = current
    for (let step = 0; step < 2 ** digit; step++) advanced = emitSpringStep(circuit, advanced, constants)
    const runsThisDigit = stepBits[digit]!
    current = {
      displacement: emitSelect(circuit, runsThisDigit, current.displacement, advanced.displacement),
      velocity: emitSelect(circuit, runsThisDigit, current.velocity, advanced.velocity),
    }
  }
  return current
}

export const settleDistance = 0.01
export const settleSpeed = 0.01

export type SpringWires = {position: Wire, velocity: Wire}

export type SteppedSpring = {position: Wire, velocity: Wire, stillAnimating: Wire}

export function emitStepSpringTo(
  circuit: Circuit,
  spring: SpringWires,
  destination: Wire,
  stepBits: readonly Wire[],
  constants: SpringConstants,
  // index.ts's goToEnd, e.g. prefers-reduced-motion: land on the destination now.
  goToEnd?: Wire,
): SteppedSpring {
  const stepped = emitSpringSteps(
    circuit,
    {displacement: circuit.roundAffine([[spring.position, 1], [destination, -1]]), velocity: spring.velocity},
    stepBits,
    constants,
  )
  // index.ts: if (Math.abs(v) < 0.01 && Math.abs(dest - pos) < 0.01) { pos = dest; v = 0 }
  // Each ReLU is exactly 0 when its side is within the threshold, and a sum of
  // nonnegative FP32 values is 0 only when every term is 0.
  const exceedance = circuit.roundAffine([
    [emitRelu(circuit, circuit.affine([[stepped.displacement, 1]], -settleDistance)), 1],
    [emitRelu(circuit, circuit.affine([[stepped.displacement, -1]], -settleDistance)), 1],
    [emitRelu(circuit, circuit.affine([[stepped.velocity, 1]], -settleSpeed)), 1],
    [emitRelu(circuit, circuit.affine([[stepped.velocity, -1]], -settleSpeed)), 1],
  ])
  // A positive exceedance is at least one FP32 step of values near 0.01, about
  // 9.3e-10, so 0.5 - 2^20 * exceedance is below 0.5 and the boolean atom rounds
  // it to 0. A zero exceedance gives exactly 0.5, which rounds up to 1.
  const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
  circuit.assumeRange(settledScore, 0, 1)
  const settled = circuit.boolean(settledScore)
  let stillAnimating = circuit.roundAffine([[settled, -1]], 1)
  circuit.assumeRange(stillAnimating, 0, 1)
  if (goToEnd !== undefined) {
    const notGoingToEnd = circuit.roundAffine([[goToEnd, -1]], 1)
    circuit.assumeRange(notGoingToEnd, 0, 1)
    stillAnimating = circuit.multiply(stillAnimating, notGoingToEnd)
  }
  return {
    position: circuit.roundAffine([[destination, 1], [circuit.multiply(stepped.displacement, stillAnimating), 1]]),
    velocity: circuit.multiply(stepped.velocity, stillAnimating),
    stillAnimating,
  }
}
