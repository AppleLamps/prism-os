// Small helpers shared by the loops section's examples.
import {Circuit, type Terms, type Wire} from '../../../../../numeric-ui-core.ts'

// The exact bit [terms + bias >= 0], for a sum that always holds an integer below 2^23 in
// magnitude. relu(v + 1) - relu(v) is 0 for v <= -1 and 1 for v >= 0, and an integer can't land
// in between. The bit is kept as its own operation (roundAffine), so a sum that reads many bits
// adds 0s and 1s, not copies of the large ReLU values each bit is made of.
export function emitIntegerAtLeastZero(circuit: Circuit, terms: Terms, bias: number): Wire {
  const upper = circuit.reglu([], 1, terms, bias + 1)
  const lower = circuit.reglu([], 1, terms, bias)
  const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

export type ProgramSize = {
  liveOperations: number
  layers: number
  storedWeights: number
  gatherReads: number
}

// Sizes of the compiled program that computes `roots`, after operations that can't reach a root
// are removed and masked sums over declared one-hot groups are lowered to indexed reads.
export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
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
