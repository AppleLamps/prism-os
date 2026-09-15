// A copy of numeric-ui-core.ts's backpropagateReference with a third way of treating boolean
// atoms. 'straight-through' passes a boolean's output gradient to its score unchanged (the
// runtime's option). 'frozen' passes nothing: every decision is held where it is, so the result
// is the exact slope of the piecewise-linear circuit inside its current decision region (ReLU
// corners still get slope 0).
//
// The two agree on a boolean whose score saturates, e.g. layout's atLeastZero, whose score is
// relu(256 d + 0.5) - relu(256 d - 0.5): its slope is 0 except within 1/512 px of the threshold.
// They differ on emitArgmax's comparison boolean(0.5 + 0.5 × (left - right)), whose score has
// slope 0.5 everywhere, so straight-through passes half of every score difference into the
// selection, and from there into every layout's geometry and quality scales.
import type {Circuit, Terms, Wire} from '../../../numeric-ui-core.ts'

export type BooleanGradient = 'straight-through' | 'frozen'

export function backpropagate(circuit: Circuit, values: Float32Array, outputGradients: Float32Array, booleanGradient: BooleanGradient): Float32Array {
  if (booleanGradient === 'straight-through') return circuit.backpropagateReference(values, outputGradients, {booleanGradient: 'straight-through'})
  const width = circuit.sourceSize + circuit.operations.length
  if (values.length !== width || outputGradients.length !== width) throw new Error('backpropagate: wrong lengths')
  const gradients = new Float32Array(outputGradients)
  for (let operationIndex = circuit.operations.length - 1; operationIndex >= 0; operationIndex--) {
    const operation = circuit.operations[operationIndex]!
    const outputGradient = gradients[circuit.sourceSize + operationIndex]!
    if (outputGradient === 0) continue
    const macro = operation.macro
    if (macro?.kind === 'multiply') {
      accumulate(gradients, [[macro.left, values[macro.right]!]], outputGradient)
      accumulate(gradients, [[macro.right, values[macro.left]!]], outputGradient)
      continue
    }
    if (macro?.kind === 'select') {
      const gate = values[macro.gate]!
      accumulate(gradients, [[macro.off, 1 - gate], [macro.on, gate]], outputGradient)
      accumulate(gradients, [[macro.gate, values[macro.on]! - values[macro.off]!]], outputGradient)
      continue
    }
    if (operation.kind === 'boolean') continue
    if (operation.kind === 'affine') {
      accumulate(gradients, operation.leftTerms, outputGradient)
      continue
    }
    const left = evaluate(values, operation.leftTerms, operation.leftBias)
    const gate = evaluate(values, operation.gateTerms, operation.gateBias)
    accumulate(gradients, operation.leftTerms, Math.fround(outputGradient * Math.max(0, gate)))
    if (gate > 0) accumulate(gradients, operation.gateTerms, Math.fround(outputGradient * left))
  }
  return gradients
}

function evaluate(values: Float32Array, terms: Terms, bias: number): number {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) value = Math.fround(value + Math.fround(Math.fround(coefficient) * values[wire]!))
  return value
}

function accumulate(gradients: Float32Array, terms: readonly (readonly [Wire, number])[], outputGradient: number) {
  for (const [wire, coefficient] of terms) {
    gradients[wire] = Math.fround(gradients[wire]! + Math.fround(outputGradient * Math.fround(coefficient)))
  }
}
