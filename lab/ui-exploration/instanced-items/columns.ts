// Generated JS for one map stage over struct-of-arrays columns. This is
// codegen's generated instance loop (lab/ui-exploration/codegen/instance.ts)
// with a different load and store: per-instance sources come from one
// Float32Array per field, and outputs go to one Float32Array per field, so
// stages hand fields to each other without packing tables.
import {invariant} from '../../../numeric-ui-core.ts'
import {type GeneratedFunction, type RowReaders, type ValueRow, gatherIndexExpression, gatherMassExpression, generateScalarModule, rowValueExpression} from '../codegen/codegen.ts'
import type {InstancePlan} from '../codegen/instance.ts'

export type ColumnCodeOptions = {rowsPerFunction: number, blockSize: number}

export function generateColumnInstanceModule(plan: InstancePlan, options: {rowsPerFunction: number}) {
  const shared = generateScalarModule(plan.sharedSteps, {rowsPerFunction: options.rowsPerFunction})
  const width = plan.instanceWidth
  const slots = Math.max(1, plan.instanceSlotCount)
  const tables: Int32Array[] = []
  const functions: string[] = []
  let lines: string[] = []
  let rowsInCurrent = 0
  let hoisted = new Set<number>()
  let hoistedSlots = new Set<number>()
  const candidateCodes = (row: ValueRow) => row.candidates.map(position =>
    plan.isInstance[position] === 1 ? plan.instanceColumn[position]! : -1 - position)
  const tableByRow = new Map<ValueRow, string>()
  const readers: RowReaders = {
    read: position => {
      if (plan.isInstance[position] === 1) return `v[o + ${plan.instanceColumn[position]}]`
      hoisted.add(position)
      return `s${position}`
    },
    gatherIndex: slot => {
      if (plan.slotIsInstance[slot] === 1) return `gi[g + ${plan.instanceSlot[slot]}]`
      hoistedSlots.add(slot)
      return `sgi${slot}`
    },
    gatherMass: slot => {
      if (plan.slotIsInstance[slot] === 1) return `gm[g + ${plan.instanceSlot[slot]}]`
      hoistedSlots.add(slot)
      return `sgm${slot}`
    },
    candidate: (row, clamped) => {
      const table = tableByRow.get(row)!
      const codes = candidateCodes(row)
      if (codes.every(code => code >= 0)) return `v[o + ${table}[${clamped}]]`
      if (codes.every(code => code < 0)) return `s[-1 - ${table}[${clamped}]]`
      return `(${table}[${clamped}] >= 0 ? v[o + ${table}[${clamped}]] : s[-1 - ${table}[${clamped}]])`
    },
    fround: 'f',
  }
  const flush = () => {
    if (lines.length === 0) return
    const hoistedLines = [
      ...[...hoisted].map(position => `const s${position} = s[${position}]`),
      ...[...hoistedSlots].map(slot => `const sgi${slot} = sgi[${slot}], sgm${slot} = sgm[${slot}]`),
    ]
    functions.push([
      `function instance${functions.length}(v, s, n, gi, gm, sgi, sgm) {`,
      ...hoistedLines,
      `for (let i = 0, o = 0, g = 0; i < n; i++, o += ${width}, g += ${slots}) {`,
      ...lines,
      '}',
      '}',
    ].join('\n'))
    lines = []
    rowsInCurrent = 0
    hoisted = new Set()
    hoistedSlots = new Set()
  }
  for (const step of plan.instanceSteps) {
    if (step.kind === 'gatherCompute') {
      const {compute} = step
      const slot = plan.instanceSlot[compute.slot]
      lines.push(`gi[g + ${slot}] = ${gatherIndexExpression(compute, readers.read)}`)
      lines.push(`gm[g + ${slot}] = ${gatherMassExpression(compute, readers.read)}`)
      continue
    }
    const {row} = step
    if (row.kind === 'gather') {
      tableByRow.set(row, `T${tables.length}`)
      tables.push(Int32Array.from(candidateCodes(row)))
    }
    lines.push(`v[o + ${plan.instanceColumn[row.position]}] = ${rowValueExpression(row, readers)}`)
    rowsInCurrent++
    if (rowsInCurrent === options.rowsPerFunction) flush()
  }
  flush()
  const inputNames = plan.instanceSources.map((_, column) => `C${column}`)
  const outputNames = plan.outputs.map((_, output) => `O${output}`)
  const load = [
    'function load(v, n, C, start) {',
    ...inputNames.map((name, column) => `const ${name} = C[${column}]`),
    `for (let i = 0, o = 0, b = start; i < n; i++, o += ${width}, b++) {`,
    ...inputNames.map((name, column) => `v[o + ${column}] = ${name}[b]`),
    '}',
    '}',
  ].join('\n')
  const store = [
    'function store(v, s, n, O, start) {',
    ...outputNames.map((name, output) => `const ${name} = O[${output}]`),
    `for (let i = 0, o = 0, b = start; i < n; i++, o += ${width}, b++) {`,
    ...plan.outputs.map((position, output) => plan.isInstance[position] === 1
      ? `${outputNames[output]}[b] = v[o + ${plan.instanceColumn[position]}]`
      : `${outputNames[output]}[b] = s[${position}]`),
    '}',
    '}',
  ].join('\n')
  const source = [
    '"use strict"',
    'const f = Math.fround',
    ...tables.map((_, index) => `const T${index} = T[${index}]`),
    load,
    store,
    `return {load, store, functions: [\n${functions.join(',\n')}\n]}`,
  ].join('\n')
  return {sharedSource: shared.source, sharedTables: shared.tables, instanceSource: source, instanceTables: tables, instanceFunctionCount: functions.length}
}

type InstanceFunction = (v: Float32Array, s: Float32Array, n: number, gi: Int32Array, gm: Float32Array, sgi: Int32Array, sgm: Float32Array) => void

export type ColumnInstanceRunner = ReturnType<typeof compileColumnInstanceProgram>

export function compileColumnInstanceProgram(plan: InstancePlan, options: ColumnCodeOptions) {
  const module = generateColumnInstanceModule(plan, options)
  const compileStart = performance.now()
  const sharedFunctions = new Function('T', module.sharedSource)(module.sharedTables) as GeneratedFunction[]
  const instance = new Function('T', module.instanceSource)(module.instanceTables) as {
    load: (v: Float32Array, n: number, columns: readonly Float32Array[], start: number) => void
    store: (v: Float32Array, s: Float32Array, n: number, columns: readonly Float32Array[], start: number) => void
    functions: InstanceFunction[]
  }
  const compileMilliseconds = performance.now() - compileStart
  const {blockSize} = options
  const width = Math.max(1, plan.instanceWidth)
  const slots = Math.max(1, plan.instanceSlotCount)
  const shared = new Float32Array(plan.flat.valueCount)
  const sharedGatherIndices = new Int32Array(Math.max(1, plan.flat.gatherSlotCount))
  const sharedGatherMasses = new Float32Array(Math.max(1, plan.flat.gatherSlotCount))
  const block = new Float32Array(width * blockSize)
  const blockGatherIndices = new Int32Array(slots * blockSize)
  const blockGatherMasses = new Float32Array(slots * blockSize)
  const {load, store, functions} = instance
  return {
    plan,
    shared,
    sharedGatherIndices,
    sharedGatherMasses,
    instanceFunctionCount: functions.length,
    sourceBytes: module.sharedSource.length + module.instanceSource.length,
    compileMilliseconds,
    runShared(source: Float32Array) {
      invariant(source.length === plan.flat.sourceSize, 'source table has the wrong length')
      shared.set(source)
      for (let index = 0; index < sharedFunctions.length; index++) sharedFunctions[index]!(shared, sharedGatherIndices, sharedGatherMasses)
    },
    runColumns(inputs: readonly Float32Array[], count: number, outputs: readonly Float32Array[]) {
      invariant(inputs.length === plan.instanceSources.length && outputs.length === plan.outputs.length, 'column counts don\'t match the plan')
      for (let start = 0; start < count; start += blockSize) {
        const n = Math.min(blockSize, count - start)
        load(block, n, inputs, start)
        for (let index = 0; index < functions.length; index++) {
          functions[index]!(block, shared, n, blockGatherIndices, blockGatherMasses, sharedGatherIndices, sharedGatherMasses)
        }
        store(block, shared, n, outputs, start)
      }
    },
  }
}
