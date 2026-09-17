// Small helpers shared by the selection patterns' examples.
import {Circuit, invariant, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'

export type ProgramSize = {
  operations: number
  layers: number
  storedWeights: number
  gatherReads: number
}

// Sizes of the compiled program that computes `roots`: live operations, layers, stored weights, and
// masked sums that the compiler lowered to gathers.
export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
  }
  return {
    operations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights,
    gatherReads,
  }
}

// Evaluates `roots` with evaluateReference, which runs operations one at a time and defines what a
// program means, and with the compiled executor, and throws unless both return the same bits. Returns
// the compiled values of the roots, and every wire's value from the reference evaluator, for
// validateOneHotGroups.
export function createBothEvaluators(circuit: Circuit, roots: readonly Wire[]) {
  const evaluateCompiled = circuit.createTensorEvaluator(roots)
  return (source: Float32Array) => {
    const everyWire = circuit.evaluateReference(source)
    const compiled = Array.from(evaluateCompiled(source))
    roots.forEach((root, index) => {
      if (!Object.is(everyWire[root], compiled[index])) {
        invariant(false, `root ${root}: the reference evaluator gives ${everyWire[root]}, the compiled executor ${compiled[index]}`)
      }
    })
    return {roots: compiled, everyWire}
  }
}

// A seeded random generator (mulberry32), so tests and reports are repeatable.
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

// The FP32 value `steps` representable values above an FP32 value within 0..2^24.
export function nextFloat32Up(value: number, steps = 1): number {
  const buffer = new Float32Array(1)
  const bits = new Uint32Array(buffer.buffer)
  buffer[0] = value
  bits[0] = bits[0]! + steps
  return buffer[0]!
}
