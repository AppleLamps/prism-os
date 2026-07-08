// Straight-through backward pass for circuits that contain boolean atoms.
//
// The repo's Circuit.backpropagateReference throws when a gradient reaches a
// boolean atom, because the exact forward rounding has no true derivative.
// Generation over fields needs SOME signal through those atoms (rank
// comparisons, wrap decisions, violation thresholds), so this pass uses the
// standard straight-through estimator: the boolean's gradient flows to its
// score terms unchanged, as if the atom were the identity. Affine and reglu
// atoms backpropagate exactly like the reference pass.
//
// The forward result stays bit-exact (this file never touches evaluation); the
// estimator only biases the training-time gradient, which the experiments
// characterize rather than hide.

import type {Circuit, Terms} from '../../numeric-ui-core.ts'
import {invariant} from '../../numeric-ui-core.ts'

function evaluateTerms(values: Float32Array, terms: Terms, bias: number): number {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    value = Math.fround(value + Math.fround(Math.fround(coefficient) * values[wire]!))
  }
  return value
}

function accumulateTermGradients(gradients: Float32Array, terms: Terms, outputGradient: number) {
  for (const [wire, coefficient] of terms) {
    gradients[wire] = Math.fround(
      gradients[wire]! + Math.fround(outputGradient * Math.fround(coefficient)),
    )
  }
}

export function backpropagateStraightThrough(
  circuit: Circuit,
  values: Float32Array,
  outputGradients: Float32Array,
): Float32Array {
  const width = circuit.sourceSize + circuit.operations.length
  invariant(values.length === width, 'forward values have the wrong length')
  invariant(outputGradients.length === width, 'output gradients have the wrong length')
  const gradients = new Float32Array(outputGradients)
  for (let operationIndex = circuit.operations.length - 1; operationIndex >= 0; operationIndex--) {
    const operation = circuit.operations[operationIndex]!
    const outputWire = circuit.sourceSize + operationIndex
    const outputGradient = gradients[outputWire]!
    if (outputGradient === 0) continue
    if (operation.kind === 'affine' || operation.kind === 'boolean') {
      // Straight-through: the boolean's rounding step is treated as identity.
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
