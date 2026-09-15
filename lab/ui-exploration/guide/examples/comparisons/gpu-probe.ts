// Runs the sign cascade and a rounding stage as WGSL compute shaders on the GPU, with no guards, over
// the same classes of FP32 differences as the other examples, and compares each result with the CPU.
// Not part of `bun test`: it needs WebGPU. From the repo root:
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/guide/examples/comparisons/gpu-probe.ts
// Measured through Deno 1.42.4 (wgpu, which translates WGSL to Metal) on an Apple GPU.
import {createRandom, differenceClasses, largestFinite, smallestNormal} from './fp32.ts'
import {type CascadePlan, planSignCascade} from './sign-cascade.ts'

const f = Math.fround

// WebGPU's flag constants, read at runtime; the TypeScript DOM library declares the interfaces but
// not these globals.
type BufferUsageFlags = {STORAGE: number, COPY_DST: number, COPY_SRC: number, MAP_READ: number}
const bufferUsage = (globalThis as unknown as {GPUBufferUsage: BufferUsageFlags}).GPUBufferUsage
const mapModeRead = (globalThis as unknown as {GPUMapMode: {READ: number}}).GPUMapMode.READ

function hexPowerOfTwo(value: number) {
  const exponent = Math.log2(value)
  if (!Number.isInteger(exponent)) throw new Error(`not a power of two: ${value}`)
  return `0x1p${exponent}f`
}

// One WGSL `let` per operation, in the same layout as emitPositiveBit.
function cascadeStatements(name: string, plan: CascadePlan) {
  const statements: string[] = []
  let previous = 'd'
  plan.stages.forEach(({scale, limit}, index) => {
    const scaled = `(${hexPowerOfTwo(scale)} * ${previous})`
    statements.push(`let ${name}_above${index}: f32 = max(0.0f, -${hexPowerOfTwo(limit)} + ${scaled});`)
    if (index === 0) {
      statements.push(`let ${name}_positive0: f32 = max(0.0f, ${scaled});`)
      statements.push(`let ${name}_clamped0: f32 = ${name}_positive0 - ${name}_above0;`)
    } else {
      statements.push(`let ${name}_clamped${index}: f32 = ${scaled} - ${name}_above${index};`)
    }
    previous = `${name}_clamped${index}`
  })
  return {statements, output: previous}
}

const boundedPlan = planSignCascade({differenceBound: 16384})
const fullPlan = planSignCascade({differenceBound: largestFinite})
const bounded = cascadeStatements('bounded', boundedPlan)
const full = cascadeStatements('full', fullPlan)

const shader = `
@group(0) @binding(0) var<storage, read> inputs: array<f32>;
@group(0) @binding(1) var<storage, read_write> outputs: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let count = arrayLength(&inputs) - 1u;
  let index = id.x;
  if (index >= count) { return; }
  let lowest: f32 = inputs[count];
  let d: f32 = inputs[index];
  ${bounded.statements.join('\n  ')}
  ${full.statements.join('\n  ')}
  let score: f32 = max(0.0f, 0x1.fffffep-2f + (256.0f * d)) - max(0.0f, -0.5f + (256.0f * d));
  let atomUnguarded: f32 = (score + 8388609.0f) - 8388609.0f;
  let atomGuarded: f32 = max(score + 8388609.0f, lowest) - 8388609.0f;
  let base = index * 8u;
  outputs[base] = ${bounded.output};
  outputs[base + 1u] = ${full.output};
  outputs[base + 2u] = atomUnguarded;
  outputs[base + 3u] = atomGuarded;
  outputs[base + 4u] = select(0.0f, 1.0f, d > 0.0f);
  outputs[base + 5u] = d * 0x1p100f;
  outputs[base + 6u] = max(0.0f, d) * 0x1p10f;
  outputs[base + 7u] = d + d;
}
`

// A rounding stage with scale 2^8, evaluated on the CPU the way the reference evaluator does.
function roundingStageOnCpu(difference: number) {
  const scaled = f(256 * difference)
  const score = f(Math.max(0, f(f(0.5 - 2 ** -25) + scaled)) - Math.max(0, f(-0.5 + scaled)))
  return f(f(score + 8388609) - 8388609)
}

const classes = differenceClasses(largestFinite, createRandom(5), 20000)
const differences = classes.flatMap(({values}) => values)
const inputs = Float32Array.from([...differences, -3.4028234663852886e38])

const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})
if (adapter === null) throw new Error('no GPU adapter')
const device = await adapter.requestDevice()
device.pushErrorScope('validation')
const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code: shader}), entryPoint: 'main'}})
const validationError = await device.popErrorScope()
if (validationError !== null) throw new Error(validationError.message)
const inputBuffer = device.createBuffer({size: inputs.byteLength, usage: bufferUsage.STORAGE | bufferUsage.COPY_DST})
const outputSize = differences.length * 8 * 4
const outputBuffer = device.createBuffer({size: outputSize, usage: bufferUsage.STORAGE | bufferUsage.COPY_SRC})
const readback = device.createBuffer({size: outputSize, usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST})
device.queue.writeBuffer(inputBuffer, 0, inputs)
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{binding: 0, resource: {buffer: inputBuffer}}, {binding: 1, resource: {buffer: outputBuffer}}],
})
const encoder = device.createCommandEncoder()
const pass = encoder.beginComputePass()
pass.setPipeline(pipeline)
pass.setBindGroup(0, bindGroup)
pass.dispatchWorkgroups(Math.ceil(differences.length / 64))
pass.end()
encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputSize)
device.queue.submit([encoder.finish()])
await readback.mapAsync(mapModeRead)
const results = new Float32Array(readback.getMappedRange().slice(0))
readback.unmap()

const summary: Record<string, Record<string, string>> = {}
const subnormalExamples: Record<string, number>[] = []
let offset = 0
for (const {label, values} of classes) {
  let boundedTested = 0
  let boundedWrong = 0
  let fullWrong = 0
  let fullWrongSubnormal = 0
  let subnormals = 0
  let unguardedDiffers = 0
  let guardedDiffers = 0
  let nativeWrong = 0
  values.forEach((difference, index) => {
    const base = (offset + index) * 8
    const expected = difference > 0 ? 1 : 0
    const subnormal = difference !== 0 && Math.abs(difference) < smallestNormal
    if (subnormal) subnormals++
    if (results[base + 4] !== expected) nativeWrong++
    if (results[base + 1] !== expected) {
      fullWrong++
      if (subnormal) fullWrongSubnormal++
    }
    if (Math.abs(difference) <= 16384) {
      boundedTested++
      if (results[base] !== expected) boundedWrong++
      const cpu = roundingStageOnCpu(difference)
      if (results[base + 2] !== cpu) unguardedDiffers++
      if (results[base + 3] !== cpu) guardedDiffers++
    }
    if (label === 'subnormal' && difference > 0) {
      subnormalExamples.push({
        difference,
        'GPU d > 0': results[base + 4]!,
        'GPU d * 2^100': results[base + 5]!,
        'CPU d * 2^100': f(difference * 2 ** 100),
        'GPU d + d': results[base + 7]!,
        'CPU d + d': f(difference + difference),
      })
    }
  })
  offset += values.length
  summary[label] = {
    'native d > 0, wrong': `${nativeWrong}/${values.length}`,
    'cascade bounded by 2^14, wrong': `${boundedWrong}/${boundedTested}`,
    'cascade bounded by 2^128, wrong': `${fullWrong}/${values.length}, of which ${fullWrongSubnormal} of ${subnormals} subnormal differences`,
    'rounding stage without guard, differs from CPU': `${unguardedDiffers}/${boundedTested}`,
    'rounding stage with max guard, differs from CPU': `${guardedDiffers}/${boundedTested}`,
  }
}
console.log(JSON.stringify({boundedStages: boundedPlan.stages.length, fullStages: fullPlan.stages.length, summary, subnormalExamples}, null, 2))
