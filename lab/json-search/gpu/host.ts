// The WebGPU host for emit.ts's shaders: plain functions with no page globals, for the measurement page and for a demo
// page. One compute pass runs a shader once per document. Buffers:
//   documents   a store of count × cellsPerDocument float32 cells, uploaded once and read by every program's shader
//   shared      a program's source table and the guards' lowest value, see emit.ts's packSharedValues, uploaded once
//   params      the document count of this evaluation
//   outputs     one buffer per output group, e.g. 3 summary values per document and 512 display kinds per document.
//               They stay on the GPU, and an evaluation copies the ranges it reads back into mappable buffers, e.g. the
//               summary of every document and the kinds of the 64 documents on screen.
//
//   const {device} = await requestBatchDevice(documentCount * cellsPerDocument * 4)
//   const store = createDocumentStore(device, cellsPerDocument, documentCount)
//   store.write(cells, documentCount)
//   const runner = await createProgramRunner(device, shader, program.packShared(shader), store)
//   const {outputs} = await runner.evaluate({count: documentCount, readbacks: [{group: 0, firstDocument: 0, documentCount}]})
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {countMismatches, expectedOutputs} from '../check.ts'
import type {WgslModule} from '../emit.ts'
import type {BatchProgram} from '../program.ts'

// WebGPU's constants, with the values from the WebGPU specification, since TypeScript's DOM library declares the types and
// not these values.
const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, QUERY_RESOLVE: 0x0200} as const
const GPUMapMode = {READ: 0x0001} as const
// What every WebGPU device grants for one storage buffer binding without being asked: 128 MiB, e.g. 65,408 documents
// of 513 cells.
const defaultStorageBindingBytes = 134_217_728

// A device whose storage buffers hold `largestBufferBytes`, or as much of it as the adapter allows. A device only gets
// more than WebGPU's default of 128 MiB per binding when the page asks, and this asks for no more than it needs.
// `largestBufferBytes` on the result is what one buffer may hold, e.g. to size the batch from.
export async function requestBatchDevice(largestBufferBytes: number) {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})
  if (adapter === null) throw new Error('this browser has no WebGPU adapter')
  const adapterLimit = Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize)
  // A buffer's size is a multiple of 4 bytes.
  const granted = Math.min(adapterLimit, Math.max(defaultStorageBindingBytes, Math.ceil(largestBufferBytes / 4) * 4))
  const hasTimestamps = adapter.features.has('timestamp-query')
  const device = await adapter.requestDevice({
    requiredFeatures: hasTimestamps ? ['timestamp-query'] : [],
    // WebGPU's default for maxBufferSize is 256 MiB.
    requiredLimits: {maxStorageBufferBindingSize: granted, maxBufferSize: Math.min(adapter.limits.maxBufferSize, Math.max(granted, 268_435_456))},
  })
  return {
    device, hasTimestamps, largestBufferBytes: granted,
    adapterInfo: {vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description},
    adapterLimits: {maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension},
  }
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

export type DocumentStore = {
  buffer: GPUBuffer
  capacity: number
  cellsPerDocument: number
  // Uploads the cells of `documentCount` documents, to the documents from `firstDocument` on. The call returns before
  // the GPU has the data, and the next evaluation waits for it.
  write: (cells: Float32Array, documentCount: number, firstDocument?: number) => void
  destroy: () => void
}

export async function createDocumentStore(device: GPUDevice, cellsPerDocument: number, capacity: number): Promise<DocumentStore> {
  const bytes = capacity * cellsPerDocument * 4
  invariant(bytes <= device.limits.maxStorageBufferBindingSize, `${capacity} documents need a buffer of ${bytes} bytes, and this device binds ${device.limits.maxStorageBufferBindingSize}`)
  const buffer = await checked(device, () => device.createBuffer({size: Math.max(4, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}))
  return {
    buffer, capacity, cellsPerDocument,
    write(cells, documentCount, firstDocument = 0) {
      invariant(firstDocument + documentCount <= capacity && cells.length >= documentCount * cellsPerDocument, 'the documents fit the store, and the cells hold them')
      device.queue.writeBuffer(buffer, firstDocument * cellsPerDocument * 4, cells.buffer, cells.byteOffset, documentCount * cellsPerDocument * 4)
    },
    destroy: () => buffer.destroy(),
  }
}

// The documents of one output group to copy out of the GPU.
export type Readback = {group: number, firstDocument: number, documentCount: number}

// performance.now() times of one evaluation, in ms.
export type Evaluation = {
  // The writeBuffer calls, which return before the GPU has the data.
  uploadMs: number
  encodeAndSubmitMs: number
  // From submit to every mapAsync resolving, or to onSubmittedWorkDone resolving without a readback.
  waitMs: number
  // Copying the mapped values into `outputs`.
  copyMs: number
  totalMs: number
  // The compute pass, from timestamp queries.
  passMs: number | undefined
  // One array per readback, in the readbacks' order, which the next evaluation that reads the same group overwrites.
  outputs: Float32Array[]
}

export type EvaluateOptions = {
  // Evaluates documents 0 to count - 1.
  count: number
  // At most one readback per group.
  readbacks: readonly Readback[]
  // New cells for the first `count` documents, uploaded before the pass.
  cells?: Float32Array
  timestamps?: boolean
}

export type ProgramRunner = Awaited<ReturnType<typeof createProgramRunner>>

// Compiles one shader and creates its buffers over a store's documents. A `salt` goes into the shader's source without
// changing its work, so a salt that no earlier run used compiles without hitting a shader cache, e.g. Metal's.
export async function createProgramRunner(device: GPUDevice, shader: WgslModule, sharedValues: Float32Array, store: DocumentStore, salt?: number) {
  invariant(shader.cellsPerInstance === store.cellsPerDocument, 'the shader reads the store\'s cells per document')
  invariant(sharedValues.length === shader.sharedLength, 'the shared values have the shader\'s length, see packSharedValues')
  const {capacity} = store
  invariant(Math.ceil(capacity / shader.workgroupSize) <= device.limits.maxComputeWorkgroupsPerDimension, 'too many documents for one dispatch dimension')
  let code = shader.code
  if (salt !== undefined) {
    const marker = 'let i: u32 = id.x;'
    invariant(code.includes(marker), 'unexpected shader text')
    code = code.replace(marker, `let salt: u32 = ${salt}u;\n_ = salt;\n${marker}`)
  }
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
  const {params, shared, outputBuffers, bindGroup, querySet, queryResolve, queryReadback} = await checked(device, () => {
    const created = {
      params: buffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}),
      shared: buffer({size: sharedValues.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true}),
      outputBuffers: shader.outputCounts.map(outputCount => buffer({size: Math.max(4, capacity * outputCount * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})),
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
        {binding: 2, resource: {buffer: store.buffer}},
        ...created.outputBuffers.map((outputBuffer, group) => ({binding: 3 + group, resource: {buffer: outputBuffer}})),
      ],
    })
    return {...created, bindGroup}
  })
  // Per group, a mappable buffer and a JavaScript array, both made on the first readback and made again when a later
  // readback is larger, e.g. 131 KB for the kinds of 64 documents and 205 MB for the kinds of 100,000.
  const readbackBuffers: (GPUBuffer | undefined)[] = shader.outputCounts.map(() => undefined)
  const readbackArrays: (Float32Array | undefined)[] = shader.outputCounts.map(() => undefined)
  const paramValues = new Uint32Array(4)

  async function evaluate({count, readbacks, cells, timestamps = false}: EvaluateOptions): Promise<Evaluation> {
    invariant(Number.isInteger(count) && count >= 1 && count <= capacity, 'the count lies within the store\'s capacity')
    invariant(!timestamps || querySet !== undefined, 'this device has no timestamp queries')
    invariant(new Set(readbacks.map(readback => readback.group)).size === readbacks.length, 'a group is read back once per evaluation')
    const ranges = readbacks.map(({group, firstDocument, documentCount}) => {
      const outputCount = shader.outputCounts[group]
      invariant(outputCount !== undefined && firstDocument >= 0 && documentCount >= 1 && firstDocument + documentCount <= capacity, 'a readback lies within its group')
      const bytes = documentCount * outputCount * 4
      let target = readbackBuffers[group]
      if (target === undefined || target.size < bytes) {
        target?.destroy()
        target = readbackBuffers[group] = device.createBuffer({size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
        readbackArrays[group] = new Float32Array(bytes / 4)
      }
      return {group, offset: firstDocument * outputCount * 4, bytes, target, array: readbackArrays[group]!}
    })
    const started = performance.now()
    if (cells !== undefined) store.write(cells, count)
    paramValues[0] = count
    device.queue.writeBuffer(params, 0, paramValues.buffer, 0, 16)
    const uploaded = performance.now()
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass(timestamps ? {timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(count / shader.workgroupSize))
    pass.end()
    for (const range of ranges) encoder.copyBufferToBuffer(outputBuffers[range.group]!, range.offset, range.target, 0, range.bytes)
    if (timestamps) {
      encoder.resolveQuerySet(querySet!, 0, 2, queryResolve, 0)
      encoder.copyBufferToBuffer(queryResolve, 0, queryReadback, 0, 16)
    }
    device.queue.submit([encoder.finish()])
    const submitted = performance.now()
    if (ranges.length === 0) await device.queue.onSubmittedWorkDone()
    else await Promise.all(ranges.map(range => range.target.mapAsync(GPUMapMode.READ, 0, range.bytes)))
    const mapped = performance.now()
    const outputs = ranges.map(range => {
      const values = range.array.subarray(0, range.bytes / 4)
      values.set(new Float32Array(range.target.getMappedRange(0, range.bytes)))
      range.target.unmap()
      return values
    })
    const finished = performance.now()
    let passMs: number | undefined
    if (timestamps) {
      await queryReadback.mapAsync(GPUMapMode.READ, 0, 16)
      const times = new BigUint64Array(queryReadback.getMappedRange(0, 16).slice(0))
      queryReadback.unmap()
      passMs = Number(times[1]! - times[0]!) / 1e6
    }
    return {uploadMs: uploaded - started, encodeAndSubmitMs: submitted - uploaded, waitMs: mapped - submitted, copyMs: finished - mapped, totalMs: finished - started, passMs, outputs}
  }

  return {
    compileMs,
    hasTimestamps,
    capacity,
    outputCounts: shader.outputCounts,
    evaluate,
    // New shared values from `offset` on, e.g. another pattern's cells in a search program.
    writeShared(values: Float32Array, offset = 0) {
      invariant(offset + values.length <= shader.sharedLength, 'the values lie within the shared buffer')
      device.queue.writeBuffer(shared, offset * 4, values.buffer, values.byteOffset, values.byteLength)
    },
    destroy() {
      for (const created of buffers) created.destroy()
      for (const created of readbackBuffers) created?.destroy()
      querySet?.destroy()
    },
  }
}

// Whether this GPU gives the CPU executor's values: evaluates the first `count` documents on both, and compares every
// output of every group. `cells` holds those documents' cells, which the store must already hold. A page runs it once
// after compiling, e.g. over 500 documents, about 40 ms of executor time, and falls back to the CPU when
// `mismatches` isn't 0.
export async function selfCheck(runner: ProgramRunner, program: BatchProgram, cells: Float32Array, count: number) {
  const cpuStarted = performance.now()
  const expected = expectedOutputs(program, cells, count)
  const cpuMs = performance.now() - cpuStarted
  const {outputs, totalMs} = await runner.evaluate({count, readbacks: program.outputCounts.map((_, group) => ({group, firstDocument: 0, documentCount: count}))})
  let values = 0
  let mismatches = 0
  outputs.forEach((group, groupIndex) => {
    values += group.length
    mismatches += countMismatches(group, expected[groupIndex]!, group.length)
  })
  return {documents: count, values, mismatches, cpuMs, gpuMs: totalMs}
}
