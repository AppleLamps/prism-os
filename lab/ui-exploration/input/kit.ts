// Helpers shared by this folder's circuits. Everything lowers to the runtime's
// three atoms; numeric-ui-core.ts is imported, not changed.
//
// - Decisions are exact integer bits: for an integer-valued affine v,
//   relu(v - t + 1) - relu(v - t) is exactly [v >= t]. Coordinates, sizes,
//   ranks, counts, and times on a 1/16 ms grid (multiplied by 16) all qualify.
// - `pick(gate, off, on)` is off + relu-gated (on - off): one ReGLU, exact for a
//   0/1 gate when on - off is computed exactly (integers below 2^24).
// - `mask(bit, value)` goes through `multiply`, the shape gather lowering
//   recognizes when the bits belong to a declared one-hot group.

import {Circuit, invariant, type Wire} from '../../../numeric-ui-core.ts'

export type {Wire}
export type Term = readonly [wire: Wire, coefficient: number]
export type Expression = Wire | readonly Term[]

export function termsOf(expression: Expression): Term[] {
  return typeof expression === 'number' ? [[expression, 1]] : [...expression]
}

export function negate(expression: Expression): Term[] {
  return termsOf(expression).map(([wire, coefficient]) => [wire, -coefficient] as const)
}

export function scaled(expression: Expression, factor: number): Term[] {
  return termsOf(expression).map(([wire, coefficient]) => [wire, coefficient * factor] as const)
}

// Allocates named source cells with declared ranges, so offsets never get
// numbered by hand.
export class SourceLayout {
  names: string[] = []
  ranges: {minimum: number, maximum: number}[] = []

  get size() {
    return this.names.length
  }

  cell(name: string, minimum: number, maximum: number): Wire {
    invariant(minimum <= maximum, `range of ${name} is inverted`)
    this.names.push(name)
    this.ranges.push({minimum, maximum})
    return this.names.length - 1
  }

  cells(name: string, count: number, minimum: number, maximum: number): Wire[] {
    return Array.from({length: count}, (_, index) => this.cell(`${name}[${index}]`, minimum, maximum))
  }

  createCircuit(): Circuit {
    const circuit = new Circuit(this.size)
    this.ranges.forEach((range, wire) => circuit.assumeRange(wire, range.minimum, range.maximum))
    return circuit
  }
}

export type Kit = ReturnType<typeof createKit>

export function createKit(circuit: Circuit) {
  const one = circuit.affine([], 1)
  const zero = circuit.affine([], 0)

  function rangeOf(expression: Expression, bias = 0) {
    let minimum = bias
    let maximum = bias
    for (const [wire, coefficient] of termsOf(expression)) {
      if (coefficient === 0) continue
      const range = circuit.ranges[wire]!
      if (coefficient > 0) {
        minimum += coefficient * range.minimum
        maximum += coefficient * range.maximum
      } else {
        minimum += coefficient * range.maximum
        maximum += coefficient * range.minimum
      }
    }
    return {minimum, maximum}
  }

  function affine(expression: Expression, bias = 0): Wire {
    return circuit.affine(termsOf(expression), bias)
  }

  function bitAffine(expression: Expression, bias = 0): Wire {
    const wire = circuit.affine(termsOf(expression), bias)
    circuit.assumeRange(wire, 0, 1)
    return wire
  }

  function relu(expression: Expression, bias = 0): Wire {
    return circuit.reglu([], 1, termsOf(expression), bias)
  }

  // Exact bit of `expression >= threshold` for an integer-valued expression.
  // The bit is normally a small affine of two relus that composes into its
  // consumers. When the relus can pass 2^19, a consumer that scales the bit
  // would scale the relus too and round past 2^24, so the bit becomes its own
  // rounding point instead. Either way a consumer may scale a bit by at most
  // 16; a larger scale, e.g. `score + 2^18 * (1 - bit)`, must be written as a
  // `pick` instead (kit.test.ts shows the rounding).
  function atLeast(expression: Expression, threshold: number): Wire {
    const terms = termsOf(expression)
    const upper = circuit.reglu([], 1, terms, 1 - threshold)
    const lower = circuit.reglu([], 1, terms, -threshold)
    const gateRange = rangeOf(terms, 1 - threshold)
    const large = !(Math.max(Math.abs(gateRange.minimum), Math.abs(gateRange.maximum)) <= 2 ** 19)
    const bit = large
      ? circuit.roundAffine([[upper, 1], [lower, -1]])
      : circuit.affine([[upper, 1], [lower, -1]])
    circuit.assumeRange(bit, 0, 1)
    return bit
  }

  // Exact bit of `expression === target` for an integer-valued expression.
  function equals(expression: Expression, target: number): Wire {
    return bitAffine([[atLeast(expression, target), 1], [atLeast(expression, target + 1), -1]])
  }

  function and(bits: readonly Wire[]): Wire {
    invariant(bits.length > 0, 'and needs at least one bit')
    if (bits.length === 1) return bits[0]!
    return atLeast(bits.map(bit => [bit, 1] as const), bits.length)
  }

  function or(bits: readonly Wire[]): Wire {
    invariant(bits.length > 0, 'or needs at least one bit')
    if (bits.length === 1) return bits[0]!
    return atLeast(bits.map(bit => [bit, 1] as const), 1)
  }

  function not(bit: Wire): Wire {
    return bitAffine([[bit, -1]], 1)
  }

  // value * bit as one ReGLU, for an exact 0/1 bit.
  function gated(bit: Wire, expression: Expression, bias = 0): Wire {
    return circuit.reglu(termsOf(expression), bias, [[bit, 1]], 0)
  }

  function pick(gate: Wire, off: Expression, on: Expression): Wire {
    const offTerms = termsOf(off)
    const onTerms = termsOf(on)
    const product = circuit.reglu([...onTerms, ...negate(offTerms)], 0, [[gate, 1]], 0)
    const result = circuit.affine([...offTerms, [product, 1]])
    const offRange = rangeOf(offTerms)
    const onRange = rangeOf(onTerms)
    circuit.assumeRange(
      result,
      Math.min(offRange.minimum, onRange.minimum),
      Math.max(offRange.maximum, onRange.maximum),
    )
    return result
  }

  function pickBit(gate: Wire, off: Expression, on: Expression): Wire {
    const result = pick(gate, off, on)
    circuit.assumeRange(result, 0, 1)
    return result
  }

  function mask(bit: Wire, value: Wire): Wire {
    return circuit.multiply(bit, value)
  }

  function dot(bits: readonly Wire[], values: readonly Wire[]): Wire {
    invariant(bits.length === values.length, 'dot needs equal lengths')
    return circuit.affine(bits.map((bit, index) => [mask(bit, values[index]!), 1] as const))
  }

  function sum(wires: readonly Wire[]): Term[] {
    return wires.map(wire => [wire, 1] as const)
  }

  function absolute(expression: Expression): Wire {
    const terms = termsOf(expression)
    const range = rangeOf(terms)
    const result = circuit.affine([[relu(terms), 1], [relu(negate(terms)), 1]])
    circuit.assumeRange(result, 0, Math.max(Math.abs(range.minimum), Math.abs(range.maximum)))
    return result
  }

  // b + relu(a - b); exact for integers below 2^23.
  function maximum(a: Expression, b: Expression): Wire {
    const bTerms = termsOf(b)
    const result = circuit.affine([...bTerms, [relu([...termsOf(a), ...negate(bTerms)]), 1]])
    const aRange = rangeOf(a)
    const bRange = rangeOf(bTerms)
    circuit.assumeRange(
      result,
      Math.max(aRange.minimum, bRange.minimum),
      Math.max(aRange.maximum, bRange.maximum),
    )
    return result
  }

  // a - relu(a - b); exact for integers below 2^23.
  function minimum(a: Expression, b: Expression): Wire {
    const aTerms = termsOf(a)
    const result = circuit.affine([...aTerms, [relu([...aTerms, ...negate(b)]), -1]])
    const aRange = rangeOf(aTerms)
    const bRange = rangeOf(b)
    circuit.assumeRange(
      result,
      Math.min(aRange.minimum, bRange.minimum),
      Math.min(aRange.maximum, bRange.maximum),
    )
    return result
  }

  // min(max(value, low), high), the same order as the oracles.
  function clamp(value: Expression, low: Expression, high: Expression): Wire {
    return minimum(maximum(value, low), high)
  }

  function chebyshev(dx: Expression, dy: Expression): Wire {
    return maximum(absolute(dx), absolute(dy))
  }

  // Declares a one-hot group when the members are distinct wires. Callers only
  // declare groups that are exact by construction; tests check them with
  // validateOneHotGroups.
  function declareOneHot(members: readonly Wire[], allowAllZero: boolean) {
    if (members.length < 2) return
    if (new Set(members).size !== members.length) return
    for (const member of members) {
      if (circuit.constants[member] !== undefined) return
    }
    circuit.assumeOneHot(members, allowAllZero)
  }

  // Argmin over integer-valued scores with ties going to the lower index. The
  // selection is an exact one-hot by construction.
  function argminInteger(scores: readonly Expression[]): {selected: Wire[], score: Wire} {
    invariant(scores.length > 0, 'argmin needs at least one score')
    type Node = {score: Expression, item: number} | {score: Wire, leftWins: Wire, left: Node, right: Node}
    let level: Node[] = scores.map((score, item) => ({score, item}))
    while (level.length > 1) {
      const next: Node[] = []
      for (let index = 0; index < level.length; index += 2) {
        const left = level[index]!
        const right = level[index + 1]
        if (right === undefined) {
          next.push(left)
          continue
        }
        const leftWins = atLeast([...termsOf(right.score), ...negate(left.score)], 0)
        next.push({score: pick(leftWins, right.score, left.score), leftWins, left, right})
      }
      level = next
    }
    const selected = Array<Wire>(scores.length)
    const route = (node: Node, mass: Wire | null) => {
      if (!('leftWins' in node)) {
        selected[node.item] = mass ?? one
        return
      }
      const leftMass = mass === null ? node.leftWins : mask(mass, node.leftWins)
      const rightMass = bitAffine(mass === null ? [[node.leftWins, -1]] : [[mass, 1], [leftMass, -1]], mass === null ? 1 : 0)
      route(node.left, leftMass)
      route(node.right, rightMass)
    }
    const root = level[0]!
    route(root, null)
    declareOneHot(selected, false)
    return {selected, score: typeof root.score === 'number' ? root.score : affine(root.score)}
  }

  return {
    circuit,
    one,
    zero,
    rangeOf,
    affine,
    bitAffine,
    relu,
    atLeast,
    equals,
    and,
    or,
    not,
    gated,
    pick,
    pickBit,
    mask,
    dot,
    sum,
    absolute,
    maximum,
    minimum,
    clamp,
    chebyshev,
    declareOneHot,
    argminInteger,
  }
}

// A Sklansky parallel prefix: outputs[i] = items[0] ∘ ... ∘ items[i] for an
// associative combine, at ceil(log2 n) combine levels.
export function sklanskyPrefix<T>(items: readonly T[], combine: (earlier: T, later: T) => T): T[] {
  const outputs = [...items]
  for (let size = 1; size < items.length; size *= 2) {
    for (let block = 0; block < items.length; block += 2 * size) {
      const middle = block + size - 1
      for (let index = middle + 1; index < Math.min(block + 2 * size, items.length); index++) {
        outputs[index] = combine(outputs[middle]!, outputs[index]!)
      }
    }
  }
  return outputs
}

export type ProgramMeasure = {
  liveOperations: number
  affine: number
  reglu: number
  boolean: number
  layers: number
  weights: number
  widestLayer: number
  gatherReads: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramMeasure {
  const program = circuit.compileTensorProgram(roots)
  const counts = {affine: 0, reglu: 0, boolean: 0}
  for (let position = circuit.sourceSize; position < program.wireOrder.length; position++) {
    const kind = circuit.operations[program.wireOrder[position]! - circuit.sourceSize]!.kind
    if (kind === 'index') throw new Error('measureProgram counts affine, reglu and boolean operations only')
    counts[kind]++
  }
  return {
    liveOperations: program.wireOrder.length - circuit.sourceSize,
    ...counts,
    layers: program.layers.length,
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    widestLayer: Math.max(0, ...program.layers.map(layer => layer.outputSize)),
    gatherReads: program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0),
  }
}

// Reads an exact 0/1 bit, failing on anything else.
export function readBit(value: number, label: string): boolean {
  invariant(value === 0 || value === 1, `${label} is not an exact bit: ${value}`)
  return value === 1
}

// Reads a one-hot group of exact bits into an index, -1 when all zero.
export function readOneHot(values: ArrayLike<number>, wires: readonly Wire[], label: string): number {
  let found = -1
  for (let index = 0; index < wires.length; index++) {
    if (readBit(values[wires[index]!]!, `${label}[${index}]`)) {
      invariant(found === -1, `${label} has more than one active bit`)
      found = index
    }
  }
  return found
}

// Seeded pseudo-random numbers for traces (mulberry32).
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function randomInteger(random: () => number, minimum: number, maximum: number) {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}
