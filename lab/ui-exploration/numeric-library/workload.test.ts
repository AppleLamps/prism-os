import {expect, test} from 'bun:test'
import {Circuit, validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {ceilFloat32, createRandom, f, measureProgram, randomLogUniform, stepFloat32} from './measure.ts'
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

test('the split percent equals Math.floor(progress * 100) in float64', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 1)
  const percent = emitPercentOfUnit(circuit, 0)
  expect(measureProgram(circuit, [percent]).liveOperations).toBe(25)
  const run = circuit.createTensorEvaluator([percent])
  const check = (progress: number) => {
    const value = run(Float32Array.of(progress))[0]
    if (value !== Math.floor(progress * 100)) throw new Error(`percent of ${progress} returned ${value}`)
  }
  for (let boundary = 0; boundary <= 100; boundary++) {
    for (const center of [f(boundary / 100), ceilFloat32(boundary / 100)]) {
      for (let step = -32; step <= 32; step++) check(Math.min(1, Math.max(0, stepFloat32(center, step))))
    }
  }
  const random = createRandom(23)
  for (let trial = 0; trial < 100_000; trial++) {
    check(trial % 2 === 0 ? f(random()) : Math.min(1, randomLogUniform(random, -149, 0, false)))
  }
})

test('tick bits and the percent label match float64 within 3 FP32 steps of every threshold', () => {
  const {circuit, output} = createWorkloadCircuit()
  const roots = workloadRoots(output)
  const run = circuit.createTensorEvaluator(roots)
  const source = randomWorkloadSource(createRandom(22), 1)
  const litStart = 4 * iconCount + 2 + 2 * tickCount
  let checked = 0
  for (const denominator of [100, tickCount]) {
    for (let boundary = 0; boundary <= denominator; boundary++) {
      for (let step = -3; step <= 3; step++) {
        const progress = Math.min(1, Math.max(0, stepFloat32(f(boundary / denominator), step)))
        source[workloadField.progress] = progress
        const values = run(source)
        expect(values[roots.length - 1]).toBe(Math.floor(progress * 100))
        for (let tick = 0; tick < tickCount; tick++) expect(values[litStart + tick]).toBe(Number(progress >= tick / tickCount))
        checked++
      }
    }
  }
  expect(checked).toBe(101 * 7 + 25 * 7)
})

test('the dock and progress ring workload matches its float64 reference', () => {
  const {circuit, output} = createWorkloadCircuit()
  const roots = workloadRoots(output)
  const size = measureProgram(circuit, roots)
  expect(size.liveOperations).toBeLessThan(2_500)
  const run = circuit.createTensorEvaluator(roots)
  const random = createRandom(21)
  let worstPosition = 0
  let worstOpacity = 0
  let checkedNearest = 0
  for (let trial = 0; trial < 3_000; trial++) {
    const source = randomWorkloadSource(random, trial)
    const values = run(source)
    const reference = referenceWorkload(source)
    let offset = 0
    const take = (count: number) => {
      const slice = [...values.slice(offset, offset + count)]
      offset += count
      return slice
    }
    const iconLeft = take(iconCount)
    const iconTop = take(iconCount)
    const iconSize = take(iconCount)
    const nearestIcon = take(iconCount)
    const [headX, headY] = take(2)
    const tickX = take(tickCount)
    const tickY = take(tickCount)
    const tickLit = take(tickCount)
    const tickOpacity = take(tickCount)
    const [percent] = take(1)
    const positions: [number[], number[]][] = [
      [iconLeft, reference.iconLeft], [iconTop, reference.iconTop], [iconSize, reference.iconSize],
      [[headX!, headY!], [reference.headX, reference.headY]], [tickX, reference.tickX], [tickY, reference.tickY],
    ]
    for (const [circuitValues, referenceValues] of positions) {
      for (let index = 0; index < circuitValues.length; index++) {
        worstPosition = Math.max(worstPosition, Math.abs(circuitValues[index]! - referenceValues[index]!))
      }
    }
    for (let tick = 0; tick < tickCount; tick++) {
      worstOpacity = Math.max(worstOpacity, Math.abs(tickOpacity[tick]! - reference.tickOpacity[tick]!))
    }
    expect(tickLit).toEqual(reference.tickLit)
    expect(percent).toBe(reference.percent)
    // The nearest icon is exact on the circuit's own distances; skip near ties.
    const sorted = [...reference.distances].sort((a, b) => a - b)
    if (sorted[1]! - sorted[0]! > 1e-3) {
      expect(nearestIcon).toEqual(reference.nearestIcon)
      checkedNearest++
    }
    if (trial < 20) validateOneHotGroups(circuit, circuit.evaluateReference(source))
  }
  expect(worstPosition).toBeLessThan(1e-3)
  expect(worstOpacity).toBeLessThan(1e-5)
  // Pointers far from the dock clamp every distance to 256 px, which are ties.
  expect(checkedNearest).toBeGreaterThan(1_500)
})
