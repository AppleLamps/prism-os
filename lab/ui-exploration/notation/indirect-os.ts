// IndirectOS rewritten with the source table allocator and the wire notation.
// It rebuilds window-manager.ts (createWindowManagerMachine) with the same
// operations in the same order, so the compiled circuit is identical, and it
// keeps the same step, pointer, and Photos API.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type PhotoOutputs, buildPhotos, declarePhotoRules, photoCells, photoInputContract} from './photos.ts'
import {
  type Allocated,
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
import {type Rect, type Vec2, createNotation} from './wires.ts'

// category: declarations
export const windowCount = 4
const pixel = [0, 16_384] as const
const smallPixel = [0, 1024] as const
const initialGeometry = [[54, 54, 520, 340], [410, 104, 500, 366], [174, 344, 470, 300], [650, 190, 560, 430]] as const
const springField = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
export const indirectOSCells = {
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
  down: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  move: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  up: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  pointer: {x: state(anyNumber), y: state(anyNumber)},
  systemBarHeight: constant(36, smallPixel),
  frameTime: input(nonNegative),
  previousFrameTime: state(nonNegative),
  timeInitialized: bit(),
  springs: {
    stiffness: constant(650, nonNegative),
    damping: constant(45, nonNegative),
    maxFrameDuration: constant(32, nonNegative),
    settleDistance: constant(0.01, nonNegative),
    settleSpeed: constant(0.01, nonNegative),
    settleDistanceScale: constant(100, nonNegative),
    settleSpeedScale: constant(100, nonNegative),
  },
  windows: list(windowCount, index => {
    const [left, top, width, height] = initialGeometry[index]!
    return {
      left: state(pixel, left), top: state(pixel, top), width: state(pixel, width), height: state(pixel, height),
      open: bit(1), minimized: bit(), maximized: bit(), present: state(unitInterval, 1),
    }
  }),
  drag: list(windowCount, () => bit()),
  resize: list(windowCount, () => bit()),
  stack: permutation(list(windowCount, index => index)),
  windowSprings: list(windowCount, index => {
    const [left, top, width, height] = initialGeometry[index]!
    return {
      position: {centerX: state(anyNumber, left + width / 2), centerY: state(anyNumber, top + height / 2), width: state(anyNumber, width), height: state(anyNumber, height), scale: state(unitInterval, 1)},
      velocity: {centerX: state(anyNumber), centerY: state(anyNumber), width: state(anyNumber), height: state(anyNumber), scale: state(anyNumber)},
    }
  }),
}
export type IndirectOSCells = Allocated<typeof indirectOSCells>

// category: behavior
export function buildIndirectOS(options: {declareTimestepNonNegative?: boolean} = {}) {
  const table = createSourceTable()
  const cells = table.allocate('', indirectOSCells)
  const photoCellWires = table.scope('photos').allocate('', photoCells)
  table.atMostOne('drag', cells.drag)
  table.atMostOne('resize', cells.resize)
  declarePhotoRules(table, photoCellWires)
  const circuit = table.createCircuit()
  const $ = createNotation(circuit, cells.unit)
  const {sum, sub, scale, half, relu, mul, min, clamp, clamp01, not, select, rect, hit, zero, unit, dot} = $
  const {viewportWidth, viewportHeight, titleHeight, buttonSize, buttonGap, resizeGrip, stack} = cells
  const down = $.vec2(cells.down.x, cells.down.y)

  const frameDuration = mul(cells.timeInitialized, clamp(sub(cells.frameTime, cells.previousFrameTime), zero, cells.springs.maxFrameDuration))
  const springTimestep = scale(frameDuration, 0.001 / 4)
  // The original learns that the timestep is nonnegative only when Photos declares
  // its inputs, after the window springs are built. report.ts measures declaring it here.
  if (options.declareTimestepNonNegative === true) $.assume(springTimestep, 0, Number.POSITIVE_INFINITY)
  const dockHeight = min(cells.dockHeight, viewportHeight)
  const dockTop = sub(viewportHeight, dockHeight)
  const workspaceTop = min(cells.systemBarHeight, dockTop)
  const workspaceHeight = sub(dockTop, workspaceTop)
  const maximizedLeft = min(cells.margin, half(viewportWidth))
  const maximizedTopInset = min(cells.margin, half(workspaceHeight))
  const maximizedRect = rect(maximizedLeft, sum(workspaceTop, maximizedTopInset), relu(sum(viewportWidth, [maximizedLeft, -2])), relu(sum(workspaceHeight, [maximizedTopInset, -2])))

  const current = cells.windows.map(window => {
    const visible = mul(window.open, not(window.minimized))
    const box = select(window.maximized, rect(window.left, window.top, window.width, window.height), maximizedRect)
    const windowHit = mul(visible, hit(down, box))
    const buttonTop = sum(box.top, [titleHeight, 0.5], [buttonSize, -0.5])
    const closeLeft = sum(box.left, box.width, [buttonGap, -1], [buttonSize, -1])
    const maximizeLeft = sum(closeLeft, [buttonGap, -1], [buttonSize, -1])
    const minimizeLeft = sum(maximizeLeft, [buttonGap, -1], [buttonSize, -1])
    // A button's hit box grows by half the gap on every side, so neighbors split the gap.
    const buttonHit = (left: Wire) => hit(down, $.outset(rect(left, buttonTop, buttonSize, buttonSize), half(buttonGap)))
    return {
      visible, windowHit,
      closeHit: buttonHit(closeLeft), maximizeHit: buttonHit(maximizeLeft), minimizeHit: buttonHit(minimizeLeft),
      dragHit: hit(down, rect(box.left, box.top, relu(sub(minimizeLeft, buttonGap, box.left)), titleHeight)),
      resizeHit: hit(down, rect(sub($.right(box), resizeGrip), sub($.bottom(box), resizeGrip), resizeGrip, resizeGrip)),
    }
  })
  const pressedWindow = frontmost(stack, current.map(window => window.windowHit))

  const dockGap = min(cells.dockGap, min(scale(viewportWidth, 1 / (windowCount - 1)), half(dockHeight)))
  const dockHorizontalSpace = relu(sum(viewportWidth, [dockGap, -(windowCount - 1)]))
  const dockVerticalSpace = relu(sum(dockHeight, [dockGap, -2]))
  const dockItemSize = min(cells.dockItemWidth, min(scale(dockHorizontalSpace, 1 / windowCount), dockVerticalSpace))
  const dockLeft = sum([viewportWidth, 0.5], [sum([dockItemSize, windowCount], [dockGap, windowCount - 1]), -0.5])
  const dockItemTop = sum(dockTop, [dockHeight, 0.5], [dockItemSize, -0.5])
  const dock = list(windowCount, index => {
    const box = rect(sum(dockLeft, [dockItemSize, index], [dockGap, index]), dockItemTop, dockItemSize, dockItemSize)
    return {box, hit: hit(down, box)}
  })

  // Presses on window controls count only on the frontmost window under the pointer.
  const presses = current.map((window, index) => {
    const canvas = mul(cells.down.active, pressedWindow[index]!)
    const dockPress = mul(cells.down.active, dock[index]!.hit)
    const selected = clamp01(sum(canvas, dockPress))
    const closePress = mul(canvas, window.closeHit)
    const minimizePress = mul(canvas, window.minimizeHit)
    const maximizePress = mul(canvas, window.maximizeHit)
    const normalWindow = not(cells.windows[index]!.maximized)
    const dragPress = mul(mul(canvas, window.dragHit), normalWindow)
    const resizePress = mul(mul(canvas, window.resizeHit), normalWindow)
    return {dockPress, selected, closePress, minimizePress, maximizePress, dragPress, resizePress}
  })

  // One frame may carry a down, a move, and an up together.
  const baseline = select(cells.down.active, cells.pointer, {x: cells.down.x, y: cells.down.y})
  const moved = select(cells.move.active, baseline, {x: cells.move.x, y: cells.move.y})
  const pointer: Vec2 = select(cells.up.active, moved, {x: cells.up.x, y: cells.up.y})
  const delta = $.zip((to, from) => sub(to, from), pointer, baseline)
  const pointerStillDown = not(cells.up.active)

  const updated = cells.windows.map((window, index) => {
    const press = presses[index]!
    const dragging = select(cells.down.active, cells.drag[index]!, press.dragPress)
    const resizing = select(cells.down.active, cells.resize[index]!, press.resizePress)
    const nextDrag = mul(dragging, pointerStillDown)
    const nextResize = mul(resizing, pointerStillDown)
    const direct = clamp01(sum(dragging, resizing))
    const widthCandidate = sum(window.width, mul(resizing, delta.x))
    const heightCandidate = sum(window.height, mul(resizing, delta.y))
    const width = clamp(widthCandidate, min(cells.minWidth, viewportWidth), viewportWidth)
    const height = clamp(heightCandidate, min(cells.minHeight, workspaceHeight), workspaceHeight)
    const maximumLeft = relu(sub(viewportWidth, width))
    const maximumTop = relu(sub(dockTop, height))
    const left = clamp(sum(window.left, mul(dragging, delta.x)), zero, maximumLeft)
    const top = clamp(sum(window.top, mul(dragging, delta.y)), workspaceTop, maximumTop)
    const afterClose = select(press.closePress, window.open, zero)
    const open = select(press.dockPress, afterClose, unit)
    const afterMinimize = select(press.minimizePress, window.minimized, unit)
    const afterDock = select(press.dockPress, afterMinimize, zero)
    const minimized = select(press.closePress, afterDock, zero)
    const maximized = select(press.closePress, $.toggle(window.maximized, press.maximizePress), zero)
    table.next(cells.drag[index]!, nextDrag)
    table.next(cells.resize[index]!, nextResize)
    return {normal: rect(left, top, width, height), open, minimized, maximized, direct}
  })

  const nextStack = raiseToFront(stack, presses.map(press => press.selected))
  const next = updated.map(window => ({
    visible: mul(window.open, not(window.minimized)),
    box: select(window.maximized, window.normal, maximizedRect),
  }))
  const focused = frontmost(nextStack, next.map(window => window.visible))

  const springs = {...cells.springs, timestep: springTimestep}
  const animations = next.map((window, index) => {
    const stored = cells.windowSprings[index]!
    const windowCenter = $.center(window.box)
    const dockCenter = $.center(dock[index]!.box)
    const center = select(window.visible, dockCenter, windowCenter)
    // A minimized or closed window flies into its dock item and shrinks to scale 0.
    const target = {centerX: center.x, centerY: center.y, width: window.box.width, height: window.box.height, scale: window.visible}
    // Pin springs during drag and resize, and snap windows that are hidden and no longer drawn.
    const hiddenAndAbsent = mul(not(cells.windows[index]!.present), not(window.visible))
    const direct = clamp01(sum(updated[index]!.direct, hiddenAndAbsent))
    const lanes = springField.map(field => {
      const stepped = $.spring(stored.position[field], stored.velocity[field], target[field], springs)
      const position = field === 'scale' ? clamp(stepped.position, zero, unit) : stepped.position
      return {
        position: select(direct, position, target[field]),
        velocity: select(direct, stepped.velocity, zero),
        active: mul(not(direct), stepped.active),
      }
    })
    const [centerXLane, centerYLane, widthLane, heightLane, scaleLane] = lanes as [typeof lanes[0], typeof lanes[0], typeof lanes[0], typeof lanes[0], typeof lanes[0]]
    table.next(stored, {
      position: {centerX: centerXLane.position, centerY: centerYLane.position, width: widthLane.position, height: heightLane.position, scale: scaleLane.position},
      velocity: {centerX: centerXLane.velocity, centerY: centerYLane.velocity, width: widthLane.velocity, height: heightLane.velocity, scale: scaleLane.velocity},
    })
    const width = clamp(widthLane.position, zero, viewportWidth)
    const height = clamp(heightLane.position, zero, viewportHeight)
    const halfWidth = half(width)
    const halfHeight = half(height)
    const scaledHalfWidth = mul(halfWidth, scaleLane.position)
    const scaledHalfHeight = mul(halfHeight, scaleLane.position)
    // Keep the scaled window inside the viewport.
    const centerX = clamp(centerXLane.position, scaledHalfWidth, sub(viewportWidth, scaledHalfWidth))
    const centerY = clamp(centerYLane.position, scaledHalfHeight, sub(viewportHeight, scaledHalfHeight))
    const active = clamp01(sum(...lanes.map(lane => lane.active)))
    return {translateX: sub(centerX, halfWidth), translateY: sub(centerY, halfHeight), width, height, scale: scaleLane.position, active}
  })
  const windowAnimationActive = clamp01(sum(...animations.map(animation => animation.active)))
  // A closing window stays drawn while it animates into the dock.
  const nextPresent = cells.windows.map((window, index) => clamp01(sum(next[index]!.visible, mul(window.present, animations[index]!.active))))
  const borderSpan = scale(unit, 2)

  table.next(cells.pointer, pointer)
  table.next(cells.previousFrameTime, cells.frameTime)
  table.next(cells.timeInitialized, unit)
  cells.windows.forEach((window, index) => {
    const {normal, open, minimized, maximized} = updated[index]!
    table.next(window, {...normal, open, minimized, maximized, present: nextPresent[index]!})
  })
  table.next(stack, nextStack)

  const windows = animations.map((animation, index) => ({
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
  const photosWindow = windows[windowCount - 1]!
  const photoInputs = {
    viewport: $.vec2(photosWindow.contentWidth, photosWindow.contentHeight),
    present: photosWindow.opacity,
    interactive: photosWindow.focused,
    springs,
  }
  const photos = buildPhotos($, table, photoCellWires, photoInputs)
  // The parent only exposes the combined animation bit.
  const {animationActive: photosAnimationActive, ...photoOutputs} = photos
  const output = {
    windows: windows.map(({dock: _, ...window}) => window),
    dockItems: windows.map(window => window.dock),
    animationActive: clamp01(sum(windowAnimationActive, photosAnimationActive)),
    photos: photoOutputs,
  }
  return {table, cells, photoCells: photoCellWires, photoInputs, circuit, output, ...table.finish()}

  // Scan ranks from the top: a rank takes the hit only if nothing above it did.
  function frontmost(order: readonly (readonly Wire[])[], candidates: readonly Wire[]) {
    const selectedRank = Array<Wire>(windowCount)
    let remaining = unit
    for (let rank = windowCount - 1; rank >= 0; rank--) {
      const rankHit = clamp01(dot(order[rank]!, candidates))
      selectedRank[rank] = mul(remaining, rankHit)
      remaining = relu(sub(remaining, rankHit))
    }
    return list(windowCount, index => clamp01(dot(order.map(row => row[index]!), selectedRank)))
  }

  // The selected window moves to the top rank; the windows above it move down one rank.
  function raiseToFront(order: readonly (readonly Wire[])[], selected: readonly Wire[]) {
    const inactive = not(clamp01(sum(...selected)))
    const selectedRank = order.map(row => clamp01(dot(row, selected)))
    return list(windowCount, rank => list(windowCount, index => sum(
      mul(inactive, order[rank]![index]!),
      rank === windowCount - 1
        ? selected[index]!
        : sum(...selectedRank.map((bitAtRank, from) => mul(bitAtRank, order[rank < from ? rank : rank + 1]![index]!))),
    )))
  }
}

export type IndirectOSOutput = ReturnType<typeof buildIndirectOS>['output']
export type {PhotoOutputs}

// category: validation
// The original checks window and dock outputs with a 1e-5 tolerance, and Photos
// geometry with none. The derived source checks are a different, mostly
// stricter rule set; README.md lists the differences.
const flag = [-1e-5, 1 + 1e-5] as const
const size = [-1e-5, Number.POSITIVE_INFINITY] as const
const box = {left: size, top: size, width: size, height: size}
const photoBox = {left: nonNegative, top: nonNegative, width: nonNegative, height: nonNegative}
const outputContract = {
  windows: {translateX: anyNumber, translateY: anyNumber, width: size, height: size, scale: flag, opacity: flag, focused: flag, stack: nonNegative, maximized: flag, contentWidth: size, contentHeight: size},
  dockItems: {...box, inactive: flag, focused: flag, open: flag},
  animationActive: flag,
  photos: {backdropOpacity: flag, photos: {...photoBox, opacity: flag, focused: flag}, thumbnails: {...photoBox, opacity: flag, focused: flag}, previousControl: {...photoBox, opacity: flag}, nextControl: {...photoBox, opacity: flag}},
}

// category: host
export function createIndirectOSMachine() {
  const built = buildIndirectOS()
  const {circuit, output, nextSource, cells, photoCells: photo} = built
  const source = new Float32Array(built.initialSource)
  const validateOutput = createOutputValidator('IndirectOS', output, outputContract)
  const validatePhotoInputs = createOutputValidator('Photos input', built.photoInputs, photoInputContract)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([...nextSource, ...leafWires(output)])
  const nextValues = new Float32Array(source.length)
  const receivePointer = (latch: {active: Wire, x: Wire, y: Wire}, x: number, y: number) => {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[latch.active] = 1
    source[latch.x] = x
    source[latch.y] = y
  }
  // Photos events in one frame are mutually exclusive; the last one wins.
  const receivePhotoEvent = (latch: Wire, x = source[photo.clickX]!, y = source[photo.clickY]!) => {
    for (const other of [photo.clickActive, photo.previousActive, photo.nextActive, photo.closeActive]) source[other] = 0
    source[latch] = 1
    source[photo.clickX] = x
    source[photo.clickY] = y
  }
  return {
    ...built,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number, frameTime: number) {
      source[cells.viewportWidth] = viewportWidth
      source[cells.viewportHeight] = viewportHeight
      source[cells.frameTime] = frameTime
      built.validate(source)
      const values = circuit.evaluateTensor(source)
      for (let offset = 0; offset < source.length; offset++) nextValues[offset] = values[nextSource[offset]!]!
      built.validate(nextValues)
      validateOutput(values)
      validatePhotoInputs(values)
      source.set(nextValues)
      return values
    },
    pointerDown: (x: number, y: number) => receivePointer(cells.down, x, y),
    pointerMove: (x: number, y: number) => receivePointer(cells.move, x, y),
    pointerUp: (x: number, y: number) => receivePointer(cells.up, x, y),
    photoClick: (x: number, y: number) => receivePhotoEvent(photo.clickActive, x, y),
    photoPrevious: () => receivePhotoEvent(photo.previousActive),
    photoNext: () => receivePhotoEvent(photo.nextActive),
    photoClose: () => receivePhotoEvent(photo.closeActive),
  }
}
export type IndirectOSMachine = ReturnType<typeof createIndirectOSMachine>
export type {Rect}
