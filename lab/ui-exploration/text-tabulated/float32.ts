// Stepping through FP32 values by their bit patterns. For nonnegative finite values, bit-pattern
// order is numeric order, so bisection over integers finds the exact FP32 boundary of a step function.

const float32View = new Float32Array(1)
const uint32View = new Uint32Array(float32View.buffer)

export function float32Bits(value: number): number {
  float32View[0] = value
  return uint32View[0]!
}

export function float32FromBits(bits: number): number {
  uint32View[0] = bits
  return float32View[0]!
}

export function nextFloat32Up(value: number): number {
  const rounded = Math.fround(value)
  if (rounded === 0) return float32FromBits(1)
  return float32FromBits(float32Bits(rounded) + 1)
}

export function nextFloat32Down(value: number): number {
  const rounded = Math.fround(value)
  if (rounded <= 0) throw new Error('nextFloat32Down expects a positive value')
  return float32FromBits(float32Bits(rounded) - 1)
}

// A deterministic pseudo-random generator for tests and traces.
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
