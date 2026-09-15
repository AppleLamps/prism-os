// WGSL emission for an instance program: one compute shader invocation per
// instance, one `let` per per-instance value.
//
// FP32 guarantees a GPU shader compiler can break, what was measured on this
// machine (Apple GPU, Metal) through wgpu (Deno 1.42) and Dawn (Node `webgpu`
// 0.6.1), and what this emitter does about each:
// - Contraction: `a + w * x` became a fused multiply-add on both stacks, in one
//   expression, with the product in a `let`, and with the product stored in a
//   `var`. Adding a runtime zero, `a + (w * x + zero)`, didn't help either.
// - Reordering sums: in the probe shader at the end of this file, `(c + a) + b`
//   kept its written order on both stacks, as one expression, with a `let`,
//   and with a `var`. In a second probe shader with different surrounding code
//   (the scratch script probe-barriers.ts named in README.md), `(3.25f + a) + b`,
//   `(a + 3.25f) + b`, and `(k + a) + b` with k loaded from a buffer all came
//   back as `(a + b)` plus the third value, on both stacks. So whether a sum
//   keeps its written order depends on the code around it, and the emitter
//   can't rely on it.
// - Folding the boolean atom: `(score + 8388609) - 8388609` came back as
//   `score` on both stacks, in every form. The same folding removes the
//   rounding in `round(x) = (x + 2^23 + 2^22) - (2^23 + 2^22)`.
// - What worked on both stacks: wrapping a result in `max(x, lowest)`, where
//   `lowest` is -3.4028235e38 loaded from the shared buffer. The compiler can't
//   prove the max is the identity, so neither fusion nor reordering reaches
//   across it, and for every finite x the max returns x unchanged. With
//   guard: 'max' the emitter wraps every inexact product and every partial sum.
// - Booleans are emitted as `select(0.0f, 1.0f, score >= 0.5f)`, which equals
//   the atom for every score in 0..1, the only range the builder accepts.
// - Constant folding in 64-bit precision: WGSL evaluates abstract-float
//   constant expressions at shader creation. Every literal here is a single
//   f32 hexadecimal literal with the exact bits, and no expression combines
//   two literals.
// - NaN and infinities: WGSL lets implementations assume they don't occur, and
//   `max` with a NaN operand isn't pinned down. Results only match where the
//   CPU reference has no NaN or Infinity. Signed zeros may also differ, which
//   never changes a nonzero result of these atoms.
import {invariant} from '../../../../../numeric-ui-core.ts'
import type {Term, ValueRow} from './codegen.ts'
import type {InstancePlan, InstanceRunner} from './instance.ts'

export const lowestFloat32 = -3.4028234663852886e38

export function wgslFloat(value: number): string {
  invariant(Number.isFinite(value), 'WGSL literals must be finite')
  invariant(Object.is(Math.fround(value), value), 'WGSL literals must already be float32 values')
  if (Object.is(value, -0)) return '(-0.0f)'
  if (Number.isInteger(value) && Math.abs(value) < 2 ** 24) return value < 0 ? `(${value}.0f)` : `${value}.0f`
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  const bits = view.getUint32(0)
  const negative = bits >>> 31 === 1
  const exponentBits = (bits >>> 23) & 0xff
  const fraction = ((bits & 0x7fffff) << 1).toString(16).padStart(6, '0')
  const magnitude = exponentBits === 0 ? `0x0.${fraction}p-126f` : `0x1.${fraction}p${exponentBits - 127}f`
  return negative ? `(-${magnitude})` : magnitude
}

function isPowerOfTwo(weight: number) {
  const magnitude = Math.abs(weight)
  return magnitude > 0 && Math.log2(magnitude) === Math.round(Math.log2(magnitude))
}

export type WgslExposure = {
  // Multiplications whose exact result may not fit in f32: a weight that isn't
  // a power of two, a ReGLU product, a masked gather read.
  inexactProducts: number
  // Additions and subtractions of two runtime values.
  additions: number
  // max(x, lowest) wrappers emitted.
  guards: number
  booleanRows: number
  gatherReads: number
}

export type Guard = 'none' | 'max'

export type WgslModule = {
  code: string
  workgroupSize: number
  guard: Guard
  // The shared buffer holds the packed shared values, then each gather slot's
  // mass, then each gather slot's index (exact small integers as f32), then
  // the lowest float32 value for the guards.
  sharedLength: number
  massOffset: number
  indexOffset: number
  lowestOffset: number
  instanceSourceCount: number
  outputCount: number
  statementCount: number
  exposure: WgslExposure
}

export type WgslOptions = {workgroupSize?: number, guard?: Guard}

export function emitInstanceWgsl(plan: InstancePlan, options: WgslOptions = {}): WgslModule {
  const workgroupSize = options.workgroupSize ?? 64
  const guard = options.guard ?? 'max'
  const sourceCount = plan.instanceSources.length
  const outputCount = plan.outputs.length
  const valueCount = plan.flat.valueCount
  const slotCount = plan.flat.gatherSlotCount
  const massOffset = valueCount
  const indexOffset = valueCount + slotCount
  const lowestOffset = valueCount + 2 * slotCount
  const hoisted = new Set<number>()
  const hoistedSlots = new Set<number>()
  const exposure: WgslExposure = {inexactProducts: 0, additions: 0, guards: 0, booleanRows: 0, gatherReads: 0}
  const body: string[] = []
  const guarded = (text: string) => {
    // Without the guard, parentheses keep the grouping the rows need, e.g. a
    // ReGLU product of a sum stays (a + b) * gate instead of a + b * gate.
    if (guard === 'none') return `(${text})`
    exposure.guards++
    return `max(${text}, lowest)`
  }
  const product = (left: string, right: string) => {
    exposure.inexactProducts++
    return guarded(`${left} * ${right}`)
  }
  const addition = (left: string, operator: '+' | '-', right: string) => {
    exposure.additions++
    return guarded(`${left} ${operator} ${right}`)
  }
  const name = (position: number) => {
    if (plan.isInstance[position] === 1) return `v${plan.instanceColumn[position]}`
    hoisted.add(position)
    return `s${position}`
  }
  const term = (value: Term) => {
    if (value.weight === 1) return name(value.position)
    // A power-of-two product is exact, so fusing it into a sum changes nothing.
    if (isPowerOfTwo(value.weight)) return `(${wgslFloat(value.weight)} * ${name(value.position)})`
    return product(wgslFloat(value.weight), name(value.position))
  }
  const sum = (bias: number, terms: readonly Term[]) => {
    if (terms.length === 0) return wgslFloat(bias)
    const first = terms[0]!
    let text = bias === 0
      ? first.weight === -1 ? `(-${name(first.position)})` : term(first)
      : addition(wgslFloat(bias), '+', term(first))
    for (let index = 1; index < terms.length; index++) {
      const next = terms[index]!
      text = next.weight === -1 ? addition(text, '-', name(next.position)) : addition(text, '+', term(next))
    }
    return text
  }
  const slotIndex = (slot: number) => {
    if (plan.slotIsInstance[slot] === 1) return `gi${plan.instanceSlot[slot]}`
    hoistedSlots.add(slot)
    return `sgi${slot}`
  }
  const slotMass = (slot: number) => {
    if (plan.slotIsInstance[slot] === 1) return `gm${plan.instanceSlot[slot]}`
    hoistedSlots.add(slot)
    return `sgm${slot}`
  }
  const rowStatements = (row: ValueRow) => {
    const target = `v${plan.instanceColumn[row.position]}`
    switch (row.kind) {
      case 'affine':
        body.push(`let ${target}: f32 = ${sum(row.bias, row.terms)};`)
        break
      case 'reglu': {
        const gate = `max(0.0f, ${sum(row.gateBias, row.gateTerms)})`
        const leftIsOne = row.terms.length === 0 && row.bias === 1
        body.push(`let ${target}: f32 = ${leftIsOne ? gate : product(sum(row.bias, row.terms), gate)};`)
        break
      }
      case 'boolean':
        exposure.booleanRows++
        body.push(`let ${target}: f32 = select(0.0f, 1.0f, ${sum(row.bias, row.terms)} >= 0.5f);`)
        break
      case 'gather': {
        exposure.gatherReads++
        const limit = row.candidates.length - 1
        const contribution = (index: number) => {
          const selected = name(row.candidates[index]!)
          return addition(wgslFloat(row.bias), '+', row.masked ? product(slotMass(row.slot), selected) : selected)
        }
        body.push(`var ${target}: f32;`)
        body.push(`switch (clamp(${slotIndex(row.slot)}, 0i, ${limit}i)) {`)
        for (let index = 0; index < limit; index++) body.push(`case ${index}i: { ${target} = ${contribution(index)}; }`)
        body.push(`default: { ${target} = ${contribution(limit)}; }`)
        body.push('}')
        break
      }
    }
  }
  plan.instanceSources.forEach((_, column) => body.push(`let v${column}: f32 = instance_sources[source_base + ${column}u];`))
  for (const step of plan.instanceSteps) {
    if (step.kind === 'gatherCompute') {
      // Index and mass sums of exact bits are exact small integers, so no guard.
      const {compute} = step
      const slot = plan.instanceSlot[compute.slot]
      const indexTerms = compute.bits.map((position, bitIndex) => `(${bitIndex}.0f * ${name(position)})`)
      const massTerms = compute.bits.map(position => name(position))
      body.push(`let gi${slot}: i32 = i32(${indexTerms.join(' + ')});`)
      body.push(`let gm${slot}: f32 = ${massTerms.join(' + ')};`)
      continue
    }
    rowStatements(step.row)
  }
  plan.outputs.forEach((position, output) => body.push(`instance_outputs[output_base + ${output}u] = ${name(position)};`))
  const hoistedLines = [
    `let lowest: f32 = shared_values[${lowestOffset}u];`,
    ...[...hoisted].sort((left, right) => left - right).map(position => `let s${position}: f32 = shared_values[${position}u];`),
    ...[...hoistedSlots].sort((left, right) => left - right).flatMap(slot => [
      `let sgi${slot}: i32 = i32(shared_values[${indexOffset + slot}u]);`,
      `let sgm${slot}: f32 = shared_values[${massOffset + slot}u];`,
    ]),
  ]
  const code = [
    'struct Params {',
    '  count: u32,',
    '  pad0: u32,',
    '  pad1: u32,',
    '  pad2: u32,',
    '}',
    '@group(0) @binding(0) var<uniform> params: Params;',
    '@group(0) @binding(1) var<storage, read> shared_values: array<f32>;',
    '@group(0) @binding(2) var<storage, read> instance_sources: array<f32>;',
    '@group(0) @binding(3) var<storage, read_write> instance_outputs: array<f32>;',
    '',
    `@compute @workgroup_size(${workgroupSize})`,
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    'let i: u32 = id.x;',
    'if (i >= params.count) {',
    'return;',
    '}',
    // Static uses keep every binding in the automatic pipeline layout.
    '_ = arrayLength(&shared_values);',
    '_ = arrayLength(&instance_sources);',
    `let source_base: u32 = i * ${sourceCount}u;`,
    `let output_base: u32 = i * ${outputCount}u;`,
    ...hoistedLines,
    ...body,
    '}',
    '',
  ].join('\n')
  return {
    code,
    workgroupSize,
    guard,
    sharedLength: lowestOffset + 1,
    massOffset,
    indexOffset,
    lowestOffset,
    instanceSourceCount: sourceCount,
    outputCount,
    statementCount: body.length,
    exposure,
  }
}

// Copy a runner's shared values and shared gather slots into the layout the
// shader reads.
export function packSharedBuffer(module: WgslModule, runner: Pick<InstanceRunner, 'shared' | 'sharedGatherIndices' | 'sharedGatherMasses'>, target = new Float32Array(module.sharedLength)) {
  target.set(runner.shared.subarray(0, module.massOffset))
  const slotCount = module.indexOffset - module.massOffset
  for (let slot = 0; slot < slotCount; slot++) {
    target[module.massOffset + slot] = runner.sharedGatherMasses[slot]!
    target[module.indexOffset + slot] = runner.sharedGatherIndices[slot]!
  }
  target[module.lowestOffset] = lowestFloat32
  return target
}

// ----- Probes for contraction, reordering and atom folding -----

export type ProbeForm = 'one expression' | 'let' | 'var' | 'runtime zero' | 'max guard'

export type ProbeCase = {
  kind: 'contraction' | 'reordering' | 'boolean atom'
  form: ProbeForm
  inputs: [number, number, number]
  // What strict per-operation FP32 rounding gives.
  expected: number
  // What the optimized form would give.
  optimized: number
}

// Exact a + w · x rounded once to f32. Every finite double is an integer times
// a power of two, so the exact sum is an integer numerator over a power of two
// and can be reduced to 60 significant bits plus a sticky bit before rounding.
function fusedMultiplyAdd(a: number, w: number, x: number) {
  const decompose = (value: number) => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    const high = view.getUint32(0)
    const low = view.getUint32(4)
    const sign = high >>> 31 === 1 ? -1n : 1n
    const exponent = (high >>> 20) & 0x7ff
    let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
    if (exponent !== 0) mantissa |= 1n << 52n
    return {mantissa: sign * mantissa, exponent: (exponent === 0 ? 1 : exponent) - 1075}
  }
  const left = decompose(a)
  const factor = decompose(w)
  const operand = decompose(x)
  const productMantissa = factor.mantissa * operand.mantissa
  const productExponent = factor.exponent + operand.exponent
  const exponent = Math.min(left.exponent, productExponent)
  const numerator = left.mantissa * (1n << BigInt(left.exponent - exponent)) + productMantissa * (1n << BigInt(productExponent - exponent))
  let shifted = numerator < 0n ? -numerator : numerator
  let shift = 0
  let sticky = 0n
  while (shifted >= 1n << 60n) {
    sticky |= shifted & 1n
    shifted >>= 1n
    shift++
  }
  const approximate = Number(shifted | sticky) * 2 ** (exponent + shift)
  return Math.fround(numerator < 0n ? -approximate : approximate)
}

const f = Math.fround

export function probeCases(): ProbeCase[] {
  const contraction: Omit<ProbeCase, 'form'>[] = []
  let state = 12345
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 4294967296
  }
  while (contraction.length < 8) {
    const a = f(random() * 64)
    const w = f(random() * 2 + 0.1)
    const x = f(random() * 64)
    const expected = f(a + f(w * x))
    const optimized = fusedMultiplyAdd(a, w, x)
    if (expected !== optimized) contraction.push({kind: 'contraction', inputs: [a, w, x], expected, optimized})
  }
  // Written (c + a) + b; the compilers measured here compute (a + b) + c.
  const reordering: Omit<ProbeCase, 'form'>[] = [
    {kind: 'reordering', inputs: [1e8, -1e8, 3.25], expected: f(f(3.25 + 1e8) - 1e8), optimized: 3.25},
    {kind: 'reordering', inputs: [16_777_216, -16_777_216, 1], expected: f(f(1 + 16_777_216) - 16_777_216), optimized: 1},
  ]
  const atom: Omit<ProbeCase, 'form'>[] = [
    {kind: 'boolean atom', inputs: [0.25, 0, 0], expected: 0, optimized: 0.25},
    {kind: 'boolean atom', inputs: [0.75, 0, 0], expected: 1, optimized: 0.75},
  ]
  return [
    ...(['one expression', 'let', 'var', 'runtime zero', 'max guard'] as const).flatMap(form => contraction.map(probe => ({...probe, form}))),
    ...(['one expression', 'let', 'var', 'max guard'] as const).flatMap(form => reordering.map(probe => ({...probe, form}))),
    ...(['one expression', 'let', 'var', 'max guard'] as const).flatMap(form => atom.map(probe => ({...probe, form}))),
  ]
}

export function probeKindCode(probe: Pick<ProbeCase, 'kind' | 'form'>) {
  const forms: readonly ProbeForm[] = ['one expression', 'let', 'var', 'runtime zero', 'max guard']
  const formIndex = forms.indexOf(probe.form)
  if (probe.kind === 'contraction') return formIndex
  const reducedIndex = probe.form === 'max guard' ? 3 : formIndex
  return (probe.kind === 'reordering' ? 5 : 9) + reducedIndex
}

// One invocation per probe case; each writes one result. The inputs buffer
// ends with a runtime zero and the lowest float32 value.
export const probeShader = [
  '@group(0) @binding(0) var<storage, read> probe_inputs: array<f32>;',
  '@group(0) @binding(1) var<storage, read> probe_kinds: array<u32>;',
  '@group(0) @binding(2) var<storage, read_write> probe_outputs: array<f32>;',
  '@compute @workgroup_size(1)',
  'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
  'let i: u32 = id.x;',
  'if (i >= arrayLength(&probe_kinds)) {',
  'return;',
  '}',
  'let a: f32 = probe_inputs[i * 3u];',
  'let b: f32 = probe_inputs[i * 3u + 1u];',
  'let c: f32 = probe_inputs[i * 3u + 2u];',
  'let zero: f32 = probe_inputs[arrayLength(&probe_inputs) - 2u];',
  'let lowest: f32 = probe_inputs[arrayLength(&probe_inputs) - 1u];',
  'var result: f32 = 0.0f;',
  'switch (probe_kinds[i]) {',
  'case 0u: { result = a + b * c; }',
  'case 1u: { let product: f32 = b * c; result = a + product; }',
  'case 2u: { var product: f32 = b * c; result = a + product; }',
  'case 3u: { result = a + (b * c + zero); }',
  'case 4u: { result = a + max(b * c, lowest); }',
  'case 5u: { result = (c + a) + b; }',
  'case 6u: { let partial: f32 = c + a; result = partial + b; }',
  'case 7u: { var partial: f32 = c + a; result = partial + b; }',
  'case 8u: { result = max(c + a, lowest) + b; }',
  'case 9u: { result = (a + 8388609.0f) - 8388609.0f; }',
  'case 10u: { let shifted: f32 = a + 8388609.0f; result = shifted - 8388609.0f; }',
  'case 11u: { var shifted: f32 = a + 8388609.0f; result = shifted - 8388609.0f; }',
  'default: { result = max(a + 8388609.0f, lowest) - 8388609.0f; }',
  '}',
  'probe_outputs[i] = result;',
  '}',
  '',
].join('\n')

export function probeInputs(cases: readonly ProbeCase[]) {
  return Float32Array.from([...cases.flatMap(probe => probe.inputs), 0, lowestFloat32])
}
