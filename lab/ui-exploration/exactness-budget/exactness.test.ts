import {expect, test} from 'bun:test'
import {Circuit} from '../../../numeric-ui-core.ts'
import {createWindowManagerMachine} from '../codegen/window-manager-copy.ts'
import {compileInstanceProgram} from './copies/codegen/instance.ts'
import {applyInteraction, interactionFrameTime} from './copies/codegen/indirect-os-machine.ts'
import {createWgslInterpreter} from './copies/codegen/wgsl-interpreter.ts'
import {packSharedBuffer} from './copies/codegen/wgsl.ts'
import {createCandidateWidthWorkload, createLifeCalendarWorkload} from './copies/codegen/workloads.ts'
import {emitCompare} from './copies/numeric-library/comparison.ts'
import {createWorkspace, evaluate, fusedMultiplyAdd32, installInterpreter, perturbedModes, prepareModeProgram, type Mode} from './interpreter.ts'
import {lifeCalendarStates, runLifeCalendar} from './life-calendar-run.ts'
import {runWorkload} from './measure.ts'
import {roundingPositions} from './rounding-positions.ts'
import {emitRoundingWgsl, roundingGuards} from './wgsl-rounding.ts'
import {cardsWorkload, indirectOSWorkload} from './workloads.ts'

const f = Math.fround

// The exact value a + w · x as a BigInt over a power of two, rounded directly to
// FP32's 24 significant bits (round half to even), with no double in between.
function exactFusedMultiplyAdd(a: number, w: number, x: number) {
  const decompose = (value: number) => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    const high = view.getUint32(0)
    const low = view.getUint32(4)
    const sign = high >>> 31 === 1 ? -1n : 1n
    const exponent = (high >>> 20) & 0x7ff
    let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
    if (exponent !== 0) mantissa |= 1n << 52n
    return {mantissa: sign * mantissa, exponent: (exponent === 0 ? 1 : exponent) - 1075}
  }
  const left = decompose(a)
  const factor = decompose(w)
  const operand = decompose(x)
  const productExponent = factor.exponent + operand.exponent
  const exponent = Math.min(left.exponent, productExponent)
  const numerator = left.mantissa * (1n << BigInt(left.exponent - exponent)) + factor.mantissa * operand.mantissa * (1n << BigInt(productExponent - exponent))
  if (numerator === 0n) return 0
  const magnitude = numerator < 0n ? -numerator : numerator
  // Keep 24 significant bits, or fewer below FP32's smallest exponent, 2^-149.
  const shift = Math.max(magnitude.toString(2).length - 24, -149 - exponent)
  let kept = magnitude
  if (shift > 0) {
    kept = magnitude >> BigInt(shift)
    const remainder = magnitude - (kept << BigInt(shift))
    const half = 1n << BigInt(shift - 1)
    if (remainder > half || (remainder === half && (kept & 1n) === 1n)) kept++
  }
  // kept has at most 25 bits, so this product and the fround below don't round.
  const rounded = Number(kept) * 2 ** (exponent + Math.max(shift, 0))
  return f(numerator < 0n ? -rounded : rounded)
}

test('the fused multiply-add rounds once, exactly, like a BigInt reference', () => {
  let state = 11
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 4294967296
  }
  let mismatches = 0
  let differsFromStored = 0
  for (let index = 0; index < 20_000; index++) {
    const scale = 2 ** Math.floor(random() * 20 - 10)
    const a = f((random() - 0.5) * 64 * scale)
    const w = f((random() - 0.5) * 4)
    const x = f((random() - 0.5) * 64 * scale)
    const actual = fusedMultiplyAdd32(a, w, x)
    const expected = exactFusedMultiplyAdd(a, w, x)
    if (!(Object.is(actual, expected) || (actual === 0 && expected === 0))) mismatches++
    if (actual !== f(a + f(w * x))) differsFromStored++
  }
  expect(mismatches).toBe(0)
  expect(differsFromStored).toBeGreaterThan(1000)

  // Random cases almost never put the double sum exactly on a midpoint between
  // two FP32 values, which is the only case where TwoSum's error term decides the
  // result. These cases do: for example a = 1 + 2^-23 and w · x = 2^-24 · (1 - 2^-46).
  // The double sum rounds to the midpoint 1 + 3 · 2^-24, a tie that rounds to the
  // even neighbor 1 + 2^-22, while the exact sum is 2^-70 below the midpoint, so
  // the correct result is a.
  let midpointCases = 0
  let midpointMismatches = 0
  let singleDoubleRoundingWrong = 0
  for (let index = 0; index < 2000; index++) {
    // An FP32 value whose 24-bit mantissa isn't a power of two, so its FP32 steps
    // below and above are equal.
    const mantissa = 2 ** 23 + 1 + Math.floor(random() * (2 ** 23 - 1))
    const exponent = Math.floor(random() * 40) - 20
    const value = mantissa * 2 ** (exponent - 23)
    const productExponent = Math.floor(random() * 10) - 5
    // w · x = (half of value's FP32 step) · (1 - 2^-46), exact in a double.
    const w = (1 + 2 ** -23) * 2 ** productExponent
    const x = (1 - 2 ** -23) * 2 ** (exponent - 24 - productExponent)
    for (const [a, sign] of [[value, 1], [value, -1], [-value, 1], [-value, -1]] as const) {
      midpointCases++
      const expected = exactFusedMultiplyAdd(a, w, sign * x)
      if (expected !== a) throw new Error(`reference: ${a} + ${w} · ${sign * x} should round to ${a}, got ${expected}`)
      if (fusedMultiplyAdd32(a, w, sign * x) !== expected) midpointMismatches++
      if (f(a + w * (sign * x)) !== expected) singleDoubleRoundingWrong++
    }
  }
  expect(midpointMismatches).toBe(0)
  // Without the TwoSum correction, about half the cases (odd mantissas) round the wrong way.
  expect(singleDoubleRoundingWrong).toBeGreaterThan(midpointCases / 4)
})

test('the stored mode reproduces the production executor on every live value of the IndirectOS session', () => {
  const machine = createWindowManagerMachine()
  let checked = 0
  let mismatches = 0
  const {original, restore} = installInterpreter(machine.circuit, {
    mode: 'stored',
    onEvaluate: call => {
      const expected = original.evaluateTensor(call.source)
      const {wireOrder, sourceSize, valueCount} = call.modeProgram.packed.flat
      // Source cells are copied into the values, so only operations are compared.
      for (let position = sourceSize; position < valueCount; position++) {
        checked++
        if (!Object.is(expected[wireOrder[position]!], f(call.values[position]!))) mismatches++
      }
    },
  })
  for (let frame = 0; frame < 240; frame++) {
    applyInteraction(machine, frame)
    machine.step(1280, 800, interactionFrameTime(frame))
  }
  restore()
  // 240 frames × 5,253 live operations.
  expect(checked).toBe(240 * 5253)
  expect(mismatches).toBe(0)
})

test('a round chain meets a tie that a fused product breaks the other way, and rounding-point strictness keeps the stored result', () => {
  // round(x · 2/π) at x = 3π/4: FP32 rounds the product to exactly 1.5, and the
  // tie goes to 2. The exact product is just below 1.5, so fusing it into the
  // shift by 2^23 + 2^22 gives 1. This is emitSinCos's quadrant index in the dock workload.
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 16)
  const shifted = circuit.roundAffine([[0, 0.6366197466850281]], 12_582_912)
  const rounded = circuit.roundAffine([[shifted, 1]], -12_582_912)
  const modeProgram = prepareModeProgram(circuit, circuit.compileTensorProgram([rounded]))
  expect(modeProgram.points.seeds.roundChains).toBe(2)
  const workspace = createWorkspace(modeProgram.packed)
  const position = modeProgram.packed.flat.positionOfWire[rounded]!
  const result = (mode: Mode) => evaluate(modeProgram.packed, modeProgram.rules[mode], Float32Array.of(f(3 * Math.PI / 4)), workspace)[position]
  expect(result('stored')).toBe(2)
  expect(result('fused')).toBe(1)
  expect(result('roundingStrict')).toBe(2)
  expect(result('float64')).not.toBe(2)
  expect(result('float64RoundingStrict')).toBe(2)
})

test('rounding points reach back from an exact comparison to its difference, and leave other sums alone', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(0, 0, 1024)
  circuit.assumeRange(1, 0, 1024)
  circuit.assumeRange(2, 1, 1)
  const bit = emitCompare(circuit, 0, 1, '>=')
  const blend = circuit.roundAffine([[0, 0.3], [1, 0.7], [2, 5]], 1)
  const modeProgram = prepareModeProgram(circuit, circuit.compileTensorProgram([bit, blend]))
  const {packed, points} = modeProgram
  const flagOf = (wire: number) => points.isRoundingPoint[packed.rowOfPosition[packed.flat.positionOfWire[wire]!]!]
  const difference = circuit.expressionWires.get('affine,0,0,1,1,-1,|,0|round')!
  expect(flagOf(bit)).toBe(1)
  expect(flagOf(difference)).toBe(1)
  expect(flagOf(blend)).toBe(0)
  // With operands up to 1024, the comparison needs clamp stages; every one of
  // its rows is a rounding point, and the blend is the only row that isn't.
  expect(points.roundingPointRows).toBe(packed.rowCount - 1)
})

test('IndirectOS keeps every decision in every mode, while the stack order output amplifies drift', () => {
  const result = runWorkload(indirectOSWorkload(), perturbedModes)
  expect(result.storedCheck.mismatches).toBe(0)
  expect(result.structure.orderSensitiveRoundingPoints).toBe(0)
  for (const mode of result.modes) {
    for (const loop of [mode.openLoop, mode.closedLoop]) {
      expect(loop.booleanFlips).toBe(0)
      expect(loop.bitRowFlips).toBe(0)
      expect(loop.gatherIndexFlips).toBe(0)
      expect(loop.decisionOutputFlips).toBe(0)
      expect(loop.settleFlips).toBe(0)
      expect(loop.driftByName['window positions and sizes (px)']).toBeLessThan(0.01)
    }
    expect(mode.closedLoop.divergenceFrames).toBe(0)
    expect(mode.reference).toEqual({pressesChecked: 7, pressTargetMismatches: 0, transitionsChecked: 11, transitionFailures: 0})
  }
  const reversed = result.modes.find(mode => mode.mode === 'reversed')!
  expect(reversed.closedLoop.driftByName['window stack order']).toBeGreaterThan(10)
  expect(reversed.openLoop.driftByName['window stack order']).toBeLessThan(1)
})

test('life-calendar: float64 breaks rows and columns, stored order at rounding points repairs them', () => {
  const {results} = runLifeCalendar(lifeCalendarStates(1).slice(0, 1), ['balancedFused', 'roundingStrict', 'float64', 'float64RoundingStrict'])
  const byMode = Object.fromEntries(results.map(result => [result.mode, result]))
  expect(byMode['stored']!.referenceMismatches).toBe(0)
  expect(byMode['balancedFused']!.decisionFlips).toBe(0)
  expect(byMode['roundingStrict']!.decisionFlips).toBe(0)
  expect(byMode['float64']!.flipsByField['row']).toBeGreaterThan(1000)
  expect(byMode['float64RoundingStrict']!.decisionFlips).toBe(0)
  expect(byMode['float64RoundingStrict']!.referenceMismatches).toBe(0)
  expect(byMode['float64RoundingStrict']!.maximumReferenceError).toBeLessThan(0.001)
})

test('cards: float64 diverges from the demo, stored order at rounding points keeps every decision', () => {
  const result = runWorkload(cardsWorkload(1, 5, 150), ['balancedFused', 'roundingStrict', 'float64', 'float64RoundingStrict'])
  expect(result.reference['decisionMismatchFrames']).toBe(0)
  const byMode = Object.fromEntries(result.modes.map(mode => [mode.mode, mode]))
  for (const mode of ['balancedFused', 'roundingStrict', 'float64RoundingStrict']) {
    expect(byMode[mode]!.closedLoop.divergenceFrames).toBe(0)
    expect((byMode[mode]!.reference as Record<string, number>)['decisionMismatchFrames']).toBe(0)
  }
  expect(byMode['float64']!.closedLoop.divergenceFrames).toBeGreaterThan(0)
})

test('the emitted WGSL for every guard placement reproduces generated JS under strict FP32 interpretation, with fewer guards at rounding points', () => {
  for (const workload of [createCandidateWidthWorkload(), createLifeCalendarWorkload()]) {
    const count = Math.min(workload.count, 1024)
    const flags = roundingPositions(workload.circuit, workload.program)
    const cpu = compileInstanceProgram(workload.plan, {rowsPerFunction: 128, blockSize: 256})
    const outputCount = workload.plan.outputs.length
    const expected = new Float32Array(count * outputCount)
    cpu.runShared(workload.sharedSources[0]!)
    cpu.runInstances(workload.instanceSources, count, expected)
    const guards: Record<string, number> = {}
    for (const guard of roundingGuards) {
      const module = emitRoundingWgsl(workload.plan, guard, flags)
      guards[guard] = module.exposure.guards
      const interpret = createWgslInterpreter(module.code)
      const actual = new Float32Array(count * outputCount)
      const shared = packSharedBuffer(module, cpu, new Float32Array(module.sharedLength))
      const sources = new Float32Array(workload.instanceSources.subarray(0, count * workload.plan.instanceSources.length))
      interpret(shared, sources, count, actual)
      let mismatches = 0
      for (let index = 0; index < actual.length; index++) if (actual[index] !== expected[index]) mismatches++
      expect({workload: workload.name, guard, mismatches}).toEqual({workload: workload.name, guard, mismatches: 0})
    }
    expect(guards['rounding points']!).toBeLessThan(guards['max']!)
    expect(guards['none']).toBe(0)
  }
})
