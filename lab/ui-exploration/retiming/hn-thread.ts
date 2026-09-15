// hn-thread as a retiming workload (copied into copies/hn-thread): 251 comments,
// 48 rank slots, driven by the differential's scripted 900-frame session.
import {buildGraph, flattenProgram, type Graph} from './flat.ts'
import {type MetricSpec, type Model, OutputGroupBuilder, type Trace, type TraceRun, describeValue, outputLabelMap} from './retime.ts'
import {thread} from './copies/hn-thread/hn-data.ts'
import {installFakeCanvas} from './copies/hn-thread/fake-canvas.ts'
import {threadLayout} from './copies/hn-thread/thread-model.ts'
import {initialThreadState, prepareThread, type PreparedThread} from './copies/hn-thread/thread-prepare.ts'
import {type BuiltThreadCircuit, type ThreadCircuitOptions, buildThreadCircuit, defaultCircuitOptions, readThreadFrame, writeInputs, writeState} from './copies/hn-thread/thread-circuit.ts'
import {scenarioInputs} from './copies/hn-thread/differential.ts'
import {type FrameInputs, type GlobalFrame, type RowFrame, type SlotFrame, type ThreadFrame, globalFrameFields} from './copies/hn-thread/thread-frame.ts'

export type HNModel = Model & {
  built: BuiltThreadCircuit
  graph: Graph
  rootPositions: Int32Array
  stateCells: number[]
  initialSource: Float32Array
  outputLabels: Map<number, string>
}

let cachedPrepared: PreparedThread | null = null

export function preparedThread() {
  if (cachedPrepared === null) {
    installFakeCanvas()
    cachedPrepared = prepareThread(thread.comments)
  }
  return cachedPrepared
}

const globalPx = ['scrollTop', 'scrollTopCap', 'containerWidth', 'containerLeft', 'containerHeight', 'submissionHeight', 'submissionLine1Top', 'submissionLine2Top', 'searchLeft', 'searchTop', 'scrollerTop', 'scrollerHeight', 'scrollerPeekUp', 'placeholderHeight'] as const satisfies readonly (keyof GlobalFrame)[]
const globalDecisions = ['pointerOn', 'pointedRow', 'ancestor', 'toggleRegion', 'peeking', 'cursorCode', 'scheduleNextRender', 'slotOverflow'] as const satisfies readonly (keyof GlobalFrame)[]
const rowDecisions = ['textHeight', 'naturalHeight', 'shrink', 'collapsed', 'visible', 'occupiesSlot', 'emphasis', 'gutterVisible', 'gutterEmphasis'] as const satisfies readonly (keyof RowFrame)[]
const slotPx = ['userTop', 'userHeight', 'commentTop', 'commentHeight', 'commentFadeSize'] as const satisfies readonly (keyof SlotFrame)[]
const slotOpacity = ['userOpacity', 'userTextOpacity'] as const satisfies readonly (keyof SlotFrame)[]
const slotDecisions = ['present', 'row', 'emphasis', 'collapsed'] as const satisfies readonly (keyof SlotFrame)[]

export function createHNModel(name: string, options: ThreadCircuitOptions = defaultCircuitOptions): HNModel {
  const prepared = preparedThread()
  const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, options)
  const program = flattenProgram(built.circuit.compileTensorProgram(built.roots))
  const rootPositions = Int32Array.from(built.roots, wire => program.positionOfWire[wire]!)
  const root = (offset: number) => rootPositions[offset]!
  const {rowCount} = built
  const slotCount = options.slotCount
  const px = new OutputGroupBuilder()
  const opacity = new OutputGroupBuilder()
  const decisions = new OutputGroupBuilder()
  for (const field of globalPx) px.add(root(built.globalOffset[field]), `global.${field}`)
  for (const field of globalDecisions) decisions.add(root(built.globalOffset[field]), `global.${field}`)
  for (let row = 0; row < rowCount; row++) {
    for (const field of rowDecisions) decisions.add(root(built.rowOffset[field] + row), `rows[${row}].${field}`)
    const gutterVisible = root(built.rowOffset.gutterVisible + row)
    px.add(root(built.rowOffset.gutterTop + row), `rows[${row}].gutterTop`, gutterVisible)
    px.add(root(built.rowOffset.gutterBottom + row), `rows[${row}].gutterBottom`, gutterVisible)
  }
  for (let slot = 0; slot < slotCount; slot++) {
    const present = root(built.slotOffset.present + slot)
    for (const field of slotPx) px.add(root(built.slotOffset[field] + slot), `slots[${slot}].${field}`, present)
    for (const field of slotOpacity) opacity.add(root(built.slotOffset[field] + slot), `slots[${slot}].${field}`, present)
    for (const field of slotDecisions) decisions.add(root(built.slotOffset[field] + slot), `slots[${slot}].${field}`)
  }
  const metric: MetricSpec = {
    px: px.build(),
    scale: new OutputGroupBuilder().build(),
    opacity: opacity.build(),
    decisions: decisions.build(),
    unitless: new OutputGroupBuilder().build(),
  }
  const {layout} = built
  const stateCells = [layout.cell.scrollTopPrevious, layout.cell.scrollDeltaPrevious, layout.cell.scrollerPeekUp, layout.cell.containerWidthPrevious]
  for (const start of [layout.collapsed, layout.restHeights, layout.heights, layout.restTargetsPrevious]) {
    for (let row = 0; row < rowCount; row++) stateCells.push(start + row)
  }
  const initialSource = new Float32Array(layout.size)
  writeState(initialSource, layout, initialThreadState(prepared, 1024))
  return {name, program, metric, built, graph: buildGraph(program), rootPositions, stateCells, initialSource, outputLabels: outputLabelMap(metric)}
}

export function hnSourceName(model: HNModel, cell: number) {
  const {layout, rowCount} = model.built
  const global = Object.entries(layout.cell).find(([, index]) => index === cell)
  if (global !== undefined) return global[0]
  for (const [name, start] of [['collapsed', layout.collapsed], ['restHeight', layout.restHeights], ['height', layout.heights], ['restTargetPrevious', layout.restTargetsPrevious]] as const) {
    if (cell >= start && cell < start + rowCount) return `${name}[${cell - start}]`
  }
  return `cell ${cell}`
}

export function describeHNValue(model: HNModel, position: number) {
  const wire = model.program.wireOrder[position]!
  const section = model.built.sections.find(candidate => wire >= candidate.firstWire && wire < candidate.endWire)?.name ?? 'source'
  return {place: section, ...describeValue(model.graph, position, cell => hnSourceName(model, cell), model.outputLabels)}
}

function stepHost(model: HNModel, source: Float32Array, inputs: FrameInputs, evaluate: (source: Float32Array) => Float32Array) {
  writeInputs(source, model.built.layout, inputs)
  const values = evaluate(source)
  const stateStart = model.built.stateOffset
  for (let index = 0; index < model.stateCells.length; index++) source[model.stateCells[index]!] = values[model.rootPositions[stateStart + index]!]!
  source[model.built.layout.cell.click] = 0
  return values
}

// differential.ts's scripted session: scroll, hold a level-1 gutter on a deep
// comment, collapse and expand a comment through its banner, resize from 1024 px
// to about 500 px, widen and scroll past the end. The script reads positions from
// the previous frame; here they come from the model without cuts, computed once,
// so every retimed run gets the same inputs.
export function scriptedSession(model: HNModel, frames = 900): Trace<HNModel> {
  const inputsAt = scenarioInputs(preparedThread(), frames)
  const inputs: FrameInputs[] = []
  {
    const source = new Float32Array(model.initialSource)
    const values = new Float32Array(model.program.valueCount)
    const rootValues = new Float32Array(model.rootPositions.length)
    // Run the circuit through the shared executor for the inputs.
    const evaluate = model.built.circuit.createTensorEvaluator(model.built.roots)
    let previous: ThreadFrame | null = null
    for (let frame = 0; frame < frames; frame++) {
      const frameInputs = inputsAt(frame, previous)
      inputs.push(frameInputs)
      stepHost(model, source, frameInputs, input => {
        rootValues.set(evaluate(input))
        model.rootPositions.forEach((position, index) => { values[position] = rootValues[index]! })
        return values
      })
      previous = readThreadFrame(model.built, rootValues)
    }
  }
  return {
    name: `scripted session, ${frames} frames`,
    createRun(retimedModel): TraceRun {
      const source = new Float32Array(retimedModel.initialSource)
      return {
        frames,
        frame(index, evaluate) {
          stepHost(retimedModel, source, inputs[index]!, evaluate)
        },
      }
    },
  }
}

// A random session: the window width drags toward random targets at up to 12 px per
// frame, the scroll position and the pointer random walk, the pointer button is held
// for stretches, and a click lands on the banner of a random visible comment about
// once every 30 frames. Targets come from the model without cuts, computed once.
export function randomSession(model: HNModel, seed: number, frames: number): Trace<HNModel> {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const prepared = preparedThread()
  const {indents} = prepared.tables
  const inputs: FrameInputs[] = []
  const source = new Float32Array(model.initialSource)
  const values = new Float32Array(model.program.valueCount)
  const rootValues = new Float32Array(model.rootPositions.length)
  const evaluate = model.built.circuit.createTensorEvaluator(model.built.roots)
  let previous: ThreadFrame | null = null
  let windowWidth = 1024
  let targetWidth = 1024
  let scrollTopReal = 0
  let pointerX = 400
  let pointerY = 300
  let pointerDown = 0
  for (let frame = 0; frame < frames; frame++) {
    if (random() < 0.01) targetWidth = Math.round(375 + random() * 900)
    windowWidth += Math.max(-12, Math.min(12, targetWidth - windowWidth))
    const maxScroll = previous === null ? 0 : Math.max(0, previous.global.placeholderHeight - previous.global.scrollerHeight)
    scrollTopReal = Math.max(0, Math.min(Math.round(maxScroll), scrollTopReal + Math.round((random() - 0.45) * 80)))
    pointerX = Math.max(0, Math.min(windowWidth, pointerX + (random() - 0.5) * 40))
    pointerY = Math.max(0, Math.min(800, pointerY + (random() - 0.5) * 40))
    if (random() < 0.02) pointerDown = 1 - pointerDown
    let click = 0
    if (previous !== null && random() < 0.03) {
      const visibleRows = previous.rows.flatMap((row, index) => row.visible === 1 && row.naturalHeight > 0 ? [index] : [])
      if (visibleRows.length > 0) {
        const row = visibleRows[Math.floor(random() * visibleRows.length)]!
        let top = 0
        for (let index = 0; index < row; index++) top += previous.rows[index]!.naturalHeight
        // differential.ts's scripted banner click: leftOf(indent + 2) and pageYOfRow(row, 10.5).
        pointerX = previous.global.containerLeft + (indents[row]! + 2) * threadLayout.indentWidth + 10.5
        pointerY = threadLayout.currentContainerTop + previous.global.submissionHeight - previous.global.scrollTopCap + top + 10.5
        click = 1
      }
    }
    const frameInputs: FrameInputs = {windowWidth, windowHeight: 800, scrollTopReal, pointerX, pointerY, pointerDown, click}
    inputs.push(frameInputs)
    stepHost(model, source, frameInputs, input => {
      rootValues.set(evaluate(input))
      model.rootPositions.forEach((position, index) => { values[position] = rootValues[index]! })
      return values
    })
    previous = readThreadFrame(model.built, rootValues)
  }
  return {
    name: `random session seed ${seed}, ${frames} frames`,
    createRun(retimedModel): TraceRun {
      const runSource = new Float32Array(retimedModel.initialSource)
      return {
        frames,
        frame(index, frameEvaluate) {
          stepHost(retimedModel, runSource, inputs[index]!, frameEvaluate)
        },
      }
    },
  }
}

export {globalFrameFields}
