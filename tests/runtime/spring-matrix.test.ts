import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Wire,
  emitAnimatedObject,
  emitApplySpringMatrix,
  inlineCircuit,
  validateCircuit,
  validateTensorProgram,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'
import {
  type PlannedEvaluation,
  type SpringClock,
  type SpringConstants,
  type WriteBack,
  advanceFrame,
  countSpringSteps,
  defaultSpringClockConfig,
  multiplySpringMatrices,
  identitySpringMatrix,
  quantizeFrameTiming,
  quantizeTimeMs,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
  validateSpringClockConfig,
} from '../../src/runtime/host-timing.ts'

// Tests for springs whose step matrix the host writes, and for the host timing
// utilities, ported from spring-bank's tests (https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/spring-bank),
// lab/ui-exploration/event-time and lab/ui-exploration/guide/examples/springs.

// Seeded hash, copied from numeric-ui-core.test.ts so the suite stays deterministic.
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

const f = Math.fround
const float32Scratch = new Float32Array(1)
const uint32Scratch = new Uint32Array(float32Scratch.buffer)

// The next FP32 value above a positive finite FP32 value.
function nextFloat32Up(value: number) {
  float32Scratch[0] = value
  uint32Scratch[0]! += 1
  return float32Scratch[0]
}

const smallestSubnormal = f(1e-45)

const springConstants: readonly SpringConstants[] = [
  {stiffness: 290, damping: 30},
  {stiffness: 650, damping: 45},
  {stiffness: 120, damping: 14},
]
const matrixBound = Math.max(...springConstants.map(constants => springMatrixBound(constants)))

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

function programCounts(program: TensorProgram) {
  let storedWeights = 0
  for (const layer of program.layers) storedWeights += layer.weights.length
  return {liveOperations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights}
}

const compileModes: {label: string, compile: (circuit: Circuit, roots: readonly Wire[]) => TensorProgram}[] = [
  {label: 'gather lowering, build-time depths', compile: (circuit, roots) => circuit.compileTensorProgram(roots)},
  {label: 'no gather lowering', compile: (circuit, roots) => circuit.compileTensorProgram(roots, false)},
  {label: 'recomputed depths', compile: (circuit, roots) => circuit.compileTensorProgram(roots, true, {recomputeDepths: true})},
  {label: 'every wire as a root', compile: circuit => circuit.compileTensorProgram()},
]

// Every compiled program returns the reference evaluator's bits on every live
// wire, and the reusable evaluator on every root. Returns the reference values.
function checkEveryCompileMode(circuit: Circuit, roots: readonly Wire[], sources: readonly Float32Array[]) {
  validateCircuit(circuit)
  const references = sources.map(source => circuit.evaluateReference(source))
  for (const mode of compileModes) {
    const program = mode.compile(circuit, roots)
    validateTensorProgram(circuit, program)
    const previousProgram = circuit.tensorProgram
    circuit.tensorProgram = program
    sources.forEach((source, sourceIndex) => {
      const tensorValues = circuit.evaluateTensor(source)
      for (const wire of program.wireOrder) {
        if (!Object.is(tensorValues[wire], references[sourceIndex]![wire])) {
          throw new Error(`${mode.label}: wire ${wire} got ${tensorValues[wire]}, reference ${references[sourceIndex]![wire]}`)
        }
      }
    })
    circuit.tensorProgram = previousProgram
  }
  const evaluate = circuit.createTensorEvaluator(roots)
  sources.forEach((source, sourceIndex) => {
    const outputs = evaluate(source)
    roots.forEach((root, rootIndex) => {
      if (!Object.is(outputs[rootIndex], references[sourceIndex]![root])) {
        throw new Error(`reusable evaluator: root ${root} got ${outputs[rootIndex]}, reference ${references[sourceIndex]![root]}`)
      }
    })
  })
  return references
}

// Plain float64 semi-implicit Euler steps, as index.ts's stepSpringTo loop.
function eulerSteps(constants: SpringConstants, displacement: number, velocity: number, steps: number) {
  let e = displacement
  let v = velocity
  for (let step = 0; step < steps; step++) {
    v += (-constants.stiffness * e - constants.damping * v) * 0.004
    e += v * 0.004
  }
  return {displacement: e, velocity: v}
}

// emitApplySpringMatrix written independently as FP32 steps: each product is
// f(entry × operand), and each sum adds from +0 in stored order.
function applyMatrixFp32(matrix: readonly number[], displacement: number, velocity: number) {
  return {
    displacement: f(f(0 + f(matrix[0]! * displacement)) + f(matrix[1]! * velocity)),
    velocity: f(f(0 + f(matrix[2]! * displacement)) + f(matrix[3]! * velocity)),
  }
}

// An FP32 sum as the runtime adds it: from f(bias), then each coefficient times
// its operand in stored order.
function sumFp32(bias: number, terms: readonly (readonly [coefficient: number, operand: number])[]) {
  let value = f(bias)
  for (const [coefficient, operand] of terms) value = f(value + f(f(coefficient) * operand))
  return value
}

function regluFp32(left: number, gate: number) {
  return f(left * Math.max(0, gate))
}

function booleanFp32(score: number) {
  return f(f(f(score) + 8_388_609) - 8_388_609)
}

type SpringSample = {
  matrix: readonly number[]
  displacement: number
  velocity: number
  destination: number
  destinationDuringSteps: number
}

// emitAnimatedObject written independently as FP32 steps, for springs whose
// displacement is measured from a separate destinationDuringSteps wire, or from
// `destination` itself.
function animatedObjectFp32(
  springs: readonly SpringSample[],
  separateDestinationDuringSteps: boolean,
  settleCheck: number,
  snap: number | undefined,
  settleDistance = f(0.01),
  settleSpeed = f(0.01),
) {
  let exceedance = 0
  let liftedRest = 0
  const stepped = springs.map(spring => {
    const next = applyMatrixFp32(spring.matrix, spring.displacement, spring.velocity)
    const displacement = separateDestinationDuringSteps
      ? sumFp32(0, [[1, spring.destinationDuringSteps], [-1, spring.destination], [1, next.displacement]])
      : next.displacement
    for (const [value, threshold] of [[displacement, settleDistance], [next.velocity, settleSpeed]] as const) {
      const positivePart = regluFp32(1, sumFp32(0, [[1, value]]))
      const negativePart = regluFp32(1, sumFp32(0, [[-1, value]]))
      exceedance = f(exceedance + regluFp32(1, sumFp32(-threshold, [[1, positivePart], [1, negativePart]])))
      liftedRest = f(f(liftedRest + f(2 ** 127 * positivePart)) + f(2 ** 127 * negativePart))
    }
    return {displacement, velocity: next.velocity}
  })
  const atRest = regluFp32(1, sumFp32(1, [[-(2 ** 22), regluFp32(1, liftedRest)]]))
  const settled = booleanFp32(regluFp32(1, sumFp32(0, [[0.5, settleCheck], [0.5, atRest], [-(2 ** 20), exceedance]])))
  const notSettled = sumFp32(1, [[-1, settled]])
  const active = snap === undefined
    ? notSettled
    : regluFp32(sumFp32(0, [[1, notSettled]]), sumFp32(0, [[1, sumFp32(1, [[-1, snap]])]]))
  const displacements = stepped.map(({displacement}) => regluFp32(sumFp32(0, [[1, displacement]]), sumFp32(0, [[1, active]])))
  return {
    displacements,
    positions: springs.map((spring, index) => sumFp32(0, [[1, spring.destination], [1, displacements[index]!]])),
    velocities: stepped.map(({velocity}) => regluFp32(sumFp32(0, [[1, velocity]]), sumFp32(0, [[1, active]]))),
    settled,
    active,
    atRest,
  }
}

describe('applying a spring matrix', () => {
  test('equals float64 Euler steps, every compile mode matches the reference evaluator, and the cost is pinned', () => {
    const circuit = new Circuit(6)
    for (let cell = 0; cell < 4; cell++) circuit.assumeRange(asWire(cell), -matrixBound, matrixBound)
    const next = emitApplySpringMatrix(circuit, [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3)], circuit.source(4), circuit.source(5))
    const roots = [next.displacement, next.velocity]
    expect(programCounts(circuit.compileTensorProgram(roots))).toEqual({liveOperations: 14, layers: 3, storedWeights: 28})
    const evaluate = circuit.createTensorEvaluator(roots)
    const random = createRandom(3)
    const sources: Float32Array[] = []
    let worstDisplacement = 0
    let worstVelocity = 0
    for (let sample = 0; sample < 1500; sample++) {
      const constants = springConstants[Math.floor(random() * springConstants.length)]!
      const steps = random() < 0.2 ? Math.floor(random() * 4) : Math.floor(random() * 301)
      const displacement = f((random() * 2 - 1) * 2000)
      const velocity = f((random() * 2 - 1) * 5000)
      const matrix = springMatrixPower(springStepMatrix(constants), steps)
      const source = Float32Array.of(...matrix, displacement, velocity)
      const outputs = evaluate(source)
      const expectedFp32 = applyMatrixFp32(Array.from(source.subarray(0, 4)), displacement, velocity)
      expect(outputs[0]).toBe(expectedFp32.displacement)
      expect(outputs[1]).toBe(expectedFp32.velocity)
      const expected = eulerSteps(constants, displacement, velocity, steps)
      worstDisplacement = Math.max(worstDisplacement, Math.abs(outputs[0]! - expected.displacement))
      worstVelocity = Math.max(worstVelocity, Math.abs(outputs[1]! - expected.velocity))
      if (sample < 40) sources.push(source)
    }
    expect(worstDisplacement).toBeLessThan(1e-3)
    expect(worstVelocity).toBeLessThan(1e-2)
    checkEveryCompileMode(circuit, roots, sources)
  })

  test('zero steps return the state unchanged, and extreme states stay FP32 products', () => {
    const circuit = new Circuit(6)
    for (let cell = 0; cell < 4; cell++) circuit.assumeRange(asWire(cell), -matrixBound, matrixBound)
    const next = emitApplySpringMatrix(circuit, [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3)], circuit.source(4), circuit.source(5))
    const evaluate = circuit.createTensorEvaluator([next.displacement, next.velocity])
    const largest = f(3.4028234663852886e38)
    for (const [displacement, velocity] of [[123.456, -7.5], [-0, 0], [f(1e-45), -f(1e-45)], [largest, -largest], [f(2 ** 24 + 2), 3]]) {
      // Sums start from +0, so -0 comes back as +0; `+ 0` ignores the sign of zero.
      const identity = evaluate(Float32Array.of(1, 0, 0, 1, displacement!, velocity!))
      expect(identity[0]! + 0).toBe(f(displacement!) + 0)
      expect(identity[1]! + 0).toBe(f(velocity!) + 0)
      const matrix = springMatrixPower(springStepMatrix(springConstants[1]!), 300)
      const stepped = evaluate(Float32Array.of(...matrix, displacement!, velocity!))
      const expected = applyMatrixFp32(Array.from(Float32Array.of(...matrix)), f(displacement!), f(velocity!))
      expect(stepped[0]).toBe(expected.displacement)
      expect(stepped[1]).toBe(expected.velocity)
    }
  })

  test('refuses matrix wires without finite declared ranges', () => {
    const circuit = new Circuit(6)
    for (let cell = 0; cell < 3; cell++) circuit.assumeRange(asWire(cell), -matrixBound, matrixBound)
    expect(() => emitApplySpringMatrix(circuit, [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3)], circuit.source(4), circuit.source(5))).toThrow('finite declared ranges')
    circuit.assumeRange(circuit.source(3), -matrixBound, Number.POSITIVE_INFINITY)
    expect(() => emitApplySpringMatrix(circuit, [circuit.source(0), circuit.source(1), circuit.source(2), circuit.source(3)], circuit.source(4), circuit.source(5))).toThrow('finite declared ranges')
  })
})

// Cells per spring: 4 matrix cells, displacement, velocity, destination,
// destinationDuringSteps. Then the settle check and snap bits.
const fieldsPerSpring = 8

function buildObject(springCount: number, separateDestinationDuringSteps: boolean, withSnap: boolean, thresholds: {settleDistance?: number, settleSpeed?: number} = {}) {
  const settleCheckCell = springCount * fieldsPerSpring
  const snapCell = settleCheckCell + 1
  const circuit = new Circuit(snapCell + 1)
  circuit.assumeRange(asWire(settleCheckCell), 0, 1)
  circuit.assumeRange(asWire(snapCell), 0, 1)
  const springs = Array.from({length: springCount}, (_, index) => {
    const start = index * fieldsPerSpring
    for (let cell = start; cell < start + 4; cell++) circuit.assumeRange(asWire(cell), -matrixBound, matrixBound)
    return {
      matrix: [circuit.source(start), circuit.source(start + 1), circuit.source(start + 2), circuit.source(start + 3)] as const,
      displacement: circuit.source(start + 4),
      velocity: circuit.source(start + 5),
      destination: circuit.source(start + 6),
      ...(separateDestinationDuringSteps ? {destinationDuringSteps: circuit.source(start + 7)} : {}),
    }
  })
  const object = emitAnimatedObject(circuit, springs, {
    settleCheck: circuit.source(settleCheckCell),
    ...(withSnap ? {snap: circuit.source(snapCell)} : {}),
    ...thresholds,
  })
  const roots = [...object.displacements, ...object.positions, ...object.velocities, object.settled, object.active]
  return {circuit, object, roots, settleCheckCell, snapCell}
}

function writeSprings(source: Float32Array, springs: readonly SpringSample[]) {
  springs.forEach((spring, index) => {
    const start = index * fieldsPerSpring
    source.set(spring.matrix, start)
    source[start + 4] = spring.displacement
    source[start + 5] = spring.velocity
    source[start + 6] = spring.destination
    source[start + 7] = spring.destinationDuringSteps
  })
}

describe('animated objects', () => {
  test('costs: removing the position subtraction saves 1 operation per spring, and the rest bit adds 2 per spring and 2 per object', () => {
    const counts = (springCount: number, separate: boolean, withSnap: boolean) => {
      const {circuit, roots} = buildObject(springCount, separate, withSnap)
      return programCounts(circuit.compileTensorProgram(roots))
    }
    // Measured before displacements and the rest bit: 26 operations and 11 layers,
    // 48 for 2 springs, and 121 operations in 13 layers for 5 springs with snap.
    expect(counts(1, false, false)).toEqual({liveOperations: 29, layers: 11, storedWeights: 54})
    expect(counts(1, true, false)).toEqual({liveOperations: 30, layers: 12, storedWeights: 57})
    expect(counts(2, false, false)).toEqual({liveOperations: 52, layers: 11, storedWeights: 102})
    expect(counts(5, true, true)).toEqual({liveOperations: 128, layers: 13, storedWeights: 264})
  })

  test('match an independent FP32 twin bit for bit, including samples at the settle thresholds and at exact rest', () => {
    const threshold = f(0.01)
    const aboveThreshold = nextFloat32Up(threshold)
    const random = createRandom(17)
    // A value near a threshold. Inside: exactly at it, or within it. Otherwise also
    // one FP32 step above it, or up to twice the threshold.
    const nearThreshold = (inside: boolean) => {
      const pick = random()
      const sign = random() < 0.5 ? -1 : 1
      if (inside) return pick < 0.4 ? sign * threshold : f(sign * random() * 0.01)
      return pick < 0.3 ? sign * threshold : pick < 0.5 ? sign * aboveThreshold : f((random() * 2 - 1) * 0.02)
    }
    const signedZero = () => (random() < 0.5 ? -0 : 0)
    let settledSamples = 0
    let notSettledNearThreshold = 0
    let settledAtRestWithoutCheck = 0
    let subnormalNotAtRest = 0
    for (const separateDestinationDuringSteps of [false, true]) {
      for (const withSnap of [false, true]) {
        const {circuit, roots, settleCheckCell, snapCell} = buildObject(3, separateDestinationDuringSteps, withSnap)
        const evaluate = circuit.createTensorEvaluator(roots)
        const sources: Float32Array[] = []
        for (let sample = 0; sample < 1500; sample++) {
          const source = new Float32Array(circuit.sourceSize)
          const pick = random()
          const nearRest = pick < 0.45
          const atRest = pick >= 0.45 && pick < 0.6
          // One sample in four of those at rest moves one spring by the smallest subnormal value.
          const subnormalSpring = atRest && random() < 0.25 ? Math.floor(random() * 3) : -1
          const inside = random() < 0.5
          const springs: SpringSample[] = Array.from({length: 3}, (_, index) => {
            const constants = springConstants[Math.floor(random() * springConstants.length)]!
            // Zero steps keep the displacements exactly where the sample puts them.
            const steps = nearRest || atRest ? 0 : Math.floor(random() * 301)
            const destination = random() < 0.4 ? 0 : f(Math.round(random() * 800) + (random() < 0.5 ? 0 : random()))
            // At rest the destination doesn't change, so the rebase adds exactly 0.
            const destinationDuringSteps = atRest || random() < 0.5 ? destination : f(destination + (random() * 2 - 1) * 50)
            const matrix = Array.from(Float32Array.of(...springMatrixPower(springStepMatrix(constants), steps)))
            if (atRest) {
              const subnormal = index === subnormalSpring
              const onVelocity = random() < 0.5
              return {
                matrix,
                displacement: subnormal && !onVelocity ? -smallestSubnormal : signedZero(),
                velocity: subnormal && onVelocity ? smallestSubnormal : signedZero(),
                destination,
                destinationDuringSteps,
              }
            }
            return {
              matrix,
              displacement: nearRest ? nearThreshold(inside) : f((random() * 2 - 1) * 900),
              velocity: nearRest ? nearThreshold(inside) : f((random() * 2 - 1) * 3000),
              destination,
              destinationDuringSteps,
            }
          })
          writeSprings(source, springs)
          source[settleCheckCell] = random() < 0.7 ? 1 : 0
          source[snapCell] = withSnap && random() < 0.15 ? 1 : 0
          const outputs = evaluate(source)
          const expected = animatedObjectFp32(springs, separateDestinationDuringSteps, source[settleCheckCell], withSnap ? source[snapCell] : undefined)
          expect(Array.from(outputs)).toEqual([...expected.displacements, ...expected.positions, ...expected.velocities, expected.settled, expected.active])
          if (expected.settled === 1) {
            settledSamples++
            // A settled object lands exactly on its destinations with zero velocity.
            // A displacement or velocity can be -0, e.g. f(-3 × 0).
            springs.forEach((spring, index) => {
              expect(outputs[index] === 0).toBe(true)
              expect(outputs[3 + index]).toBe(spring.destination)
              expect(outputs[6 + index] === 0).toBe(true)
            })
            if (atRest && source[settleCheckCell] === 0) settledAtRestWithoutCheck++
          } else if (nearRest && source[settleCheckCell] === 1) {
            notSettledNearThreshold++
          }
          if (subnormalSpring >= 0) {
            expect(expected.atRest).toBe(0)
            if (source[settleCheckCell] === 0) {
              expect(outputs[9]).toBe(0)
              subnormalNotAtRest++
            }
          }
          if (sample < 30) sources.push(source)
        }
        checkEveryCompileMode(circuit, roots, sources)
      }
    }
    expect(settledSamples).toBeGreaterThan(500)
    expect(notSettledNearThreshold).toBeGreaterThan(300)
    expect(settledAtRestWithoutCheck).toBeGreaterThan(200)
    expect(subnormalNotAtRest).toBeGreaterThan(30)
  })

  test('settle at a settle check with index.ts thresholds, or at exact rest without one, and a huge exceedance never flips the bit', () => {
    const {circuit, roots, settleCheckCell} = buildObject(1, false, false)
    const evaluate = circuit.createTensorEvaluator(roots)
    const threshold = f(0.01)
    // [displacement, position, velocity, settled, active]
    const run = (displacement: number, velocity: number, settleCheck: number, destination = 0) => {
      const source = new Float32Array(circuit.sourceSize)
      writeSprings(source, [{matrix: [1, 0, 0, 1], displacement, velocity, destination, destinationDuringSteps: destination}])
      source[settleCheckCell] = settleCheck
      // `+ 0` ignores the sign of zero, e.g. a settled negative velocity is f(-0.01 × 0) = -0.
      return Array.from(evaluate(source), value => value + 0)
    }
    // At the threshold settles; one FP32 step above doesn't, on either side.
    expect(run(threshold, -threshold, 1)).toEqual([0, 0, 0, 1, 0])
    expect(run(-threshold, threshold, 1)).toEqual([0, 0, 0, 1, 0])
    expect(run(nextFloat32Up(threshold), 0, 1)).toEqual([nextFloat32Up(threshold), nextFloat32Up(threshold), 0, 0, 1])
    expect(run(0, -nextFloat32Up(threshold), 1)).toEqual([0, 0, -nextFloat32Up(threshold), 0, 1])
    // Within both thresholds, but not at a settle check: keeps animating.
    expect(run(threshold, 0, 0)).toEqual([threshold, threshold, 0, 0, 1])
    // Exactly at rest settles without a settle check, and the smallest subnormal
    // displacement or velocity isn't rest.
    expect(run(0, 0, 0)).toEqual([0, 0, 0, 1, 0])
    expect(run(-0, -0, 0)).toEqual([0, 0, 0, 1, 0])
    expect(run(smallestSubnormal, 0, 0)).toEqual([smallestSubnormal, smallestSubnormal, 0, 0, 1])
    expect(run(0, -smallestSubnormal, 0)).toEqual([0, 0, -smallestSubnormal, 0, 1])
    // Huge states: the exceedance and the rest lift overflow to Infinity, and the score clamps at 0.
    const largest = f(3.4028234663852886e38)
    expect(run(largest, largest, 1).slice(3)).toEqual([0, 1])
    expect(run(largest, largest, 0).slice(3)).toEqual([0, 1])
    // At 100,000 px positions are 1/128 px apart, and the stored displacement still
    // settles at exactly 0.01 and not one FP32 step above it.
    expect(run(threshold, 0, 1, 100_000)).toEqual([0, 100_000, 0, 1, 0])
    expect(run(nextFloat32Up(threshold), 0, 1, 100_000)).toEqual([nextFloat32Up(threshold), f(100_000 + nextFloat32Up(threshold)), 0, 0, 1])
  })

  test('the settle score adds the settle check and rest bits first, so the smallest threshold floor still resolves', () => {
    const floor = 2 ** -22
    const {circuit, roots, settleCheckCell} = buildObject(1, false, false, {settleDistance: floor, settleSpeed: floor})
    const evaluate = circuit.createTensorEvaluator(roots)
    const source = new Float32Array(circuit.sourceSize)
    // One FP32 step above 2^-22 exceeds the threshold by 2^-45, which moves the score by 2^-25.
    writeSprings(source, [{matrix: [1, 0, 0, 1], displacement: nextFloat32Up(floor), velocity: 0, destination: 0, destinationDuringSteps: 0}])
    source[settleCheckCell] = 1
    expect(evaluate(source)[3]).toBe(0)
    source[0 + 4] = floor
    expect(evaluate(source)[3]).toBe(1)
    const kinds = circuit.roundingPoints().map(point => point.kind)
    expect(kinds.filter(kind => kind === 'marked')).toHaveLength(1)
    expect(kinds.filter(kind => kind === 'boolean')).toHaveLength(1)
    expect(() => buildObject(1, false, false, {settleDistance: 2 ** -23})).toThrow('at least 2^-22')
    expect(() => buildObject(1, false, false, {settleSpeed: Number.NaN})).toThrow('at least 2^-22')
  })

  test('a changed destination rebases the displacement once, and an unchanged one adds exactly 0', () => {
    const {circuit, roots, settleCheckCell} = buildObject(1, true, false)
    const evaluate = circuit.createTensorEvaluator(roots)
    const random = createRandom(23)
    let rebased = 0
    for (let sample = 0; sample < 2000; sample++) {
      const source = new Float32Array(circuit.sourceSize)
      const steps = Math.floor(random() * 301)
      const matrix = Array.from(Float32Array.of(...springMatrixPower(springStepMatrix(springConstants[0]!), steps)))
      const displacement = f((random() * 2 - 1) * 900)
      const velocity = f((random() * 2 - 1) * 3000)
      const destinationDuringSteps = f(2 ** 20 + Math.round(random() * 800))
      const destination = random() < 0.5 ? destinationDuringSteps : f(2 ** 20 + Math.round(random() * 800))
      writeSprings(source, [{matrix, displacement, velocity, destination, destinationDuringSteps}])
      source[settleCheckCell] = 0
      const outputs = evaluate(source)
      const stepped = applyMatrixFp32(matrix, displacement, velocity)
      if (destination === destinationDuringSteps) {
        // The stepped displacement comes back as it is, at any distance from the origin.
        expect(outputs[0]! + 0).toBe(stepped.displacement + 0)
      } else {
        // Whole-pixel destinations near 2^20 subtract exactly, so only the sum rounds.
        expect(outputs[0]).toBe(f(destinationDuringSteps - destination + stepped.displacement))
        rebased++
      }
    }
    expect(rebased).toBeGreaterThan(800)
  })

  test('refuses settle check and snap wires outside 0..1, and objects without springs', () => {
    const circuit = new Circuit(8)
    for (let cell = 0; cell < 4; cell++) circuit.assumeRange(asWire(cell), -matrixBound, matrixBound)
    const [matrix0, matrix1, matrix2, matrix3, displacement, velocity, destination, settleCheck] = Array.from({length: 8}, (_, cell) => circuit.source(cell))
    const spring = {matrix: [matrix0!, matrix1!, matrix2!, matrix3!] as const, displacement: displacement!, velocity: velocity!, destination: destination!}
    expect(() => emitAnimatedObject(circuit, [spring], {settleCheck: settleCheck!})).toThrow('within 0..1')
    circuit.assumeRange(settleCheck!, 0, 1)
    expect(() => emitAnimatedObject(circuit, [], {settleCheck: settleCheck!})).toThrow('at least one spring')
    expect(() => emitAnimatedObject(circuit, [spring], {settleCheck: settleCheck!, snap: destination!})).toThrow('within 0..1')
  })

  test('inlining keeps the values and the rounding points', () => {
    const {circuit, roots, settleCheckCell} = buildObject(2, true, true)
    const target = new Circuit(circuit.sourceSize)
    const wireMap = inlineCircuit(target, circuit, Array.from({length: circuit.sourceSize}, (_, wire) => wire).map(asWire))
    const random = createRandom(5)
    for (let sample = 0; sample < 200; sample++) {
      const source = new Float32Array(circuit.sourceSize)
      writeSprings(source, Array.from({length: 2}, () => ({
        matrix: Array.from(Float32Array.of(...springMatrixPower(springStepMatrix(springConstants[0]!), Math.floor(random() * 40)))),
        displacement: random() < 0.2 ? 0 : f(random() * 0.03),
        velocity: random() < 0.2 ? 0 : f((random() * 2 - 1) * 0.02),
        destination: 0,
        destinationDuringSteps: random() < 0.5 ? 0 : f(random() * 0.01),
      })))
      source[settleCheckCell] = random() < 0.5 ? 1 : 0
      const expected = circuit.evaluateReference(source)
      const actual = target.evaluateReference(source)
      for (const root of roots) expect(actual[wireMap[root]!]).toBe(expected[root])
    }
    expect(target.roundingPoints().map(point => point.kind).sort()).toEqual(circuit.roundingPoints().map(point => point.kind).sort())
  })

  test('the backward pass gives matrix cells and state the gradients of whole products, and rejects the settle atom by default', () => {
    const {circuit, object, settleCheckCell} = buildObject(1, false, false)
    const random = createRandom(29)
    for (let sample = 0; sample < 100; sample++) {
      const steps = sample < 10 ? 0 : Math.floor(random() * 301)
      const matrix = Float32Array.of(...springMatrixPower(springStepMatrix(springConstants[sample % 3]!), steps))
      const source = new Float32Array(circuit.sourceSize)
      const destination = f(random() * 800)
      const displacement = f((random() * 2 - 1) * 500)
      const velocity = f((random() * 2 - 1) * 2000)
      writeSprings(source, [{matrix: Array.from(matrix), displacement, velocity, destination, destinationDuringSteps: destination}])
      source[settleCheckCell] = 0
      const values = circuit.evaluateReference(source)
      const seeds = new Float32Array(values.length)
      seeds[object.positions[0]!] = 1
      expect(() => circuit.backpropagateReference(values, seeds)).toThrow('boolean atom')
      const gradients = circuit.backpropagateReference(values, seeds, {booleanGradient: 'straight-through'})
      const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-4 * Math.max(1, Math.abs(expected)))
      // position = destination + m0 × displacement + m1 × velocity
      close(gradients[0]!, displacement)
      close(gradients[1]!, velocity)
      expect(gradients[2]).toBe(0)
      expect(gradients[3]).toBe(0)
      close(gradients[4]!, matrix[0]!)
      close(gradients[5]!, matrix[1]!)
      expect(gradients[6]).toBe(1)
    }
  })
})

describe('host timing', () => {
  test('frame durations over any split of a time span add up, and idle, late and early times clamp as documented', () => {
    expect(quantizeTimeMs(16.6667)).toBe(16.671875)
    expect(Object.is(quantizeTimeMs(-0.001), 0)).toBe(true)
    const random = createRandom(41)
    for (let trace = 0; trace < 50; trace++) {
      const start = random() * 1e7
      let previous: number | null = null
      let totalMs = 0
      let firstFrameMs = 0
      let lastFrameMs = 0
      let now = start
      for (let frame = 0; frame < 60; frame++) {
        now += random() * 60
        const eventTimeStamps = Array.from({length: 3}, () => now - random() * 50)
        const timing = quantizeFrameTiming(now, previous, eventTimeStamps)
        for (const value of [timing.durationMs, ...timing.eventTimesMs]) {
          expect(Number.isInteger(value * 64)).toBe(true)
          expect(f(value)).toBe(value)
          expect(Object.is(value, -0)).toBe(false)
        }
        timing.eventTimesMs.forEach((eventTimeMs, index) => {
          const quantizedEvent = quantizeTimeMs(eventTimeStamps[index]!)
          if (previous === null || quantizedEvent >= previous) expect(timing.frameTimeMs + eventTimeMs).toBe(quantizedEvent)
          else expect(timing.frameTimeMs + eventTimeMs).toBe(previous)
        })
        totalMs += timing.durationMs
        if (previous === null) firstFrameMs = timing.frameTimeMs
        previous = timing.frameTimeMs
        lastFrameMs = timing.frameTimeMs
      }
      // Quantizing absolute timestamps first makes every split of the span add up exactly.
      expect(totalMs).toBe(lastFrameMs - firstFrameMs)
    }
    // The first frame after idle has duration 0, and its events keep their relative times within the cap.
    expect(quantizeFrameTiming(5000, null, [4990.004, 4000])).toEqual({frameTimeMs: 5000, durationMs: 0, eventTimesMs: [-10, -1000]})
    expect(quantizeFrameTiming(5000, null, [4990.01]).eventTimesMs).toEqual([-9.984375])
    // A frame timestamp before the previous frame counts no time.
    expect(quantizeFrameTiming(990, 1000, [])).toEqual({frameTimeMs: 1000, durationMs: 0, eventTimesMs: []})
    // A 100 s stall writes the cap, 1,200 ms, an event after the frame reads +0,
    // and an older event reads the later of the previous frame and -1,200 ms.
    const stalled = quantizeFrameTiming(101_000, 1000, [101_003, 500])
    expect(stalled.durationMs).toBe(1200)
    expect(Object.is(stalled.eventTimesMs[0], 0)).toBe(true)
    expect(stalled.eventTimesMs[1]).toBe(-1200)
    // Past the cap, an event after the previous frame is clamped too, and so is an event 4 s before a frame after idle.
    expect(quantizeFrameTiming(200_000, 1000, [500, 1500, 199_000]).eventTimesMs).toEqual([-1200, -1200, -1000])
    expect(quantizeFrameTiming(5000, null, [1000]).eventTimesMs).toEqual([-1200])
    // Within the cap, an event before the previous frame reads the previous frame's time.
    expect(quantizeFrameTiming(1100, 1000, [900]).eventTimesMs).toEqual([-100])
    expect(() => quantizeTimeMs(Number.NaN)).toThrow('finite')
  })

  test('countSpringSteps runs floor(pending / 4) steps and carries the leftover, or snaps when more steps are pending than the budget', () => {
    let checked = 0
    let snaps = 0
    for (let steps = 0; steps <= 305; steps++) {
      for (const offset of [-1 / 64, 0, 1 / 64]) {
        const pendingMs = 4 * steps + offset
        if (pendingMs < 0) continue
        for (const budget of [300, 7, 0]) {
          const count = countSpringSteps(pendingMs, budget)
          const pendingSteps = Math.floor(pendingMs / 4)
          if (pendingSteps > budget) {
            expect(count).toEqual({steps: 0, leftoverMs: 0, snap: true})
            snaps++
          } else {
            expect(count).toEqual({steps: pendingSteps, leftoverMs: pendingMs - 4 * pendingSteps, snap: false})
          }
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(2700)
    expect(snaps).toBeGreaterThan(1500)
    // 1,203.984375 ms runs the whole cap and carries 3.984375 ms, and 1,204 ms snaps.
    expect(countSpringSteps(1203.984375, 300)).toEqual({steps: 300, leftoverMs: 3.984375, snap: false})
    expect(countSpringSteps(1204, 300)).toEqual({steps: 0, leftoverMs: 0, snap: true})
    expect(countSpringSteps(100_000.5, 300)).toEqual({steps: 0, leftoverMs: 0, snap: true})
    expect(() => countSpringSteps(1 / 128, 300)).toThrow('time grid')
    expect(() => countSpringSteps(-4, 300)).toThrow('nonnegative')
    expect(() => countSpringSteps(4, 1.5)).toThrow('step budget')
  })

  test('spring matrices: powers by squaring equal repeated Euler steps, and the declared bound covers every FP32 entry the host writes', () => {
    for (const constants of springConstants) {
      const step = springStepMatrix(constants)
      const euler = eulerSteps(constants, 3, -7, 1)
      expect(Math.abs(step[0] * 3 + step[1] * -7 - euler.displacement)).toBeLessThan(1e-12)
      expect(Math.abs(step[2] * 3 + step[3] * -7 - euler.velocity)).toBeLessThan(1e-12)
      const bound = springMatrixBound(constants)
      let repeated = identitySpringMatrix
      let largest = 1
      for (let steps = 0; steps <= 300; steps++) {
        if (steps > 0) repeated = multiplySpringMatrices(repeated, step)
        const power = springMatrixPower(step, steps)
        power.forEach((entry, index) => {
          expect(Math.abs(entry - repeated[index]!)).toBeLessThan(1e-12)
          expect(Math.abs(f(entry))).toBeLessThanOrEqual(bound)
          largest = Math.max(largest, Math.abs(entry))
        })
      }
      expect(bound).toBeLessThan(largest * (1 + 1e-5))
    }
    expect(springMatrixBound({stiffness: 650, damping: 45})).toBeCloseTo(10.36, 2)
    expect(() => springMatrixBound({stiffness: 1e7, damping: 0})).toThrow('overflows')
    expect(() => springStepMatrix({stiffness: -1, damping: 0})).toThrow('nonnegative')
    expect(() => springMatrixPower(identitySpringMatrix, 1.5)).toThrow('nonnegative integer')
    validateSpringClockConfig(defaultSpringClockConfig)
    expect(() => validateSpringClockConfig({...defaultSpringClockConfig, timeGrid: 60})).toThrow('power of two')
    expect(() => validateSpringClockConfig({...defaultSpringClockConfig, stepMs: 1 / 128})).toThrow('multiple of the time grid')
    expect(() => validateSpringClockConfig({...defaultSpringClockConfig, maxStepsPerFrame: 0})).toThrow('positive integer')
    // 2^20 steps of 4 ms on a 1/64 ms grid are 2^28 grid steps.
    expect(() => validateSpringClockConfig({...defaultSpringClockConfig, maxStepsPerFrame: 2 ** 20})).toThrow('2^24 grid steps')
  })
})

type TestEvent = {timeStamp: number, id: number}
type LoggedEvaluation = Omit<PlannedEvaluation<TestEvent>, 'events'> & {eventIds: number[]}

// Runs the planner along frame times with an evaluate callback that only logs,
// and reports animating while `animating` says so.
function runPlanner(
  frameTimes: readonly number[],
  events: readonly TestEvent[],
  writeBack: WriteBack,
  animating: (evaluation: PlannedEvaluation<TestEvent>) => boolean = () => true,
) {
  let clock: SpringClock = stoppedSpringClock
  const log: LoggedEvaluation[] = []
  const clocks: SpringClock[] = []
  const stepsPerFrame: number[] = []
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    const arrived: TestEvent[] = []
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) arrived.push(events[nextEvent++]!)
    let steps = 0
    clock = advanceFrame(clock, frameTime, arrived, evaluation => {
      const {events: evaluationEvents, ...rest} = evaluation
      log.push({...rest, eventIds: evaluationEvents.map(event => event.id)})
      steps += evaluation.steps
      return animating(evaluation)
    }, writeBack)
    clocks.push(clock)
    stepsPerFrame.push(steps)
  }
  return {log, clocks, clock, stepsPerFrame}
}

// A stand-in for a program: each event starts an animation that keeps moving until a snap.
function movesUntilSnap() {
  let moving = false
  return (evaluation: PlannedEvaluation<TestEvent>) => {
    if (evaluation.snap) moving = false
    if (evaluation.events.length > 0) moving = true
    return moving
  }
}

function frameTimesAt(hz: number, durationMs: number, stall?: {startMs: number, lengthMs: number}) {
  const times: number[] = []
  for (let frame = 0; ; frame++) {
    const time = (frame * 1000) / hz
    if (time > durationMs) break
    if (stall !== undefined && time > stall.startMs && time < stall.startMs + stall.lengthMs) continue
    times.push(time)
  }
  return times
}

describe('advanceFrame', () => {
  test('a stopped clock starts at an event, checks settling at fixed simulated times, and after idle the duration restarts at 0', () => {
    // Something animates until the settle check at 159.296875 ms.
    const {log, clocks} = runPlanner([100, 180, 250], [{timeStamp: 95.3, id: 1}], 'every evaluation', evaluation => evaluation.timeMs < 159)
    expect(log).toEqual([
      {kind: 'events', timeMs: 95.296875, simulatedTimeMs: 95.296875, durationMs: 0, steps: 0, settleCheck: true, snap: false, writesBack: true, eventIds: [1]},
      {kind: 'frame', timeMs: 100, simulatedTimeMs: 99.296875, durationMs: 4.703125, steps: 1, settleCheck: false, snap: false, writesBack: true, eventIds: []},
      // 64 ms of simulated time after the event.
      {kind: 'settle check', timeMs: 159.296875, simulatedTimeMs: 159.296875, durationMs: 59.296875, steps: 15, settleCheck: true, snap: false, writesBack: true, eventIds: []},
      // The check reported that nothing animates: idle starts, and the frame starts no clock.
      {kind: 'frame', timeMs: 180, simulatedTimeMs: 180, durationMs: 0, steps: 0, settleCheck: true, snap: false, writesBack: true, eventIds: []},
      {kind: 'frame', timeMs: 250, simulatedTimeMs: 250, durationMs: 0, steps: 0, settleCheck: true, snap: false, writesBack: true, eventIds: []},
    ])
    expect(clocks[0]).toEqual({animatedUntilMs: 99.296875, checkOriginMs: 95.296875, lastEvaluationMs: 100})
    expect(clocks[1]).toEqual({animatedUntilMs: null, checkOriginMs: 95.296875, lastEvaluationMs: null})
  })

  test('evaluations that write state back are the same at 10, 30, 60 and 120 fps and through a 500 ms stall, with presses between frames', () => {
    const random = createRandom(53)
    const events: TestEvent[] = []
    let time = 100
    for (let id = 0; id < 20; id++) {
      time += 20 + random() * 400
      events.push({timeStamp: time, id})
    }
    const durationMs = time + 1000
    // A stand-in for a program: an event starts an animation that settles at the
    // first settle check 300 ms or more after the latest event, and an evaluation
    // while the clock is stopped (settleCheck with no steps behind it) finds
    // nothing animating unless it applies events. Gaps above 364 ms stop the clock.
    const stopsAfterEvents = (evaluation: PlannedEvaluation<TestEvent>) => {
      if (evaluation.kind === 'events') return true
      if (!evaluation.settleCheck) return true
      if (evaluation.kind === 'frame') return false
      let latestEventMs = Number.NEGATIVE_INFINITY
      for (const event of events) {
        const eventMs = quantizeTimeMs(event.timeStamp)
        if (eventMs <= evaluation.timeMs) latestEventMs = Math.max(latestEventMs, eventMs)
      }
      return evaluation.timeMs - latestEventMs < 300
    }
    const writing = (run: ReturnType<typeof runPlanner>) => run.log.filter(evaluation => evaluation.writesBack)
    const reference = writing(runPlanner(frameTimesAt(120, durationMs), events, 'events and settle checks', stopsAfterEvents))
    expect(reference.filter(evaluation => evaluation.kind === 'settle check').length).toBeGreaterThan(20)
    for (const frameTimes of [
      frameTimesAt(10, durationMs),
      frameTimesAt(30, durationMs),
      frameTimesAt(60, durationMs),
      frameTimesAt(60, durationMs, {startMs: 1000, lengthMs: 500}),
    ]) {
      const run = runPlanner(frameTimes, events, 'events and settle checks', stopsAfterEvents)
      expect(writing(run)).toEqual(reference)
      expect(run.log.filter(evaluation => evaluation.kind === 'frame').every(evaluation => !evaluation.writesBack)).toBe(true)
      // With every evaluation writing back, the settle checks are still the same.
      const checks = (log: readonly LoggedEvaluation[]) => log.filter(evaluation => evaluation.kind !== 'frame').map(({kind, timeMs, settleCheck, eventIds}) => ({kind, timeMs, settleCheck, eventIds}))
      expect(checks(runPlanner(frameTimes, events, 'every evaluation', stopsAfterEvents).log)).toEqual(checks(reference))
    }
    for (const evaluation of reference) {
      expect(evaluation.steps).toBeLessThanOrEqual(evaluation.kind === 'settle check' ? 16 : 300)
      expect(evaluation.snap).toBe(false)
    }
  })

  test('past the cap, a snap evaluation stops the clock and drops the backlog, so no frame runs more than 300 steps', () => {
    const stall = runPlanner([0, 1000 / 60, 2000 + 1000 / 60, 2000 + 2000 / 60], [{timeStamp: 0, id: 0}], 'every evaluation', movesUntilSnap())
    expect(stall.log.map(({kind, timeMs, simulatedTimeMs, durationMs, steps, settleCheck, snap}) => ({kind, timeMs, simulatedTimeMs, durationMs, steps, settleCheck, snap}))).toEqual([
      {kind: 'events', timeMs: 0, simulatedTimeMs: 0, durationMs: 0, steps: 0, settleCheck: true, snap: false},
      {kind: 'frame', timeMs: 0, simulatedTimeMs: 0, durationMs: 0, steps: 0, settleCheck: false, snap: false},
      {kind: 'frame', timeMs: 16.671875, simulatedTimeMs: 16, durationMs: 16.671875, steps: 4, settleCheck: false, snap: false},
      // 2,000.671875 ms pending would be 500 steps: snap, and the frame runs with the clock stopped.
      {kind: 'snap', timeMs: 2016.671875, simulatedTimeMs: 2016.671875, durationMs: 2000, steps: 0, settleCheck: true, snap: true},
      {kind: 'frame', timeMs: 2016.671875, simulatedTimeMs: 2016.671875, durationMs: 0, steps: 0, settleCheck: true, snap: false},
      {kind: 'frame', timeMs: 2033.328125, simulatedTimeMs: 2033.328125, durationMs: 0, steps: 0, settleCheck: true, snap: false},
    ])
    expect(stall.clocks[2]!.animatedUntilMs).toBeNull()
    expect(stall.stepsPerFrame).toEqual([0, 4, 0, 0])
    // A snap that still reports something animating starts the clock at its own time.
    const stillMoving = runPlanner([0, 1000 / 60, 2000 + 1000 / 60], [{timeStamp: 0, id: 0}], 'every evaluation')
    expect(stillMoving.clock).toEqual({animatedUntilMs: 2016.671875, checkOriginMs: 2016.671875, lastEvaluationMs: 2016.671875})
    // With 'events and settle checks', the snap writes state back, and the frame then evaluates a copy.
    let committed = advanceFrame(stoppedSpringClock, 10, [{timeStamp: 10, id: 0}], () => true, 'events and settle checks')
    const snapLog: PlannedEvaluation<TestEvent>[] = []
    const moving = movesUntilSnap()
    committed = advanceFrame(committed, 3000, [], evaluation => {
      snapLog.push(evaluation)
      return moving(evaluation)
    }, 'events and settle checks')
    expect(snapLog.map(({kind, steps, writesBack}) => ({kind, steps, writesBack}))).toEqual([
      {kind: 'snap', steps: 0, writesBack: true},
      {kind: 'frame', steps: 0, writesBack: false},
    ])
    expect(committed).toEqual({animatedUntilMs: null, checkOriginMs: 10, lastEvaluationMs: null})
  })

  test('an event during a long stall applies at its own timestamp after a snap, and later steps share what is left of the budget', () => {
    const run = runPlanner([0, 1000 / 60, 3000 + 1000 / 60], [{timeStamp: 0, id: 0}, {timeStamp: 1500, id: 1}, {timeStamp: 2950, id: 2}], 'every evaluation', movesUntilSnap())
    expect(run.log.slice(3).map(({kind, timeMs, simulatedTimeMs, steps, settleCheck, snap, eventIds}) => ({kind, timeMs, simulatedTimeMs, steps, settleCheck, snap, eventIds}))).toEqual([
      // 1,484 ms from where the springs stepped to the press: snap onto the destinations before it, then apply it.
      {kind: 'snap', timeMs: 1500, simulatedTimeMs: 1500, steps: 0, settleCheck: true, snap: true, eventIds: []},
      {kind: 'events', timeMs: 1500, simulatedTimeMs: 1500, steps: 0, settleCheck: true, snap: false, eventIds: [1]},
      // 1,450 ms more: snap onto the first press's destinations, and apply the second press.
      {kind: 'snap', timeMs: 2950, simulatedTimeMs: 2950, steps: 0, settleCheck: true, snap: true, eventIds: []},
      {kind: 'events', timeMs: 2950, simulatedTimeMs: 2950, steps: 0, settleCheck: true, snap: false, eventIds: [2]},
      // The second press's animation starts at its timestamp and steps normally to the frame.
      {kind: 'settle check', timeMs: 3014, simulatedTimeMs: 3014, steps: 16, settleCheck: true, snap: false, eventIds: []},
      {kind: 'frame', timeMs: 3016.671875, simulatedTimeMs: 3014, steps: 0, settleCheck: false, snap: false, eventIds: []},
    ])
    // A press at 1,150 ms steps 283 times with its settle checks, and the 25 steps
    // up to the frame at 1,250 ms exceed the remaining 17, so the springs snap.
    const split = runPlanner([0, 1000 / 60, 1250], [{timeStamp: 0, id: 0}, {timeStamp: 1150, id: 1}], 'every evaluation', movesUntilSnap())
    expect(split.stepsPerFrame).toEqual([0, 4, 283])
    expect(split.log.slice(-3).map(({kind, timeMs, steps}) => ({kind, timeMs, steps}))).toEqual([
      {kind: 'events', timeMs: 1150, steps: 15},
      {kind: 'snap', timeMs: 1250, steps: 0},
      {kind: 'frame', timeMs: 1250, steps: 0},
    ])
    expect(split.log.filter(evaluation => evaluation.kind === 'settle check').map(evaluation => evaluation.timeMs)).toEqual(Array.from({length: 17}, (_, index) => 64 * (index + 1)))
  })

  test('late events apply at the last evaluation, events after the frame at the frame, and events sharing a timestamp share one evaluation', () => {
    let clock = advanceFrame(stoppedSpringClock, 100, [{timeStamp: 100, id: 0}], () => true)
    const log: LoggedEvaluation[] = []
    clock = advanceFrame(clock, 116.6667, [
      {timeStamp: 90, id: 1},
      {timeStamp: 105, id: 2},
      {timeStamp: 130, id: 3},
      {timeStamp: 105.001, id: 4},
    ], evaluation => {
      const {events, ...rest} = evaluation
      log.push({...rest, eventIds: events.map(event => event.id)})
      return true
    })
    expect(log.map(({kind, timeMs, steps, eventIds}) => ({kind, timeMs, steps, eventIds}))).toEqual([
      {kind: 'events', timeMs: 100, steps: 0, eventIds: [1]},
      {kind: 'events', timeMs: 105, steps: 1, eventIds: [2, 4]},
      {kind: 'events', timeMs: 116.671875, steps: 3, eventIds: [3]},
      {kind: 'frame', timeMs: 116.671875, steps: 0, eventIds: []},
    ])
    expect(clock).toEqual({animatedUntilMs: 116, checkOriginMs: 100, lastEvaluationMs: 116.671875})
  })

  test("with 'events and settle checks', a frame evaluates a copy and leaves the clock where the last commit put it", () => {
    const committed = advanceFrame(stoppedSpringClock, 10, [{timeStamp: 10, id: 0}], () => true, 'events and settle checks')
    const log: PlannedEvaluation<TestEvent>[] = []
    const after = advanceFrame(committed, 40, [], evaluation => {
      log.push(evaluation)
      return true
    }, 'events and settle checks')
    expect(log.map(({kind, steps, writesBack, durationMs}) => ({kind, steps, writesBack, durationMs}))).toEqual([{kind: 'frame', steps: 7, writesBack: false, durationMs: 30}])
    expect(after).toEqual(committed)
  })

  test("a snap counts steps from the last evaluation that wrote state back, so with 'events and settle checks' a frame gap from just above 1,140 ms can snap, depending on where the last settle check landed", () => {
    // An event at 0 ms starts an animation that moves until a snap. One frame runs at
    // previousFrameMs, and the next one gapMs later. Returns whether that frame snaps.
    const snapsAfterGap = (previousFrameMs: number, gapMs: number, writeBack: WriteBack) => {
      const moving = movesUntilSnap()
      let clock = advanceFrame(stoppedSpringClock, 0, [{timeStamp: 0, id: 0}], moving, writeBack)
      clock = advanceFrame(clock, previousFrameMs, [], moving, writeBack)
      let snapped = false
      advanceFrame(clock, previousFrameMs + gapMs, [], evaluation => {
        if (evaluation.snap) snapped = true
        return moving(evaluation)
      }, writeBack)
      return snapped
    }
    // The frame at 60 ms wrote back at simulated time 60 ms, so 1,204 ms later is 301 steps.
    expect(snapsAfterGap(60, 1203, 'every evaluation')).toBe(false)
    expect(snapsAfterGap(60, 1204, 'every evaluation')).toBe(true)
    // The frame at 60 ms evaluated a copy, and the first settle check is at 64 ms, so
    // the steps count from the event at 0 ms.
    expect(snapsAfterGap(60, 1143, 'events and settle checks')).toBe(false)
    expect(snapsAfterGap(60, 1144, 'events and settle checks')).toBe(true)
    // A frame at 64 ms runs the settle check at 64 ms, which writes back.
    expect(snapsAfterGap(64, 1203, 'events and settle checks')).toBe(false)
    expect(snapsAfterGap(64, 1204, 'events and settle checks')).toBe(true)
    // The last evaluation that wrote back is less than 64 ms before the previous frame,
    // so the smallest gap that snaps is just above 1,140 ms, e.g. after a frame at 63.984375 ms.
    expect(snapsAfterGap(63.984375, 1140, 'events and settle checks')).toBe(false)
    expect(snapsAfterGap(63.984375, 1140.015625, 'events and settle checks')).toBe(true)
  })
})

// A small app along frame-time traces. Object 0 has x and y springs (stiffness
// 290, damping 30) and a scale spring (stiffness 333, damping 20); object 1 has one
// spring (stiffness 290, damping 30). A press replaces one object's destinations,
// and a jump press also snaps that object onto them. The host writes one matrix per
// stiffness and damping pair before each evaluation, and 1 into every object's
// snap cell for a planned snap.
type Press = {timeStamp: number, object: number, destinations: readonly number[], jump: boolean}

const appPairs: readonly SpringConstants[] = [{stiffness: 290, damping: 30}, {stiffness: 333, damping: 20}]
const appSpringPair = [0, 0, 1, 0] as const
const appObjectSprings: readonly (readonly number[])[] = [[0, 1, 2], [3]]
const appInitialPositions = [400, 300, 1, 200] as const
const appCell = {matrixStart: 0, settleCheck: 8, eventActiveStart: 9, snapStart: 11, eventDestinationStart: 13, springStart: 17, size: 29} as const
// Per spring: its displacement from the destination in effect, its velocity, and that destination.
const appSpringCell = (spring: number, field: 0 | 1 | 2) => appCell.springStart + 3 * spring + field
const appOutput = {positions: appCell.size, active: appCell.size + 4, settled: appCell.size + 6} as const
const appPowers = appPairs.map(constants => {
  const step = springStepMatrix(constants)
  return Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(step, steps))
})

function createApp() {
  const circuit = new Circuit(appCell.size)
  appPairs.forEach((constants, pair) => {
    const bound = springMatrixBound(constants)
    for (let entry = 0; entry < 4; entry++) circuit.assumeRange(asWire(appCell.matrixStart + 4 * pair + entry), -bound, bound)
  })
  circuit.assumeRange(circuit.source(appCell.settleCheck), 0, 1)
  for (let object = 0; object < 2; object++) {
    circuit.assumeRange(asWire(appCell.eventActiveStart + object), 0, 1)
    circuit.assumeRange(asWire(appCell.snapStart + object), 0, 1)
  }
  const objectOfSpring = (spring: number) => appObjectSprings.findIndex(members => members.includes(spring))
  const destinations = appSpringPair.map((_, spring) => circuit.select(
    asWire(appCell.eventActiveStart + objectOfSpring(spring)),
    asWire(appSpringCell(spring, 2)),
    asWire(appCell.eventDestinationStart + spring),
  ))
  const objects = appObjectSprings.map((members, objectIndex) => emitAnimatedObject(circuit, members.map(spring => {
    const start = appCell.matrixStart + 4 * appSpringPair[spring]!
    return {
      matrix: [circuit.source(start), circuit.source(start + 1), circuit.source(start + 2), circuit.source(start + 3)] as const,
      displacement: circuit.source(appSpringCell(spring, 0)),
      velocity: circuit.source(appSpringCell(spring, 1)),
      destination: destinations[spring]!,
      destinationDuringSteps: circuit.source(appSpringCell(spring, 2)),
    }
  }), {settleCheck: circuit.source(appCell.settleCheck), snap: circuit.source(appCell.snapStart + objectIndex)}))
  const positions: Wire[] = []
  const displacements: Wire[] = []
  const velocities: Wire[] = []
  objects.forEach((object, objectIndex) => appObjectSprings[objectIndex]!.forEach((spring, index) => {
    positions[spring] = object.positions[index]!
    displacements[spring] = object.displacements[index]!
    velocities[spring] = object.velocities[index]!
  }))
  const zero = circuit.affine([], 0)
  const nextSource: Wire[] = Array.from({length: appCell.size}, (_, wire) => circuit.source(wire))
  for (let object = 0; object < 2; object++) {
    nextSource[appCell.eventActiveStart + object] = zero
    nextSource[appCell.snapStart + object] = zero
  }
  for (let spring = 0; spring < 4; spring++) {
    nextSource[appCell.eventDestinationStart + spring] = zero
    nextSource[appSpringCell(spring, 0)] = displacements[spring]!
    nextSource[appSpringCell(spring, 1)] = velocities[spring]!
    nextSource[appSpringCell(spring, 2)] = destinations[spring]!
  }
  const roots = [...nextSource, ...positions, ...objects.map(object => object.active), ...objects.map(object => object.settled)]
  return circuit.createTensorEvaluator(roots)
}

type AppRun = {
  frames: Map<number, {positions: number[], outputs: Float32Array}>
  settles: {timeMs: number, settled: number[]}[]
  commits: {timeMs: number, kind: string, table: Float32Array}[]
  stepsPerFrame: number[]
  clock: SpringClock
  // Evaluations that wrote state back without checking settling, and found nothing animating.
  stopsWithoutSettleCheck: number
}

// `offset` is added to every destination, e.g. 65,536 runs the app near 65,536 px.
function runApp(evaluate: ReturnType<typeof createApp>, presses: readonly Press[], frameTimes: readonly number[], writeBack: WriteBack, offset = 0): AppRun {
  const state = new Float32Array(appCell.size)
  appInitialPositions.forEach((position, spring) => {
    state[appSpringCell(spring, 2)] = position + offset
  })
  const scratch = new Float32Array(appCell.size)
  const run: AppRun = {frames: new Map(), settles: [], commits: [], stepsPerFrame: [], clock: stoppedSpringClock, stopsWithoutSettleCheck: 0}
  let nextPress = 0
  for (const frameTime of frameTimes) {
    const arrived: Press[] = []
    while (nextPress < presses.length && presses[nextPress]!.timeStamp <= frameTime) arrived.push(presses[nextPress++]!)
    let steps = 0
    run.clock = advanceFrame(run.clock, frameTime, arrived, evaluation => {
      steps += evaluation.steps
      const table = evaluation.writesBack ? state : scratch
      if (!evaluation.writesBack) scratch.set(state)
      appPowers.forEach((powers, pair) => table.set(powers[evaluation.steps]!, appCell.matrixStart + 4 * pair))
      table[appCell.settleCheck] = evaluation.settleCheck ? 1 : 0
      for (let object = 0; object < 2; object++) table[appCell.snapStart + object] = evaluation.snap ? 1 : 0
      for (const press of evaluation.events) {
        table[appCell.eventActiveStart + press.object] = 1
        if (press.jump) table[appCell.snapStart + press.object] = 1
        appObjectSprings[press.object]!.forEach((spring, index) => {
          table[appCell.eventDestinationStart + spring] = press.destinations[index]! + offset
        })
      }
      const outputs = evaluate(table)
      if (evaluation.writesBack) {
        state.set(outputs.subarray(0, appCell.size))
        run.commits.push({timeMs: evaluation.timeMs, kind: evaluation.kind, table: Float32Array.from(state)})
        if (evaluation.settleCheck && evaluation.kind !== 'frame') {
          run.settles.push({timeMs: evaluation.timeMs, settled: [outputs[appOutput.settled]!, outputs[appOutput.settled + 1]!]})
        }
      }
      if (evaluation.kind === 'frame') {
        run.frames.set(frameTime, {
          positions: Array.from(outputs.subarray(appOutput.positions, appOutput.positions + 4)),
          outputs: Float32Array.from(outputs),
        })
      }
      const animating = outputs[appOutput.active]! > 0 || outputs[appOutput.active + 1]! > 0
      if (evaluation.writesBack && !evaluation.settleCheck && !animating) run.stopsWithoutSettleCheck++
      return animating
    }, writeBack)
    run.stepsPerFrame.push(steps)
  }
  return run
}

type Float64Spring = {position: number, velocity: number, destination: number}

function stepFloat64Springs(springs: readonly Float64Spring[]) {
  springs.forEach((spring, index) => {
    const {stiffness, damping} = appPairs[appSpringPair[index]!]!
    const displacement = spring.position - spring.destination
    spring.velocity += (-stiffness * displacement - damping * spring.velocity) * 0.004
    spring.position = spring.destination + displacement + spring.velocity * 0.004
  })
}

// Snaps every object whose springs are all within both thresholds, and returns the bits.
function settleFloat64Objects(springs: readonly Float64Spring[]) {
  const threshold = f(0.01)
  return appObjectSprings.map(members => {
    const settled = members.every(spring =>
      Math.abs(springs[spring]!.position - springs[spring]!.destination) <= threshold && Math.abs(springs[spring]!.velocity) <= threshold)
    if (settled) {
      for (const spring of members) {
        springs[spring]!.position = springs[spring]!.destination
        springs[spring]!.velocity = 0
      }
    }
    return settled ? 1 : 0
  })
}

// Frame-free float64 springs: 4 ms Euler steps from the moment the clock
// started, settle checks every 16 steps, presses applied at their timestamps
// after stepping to them, and a stopped clock that starts at a press. A jump
// snaps its object after the press's settle check, and the clock stops once
// every spring is exactly at rest.
function runFloat64Reference(presses: readonly Press[], frameTimes: readonly number[], offset = 0) {
  const springs: Float64Spring[] = appInitialPositions.map(position => ({position: position + offset, velocity: 0, destination: position + offset}))
  let animatedUntilMs: number | null = null
  let originMs = 0
  const settles: {timeMs: number, settled: number[]}[] = []
  const check = (timeMs: number) => {
    const settled = settleFloat64Objects(springs)
    settles.push({timeMs, settled})
    return settled.every(bit => bit === 1)
  }
  const advanceTo = (timeMs: number) => {
    while (animatedUntilMs !== null && animatedUntilMs + 4 <= timeMs) {
      stepFloat64Springs(springs)
      const stepped: number = animatedUntilMs + 4
      animatedUntilMs = (stepped - originMs) % 64 === 0 && check(stepped) ? null : stepped
    }
  }
  const positions = new Map<number, number[]>()
  const displacements = new Map<number, number[]>()
  let nextPress = 0
  for (const frameTime of frameTimes) {
    while (nextPress < presses.length && presses[nextPress]!.timeStamp <= frameTime) {
      const timeMs = presses[nextPress]!.timeStamp
      advanceTo(timeMs)
      const jumped = new Set<number>()
      while (nextPress < presses.length && presses[nextPress]!.timeStamp === timeMs) {
        const press = presses[nextPress++]!
        appObjectSprings[press.object]!.forEach((spring, index) => {
          springs[spring]!.destination = press.destinations[index]! + offset
        })
        if (press.jump) jumped.add(press.object)
      }
      const snapJumped = () => {
        for (const object of jumped) {
          for (const spring of appObjectSprings[object]!) {
            springs[spring]!.position = springs[spring]!.destination
            springs[spring]!.velocity = 0
          }
        }
      }
      if (animatedUntilMs === null) {
        const settled = settleFloat64Objects(springs)
        settles.push({timeMs, settled})
        snapJumped()
        if (settled.some((bit, object) => bit === 0 && !jumped.has(object))) {
          animatedUntilMs = timeMs
          originMs = timeMs
        }
      } else {
        snapJumped()
        if (springs.every(spring => spring.position === spring.destination && spring.velocity === 0)) animatedUntilMs = null
      }
    }
    advanceTo(frameTime)
    positions.set(frameTime, springs.map(spring => spring.position))
    displacements.set(frameTime, springs.map(spring => spring.position - spring.destination))
  }
  return {positions, displacements, settles}
}

// chenguini ui.md's order in float64: handle inputs, new layout, then an
// animation tick that catches up toward the new destinations, with one settle
// check per frame.
function runUiMdOrder(presses: readonly Press[], frameTimes: readonly number[]) {
  const springs: Float64Spring[] = appInitialPositions.map(position => ({position, velocity: 0, destination: position}))
  let animatedUntilMs: number | null = null
  const positions = new Map<number, number[]>()
  let nextPress = 0
  for (const now of frameTimes) {
    while (nextPress < presses.length && presses[nextPress]!.timeStamp <= now) {
      const press = presses[nextPress++]!
      appObjectSprings[press.object]!.forEach((spring, index) => {
        springs[spring]!.destination = press.destinations[index]!
      })
    }
    let newAnimatedUntilMs: number = animatedUntilMs ?? now
    const steps = Math.min(300, Math.floor((now - newAnimatedUntilMs) / 4))
    newAnimatedUntilMs += steps * 4
    for (let step = 0; step < steps; step++) stepFloat64Springs(springs)
    animatedUntilMs = settleFloat64Objects(springs).every(bit => bit === 1) ? null : newAnimatedUntilMs
    positions.set(now, springs.map(spring => spring.position))
  }
  return positions
}

// 12 presses between frames on the 1/64 ms grid, 90 to 700 ms apart, so most
// retarget moving springs. With jumpChance above 0, some presses are jumps.
function appPresses(seed: number, jumpChance = 0) {
  const random = createRandom(seed)
  const presses: Press[] = []
  let time = 100
  for (let index = 0; index < 12; index++) {
    time += 90 + random() * 610
    const object = random() < 0.6 ? 0 : 1
    const destinations = object === 0
      ? [Math.round(random() * 800), Math.round(random() * 600), Math.round((0.5 + random()) * 64) / 64]
      : [Math.round(random() * 800)]
    // Drawn only when asked, so the traces without jumps stay the same.
    const jump = jumpChance > 0 && random() < jumpChance
    presses.push({timeStamp: Math.round(time * 64) / 64, object, destinations, jump})
  }
  return presses
}

function framePositions(run: AppRun) {
  return new Map([...run.frames].map(([time, frame]) => [time, frame.positions]))
}

// Each spring's stored displacement after each frame's evaluation.
function frameDisplacements(run: AppRun) {
  return new Map([...run.frames].map(([time, frame]) => [time, Array.from({length: 4}, (_, spring) => frame.outputs[appSpringCell(spring, 0)]!)]))
}

function maxFrameDifference(left: ReadonlyMap<number, readonly number[]>, right: ReadonlyMap<number, readonly number[]>) {
  let worst = 0
  let shared = 0
  for (const [time, positions] of left) {
    const other = right.get(time)
    if (other === undefined) continue
    shared++
    positions.forEach((position, index) => {
      worst = Math.max(worst, Math.abs(position - other[index]!))
    })
  }
  expect(shared).toBeGreaterThan(20)
  return worst
}

function differingBits(left: Float32Array, right: Float32Array) {
  let count = 0
  for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) count++
  return count
}

// Seeds 1 to 8 without jumps, then 4 seeds where about a third of the presses jump.
const traceCases = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(seed => ({seed, jumpChance: 0})),
  ...[21, 22, 23, 24].map(seed => ({seed, jumpChance: 0.35})),
]

function traceSchedules(presses: readonly Press[]) {
  const durationMs = presses.at(-1)!.timeStamp + 2000
  const stall = {startMs: presses[2]!.timeStamp - 100, lengthMs: 500}
  return {
    baseline: frameTimesAt(120, durationMs),
    others: [
      frameTimesAt(10, durationMs),
      frameTimesAt(30, durationMs),
      frameTimesAt(60, durationMs),
      frameTimesAt(60, durationMs, stall),
      frameTimesAt(120, durationMs, stall),
    ],
  }
}

describe('springs along frame-time traces, with presses between frames', () => {
  const evaluate = createApp()

  test("with 'events and settle checks', committed tables and displays are bit-identical at 10, 30, 60 and 120 fps and through 500 ms stalls, and settle like float64 springs, including jumps that stop the clock at exact rest", () => {
    let stopsAtJumps = 0
    for (const {seed, jumpChance} of traceCases) {
      const presses = appPresses(seed, jumpChance)
      const {baseline, others} = traceSchedules(presses)
      const baselineRun = runApp(evaluate, presses, baseline, 'events and settle checks')
      for (const frameTimes of [baseline, ...others]) {
        const run = frameTimes === baseline ? baselineRun : runApp(evaluate, presses, frameTimes, 'events and settle checks')
        expect(run.commits.map(({timeMs, kind}) => `${kind}@${timeMs}`)).toEqual(baselineRun.commits.map(({timeMs, kind}) => `${kind}@${timeMs}`))
        run.commits.forEach((commit, index) => expect(differingBits(commit.table, baselineRun.commits[index]!.table)).toBe(0))
        let sharedDisplays = 0
        for (const [time, frame] of run.frames) {
          const other = baselineRun.frames.get(time)
          if (other === undefined) continue
          sharedDisplays++
          expect(differingBits(frame.outputs, other.outputs)).toBe(0)
        }
        expect(sharedDisplays).toBeGreaterThan(20)
        const reference = runFloat64Reference(presses, frameTimes)
        expect(run.settles).toEqual(reference.settles)
        expect(maxFrameDifference(framePositions(run), reference.positions)).toBeLessThan(5e-4)
        expect(run.commits.some(commit => commit.kind === 'snap')).toBe(false)
      }
      // Without jumps, a running clock only stops at a settle check. A jump snaps its
      // object, and when the other object is exactly at rest, nothing animates and the
      // clock stops at the jump, which needs the rest bit.
      if (jumpChance === 0) expect(baselineRun.stopsWithoutSettleCheck).toBe(0)
      else stopsAtJumps += baselineRun.stopsWithoutSettleCheck
    }
    // Measured: 5 stops over the 4 traces with jumps.
    expect(stopsAtJumps).toBeGreaterThan(0)
  })

  test('writing back every evaluation stays within 5e-4 px of float64 springs and of 120 fps, and settles like float64 springs', () => {
    let runsWithDifferentSettles = 0
    for (const {seed, jumpChance} of traceCases) {
      const presses = appPresses(seed, jumpChance)
      const {baseline, others} = traceSchedules(presses)
      const baselineRun = runApp(evaluate, presses, baseline, 'every evaluation')
      for (const frameTimes of [baseline, ...others]) {
        const run = frameTimes === baseline ? baselineRun : runApp(evaluate, presses, frameTimes, 'every evaluation')
        const reference = runFloat64Reference(presses, frameTimes)
        expect(maxFrameDifference(framePositions(run), reference.positions)).toBeLessThan(5e-4)
        expect(maxFrameDifference(framePositions(run), framePositions(baselineRun))).toBeLessThan(5e-4)
        if (JSON.stringify(run.settles) !== JSON.stringify(reference.settles)) runsWithDifferentSettles++
      }
    }
    // Every evaluation rounds the stored displacement at its own size, so drift
    // shrinks near rest. Measured on seeds 1 to 8: up to 1.4e-4 px from float64,
    // and every run settles like float64. With absolute positions, which rounded at
    // up to 2^-14 px at 800 px, it was 7.3e-4 px, and 2 of 48 runs settled at a
    // different check.
    expect(runsWithDifferentSettles).toBe(0)
  })

  test('a 3 s stall snaps every object onto its destination once, no frame runs more than 300 steps, and the committed tables stay bit-identical across frame rates', () => {
    const presses: Press[] = [
      {timeStamp: 100, object: 0, destinations: [700, 50, 1.5], jump: false},
      {timeStamp: 250, object: 1, destinations: [20], jump: false},
      // During the stall, 2.9 s before the next frame.
      {timeStamp: 500, object: 0, destinations: [120, 480, 0.75], jump: false},
      {timeStamp: 4000, object: 1, destinations: [640], jump: false},
      {timeStamp: 4100, object: 0, destinations: [300, 300, 1], jump: false},
    ]
    const stall = {startMs: 400, lengthMs: 3000}
    const runs = [120, 60, 30, 10].map(hz => runApp(evaluate, presses, frameTimesAt(hz, 6000, stall), 'events and settle checks'))
    for (const run of runs) {
      expect(Math.max(...run.stepsPerFrame)).toBeLessThanOrEqual(300)
      const snaps = run.commits.filter(commit => commit.kind === 'snap')
      expect(snaps.map(commit => commit.timeMs)).toEqual([3400])
      // Right after the snap every displacement and velocity is ±0.
      for (let spring = 0; spring < 4; spring++) {
        expect(snaps[0]!.table[appSpringCell(spring, 0)] === 0).toBe(true)
        expect(snaps[0]!.table[appSpringCell(spring, 1)] === 0).toBe(true)
      }
      expect(run.commits.map(({timeMs, kind}) => `${kind}@${timeMs}`)).toEqual(runs[0]!.commits.map(({timeMs, kind}) => `${kind}@${timeMs}`))
      run.commits.forEach((commit, index) => expect(differingBits(commit.table, runs[0]!.commits[index]!.table)).toBe(0))
      expect(run.clock.animatedUntilMs).toBeNull()
    }
    // Every frame rate resumes at 3,400 ms, and shows the snapped objects there.
    expect(runs[3]!.frames.get(3400)!.positions).toEqual([120, 480, 0.75, 20])
  })

  test('moved to 65,536, 131,072 and 1,048,576 px, both policies settle like float64 springs and stop animating, and stored displacements stay within 5e-4 px of float64 up to 131,072 px', () => {
    for (const offset of [2 ** 16, 2 ** 17, 2 ** 20]) {
      // FP32 values near the offset are this far apart, e.g. 1/128 px near 65,536 px.
      const spacing = 2 ** (Math.log2(offset) - 23)
      for (const writeBack of ['every evaluation', 'events and settle checks'] as const) {
        let worstDisplacement = 0
        let worstPosition = 0
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
          const presses = appPresses(seed)
          const {baseline, others} = traceSchedules(presses)
          for (const frameTimes of [baseline, ...others]) {
            const run = runApp(evaluate, presses, frameTimes, writeBack, offset)
            const reference = runFloat64Reference(presses, frameTimes, offset)
            expect(run.settles).toEqual(reference.settles)
            // Nothing still animates 2 s after the last press.
            expect(run.clock.animatedUntilMs).toBeNull()
            worstDisplacement = Math.max(worstDisplacement, maxFrameDifference(frameDisplacements(run), reference.displacements))
            worstPosition = Math.max(worstPosition, maxFrameDifference(framePositions(run), reference.positions))
          }
        }
        if (offset <= 2 ** 17) {
          // Measured: 1.4e-4 px with 'every evaluation' and 7.4e-5 px with 'events and settle checks', as at 0 px.
          expect(worstDisplacement).toBeLessThan(5e-4)
          // The drawn position rounds once at the destination's magnitude. Measured:
          // 3.9e-3 px near 65,536 px and 7.9e-3 px near 131,072 px.
          expect(worstPosition).toBeLessThan(spacing / 2 + 5e-4)
        } else {
          // FP32 values near 1,048,576 px are 1/8 px apart, so the scale spring's
          // destinations, on a 1/64 grid, round before they reach the program. Measured: 0.10 px.
          expect(worstDisplacement).toBeLessThan(spacing)
        }
      }
    }
  })

  test("ui.md's order, applying presses and then catching up, differs across frame rates in float64", () => {
    let worst10 = 0
    let worst30 = 0
    let worst60 = 0
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const presses = appPresses(seed)
      const durationMs = presses.at(-1)!.timeStamp + 2000
      const baseline = runUiMdOrder(presses, frameTimesAt(120, durationMs))
      worst10 = Math.max(worst10, maxFrameDifference(runUiMdOrder(presses, frameTimesAt(10, durationMs)), baseline))
      worst30 = Math.max(worst30, maxFrameDifference(runUiMdOrder(presses, frameTimesAt(30, durationMs)), baseline))
      worst60 = Math.max(worst60, maxFrameDifference(runUiMdOrder(presses, frameTimesAt(60, durationMs)), baseline))
    }
    // Measured: 359, 124 and 53 px.
    expect(worst10).toBeGreaterThan(100)
    expect(worst30).toBeGreaterThan(50)
    expect(worst60).toBeGreaterThan(10)
  })
})
