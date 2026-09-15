// layout-tree's app shell as a retiming workload (copied into copies/layout-tree):
// a menu toggle, a sidebar spring, and a Clay-style layout with a wrapping tag row,
// sticky headers and card grids.
import {buildGraph, flattenProgram, type Graph} from './flat.ts'
import {type MetricSpec, type Model, OutputGroupBuilder, type Trace, type TraceRun, describeValue, outputLabelMap} from './retime.ts'
import {type AppShell, type AppShellOptions, createAppShell} from './copies/layout-tree/app-shell.ts'
import {appTextTables} from './copies/layout-tree/app-text-tables.ts'
import {writeLayoutSources} from './copies/layout-tree/builder.ts'

export type AppShellModel = Model & {
  shell: AppShell
  graph: Graph
  initialSource: Float32Array
  nextSource: [cell: number, position: number][]
  outputLabels: Map<number, string>
  springPosition: number
}

export function createAppShellModel(name: string, options: Partial<AppShellOptions> = {}): AppShellModel {
  const shell = createAppShell(options)
  const tables = new Map(Object.entries(appTextTables))
  const program = flattenProgram(shell.circuit.compileTensorProgram(shell.roots))
  const initialSource = shell.table.createValues()
  writeLayoutSources(initialSource, shell.sources, {viewportWidth: 1280, viewportHeight: 800, mainScroll: 0}, tables)
  const position = (wire: number) => program.positionOfWire[wire]!
  const px = new OutputGroupBuilder()
  const decisions = new OutputGroupBuilder()
  const unitless = new OutputGroupBuilder()
  for (const [rectName, rect] of shell.layout.rects) {
    px.add(position(rect.x), `${rectName}.x`)
    px.add(position(rect.y), `${rectName}.y`)
    px.add(position(rect.width), `${rectName}.width`)
    px.add(position(rect.height), `${rectName}.height`)
  }
  for (const [textName, wire] of shell.layout.lines) decisions.add(position(wire), `${textName}.lines`)
  for (const [scrollName, wire] of shell.layout.scroll) px.add(position(wire), `${scrollName}.scroll`)
  for (const [wrapName, wires] of shell.layout.wrapLines) wires.forEach((wire, index) => decisions.add(position(wire), `${wrapName}.line[${index}]`))
  for (const [gridName, wire] of shell.layout.gridColumns) decisions.add(position(wire), `${gridName}.columns`)
  px.add(position(shell.sidebarWidth), 'sidebarWidth')
  // emitSpring's active output is a clamp, not a bit.
  unitless.add(position(shell.animating), 'sidebar spring active')
  const nextSource = shell.nextSource.map(([cell, wire]): [number, number] => [cell, position(wire)])
  const openCell = shell.table.wire('sidebar.open')
  decisions.add(nextSource.find(([cell]) => cell === openCell)![1], 'next sidebar.open')
  const metric: MetricSpec = {
    px: px.build(),
    scale: new OutputGroupBuilder().build(),
    opacity: new OutputGroupBuilder().build(),
    decisions: decisions.build(),
    unitless: unitless.build(),
  }
  const positionCell = shell.table.wire('sidebar.position')
  return {
    name,
    program,
    metric,
    shell,
    graph: buildGraph(program),
    initialSource,
    nextSource,
    outputLabels: outputLabelMap(metric),
    springPosition: nextSource.find(([cell]) => cell === positionCell)![1],
  }
}

export function describeAppShellValue(model: AppShellModel, position: number) {
  const {circuit} = model.shell
  const wire = model.program.wireOrder[position]!
  const tag = wire < circuit.sourceSize ? 'source' : circuit.tagNames[circuit.operationTags[wire - circuit.sourceSize]!]!
  return {place: tag, ...describeValue(model.graph, position, cell => model.shell.table.names[cell]!, model.outputLabels)}
}

export type AppFrame = {
  viewportWidth: number
  viewportHeight: number
  frameDuration: number
  pointerDown: {x: number, y: number} | null
  scrollDelta: number
}

// The menu button sits at (16, 8) with a 40 px square at every width.
const menuPress = {x: 36, y: 28}

export function appShellTrace(name: string, frames: readonly AppFrame[]): Trace<AppShellModel> {
  return {
    name,
    createRun(model): TraceRun {
      const {shell} = model
      const source = new Float32Array(model.initialSource)
      const cell = (cellName: string) => shell.table.wire(cellName)
      const scrollCell = shell.sources.inputs.get('mainScroll')!
      const cells = {
        viewportWidth: cell('input.viewportWidth'),
        viewportHeight: cell('input.viewportHeight'),
        timestep: cell('spring.timestep'),
        downActive: cell('pointer.downActive'),
        downX: cell('pointer.downX'),
        downY: cell('pointer.downY'),
      }
      return {
        frames: frames.length,
        frame(index, evaluate) {
          // app-shell.ts createAppMachine's step.
          const frame = frames[index]!
          source[cells.viewportWidth] = frame.viewportWidth
          source[cells.viewportHeight] = frame.viewportHeight
          source[scrollCell] = Math.min(8192, Math.max(0, source[scrollCell]! + frame.scrollDelta))
          source[cells.timestep] = Math.min(0.032, Math.max(0, frame.frameDuration)) / 4
          source[cells.downActive] = frame.pointerDown === null ? 0 : 1
          if (frame.pointerDown !== null) {
            source[cells.downX] = frame.pointerDown.x
            source[cells.downY] = frame.pointerDown.y
          }
          const values = evaluate(source)
          for (const [target, position] of model.nextSource) source[target] = values[position]!
          source[cells.downActive] = 0
        },
      }
    },
  }
}

const idle = (viewportWidth: number, scrollDelta = 0, pointerDown: {x: number, y: number} | null = null): AppFrame =>
  ({viewportWidth, viewportHeight: 820, frameDuration: 1 / 60, pointerDown, scrollDelta})

// layout-tree/report.ts's app shell frames: every 80 px from 320 to 2400 with 60
// settle frames and 5 scroll requests, then two sidebar toggles at 900 and 1440 px
// while scrolling.
export function appShellFrames(): AppFrame[] {
  const frames: AppFrame[] = []
  for (let viewportWidth = 320; viewportWidth <= 2400; viewportWidth += 80) {
    for (let settle = 0; settle < 60; settle++) frames.push(idle(viewportWidth))
    for (const scrollDelta of [0, 400, 800, 9000, -20_000]) frames.push(idle(viewportWidth, scrollDelta))
  }
  for (const viewportWidth of [900, 1440]) {
    for (let settle = 0; settle < 61; settle++) frames.push(idle(viewportWidth))
    for (let toggle = 0; toggle < 2; toggle++) {
      frames.push(idle(viewportWidth, 0, menuPress))
      for (let frame = 0; frame < 45; frame++) frames.push(idle(viewportWidth, 37))
    }
  }
  return frames
}

// A random session: the window width drags toward random targets at up to 24 px
// per frame, scroll requests of up to 600 px, menu presses, and frame durations of
// 1/120 s to 1/30 s.
export function randomAppShellFrames(seed: number, count: number): AppFrame[] {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const frames: AppFrame[] = []
  let width = 1280
  let target = 1280
  for (let index = 0; index < count; index++) {
    if (random() < 0.02) target = Math.round(360 + random() * 1800)
    width += Math.max(-24, Math.min(24, target - width))
    const pointerDown = random() < 0.01 ? menuPress : null
    const scrollDelta = random() < 0.1 ? Math.round((random() - 0.3) * 600) : 0
    const frameDuration = [1 / 120, 1 / 60, 1 / 60, 1 / 30][Math.floor(random() * 4)]!
    frames.push({viewportWidth: width, viewportHeight: 820, frameDuration, pointerDown, scrollDelta})
  }
  return frames
}

// A held-out trace with continuous input: a live window resize from 1280 to 700 px
// at 8 px per frame, a toggle while growing back to 1180 px, a toggle while
// scrolling, then idle frames.
export function smoothResizeFrames(): AppFrame[] {
  const frames: AppFrame[] = []
  for (let settle = 0; settle < 60; settle++) frames.push(idle(1280))
  for (let step = 1; step <= 73; step++) frames.push(idle(1280 - step * 8))
  for (let settle = 0; settle < 20; settle++) frames.push(idle(700))
  frames.push(idle(700, 0, menuPress))
  for (let step = 1; step <= 60; step++) frames.push(idle(700 + step * 8))
  frames.push(idle(1180, 0, menuPress))
  for (let step = 0; step < 60; step++) frames.push(idle(1180, 20))
  for (let settle = 0; settle < 60; settle++) frames.push(idle(1180))
  return frames
}
