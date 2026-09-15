// Runs every instance workload's emitted WGSL on a real GPU, headlessly, and
// compares the outputs with the CPU generated-JS outputs, with and without the
// max guard. Prints JSON; gpu-results-wgpu.json and gpu-results-dawn.json in
// this folder are saved outputs.
//
// Bun has no WebGPU. Two runtimes on this machine do:
//   Deno (wgpu, naga → Metal):
//     deno run --unstable-webgpu --allow-all lab/ui-exploration/codegen/gpu-headless.ts
//   Node (Dawn, Tint → Metal), with the `webgpu` npm package installed anywhere:
//     DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/codegen/gpu-headless.ts
import {compareOutputs, createGpuInstanceRunner, runGpuProbes} from './gpu-runner.ts'
import {compileInstanceProgram} from './instance.ts'
import {emitInstanceWgsl, packSharedBuffer} from './wgsl.ts'
import {buildAllWorkloads} from './workloads.ts'

type HostGlobals = {
  Deno?: {version?: {deno?: string}}
  process?: {env: Record<string, string | undefined>, version?: string, exit?: (code: number) => void}
}

async function acquireGpu() {
  const host = globalThis as unknown as HostGlobals
  if (host.Deno !== undefined && 'gpu' in navigator) return {runtime: `Deno ${host.Deno.version?.deno ?? ''} (wgpu)`, gpu: navigator.gpu}
  const dawnPath = host.process?.env['DAWN_WEBGPU']
  if (dawnPath !== undefined) {
    const dawn = await import(dawnPath) as {create: (flags: string[]) => GPU, globals: Record<string, unknown>}
    Object.assign(globalThis, dawn.globals)
    return {runtime: `Node ${host.process?.version ?? ''} (Dawn)`, gpu: dawn.create([])}
  }
  throw new Error('No WebGPU here. Use Deno with --unstable-webgpu, or Node with DAWN_WEBGPU set to the webgpu package entry.')
}

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[values.length >> 1]!
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
const probes = await runGpuProbes(device)
const probeSummary: Record<string, {strict: number, optimized: number, other: number}> = {}
for (const probe of probes) {
  const entry = probeSummary[`${probe.kind} / ${probe.form}`] ??= {strict: 0, optimized: 0, other: 0}
  if (probe.strict) entry.strict++
  else if (probe.optimizedMatch) entry.optimized++
  else entry.other++
}
const results: unknown[] = []
const workloads = buildAllWorkloads()
for (const guard of ['none', 'max'] as const) {
  for (const workload of workloads) {
    const {plan, count} = workload
    const module = emitInstanceWgsl(plan, {guard})
    const cpu = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 1024})
    const gpuRunner = await createGpuInstanceRunner(device, module, count)
    // Uploaded once, outside the timed runs below.
    const upload = await gpuRunner.setInstanceSources(workload.instanceSources, count)
    const outputCount = plan.outputs.length
    const cpuOutputs = new Float32Array(count * outputCount)
    const gpuOutputs = new Float32Array(count * outputCount)
    let mismatches = 0
    let compared = 0
    let maximumDifference = 0
    const cpuMilliseconds: number[] = []
    const gpuMilliseconds: number[] = []
    for (let sharedIndex = 0; sharedIndex < workload.sharedSources.length; sharedIndex++) {
      for (let repeat = 0; repeat < 5; repeat++) {
        const start = performance.now()
        cpu.runShared(workload.sharedSources[sharedIndex]!)
        cpu.runInstances(workload.instanceSources, count, cpuOutputs)
        cpuMilliseconds.push(performance.now() - start)
        const {milliseconds} = await gpuRunner.run(packSharedBuffer(module, cpu), count, gpuOutputs)
        gpuMilliseconds.push(milliseconds)
      }
      if (workload.skip === undefined) {
        // One pass over the whole table: per-instance subarrays for a million
        // pixels allocate enough garbage that Dawn's Node bindings crashed
        // (exit 139) in two full runs.
        const comparison = compareOutputs(gpuOutputs, cpuOutputs, count * outputCount)
        mismatches += comparison.mismatches
        compared += count * outputCount
        maximumDifference = Math.max(maximumDifference, comparison.maximumDifference)
      } else {
        for (let instance = 0; instance < count; instance++) {
          if (workload.skip(sharedIndex, instance)) continue
          const comparison = compareOutputs(gpuOutputs.subarray(instance * outputCount), cpuOutputs.subarray(instance * outputCount), outputCount)
          mismatches += comparison.mismatches
          compared += outputCount
          maximumDifference = Math.max(maximumDifference, comparison.maximumDifference)
        }
      }
    }
    gpuRunner.destroy()
    console.error(`${guard} guard, ${workload.name}: ${mismatches} of ${compared} outputs differ`)
    results.push({
      workload: workload.name,
      guard,
      instanceRows: plan.counts.instanceRows,
      sharedRows: plan.counts.sharedRows,
      shaderStatements: module.statementCount,
      shaderBytes: module.code.length,
      exposure: module.exposure,
      comparedOutputs: compared,
      mismatches,
      maximumDifference,
      shaderCompileMilliseconds: Number(gpuRunner.compileMilliseconds.toFixed(1)),
      instanceSourceBytes: count * plan.instanceSources.length * 4,
      instanceSourceUploadMilliseconds: Number(upload.milliseconds.toFixed(2)),
      medianCpuMilliseconds: Number(median(cpuMilliseconds).toFixed(2)),
      // Shared-value upload, dispatch and readback; per-instance sources excluded.
      medianGpuMilliseconds: Number(median(gpuMilliseconds).toFixed(2)),
    })
  }
}
console.log(JSON.stringify({runtime, adapter: adapter.info, probeSummary, results}, null, 2))
device.destroy()
;(globalThis as unknown as HostGlobals).process?.exit?.(0)
