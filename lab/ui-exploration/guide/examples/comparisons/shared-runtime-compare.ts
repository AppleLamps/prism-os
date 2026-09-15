// emitCompare in the repo root runtime, numeric-ui-core.ts: the one comparison
// helper that Cheng decided on September 14, 2026 building blocks should use. It
// builds integer bits when both operands are declared on a grid, a sign cascade
// planned for every FP32 value otherwise, and ends with a boolean atom only with
// {endWithBoolean: true}. The other files in this folder build each form by hand, to show how and
// why each form works; shared-runtime-compare.test.ts checks that the helper gives
// the same bits as native comparisons and as the hand-built sign cascade.
import {Circuit, type Relation, emitCompare, emitMinimum, emitMinimumExact} from '../../../../../numeric-ui-core.ts'

export const relations: readonly Relation[] = ['>', '>=', '<', '<=', '===']

// [pointerX relation windowLeft] for every relation, over two source cells declared
// within 0..16,384. With a grid, e.g. 1/64 when the host writes coordinates in
// 1/64 px, the declaration states that both cells hold multiples of it.
// Source table: [pointerX, windowLeft].
export function buildSharedCompare(options: {grid?: number, endWithBoolean?: boolean} = {}) {
  const circuit = new Circuit(2)
  const pointerX = 0
  const windowLeft = 1
  for (const wire of [pointerX, windowLeft]) {
    circuit.assumeRange(wire, 0, 16_384)
    if (options.grid !== undefined) circuit.assumeGrid(wire, options.grid)
  }
  const endWithBoolean = options.endWithBoolean ?? false
  const bits = relations.map(relation => emitCompare(circuit, pointerX, relation, windowLeft, {endWithBoolean}))
  return {circuit, pointerX, windowLeft, bits}
}

// Math.min(a, b) two ways, over two source cells declared within 0..16,384:
// emitMinimum computes a - relu(a - b), which rebuilds the smaller operand from a
// rounded difference, and emitMinimumExact selects one operand with an emitCompare bit.
// Source table: [a, b].
export function buildMinimums() {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 16_384)
  circuit.assumeRange(1, 0, 16_384)
  const drifting = emitMinimum(circuit, 0, 1)
  const exact = emitMinimumExact(circuit, 0, 1)
  return {circuit, drifting, exact}
}
