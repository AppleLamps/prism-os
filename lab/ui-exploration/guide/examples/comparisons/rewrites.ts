// Executors that evaluate the same circuit with different arithmetic, standing in for what an
// optimizing compiler or another backend may do. They show which comparison forms need FP32 rounding
// to happen exactly as written, and which need no rounding at all.
import type {Circuit, Terms} from '../../../../../src/runtime/numeric-ui-core.ts'
import {smallestNormal} from './fp32.ts'

export type ExecutorMode =
  // The reference semantics: each product rounded to FP32, then added to the running sum in stored
  // order, bias first.
  | 'stored'
  // No rounding anywhere. The boolean atom's (score + 8,388,609) - 8,388,609 then returns the score.
  | 'float64'
  // FP32, but the boolean atom's (score + 8,388,609) - 8,388,609 rewritten as the score, which is
  // what codegen measured Apple's Metal shader compiler doing.
  | 'atomRewrittenToScore'
  // FP32, with each sum's terms added in reverse order and the bias last.
  | 'reversedTerms'
  // Each sum computed in float64 and rounded to FP32 once, like a fused kernel.
  | 'sumsRoundedOnce'
  // FP32, with every subnormal value (nonzero and below 2^-126) replaced by 0 on inputs and results,
  // like hardware in denormals-are-zero and flush-to-zero mode.
  | 'flushSubnormals'

export const executorModes: readonly ExecutorMode[] = ['stored', 'float64', 'atomRewrittenToScore', 'reversedTerms', 'sumsRoundedOnce', 'flushSubnormals']

const booleanOffset = 8_388_609

function flushSubnormal(value: number): number {
  const rounded = Math.fround(value)
  return Math.abs(rounded) < smallestNormal ? 0 : rounded
}

export function evaluateWithMode(circuit: Circuit, source: Float32Array, mode: ExecutorMode): Float64Array {
  const round = mode === 'float64'
    ? (value: number) => value
    : mode === 'flushSubnormals' ? flushSubnormal : Math.fround
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(mode === 'flushSubnormals' ? source.map(flushSubnormal) : source)
  const sum = (terms: Terms, bias: number) => {
    if (mode === 'sumsRoundedOnce') {
      let unrounded = Math.fround(bias)
      for (const [wire, coefficient] of terms) unrounded += Math.fround(coefficient) * values[wire]!
      return Math.fround(unrounded)
    }
    if (mode === 'reversedTerms') {
      let value = 0
      for (let index = terms.length - 1; index >= 0; index--) {
        const [wire, coefficient] = terms[index]!
        value = Math.fround(value + Math.fround(Math.fround(coefficient) * values[wire]!))
      }
      return Math.fround(value + Math.fround(bias))
    }
    let value = round(bias)
    for (const [wire, coefficient] of terms) value = round(value + round(round(coefficient) * values[wire]!))
    return value
  }
  circuit.operations.forEach((operation, index) => {
    let value = sum(operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value = round(value * Math.max(0, sum(operation.gateTerms, operation.gateBias)))
    } else if (operation.kind === 'boolean') {
      value = mode === 'atomRewrittenToScore'
        ? value
        : round(round(round(value) + booleanOffset) - booleanOffset)
    }
    values[circuit.sourceSize + index] = value
  })
  return values
}
