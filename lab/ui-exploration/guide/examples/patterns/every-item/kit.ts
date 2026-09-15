// Helpers shared by the examples of the family "Per-item computations, then counts and sums": program
// sizes, running one circuit through both evaluators, and a seeded random generator.
import type {Circuit, Wire} from '../../../../../../numeric-ui-core.ts'

export type ProgramSize = {
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
  indexReads: number
}

// Sizes of the compiled program for `roots`. Live operations are the operations some root depends on, layers
// are the longest chain of operations that must run one after another, stored weights are the nonzero
// coefficients the compiled layers keep, gather reads are masked sums the compiler lowered to one read, and
// index reads are circuit.indexRead instructions.
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
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
    indexReads,
  }
}

// Evaluates the roots with evaluateReference, which runs operations one at a time and defines what the program
// means, and with the compiled layers from createTensorEvaluator, and throws when a root differs. Like
// validateTensorEvaluation, it treats -0 and +0 as equal. Returns the root values, and every wire's reference
// value for validateOneHotGroups, validateIndexReads and validateGrids.
export function createBothEvaluators(circuit: Circuit, roots: readonly Wire[]) {
  const evaluateCompiled = circuit.createTensorEvaluator(roots)
  return (source: Float32Array) => {
    const values = circuit.evaluateReference(source)
    const compiled = evaluateCompiled(source)
    const outputs = roots.map((root, position) => {
      if (values[root] !== compiled[position]) {
        throw new Error(`root ${position} (wire ${root}): reference ${values[root]}, compiled ${compiled[position]}`)
      }
      return compiled[position]!
    })
    return {outputs, values}
  }
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

// An integer within minimum..maximum, both included.
export function randomInteger(random: () => number, minimum: number, maximum: number) {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}
