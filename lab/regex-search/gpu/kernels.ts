// WebGPU kernels for form (c)'s tree, and the host loop that runs one prefix network level per dispatch. Every product is
// a plain sum of products followed by min(sum, 1), i.e. a batched GEMM with a clamp back to 0/1, over (S + 1) × (S + 1)
// matrices that stay on the GPU between levels. automaton-inputs.ts's gpuPlan describes the slots and the triples.
// An evaluation gets its leaves in one of two ways:
// - 'leaves': JavaScript writes N × (S + 1) × (S + 1) floats and uploads them.
// - 'classes': JavaScript uploads the class of every code point, N × 4 bytes, and a gather dispatch copies each class's
//   matrix into the leaves on the GPU. The class matrices are uploaded once per pattern, in prepare.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import type {GpuPlan} from './automaton-inputs.ts'

// WebGPU's constants, with the values from the WebGPU specification, since TypeScript's DOM library declares the types and
// not these values.
const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, QUERY_RESOLVE: 0x0200} as const
const GPUMapMode = {READ: 0x0001} as const

// How a dispatch splits the matrix products into invocations:
// - 'row': one invocation per combine and row of the result, which loops over the middle state and the column.
// - 'entry': one invocation per combine and entry of the result, which loops over the middle state.
// - 'matrix': one invocation per combine, which computes the whole product.
export type Granularity = 'row' | 'entry' | 'matrix'
export type KernelChoice = {granularity: Granularity, workgroupX: number, workgroupY: number}

export const kernelChoices: Record<string, KernelChoice> = {
  'row-16x16': {granularity: 'row', workgroupX: 16, workgroupY: 16},
  'row-64x4': {granularity: 'row', workgroupX: 64, workgroupY: 4},
  'entry-8x32': {granularity: 'entry', workgroupX: 8, workgroupY: 32},
  'entry-4x64': {granularity: 'entry', workgroupX: 4, workgroupY: 64},
  'matrix-64': {granularity: 'matrix', workgroupX: 64, workgroupY: 1},
  'matrix-256': {granularity: 'matrix', workgroupX: 256, workgroupY: 1},
}

const levelStruct = 'struct Level { offset: u32, count: u32 }'

// Every shader starts with `let salt = <salt>u;`, which changes the source without changing the work, so that a new salt
// compiles without hitting a shader cache from an earlier run, e.g. Metal's. `from` is a reserved word in WGSL, so the
// shaders say fromState.

// JS: result[s][t] = Math.min(1, sum over u of earlier[s][u] × later[u][t]), for every triple of the level.
export function matrixProductShader(states: number, {granularity, workgroupX, workgroupY}: KernelChoice, salt = 0): string {
  const size = states + 1
  const header = `${levelStruct}
@group(0) @binding(0) var<storage, read_write> matrices: array<f32>;
@group(0) @binding(1) var<storage, read> triples: array<u32>;
@group(0) @binding(2) var<uniform> level: Level;
const size = ${size}u;
@compute @workgroup_size(${workgroupX}, ${workgroupY})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let salt = ${salt}u;`
  switch (granularity) {
    case 'row':
      return `${header}
  if (id.x >= level.count || id.y >= size) { return; }
  let triple = (level.offset + id.x) * 3u;
  let earlierRow = triples[triple] * size * size + id.y * size;
  let later = triples[triple + 1u] * size * size;
  let resultRow = triples[triple + 2u] * size * size + id.y * size;
  var row: array<f32, ${size}>;
  for (var middle = 0u; middle < size; middle++) {
    let weight = matrices[earlierRow + middle];
    let laterRow = later + middle * size;
    for (var toState = 0u; toState < size; toState++) {
      row[toState] += weight * matrices[laterRow + toState];
    }
  }
  for (var toState = 0u; toState < size; toState++) {
    matrices[resultRow + toState] = min(row[toState], 1.0);
  }
}`
    case 'entry':
      return `${header}
  if (id.x >= level.count || id.y >= size * size) { return; }
  let triple = (level.offset + id.x) * 3u;
  let fromState = id.y / size;
  let toState = id.y % size;
  let earlierRow = triples[triple] * size * size + fromState * size;
  let later = triples[triple + 1u] * size * size;
  var total = 0.0;
  for (var middle = 0u; middle < size; middle++) {
    total += matrices[earlierRow + middle] * matrices[later + middle * size + toState];
  }
  matrices[triples[triple + 2u] * size * size + id.y] = min(total, 1.0);
}`
    case 'matrix':
      return `${header}
  if (id.x >= level.count) { return; }
  let triple = (level.offset + id.x) * 3u;
  let earlier = triples[triple] * size * size;
  let later = triples[triple + 1u] * size * size;
  let result = triples[triple + 2u] * size * size;
  for (var fromState = 0u; fromState < size; fromState++) {
    var row: array<f32, ${size}>;
    for (var middle = 0u; middle < size; middle++) {
      let weight = matrices[earlier + fromState * size + middle];
      let laterRow = later + middle * size;
      for (var toState = 0u; toState < size; toState++) {
        row[toState] += weight * matrices[laterRow + toState];
      }
    }
    for (var toState = 0u; toState < size; toState++) {
      matrices[result + fromState * size + toState] = min(row[toState], 1.0);
    }
  }
}`
  }
}

// JS: result[s] = Math.min(1, sum over u of earlier[s][u] × later[u]), one invocation per combine and row.
export function vectorProductShader(states: number, salt = 0): string {
  const size = states + 1
  return `${levelStruct}
@group(0) @binding(0) var<storage, read> matrices: array<f32>;
@group(0) @binding(1) var<storage, read_write> vectors: array<f32>;
@group(0) @binding(2) var<storage, read> triples: array<u32>;
@group(0) @binding(3) var<uniform> level: Level;
const size = ${size}u;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let salt = ${salt}u;
  if (id.x >= level.count || id.y >= size) { return; }
  let triple = (level.offset + id.x) * 3u;
  let earlierRow = triples[triple] * size * size + id.y * size;
  let later = triples[triple + 1u] * size;
  var total = 0.0;
  for (var middle = 0u; middle < size; middle++) {
    total += matrices[earlierRow + middle] * vectors[later + middle];
  }
  vectors[triples[triple + 2u] * size + id.y] = min(total, 1.0);
}`
}

// JS: words[j] = the reach bits at position j, bit s for state s, from vector slot j.
export function packShader(states: number, salt = 0): string {
  return `${levelStruct}
@group(0) @binding(0) var<storage, read> vectors: array<f32>;
@group(0) @binding(1) var<storage, read_write> words: array<u32>;
@group(0) @binding(2) var<uniform> level: Level;
const size = ${states + 1}u;
const states = ${states}u;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let salt = ${salt}u;
  if (id.x >= level.count) { return; }
  let base = id.x * size;
  var word = 0u;
  for (var state = 0u; state < states; state++) {
    word |= select(0u, 1u << state, vectors[base + state] > 0.5);
  }
  words[id.x] = word;
}`
}

// JS: leaves[j][s][t] = perClass[classOf[j]][s][t], one invocation per position and row, and the last leaf's last column
// into vector slot N - 1.
export function gatherShader(states: number, salt = 0): string {
  return `${levelStruct}
@group(0) @binding(0) var<storage, read> perClass: array<f32>;
@group(0) @binding(1) var<storage, read> classOf: array<u32>;
@group(0) @binding(2) var<storage, read_write> matrices: array<f32>;
@group(0) @binding(3) var<storage, read_write> vectors: array<f32>;
@group(0) @binding(4) var<uniform> level: Level;
const size = ${states + 1}u;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let salt = ${salt}u;
  if (id.x >= level.count || id.y >= size) { return; }
  let classRow = classOf[id.x] * size * size + id.y * size;
  let leafRow = id.x * size * size + id.y * size;
  for (var toState = 0u; toState < size; toState++) {
    matrices[leafRow + toState] = perClass[classRow + toState];
  }
  if (id.x == level.count - 1u) {
    vectors[id.x * size + id.y] = perClass[classRow + size - 1u];
  }
}`
}

// performance.now() times of one evaluation, in ms, from the first upload call to the last copy out of the readback.
export type EvaluationTiming = {
  // The writeBuffer calls, which return before the GPU has the data.
  uploadMs: number
  encodeAndSubmitMs: number
  // From submit to mapAsync resolving with readback, or to onSubmittedWorkDone resolving without.
  waitMs: number
  // Copying the mapped words into a JavaScript array, with readback.
  copyMs: number
  totalMs: number
}
export type TimestampMode = 'none' | 'pass' | 'levels'
export type Evaluation = EvaluationTiming & {
  words: Uint32Array | undefined
  // From timestamp queries: the one compute pass that runs the gather, every level and the packing, or one pass per level.
  passMs: number | undefined
  levelMs: number[] | undefined
}
export type EvaluationInput = {kind: 'leaves', leaves: Float32Array, lastColumn: Float32Array} | {kind: 'classes', classes: Uint32Array}

export type CompileTimes = {matrixProductMs: number, vectorProductMs: number, packMs: number, gatherMs: number}

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

// From createShaderModule to createComputePipelineAsync resolving, including reading the compilation messages, so that a
// WGSL error shows its message instead of an invalid pipeline.
async function compile(device: GPUDevice, code: string) {
  const started = performance.now()
  const module = device.createShaderModule({code})
  const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
  if (errors.length > 0) throw new Error(`WGSL errors: ${errors.map(message => `line ${message.lineNum}: ${message.message}`).join('; ')}\n${code}`)
  const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  return {pipeline, compileMs: performance.now() - started}
}

export async function createGpuTree(device: GPUDevice, states: number, choice: KernelChoice, salt = 0) {
  invariant(states <= 32, 'the pack kernel writes one 32-bit word per position')
  const size = states + 1
  const area = size * size
  const matrixProduct = await checked(device, () => compile(device, matrixProductShader(states, choice, salt)))
  const vectorProduct = await checked(device, () => compile(device, vectorProductShader(states, salt)))
  const pack = await checked(device, () => compile(device, packShader(states, salt)))
  const gather = await checked(device, () => compile(device, gatherShader(states, salt)))
  const compileTimes: CompileTimes = {matrixProductMs: matrixProduct.compileMs, vectorProductMs: vectorProduct.compileMs, packMs: pack.compileMs, gatherMs: gather.compileMs}
  const matrixRows = choice.granularity === 'row' ? size : choice.granularity === 'entry' ? area : 1
  const hasTimestamps = device.features.has('timestamp-query')

  // perClass is createLeafWriter's perClass, uploaded once here for the 'classes' input.
  async function prepare(plan: GpuPlan, perClass: Float32Array) {
    const {textLength, levels} = plan
    const buffers: GPUBuffer[] = []
    const buffer = (descriptor: GPUBufferDescriptor) => {
      const created = device.createBuffer(descriptor)
      buffers.push(created)
      return created
    }
    const bufferWith = (data: Uint32Array | Float32Array, usage: number) => {
      const created = buffer({size: Math.max(12, data.byteLength), usage, mappedAtCreation: true})
      new Uint8Array(created.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      created.unmap()
      return created
    }
    const prepared = await checked(device, () => {
      const matrices = buffer({size: plan.matrixSlots * area * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const vectors = buffer({size: textLength * size * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const matrixTriples = bufferWith(plan.matrixTriples, GPUBufferUsage.STORAGE)
      const vectorTriples = bufferWith(plan.vectorTriples, GPUBufferUsage.STORAGE)
      const classMatrices = bufferWith(perClass, GPUBufferUsage.STORAGE)
      const classIndices = buffer({size: Math.max(12, textLength * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const words = buffer({size: textLength * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})
      const wordsReadback = buffer({size: textLength * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
      const levelBuffer = (offset: number, count: number) => bufferWith(Uint32Array.of(offset, count), GPUBufferUsage.UNIFORM)
      const matrixGroups = levels.map(level => level.matrixCount === 0 ? undefined : device.createBindGroup({
        layout: matrixProduct.pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: matrices}}, {binding: 1, resource: {buffer: matrixTriples}}, {binding: 2, resource: {buffer: levelBuffer(level.matrixOffset, level.matrixCount)}}],
      }))
      const vectorGroups = levels.map(level => level.vectorCount === 0 ? undefined : device.createBindGroup({
        layout: vectorProduct.pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: matrices}}, {binding: 1, resource: {buffer: vectors}}, {binding: 2, resource: {buffer: vectorTriples}}, {binding: 3, resource: {buffer: levelBuffer(level.vectorOffset, level.vectorCount)}}],
      }))
      const positions = levelBuffer(0, textLength)
      const packGroup = device.createBindGroup({
        layout: pack.pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: vectors}}, {binding: 1, resource: {buffer: words}}, {binding: 2, resource: {buffer: positions}}],
      })
      const gatherGroup = device.createBindGroup({
        layout: gather.pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: classMatrices}}, {binding: 1, resource: {buffer: classIndices}}, {binding: 2, resource: {buffer: matrices}}, {binding: 3, resource: {buffer: vectors}}, {binding: 4, resource: {buffer: positions}}],
      })
      // Two timestamps per level, plus two for the packing pass.
      const queryCount = 2 * (levels.length + 1)
      const querySet = hasTimestamps ? device.createQuerySet({type: 'timestamp', count: queryCount}) : undefined
      const queryResolve = buffer({size: 8 * queryCount, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC})
      const queryReadback = buffer({size: 8 * queryCount, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
      return {matrices, vectors, classIndices, words, wordsReadback, matrixGroups, vectorGroups, packGroup, gatherGroup, querySet, queryCount, queryResolve, queryReadback}
    })
    const {matrices, vectors, classIndices, words, wordsReadback, matrixGroups, vectorGroups, packGroup, gatherGroup, querySet, queryCount, queryResolve, queryReadback} = prepared

    const encodeLevel = (pass: GPUComputePassEncoder, index: number) => {
      const level = levels[index]!
      const matrixGroup = matrixGroups[index]
      if (matrixGroup !== undefined) {
        pass.setPipeline(matrixProduct.pipeline)
        pass.setBindGroup(0, matrixGroup)
        pass.dispatchWorkgroups(Math.ceil(level.matrixCount / choice.workgroupX), Math.ceil(matrixRows / choice.workgroupY))
      }
      const vectorGroup = vectorGroups[index]
      if (vectorGroup !== undefined) {
        pass.setPipeline(vectorProduct.pipeline)
        pass.setBindGroup(0, vectorGroup)
        pass.dispatchWorkgroups(Math.ceil(level.vectorCount / 16), Math.ceil(size / 16))
      }
    }
    const encodePack = (pass: GPUComputePassEncoder) => {
      pass.setPipeline(pack.pipeline)
      pass.setBindGroup(0, packGroup)
      pass.dispatchWorkgroups(Math.ceil(textLength / 256))
    }
    const encodeGather = (pass: GPUComputePassEncoder) => {
      pass.setPipeline(gather.pipeline)
      pass.setBindGroup(0, gatherGroup)
      pass.dispatchWorkgroups(Math.ceil(textLength / 16), Math.ceil(size / 16))
    }

    // With compute false, only the upload: the same writeBuffer calls and an empty command buffer, where
    // onSubmittedWorkDone resolves once the GPU has the data.
    async function evaluate(input: EvaluationInput, {readback, timestamps, compute = true}: {readback: boolean, timestamps: TimestampMode, compute?: boolean}): Promise<Evaluation> {
      invariant(timestamps === 'none' || querySet !== undefined, 'this device has no timestamp queries')
      invariant(compute || (!readback && timestamps === 'none'), 'an upload without compute has nothing to read back')
      invariant(timestamps !== 'levels' || input.kind === 'leaves', 'one pass per level is measured with uploaded leaves')
      const started = performance.now()
      if (input.kind === 'leaves') {
        device.queue.writeBuffer(matrices, 0, input.leaves.buffer, input.leaves.byteOffset, input.leaves.byteLength)
        device.queue.writeBuffer(vectors, (textLength - 1) * size * 4, input.lastColumn.buffer, input.lastColumn.byteOffset, input.lastColumn.byteLength)
      } else {
        device.queue.writeBuffer(classIndices, 0, input.classes.buffer, input.classes.byteOffset, input.classes.byteLength)
      }
      const uploaded = performance.now()
      const encoder = device.createCommandEncoder()
      if (!compute) {
        // Nothing to encode.
      } else if (timestamps === 'levels') {
        levels.forEach((_, index) => {
          const pass = encoder.beginComputePass({timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 2 * index, endOfPassWriteIndex: 2 * index + 1}})
          encodeLevel(pass, index)
          pass.end()
        })
        if (readback) {
          const pass = encoder.beginComputePass({timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 2 * levels.length, endOfPassWriteIndex: 2 * levels.length + 1}})
          encodePack(pass)
          pass.end()
        }
      } else {
        const pass = encoder.beginComputePass(timestamps === 'pass' ? {timestampWrites: {querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
        if (input.kind === 'classes') encodeGather(pass)
        levels.forEach((_, index) => encodeLevel(pass, index))
        if (readback) encodePack(pass)
        pass.end()
      }
      if (readback) encoder.copyBufferToBuffer(words, 0, wordsReadback, 0, textLength * 4)
      if (timestamps !== 'none') {
        encoder.resolveQuerySet(querySet!, 0, queryCount, queryResolve, 0)
        encoder.copyBufferToBuffer(queryResolve, 0, queryReadback, 0, 8 * queryCount)
      }
      device.queue.submit([encoder.finish()])
      const submitted = performance.now()
      let result: Uint32Array | undefined
      if (readback) {
        await wordsReadback.mapAsync(GPUMapMode.READ, 0, textLength * 4)
      } else {
        await device.queue.onSubmittedWorkDone()
      }
      const mapped = performance.now()
      if (readback) {
        result = new Uint32Array(wordsReadback.getMappedRange(0, textLength * 4).slice(0))
        wordsReadback.unmap()
      }
      const finished = performance.now()
      let passMs: number | undefined
      let levelMs: number[] | undefined
      if (timestamps !== 'none') {
        await queryReadback.mapAsync(GPUMapMode.READ, 0, 8 * queryCount)
        const times = new BigUint64Array(queryReadback.getMappedRange(0, 8 * queryCount).slice(0))
        queryReadback.unmap()
        const between = (begin: number) => Number(times[begin + 1]! - times[begin]!) / 1e6
        if (timestamps === 'pass') passMs = between(0)
        else levelMs = [...levels.map((_, index) => between(2 * index)), ...(readback ? [between(2 * levels.length)] : [])]
      }
      return {uploadMs: uploaded - started, encodeAndSubmitMs: submitted - uploaded, waitMs: mapped - submitted, copyMs: finished - mapped, totalMs: finished - started, words: result, passMs, levelMs}
    }

    return {
      evaluate,
      destroy() {
        for (const created of buffers) created.destroy()
        querySet?.destroy()
      },
    }
  }

  return {compileTimes, hasTimestamps, prepare}
}
