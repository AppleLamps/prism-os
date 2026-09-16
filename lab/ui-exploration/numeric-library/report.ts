// Heavy measurement for README.md: macro costs and dense error sweeps, comparison
// plans, drifting against exact minimum, the rectangle hit test, and the workload.
// The section that ran IndirectOS in five minimum and maximum modes was removed on
// September 16, 2026, with the IndirectOS copies it built, and stays at the
// exploration-2026-09 tag.
// Run: bun lab/ui-exploration/numeric-library/report.ts [section...]
// Sections: macros, plans, minimum, rectangle-hit, workload.
// Merges results into report-output.json.
import {Circuit, emitMinimum, type Wire} from '../../../numeric-ui-core.ts'
import {
  compareCost,
  emitCompare,
  emitDivide,
  emitExp,
  emitFloor,
  emitFloorOnGrid,
  emitHash,
  emitMaximumExact,
  emitMinimumExact,
  emitMinimumOf,
  emitMix,
  emitReciprocal,
  emitRemapRuntime,
  emitRound,
  emitSinCos,
  emitSmoothstep,
  emitSqrt,
  hashReference,
  planCompare,
} from './library.ts'
import {emitSignBit} from './comparison.ts'
import {chiSquarePValue, chiSquareStatistic, createRandom, f, measureProgram, randomLogUniform, roundHalfEven, stepFloat32} from './measure.ts'
import {
  createWorkloadCircuit,
  emitPercentOfUnit,
  iconCount,
  randomWorkloadSource,
  referenceWorkload,
  tickCount,
  workloadField,
  workloadRoots,
} from './workload.ts'

type Sampler = (random: () => number, trial: number) => Float32Array
type Scorer = (source: Float32Array, output: Float32Array) => number

// Builds one macro alone, samples it densely, and keeps the worst score.
function sweep(label: string, ranges: [number, number][], build: (circuit: Circuit) => Wire[], trials: number, sample: Sampler, score: Scorer) {
  const circuit = new Circuit(ranges.length)
  ranges.forEach(([minimum, maximum], wire) => circuit.assumeRange(wire, minimum, maximum))
  const roots = build(circuit)
  const run = circuit.createTensorEvaluator(roots)
  const random = createRandom(label.length * 7919)
  let worst = 0
  for (let trial = 0; trial < trials; trial++) {
    const source = sample(random, trial)
    worst = Math.max(worst, score(source, run(source)))
  }
  return {label, ...measureProgram(circuit, roots), trials, worst}
}

function macros() {
  const rows = []
  const pairSample = (magnitude: number, minimumExponent: number): Sampler => (random, trial) => {
    const a = trial % 2 === 0 ? randomLogUniform(random, minimumExponent, Math.log2(magnitude), true) : f((random() * 2 - 1) * magnitude)
    const b = trial % 4 === 0 ? stepFloat32(a, Math.floor(random() * 5) - 2) : trial % 4 === 2 ? a : f((random() * 2 - 1) * magnitude)
    return Float32Array.of(a, Math.max(-magnitude, Math.min(magnitude, b)))
  }
  const compareScore: Scorer = (source, output) => Number(output[0] !== Number(source[0]! >= source[1]!)) + Number(output[1] !== Math.min(source[0]!, source[1]!))
  for (const [label, magnitude, resolution, minimumExponent] of [
    ['a >= b and min(a, b), integers to 2^20, resolution 1', 2 ** 20, 1, 0],
    ['a >= b and min(a, b), pixels to 2^14, resolution 2^-30 (operands >= 2^-7)', 16_384, 2 ** -30, -7],
    ['a >= b and min(a, b), pixels to 2^14, every FP32 pair', 16_384, undefined, -149],
  ] as const) {
    const options = resolution === undefined ? {} : {resolution}
    const integers = resolution === 1
    rows.push(sweep(label, [[-magnitude, magnitude], [-magnitude, magnitude]], circuit => [emitCompare(circuit, 0, 1, '>=', options), emitMinimumExact(circuit, 0, 1, options)], 1_000_000,
      integers ? (random, trial) => { const a = Math.round((random() * 2 - 1) * magnitude); return Float32Array.of(a, Math.max(-magnitude, Math.min(magnitude, trial % 2 === 0 ? a + Math.round((random() * 2 - 1) * 3) : Math.round((random() * 2 - 1) * magnitude)))) } : pairSample(magnitude, minimumExponent),
      compareScore))
  }
  rows.push(sweep('max(a, b), pixels to 2^14, resolution 2^-30', [[-16_384, 16_384], [-16_384, 16_384]], circuit => [emitMaximumExact(circuit, 0, 1, {resolution: 2 ** -30})], 500_000, pairSample(16_384, -7), (source, output) => Number(output[0] !== Math.max(source[0]!, source[1]!))))
  rows.push(sweep('minimum of 8 values by counting, pixels, resolution 2^-27', Array.from({length: 8}, (): [number, number] => [0, 16_384]), circuit => [emitMinimumOf(circuit, [0, 1, 2, 3, 4, 5, 6, 7], {resolution: 2 ** -27}).minimum], 200_000,
    random => Float32Array.from({length: 8}, () => random() < 0.2 ? 512 : f(random() * 16_384)), (source, output) => Number(output[0] !== Math.min(...source))))
  rows.push(sweep('round, |x| < 2^22', [[-(2 ** 22) + 1, 2 ** 22 - 1]], circuit => [emitRound(circuit, 0)], 1_000_000,
    (random, trial) => Float32Array.of(trial % 3 === 0 ? stepFloat32(Math.round((random() * 2 - 1) * 1e5) + 0.5, Math.floor(random() * 5) - 2) : f((random() * 2 - 1) * (2 ** 22 - 1))), (source, output) => Number(output[0] !== roundHalfEven(source[0]!))))
  rows.push(sweep('floor on a 1/64 grid, |x| < 2^16', [[-(2 ** 16) + 1, 2 ** 16 - 1]], circuit => [emitFloorOnGrid(circuit, 0, 6)], 1_000_000,
    random => Float32Array.of(Math.round((random() * 2 - 1) * (2 ** 16 - 1) * 64) / 64), (source, output) => Number(output[0] !== Math.floor(source[0]!))))
  const floorSample = (signed: boolean): Sampler => (random, trial) => {
    const value = trial % 3 === 0 ? stepFloat32(Math.round((random() * 2 - 1) * 1e4) * 0.5, Math.floor(random() * 7) - 3) : trial % 3 === 1 ? randomLogUniform(random, -149, 22, signed) : f(random() * (2 ** 22 - 1))
    return Float32Array.of(signed ? Math.max(-(2 ** 22) + 1, Math.min(2 ** 22 - 1, value)) : Math.max(0, Math.min(2 ** 22 - 1, Math.abs(value))))
  }
  rows.push(sweep('floor, any FP32 x in [0, 2^22)', [[0, 2 ** 22 - 1]], circuit => [emitFloor(circuit, 0)], 1_000_000, floorSample(false), (source, output) => Number(output[0] !== Math.floor(source[0]!))))
  rows.push(sweep('floor, any FP32 x in (-2^22, 2^22)', [[-(2 ** 22) + 1, 2 ** 22 - 1]], circuit => [emitFloor(circuit, 0)], 1_000_000, floorSample(true), (source, output) => Number(output[0] !== Math.floor(source[0]!))))
  const logUniform = (minimum: number, maximum: number): Sampler => (random, trial) =>
    Float32Array.of(trial % 10 === 0 ? Math.min(maximum, Math.max(minimum, stepFloat32(minimum * 2 ** Math.floor(random() * Math.log2(maximum / minimum)), (trial % 5) - 2))) : f(minimum * 2 ** (random() * Math.log2(maximum / minimum))))
  for (const bucketsPerOctave of [1, 2, 4]) {
    rows.push(sweep(`reciprocal on [1, 16384], ${bucketsPerOctave} per octave (relative error)`, [[1, 16_384]], circuit => [emitReciprocal(circuit, 0, {bucketsPerOctave})], 1_000_000, logUniform(1, 16_384), (source, output) => Math.abs(output[0]! * source[0]! - 1)))
  }
  rows.push(sweep('divide by [1, 16384], numerator in [-16384, 16384] (relative error)', [[1, 16_384], [-16_384, 16_384]], circuit => [emitDivide(circuit, 1, 0)], 1_000_000,
    (random, trial) => Float32Array.of(logUniform(1, 16_384)(random, trial)[0]!, f((random() * 2 - 1) * 16_384) || 1), (source, output) => Math.abs(output[0]! * source[0]! / source[1]! - 1)))
  for (const bucketsPerOctave of [1, 2]) {
    rows.push(sweep(`sqrt on {0} and [1, 2^22], ${bucketsPerOctave} per octave (relative error)`, [[0, 2 ** 22]], circuit => [emitSqrt(circuit, 0, {minimumPositive: 1, bucketsPerOctave})], 1_000_000, logUniform(1, 2 ** 22), (source, output) => Math.abs(output[0]! / Math.sqrt(source[0]!) - 1)))
  }
  const buildSinCos = (circuit: Circuit) => { const {sin, cos} = emitSinCos(circuit, 0); return [sin, cos] }
  const sinCosScore: Scorer = (source, output) => Math.max(Math.abs(output[0]! - Math.sin(source[0]!)), Math.abs(output[1]! - Math.cos(source[0]!)))
  // The quadrant round(angle * 2 / pi) switches at odd multiples of pi / 4.
  rows.push(sweep('sin and cos, |angle| <= 190, 10% within 4 FP32 steps of a quadrant switch, 1% within 6 steps of an endpoint (absolute error)', [[-190, 190]], buildSinCos, 1_000_000,
    (random, trial) => Float32Array.of(Math.max(-190, Math.min(190, trial % 10 === 0
      ? stepFloat32((Math.round((random() * 2 - 1) * 121) + 0.5) * Math.PI / 2, (trial % 9) - 4)
      : trial % 100 === 1
        ? stepFloat32(trial % 200 === 1 ? 190 : -190, trial % 200 === 1 ? -(trial % 7) : trial % 7)
        : f((random() * 2 - 1) * 190)))),
    sinCosScore))
  // Every FP32 angle in two stretches: [3.5, 4], which holds the quadrant switch at 5 pi / 4, and the top of the domain.
  for (const [low, high, step] of [[3.5, 4, 2 ** -22], [128, 190, 2 ** -16]] as const) {
    rows.push(sweep(`sin and cos, every FP32 angle in [${low}, ${high}] (absolute error)`, [[-190, 190]], buildSinCos, (high - low) / step + 1,
      (_random, trial) => Float32Array.of(low + trial * step), sinCosScore))
  }
  for (const limit of [0.5, 2, 8, 16]) {
    rows.push(sweep(`exp, |x| <= ${limit}, random with both endpoints (relative error)`, [[-limit, limit]], circuit => [emitExp(circuit, 0)], 1_000_000,
      (random, trial) => Float32Array.of(trial === 0 ? limit : trial === 1 ? -limit : f((random() * 2 - 1) * limit)), (source, output) => Math.abs(output[0]! / Math.exp(source[0]!) - 1)))
  }
  rows.push(sweep('smoothstep with constant edges -40..120, x in [-2000, 2000], a quarter within 3 FP32 steps of an edge, a quarter in [-200, 200] (absolute error)', [[-2000, 2000]], circuit => [emitSmoothstep(circuit, -40, 120, 0)], 1_000_000,
    (random, trial) => Float32Array.of(trial % 4 === 0 ? stepFloat32(trial % 8 === 0 ? -40 : 120, Math.floor(random() * 7) - 3) : trial % 4 === 1 ? f((random() * 2 - 1) * 200) : f((random() * 2 - 1) * 2000)),
    (source, output) => { const t = Math.min(1, Math.max(0, (source[0]! + 40) / 160)); return Math.abs(output[0]! - t * t * (3 - 2 * t)) }))
  rows.push(sweep('runtime remap, input span in [1, 999], half the inputs inside the span (error over max(1, |result|, |(x - inMinimum) * outSpan / inSpan|))',
    [[-1000, 1000], [-500, 0], [1, 500], [-100, 100], [-100, 100]], circuit => [emitRemapRuntime(circuit, 0, 1, 2, 3, 4, {minimum: 1, maximum: 1000})], 1_000_000,
    (random, trial) => {
      const inMinimum = f(-random() * 500)
      const inMaximum = f(1 + random() * 499)
      const x = trial % 2 === 0 ? f(inMinimum + random() * (inMaximum - inMinimum)) : f((random() * 2 - 1) * 1000)
      return Float32Array.of(x, inMinimum, inMaximum, f((random() * 2 - 1) * 100), f((random() * 2 - 1) * 100))
    },
    (source, output) => {
      const term = (source[0]! - source[1]!) / (source[2]! - source[1]!) * (source[4]! - source[3]!)
      const expected = source[3]! + term
      return Math.abs(output[0]! - expected) / Math.max(1, Math.abs(expected), Math.abs(term))
    }))
  rows.push(sweep('mix(a, b, t), a and b in [-1024, 1024] (error in ulps of max(|a|, |b|))', [[-1024, 1024], [-1024, 1024], [0, 1]], circuit => [emitMix(circuit, 0, 1, 2)], 1_000_000,
    random => Float32Array.of(f((random() * 2 - 1) * 1024), f((random() * 2 - 1) * 1024), f(random())),
    (source, output) => Math.abs(output[0]! - (source[0]! * (1 - source[2]!) + source[1]! * source[2]!)) / (Math.max(Math.abs(source[0]!), Math.abs(source[1]!), 1) * 2 ** -23)))
  rows.push(sweep('hash, keys in [0, 2^20] (mismatches against the FP32 reference)', [[0, 2 ** 20]], circuit => [emitHash(circuit, 0)], 1_048_577,
    (_random, trial) => Float32Array.of(trial), (source, output) => Number(output[0] !== hashReference(source[0]!))))
  // 163,872 keys cover the workload's keys cycle * 24 + tick up to 16,384 seconds.
  const hashQuality = [1024, 16_384, 65_536, 163_872, 1_048_576].map(count => {
    const buckets: number[] = new Array(64).fill(0)
    for (let key = 0; key < count; key++) {
      const bucket = Math.floor(hashReference(key) * 64)
      buckets[bucket] = buckets[bucket]! + 1
    }
    const statistic = chiSquareStatistic(buckets)
    return {keys: count, chiSquareOver64Buckets: Number(statistic.toFixed(1)), pValueWith63DegreesOfFreedom: Number(chiSquarePValue(statistic, 63).toPrecision(2))}
  })
  return {rows, hashQuality}
}

function plans() {
  return [
    ['integers in [0, 16384]', 2 ** 15, 1],
    ['pixels in [0, 16384], operands >= 2^-7 or 0', 2 ** 15, 2 ** -30],
    ['pixels in [0, 16384], operands >= 2^-31 or 0', 2 ** 15, 2 ** -54],
    ['pixels in [0, 16384], every FP32 value', 2 ** 15, 2 ** -149],
    ['unit interval, every FP32 value', 2, 2 ** -149],
  ].map(([label, bound, resolution]) => ({label, ...compareCost(planCompare(bound as number, resolution as number)), plan: planCompare(bound as number, resolution as number)}))
}

// Where the drifting minimum a - relu(a - b) differs from Math.min: fractional pairs
// whose magnitudes differ.
function minimumContrast() {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 16_384)
  circuit.assumeRange(1, 0, 16_384)
  const drifting = emitMinimum(circuit, 0, 1)
  const exact = emitMinimumExact(circuit, 0, 1, {resolution: 2 ** -30})
  const run = circuit.createTensorEvaluator([drifting, exact])
  const random = createRandom(99)
  const bands = [[0, 8, 0, 8], [512, 16_384, 0, 8], [0, 8, 512, 16_384], [900, 1000, 900, 1000]] as const
  return bands.map(([aMinimum, aMaximum, bMinimum, bMaximum]) => {
    let driftingWrong = 0
    let driftingMaximumError = 0
    let exactWrong = 0
    const trials = 200_000
    for (let trial = 0; trial < trials; trial++) {
      const a = f(aMinimum + random() * (aMaximum - aMinimum))
      const b = f(bMinimum + random() * (bMaximum - bMinimum))
      const [driftingValue, exactValue] = run(Float32Array.of(a, b))
      if (driftingValue !== Math.min(a, b)) driftingWrong++
      driftingMaximumError = Math.max(driftingMaximumError, Math.abs(driftingValue! - Math.min(a, b)))
      if (exactValue !== Math.min(a, b)) exactWrong++
    }
    return {a: `[${aMinimum}, ${aMaximum}]`, b: `[${bMinimum}, ${bMaximum}]`, trials, driftingNotEqualToMathMin: driftingWrong, driftingMaximumError, exactNotEqualToMathMin: exactWrong}
  })
}

function workload() {
  const {circuit, output} = createWorkloadCircuit()
  const roots = workloadRoots(output)
  const size = measureProgram(circuit, roots)
  const dockSize = measureProgram(circuit, [...output.iconLeft, ...output.iconTop, ...output.iconSize, ...output.nearestIcon])
  const ringSize = measureProgram(circuit, [output.headX, output.headY, ...output.tickX, ...output.tickY, ...output.tickLit, ...output.tickOpacity, output.percent])
  const run = circuit.createTensorEvaluator(roots)
  const nearestStart = 3 * iconCount
  const headStart = 4 * iconCount
  const tickStart = headStart + 2
  const litStart = tickStart + 2 * tickCount
  const percentIndex = roots.length - 1
  const random = createRandom(5)
  let worstPosition = 0
  let litMismatches = 0
  let percentMismatches = 0
  let nearestChecked = 0
  let nearestMismatches = 0
  const trials = 100_000
  for (let trial = 0; trial < trials; trial++) {
    const source = randomWorkloadSource(random, trial)
    const values = run(source)
    const reference = referenceWorkload(source)
    const flat = [...reference.iconLeft, ...reference.iconTop, ...reference.iconSize]
    for (let index = 0; index < flat.length; index++) worstPosition = Math.max(worstPosition, Math.abs(values[index]! - flat[index]!))
    worstPosition = Math.max(worstPosition, Math.abs(values[headStart]! - reference.headX), Math.abs(values[headStart + 1]! - reference.headY))
    for (let tick = 0; tick < tickCount; tick++) {
      worstPosition = Math.max(worstPosition, Math.abs(values[tickStart + tick]! - reference.tickX[tick]!), Math.abs(values[tickStart + tickCount + tick]! - reference.tickY[tick]!))
      if (values[litStart + tick] !== reference.tickLit[tick]) litMismatches++
    }
    if (values[percentIndex] !== reference.percent) percentMismatches++
    // The nearest icon is decided on the circuit's own square roots; skip near ties.
    const sorted = [...reference.distances].sort((a, b) => a - b)
    if (sorted[1]! - sorted[0]! > 1e-3) {
      nearestChecked++
      for (let icon = 0; icon < iconCount; icon++) {
        if (values[nearestStart + icon] !== reference.nearestIcon[icon]) {
          nearestMismatches++
          break
        }
      }
    }
  }

  // Progress values within 3 FP32 steps of a percent boundary k / 100 or a tick boundary
  // k / 24, against float64. The rounded forms are what the workload used before:
  // floor(fround(progress * 100)) and thresholds fround(tick / 24).
  const rounded = new Circuit(1)
  rounded.assumeRange(0, 0, 1)
  const roundedPercent = emitFloor(rounded, rounded.roundAffine([[0, 100]]))
  const roundedLit = Array.from({length: tickCount}, (_, tick) => emitSignBit(rounded, rounded.roundAffine([[0, 1]], -tick / tickCount), '>=', planCompare(1, 2 ** -29)))
  const runRounded = rounded.createTensorEvaluator([roundedPercent, ...roundedLit])
  const split = new Circuit(1)
  split.assumeRange(0, 0, 1)
  const splitPercent = emitPercentOfUnit(split, 0)
  const thresholds = {
    percentBoundaryValues: 0,
    workloadPercentMismatches: 0,
    roundedProductPercentMismatches: 0,
    tickBoundaryValues: 0,
    workloadLitMismatches: 0,
    roundedThresholdLitMismatches: 0,
    splitPercentSize: measureProgram(split, [splitPercent]),
    roundedProductPercentSize: measureProgram(rounded, [roundedPercent]),
  }
  const boundarySource = Float32Array.from(randomWorkloadSource(createRandom(8), 1))
  for (const denominator of [100, tickCount]) {
    for (let boundary = 0; boundary <= denominator; boundary++) {
      for (let step = -3; step <= 3; step++) {
        const progress = Math.min(1, Math.max(0, stepFloat32(f(boundary / denominator), step)))
        boundarySource[workloadField.progress] = progress
        const values = run(boundarySource)
        const roundedValues = runRounded(Float32Array.of(progress))
        if (denominator === 100) {
          thresholds.percentBoundaryValues++
          if (values[percentIndex] !== Math.floor(progress * 100)) thresholds.workloadPercentMismatches++
          if (roundedValues[0] !== Math.floor(progress * 100)) thresholds.roundedProductPercentMismatches++
        } else if (boundary < tickCount) {
          thresholds.tickBoundaryValues++
          const expected = Number(progress >= boundary / tickCount)
          if (values[litStart + boundary] !== expected) thresholds.workloadLitMismatches++
          if (roundedValues[1 + boundary] !== expected) thresholds.roundedThresholdLitMismatches++
        }
      }
    }
  }

  // 40 consecutive FP32 seconds up to 16,384 through the whole circuit: how far tick 0 moves per step.
  const clockSource = Float32Array.from(boundarySource)
  let seconds = stepFloat32(16_384, -40)
  let previousTick: [number, number] | null = null
  let largestTickMove = 0
  for (let step = 0; step <= 40; step++) {
    clockSource[workloadField.seconds] = seconds
    const values = run(clockSource)
    const tick: [number, number] = [values[tickStart]!, values[tickStart + tickCount]!]
    if (previousTick !== null) largestTickMove = Math.max(largestTickMove, Math.hypot(tick[0] - previousTick[0], tick[1] - previousTick[1]))
    previousTick = tick
    seconds = stepFloat32(seconds, 1)
  }
  const spinClock = {secondsStepBelow16384: 2 ** -10, cycleStepNear16384Seconds: 2 ** -11, largestTickMovePerSecondsStep: largestTickMove}

  return {size, dockSize, ringSize, trials, worstPosition, litMismatches, percentMismatches, nearestChecked, nearestMismatches, thresholds, spinClock}
}

// IndirectOS's rectangle hit: boolean(clamp01(min of four interval distances)).
function rectangleHit() {
  const variants = ['drifting nested', 'exact nested', 'exact counting'] as const
  return variants.map(variant => {
    const circuit = new Circuit(6)
    for (let wire = 0; wire < 6; wire++) circuit.assumeRange(wire, 0, 16_384)
    const [x, y, left, top, width, height] = [0, 1, 2, 3, 4, 5]
    const distances = [
      circuit.affine([[x, 1], [left, -1]]),
      circuit.affine([[left, 1], [width, 1], [x, -1]]),
      circuit.affine([[y, 1], [top, -1]]),
      circuit.affine([[top, 1], [height, 1], [y, -1]]),
    ]
    const options = {resolution: 2 ** -29}
    let minimum: Wire
    if (variant === 'drifting nested') {
      minimum = emitMinimum(circuit, emitMinimum(circuit, distances[0]!, distances[1]!), emitMinimum(circuit, distances[2]!, distances[3]!))
    } else if (variant === 'exact nested') {
      minimum = emitMinimumExact(circuit, emitMinimumExact(circuit, distances[0]!, distances[1]!, options), emitMinimumExact(circuit, distances[2]!, distances[3]!, options), options)
    } else {
      minimum = emitMinimumOf(circuit, distances, options).minimum
    }
    const positive = circuit.reglu([], 1, [[minimum, 1]], 0)
    const aboveOne = circuit.reglu([], 1, [[minimum, 1]], -1)
    const score = circuit.affine([[positive, 1], [aboveOne, -1]])
    circuit.assumeRange(score, 0, 1)
    const hit = circuit.boolean(score)
    const run = circuit.createTensorEvaluator([hit])
    const random = createRandom(17)
    let mismatches = 0
    const trials = 1_000_000
    for (let trial = 0; trial < trials; trial++) {
      // 1/64-grid rectangles, FP32 pointers within a few ulps of 0.5 px inside an edge.
      const rectangleLeft = Math.round(random() * 8000 * 64) / 64
      const rectangleTop = Math.round(random() * 8000 * 64) / 64
      const rectangleWidth = Math.round((1 + random() * 8000) * 64) / 64
      const rectangleHeight = Math.round((1 + random() * 8000) * 64) / 64
      const edge = Math.floor(random() * 4)
      const jitter = (random() * 2 - 1) * 4e-4
      const pointerX = f(edge === 0 ? rectangleLeft + 0.5 + jitter : edge === 1 ? rectangleLeft + rectangleWidth - 0.5 + jitter : rectangleLeft + random() * rectangleWidth)
      const pointerY = f(edge === 2 ? rectangleTop + 0.5 + jitter : edge === 3 ? rectangleTop + rectangleHeight - 0.5 + jitter : rectangleTop + random() * rectangleHeight)
      const source = Float32Array.of(pointerX, pointerY, rectangleLeft, rectangleTop, rectangleWidth, rectangleHeight)
      if (source.some(value => value > 16_384)) continue
      const expected = Number(Math.min(pointerX - rectangleLeft, rectangleLeft + rectangleWidth - pointerX, pointerY - rectangleTop, rectangleTop + rectangleHeight - pointerY) >= 0.5)
      if (run(source)[0] !== expected) mismatches++
    }
    return {variant, ...measureProgram(circuit, [hit]), trials, mismatchesAgainstFloat64: mismatches}
  })
}

const sections: Record<string, () => unknown> = {macros, plans, minimum: minimumContrast, 'rectangle-hit': rectangleHit, workload}
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(sections)
const outputPath = new URL('./report-output.json', import.meta.url).pathname
const previous = await Bun.file(outputPath).exists() ? await Bun.file(outputPath).json() as Record<string, unknown> : {}
for (const name of selected) {
  const start = performance.now()
  previous[name] = sections[name]!()
  console.log(JSON.stringify({section: name, seconds: Number(((performance.now() - start) / 1000).toFixed(1)), result: previous[name]}, null, 2))
}
await Bun.write(outputPath, JSON.stringify(previous, null, 2))
