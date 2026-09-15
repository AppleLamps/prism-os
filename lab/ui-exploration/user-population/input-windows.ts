// Part 1: a frame's whole pointer queue, handled in one evaluation, for window
// behaviors: focus with raise to front, drag with slop, click versus drag, a
// maximize button, and double click on the title bar.
//
// `windowsOracleEvent` is the plain TypeScript reference. It processes events
// one at a time and never imports circuit code. Two circuit forms handle every
// queued event in one evaluation:
//
// - 'unrolled': the event step is built once per queue slot, each copy reading
//   the previous copy's state. Depth grows with the queue capacity.
// - 'folded': moves never change what a later event sees except through two
//   summaries, the press point (a latch) and "crossed the slop distance since
//   the latest press" (an OR that resets at each press). Both are computed for
//   every slot at once from prefix counts. Only press sessions (a down and its
//   up) run in sequence, because a down hit-tests geometry that the previous
//   session's up may have changed. Depth grows with the number of downs per
//   evaluation, which JS bounds by splitting a frame into more evaluations.

import {invariant} from '../../../numeric-ui-core.ts'
import {allocateEventQueue, coordinateLimit, eventTimeLimit, isOnTimeGrid, writeEventQueue, type EventSlot, type QueuedEvent} from './events.ts'
import {createKit, readBit, readOneHot, SourceLayout, sklanskyPrefix, type Kit, type Term, type Wire} from './kit.ts'

export type Rectangle = {left: number, top: number, width: number, height: number}

export type WindowsConfig = {
  workspace: Rectangle
  windows: readonly {width: number, height: number, initialLeft: number, initialTop: number}[]
  titleHeight: number
  buttonWidth: number
  // A drag begins once the Chebyshev distance from the press point exceeds slop.
  slop: number
  // Two title clicks form a double click when the second down comes at most
  // this many milliseconds after the first click's up, within slop pixels.
  doubleClickInterval: number
}

// The latched click time is stored relative to the current frame and aged by
// each frame's duration, clamped so it stays a small exact number in FP32.
export const lastClickTimeLimit = 65536

export type WindowsState = {
  pointerX: number
  pointerY: number
  pressed: boolean
  pressX: number
  pressY: number
  pressWindow: number
  grabLeft: number
  grabTop: number
  pressOnTitle: boolean
  pressOnButton: boolean
  pressWasMaximized: boolean
  pressSecondClick: boolean
  slopExceeded: boolean
  left: number[]
  top: number[]
  maximized: boolean[]
  // 0 is the back, windowCount - 1 is the front.
  rank: number[]
  focus: number
  lastClickValid: boolean
  lastClickTime: number
  lastClickX: number
  lastClickY: number
  lastClickWindow: number
}

export type WindowsDisplay = {rectangles: Rectangle[], dragOwner: number}

export function validateWindowsConfig(config: WindowsConfig) {
  invariant(config.windows.length >= 1, 'at least one window is needed')
  const integers = [
    config.workspace.left, config.workspace.top, config.workspace.width, config.workspace.height,
    config.titleHeight, config.buttonWidth, config.slop,
    ...config.windows.flatMap(window => [window.width, window.height, window.initialLeft, window.initialTop]),
  ]
  invariant(integers.every(Number.isInteger), 'window geometry must be whole pixels')
  invariant(isOnTimeGrid(config.doubleClickInterval) && config.doubleClickInterval >= 0, 'the double click interval must sit on the 1/16 ms grid')
}

export function createWindowsState(config: WindowsConfig): WindowsState {
  validateWindowsConfig(config)
  return {
    pointerX: 0,
    pointerY: 0,
    pressed: false,
    pressX: 0,
    pressY: 0,
    pressWindow: -1,
    grabLeft: 0,
    grabTop: 0,
    pressOnTitle: false,
    pressOnButton: false,
    pressWasMaximized: false,
    pressSecondClick: false,
    slopExceeded: false,
    left: config.windows.map(window => window.initialLeft),
    top: config.windows.map(window => window.initialTop),
    maximized: config.windows.map(() => false),
    rank: config.windows.map((_, index) => index),
    focus: -1,
    lastClickValid: false,
    lastClickTime: -lastClickTimeLimit,
    lastClickX: 0,
    lastClickY: 0,
    lastClickWindow: -1,
  }
}

// What the user saw while the pointer was released: stored geometry, or the
// workspace for a maximized window.
export function seenWindowRectangle(config: WindowsConfig, state: WindowsState, index: number): Rectangle {
  if (state.maximized[index]!) return {...config.workspace}
  const window = config.windows[index]!
  return {left: state.left[index]!, top: state.top[index]!, width: window.width, height: window.height}
}

export function strictlyInside(rectangle: Rectangle, x: number, y: number) {
  return x > rectangle.left && x < rectangle.left + rectangle.width && y > rectangle.top && y < rectangle.top + rectangle.height
}

function clampPixels(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function draggedWindowPosition(config: WindowsConfig, state: WindowsState, index: number) {
  const window = config.windows[index]!
  const workspace = config.workspace
  return {
    left: clampPixels(state.grabLeft + state.pointerX - state.pressX, workspace.left, workspace.left + workspace.width - window.width),
    top: clampPixels(state.grabTop + state.pointerY - state.pressY, workspace.top, workspace.top + workspace.height - window.height),
  }
}

// The window under (x, y) with the highest rank, -1 for none.
export function windowsFrontmostHit(config: WindowsConfig, state: WindowsState, x: number, y: number) {
  let hit = -1
  for (let index = 0; index < config.windows.length; index++) {
    if (!strictlyInside(seenWindowRectangle(config, state, index), x, y)) continue
    if (hit === -1 || state.rank[index]! > state.rank[hit]!) hit = index
  }
  return hit
}

export function raiseWindow(state: WindowsState, index: number) {
  const raisedRank = state.rank[index]!
  for (let other = 0; other < state.rank.length; other++) {
    if (state.rank[other]! > raisedRank) state.rank[other]!--
  }
  state.rank[index] = state.rank.length - 1
}

export function windowsOracleFrameStart(state: WindowsState, frameDelta: number) {
  state.lastClickTime = Math.max(state.lastClickTime - frameDelta, -lastClickTimeLimit)
}

export function windowsOracleEvent(config: WindowsConfig, state: WindowsState, event: QueuedEvent) {
  if (event.kind === 'key') return
  const {x, y} = event
  state.pointerX = x
  state.pointerY = y
  if (event.kind === 'down') {
    invariant(!state.pressed, 'a pointer down arrived while the pointer was already pressed')
    const hit = windowsFrontmostHit(config, state, x, y)
    state.pressed = true
    state.pressX = x
    state.pressY = y
    state.pressWindow = hit
    state.slopExceeded = false
    state.focus = hit
    if (hit === -1) {
      state.grabLeft = 0
      state.grabTop = 0
      state.pressOnTitle = false
      state.pressOnButton = false
      state.pressWasMaximized = false
      state.pressSecondClick = false
      return
    }
    const rectangle = seenWindowRectangle(config, state, hit)
    const onTitleBand = y - rectangle.top < config.titleHeight
    const onButtonBand = x >= rectangle.left + rectangle.width - config.buttonWidth
    state.pressOnButton = onTitleBand && onButtonBand
    state.pressOnTitle = onTitleBand && !onButtonBand
    state.grabLeft = state.left[hit]!
    state.grabTop = state.top[hit]!
    state.pressWasMaximized = state.maximized[hit]!
    state.pressSecondClick = state.pressOnTitle
      && state.lastClickValid
      && state.lastClickWindow === hit
      && event.time - state.lastClickTime <= config.doubleClickInterval
      && Math.max(Math.abs(x - state.lastClickX), Math.abs(y - state.lastClickY)) <= config.slop
    raiseWindow(state, hit)
    return
  }
  if (event.kind === 'move') {
    if (state.pressed && Math.max(Math.abs(x - state.pressX), Math.abs(y - state.pressY)) > config.slop) {
      state.slopExceeded = true
    }
    return
  }
  // An up without a press (e.g. the press went to a menu) is ignored.
  if (!state.pressed) return
  const pressed = state.pressWindow
  const click = !state.slopExceeded
  if (pressed >= 0) {
    if (state.slopExceeded && state.pressOnTitle && !state.pressWasMaximized) {
      const dragged = draggedWindowPosition(config, state, pressed)
      state.left[pressed] = dragged.left
      state.top[pressed] = dragged.top
    }
    if (click && (state.pressOnButton || (state.pressOnTitle && state.pressSecondClick))) {
      state.maximized[pressed] = !state.maximized[pressed]!
    }
  }
  const titleClick = click && state.pressOnTitle
  if (titleClick) {
    state.lastClickTime = event.time
    state.lastClickX = state.pressX
    state.lastClickY = state.pressY
    state.lastClickWindow = pressed
  }
  state.lastClickValid = titleClick && !state.pressSecondClick
  state.pressed = false
  state.slopExceeded = false
}

export function windowsOracleDisplay(config: WindowsConfig, state: WindowsState): WindowsDisplay {
  const dragOwner = state.pressed && state.pressWindow >= 0 && state.slopExceeded && state.pressOnTitle && !state.pressWasMaximized
    ? state.pressWindow
    : -1
  const rectangles = config.windows.map((window, index) => {
    if (state.maximized[index]!) return {...config.workspace}
    if (index === dragOwner) return {...draggedWindowPosition(config, state, index), width: window.width, height: window.height}
    return {left: state.left[index]!, top: state.top[index]!, width: window.width, height: window.height}
  })
  return {rectangles, dragOwner}
}

export function windowsOracleFrame(config: WindowsConfig, state: WindowsState, frameDelta: number, events: readonly QueuedEvent[]) {
  windowsOracleFrameStart(state, frameDelta)
  for (const event of events) windowsOracleEvent(config, state, event)
  return windowsOracleDisplay(config, state)
}

// ---------------------------------------------------------------------------
// Source table layout

export type WindowsCells = {
  pointerX: Wire
  pointerY: Wire
  pressActive: Wire
  pressX: Wire
  pressY: Wire
  pressWindow: Wire[]
  grabLeft: Wire
  grabTop: Wire
  pressOnTitle: Wire
  pressOnButton: Wire
  pressWasMaximized: Wire
  pressSecondClick: Wire
  slopLatch: Wire
  left: Wire[]
  top: Wire[]
  maximized: Wire[]
  rank: Wire[]
  focus: Wire[]
  lastClickValid: Wire
  lastClickTime: Wire
  lastClickX: Wire
  lastClickY: Wire
  lastClickWindow: Wire[]
}

export type WindowsConstants = {
  workspaceLeft: Wire
  workspaceTop: Wire
  workspaceWidth: Wire
  workspaceHeight: Wire
  width: Wire[]
  height: Wire[]
  titleHeight: Wire
  buttonWidth: Wire
  slop: Wire
  doubleClickInterval: Wire
}

export function allocateWindowsConstants(layout: SourceLayout, count: number): WindowsConstants {
  return {
    workspaceLeft: layout.cell('workspaceLeft', 0, coordinateLimit),
    workspaceTop: layout.cell('workspaceTop', 0, coordinateLimit),
    workspaceWidth: layout.cell('workspaceWidth', 1, coordinateLimit),
    workspaceHeight: layout.cell('workspaceHeight', 1, coordinateLimit),
    width: layout.cells('windowWidth', count, 1, coordinateLimit),
    height: layout.cells('windowHeight', count, 1, coordinateLimit),
    titleHeight: layout.cell('titleHeight', 1, 256),
    buttonWidth: layout.cell('buttonWidth', 0, 256),
    slop: layout.cell('slop', 0, 64),
    doubleClickInterval: layout.cell('doubleClickInterval', 0, eventTimeLimit),
  }
}

export function allocateWindowsCells(layout: SourceLayout, count: number): WindowsCells {
  const coordinate = (name: string) => layout.cell(name, -coordinateLimit, coordinateLimit)
  const bit = (name: string) => layout.cell(name, 0, 1)
  return {
    pointerX: coordinate('pointerX'),
    pointerY: coordinate('pointerY'),
    pressActive: bit('pressActive'),
    pressX: coordinate('pressX'),
    pressY: coordinate('pressY'),
    pressWindow: layout.cells('pressWindow', count, 0, 1),
    grabLeft: coordinate('grabLeft'),
    grabTop: coordinate('grabTop'),
    pressOnTitle: bit('pressOnTitle'),
    pressOnButton: bit('pressOnButton'),
    pressWasMaximized: bit('pressWasMaximized'),
    pressSecondClick: bit('pressSecondClick'),
    slopLatch: bit('slopLatch'),
    left: layout.cells('left', count, -coordinateLimit, coordinateLimit),
    top: layout.cells('top', count, -coordinateLimit, coordinateLimit),
    maximized: layout.cells('maximized', count, 0, 1),
    rank: layout.cells('rank', count, 0, count - 1),
    focus: layout.cells('focus', count, 0, 1),
    lastClickValid: bit('lastClickValid'),
    lastClickTime: layout.cell('lastClickTime', -lastClickTimeLimit, 0),
    lastClickX: coordinate('lastClickX'),
    lastClickY: coordinate('lastClickY'),
    lastClickWindow: layout.cells('lastClickWindow', count, 0, 1),
  }
}

export function flattenWindowsCells(cells: WindowsCells): Wire[] {
  return [
    cells.pointerX, cells.pointerY, cells.pressActive, cells.pressX, cells.pressY, ...cells.pressWindow,
    cells.grabLeft, cells.grabTop, cells.pressOnTitle, cells.pressOnButton, cells.pressWasMaximized, cells.pressSecondClick,
    cells.slopLatch, ...cells.left, ...cells.top, ...cells.maximized, ...cells.rank, ...cells.focus,
    cells.lastClickValid, cells.lastClickTime, cells.lastClickX, cells.lastClickY, ...cells.lastClickWindow,
  ]
}

export function declareWindowsOneHots(kit: Kit, cells: WindowsCells) {
  kit.declareOneHot(cells.pressWindow, true)
  kit.declareOneHot(cells.focus, true)
  kit.declareOneHot(cells.lastClickWindow, true)
}

function writeOneHot(source: Float32Array, wires: readonly Wire[], index: number) {
  wires.forEach((wire, position) => {
    source[wire] = position === index ? 1 : 0
  })
}

export function writeWindowsConstants(source: Float32Array, constants: WindowsConstants, config: WindowsConfig) {
  source[constants.workspaceLeft] = config.workspace.left
  source[constants.workspaceTop] = config.workspace.top
  source[constants.workspaceWidth] = config.workspace.width
  source[constants.workspaceHeight] = config.workspace.height
  config.windows.forEach((window, index) => {
    source[constants.width[index]!] = window.width
    source[constants.height[index]!] = window.height
  })
  source[constants.titleHeight] = config.titleHeight
  source[constants.buttonWidth] = config.buttonWidth
  source[constants.slop] = config.slop
  source[constants.doubleClickInterval] = config.doubleClickInterval
}

export function writeWindowsState(source: Float32Array, cells: WindowsCells, state: WindowsState) {
  source[cells.pointerX] = state.pointerX
  source[cells.pointerY] = state.pointerY
  source[cells.pressActive] = state.pressed ? 1 : 0
  source[cells.pressX] = state.pressX
  source[cells.pressY] = state.pressY
  writeOneHot(source, cells.pressWindow, state.pressWindow)
  source[cells.grabLeft] = state.grabLeft
  source[cells.grabTop] = state.grabTop
  source[cells.pressOnTitle] = state.pressOnTitle ? 1 : 0
  source[cells.pressOnButton] = state.pressOnButton ? 1 : 0
  source[cells.pressWasMaximized] = state.pressWasMaximized ? 1 : 0
  source[cells.pressSecondClick] = state.pressSecondClick ? 1 : 0
  source[cells.slopLatch] = state.slopExceeded ? 1 : 0
  state.left.forEach((value, index) => {
    source[cells.left[index]!] = value
    source[cells.top[index]!] = state.top[index]!
    source[cells.maximized[index]!] = state.maximized[index]! ? 1 : 0
    source[cells.rank[index]!] = state.rank[index]!
  })
  writeOneHot(source, cells.focus, state.focus)
  source[cells.lastClickValid] = state.lastClickValid ? 1 : 0
  source[cells.lastClickTime] = state.lastClickTime
  source[cells.lastClickX] = state.lastClickX
  source[cells.lastClickY] = state.lastClickY
  writeOneHot(source, cells.lastClickWindow, state.lastClickWindow)
}

export function readWindowsState(values: ArrayLike<number>, cells: WindowsCells): WindowsState {
  const bit = (wire: Wire, label: string) => readBit(values[wire]!, label)
  return {
    pointerX: values[cells.pointerX]!,
    pointerY: values[cells.pointerY]!,
    pressed: bit(cells.pressActive, 'pressActive'),
    pressX: values[cells.pressX]!,
    pressY: values[cells.pressY]!,
    pressWindow: readOneHot(values, cells.pressWindow, 'pressWindow'),
    grabLeft: values[cells.grabLeft]!,
    grabTop: values[cells.grabTop]!,
    pressOnTitle: bit(cells.pressOnTitle, 'pressOnTitle'),
    pressOnButton: bit(cells.pressOnButton, 'pressOnButton'),
    pressWasMaximized: bit(cells.pressWasMaximized, 'pressWasMaximized'),
    pressSecondClick: bit(cells.pressSecondClick, 'pressSecondClick'),
    slopExceeded: bit(cells.slopLatch, 'slopLatch'),
    left: cells.left.map(wire => values[wire]!),
    top: cells.top.map(wire => values[wire]!),
    maximized: cells.maximized.map((wire, index) => bit(wire, `maximized[${index}]`)),
    rank: cells.rank.map(wire => values[wire]!),
    focus: readOneHot(values, cells.focus, 'focus'),
    lastClickValid: bit(cells.lastClickValid, 'lastClickValid'),
    lastClickTime: values[cells.lastClickTime]!,
    lastClickX: values[cells.lastClickX]!,
    lastClickY: values[cells.lastClickY]!,
    lastClickWindow: readOneHot(values, cells.lastClickWindow, 'lastClickWindow'),
  }
}

// ---------------------------------------------------------------------------
// Circuit builders, shared by both forms and by app.ts

export function windowsSeenRectangles(kit: Kit, constants: WindowsConstants, state: WindowsCells) {
  return state.left.map((left, index) => {
    const maximized = state.maximized[index]!
    return {
      left: kit.pick(maximized, left, constants.workspaceLeft),
      top: kit.pick(maximized, state.top[index]!, constants.workspaceTop),
      width: kit.pick(maximized, constants.width[index]!, constants.workspaceWidth),
      height: kit.pick(maximized, constants.height[index]!, constants.workspaceHeight),
    }
  })
}

// Raise to front: when `selected` (a one-hot or all zero) picks a window, the
// windows above it move down one rank and it takes the top rank.
export function raiseRanks(kit: Kit, rank: readonly Wire[], selected: readonly Wire[]): Wire[] {
  const count = rank.length
  const above = (upper: number, lower: number) => kit.atLeast([[rank[upper]!, 1], [rank[lower]!, -1]], 1)
  return rank.map((rankWire, index) => {
    const demotions: Term[] = []
    for (let other = 0; other < count; other++) {
      if (other !== index) demotions.push([kit.and([selected[other]!, above(index, other)]), -1])
    }
    const promotion = kit.gated(selected[index]!, [[rankWire, -1]], count - 1)
    const result = kit.affine([[rankWire, 1], ...demotions, [promotion, 1]])
    kit.circuit.assumeRange(result, 0, count - 1)
    return result
  })
}

// The effect of a down at (x, y) when `gate` is 1, and the unchanged state when
// it is 0. Also returns the frontmost hit window (gated) and the rectangles
// hit-tested, for consumers such as controls inside a window.
export function windowsDownUpdate(kit: Kit, constants: WindowsConstants, state: WindowsCells, gate: Wire, x: Wire, y: Wire, time: Wire) {
  const count = state.left.length
  const rectangles = windowsSeenRectangles(kit, constants, state)
  const edgeBits = rectangles.map(rectangle => [
    kit.atLeast([[x, 1], [rectangle.left, -1]], 1),
    kit.atLeast([[rectangle.left, 1], [rectangle.width, 1], [x, -1]], 1),
    kit.atLeast([[y, 1], [rectangle.top, -1]], 1),
    kit.atLeast([[rectangle.top, 1], [rectangle.height, 1], [y, -1]], 1),
  ])
  const inside = edgeBits.map(bits => kit.and(bits))
  // y - top < titleHeight, and x >= right - buttonWidth.
  const titleBand = rectangles.map(rectangle => kit.atLeast([[constants.titleHeight, 1], [y, -1], [rectangle.top, 1]], 1))
  const buttonBand = rectangles.map(rectangle => kit.atLeast([[x, 1], [rectangle.left, -1], [rectangle.width, -1], [constants.buttonWidth, 1]], 0))
  const onButton = rectangles.map((_, index) => kit.and([...edgeBits[index]!, titleBand[index]!, buttonBand[index]!]))
  const onTitle = rectangles.map((_, index) => kit.atLeast([...kit.sum(edgeBits[index]!), [titleBand[index]!, 1], [buttonBand[index]!, -1]], 5))

  // Frontmost among the windows under the pointer: inside, and no window with a
  // higher rank is also inside.
  const above = (upper: number, lower: number) => kit.atLeast([[state.rank[upper]!, 1], [state.rank[lower]!, -1]], 1)
  const hit = inside.map((insideBit, index) => {
    const occluders: Term[] = []
    for (let other = 0; other < count; other++) {
      if (other !== index) occluders.push([kit.and([above(other, index), inside[other]!]), -1])
    }
    return kit.atLeast([[insideBit, 1], [gate, 1], ...occluders], 2)
  })
  kit.declareOneHot(hit, true)

  const freshTitle = kit.bitAffine(hit.map((bit, index) => [kit.mask(bit, onTitle[index]!), 1] as const))
  const freshButton = kit.bitAffine(hit.map((bit, index) => [kit.mask(bit, onButton[index]!), 1] as const))
  const freshWasMaximized = kit.bitAffine(kit.dot(hit, state.maximized))
  const freshGrabLeft = kit.dot(hit, state.left)
  const freshGrabTop = kit.dot(hit, state.top)
  const lastWindowMatch = kit.dot(hit, state.lastClickWindow)
  // time - lastClickTime <= interval, scaled by 16 so the grid values are integers.
  const timeOk = kit.atLeast([[state.lastClickTime, 16], [time, -16], [constants.doubleClickInterval, 16]], 0)
  const distanceOk = kit.atLeast([
    [constants.slop, 1],
    [kit.chebyshev([[x, 1], [state.lastClickX, -1]], [[y, 1], [state.lastClickY, -1]]), -1],
  ], 0)
  const freshSecondClick = kit.and([freshTitle, state.lastClickValid, lastWindowMatch, timeOk, distanceOk])

  const rank = raiseRanks(kit, state.rank, hit)

  const latch = (kept: Wire, fresh: Wire) => kit.pick(gate, kept, fresh)
  const latchBit = (kept: Wire, fresh: Wire) => kit.pickBit(gate, kept, fresh)
  const next: WindowsCells = {
    ...state,
    pressX: latch(state.pressX, x),
    pressY: latch(state.pressY, y),
    pressWindow: state.pressWindow.map((kept, index) => latchBit(kept, hit[index]!)),
    grabLeft: latch(state.grabLeft, freshGrabLeft),
    grabTop: latch(state.grabTop, freshGrabTop),
    pressOnTitle: latchBit(state.pressOnTitle, freshTitle),
    pressOnButton: latchBit(state.pressOnButton, freshButton),
    pressWasMaximized: latchBit(state.pressWasMaximized, freshWasMaximized),
    pressSecondClick: latchBit(state.pressSecondClick, freshSecondClick),
    focus: state.focus.map((kept, index) => latchBit(kept, hit[index]!)),
    rank,
  }
  declareWindowsOneHots(kit, next)
  return {state: next, hit, rectangles}
}

function windowsDraggedPosition(kit: Kit, constants: WindowsConstants, state: WindowsCells, pointerX: Wire, pointerY: Wire) {
  const width = kit.dot(state.pressWindow, constants.width)
  const height = kit.dot(state.pressWindow, constants.height)
  return {
    left: kit.clamp(
      [[state.grabLeft, 1], [pointerX, 1], [state.pressX, -1]],
      constants.workspaceLeft,
      [[constants.workspaceLeft, 1], [constants.workspaceWidth, 1], [width, -1]],
    ),
    top: kit.clamp(
      [[state.grabTop, 1], [pointerY, 1], [state.pressY, -1]],
      constants.workspaceTop,
      [[constants.workspaceTop, 1], [constants.workspaceHeight, 1], [height, -1]],
    ),
  }
}

// The effect of an up at (x, y) that ends a press, when `gate` is 1. `slopAtUp`
// is whether the press crossed the slop distance before this up.
export function windowsUpUpdate(kit: Kit, constants: WindowsConstants, state: WindowsCells, gate: Wire, x: Wire, y: Wire, time: Wire, slopAtUp: Wire) {
  const commit = kit.atLeast([[gate, 1], [slopAtUp, 1], [state.pressOnTitle, 1], [state.pressWasMaximized, -1]], 3)
  const dragged = windowsDraggedPosition(kit, constants, state, x, y)
  const click = kit.atLeast([[gate, 1], [slopAtUp, -1]], 1)
  const titleSecondClick = kit.mask(state.pressOnTitle, state.pressSecondClick)
  const toggleBase = kit.atLeast([[click, 1], [state.pressOnButton, 1], [titleSecondClick, 1]], 2)
  const titleClick = kit.and([click, state.pressOnTitle])
  const next: WindowsCells = {
    ...state,
    left: state.left.map((kept, index) => kit.pick(kit.mask(commit, state.pressWindow[index]!), kept, dragged.left)),
    top: state.top.map((kept, index) => kit.pick(kit.mask(commit, state.pressWindow[index]!), kept, dragged.top)),
    maximized: state.maximized.map((bit, index) => {
      const toggle = kit.mask(toggleBase, state.pressWindow[index]!)
      return kit.bitAffine([[bit, 1], [toggle, 1], [kit.mask(bit, toggle), -2]])
    }),
    lastClickValid: kit.bitAffine([
      [state.lastClickValid, 1],
      [kit.mask(gate, state.lastClickValid), -1],
      [kit.atLeast([[titleClick, 1], [state.pressSecondClick, -1]], 1), 1],
    ]),
    lastClickTime: kit.pick(titleClick, state.lastClickTime, time),
    lastClickX: kit.pick(titleClick, state.lastClickX, state.pressX),
    lastClickY: kit.pick(titleClick, state.lastClickY, state.pressY),
    lastClickWindow: state.lastClickWindow.map((kept, index) => kit.pickBit(titleClick, kept, state.pressWindow[index]!)),
  }
  declareWindowsOneHots(kit, next)
  return next
}

// One queue slot, unrolled: every part reads the same incoming state, and the
// parts are merged by which event kind owns each field.
export function windowsEventStep(kit: Kit, constants: WindowsConstants, state: WindowsCells, slot: Pick<EventSlot, 'down' | 'move' | 'up' | 'x' | 'y' | 'time'>) {
  const upGate = kit.and([slot.up, state.pressActive])
  const down = windowsDownUpdate(kit, constants, state, slot.down, slot.x, slot.y, slot.time)
  const up = windowsUpUpdate(kit, constants, state, upGate, slot.x, slot.y, slot.time, state.slopLatch)
  const pointerEvent = kit.bitAffine([[slot.down, 1], [slot.move, 1], [slot.up, 1]])
  const far = kit.atLeast([
    [kit.chebyshev([[slot.x, 1], [state.pressX, -1]], [[slot.y, 1], [state.pressY, -1]]), 1],
    [constants.slop, -1],
  ], 1)
  const crossing = kit.and([slot.move, state.pressActive, far])
  const next: WindowsCells = {
    ...down.state,
    pointerX: kit.pick(pointerEvent, state.pointerX, slot.x),
    pointerY: kit.pick(pointerEvent, state.pointerY, slot.y),
    pressActive: kit.bitAffine([[state.pressActive, 1], [slot.down, 1], [upGate, -1]]),
    slopLatch: kit.atLeast([[state.slopLatch, 1], [crossing, 1], [slot.down, -2], [upGate, -2]], 1),
    left: up.left,
    top: up.top,
    maximized: up.maximized,
    lastClickValid: up.lastClickValid,
    lastClickTime: up.lastClickTime,
    lastClickX: up.lastClickX,
    lastClickY: up.lastClickY,
    lastClickWindow: up.lastClickWindow,
  }
  return {state: next, hit: down.hit, rectangles: down.rectangles}
}

export function windowsAgeClickTime(kit: Kit, lastClickTime: Wire, frameDelta: Wire) {
  return kit.maximum([[lastClickTime, 1], [frameDelta, -1]], [[kit.one, -lastClickTimeLimit]])
}

export function windowsDisplay(kit: Kit, constants: WindowsConstants, state: WindowsCells) {
  const dragBase = kit.atLeast([[state.pressActive, 1], [state.slopLatch, 1], [state.pressOnTitle, 1], [state.pressWasMaximized, -1]], 3)
  const dragOwner = state.pressWindow.map(bit => kit.mask(dragBase, bit))
  const dragged = windowsDraggedPosition(kit, constants, state, state.pointerX, state.pointerY)
  const rectangles = state.left.map((left, index) => {
    const maximized = state.maximized[index]!
    return {
      left: kit.pick(maximized, kit.pick(dragOwner[index]!, left, dragged.left), constants.workspaceLeft),
      top: kit.pick(maximized, kit.pick(dragOwner[index]!, state.top[index]!, dragged.top), constants.workspaceTop),
      width: kit.pick(maximized, constants.width[index]!, constants.workspaceWidth),
      height: kit.pick(maximized, constants.height[index]!, constants.workspaceHeight),
    }
  })
  return {rectangles, dragOwner}
}

// The folded form. Session s holds the events after the s-th down of this
// evaluation (session 0 continues a press carried in from earlier). With a
// legal stream (downs and ups alternate), "pressed before event i" is the
// initial press bit plus downs minus ups before i, an exact integer.
function buildFoldedWindowsFrame(
  kit: Kit,
  constants: WindowsConstants,
  initial: WindowsCells,
  slots: readonly EventSlot[],
  maximumDowns: number,
  pressPoint: 'session' | 'prefix-scan',
): WindowsCells {
  invariant(Number.isInteger(maximumDowns) && maximumDowns >= 1, 'maximumDowns must be a positive integer')
  const capacity = slots.length
  const sessionCount = maximumDowns + 1
  const prefix = (field: 'down' | 'up') => slots.map((_, index) => kit.affine(slots.slice(0, index + 1).map(slot => [slot[field], 1] as const)))
  const downPrefix = prefix('down')
  const upPrefix = prefix('up')

  // sessionBits[i][s] = [number of downs up to and including event i === s].
  const sessionBits = slots.map((_, index) => {
    const reached = (session: number) => kit.atLeast(downPrefix[index]!, session)
    return Array.from({length: sessionCount}, (_, session) => {
      const terms: Term[] = []
      if (session > 0) terms.push([reached(session), 1])
      if (session + 1 < sessionCount) terms.push([reached(session + 1), -1])
      return kit.bitAffine(terms, session === 0 ? 1 : 0)
    })
  })
  sessionBits.forEach(bits => kit.declareOneHot(bits, false))

  const eventsOfSession = (field: 'down' | 'up', session: number) => {
    const bits = slots.map((slot, index) => kit.atLeast([[slot[field], 1], [sessionBits[index]![session]!, 1]], 2))
    kit.declareOneHot(bits, true)
    return bits
  }
  const sessions = Array.from({length: sessionCount}, (_, session) => {
    const downs = session === 0 ? null : eventsOfSession('down', session)
    const ups = eventsOfSession('up', session)
    return {
      hasDown: downs === null ? kit.zero : kit.bitAffine(kit.sum(downs)),
      downX: downs === null ? kit.zero : kit.dot(downs, slots.map(slot => slot.x)),
      downY: downs === null ? kit.zero : kit.dot(downs, slots.map(slot => slot.y)),
      downTime: downs === null ? kit.zero : kit.dot(downs, slots.map(slot => slot.time)),
      hasUp: kit.bitAffine(kit.sum(ups)),
      upX: kit.dot(ups, slots.map(slot => slot.x)),
      upY: kit.dot(ups, slots.map(slot => slot.y)),
      upTime: kit.dot(ups, slots.map(slot => slot.time)),
    }
  })

  // The press point each event sees.
  let pressAt: {x: Wire, y: Wire}[]
  if (pressPoint === 'session') {
    const pressXs = sessions.map((session, index) => (index === 0 ? initial.pressX : session.downX))
    const pressYs = sessions.map((session, index) => (index === 0 ? initial.pressY : session.downY))
    pressAt = slots.map((_, index) => ({x: kit.dot(sessionBits[index]!, pressXs), y: kit.dot(sessionBits[index]!, pressYs)}))
  } else {
    type Latch = {written: Wire, x: Wire, y: Wire}
    const items: Latch[] = [
      {written: kit.one, x: initial.pressX, y: initial.pressY},
      ...slots.map(slot => ({written: slot.down, x: slot.x, y: slot.y})),
    ]
    const scanned = sklanskyPrefix(items, (earlier, later) => ({
      written: earlier.written === kit.one ? kit.one : kit.or([earlier.written, later.written]),
      x: kit.pick(later.written, earlier.x, later.x),
      y: kit.pick(later.written, earlier.y, later.y),
    }))
    pressAt = slots.map((_, index) => scanned[index + 1]!)
  }

  const crossings = slots.map((slot, index) => {
    const far = kit.atLeast([
      [kit.chebyshev([[slot.x, 1], [pressAt[index]!.x, -1]], [[slot.y, 1], [pressAt[index]!.y, -1]]), 1],
      [constants.slop, -1],
    ], 1)
    const pressedBefore: Term[] = index === 0
      ? [[initial.pressActive, 1]]
      : [[initial.pressActive, 1], [downPrefix[index - 1]!, 1], [upPrefix[index - 1]!, -1]]
    return kit.atLeast([[slot.move, 1], ...pressedBefore, [far, 1]], 3)
  })
  const sessionSlop = sessions.map((_, session) => kit.atLeast([
    ...(session === 0 ? [[initial.slopLatch, 1] as const] : []),
    ...slots.map((_, index) => [kit.mask(sessionBits[index]![session]!, crossings[index]!), 1] as const),
  ], 1))

  let state = initial
  for (let session = 0; session < sessionCount; session++) {
    const events = sessions[session]!
    if (session > 0) state = windowsDownUpdate(kit, constants, state, events.hasDown, events.downX, events.downY, events.downTime).state
    state = windowsUpUpdate(kit, constants, state, events.hasUp, events.upX, events.upY, events.upTime, sessionSlop[session]!)
  }

  const pointerKinds = slots.map(slot => kit.bitAffine([[slot.down, 1], [slot.move, 1], [slot.up, 1]]))
  const pointerPrefix = slots.map((_, index) => kit.affine(kit.sum(pointerKinds.slice(0, index + 1))))
  const pointerTotal = pointerPrefix[capacity - 1]!
  const lastPointer = slots.map((_, index) => kit.atLeast([[pointerKinds[index]!, 1], [pointerTotal, -1], [pointerPrefix[index]!, 1]], 1))
  kit.declareOneHot(lastPointer, true)
  const anyPointer = kit.atLeast([[pointerTotal, 1]], 1)
  const pressActive = kit.bitAffine([[initial.pressActive, 1], [downPrefix[capacity - 1]!, 1], [upPrefix[capacity - 1]!, -1]])
  const lastSession = sessionBits[capacity - 1]!
  return {
    ...state,
    pointerX: kit.pick(anyPointer, initial.pointerX, kit.dot(lastPointer, slots.map(slot => slot.x))),
    pointerY: kit.pick(anyPointer, initial.pointerY, kit.dot(lastPointer, slots.map(slot => slot.y))),
    pressActive,
    slopLatch: kit.atLeast([[pressActive, 1], ...sessionSlop.map((slop, session) => [kit.mask(lastSession[session]!, slop), 1] as const)], 2),
  }
}

export type WindowsVariant =
  | {kind: 'unrolled'}
  | {kind: 'folded', maximumDowns: number, pressPoint: 'session' | 'prefix-scan'}

export function variantLabel(variant: WindowsVariant) {
  return variant.kind === 'unrolled' ? 'unrolled' : `folded, ${variant.maximumDowns} downs, ${variant.pressPoint === 'session' ? 'session reads' : 'prefix scan'}`
}

export function buildWindowsCircuit(config: WindowsConfig, capacity: number, variant: WindowsVariant) {
  validateWindowsConfig(config)
  const count = config.windows.length
  const layout = new SourceLayout()
  const frameDelta = layout.cell('frameDelta', 0, eventTimeLimit)
  const constants = allocateWindowsConstants(layout, count)
  const cells = allocateWindowsCells(layout, count)
  const slots = allocateEventQueue(layout, capacity)
  const circuit = layout.createCircuit()
  const kit = createKit(circuit)
  declareWindowsOneHots(kit, cells)
  const initial: WindowsCells = {...cells, lastClickTime: windowsAgeClickTime(kit, cells.lastClickTime, frameDelta)}
  let next = initial
  if (variant.kind === 'unrolled') {
    for (const slot of slots) next = windowsEventStep(kit, constants, next, slot).state
  } else {
    next = buildFoldedWindowsFrame(kit, constants, initial, slots, variant.maximumDowns, variant.pressPoint)
  }
  const display = windowsDisplay(kit, constants, next)
  const stateOutputs = flattenWindowsCells(next)
  const roots = [
    ...stateOutputs,
    ...display.rectangles.flatMap(rectangle => [rectangle.left, rectangle.top, rectangle.width, rectangle.height]),
    ...display.dragOwner,
  ]
  return {config, capacity, variant, layout, circuit, kit, frameDelta, constants, cells, slots, roots, stateOutputCount: stateOutputs.length}
}

export type WindowsMachine = ReturnType<typeof createWindowsMachine>

export function createWindowsMachine(config: WindowsConfig, capacity: number, variant: WindowsVariant) {
  const build = buildWindowsCircuit(config, capacity, variant)
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const source = new Float32Array(build.layout.size)
  function reset() {
    source.fill(0)
    writeWindowsConstants(source, build.constants, config)
    writeWindowsState(source, build.cells, createWindowsState(config))
  }
  reset()
  const stateCells = flattenWindowsCells(build.cells)
  const count = config.windows.length
  const dragOwnerOutputs = Array.from({length: count}, (_, index) => stateCells.length + count * 4 + index)

  function writeFrame(frameDelta: number, events: readonly QueuedEvent[]) {
    invariant(isOnTimeGrid(frameDelta) && frameDelta >= 0 && frameDelta <= eventTimeLimit, `frame delta ${frameDelta} is off the grid`)
    if (variant.kind === 'folded') {
      const downs = events.filter(event => event.kind === 'down').length
      invariant(downs <= variant.maximumDowns, `${downs} downs exceed this circuit's ${variant.maximumDowns}`)
    }
    source[build.frameDelta] = frameDelta
    writeEventQueue(source, build.slots, events)
  }

  function step(frameDelta: number, events: readonly QueuedEvent[]) {
    writeFrame(frameDelta, events)
    const outputs = evaluate(source)
    for (let index = 0; index < stateCells.length; index++) source[stateCells[index]!] = outputs[index]!
    writeEventQueue(source, build.slots, [])
    const rectangles = Array.from({length: count}, (_, index) => {
      const base = stateCells.length + index * 4
      return {left: outputs[base]!, top: outputs[base + 1]!, width: outputs[base + 2]!, height: outputs[base + 3]!}
    })
    return {
      state: readWindowsState(source, build.cells),
      display: {rectangles, dragOwner: readOneHot(outputs, dragOwnerOutputs, 'drag owner')},
    }
  }

  return {...build, source, reset, writeFrame, step}
}
