// Sizes of a compiled program, and a seeded random generator, shared by this folder's examples.
import type {Circuit, Wire} from '../../../../../../numeric-ui-core.ts'

export type ProgramSize = {
  // Live operations: the total work of one evaluation.
  operations: number
  // Compiled layers: the longest chain of operations that must run one after another.
  layers: number
  // Nonzero coefficients that the compiled layers keep.
  storedWeights: number
  // Masked sums over a declared one-hot that the compiler turned into gathers.
  gatherReads: number
  // Index read instructions.
  indexReads: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  let indexReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    indexReads += layer.indexReads.length
  }
  return {
    operations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    indexReads,
  }
}

export function formatSize(size: ProgramSize): string {
  return `${size.operations} operations, ${size.layers} layers, ${size.storedWeights} weights, ${size.gatherReads} gather reads, ${size.indexReads} index reads`
}

// A seeded random generator (mulberry32), so tests are repeatable.
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
