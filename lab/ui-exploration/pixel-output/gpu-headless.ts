// Runs exported per-pixel shaders on a real GPU and writes the outputs next to them.
// It only reads files, so it runs under Deno and Node without pretext or the builder.
//
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/pixel-output/gpu-headless.ts <directory>
//   DAWN_WEBGPU=<path to webgpu/index.js> node lab/ui-exploration/pixel-output/gpu-headless.ts <directory>
//
// <directory> holds case folders written by `report.ts gpu-export`. For each case,
// guard and state it uploads the pixel centers once, then times 7 runs of: upload the
// shared values, dispatch, read back (median), and 7 runs without the readback,
// waiting on onSubmittedWorkDone instead. Outputs go to gpu-<runtime>-<guard>-<state>.f32.
//
// Compile times: the system keeps a shader cache across processes, so compiling the
// same shader text again takes a fraction of the first compile (for the count shaders,
// 0.4 to 0.6s instead of 12 to 37s in one check). Every shader gets a token unique to
// this run (a renamed local and one unused `let`), so compileMilliseconds is a cold
// compile, and warmCompileMilliseconds compiles the same text a second time.
import {readFileSync, readdirSync, writeFileSync, existsSync} from 'node:fs'
import {join} from 'node:path'
import {createGpuInstanceRunner, measurePipelineCompile} from './gpu-runner.ts'
import type {WgslModule} from './wgsl.ts'

const cacheToken = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`
const withCacheToken = (code: string) => code
  .replaceAll('source_base', `source_base_${cacheToken}`)
  .replace('let output_base', `let cache_token_${cacheToken}: u32 = i + 12345u;\nlet output_base`)

type HostGlobals = {
  Deno?: {version?: {deno?: string}, args: string[]}
  process?: {env: Record<string, string | undefined>, version?: string, argv: string[], exit?: (code: number) => void}
}

const host = globalThis as unknown as HostGlobals

async function acquireGpu() {
  if (host.Deno !== undefined && 'gpu' in navigator) return {runtime: `Deno ${host.Deno.version?.deno ?? ''} (wgpu)`, key: 'wgpu', gpu: navigator.gpu}
  const dawnPath = host.process?.env['DAWN_WEBGPU']
  if (dawnPath !== undefined) {
    const dawn = await import(dawnPath) as {create: (flags: string[]) => GPU, globals: Record<string, unknown>}
    Object.assign(globalThis, dawn.globals)
    return {runtime: `Node ${host.process?.version ?? ''} (Dawn)`, key: 'dawn', gpu: dawn.create([])}
  }
  throw new Error('No WebGPU here. Use Deno with --unstable-webgpu, or Node with DAWN_WEBGPU set to the webgpu package entry.')
}

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[values.length >> 1]!
}

const directory = host.Deno?.args[0] ?? host.process?.argv[2]
if (directory === undefined) throw new Error('usage: gpu-headless.ts <directory>')
const {runtime, key, gpu} = await acquireGpu()
const adapter = await gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no GPU adapter')
const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
  },
})
for (const caseName of readdirSync(directory)) {
  const caseDirectory = join(directory, caseName)
  if (!existsSync(join(caseDirectory, 'meta.json'))) continue
  const meta = JSON.parse(readFileSync(join(caseDirectory, 'meta.json'), 'utf8')) as {
    count: number, width: number, height: number, workgroupSize: number, sharedLength: number, instanceSourceCount: number, outputCount: number,
    states: string[], shaders: {guard: string, file: string, statements: number}[]
  }
  const centers = new Float32Array(meta.count * 2)
  for (let y = 0; y < meta.height; y++) {
    for (let x = 0; x < meta.width; x++) {
      centers[(y * meta.width + x) * 2] = x + 0.5
      centers[(y * meta.width + x) * 2 + 1] = y + 0.5
    }
  }
  const results: unknown[] = []
  for (const shader of meta.shaders) {
    const module = {
      code: withCacheToken(readFileSync(join(caseDirectory, shader.file), 'utf8')),
      workgroupSize: meta.workgroupSize,
      sharedLength: meta.sharedLength,
      instanceSourceCount: meta.instanceSourceCount,
      outputCount: meta.outputCount,
    } as WgslModule
    const runner = await createGpuInstanceRunner(device, module, meta.count)
    const warmCompileMilliseconds = await measurePipelineCompile(device, module.code)
    console.error(`${caseName}, ${shader.guard} guard: compile ${runner.compileMilliseconds.toFixed(1)} ms with a new token, ${warmCompileMilliseconds.toFixed(1)} ms for the same text again`)
    const upload = await runner.setInstanceSources(centers, meta.count)
    const outputs = new Float32Array(meta.count * meta.outputCount)
    for (const state of meta.states) {
      const bytes = readFileSync(join(caseDirectory, `shared-${state}.f32`))
      const shared = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      const times: number[] = []
      for (let repeat = 0; repeat < 7; repeat++) times.push((await runner.run(shared, meta.count, outputs)).milliseconds)
      const dispatchTimes: number[] = []
      for (let repeat = 0; repeat < 7; repeat++) dispatchTimes.push((await runner.dispatchOnly(shared, meta.count)).milliseconds)
      const file = `gpu-${key}-${shader.guard}-${state}.f32`
      writeFileSync(join(caseDirectory, file), new Uint8Array(outputs.buffer))
      results.push({guard: shader.guard, state, file, milliseconds: Number(median(times).toFixed(2)), dispatchOnlyMilliseconds: Number(median(dispatchTimes).toFixed(2))})
      console.error(`${caseName}, ${shader.guard} guard, ${state}: ${median(times).toFixed(1)} ms with readback, ${median(dispatchTimes).toFixed(1)} ms without`)
    }
    results.push({guard: shader.guard, compileMilliseconds: Number(runner.compileMilliseconds.toFixed(1)), warmCompileMilliseconds: Number(warmCompileMilliseconds.toFixed(1)), cacheToken, instanceSourceUploadMilliseconds: Number(upload.milliseconds.toFixed(2)), statements: shader.statements})
    runner.destroy()
  }
  writeFileSync(join(caseDirectory, `gpu-${key}.json`), JSON.stringify({runtime, key, adapter: adapter.info, results}, null, 2))
}
device.destroy()
host.process?.exit?.(0)
