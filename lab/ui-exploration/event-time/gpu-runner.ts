// Runs an emitted instance shader on any WebGPU device: a browser's
// navigator.gpu, Deno's (wgpu), or Dawn's Node bindings. The shared values and
// the per-instance sources are storage buffers; outputs come back through a
// mapped readback buffer.
import {invariant} from '../../../numeric-ui-core.ts'
import {type ProbeCase, type WgslModule, probeCases, probeInputs, probeKindCode, probeShader} from './wgsl.ts'

// The spec's flag values; not every runtime defines the global namespaces.
const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080} as const
const GPUMapMode = {READ: 0x0001} as const

async function withValidation<T>(device: GPUDevice, build: () => T): Promise<T> {
  device.pushErrorScope('validation')
  const result = build()
  const error = await device.popErrorScope()
  if (error !== null) throw new Error(`WebGPU validation error: ${error.message}`)
  return result
}

function byteLength(values: number) {
  return Math.max(4, Math.ceil(values * 4 / 4) * 4)
}

export type GpuInstanceRunner = {
  compileMilliseconds: number
  // Upload the per-instance sources once, and wait until the queue has done
  // the work (writeBuffer, an empty submit, onSubmittedWorkDone).
  setInstanceSources: (instanceSources: Float32Array, count: number) => Promise<{milliseconds: number}>
  // Upload the shared values, dispatch, read outputs back into target. The
  // per-instance sources were uploaded before, by setInstanceSources.
  run: (sharedValues: Float32Array, count: number, target: Float32Array) => Promise<{milliseconds: number}>
  destroy: () => void
}

export async function createGpuInstanceRunner(device: GPUDevice, module: WgslModule, capacity: number): Promise<GpuInstanceRunner> {
  invariant(Math.ceil(capacity / module.workgroupSize) <= 65_535, 'too many instances for one dispatch dimension')
  const compileStart = performance.now()
  const pipeline = await withValidation(device, () => device.createComputePipeline({
    layout: 'auto',
    compute: {module: device.createShaderModule({code: module.code}), entryPoint: 'main'},
  }))
  const compileMilliseconds = performance.now() - compileStart
  const params = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
  const shared = device.createBuffer({size: byteLength(module.sharedLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
  const sources = device.createBuffer({size: byteLength(capacity * module.instanceSourceCount), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
  const outputs = device.createBuffer({size: byteLength(capacity * module.outputCount), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})
  const readback = device.createBuffer({size: byteLength(capacity * module.outputCount), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
  const bindGroup = await withValidation(device, () => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: params}},
      {binding: 1, resource: {buffer: shared}},
      {binding: 2, resource: {buffer: sources}},
      {binding: 3, resource: {buffer: outputs}},
    ],
  }))
  const paramValues = new Uint32Array(4)
  return {
    compileMilliseconds,
    async setInstanceSources(instanceSources, count) {
      invariant(count <= capacity, 'instance count exceeds capacity')
      const start = performance.now()
      // A subarray instead of (dataOffset, size): Deno 1.42 reads those two
      // arguments differently from the spec's element counts.
      device.queue.writeBuffer(sources, 0, instanceSources.subarray(0, count * module.instanceSourceCount))
      device.queue.submit([])
      await device.queue.onSubmittedWorkDone()
      return {milliseconds: performance.now() - start}
    },
    async run(sharedValues, count, target) {
      invariant(count <= capacity, 'instance count exceeds capacity')
      invariant(sharedValues.length === module.sharedLength, 'shared buffer has the wrong length')
      const start = performance.now()
      paramValues[0] = count
      device.queue.writeBuffer(params, 0, paramValues)
      device.queue.writeBuffer(shared, 0, sharedValues)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(count / module.workgroupSize))
      pass.end()
      const bytes = count * module.outputCount * 4
      encoder.copyBufferToBuffer(outputs, 0, readback, 0, bytes)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ, 0, bytes)
      target.set(new Float32Array(readback.getMappedRange(0, bytes)))
      readback.unmap()
      return {milliseconds: performance.now() - start}
    },
    destroy() {
      for (const buffer of [params, shared, sources, outputs, readback]) buffer.destroy()
    },
  }
}

export type ProbeResult = ProbeCase & {gpu: number, strict: boolean, optimizedMatch: boolean}

export async function runGpuProbes(device: GPUDevice): Promise<ProbeResult[]> {
  const cases = probeCases()
  const pipeline = await withValidation(device, () => device.createComputePipeline({
    layout: 'auto',
    compute: {module: device.createShaderModule({code: probeShader}), entryPoint: 'main'},
  }))
  const inputs = probeInputs(cases)
  const kinds = Uint32Array.from(cases, probe => probeKindCode(probe))
  const inputBuffer = device.createBuffer({size: inputs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
  const kindBuffer = device.createBuffer({size: kinds.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
  const outputBuffer = device.createBuffer({size: cases.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})
  const readback = device.createBuffer({size: cases.length * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
  device.queue.writeBuffer(inputBuffer, 0, inputs)
  device.queue.writeBuffer(kindBuffer, 0, kinds)
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: inputBuffer}},
      {binding: 1, resource: {buffer: kindBuffer}},
      {binding: 2, resource: {buffer: outputBuffer}},
    ],
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(cases.length)
  pass.end()
  encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, cases.length * 4)
  device.queue.submit([encoder.finish()])
  await readback.mapAsync(GPUMapMode.READ)
  const results = new Float32Array(readback.getMappedRange().slice(0))
  readback.unmap()
  for (const buffer of [inputBuffer, kindBuffer, outputBuffer, readback]) buffer.destroy()
  return cases.map((probe, index) => ({
    ...probe,
    gpu: results[index]!,
    strict: Object.is(results[index], probe.expected),
    optimizedMatch: Object.is(results[index], probe.optimized),
  }))
}

// Compare GPU outputs with CPU outputs: zeros of either sign count as equal,
// since signed zeros never change a nonzero result of these atoms.
export function compareOutputs(gpu: Float32Array, cpu: Float32Array, count: number) {
  let mismatches = 0
  let maximumDifference = 0
  let firstMismatch = -1
  for (let index = 0; index < count; index++) {
    const left = gpu[index]!
    const right = cpu[index]!
    if (left === right || (Number.isNaN(left) && Number.isNaN(right))) continue
    mismatches++
    if (firstMismatch < 0) firstMismatch = index
    maximumDifference = Math.max(maximumDifference, Math.abs(left - right))
  }
  return {mismatches, maximumDifference, firstMismatch}
}
