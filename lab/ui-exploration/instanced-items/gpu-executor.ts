// The staged program with its map stages on the GPU: shared stages, each map stage's shared part,
// and every reduction stay on the CPU, and each map stage's per-instance part runs as one compute
// shader. Every map stage pays one round trip per evaluation: pack its per-instance inputs, upload,
// dispatch, read back, unpack. The timings keep those parts apart.
import {createExecutor, type MapStageContext} from './executor.ts'
import {createGpuInstanceRunner} from './gpu-runner.ts'
import type {StagedProgram} from './staged.ts'
import {emitInstanceWgsl, packSharedBuffer, type Guard} from './wgsl.ts'

export type GpuStageTiming = {
  name: string
  instances: number
  shaderStatements: number
  guards: number
  compileMilliseconds: number
  // Per evaluation: the CPU shared part and packing, the upload of per-instance inputs (waiting on
  // the queue), dispatch plus readback, and unpacking into columns.
  cpuMilliseconds: number[]
  uploadMilliseconds: number[]
  dispatchMilliseconds: number[]
  unpackMilliseconds: number[]
}

// By default a map stage goes to the GPU when its per-instance part has at least 8 rows. A stage
// like a row's gap (1 row) costs more in its round trip than its arithmetic.
export const defaultOnGpu = (context: MapStageContext) => context.plan.counts.instanceRows >= 8

export async function createGpuExecutor(program: StagedProgram, device: GPUDevice, options: {guard?: Guard, workgroupSize?: number, onGpu?: (context: MapStageContext) => boolean} = {}) {
  const guard = options.guard ?? 'max'
  const onGpu = options.onGpu ?? defaultOnGpu
  const pending: {context: MapStageContext, slot: {run: (() => Promise<void>) | null}}[] = []
  const executor = createExecutor(program, {
    mapStage: context => {
      if (!onGpu(context)) return null
      const slot: {run: (() => Promise<void>) | null} = {run: null}
      pending.push({context, slot})
      return () => slot.run!()
    },
  })
  const timings: GpuStageTiming[] = []
  const runners: {destroy: () => void}[] = []
  for (const {context, slot} of pending) {
    const module = emitInstanceWgsl(context.plan, {guard, workgroupSize: options.workgroupSize ?? 64})
    const runner = await createGpuInstanceRunner(device, module, context.count)
    runners.push(runner)
    const {count, inputColumns, outputColumns} = context
    const sourceWidth = inputColumns.length
    const outputWidth = outputColumns.length
    const instanceSources = new Float32Array(Math.max(1, count * sourceWidth))
    const outputs = new Float32Array(Math.max(1, count * outputWidth))
    const sharedBuffer = new Float32Array(module.sharedLength)
    const timing: GpuStageTiming = {
      name: context.stage.name, instances: count, shaderStatements: module.statementCount, guards: module.exposure.guards,
      compileMilliseconds: runner.compileMilliseconds, cpuMilliseconds: [], uploadMilliseconds: [], dispatchMilliseconds: [], unpackMilliseconds: [],
    }
    timings.push(timing)
    slot.run = async () => {
      const start = performance.now()
      context.fillSharedSources()
      context.cpu.runShared(context.sourceTable)
      packSharedBuffer(module, context.cpu, sharedBuffer)
      for (let column = 0; column < sourceWidth; column++) {
        const values = inputColumns[column]!
        for (let instance = 0; instance < count; instance++) instanceSources[instance * sourceWidth + column] = values[instance]!
      }
      const packed = performance.now()
      await runner.setInstanceSources(instanceSources, count)
      const uploaded = performance.now()
      await runner.run(sharedBuffer, count, outputs)
      const dispatched = performance.now()
      for (let output = 0; output < outputWidth; output++) {
        const values = outputColumns[output]!
        for (let instance = 0; instance < count; instance++) values[instance] = outputs[instance * outputWidth + output]!
      }
      const unpacked = performance.now()
      timing.cpuMilliseconds.push(packed - start)
      timing.uploadMilliseconds.push(uploaded - packed)
      timing.dispatchMilliseconds.push(dispatched - uploaded)
      timing.unpackMilliseconds.push(unpacked - dispatched)
    }
  }
  return {
    executor,
    timings,
    destroy() {
      for (const runner of runners) runner.destroy()
    },
  }
}
