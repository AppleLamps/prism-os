// A WebGPU device for tests without a GPU: the part of WebGPU that gpu/host.ts calls, with a compute pass that runs
// the shader's text through wgsl-interpreter.ts. So `createGpuSearcher(createInterpretedDevice(), texts)` runs under
// `bun test` as it runs in a page: the same shader text, the same buffers and parameters, the words that the runner
// packs at each upload, and the same readbacks.
//
// What it doesn't say: what a GPU's compiler does with a shader, e.g. whether it fuses a product into a sum, and how
// long anything takes. The runs in headless Chrome check the first, see gpu/combined-run.ts and gpu/review-run.ts.
// What it leaves out: timestamp queries, and the errors that a real device reports, e.g. a buffer that is too large,
// except the one that a test asks for with `refusedBindGroup`. Its error scopes are WebGPU's: one stack per device,
// an error goes to the nearest scope of its kind, and a pop takes the newest scope. A buffer here is plain memory, a
// submitted pass runs at once, one document after the other, and a mapped range is a copy, as in WebGPU.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type WgslInterpreter, createWgslInterpreter} from './wgsl-interpreter.ts'

type FakeBuffer = {
  size: number
  bytes: ArrayBuffer
  getMappedRange: (offset?: number, size?: number) => ArrayBuffer
  mapAsync: () => Promise<void>
  unmap: () => void
  destroy: () => void
}
type Pipeline = {interpret: WgslInterpreter, bindings: Map<number, string>, getBindGroupLayout: () => object}
type BindGroup = {buffers: Map<number, FakeBuffer>}
type Command =
  | {kind: 'pass', pipeline: Pipeline, bindGroup: BindGroup}
  | {kind: 'copy', source: FakeBuffer, sourceOffset: number, target: FakeBuffer, targetOffset: number, size: number}

function createBuffer({size, mappedAtCreation = false}: {size: number, mappedAtCreation?: boolean}): FakeBuffer {
  const bytes = new ArrayBuffer(size)
  // The ranges that are mapped for writing, which `unmap` copies into the buffer.
  let written: {offset: number, range: ArrayBuffer}[] = []
  let writing = mappedAtCreation
  return {
    size, bytes,
    getMappedRange(offset = 0, length = size - offset) {
      const range = bytes.slice(offset, offset + length)
      if (writing) written.push({offset, range})
      return range
    },
    mapAsync: () => Promise.resolve(),
    unmap() {
      for (const {offset, range} of written) new Uint8Array(bytes).set(new Uint8Array(range), offset)
      written = []
      writing = false
    },
    destroy() {},
  }
}

// Which buffer each binding of a shader is, by its name in the shader's text, e.g. 3 for instance_outputs_0.
function bindingsOf(code: string) {
  const bindings = new Map<number, string>()
  for (const [, binding, name] of code.matchAll(/@group\(0\) @binding\((\d+)\) var<[^>]+> (\w+):/g)) bindings.set(Number(binding), name!)
  return bindings
}

function runPass({interpret, bindings}: Pipeline, {buffers}: BindGroup) {
  const named = new Map<string, FakeBuffer>()
  for (const [binding, name] of bindings) {
    const buffer = buffers.get(binding)
    invariant(buffer !== undefined, `the bind group has no buffer for ${name}`)
    named.set(name, buffer)
  }
  const floats = (name: string) => new Float32Array(named.get(name)!.bytes)
  const numbered = (prefix: string) => [...named.keys()].filter(name => name.startsWith(prefix)).sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length))).map(floats)
  const [count, windowFirst, windowCount, first] = new Uint32Array(named.get('params')!.bytes)
  const packed = named.get('packed_words')
  interpret(floats('shared_values'), floats('instance_sources'), count!, numbered('instance_outputs_'), {
    inputs: numbered('instance_inputs_'), window: {first: windowFirst!, count: windowCount!}, first: first!,
    ...(packed === undefined ? {} : {packed: new Uint32Array(packed.bytes)}),
  })
}

// `refusedBindGroup` is the number of a bind group, counted from 0 in the order of their creation, that the device
// refuses with a validation error, as a GPU refuses one that doesn't fit its shader's layout. Only an error scope
// reports that.
export function createInterpretedDevice(options: {refusedBindGroup?: number} = {}): GPUDevice {
  const scopes: {filter: string, error: {message: string} | null}[] = []
  let bindGroups = 0
  const device = {
    // WebGPU's default for a buffer, and what an Apple M5 Max's adapter allows for a binding.
    limits: {maxStorageBufferBindingSize: 4_294_967_292, maxBufferSize: 4_294_967_296, maxComputeWorkgroupsPerDimension: 65_535},
    features: new Set<string>(),
    pushErrorScope(filter: string) {
      scopes.push({filter, error: null})
    },
    popErrorScope() {
      const scope = scopes.pop()
      return scope === undefined ? Promise.reject(new Error('popErrorScope on a device without an error scope')) : Promise.resolve(scope.error)
    },
    createBuffer,
    createShaderModule: ({code}: {code: string}) => ({code, getCompilationInfo: () => Promise.resolve({messages: []})}),
    createComputePipelineAsync({compute}: {compute: {module: {code: string}}}): Promise<Pipeline> {
      return Promise.resolve({interpret: createWgslInterpreter(compute.module.code), bindings: bindingsOf(compute.module.code), getBindGroupLayout: () => ({})})
    },
    createBindGroup({entries}: {entries: {binding: number, resource: {buffer: FakeBuffer}}[]}): BindGroup {
      const number = bindGroups++
      if (number === options.refusedBindGroup) {
        // The newest validation scope keeps its first error. Without such a scope, a GPU fires `uncapturederror`.
        const scope = scopes.findLast(candidate => candidate.filter === 'validation')
        invariant(scope !== undefined, 'a refused bind group is created inside a validation scope')
        scope.error ??= {message: `bind group ${number} doesn't fit its shader's layout`}
      }
      return {buffers: new Map(entries.map(entry => [entry.binding, entry.resource.buffer]))}
    },
    createCommandEncoder() {
      const commands: Command[] = []
      return {
        beginComputePass() {
          const pass: {pipeline?: Pipeline, bindGroup?: BindGroup} = {}
          return {
            setPipeline(pipeline: Pipeline) {
              pass.pipeline = pipeline
            },
            setBindGroup(_index: number, bindGroup: BindGroup) {
              pass.bindGroup = bindGroup
            },
            // Every workgroup's invocations past the document count return at once, so the count alone says what runs.
            dispatchWorkgroups() {
              invariant(pass.pipeline !== undefined && pass.bindGroup !== undefined, 'a pass has a pipeline and a bind group')
              commands.push({kind: 'pass', pipeline: pass.pipeline, bindGroup: pass.bindGroup})
            },
            end() {},
          }
        },
        copyBufferToBuffer(source: FakeBuffer, sourceOffset: number, target: FakeBuffer, targetOffset: number, size: number) {
          commands.push({kind: 'copy', source, sourceOffset, target, targetOffset, size})
        },
        finish: () => commands,
      }
    },
    queue: {
      // `data` is an ArrayBuffer with an offset and a size in bytes, or a typed array, which is written whole.
      writeBuffer(buffer: FakeBuffer, bufferOffset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
        const source = data instanceof ArrayBuffer ? new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        invariant(bufferOffset + source.length <= buffer.size, 'a write lies within its buffer')
        new Uint8Array(buffer.bytes).set(source, bufferOffset)
      },
      submit(commandBuffers: Command[][]) {
        for (const command of commandBuffers.flat()) {
          if (command.kind === 'pass') runPass(command.pipeline, command.bindGroup)
          else new Uint8Array(command.target.bytes).set(new Uint8Array(command.source.bytes, command.sourceOffset, command.size), command.targetOffset)
        }
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  }
  // Only the calls of gpu/host.ts are here, so the object stands in for a device in tests and nowhere else.
  return device as unknown as GPUDevice
}
