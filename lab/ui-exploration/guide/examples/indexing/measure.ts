// Counting helpers for the examples in this folder, over the repo root runtime.
import type {Circuit, Wire} from '../../../../../numeric-ui-core.ts'

export type ProgramCounts = {
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
}

// Compile the operations that the roots need and count what the executor runs.
// Stored weights are the nonzero entries of every layer's sparse matrix.
export function countProgram(circuit: Circuit, roots: readonly Wire[], lowerGathers = true): ProgramCounts {
  const program = circuit.compileTensorProgram(roots, lowerGathers)
  let storedWeights = 0
  let gatherReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
  }
  return {
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
  }
}

// Evaluate one source table with the reference evaluator and with the compiled
// program, and count the live wires whose values differ.
export function countMismatches(
  circuit: Circuit,
  roots: readonly Wire[],
  source: Float32Array,
  lowerGathers = true,
): {mismatches: number, reference: Float32Array, compiled: Float32Array} {
  const program = circuit.compileTensorProgram(roots, lowerGathers)
  const reference = circuit.evaluateReference(source)
  const previousProgram = circuit.tensorProgram
  circuit.tensorProgram = program
  const compiled = circuit.evaluateTensor(source)
  circuit.tensorProgram = previousProgram
  let mismatches = 0
  for (const wire of program.wireOrder) {
    const compiledValue = compiled[wire]!
    const referenceValue = reference[wire]!
    if (!(compiledValue === referenceValue || Object.is(compiledValue, referenceValue))) mismatches++
  }
  return {mismatches, reference, compiled}
}

// The derivative of evaluate at point, as a central difference with step h.
export function centralDifference(evaluate: (point: number) => number, point: number, h: number): number {
  return (evaluate(point + h) - evaluate(point - h)) / (2 * h)
}
