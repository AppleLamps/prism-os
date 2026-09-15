// Prefix sums in FP32: one addition at a time, or with the Brent-Kung network, against float64.
//
// A running total that has passed a million pixels, where FP32 values are 1/8 px apart, rounds every
// addition of a few hundred pixels. The Brent-Kung network adds neighbors first, then pairs of pairs, so
// most of its additions combine sums of similar size, and only its last few levels add at the total's size.
const f = Math.fround

// through[i] = values[0] + ... + values[i], one rounded addition at a time.
export function sequentialThrough(values: Float32Array): Float32Array {
  const through = new Float32Array(values.length)
  let running = 0
  for (let index = 0; index < values.length; index++) {
    running = f(running + values[index]!)
    through[index] = running
  }
  return through
}

// The same outputs from the Brent-Kung network, with the loops of instanced-items/executor.ts. The upward
// pass stores the sum of each block of 2, 4, 8, ... items at the block's last position; the downward pass
// fills in the other positions. About 2n additions over about 2 log2 n levels. Writing into a
// Float32Array rounds each addition to FP32.
export function brentKungThrough(values: Float32Array): Float32Array {
  const inclusive = Float32Array.from(values)
  const count = values.length
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
  }
  for (span = span / 4; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
  }
  return inclusive
}

// The same partial sums of the same FP32 values, in float64, where these totals have no visible rounding.
export function float64Through(values: Float32Array): Float64Array {
  const through = new Float64Array(values.length)
  let running = 0
  for (let index = 0; index < values.length; index++) {
    running += values[index]!
    through[index] = running
  }
  return through
}

export function largestDifference(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let largest = 0
  for (let index = 0; index < left.length; index++) largest = Math.max(largest, Math.abs(left[index]! - right[index]!))
  return largest
}

// Strip steps like the gallery's 1D strip at a 1440 × 900 window: each unfocused photo is
// 0.7 × min(1136, naturalWidth, 760 × aspectRatio) wide, plus the 52 px gap. Photos use the aspect ratios
// and integer width jitter of instanced-items/synthetic-photos.ts, from the same seeded generator.
export function syntheticStripSteps(count: number, seed = 20260913): Float32Array {
  const shapes = [[2048, 2048], [1792, 2688], [2688, 1792], [1632, 2912], [2912, 1632], [1344, 896], [896, 1344], [1536, 768], [1856, 2464], [2464, 1856], [1456, 816]] as const
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const steps = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    const [width, height] = shapes[Math.floor(random() * shapes.length)]!
    const naturalWidth = width + Math.floor(random() * 97) - 48
    const base = Math.min(1136, naturalWidth, 760 * (naturalWidth / height))
    steps[index] = base * 0.7 + 52
  }
  return steps
}

export function measurePrefixDrift(steps: Float32Array) {
  const exact = float64Through(steps)
  return {
    total: exact[exact.length - 1]!,
    sequentialDrift: largestDifference(sequentialThrough(steps), exact),
    brentKungDrift: largestDifference(brentKungThrough(steps), exact),
  }
}
