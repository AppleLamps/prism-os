// Small builder helpers for the model section's examples. Each one only calls numeric-ui-core.ts, and each one is
// ordinary JavaScript that runs once, while building, and appends operations to a circuit.
import {type Circuit, type Wire, emitRelu, invariant} from '../../../../../src/runtime/numeric-ui-core.ts'

// Live operations, layers and stored weights of the program compiled for these roots. Live operations are the ones
// some root depends on; stored weights are the nonzero coefficients of every layer's sparse matrix.
export function measure(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  for (const layer of program.layers) storedWeights += layer.weights.length
  return {liveOperations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights}
}

// A wire that always holds `value`. When an ordinary affine reads it, the builder adds the value to that affine's bias
// instead of reading the wire; min, max, multiply and select keep it as a wire of its own.
export function emitConstant(circuit: Circuit, value: number): Wire {
  return circuit.affine([], value)
}

// JS: 1 - bit, for a bit that is exactly 0 or 1.
export function emitNot(circuit: Circuit, bit: Wire): Wire {
  return circuit.affine([[bit, -1]], 1)
}

// JS: Math.min(1, Math.max(0, value)), as relu(value) - relu(value - 1). When value is its own operation, the result is
// exactly 1 for every value above 1 while value is at most 2^24. When value is a small affine that the builder copies
// into both ReLUs, both copies must add without rounding, e.g. up to 2^23 for multiples of 1/2, while value = x + 0.25
// at x = Math.fround(0.8) gives 0.99999994 (execution-model.md, "Clamping").
export function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const aboveZero = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const clamped = circuit.affine([[aboveZero, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return clamped
}

// JS: a >= b ? 1 : 0, as an exact bit, e.g. pointerX >= trackLeft.
// The difference is kept as its own operation, so FP32 rounds it once, and for finite operands it is 0 exactly when
// a === b. Multiplying by a power of two is exact. Adding 0.5 and clamping to 0..1 puts a difference of 0 exactly on
// 0.5, which the boolean atom sends to 1, and any difference of at least 2^-23 / scale on the right side of 0.5.
// The score is a small affine, so the builder copies it into both of the clamp's ReLUs. While scale * |a - b| <= 2^22,
// each copy rounds by at most 1/4, so for a score above 1 the clamp returns a value within 0.5..1.5, e.g. 0.99999994 for
// a = Math.fround(0.8) / 64 and b = 0, and the boolean atom sends every such value to 1. The helper reads that bound from
// the declared ranges and throws while building without it. For operands on the
// host's 1/64 px grid, any two different values differ by at least 2^-6, far above the comparison's resolution.
export function emitAtLeast(circuit: Circuit, a: Wire, b: Wire, scale: number): Wire {
  invariant(Number.isInteger(Math.log2(scale)), 'the comparison scale must be a power of two')
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  const range = circuit.ranges[difference]!
  const largestDifference = Math.max(Math.abs(range.minimum), Math.abs(range.maximum))
  invariant(
    Number.isFinite(largestDifference) && scale * largestDifference <= 2 ** 22,
    `comparison needs declared ranges with scale * |a - b| <= 2^22, got at most ${largestDifference}`,
  )
  const score = circuit.affine([[difference, scale]], 0.5)
  return circuit.boolean(emitClampZeroOne(circuit, score))
}

// JS: value >= threshold ? 1 : 0, for an integer value, as relu(value - threshold + 1) - relu(value - threshold).
// An integer can't land strictly between threshold - 1 and threshold, so the result is exactly 0 or 1. The bit is kept
// as its own operation: otherwise the builder would copy both ReLUs into a later sum with large coefficients, and the
// running FP32 sum would round them (lab/ui-exploration/lists/README.md, "Hazard").
export function emitIntegerAtLeast(circuit: Circuit, value: Wire, threshold: number): Wire {
  const upper = emitRelu(circuit, circuit.affine([[value, 1]], 1 - threshold))
  const lower = emitRelu(circuit, circuit.affine([[value, 1]], -threshold))
  const bit = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// JS: bits.every(bit => bit === 1) ? 1 : 0, as relu(bit0 + ... + bitN - (N - 1)). The sum is an integer from 0 to N,
// so the ReLU returns exactly 1 when every bit is 1, and 0 otherwise.
export function emitAll(circuit: Circuit, bits: readonly Wire[]): Wire {
  return emitRelu(circuit, circuit.affine(bits.map(bit => [bit, 1] as const), -(bits.length - 1)))
}
