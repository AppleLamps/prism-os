// WGSL emission with guards chosen per row. A copy of codegen's emitInstanceWgsl
// (copies/codegen/wgsl.ts) whose max(x, lowest) guards can go on every row, on
// no row, or only on rounding points.
//
// codegen measured that Apple's Metal compiler, through wgpu and Dawn, fuses
// multiply-adds, regroups sums, and folds (x + K) - K, and that wrapping a value
// in max(x, lowest), with lowest loaded from a buffer, stops all three. With
// guard 'max', every inexact product and partial sum is wrapped.
//
// - 'none': parentheses keep each row's grouping, and nothing stops the compiler.
// - 'max': codegen's guard on every inexact product and partial sum.
// - 'rounding points': the same guards, but only inside rows the interpreter
//   marks as rounding points (boolean atoms, round chains, sign tests, and the
//   rows between them and the comparison difference).
// - 'rounding points and inputs': also one guard around the final value of every
//   row a rounding point reads, so the compiler can't regroup an input's own sum
//   into the rounding point's sum.
import {invariant} from '../../../numeric-ui-core.ts'
import type {Term, ValueRow} from './copies/codegen/codegen.ts'
import type {InstancePlan} from './copies/codegen/instance.ts'
import {lowestFloat32, wgslFloat, type WgslExposure, type WgslModule} from './copies/codegen/wgsl.ts'

export type RoundingGuard = 'none' | 'max' | 'rounding points' | 'rounding points and inputs'
export const roundingGuards: readonly RoundingGuard[] = ['none', 'max', 'rounding points', 'rounding points and inputs']

export type RoundingWgslModule = WgslModule & {roundingGuard: RoundingGuard, guardedRows: number, inputBarriers: number}

function isPowerOfTwo(weight: number) {
  const magnitude = Math.abs(weight)
  return magnitude > 0 && Math.log2(magnitude) === Math.round(Math.log2(magnitude))
}

// isRoundingPosition: 1 at each packed position whose row is a rounding point.
export function emitRoundingWgsl(plan: InstancePlan, guard: RoundingGuard, isRoundingPosition: Uint8Array, workgroupSize = 64): RoundingWgslModule {
  invariant(isRoundingPosition.length === plan.flat.valueCount, 'rounding flags must cover every packed position')
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
  // Positions read by some per-instance rounding point.
  const roundingInputs = new Set<number>()
  if (guard === 'rounding points and inputs') {
    for (const step of plan.instanceSteps) {
      if (step.kind !== 'row' || isRoundingPosition[step.row.position] !== 1) continue
      for (const term of [...step.row.terms, ...step.row.gateTerms]) roundingInputs.add(term.position)
      for (const candidate of step.row.candidates) roundingInputs.add(candidate)
    }
  }
  let guardRow = false
  let guardedRows = 0
  let inputBarriers = 0
  const guarded = (text: string) => {
    if (!guardRow) return `(${text})`
    exposure.guards++
    return `max(${text}, lowest)`
  }
  const barrier = (text: string) => {
    exposure.guards++
    inputBarriers++
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
    guardRow = guard === 'max' || (guard !== 'none' && isRoundingPosition[row.position] === 1)
    if (guardRow && guard !== 'max') guardedRows++
    const finish = (text: string) => roundingInputs.has(row.position) && isRoundingPosition[row.position] !== 1 ? barrier(text) : text
    switch (row.kind) {
      case 'affine':
        body.push(`let ${target}: f32 = ${finish(sum(row.bias, row.terms))};`)
        break
      case 'reglu': {
        const gate = `max(0.0f, ${sum(row.gateBias, row.gateTerms)})`
        const leftIsOne = row.terms.length === 0 && row.bias === 1
        body.push(`let ${target}: f32 = ${finish(leftIsOne ? gate : product(sum(row.bias, row.terms), gate))};`)
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
          return finish(addition(wgslFloat(row.bias), '+', row.masked ? product(slotMass(row.slot), selected) : selected))
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
    guard: guard === 'none' ? 'none' : 'max',
    roundingGuard: guard,
    guardedRows,
    inputBarriers,
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

export {lowestFloat32}
