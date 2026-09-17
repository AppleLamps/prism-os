// A paragraph flowing around a rectangle, like pretext's dynamic-layout demo, in one circuit.
//
// Every band (one line height tall) gets its available slot from the obstacle state: the column
// minus the rectangle's padded interval when the rectangle overlaps the band, keeping the widest
// remaining slot at least minimumSlotWidth wide (dynamic-layout uses 24px; ties go to the right
// slot, as layoutColumn does for its left column). A band with no slot lays out nothing. Each band's line comes from the gathered line walker
// with that band's own width, and each word gets a position, then a spring toward it.
//
// Geometry cells are integers (the demo rounds pointer coordinates once), so every geometry
// comparison is an exact integer comparison.
import {type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {compile, integerAtLeast, relu, type Compiled, type SourceTable} from './kit.ts'
import {createFastCircuit, segmentGeometry, walkGatheredLines, type FastCircuit, type FastParagraph} from './fast-walker.ts'
import {defaultSpringConfig, emitStepMatrix, emitWordSpring, type SpringConfig} from './word-springs.ts'

export type FlowOptions = {
  window: number
  epsilon: number
  top: number
  lineHeight: number
  bandCount: number
  horizontalPadding: number
  verticalPadding: number
  minimumSlotWidth: number
  // Springs for the segments listed (usually the text segments), or null for geometry only.
  springSegments: readonly number[] | null
  springConfig?: SpringConfig
  // The longest run of break-after segments the walker handles; see createFastCircuit.
  runLimit?: number
}

export type FlowState = {
  columnLeft: number
  columnWidth: number
  obstacleX: number
  obstacleY: number
  obstacleWidth: number
  obstacleHeight: number
}

export type FlowCells = {[Key in keyof FlowState]: Wire} & {stepCount: Wire, positionX: Wire[], positionY: Wire[], velocityX: Wire[], velocityY: Wire[]}

export type BandOutput = {usable: number, left: number, slotWidth: number, start: number, lineWidth: number}

export type FlowOutputs = {
  lineCount: number
  windowOverflow: number
  runOverflow: number
  bands: BandOutput[]
  segments: {visible: number, x: number, y: number}[]
  springs: {x: number, y: number, velocityX: number, velocityY: number, active: number}[]
}

export type FlowBuild = {
  fc: FastCircuit
  cells: FlowCells
  compiled: Compiled
  springSegments: readonly number[]
  decode: (values: Float32Array) => FlowOutputs
}

export function buildFlowCircuit(paragraph: FastParagraph, options: FlowOptions): FlowBuild {
  const springSegments = options.springSegments ?? []
  const springConfig = options.springConfig ?? defaultSpringConfig
  let cells: FlowCells | null = null
  const fc = createFastCircuit(paragraph, options.epsilon, (source: SourceTable) => {
    cells = {
      columnLeft: source.cell(0, 0, 4096),
      columnWidth: source.cell(320, 0, 4096),
      obstacleX: source.cell(-1000, -4096, 8192),
      obstacleY: source.cell(-1000, -4096, 8192),
      obstacleWidth: source.cell(0, 0, 4096),
      obstacleHeight: source.cell(0, 0, 4096),
      stepCount: source.cell(0, 0, 2 ** springConfig.stepBits - 1),
      positionX: springSegments.map(() => source.cell(0, -32768, 32768)),
      positionY: springSegments.map(() => source.cell(0, -32768, 32768)),
      velocityX: springSegments.map(() => source.cell(0, -1e6, 1e6)),
      velocityY: springSegments.map(() => source.cell(0, -1e6, 1e6)),
    }
  }, options.runLimit)
  const flowCells = cells! as FlowCells
  const {circuit, unit} = fc
  const {columnLeft, columnWidth, obstacleX, obstacleY, obstacleWidth, obstacleHeight} = flowCells
  const hPad = options.horizontalPadding
  const vPad = options.verticalPadding

  // Slot choice when the rectangle blocks a band. It doesn't depend on the band.
  const intersectsRight = integerAtLeast(circuit, [[obstacleX, 1], [obstacleWidth, 1], [columnLeft, -1]], hPad, 1)
  const intersectsLeft = integerAtLeast(circuit, [[columnLeft, 1], [columnWidth, 1], [obstacleX, -1]], hPad, 1)
  const intersects = circuit.multiply(intersectsRight, intersectsLeft)
  const leftWidth = relu(circuit, [[obstacleX, 1], [columnLeft, -1]], -hPad)
  const rightWidth = relu(circuit, [[columnLeft, 1], [columnWidth, 1], [obstacleX, -1], [obstacleWidth, -1]], -hPad)
  const leftFits = integerAtLeast(circuit, [[leftWidth, 1]], 0, options.minimumSlotWidth)
  const rightFits = integerAtLeast(circuit, [[rightWidth, 1]], 0, options.minimumSlotWidth)
  const rightWider = integerAtLeast(circuit, [[rightWidth, 1], [leftWidth, -1]], 0, 0)
  const bothFit = circuit.multiply(rightFits, leftFits)
  const chooseRight = circuit.roundAffine([[rightFits, 1], [bothFit, -1], [circuit.multiply(bothFit, rightWider), 1]])
  circuit.assumeRange(chooseRight, 0, 1)
  const chooseLeft = circuit.roundAffine([[leftFits, 1], [circuit.multiply(leftFits, chooseRight), -1]])
  circuit.assumeRange(chooseLeft, 0, 1)
  const anySlot = circuit.roundAffine([[leftFits, 1], [rightFits, 1], [bothFit, -1]])
  circuit.assumeRange(anySlot, 0, 1)
  const blockedWidth = circuit.roundAffine([[circuit.multiply(rightWidth, chooseRight), 1], [circuit.multiply(leftWidth, chooseLeft), 1]])
  circuit.assumeRange(blockedWidth, 0, 4096)
  const widthChange = circuit.roundAffine([[blockedWidth, 1], [columnWidth, -1]])
  const rightSlotShift = circuit.roundAffine([[obstacleX, 1], [obstacleWidth, 1], [columnLeft, -1]], hPad)
  circuit.assumeRange(rightSlotShift, 0, 8192)
  const leftChange = circuit.multiply(rightSlotShift, chooseRight)

  const lineWidths: Wire[] = []
  const lefts: Wire[] = []
  const usable: Wire[] = []
  for (let band = 0; band < options.bandCount; band++) {
    const bandTop = options.top + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    // getRectIntervalsForBand: the rectangle blocks the band unless the band is entirely above or below.
    const belowTop = integerAtLeast(circuit, [[obstacleY, -1]], bandBottom + vPad, 1)
    const aboveBottom = integerAtLeast(circuit, [[obstacleY, 1], [obstacleHeight, 1]], vPad - bandTop, 1)
    const blocked = circuit.multiply(circuit.multiply(belowTop, aboveBottom), intersects)
    circuit.assumeRange(blocked, 0, 1)
    const width = circuit.roundAffine([[columnWidth, 1], [circuit.multiply(widthChange, blocked), 1]])
    circuit.assumeRange(width, 0, 4096)
    lineWidths.push(width)
    lefts.push(circuit.roundAffine([[columnLeft, 1], [circuit.multiply(leftChange, blocked), 1]]))
    const gate = circuit.roundAffine([[blocked, -1], [circuit.multiply(blocked, anySlot), 1]], 1)
    circuit.assumeRange(gate, 0, 1)
    usable.push(gate)
  }

  const walk = walkGatheredLines(fc, options.window, lineWidths, usable)
  const geometry = segmentGeometry(fc, walk, lefts, options.top, options.lineHeight)
  const roots: Wire[] = [walk.lineCount, walk.windowOverflow, fc.runOverflow]
  for (let band = 0; band < options.bandCount; band++) roots.push(usable[band]!, lefts[band]!, lineWidths[band]!, walk.starts[band]!, walk.widths[band]!)
  for (let segment = 0; segment < fc.segmentCount; segment++) roots.push(geometry.visible[segment]!, geometry.x[segment]!, geometry.y[segment]!)
  if (springSegments.length > 0) {
    const matrix = emitStepMatrix(circuit, unit, flowCells.stepCount, springConfig)
    springSegments.forEach((segment, index) => {
      const springX = emitWordSpring(circuit, matrix, flowCells.positionX[index]!, flowCells.velocityX[index]!, geometry.x[segment]!, springConfig)
      const springY = emitWordSpring(circuit, matrix, flowCells.positionY[index]!, flowCells.velocityY[index]!, geometry.y[segment]!, springConfig)
      const active = circuit.roundAffine([[springX.active, 1], [springY.active, 1]])
      roots.push(springX.position, springY.position, springX.velocity, springY.velocity, active)
    })
  }
  const compiled = compile(circuit, roots)
  const bandOffset = 3
  const segmentOffset = bandOffset + options.bandCount * 5
  const springOffset = segmentOffset + fc.segmentCount * 3
  return {
    fc,
    cells: flowCells,
    compiled,
    springSegments,
    decode: values => ({
      lineCount: values[0]!,
      windowOverflow: values[1]!,
      runOverflow: values[2]!,
      bands: Array.from({length: options.bandCount}, (_, band) => {
        const base = bandOffset + band * 5
        return {usable: values[base]!, left: values[base + 1]!, slotWidth: values[base + 2]!, start: values[base + 3]!, lineWidth: values[base + 4]!}
      }),
      segments: Array.from({length: fc.segmentCount}, (_, segment) => {
        const base = segmentOffset + segment * 3
        return {visible: values[base]!, x: values[base + 1]!, y: values[base + 2]!}
      }),
      springs: springSegments.map((_, index) => {
        const base = springOffset + index * 5
        return {x: values[base]!, y: values[base + 1]!, velocityX: values[base + 2]!, velocityY: values[base + 3]!, active: values[base + 4]!}
      }),
    }),
  }
}

export function writeFlowState(build: FlowBuild, table: Float32Array, state: FlowState): void {
  for (const key of Object.keys(state) as (keyof FlowState)[]) table[build.cells[key]] = state[key]
}

// Copies each spring's next position and velocity back into the source table.
export function writeSpringState(build: FlowBuild, table: Float32Array, outputs: FlowOutputs): void {
  outputs.springs.forEach((spring, index) => {
    table[build.cells.positionX[index]!] = spring.x
    table[build.cells.positionY[index]!] = spring.y
    table[build.cells.velocityX[index]!] = spring.velocityX
    table[build.cells.velocityY[index]!] = spring.velocityY
  })
}

type Interval = {left: number, right: number}
type Cursor = {segmentIndex: number, graphemeIndex: number}
type LineRange = {width: number, start: Cursor, end: Cursor}

export type ReferenceFlow = {
  bands: {usable: boolean, left: number, slotWidth: number, line: LineRange | null}[]
  segments: {visible: boolean, x: number, y: number}[]
}

// The reference: dynamic-layout's layoutColumn for one rectangle, with pretext's layoutNextLineRange.
export function referenceFlow(
  layoutNextLineRange: (prepared: never, start: Cursor, maxWidth: number) => LineRange | null,
  prepared: object,
  paragraph: FastParagraph,
  state: FlowState,
  options: Pick<FlowOptions, 'top' | 'lineHeight' | 'bandCount' | 'horizontalPadding' | 'verticalPadding' | 'minimumSlotWidth'>,
): ReferenceFlow {
  const bands: ReferenceFlow['bands'] = []
  const segments = paragraph.widths.map(() => ({visible: false, x: 0, y: 0}))
  let cursor: Cursor = {segmentIndex: 0, graphemeIndex: 0}
  const columnLeft = state.columnLeft
  const columnRight = state.columnLeft + state.columnWidth
  for (let band = 0; band < options.bandCount; band++) {
    const bandTop = options.top + band * options.lineHeight
    const bandBottom = bandTop + options.lineHeight
    const blocked: Interval[] = []
    if (!(bandBottom <= state.obstacleY - options.verticalPadding || bandTop >= state.obstacleY + state.obstacleHeight + options.verticalPadding)) {
      blocked.push({left: state.obstacleX - options.horizontalPadding, right: state.obstacleX + state.obstacleWidth + options.horizontalPadding})
    }
    let slots: Interval[] = [{left: columnLeft, right: columnRight}]
    for (const interval of blocked) {
      const next: Interval[] = []
      for (const slot of slots) {
        if (interval.right <= slot.left || interval.left >= slot.right) {
          next.push(slot)
          continue
        }
        if (interval.left > slot.left) next.push({left: slot.left, right: interval.left})
        if (interval.right < slot.right) next.push({left: interval.right, right: slot.right})
      }
      slots = next
    }
    slots = slots.filter(slot => slot.right - slot.left >= options.minimumSlotWidth)
    if (slots.length === 0) {
      bands.push({usable: false, left: 0, slotWidth: 0, line: null})
      continue
    }
    let slot = slots[0]!
    for (let index = 1; index < slots.length; index++) {
      const candidate = slots[index]!
      const bestWidth = slot.right - slot.left
      const candidateWidth = candidate.right - candidate.left
      if (candidateWidth > bestWidth || (candidateWidth === bestWidth && candidate.left > slot.left)) slot = candidate
    }
    const slotWidth = slot.right - slot.left
    const line = layoutNextLineRange(prepared as never, cursor, slotWidth)
    bands.push({usable: true, left: slot.left, slotWidth, line})
    if (line === null) continue
    let x = slot.left
    for (let segment = line.start.segmentIndex; segment < line.end.segmentIndex; segment++) {
      segments[segment] = {visible: true, x, y: bandTop}
      x += paragraph.widths[segment]!
    }
    cursor = line.end
  }
  return {bands, segments}
}
