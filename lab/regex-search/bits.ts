// Bits in builder code: a boolean when builder code already knows the bit, e.g. a state that no step reaches, or a wire
// that holds exactly 0 or 1. The helpers fold known bits, so a missing step adds no operations.
import type {Circuit, Wire} from '../../src/runtime/numeric-ui-core.ts'

export type Bit = Wire | boolean

// JS: !bit, as 1 - bit, which the builder copies into the operations that read it.
export function not(circuit: Circuit, bit: Bit): Bit {
  return typeof bit === 'boolean' ? !bit : circuit.affine([[bit, -1]], 1)
}

// JS: a && b, as relu(a + b - 1).
export function and(circuit: Circuit, a: Bit, b: Bit): Bit {
  if (a === false || b === false) return false
  if (a === true) return b
  if (b === true) return a
  return circuit.reglu([], 1, [[a, 1], [b, 1]], -1)
}

// JS: a && !b, as relu(a - b).
export function andNot(circuit: Circuit, a: Bit, b: Bit): Bit {
  if (a === false || b === true) return false
  if (b === false) return a
  if (a === true) return not(circuit, b)
  return circuit.reglu([], 1, [[a, 1], [b, -1]], 0)
}

// JS: !bits.some(bit => bit), as relu(1 - sum of bits).
export function noneOf(circuit: Circuit, bits: readonly Bit[]): Bit {
  if (bits.includes(true)) return false
  const wires = bits.filter((bit): bit is Wire => typeof bit !== 'boolean')
  if (wires.length === 0) return true
  if (wires.length === 1) return not(circuit, wires[0]!)
  return circuit.reglu([], 1, wires.map(wire => [wire, -1] as const), 1)
}

// JS: a || b for two bits that are never both 1, as a + b.
export function orExclusive(circuit: Circuit, a: Bit, b: Bit): Bit {
  if (a === false) return b
  if (b === false || a === true) return a
  if (b === true) return b
  return circuit.affine([[a, 1], [b, 1]])
}

// A wire that holds the bit, for an output.
export function bitWire(circuit: Circuit, bit: Bit): Wire {
  return typeof bit === 'boolean' ? circuit.constant(bit ? 1 : 0) : bit
}
