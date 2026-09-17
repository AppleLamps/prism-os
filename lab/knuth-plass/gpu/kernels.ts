// WebGPU kernels for the min-plus tree, and the host loop that runs one level of Brent-Kung's network per dispatch, for
// every paragraph of a batch at once. Every entry is a u32 within 0..noPath, every product clamps at noPath, and the
// matrices stay on the GPU between levels. The host reads back only what backtracking needs: per paragraph, the total
// cost and the pointer of every break point. plan.ts describes the slots, and runPlanInJavaScript is the same arithmetic
// in JavaScript.
// An evaluation gets its input in one of three ways:
// - 'line-costs': JavaScript computes every line cost, row 0 of every leaf, P × n × W u32 values, and uploads them.
// - 'positions': JavaScript uploads every paragraph's lineStarts and lineEnds, P × 2n i32 values, and the widths, and a
//   kernel computes the line costs on the GPU.
// - 'widths': the positions are already on the GPU, from an earlier 'positions' evaluation, and JavaScript uploads only
//   the widths, P i32 values, e.g. for a width slider.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {infeasible, lineCostCap, slackLimit} from '../paragraph.ts'
import {type GpuPlan, type Kernel, backtrackAll, matrixTripleSize, noPath, vectorTripleSize} from './plan.ts'

// WebGPU's constants, with the values from the WebGPU specification, since TypeScript's DOM library declares the types and
// not these values.
const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, QUERY_RESOLVE: 0x0200} as const
const GPUMapMode = {READ: 0x0001} as const

export type Input = 'line-costs' | 'positions' | 'widths'

// The workgroup of a kernel with one invocation per combine and row: x runs over paragraphs × combines, and y over the
// rows, with 256 invocations per workgroup, e.g. 32 × 8 at W = 8 and 8 × 32 at W = 32.
export function rowWorkgroup(window: number) {
  const y = Math.min(32, 2 ** Math.ceil(Math.log2(window)))
  return {x: 256 / y, y}
}

// `from` is a reserved word in WGSL, so the shaders say start.
const header = (window: number) => `struct Shape { paragraphs: u32, breaks: u32, productSlots: u32, unused: u32 }
struct Level { offset: u32, count: u32 }
const window = ${window}u;
const area = ${window * window}u;
const noPath = ${noPath}u;
fn slotStart(shape: Shape, paragraph: u32, slot: u32) -> u32 {
  let leafSlot = paragraph * shape.breaks + slot;
  let productSlot = shape.paragraphs * shape.breaks + paragraph * shape.productSlots + slot - shape.breaks;
  return select(productSlot, leafSlot, slot < shape.breaks) * area;
}`

// Every main starts with `let salt = <salt>u;`, which changes the source without changing the work, so that a new salt
// compiles without hitting a shader cache from an earlier run, e.g. Metal's.
const saltLine = (salt: number) => `  let salt = ${salt}u;`

// JS: runPlanInJavaScript's matrix products for one level, one invocation per paragraph × combine and row of the result.
export function matrixProductShader(kernel: Kernel, window: number, salt = 0): string {
  const {x, y} = rowWorkgroup(window)
  const common = `${header(window)}
@group(0) @binding(0) var<storage, read_write> matrices: array<u32>;
@group(0) @binding(1) var<storage, read> triples: array<u32>;
@group(0) @binding(2) var<uniform> shape: Shape;
@group(0) @binding(3) var<uniform> level: Level;
@compute @workgroup_size(${x}, ${y})
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= level.count * shape.paragraphs || id.y >= window) { return; }
  let paragraph = id.x / level.count;
  let triple = (level.offset + id.x % level.count) * ${matrixTripleSize}u;
  let later = slotStart(shape, paragraph, triples[triple]);
  let earlier = slotStart(shape, paragraph, triples[triple + 1u]);
  let result = slotStart(shape, paragraph, triples[triple + 2u]) + id.y * window;
  let laterRow = later + id.y * window;
  var row: array<u32, ${window}>;`
  if (kernel === 'full') {
    return `${common}
  for (var column = 0u; column < window; column++) { row[column] = noPath; }
  for (var middle = 0u; middle < window; middle++) {
    let weight = matrices[laterRow + middle];
    let earlierRow = earlier + middle * window;
    for (var column = 0u; column < window; column++) {
      row[column] = min(row[column], weight + matrices[earlierRow + column]);
    }
  }
  for (var column = 0u; column < window; column++) { matrices[result + column] = row[column]; }
}`
  }
  return `${common}
  let laterBreaks = triples[triple + 3u];
  let earlierBreaks = triples[triple + 4u];
  if (id.y >= laterBreaks + earlierBreaks) { return; }
  if (id.y >= laterBreaks) {
    let earlierRow = earlier + (id.y - laterBreaks) * window;
    for (var column = 0u; column < window; column++) { matrices[result + column] = matrices[earlierRow + column]; }
    return;
  }
  for (var column = 0u; column < window; column++) {
    row[column] = select(noPath, matrices[laterRow + column + earlierBreaks], column + earlierBreaks < window);
  }
  let middleRows = min(earlierBreaks, window);
  for (var middle = 0u; middle < middleRows; middle++) {
    let weight = matrices[laterRow + middle];
    let earlierRow = earlier + middle * window;
    for (var column = 0u; column < window; column++) {
      row[column] = min(row[column], weight + matrices[earlierRow + column]);
    }
  }
  for (var column = 0u; column < window; column++) { matrices[result + column] = row[column]; }
}`
}

// JS: runPlanInJavaScript's products of a matrix with a vector for one level, one invocation per paragraph × combine and
// row of the result.
export function vectorProductShader(kernel: Kernel, window: number, salt = 0): string {
  const {x, y} = rowWorkgroup(window)
  return `${header(window)}
@group(0) @binding(0) var<storage, read> matrices: array<u32>;
@group(0) @binding(1) var<storage, read_write> vectors: array<u32>;
@group(0) @binding(2) var<storage, read> triples: array<u32>;
@group(0) @binding(3) var<uniform> shape: Shape;
@group(0) @binding(4) var<uniform> level: Level;
@compute @workgroup_size(${x}, ${y})
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= level.count * shape.paragraphs || id.y >= window) { return; }
  let paragraph = id.x / level.count;
  let triple = (level.offset + id.x % level.count) * ${vectorTripleSize}u;
  let earlier = (paragraph * shape.breaks + triples[triple + 1u]) * window;
  let result = (paragraph * shape.breaks + triples[triple + 2u]) * window + id.y;
${kernel === 'dense-rows' ? `  let laterBreaks = triples[triple + 3u];
  if (id.y >= laterBreaks) {
    vectors[result] = vectors[earlier + id.y - laterBreaks];
    return;
  }
` : ''}  let laterRow = slotStart(shape, paragraph, triples[triple]) + id.y * window;
  var best = noPath;
  for (var middle = 0u; middle < window; middle++) {
    best = min(best, matrices[laterRow + middle] + vectors[earlier + middle]);
  }
  vectors[result] = best;
}`
}

const shiftRows = `  for (var row = 1u; row < window; row++) {
    for (var column = 0u; column < window; column++) {
      matrices[leaf + row * window + column] = select(noPath, 0u, column + 1u == row);
    }
  }
`

// JS: the leaves from uploaded line costs, one invocation per paragraph × break point: row 0 from lineCosts, and for the
// full kernel, rows r >= 1 with 0 at column r - 1 and noPath elsewhere.
export function leavesFromLineCostsShader(kernel: Kernel, window: number, salt = 0): string {
  return `${header(window)}
@group(0) @binding(0) var<storage, read> lineCosts: array<u32>;
@group(0) @binding(1) var<storage, read_write> matrices: array<u32>;
@group(0) @binding(2) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= shape.paragraphs * shape.breaks) { return; }
  let leaf = id.x * area;
  let costs = id.x * window;
  for (var column = 0u; column < window; column++) { matrices[leaf + column] = lineCosts[costs + column]; }
${kernel === 'full' ? shiftRows : ''}}`
}

// JS: writeLineCosts on the GPU, one invocation per paragraph × break point, from lineStarts and lineEnds in positions and
// each paragraph's width. For the full kernel, also rows r >= 1 like leavesFromLineCostsShader.
export function leavesFromPositionsShader(kernel: Kernel, window: number, salt = 0): string {
  return `${header(window)}
@group(0) @binding(0) var<storage, read> positions: array<i32>;
@group(0) @binding(1) var<storage, read> widths: array<i32>;
@group(0) @binding(2) var<storage, read_write> matrices: array<u32>;
@group(0) @binding(3) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= shape.paragraphs * shape.breaks) { return; }
  let paragraph = id.x / shape.breaks;
  let to = i32(id.x % shape.breaks) + 1;
  let breaks = i32(shape.breaks);
  let base = i32(paragraph * 2u * shape.breaks);
  let end = positions[base + breaks + to - 1];
  let width = widths[paragraph];
  let leaf = id.x * area;
  for (var column = 0; column < i32(window); column++) {
    let start = to - 1 - column;
    let slack = width - (end - positions[base + max(start, 0)]);
    let capped = u32(clamp(slack, 0, ${slackLimit}));
    let fits = select(capped * capped, 0u, to == breaks);
    let overflows = select(${infeasible}u, ${lineCostCap}u, column == 0);
    matrices[leaf + u32(column)] = select(select(fits, overflows, slack < 0), noPath, start < 0);
  }
${kernel === 'full' ? shiftRows : ''}}`
}

// JS: s[1] = [M[1][0][0], 0, noPath, ...] for every paragraph.
export function firstStateShader(window: number, salt = 0): string {
  return `${header(window)}
@group(0) @binding(0) var<storage, read> matrices: array<u32>;
@group(0) @binding(1) var<storage, read_write> vectors: array<u32>;
@group(0) @binding(2) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= shape.paragraphs) { return; }
  let state = id.x * shape.breaks * window;
  vectors[state] = matrices[slotStart(shape, id.x, 0u)];
  vectors[state + 1u] = 0u;
  for (var row = 2u; row < window; row++) { vectors[state + row] = noPath; }
}`
}

// JS: out[p × (n + 1)] = s[n][0], and out[p × (n + 1) + to] = to - boxes for the smallest boxes of the smallest
// s[to - 1][boxes - 1] + M[to][0][boxes - 1], one invocation per paragraph × break point.
export function pointerShader(window: number, salt = 0): string {
  return `${header(window)}
@group(0) @binding(0) var<storage, read> matrices: array<u32>;
@group(0) @binding(1) var<storage, read> vectors: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
${saltLine(salt)}
  if (id.x >= shape.paragraphs * shape.breaks) { return; }
  let paragraph = id.x / shape.breaks;
  let to = id.x % shape.breaks + 1u;
  let outBase = paragraph * (shape.breaks + 1u);
  if (to == shape.breaks) { out[outBase] = vectors[(paragraph * shape.breaks + to - 1u) * window]; }
  if (to == 1u) {
    out[outBase + 1u] = 0u;
    return;
  }
  let state = (paragraph * shape.breaks + to - 2u) * window;
  let leaf = slotStart(shape, paragraph, to - 1u);
  var best = 0xffffffffu;
  var pointer = to - 1u;
  for (var boxes = 1u; boxes <= window; boxes++) {
    let total = vectors[state + boxes - 1u] + matrices[leaf + boxes - 1u];
    let better = total < best;
    best = select(best, total, better);
    pointer = select(pointer, to - boxes, better);
  }
  out[outBase + to] = pointer;
}`
}

// performance.now() times of one evaluation, in ms, from the first upload call to the end of backtracking.
export type EvaluationTiming = {
  // The writeBuffer calls, which return before the GPU has the data.
  uploadMs: number
  encodeAndSubmitMs: number
  // From submit to mapAsync resolving.
  waitMs: number
  // Copying the mapped values into a JavaScript array.
  copyMs: number
  // backtrackAll over every paragraph.
  backtrackMs: number
  totalMs: number
}
export type TimestampMode = 'none' | 'pass' | 'stages'
export type Evaluation = EvaluationTiming & {
  out: Uint32Array
  states: Uint32Array | undefined
  // From timestamp queries: the one compute pass that runs everything, or one pass per stage: the leaves and s[1], each
  // level, and the pointers.
  passMs: number | undefined
  stageMs: number[] | undefined
}
export type EvaluationInput = {kind: 'line-costs', lineCosts: Uint32Array} | {kind: 'positions', positions: Int32Array, widths: Int32Array} | {kind: 'widths', widths: Int32Array}

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

export type CompileTimes = Record<'matrixProductMs' | 'vectorProductMs' | 'leavesFromLineCostsMs' | 'leavesFromPositionsMs' | 'firstStateMs' | 'pointerMs', number>

export async function createGpuTree(device: GPUDevice, kernel: Kernel, window: number, runSalt = 0) {
  // The first state and pointer shaders have the same text for both kernels, so each kernel gets its own salt, and no
  // compile hits the cache of the other kernel's.
  const salt = runSalt * 2 + (kernel === 'full' ? 0 : 1)
  const matrixProduct = await checked(device, () => compile(device, matrixProductShader(kernel, window, salt)))
  const vectorProduct = await checked(device, () => compile(device, vectorProductShader(kernel, window, salt)))
  const leavesFromLineCosts = await checked(device, () => compile(device, leavesFromLineCostsShader(kernel, window, salt)))
  const leavesFromPositions = await checked(device, () => compile(device, leavesFromPositionsShader(kernel, window, salt)))
  const firstState = await checked(device, () => compile(device, firstStateShader(window, salt)))
  const pointer = await checked(device, () => compile(device, pointerShader(window, salt)))
  const compileTimes: CompileTimes = {
    matrixProductMs: matrixProduct.compileMs, vectorProductMs: vectorProduct.compileMs, leavesFromLineCostsMs: leavesFromLineCosts.compileMs,
    leavesFromPositionsMs: leavesFromPositions.compileMs, firstStateMs: firstState.compileMs, pointerMs: pointer.compileMs,
  }
  const workgroup = rowWorkgroup(window)
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension
  const hasTimestamps = device.features.has('timestamp-query')

  // readStates adds a readback buffer for every state, s[1..n] of every paragraph, which the check mode compares.
  async function prepare(plan: GpuPlan, paragraphs: number, {readStates = false} = {}) {
    const {breaks, productSlots, levels} = plan
    const area = window * window
    const matrixBytes = paragraphs * (breaks + productSlots) * area * 4
    invariant(matrixBytes <= device.limits.maxStorageBufferBindingSize, `the matrices need ${matrixBytes} bytes, above maxStorageBufferBindingSize`)
    const largestCount = Math.max(0, ...levels.map(level => Math.max(level.matrixCount, level.vectorCount)))
    invariant(Math.ceil(paragraphs * largestCount / workgroup.x) <= maxWorkgroups && Math.ceil(paragraphs * breaks / 256) <= maxWorkgroups, 'too many combines for one dispatch dimension')
    const buffers: GPUBuffer[] = []
    const buffer = (descriptor: GPUBufferDescriptor) => {
      const created = device.createBuffer(descriptor)
      buffers.push(created)
      return created
    }
    const bufferWith = (data: Uint32Array, usage: number) => {
      const created = buffer({size: Math.max(16, data.byteLength), usage, mappedAtCreation: true})
      new Uint8Array(created.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      created.unmap()
      return created
    }
    const outBytes = paragraphs * (breaks + 1) * 4
    const stateBytes = paragraphs * breaks * window * 4
    const prepared = await checked(device, () => {
      const matrices = buffer({size: matrixBytes, usage: GPUBufferUsage.STORAGE})
      const vectors = buffer({size: stateBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})
      const lineCosts = buffer({size: paragraphs * breaks * window * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const positions = buffer({size: paragraphs * 2 * breaks * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const widths = buffer({size: Math.max(16, paragraphs * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
      const out = buffer({size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})
      const outReadback = buffer({size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
      const statesReadback = readStates ? buffer({size: stateBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}) : undefined
      const matrixTriples = bufferWith(plan.matrixTriples.length === 0 ? new Uint32Array(matrixTripleSize) : plan.matrixTriples, GPUBufferUsage.STORAGE)
      const vectorTriples = bufferWith(plan.vectorTriples.length === 0 ? new Uint32Array(vectorTripleSize) : plan.vectorTriples, GPUBufferUsage.STORAGE)
      const shape = bufferWith(Uint32Array.of(paragraphs, breaks, productSlots, 0), GPUBufferUsage.UNIFORM)
      const levelBuffer = (offset: number, count: number) => bufferWith(Uint32Array.of(offset, count), GPUBufferUsage.UNIFORM)
      const group = (pipeline: GPUComputePipeline, resources: GPUBuffer[]) => device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({binding, resource: {buffer: resource}}))})
      const matrixGroups = levels.map(level => level.matrixCount === 0 ? undefined : group(matrixProduct.pipeline, [matrices, matrixTriples, shape, levelBuffer(level.matrixOffset, level.matrixCount)]))
      const vectorGroups = levels.map(level => level.vectorCount === 0 ? undefined : group(vectorProduct.pipeline, [matrices, vectors, vectorTriples, shape, levelBuffer(level.vectorOffset, level.vectorCount)]))
      const lineCostsGroup = group(leavesFromLineCosts.pipeline, [lineCosts, matrices, shape])
      const positionsGroup = group(leavesFromPositions.pipeline, [positions, widths, matrices, shape])
      const firstStateGroup = group(firstState.pipeline, [matrices, vectors, shape])
      const pointerGroup = group(pointer.pipeline, [matrices, vectors, out, shape])
      // Two timestamps per stage: the leaves and s[1], every level, and the pointers.
      const queryCount = 2 * (levels.length + 2)
      const querySet = hasTimestamps ? device.createQuerySet({type: 'timestamp', count: queryCount}) : undefined
      const queryResolve = buffer({size: 8 * queryCount, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC})
      const queryReadback = buffer({size: 8 * queryCount, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
      return {vectors, lineCosts, positions, widths, out, outReadback, statesReadback, matrixGroups, vectorGroups, lineCostsGroup, positionsGroup, firstStateGroup, pointerGroup, querySet, queryCount, queryResolve, queryReadback}
    })
    let positionsUploaded = false

    const encodeLeaves = (pass: GPUComputePassEncoder, fromLineCosts: boolean) => {
      pass.setPipeline(fromLineCosts ? leavesFromLineCosts.pipeline : leavesFromPositions.pipeline)
      pass.setBindGroup(0, fromLineCosts ? prepared.lineCostsGroup : prepared.positionsGroup)
      pass.dispatchWorkgroups(Math.ceil(paragraphs * breaks / 256))
      pass.setPipeline(firstState.pipeline)
      pass.setBindGroup(0, prepared.firstStateGroup)
      pass.dispatchWorkgroups(Math.ceil(paragraphs / 256))
    }
    const encodeLevel = (pass: GPUComputePassEncoder, index: number) => {
      const level = levels[index]!
      const matrixGroup = prepared.matrixGroups[index]
      if (matrixGroup !== undefined) {
        pass.setPipeline(matrixProduct.pipeline)
        pass.setBindGroup(0, matrixGroup)
        pass.dispatchWorkgroups(Math.ceil(paragraphs * level.matrixCount / workgroup.x), Math.ceil(window / workgroup.y))
      }
      const vectorGroup = prepared.vectorGroups[index]
      if (vectorGroup !== undefined) {
        pass.setPipeline(vectorProduct.pipeline)
        pass.setBindGroup(0, vectorGroup)
        pass.dispatchWorkgroups(Math.ceil(paragraphs * level.vectorCount / workgroup.x), Math.ceil(window / workgroup.y))
      }
    }
    const encodePointers = (pass: GPUComputePassEncoder) => {
      pass.setPipeline(pointer.pipeline)
      pass.setBindGroup(0, prepared.pointerGroup)
      pass.dispatchWorkgroups(Math.ceil(paragraphs * breaks / 256))
    }

    const breakPoints = new Int32Array(paragraphs * breaks)
    const lineCounts = new Int32Array(paragraphs)

    async function evaluate(input: EvaluationInput, {timestamps = 'none', withStates = false}: {timestamps?: TimestampMode, withStates?: boolean} = {}): Promise<Evaluation> {
      invariant(timestamps === 'none' || prepared.querySet !== undefined, 'this device has no timestamp queries')
      invariant(!withStates || prepared.statesReadback !== undefined, 'prepare with readStates to read the states back')
      const started = performance.now()
      if (input.kind === 'line-costs') {
        device.queue.writeBuffer(prepared.lineCosts, 0, input.lineCosts.buffer, input.lineCosts.byteOffset, input.lineCosts.byteLength)
      } else {
        if (input.kind === 'positions') {
          device.queue.writeBuffer(prepared.positions, 0, input.positions.buffer, input.positions.byteOffset, input.positions.byteLength)
          positionsUploaded = true
        }
        invariant(positionsUploaded, 'the widths input needs an earlier positions evaluation')
        device.queue.writeBuffer(prepared.widths, 0, input.widths.buffer, input.widths.byteOffset, input.widths.byteLength)
      }
      const uploaded = performance.now()
      const encoder = device.createCommandEncoder()
      const fromLineCosts = input.kind === 'line-costs'
      if (timestamps === 'stages') {
        const stage = (index: number, encode: (pass: GPUComputePassEncoder) => void) => {
          const pass = encoder.beginComputePass({timestampWrites: {querySet: prepared.querySet!, beginningOfPassWriteIndex: 2 * index, endOfPassWriteIndex: 2 * index + 1}})
          encode(pass)
          pass.end()
        }
        stage(0, pass => encodeLeaves(pass, fromLineCosts))
        levels.forEach((_, index) => stage(index + 1, pass => encodeLevel(pass, index)))
        stage(levels.length + 1, encodePointers)
      } else {
        const pass = encoder.beginComputePass(timestamps === 'pass' ? {timestampWrites: {querySet: prepared.querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1}} : {})
        encodeLeaves(pass, fromLineCosts)
        levels.forEach((_, index) => encodeLevel(pass, index))
        encodePointers(pass)
        pass.end()
      }
      encoder.copyBufferToBuffer(prepared.out, 0, prepared.outReadback, 0, outBytes)
      if (withStates) encoder.copyBufferToBuffer(prepared.vectors, 0, prepared.statesReadback!, 0, stateBytes)
      if (timestamps !== 'none') {
        encoder.resolveQuerySet(prepared.querySet!, 0, prepared.queryCount, prepared.queryResolve, 0)
        encoder.copyBufferToBuffer(prepared.queryResolve, 0, prepared.queryReadback, 0, 8 * prepared.queryCount)
      }
      device.queue.submit([encoder.finish()])
      const submitted = performance.now()
      await prepared.outReadback.mapAsync(GPUMapMode.READ, 0, outBytes)
      const mapped = performance.now()
      const result = new Uint32Array(prepared.outReadback.getMappedRange(0, outBytes).slice(0))
      prepared.outReadback.unmap()
      const copied = performance.now()
      backtrackAll(result, paragraphs, breaks, breakPoints, lineCounts)
      const finished = performance.now()
      let states: Uint32Array | undefined
      if (withStates) {
        await prepared.statesReadback!.mapAsync(GPUMapMode.READ, 0, stateBytes)
        states = new Uint32Array(prepared.statesReadback!.getMappedRange(0, stateBytes).slice(0))
        prepared.statesReadback!.unmap()
      }
      let passMs: number | undefined
      let stageMs: number[] | undefined
      if (timestamps !== 'none') {
        await prepared.queryReadback.mapAsync(GPUMapMode.READ, 0, 8 * prepared.queryCount)
        const times = new BigUint64Array(prepared.queryReadback.getMappedRange(0, 8 * prepared.queryCount).slice(0))
        prepared.queryReadback.unmap()
        const between = (begin: number) => Number(times[begin + 1]! - times[begin]!) / 1e6
        if (timestamps === 'pass') passMs = between(0)
        else stageMs = Array.from({length: levels.length + 2}, (_, index) => between(2 * index))
      }
      return {uploadMs: uploaded - started, encodeAndSubmitMs: submitted - uploaded, waitMs: mapped - submitted, copyMs: copied - mapped, backtrackMs: finished - copied, totalMs: finished - started, out: result, states, passMs, stageMs}
    }

    return {
      evaluate,
      matrixMegabytes: matrixBytes / 1e6,
      destroy() {
        for (const created of buffers) created.destroy()
        prepared.querySet?.destroy()
      },
    }
  }

  return {compileTimes, hasTimestamps, prepare}
}
