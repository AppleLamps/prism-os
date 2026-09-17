// Exact arithmetic on the numbers a circuit holds, to check whether an operation rounded.
//
// Every finite float is an integer times a power of two, so sums and products of floats can be
// computed exactly with BigInt. An operation didn't round when its FP32 result equals the exact
// result of the same arithmetic on the same FP32 inputs. For a ReLU-gated product, only the result
// counts: a gate sum like -1 + 2^-100 rounds to -1, but the ReLU returns 0 either way.
import type {Circuit, Terms} from '../../../../../src/runtime/numeric-ui-core.ts'

// mantissa * 2^exponent
type Dyadic = {mantissa: bigint, exponent: number}

const view = new DataView(new ArrayBuffer(8))

function toDyadic(value: number): Dyadic {
  if (!Number.isFinite(value)) throw new Error(`expected a finite value, got ${value}`)
  if (value === 0) return {mantissa: 0n, exponent: 0}
  view.setFloat64(0, value)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const biasedExponent = (high >>> 20) & 0x7ff
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
  let exponent = -1074
  if (biasedExponent !== 0) {
    mantissa |= 1n << 52n
    exponent = biasedExponent - 1075
  }
  return {mantissa: high >>> 31 === 1 ? -mantissa : mantissa, exponent}
}

function add(left: Dyadic, right: Dyadic): Dyadic {
  const exponent = Math.min(left.exponent, right.exponent)
  return {
    mantissa: (left.mantissa << BigInt(left.exponent - exponent)) + (right.mantissa << BigInt(right.exponent - exponent)),
    exponent,
  }
}

function multiply(left: Dyadic, right: Dyadic): Dyadic {
  return {mantissa: left.mantissa * right.mantissa, exponent: left.exponent + right.exponent}
}

function exactSum(values: Float32Array, terms: Terms, bias: number): Dyadic {
  let sum = toDyadic(Math.fround(bias))
  for (const [wire, coefficient] of terms) {
    sum = add(sum, multiply(toDyadic(Math.fround(coefficient)), toDyadic(values[wire]!)))
  }
  return sum
}

// The indices of operations whose FP32 result, in `values` from evaluateReference, differs from the
// exact result of their arithmetic. A boolean atom's arithmetic is (score + K) - K, whose exact
// result is the score, so an atom counts as rounded whenever its score isn't already 0 or 1.
export function roundedOperations(circuit: Circuit, values: Float32Array): number[] {
  const rounded: number[] = []
  circuit.operations.forEach((operation, index) => {
    let exact = exactSum(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      const gate = exactSum(values, operation.gateTerms, operation.gateBias)
      exact = gate.mantissa > 0n ? multiply(exact, gate) : {mantissa: 0n, exponent: 0}
    }
    const output = values[circuit.sourceSize + index]!
    if (!Number.isFinite(output) || add(exact, multiply(toDyadic(output), {mantissa: -1n, exponent: 0})).mantissa !== 0n) {
      rounded.push(index)
    }
  })
  return rounded
}
