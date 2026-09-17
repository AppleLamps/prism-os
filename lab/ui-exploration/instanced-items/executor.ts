// The staged executor: shared stages as generated JS, map stages as generated
// JS with an instance loop over struct-of-arrays columns, and reductions as
// plain loops that take the FP32 steps staged.ts states for each fold order.
import {invariant, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {type GeneratedFunction, flattenProgram, generateScalarModule} from '../codegen/codegen.ts'
import {type ColumnInstanceRunner, compileColumnInstanceProgram} from './columns.ts'
import {type InstancePlan, planInstances} from '../codegen/instance.ts'
import {type Reduction, type StageInfo, type StagedProgram, type Value} from './staged.ts'

const f = Math.fround

export type MapStageContext = {
  stage: StageInfo
  plan: InstancePlan
  count: number
  // The stage's source table. fillSharedSources writes its shared cells; instance cells stay 0.
  sourceTable: Float32Array
  // One column per per-instance source, in plan.instanceSources order.
  inputColumns: readonly Float32Array[]
  // One column per output, in plan.outputs order.
  outputColumns: readonly Float32Array[]
  // The generated JS for this stage: runShared evaluates the part that reads no instance cell.
  cpu: ColumnInstanceRunner
  fillSharedSources: () => void
  runCpu: () => void
}

export type ExecutorOptions = {
  rowsPerFunction?: number
  blockSize?: number
  // Replace a map stage's runner, e.g. with a GPU dispatch. Returning null keeps the generated JS.
  mapStage?: (context: MapStageContext) => (() => void | Promise<void>) | null
}

export type StepTiming = {name: string, kind: string, milliseconds: number}

export type StagedExecutor = ReturnType<typeof createExecutor>

export function createExecutor(program: StagedProgram, options: ExecutorOptions = {}) {
  const rowsPerFunction = options.rowsPerFunction ?? 128
  const blockSize = options.blockSize ?? 1024
  const {values} = program
  const sharedSlot = new Int32Array(values.length).fill(-1)
  let sharedCount = 0
  for (const info of values) if (info.axis === 'shared') sharedSlot[info.id] = sharedCount++
  const shared = new Float32Array(sharedCount)
  const columns: (Float32Array | null)[] = values.map(info => info.axis === 'shared' ? null : new Float32Array(program.count(info.axis)))
  for (const info of values) if (info.producer.kind === 'constant') columns[info.id]!.set(info.producer.values)
  const column = (id: number) => {
    const stored = columns[id]
    invariant(stored !== null && stored !== undefined, `${values[id]!.name} isn't a field`)
    return stored
  }
  const slot = (id: number) => {
    const position = sharedSlot[id]!
    invariant(position >= 0, `${values[id]!.name} isn't a shared value`)
    return position
  }
  let compileMilliseconds = 0
  let functionCount = 0

  const compileStage = (stage: StageInfo): (() => void | Promise<void>) => {
    const roots = program.stageRoots(stage)
    if (roots.length === 0) return () => {}
    const compiled = stage.circuit.compileTensorProgram(roots)
    const valueOfWire = new Map<Wire, number>(stage.outputs.map(output => [output.wire, output.value]))
    if (stage.kind === 'shared') {
      const flat = flattenProgram(compiled)
      const module = generateScalarModule(flat.steps, {rowsPerFunction})
      const start = performance.now()
      const functions = new Function('T', module.source)(module.tables) as GeneratedFunction[]
      compileMilliseconds += performance.now() - start
      functionCount += functions.length
      const packed = new Float32Array(compiled.valueCount)
      const gatherIndices = new Int32Array(Math.max(1, compiled.gatherSlotCount))
      const gatherMasses = new Float32Array(Math.max(1, compiled.gatherSlotCount))
      const inputSlots = Int32Array.from(stage.sourceValues, id => slot(id))
      const outputPositions = Int32Array.from(roots, wire => flat.positionOfWire[wire]!)
      const outputSlots = Int32Array.from(roots, wire => slot(valueOfWire.get(wire)!))
      return () => {
        for (let wire = 0; wire < inputSlots.length; wire++) packed[wire] = shared[inputSlots[wire]!]!
        for (let index = 0; index < functions.length; index++) functions[index]!(packed, gatherIndices, gatherMasses)
        for (let output = 0; output < outputSlots.length; output++) shared[outputSlots[output]!] = packed[outputPositions[output]!]!
      }
    }
    const instanceSources: Wire[] = []
    const sharedInputs: {wire: Wire, slot: number}[] = []
    stage.sourceValues.forEach((id, wire) => {
      if (values[id]!.axis === 'shared') sharedInputs.push({wire: stage.circuit.source(wire), slot: slot(id)})
      else instanceSources.push(stage.circuit.source(wire))
    })
    const plan = planInstances(compiled, instanceSources, roots)
    const runner = compileColumnInstanceProgram(plan, {rowsPerFunction, blockSize})
    compileMilliseconds += runner.compileMilliseconds
    functionCount += runner.instanceFunctionCount
    const sourceTable = new Float32Array(stage.circuit.sourceSize)
    const inputColumns = plan.instanceSources.map(wire => column(stage.sourceValues[wire]!))
    const outputColumns = roots.map(wire => column(valueOfWire.get(wire)!))
    const count = program.count(stage.axis)
    const fillSharedSources = () => {
      for (const input of sharedInputs) sourceTable[input.wire] = shared[input.slot]!
    }
    const runCpu = () => {
      fillSharedSources()
      runner.runShared(sourceTable)
      runner.runColumns(inputColumns, count, outputColumns)
    }
    return options.mapStage?.({stage, plan, count, sourceTable, inputColumns, outputColumns, cpu: runner, fillSharedSources, runCpu}) ?? runCpu
  }

  const compileReduction = (reduction: Reduction): () => void => {
    switch (reduction.kind) {
      case 'sum': {
        const input = column(reduction.input)
        const output = slot(reduction.output)
        return () => {
          let total = 0
          for (let instance = 0; instance < input.length; instance++) total = f(total + input[instance]!)
          shared[output] = total
        }
      }
      case 'prefix': {
        const input = column(reduction.input)
        const before = column(reduction.before)
        const through = column(reduction.through)
        const total = slot(reduction.total)
        const start = f(reduction.bias)
        const count = input.length
        if (reduction.order === 'sequential') {
          return () => {
            let running = start
            for (let instance = 0; instance < count; instance++) {
              before[instance] = running
              running = f(running + input[instance]!)
              through[instance] = running
            }
            shared[total] = running
          }
        }
        const inclusive = new Float32Array(count)
        return () => {
          inclusive.set(input)
          let span = 1
          for (; span < count; span *= 2) {
            for (let index = 2 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
          }
          for (span = span / 4; span >= 1; span /= 2) {
            for (let index = 3 * span - 1; index < count; index += 2 * span) inclusive[index] = inclusive[index - span]! + inclusive[index]!
          }
          before[0] = start
          for (let instance = 0; instance < count; instance++) {
            through[instance] = start + inclusive[instance]!
            if (instance + 1 < count) before[instance + 1] = through[instance]!
          }
          shared[total] = through[count - 1]!
        }
      }
      case 'firstActive': {
        const input = column(reduction.input)
        const gate = slot(reduction.gate)
        const index = slot(reduction.index)
        const present = slot(reduction.present)
        return () => {
          let found = -1
          if (shared[gate] === 1) {
            for (let instance = 0; instance < input.length; instance++) {
              if (input[instance] === 1) {
                found = instance
                break
              }
            }
          }
          shared[index] = Math.max(0, found)
          shared[present] = found >= 0 ? 1 : 0
        }
      }
      case 'argmax': {
        const input = column(reduction.input)
        const index = slot(reduction.index)
        const score = slot(reduction.score)
        const scores = new Float32Array(input.length)
        const items = new Int32Array(input.length)
        const scale = f(0.4999999403953552)
        const offset = f(0.5000000596046448)
        return () => {
          scores.set(input)
          for (let item = 0; item < items.length; item++) items[item] = item
          let length = input.length
          while (length > 1) {
            let written = 0
            for (let position = 0; position < length; position += 2) {
              if (position + 1 === length) {
                scores[written] = scores[position]!
                items[written] = items[position]!
                written++
                continue
              }
              const left = scores[position]!
              const right = scores[position + 1]!
              const comparison = f(f(offset + f(scale * left)) + f(-scale * right))
              const leftWins = f(f(comparison + 8388609) - 8388609)
              const complement = f(1 - leftWins)
              scores[written] = f(f(0 + f(leftWins * Math.max(0, left))) + f(complement * Math.max(0, right)))
              items[written] = leftWins === 1 ? items[position]! : items[position + 1]!
              written++
            }
            length = written
          }
          shared[index] = items[0]!
          shared[score] = scores[0]!
        }
      }
      case 'max': {
        const input = column(reduction.input)
        const output = slot(reduction.output)
        return () => {
          let running = input[0]!
          for (let instance = 1; instance < input.length; instance++) {
            const next = input[instance]!
            running = f(next + Math.max(0, f(running - next)))
          }
          shared[output] = running
        }
      }
      case 'groupMax': {
        const input = column(reduction.input)
        const groups = column(reduction.group)
        const output = column(reduction.output)
        return () => {
          let group = -1
          let running = 0
          for (let instance = 0; instance < input.length; instance++) {
            const next = input[instance]!
            if (groups[instance] !== group) {
              if (group >= 0) output[group] = running
              group = groups[instance]!
              running = next
            } else {
              running = f(next + Math.max(0, f(running - next)))
            }
          }
          output[group] = running
        }
      }
      case 'gatherAt': {
        const input = column(reduction.input)
        const index = slot(reduction.index)
        const present = reduction.present === null ? -1 : slot(reduction.present)
        const output = slot(reduction.output)
        return () => {
          shared[output] = present >= 0 && shared[present] === 0 ? 0 : f(0 + input[shared[index]!]!)
        }
      }
      case 'gatherIndexed': {
        const indices = column(reduction.index)
        const pairs = reduction.inputs.map((input, field) => ({from: column(input), to: column(reduction.outputs[field]!)}))
        return () => {
          for (const {from, to} of pairs) {
            for (let instance = 0; instance < to.length; instance++) to[instance] = from[indices[instance]!]!
          }
        }
      }
      case 'scatter': {
        const output = column(reduction.output)
        const index = slot(reduction.index)
        const present = reduction.present === null ? -1 : slot(reduction.present)
        const value = reduction.value === null ? -1 : slot(reduction.value)
        return () => {
          output.fill(0)
          if (present >= 0 && shared[present] === 0) return
          output[shared[index]!] = value >= 0 ? f(0 + shared[value]!) : 1
        }
      }
    }
  }

  const runners: {name: string, kind: string, run: () => void | Promise<void>}[] = program.steps.map(step => step.kind === 'stage'
    ? {name: step.stage.name, kind: step.stage.kind, run: compileStage(step.stage)}
    : {name: step.reduction.name, kind: step.reduction.kind, run: compileReduction(step.reduction)})
  const nextCells = new Set(program.nexts.map(next => next.cell))
  for (const {value} of program.nexts) invariant(!nextCells.has(value), `${values[value]!.name} is both a next value and a written cell`)
  const nextCopies = program.nexts.map(({cell, value}) => values[cell]!.axis === 'shared'
    ? () => {
        shared[slot(cell)] = shared[slot(value)]!
      }
    : () => {
        column(cell).set(column(value))
      })

  return {
    program,
    shared,
    columns,
    compileMilliseconds,
    functionCount,
    // Run every step, then copy next values into their cells.
    step() {
      for (let index = 0; index < runners.length; index++) {
        if (runners[index]!.run() !== undefined) throw new Error('a map stage runs asynchronously; call stepAsync')
      }
      for (let index = 0; index < nextCopies.length; index++) nextCopies[index]!()
    },
    // For map stages replaced by asynchronous runners, e.g. GPU dispatches.
    async stepAsync() {
      for (let index = 0; index < runners.length; index++) await runners[index]!.run()
      for (let index = 0; index < nextCopies.length; index++) nextCopies[index]!()
    },
    // The same work, timed per step.
    timedStep(into: Map<string, number>) {
      for (const runner of runners) {
        const start = performance.now()
        runner.run()
        const key = `${runner.kind}: ${runner.name}`
        into.set(key, (into.get(key) ?? 0) + performance.now() - start)
      }
      for (const copy of nextCopies) copy()
    },
    get: (value: Value, instance = 0) => values[value.id]!.axis === 'shared' ? shared[slot(value.id)]! : column(value.id)[instance]!,
    set: (value: Value, number: number, instance = 0) => {
      if (values[value.id]!.axis === 'shared') shared[slot(value.id)] = number
      else column(value.id)[instance] = number
    },
    column: (value: Value) => column(value.id),
    slot: (value: Value) => slot(value.id),
  }
}
