// Shader-like helpers over wires. Every helper closes over one circuit and its
// unit wire, so no call needs a circuit argument. Small affine helpers cost
// nothing at runtime: the builder composes them into their consumers.
import {
  type Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  emitSelect,
  emitSpring,
  invariant,
} from '../../../numeric-ui-core.ts'

export type Vec2 = {x: Wire, y: Wire}
export type Rect = {left: Wire, top: Wire, width: Wire, height: Wire}
// A term is a wire, a [wire, coefficient] pair, or a number added to the bias.
export type Term = Wire | readonly [Wire, number] | {readonly bias: number}
export type Struct = Wire | readonly Struct[] | {readonly [field: string]: Struct}

export type SpringParams = {
  stiffness: Wire
  damping: Wire
  timestep: Wire
  settleDistance: Wire
  settleSpeed: Wire
  settleDistanceScale: Wire
  settleSpeedScale: Wire
}

export const bias = (value: number) => ({bias: value})

export type Notation = ReturnType<typeof createNotation>

export function createNotation(circuit: Circuit, unit: Wire) {
  const zero = circuit.affine([])

  function sum(...parts: Term[]): Wire {
    let offset = 0
    const terms: [Wire, number][] = []
    for (const part of parts) {
      if (typeof part === 'number') terms.push([part, 1])
      else if ('bias' in part) offset += part.bias
      else terms.push([part[0], part[1]])
    }
    return circuit.affine(terms, offset)
  }
  const sub = (first: Wire, ...rest: Wire[]) => sum(first, ...rest.map(wire => [wire, -1] as const))
  const scale = (wire: Wire, coefficient: number) => circuit.affine([[wire, coefficient]])
  const half = (wire: Wire) => scale(wire, 0.5)
  const relu = (wire: Wire) => emitRelu(circuit, wire)
  const mul = (left: Wire, right: Wire) => emitMultiply(circuit, left, right)
  const min = (first: Wire, ...rest: Wire[]) => rest.reduce((result, wire) => emitMinimum(circuit, result, wire), first)
  const max = (first: Wire, ...rest: Wire[]) => rest.reduce((result, wire) => emitMaximum(circuit, result, wire), first)
  const clamp = (value: Wire, low: Wire, high: Wire) => min(max(value, low), high)
  const assume = (wire: Wire, minimum: number, maximum: number) => {
    circuit.assumeRange(wire, minimum, maximum)
    return wire
  }
  // `one` is the unit wire by default; pass the number 1 to put the offset in the bias instead.
  const clamp01 = (value: Wire, one: Wire | 1 = unit) =>
    assume(sum(relu(value), [relu(one === 1 ? sum(value, bias(-1)) : sub(value, one)), -1]), 0, 1)
  const not = (bit: Wire) => sub(unit, bit)
  const or = (...bits: Wire[]) => clamp01(sum(...bits))
  const constant = (value: Wire | number) => circuit.affine([], value)

  // Apply `fn` leaf by leaf over structs of the same shape.
  function zip<S extends Struct>(fn: (...leaves: Wire[]) => Wire, first: S, ...rest: S[]): S {
    if (typeof first === 'number') return fn(first, ...(rest as Wire[])) as S
    if (Array.isArray(first)) {
      return first.map((element: Struct, index) => zip(fn, element, ...rest.map(other => (other as Struct[])[index]!))) as unknown as S
    }
    const result: Record<string, Struct> = {}
    for (const field of Object.keys(first)) {
      result[field] = zip(fn, (first as Record<string, Struct>)[field]!, ...rest.map(other => (other as Record<string, Struct>)[field]!))
    }
    return result as S
  }
  const select = <S extends Struct>(bit: Wire, off: S, on: S) => zip((offLeaf, onLeaf) => emitSelect(circuit, bit, offLeaf!, onLeaf!), off, on)
  // select with a fractional t interpolates: t * on + (1 - t) * off.
  const mix = <S extends Struct>(t: Wire, from: S, to: S) => select(t, from, to)
  const minStruct = <S extends Struct>(first: S, second: S) => zip((a, b) => min(a!, b!), first, second)
  const maxStruct = <S extends Struct>(first: S, second: S) => zip((a, b) => max(a!, b!), first, second)
  const clampStruct = <S extends Struct>(value: S, low: S, high: S) => zip((v, l, h) => clamp(v!, l!, h!), value, low, high)
  const add = <S extends Struct>(first: S, second: S) => zip((a, b) => sum(a!, b!), first, second)
  const scaleStruct = <S extends Struct>(value: S, coefficient: number) => zip(leaf => scale(leaf!, coefficient), value)

  const vec2 = (x: Wire, y: Wire): Vec2 => ({x, y})
  const rect = (left: Wire, top: Wire, width: Wire, height: Wire): Rect => ({left, top, width, height})
  const right = (box: Rect) => sum(box.left, box.width)
  const bottom = (box: Rect) => sum(box.top, box.height)
  const center = (box: Rect) => vec2(sum(box.left, [box.width, 0.5]), sum(box.top, [box.height, 0.5]))
  const outset = (box: Rect, amount: Wire) =>
    rect(sub(box.left, amount), sub(box.top, amount), sum(box.width, [amount, 2]), sum(box.height, [amount, 2]))

  // Signed distance to the nearer end of [start, start + size].
  const intervalDistance = (position: Wire, start: Wire, size: Wire) => {
    const end = sum(start, size)
    return min(sub(position, start), sub(end, position))
  }
  // A bit that is 1 when the point is at least half a pixel inside the box.
  const hit = (point: Vec2, box: Rect) => circuit.boolean(clamp01(min(
    intervalDistance(point.x, box.left, box.width),
    intervalDistance(point.y, box.top, box.height),
  )))
  // The same test as one bit per axis, so rows and columns can be shared.
  const intervalHit = (position: Wire, start: Wire, size: Wire) =>
    circuit.boolean(clamp01(intervalDistance(position, start, size), 1))
  const separableHit = (point: Vec2, box: Rect) =>
    min(intervalHit(point.x, box.left, box.width), intervalHit(point.y, box.top, box.height))

  // An exact bit for a >= b when s * |a - b| stays below 2^23 and the
  // operands are at least about 2^-24 / s apart (runtime.md section 5).
  function atLeast(a: Wire, b: Wire, comparisonScale = 512) {
    const difference = circuit.roundAffine([[a, 1], [b, -1]])
    return circuit.boolean(clamp01(sum([difference, comparisonScale], bias(0.5)), 1))
  }

  // 1 / x for x within minimum..maximum (minimum >= 1). One exact threshold bit
  // per octave picks a seed within a third of the answer; each Newton step
  // y = y * (2 - x * y) squares the relative error. Cost: 4 operations per
  // octave plus 3 per step (runtime.md section 5 measured the same shape).
  function reciprocal(x: Wire, minimum: number, maximum: number, steps = 5) {
    invariant(minimum >= 1 && maximum >= minimum, 'reciprocal needs 1 <= minimum <= maximum')
    const lowOctave = Math.floor(Math.log2(minimum))
    const highOctave = Math.ceil(Math.log2(maximum))
    const seedFor = (octave: number) => 2 / 3 * 2 ** -octave
    const seedTerms: [Wire, number][] = []
    for (let octave = lowOctave + 1; octave <= highOctave; octave++) {
      // [x >= 2^octave], with the score kept as its own rounding point.
      const score = circuit.roundAffine([[x, 2 ** -octave]], -0.5)
      seedTerms.push([circuit.boolean(clamp01(score, 1)), seedFor(octave) - seedFor(octave - 1)])
    }
    let estimate = assume(circuit.affine(seedTerms, seedFor(lowOctave)), seedFor(highOctave), seedFor(lowOctave))
    for (let step = 0; step < steps; step++) {
      const correction = assume(sum(bias(2), [mul(x, estimate), -1]), 0, 2)
      estimate = assume(mul(estimate, correction), 0, 2 / minimum)
    }
    return estimate
  }

  const dot = (bits: readonly Wire[], values: readonly Wire[]) => {
    invariant(bits.length === values.length, 'dot needs equal lengths')
    return sum(...bits.map((bit, index) => mul(bit, values[index]!)))
  }
  // sum over i of bits[i] * table[i], with build-time constants in the weights.
  const lookup = (bits: readonly Wire[], table: readonly number[]) =>
    sum(...bits.map((bit, index) => [bit, table[index]!] as const))
  // bit' = bit + press * (1 - 2 * bit)
  const toggle = (bit: Wire, press: Wire) => sum(bit, mul(press, sum(unit, [bit, -2])))

  function spring(position: Wire, velocity: Wire, destination: Wire, params: SpringParams) {
    return emitSpring(
      circuit, position, destination, velocity, params.stiffness, params.damping, params.timestep,
      params.settleDistance, params.settleSpeed, params.settleDistanceScale, params.settleSpeedScale, unit,
    )
  }

  return {
    circuit, unit, zero, sum, sub, scale, half, relu, mul, min, max, clamp, clamp01, not, or, constant, assume,
    zip, select, mix, minStruct, maxStruct, clampStruct, add, scaleStruct,
    vec2, rect, right, bottom, center, outset, intervalDistance, hit, intervalHit, separableHit, atLeast,
    dot, lookup, toggle, spring, reciprocal,
    boolean: (score: Wire) => circuit.boolean(score),
    firstActive: (gate: Wire, candidates: readonly Wire[]) => emitFirstActive(circuit, gate, candidates),
    argmax: (scores: readonly Wire[]) => emitArgmax(circuit, scores, unit).selected,
  }
}

// Read a struct of wires as a struct of numbers of the same shape. Wire is a
// number type, so the result type is the struct type itself.
export function read<S>(values: Float32Array, struct: S): S {
  if (typeof struct === 'number') return values[struct]! as S
  if (Array.isArray(struct)) return struct.map(element => read(values, element)) as S
  const result: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(struct as Record<string, unknown>)) result[field] = read(values, value)
  return result as S
}
