// Checks matrix-powers.ts against index.ts's float64 loop over random and adversarial
// springs, in both evaluators, and pins the sizes that patterns/matrix-powers.md quotes.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/patterns/combining-steps
import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads} from '../../../../../../numeric-ui-core.ts'
import {springMatrixPower, springStepMatrix} from '../../../../../../host-timing.ts'
import {
  buildDigitPowers,
  buildHostMatrix,
  buildTableOfPowers,
  maxSteps,
  springConstants,
  stepDigitCount,
  stepSpringLoop,
  tableSampleCount,
  writeTableOfPowers,
} from './matrix-powers.ts'
import {createRandom, evaluateBoth, measureProgram} from './measure.ts'

type SpringCase = {displacement: number, velocity: number, steps: number}

const step = springStepMatrix(springConstants)

// 1,000 random springs within ±2,000 px and ±20,000 px/s, then every combination of
// step counts at digit boundaries and the cap, displacements from 0 and -0 to the
// declared ±65,536 px, and velocities up to 1,000,000 px/s.
function springCases(): SpringCase[] {
  const random = createRandom(5)
  const cases: SpringCase[] = []
  for (let trial = 0; trial < 1000; trial++) {
    cases.push({
      displacement: Math.fround((random() * 2 - 1) * 2000),
      velocity: Math.fround((random() * 2 - 1) * 20_000),
      steps: Math.floor(random() * (maxSteps + 1)),
    })
  }
  for (const steps of [0, 1, 2, 3, 4, 127, 128, 255, 256, 257, 299, 300]) {
    for (const displacement of [0, -0, 2 ** -20, 1, -300, 16_384, -65_536]) {
      for (const velocity of [0, 0.5, -5000, 1_000_000]) cases.push({displacement, velocity, steps})
    }
  }
  return cases
}

// The circuit's error against the float64 loop, relative to how far the spring can
// move, so springs near 65,536 px and near 0 px can share one bound.
function relativeErrors(outputs: readonly number[], {displacement, velocity, steps}: SpringCase) {
  const expected = stepSpringLoop(displacement, velocity, steps, springConstants)
  const displacementScale = Math.max(1, Math.abs(displacement), Math.abs(velocity) * 0.004)
  const velocityScale = Math.max(1, Math.abs(displacement) * springConstants.stiffness * 0.004, Math.abs(velocity))
  return {
    displacement: Math.abs(outputs[0]! - expected.displacement) / displacementScale,
    velocity: Math.abs(outputs[1]! - expected.velocity) / velocityScale,
    absoluteDisplacement: Math.abs(outputs[0]! - expected.displacement),
  }
}

function runHostMatrix() {
  const built = buildHostMatrix(1)
  const evaluate = built.circuit.createTensorEvaluator(built.roots)
  const source = new Float32Array(built.circuit.sourceSize)
  return (spring: SpringCase) => {
    source.set(springMatrixPower(step, spring.steps), 0)
    source[built.springs[0]!.displacement] = spring.displacement
    source[built.springs[0]!.velocity] = spring.velocity
    return evaluateBoth(built.circuit, evaluate, built.roots, source).outputs
  }
}

describe('repeated steps as matrix powers', () => {
  const cases = springCases()

  test('JavaScript writes the matrix: the circuit equals the same products in FP32, and follows the loop', () => {
    const run = runHostMatrix()
    let worstRelative = 0
    let worstAbsoluteWithin2000 = 0
    for (const [index, spring] of cases.entries()) {
      const outputs = run(spring)
      // What the program computes, written in JavaScript: the cells hold FP32 entries.
      const m = Float32Array.from(springMatrixPower(step, spring.steps))
      const expectedDisplacement = Math.fround(Math.fround(m[0]! * spring.displacement) + Math.fround(m[1]! * spring.velocity))
      const expectedVelocity = Math.fround(Math.fround(m[2]! * spring.displacement) + Math.fround(m[3]! * spring.velocity))
      expect(outputs[0] === expectedDisplacement && outputs[1] === expectedVelocity).toBe(true)
      const errors = relativeErrors(outputs, spring)
      worstRelative = Math.max(worstRelative, errors.displacement, errors.velocity)
      if (index < 1000) worstAbsoluteWithin2000 = Math.max(worstAbsoluteWithin2000, errors.absoluteDisplacement)
    }
    expect(worstRelative).toBeLessThan(1e-6)
    expect(worstAbsoluteWithin2000).toBeLessThan(3e-4)
  })

  test('the circuit builds M^steps from the step count: exact digits, the same bounds, and different last bits than the host matrix', () => {
    const built = buildDigitPowers(1)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const runHost = runHostMatrix()
    let worstRelative = 0
    let worstAbsoluteWithin2000 = 0
    let differingFromHost = 0
    for (const [index, spring] of cases.entries()) {
      const source = Float32Array.from([spring.steps, spring.displacement, spring.velocity])
      const {outputs, values} = evaluateBoth(built.circuit, evaluate, built.roots, source)
      if (index % 50 === 0) {
        validateGrids(built.circuit, values)
        expect(built.digits.map(digit => values[digit])).toEqual(
          Array.from({length: stepDigitCount}, (_, digit) => (spring.steps >> digit) & 1))
      }
      const errors = relativeErrors(outputs, spring)
      worstRelative = Math.max(worstRelative, errors.displacement, errors.velocity)
      if (index < 1000) worstAbsoluteWithin2000 = Math.max(worstAbsoluteWithin2000, errors.absoluteDisplacement)
      const host = runHost(spring)
      if (outputs[0] !== host[0] || outputs[1] !== host[1]) differingFromHost++
    }
    expect(worstRelative).toBeLessThan(1e-6)
    expect(worstAbsoluteWithin2000).toBeLessThan(3e-4)
    // FP32 groups the product differently from JavaScript's float64 squaring.
    expect(differingFromHost).toBeGreaterThan(cases.length / 2)
  })

  test('a table of powers read at a computed step count gives the host matrix bit for bit', () => {
    const built = buildTableOfPowers()
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const source = new Float32Array(built.circuit.sourceSize)
    writeTableOfPowers(source, springConstants)
    const runHost = runHostMatrix()
    for (const [index, spring] of cases.entries()) {
      source[built.sampleSteps] = spring.steps
      source[built.springs[0]!.displacement] = spring.displacement
      source[built.springs[0]!.velocity] = spring.velocity
      const {outputs, values} = evaluateBoth(built.circuit, evaluate, built.roots, source)
      if (index % 50 === 0) validateIndexReads(built.circuit, values)
      // A read copies the FP32 entries JavaScript wrote, so the products multiply the same bits.
      const host = runHost(spring)
      expect(outputs[0] === host[0] && outputs[1] === host[1]).toBe(true)
    }
    expect(tableSampleCount).toBe(301)
  })

  test('sizes quoted in the doc', () => {
    const size = (label: string, built: {circuit: Parameters<typeof measureProgram>[0], roots: number[]}) => {
      const {operations, layers, indexReads} = measureProgram(built.circuit, built.roots)
      return `${label}: ${operations} operations, ${layers} layers, ${indexReads} index reads`
    }
    const digits = buildDigitPowers(1)
    expect([
      size('host matrix, 1 spring', buildHostMatrix(1)),
      size('host matrix, 20 springs', buildHostMatrix(20)),
      size('digit powers, 1 spring', digits),
      size('digit powers, 20 springs', buildDigitPowers(20)),
      size('digit powers, digits alone', {circuit: digits.circuit, roots: digits.digits}),
      size('table of powers, 1 spring', buildTableOfPowers()),
    ]).toEqual([
      'host matrix, 1 spring: 14 operations, 3 layers, 0 index reads',
      'host matrix, 20 springs: 280 operations, 3 layers, 0 index reads',
      'digit powers, 1 spring: 208 operations, 40 layers, 0 index reads',
      'digit powers, 20 springs: 474 operations, 40 layers, 0 index reads',
      'digit powers, digits alone: 26 operations, 26 layers, 0 index reads',
      'table of powers, 1 spring: 18 operations, 4 layers, 4 index reads',
    ])
  })
})
