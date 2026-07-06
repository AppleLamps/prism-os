// Surrogate backpropagation for circuits that contain boolean atoms.
//
// Circuit.backpropagateReference THROWS at boolean atoms: the boolean forward
// pass is an exact 0/1 round, whose true derivative is zero almost everywhere
// and undefined at the threshold, so there is no honest gradient to propagate.
// boolean-state.md reserves the slot for exactly this: "its backward pass may
// use a surrogate gradient; that does not change the exact forward result".
//
// This file backpropagates affine and reglu atoms identically to the reference
// (mirroring its FP32 discipline line for line) and, at boolean atoms, routes a
// configurable surrogate gradient into the score's affine terms instead of
// throwing. The forward pass is untouched, so exactness still holds; only the
// backward pass invents a slope.

import {type Terms, invariant} from '../numeric-ui-core.ts'

// Minimal structural view of the public Circuit fields this surrogate reads.
// The core module does not export its Operation/AtomKind types, so we restate
// just the shape backpropagation needs. The boolean atom stores its score in
// leftTerms/leftBias (see Circuit.boolean), matching this view.
type OperationView = {
  kind: 'affine' | 'reglu' | 'boolean'
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
}

type CircuitView = {
  sourceSize: number
  operations: readonly OperationView[]
}

export type SurrogateMode = 'ste' | 'sigmoidSte'

export type SurrogateOptions = {
  // 'ste': straight-through estimator, the boolean is treated as identity in
  //   the backward pass and the incoming gradient passes through unchanged.
  // 'sigmoidSte': the gradient is scaled by the derivative of a logistic
  //   sigmoid centered at 0.5, sigmoid(temperature * (score - 0.5)). The
  //   forward bit is still the exact round; only the surrogate slope changes.
  mode?: SurrogateMode
  // Logistic steepness for 'sigmoidSte'. Larger values concentrate gradient
  // near the 0.5 decision boundary; smaller values spread it out. Ignored by
  // 'ste'.
  temperature?: number
}

// Identical to the reference's evaluateTerms FP32 reduction. Boolean atoms need
// their forward score to evaluate the sigmoid surrogate, and reglu atoms need
// left/gate exactly as the reference computes them.
function evaluateTerms(values: Float32Array, terms: Terms, bias: number): number {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    value = Math.fround(
      value + Math.fround(Math.fround(coefficient) * values[wire]!),
    )
  }
  return value
}

// Identical to the reference's accumulateTermGradients FP32 discipline.
function accumulateTermGradients(
  gradients: Float32Array,
  terms: Terms,
  outputGradient: number,
) {
  for (const [wire, coefficient] of terms) {
    gradients[wire] = Math.fround(
      gradients[wire]! + Math.fround(outputGradient * Math.fround(coefficient)),
    )
  }
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

export function backpropagateSurrogate(
  circuit: CircuitView,
  values: Float32Array,
  outputGradients: Float32Array,
  options: SurrogateOptions = {},
): Float32Array {
  const mode = options.mode ?? 'ste'
  const temperature = options.temperature ?? 1
  invariant(temperature > 0, 'surrogate temperature must be positive')
  const width = circuit.sourceSize + circuit.operations.length
  invariant(values.length === width, 'forward values have the wrong length')
  invariant(outputGradients.length === width, 'output gradients have the wrong length')
  const gradients = new Float32Array(outputGradients)
  // Differentiate FP32 arithmetic as real-valued; ReLU uses zero slope at its
  // corner. Boolean atoms use the configured surrogate slope.
  for (let operationIndex = circuit.operations.length - 1; operationIndex >= 0; operationIndex--) {
    const operation = circuit.operations[operationIndex]!
    const outputWire = circuit.sourceSize + operationIndex
    const outputGradient = gradients[outputWire]!
    if (outputGradient === 0) continue
    if (operation.kind === 'boolean') {
      let surrogateGradient = outputGradient
      if (mode === 'sigmoidSte') {
        // Boolean stores its score as the left affine form; the sigmoid is
        // centered at the 0.5 decision boundary. d/ds sigmoid(t*(s-0.5))
        // = t * sig * (1 - sig).
        const score = evaluateTerms(values, operation.leftTerms, operation.leftBias)
        const activation = sigmoid(temperature * (score - 0.5))
        surrogateGradient = Math.fround(
          outputGradient * Math.fround(temperature * activation * (1 - activation)),
        )
      }
      accumulateTermGradients(gradients, operation.leftTerms, surrogateGradient)
      continue
    }
    if (operation.kind === 'affine') {
      accumulateTermGradients(gradients, operation.leftTerms, outputGradient)
      continue
    }
    const left = evaluateTerms(values, operation.leftTerms, operation.leftBias)
    const gate = evaluateTerms(values, operation.gateTerms, operation.gateBias)
    const activeGate = Math.max(0, gate)
    accumulateTermGradients(
      gradients,
      operation.leftTerms,
      Math.fround(outputGradient * activeGate),
    )
    if (gate > 0) {
      accumulateTermGradients(
        gradients,
        operation.gateTerms,
        Math.fround(outputGradient * left),
      )
    }
  }
  return gradients
}
