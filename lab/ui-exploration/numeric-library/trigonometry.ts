// Sine and cosine by quadrant reduction and short Horner polynomials.
import {type Circuit, type Wire, invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {emitFloorOnGrid, emitIntegerOneHot} from './rounding.ts'

// pi / 2 split into a 17-bit constant and a small correction (the fdlibm trick):
// quadrant * halfPiHigh stays exact for |quadrant| < 2^7, and
// angle - quadrant * halfPiHigh is exact by Sterbenz's lemma.
const halfPiHigh = 102_943 / 65_536
const halfPiLow = Math.PI / 2 - halfPiHigh
export const trigonometryDomain = 190

// Math.sin and Math.cos of an FP32 angle with |angle| <= 190 (about 60 pi).
export function emitSinCos(circuit: Circuit, angle: Wire): {sin: Wire, cos: Wire} {
  const range = circuit.ranges[angle]!
  invariant(
    range.minimum >= -trigonometryDomain && range.maximum <= trigonometryDomain,
    `sine and cosine need a declared angle range inside [-${trigonometryDomain}, ${trigonometryDomain}]`,
  )
  const quadrantLimit = Math.ceil(trigonometryDomain * 2 / Math.PI) + 1
  // quadrant = round(angle * 2 / pi), with the scale folded into the first rounding step.
  const roundingBase = 2 ** 23 + 2 ** 22
  const shifted = circuit.roundAffine([[angle, 2 / Math.PI]], roundingBase)
  const quadrant = circuit.roundAffine([[shifted, 1]], -roundingBase)
  circuit.assumeRange(quadrant, -quadrantLimit, quadrantLimit)
  const reducedHigh = circuit.roundAffine([[angle, 1], [quadrant, -halfPiHigh]])
  const reduced = circuit.roundAffine([[reducedHigh, 1], [quadrant, -halfPiLow]])
  circuit.assumeRange(reduced, -0.8, 0.8)
  const squared = circuit.multiply(reduced, reduced)
  circuit.assumeRange(squared, 0, 0.64)

  // Horner steps c + squared * (inner), each one ReGLU row whose left side
  // computes the inner sum in place.
  const hornerProduct = (coefficients: readonly number[]) => {
    // Returns p with value = coefficients[0] + p.
    let product = circuit.reglu([], coefficients.at(-1)!, [[squared, 1]], 0)
    circuit.assumeRange(product, -1, 1)
    for (let index = coefficients.length - 2; index >= 1; index--) {
      product = circuit.reglu([[product, 1]], coefficients[index]!, [[squared, 1]], 0)
      circuit.assumeRange(product, -1, 1)
    }
    return product
  }
  // sin(r) / r = 1 - r^2/3! + r^4/5! - r^6/7! + r^8/9!
  const sineProduct = hornerProduct([1, -1 / 6, 1 / 120, -1 / 5040, 1 / 362_880])
  const sine = circuit.reglu([[reduced, 1]], 0, [[sineProduct, 1]], 1)
  circuit.assumeRange(sine, -0.75, 0.75)
  // cos(r) = 1 - r^2/2! + r^4/4! - r^6/6! + r^8/8! - r^10/10!
  const cosineProduct = hornerProduct([1, -1 / 2, 1 / 24, -1 / 720, 1 / 40_320, -1 / 3_628_800])
  const cosine = circuit.roundAffine([[cosineProduct, 1]], 1)
  circuit.assumeRange(cosine, 0.65, 1)
  const negativeSine = circuit.roundAffine([[sine, -1]])
  const negativeCosine = circuit.roundAffine([[cosine, -1]])
  circuit.assumeRange(negativeSine, -0.75, 0.75)
  circuit.assumeRange(negativeCosine, -1, -0.65)

  // quadrant mod 4 from a floor on the 1/4 grid, then its one-hot.
  const quarter = emitFloorOnGrid(circuit, circuit.roundAffine([[quadrant, 0.25]]), 2)
  const quadrantClass = circuit.roundAffine([[quadrant, 1], [quarter, -4]])
  circuit.assumeRange(quadrantClass, 0, 3)
  const classes = emitIntegerOneHot(circuit, quadrantClass, 0, 3)
  const pick = (candidates: readonly Wire[]) =>
    circuit.affine(candidates.map((candidate, index) => [circuit.multiply(candidate, classes[index]!), 1]))
  const sin = pick([sine, cosine, negativeSine, negativeCosine])
  const cos = pick([cosine, negativeSine, negativeCosine, sine])
  circuit.assumeRange(sin, -1, 1)
  circuit.assumeRange(cos, -1, 1)
  return {sin, cos}
}

export function emitSin(circuit: Circuit, angle: Wire) {
  return emitSinCos(circuit, angle).sin
}

export function emitCos(circuit: Circuit, angle: Wire) {
  return emitSinCos(circuit, angle).cos
}
