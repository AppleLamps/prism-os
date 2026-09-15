// Circuit helpers shared by the walkers: a source table builder, the rounding comparison, integer
// one-hots, masked reads, and compile-time measurement.
import {Circuit, type Terms, type Wire} from '../../../numeric-ui-core.ts'

// Source cells with declared ranges. Cell 0 is always the constant 1, used as the last term of
// comparisons so that the 0.5 offset is added after large terms cancel.
export class SourceTable {
  values: number[] = []
  ranges: [number, number][] = []
  readonly unit: Wire

  constructor() {
    this.unit = this.cell(1, 1, 1)
  }

  cell(value: number, minimum: number, maximum: number): Wire {
    this.values.push(value)
    this.ranges.push([minimum, maximum])
    return this.values.length - 1
  }

  cells(values: readonly number[], minimum: number, maximum: number): Wire[] {
    return values.map(value => this.cell(value, minimum, maximum))
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

// Wires created while building integer one-hots, so reports can say how much of a circuit is
// spent turning integers into one-hot groups (the cost of reading at a computed index).
const oneHotWires = new WeakMap<Circuit, Set<Wire>>()

function recordOneHotWire(circuit: Circuit, wire: Wire): Wire {
  let wires = oneHotWires.get(circuit)
  if (wires === undefined) {
    wires = new Set()
    oneHotWires.set(circuit, wires)
  }
  wires.add(wire)
  return wire
}

// Live operations that build integer one-hots, for a compiled program.
export function countOneHotOperations(circuit: Circuit, wireOrder: ArrayLike<number>): number {
  const recorded = oneHotWires.get(circuit)
  if (recorded === undefined) return 0
  let count = 0
  for (let position = circuit.sourceSize; position < wireOrder.length; position++) {
    if (recorded.has(wireOrder[position]!)) count++
  }
  return count
}

export function relu(circuit: Circuit, terms: Terms, bias = 0): Wire {
  return circuit.reglu([], 1, terms, bias)
}

// [spanTerms <= limit + epsilon], rounded into an exact bit by the boolean atom.
// The score is 64 * (limit + epsilon - span) + 0.5, accumulated span first, then the limit, then
// the offset through the unit cell, so large prefix terms cancel before small ones are added.
// Exact whenever |limit + epsilon - span| >= 1/128 plus FP32 rounding of the terms, which holds
// for quarter-pixel spans and limits because every such difference is at least epsilon = 0.005.
// Costs 4 live operations and 3 layers: the score, two relus, and the boolean with the clamp
// composed into its terms.
export function fitBit(circuit: Circuit, unit: Wire, spanTerms: Terms, limit: Wire, epsilon: number): Wire {
  const terms: [Wire, number][] = spanTerms.map(([wire, coefficient]) => [wire, -64 * coefficient])
  terms.push([limit, 64], [unit, 64 * epsilon + 0.5])
  const score = circuit.roundAffine(terms)
  const positive = relu(circuit, [[score, 1]])
  const aboveOne = relu(circuit, [[score, 1]], -1)
  const clamped = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// [x >= threshold] for an integer-valued affine x, exact below 2^24. 2 relus, composes into consumers.
export function integerAtLeast(circuit: Circuit, terms: Terms, bias: number, threshold: number): Wire {
  const upper = relu(circuit, terms, bias - threshold + 1)
  const lower = relu(circuit, terms, bias - threshold)
  const bit = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

export type OneHot = {
  // members[p] = [x == low + p]
  members: Wire[]
  // [x >= j] as an affine form over the shared relus, for j in low..low + count.
  atLeast: (j: number) => Terms
}

// One-hot of an integer wire x over positions low..low+count-1. x must lie in low..low+count-1, or
// equal low+count when allowAllZero is set, which gives all zeros. Uses the hat function
// relu(x-p+1) - 2 relu(x-p) + relu(x-p-1), so neighboring members share relus: count relus plus
// count members, about 2 atoms per position.
export function integerOneHot(circuit: Circuit, unit: Wire, x: Wire, low: number, count: number, allowAllZero: boolean): OneHot {
  // r(j) = relu(x - j) as terms. For j <= low it is x - j itself, because x >= low.
  const relus = new Map<number, Wire>()
  const r = (j: number): Terms => {
    if (j <= low) return j === 0 ? [[x, 1]] : [[x, 1], [unit, -j]]
    let wire = relus.get(j)
    if (wire === undefined) {
      wire = recordOneHotWire(circuit, relu(circuit, [[x, 1]], -j))
      relus.set(j, wire)
    }
    return [[wire, 1]]
  }
  const scale = (terms: Terms, coefficient: number): [Wire, number][] =>
    terms.map(([wire, value]) => [wire, value * coefficient])
  const members: Wire[] = []
  for (let position = low; position < low + count; position++) {
    const member = recordOneHotWire(circuit, circuit.roundAffine([
      ...scale(r(position - 1), 1),
      ...scale(r(position), -2),
      ...scale(r(position + 1), 1),
    ]))
    circuit.assumeRange(member, 0, 1)
    members.push(member)
  }
  circuit.assumeOneHot(members, allowAllZero)
  return {
    members,
    atLeast: j => [...scale(r(j - 1), 1), ...scale(r(j), -1)],
  }
}

// Sum of bit * value over a declared one-hot group. The compiler lowers it to a gather read.
export function maskedRead(circuit: Circuit, members: readonly Wire[], values: readonly Wire[]): Wire {
  return circuit.roundAffine(members.map((bit, position) => [circuit.multiply(values[position]!, bit), 1] as const))
}

export type CircuitSize = {
  sourceCells: number
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
  gatherTableEntries: number
  oneHotOperations: number
  maximumLayerWidth: number
}

export type Compiled = {
  circuit: Circuit
  roots: Wire[]
  evaluate: (source: Float32Array) => Float32Array
  size: CircuitSize
}

export function compile(circuit: Circuit, roots: Wire[]): Compiled {
  const program = circuit.compileTensorProgram(roots)
  circuit.tensorProgram = program
  let gatherReads = 0
  let gatherTableEntries = 0
  let maximumLayerWidth = 0
  for (const layer of program.layers) {
    gatherReads += layer.gatherReads.length
    for (const read of layer.gatherReads) gatherTableEntries += read.candidatePositions.length
    maximumLayerWidth = Math.max(maximumLayerWidth, layer.outputSize)
  }
  const recorded = oneHotWires.get(circuit)
  let oneHotOperations = 0
  if (recorded !== undefined) {
    for (let position = circuit.sourceSize; position < program.wireOrder.length; position++) {
      if (recorded.has(program.wireOrder[position]!)) oneHotOperations++
    }
  }
  return {
    circuit,
    roots,
    evaluate: circuit.createTensorEvaluator(roots),
    size: {
      sourceCells: circuit.sourceSize,
      liveOperations: program.wireOrder.length - circuit.sourceSize,
      layers: program.layers.length,
      storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
      gatherReads,
      gatherTableEntries,
      oneHotOperations,
      maximumLayerWidth,
    },
  }
}

export function medianMicroseconds(run: () => void, iterations: number): number {
  const samples: number[] = []
  for (let sample = 0; sample < 5; sample++) {
    for (let warm = 0; warm < Math.min(20, iterations); warm++) run()
    const started = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  samples.sort((left, right) => left - right)
  return Number(samples[2]!.toPrecision(3))
}
