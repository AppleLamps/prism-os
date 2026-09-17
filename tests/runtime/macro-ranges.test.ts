import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  emitSelect,
  emitSpring,
} from '../../src/runtime/numeric-ui-core.ts'

// Characterization tests for the magnitude preconditions of the macro library.
// These pin the FP32 re-rounding boundaries where each macro stops matching its
// real-valued definition. Nothing here is fixed; the tests document the bounds
// the compiled UI silently relies on. See the Macro contracts section of
// execution-model.md for the table.

const f = Math.fround
// Widest finite range the circuit will accept as a source bound.
const BIG = 3.4e38

// max(a, b) expanded as b + relu(a - b), evaluated through the real circuit.
function evaluateMaximum(a: number, b: number): number {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), -BIG, BIG)
  circuit.assumeRange(circuit.source(1), -BIG, BIG)
  const result = emitMaximum(circuit, circuit.source(0), circuit.source(1))
  const reference = circuit.evaluateReference(Float32Array.from([a, b]))
  const tensor = circuit.evaluateTensor(Float32Array.from([a, b]))
  // The compiled and literal evaluators must agree bit-for-bit regardless of magnitude.
  expect(tensor[result]).toBe(reference[result])
  return reference[result]!
}

// min(a, b) expanded as a - relu(a - b).
function evaluateMinimum(a: number, b: number): number {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), -BIG, BIG)
  circuit.assumeRange(circuit.source(1), -BIG, BIG)
  const result = emitMinimum(circuit, circuit.source(0), circuit.source(1))
  const reference = circuit.evaluateReference(Float32Array.from([a, b]))
  const tensor = circuit.evaluateTensor(Float32Array.from([a, b]))
  expect(tensor[result]).toBe(reference[result])
  return reference[result]!
}

// select(gate, off, on) expanded as gate * on + (1 - gate) * off, two masked products.
function evaluateSelect(gate: number, off: number, on: number): number {
  const circuit = new Circuit(3)
  circuit.assumeRange(circuit.source(0), 0, 1)
  circuit.assumeRange(circuit.source(1), -BIG, BIG)
  circuit.assumeRange(circuit.source(2), -BIG, BIG)
  const result = emitSelect(circuit, circuit.source(0), circuit.source(1), circuit.source(2))
  const reference = circuit.evaluateReference(Float32Array.from([gate, off, on]))
  const tensor = circuit.evaluateTensor(Float32Array.from([gate, off, on]))
  expect(tensor[result]).toBe(reference[result])
  return reference[result]!
}

// multiply(a, b); ranges chosen so each operand keeps its sign freedom.
function evaluateMultiply(a: number, b: number): number {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), a < 0 ? -BIG : 0, BIG)
  circuit.assumeRange(circuit.source(1), b < 0 ? -BIG : 0, BIG)
  const result = emitMultiply(circuit, circuit.source(0), circuit.source(1))
  const reference = circuit.evaluateReference(Float32Array.from([a, b]))
  const tensor = circuit.evaluateTensor(Float32Array.from([a, b]))
  expect(tensor[result]).toBe(reference[result])
  return reference[result]!
}

// The clamp01 shape relu(v) - relu(v - 1), built through the REAL atom path so
// these tests exercise the compiled circuit instead of a JS shadow that could
// drift from numeric-ui-core.ts. This mirrors emitClampZeroOne exactly (which is
// not exported): positive = relu(v); aboveOne = relu(v - unit);
// result = affine([[positive, 1], [aboveOne, -1]]); assumeRange(result, 0, 1),
// with unit pinned to 1.
function evaluateClampZeroOne(v: number): number {
  const circuit = new Circuit(2)
  circuit.assumeRange(circuit.source(0), -BIG, BIG)
  circuit.assumeRange(circuit.source(1), 1, 1)
  const value = circuit.source(0)
  const unit = circuit.source(1)
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  const source = Float32Array.from([v, 1])
  const reference = circuit.evaluateReference(source)
  const tensor = circuit.evaluateTensor(source)
  // The compiled and literal evaluators must agree bit-for-bit regardless of magnitude.
  expect(tensor[result]).toBe(reference[result])
  return reference[result]!
}

const random = createRandom(0x5afe9a)

describe('emitMaximum / emitMinimum magnitude preconditions', () => {
  test('the known disparity failure: max(2**24, -1) loses one unit', () => {
    // True maximum is 2**24; the macro returns one less because a - b = 2**24 + 1
    // rounds down to 2**24 at this magnitude, then b + relu(a - b) subtracts the 1
    // back off through b. This is the characteristic failure, not fixed here.
    expect(evaluateMaximum(2 ** 24, -1)).toBe(16_777_215)
    expect(Math.max(2 ** 24, -1)).toBe(16_777_216)
    expect(evaluateMaximum(2 ** 24, -1)).toBe(Math.max(2 ** 24, -1) - 1)
  })

  test('the mirror disparity failure: min(2**24, -1) collapses to zero', () => {
    // a - relu(a - b) = 2**24 - 2**24 = 0, losing the true minimum of -1.
    expect(evaluateMinimum(2 ** 24, -1)).toBe(0)
    expect(Math.min(2 ** 24, -1)).toBe(-1)
  })

  test('the first diverging magnitude for max(a, -1) is the integer a = 2**24', () => {
    // Step integer winners up to the boundary; a - (-1) = a + 1 first fails to round
    // back exactly when a reaches 2**24, where the binade ulp grows from 1 to 2.
    // Just below, a + 1 is still representable, so the macro is exact.
    expect(evaluateMaximum(2 ** 24 - 1, -1)).toBe(2 ** 24 - 1)
    expect(evaluateMaximum(2 ** 24, -1)).toBe(16_777_215)
    expect(evaluateMaximum(2 ** 24, -1)).not.toBe(Math.max(2 ** 24, -1))
    // Pin that 2**24 is the FIRST failing integer: every integer just below is exact.
    for (let a = 2 ** 24 - 64; a < 2 ** 24; a++) {
      expect(evaluateMaximum(a, -1)).toBe(a)
    }
  })

  test('max and min stay exact for integer operands with |x| < 2**23', () => {
    // The safe regime is integers whose difference also stays representable: with
    // |a|, |b| < 2**23 the intermediate a - b never exceeds 2**24, so both a - b
    // and b + relu(a - b) stay integral and lossless. Pushing operands up to
    // 2**24 lets the difference reach 2**25 and re-round (covered separately).
    for (let trial = 0; trial < 3_000; trial++) {
      const a = Math.round(signedMagnitude(random, 2 ** 23 - 1))
      const b = Math.round(signedMagnitude(random, 2 ** 23 - 1))
      expect(evaluateMaximum(a, b)).toBe(Math.max(a, b))
      expect(evaluateMinimum(a, b)).toBe(Math.min(a, b))
    }
    // The maximum-disparity integer pair at this scale is still exact.
    expect(evaluateMaximum(2 ** 23 - 1, -(2 ** 23 - 1))).toBe(2 ** 23 - 1)
    expect(evaluateMinimum(2 ** 23 - 1, -(2 ** 23 - 1))).toBe(-(2 ** 23 - 1))
  })

  test('max and min are NOT exact for fractional operands even at small scale', () => {
    // Recombining b + relu(a - b) re-rounds the fractional bits, so the integer
    // safe range does not extend to arbitrary reals. This documents the limit.
    const a = f(422.882_418_613_880_9)
    const b = f(-79.529_039_096_087_22)
    expect(evaluateMaximum(a, b)).not.toBe(Math.max(a, b))
    expect(evaluateMaximum(a, b)).toBeCloseTo(Math.max(a, b), 2)
  })

  test('the winner being the small operand stays exact even at huge disparity', () => {
    // max(-1, 2**e): relu(a - b) = relu(negative) = 0, so result = b exactly.
    // Disparity only hurts when the LARGE operand is the loser fed through relu.
    for (let exponent = 10; exponent <= 40; exponent++) {
      const large = f(2 ** exponent)
      expect(evaluateMaximum(-1, large)).toBe(large)
    }
    // And min(2**24, -1) collapses to 0 only once the large operand drives a - b.
    expect(evaluateMinimum(2 ** 24, -1)).toBe(0)
    expect(evaluateMinimum(2 ** 23, -1)).toBe(-1)
  })
})

describe('clamp01 pattern relu(v) - relu(v - 1) magnitude precondition', () => {
  test('clamp01 is exact through 2**24 then degrades at the binade boundaries', () => {
    // Sanity: the pattern clamps correctly at normal magnitudes.
    expect(evaluateClampZeroOne(0.5)).toBe(0.5)
    expect(evaluateClampZeroOne(-3)).toBe(0)
    expect(evaluateClampZeroOne(2)).toBe(1)
    // The plateau value of 1 survives up to the lower binade edge 2**24 itself.
    expect(evaluateClampZeroOne(2 ** 24)).toBe(1)
    // First failing magnitude: once ulp reaches 2 (binade [2**24, 2**25)),
    // v - 1 rounds to v - 2, so relu(v) - relu(v - 1) = 2 instead of 1.
    expect(evaluateClampZeroOne(2 ** 24 + 2)).toBe(2)
    // At 2**25 the binade ulp is 4, so v - 1 rounds back up to v. Both relu arms
    // then equal 2**25 and cancel: relu(v) - relu(v - 1) = 0 instead of 1.
    expect(evaluateClampZeroOne(2 ** 25)).toBe(0)
  })
})

describe('emitSelect exactness at the gate rails', () => {
  const magnitudes = [
    0, 1, -1, 0.5, -0.5, 3.141_59, -2.718_28,
    1e-20, 1e20, 2 ** 24, -(2 ** 24), 12_345.678, -9.99e30, 1e10,
  ]

  test('gate exactly 0 returns off bit-exactly for every magnitude pair', () => {
    // 0 * on + 1 * off = off: the unpicked product is 0 and adding it to off doesn't
    // round, so this rail is unconditional.
    for (const off of magnitudes) {
      for (const on of magnitudes) {
        expect(evaluateSelect(0, off, on)).toBe(f(off))
      }
    }
  })

  test('gate exactly 1 returns on bit-exactly for integer operands with |x| < 2**23', () => {
    // Both endpoints select directly through products, without subtracting the
    // two candidates from each other.
    const integers = [0, 1, -1, 2, -2, 1000, -1000, 65_535, 2 ** 22, -(2 ** 22), 2 ** 23 - 1, -(2 ** 23 - 1)]
    for (const on of integers) {
      for (const off of integers) {
        expect(evaluateSelect(1, off, on)).toBe(on)
      }
    }
    // off = 0 reconstructs on exactly at any magnitude or fractional value.
    for (const on of [3.141_59, -2.718_28, 1e-20, 1e20, -9.99e30, 2 ** 24]) {
      expect(evaluateSelect(1, 0, on)).toBe(f(on))
    }
  })

  test('gate exactly 1 stays exact across extreme magnitude differences', () => {
    expect(evaluateSelect(1, 1e10, 1)).toBe(1)
    expect(evaluateSelect(1, -9.99e30, 16_777_216)).toBe(16_777_216)
    expect(evaluateSelect(1, 1000, 3.141_59)).toBe(f(3.141_59))
    expect(evaluateSelect(1, 16_777_216, 3.141_59)).toBe(f(3.141_59))
  })
})

describe('emitSpring settled branch', () => {
  // sources: position, destination, velocity, stiffness, damping, timestep,
  // settleDistance, settleSpeed, settleDistanceScale, settleSpeedScale, unit.
  function buildSettledSpring(initialPosition: number, destination: number, initialVelocity: number) {
    const circuit = new Circuit(11)
    circuit.assumeRange(circuit.source(0), -1e6, 1e6)
    circuit.assumeRange(circuit.source(1), -1e6, 1e6)
    circuit.assumeRange(circuit.source(2), -1e6, 1e6)
    circuit.assumeRange(circuit.source(3), 0, 1000)
    circuit.assumeRange(circuit.source(4), 0, 1000)
    circuit.assumeRange(circuit.source(5), 0, 1)
    circuit.assumeRange(circuit.source(6), 0, 1e6)
    circuit.assumeRange(circuit.source(7), 0, 1e6)
    circuit.assumeRange(circuit.source(8), 0, 1e6)
    circuit.assumeRange(circuit.source(9), 0, 1e6)
    circuit.assumeRange(circuit.source(10), 1, 1)
    const [position0, destination0, velocity0, stiffness, damping, timestep, settleDistance, settleSpeed, settleDistanceScale, settleSpeedScale, unit] =
      Array.from({length: 11}, (_, cell) => circuit.source(cell))
    const spring = emitSpring(circuit, position0!, destination0!, velocity0!, stiffness!, damping!, timestep!, settleDistance!, settleSpeed!, settleDistanceScale!, settleSpeedScale!, unit!)
    let position = initialPosition
    let velocity = initialVelocity
    let active = 1
    for (let frame = 0; frame < 240; frame++) {
      const source = Float32Array.from([
        position, destination, velocity,
        200, 20, 0.05, 0.5, 0.5, 1000, 1000, 1,
      ])
      const reference = circuit.evaluateReference(source)
      const tensor = circuit.evaluateTensor(source)
      // Reference and compiled springs must step identically.
      expect(tensor[spring.position]).toBe(reference[spring.position])
      expect(tensor[spring.velocity]).toBe(reference[spring.velocity])
      expect(tensor[spring.active]).toBe(reference[spring.active])
      position = reference[spring.position]!
      velocity = reference[spring.velocity]!
      active = reference[spring.active]!
    }
    return {position, velocity, active}
  }

  test('a settled spring snaps position to destination and velocity to zero exactly', () => {
    for (const [start, destination] of [
      [100, 0],
      [5, 42],
      [-30, -7],
      [0, 250],
    ] as const) {
      const settled = buildSettledSpring(start, destination, 0)
      // Settled means active rounds to 0, so position = select(0, destination, position)
      // = destination and velocity = multiply(0, velocity) = 0, both bit-exact.
      expect(settled.active).toBe(0)
      expect(settled.position).toBe(f(destination))
      expect(settled.velocity).toBe(0)
    }
  })

  test('a spring released with initial velocity still settles exactly', () => {
    const settled = buildSettledSpring(5, 42, -3)
    expect(settled.active).toBe(0)
    expect(settled.position).toBe(42)
    expect(settled.velocity).toBe(0)
  })
})

describe('emitMultiply exact-product property', () => {
  test('emitMultiply equals fround(a * b) across signs and magnitudes', () => {
    // The macro routes through reglu so the single FP32 product matches Math.fround
    // exactly; there is no second rounding step to drift.
    const values = [
      0, 1, -1, 0.5, -0.5, 2, -2, 1e10, -1e10, 1e-10,
      3.141_59, -2.718_28, 2 ** 23, 1234.5, 65_535, -65_535, 0.1, -0.1,
    ]
    for (const a of values) {
      for (const b of values) {
        expect(evaluateMultiply(a, b)).toBe(f(f(a) * f(b)))
      }
    }
  })

  test('emitMultiply tracks fround even into overflow', () => {
    // Confirms the exact-product property is unconditional for finite inputs:
    // when fround(a * b) overflows to +/-Infinity, the macro overflows the same way.
    expect(evaluateMultiply(1e20, 1e20)).toBe(f(f(1e20) * f(1e20)))
    expect(evaluateMultiply(-1e20, 1e20)).toBe(f(f(-1e20) * f(1e20)))
    expect(evaluateMultiply(1e20, 1e20)).toBe(Infinity)
  })

  test('a proven-nonnegative operand lowers emitMultiply to one reglu', () => {
    // With a provably non-negative operand emitMultiply takes the single-reglu
    // fast path; the assumed range is then enforced at evaluation time. (Lifted
    // from the former numeric-ui-atoms suite — the one assertion not covered here.)
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(1), 0, Number.POSITIVE_INFINITY)
    const product = emitMultiply(circuit, circuit.source(0), circuit.source(1))
    expect(circuit.operations.length).toBe(1)
    expect(circuit.operations[0]!.kind).toBe('reglu')
    expect(circuit.evaluateTensor(Float32Array.from([-3, 2]))[product]).toBe(-6)
    expect(() => circuit.evaluateTensor(Float32Array.from([-3, -2]))).toThrow(
      /outside its assumed range/,
    )
  })
})

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function signedMagnitude(next: () => number, scale: number): number {
  return (next() * 2 - 1) * scale
}
