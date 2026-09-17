// Helpers shared by this folder's examples: program sizes, AND over exact bits,
// evaluating one table with both evaluators, frame times, and a seeded random
// number generator.
import type {Circuit, Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'

export type ProgramSize = {
  // Live operations in the compiled program: the total work of one evaluation.
  operations: number
  // Compiled layers: the longest chain of operations that must run one after another.
  layers: number
}

export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  return {operations: program.valueCount - circuit.sourceSize, layers: program.layers.length}
}

// 'compiled' runs the compiled layers, and 'reference' runs evaluateReference, which
// runs operations one at a time and defines what a program means.
export type Evaluator = 'compiled' | 'reference'

// Returns a function from a source table to the roots' values.
export function createEvaluator(circuit: Circuit, roots: readonly Wire[], evaluator: Evaluator): (source: Float32Array) => Float32Array {
  if (evaluator === 'compiled') return circuit.createTensorEvaluator(roots)
  return source => {
    const values = circuit.evaluateReference(source)
    return Float32Array.from(roots, root => values[root]!)
  }
}

// AND of exact bits, relu(sum of the bits - (count - 1)), which is 1 only when every bit is 1.
export function emitAll(circuit: Circuit, bits: readonly Wire[]): Wire {
  return circuit.reglu([], 1, bits.map((bit): [Wire, number] => [bit, 1]), -(bits.length - 1))
}

// Runs one table through evaluateReference, which runs operations one at a time and
// defines what the program means, and through the compiled program, and throws
// unless every root holds the same bits in both. Returns a copy of the roots' values.
export function evaluateBoth(
  circuit: Circuit,
  evaluate: (source: Float32Array) => Float32Array,
  roots: readonly Wire[],
  source: Float32Array,
): Float32Array {
  const referenceValues = circuit.evaluateReference(source)
  const tensorValues = evaluate(source)
  for (let index = 0; index < roots.length; index++) {
    if (!Object.is(referenceValues[roots[index]!], tensorValues[index])) {
      throw new Error(`root ${index} differs between the evaluators: ${referenceValues[roots[index]!]} against ${tensorValues[index]}`)
    }
  }
  return Float32Array.from(tensorValues)
}

// Frame timestamps at a steady rate, computed as (frame × 1000) / hz, so every
// fourth 120 fps frame time is bit-identical to a 30 fps frame time. A stall skips
// the frames strictly inside it. Copied from guide/examples/springs/frame-rate-check.ts.
export function frameTimesAt(hz: number, durationMs: number, stall?: {startMs: number, lengthMs: number}): number[] {
  const times: number[] = []
  for (let frame = 0; ; frame++) {
    const time = (frame * 1000) / hz
    if (time > durationMs) break
    if (stall !== undefined && time > stall.startMs && time < stall.startMs + stall.lengthMs) continue
    times.push(time)
  }
  return times
}

// mulberry32, copied from guide/examples/springs/frame-rate-check.ts.
export function seededRandom(seed: number) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// The FP32 value next to value, toward +Infinity (direction 1) or -Infinity
// (direction -1), for probing comparisons right next to their thresholds.
export function nextFloat32(value: number, direction: 1 | -1): number {
  const float = new Float32Array([value])
  const bits = new Uint32Array(float.buffer)
  if (float[0] === 0) {
    bits[0] = 1
    return direction * float[0]!
  }
  // Adding 1 to the stored bits moves away from zero, for either sign.
  bits[0] = (float[0]! > 0) === (direction > 0) ? bits[0]! + 1 : bits[0]! - 1
  return float[0]!
}
