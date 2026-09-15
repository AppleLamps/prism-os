// Runs the staged gallery with its map stages on a real GPU, headlessly, at 221 photos and at
// 1,000 and 10,000 synthetic photos, and compares every stored value with the CPU executor every
// frame. Prints JSON; gpu-results-wgpu.json and gpu-results-dawn.json are saved outputs.
//
//   Deno (wgpu, naga → Metal):
//     deno run --unstable-webgpu --allow-all lab/ui-exploration/instanced-items/gpu-headless.ts
//   Node (Dawn, Tint → Metal), with the `webgpu` npm package installed anywhere:
//     DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/instanced-items/gpu-headless.ts
//
// Options through environment variables: GALLERY_COUNTS (default "221,1000,10000"), GALLERY_FRAMES
// (default 60), GALLERY_GUARD ("max" or "none", default "max").
import {createExecutor} from './executor.ts'
import {createStagedEngine, latchNames} from './gallery-engine.ts'
import {applySessionFrame, startSession} from './gallery-session.ts'
import {buildStagedGallery} from './gallery-staged.ts'
import {createGpuExecutor} from './gpu-executor.ts'
import {photoGalleryData} from '../gallery/photo-data.ts'
import {syntheticPhotos} from './synthetic-photos.ts'

type HostGlobals = {
  Deno?: {version?: {deno?: string}, env: {get(name: string): string | undefined}}
  process?: {env: Record<string, string | undefined>, version?: string, exit?: (code: number) => void}
}

const host = globalThis as unknown as HostGlobals
const environment = (name: string) => host.Deno?.env.get(name) ?? host.process?.env[name]

async function acquireGpu() {
  if (host.Deno !== undefined && 'gpu' in navigator) return {runtime: `Deno ${host.Deno.version?.deno ?? ''} (wgpu)`, gpu: navigator.gpu}
  const dawnPath = host.process?.env['DAWN_WEBGPU']
  if (dawnPath !== undefined) {
    const dawn = await import(dawnPath) as {create: (flags: string[]) => GPU, globals: Record<string, unknown>}
    Object.assign(globalThis, dawn.globals)
    return {runtime: `Node ${host.process?.version ?? ''} (Dawn)`, gpu: dawn.create([])}
  }
  throw new Error('No WebGPU here. Use Deno with --unstable-webgpu, or Node with DAWN_WEBGPU set to the webgpu package entry.')
}

const median = (values: readonly number[]) => values.length === 0 ? 0 : [...values].sort((left, right) => left - right)[values.length >> 1]!
const same = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right))

const {runtime, gpu} = await acquireGpu()
const adapter = await gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no GPU adapter')
const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
  },
})
// Dawn's Node bindings have crashed mid-run (exit 139), so results are also written after each count.
const {writeFileSync} = await import('node:fs')
const outputPath = environment('GALLERY_OUTPUT')
const counts = (environment('GALLERY_COUNTS') ?? '221,1000,10000').split(',').map(Number)
const frames = Number(environment('GALLERY_FRAMES') ?? '60')
const guard = environment('GALLERY_GUARD') === 'none' ? 'none' as const : 'max' as const
const results: unknown[] = []
for (const count of counts) {
  const photos = count === 221 ? photoGalleryData : syntheticPhotos(count)
  const staged = buildStagedGallery(photos, count === 221 ? {} : {coordinateLimit: 2 ** 24})
  const cpu = createExecutor(staged.program)
  const gpuExecutor = await createGpuExecutor(staged.program, device, {guard})
  const cpuEngine = createStagedEngine(staged, cpu)
  const gpuEngine = createStagedEngine(staged, gpuExecutor.executor)
  startSession(cpuEngine, photos)
  startSession(gpuEngine, photos)
  const consumed = [...staged.program.consumed].map(id => staged.program.handle(id))
  let compared = 0
  let mismatches = 0
  const firstMismatches: string[] = []
  const cpuMilliseconds: number[] = []
  const gpuMilliseconds: number[] = []
  for (let frame = 0; frame < frames; frame++) {
    applySessionFrame(cpuEngine, frame)
    applySessionFrame(gpuEngine, frame)
    let start = performance.now()
    cpu.step()
    cpuMilliseconds.push(performance.now() - start)
    start = performance.now()
    await gpuExecutor.executor.stepAsync()
    gpuMilliseconds.push(performance.now() - start)
    for (const value of consumed) {
      const instances = staged.program.count(value.axis)
      const cpuValues = value.axis === 'shared' ? null : cpu.column(value)
      const gpuValues = value.axis === 'shared' ? null : gpuExecutor.executor.column(value)
      for (let instance = 0; instance < instances; instance++) {
        const left = cpuValues === null ? cpu.get(value) : cpuValues[instance]!
        const right = gpuValues === null ? gpuExecutor.executor.get(value) : gpuValues[instance]!
        compared++
        if (!same(left, right)) {
          mismatches++
          if (firstMismatches.length < 5) firstMismatches.push(`frame ${frame} ${staged.program.values[value.id]!.name} instance ${instance}: cpu ${left}, gpu ${right}`)
        }
      }
    }
    for (const name of latchNames) {
      cpuEngine.setCell(name, 0)
      gpuEngine.setCell(name, 0)
    }
  }
  const warm = (values: number[]) => median(values.slice(Math.min(5, values.length - 1)))
  results.push({
    photos: count,
    guard,
    frames,
    comparedValues: compared,
    mismatches,
    firstMismatches,
    medianCpuExecutorMilliseconds: Number(warm(cpuMilliseconds).toFixed(3)),
    medianGpuPipelineMilliseconds: Number(warm(gpuMilliseconds).toFixed(3)),
    stages: gpuExecutor.timings.filter(timing => timing.instances === count).map(timing => ({
      name: timing.name,
      shaderStatements: timing.shaderStatements,
      guards: timing.guards,
      compileMilliseconds: Number(timing.compileMilliseconds.toFixed(1)),
      medianCpuAndPackMilliseconds: Number(warm(timing.cpuMilliseconds).toFixed(3)),
      medianUploadMilliseconds: Number(warm(timing.uploadMilliseconds).toFixed(3)),
      medianDispatchAndReadbackMilliseconds: Number(warm(timing.dispatchMilliseconds).toFixed(3)),
      medianUnpackMilliseconds: Number(warm(timing.unpackMilliseconds).toFixed(3)),
    })),
  })
  console.error(`${count} photos, guard ${guard}: ${mismatches} of ${compared} values differ; CPU ${warm(cpuMilliseconds).toFixed(2)} ms, GPU pipeline ${warm(gpuMilliseconds).toFixed(2)} ms`)
  // Deno 1.42 has no adapter.info.
  const info = (adapter as {info?: GPUAdapterInfo}).info
  if (outputPath !== undefined) writeFileSync(outputPath, `${JSON.stringify({runtime, adapter: info === undefined ? null : {vendor: info.vendor, architecture: info.architecture, description: info.description}, results}, null, 2)}\n`)
  gpuExecutor.destroy()
}
console.log(JSON.stringify({runtime, adapter: adapter.info, results}, null, 2))
device.destroy()
host.process?.exit?.(0)
