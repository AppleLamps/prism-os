// The demo's logic, with no DOM: the app shell at rest, a drag solver, pointer handling for card
// edges, knob locks, and flip queries turned into sentences. demo.ts only measures text, copies
// rectangles onto elements and forwards events.
import {cardCount, knobNames, knobSpecs, type KnobName} from './app-shell.ts'
import {createAppDrag, type EdgeSide} from './app-drag.ts'
import {createDragSolver, edgeValue, type EdgeTerms, type FrameResult} from './drag-solver.ts'
import {answerFlipQueries, type FlipAnswer} from './flip-query.ts'
import type {LayoutResult, TextTable} from './tree.ts'

export type DemoHandle = {node: string, side: EdgeSide}

// How close to an edge a press must be to grab it, in px.
const handleSlop = 6

export function createDemoModel(tables: ReadonlyMap<string, TextTable>, viewportWidth: number, viewportHeight: number) {
  const app = createAppDrag(tables)
  const solver = createDragSolver(app.problem)
  const source = app.createSource(viewportWidth, viewportHeight)
  const scrollCell = app.shell.sources.inputs.get('mainScroll')!
  const scrollWire = app.shell.layout.scroll.get('main')!
  const locked = new Set<KnobName>()
  let values = new Float32Array(solver.evaluate(source))
  let drag: {handle: DemoHandle, pointerStart: number, edgeStart: number, edge: EdgeTerms} | null = null
  let lastFrame: FrameResult | null = null
  let flips: FlipAnswer[] = []
  let flipsScanned = false

  const refresh = () => { values = new Float32Array(solver.evaluate(source)) }
  const layout = (): LayoutResult => app.shell.readWires(values)
  const knobs = () => Object.fromEntries(knobNames.map(name => [name, source[app.shell.knobCells.get(name)!]!])) as Record<KnobName, number>
  const unlocked = () => knobNames.flatMap((name, index) => locked.has(name) ? [] : [index])

  const hitTest = (x: number, y: number): DemoHandle | null => {
    const result = layout()
    const main = result.rects.get('main')!
    if (x < main.x || x > main.x + main.width || y < main.y || y > main.y + main.height) return null
    for (let index = 0; index < cardCount; index++) {
      const node = `card${index}`
      const card = result.rects.get(node)!
      const insideY = y >= card.y && y <= card.y + card.height
      const insideX = x >= card.x && x <= card.x + card.width
      if (insideY && Math.abs(x - (card.x + card.width)) <= handleSlop) return {node, side: 'right'}
      if (insideY && Math.abs(x - card.x) <= handleSlop) return {node, side: 'left'}
      if (insideX && Math.abs(y - (card.y + card.height)) <= handleSlop) return {node, side: 'bottom'}
    }
    return null
  }

  // Flip queries for the dragged card's grid and title. Without a scan each answer is one
  // backward pass plus two evaluations, cheap enough for every pointer move.
  const computeFlips = (handle: DemoHandle, scan: boolean) => {
    const queries = [...app.gridQueries(app.gridOfCard(handle.node), values), ...app.lineQueries(`${handle.node}.title`, values)]
    flips = queries.flatMap(query => answerFlipQueries(solver, source, query, unlocked(), {scan}))
    flipsScanned = scan
  }

  const flipSentences = () => {
    const current = knobs()
    return flips.flatMap(answer => {
      if (answer.predictedChange === null || !answer.insideRange) return []
      const name = answer.knob as KnobName
      const unit = knobSpecs[name].unit === 'px' ? ' px' : '×'
      const reaches = current[name] + answer.predictedChange
      const digits = name === 'titleScale' ? 3 : 1
      let sentence = `${answer.label} if ${name} reaches ${reaches.toFixed(digits)}${unit}`
      if (flipsScanned && answer.actualChange !== null && Math.abs(answer.actualChange - answer.predictedChange) > 1e-3) {
        sentence += ` (a scan finds the first flip at ${(current[name] + answer.actualChange).toFixed(digits)}${unit})`
      }
      return [sentence]
    })
  }

  return {
    app,
    solver,
    layout,
    knobs,
    hitTest,
    flipSentences,
    state: () => ({knobs: knobs(), locked: [...locked], lastFrame, dragging: drag?.handle ?? null, scroll: values[scrollWire]!}),
    pointerDown(x: number, y: number) {
      const handle = hitTest(x, y)
      if (handle === null) return false
      const edge = app.edge(handle.node, handle.side)
      drag = {handle, pointerStart: handle.side === 'bottom' ? y : x, edgeStart: edgeValue(values, edge), edge}
      computeFlips(handle, false)
      return true
    },
    pointerMove(x: number, y: number) {
      if (drag === null) return null
      const pointer = drag.handle.side === 'bottom' ? y : x
      lastFrame = solver.solveFrame(source, unlocked(), drag.edge, drag.edgeStart + pointer - drag.pointerStart)
      refresh()
      computeFlips(drag.handle, false)
      return lastFrame
    },
    pointerUp() {
      if (drag === null) return
      computeFlips(drag.handle, true)
      drag = null
    },
    scroll(delta: number) {
      source[scrollCell] = Math.min(8192, Math.max(0, source[scrollCell]! + delta))
      refresh()
      // The circuit clamps the scroll position to the content's bottom; keep the clamped value.
      source[scrollCell] = values[scrollWire]!
    },
    setViewport(width: number, height: number) {
      source[app.shell.table.wire('input.viewportWidth')] = Math.min(4096, Math.max(0, width))
      source[app.shell.table.wire('input.viewportHeight')] = Math.min(4096, Math.max(0, height))
      refresh()
    },
    setLocked(name: KnobName, isLocked: boolean) {
      if (isLocked) locked.add(name)
      else locked.delete(name)
    },
    resetKnobs() {
      const fresh = app.createSource(source[app.shell.table.wire('input.viewportWidth')]!, source[app.shell.table.wire('input.viewportHeight')]!)
      for (const name of knobNames) source[app.shell.knobCells.get(name)!] = fresh[app.shell.knobCells.get(name)!]!
      refresh()
      flips = []
      lastFrame = null
    },
  }
}
