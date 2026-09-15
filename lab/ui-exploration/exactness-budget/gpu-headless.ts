// Runs codegen's instance workloads on a real GPU with four guard placements, and
// compares GPU outputs with CPU generated JS, split into decision outputs (owners,
// regions, rows, columns, layout bits) and continuous outputs (positions, colors).
// Prints JSON; gpu-results-wgpu.json and gpu-results-dawn.json are saved outputs.
//
// Bun has no WebGPU. From the repo root:
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/exactness-budget/gpu-headless.ts
//   DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/exactness-budget/gpu-headless.ts
// WORKLOADS=ui or WORKLOADS=random runs only the UI workloads or only the random
// circuits. Each result prints as its own JSON line as soon as it's measured, so a
// crash in Dawn's Node bindings (exit 139, which codegen also hit) keeps the earlier lines.
import {createCandidateGalleryMachine} from '../../../candidate-gallery.ts'
import {createGpuInstanceRunner} from './copies/codegen/gpu-runner.ts'
import {compileInstanceProgram} from './copies/codegen/instance.ts'
import {lifeOutputField} from './copies/codegen/life-calendar.ts'
import {sdfOutputField} from './copies/codegen/sdf-shapes.ts'
import {packSharedBuffer} from './copies/codegen/wgsl.ts'
import {buildAllWorkloads, type Workload} from './copies/codegen/workloads.ts'
import {roundingPositions} from './rounding-positions.ts'
import {emitRoundingWgsl, roundingGuards} from './wgsl-rounding.ts'

type HostGlobals = {
  Deno?: {version?: {deno?: string}, env?: {get: (name: string) => string | undefined}}
  process?: {env: Record<string, string | undefined>, version?: string, exit?: (code: number) => void, argv?: string[]}
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

// 1 for output columns that hold decisions.
function decisionColumns(workload: Workload, cpuOutputs: readonly Float32Array[]): Uint8Array {
  const outputCount = workload.plan.outputs.length
  const columns = new Uint8Array(outputCount)
  if (workload.name.startsWith('IndirectOS ownership')) return columns.fill(1)
  if (workload.name.startsWith('life-calendar')) {
    columns.fill(1)
    columns[lifeOutputField.x] = 0
    columns[lifeOutputField.y] = 0
    return columns
  }
  if (workload.name.startsWith('SDF shapes')) {
    columns[sdfOutputField.owner] = 1
    return columns
  }
  if (workload.name.startsWith('candidate-gallery')) {
    const {output} = createCandidateGalleryMachine()
    // Outputs are selectedLayout, scores, thumbnails, hero, heroPresent.
    for (let index = 0; index < output.selectedLayout.length; index++) columns[index] = 1
    columns[outputCount - 1] = 1
    return columns
  }
  // Random circuits: columns whose CPU values are exactly 0 or 1 for every
  // instance. Integers aren't enough there: products of products pass 2^24, where
  // every FP32 value is an integer, so a huge continuous value would count as a decision.
  columns.fill(1)
  for (const outputs of cpuOutputs) {
    for (let index = 0; index < outputs.length; index++) {
      if (outputs[index] !== 0 && outputs[index] !== 1) columns[index % outputCount] = 0
    }
  }
  return columns
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
const host = globalThis as unknown as HostGlobals
const selection = host.Deno?.env?.get('WORKLOADS') ?? host.process?.env['WORKLOADS'] ?? 'all'
console.log(JSON.stringify({runtime, adapter: adapter.info ?? null}))
for (const workload of buildAllWorkloads()) {
  const isRandom = workload.name.startsWith('random circuit')
  if ((selection === 'ui' && isRandom) || (selection === 'random' && !isRandom)) continue
  const {plan, count} = workload
  // Instances to leave out, computed before any GPU work.
  const skipped = workload.sharedSources.map((_, sharedIndex) => Uint8Array.from({length: count}, (_, instance) => workload.skip?.(sharedIndex, instance) === true ? 1 : 0))
  const outputCount = plan.outputs.length
  const isRoundingPosition = roundingPositions(workload.circuit, workload.program)
  let roundingInstanceRows = 0
  for (const step of plan.instanceSteps) if (step.kind === 'row' && isRoundingPosition[step.row.position] === 1) roundingInstanceRows++
  const cpu = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 1024})
  const cpuOutputs = workload.sharedSources.map(shared => {
    const outputs = new Float32Array(count * outputCount)
    cpu.runShared(shared)
    cpu.runInstances(workload.instanceSources, count, outputs)
    return outputs
  })
  const decisions = decisionColumns(workload, cpuOutputs)
  const gpuOutputs = new Float32Array(count * outputCount)
  for (const guard of roundingGuards) {
    const module = emitRoundingWgsl(plan, guard, isRoundingPosition)
    const gpuRunner = await createGpuInstanceRunner(device, module, count)
    await gpuRunner.setInstanceSources(workload.instanceSources, count)
    let decisionOutputsCompared = 0
    let decisionMismatches = 0
    let continuousOutputsCompared = 0
    let continuousMismatches = 0
    let largestContinuousDifference = 0
    const milliseconds: number[] = []
    for (let sharedIndex = 0; sharedIndex < workload.sharedSources.length; sharedIndex++) {
      cpu.runShared(workload.sharedSources[sharedIndex]!)
      for (let repeat = 0; repeat < 3; repeat++) {
        const run = await gpuRunner.run(packSharedBuffer(module, cpu), count, gpuOutputs)
        milliseconds.push(run.milliseconds)
      }
      const expected = cpuOutputs[sharedIndex]!
      for (let instance = 0; instance < count; instance++) {
        if (skipped[sharedIndex]![instance] === 1) continue
        const base = instance * outputCount
        for (let column = 0; column < outputCount; column++) {
          const left = gpuOutputs[base + column]!
          const right = expected[base + column]!
          const same = left === right || (Number.isNaN(left) && Number.isNaN(right))
          if (decisions[column] === 1) {
            decisionOutputsCompared++
            if (!same) decisionMismatches++
          } else {
            continuousOutputsCompared++
            if (!same) {
              continuousMismatches++
              largestContinuousDifference = Math.max(largestContinuousDifference, Math.abs(left - right))
            }
          }
        }
      }
    }
    gpuRunner.destroy()
    console.error(`${guard}, ${workload.name}: decisions ${decisionMismatches} of ${decisionOutputsCompared}, continuous ${continuousMismatches} of ${continuousOutputsCompared} (largest ${largestContinuousDifference})`)
    console.log(JSON.stringify({
      workload: workload.name,
      guard,
      instanceRows: plan.counts.instanceRows,
      roundingInstanceRows,
      shaderStatements: module.statementCount,
      guards: module.exposure.guards,
      guardedRows: module.guardedRows,
      inputBarriers: module.inputBarriers,
      inexactProducts: module.exposure.inexactProducts,
      additions: module.exposure.additions,
      decisionOutputsCompared,
      decisionMismatches,
      continuousOutputsCompared,
      continuousMismatches,
      largestContinuousDifference,
      shaderCompileMilliseconds: Number(gpuRunner.compileMilliseconds.toFixed(1)),
      medianGpuMilliseconds: Number(median(milliseconds).toFixed(2)),
    }))
  }
}
device.destroy()
;(globalThis as unknown as HostGlobals).process?.exit?.(0)
