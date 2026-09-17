// The executor adds each operation's terms in stored order:
//   value = f(bias); for each term: value = f(value + f(weight * input))
// where f is Math.fround. This file shows what changes when a backend adds the
// same terms in another order, fuses a product into the addition, or skips
// FP32 rounding altogether, as GPU shader compilers and parallel kernels do.
import {Circuit, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'

export type Terms = readonly (readonly [weight: number, input: number])[]

const f = Math.fround

// What the executor does.
export function addInStoredOrder(bias: number, terms: Terms): number {
  let value = f(bias)
  for (const [weight, input] of terms) value = f(value + f(f(weight) * input))
  return value
}

export function addInReversedOrder(bias: number, terms: Terms): number {
  return addInStoredOrder(bias, [...terms].reverse())
}

// A fused multiply-add: the product goes into the addition without being
// rounded first. The float64 product of two FP32 values is exact.
export function addFused(bias: number, terms: Terms): number {
  let value = f(bias)
  for (const [weight, input] of terms) value = f(value + f(weight) * input)
  return value
}

// Pairwise, like a parallel reduction: products first, then a balanced tree.
export function addBalanced(bias: number, terms: Terms): number {
  let level = [f(bias), ...terms.map(([weight, input]) => f(f(weight) * input))]
  while (level.length > 1) {
    const next: number[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? f(level[index]! + level[index + 1]!) : level[index]!)
    }
    level = next
  }
  return level[0]!
}

// Two orders of the same three terms: a spring position of 1256 px, a small
// step, and the destination 1256 px. roundAffine keeps the caller's term order.
// Source layout: position, step, destination.
export function buildTermOrders(): {circuit: Circuit, addThenSubtract: Wire, subtractThenAdd: Wire} {
  const circuit = new Circuit(3)
  for (let wire = 0; wire < 3; wire++) circuit.assumeRange(asWire(wire), -2048, 2048)
  const addThenSubtract = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), 1], [circuit.source(2), -1]])
  const subtractThenAdd = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(2), -1], [circuit.source(1), 1]])
  return {circuit, addThenSubtract, subtractThenAdd}
}

// `1 + 0.1 * count`: the executor rounds the product before adding it.
export function buildScaledCount(): {circuit: Circuit, scaled: Wire} {
  const circuit = new Circuit(1)
  circuit.assumeRange(circuit.source(0), 0, 1024)
  return {circuit, scaled: circuit.roundAffine([[circuit.source(0), 0.1]], 1)}
}

// A difference of two values has the same FP32 result in every order, with or
// without fusion: the first term enters exactly, and one addition remains.
export function buildDifference(): {circuit: Circuit, difference: Wire} {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), -16_384, 16_384)
  circuit.assumeRange(circuit.source(1), -16_384, 16_384)
  return {circuit, difference: circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), -1]])}
}

// round(x) for |x| < 2^22: FP32 values above 2^23 are whole numbers, so adding
// 2^23 + 2^22 rounds x to an integer, and subtracting it again brings the
// integer back. In float64 nothing rounds and the chain returns x.
const roundShift = 2 ** 23 + 2 ** 22

export function buildRound(): {circuit: Circuit, rounded: Wire} {
  const circuit = new Circuit(1)
  circuit.assumeRange(circuit.source(0), -(2 ** 21), 2 ** 21)
  const shifted = circuit.roundAffine([[circuit.source(0), 1]], roundShift)
  return {circuit, rounded: circuit.roundAffine([[shifted, 1]], -roundShift)}
}

export function roundInFloat32(x: number): number {
  return f(f(f(x) + roundShift) - roundShift)
}

export function roundInFloat64(x: number): number {
  return (x + roundShift) - roundShift
}
