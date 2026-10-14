// The WebGPU host for emit.ts's and loop-emit.ts's shaders: plain functions with no page globals, for the measurement
// pages and for a demo page. One compute pass runs a shader once per document. Buffers:
//   documents   a store of count × cellsPerDocument float32 cells, uploaded once and read by every program's shader
//   shared      a program's source table, uploaded once, or again when it changes, e.g. a new pattern's cells
//   params      the document count of this evaluation, and for a loop shader the window of documents that get per
//               position outputs
//   inputs      for a loop shader, other per-document buffers, e.g. the display kinds that another runner computed
//   outputs     one buffer per output group, e.g. 3 summary values per document and 512 display kinds per document.
//               They stay on the GPU, and an evaluation copies the ranges it reads back into mappable buffers, e.g. the
//               summary of every document and the kinds of the 64 documents on screen.
//   packed      for a shader of bit-emit.ts, words of bits that the runner packs from the shared values with the
//               shader's plan, each time the shared values change, e.g. 272 words for regex search at 8 states
//
//   const {device} = await requestBatchDevice(documentCount * cellsPerDocument * 4)
//   const store = createDocumentStore(device, cellsPerDocument, documentCount)
//   store.write(cells, documentCount)
//   const runner = await createProgramRunner(device, shader, program.packShared(shader), store)
//   const {outputs} = await runner.evaluate({count: documentCount, readbacks: [{group: 0, firstDocument: 0, documentCount}]})
import {invariant} from '../../runtime/numeric-ui-core.ts'
import {packWords} from '../bit-emit.ts'
import {countMismatches, expectedOutputs} from '../check.ts'
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

// Runs `build` inside two error scopes, and throws what the GPU reports into them. A device has one stack of scopes,
// and two calls can overlap, e.g. the three search runners that searcher.ts creates at the same time: the scopes that
// one call pops may then be the ones that another call pushed. So both scopes are pushed in one step and both are
// popped in one step, without an await in between. The stack then holds whole pairs at every await, each pop takes
// the scope of the kind that its message names, and every error is thrown by one of the overlapping calls, though
// maybe not by the one whose `build` caused it. With an await between the two pops, a call could pop another call's
// validation scope where it expects its own out-of-memory scope, and name a validation error "out of memory".
async function checked<Result>(device: GPUDevice, build: () => Promise<Result> | Result): Promise<Result> {
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  const popBoth = () => Promise.all([device.popErrorScope(), device.popErrorScope()])
  let result: Result
  try {
    result = await build()
  } catch (error) {
    // What `build` throws says more than a scope would, e.g. a WGSL error's line. The pair still comes off the stack.
    void popBoth().catch(() => {})
    throw error
  }
  const [outOfMemory, validation] = await popBoth()
  if (outOfMemory !== null) throw new Error(`WebGPU out of memory: ${outOfMemory.message}`)
  if (validation !== null) throw new Error(`WebGPU validation error: ${validation.message}`)
  return result
}

/** @public */
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
/** @public */
export type Readback = {group: number, firstDocument: number, documentCount: number}

// performance.now() times of one evaluation, in ms.
/** @public */
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

type EvaluateOptions = {
  // Evaluates `count` documents, from firstDocument on, which is 0 unless given. Only a loop shader reads firstDocument.
  count: number
  firstDocument?: number
  // At most one readback per group. A windowed group's rows are the window's documents, so its readback starts at 0.
  readbacks: readonly Readback[]
  // New cells for the first `count` documents, uploaded before the pass.
  cells?: Float32Array
  // New shared values, uploaded before the pass, e.g. the cells of the pattern to search for.
  shared?: Float32Array
  // For a loop shader: the documents that get per position outputs, e.g. the ones on screen.
  window?: {firstDocument: number, documentCount: number}
  timestamps?: boolean
}

// What a runner needs from a shader: emit.ts's WgslModule, loop-emit.ts's LoopWgslModule and bit-emit.ts's
// BitLoopWgslModule all have it.
/** @public */
export type RunnableShader = {
  code: string
  workgroupSize: number
  sharedLength: number
  cellsPerInstance: number
  outputCounts: number[]
  // true for an output group that only holds the documents of a window.
  windowedGroups?: boolean[]
  // The cells per document of the buffers a loop shader reads after the store.
  inputCells?: number[]
  // bit-emit.ts's plan of the buffer packed_words, bound after the output buffers: which shared cell is which bit of
  // which word. Without it, or with no words, the shader has no such buffer.
  packedCells?: readonly (readonly number[])[]
}

type RunnerOptions = {
  // The buffers of shader.inputCells, in order, e.g. another runner's outputBuffers[1].
  inputs?: readonly GPUBuffer[]
  // How many documents a windowed output group holds.
  windowCapacity?: number
}

export type ProgramRunner = Awaited<ReturnType<typeof createProgramRunner>>

// Compiles one shader and creates its buffers over a store's documents. A `salt` goes into the shader's source without
// changing its work, so a salt that no earlier run used compiles without hitting a shader cache, e.g. Metal's.
export async function createProgramRunner(device: GPUDevice, shader: RunnableShader, sharedValues: Float32Array, store: DocumentStore, salt?: number, options: RunnerOptions = {}) {
  invariant(shader.cellsPerInstance === store.cellsPerDocument, 'the shader reads the store\'s cells per document')
  invariant(sharedValues.length === shader.sharedLength, 'the shared values have the shader\'s length, see packSharedValues')
  const {capacity} = store
  const inputs = options.inputs ?? []
  invariant(inputs.length === (shader.inputCells?.length ?? 0), 'the runner gets one buffer per input of the shader')
  inputs.forEach((input, index) => invariant(input.size >= capacity * shader.inputCells![index]! * 4, 'an input buffer holds every document of the store'))
  const windowCapacity = options.windowCapacity ?? 0
  // How many documents each output group holds.
  const groupCapacity = shader.outputCounts.map((_, group) => shader.windowedGroups?.[group] === true ? windowCapacity : capacity)
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
  const packedCells = shader.packedCells ?? []
  // The shared values as last uploaded, since the packed words are packed from all of them and writeShared may write
  // only a part.
  const sharedCopy = new Float32Array(sharedValues)
  const packedWords = new Uint32Array(packedCells.length)
  const {params, shared, packed, outputBuffers, bindGroup, querySet, queryResolve, queryReadback} = await checked(device, () => {
    const created = {
      params: buffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}),
      shared: buffer({size: sharedValues.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true}),
      packed: packedCells.length > 0 ? buffer({size: packedCells.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}) : undefined,
      outputBuffers: shader.outputCounts.map((outputCount, group) => buffer({size: Math.max(4, groupCapacity[group]! * outputCount * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})),
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
        ...inputs.map((input, index) => ({binding: 3 + index, resource: {buffer: input}})),
        ...created.outputBuffers.map((outputBuffer, group) => ({binding: 3 + inputs.length + group, resource: {buffer: outputBuffer}})),
        ...(created.packed === undefined ? [] : [{binding: 3 + inputs.length + created.outputBuffers.length, resource: {buffer: created.packed}}]),
      ],
    })
    return {...created, bindGroup}
  })
  if (packed !== undefined) device.queue.writeBuffer(packed, 0, packWords(packedCells, sharedCopy, packedWords))
  // Per group, a mappable buffer and a JavaScript array, both made on the first readback and made again when a later
  // readback is larger, e.g. 131 KB for the kinds of 64 documents and 205 MB for the kinds of 100,000.
  const readbackBuffers: (GPUBuffer | undefined)[] = shader.outputCounts.map(() => undefined)
  const readbackArrays: (Float32Array | undefined)[] = shader.outputCounts.map(() => undefined)
  const paramValues = new Uint32Array(4)

  async function evaluate({count, firstDocument = 0, readbacks, cells, shared: newShared, window, timestamps = false}: EvaluateOptions): Promise<Evaluation> {
    invariant(Number.isInteger(count) && count >= 1 && firstDocument >= 0 && firstDocument + count <= capacity, 'the documents lie within the store\'s capacity')
    invariant(!timestamps || querySet !== undefined, 'this device has no timestamp queries')
    invariant(new Set(readbacks.map(readback => readback.group)).size === readbacks.length, 'a group is read back once per evaluation')
    invariant(window === undefined || (window.firstDocument >= 0 && window.documentCount >= 0 && window.documentCount <= windowCapacity), 'the window holds at most windowCapacity documents')
    const ranges = readbacks.map(({group, firstDocument, documentCount}) => {
      const outputCount = shader.outputCounts[group]
      invariant(outputCount !== undefined && firstDocument >= 0 && documentCount >= 1 && firstDocument + documentCount <= groupCapacity[group]!, 'a readback lies within its group')
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
    if (newShared !== undefined) writeShared(newShared)
    paramValues[0] = count
    paramValues[1] = window?.firstDocument ?? 0
    paramValues[2] = window?.documentCount ?? 0
    paramValues[3] = firstDocument
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

  // New shared values from `offset` on, e.g. another pattern's cells in a search program. With a plan of packed words,
  // the words are packed again from every shared value and uploaded too, e.g. for regex search at 32 states the
  // 16,384 transition cells, each one into two bits, of 1,088 words.
  function writeShared(values: Float32Array, offset = 0) {
    invariant(offset + values.length <= shader.sharedLength, 'the values lie within the shared buffer')
    device.queue.writeBuffer(shared, offset * 4, values.buffer, values.byteOffset, values.byteLength)
    if (packed !== undefined) {
      sharedCopy.set(values, offset)
      device.queue.writeBuffer(packed, 0, packWords(packedCells, sharedCopy, packedWords))
    }
  }

  // Copies some documents' values of one output group out of the GPU without running a pass, e.g. the display kinds of
  // the documents that scrolled into view. The values are what the last evaluation that covered those documents wrote.
  async function read({group, firstDocument, documentCount}: Readback) {
    const outputCount = shader.outputCounts[group]
    invariant(outputCount !== undefined && firstDocument >= 0 && documentCount >= 1 && firstDocument + documentCount <= groupCapacity[group]!, 'a read lies within its group')
    const bytes = documentCount * outputCount * 4
    const target = device.createBuffer({size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(outputBuffers[group]!, firstDocument * outputCount * 4, target, 0, bytes)
    device.queue.submit([encoder.finish()])
    await target.mapAsync(GPUMapMode.READ, 0, bytes)
    const values = new Float32Array(target.getMappedRange(0, bytes).slice(0))
    target.unmap()
    target.destroy()
    return values
  }

  return {
    compileMs,
    hasTimestamps,
    capacity,
    outputCounts: shader.outputCounts,
    // Each output group's buffer on the GPU, e.g. to give the display kinds to a search runner as an input.
    outputBuffers,
    evaluate,
    read,
    writeShared,
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
/** @public */
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

/** @public */
export type KernelRunner = Awaited<ReturnType<typeof createKernelRunner>>

// A runner for tests/json-search/bit-rows.ts's hand-written kernel, which reads its pattern from a buffer of u32 values and writes one
// match count per document. It's here for the comparison with the loop shader, and reads the same store.
/** @public */
export async function createKernelRunner(device: GPUDevice, kernel: {code: string, workgroupSize: number, tableLength: number, cellsPerDocument: number}, store: DocumentStore, salt?: number) {
  invariant(kernel.cellsPerDocument === store.cellsPerDocument, 'the kernel reads the store\'s cells per document')
  const {capacity} = store
  let code = kernel.code
  if (salt !== undefined) {
    const marker = 'let i: u32 = id.x;'
    invariant(code.includes(marker), 'unexpected shader text')
    code = code.replace(marker, `let salt: u32 = ${salt}u;\n_ = salt;\n${marker}`)
  }
  const compileStarted = performance.now()
  const pipeline = await checked(device, async () => {
    const module = device.createShaderModule({code})
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
    if (errors.length > 0) throw new Error(`WGSL errors: ${errors.slice(0, 5).map(message => `line ${message.lineNum}: ${message.message}`).join('; ')}`)
    return device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  })
  const compileMs = performance.now() - compileStarted
  const hasTimestamps = device.features.has('timestamp-query')
  const buffers = await checked(device, () => ({
    params: device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}),
    tables: device.createBuffer({size: kernel.tableLength * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}),
    counts: device.createBuffer({size: capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}),
    readback: device.createBuffer({size: capacity * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
    queryResolve: device.createBuffer({size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC}),
    queryReadback: device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
  }))
  const querySet = hasTimestamps ? device.createQuerySet({type: 'timestamp', count: 2}) : undefined
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: {buffer: buffers.params}},
      {binding: 1, resource: {buffer: buffers.tables}},
      {binding: 2, resource: {buffer: store.buffer}},
      {binding: 3, resource: {buffer: buffers.counts}},
    ],
  })
  const counts = new Float32Array(capacity)
  const paramValues = new Uint32Array(4)
  return {
    compileMs,
    hasTimestamps,
    // Runs the first `count` documents with the given pattern tables, uploaded before the pass, and reads back every
    // document's match count into an array that the next call overwrites.
    async evaluate({count, tables, timestamps = false}: {count: number, tables?: Uint32Array, timestamps?: boolean}) {
      invariant(count >= 1 && count <= capacity, 'the count lies within the store\'s capacity')
      const started = performance.now()
      if (tables !== undefined) device.queue.writeBuffer(buffers.tables, 0, tables.buffer, tables.byteOffset, tables.byteLength)
      paramValues[0] = count
      device.queue.writeBuffer(buffers.params, 0, paramValues.buffer, 0, 16)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass(timestamps ? {timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(count / kernel.workgroupSize))
      pass.end()
      encoder.copyBufferToBuffer(buffers.counts, 0, buffers.readback, 0, count * 4)
      if (timestamps) {
        encoder.resolveQuerySet(querySet!, 0, 2, buffers.queryResolve, 0)
        encoder.copyBufferToBuffer(buffers.queryResolve, 0, buffers.queryReadback, 0, 16)
      }
      device.queue.submit([encoder.finish()])
      await buffers.readback.mapAsync(GPUMapMode.READ, 0, count * 4)
      const values = counts.subarray(0, count)
      values.set(new Float32Array(buffers.readback.getMappedRange(0, count * 4)))
      buffers.readback.unmap()
      const totalMs = performance.now() - started
      let passMs: number | undefined
      if (timestamps) {
        await buffers.queryReadback.mapAsync(GPUMapMode.READ, 0, 16)
        const times = new BigUint64Array(buffers.queryReadback.getMappedRange(0, 16).slice(0))
        buffers.queryReadback.unmap()
        passMs = Number(times[1]! - times[0]!) / 1e6
      }
      return {totalMs, passMs, counts: values}
    },
    destroy() {
      for (const created of Object.values(buffers)) created.destroy()
      querySet?.destroy()
    },
  }
}
