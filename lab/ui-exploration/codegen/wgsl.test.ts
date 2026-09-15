import {expect, test} from 'bun:test'
import {createCandidateGalleryMachine, sourceField as candidateSourceField} from './candidate-gallery-copy.ts'
import {sameFloat} from './codegen.ts'
import {compileInstanceProgram, instanceSourceTable, planInstances, type InstancePlan} from './instance.ts'
import {createIndirectOSMachine} from './indirect-os-machine.ts'
import {createLifeCalendarCircuit, lifeCalendarSource} from './life-calendar.ts'
import {buildRandomCircuit, createRandom, randomSource} from './random-circuit.ts'
import {createSdfShapesCircuit, pixelCenters, sdfShapesSource} from './sdf-shapes.ts'
import {emitInstanceWgsl, packSharedBuffer, probeCases, probeKindCode, wgslFloat} from './wgsl.ts'
import {createWgslInterpreter, parseWgslFloat} from './wgsl-interpreter.ts'
import {createWindowOwnershipCircuit} from './window-ownership.ts'

function parseLiteral(text: string) {
  const negative = text.startsWith('(-')
  const token = negative ? text.slice(2, -1) : text
  return negative ? -parseWgslFloat(token) : parseWgslFloat(token)
}

test('WGSL literals carry the exact float32 bits over every finite exponent, subnormals included', () => {
  const random = createRandom(99)
  const view = new DataView(new ArrayBuffer(4))
  const values = [0, -0, 0.1, 1 / 3, -0.5, 12_582_912, 3.4028234663852886e38, 1.401298464324817e-45, -1e-40, 2 ** -126, 0.4999999403953552].map(value => Math.fround(value))
  let subnormals = 0
  for (let index = 0; index < 20_000; index++) {
    // Random sign and fraction bits. One draw in ten is subnormal (exponent
    // bits 0); the rest spread over every finite exponent (bits 1..254).
    const exponentBits = random() < 0.1 ? 0 : 1 + Math.floor(random() * 254)
    const fractionBits = Math.floor(random() * 0x800000)
    const signBit = random() < 0.5 ? 0 : 0x80000000
    view.setUint32(0, (signBit | (exponentBits << 23) | fractionBits) >>> 0)
    if (exponentBits === 0 && fractionBits !== 0) subnormals++
    values.push(view.getFloat32(0))
  }
  let checked = 0
  for (const value of values) {
    if (!Object.is(parseLiteral(wgslFloat(value)), value)) throw new Error(`literal ${wgslFloat(value)} doesn't carry ${value}`)
    checked++
  }
  expect(checked).toBe(20_011)
  expect(subnormals).toBeGreaterThan(1_500)
})

// Interprets the emitted WGSL with and without the max guard and compares both
// with the CPU instance outputs.
function interpretAndCompare(plan: InstancePlan, sharedSource: Float32Array, instanceSources: Float32Array, count: number, skip?: (instance: number) => boolean) {
  const runner = compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize: 256})
  const cpu = new Float32Array(count * plan.outputs.length)
  runner.runShared(sharedSource)
  runner.runInstances(instanceSources, count, cpu)
  let compared = 0
  const modules = (['none', 'max'] as const).map(guard => {
    const module = emitInstanceWgsl(plan, {guard})
    const interpreted = new Float32Array(count * plan.outputs.length)
    createWgslInterpreter(module.code)(packSharedBuffer(module, runner), instanceSources, count, interpreted)
    for (let instance = 0; instance < count; instance++) {
      if (skip?.(instance)) continue
      for (let output = 0; output < plan.outputs.length; output++) {
        const left = interpreted[instance * plan.outputs.length + output]!
        const right = cpu[instance * plan.outputs.length + output]!
        if (!(left === right || sameFloat(left, right))) {
          throw new Error(`guard ${guard}, instance ${instance} output ${output}: interpreted WGSL ${left}, CPU ${right}`)
        }
        compared++
      }
    }
    return module
  })
  return {compared, module: modules[1]!}
}

test('the emitted WGSL, with and without the max guard, interpreted with strict f32 rounding, reproduces the CPU instance outputs on random circuits', () => {
  let compared = 0
  const cellSets = [[4, 5], [0, 1, 2, 3], [0, 1, 2, 3, 7, 9], [8, 11]]
  for (let seed = 1; seed <= 25; seed++) {
    const {circuit, sources, all} = buildRandomCircuit(seed)
    const program = circuit.compileTensorProgram()
    const instanceCells = cellSets[seed % cellSets.length]!
    const outputs = all.filter(wire => wire >= circuit.sourceSize)
    const plan = planInstances(program, instanceCells, outputs)
    const random = createRandom(seed * 31)
    const count = 9
    const instanceSources = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const other = randomSource(random, true)
      instanceCells.forEach((cell, column) => {
        instanceSources[instance * instanceCells.length + column] = other[cell]!
      })
    }
    const sharedSource = sources[0]!
    // WGSL leaves NaN and Infinity behavior open, so instances whose reference
    // evaluation isn't finite are skipped.
    const skip = (instance: number) => {
      const reference = circuit.evaluateReference(instanceSourceTable(plan, sharedSource, instanceSources, instance))
      return Array.from(program.wireOrder, wire => reference[wire]!).some(value => !Number.isFinite(value))
    }
    compared += interpretAndCompare(plan, sharedSource, instanceSources, count, skip).compared
  }
  expect(compared).toBeGreaterThan(3000)
})

test('the emitted WGSL for the four workloads, with and without the max guard, interpreted, reproduces the CPU outputs', () => {
  const machine = createIndirectOSMachine({evaluator: 'generated', validate: false})
  machine.step(1280, 800, 16)
  const ownership = createWindowOwnershipCircuit()
  const ownershipPlan = planInstances(ownership.circuit.compileTensorProgram(ownership.outputs), ownership.instanceSources, ownership.outputs)
  const pixels = new Float32Array(64 * 40 * 2)
  for (let pixel = 0; pixel < 64 * 40; pixel++) {
    pixels[pixel * 2] = (pixel % 64) * 20 + 0.5
    pixels[pixel * 2 + 1] = Math.floor(pixel / 64) * 20 + 0.5
  }
  const ownershipResult = interpretAndCompare(ownershipPlan, machine.source, pixels, 64 * 40)
  expect(ownershipResult.module.exposure.booleanRows).toBeGreaterThan(20)
  expect(ownershipResult.module.exposure.gatherReads).toBeGreaterThan(0)

  const calendar = createLifeCalendarCircuit()
  const calendarPlan = planInstances(calendar.circuit.compileTensorProgram([...calendar.outputs, ...Object.values(calendar.shared)]), calendar.instanceSources, calendar.outputs)
  const cells = Float32Array.from({length: 600}, (_, index) => index * 45)
  interpretAndCompare(calendarPlan, lifeCalendarSource(1440, 900, 700, 420, 11_503), cells, cells.length)

  const candidate = createCandidateGalleryMachine()
  const candidateOutputs = [...candidate.output.selectedLayout, ...candidate.output.scores, ...candidate.output.thumbnails, ...candidate.output.hero]
  candidate.source[candidateSourceField.viewportHeight] = 800
  const candidatePlan = planInstances(candidate.circuit.compileTensorProgram(candidateOutputs), [candidateSourceField.viewportWidth], candidateOutputs)
  const widths = Float32Array.from({length: 64}, (_, index) => 320 + index * 23)
  interpretAndCompare(candidatePlan, candidate.source, widths, widths.length)

  const scene = createSdfShapesCircuit()
  const scenePlan = planInstances(scene.circuit.compileTensorProgram([...scene.outputs, ...scene.hovers]), scene.instanceSources, scene.outputs)
  interpretAndCompare(scenePlan, sdfShapesSource(338, 150), pixelCenters(40, 30).map((value, index) => value * 14 + (index % 2) * 3), 40 * 30)
})

test('every probe case separates strict rounding from the optimized form', () => {
  const cases = probeCases()
  expect(cases.filter(probe => probe.kind === 'contraction').length).toBe(8 * 5)
  expect(new Set(cases.map(probeKindCode)).size).toBe(13)
  for (const probe of cases) expect(Object.is(probe.expected, probe.optimized)).toBe(false)
})

test('the max guard changes no strict result', () => {
  const scene = createSdfShapesCircuit()
  const plan = planInstances(scene.circuit.compileTensorProgram([...scene.outputs, ...scene.hovers]), scene.instanceSources, scene.outputs)
  const runner = compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize: 256})
  const pixels = pixelCenters(30, 20).map(value => value * 18)
  runner.runShared(sdfShapesSource(338, 150))
  const cpu = new Float32Array(600 * plan.outputs.length)
  runner.runInstances(pixels, 600, cpu)
  for (const guard of ['none', 'max'] as const) {
    const module = emitInstanceWgsl(plan, {guard})
    expect(module.exposure.inexactProducts).toBeGreaterThan(100)
    expect(module.exposure.guards).toBe(guard === 'max' ? module.exposure.inexactProducts + module.exposure.additions : 0)
    const interpreted = new Float32Array(cpu.length)
    createWgslInterpreter(module.code)(packSharedBuffer(module, runner), pixels, 600, interpreted)
    for (let index = 0; index < cpu.length; index++) expect(sameFloat(interpreted[index]!, cpu[index]!) || interpreted[index] === cpu[index]).toBe(true)
  }
})
