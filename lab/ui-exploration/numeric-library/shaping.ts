// Shader-style shaping functions (mix, remap, smoothstep), exp over small ranges,
// and a float hash for per-item pseudo-random values.
import {type Circuit, type Wire, invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {type NewtonOptions, emitReciprocal} from './arithmetic.ts'
import {emitFract} from './rounding.ts'

// mix(a, b, t) = (1 - t) * a + t * b with t in 0..1. Returns a exactly at t = 0 and
// b exactly at t = 1. 4 operations, 3 layers.
export function emitMix(circuit: Circuit, a: Wire, b: Wire, t: Wire): Wire {
  const range = circuit.ranges[t]!
  invariant(range.minimum >= 0 && range.maximum <= 1, 'mix needs t within 0..1')
  return circuit.select(t, a, b)
}

// remap(x) from [inMinimum, inMaximum] to [outMinimum, outMaximum] with constant
// endpoints: one affine, which composes into its consumers for free.
export function emitRemap(
  circuit: Circuit,
  value: Wire,
  inMinimum: number,
  inMaximum: number,
  outMinimum: number,
  outMaximum: number,
): Wire {
  invariant(inMaximum !== inMinimum, 'remap needs distinct input endpoints')
  const scale = (outMaximum - outMinimum) / (inMaximum - inMinimum)
  return circuit.affine([[value, scale]], outMinimum - inMinimum * scale)
}

// remap with endpoints read from wires. The input span inMaximum - inMinimum needs
// a declared positive range; costs one reciprocal and two products.
export function emitRemapRuntime(
  circuit: Circuit,
  value: Wire,
  inMinimum: Wire,
  inMaximum: Wire,
  outMinimum: Wire,
  outMaximum: Wire,
  span: {minimum: number, maximum: number},
  options: NewtonOptions = {},
): Wire {
  const inSpan = circuit.roundAffine([[inMaximum, 1], [inMinimum, -1]])
  circuit.assumeRange(inSpan, span.minimum, span.maximum)
  const progress = circuit.multiply(circuit.roundAffine([[value, 1], [inMinimum, -1]]), emitReciprocal(circuit, inSpan, options))
  const outSpan = circuit.roundAffine([[outMaximum, 1], [outMinimum, -1]])
  return circuit.roundAffine([[outMinimum, 1], [circuit.multiply(progress, outSpan), 1]])
}

// clamp01 of a small affine, materialized so later products read one rounding point.
function emitUnitClampOfTerms(circuit: Circuit, terms: readonly [Wire, number][], bias: number) {
  const positive = circuit.reglu([], 1, terms, bias)
  const aboveOne = circuit.reglu([], 1, terms, bias - 1)
  const clamped = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return clamped
}

// t^2 (3 - 2t), with the second factor computed inside the ReGLU gate row.
function emitSmoothstepOfUnit(circuit: Circuit, t: Wire) {
  const squared = circuit.multiply(t, t)
  const result = circuit.reglu([[squared, 1]], 0, [[t, -2]], 3)
  circuit.assumeRange(result, 0, 1)
  return result
}

// smoothstep(edge0, edge1, x) with constant edges. Exactly 0 for x <= edge0 and
// exactly 1 for x >= edge1 while |x / (edge1 - edge0)| stays below 2^23.
// 5 operations, 4 layers.
export function emitSmoothstep(circuit: Circuit, edge0: number, edge1: number, value: Wire): Wire {
  invariant(edge0 !== edge1, 'smoothstep needs distinct edges')
  const scale = 1 / (edge1 - edge0)
  return emitSmoothstepOfUnit(circuit, emitUnitClampOfTerms(circuit, [[value, scale]], -edge0 * scale))
}

// smoothstep with edges read from wires. edge1 - edge0 needs a declared positive range.
export function emitSmoothstepRuntime(
  circuit: Circuit,
  edge0: Wire,
  edge1: Wire,
  value: Wire,
  span: {minimum: number, maximum: number},
  options: NewtonOptions = {},
): Wire {
  const edgeSpan = circuit.roundAffine([[edge1, 1], [edge0, -1]])
  circuit.assumeRange(edgeSpan, span.minimum, span.maximum)
  const offset = circuit.roundAffine([[value, 1], [edge0, -1]])
  const progress = circuit.multiply(offset, emitReciprocal(circuit, edgeSpan, options))
  return emitSmoothstepOfUnit(circuit, emitUnitClampOfTerms(circuit, [[progress, 1]], 0))
}

export function expPlan(maximumMagnitude: number) {
  // Scale into |y| <= 0.5, then square `squarings` times.
  const squarings = maximumMagnitude <= 0.5 ? 0 : Math.ceil(Math.log2(maximumMagnitude / 0.5))
  // Taylor degree whose remainder 0.5^(n+1) / (n+1)! * e^0.5 is below 2^-26.
  let degree = 1
  let remainder = 0.5 ** 2 / 2 * Math.exp(0.5)
  while (remainder > 2 ** -26) {
    degree++
    remainder *= 0.5 / (degree + 1)
  }
  return {squarings, degree}
}

// Math.exp(x) for |x| <= 16: exp(y)^(2^k) with y = x / 2^k in [-0.5, 0.5] and
// a degree-8 Taylor polynomial. Relative error grows about 2^k times FP32's floor.
// degree - 1 + k operations.
export function emitExp(circuit: Circuit, value: Wire): Wire {
  const range = circuit.ranges[value]!
  const maximumMagnitude = Math.max(Math.abs(range.minimum), Math.abs(range.maximum))
  invariant(maximumMagnitude <= 16, 'exp needs a declared range inside [-16, 16]')
  const {squarings, degree} = expPlan(maximumMagnitude)
  const shrink = 2 ** -squarings
  // exp(y) = 1 + y (1 + y/2 (1 + y/3 (... (1 + y/n)))). p_i = (y / i) * (1 + p_(i+1)).
  let product = circuit.reglu([[value, shrink / (degree - 1)]], 0, [[value, shrink / degree]], 1)
  circuit.assumeRange(product, -1, 1)
  for (let index = degree - 2; index >= 1; index--) {
    product = circuit.reglu([[value, shrink / index]], 0, [[product, 1]], 1)
    circuit.assumeRange(product, -1, 1)
  }
  const upper = Math.fround(Math.exp(range.maximum) * 1.001)
  if (squarings === 0) {
    const result = circuit.roundAffine([[product, 1]], 1)
    circuit.assumeRange(result, 0, upper)
    return result
  }
  let power = circuit.reglu([[product, 1]], 1, [[product, 1]], 1)
  let powerMaximum = Math.exp(maximumMagnitude * shrink * 2) * 1.001
  circuit.assumeRange(power, 0, Math.fround(powerMaximum))
  for (let squaring = 1; squaring < squarings; squaring++) {
    power = circuit.multiply(power, power)
    powerMaximum *= powerMaximum
    circuit.assumeRange(power, 0, Math.fround(powerMaximum))
  }
  circuit.assumeRange(power, 0, upper)
  return power
}

// Dave Hoskins's "hash without sine" for one float, with every step rounded to FP32:
// p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p).
// Keys in [0, 2^20]. Bit-equal to hashReference.
export function emitHash(circuit: Circuit, key: Wire): Wire {
  const range = circuit.ranges[key]!
  invariant(range.minimum >= 0 && range.maximum <= 2 ** 20, 'hash needs a declared key range inside [0, 2^20]')
  const scaled = circuit.roundAffine([[key, 0.1031]])
  const first = emitFract(circuit, scaled)
  const second = circuit.reglu([[first, 1]], 0, [[first, 1]], 33.33)
  circuit.assumeRange(second, 0, 35)
  const third = circuit.reglu([[second, 1]], 0, [[second, 2]], 0)
  circuit.assumeRange(third, 0, 2500)
  return emitFract(circuit, third)
}

export function hashReference(key: number): number {
  const f = Math.fround
  const scaled = f(f(0 + f(f(0.1031) * key)))
  const first = f(scaled - Math.floor(scaled))
  const second = f(first * Math.max(0, f(f(33.33) + f(first))))
  const third = f(second * Math.max(0, f(f(2) * second)))
  return f(third - Math.floor(third))
}
