// Instance-parallel evaluation: one compiled circuit evaluated over N
// instances, e.g. every pixel of a canvas, every cell of a grid, or hundreds of
// viewport widths, without copying its operations N times.
//
// The source table splits into instance cells, which differ per instance (a
// pixel's x and y), and shared cells, which are the same for every instance
// (window geometry, the pointer). A live value that reads no instance cell,
// directly or indirectly, is shared: it's computed once. Everything else is
// computed once per instance. This is how a shader separates uniforms from
// per-fragment values, and how a compiler hoists loop-invariant code.
//
// Two backends run the per-instance part over blocks of instances:
// - generated JS, instance-major: each generated function loops over the
//   block's instances and runs its statements for one instance at a time;
// - a batched executor, value-major: an interpreter that visits each row once
//   per block and loops over the block's instances inside, so the cost of
//   interpreting a row is paid once per block instead of once per instance.
// Both keep the executor's FP32 accumulation order for every instance.
import {invariant, type Wire} from '../../../../../numeric-ui-core.ts'
import {
  type FlatProgram,
  type GatherCompute,
  type GeneratedFunction,
  type RowReaders,
  type Step,
  type TensorProgram,
  type Term,
  type ValueRow,
  flattenProgram,
  gatherIndexExpression,
  gatherMassExpression,
  generateScalarModule,
  rowValueExpression,
} from './codegen.ts'

export type InstancePlan = {
  flat: FlatProgram
  // Source cells that differ per instance, in per-instance column order.
  instanceSources: number[]
  // Per packed position: 1 when the value differs per instance.
  isInstance: Uint8Array
  // Per packed position: the column in a per-instance table, or -1 for shared values.
  instanceColumn: Int32Array
  // Per-instance columns: instance sources first, then per-instance live values.
  instanceWidth: number
  slotIsInstance: Uint8Array
  // Gather slot to per-instance slot index, or -1 for shared slots.
  instanceSlot: Int32Array
  instanceSlotCount: number
  sharedSteps: Step[]
  instanceSteps: Step[]
  // Packed positions of the requested per-instance outputs.
  outputs: number[]
  counts: {
    sharedRows: number
    instanceRows: number
    sharedWeights: number
    instanceWeights: number
    // Longest chain of per-instance rows: the depth a per-layer parallel
    // backend would need for the per-instance part.
    instanceLayers: number
  }
}

function stepInputs(row: ValueRow): number[] {
  const inputs: number[] = []
  for (const term of row.terms) inputs.push(term.position)
  for (const term of row.gateTerms) inputs.push(term.position)
  for (const candidate of row.candidates) inputs.push(candidate)
  return inputs
}

export function planInstances(program: TensorProgram, instanceSourceWires: readonly Wire[], outputWires: readonly Wire[]): InstancePlan {
  const flat = flattenProgram(program)
  const isInstance = new Uint8Array(flat.valueCount)
  const instanceColumn = new Int32Array(flat.valueCount).fill(-1)
  const depth = new Int32Array(flat.valueCount)
  let instanceWidth = 0
  for (const wire of instanceSourceWires) {
    invariant(Number.isInteger(wire) && wire >= 0 && wire < flat.sourceSize, 'instance cells must be source cells')
    invariant(isInstance[wire] === 0, 'instance cells must be distinct')
    isInstance[wire] = 1
    instanceColumn[wire] = instanceWidth++
  }
  const slotIsInstance = new Uint8Array(flat.gatherSlotCount)
  const instanceSlot = new Int32Array(flat.gatherSlotCount).fill(-1)
  const slotDepth = new Int32Array(flat.gatherSlotCount)
  let instanceSlotCount = 0
  const sharedSteps: Step[] = []
  const instanceSteps: Step[] = []
  const counts = {sharedRows: 0, instanceRows: 0, sharedWeights: 0, instanceWeights: 0, instanceLayers: 0}
  for (const step of flat.steps) {
    if (step.kind === 'gatherCompute') {
      const {compute} = step
      if (compute.bits.some(position => isInstance[position] === 1)) {
        slotIsInstance[compute.slot] = 1
        instanceSlot[compute.slot] = instanceSlotCount++
        slotDepth[compute.slot] = Math.max(0, ...compute.bits.map(position => depth[position]!))
        instanceSteps.push(step)
      } else {
        sharedSteps.push(step)
      }
      continue
    }
    const {row} = step
    const inputs = stepInputs(row)
    const readsInstanceSlot = row.kind === 'gather' && slotIsInstance[row.slot] === 1
    const weights = row.terms.length + row.gateTerms.length
    if (readsInstanceSlot || inputs.some(position => isInstance[position] === 1)) {
      isInstance[row.position] = 1
      instanceColumn[row.position] = instanceWidth++
      let rowDepth = readsInstanceSlot ? slotDepth[row.slot]! : 0
      for (const position of inputs) rowDepth = Math.max(rowDepth, depth[position]!)
      depth[row.position] = rowDepth + 1
      counts.instanceLayers = Math.max(counts.instanceLayers, rowDepth + 1)
      instanceSteps.push(step)
      counts.instanceRows++
      counts.instanceWeights += weights
    } else {
      sharedSteps.push(step)
      counts.sharedRows++
      counts.sharedWeights += weights
    }
  }
  const outputs = outputWires.map(wire => {
    const position = flat.positionOfWire[wire]!
    invariant(position >= 0, 'output wire is not live in the compiled program')
    return position
  })
  return {
    flat,
    instanceSources: [...instanceSourceWires],
    isInstance,
    instanceColumn,
    instanceWidth,
    slotIsInstance,
    instanceSlot,
    instanceSlotCount,
    sharedSteps,
    instanceSteps,
    outputs,
    counts,
  }
}

// ----- Generated JS, instance-major -----

export type InstanceCodeOptions = {
  rowsPerFunction: number
  // Instances per block. Per-instance values of one block live in one buffer
  // of blockSize × instanceWidth values.
  blockSize: number
}

export type InstanceModule = {
  sharedSource: string
  sharedTables: Int32Array[]
  instanceSource: string
  instanceTables: Int32Array[]
  instanceFunctionCount: number
}

export function generateInstanceModule(plan: InstancePlan, options: InstanceCodeOptions): InstanceModule {
  const shared = generateScalarModule(plan.sharedSteps, {rowsPerFunction: options.rowsPerFunction})
  const width = plan.instanceWidth
  const slots = Math.max(1, plan.instanceSlotCount)
  const sourceCount = plan.instanceSources.length
  const outputCount = plan.outputs.length
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
  const loadStatements = plan.instanceSources.map((_, column) => `v[o + ${column}] = src[b + ${column}]`)
  const storeStatements = plan.outputs.map((position, output) => plan.isInstance[position] === 1
    ? `out[b + ${output}] = v[o + ${plan.instanceColumn[position]}]`
    : `out[b + ${output}] = s[${position}]`)
  const source = [
    '"use strict"',
    'const f = Math.fround',
    ...tables.map((_, index) => `const T${index} = T[${index}]`),
    `function load(v, n, src, start) {\nfor (let i = 0, o = 0, b = start * ${sourceCount}; i < n; i++, o += ${width}, b += ${sourceCount}) {\n${loadStatements.join('\n')}\n}\n}`,
    `function store(v, s, n, out, start) {\nfor (let i = 0, o = 0, b = start * ${outputCount}; i < n; i++, o += ${width}, b += ${outputCount}) {\n${storeStatements.join('\n')}\n}\n}`,
    `return {load, store, functions: [\n${functions.join(',\n')}\n]}`,
  ].join('\n')
  return {
    sharedSource: shared.source,
    sharedTables: shared.tables,
    instanceSource: source,
    instanceTables: tables,
    instanceFunctionCount: functions.length,
  }
}

type InstanceFunction = (
  v: Float32Array, s: Float32Array, n: number,
  gi: Int32Array, gm: Float32Array, sgi: Int32Array, sgm: Float32Array,
) => void

export type InstanceRunner = {
  plan: InstancePlan
  // Shared values at their packed positions (instance positions are unused).
  shared: Float32Array
  sharedGatherIndices: Int32Array
  sharedGatherMasses: Float32Array
  runShared: (source: Float32Array) => void
  // instanceSources holds count × instanceSources.length cells; outputs
  // receives count × outputs.length values.
  runInstances: (instanceSources: Float32Array, count: number, outputs: Float32Array) => void
  // A per-instance value of the last block run, for tests.
  lastBlockValue: (instanceInBlock: number, position: number) => number
  sourceBytes: number
  compileMilliseconds: number
}

export function compileInstanceProgram(plan: InstancePlan, options: InstanceCodeOptions): InstanceRunner {
  const module = generateInstanceModule(plan, options)
  const compileStart = performance.now()
  const sharedFunctions = new Function('T', module.sharedSource)(module.sharedTables) as GeneratedFunction[]
  const instance = new Function('T', module.instanceSource)(module.instanceTables) as {
    load: (v: Float32Array, n: number, src: Float32Array, start: number) => void
    store: (v: Float32Array, s: Float32Array, n: number, out: Float32Array, start: number) => void
    functions: InstanceFunction[]
  }
  const compileMilliseconds = performance.now() - compileStart
  const blockSize = options.blockSize
  const width = plan.instanceWidth
  const slots = Math.max(1, plan.instanceSlotCount)
  const shared = new Float32Array(plan.flat.valueCount)
  const sharedGatherIndices = new Int32Array(Math.max(1, plan.flat.gatherSlotCount))
  const sharedGatherMasses = new Float32Array(Math.max(1, plan.flat.gatherSlotCount))
  const block = new Float32Array(width * blockSize)
  const blockGatherIndices = new Int32Array(slots * blockSize)
  const blockGatherMasses = new Float32Array(slots * blockSize)
  const {load, store, functions} = instance
  const functionCount = functions.length
  return {
    plan,
    shared,
    sharedGatherIndices,
    sharedGatherMasses,
    sourceBytes: module.sharedSource.length + module.instanceSource.length,
    compileMilliseconds,
    runShared(source) {
      invariant(source.length === plan.flat.sourceSize, 'source table has the wrong length')
      shared.set(source)
      for (let index = 0; index < sharedFunctions.length; index++) sharedFunctions[index]!(shared, sharedGatherIndices, sharedGatherMasses)
    },
    runInstances(instanceSources, count, outputs) {
      invariant(instanceSources.length >= count * plan.instanceSources.length, 'instance source table is too short')
      invariant(outputs.length >= count * plan.outputs.length, 'instance output table is too short')
      for (let start = 0; start < count; start += blockSize) {
        const n = Math.min(blockSize, count - start)
        load(block, n, instanceSources, start)
        for (let index = 0; index < functionCount; index++) {
          functions[index]!(block, shared, n, blockGatherIndices, blockGatherMasses, sharedGatherIndices, sharedGatherMasses)
        }
        store(block, shared, n, outputs, start)
      }
    },
    lastBlockValue(instanceInBlock, position) {
      return plan.isInstance[position] === 1 ? block[instanceInBlock * width + plan.instanceColumn[position]!]! : shared[position]!
    },
  }
}

// ----- Batched executor, value-major -----

type EncodedTerms = {weights: Float64Array, codes: Int32Array}

// A code >= 0 is a per-instance column; a code < 0 is the shared packed
// position -1 - code.
function encodeTerms(plan: InstancePlan, terms: readonly Term[]): EncodedTerms {
  return {
    weights: Float64Array.from(terms, term => term.weight),
    codes: Int32Array.from(terms, term => plan.isInstance[term.position] === 1 ? plan.instanceColumn[term.position]! : -1 - term.position),
  }
}

function encodePosition(plan: InstancePlan, position: number) {
  return plan.isInstance[position] === 1 ? plan.instanceColumn[position]! : -1 - position
}

type EncodedStep =
  | {kind: 'row', row: ValueRow, column: number, left: EncodedTerms, gate: EncodedTerms, candidates: Int32Array}
  | {kind: 'gatherCompute', slot: number, bits: Int32Array}

// The shared part, interpreted once per evaluation over packed positions.
export function runStepsOnce(steps: readonly Step[], values: Float32Array, gatherIndices: Int32Array, gatherMasses: Float32Array) {
  for (const step of steps) {
    if (step.kind === 'gatherCompute') {
      const {compute} = step
      let index = 0
      let mass = 0
      for (let bitIndex = 0; bitIndex < compute.bits.length; bitIndex++) {
        const bit = values[compute.bits[bitIndex]!]!
        index += bitIndex * bit
        mass += bit
      }
      gatherIndices[compute.slot] = index
      gatherMasses[compute.slot] = mass
      continue
    }
    const {row} = step
    const accumulate = (bias: number, terms: readonly Term[]) => {
      let value = bias
      for (const term of terms) value = Math.fround(value + Math.fround(term.weight * values[term.position]!))
      return value
    }
    let value = accumulate(row.bias, row.terms)
    if (row.kind === 'reglu') {
      value = Math.fround(value * Math.max(0, accumulate(row.gateBias, row.gateTerms)))
    } else if (row.kind === 'boolean') {
      value = Math.fround(Math.fround(value + 8388609) - 8388609)
    } else if (row.kind === 'gather') {
      const index = Math.min(Math.max(gatherIndices[row.slot]!, 0), row.candidates.length - 1)
      let contribution = values[row.candidates[index]!]!
      if (row.masked) contribution = Math.fround(gatherMasses[row.slot]! * contribution)
      value = Math.fround(value + contribution)
    }
    values[row.position] = value
  }
}

export function createBatchedExecutor(plan: InstancePlan, blockSize: number): InstanceRunner {
  const width = plan.instanceWidth
  const sourceCount = plan.instanceSources.length
  const outputCount = plan.outputs.length
  const values = new Float32Array(width * blockSize)
  const gate = new Float32Array(blockSize)
  const indexScratch = new Float64Array(blockSize)
  const massScratch = new Float64Array(blockSize)
  const slots = Math.max(1, plan.instanceSlotCount)
  const gatherIndices = new Int32Array(slots * blockSize)
  const gatherMasses = new Float32Array(slots * blockSize)
  const shared = new Float32Array(plan.flat.valueCount)
  const sharedGatherIndices = new Int32Array(Math.max(1, plan.flat.gatherSlotCount))
  const sharedGatherMasses = new Float32Array(Math.max(1, plan.flat.gatherSlotCount))
  const encoded: EncodedStep[] = plan.instanceSteps.map(step => step.kind === 'gatherCompute'
    ? {kind: 'gatherCompute', slot: plan.instanceSlot[step.compute.slot]!, bits: Int32Array.from(step.compute.bits, position => encodePosition(plan, position))}
    : {
        kind: 'row',
        row: step.row,
        column: plan.instanceColumn[step.row.position]!,
        left: encodeTerms(plan, step.row.terms),
        gate: encodeTerms(plan, step.row.gateTerms),
        candidates: Int32Array.from(step.row.candidates, position => encodePosition(plan, position)),
      })
  const outputCodes = Int32Array.from(plan.outputs, position => encodePosition(plan, position))

  function accumulate(target: Float32Array, base: number, n: number, bias: number, terms: EncodedTerms) {
    target.fill(bias, base, base + n)
    const {weights, codes} = terms
    for (let term = 0; term < codes.length; term++) {
      const weight = weights[term]!
      const code = codes[term]!
      if (code < 0) {
        const product = Math.fround(weight * shared[-1 - code]!)
        for (let i = 0; i < n; i++) target[base + i] = target[base + i]! + product
      } else {
        const input = code * blockSize
        if (weight === 1) {
          for (let i = 0; i < n; i++) target[base + i] = target[base + i]! + values[input + i]!
        } else if (weight === -1) {
          for (let i = 0; i < n; i++) target[base + i] = target[base + i]! - values[input + i]!
        } else {
          for (let i = 0; i < n; i++) target[base + i] = target[base + i]! + Math.fround(weight * values[input + i]!)
        }
      }
    }
  }

  function runBlock(n: number) {
    for (const step of encoded) {
      if (step.kind === 'gatherCompute') {
        indexScratch.fill(0, 0, n)
        massScratch.fill(0, 0, n)
        for (let bitIndex = 0; bitIndex < step.bits.length; bitIndex++) {
          const code = step.bits[bitIndex]!
          if (code < 0) {
            const bit = shared[-1 - code]!
            for (let i = 0; i < n; i++) {
              indexScratch[i] = indexScratch[i]! + bitIndex * bit
              massScratch[i] = massScratch[i]! + bit
            }
          } else {
            const input = code * blockSize
            for (let i = 0; i < n; i++) {
              const bit = values[input + i]!
              indexScratch[i] = indexScratch[i]! + bitIndex * bit
              massScratch[i] = massScratch[i]! + bit
            }
          }
        }
        const base = step.slot * blockSize
        for (let i = 0; i < n; i++) {
          gatherIndices[base + i] = indexScratch[i]!
          gatherMasses[base + i] = massScratch[i]!
        }
        continue
      }
      const {row, column, left, candidates} = step
      const base = column * blockSize
      switch (row.kind) {
        case 'affine':
          accumulate(values, base, n, row.bias, left)
          break
        case 'reglu':
          accumulate(values, base, n, row.bias, left)
          accumulate(gate, 0, n, row.gateBias, step.gate)
          for (let i = 0; i < n; i++) values[base + i] = values[base + i]! * Math.max(0, gate[i]!)
          break
        case 'boolean':
          accumulate(values, base, n, row.bias, left)
          for (let i = 0; i < n; i++) values[base + i] = Math.fround(values[base + i]! + 8388609) - 8388609
          break
        case 'gather': {
          const limit = candidates.length - 1
          if (plan.slotIsInstance[row.slot] === 0) {
            const index = Math.min(Math.max(sharedGatherIndices[row.slot]!, 0), limit)
            const mass = sharedGatherMasses[row.slot]!
            const code = candidates[index]!
            if (code < 0) {
              const selected = shared[-1 - code]!
              values.fill(row.bias + (row.masked ? Math.fround(mass * selected) : selected), base, base + n)
            } else {
              const input = code * blockSize
              for (let i = 0; i < n; i++) {
                const selected = values[input + i]!
                values[base + i] = row.bias + (row.masked ? Math.fround(mass * selected) : selected)
              }
            }
          } else {
            const slotBase = plan.instanceSlot[row.slot]! * blockSize
            for (let i = 0; i < n; i++) {
              const code = candidates[Math.min(Math.max(gatherIndices[slotBase + i]!, 0), limit)]!
              const selected = code < 0 ? shared[-1 - code]! : values[code * blockSize + i]!
              values[base + i] = row.bias + (row.masked ? Math.fround(gatherMasses[slotBase + i]! * selected) : selected)
            }
          }
          break
        }
      }
    }
  }

  return {
    plan,
    shared,
    sharedGatherIndices,
    sharedGatherMasses,
    sourceBytes: 0,
    compileMilliseconds: 0,
    runShared(source) {
      invariant(source.length === plan.flat.sourceSize, 'source table has the wrong length')
      shared.set(source)
      runStepsOnce(plan.sharedSteps, shared, sharedGatherIndices, sharedGatherMasses)
    },
    runInstances(instanceSources, count, outputs) {
      invariant(instanceSources.length >= count * sourceCount, 'instance source table is too short')
      invariant(outputs.length >= count * outputCount, 'instance output table is too short')
      for (let start = 0; start < count; start += blockSize) {
        const n = Math.min(blockSize, count - start)
        for (let column = 0; column < sourceCount; column++) {
          const base = column * blockSize
          for (let i = 0; i < n; i++) values[base + i] = instanceSources[(start + i) * sourceCount + column]!
        }
        runBlock(n)
        for (let output = 0; output < outputCount; output++) {
          const code = outputCodes[output]!
          if (code < 0) {
            const value = shared[-1 - code]!
            for (let i = 0; i < n; i++) outputs[(start + i) * outputCount + output] = value
          } else {
            const base = code * blockSize
            for (let i = 0; i < n; i++) outputs[(start + i) * outputCount + output] = values[base + i]!
          }
        }
      }
    },
    lastBlockValue(instanceInBlock, position) {
      return plan.isInstance[position] === 1 ? values[plan.instanceColumn[position]! * blockSize + instanceInBlock]! : shared[position]!
    },
  }
}

// The source table of one instance: shared cells with the instance cells replaced.
export function instanceSourceTable(plan: InstancePlan, sharedSource: Float32Array, instanceSources: Float32Array, instance: number) {
  const source = new Float32Array(sharedSource)
  const width = plan.instanceSources.length
  plan.instanceSources.forEach((wire, column) => {
    source[wire] = instanceSources[instance * width + column]!
  })
  return source
}

export type {GatherCompute}
