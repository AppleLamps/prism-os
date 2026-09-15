// The one-event-at-a-time reference for IndirectOS over the event queue. Plain
// TypeScript in float64; it never imports circuit code.
//
// Semantics (the circuit in desktop-queue.ts implements the same rules):
// - A down hit-tests the frontmost visible window, focuses and raises it, and
//   records a press: the point, the window, which region of the window it hit
//   (close, maximize, minimize, resize grip, title bar, content, in that
//   priority), the dock item under it, and the window's geometry (the grab).
// - A drag or resize follows the pointer from the grab: the geometry is always
//   the grab plus the pointer's offset from the press point, clamped to the
//   workspace, so a drag past an edge and back returns to the same place.
// - A move or up farther than `slop` pixels from the press point (Chebyshev
//   distance) turns the press into a drag. An up that never crossed slop is a
//   click. Window buttons and dock items act on a click, so pressing a button,
//   moving out, and moving back cancels it.
// - A click on the Photos content reaches Photos at local coordinates, hit-tested
//   against the layout at the window's destination size.
// - ArrowLeft, ArrowRight and Escape go to Photos while Photos is the focused
//   window (the frontmost visible one) at the time of the key.
// - After every evaluation all windows are clamped to the current viewport.

export type Rect = {left: number, top: number, width: number, height: number}
export type Point = {x: number, y: number}
export type Viewport = {width: number, height: number}
export type QueuedEvent = {kind: 'down' | 'move' | 'up', x: number, y: number} | {kind: 'key', key: 'ArrowLeft' | 'ArrowRight' | 'Escape'}

export const regionNames = ['close', 'maximize', 'minimize', 'resize', 'drag', 'content'] as const
export const desktopConstants = {margin: 12, titleHeight: 44, minWidth: 280, minHeight: 190, resizeGrip: 24, buttonSize: 18, buttonGap: 10, dockHeight: 76, dockGap: 12, dockItemWidth: 50, systemBarHeight: 36, slop: 4}
export const photoConstants = {gap: 18, mainInset: 92, thumbnailHeight: 82, controlSize: 52}
export const oracleWindowCount = 4
export const oraclePhotoCount = 12
const photosIndex = 3
const initialGeometry = [[54, 54, 520, 340], [410, 104, 500, 366], [174, 344, 470, 300], [650, 190, 560, 430]] as const

export type OracleWindow = Rect & {open: boolean, minimized: boolean, maximized: boolean}
export type OraclePress = {active: boolean, x: number, y: number, window: number, region: number, dock: number, grab: Rect, slop: boolean}
export type OracleState = {
  windows: OracleWindow[]
  // order[rank] is the window at that rank; rank 0 is the back.
  order: number[]
  press: OraclePress
  pointer: Point
  photoFocus: number
}

export function createOracleState(): OracleState {
  return {
    windows: initialGeometry.map(([left, top, width, height]) => ({left, top, width, height, open: true, minimized: false, maximized: false})),
    order: [0, 1, 2, 3],
    press: {active: false, x: 0, y: 0, window: -1, region: -1, dock: -1, grab: {left: 0, top: 0, width: 0, height: 0}, slop: false},
    pointer: {x: 0, y: 0},
    photoFocus: -1,
  }
}

export function cloneOracleState(state: OracleState): OracleState {
  return structuredClone(state)
}

// The smallest distance from a hit decision's threshold, over decisions whose
// operands aren't on a 1/64 grid. FP32 rounding can only flip a decision whose
// operands aren't exact, so traces avoid points where this is tiny.
export type Margins = {minimum: number}
export const createMargins = (): Margins => ({minimum: Number.POSITIVE_INFINITY})

const relu = (value: number) => Math.max(0, value)
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

function decide(distance: number, margins: Margins) {
  if (!Number.isInteger(distance * 64)) margins.minimum = Math.min(margins.minimum, Math.abs(distance - 0.5))
  return distance >= 0.5
}
const intervalDistance = (position: number, start: number, size: number) => Math.min(position - start, start + size - position)
// At least half a pixel inside the box, as wires.ts `hit`.
export function hitTest(point: Point, box: Rect, margins: Margins) {
  return decide(Math.min(intervalDistance(point.x, box.left, box.width), intervalDistance(point.y, box.top, box.height)), margins)
}
const intervalHit = (position: number, start: number, size: number, margins: Margins) => decide(intervalDistance(position, start, size), margins)
function separableHit(point: Point, box: Rect, margins: Margins) {
  const x = intervalHit(point.x, box.left, box.width, margins)
  const y = intervalHit(point.y, box.top, box.height, margins)
  return x && y
}

export function desktopLayout(viewport: Viewport) {
  const {width: viewportWidth, height: viewportHeight} = viewport
  const c = desktopConstants
  const dockHeight = Math.min(c.dockHeight, viewportHeight)
  const dockTop = viewportHeight - dockHeight
  const workspaceTop = Math.min(c.systemBarHeight, dockTop)
  const workspaceHeight = dockTop - workspaceTop
  const maximizedLeft = Math.min(c.margin, viewportWidth / 2)
  const maximizedTopInset = Math.min(c.margin, workspaceHeight / 2)
  const maximizedRect: Rect = {left: maximizedLeft, top: workspaceTop + maximizedTopInset, width: relu(viewportWidth - 2 * maximizedLeft), height: relu(workspaceHeight - 2 * maximizedTopInset)}
  const dockGap = Math.min(c.dockGap, Math.min(viewportWidth / 3, dockHeight / 2))
  const dockItemSize = Math.min(c.dockItemWidth, Math.min(relu(viewportWidth - 3 * dockGap) / 4, relu(dockHeight - 2 * dockGap)))
  const dockLeft = viewportWidth / 2 - (4 * dockItemSize + 3 * dockGap) / 2
  const dockItemTop = dockTop + dockHeight / 2 - dockItemSize / 2
  const dock: Rect[] = Array.from({length: oracleWindowCount}, (_, index) => ({left: dockLeft + (dockItemSize + dockGap) * index, top: dockItemTop, width: dockItemSize, height: dockItemSize}))
  return {viewport, dockTop, workspaceTop, workspaceHeight, maximizedRect, dock}
}
export type DesktopLayout = ReturnType<typeof desktopLayout>

export const isVisible = (window: OracleWindow) => window.open && !window.minimized
export const windowBox = (layout: DesktopLayout, window: OracleWindow): Rect => window.maximized ? {...layout.maximizedRect} : {left: window.left, top: window.top, width: window.width, height: window.height}

export function windowRegions(box: Rect) {
  const c = desktopConstants
  const buttonTop = box.top + c.titleHeight / 2 - c.buttonSize / 2
  const closeLeft = box.left + box.width - c.buttonGap - c.buttonSize
  const maximizeLeft = closeLeft - c.buttonGap - c.buttonSize
  const minimizeLeft = maximizeLeft - c.buttonGap - c.buttonSize
  const button = (left: number): Rect => ({left: left - c.buttonGap / 2, top: buttonTop - c.buttonGap / 2, width: c.buttonSize + c.buttonGap, height: c.buttonSize + c.buttonGap})
  return {
    close: button(closeLeft),
    maximize: button(maximizeLeft),
    minimize: button(minimizeLeft),
    resize: {left: box.left + box.width - c.resizeGrip, top: box.top + box.height - c.resizeGrip, width: c.resizeGrip, height: c.resizeGrip},
    drag: {left: box.left, top: box.top, width: relu(minimizeLeft - c.buttonGap - box.left), height: c.titleHeight},
    content: contentBox(box),
  }
}

export const contentBox = (box: Rect): Rect => ({left: box.left + 1, top: box.top + desktopConstants.titleHeight + 1, width: relu(box.width - 2), height: relu(box.height - desktopConstants.titleHeight - 2)})

export function focusedWindow(state: OracleState) {
  for (let rank = state.order.length - 1; rank >= 0; rank--) {
    const index = state.order[rank]!
    if (isVisible(state.windows[index]!)) return index
  }
  return -1
}

function raise(state: OracleState, index: number) {
  state.order = [...state.order.filter(other => other !== index), index]
}

function geometryFromGrab(layout: DesktopLayout, press: OraclePress, point: Point): Rect {
  const c = desktopConstants
  const {width: viewportWidth} = layout.viewport
  const resize = regionNames[press.region] === 'resize' ? 1 : 0
  const drag = regionNames[press.region] === 'drag' ? 1 : 0
  const dx = point.x - press.x
  const dy = point.y - press.y
  const width = clamp(press.grab.width + resize * dx, Math.min(c.minWidth, viewportWidth), viewportWidth)
  const height = clamp(press.grab.height + resize * dy, Math.min(c.minHeight, layout.workspaceHeight), layout.workspaceHeight)
  const left = clamp(press.grab.left + drag * dx, 0, relu(viewportWidth - width))
  const top = clamp(press.grab.top + drag * dy, layout.workspaceTop, relu(layout.dockTop - height))
  return {left, top, width, height}
}

function clampStored(layout: DesktopLayout, window: OracleWindow): Rect {
  return geometryFromGrab(layout, {active: false, x: 0, y: 0, window: -1, region: -1, dock: -1, grab: window, slop: false}, {x: 0, y: 0})
}

export function oracleEvent(state: OracleState, layout: DesktopLayout, event: QueuedEvent, margins: Margins = createMargins()) {
  if (event.kind === 'key') {
    if (focusedWindow(state) !== photosIndex || state.photoFocus < 0) {
      if (event.key === 'Escape' && focusedWindow(state) === photosIndex) state.photoFocus = -1
      return
    }
    if (event.key === 'Escape') state.photoFocus = -1
    else state.photoFocus = (state.photoFocus + (event.key === 'ArrowRight' ? 1 : oraclePhotoCount - 1)) % oraclePhotoCount
    return
  }
  const point = {x: event.x, y: event.y}
  state.pointer = point
  if (event.kind === 'down') {
    if (state.press.active) throw new Error('a pointer down arrived while the pointer was already pressed')
    // Every window's hit tests run, as in the circuit, so every decision counts toward the margins.
    const hits = state.windows.map(window => {
      const box = windowBox(layout, window)
      const inside = hitTest(point, box, margins) && isVisible(window)
      const regions = windowRegions(box)
      const regionHits = regionNames.map(name => hitTest(point, regions[name], margins) && !((name === 'resize' || name === 'drag') && window.maximized))
      return {inside, region: regionHits.indexOf(true)}
    })
    let pressed = -1
    for (let rank = state.order.length - 1; rank >= 0 && pressed === -1; rank--) {
      if (hits[state.order[rank]!]!.inside) pressed = state.order[rank]!
    }
    const dockHits = layout.dock.map(box => hitTest(point, box, margins))
    const pressedWindow = pressed >= 0 ? state.windows[pressed]! : null
    state.press = {
      active: true,
      x: point.x,
      y: point.y,
      window: pressed,
      region: pressed >= 0 ? hits[pressed]!.region : -1,
      dock: dockHits.indexOf(true),
      grab: pressedWindow === null ? {left: 0, top: 0, width: 0, height: 0} : {left: pressedWindow.left, top: pressedWindow.top, width: pressedWindow.width, height: pressedWindow.height},
      slop: false,
    }
    if (pressed >= 0) raise(state, pressed)
    return
  }
  if (!state.press.active) {
    if (event.kind === 'up') throw new Error('a pointer up arrived without a press')
    return
  }
  if (Math.max(Math.abs(point.x - state.press.x), Math.abs(point.y - state.press.y)) > desktopConstants.slop) state.press.slop = true
  if (event.kind === 'move') return
  const {press} = state
  const click = !press.slop
  const region = regionNames[press.region]
  if (press.window >= 0 && (region === 'drag' || region === 'resize')) Object.assign(state.windows[press.window]!, geometryFromGrab(layout, press, point))
  const photosClick = click && press.window === photosIndex && region === 'content'
  if (photosClick) {
    const content = contentBox(windowBox(layout, state.windows[photosIndex]!))
    state.photoFocus = oraclePhotoClick(content.width, content.height, state.photoFocus, {x: point.x - content.left, y: point.y - content.top}, margins)
  }
  state.windows.forEach((window, index) => {
    const onWindow = click && press.window === index
    const closeClick = onWindow && region === 'close'
    const maximizeClick = onWindow && region === 'maximize'
    const minimizeClick = onWindow && region === 'minimize'
    const dockClick = click && press.dock === index
    const open = dockClick ? true : closeClick ? false : window.open
    const minimized = closeClick ? false : dockClick ? false : minimizeClick ? true : window.minimized
    const maximized = closeClick ? false : maximizeClick ? !window.maximized : window.maximized
    Object.assign(window, {open, minimized, maximized})
  })
  if (click && press.dock >= 0) raise(state, press.dock)
  state.press = {...press, active: false, slop: false}
}

// The end of an evaluation: a held drag or resize follows the pointer from the
// grab, and every other window is clamped to the current viewport.
export function oracleEvaluationEnd(state: OracleState, layout: DesktopLayout) {
  const {press} = state
  const region = regionNames[press.region]
  state.windows.forEach((window, index) => {
    const held = press.active && press.window === index && (region === 'drag' || region === 'resize')
    Object.assign(window, held ? geometryFromGrab(layout, press, state.pointer) : clampStored(layout, window))
  })
}

export function oracleEvaluation(state: OracleState, viewport: Viewport, events: readonly QueuedEvent[], margins: Margins = createMargins()) {
  const layout = desktopLayout(viewport)
  for (const event of events) oracleEvent(state, layout, event, margins)
  oracleEvaluationEnd(state, layout)
  return margins
}

// Photos: layout at a content size, and one click at a local point.
export function oraclePhotoLayout(viewportX: number, viewportY: number) {
  const {gap, mainInset: mainInsetLimit, thumbnailHeight, controlSize} = photoConstants
  const gridWidth = relu(viewportX / 4 - gap * 5 / 4)
  const gridHeight = relu(viewportY / 3 - gap * 4 / 3)
  const gridLeft = Array.from({length: 4}, (_, column) => gap * (1 + column) + gridWidth * column)
  const gridTop = Array.from({length: 3}, (_, row) => gap * (1 + row) + gridHeight * row)
  const baseSize = Math.min(thumbnailHeight, Math.min(viewportX / 6, viewportY * 0.24))
  const mainInset = Math.min(mainInsetLimit, viewportX * 0.08)
  const main: Rect = {left: mainInset, top: gap, width: relu(viewportX - 2 * mainInset), height: relu(viewportY - baseSize - 3 * gap)}
  const outerInset = Math.min(gap, viewportX * 0.5)
  const thumbnailGap = Math.min(12, relu(viewportX / 8 - outerInset * 2 / 8 - baseSize * falloffMass() / 8))
  const centerY = viewportY - gap - baseSize * 0.5
  const controlTop = relu(gap + main.height * 0.5 - controlSize * 0.5)
  const previousControl: Rect = {left: gap * 0.5, top: controlTop, width: controlSize, height: controlSize}
  const nextControl: Rect = {left: relu(viewportX - gap * 0.5 - controlSize), top: controlTop, width: controlSize, height: controlSize}
  const thumbnails = (focus: number): Rect[] => Array.from({length: oraclePhotoCount}, (_, item) => {
    const offset = cyclicOffset(item, focus)
    const visibleOffset = Math.abs(offset) < 5 ? offset : 0
    const spread = Math.sign(visibleOffset) * spreadAt(Math.abs(visibleOffset))
    const scale = relu(1 - 0.22 * Math.abs(offset))
    const centerX = viewportX * 0.5 + baseSize * spread + thumbnailGap * visibleOffset
    const size = baseSize * scale
    return {left: centerX - size * 0.5, top: relu(centerY - size * 0.5), width: size, height: size}
  })
  return {gridWidth, gridHeight, gridLeft, gridTop, main, previousControl, nextControl, thumbnails}
}

export function oraclePhotoClick(viewportX: number, viewportY: number, focus: number, click: Point, margins: Margins) {
  const layout = oraclePhotoLayout(viewportX, viewportY)
  const columns = layout.gridLeft.map(left => intervalHit(click.x, left, layout.gridWidth, margins))
  const rows = layout.gridTop.map(top => intervalHit(click.y, top, layout.gridHeight, margins))
  if (focus < 0) {
    const item = Array.from({length: oraclePhotoCount}, (_, index) => columns[index % 4]! && rows[Math.floor(index / 4)]!).indexOf(true)
    return item
  }
  const candidates = [
    separableHit(click, layout.previousControl, margins),
    separableHit(click, layout.nextControl, margins),
    ...layout.thumbnails(focus).map(box => separableHit(click, box, margins)),
    separableHit(click, layout.main, margins),
  ]
  const first = candidates.indexOf(true)
  if (first === 0) return (focus + oraclePhotoCount - 1) % oraclePhotoCount
  if (first === 1) return (focus + 1) % oraclePhotoCount
  if (first >= 2 && first < 2 + oraclePhotoCount) return first - 2
  if (first === 2 + oraclePhotoCount) return focus
  return -1
}

export function cyclicOffset(item: number, focused: number) {
  let offset = item - focused
  if (offset > oraclePhotoCount / 2) offset -= oraclePhotoCount
  if (offset < -oraclePhotoCount / 2) offset += oraclePhotoCount
  return offset
}
const falloff = (distance: number) => Math.max(0, 1 - 0.22 * distance)
function falloffMass() {
  let mass = falloff(0)
  for (let distance = 1; distance < 5; distance++) mass += 2 * falloff(distance)
  return mass
}
function spreadAt(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) spread += (falloff(step - 1) + falloff(step)) / 2
  return spread
}
