// codegen's life-calendar over its 27,393 cells in each mode. The shared rows run
// once per viewport and pointer, the per-cell rows once per cell, so a mode costs
// 63 interpreted rows per cell instead of 2,054.
import {planInstances} from './copies/codegen/instance.ts'
import {createLifeCalendarCircuit, life, lifeCalendarSource, lifeOutputField, lifeSourceField, referenceLifeCalendar} from './copies/codegen/life-calendar.ts'
import {createWorkspace, evaluate, prepareModeProgram, type Mode} from './interpreter.ts'
import {structureOf, type ProgramStructure} from './measure.ts'

export type LifeCalendarState = {windowWidth: number, windowHeight: number, pointerX: number, pointerY: number, age: number}

export type LifeCalendarModeResult = {
  mode: Mode
  decisionsChecked: number
  // Decision outputs that differ from the stored interpreter, per field.
  flipsByField: Record<string, number>
  decisionFlips: number
  // Decision outputs that differ from the demo's float64 formulas.
  referenceMismatches: number
  referenceMismatchesByField: Record<string, number>
  maximumDrift: number
  maximumReferenceError: number
  milliseconds: number
}

const decisionFields = ['filled', 'today', 'pillFilled', 'pillEmpty', 'dayOfWeek', 'hovered', 'row', 'column'] as const
const positionFields = ['x', 'y'] as const

export function runLifeCalendar(states: readonly LifeCalendarState[], modesToRun: readonly Mode[]) {
  const calendar = createLifeCalendarCircuit()
  const program = calendar.circuit.compileTensorProgram([...calendar.outputs, ...Object.values(calendar.shared)])
  const plan = planInstances(program, calendar.instanceSources, calendar.outputs)
  const modeProgram = prepareModeProgram(calendar.circuit, program)
  const {packed} = modeProgram
  const instanceSteps = new Set(plan.instanceSteps)
  const sharedEntries: number[] = []
  const instanceEntries: number[] = []
  plan.flat.steps.forEach((step, index) => (instanceSteps.has(step) ? instanceEntries : sharedEntries).push(packed.steps[index]!))
  const shared = Int32Array.from(sharedEntries)
  const perCell = Int32Array.from(instanceEntries)
  const workspace = createWorkspace(packed)
  const size = lifeOutputField.size

  const runState = (mode: Mode, state: LifeCalendarState, outputs: Float64Array) => {
    const rules = modeProgram.rules[mode]
    const source = lifeCalendarSource(state.windowWidth, state.windowHeight, state.pointerX, state.pointerY, state.age)
    for (let cell = 0; cell < packed.sourceSize; cell++) workspace.values[cell] = source[cell]!
    evaluate(packed, rules, source, workspace, shared)
    for (let cell = 0; cell < life; cell++) {
      workspace.values[lifeSourceField.cell] = cell
      evaluate(packed, rules, source, workspace, perCell)
      for (let field = 0; field < size; field++) outputs[cell * size + field] = workspace.values[plan.outputs[field]!]!
    }
  }

  const storedOutputs = states.map(state => {
    const outputs = new Float64Array(life * size)
    runState('stored', state, outputs)
    return outputs
  })
  const results: LifeCalendarModeResult[] = []
  const modeOutputs = new Float64Array(life * size)
  for (const mode of ['stored', ...modesToRun.filter(mode => mode !== 'stored')] as Mode[]) {
    const start = performance.now()
    const result: LifeCalendarModeResult = {
      mode, decisionsChecked: 0, flipsByField: {}, decisionFlips: 0, referenceMismatches: 0, referenceMismatchesByField: {},
      maximumDrift: 0, maximumReferenceError: 0, milliseconds: 0,
    }
    states.forEach((state, stateIndex) => {
      runState(mode, state, modeOutputs)
      const stored = storedOutputs[stateIndex]!
      const reference = referenceLifeCalendar(state.windowWidth, state.windowHeight, state.pointerX, state.pointerY, state.age)
      for (let cell = 0; cell < life; cell++) {
        const expected = reference.cell(cell)
        for (const name of decisionFields) {
          const field = lifeOutputField[name]
          const value = modeOutputs[cell * size + field]!
          result.decisionsChecked++
          if (value !== stored[cell * size + field]) {
            result.decisionFlips++
            result.flipsByField[name] = (result.flipsByField[name] ?? 0) + 1
          }
          if (value !== expected[field]) {
            result.referenceMismatches++
            result.referenceMismatchesByField[name] = (result.referenceMismatchesByField[name] ?? 0) + 1
          }
        }
        for (const name of positionFields) {
          const field = lifeOutputField[name]
          const value = Math.fround(modeOutputs[cell * size + field]!)
          result.maximumDrift = Math.max(result.maximumDrift, Math.abs(value - stored[cell * size + field]!))
          result.maximumReferenceError = Math.max(result.maximumReferenceError, Math.abs(value - expected[field]!))
        }
      }
    })
    result.milliseconds = performance.now() - start
    results.push(result)
  }
  const structure: Omit<ProgramStructure, 'bitRows' | 'decisionOutputs'> = structureOf(modeProgram)
  return {structure, sharedRows: plan.counts.sharedRows, instanceRows: plan.counts.instanceRows, states: states.length, results}
}

export function lifeCalendarStates(pointerCount: number): LifeCalendarState[] {
  const viewports = [[1440, 900], [390, 844], [1280, 800], [2560, 1440], [800, 600], [1024, 1366], [3840, 2160]] as const
  const states: LifeCalendarState[] = []
  viewports.forEach(([windowWidth, windowHeight], viewportIndex) => {
    for (let pointer = 0; pointer < pointerCount; pointer++) {
      // Pointers spread over the window on a 1/4 px grid, including the grid's edges.
      const fraction = (pointer + 0.5) / pointerCount
      states.push({
        windowWidth,
        windowHeight,
        pointerX: Math.round(windowWidth * fraction * 4) / 4,
        pointerY: Math.round(windowHeight * ((fraction * 7 + viewportIndex * 0.13) % 1) * 4) / 4,
        age: 11_503,
      })
    }
  })
  return states
}
