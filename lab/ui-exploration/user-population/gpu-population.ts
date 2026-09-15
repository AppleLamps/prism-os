// Runs the population's per-user program as a WGSL compute shader and compares
// every output with the CPU instance loop, frame by frame. The simulated users,
// the state writeback and the metrics stay on the CPU: each frame uploads the
// per-user table (state, behavior cells and events), dispatches, reads the
// outputs back, and compares them with the generated JS outputs for the same
// table. wgsl.ts and gpu-runner.ts are imported from codegen.
//
// Bun has no WebGPU. Run from the repo root under Node with Dawn (the `webgpu`
// npm package, installed in a scratch folder as codegen's README describes):
//   DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/user-population/gpu-population.ts [users per setting] [frames] [guards]
// or under Deno with wgpu:
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/user-population/gpu-population.ts [users per setting] [frames] [guards]
// where guards is e.g. max,none. Prints JSON, and progress to stderr.

import {testWindowsConfig as config, type BehaviorSetting} from './fixtures.ts'
import {compareOutputs, createGpuInstanceRunner} from '../codegen/gpu-runner.ts'
import {createPopulation, frameSchedule, liftedPopulationCircuit, populationFrameDelta} from './population.ts'
import {createUserModel} from './user-model.ts'
import {emitInstanceWgsl, packSharedBuffer, type Guard} from '../codegen/wgsl.ts'
import {buildWindowsCircuit} from './windows.ts'

type HostGlobals = {
  Deno?: {args: string[], version?: {deno?: string}, exit?: (code: number) => void}
  process?: {env: Record<string, string | undefined>, argv: string[], version?: string, exit?: (code: number) => void}
}

const host = globalThis as unknown as HostGlobals

async function acquireGpu(): Promise<{runtime: string, gpu: GPU}> {
  if (host.Deno !== undefined && 'gpu' in navigator) return {runtime: `Deno ${host.Deno.version?.deno ?? ''} (wgpu)`, gpu: navigator.gpu}
  const dawnPath = host.process?.env['DAWN_WEBGPU']
  if (dawnPath === undefined) throw new Error('No WebGPU here. Use Deno with --unstable-webgpu, or Node with DAWN_WEBGPU set to the webgpu package entry.')
  const dawn = await import(dawnPath) as {create: (flags: string[]) => GPU, globals: Record<string, unknown>}
  Object.assign(globalThis, dawn.globals)
  return {runtime: `Node ${host.process?.version ?? ''} (Dawn)`, gpu: dawn.create([])}
}

const {runtime, gpu} = await acquireGpu()
const adapter = await gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no GPU adapter')
const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
  },
})

const args = host.Deno?.args ?? host.process?.argv.slice(2) ?? []
const usersPerGroup = Number(args[0] ?? 64)
const frames = Number(args[1] ?? 300)
const guards = (args[2] ?? 'max,none').split(',') as Guard[]
const jankProbability = 0.02
const settings: BehaviorSetting[] = []
for (const slop of [2, 4, 6, 10]) {
  for (const doubleClickDistance of [2, 4, 8, 16]) {
    for (const doubleClickInterval of [300, 400, 500, 700]) settings.push({slop, doubleClickInterval, doubleClickDistance})
  }
}
const userCount = settings.length * usersPerGroup

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[values.length >> 1]!
}

const results: unknown[] = []
for (const guard of guards) {
  const build = buildWindowsCircuit(config, 16, {kind: 'folded', maximumDowns: 2, pressPoint: 'session'})
  const behaviorCells = [build.constants.slop, build.constants.doubleClickInterval, build.constants.doubleClickDistance]
  const population = createPopulation(liftedPopulationCircuit(build), {userCount, perUserCells: behaviorCells, frameDelta: populationFrameDelta})
  const groupOfUser = Uint32Array.from({length: userCount}, (_, user) => user % settings.length)
  for (let user = 0; user < userCount; user++) {
    const setting = settings[groupOfUser[user]!]!
    const base = user * population.width
    population.table[base + population.columnOf(build.constants.slop)] = setting.slop
    population.table[base + population.columnOf(build.constants.doubleClickInterval)] = setting.doubleClickInterval
    population.table[base + population.columnOf(build.constants.doubleClickDistance)] = setting.doubleClickDistance
  }
  const model = createUserModel(population, {groupCount: settings.length, groupOfUser, seed: 1})
  const module = emitInstanceWgsl(population.plan, {guard})
  const runner = await createGpuInstanceRunner(device, module, userCount)
  const gpuOutputs = new Float32Array(userCount * population.outputCount)
  const schedule = frameSchedule(frames, jankProbability, 1)
  let frameEnd = 0
  let currentFrameDelta = populationFrameDelta
  let mismatches = 0
  let mismatchedFrames = 0
  let maximumDifference = 0
  let firstMismatch: string | null = null
  const uploadMilliseconds: number[] = []
  const gpuMilliseconds: number[] = []
  const cpuMilliseconds: number[] = []
  for (let frame = 0; frame < frames; frame++) {
    const frameDelta = schedule[frame]!
    frameEnd += frameDelta
    if (frameDelta !== currentFrameDelta) {
      population.setFrameDelta(frameDelta)
      currentFrameDelta = frameDelta
    }
    model.emitFrame(frame, frameEnd)
    const upload = await runner.setInstanceSources(population.table, userCount)
    uploadMilliseconds.push(upload.milliseconds)
    const run = await runner.run(packSharedBuffer(module, population.runner), userCount, gpuOutputs)
    gpuMilliseconds.push(run.milliseconds)
    const cpuStart = performance.now()
    population.step()
    cpuMilliseconds.push(performance.now() - cpuStart)
    const comparison = compareOutputs(gpuOutputs, population.outputs, userCount * population.outputCount)
    if (comparison.mismatches > 0) {
      mismatchedFrames++
      mismatches += comparison.mismatches
      maximumDifference = Math.max(maximumDifference, comparison.maximumDifference)
      firstMismatch ??= `frame ${frame}, user ${Math.floor(comparison.firstMismatch / population.outputCount)}, output ${comparison.firstMismatch % population.outputCount}`
    }
    model.observeFrame(frame)
    if (frame % 100 === 99) console.error(`${guard} guard: ${frame + 1} frames, ${mismatches} mismatches so far`)
  }
  runner.destroy()
  const late = (values: number[]) => median(values.slice(Math.floor(values.length / 2)))
  results.push({
    guard,
    userCount,
    frames,
    outputsCompared: userCount * population.outputCount * frames,
    mismatches,
    mismatchedFrames,
    maximumDifference,
    firstMismatch,
    shaderStatements: module.statementCount,
    shaderBytes: module.code.length,
    exposure: module.exposure,
    shaderCompileMilliseconds: Number(runner.compileMilliseconds.toFixed(1)),
    perUserSourceBytesPerFrame: userCount * population.width * 4,
    medianUploadMillisecondsLaterFrames: Number(late(uploadMilliseconds).toFixed(2)),
    medianDispatchAndReadbackMillisecondsLaterFrames: Number(late(gpuMilliseconds).toFixed(2)),
    medianCpuInstanceLoopMillisecondsLaterFrames: Number(late(cpuMilliseconds).toFixed(2)),
  })
}
console.log(JSON.stringify({runtime, adapter: adapter.info, results}, null, 2))
device.destroy()
host.process?.exit?.(0)
host.Deno?.exit?.(0)
