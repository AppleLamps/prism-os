// A streamed conversation as one fixed circuit: words (segments) arrive into a fixed capacity, every
// word has a spring, a chat bubble is a reduction over its turn's words, and stopping a reply writes
// arrivedCount.
//
// Source cells, all written by JS:
//   maxWidth, columnWidth       the bubble's text width limit and the column the bubbles sit in
//   arrivedCount                how many segments have arrived; later segments are absent or departing
//   widths, breakAfter          per segment, from pretext's prepare on each turn's prefix
//   turnStart                   per segment, 1 at the first segment of each turn after the first
//   stepCount                   fixed 4 ms spring steps for this evaluation
//   spring state                per segment x, y, opacity and their velocities; per turn the bubble's
//                               top, width, height, opacity and velocities
//   previousArrivedCount        the arrivedCount of the previous evaluation, for spawn 'from-previous'
//
// Absent segments (never arrived) have width 0, so they glue onto the end of the last line. Departing
// segments (arrived, then removed by Stop) keep their widths, so they keep their places while they
// fade out. Outputs that describe the whole text (line count, overflow bits, bubbles) read the arrived
// count, never the capacity.
import {emitMaximum, type Circuit, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {
  asIndexReadCircuit,
  atLeastBit,
  compile,
  integerAtLeast,
  integerOneHot,
  integerSteps,
  maskedRead,
  sharedRuntime,
  SourceTable,
  type Compiled,
  type Runtime,
} from './kit.ts'
import {buildWalker, maximumLineWidth, maximumSegmentWidth, type Walker} from './stream-walker.ts'
import {emitStepMatrix, emitWordSpring, type SpringConfig} from '../text-walker/word-springs.ts'

// How lineCount reads the arrived count:
//   'one-hot'     an integer one-hot of arrivedCount and a masked read of lineIndex at arrivedCount - 1
//   'index-read'  the index-read runtime's instruction, lineIndex[arrivedCount - 1]
//   'count'       the number of line slots whose start is before arrivedCount; no read at an index
export type LineCountMode = 'one-hot' | 'index-read' | 'count'

// Where an arriving word starts:
//   'in-place'       at its own place, fading in
//   'from-previous'  at the previous segment's current position, sliding out while fading in
export type SpawnMode = 'in-place' | 'from-previous'

export type FlowLayout = {
  top: number
  left: number
  lineHeight: number
  paddingX: number
  paddingY: number
  gap: number
}

export const defaultFlowLayout: FlowLayout = {top: 8, left: 8, lineHeight: 20, paddingX: 10, paddingY: 6, gap: 10}

export type StreamBuildOptions = {
  capacity: number
  window: number
  lineSlots: number
  epsilon: number
  runLimit?: number
  lineCountMode: LineCountMode
  runtime?: Runtime
  // 1 for a single reply: no turn cells and no turn one-hot. 2 or more for a conversation.
  turnCapacity: number
  rightAlignedTurns: (turn: number) => boolean
  layout: FlowLayout
  // Per turn bubble reductions. Required for a conversation, optional for a single reply.
  bubbles: boolean
  springs: {config: SpringConfig, spawn: SpawnMode} | null
}

// Opacity springs share the frame matrix, so they use the same stiffness and damping, with a finer
// settle threshold.
export const opacitySettleThreshold = 0.002
// A word whose opacity is below 1/64 can't be seen, so its position may jump. The visibility bit is
// exact 0 or 1; opacities within about 1/4096 of 1/64 may land on either side.
export const visibleOpacity = 1 / 64
export const maximumPosition = 2 ** 18

export type StreamCells = {
  unit: Wire
  maxWidth: Wire
  columnWidth: Wire
  startCursor: Wire
  arrivedCount: Wire
  previousArrivedCount: Wire | null
  stepCount: Wire | null
  widths: Wire[]
  breakAfter: Wire[]
  turnStart: Wire[] | null
  words: {x: Wire[], y: Wire[], velocityX: Wire[], velocityY: Wire[], opacity: Wire[], opacityVelocity: Wire[]} | null
  bubbles: {top: Wire[], width: Wire[], height: Wire[], opacity: Wire[], topVelocity: Wire[], widthVelocity: Wire[], heightVelocity: Wire[], opacityVelocity: Wire[]} | null
}

const outputNames = [
  'global', 'lineIndex', 'x', 'targetX', 'targetY',
  'springX', 'springY', 'velocityX', 'velocityY', 'opacity', 'opacityVelocity',
  'turnLineCount', 'turnWidth', 'turnTop', 'turnLeft', 'turnHeight', 'turnPresent',
  'bubbleTop', 'bubbleWidth', 'bubbleHeight', 'bubbleLeft', 'bubbleOpacity',
  'bubbleTopVelocity', 'bubbleWidthVelocity', 'bubbleHeightVelocity', 'bubbleOpacityVelocity',
] as const

export type OutputName = typeof outputNames[number]

export type StreamOutputs = {
  lineCount: number
  windowOverflow: number
  moreLinesThanSlots: number
  runOverflow: number
  turnOverflow: number
  // Sum of spring activity; 0 when every spring has settled.
  animating: number
} & {[Name in Exclude<OutputName, 'global'>]: Float32Array}

export type Phase = {name: string, firstOperation: number}

export type StreamBuild = {
  options: StreamBuildOptions
  cells: StreamCells
  compiled: Compiled
  walker: Walker
  // Operations appended from firstOperation until the next phase belong to that phase.
  phases: Phase[]
  initialTable: () => Float32Array
  outputs: (values: Float32Array) => StreamOutputs
  buildMilliseconds: number
}

export function buildStreamCircuit(options: StreamBuildOptions): StreamBuild {
  const started = performance.now()
  const runtime = options.runtime ?? sharedRuntime
  const capacity = options.capacity
  const turnCapacity = options.turnCapacity
  const layout = options.layout
  if (options.lineCountMode === 'index-read' && runtime.name !== 'index-read') throw new Error("lineCountMode 'index-read' needs the index-read runtime")
  if (turnCapacity >= 2 && !options.bubbles) throw new Error('a conversation needs per turn bubbles to place its turns')

  const source = new SourceTable()
  const springs = options.springs
  const cells: StreamCells = {
    unit: source.unit,
    maxWidth: source.cell(240, 0, maximumLineWidth),
    columnWidth: source.cell(320, 0, 4096),
    startCursor: source.cell(0, 0, capacity),
    arrivedCount: source.cell(0, 0, capacity),
    previousArrivedCount: springs?.spawn === 'from-previous' ? source.cell(0, 0, capacity) : null,
    stepCount: springs === null ? null : source.cell(0, 0, 2 ** springs.config.stepBits - 1),
    widths: Array.from({length: capacity}, () => source.cell(0, 0, maximumSegmentWidth)),
    breakAfter: Array.from({length: capacity}, () => source.cell(0, 0, 1)),
    turnStart: turnCapacity >= 2 ? Array.from({length: capacity}, () => source.cell(0, 0, 1)) : null,
    words: springs === null ? null : {
      x: Array.from({length: capacity}, () => source.cell(0, -maximumPosition, maximumPosition)),
      y: Array.from({length: capacity}, () => source.cell(0, -maximumPosition, maximumPosition)),
      velocityX: Array.from({length: capacity}, () => source.cell(0, -1e6, 1e6)),
      velocityY: Array.from({length: capacity}, () => source.cell(0, -1e6, 1e6)),
      opacity: Array.from({length: capacity}, () => source.cell(0, -1, 2)),
      opacityVelocity: Array.from({length: capacity}, () => source.cell(0, -1e6, 1e6)),
    },
    bubbles: springs === null || !options.bubbles ? null : {
      top: Array.from({length: turnCapacity}, () => source.cell(0, -maximumPosition, maximumPosition)),
      width: Array.from({length: turnCapacity}, () => source.cell(0, -maximumPosition, maximumPosition)),
      height: Array.from({length: turnCapacity}, () => source.cell(0, -maximumPosition, maximumPosition)),
      opacity: Array.from({length: turnCapacity}, () => source.cell(0, -1, 2)),
      topVelocity: Array.from({length: turnCapacity}, () => source.cell(0, -1e6, 1e6)),
      widthVelocity: Array.from({length: turnCapacity}, () => source.cell(0, -1e6, 1e6)),
      heightVelocity: Array.from({length: turnCapacity}, () => source.cell(0, -1e6, 1e6)),
      opacityVelocity: Array.from({length: turnCapacity}, () => source.cell(0, -1e6, 1e6)),
    },
  }
  const circuit = source.createCircuit(runtime)
  const {unit} = cells
  const materialize = (terms: readonly (readonly [Wire, number])[], bias: number, minimum: number, maximum: number): Wire => {
    const wire = circuit.roundAffine(terms, bias)
    circuit.assumeRange(wire, minimum, maximum)
    return wire
  }
  const constant = (value: number): Wire => materialize([[unit, value]], 0, value, value)
  const phases: Phase[] = []
  const mark = (name: string) => phases.push({name, firstOperation: circuit.operations.length})

  const walker = buildWalker(circuit, {
    unit,
    maxWidth: cells.maxWidth,
    startCursor: cells.startCursor,
    arrivedCount: cells.arrivedCount,
    widths: cells.widths,
    breakAfter: cells.breakAfter,
    turnStart: cells.turnStart,
  }, {window: options.window, lineSlots: options.lineSlots, epsilon: options.epsilon, runLimit: options.runLimit ?? 1}, mark)
  const {lineIndex, x, arrivedSteps} = walker

  // lineCount at the arrived count.
  mark('lineCount at the arrived count')
  let lineCount: Wire
  if (options.lineCountMode === 'one-hot') {
    const arrivedOneHot = integerOneHot(circuit, unit, cells.arrivedCount, 0, capacity + 1, false)
    const read = maskedRead(circuit, arrivedOneHot.members, [walker.zero, ...lineIndex])
    // members[0] is [arrivedCount == 0].
    lineCount = materialize([[read, 1], [arrivedOneHot.members[0]!, -1]], 1, 0, options.lineSlots)
  } else if (options.lineCountMode === 'index-read') {
    const read = asIndexReadCircuit(circuit).indexReadAffine([[cells.arrivedCount, 1]], -1, lineIndex, 'zero', 'clamp') as Wire
    lineCount = materialize([[read, 1], ...arrivedSteps.atLeast(1)], 0, 0, options.lineSlots)
  } else {
    const terms = walker.starts.flatMap(start => [[integerAtLeast(circuit, [[cells.arrivedCount, 1], [start, -1]], 0, 1), 1] as const])
    lineCount = materialize(terms, 0, 0, options.lineSlots)
  }

  mark('presence bits and turn one-hots')
  const needsPresence = options.bubbles || springs !== null
  const present = needsPresence ? Array.from({length: capacity}, (_, j) => materialize(arrivedSteps.atLeast(j + 1), 0, 0, 1)) : []

  // Per turn: which turn each segment belongs to, as a one-hot over turns.
  const turnMembers: Wire[][] | null = walker.turnIndex === null ? null : walker.turnIndex.map(index => integerOneHot(circuit, unit, index, 0, turnCapacity, true).members)
  const turnOverflow = walker.turnIndex === null ? walker.zero : integerAtLeast(circuit, [[walker.turnIndex[capacity - 1]!, 1]], 0, turnCapacity)

  const groups = new Map<OutputName, Wire[]>()
  const turnLineCount: Wire[] = []
  const turnWidth: Wire[] = []
  const turnTop: Wire[] = []
  const turnLeft: Wire[] = []
  const turnHeight: Wire[] = []
  const turnPresent: Wire[] = []
  let targetX: Wire[]
  let targetY: Wire[]
  mark('bubbles (reductions over words, placement) and word targets')
  if (options.bubbles) {
    // A bubble is a reduction over its turn's present words: the widest right edge, and the number
    // of present segments that start a line.
    const presentEdge = x.map((xWire, j) => circuit.multiply(materialize([[xWire, 1], [walker.widthHead[j]!, 1]], 0, -(2 ** 17), 2 ** 17), present[j]!))
    if (turnMembers === null) {
      turnWidth.push(maximumTournament(circuit, presentEdge))
      turnLineCount.push(lineCount)
    } else {
      const presentLineStart = lineIndex.map((index, j) => {
        const isLineStart = j === 0 ? unit : materialize([[index, 1], [lineIndex[j - 1]!, -1]], 0, 0, 1)
        return circuit.multiply(isLineStart, present[j]!)
      })
      for (let turn = 0; turn < turnCapacity; turn++) {
        turnWidth.push(maximumTournament(circuit, presentEdge.map((edge, j) => circuit.multiply(edge, turnMembers[j]![turn]!))))
        turnLineCount.push(materialize(presentLineStart.map((bit, j) => [circuit.multiply(bit, turnMembers[j]![turn]!), 1] as const), 0, 0, options.lineSlots))
      }
    }
    for (let turn = 0; turn < turnCapacity; turn++) {
      turnPresent.push(materialize([[integerAtLeast(circuit, [[turnLineCount[turn]!, 1]], 0, 1), 1]], 0, 0, 1))
    }
    const wordOffsetX: Wire[] = []
    const wordOffsetY: Wire[] = []
    for (let turn = 0; turn < turnCapacity; turn++) {
      const earlier: [Wire, number][] = []
      const earlierPresent: [Wire, number][] = []
      for (let before = 0; before < turn; before++) {
        earlier.push([turnLineCount[before]!, layout.lineHeight], [turnPresent[before]!, 2 * layout.paddingY + layout.gap])
        earlierPresent.push([turnPresent[before]!, 2 * layout.paddingY + layout.gap])
      }
      turnTop.push(materialize(earlier, layout.top, layout.top, 2 ** 20))
      turnHeight.push(materialize([[turnLineCount[turn]!, layout.lineHeight], [turnPresent[turn]!, 2 * layout.paddingY]], 0, 0, 2 ** 20))
      const left = options.rightAlignedTurns(turn)
        ? materialize([[cells.columnWidth, 1], [turnWidth[turn]!, -1]], -2 * layout.paddingX - layout.left, -maximumPosition, 2 ** 18)
        : constant(layout.left)
      turnLeft.push(left)
      wordOffsetX.push(materialize([[left, 1]], layout.paddingX, -maximumPosition, 2 ** 18))
      wordOffsetY.push(materialize(earlierPresent, layout.top + layout.paddingY, layout.top + layout.paddingY, 2 ** 20))
    }
    if (turnMembers === null) {
      targetX = x.map(xWire => materialize([[xWire, 1], [wordOffsetX[0]!, 1]], 0, -maximumPosition, 2 ** 18))
      targetY = lineIndex.map(index => materialize([[index, layout.lineHeight], [wordOffsetY[0]!, 1]], 0, 0, 2 ** 20))
    } else {
      targetX = x.map((xWire, j) => materialize([[xWire, 1], [maskedRead(circuit, turnMembers[j]!, wordOffsetX), 1]], 0, -maximumPosition, 2 ** 18))
      targetY = lineIndex.map((index, j) => materialize([[index, layout.lineHeight], [maskedRead(circuit, turnMembers[j]!, wordOffsetY), 1]], 0, 0, 2 ** 20))
    }
    groups.set('turnLineCount', turnLineCount)
    groups.set('turnWidth', turnWidth)
    groups.set('turnTop', turnTop)
    groups.set('turnLeft', turnLeft)
    groups.set('turnHeight', turnHeight)
    groups.set('turnPresent', turnPresent)
  } else {
    targetX = x.map(xWire => materialize([[xWire, 1]], layout.left + layout.paddingX, -maximumPosition, 2 ** 18))
    targetY = lineIndex.map(index => materialize([[index, layout.lineHeight]], layout.top + layout.paddingY, 0, 2 ** 20))
  }

  mark('springs (frame matrix, word springs, bubble springs)')
  const activity: [Wire, number][] = []
  if (springs !== null) {
    const {config, spawn} = springs
    const opacityConfig: SpringConfig = {...config, settleThreshold: opacitySettleThreshold}
    const words = cells.words!
    const matrix = emitStepMatrix(circuit, unit, cells.stepCount!, config)
    const previousSteps = cells.previousArrivedCount === null ? null : integerSteps(circuit, unit, cells.previousArrivedCount, 0)
    const springX: Wire[] = []
    const springY: Wire[] = []
    const velocityX: Wire[] = []
    const velocityY: Wire[] = []
    const opacity: Wire[] = []
    const opacityVelocity: Wire[] = []
    for (let j = 0; j < capacity; j++) {
      const visible = atLeastBit(circuit, unit, words.opacity[j]!, visibleOpacity, 4096)
      // An invisible word starts at its target and at rest.
      let sourceX = circuit.select(visible, targetX[j]!, words.x[j]!)
      let sourceY = circuit.select(visible, targetY[j]!, words.y[j]!)
      if (spawn === 'from-previous' && j > 0) {
        const notWasPresent = materialize(previousSteps!.atLeast(j + 1).map(([wire, coefficient]) => [wire, -coefficient] as const), 1, 0, 1)
        const arriving = circuit.multiply(present[j]!, notWasPresent)
        sourceX = circuit.select(arriving, sourceX, words.x[j - 1]!)
        sourceY = circuit.select(arriving, sourceY, words.y[j - 1]!)
      }
      const sourceVelocityX = circuit.multiply(words.velocityX[j]!, visible)
      const sourceVelocityY = circuit.multiply(words.velocityY[j]!, visible)
      const springOnX = emitWordSpring(circuit, matrix, sourceX, sourceVelocityX, targetX[j]!, config)
      const springOnY = emitWordSpring(circuit, matrix, sourceY, sourceVelocityY, targetY[j]!, config)
      const fade = emitWordSpring(circuit, matrix, words.opacity[j]!, words.opacityVelocity[j]!, present[j]!, opacityConfig)
      springX.push(springOnX.position)
      springY.push(springOnY.position)
      velocityX.push(springOnX.velocity)
      velocityY.push(springOnY.velocity)
      opacity.push(fade.position)
      opacityVelocity.push(fade.velocity)
      activity.push([springOnX.active, 1], [springOnY.active, 1], [fade.active, 1])
    }
    groups.set('springX', springX)
    groups.set('springY', springY)
    groups.set('velocityX', velocityX)
    groups.set('velocityY', velocityY)
    groups.set('opacity', opacity)
    groups.set('opacityVelocity', opacityVelocity)
    if (cells.bubbles !== null) {
      const bubbles = cells.bubbles
      const outputs = {bubbleTop: [] as Wire[], bubbleWidth: [] as Wire[], bubbleHeight: [] as Wire[], bubbleLeft: [] as Wire[], bubbleOpacity: [] as Wire[], bubbleTopVelocity: [] as Wire[], bubbleWidthVelocity: [] as Wire[], bubbleHeightVelocity: [] as Wire[], bubbleOpacityVelocity: [] as Wire[]}
      for (let turn = 0; turn < turnCapacity; turn++) {
        const visible = atLeastBit(circuit, unit, bubbles.opacity[turn]!, visibleOpacity, 4096)
        const spring = (position: Wire, velocity: Wire, target: Wire) => emitWordSpring(circuit, matrix, circuit.select(visible, target, position), circuit.multiply(velocity, visible), target, config)
        const top = spring(bubbles.top[turn]!, bubbles.topVelocity[turn]!, turnTop[turn]!)
        const width = spring(bubbles.width[turn]!, bubbles.widthVelocity[turn]!, turnWidth[turn]!)
        const height = spring(bubbles.height[turn]!, bubbles.heightVelocity[turn]!, turnHeight[turn]!)
        const fade = emitWordSpring(circuit, matrix, bubbles.opacity[turn]!, bubbles.opacityVelocity[turn]!, turnPresent[turn]!, opacityConfig)
        outputs.bubbleTop.push(top.position)
        outputs.bubbleWidth.push(width.position)
        outputs.bubbleHeight.push(height.position)
        outputs.bubbleOpacity.push(fade.position)
        outputs.bubbleTopVelocity.push(top.velocity)
        outputs.bubbleWidthVelocity.push(width.velocity)
        outputs.bubbleHeightVelocity.push(height.velocity)
        outputs.bubbleOpacityVelocity.push(fade.velocity)
        outputs.bubbleLeft.push(options.rightAlignedTurns(turn)
          ? materialize([[cells.columnWidth, 1], [width.position, -1]], -2 * layout.paddingX - layout.left, -maximumPosition, 2 ** 18)
          : constant(layout.left))
        activity.push([top.active, 1], [width.active, 1], [height.active, 1], [fade.active, 1])
      }
      for (const [name, wires] of Object.entries(outputs)) groups.set(name as OutputName, wires)
    }
  }
  const animating = activity.length === 0 ? walker.zero : circuit.roundAffine(activity)

  groups.set('global', [lineCount, walker.windowOverflow, walker.moreLinesThanSlots, walker.runOverflow, turnOverflow, animating])
  groups.set('lineIndex', lineIndex)
  groups.set('x', x)
  groups.set('targetX', targetX)
  groups.set('targetY', targetY)

  const roots: Wire[] = []
  const offsets = new Map<OutputName, [number, number]>()
  for (const name of outputNames) {
    const wires = groups.get(name) ?? []
    offsets.set(name, [roots.length, wires.length])
    roots.push(...wires)
  }
  const compiled = compile(circuit, roots, runtime)
  const initial = source.table()
  return {
    options,
    cells,
    compiled,
    walker,
    phases,
    initialTable: () => Float32Array.from(initial),
    outputs: values => {
      const view = (name: OutputName) => {
        const [offset, length] = offsets.get(name)!
        return values.subarray(offset, offset + length)
      }
      const result = {
        lineCount: values[0]!,
        windowOverflow: values[1]!,
        moreLinesThanSlots: values[2]!,
        runOverflow: values[3]!,
        turnOverflow: values[4]!,
        animating: values[5]!,
      } as StreamOutputs
      for (const name of outputNames) if (name !== 'global') result[name] = view(name)
      return result
    },
    buildMilliseconds: performance.now() - started,
  }
}

export function maximumTournament(circuit: Circuit, values: readonly Wire[]): Wire {
  let level = [...values]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? emitMaximum(circuit, level[index]!, level[index + 1]!) : level[index]!)
    }
    level = next
  }
  return level[0]!
}

// Live operations per build phase. An operation deduplicated into an earlier identical expression
// counts in the phase that first built it.
export function liveOperationsByPhase(build: StreamBuild): {name: string, liveOperations: number}[] {
  const {circuit, program} = build.compiled
  const counts = build.phases.map(phase => ({name: phase.name, liveOperations: 0}))
  for (let position = circuit.sourceSize; position < program.wireOrder.length; position++) {
    const operation = program.wireOrder[position]! - circuit.sourceSize
    let phase = 0
    while (phase + 1 < build.phases.length && build.phases[phase + 1]!.firstOperation <= operation) phase++
    counts[phase]!.liveOperations++
  }
  return counts
}

// Copies every spring's next position and velocity back into the source table, and remembers this
// evaluation's arrivedCount.
export function writeBack(build: StreamBuild, table: Float32Array, outputs: StreamOutputs): void {
  const {cells} = build
  if (cells.previousArrivedCount !== null) table[cells.previousArrivedCount] = table[cells.arrivedCount]!
  const words = cells.words
  if (words !== null) {
    for (let j = 0; j < build.options.capacity; j++) {
      table[words.x[j]!] = outputs.springX[j]!
      table[words.y[j]!] = outputs.springY[j]!
      table[words.velocityX[j]!] = outputs.velocityX[j]!
      table[words.velocityY[j]!] = outputs.velocityY[j]!
      table[words.opacity[j]!] = outputs.opacity[j]!
      table[words.opacityVelocity[j]!] = outputs.opacityVelocity[j]!
    }
  }
  const bubbles = cells.bubbles
  if (bubbles !== null) {
    for (let turn = 0; turn < build.options.turnCapacity; turn++) {
      table[bubbles.top[turn]!] = outputs.bubbleTop[turn]!
      table[bubbles.width[turn]!] = outputs.bubbleWidth[turn]!
      table[bubbles.height[turn]!] = outputs.bubbleHeight[turn]!
      table[bubbles.opacity[turn]!] = outputs.bubbleOpacity[turn]!
      table[bubbles.topVelocity[turn]!] = outputs.bubbleTopVelocity[turn]!
      table[bubbles.widthVelocity[turn]!] = outputs.bubbleWidthVelocity[turn]!
      table[bubbles.heightVelocity[turn]!] = outputs.bubbleHeightVelocity[turn]!
      table[bubbles.opacityVelocity[turn]!] = outputs.bubbleOpacityVelocity[turn]!
    }
  }
}

// First paint: every spring at its target and at rest, present words and bubbles fully opaque.
// Evaluates with 0 steps, so nothing moves.
export function settleAtTargets(build: StreamBuild, table: Float32Array): StreamOutputs {
  const {cells} = build
  if (cells.stepCount !== null) table[cells.stepCount] = 0
  const outputs = build.outputs(build.compiled.evaluate(table))
  if (cells.previousArrivedCount !== null) table[cells.previousArrivedCount] = table[cells.arrivedCount]!
  const arrived = table[cells.arrivedCount]!
  const words = cells.words
  if (words !== null) {
    for (let j = 0; j < build.options.capacity; j++) {
      table[words.x[j]!] = outputs.targetX[j]!
      table[words.y[j]!] = outputs.targetY[j]!
      table[words.velocityX[j]!] = 0
      table[words.velocityY[j]!] = 0
      table[words.opacity[j]!] = j < arrived ? 1 : 0
      table[words.opacityVelocity[j]!] = 0
    }
  }
  const bubbles = cells.bubbles
  if (bubbles !== null) {
    for (let turn = 0; turn < build.options.turnCapacity; turn++) {
      table[bubbles.top[turn]!] = outputs.turnTop[turn]!
      table[bubbles.width[turn]!] = outputs.turnWidth[turn]!
      table[bubbles.height[turn]!] = outputs.turnHeight[turn]!
      table[bubbles.opacity[turn]!] = outputs.turnPresent[turn]!
      table[bubbles.topVelocity[turn]!] = 0
      table[bubbles.widthVelocity[turn]!] = 0
      table[bubbles.heightVelocity[turn]!] = 0
      table[bubbles.opacityVelocity[turn]!] = 0
    }
  }
  return build.outputs(build.compiled.evaluate(table))
}
