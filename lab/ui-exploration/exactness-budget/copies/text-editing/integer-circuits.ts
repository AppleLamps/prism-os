// Integer building blocks for the text editing circuit. Every wire these helpers read or write
// holds an integer below 2^23 in magnitude, so every step is exact in FP32. The helpers check the
// declared ranges of their operands at build time and refuse wires that are too wide.

import {Circuit, type Terms, type Wire, invariant} from '../../../../../numeric-ui-core.ts'

const comparisonScale = 2 ** -24

// A wire the builder won't expand into its consumers: a source cell, a preserved-rounding affine,
// a reglu, a boolean, or a sum wide enough to stay shared.
function isMaterialized(circuit: Circuit, wire: Wire): boolean {
  if (wire < circuit.sourceSize) return true
  const operation = circuit.operations[wire - circuit.sourceSize]!
  return operation.kind !== 'affine' || operation.preserveRounding === true || operation.leftTerms.length >= 4
}

export function constant(circuit: Circuit, value: number): Wire {
  invariant(Number.isInteger(value), 'integer circuits only use integer constants')
  return circuit.affine([], value)
}

// [sum of coefficient * wire + bias >= 0] for integer-valued operands, as one boolean atom.
// The score is 0.5 + difference * 2^-24. The builder evaluates the bias first and then the terms in
// wire order; as long as every partial sum stays inside (-1, 1), each partial sum is a multiple of
// 2^-24 with at most 24 significant bits, so it is exact, and the atom rounds 0.5 up and
// 0.5 - 2^-24 down. For example [caret >= 7] is `atLeastZero(circuit, [[caret, 1]], -7)`.
export function atLeastZero(circuit: Circuit, terms: Terms, bias = 0): Wire {
  invariant(Number.isInteger(bias), 'comparison bias must be an integer')
  let foldedBias = bias
  const coefficients = new Map<Wire, number>()
  for (const [wire, coefficient] of terms) {
    invariant(Number.isInteger(coefficient), 'comparison coefficients must be integers')
    const constantValue = circuit.constants[wire]
    if (constantValue !== undefined) {
      foldedBias += coefficient * constantValue
      continue
    }
    invariant(isMaterialized(circuit, wire), 'comparison operands must be materialized wires')
    coefficients.set(wire, (coefficients.get(wire) ?? 0) + coefficient)
  }
  const ordered = [...coefficients].filter(([, coefficient]) => coefficient !== 0).sort(([left], [right]) => left - right)
  const scoreBias = 0.5 + foldedBias * comparisonScale
  invariant(Math.fround(scoreBias) === scoreBias && Math.abs(scoreBias) < 1, 'comparison bias is too large')
  let low = scoreBias
  let high = scoreBias
  for (const [wire, coefficient] of ordered) {
    const range = circuit.ranges[wire]!
    const first = coefficient * comparisonScale * range.minimum
    const second = coefficient * comparisonScale * range.maximum
    invariant(Number.isFinite(first) && Number.isFinite(second), 'comparison operand needs a finite range')
    low += Math.min(first, second)
    high += Math.max(first, second)
    invariant(low > -1 && high < 1, 'comparison operands are too wide for an exact boolean')
  }
  const score = circuit.affine(ordered.map(([wire, coefficient]) => [wire, coefficient * comparisonScale]), scoreBias)
  circuit.assumeRange(score, Math.max(0, Math.fround(low)), Math.min(1, Math.fround(high)))
  return circuit.boolean(score)
}

function rangeOf(circuit: Circuit, wire: Wire) {
  return circuit.ranges[wire]!
}

// bit ? on : off, for integer operands and a 0/1 bit: off + bit * (on - off), 2 atoms.
export function pick(circuit: Circuit, bit: Wire, off: Wire, on: Wire): Wire {
  if (off === on) return off
  const delta = circuit.reglu([[on, 1], [off, -1]], 0, [[bit, 1]], 0)
  const result = circuit.roundAffine([[off, 1], [delta, 1]])
  const offRange = rangeOf(circuit, off)
  const onRange = rangeOf(circuit, on)
  circuit.assumeRange(result, Math.min(offRange.minimum, onRange.minimum), Math.max(offRange.maximum, onRange.maximum))
  return result
}

export function integerMaximum(circuit: Circuit, left: Wire, right: Wire): Wire {
  const above = circuit.reglu([], 1, [[left, 1], [right, -1]], 0)
  const result = circuit.roundAffine([[right, 1], [above, 1]])
  const leftRange = rangeOf(circuit, left)
  const rightRange = rangeOf(circuit, right)
  circuit.assumeRange(result, Math.max(leftRange.minimum, rightRange.minimum), Math.max(leftRange.maximum, rightRange.maximum))
  return result
}

export function integerMinimum(circuit: Circuit, left: Wire, right: Wire): Wire {
  const above = circuit.reglu([], 1, [[left, 1], [right, -1]], 0)
  const result = circuit.roundAffine([[left, 1], [above, -1]])
  const leftRange = rangeOf(circuit, left)
  const rightRange = rangeOf(circuit, right)
  circuit.assumeRange(result, Math.min(leftRange.minimum, rightRange.minimum), Math.min(leftRange.maximum, rightRange.maximum))
  return result
}

export function andBits(circuit: Circuit, left: Wire, right: Wire): Wire {
  const result = circuit.reglu([[left, 1]], 0, [[right, 1]], 0)
  circuit.assumeRange(result, 0, 1)
  return result
}

// value * bit for a 0/1 bit, 1 atom.
export function maskValue(circuit: Circuit, value: Wire, bit: Wire): Wire {
  const result = circuit.reglu([[value, 1]], 0, [[bit, 1]], 0)
  const range = rangeOf(circuit, value)
  circuit.assumeRange(result, Math.min(0, range.minimum), Math.max(0, range.maximum))
  return result
}

export function materialize(circuit: Circuit, terms: Terms, bias: number, minimum: number, maximum: number): Wire {
  const result = circuit.roundAffine(terms, bias)
  circuit.assumeRange(result, minimum, maximum)
  return result
}

// Turns monotone bits into a one-hot group. `atLeast[j]` must be [x >= j + 1] for some integer x,
// i.e. a run of ones followed by zeros. Position k of the group is [x == k] for k = 0..atLeast.length:
// the first member is 1 - atLeast[0], the middle ones are neighbor differences, and the last is
// the last bit. The group is declared, so masked sums over it lower to gather reads.
export function oneHotFromMonotone(circuit: Circuit, atLeast: readonly Wire[]): Wire[] {
  if (atLeast.length === 0) return []
  const members: Wire[] = [circuit.roundAffine([[atLeast[0]!, -1]], 1)]
  for (let index = 1; index < atLeast.length; index++) {
    members.push(circuit.roundAffine([[atLeast[index - 1]!, 1], [atLeast[index]!, -1]]))
  }
  members.push(circuit.roundAffine([[atLeast[atLeast.length - 1]!, 1]]))
  circuit.assumeOneHot(members)
  return members
}

// One-hot group of an integer wire known to lie in 0..positions-1.
export function integerOneHot(circuit: Circuit, value: Wire, positions: number): Wire[] {
  const atLeast: Wire[] = []
  for (let position = 1; position < positions; position++) atLeast.push(atLeastZero(circuit, [[value, 1]], -position))
  return oneHotFromMonotone(circuit, atLeast)
}

// Masked read sum over a one-hot group; the compiler lowers it to a gather read.
// An empty group (a table with one position) reads the only value.
export function gather(circuit: Circuit, members: readonly Wire[], values: readonly Wire[]): Wire {
  if (members.length === 0) {
    invariant(values.length === 1, 'an empty group reads a one-entry table')
    return values[0]!
  }
  invariant(members.length === values.length, 'gather table must match the group size')
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    const range = rangeOf(circuit, value)
    minimum = Math.min(minimum, range.minimum)
    maximum = Math.max(maximum, range.maximum)
  }
  invariant(Number.isFinite(minimum) && Number.isFinite(maximum), 'gather candidates need finite ranges')
  const result = circuit.roundAffine(members.map((member, position) => [circuit.multiply(member, values[position]!), 1]))
  circuit.assumeRange(result, minimum, maximum)
  return result
}

// floor(value / 2^exponent) for an integer value in 0..2^23-1, in 3 atoms: shift by -0.5 plus half
// a grid step so no value sits on a rounding tie, then round through an offset of 2^23 + 2^22.
export function floorByPowerOfTwo(circuit: Circuit, value: Wire, exponent: number): Wire {
  const range = rangeOf(circuit, value)
  invariant(range.minimum >= 0 && range.maximum < 2 ** 23, 'floor operand must lie in 0..2^23-1')
  const shifted = circuit.roundAffine([[value, 2 ** -exponent]], -0.5 + 2 ** -(exponent + 1))
  const offset = 2 ** 23 + 2 ** 22
  const rounded = circuit.roundAffine([[shifted, 1]], offset)
  const result = circuit.roundAffine([[rounded, 1]], -offset)
  circuit.assumeRange(result, Math.floor(range.minimum / 2 ** exponent), Math.floor(range.maximum / 2 ** exponent))
  return result
}

// Bits of an integer in 0..2^bitCount-1, highest first: bit j is [remainder >= 2^j], then the
// remainder drops by bit * 2^j. Returns bits indexed by weight (bits[j] has weight 2^j).
export function integerBits(circuit: Circuit, value: Wire, bitCount: number): Wire[] {
  const bits = Array<Wire>(bitCount)
  let remainder = circuit.roundAffine([[value, 1]])
  circuit.assumeRange(remainder, 0, 2 ** bitCount - 1)
  for (let weight = bitCount - 1; weight >= 0; weight--) {
    const bit = atLeastZero(circuit, [[remainder, 1]], -(2 ** weight))
    bits[weight] = bit
    if (weight > 0) {
      remainder = materialize(circuit, [[remainder, 1], [bit, -(2 ** weight)]], 0, 0, 2 ** weight - 1)
    }
  }
  return bits
}

export function bitCountFor(maximum: number): number {
  let count = 1
  while (2 ** count <= maximum) count++
  return count
}

export type ScanStrategy = 'sklansky' | 'brent-kung'

// result[i] = combine(leaves[0], ..., leaves[i]) for an associative combine.
// Sklansky: about n log2(n) / 2 combines at depth log2(n). Brent-Kung: about 2n combines at depth
// 2 log2(n).
export function prefixScan(leaves: readonly Wire[], combine: (earlier: Wire, later: Wire) => Wire, strategy: ScanStrategy): Wire[] {
  const result = [...leaves]
  const count = leaves.length
  if (strategy === 'sklansky') {
    for (let span = 1; span < count; span *= 2) {
      for (let blockStart = 0; blockStart + span < count; blockStart += 2 * span) {
        const earlier = result[blockStart + span - 1]!
        const blockEnd = Math.min(blockStart + 2 * span, count)
        for (let index = blockStart + span; index < blockEnd; index++) result[index] = combine(earlier, result[index]!)
      }
    }
    return result
  }
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) result[index] = combine(result[index - span]!, result[index]!)
  }
  for (span = Math.floor(span / 4); span >= 1; span = Math.floor(span / 2)) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) result[index] = combine(result[index - span]!, result[index]!)
  }
  return result
}

// combine over all leaves as a balanced tree: leaves.length - 1 combines at depth log2(n).
export function tournament(leaves: readonly Wire[], combine: (left: Wire, right: Wire) => Wire): Wire {
  invariant(leaves.length > 0, 'a tournament needs at least one leaf')
  let level = [...leaves]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) next.push(index + 1 < level.length ? combine(level[index]!, level[index + 1]!) : level[index]!)
    level = next
  }
  return level[0]!
}

export function suffixScan(leaves: readonly Wire[], combine: (earlier: Wire, later: Wire) => Wire, strategy: ScanStrategy): Wire[] {
  return prefixScan([...leaves].reverse(), (later, earlier) => combine(earlier, later), strategy).reverse()
}

// One stage of a barrel shifter: bit ? moved : stay, where a missing value reads as zero.
function shiftStage(circuit: Circuit, bit: Wire, stay: Wire | null, moved: Wire | null): Wire | null {
  if (stay === null && moved === null) return null
  if (moved === null) return maskValue(circuit, stay!, circuit.affine([[bit, -1]], 1))
  if (stay === null) return maskValue(circuit, moved, bit)
  return pick(circuit, bit, stay, moved)
}

// output[i] = values[i + shift] for i in 0..outputLength-1, with values outside the array reading
// as zero. The shift is given by its bits (bits[j] has weight 2^j). Stages run from the highest bit
// down; stage j only needs outputLength + 2^j - 1 positions.
export function barrelShiftTowardStart(circuit: Circuit, values: readonly (Wire | null)[], bits: readonly Wire[], outputLength: number): (Wire | null)[] {
  let current: readonly (Wire | null)[] = values
  for (let weight = bits.length - 1; weight >= 0; weight--) {
    const span = 2 ** weight
    const length = outputLength + span - 1
    const next: (Wire | null)[] = []
    for (let position = 0; position < length; position++) {
      next.push(shiftStage(circuit, bits[weight]!, current[position] ?? null, current[position + span] ?? null))
    }
    current = next
  }
  return current.slice(0, outputLength)
}

// output[i] = values[i - shift] for i in 0..outputLength-1. Stages run from the lowest bit up, so the
// occupied part of the array grows from values.length by 2^j per stage.
export function barrelShiftTowardEnd(circuit: Circuit, values: readonly (Wire | null)[], bits: readonly Wire[], outputLength: number): (Wire | null)[] {
  let current: readonly (Wire | null)[] = values
  let occupied = values.length
  for (let weight = 0; weight < bits.length; weight++) {
    const span = 2 ** weight
    occupied = Math.min(outputLength, occupied + span)
    const next: (Wire | null)[] = []
    for (let position = 0; position < occupied; position++) {
      next.push(shiftStage(circuit, bits[weight]!, current[position] ?? null, position >= span ? current[position - span] ?? null : null))
    }
    current = next
  }
  const output = current.slice(0, outputLength)
  while (output.length < outputLength) output.push(null)
  return output
}

export type CircuitSize = {
  sources: number
  operations: number
  liveOperations: number
  affine: number
  reglu: number
  boolean: number
  layers: number
  storedWeights: number
  gatherReads: number
  gatherTableEntries: number
  widestLayer: number
}

export function measureCircuit(circuit: Circuit, roots: readonly Wire[]): CircuitSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  let gatherTableEntries = 0
  let widestLayer = 0
  let liveOperations = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    for (const read of layer.gatherReads) gatherTableEntries += read.candidatePositions.length
    widestLayer = Math.max(widestLayer, layer.outputSize)
    liveOperations += layer.outputSize
  }
  const counts = {affine: 0, reglu: 0, boolean: 0}
  const liveWires = new Set<number>()
  for (let position = circuit.sourceSize; position < program.wireOrder.length; position++) liveWires.add(program.wireOrder[position]!)
  for (const wire of liveWires) counts[circuit.operations[wire - circuit.sourceSize]!.kind]++
  return {
    sources: circuit.sourceSize,
    operations: circuit.operations.length,
    liveOperations,
    ...counts,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    gatherTableEntries,
    widestLayer,
  }
}
