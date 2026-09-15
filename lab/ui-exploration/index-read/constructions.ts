// Building blocks the workloads share: the two relu one-hot styles phase 1
// used, the masked read, comparisons, and an exact integer floor division.
import {Circuit, type Terms, type Wire} from './numeric-ui-core.ts'

export function emitReluForm(circuit: Circuit, terms: Terms, bias = 0): Wire {
  return circuit.reglu([], 1, terms, bias)
}

// [x >= threshold] for an integer x = terms + bias, written as
// relu(x - threshold + 1) - relu(x - threshold). Exact for integers below 2^23.
export function emitIntegerAtLeast(circuit: Circuit, terms: Terms, bias: number, threshold: number): Wire {
  const upper = emitReluForm(circuit, terms, bias - threshold + 1)
  const lower = emitReluForm(circuit, terms, bias - threshold)
  const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// Integer one-hot of x = terms + bias over positions 0..size-1, as phase 1's
// pretext circuits build it: member 0 is 1 for every x <= 0, member p is
// [x >= p] - [x >= p + 1], and every member is 0 once x >= size. Declared as a
// group; allowAllZero when x may reach size.
export function emitIntegerOneHot(
  circuit: Circuit,
  terms: Terms,
  bias: number,
  size: number,
  allowAllZero: boolean,
): Wire[] {
  const atLeast: Wire[] = []
  for (let threshold = 1; threshold <= size; threshold++) {
    atLeast.push(emitIntegerAtLeast(circuit, terms, bias, threshold))
  }
  const members: Wire[] = []
  for (let position = 0; position < size; position++) {
    const above = atLeast[position]!
    const member = position === 0
      ? circuit.roundAffine([[above, -1]], 1)
      : circuit.roundAffine([[atLeast[position - 1]!, 1], [above, -1]])
    circuit.assumeRange(member, 0, 1)
    members.push(member)
  }
  circuit.assumeOneHot(members, allowAllZero)
  return members
}

// Integer one-hot of one wire over 0..size-1, as phase 1's constructions.ts
// builds it for values[index]: [x >= v] for v = 1..size-1 from plain affine
// relu differences, with constant ends, so x <= 0 selects member 0 and
// x >= size - 1 selects the last member.
export function emitClampedOneHot(circuit: Circuit, index: Wire, size: number): Wire[] {
  const atLeast: Wire[] = [circuit.affine([], 1)]
  for (let value = 1; value < size; value++) {
    const difference = circuit.affine([[index, 1]], 1 - value)
    const bit = circuit.affine([
      [emitReluForm(circuit, [[difference, 1]]), 1],
      [emitReluForm(circuit, [[difference, 1]], -1), -1],
    ])
    circuit.assumeRange(bit, 0, 1)
    atLeast.push(bit)
  }
  atLeast.push(circuit.affine([], 0))
  const members = Array.from({length: size}, (_, value) =>
    circuit.roundAffine([[atLeast[value]!, 1], [atLeast[value + 1]!, -1]]))
  circuit.assumeOneHot(members)
  return members
}

// The sum of bit * value over a one-hot group, kept as its own rounding point.
export function emitMaskedRead(circuit: Circuit, members: readonly Wire[], values: readonly Wire[]): Wire {
  return circuit.roundAffine(members.map((bit, position) =>
    [circuit.multiply(values[position]!, bit), 1] as const))
}

export function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitReluForm(circuit, [[value, 1]])
  const aboveOne = emitReluForm(circuit, [[value, 1]], -1)
  const result = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// [d >= 0] for d = terms + bias through the boolean atom: exact when d is 0 or
// |d| >= 1 / (2 * scale), ignoring FP32 rounding of d itself.
export function emitAtLeastZeroRounding(circuit: Circuit, terms: Terms, bias: number, scale = 64): Wire {
  const score = circuit.roundAffine(
    terms.map(([wire, coefficient]) => [wire, coefficient * scale] as const),
    bias * scale + 0.5,
  )
  return circuit.boolean(emitClampZeroOne(circuit, score))
}

// FP32 steps are exactly 1 in [2^23, 2^24), so adding this base and removing it
// rounds to the nearest integer, ties to even. Exact for |x| < 2^22.
const roundingBase = 2 ** 23 + 2 ** 22

export function emitRound(circuit: Circuit, value: Wire): Wire {
  const shifted = circuit.roundAffine([[value, 1]], roundingBase)
  return circuit.roundAffine([[shifted, 1]], -roundingBase)
}

// floor(numerator / divisor) for an integer numerator in 0..2^21 and a positive
// integer divisor known at build time. The rounded approximate quotient is off
// by at most one, and the sign of the exact integer remainder corrects it.
export function emitFloorDivide(circuit: Circuit, numerator: Wire, divisor: number): Wire {
  const quotient = emitRound(circuit, circuit.roundAffine([[numerator, 1 / divisor]]))
  const remainder = circuit.roundAffine([[numerator, 1], [quotient, -divisor]])
  const negative = emitIntegerAtLeast(circuit, [[remainder, -1]], 0, 1)
  return circuit.roundAffine([[quotient, 1], [negative, -1]])
}

// A max tournament, log depth.
export function emitMaximumTournament(
  values: readonly Wire[],
  maximum: (left: Wire, right: Wire) => Wire,
): Wire {
  let level = [...values]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? maximum(level[index]!, level[index + 1]!) : level[index]!)
    }
    level = next
  }
  return level[0]!
}

// Source cells with ranges, allocated one at a time.
export class SourceLayout {
  values: number[] = []
  ranges: [number, number][] = []

  cell(value: number, minimum: number, maximum: number): Wire {
    this.values.push(value)
    this.ranges.push([minimum, maximum])
    return this.values.length - 1
  }

  cells(count: number, value: (index: number) => number, minimum: number, maximum: number): Wire[] {
    return Array.from({length: count}, (_, index) => this.cell(value(index), minimum, maximum))
  }

  createCircuit(): Circuit {
    const circuit = new Circuit(this.values.length)
    for (let wire = 0; wire < this.values.length; wire++) {
      circuit.assumeRange(wire, this.ranges[wire]![0], this.ranges[wire]![1])
    }
    return circuit
  }

  table(): Float32Array {
    return Float32Array.from(this.values)
  }
}
