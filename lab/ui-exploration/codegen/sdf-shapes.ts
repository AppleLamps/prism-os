// Shader-style shapes as an instance-parallel workload: signed distances for
// rounded rectangles and circles, antialiased fills, a smooth hover falloff
// driven by the pointer, a glow ring, and the exact frontmost shape under each
// pixel. The pixel position is the per-instance cell; the pointer and the
// shapes are shared, so every hover computation happens once per frame.
//
// A signed distance needs a Euclidean length, and a length needs a square
// root. Instead, the length of (u, v) with u, v ≥ 0 is the largest projection
// of the vector onto a fan of directions: fold into the octant (big ≥ small),
// then take max over k of big · cos θk + small · sin θk for θk spread over 0°
// to 45°. With 16 directions the result is within ±0.015% of the true length,
// and it only uses affine sums and maxima. No squares appear, so 4K coordinates
// don't leave FP32's exact range the way squared distances do.
import {Circuit, type Wire, emitMaximum, emitMultiply, emitRelu, emitSelect} from '../../../src/runtime/numeric-ui-core.ts'

export const shapeField = {centerX: 0, centerY: 1, halfWidth: 2, halfHeight: 3, radius: 4, red: 5, green: 6, blue: 7, size: 8} as const
export const sdfSourceField = {pixelX: 0, pixelY: 1, pointerX: 2, pointerY: 3, unit: 4, shapeStart: 5} as const
export const sdfOutputField = {red: 0, green: 1, blue: 2, owner: 3, size: 4} as const

export type Shape = {centerX: number, centerY: number, halfWidth: number, halfHeight: number, radius: number, red: number, green: number, blue: number}

export const defaultShapes: Shape[] = [
  {centerX: 150, centerY: 118, halfWidth: 112, halfHeight: 72, radius: 18, red: 66, green: 133, blue: 244},
  {centerX: 338, centerY: 150, halfWidth: 86, halfHeight: 86, radius: 86, red: 234, green: 84, blue: 106},
  {centerX: 262, centerY: 268, halfWidth: 160, halfHeight: 28, radius: 28, red: 250, green: 188, blue: 45},
  {centerX: 470, centerY: 78, halfWidth: 44, halfHeight: 44, radius: 44, red: 52, green: 199, blue: 120},
  {centerX: 486, centerY: 262, halfWidth: 72, halfHeight: 52, radius: 10, red: 150, green: 110, blue: 230},
  {centerX: 92, centerY: 304, halfWidth: 58, halfHeight: 30, radius: 14, red: 40, green: 190, blue: 210},
]
export const background = {red: 18, green: 20, blue: 28} as const
const hoverFalloff = 36
const glowWidth = 22
const hoverBrightening = 48

export function shapeSourceField(shape: number, field: number) {
  return sdfSourceField.shapeStart + shape * shapeField.size + field
}

function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.roundAffine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

export function polygonDirectionAngles(directions: number) {
  return Array.from({length: directions + 1}, (_, index) => index * Math.PI / 4 / directions)
}

// The fan of projections underestimates the length by at most 1 - cos(Δ/2),
// Δ = 45° / directions. Scaling by the midpoint centers the error around zero.
export function polygonScale(directions: number) {
  return 1 / ((1 + Math.cos(Math.PI / 4 / directions / 2)) / 2)
}

function emitPolygonLength(circuit: Circuit, u: Wire, v: Wire, directions: number) {
  const excess = emitRelu(circuit, circuit.roundAffine([[u, 1], [v, -1]]))
  const big = circuit.roundAffine([[v, 1], [excess, 1]])
  const small = circuit.roundAffine([[u, 1], [excess, -1]])
  const scale = polygonScale(directions)
  let level = polygonDirectionAngles(directions).map(angle => angle === 0
    ? circuit.roundAffine([[big, scale]])
    : circuit.roundAffine([[big, Math.cos(angle) * scale], [small, Math.sin(angle) * scale]]))
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : emitMaximum(circuit, level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

// iq's rounded box: q = |p - c| - (halfSize - radius);
// distance = length(max(q, 0)) + min(max(qx, qy), 0) - radius.
function emitRoundedBoxDistance(circuit: Circuit, x: Wire, y: Wire, shape: number, directions: number) {
  const field = (name: keyof typeof shapeField) => shapeSourceField(shape, shapeField[name])
  const dx = circuit.roundAffine([[x, 1], [field('centerX'), -1]])
  const dy = circuit.roundAffine([[y, 1], [field('centerY'), -1]])
  const absoluteX = circuit.roundAffine([[emitRelu(circuit, dx), 1], [circuit.reglu([], 1, [[dx, -1]], 0), 1]])
  const absoluteY = circuit.roundAffine([[emitRelu(circuit, dy), 1], [circuit.reglu([], 1, [[dy, -1]], 0), 1]])
  const qx = circuit.roundAffine([[absoluteX, 1], [field('halfWidth'), -1], [field('radius'), 1]])
  const qy = circuit.roundAffine([[absoluteY, 1], [field('halfHeight'), -1], [field('radius'), 1]])
  const outside = emitPolygonLength(circuit, emitRelu(circuit, qx), emitRelu(circuit, qy), directions)
  const inside = circuit.reglu([], 1, [[emitMaximum(circuit, qx, qy), -1]], 0)
  return circuit.roundAffine([[outside, 1], [inside, -1], [field('radius'), -1]])
}

// [distance ≤ 0]: the preserved-difference comparison with a 2^9 scale.
function emitInsideBit(circuit: Circuit, distance: Wire, unit: Wire) {
  const score = circuit.roundAffine([[distance, -512]], 0.5)
  return circuit.boolean(emitClampZeroOne(circuit, score, unit))
}

export function createSdfShapesCircuit(shapeCount = defaultShapes.length, directions = 16) {
  const circuit = new Circuit(sdfSourceField.shapeStart + shapeCount * shapeField.size)
  circuit.assumeRange(sdfSourceField.pixelX, 0, 8192)
  circuit.assumeRange(sdfSourceField.pixelY, 0, 8192)
  circuit.assumeRange(sdfSourceField.pointerX, -8192, 8192)
  circuit.assumeRange(sdfSourceField.pointerY, -8192, 8192)
  circuit.assumeRange(sdfSourceField.unit, 1, 1)
  for (let shape = 0; shape < shapeCount; shape++) {
    for (const name of ['centerX', 'centerY'] as const) circuit.assumeRange(shapeSourceField(shape, shapeField[name]), -8192, 8192)
    for (const name of ['halfWidth', 'halfHeight', 'radius'] as const) circuit.assumeRange(shapeSourceField(shape, shapeField[name]), 0, 4096)
    for (const name of ['red', 'green', 'blue'] as const) circuit.assumeRange(shapeSourceField(shape, shapeField[name]), 0, 255)
  }
  const unit = sdfSourceField.unit
  let red: Wire = circuit.affine([], background.red)
  let green: Wire = circuit.affine([], background.green)
  let blue: Wire = circuit.affine([], background.blue)
  const insideBits: Wire[] = []
  const hovers: Wire[] = []
  for (let shape = 0; shape < shapeCount; shape++) {
    const field = (name: keyof typeof shapeField) => shapeSourceField(shape, shapeField[name])
    // Shared: the pointer's distance to this shape and a smoothstep falloff.
    const pointerDistance = emitRoundedBoxDistance(circuit, sdfSourceField.pointerX, sdfSourceField.pointerY, shape, directions)
    const nearness = emitClampZeroOne(circuit, circuit.roundAffine([[pointerDistance, -1 / hoverFalloff]], 1), unit)
    const hover = emitMultiply(circuit, emitMultiply(circuit, nearness, nearness), circuit.roundAffine([[nearness, -2]], 3))
    circuit.assumeRange(hover, 0, 1)
    hovers.push(hover)
    const shapeColor = (channel: 'red' | 'green' | 'blue') => circuit.roundAffine([[field(channel), 1], [hover, hoverBrightening]])
    // Per pixel: distance, fill coverage, glow ring.
    const distance = emitRoundedBoxDistance(circuit, sdfSourceField.pixelX, sdfSourceField.pixelY, shape, directions)
    const coverage = emitClampZeroOne(circuit, circuit.roundAffine([[distance, -1]], 0.5), unit)
    const ring = emitClampZeroOne(circuit, circuit.roundAffine([[emitRelu(circuit, distance), -1 / glowWidth]], 1), unit)
    const glow = emitMultiply(circuit, emitMultiply(circuit, ring, ring), circuit.roundAffine([[hover, 0.6]]))
    circuit.assumeRange(glow, 0, 1)
    red = emitSelect(circuit, coverage, emitSelect(circuit, glow, red, shapeColor('red')), shapeColor('red'))
    green = emitSelect(circuit, coverage, emitSelect(circuit, glow, green, shapeColor('green')), shapeColor('green'))
    blue = emitSelect(circuit, coverage, emitSelect(circuit, glow, blue, shapeColor('blue')), shapeColor('blue'))
    insideBits.push(emitInsideBit(circuit, distance, unit))
  }
  // Later shapes draw on top: walk from the top shape down and keep the first hit.
  const ownerTerms: [Wire, number][] = []
  let remaining: Wire = unit
  for (let shape = shapeCount - 1; shape >= 0; shape--) {
    ownerTerms.push([emitMultiply(circuit, remaining, insideBits[shape]!), shape + 1])
    remaining = emitRelu(circuit, circuit.affine([[remaining, 1], [insideBits[shape]!, -1]]))
  }
  const owner = circuit.affine(ownerTerms)
  const outputs = Array<Wire>(sdfOutputField.size)
  outputs[sdfOutputField.red] = red
  outputs[sdfOutputField.green] = green
  outputs[sdfOutputField.blue] = blue
  outputs[sdfOutputField.owner] = owner
  return {circuit, outputs, hovers, instanceSources: [sdfSourceField.pixelX, sdfSourceField.pixelY]}
}

export function sdfShapesSource(pointerX: number, pointerY: number, shapes: readonly Shape[] = defaultShapes) {
  const source = new Float32Array(sdfSourceField.shapeStart + shapes.length * shapeField.size)
  source[sdfSourceField.pointerX] = pointerX
  source[sdfSourceField.pointerY] = pointerY
  source[sdfSourceField.unit] = 1
  shapes.forEach((shape, index) => {
    for (const name of Object.keys(shapeField) as (keyof typeof shapeField)[]) {
      if (name === 'size') continue
      source[shapeSourceField(index, shapeField[name])] = shape[name]
    }
  })
  return source
}

export function pixelCenters(width: number, height: number) {
  const pixels = new Float32Array(width * height * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 2] = x + 0.5
      pixels[(y * width + x) * 2 + 1] = y + 0.5
    }
  }
  return pixels
}

// Float64 reference with exact Euclidean lengths (Math.hypot).
export function referenceShapeDistance(shape: Shape, x: number, y: number) {
  const qx = Math.abs(x - shape.centerX) - (shape.halfWidth - shape.radius)
  const qy = Math.abs(y - shape.centerY) - (shape.halfHeight - shape.radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - shape.radius
}

export function referenceShapesPixel(shapes: readonly Shape[], pointerX: number, pointerY: number, x: number, y: number) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  const mix = (from: number, to: number, amount: number) => amount * to + (1 - amount) * from
  let red: number = background.red
  let green: number = background.green
  let blue: number = background.blue
  let owner = 0
  shapes.forEach((shape, index) => {
    const nearness = clamp(1 - referenceShapeDistance(shape, pointerX, pointerY) / hoverFalloff)
    const hover = nearness * nearness * (3 - 2 * nearness)
    const distance = referenceShapeDistance(shape, x, y)
    const coverage = clamp(0.5 - distance)
    const ring = clamp(1 - Math.max(distance, 0) / glowWidth)
    const glow = ring * ring * hover * 0.6
    red = mix(mix(red, shape.red + hover * hoverBrightening, glow), shape.red + hover * hoverBrightening, coverage)
    green = mix(mix(green, shape.green + hover * hoverBrightening, glow), shape.green + hover * hoverBrightening, coverage)
    blue = mix(mix(blue, shape.blue + hover * hoverBrightening, glow), shape.blue + hover * hoverBrightening, coverage)
    if (distance <= 0) owner = index + 1
  })
  return {red, green, blue, owner}
}
