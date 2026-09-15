// The frame loop of the per-pixel thread: build the thread circuit with no slots,
// add the per-pixel program, compile once, and split the program into the shared
// part (the thread logic, run once per frame) and the per-pixel part (run for every
// pixel center) with codegen's planInstances over the two pixel cells.
import {
  buildPixelProgram, pixelCellLayout, writePixelTables, writeTextTables,
  type BuiltPixelProgram, type GlyphTextCells, type PixelCellLayout, type PixelProgramOptions,
} from './pixel-circuit.ts'
import type {PaintTables} from './pixel-model.ts'
import {compileInstanceProgram, planInstances, type InstancePlan, type InstanceRunner} from './instance.ts'
import type {TensorProgram} from './codegen.ts'
import type {Wire} from './numeric-ui-core.ts'
import type {Staircase} from './text-heights.ts'
import type {GlyphAtlas, TextCapacity, TextTables} from './text-table.ts'
import {buildThreadCircuit, writeInputs, writeState, type BuiltThreadCircuit} from './thread-circuit.ts'
import {containerWidthF, type FrameInputs, type GlobalFrame, type ThreadState} from './thread-frame.ts'
import type {ThreadTables} from './thread-model.ts'

// The shared runtime's behavior: no index one-hot recognition, no inferred bit families, build-time depths. With these,
// the runtime copy reproduces hn-thread's counts (53,703 live operations with 48 slots, 28,340 with none).
export const pixelCompileOptions = {lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false} as const

export type ThreadModel = {tables: ThreadTables, staircases: readonly Staircase[]}

export type PixelMachineOptions = PixelProgramOptions & {
  rowsPerFunction?: number
  blockSize?: number
  // Also keep the geometry wires the float64 rasterizer reads (they're live anyway).
  checkWires?: boolean
}

// Glyph text: the atlas, table capacities, and pretext's layout at a container width.
export type GlyphTextOptions = {atlas: GlyphAtlas, capacity: TextCapacity, layout: (containerWidth: number) => TextTables}

// Global outputs JS reads after a frame.
export const hostGlobalFields = ['scheduleNextRender', 'cursorCode', 'placeholderHeight', 'scrollerHeight', 'scrollerTop', 'containerLeft', 'containerWidth'] as const satisfies readonly (keyof GlobalFrame)[]

export type PixelProgramBuild = {
  built: BuiltThreadCircuit
  pixel: BuiltPixelProgram
  cells: PixelCellLayout
  roots: Wire[]
  program: TensorProgram
  plan: InstancePlan
  buildMilliseconds: number
  compileMilliseconds: number
}

export function buildPixelThread(model: ThreadModel, paint: PaintTables, options: PixelMachineOptions, glyphText?: GlyphTextCells): PixelProgramBuild {
  const buildStart = performance.now()
  const cells = pixelCellLayout(model.tables, options, glyphText)
  const built = buildThreadCircuit(model, {slotCount: 0, slotMode: 'none', naturalPrefix: 'brent-kung', visualPrefix: 'fold'}, cells.count)
  const pixel = buildPixelProgram(built, model.tables, paint, options, cells)
  const buildMilliseconds = performance.now() - buildStart
  const roots = [
    ...built.stateWires,
    ...hostGlobalFields.map(field => built.globalWires[field]),
    ...(options.checkWires === false ? [] : pixel.checkWires),
    ...pixel.outputs,
  ]
  const compileStart = performance.now()
  const program = built.circuit.compileTensorProgram(roots, true, pixelCompileOptions)
  const plan = planInstances(program, [pixel.pixelXCell, pixel.pixelYCell], pixel.outputs)
  const compileMilliseconds = performance.now() - compileStart
  return {built, pixel, cells, roots, program, plan, buildMilliseconds, compileMilliseconds}
}

export type PixelMachine = PixelProgramBuild & {
  runner: InstanceRunner
  source: Float32Array
  setState(state: ThreadState): void
  setInputs(inputs: FrameInputs): void
  // Runs the thread logic once. With glyph text, first rewrites the text tables if the container width changed.
  runShared(): void
  // runShared, then every pixel center (count × 2 cells) into outputs (count × 6 values).
  draw(pixelCenters: Float32Array, count: number, outputs: Float32Array): void
  // Writes the last run's next-state values into the source table and clears the click latch.
  commit(): void
  sharedValue(wire: Wire): number
  global(field: typeof hostGlobalFields[number]): number
  checkValues(): Float64Array
  // The text tables in the source table, or null without glyph text.
  textTables(): TextTables | null
  textLayoutMilliseconds(): number
}

export function createPixelMachine(model: ThreadModel, paint: PaintTables, options: PixelMachineOptions, state: ThreadState, glyphText?: GlyphTextOptions): PixelMachine {
  const build = buildPixelThread(model, paint, options, glyphText)
  const {built, pixel, cells, plan} = build
  const runner = compileInstanceProgram(plan, {rowsPerFunction: options.rowsPerFunction ?? 128, blockSize: options.blockSize ?? 1024})
  const source = new Float32Array(built.layout.size)
  writeState(source, built.layout, state)
  writePixelTables(source, built, cells, model.tables, paint, glyphText?.atlas)
  const rowCount = built.rowCount
  const {layout} = built
  const stateCells = [layout.cell.scrollTopPrevious, layout.cell.scrollDeltaPrevious, layout.cell.scrollerPeekUp, layout.cell.containerWidthPrevious]
  for (const start of [layout.collapsed, layout.restHeights, layout.heights, layout.restTargetsPrevious]) {
    for (let row = 0; row < rowCount; row++) stateCells.push(start + row)
  }
  const statePositions = built.stateWires.map(wire => plan.flat.positionOfWire[wire]!)
  const sharedValue = (wire: Wire) => {
    const position = plan.flat.positionOfWire[wire]!
    if (position < 0) throw new Error(`wire ${wire} isn't live`)
    return runner.shared[position]!
  }
  let textWidth = Number.NaN
  let text: TextTables | null = null
  let layoutMilliseconds = 0
  const ensureText = () => {
    if (glyphText === undefined) return
    const containerWidth = containerWidthF(source[layout.cell.windowWidth]!)
    if (containerWidth === textWidth) return
    const start = performance.now()
    text = glyphText.layout(containerWidth)
    writeTextTables(source, built, cells, text)
    layoutMilliseconds = performance.now() - start
    textWidth = containerWidth
  }
  const runShared = () => {
    ensureText()
    runner.runShared(source)
  }
  return {
    ...build,
    runner,
    source,
    setState(next) {
      writeState(source, layout, next)
    },
    setInputs(inputs) {
      writeInputs(source, layout, inputs)
    },
    runShared,
    draw(pixelCenters, count, outputs) {
      runShared()
      runner.runInstances(pixelCenters, count, outputs)
    },
    commit() {
      for (let index = 0; index < stateCells.length; index++) source[stateCells[index]!] = runner.shared[statePositions[index]!]!
      source[layout.cell.click] = 0
    },
    sharedValue,
    global: field => sharedValue(built.globalWires[field]),
    checkValues: () => Float64Array.from(pixel.checkWires, sharedValue),
    textTables: () => text,
    textLayoutMilliseconds: () => layoutMilliseconds,
  }
}

// Pixel centers offset + stride * i on both axes, as (x, y) pairs in row order.
export function pixelCenters(width: number, height: number, stride = 1, offset = 0.5) {
  const centers = new Float32Array(width * height * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      centers[(y * width + x) * 2] = offset + stride * x
      centers[(y * width + x) * 2 + 1] = offset + stride * y
    }
  }
  return centers
}

export type {GlyphTextCells}
