// IndirectOS in the notation, with each phase 2 change behind an option so the
// report can attribute the difference to each change:
// - declareTimestep: declare the original spring timestep nonnegative where it is computed
// - springs: the original emitSpring lanes, or the spring bank (fixed 4 ms steps,
//   one frame matrix per group, one settle bit per box, deferred retargeting)
// - photosViewport: Photos lays out at this frame's projected window size, or at
//   the window's stepped springs before the settle snap (early in the circuit)
// - input: one latch per pointer event kind, or a fixed-capacity event queue
//   handled in one evaluation (desktop-queue.ts)
// - notes: the Notes window's paragraph flowing around the other windows (notes.ts)
//
// With originalOptions the build creates the same operations in the same order
// as window-manager.ts, so the compiled circuit is identical.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type DesktopResult, type DesktopContext, buildLatchDesktop} from './desktop-latches.ts'
import {type QueuedEvent, legalizePointerStream, splitIntoEvaluations, writeQueue} from './events.ts'
import {type QueueCells, buildQueueDesktop, declareQueueRules, queueCells} from './desktop-queue.ts'
import {type NotesBuild, type NotesOptions, buildNotes, notesCells} from './notes.ts'
import {
  type PhotoDebug,
  type PhotoSprings,
  buildPhotos,
  declarePhotoRules,
  photoBankCells,
  photoConstantCells,
  photoInputContract,
  photoLatchCells,
  photoStateCells,
} from './photos.ts'
import {type SpringClock, type SpringGroup, createConstantPowerGroup, createSpringClock, emitSpringBox, withSection} from '../spring-bank/spring-bank.ts'
import {createFrameDeltaTracker, defaultClockConfig} from '../spring-bank/spring-math.ts'
import {
  anyNumber,
  bit,
  constant,
  createOutputValidator,
  createSourceTable,
  event,
  input,
  leafWires,
  list,
  nonNegative,
  permutation,
  state,
  unitInterval,
} from './table.ts'
import {type Rect, createNotation} from '../notation/wires.ts'

// category: declarations
export const windowCount = 4
export const notesWindowIndex = 1
export const photosWindowIndex = 3
const pixel = [0, 16_384] as const
const center = [-16_384, 32_768] as const
const smallPixel = [0, 1024] as const
export const initialGeometry = [[54, 54, 520, 340], [410, 104, 500, 366], [174, 344, 470, 300], [650, 190, 560, 430]] as const
export const springField = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
export const windowSpringConstants = {stiffness: 650, damping: 45}

export type InputChoice = {kind: 'latches'} | {kind: 'queue', capacity: number, maximumDowns: number, keyGates?: 'gather' | 'per-phase'}
export type IndirectOSOptions = {
  declareTimestep: boolean
  springs: 'original' | 'bank'
  photosViewport: 'current-frame' | 'stepped-springs'
  input: InputChoice
  notes: NotesOptions | null
}
export const originalOptions: IndirectOSOptions = {declareTimestep: false, springs: 'original', photosViewport: 'current-frame', input: {kind: 'latches'}, notes: null}

const layoutCells = {
  viewportWidth: input(pixel),
  viewportHeight: input(pixel),
  unit: constant(1, [1, 1]),
  margin: constant(12, smallPixel),
  titleHeight: constant(44, smallPixel),
  minWidth: constant(280, smallPixel),
  minHeight: constant(190, smallPixel),
  resizeGrip: constant(24, smallPixel),
  buttonSize: constant(18, smallPixel),
  buttonGap: constant(10, smallPixel),
  dockHeight: constant(76, smallPixel),
  dockGap: constant(12, smallPixel),
  dockItemWidth: constant(50, smallPixel),
}
export const latchCells = {
  down: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  move: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  up: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  pointer: {x: state(anyNumber), y: state(anyNumber)},
}
const originalClockCells = {frameTime: input(nonNegative), previousFrameTime: state(nonNegative), timeInitialized: bit()}
const springConstantCells = {
  stiffness: constant(650, nonNegative),
  damping: constant(45, nonNegative),
  maxFrameDuration: constant(32, nonNegative),
  settleDistance: constant(0.01, nonNegative),
  settleSpeed: constant(0.01, nonNegative),
  settleDistanceScale: constant(100, nonNegative),
  settleSpeedScale: constant(100, nonNegative),
}
const windowCells = list(windowCount, index => {
  const [left, top, width, height] = initialGeometry[index]!
  return {
    left: state(pixel, left), top: state(pixel, top), width: state(pixel, width), height: state(pixel, height),
    open: bit(1), minimized: bit(), maximized: bit(), present: state(unitInterval, 1),
  }
})
const pressLatchCells = {drag: list(windowCount, () => bit()), resize: list(windowCount, () => bit())}
const windowSpringCells = list(windowCount, index => {
  const [left, top, width, height] = initialGeometry[index]!
  return {
    position: {centerX: state(anyNumber, left + width / 2), centerY: state(anyNumber, top + height / 2), width: state(anyNumber, width), height: state(anyNumber, height), scale: state(unitInterval, 1)},
    velocity: {centerX: state(anyNumber), centerY: state(anyNumber), width: state(anyNumber), height: state(anyNumber), scale: state(anyNumber)},
  }
})
// The bank's clock, and the destination each window lane stepped toward last frame.
const bankCells = {
  frameDeltaMs: input([0, defaultClockConfig.maxFrameDeltaMs]),
  leftoverMs: state([0, defaultClockConfig.maxFrameDeltaMs]),
  running: bit(),
  // Centers may sit a little outside the viewport, e.g. a dock item in a 2 px
  // wide viewport is centered at -4.8e-7 px after FP32 rounds a third.
  windowDestinations: list(windowCount, index => {
    const [left, top, width, height] = initialGeometry[index]!
    return {centerX: state(center, left + width / 2), centerY: state(center, top + height / 2), width: state(pixel, width), height: state(pixel, height), scale: state(unitInterval, 1)}
  }),
}

// category: behavior
export function buildIndirectOS(options: IndirectOSOptions = originalOptions) {
  invariant(options.springs === 'bank' || options.photosViewport === 'current-frame', 'Photos reads stepped springs only with the spring bank')
  invariant(options.notes === null || options.input.kind === 'queue', 'the Notes flow is built on the queue input')
  const latchesOn = options.input.kind === 'latches'
  const table = createSourceTable()
  // Allocation order follows window-manager.ts's source layout; cells only a
  // variant needs are left out, and cells new to this folder come last.
  const layout = table.allocate('', layoutCells)
  const latches = latchesOn ? table.allocate('', latchCells) : null
  const systemBarHeight = table.allocate('systemBarHeight', constant(36, smallPixel))
  const originalClock = options.springs === 'original' ? table.allocate('', originalClockCells) : null
  const springConstants = table.allocate('springs', springConstantCells)
  const windows = table.allocate('windows', windowCells)
  const pressLatches = latchesOn ? table.allocate('', pressLatchCells) : null
  const stack = table.allocate('stack', permutation(list(windowCount, index => index)))
  const windowSprings = table.allocate('windowSprings', windowSpringCells)
  const photoScope = table.scope('photos')
  const photoConstants = photoScope.allocate('', photoConstantCells)
  const photoLatches = latchesOn ? photoScope.allocate('', photoLatchCells) : null
  const photoState = photoScope.allocate('', photoStateCells)
  const bank = options.springs === 'bank' ? table.allocate('bank', bankCells) : null
  const photoDestinations = bank === null ? null : photoScope.allocate('destinations', photoBankCells)
  const queue: QueueCells | null = options.input.kind === 'queue' ? table.allocate('queue', queueCells(options.input.capacity)) : null
  const notesCellWires = options.notes === null ? null : table.scope('notes').allocate('', notesCells(options.notes))
  if (pressLatches !== null) {
    table.atMostOne('drag', pressLatches.drag)
    table.atMostOne('resize', pressLatches.resize)
  }
  if (photoLatches !== null) declarePhotoRules(table, photoLatches)
  if (queue !== null) declareQueueRules(table, queue)
  const circuit = table.createCircuit()
  const $ = createNotation(circuit, layout.unit)
  const {sum, sub, scale, half, relu, mul, min, clamp, clamp01, not, select, rect, zero, unit} = $
  const {viewportWidth, viewportHeight, titleHeight} = layout

  let springTimestep: Wire | null = null
  let clock: SpringClock | null = null
  let windowGroup: SpringGroup | null = null
  if (originalClock !== null) {
    const frameDuration = mul(originalClock.timeInitialized, clamp(sub(originalClock.frameTime, originalClock.previousFrameTime), zero, springConstants.maxFrameDuration))
    springTimestep = scale(frameDuration, 0.001 / 4)
    // The original learns that the timestep is nonnegative only when Photos declares
    // its inputs, after the window springs are built.
    if (options.declareTimestep) $.assume(springTimestep, 0, Number.POSITIVE_INFINITY)
  } else {
    const cells = bank!
    clock = createSpringClock(circuit, {frameDeltaMs: cells.frameDeltaMs, leftoverMs: cells.leftoverMs, running: cells.running, unit}, defaultClockConfig)
    windowGroup = createConstantPowerGroup(circuit, clock, windowSpringConstants, 'split-table')
  }
  const dockHeight = min(layout.dockHeight, viewportHeight)
  const dockTop = sub(viewportHeight, dockHeight)
  const workspaceTop = min(systemBarHeight, dockTop)
  const workspaceHeight = sub(dockTop, workspaceTop)
  const maximizedLeft = min(layout.margin, half(viewportWidth))
  const maximizedTopInset = min(layout.margin, half(workspaceHeight))
  const maximizedRect = rect(maximizedLeft, sum(workspaceTop, maximizedTopInset), relu(sum(viewportWidth, [maximizedLeft, -2])), relu(sum(workspaceHeight, [maximizedTopInset, -2])))

  const context: DesktopContext = {$, table, layout, windows, stack, effectiveDockHeight: dockHeight, dockTop, workspaceTop, workspaceHeight, maximizedRect, photoConstants, photoState}
  const desktop: DesktopResult = latches !== null
    ? withSection(circuit, 'desktop with latches', () => buildLatchDesktop(context, latches, pressLatches!))
    : buildQueueDesktop(context, queue!, options.input.kind === 'queue' ? options.input : {capacity: 1, maximumDowns: 1})
  const {updated, nextStack, next, focused, dock} = desktop

  const springParams = springTimestep === null ? null : {...springConstants, timestep: springTimestep}
  const windowDebug = {snap: [] as Wire[], active: [] as Wire[]}
  const animations = next.map((window, index) => withSection(circuit, 'window springs and projection', () => {
    const stored = windowSprings[index]!
    const windowCenter = $.center(window.box)
    const dockCenter = $.center(dock[index]!.box)
    const center = select(window.visible, dockCenter, windowCenter)
    // A minimized or closed window flies into its dock item and shrinks to scale 0.
    const target = {centerX: center.x, centerY: center.y, width: window.box.width, height: window.box.height, scale: window.visible}
    // Pin springs during drag and resize, and snap windows that are hidden and no longer drawn.
    const hiddenAndAbsent = mul(not(windows[index]!.present), not(window.visible))
    const direct = clamp01(sum(updated[index]!.direct, hiddenAndAbsent))
    let positions: Record<typeof springField[number], Wire>
    let laneActive: Wire[] = []
    let boxActive: Wire | null = null
    let stepped: Wire[] | null = null
    if (springParams !== null) {
      const lanes = springField.map(field => {
        const steppedSpring = $.spring(stored.position[field], stored.velocity[field], target[field], springParams)
        const position = field === 'scale' ? clamp(steppedSpring.position, zero, unit) : steppedSpring.position
        return {
          position: select(direct, position, target[field]),
          velocity: select(direct, steppedSpring.velocity, zero),
          active: mul(not(direct), steppedSpring.active),
        }
      })
      const [centerXLane, centerYLane, widthLane, heightLane, scaleLane] = lanes as [typeof lanes[0], typeof lanes[0], typeof lanes[0], typeof lanes[0], typeof lanes[0]]
      table.next(stored, {
        position: {centerX: centerXLane.position, centerY: centerYLane.position, width: widthLane.position, height: heightLane.position, scale: scaleLane.position},
        velocity: {centerX: centerXLane.velocity, centerY: centerYLane.velocity, width: widthLane.velocity, height: heightLane.velocity, scale: scaleLane.velocity},
      })
      positions = {centerX: centerXLane.position, centerY: centerYLane.position, width: widthLane.position, height: heightLane.position, scale: scaleLane.position}
      laneActive = lanes.map(lane => lane.active)
    } else {
      const destinations = bank!.windowDestinations[index]!
      const box = emitSpringBox(circuit, springField.map(field => ({
        group: windowGroup!, position: stored.position[field], velocity: stored.velocity[field], destination: target[field], previousDestination: destinations[field],
      })), {unit, settleDistance: springConstants.settleDistance, settleSpeed: springConstants.settleSpeed, retarget: 'deferred', snap: direct})
      const [centerX, centerY, width, height, boxScale] = box.positions as [Wire, Wire, Wire, Wire, Wire]
      positions = {centerX, centerY, width, height, scale: clamp(boxScale, zero, unit)}
      const [centerXVelocity, centerYVelocity, widthVelocity, heightVelocity, scaleVelocity] = box.velocities as [Wire, Wire, Wire, Wire, Wire]
      table.next(stored, {position: positions, velocity: {centerX: centerXVelocity, centerY: centerYVelocity, width: widthVelocity, height: heightVelocity, scale: scaleVelocity}})
      const [nextCenterX, nextCenterY, nextWidth, nextHeight, nextScale] = box.nextPreviousDestinations as [Wire, Wire, Wire, Wire, Wire]
      table.next(destinations, {centerX: nextCenterX, centerY: nextCenterY, width: nextWidth, height: nextHeight, scale: nextScale})
      boxActive = box.active
      stepped = box.steppedPositions
      windowDebug.snap.push(direct)
      windowDebug.active.push(box.active)
    }
    const width = clamp(positions.width, zero, viewportWidth)
    const height = clamp(positions.height, zero, viewportHeight)
    const halfWidth = half(width)
    const halfHeight = half(height)
    const scaledHalfWidth = mul(halfWidth, positions.scale)
    const scaledHalfHeight = mul(halfHeight, positions.scale)
    // Keep the scaled window inside the viewport.
    const centerX = clamp(positions.centerX, scaledHalfWidth, sub(viewportWidth, scaledHalfWidth))
    const centerY = clamp(positions.centerY, scaledHalfHeight, sub(viewportHeight, scaledHalfHeight))
    const active = boxActive ?? clamp01(sum(...laneActive))
    return {translateX: sub(centerX, halfWidth), translateY: sub(centerY, halfHeight), width, height, scale: positions.scale, active, centerX, centerY, scaledHalfWidth, scaledHalfHeight, stepped}
  }))
  const windowAnimationActive = clamp01(sum(...animations.map(animation => animation.active)))
  // A closing window stays drawn while it animates into the dock.
  const nextPresent = windows.map((window, index) => clamp01(sum(next[index]!.visible, mul(window.present, animations[index]!.active))))
  const borderSpan = scale(unit, 2)

  if (originalClock !== null) {
    table.next(originalClock.previousFrameTime, originalClock.frameTime)
    table.next(originalClock.timeInitialized, unit)
  }
  windows.forEach((window, index) => {
    const {normal, open, minimized, maximized} = updated[index]!
    table.next(window, {...normal, open, minimized, maximized, present: nextPresent[index]!})
  })
  table.next(stack, nextStack)

  const windowOutputs = animations.map((animation, index) => ({
    translateX: animation.translateX,
    translateY: animation.translateY,
    width: animation.width,
    height: animation.height,
    scale: animation.scale,
    opacity: nextPresent[index]!,
    focused: focused[index]!,
    // Animating windows jump above the others.
    stack: sum(...nextStack.map((row, rank) => [row[index]!, rank + 1] as const), [animation.active, 40]),
    maximized: updated[index]!.maximized,
    contentWidth: relu(sub(animation.width, borderSpan)),
    contentHeight: relu(sum(animation.height, [titleHeight, -1], [borderSpan, -1])),
    dock: {...dock[index]!.box, inactive: not(next[index]!.visible), focused: focused[index]!, open: updated[index]!.open},
  }))
  const photosWindow = windowOutputs[photosWindowIndex]!
  const photosAnimation = animations[photosWindowIndex]!
  const photoSprings: PhotoSprings = springParams !== null
    ? {kind: 'original', params: springParams}
    : {kind: 'bank', group: windowGroup!, settleDistance: springConstants.settleDistance, settleSpeed: springConstants.settleSpeed, destinations: photoDestinations!}
  const photoInputs = options.photosViewport === 'stepped-springs'
    ? {
        // spring-bank's "stepped-springs": this frame's window springs after
        // stepping but before the settle snap, and presence from last frame.
        viewport: $.vec2(relu(sum(photosAnimation.stepped![2]!, [unit, -2])), relu(sum(photosAnimation.stepped![3]!, [titleHeight, -1], [unit, -2]))),
        present: windows[photosWindowIndex]!.present,
        interactive: photosWindow.focused,
        springs: photoSprings,
      }
    : {viewport: $.vec2(photosWindow.contentWidth, photosWindow.contentHeight), present: photosWindow.opacity, interactive: photosWindow.focused, springs: photoSprings}
  const photos = latchesOn
    ? withSection(circuit, 'photos with latches', () => buildPhotos($, table, {...photoConstants, ...photoLatches!, ...photoState}, photoInputs))
    : desktop.renderPhotos!(photoInputs, photoState, photoSprings)
  // The parent only exposes the combined animation bit.
  const {animationActive: photosAnimationActive, ...photoOutputs} = photos.output
  let notes: NotesBuild | null = null
  if (options.notes !== null) {
    notes = buildNotes($, table, notesCellWires!, options.notes, {
      layout, windows: animations.map((animation, index) => ({...animation, opacity: nextPresent[index]!, present: windows[index]!.present, destination: next[index]!.box, visible: next[index]!.visible})), nextStack, stack, notesVisible: next[notesWindowIndex]!.visible,
      group: bank === null ? {kind: 'original', params: springParams!} : {kind: 'bank', clock: clock!, settleDistance: springConstants.settleDistance, settleSpeed: springConstants.settleSpeed},
    })
  }
  const animationActive = clamp01(sum(windowAnimationActive, photosAnimationActive, ...(notes === null ? [] : [notes.animationActive])))
  const output = {
    windows: windowOutputs.map(({dock: _, ...window}) => window),
    dockItems: windowOutputs.map(window => window.dock),
    animationActive,
    photos: photoOutputs,
    ...(notes === null ? {} : {notes: notes.output}),
  }
  if (bank !== null) {
    table.next(bank.leftoverMs, clock!.nextLeftoverMs)
    table.next(bank.running, animationActive)
  }
  const debug = {windows: windowDebug, photos: photos.debug as PhotoDebug, ...(notes === null ? {} : {notes: notes.debug}), ...desktop.debug}
  return {
    options, table, circuit, output, debug, photoInputs,
    cells: {layout, latches, systemBarHeight, originalClock, springConstants, windows, pressLatches, stack, windowSprings, photoConstants, photoLatches, photoState, bank, photoDestinations, queue, notes: notesCellWires},
    ...table.finish(),
  }
}
export type IndirectOSBuild = ReturnType<typeof buildIndirectOS>
export type IndirectOSOutput = IndirectOSBuild['output']
export type {Rect}

// category: validation
// window-manager.ts checks window and dock outputs with a 1e-5 tolerance and
// Photos geometry with none. notation/README.md lists how the derived checks
// differ. One rule is relaxed here: thumbnails spring in past the left edge
// legitimately, so their left edge isn't checked.
const flag = [-1e-5, 1 + 1e-5] as const
const size = [-1e-5, Number.POSITIVE_INFINITY] as const
const box = {left: size, top: size, width: size, height: size}
const photoBox = {left: nonNegative, top: nonNegative, width: nonNegative, height: nonNegative}
export const outputContract = {
  windows: {translateX: anyNumber, translateY: anyNumber, width: size, height: size, scale: flag, opacity: flag, focused: flag, stack: nonNegative, maximized: flag, contentWidth: size, contentHeight: size},
  dockItems: {...box, inactive: flag, focused: flag, open: flag},
  animationActive: flag,
  photos: {backdropOpacity: flag, photos: {...photoBox, opacity: flag, focused: flag}, thumbnails: {top: nonNegative, width: nonNegative, height: nonNegative, opacity: flag, focused: flag}, previousControl: {...photoBox, opacity: flag}, nextControl: {...photoBox, opacity: flag}},
}

// category: host
export type MachineOptions = {validate?: boolean, debugOutputs?: boolean}
// Called around every evaluation: with the source table just before it, and
// with the evaluated root values and the written-back table just after it.
export type MachineObserver = {
  beforeEvaluate?: (source: Float32Array) => void
  afterEvaluate?: (values: Float32Array, source: Float32Array) => void
}

export function createIndirectOSMachine(options: IndirectOSOptions = originalOptions, machineOptions: MachineOptions = {}) {
  const built = buildIndirectOS(options)
  const {circuit, output, nextSource, cells} = built
  const validate = machineOptions.validate ?? true
  const measuredRoots = [...nextSource, ...leafWires(output)]
  const roots = [...measuredRoots, ...leafWires(built.photoInputs.viewport), built.photoInputs.present, built.photoInputs.interactive, ...(machineOptions.debugOutputs === true ? leafWires(built.debug) : [])]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(built.initialSource)
  const values = new Float32Array(circuit.sourceSize + circuit.operations.length)
  const nextValues = new Float32Array(source.length)
  const validateOutput = createOutputValidator('IndirectOS', output, outputContract)
  const validatePhotoInputs = createOutputValidator('Photos input', {viewport: built.photoInputs.viewport, present: built.photoInputs.present, interactive: built.photoInputs.interactive}, photoInputContract)
  const frameDelta = createFrameDeltaTracker(defaultClockConfig)
  // The evaluator can be swapped (tiered.ts); it returns root values in root order.
  let evaluate: (table: Float32Array) => Float32Array = evaluateRoots
  const observers: MachineObserver[] = []
  const receivePointer = (latch: {active: Wire, x: Wire, y: Wire}, x: number, y: number) => {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[latch.active] = 1
    source[latch.x] = x
    source[latch.y] = y
  }
  const photoLatches = () => {
    invariant(cells.photoLatches !== null, 'this machine has no Photos latches')
    return cells.photoLatches
  }
  // Photos events in one frame are mutually exclusive; the last one wins.
  const receivePhotoEvent = (latch: Wire, x = source[photoLatches().clickX]!, y = source[photoLatches().clickY]!) => {
    const photo = photoLatches()
    for (const other of [photo.clickActive, photo.previousActive, photo.nextActive, photo.closeActive]) source[other] = 0
    source[latch] = 1
    source[photo.clickX] = x
    source[photo.clickY] = y
  }
  const latches = () => {
    invariant(cells.latches !== null, 'this machine has no pointer latches')
    return cells.latches
  }
  // One evaluation: validate, run, write back, validate outputs.
  function evaluateOnce() {
    if (validate) built.validate(source)
    for (const observer of observers) observer.beforeEvaluate?.(source)
    const rootValues = evaluate(source)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    for (let offset = 0; offset < source.length; offset++) nextValues[offset] = values[nextSource[offset]!]!
    if (validate) {
      built.validate(nextValues)
      validateOutput(values)
      validatePhotoInputs(values)
    }
    source.set(nextValues)
    for (const observer of observers) observer.afterEvaluate?.(values, source)
    return values
  }
  function writeFrame(viewportWidth: number, viewportHeight: number, frameTime: number) {
    source[cells.layout.viewportWidth] = viewportWidth
    source[cells.layout.viewportHeight] = viewportHeight
    if (cells.originalClock !== null) source[cells.originalClock.frameTime] = frameTime
    else source[cells.bank!.frameDeltaMs] = frameDelta(frameTime)
  }
  const queueOptions = options.input.kind === 'queue' ? options.input : null
  // The queue's frame: keep the pointer stream legal, split into evaluations of
  // at most `capacity` events and `maximumDowns` downs, and evaluate each. Only
  // the first evaluation carries the frame's time.
  function stepFrame(viewportWidth: number, viewportHeight: number, frameTime: number, events: readonly QueuedEvent[]) {
    invariant(queueOptions !== null && cells.queue !== null, 'this machine has no event queue')
    const legal = legalizePointerStream(events, source[cells.queue.press.active] === 1)
    const evaluations = splitIntoEvaluations(legal.events, queueOptions.capacity, queueOptions.maximumDowns)
    let result = values
    evaluations.forEach((evaluation, index) => {
      if (index === 0) writeFrame(viewportWidth, viewportHeight, frameTime)
      else if (cells.bank !== null) source[cells.bank.frameDeltaMs] = 0
      writeQueue(source, cells.queue!, evaluation)
      result = evaluateOnce()
    })
    return {values: result, evaluations: evaluations.length}
  }
  return {
    ...built,
    source,
    values,
    roots,
    measuredRoots,
    tensorProgram,
    setEvaluator(next: (table: Float32Array) => Float32Array) {
      evaluate = next
    },
    observe(observer: MachineObserver) {
      observers.push(observer)
    },
    evaluateOnce,
    writeFrame,
    stepFrame,
    step(viewportWidth: number, viewportHeight: number, frameTime: number) {
      if (queueOptions !== null) return stepFrame(viewportWidth, viewportHeight, frameTime, []).values
      writeFrame(viewportWidth, viewportHeight, frameTime)
      return evaluateOnce()
    },
    pointerDown: (x: number, y: number) => receivePointer(latches().down, x, y),
    pointerMove: (x: number, y: number) => receivePointer(latches().move, x, y),
    pointerUp: (x: number, y: number) => receivePointer(latches().up, x, y),
    photoClick: (x: number, y: number) => receivePhotoEvent(photoLatches().clickActive, x, y),
    photoPrevious: () => receivePhotoEvent(photoLatches().previousActive),
    photoNext: () => receivePhotoEvent(photoLatches().nextActive),
    photoClose: () => receivePhotoEvent(photoLatches().closeActive),
  }
}
export type IndirectOSMachine = ReturnType<typeof createIndirectOSMachine>
