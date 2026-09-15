import type {Circuit, Wire} from '../../../../../numeric-ui-core.ts'

export type ProgramSize = {
  // Live operations in the compiled program: the total work of one evaluation.
  operations: number
  // Compiled layers: the longest chain of operations that must run one after another.
  layers: number
  // Nonzero coefficients stored in the layers' sparse matrices.
  storedWeights: number
  // Masked sums over a declared one-hot that the compiler turned into indexed reads.
  gatherReads: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  return {
    operations: program.valueCount - circuit.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    gatherReads: program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0),
  }
}
