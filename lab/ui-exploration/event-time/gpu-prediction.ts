// Runs the per-sample part of a HandwiredOS prediction on a GPU, headlessly:
// 301 instances, instance i holding M^i in the 4 source-matrix cells, compared
// bit for bit with the generated instance loop on the CPU, from committed
// tables taken along the live resize trace while something animates. Prints
// JSON; gpu-results-wgpu.json and gpu-results-dawn.json are saved outputs.
//
// Bun has no WebGPU. Run from the repo root with either:
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/event-time/gpu-prediction.ts
//   DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/event-time/gpu-prediction.ts
import {replayCommitPerEvent} from './commits.ts'
import {createEventTimeMachine} from './event-machine.ts'
import {compareOutputs, createGpuInstanceRunner} from '../codegen/gpu-runner.ts'
import {createPredictor, sampleCount} from './prediction.ts'
import {createHandwiredOSTrace, offsetPresses, randomPressOffsets} from './trace.ts'
import {emitInstanceWgsl, packSharedBuffer} from '../codegen/wgsl.ts'

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
const device = await adapter.requestDevice()

const trace = createHandwiredOSTrace({liveResize: true})
const events = offsetPresses(trace.events, randomPressOffsets(7, 30))
const durationMs = trace.durationMs + 2000
const results: unknown[] = []
for (const photosInputs of ['current-frame', 'previous-frame', 'stepped-springs'] as const) {
  const machine = createEventTimeMachine({springs: 'source-matrix', photosInputs, evaluator: 'generated'})
  const predictor = createPredictor(machine)
  const tables: Float32Array[] = []
  let runningEventCommits = 0
  replayCommitPerEvent(machine, events, [], {
    settle: 'predicted',
    durationMs,
    recordTables: false,
    recordDisplays: false,
    afterCommit(kind) {
      // Every 4th event commit that leaves the clock running, up to 16 tables.
      if (kind !== 'event' || !machine.running()) return
      if (runningEventCommits++ % 4 === 0 && tables.length < 16) tables.push(Float32Array.from(machine.table))
    },
  })
  const powers = predictor.powers()
  const outputCount = predictor.plan.outputs.length
  for (const guard of ['max', 'none'] as const) {
    const module = emitInstanceWgsl(predictor.plan, {guard})
    const gpuRunner = await createGpuInstanceRunner(device, module, sampleCount)
    const upload = await gpuRunner.setInstanceSources(powers, sampleCount)
    const cpuOutputs = new Float32Array(sampleCount * outputCount)
    const gpuOutputs = new Float32Array(sampleCount * outputCount)
    let mismatches = 0
    let maximumDifference = 0
    let decisionMismatches = 0
    const cpuMilliseconds: number[] = []
    const gpuMilliseconds: number[] = []
    for (const table of tables) {
      for (let repeat = 0; repeat < 8; repeat++) {
        const start = performance.now()
        predictor.runner.runShared(table)
        predictor.runner.runInstances(powers, sampleCount, cpuOutputs)
        cpuMilliseconds.push(performance.now() - start)
        const {milliseconds} = await gpuRunner.run(packSharedBuffer(module, predictor.runner), sampleCount, gpuOutputs)
        gpuMilliseconds.push(milliseconds)
      }
      const comparison = compareOutputs(gpuOutputs, cpuOutputs, sampleCount * outputCount)
      mismatches += comparison.mismatches
      maximumDifference = Math.max(maximumDifference, comparison.maximumDifference)
      // The animation bit of every sample.
      for (let sample = 0; sample < sampleCount; sample++) {
        const offset = sample * outputCount + predictor.activeColumn
        if (gpuOutputs[offset] !== cpuOutputs[offset]) decisionMismatches++
      }
    }
    gpuRunner.destroy()
    console.error(`${photosInputs}, ${guard} guard: ${mismatches} of ${tables.length * sampleCount * outputCount} outputs differ`)
    results.push({
      photosInputs,
      guard,
      tables: tables.length,
      instanceRows: predictor.plan.counts.instanceRows,
      instanceLayers: predictor.plan.counts.instanceLayers,
      sharedRows: predictor.plan.counts.sharedRows,
      shaderStatements: module.statementCount,
      guards: module.exposure.guards,
      comparedOutputs: tables.length * sampleCount * outputCount,
      mismatches,
      maximumDifference,
      animationBitMismatches: decisionMismatches,
      shaderCompileMilliseconds: Number(gpuRunner.compileMilliseconds.toFixed(1)),
      instanceSourceUploadMilliseconds: Number(upload.milliseconds.toFixed(2)),
      medianCpuMilliseconds: Number(median(cpuMilliseconds).toFixed(3)),
      // Shared-value upload, dispatch and readback of all 301 samples.
      medianGpuMilliseconds: Number(median(gpuMilliseconds).toFixed(3)),
    })
  }
}
console.log(JSON.stringify({runtime, adapter: adapter.info, sampleCount, results}, null, 2))
device.destroy()
;(globalThis as unknown as HostGlobals).process?.exit?.(0)
