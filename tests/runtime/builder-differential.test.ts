import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Terms,
  type Wire,
  invariant,
  validateCircuit,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'

// Differential oracle for the builder's emit-time rewrites.
//
// The existing random-circuit test compares evaluateReference against
// evaluateTensor, but BOTH run the same already-rewritten operation stream. A
// sign bug inside term merging, constant folding, affine-into-affine
// composition, or constant-gate reglu demotion produces a wrong program that
// both evaluators execute identically, so that oracle cannot see it.
//
// This file records, for every emitted operation, the INTENDED expression as a
// naive tree BEFORE Circuit rewrites it, then evaluates that tree in plain
// float64 with no folding, no composition, no dedup, and no normalization. The
// naive value is compared against circuit.evaluateReference, which is the
// declared ground truth. Rewrites legally change FP32 rounding, so the
// continuous comparison uses a relative tolerance with an absolute floor for
// near-zero values. Boolean atoms produce exact bits and are compared exactly.

type ShadowKind = 'affine' | 'reglu' | 'boolean'

type ShadowOp = {
  kind: ShadowKind
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
  // The wire Circuit returned for this emit. Aliasing and deduplication can
  // make this point at an earlier wire; the recorded intent is then equivalent
  // to whatever already lives there, so writing its value is consistent.
  wire: Wire
}

// A circuit paired with a shadow recorder. Every emit goes through these
// wrappers so the naive intent is captured at the same instant Circuit sees it.
class ShadowCircuit {
  circuit: Circuit
  ops: ShadowOp[]

  constructor(sourceSize: number) {
    this.circuit = new Circuit(sourceSize)
    this.ops = []
  }

  affine(terms: Terms, bias: number): Wire {
    const wire = this.circuit.affine(terms, bias)
    this.ops.push({kind: 'affine', leftTerms: terms, leftBias: bias, gateTerms: [], gateBias: 0, wire})
    return wire
  }

  reglu(leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
    const wire = this.circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)
    this.ops.push({kind: 'reglu', leftTerms, leftBias, gateTerms, gateBias, wire})
    return wire
  }

  boolean(value: Wire): Wire {
    const wire = this.circuit.boolean(value)
    this.ops.push({kind: 'boolean', leftTerms: [[value, 1]], leftBias: 0, gateTerms: [], gateBias: 0, wire})
    return wire
  }
}

// Evaluate one naive affine form in float64: bias + sum(coefficient * value).
// No FP32 rounding, no term merging, no constant folding, no composition. Terms
// are summed in the exact order the caller supplied them.
function evaluateNaiveAffine(terms: Terms, bias: number, values: Map<Wire, number>): number {
  let value = bias
  for (const [wire, coefficient] of terms) {
    const operand = values.get(wire)
    invariant(operand !== undefined, 'shadow read a wire with no recorded value')
    value += coefficient * operand
  }
  return value
}

// Replays the recorded intent in float64. Booleans round exactly with the same
// 0.5-rounds-up rule the reference uses so their bits can be compared exactly.
function evaluateShadow(shadow: ShadowCircuit, source: Float32Array): Map<Wire, number> {
  const values = new Map<Wire, number>()
  for (let wire = 0; wire < source.length; wire++) values.set(asWire(wire), source[wire]!)
  for (const op of shadow.ops) {
    const left = evaluateNaiveAffine(op.leftTerms, op.leftBias, values)
    let value: number
    if (op.kind === 'affine') {
      value = left
    } else if (op.kind === 'reglu') {
      value = left * Math.max(0, evaluateNaiveAffine(op.gateTerms, op.gateBias, values))
    } else {
      // Exact 0/1 rounding; the score is provably within zero and one.
      value = left < 0.5 ? 0 : 1
    }
    values.set(op.wire, value)
  }
  return values
}

// Continuous wires agree up to FP32 rounding drift; boolean wires agree exactly.
function closeEnough(naive: number, reference: number, isBoolean: boolean): boolean {
  if (isBoolean) return naive === reference
  const difference = Math.abs(naive - reference)
  if (difference <= 1e-4) return true
  return difference <= 1e-4 * Math.max(Math.abs(naive), Math.abs(reference))
}

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

// Small coefficients keep magnitudes modest across deep composition chains so
// that the absolute-tolerance floor is meaningful rather than swamped by drift.
function randomCoefficient(random: () => number) {
  return [-1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2][randomInteger(random, 8)]!
}

function randomBias(random: () => number) {
  return [-2, -1, -0.5, 0, 0.5, 1, 2][randomInteger(random, 7)]!
}

function randomTerms(random: () => number, wires: readonly Wire[], maxTerms: number): Terms {
  return Array.from(
    {length: randomInteger(random, maxTerms + 1)},
    () => [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)] as const,
  )
}

// Deliberately constructs the rewrite-triggering shapes the oracle must cover.
function emitRandomOperation(
  random: () => number,
  shadow: ShadowCircuit,
  wires: Wire[],
  unitWires: Wire[],
  constantWires: Wire[],
  affineWires: Wire[],
) {
  const shape = randomInteger(random, 10)
  let wire: Wire
  if (shape === 0 && constantWires.length > 0) {
    // Constant wires feeding terms exercise the folding path.
    const constant = constantWires[randomInteger(random, constantWires.length)]!
    const terms: Terms = [
      [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)],
      [constant, randomCoefficient(random)],
      [constant, randomCoefficient(random)],
    ]
    wire = shadow.affine(terms, randomBias(random))
  } else if (shape === 1) {
    // A fresh constant wire (empty terms) to feed later folds and demotions.
    // Mix in larger magnitudes so positive demotion gates land clearly away
    // from one, where bias and coefficient scaling both become observable.
    const constantValue = [-3, -2, -1, 0.5, 1, 2, 3][randomInteger(random, 7)]!
    wire = shadow.affine([], constantValue)
    constantWires.push(wire)
  } else if (shape === 2) {
    // Duplicate terms on the same wire exercise the merge path.
    const target = wires[randomInteger(random, wires.length)]!
    const terms: Terms = [
      [target, randomCoefficient(random)],
      [target, randomCoefficient(random)],
      [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)],
      [target, randomCoefficient(random)],
    ]
    wire = shadow.affine(terms, randomBias(random))
  } else if (shape === 3 && affineWires.length > 0) {
    // Affine-of-affine chains exercise composition; favor existing affine wires.
    const terms: Terms = [
      [affineWires[randomInteger(random, affineWires.length)]!, randomCoefficient(random)],
      [affineWires[randomInteger(random, affineWires.length)]!, randomCoefficient(random)],
      [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)],
    ]
    wire = shadow.affine(terms, randomBias(random))
  } else if (shape === 4) {
    // Identity single-term coefficient-1 form exercises aliasing.
    wire = shadow.affine([[wires[randomInteger(random, wires.length)]!, 1]], 0)
  } else if (shape === 5 && constantWires.length > 0) {
    // reglu with a constant gate exercises demotion. A constant gate < 0 must
    // collapse to exactly zero; a constant gate other than one must scale both
    // the left coefficients and the left bias, so force a nonzero left bias and
    // a gate magnitude away from one to make that scaling observable.
    const constant = constantWires[randomInteger(random, constantWires.length)]!
    const gateSign = randomInteger(random, 2) === 0 ? 1 : -1
    const nonzeroBias = [-2, -1, -0.5, 0.5, 1, 2][randomInteger(random, 6)]!
    wire = shadow.reglu(
      [
        [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)],
        [wires[randomInteger(random, wires.length)]!, randomCoefficient(random)],
      ],
      nonzeroBias,
      [[constant, gateSign * 2]],
      randomBias(random),
    )
  } else if (shape === 6) {
    // reglu with a left form that may fold to exactly zero (left-zero demotion).
    wire = shadow.reglu([], 0, randomTerms(random, wires, 3), randomBias(random))
  } else if (shape <= 8) {
    // General reglu over live wires.
    wire = shadow.reglu(
      randomTerms(random, wires, 4),
      randomBias(random),
      randomTerms(random, wires, 4),
      randomBias(random),
    )
  } else {
    // Boolean atom over a wire provably within zero and one.
    const input = unitWires[randomInteger(random, unitWires.length)]!
    wire = shadow.boolean(input)
    unitWires.push(wire)
  }

  // Track wires by category so later operations can target the right shapes.
  if (!wires.includes(wire)) wires.push(wire)
  const operationIndex = wire - shadow.circuit.sourceSize
  if (operationIndex >= 0) {
    const op = shadow.circuit.operations[operationIndex]!
    if (op.kind === 'affine' && !affineWires.includes(wire)) affineWires.push(wire)
  }
  return wire
}

describe('builder rewrite differential oracle', () => {
  test('naive intent matches the reference across seeded rewrite-heavy circuits', () => {
    const random = createRandom(0x5ad0c)
    let comparedWires = 0
    let booleanWires = 0
    let aliasReuses = 0

    for (let circuitIndex = 0; circuitIndex < 400; circuitIndex++) {
      const sourceSize = 3 + randomInteger(random, 4)
      const shadow = new ShadowCircuit(sourceSize)
      // The first two source wires stay within zero and one to seed booleans.
      shadow.circuit.assumeRange(shadow.circuit.source(0), 0, 1)
      shadow.circuit.assumeRange(shadow.circuit.source(1), 0, 1)

      const wires: Wire[] = Array.from({length: sourceSize}, (_, wire) => asWire(wire))
      const unitWires: Wire[] = [asWire(0), asWire(1)]
      const constantWires: Wire[] = []
      const affineWires: Wire[] = []
      const operationCount = 10 + randomInteger(random, 50)

      const emittedBefore = shadow.ops.length
      for (let operation = 0; operation < operationCount; operation++) {
        const widthBefore = shadow.circuit.sourceSize + shadow.circuit.operations.length
        const wire = emitRandomOperation(random, shadow, wires, unitWires, constantWires, affineWires)
        const widthAfter = shadow.circuit.sourceSize + shadow.circuit.operations.length
        // No new operation means the emit aliased or deduplicated to an old wire.
        if (widthAfter === widthBefore) {
          invariant(wire < widthBefore, 'reused wire must already exist')
          aliasReuses++
        }
      }
      invariant(shadow.ops.length > emittedBefore, 'recorded no operations')

      validateCircuit(shadow.circuit)

      for (let sampleIndex = 0; sampleIndex < 6; sampleIndex++) {
        const source = Float32Array.from({length: sourceSize}, (_, wire) =>
          // Keep the boolean-seed wires within zero and one; the rest range
          // over modest negative and positive magnitudes.
          wire < 2 ? randomInteger(random, 2) : random() * 4 - 2,
        )
        const reference = shadow.circuit.evaluateReference(source)
        const naive = evaluateShadow(shadow, source)

        for (const op of shadow.ops) {
          const referenceValue = reference[op.wire]!
          const naiveValue = naive.get(op.wire)!
          const isBoolean = op.kind === 'boolean'
          if (isBoolean) booleanWires++
          comparedWires++
          if (!closeEnough(naiveValue, referenceValue, isBoolean)) {
            throw new Error(
              `circuit ${circuitIndex} sample ${sampleIndex} wire ${op.wire} (${op.kind}): ` +
                `naive ${naiveValue} vs reference ${referenceValue}`,
            )
          }
        }
      }
    }

    // Confirm the generator actually produced the shapes the oracle targets.
    expect(comparedWires).toBeGreaterThan(50_000)
    expect(booleanWires).toBeGreaterThan(0)
    expect(aliasReuses).toBeGreaterThan(0)
  })

  test('hand-built rewrite shapes evaluate exactly to their intent', () => {
    // Composition three deep, with merging, folding, and demotion mixed in.
    const shadow = new ShadowCircuit(2)
    shadow.circuit.assumeRange(shadow.circuit.source(0), 0, 1)
    const constant = shadow.affine([], 2) // wire 2, constant 2
    const first = shadow.affine([[asWire(0), 3], [constant, 1]], 1) // 3*v0 + 2 + 1 = 3*v0 + 3
    const second = shadow.affine([[first, 2], [asWire(0), 0.5], [asWire(0), 0.5]], -1) // 2*first + v0 - 1
    const third = shadow.affine([[second, 1], [first, -1]], 0) // second - first
    // Constant gate < 0 must demote to exactly zero.
    const demotedNegative = shadow.reglu([[asWire(0), 5]], 7, [[constant, -1]], 0)
    // Constant gate > 0 scales the left form.
    const demotedPositive = shadow.reglu([[asWire(0), 5]], 7, [[constant, 1]], 0)
    // Identity alias returns the input wire without allocating.
    const alias = shadow.affine([[third, 1]], 0)

    expect(alias).toBe(third)
    expect(shadow.circuit.operations[demotedNegative - 2]!.kind).toBe('affine')
    expect(shadow.circuit.operations[demotedNegative - 2]!.leftTerms).toEqual([])

    const source = Float32Array.from([0.5, 0])
    const reference = shadow.circuit.evaluateReference(source)
    const naive = evaluateShadow(shadow, source)
    for (const op of shadow.ops) {
      const ok = closeEnough(naive.get(op.wire)!, reference[op.wire]!, op.kind === 'boolean')
      expect(ok).toBe(true)
    }
    // Spot-check the demotion arithmetic against the closed form.
    expect(reference[demotedNegative]!).toBe(0)
    expect(reference[demotedPositive]!).toBeCloseTo((7 + 5 * 0.5) * 2, 5)
  })
})
