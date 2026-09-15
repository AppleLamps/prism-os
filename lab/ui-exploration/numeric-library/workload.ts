// A shader-style workload built from the library: a dock whose icons magnify with a
// smooth radial falloff around the pointer and push their neighbors apart, the
// nearest icon as an exact one-hot, and a circular progress ring with a spinning
// set of ticks, lit ticks, a head dot, per-cycle jitter, and a percent label.
import {Circuit, type Wire, invariant} from '../../../numeric-ui-core.ts'
import {emitSqrt} from './arithmetic.ts'
import {emitClampExact, emitMinimumOf, emitSignBit, planCompare} from './comparison.ts'
import {emitFloor, emitFract} from './rounding.ts'
import {emitHash, emitSmoothstep, hashReference} from './shaping.ts'
import {ceilFloat32, stepFloat32} from './measure.ts'
import {emitSinCos} from './trigonometry.ts'

export const iconCount = 9
export const tickCount = 24

export const workloadField = {
  viewportWidth: 0,
  viewportHeight: 1,
  pointerX: 2,
  pointerY: 3,
  pointerInside: 4,
  progress: 5,
  seconds: 6,
  size: 7,
} as const

export const workloadConstants = {
  iconSize: 48,
  iconGap: 10,
  dockBottomInset: 16,
  maximumScale: 2.2,
  falloffRadius: 150,
  ringRadius: 64,
  ringInset: 112,
  tickRadius: 3,
  spinPeriod: 2.4,
  jitter: 3,
} as const

export type WorkloadOutputs = {
  iconLeft: Wire[]
  iconTop: Wire[]
  iconSize: Wire[]
  nearestIcon: Wire[]
  headX: Wire
  headY: Wire
  tickX: Wire[]
  tickY: Wire[]
  tickLit: Wire[]
  tickOpacity: Wire[]
  percent: Wire
}

// Math.floor(progress * 100) as float64 computes it, for an FP32 progress in [0, 1].
// floor(fround(progress * 100)) is one too high whenever the product rounds up to an
// integer, e.g. progress = fround(0.01) = 0.0099999998 gives 1 instead of 0. float64
// holds progress * 100 exactly (24 + 5 significant bits), and FP32 can hold it as two
// exact parts: with scaled = progress * 2^19, high = floor(scaled), and
// low = scaled - high, both high * 100 / 2^19 and low * 100 / 2^19 are exact whenever
// progress >= 2^-15. The floor of their sum is floor(highProduct) plus the carry
// [lowProduct >= 1 - fract(highProduct)]. Below 2^-15 both forms return 0.
// 25 operations and 20 layers, against 8 and 7 for floor(fround(progress * 100)).
export function emitPercentOfUnit(circuit: Circuit, progress: Wire): Wire {
  const range = circuit.ranges[progress]!
  invariant(range.minimum >= 0 && range.maximum <= 1, 'percent needs a declared range inside [0, 1]')
  const scaled = circuit.roundAffine([[progress, 2 ** 19]])
  const high = emitFloor(circuit, scaled)
  const low = circuit.roundAffine([[scaled, 1], [high, -1]])
  circuit.assumeRange(low, 0, 1)
  const partScale = 100 / 2 ** 19
  const highProduct = circuit.roundAffine([[high, partScale]])
  circuit.assumeRange(highProduct, 0, 100)
  const lowProduct = circuit.roundAffine([[low, partScale]])
  circuit.assumeRange(lowProduct, 0, partScale)
  const highFloor = emitFloor(circuit, highProduct)
  const highFraction = circuit.roundAffine([[highProduct, 1], [highFloor, -1]])
  circuit.assumeRange(highFraction, 0, 1)
  // 1 - highFraction is exact when highFraction >= 0.5. Below that no carry is
  // possible, and the sign test below still returns 0.
  const missing = circuit.roundAffine([[highFraction, -1]], 1)
  circuit.assumeRange(missing, 0, 1)
  const carryDifference = circuit.roundAffine([[lowProduct, 1], [missing, -1]])
  circuit.assumeRange(carryDifference, -1, 1)
  // Whenever a carry is possible, progress >= 0.009, and both operands are multiples of 2^-28.
  const carry = emitSignBit(circuit, carryDifference, '>=', planCompare(1, 2 ** -28))
  const percent = circuit.affine([[highFloor, 1], [carry, 1]])
  circuit.assumeRange(percent, 0, 100)
  return percent
}

export function createWorkloadCircuit() {
  const c = workloadConstants
  const circuit = new Circuit(workloadField.size)
  circuit.assumeRange(workloadField.viewportWidth, 320, 7680)
  circuit.assumeRange(workloadField.viewportHeight, 240, 4320)
  circuit.assumeRange(workloadField.pointerX, -1024, 8192)
  circuit.assumeRange(workloadField.pointerY, -1024, 8192)
  circuit.assumeRange(workloadField.pointerInside, 0, 1)
  circuit.assumeRange(workloadField.progress, 0, 1)
  circuit.assumeRange(workloadField.seconds, 0, 16_384)

  // Dock: magnification from each icon's resting center, as macOS does, so the
  // falloff does not feed back into the layout it produces.
  const pitch = c.iconSize + c.iconGap
  const dockCenterY = circuit.affine([[workloadField.viewportHeight, 1]], -c.dockBottomInset - c.iconSize / 2)
  const pointerDy = circuit.roundAffine([[workloadField.pointerY, 1], [dockCenterY, -1]])
  const dySquared = circuit.multiply(pointerDy, pointerDy)
  const squaredMinimum = circuit.affine([], 1)
  const squaredMaximum = circuit.affine([], 2 ** 16)
  circuit.assumeRange(squaredMinimum, 1, 1)
  circuit.assumeRange(squaredMaximum, 2 ** 16, 2 ** 16)
  const scales: Wire[] = []
  const distances: Wire[] = []
  for (let icon = 0; icon < iconCount; icon++) {
    const restingCenter = circuit.affine([[workloadField.viewportWidth, 0.5]], (icon - (iconCount - 1) / 2) * pitch)
    const dx = circuit.roundAffine([[workloadField.pointerX, 1], [restingCenter, -1]])
    const squared = circuit.roundAffine([[circuit.multiply(dx, dx), 1], [dySquared, 1]])
    circuit.assumeRange(squared, 0, 2 ** 29)
    // Distances past the falloff radius do not matter, so clamp before the root.
    const clampedSquared = emitClampExact(circuit, squared, squaredMinimum, squaredMaximum, {resolution: 2 ** -16})
    const distance = emitSqrt(circuit, clampedSquared)
    distances.push(distance)
    const falloff = emitSmoothstep(circuit, c.falloffRadius, 0, distance)
    const hovered = circuit.multiply(falloff, workloadField.pointerInside)
    scales.push(circuit.affine([[hovered, c.maximumScale - 1]], 1))
  }
  const iconSize = scales.map(scale => circuit.affine([[scale, c.iconSize]]))
  const totalWidth = circuit.affine(iconSize.map(size => [size, 1]), (iconCount - 1) * c.iconGap)
  const dockLeft = circuit.roundAffine([[workloadField.viewportWidth, 0.5], [totalWidth, -0.5]])
  // One wide sum per prefix: depth 1, terms in icon order.
  const iconLeft = iconSize.map((_, icon) =>
    circuit.roundAffine([[dockLeft, 1], ...iconSize.slice(0, icon).map((size): [Wire, number] => [size, 1])], icon * c.iconGap))
  const dockBottom = circuit.affine([[workloadField.viewportHeight, 1]], -c.dockBottomInset)
  const iconTop = iconSize.map(size => circuit.roundAffine([[dockBottom, 1], [size, -1]]))
  const {winners} = emitMinimumOf(circuit, distances, {resolution: 2 ** -12})
  const nearestIcon = winners.map(winner => circuit.multiply(winner, workloadField.pointerInside))

  // Progress ring in the top-right corner.
  const centerX = circuit.affine([[workloadField.viewportWidth, 1]], -c.ringInset)
  const centerY = circuit.affine([], c.ringInset)
  const headAngle = circuit.affine([[workloadField.progress, 2 * Math.PI]], -Math.PI / 2)
  const head = emitSinCos(circuit, headAngle)
  const headX = circuit.roundAffine([[centerX, 1], [head.cos, c.ringRadius]])
  const headY = circuit.roundAffine([[centerY, 1], [head.sin, c.ringRadius]])
  // Spin: angle = 2 pi fract(seconds / period), then rotate constant tick offsets
  // with one shared (cos, sin) pair instead of one sine per tick.
  const cycles = circuit.roundAffine([[workloadField.seconds, 1 / c.spinPeriod]])
  const spinFraction = emitFract(circuit, cycles)
  const spin = emitSinCos(circuit, circuit.affine([[spinFraction, 2 * Math.PI]]))
  const cycleIndex = emitFloor(circuit, cycles)
  const tickX: Wire[] = []
  const tickY: Wire[] = []
  const tickLit: Wire[] = []
  const tickOpacity: Wire[] = []
  // For ticks >= 1 the lit difference below is 0 or at least 2^-29 in magnitude.
  const litPlan = planCompare(1, 2 ** -29)
  for (let tick = 0; tick < tickCount; tick++) {
    const offset = 2 * Math.PI * tick / tickCount - Math.PI / 2
    // Per-cycle jitter from a runtime key: cycle * tickCount + tick.
    const key = circuit.roundAffine([[cycleIndex, tickCount]], tick)
    circuit.assumeRange(key, 0, 2 ** 20)
    const jitter = circuit.affine([[emitHash(circuit, key), 2 * c.jitter]], -c.jitter)
    const radius = circuit.affine([[jitter, 1]], c.ringRadius)
    // cos(offset + spin) = cos(offset) cos(spin) - sin(offset) sin(spin), and so on.
    const rotatedCos = circuit.roundAffine([[spin.cos, Math.cos(offset)], [spin.sin, -Math.sin(offset)]])
    const rotatedSin = circuit.roundAffine([[spin.sin, Math.cos(offset)], [spin.cos, Math.sin(offset)]])
    circuit.assumeRange(rotatedCos, -1.001, 1.001)
    circuit.assumeRange(rotatedSin, -1.001, 1.001)
    tickX.push(circuit.roundAffine([[centerX, 1], [circuit.multiply(rotatedCos, radius), 1]]))
    tickY.push(circuit.roundAffine([[centerY, 1], [circuit.multiply(rotatedSin, radius), 1]]))
    // Lit when progress >= tick / tickCount in float64. An FP32 progress satisfies that
    // exactly when progress >= ceilFloat32(tick / tickCount), and the difference from that
    // constant has the exact sign. fround(tick / tickCount) as the constant would light
    // some ticks one FP32 step early, e.g. tick 5 at progress = fround(5 / 24) = 0.20833333,
    // which is below 5 / 24.
    const litDifference = circuit.roundAffine([[workloadField.progress, 1]], -ceilFloat32(tick / tickCount))
    tickLit.push(emitSignBit(circuit, litDifference, '>=', litPlan))
    // Brighter near the spinning head at offset 0: smoothstep over the cyclic distance.
    const phase = emitFract(circuit, circuit.roundAffine([[spinFraction, -1]], tick / tickCount + 1))
    tickOpacity.push(circuit.affine([[emitSmoothstep(circuit, 0.5, 1, phase), 0.75]], 0.25))
  }
  const percent = emitPercentOfUnit(circuit, workloadField.progress)
  const output: WorkloadOutputs = {iconLeft, iconTop, iconSize, nearestIcon, headX, headY, tickX, tickY, tickLit, tickOpacity, percent}
  return {circuit, output}
}

export function workloadRoots(output: WorkloadOutputs) {
  return [
    ...output.iconLeft, ...output.iconTop, ...output.iconSize, ...output.nearestIcon,
    output.headX, output.headY, ...output.tickX, ...output.tickY, ...output.tickLit, ...output.tickOpacity, output.percent,
  ]
}

// The same workload in float64 with Math functions. The hash is defined by its FP32
// steps, so the reference reuses hashReference, and the spin clock starts from the
// circuit's rounded cycle count. The tick lit bits and the percent label use plain
// float64 thresholds.
export function referenceWorkload(source: Float32Array) {
  const c = workloadConstants
  const [viewportWidth, viewportHeight, pointerX, pointerY, pointerInside, progress, seconds] = source
  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }
  const pitch = c.iconSize + c.iconGap
  const dockCenterY = viewportHeight! - c.dockBottomInset - c.iconSize / 2
  const distances: number[] = []
  const iconSize: number[] = []
  for (let icon = 0; icon < iconCount; icon++) {
    const restingCenter = viewportWidth! * 0.5 + (icon - (iconCount - 1) / 2) * pitch
    const distance = Math.sqrt(Math.min(Math.max((pointerX! - restingCenter) ** 2 + (pointerY! - dockCenterY) ** 2, 1), 2 ** 16))
    distances.push(distance)
    iconSize.push(c.iconSize * (1 + (c.maximumScale - 1) * smoothstep(c.falloffRadius, 0, distance) * pointerInside!))
  }
  const totalWidth = iconSize.reduce((total, size) => total + size, 0) + (iconCount - 1) * c.iconGap
  const dockLeft = viewportWidth! * 0.5 - totalWidth * 0.5
  const iconLeft: number[] = []
  let running = dockLeft
  for (let icon = 0; icon < iconCount; icon++) {
    iconLeft.push(running)
    running += iconSize[icon]! + c.iconGap
  }
  const iconTop = iconSize.map(size => viewportHeight! - c.dockBottomInset - size)
  const nearest = distances.indexOf(Math.min(...distances))
  const nearestIcon = distances.map((_, icon) => Number(icon === nearest) * pointerInside!)
  const centerX = viewportWidth! - c.ringInset
  const centerY = c.ringInset
  const headAngle = progress! * 2 * Math.PI - Math.PI / 2
  // The circuit's spin clock is fround(fround(1 / period) * seconds). Near 16,384 seconds that
  // value is about 6,827 cycles, where one FP32 step is 2^-11 cycles, about 0.2 px at a 64 px
  // radius, so the reference starts from the same rounded value.
  const cycles = Math.fround(Math.fround(1 / c.spinPeriod) * seconds!)
  const spinFraction = cycles - Math.floor(cycles)
  const spinAngle = spinFraction * 2 * Math.PI
  const tickX: number[] = []
  const tickY: number[] = []
  const tickLit: number[] = []
  const tickOpacity: number[] = []
  for (let tick = 0; tick < tickCount; tick++) {
    const angle = 2 * Math.PI * tick / tickCount - Math.PI / 2 + spinAngle
    const radius = c.ringRadius - c.jitter + 2 * c.jitter * hashReference(Math.floor(cycles) * tickCount + tick)
    tickX.push(centerX + radius * Math.cos(angle))
    tickY.push(centerY + radius * Math.sin(angle))
    tickLit.push(Number(progress! >= tick / tickCount))
    const phaseRaw = tick / tickCount + 1 - spinFraction
    tickOpacity.push(0.25 + 0.75 * smoothstep(0.5, 1, phaseRaw - Math.floor(phaseRaw)))
  }
  return {
    iconLeft, iconTop, iconSize, nearestIcon, distances,
    headX: centerX + c.ringRadius * Math.cos(headAngle),
    headY: centerY + c.ringRadius * Math.sin(headAngle),
    tickX, tickY, tickLit, tickOpacity,
    percent: Math.floor(progress! * 100),
  }
}

// Random sources for the tests and the report: pointers mostly near the dock, a third
// of the progress values within 3 FP32 steps of a tick boundary k / 24, a third within
// 3 steps of a percent boundary k / 100, and times up to 16,384 s.
export function randomWorkloadSource(random: () => number, trial: number) {
  const source = new Float32Array(workloadField.size)
  const width = Math.fround(320 + random() * 3000)
  const height = Math.fround(240 + random() * 2000)
  source[workloadField.viewportWidth] = width
  source[workloadField.viewportHeight] = height
  const nearDock = trial % 4 !== 0
  source[workloadField.pointerX] = Math.fround(nearDock ? width / 2 + (random() * 2 - 1) * 400 : random() * width)
  source[workloadField.pointerY] = Math.fround(nearDock ? height - 40 + (random() * 2 - 1) * 160 : random() * height)
  source[workloadField.pointerInside] = trial % 5 === 0 ? 0 : 1
  const boundaryDenominator = trial % 3 === 0 ? tickCount : trial % 3 === 1 ? 100 : 0
  source[workloadField.progress] = boundaryDenominator === 0
    ? Math.fround(random())
    : Math.min(1, Math.max(0, stepFloat32(Math.fround(Math.floor(random() * (boundaryDenominator + 1)) / boundaryDenominator), Math.floor(random() * 7) - 3)))
  source[workloadField.seconds] = Math.fround(random() * (trial % 2 === 0 ? 60 : 16_384))
  return source
}
