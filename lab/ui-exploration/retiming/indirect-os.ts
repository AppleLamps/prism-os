// IndirectOS as a retiming workload: spring-bank's copy of window-manager.ts
// (copied into copies/spring-bank), with the original springs or the bank springs,
// driven by codegen's 240-frame session or spring-bank's live resize trace.
import {buildGraph, evaluateRows, flattenProgram, type FlatProgram, type Graph} from './flat.ts'
import {type MetricSpec, type Model, OutputGroupBuilder, type Trace, type TraceRun, describeValue, outputLabelMap} from './retime.ts'
import {
  type WindowManagerOptions,
  bankOptions,
  bankSourceField,
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  originalOptions,
  photoFocusSourceField,
  photoSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
  writeBankFrame,
} from './copies/spring-bank/window-manager.ts'
import {controlField, itemCount as photoCount, photoField, sourceField as photosChildSourceField, thumbnailSpringField} from './copies/spring-bank/photo-gallery.ts'
import {createIndirectOSTrace, scheduleFrameTimes, type TraceEvent} from './copies/spring-bank/trace.ts'
import {createFrameDeltaTracker, defaultClockConfig} from './copies/spring-bank/spring-math.ts'

export {bankOptions, originalOptions}

export type IndirectOSModel = Model & {
  options: WindowManagerOptions
  graph: Graph
  initialSource: Float32Array
  nextSource: Int32Array
  outputLabels: Map<number, string>
  // Computed values that the inlined Photos app reads as its source cells, by
  // the child's field name, and every value built inside the child.
  photosInputs: Map<number, string>
  insidePhotos: Set<number>
}

export const photosWindow = windowCount - 1
const windowStateNames = ['left', 'top', 'width', 'height', 'open', 'minimized', 'maximized', 'present']
const springStateNames = ['centerX', 'centerY', 'width', 'height', 'scale', 'centerXVelocity', 'centerYVelocity', 'widthVelocity', 'heightVelocity', 'scaleVelocity']
const thumbnailSpringNames = ['centerX', 'centerXVelocity', 'scale', 'scaleVelocity']
const laneNames = ['centerX', 'centerY', 'width', 'height', 'scale']

function fieldName(table: Record<string, number>, value: number) {
  return Object.entries(table).find(([name, index]) => index === value && name !== 'size' && !name.endsWith('Start'))?.[0]
}

export function indirectOSSourceName(cell: number): string {
  const direct = cell < sourceField.windowStart ? fieldName(sourceField, cell) : undefined
  if (direct !== undefined) return direct
  if (cell >= sourceField.windowStart && cell < sourceField.dragStart) {
    const offset = cell - sourceField.windowStart
    return `window[${Math.floor(offset / windowStateField.size)}].${windowStateNames[offset % windowStateField.size]}`
  }
  if (cell >= sourceField.dragStart && cell < sourceField.resizeStart) return `drag[${cell - sourceField.dragStart}]`
  if (cell >= sourceField.resizeStart && cell < sourceField.stackStart) return `resize[${cell - sourceField.resizeStart}]`
  if (cell >= sourceField.stackStart && cell < sourceField.springStart) {
    const offset = cell - sourceField.stackStart
    return `stack[rank ${Math.floor(offset / windowCount)}][${offset % windowCount}]`
  }
  if (cell >= sourceField.springStart && cell < sourceField.photoStart) {
    const offset = cell - sourceField.springStart
    return `spring[${Math.floor(offset / 10)}].${springStateNames[offset % 10]}`
  }
  if (cell >= sourceField.photoStart && cell < photoSourceField.focusStart) return `photos.${fieldName(photoSourceField, cell)}`
  if (cell >= photoSourceField.focusStart && cell < photoSourceField.thumbnailSpringStart) return `photos.focus[${cell - photoSourceField.focusStart}]`
  if (cell >= photoSourceField.thumbnailSpringStart && cell < photoSourceField.size) {
    const offset = cell - photoSourceField.thumbnailSpringStart
    return `thumbnailSpring[${Math.floor(offset / thumbnailSpringField.size)}].${thumbnailSpringNames[offset % thumbnailSpringField.size]}`
  }
  if (cell === bankSourceField.frameDeltaMs) return 'bank.frameDeltaMs'
  if (cell === bankSourceField.clockLeftoverMs) return 'bank.clockLeftoverMs'
  if (cell === bankSourceField.clockRunning) return 'bank.clockRunning'
  if (cell >= bankSourceField.springFrameStart && cell < bankSourceField.windowDestinationStart) return `bank.frameMatrix[${cell - bankSourceField.springFrameStart}]`
  if (cell >= bankSourceField.windowDestinationStart && cell < bankSourceField.photoThumbnailDestinationStart) {
    const offset = cell - bankSourceField.windowDestinationStart
    return `bank.previousDestination[${Math.floor(offset / laneNames.length)}].${laneNames[offset % laneNames.length]}`
  }
  if (cell >= bankSourceField.photoThumbnailDestinationStart && cell < bankSourceField.powerTableStart) return `bank.previousThumbnailDestination[${cell - bankSourceField.photoThumbnailDestinationStart}]`
  return `bank.powerTable[${cell - bankSourceField.powerTableStart}]`
}

export type IndirectOSMetricOptions = {
  // Leave the outputs that only decide whether to render another frame out of the
  // metric: animationActive, and with the bank springs the clock's running bit. A cut
  // may then make them a frame late, e.g. render one frame more than needed.
  keepRenderingMayLag?: boolean
}

export function createIndirectOSModel(name: string, options: WindowManagerOptions, metricOptions: IndirectOSMetricOptions = {}): IndirectOSModel {
  const machine = createWindowManagerMachine(options)
  const program: FlatProgram = flattenProgram(machine.tensorProgram)
  const position = (wire: number) => program.positionOfWire[wire]!
  const {output} = machine
  const windowWire = (windowIndex: number, field: number) => position(output.windows[windowIndex * windowOutputField.size + field]!)
  const photosOpacity = windowWire(photosWindow, windowOutputField.opacity)
  const px = new OutputGroupBuilder()
  const scale = new OutputGroupBuilder()
  const opacity = new OutputGroupBuilder()
  const decisions = new OutputGroupBuilder()
  const unitless = new OutputGroupBuilder()
  // With the original springs, a window's stack output adds a fractional
  // animation weight, presence fades, and animationActive is a clamp.
  const decide = (value: number, label: string) => {
    const fractional = options.springs === 'original' && /^windows\[\d\]\.stack$|\.present$|^animationActive$/.test(label)
    ;(fractional ? unitless : decisions).add(value, label)
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const windowOpacity = windowWire(windowIndex, windowOutputField.opacity)
    for (const field of ['translateX', 'translateY', 'width', 'height', 'contentWidth', 'contentHeight'] as const) {
      px.add(windowWire(windowIndex, windowOutputField[field]), `windows[${windowIndex}].${field}`, windowOpacity)
    }
    scale.add(windowWire(windowIndex, windowOutputField.scale), `windows[${windowIndex}].scale × width`, windowOpacity, -1, windowWire(windowIndex, windowOutputField.width))
    scale.add(windowWire(windowIndex, windowOutputField.scale), `windows[${windowIndex}].scale × height`, windowOpacity, -1, windowWire(windowIndex, windowOutputField.height))
    opacity.add(windowOpacity, `windows[${windowIndex}].opacity`)
    for (const field of ['focused', 'stack', 'maximized'] as const) decide(windowWire(windowIndex, windowOutputField[field]), `windows[${windowIndex}].${field}`)
    for (const field of ['left', 'top', 'width', 'height'] as const) {
      px.add(position(output.dockItems[windowIndex * dockOutputField.size + dockOutputField[field]]!), `dock[${windowIndex}].${field}`)
    }
    for (const field of ['inactive', 'focused', 'open'] as const) {
      decide(position(output.dockItems[windowIndex * dockOutputField.size + dockOutputField[field]]!), `dock[${windowIndex}].${field}`)
    }
  }
  for (const [groupName, wires] of [['photos', output.photos.photos], ['thumbnails', output.photos.thumbnails]] as const) {
    for (let item = 0; item < photoCount; item++) {
      const itemWire = (field: number) => position(wires[item * photoField.size + field]!)
      const itemOpacity = itemWire(photoField.opacity)
      for (const field of ['left', 'top', 'width', 'height'] as const) px.add(itemWire(photoField[field]), `${groupName}[${item}].${field}`, itemOpacity, photosOpacity)
      opacity.add(itemOpacity, `${groupName}[${item}].opacity`, photosOpacity)
      decide(itemWire(photoField.focused), `${groupName}[${item}].focused`)
    }
  }
  for (const [groupName, wires] of [['previousControl', output.photos.previousControl], ['nextControl', output.photos.nextControl]] as const) {
    const controlWire = (field: number) => position(wires[field]!)
    for (const field of ['left', 'top', 'width', 'height'] as const) px.add(controlWire(controlField[field]), `${groupName}.${field}`, controlWire(controlField.opacity), photosOpacity)
    opacity.add(controlWire(controlField.opacity), `${groupName}.opacity`, photosOpacity)
  }
  opacity.add(position(output.photos.backdropOpacity), 'photos.backdropOpacity', photosOpacity)
  if (metricOptions.keepRenderingMayLag !== true) decide(position(output.animationActive), 'animationActive')
  const nextSource = Int32Array.from(output.nextSource, position)
  const discreteCells: number[] = [sourceField.timeInitialized]
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized, windowStateField.present]) discreteCells.push(windowSourceField(windowIndex, field))
    discreteCells.push(dragSourceField(windowIndex), resizeSourceField(windowIndex))
    for (let rank = 0; rank < windowCount; rank++) discreteCells.push(stackSourceField(rank, windowIndex))
  }
  for (let item = 0; item < photoCount; item++) discreteCells.push(photoFocusSourceField(item))
  if (options.springs !== 'original' && metricOptions.keepRenderingMayLag !== true) discreteCells.push(bankSourceField.clockRunning)
  for (const cell of discreteCells) decide(nextSource[cell]!, `next ${indirectOSSourceName(cell)}`)
  const metric: MetricSpec = {px: px.build(), scale: scale.build(), opacity: opacity.build(), decisions: decisions.build(), unitless: unitless.build()}

  const outputLabels = outputLabelMap(metric)
  nextSource.forEach((value, cell) => { if (!outputLabels.has(value) && value >= program.sourceSize) outputLabels.set(value, `next ${indirectOSSourceName(cell)}`) })

  const photosInputs = new Map<number, string>()
  const insidePhotos = new Set<number>()
  const {circuit: childCircuit, wireMap} = machine.inlinedPhotos
  for (let wire = 0; wire < wireMap.length; wire++) {
    const parentPosition = program.positionOfWire[wireMap[wire]!]!
    if (parentPosition < program.sourceSize) continue
    if (wire < childCircuit.sourceSize) {
      if (!photosInputs.has(parentPosition)) photosInputs.set(parentPosition, fieldName(photosChildSourceField, wire) ?? `input ${wire}`)
    } else {
      insidePhotos.add(parentPosition)
    }
  }
  return {
    name,
    program,
    metric,
    options,
    graph: buildGraph(program),
    initialSource: new Float32Array(machine.source),
    nextSource,
    outputLabels,
    photosInputs,
    insidePhotos,
  }
}

export function describeIndirectOSValue(model: IndirectOSModel, position: number) {
  const photosInput = model.photosInputs.get(position)
  const place = photosInput !== undefined ? `Photos input ${photosInput}` : model.insidePhotos.has(position) ? 'inside Photos' : 'window manager'
  return {place, ...describeValue(model.graph, position, indirectOSSourceName, model.outputLabels)}
}

// Event writers, as in perturbed-executor.ts's host: latches and coordinates.
function createHost(source: Float32Array) {
  const photoEventFields = [photoSourceField.clickActive, photoSourceField.previousActive, photoSourceField.nextActive, photoSourceField.closeActive]
  const pointer = (active: number, xField: number, yField: number) => (x: number, y: number) => {
    source[active] = 1
    source[xField] = x
    source[yField] = y
  }
  const photo = (field: number) => (x = source[photoSourceField.clickX]!, y = source[photoSourceField.clickY]!) => {
    for (const eventField of photoEventFields) source[eventField] = 0
    source[field] = 1
    source[photoSourceField.clickX] = x
    source[photoSourceField.clickY] = y
  }
  return {
    pointerDown: pointer(sourceField.downActive, sourceField.downX, sourceField.downY),
    pointerMove: pointer(sourceField.moveActive, sourceField.moveX, sourceField.moveY),
    pointerUp: pointer(sourceField.upActive, sourceField.upX, sourceField.upY),
    photoClick: photo(photoSourceField.clickActive),
    photoNext: () => photo(photoSourceField.nextActive)(),
    photoPrevious: () => photo(photoSourceField.previousActive)(),
    photoClose: () => photo(photoSourceField.closeActive)(),
  }
}

type Host = ReturnType<typeof createHost>

function stepFrame(model: IndirectOSModel, source: Float32Array, frameTime: number, frameDelta: (time: number) => number, evaluate: (source: Float32Array) => Float32Array, viewport = {width: 1280, height: 800}) {
  source[sourceField.viewportWidth] = viewport.width
  source[sourceField.viewportHeight] = viewport.height
  if (model.options.springs === 'original') source[sourceField.frameTime] = frameTime
  else writeBankFrame(source, model.options, frameDelta(frameTime))
  const values = evaluate(source)
  for (let field = 0; field < source.length; field++) source[field] = values[model.nextSource[field]!]!
}

// codegen/indirect-os-machine.ts: a deterministic 240-frame session at 1280×800 with
// one 90 ms stall at frame 90. Photos is window 3.
export function interactionFrameTime(frame: number) {
  return 1000 + frame * 16.667 + (frame >= 90 ? 90 : 0)
}

export function applyInteraction(host: Host, frame: number) {
  if (frame === 5) host.pointerDown(150, 70)
  if (frame > 5 && frame <= 30) host.pointerMove(150 + (frame - 5) * 8, 70 + (frame - 5) * 4)
  if (frame === 31) host.pointerUp(350, 170)
  if (frame === 60) host.pointerDown(762, 482)
  if (frame > 60 && frame <= 80) host.pointerMove(762 + (frame - 60) * 5, 482 + (frame - 60) * 3)
  if (frame === 81) host.pointerUp(862, 542)
  if (frame === 100) host.pointerDown(891, 126)
  if (frame === 101) host.pointerUp(891, 126)
  if (frame === 115) host.pointerDown(609, 762)
  if (frame === 116) host.pointerUp(609, 762)
  if (frame === 130) host.pointerDown(1163, 212)
  if (frame === 131) host.pointerUp(1163, 212)
  if (frame === 160) host.photoClick(472, 309)
  if (frame === 175) host.photoNext()
  if (frame === 190) host.photoPrevious()
  if (frame === 200) host.photoClose()
  if (frame === 210) host.pointerDown(1221, 70)
  if (frame === 211) host.pointerUp(1221, 70)
  if (frame === 225) host.pointerDown(835, 126)
  if (frame === 226) host.pointerUp(835, 126)
}

export const codegenSession: Trace<IndirectOSModel> = {
  name: 'codegen session, 240 frames',
  createRun(model): TraceRun {
    const source = new Float32Array(model.initialSource)
    const host = createHost(source)
    const frameDelta = createFrameDeltaTracker(defaultClockConfig)
    return {
      frames: 240,
      frame(index, evaluate) {
        applyInteraction(host, index)
        stepFrame(model, source, interactionFrameTime(index), frameDelta, evaluate)
      },
    }
  },
}

function applyTraceEvent(host: Host, event: TraceEvent) {
  switch (event.kind) {
    case 'pointerDown': host.pointerDown(event.x, event.y); break
    case 'pointerMove': host.pointerMove(event.x, event.y); break
    case 'pointerUp': host.pointerUp(event.x, event.y); break
    case 'photoClick': host.photoClick(event.x, event.y); break
    case 'photoNext': host.photoNext(); break
    case 'photoPrevious': host.photoPrevious(); break
    case 'photoClose': host.photoClose(); break
  }
}

// spring-bank/trace.ts: minimize, restore mid-animation, drag, maximize, restore
// mid-animation, open a photo, next twice, resize Photos by hand, close the
// lightbox, close a window. Events apply in the next rendered frame.
export function liveResizeTrace(fps: number): Trace<IndirectOSModel> {
  const {events, durationMs} = createIndirectOSTrace({liveResize: true})
  const times = scheduleFrameTimes({fps, durationMs})
  return {
    name: `live resize trace, ${fps} fps`,
    createRun(model): TraceRun {
      const source = new Float32Array(model.initialSource)
      const host = createHost(source)
      const frameDelta = createFrameDeltaTracker(defaultClockConfig)
      let nextEvent = 0
      return {
        frames: times.length,
        frame(index, evaluate) {
          const time = times[index]!
          while (nextEvent < events.length && events[nextEvent]!.time <= time) applyTraceEvent(host, events[nextEvent++]!)
          stepFrame(model, source, time, frameDelta, evaluate)
        },
      }
    },
  }
}

// A held-out trace where the browser window itself resizes. Neither trace above
// changes the viewport, so values derived only from the viewport never change there,
// and a cut on them shows no error. Here Photos is maximized, the viewport shrinks
// from 1280×800 to 1000×680 over 2 s, a photo opens, the viewport grows back over
// 1 s, the lightbox closes, and Photos is restored.
export function browserResizeTrace(fps: number): Trace<IndirectOSModel> {
  const at = (thirtyFpsFrame: number) => (thirtyFpsFrame * 1000) / 30
  const events: TraceEvent[] = [
    {time: at(6), kind: 'pointerDown', x: 1163, y: 212},
    {time: at(6), kind: 'pointerUp', x: 1163, y: 212},
    {time: at(120), kind: 'photoClick', x: 60, y: 60},
    {time: at(180), kind: 'photoClose'},
    {time: at(210), kind: 'pointerDown', x: 1221, y: 70},
    {time: at(210), kind: 'pointerUp', x: 1221, y: 70},
  ]
  const times = scheduleFrameTimes({fps, durationMs: at(260)})
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
  const viewportAt = (time: number) => {
    const amount = clamp01((time - at(40)) / (at(100) - at(40))) - clamp01((time - at(130)) / (at(160) - at(130)))
    return {width: Math.round(1280 - 280 * amount), height: Math.round(800 - 120 * amount)}
  }
  return {
    name: `browser resize trace, ${fps} fps`,
    createRun(model): TraceRun {
      const source = new Float32Array(model.initialSource)
      const host = createHost(source)
      const frameDelta = createFrameDeltaTracker(defaultClockConfig)
      let nextEvent = 0
      return {
        frames: times.length,
        frame(index, evaluate) {
          const time = times[index]!
          while (nextEvent < events.length && events[nextEvent]!.time <= time) applyTraceEvent(host, events[nextEvent++]!)
          stepFrame(model, source, time, frameDelta, evaluate, viewportAt(time))
        },
      }
    },
  }
}

// A held-out random trace adapted from notation/traces.ts's randomFrame: clicks on
// title bar buttons and dock items, drags and resizes that sometimes continue over
// several frames, photo clicks, next, previous and close, random frame durations
// of 1 to 41 ms. The viewport moves by small steps instead of jumping. Targets come
// from the reference outputs, computed once without cuts, so every retimed run gets
// the same events.
type RandomFrame = {events: TraceEvent[], width: number, height: number, elapsed: number}

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

export function randomInteractionTrace(model: IndirectOSModel, seed: number, frameCount: number): Trace<IndirectOSModel> {
  const random = createRandom(seed)
  const positionOf = new Map<string, number>()
  for (const group of [model.metric.px, model.metric.opacity, model.metric.decisions, model.metric.unitless]) {
    group.label.forEach((label, index) => positionOf.set(label, group.position[index]!))
  }
  const read = (values: Float32Array, label: string) => values[positionOf.get(label)!]!
  const buttonSize = model.initialSource[sourceField.buttonSize]!
  const buttonGap = model.initialSource[sourceField.buttonGap]!
  const titleHeight = model.initialSource[sourceField.titleHeight]!
  const grip = model.initialSource[sourceField.resizeGrip]!
  const frames: RandomFrame[] = []
  const source = new Float32Array(model.initialSource)
  const host = createHost(source)
  const frameDelta = createFrameDeltaTracker(defaultClockConfig)
  const evaluate = (() => {
    const values = new Float32Array(model.program.valueCount)
    const gatherIndex = new Int32Array(Math.max(1, model.program.slotCompute.length))
    const gatherMass = new Float32Array(Math.max(1, model.program.slotCompute.length))
    const reads = {term: model.program.termPosition, gate: model.program.gatePosition, candidate: model.program.candidatePosition, bit: model.program.bitPosition}
    return (input: Float32Array) => {
      values.set(input)
      evaluateRows(model.program, reads, values, gatherIndex, gatherMass)
      return values
    }
  })()
  let width = 1280
  let height = 800
  let time = 1000
  let values = new Float32Array(model.program.valueCount)
  const apply = (frame: RandomFrame) => {
    for (const event of frame.events) applyTraceEvent(host, event)
    time += frame.elapsed
    stepFrame(model, source, time, frameDelta, input => { values = evaluate(input); return values }, {width: frame.width, height: frame.height})
  }
  const first: RandomFrame = {events: [], width, height, elapsed: 16}
  frames.push(first)
  apply(first)
  for (let frame = 1; frame < frameCount; frame++) {
    const index = Math.floor(random() * windowCount)
    const window = (field: string) => read(values, `windows[${index}].${field}`)
    const elapsed = 1 + random() * 40
    const held = [...Array(windowCount).keys()].some(windowIndex => source[dragSourceField(windowIndex)] === 1 || source[resizeSourceField(windowIndex)] === 1)
    const choice = held && random() < 0.5 ? 12 + Math.floor(random() * 2) : Math.floor(random() * 15)
    const events: TraceEvent[] = []
    const click = (x: number, y: number) => events.push({time, kind: 'pointerDown', x, y}, {time, kind: 'pointerUp', x, y})
    if (choice === 0) {
      width = Math.min(1600, Math.max(600, Math.round(width + (random() - 0.5) * 120)))
      height = Math.min(1000, Math.max(500, Math.round(height + (random() - 0.5) * 80)))
    } else if (choice === 1) {
      events.push({time, kind: 'pointerDown', x: random() * width, y: random() * height}, {time, kind: 'pointerUp', x: random() * width, y: random() * height})
    } else if (choice >= 2 && choice <= 4) {
      const closeX = window('translateX') + window('width') - buttonGap - buttonSize / 2
      click(closeX - (choice - 2 === 2 ? 0 : choice - 2 === 0 ? 1 : 2) * (buttonGap + buttonSize), window('translateY') + titleHeight / 2)
    } else if (choice === 5) {
      click(read(values, `dock[${index}].left`) + read(values, `dock[${index}].width`) / 2, read(values, `dock[${index}].top`) + read(values, `dock[${index}].height`) / 2)
    } else if (choice === 6 || choice === 7) {
      const start = choice === 6
        ? {x: window('translateX') + Math.min(40, window('width') / 4), y: window('translateY') + Math.min(titleHeight / 2, window('height') / 4)}
        : {x: window('translateX') + window('width') - Math.min(grip / 2, window('width') / 4), y: window('translateY') + window('height') - Math.min(grip / 2, window('height') / 4)}
      const end = {x: start.x + (random() - 0.5) * width, y: start.y + (random() - 0.5) * height}
      events.push({time, kind: 'pointerDown', ...start}, {time, kind: 'pointerMove', ...end})
      if (random() < 0.5) events.push({time, kind: 'pointerUp', ...end})
    } else if (choice === 8 || choice === 9) {
      const pool = [...Array(photoCount).keys()].flatMap(item => [`photos[${item}]`, `thumbnails[${item}]`]).concat(['previousControl', 'nextControl'])
      const target = pool[Math.floor(random() * pool.length)]!
      const point = {x: read(values, `${target}.left`) + read(values, `${target}.width`) * random(), y: read(values, `${target}.top`) + read(values, `${target}.height`) * random()}
      if (choice === 8) click(read(values, `windows[${photosWindow}].translateX`) + 1 + point.x, read(values, `windows[${photosWindow}].translateY`) + titleHeight + 1 + point.y)
      events.push({time, kind: 'photoClick', ...point})
    } else if (choice === 10) {
      events.push({time, kind: random() < 0.5 ? 'photoPrevious' : 'photoNext'})
    } else if (choice === 11) {
      events.push({time, kind: 'photoClose'})
    } else if (choice === 12 || choice === 13) {
      const reach = choice === 12 ? {x: 240, y: 240} : {x: width, y: height}
      events.push({time, kind: 'pointerMove', x: source[sourceField.pointerX]! + (random() - 0.5) * reach.x, y: source[sourceField.pointerY]! + (random() - 0.5) * reach.y})
    }
    const next = {events, width, height, elapsed}
    frames.push(next)
    apply(next)
  }
  return {
    name: `random interactions, seed ${seed}`,
    createRun(retimedModel): TraceRun {
      const runSource = new Float32Array(retimedModel.initialSource)
      const runHost = createHost(runSource)
      const runDelta = createFrameDeltaTracker(defaultClockConfig)
      let runTime = 1000
      return {
        frames: frames.length,
        frame(index, frameEvaluate) {
          const frame = frames[index]!
          for (const event of frame.events) applyTraceEvent(runHost, event)
          runTime += frame.elapsed
          stepFrame(retimedModel, runSource, runTime, runDelta, frameEvaluate, {width: frame.width, height: frame.height})
        },
      }
    },
  }
}

// The hand-chosen cut of indirect-os and spring-bank, expressed as registers:
// Photos reads last frame's content size and window opacity.
export function photosPreviousFrameCuts(model: IndirectOSModel) {
  const find = (group: {label: string[], position: Int32Array}, label: string) => group.position[group.label.indexOf(label)]!
  return [
    find(model.metric.px, `windows[${photosWindow}].contentWidth`),
    find(model.metric.px, `windows[${photosWindow}].contentHeight`),
    find(model.metric.opacity, `windows[${photosWindow}].opacity`),
  ]
}
