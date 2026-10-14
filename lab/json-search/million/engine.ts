// Runs one kernel of kernels.ts, or bit-rows.ts's kernel as it is, over documents that are already on the GPU, and
// times one search as a page would see it: from the upload of the pattern's tables until the results are in a
// JavaScript array.
//
//   const engine = await createEngine(device, kernel, {parts: [{buffer, firstDocument: 0, documentCount}], scopes}, tableLength, capacity)
//   const {values, totalMs} = await engine.search({count, tables, scopeMask: 2})
//
// What one search does: writeBuffer of the tables and of 16 bytes of parameters per part, one compute pass with one
// dispatch per part, for a 'has' kernel a clear of the result bits before it, with `packBits` a second pass that packs
// the counts into bits, a copy of the results into a mappable buffer, and mapAsync.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {type Kernel, packCountsKernel} from './kernels.ts'

const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, QUERY_RESOLVE: 0x0200} as const
const GPUMapMode = {READ: 0x0001} as const

// The documents of one buffer. With several parts, each buffer stays within what one binding holds.
export type DocumentPart = {buffer: GPUBuffer, firstDocument: number, documentCount: number}

export type EngineInputs = {
  parts: readonly DocumentPart[]
  // The packed layout's buffer of the word where each document starts.
  starts?: GPUBuffer
  // 32 words of scope bits per document.
  scopes?: GPUBuffer
}

export type SearchTiming = {
  // From before the writeBuffer calls until the results are copied into `values`.
  totalMs: number
  // Until the commands are submitted, until the readback is mapped, and the copy into `values`.
  submitMs: number
  waitMs: number
  copyMs: number
  // The compute passes, from timestamp queries.
  passMs: number | undefined
}

export type Engine = Awaited<ReturnType<typeof createEngine>>

export async function checked<Result>(device: GPUDevice, build: () => Promise<Result> | Result): Promise<Result> {
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  const result = await build()
  const outOfMemory = await device.popErrorScope()
  const validation = await device.popErrorScope()
  if (outOfMemory !== null) throw new Error(`WebGPU out of memory: ${outOfMemory.message}`)
  if (validation !== null) throw new Error(`WebGPU validation error: ${validation.message}`)
  return result
}

export async function compile(device: GPUDevice, code: string) {
  const started = performance.now()
  const pipeline = await checked(device, async () => {
    const module = device.createShaderModule({code})
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
    if (errors.length > 0) throw new Error(`WGSL errors: ${errors.slice(0, 5).map(message => `line ${message.lineNum}: ${message.message}`).join('; ')}`)
    return device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  })
  return {pipeline, compileMs: performance.now() - started}
}

// `capacity` is how many documents the results hold. `packBits` adds the second pass to a 'count' kernel, and the
// search then reads back bits instead of counts.
export async function createEngine(device: GPUDevice, kernel: Kernel, inputs: EngineInputs, tableLength: number, capacity: number, options: {packBits?: boolean} = {}) {
  const packBits = options.packBits === true
  invariant(!packBits || kernel.output === 'count', 'only counts are packed into bits')
  invariant(!(packBits || kernel.output === 'has') || inputs.parts.every(part => part.firstDocument % 32 === 0), 'with bits, a part starts at a multiple of 32 documents')
  const {pipeline, compileMs} = await compile(device, kernel.code)
  const pack = packBits ? await compile(device, packCountsKernel().code) : undefined
  const hasTimestamps = device.features.has('timestamp-query')
  const bitWords = Math.ceil(capacity / 32)
  const resultWords = kernel.output === 'count' ? capacity : bitWords
  const readbackWords = kernel.output === 'has' || packBits ? bitWords : capacity
  const created = await checked(device, () => {
    const tables = device.createBuffer({size: tableLength * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
    const results = device.createBuffer({size: resultWords * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST})
    const bits = packBits ? device.createBuffer({size: bitWords * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC}) : undefined
    const parts = inputs.parts.map(part => {
      const params = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
      const buffers = {params, tables, documents: part.buffer, starts: inputs.starts, scopes: inputs.scopes, results}
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: kernel.bindings.map((name, binding) => {
          const buffer = buffers[name]
          invariant(buffer !== undefined, `the kernel reads ${name}`)
          return {binding, resource: {buffer}}
        }),
      })
      const packGroup = pack === undefined ? undefined : device.createBindGroup({
        layout: pack.pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: params}}, {binding: 1, resource: {buffer: results}}, {binding: 2, resource: {buffer: bits!}}],
      })
      return {...part, params, bindGroup, packGroup}
    })
    return {
      tables, results, bits, parts,
      readback: device.createBuffer({size: readbackWords * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
      queryResolve: device.createBuffer({size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC}),
      queryReadback: device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
    }
  })
  const querySet = hasTimestamps ? device.createQuerySet({type: 'timestamp', count: 2}) : undefined
  const values = new Uint32Array(readbackWords)
  const paramValues = new Uint32Array(4)

  // Searches the documents `first` to `first + count - 1`. `values` holds one count per document of the store, or one
  // bit per document, 32 documents a word, and the next search overwrites it. Only the searched documents' values are
  // read back, so with `first` above 0 the earlier documents keep the last search's values. For bits, `first` is a
  // multiple of 32.
  async function search({count, first = 0, tables, scopeMask = 0, timestamps = false}: {count: number, first?: number, tables?: Uint32Array<ArrayBuffer>, scopeMask?: number, timestamps?: boolean}): Promise<SearchTiming & {values: Uint32Array<ArrayBuffer>}> {
    invariant(count >= 1 && first >= 0 && first + count <= capacity, 'the documents lie within the capacity')
    const asBits = kernel.output === 'has' || packBits
    invariant(!asBits || first % 32 === 0, 'a search that returns bits starts at a multiple of 32 documents')
    invariant(!timestamps || querySet !== undefined, 'this device has no timestamp queries')
    const started = performance.now()
    if (tables !== undefined) device.queue.writeBuffer(created.tables, 0, tables)
    const running = created.parts.flatMap(part => {
      const from = Math.max(first, part.firstDocument)
      const to = Math.min(first + count, part.firstDocument + part.documentCount)
      if (to <= from) return []
      paramValues[0] = to - from
      paramValues[1] = from
      paramValues[2] = scopeMask
      paramValues[3] = part.firstDocument
      device.queue.writeBuffer(part.params, 0, paramValues)
      return [{part, documents: to - from}]
    })
    const encoder = device.createCommandEncoder()
    const firstWord = first >> 5
    const words = asBits ? Math.ceil((first + count) / 32) - firstWord : count
    if (kernel.output === 'has') encoder.clearBuffer(created.results, firstWord * 4, words * 4)
    const pass = encoder.beginComputePass(timestamps ? {timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 0, ...(pack === undefined ? {endOfPassWriteIndex: 1} : {})}} : {})
    pass.setPipeline(pipeline)
    for (const {part, documents} of running) {
      pass.setBindGroup(0, part.bindGroup)
      pass.dispatchWorkgroups(Math.ceil(documents / kernel.workgroupSize))
    }
    pass.end()
    if (pack !== undefined) {
      const packPass = encoder.beginComputePass(timestamps ? {timestampWrites: {querySet: querySet!, endOfPassWriteIndex: 1}} : {})
      packPass.setPipeline(pack.pipeline)
      for (const {part, documents} of running) {
        packPass.setBindGroup(0, part.packGroup!)
        packPass.dispatchWorkgroups(Math.ceil(Math.ceil(documents / 32) / 64))
      }
      packPass.end()
    }
    const source = packBits ? created.bits! : created.results
    const offset = asBits ? firstWord * 4 : first * 4
    encoder.copyBufferToBuffer(source, offset, created.readback, offset, words * 4)
    if (timestamps) {
      encoder.resolveQuerySet(querySet!, 0, 2, created.queryResolve, 0)
      encoder.copyBufferToBuffer(created.queryResolve, 0, created.queryReadback, 0, 16)
    }
    device.queue.submit([encoder.finish()])
    const submitted = performance.now()
    // A mapped range starts at a multiple of 8 bytes.
    const mapOffset = offset - offset % 8
    await created.readback.mapAsync(GPUMapMode.READ, mapOffset, offset - mapOffset + words * 4)
    const mapped = performance.now()
    values.set(new Uint32Array(created.readback.getMappedRange(mapOffset, offset - mapOffset + words * 4), offset - mapOffset, words), offset / 4)
    created.readback.unmap()
    const finished = performance.now()
    let passMs: number | undefined
    if (timestamps) {
      await created.queryReadback.mapAsync(GPUMapMode.READ, 0, 16)
      const times = new BigUint64Array(created.queryReadback.getMappedRange(0, 16).slice(0))
      created.queryReadback.unmap()
      passMs = Number(times[1]! - times[0]!) / 1e6
    }
    return {values, totalMs: finished - started, submitMs: submitted - started, waitMs: mapped - submitted, copyMs: finished - mapped, passMs}
  }

  return {
    compileMs, hasTimestamps, capacity, output: kernel.output === 'has' || packBits ? 'bits' as const : 'counts' as const,
    // The bytes of the buffers that this engine made, by name.
    bufferBytes: {tables: created.tables.size, results: created.results.size, bits: created.bits?.size ?? 0, readback: created.readback.size},
    search,
    destroy() {
      for (const buffer of [created.tables, created.results, created.bits, created.readback, created.queryResolve, created.queryReadback, ...created.parts.map(part => part.params)]) buffer?.destroy()
      querySet?.destroy()
    },
  }
}
