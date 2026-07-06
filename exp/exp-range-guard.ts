// Prototype: a compile-time magnitude guard for the re-rounding macros, built
// on the range system already in numeric-ui-core.ts (ranges / assumeRange).
// Policy: flag a macro input ONLY when its proven range is finite AND exceeds
// the safe band; stay silent when the range is unknown, so experiments need not
// annotate every source. This is a non-invasive prototype — the macros here
// wrap (or re-derive) the real ones without touching core. See macro-ranges.md.
import {
  Circuit,
  type Wire,
  emitMaximum,
  emitMinimum,
  emitRelu,
  emitSelect,
  invariant,
} from '../numeric-ui-core.ts'

// Largest value below which every integer is exactly representable in FP32.
export const integerExactLimit = 2 ** 24
// Conservative operand bound for the `b + relu(a - b)` reconstruction forms, so
// the difference stays under integerExactLimit and never re-rounds.
export const binarySafeLimit = 2 ** 23

// A wire's proven magnitude bound, or null when its range is unbounded/unknown.
function knownMagnitude(circuit: Circuit, wire: Wire): number | null {
  const range = circuit.ranges[wire]!
  if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)) return null
  return Math.max(Math.abs(range.minimum), Math.abs(range.maximum))
}

function guardBinary(circuit: Circuit, label: string, ...inputs: readonly Wire[]) {
  for (const wire of inputs) {
    const magnitude = knownMagnitude(circuit, wire)
    invariant(
      magnitude === null || magnitude < binarySafeLimit,
      `${label}: input wire ${wire} can reach ${magnitude} (>= 2**23); the `
        + 'b + relu(a - b) reconstruction will re-round. Scale the operand down.',
    )
  }
}

export function emitMaximumGuarded(circuit: Circuit, a: Wire, b: Wire): Wire {
  guardBinary(circuit, 'emitMaximum', a, b)
  return emitMaximum(circuit, a, b)
}

export function emitMinimumGuarded(circuit: Circuit, a: Wire, b: Wire): Wire {
  guardBinary(circuit, 'emitMinimum', a, b)
  return emitMinimum(circuit, a, b)
}

export function emitSelectGuarded(circuit: Circuit, gate: Wire, off: Wire, on: Wire): Wire {
  // The off = 0 rail reconstructs `on` exactly at any magnitude, so skip the
  // check when off is provably zero; otherwise both rails can re-round.
  const offRange = circuit.ranges[off]!
  const offIsZero = offRange.minimum === 0 && offRange.maximum === 0
  if (!offIsZero) guardBinary(circuit, 'emitSelect', off, on)
  return emitSelect(circuit, gate, off, on)
}

export function emitClampZeroOneGuarded(circuit: Circuit, value: Wire, unit: Wire): Wire {
  const range = circuit.ranges[value]!
  invariant(
    !Number.isFinite(range.maximum) || range.maximum <= integerExactLimit,
    `emitClampZeroOne: input wire ${value} can reach ${range.maximum} (> 2**24); `
      + 'relu(v) - relu(v - 1) will re-round (returns 2, then 0). Scale it down.',
  )
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}
