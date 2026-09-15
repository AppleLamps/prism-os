// Shared by this folder's tests: the sizes of a compiled program, a seeded random
// generator, and a check that both evaluators return the same values.
import type {Circuit, Wire} from '../../../../../../numeric-ui-core.ts'

export type ProgramSize = {
  // Live operations: the operations some root depends on. All of them run on every evaluation.
  operations: number
  // Layers: the longest chain of operations that must run one after another.
  layers: number
  // The nonzero coefficients the layers keep.
  storedWeights: number
  // Index read instructions among the live operations.
  indexReads: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let indexReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    indexReads += layer.indexReads.length
  }
  return {
    operations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    indexReads,
  }
}

// mulberry32, so tests are repeatable.
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

// Runs one source table through evaluateReference, which runs operations one at a
// time and defines what the program means, and through the compiled layers from
// createTensorEvaluator(roots), and throws when a root differs. Compares with ===,
// like validateTensorEvaluation, so +0 and -0 count as equal. Returns the roots'
// values, and every wire's value for the validators that need them all.
export function evaluateBoth(
  circuit: Circuit,
  evaluate: (source: Float32Array) => Float32Array,
  roots: readonly Wire[],
  source: Float32Array,
): {outputs: number[], values: Float32Array} {
  const values = circuit.evaluateReference(source)
  const compiled = evaluate(source)
  const outputs = roots.map((root, index) => {
    const referenceValue = values[root]!
    if (compiled[index] !== referenceValue) {
      throw new Error(`root ${index} (wire ${root}): the compiled layers gave ${compiled[index]}, evaluateReference gave ${referenceValue}`)
    }
    return referenceValue
  })
  return {outputs, values}
}
