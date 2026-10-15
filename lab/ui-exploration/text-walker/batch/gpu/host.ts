// The WebGPU host loop for batch/gpu's shaders: one compute pass that runs a shader from shaders.ts once per paragraph, like
// lab/ui-exploration/codegen/gpu-runner.ts, with an evaluation's time split into its parts: the upload, encoding and
// submitting, the wait for the readback, and the copy. Buffers:
//   params    the paragraph count of this evaluation
//   shared    shaders.ts's sharedValues, uploaded once, and a new width at maxWidthOffset with the shared-width plan
//   sources   count × instanceSourceCount float32 cells, from writeInstanceCells or cells.ts's createSharedWidthWriter
//   outputs   one line count per paragraph, as a float32 value, copied into a mappable buffer for readback
import {invariant} from '../../../../../src/runtime/numeric-ui-core.ts'
import type {BatchShader} from './shaders.ts'

// WebGPU's constants, with the values from the WebGPU specification, since TypeScript's DOM library declares the types and
// not these values.
const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, QUERY_RESOLVE: 0x0200} as const
const GPUMapMode = {READ: 0x0001} as const

// performance.now() times of one evaluation, in ms.
export type Evaluation = {
  // The writeBuffer calls, which return before the GPU has the data.
  uploadMs: number
  encodeAndSubmitMs: number
  // From submit to mapAsync resolving with readback, or to onSubmittedWorkDone resolving without.
  waitMs: number
  // Copying the mapped line counts into lineCounts, with readback.
  copyMs: number
  totalMs: number
  // The compute pass, from timestamp queries.
  passMs: number | undefined
}

export type EvaluateOptions = {
  count: number
  // New cells for the first `count` paragraphs, or undefined when the cells on the GPU stay.
  cells?: Float32Array | undefined
  // A new width for every paragraph, with the shared-width plan.
  width?: number | undefined
  readback: boolean
  timestamps: boolean
  // With compute false, only the upload: the same writeBuffer calls and an empty command buffer, where
  // onSubmittedWorkDone resolves once the GPU has the data.
  compute?: boolean
}

async function checked<Result>(device: GPUDevice, build: () => Promise<Result> | Result): Promise<Result> {
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  const result = await build()
  const outOfMemory = await device.popErrorScope()
  const validation = await device.popErrorScope()
  if (outOfMemory !== null) throw new Error(`WebGPU out of memory: ${outOfMemory.message}`)
  if (validation !== null) throw new Error(`WebGPU validation error: ${validation.message}`)
  return result
}

export async function createBatchRunner(device: GPUDevice, shader: BatchShader, capacity: number, salt: number) {
  invariant(Math.ceil(capacity / shader.workgroupSize) <= device.limits.maxComputeWorkgroupsPerDimension, 'too many paragraphs for one dispatch dimension')
  // `let salt` changes the source without changing the work, so a salt that no earlier run used compiles without hitting
  // a shader cache from an earlier run, e.g. Metal's.
  const marker = 'let i: u32 = id.x;'
  invariant(shader.code.includes(marker), 'unexpected shader text')
  const code = shader.code.replace(marker, `let salt: u32 = ${salt}u;\n_ = salt;\n${marker}`)
  // From createShaderModule to createComputePipelineAsync resolving, including reading the compilation messages.
  const compileStarted = performance.now()
  const pipeline = await checked(device, async () => {
    const module = device.createShaderModule({code})
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
    if (errors.length > 0) throw new Error(`WGSL errors: ${errors.slice(0, 5).map(message => `line ${message.lineNum}: ${message.message}`).join('; ')}`)
    return device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  })
  const compileMs = performance.now() - compileStarted
  const hasTimestamps = device.features.has('timestamp-query')
  const buffers: GPUBuffer[] = []
  const buffer = (descriptor: GPUBufferDescriptor) => {
    const created = device.createBuffer(descriptor)
    buffers.push(created)
    return created
  }
  const outputBytes = Math.max(4, capacity * shader.outputCount * 4)
  const {params, shared, sources, outputs, readbackBuffer, bindGroup, querySet, queryResolve, queryReadback} = await checked(device, () => {
    const sharedValues = Float32Array.from(shader.sharedValues)
    const created = {
      params: buffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}),
      shared: buffer({size: sharedValues.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true}),
      sources: buffer({size: Math.max(4, capacity * shader.instanceSourceCount * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}),
      outputs: buffer({size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}),
      readbackBuffer: buffer({size: outputBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
      querySet: hasTimestamps ? device.createQuerySet({type: 'timestamp', count: 2}) : undefined,
      queryResolve: buffer({size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC}),
      queryReadback: buffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
    }
    new Float32Array(created.shared.getMappedRange()).set(sharedValues)
    created.shared.unmap()
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: {buffer: created.params}},
        {binding: 1, resource: {buffer: created.shared}},
        {binding: 2, resource: {buffer: created.sources}},
        {binding: 3, resource: {buffer: created.outputs}},
      ],
    })
    return {...created, bindGroup}
  })
  const lineCounts = new Float32Array(capacity * shader.outputCount)
  const paramValues = new Uint32Array(4)
  const widthValue = new Float32Array(1)

  async function evaluate({count, cells, width, readback, timestamps, compute = true}: EvaluateOptions): Promise<Evaluation> {
    invariant(Number.isInteger(count) && count >= 1 && count <= capacity, 'the count must lie within the capacity')
    invariant(!timestamps || querySet !== undefined, 'this device has no timestamp queries')
    invariant(compute || (!readback && !timestamps), 'an upload without compute has nothing to read back')
    invariant(width === undefined || shader.maxWidthOffset >= 0, 'only the shared-width plan takes a width')
    const started = performance.now()
    if (cells !== undefined) {
      invariant(cells.length >= count * shader.instanceSourceCount, 'too few cells for the count')
      device.queue.writeBuffer(sources, 0, cells.buffer, cells.byteOffset, count * shader.instanceSourceCount * 4)
    }
    if (width !== undefined) {
      widthValue[0] = width
      device.queue.writeBuffer(shared, shader.maxWidthOffset * 4, widthValue.buffer, 0, 4)
    }
    paramValues[0] = count
    device.queue.writeBuffer(params, 0, paramValues.buffer, 0, 16)
    const uploaded = performance.now()
    const encoder = device.createCommandEncoder()
    if (compute) {
      const pass = encoder.beginComputePass(timestamps ? {timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(count / shader.workgroupSize))
      pass.end()
    }
    const bytes = count * shader.outputCount * 4
    if (readback) encoder.copyBufferToBuffer(outputs, 0, readbackBuffer, 0, bytes)
    if (timestamps) {
      encoder.resolveQuerySet(querySet!, 0, 2, queryResolve, 0)
      encoder.copyBufferToBuffer(queryResolve, 0, queryReadback, 0, 16)
    }
    device.queue.submit([encoder.finish()])
    const submitted = performance.now()
    if (readback) await readbackBuffer.mapAsync(GPUMapMode.READ, 0, bytes)
    else await device.queue.onSubmittedWorkDone()
    const mapped = performance.now()
    if (readback) {
      lineCounts.set(new Float32Array(readbackBuffer.getMappedRange(0, bytes)))
      readbackBuffer.unmap()
    }
    const finished = performance.now()
    let passMs: number | undefined
    if (timestamps) {
      await queryReadback.mapAsync(GPUMapMode.READ, 0, 16)
      const times = new BigUint64Array(queryReadback.getMappedRange(0, 16).slice(0))
      queryReadback.unmap()
      passMs = Number(times[1]! - times[0]!) / 1e6
    }
    return {uploadMs: uploaded - started, encodeAndSubmitMs: submitted - uploaded, waitMs: mapped - submitted, copyMs: finished - mapped, totalMs: finished - started, passMs}
  }

  return {
    compileMs,
    hasTimestamps,
    // The line counts of the last evaluation with readback, one per paragraph.
    lineCounts,
    evaluate,
    destroy() {
      for (const created of buffers) created.destroy()
      querySet?.destroy()
    },
  }
}
