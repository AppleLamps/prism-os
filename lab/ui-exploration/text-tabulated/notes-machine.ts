// A Notes window whose width springs while you drag its right edge. One circuit turns the springing
// width into every block's line count, height, shrink-wrapped bubble width, and each painted line's
// start and end cursor. JS decodes the frame clock into step bits, records pointer latches, and turns
// cursors back into strings.

import {emitMaximum, emitMinimum, emitRelu, type Circuit, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {materializeLineRange, prepareWithSegments, type PreparedTextWithSegments} from './pretext/layout.ts'
import {pieceAt, tabulateBlock, type BlockMode, type BlockSpec, type BlockTable} from './tabulate.ts'
import {SourceLayout, emitAtLeast, emitAtLeastCell, emitBlockDeltaRows, emitDeltaRow, programStats, type BlockOutputs} from './step-circuit.ts'
import {emitMatrixSpring, emitStepMatrix, stepBitCount, type SpringConstants} from './springs.ts'
import {notesContent, notesFonts, notesLineHeights, type NotesContent} from './notes-content.ts'

export const notesLayout = {
  windowLeft: 40,
  windowTop: 40,
  titleBarHeight: 36,
  padding: 24,
  gripWidth: 16,
  minWindowWidth: 280,
  maxWindowWidth: 1100,
  initialWindowWidth: 640,
  // Content widths covered by the tables. Wider than the drag range, so spring overshoot stays inside.
  tabulateFrom: 200,
  tabulateTo: 1100,
  tabulateStep: 1,
  blockGap: 14,
  sectionGap: 26,
  bubbleGap: 8,
  bubbleRatio: 0.8,
  bubblePaddingX: 12,
  bubblePaddingY: 8,
  spring: {stiffness: 290, damping: 30} satisfies SpringConstants,
}

export type NotesBlockKind = 'heading' | 'paragraph' | 'bubble'

export type NotesBlock = {
  kind: NotesBlockKind
  text: string
  font: string
  lineHeight: number
  mine: boolean
  paddingX: number
  paddingY: number
  gapAfter: number
  prepared: PreparedTextWithSegments
  spec: BlockSpec
  table: BlockTable
}

export function bubbleMaxContentWidth(contentWidth: number): number {
  // Same shape as pretext's bubbles demo: floor the bubble's max width, then subtract padding.
  return Math.floor(contentWidth * notesLayout.bubbleRatio) - notesLayout.bubblePaddingX * 2
}

export function prepareNotesBlocks(content: NotesContent = notesContent, step = notesLayout.tabulateStep): NotesBlock[] {
  const blocks: NotesBlock[] = []
  const add = (kind: NotesBlockKind, text: string, font: string, lineHeight: number, mode: BlockMode, maxWidthAt: (width: number) => number, mine: boolean, gapAfter: number) => {
    const prepared = prepareWithSegments(text, font)
    const spec: BlockSpec = {prepared, mode, maxWidthAt}
    const table = tabulateBlock(spec, notesLayout.tabulateFrom, notesLayout.tabulateTo, step)
    const isBubble = kind === 'bubble'
    blocks.push({
      kind, text, font, lineHeight, mine, gapAfter, prepared, spec, table,
      paddingX: isBubble ? notesLayout.bubblePaddingX : 0,
      paddingY: isBubble ? notesLayout.bubblePaddingY : 0,
    })
  }
  add('heading', content.heading, notesFonts.heading, notesLineHeights.heading, 'shrinkwrap', width => width, false, notesLayout.blockGap)
  content.paragraphs.forEach((text, index) => {
    const gapAfter = index === content.paragraphs.length - 1 ? notesLayout.sectionGap : notesLayout.blockGap
    add('paragraph', text, notesFonts.body, notesLineHeights.body, 'plain', width => width, false, gapAfter)
  })
  content.messages.forEach((message, index) => {
    const gapAfter = index === content.messages.length - 1 ? 0 : notesLayout.bubbleGap
    add('bubble', message.text, notesFonts.bubble, notesLineHeights.bubble, 'shrinkwrap', bubbleMaxContentWidth, message.mine, gapAfter)
  })
  return blocks
}

export function outputsFor(kind: NotesBlockKind): BlockOutputs {
  return {
    lineCount: true,
    maxLineWidth: true,
    layoutWidth: kind !== 'paragraph',
    cursors: true,
    // Heading lines are centered, so their x needs each line's width.
    lineWidths: kind === 'heading',
  }
}

export type SlotView = {start: number, end: number, x: number | null, y: number, opacity: number}

export type BlockView = {
  top: number
  height: number
  bubbleX: number | null
  bubbleWidth: number | null
  lineCount: number
  maxLineWidth: number
  layoutWidth: number | null
  slots: SlotView[]
}

export type NotesMachine = ReturnType<typeof createNotesMachine>

export function createNotesMachine(blocks: readonly NotesBlock[]) {
  const layoutConstants = notesLayout
  const source = new SourceLayout()
  const coordinate = 16384
  const speed = 1_000_000
  const cells = {
    viewportWidth: source.cell('viewportWidth', 1280, 0, 8192),
    stepBits: Array.from({length: stepBitCount}, (_, bit) => source.cell(`stepBit${bit}`, 0, 0, 1)),
    downActive: source.cell('downActive', 0, 0, 1),
    downX: source.cell('downX', 0, -coordinate, coordinate),
    downY: source.cell('downY', 0, -coordinate, coordinate),
    moveActive: source.cell('moveActive', 0, 0, 1),
    moveX: source.cell('moveX', 0, -coordinate, coordinate),
    upActive: source.cell('upActive', 0, 0, 1),
    upX: source.cell('upX', 0, -coordinate, coordinate),
    pointerX: source.cell('pointerX', 0, -coordinate, coordinate),
    dragging: source.cell('dragging', 0, 0, 1),
    grabOffset: source.cell('grabOffset', 0, -coordinate, coordinate),
    targetWidth: source.cell('targetWidth', layoutConstants.initialWindowWidth, 0, 8192),
    windowWidth: source.cell('windowWidth', layoutConstants.initialWindowWidth, -coordinate, coordinate),
    windowVelocity: source.cell('windowVelocity', 0, -speed, speed),
    windowHeight: source.cell('windowHeight', 0, 0, 1_000_000),
  }
  const initialContentWidth = layoutConstants.initialWindowWidth - 2 * layoutConstants.padding
  const blockCells = blocks.map((block, index) => {
    const piece = pieceAt(block.table.thresholds, initialContentWidth)
    const height = block.table.lineCount[piece]! * block.lineHeight + 2 * block.paddingY
    const bubbleWidth = Math.ceil(block.table.maxLineWidth[piece]!) + 2 * block.paddingX
    return {
      height: source.cell(`block${index}.height`, height, -coordinate, 1_000_000),
      heightVelocity: source.cell(`block${index}.heightVelocity`, 0, -speed, speed),
      width: block.kind === 'bubble' ? source.cell(`block${index}.width`, bubbleWidth, -coordinate, coordinate) : null,
      widthVelocity: block.kind === 'bubble' ? source.cell(`block${index}.widthVelocity`, 0, -speed, speed) : null,
    }
  })
  const circuit: Circuit = source.createCircuit()
  const nextSource: Wire[] = source.values.map((_, wire) => wire)
  const zero = circuit.roundAffine([], 0)
  const constant = (value: number) => circuit.roundAffine([], value)
  const select = (gate: Wire, off: Wire, on: Wire) => circuit.select(gate, off, on)
  const or = (left: Wire, right: Wire) => {
    const positive = emitRelu(circuit, circuit.affine([[left, 1], [right, 1]]))
    const aboveOne = emitRelu(circuit, circuit.affine([[left, 1], [right, 1]], -1))
    const result = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
    circuit.assumeRange(result, 0, 1)
    return result
  }

  // ---- pointer and drag
  for (const latch of [cells.downActive, cells.moveActive, cells.upActive, ...cells.stepBits]) nextSource[latch] = zero
  const pointerX = select(cells.upActive, select(cells.moveActive, select(cells.downActive, cells.pointerX, cells.downX), cells.moveX), cells.upX)
  const windowRight = circuit.roundAffine([[cells.windowWidth, 1]], layoutConstants.windowLeft)
  const gripLeft = circuit.roundAffine([[cells.windowWidth, 1]], layoutConstants.windowLeft - layoutConstants.gripWidth / 2)
  const gripRight = circuit.roundAffine([[cells.windowWidth, 1]], layoutConstants.windowLeft + layoutConstants.gripWidth / 2)
  const windowBottom = circuit.roundAffine([[cells.windowHeight, 1]], layoutConstants.windowTop)
  const insideBits = [
    emitAtLeastCell(circuit, cells.downX, gripLeft),
    emitAtLeastCell(circuit, gripRight, cells.downX),
    emitAtLeast(circuit, cells.downY, layoutConstants.windowTop),
    emitAtLeastCell(circuit, windowBottom, cells.downY),
  ]
  const insideGrip = circuit.reglu([], 1, insideBits.map(bit => [bit, 1] as const), -3)
  circuit.assumeRange(insideGrip, 0, 1)
  const pressOnGrip = circuit.reglu([], 1, [[cells.downActive, 1], [insideGrip, 1]], -1)
  circuit.assumeRange(pressOnGrip, 0, 1)
  const activeDrag = or(cells.dragging, pressOnGrip)
  const grabOffset = select(pressOnGrip, cells.grabOffset, circuit.roundAffine([[cells.downX, 1], [windowRight, -1]]))
  const rawTarget = circuit.roundAffine([[pointerX, 1], [grabOffset, -1]], -layoutConstants.windowLeft)
  const viewportLimit = circuit.roundAffine([[cells.viewportWidth, 1]], -layoutConstants.windowLeft - 20)
  const upperLimit = emitMinimum(circuit, constant(layoutConstants.maxWindowWidth), viewportLimit)
  const clampedTarget = emitMaximum(circuit, emitMinimum(circuit, rawTarget, upperLimit), constant(layoutConstants.minWindowWidth))
  const targetWidth = select(activeDrag, cells.targetWidth, clampedTarget)
  circuit.assumeRange(targetWidth, 0, 8192)
  const dragging = circuit.reglu([], 1, [[activeDrag, 1], [cells.upActive, -1]], 0)
  circuit.assumeRange(dragging, 0, 1)
  nextSource[cells.pointerX] = pointerX
  nextSource[cells.grabOffset] = grabOffset
  nextSource[cells.targetWidth] = targetWidth
  nextSource[cells.dragging] = dragging

  // ---- springs share one runtime step matrix
  const matrix = emitStepMatrix(circuit, cells.stepBits, layoutConstants.spring)
  const windowSpring = emitMatrixSpring(circuit, matrix, cells.windowWidth, cells.windowVelocity, targetWidth)
  nextSource[cells.windowWidth] = windowSpring.position
  nextSource[cells.windowVelocity] = windowSpring.velocity
  const activeTerms: [Wire, number][] = [[dragging, 1], [windowSpring.active, 1]]
  const contentWidth = circuit.roundAffine([[windowSpring.position, 1]], -2 * layoutConstants.padding)
  circuit.assumeRange(contentWidth, 0, 8192)

  // ---- text tables
  const blockWires = blocks.map((block, index) => {
    const rows = emitBlockDeltaRows(circuit, contentWidth, block.table, outputsFor(block.kind))
    const heightTarget = circuit.roundAffine([[rows.lineCount!, block.lineHeight]], 2 * block.paddingY)
    const heightSpring = emitMatrixSpring(circuit, matrix, blockCells[index]!.height, blockCells[index]!.heightVelocity, heightTarget)
    nextSource[blockCells[index]!.height] = heightSpring.position
    nextSource[blockCells[index]!.heightVelocity] = heightSpring.velocity
    activeTerms.push([heightSpring.active, 1])
    let bubbleWidth: Wire | null = null
    if (block.kind === 'bubble') {
      const widthTarget = emitDeltaRow(circuit, rows.bits, block.table.maxLineWidth.map(width => Math.ceil(width) + 2 * block.paddingX))
      const widthSpring = emitMatrixSpring(circuit, matrix, blockCells[index]!.width!, blockCells[index]!.widthVelocity!, widthTarget)
      nextSource[blockCells[index]!.width!] = widthSpring.position
      nextSource[blockCells[index]!.widthVelocity!] = widthSpring.velocity
      activeTerms.push([widthSpring.active, 1])
      bubbleWidth = widthSpring.position
    }
    return {rows, height: heightSpring.position, bubbleWidth}
  })

  // ---- vertical stacking: one wide sum per block top, in block order
  const tops: Wire[] = []
  let gapSum = 0
  for (let index = 0; index < blocks.length; index++) {
    tops.push(circuit.roundAffine(blockWires.slice(0, index).map(wires => [wires.height, 1] as const), gapSum))
    gapSum += blocks[index]!.gapAfter
  }
  const windowHeight = circuit.roundAffine(
    blockWires.map(wires => [wires.height, 1] as const),
    gapSum + layoutConstants.titleBarHeight + 2 * layoutConstants.padding,
  )
  nextSource[cells.windowHeight] = windowHeight
  const animationActive = circuit.roundAffine(activeTerms)

  // ---- projection outputs
  const roots: Wire[] = [...nextSource]
  const push = (wire: Wire) => {
    roots.push(wire)
    return roots.length - 1
  }
  const windowView = {
    width: push(windowSpring.position),
    height: push(windowHeight),
    contentWidth: push(contentWidth),
    animationActive: push(animationActive),
    dragging: push(dragging),
  }
  const blockViews = blocks.map((block, index) => {
    const wires = blockWires[index]!
    const bubbleX = wires.bubbleWidth === null
      ? null
      : block.mine ? circuit.roundAffine([[contentWidth, 1], [wires.bubbleWidth, -1]]) : zero
    const slots = Array.from({length: block.table.slotCount}, (_, slot) => {
      const lineTop = block.paddingY + slot * block.lineHeight
      const x = block.kind === 'heading'
        ? circuit.roundAffine([[contentWidth, 0.5], [wires.rows.lineWidths[slot]!, -0.5]])
        : bubbleX === null ? null : circuit.roundAffine([[bubbleX, 1]], block.paddingX)
      // Lines fade in as the block's springing height uncovers them.
      const reveal = circuit.roundAffine([[wires.height, 1 / block.lineHeight]], -lineTop / block.lineHeight)
      const positive = emitRelu(circuit, reveal)
      const aboveOne = emitRelu(circuit, circuit.affine([[reveal, 1]], -1))
      const opacity = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
      return {
        start: push(wires.rows.starts[slot]!),
        end: push(wires.rows.ends[slot]!),
        x: x === null ? null : push(x),
        y: push(circuit.roundAffine([[tops[index]!, 1]], lineTop)),
        opacity: push(opacity),
      }
    })
    return {
      top: push(tops[index]!),
      height: push(wires.height),
      bubbleX: bubbleX === null ? null : push(bubbleX),
      bubbleWidth: wires.bubbleWidth === null ? null : push(wires.bubbleWidth),
      lineCount: push(wires.rows.lineCount!),
      maxLineWidth: push(wires.rows.maxLineWidth!),
      layoutWidth: wires.rows.layoutWidth === null ? null : push(wires.rows.layoutWidth),
      slots,
    }
  })

  const started = performance.now()
  const evaluate = circuit.createTensorEvaluator(roots)
  const evaluatorMilliseconds = performance.now() - started
  const input = source.table()
  let output: Float32Array<ArrayBufferLike> = new Float32Array(roots.length)
  // Run one frame with zero steps so the source table holds consistent derived state (window height).
  const step = (steps: number) => {
    if (!(Number.isInteger(steps) && steps >= 0 && steps < 2 ** stepBitCount)) throw new Error('steps must be an integer in 0..511')
    for (let bit = 0; bit < stepBitCount; bit++) input[cells.stepBits[bit]!] = (steps >> bit) & 1
    output = evaluate(input)
    for (let wire = 0; wire < nextSource.length; wire++) input[wire] = output[wire]!
    return output
  }
  step(0)

  const read = (index: number) => output[index]!
  const readBlock = (view: typeof blockViews[number]): BlockView => ({
    top: read(view.top),
    height: read(view.height),
    bubbleX: view.bubbleX === null ? null : read(view.bubbleX),
    bubbleWidth: view.bubbleWidth === null ? null : read(view.bubbleWidth),
    lineCount: read(view.lineCount),
    maxLineWidth: read(view.maxLineWidth),
    layoutWidth: view.layoutWidth === null ? null : read(view.layoutWidth),
    slots: view.slots.map(slot => ({
      start: read(slot.start),
      end: read(slot.end),
      x: slot.x === null ? null : read(slot.x),
      y: read(slot.y),
      opacity: read(slot.opacity),
    })),
  })

  return {
    blocks,
    circuit,
    source,
    cells,
    blockCells,
    roots,
    evaluatorMilliseconds,
    stats: () => programStats(circuit, roots),
    step,
    setViewportWidth(width: number) {
      input[cells.viewportWidth] = width
    },
    pointerDown(x: number, y: number) {
      input[cells.downActive] = 1
      input[cells.downX] = x
      input[cells.downY] = y
    },
    pointerMove(x: number) {
      input[cells.moveActive] = 1
      input[cells.moveX] = x
    },
    pointerUp(x: number) {
      input[cells.upActive] = 1
      input[cells.upX] = x
    },
    readWindow: () => ({
      width: read(windowView.width),
      height: read(windowView.height),
      contentWidth: read(windowView.contentWidth),
      animationActive: read(windowView.animationActive),
      dragging: read(windowView.dragging),
    }),
    readBlock: (index: number) => readBlock(blockViews[index]!),
    readSource: (wire: Wire) => input[wire]!,
  }
}

// JS projection: turn a slot's cursor ids back into the line's text.
export function materializeSlot(block: NotesBlock, startId: number, endId: number): string {
  if (startId === endId) return ''
  const start = block.table.cursors[startId]!
  const end = block.table.cursors[endId]!
  return materializeLineRange(block.prepared, {start, end, width: 0}).text
}

// The doctrine's fixed-step clock: 4ms steps, catch up at most 300 steps per frame.
export function createStepClock(startTime: number) {
  let animatedUntil = startTime
  return (now: number) => {
    const steps = Math.min(300, Math.floor((now - animatedUntil) / 4))
    animatedUntil = steps === 300 ? now : animatedUntil + steps * 4
    return Math.max(0, steps)
  }
}
