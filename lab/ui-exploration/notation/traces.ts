// Interaction traces that drive the original createWindowManagerMachine and the
// rewrite side by side, comparing every projected output and next-source value
// bit for bit after every frame.
import {
  createWindowManagerMachine,
  dockOutputField,
  windowOutputField,
} from '../../../window-manager.ts'
import {controlField, photoField} from '../../../photo-gallery.ts'
import {type IndirectOSMachine, createIndirectOSMachine, windowCount} from './indirect-os.ts'
import {leafWires} from './table.ts'
import {read} from './wires.ts'

type OriginalMachine = ReturnType<typeof createWindowManagerMachine>
export type Pair = {
  original: OriginalMachine
  rewrite: IndirectOSMachine
  originalRoots: number[]
  rewriteRoots: number[]
  frameTime: number
  // The Photos window's focused output from the previous frame, NaN before the first frame.
  photosFocused: number
}

export function createPair(): Pair {
  const original = createWindowManagerMachine()
  const rewrite = createIndirectOSMachine()
  const photos = original.output.photos
  const originalRoots = [
    ...original.output.nextSource, ...original.output.windows, ...original.output.dockItems, original.output.animationActive,
    photos.backdropOpacity, ...photos.photos, ...photos.thumbnails, ...photos.previousControl, ...photos.nextControl,
  ]
  // The rewrite's named output structs flatten in the original's field order.
  const rewriteRoots = [...rewrite.nextSource, ...leafWires(rewrite.output)]
  return {original, rewrite, originalRoots, rewriteRoots, frameTime: 0, photosFocused: Number.NaN}
}

// Check that the original's flat output tables and the rewrite's named structs name the same fields in the same order.
export function originalFieldOrder() {
  const byOffset = (table: Record<string, number>) =>
    Object.entries(table).filter(([field]) => field !== 'size').sort((left, right) => left[1] - right[1]).map(([field]) => field)
  return {
    windows: byOffset(windowOutputField),
    dockItems: byOffset(dockOutputField),
    photos: byOffset(photoField),
    controls: byOffset(controlField),
  }
}

const bits = new Float32Array(2)
const bitView = new Uint32Array(bits.buffer)
function sameBits(left: number, right: number) {
  bits[0] = left
  bits[1] = right
  return bitView[0] === bitView[1]
}

export type Action =
  | {kind: 'down' | 'move' | 'up' | 'photoClick', x: number, y: number}
  | {kind: 'photoPrevious' | 'photoNext' | 'photoClose'}

export type Frame = {actions: readonly Action[], width: number, height: number, elapsed: number}

export type TraceResult = {
  frames: number
  comparedValues: number
  mismatchedValues: number
  firstMismatch: string | null
  // Frames where a machine's runtime validator threw. The trace then evaluates
  // the same circuit on the same table and writes back, so it can continue.
  originalRejections: number
  rewriteRejections: number
  disagreements: number
  firstOriginalRejection: string | null
  firstRewriteRejection: string | null
  // How often the trace reaches interactions that are easy to miss, read from
  // the rewrite's state. The bits match the original's, so the counts hold for both.
  coverage: {
    // A drag or resize pressed in an earlier frame changes a window in a frame
    // with pointer movement, no press, and no viewport change.
    heldDragMoves: number
    heldResizeMoves: number
    // One press raises Photos and opens a photo in the same evaluation.
    focusAndSelect: number
  }
}

type Steppable = {
  step: (width: number, height: number, frameTime: number) => Float32Array
  circuit: {evaluateTensor: (source: Float32Array) => Float32Array}
  source: Float32Array
}

function stepOrRecover(machine: Steppable, nextSource: readonly number[], frame: Frame, frameTime: number) {
  try {
    return {values: machine.step(frame.width, frame.height, frameTime), rejection: null}
  } catch (error) {
    // step already wrote the viewport and frame time before validating.
    const values = machine.circuit.evaluateTensor(machine.source)
    for (let offset = 0; offset < machine.source.length; offset++) machine.source[offset] = values[nextSource[offset]!]!
    return {values, rejection: (error as Error).message}
  }
}

export function stepPair(pair: Pair, frame: Frame, result: TraceResult) {
  const {source, cells, photoCells, output} = pair.rewrite
  const hasDown = frame.actions.some(action => action.kind === 'down')
  const hasMotion = frame.actions.some(action => action.kind === 'move' || action.kind === 'up')
  const sameViewport = source[cells.viewportWidth] === frame.width && source[cells.viewportHeight] === frame.height
  const heldDrag = cells.drag.map(wire => source[wire] === 1)
  const heldResize = cells.resize.map(wire => source[wire] === 1)
  const windowsBefore = cells.windows.map(window => read(source, window))
  const photoOpenBefore = photoCells.focus.some(wire => source[wire] === 1)

  for (const machine of [pair.original, pair.rewrite]) {
    for (const action of frame.actions) {
      if (action.kind === 'down') machine.pointerDown(action.x, action.y)
      else if (action.kind === 'move') machine.pointerMove(action.x, action.y)
      else if (action.kind === 'up') machine.pointerUp(action.x, action.y)
      else if (action.kind === 'photoClick') machine.photoClick(action.x, action.y)
      else if (action.kind === 'photoPrevious') machine.photoPrevious()
      else if (action.kind === 'photoNext') machine.photoNext()
      else machine.photoClose()
    }
  }
  pair.frameTime += frame.elapsed
  const originalStep = stepOrRecover(pair.original, pair.original.output.nextSource, frame, pair.frameTime)
  const rewriteStep = stepOrRecover(pair.rewrite, pair.rewrite.nextSource, frame, pair.frameTime)
  const originalValues = originalStep.values
  const rewriteValues = rewriteStep.values
  result.frames++
  if (originalStep.rejection !== null) {
    result.originalRejections++
    result.firstOriginalRejection ??= `frame ${result.frames}: ${originalStep.rejection}`
  }
  if (rewriteStep.rejection !== null) {
    result.rewriteRejections++
    result.firstRewriteRejection ??= `frame ${result.frames}: ${rewriteStep.rejection}`
  }
  if ((originalStep.rejection === null) !== (rewriteStep.rejection === null)) result.disagreements++
  for (let index = 0; index < pair.originalRoots.length; index++) {
    result.comparedValues++
    const left = originalValues[pair.originalRoots[index]!]!
    const right = rewriteValues[pair.rewriteRoots[index]!]!
    if (!sameBits(left, right)) {
      result.mismatchedValues++
      result.firstMismatch ??= `frame ${result.frames}, root ${index}: ${left} vs ${right}`
    }
  }

  if (!hasDown && hasMotion && sameViewport) {
    cells.windows.forEach((window, index) => {
      const before = windowsBefore[index]!
      const after = read(source, window)
      if (heldDrag[index] && (after.left !== before.left || after.top !== before.top)) result.coverage.heldDragMoves++
      if (heldResize[index] && (after.width !== before.width || after.height !== before.height)) result.coverage.heldResizeMoves++
    })
  }
  const photosFocused = rewriteValues[output.windows[windowCount - 1]!.focused]!
  const photoOpenAfter = photoCells.focus.some(wire => source[wire] === 1)
  if (hasDown && pair.photosFocused === 0 && photosFocused === 1 && !photoOpenBefore && photoOpenAfter) result.coverage.focusAndSelect++
  pair.photosFocused = photosFocused
  return rewriteValues
}

export const emptyResult = (): TraceResult => ({
  frames: 0,
  comparedValues: 0,
  mismatchedValues: 0,
  firstMismatch: null,
  originalRejections: 0,
  rewriteRejections: 0,
  disagreements: 0,
  firstOriginalRejection: null,
  firstRewriteRejection: null,
  coverage: {heldDragMoves: 0, heldResizeMoves: 0, focusAndSelect: 0},
})

export function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

const click = (x: number, y: number): Action[] => [{kind: 'down', x, y}, {kind: 'up', x, y}]

// Points on screen come from the rewrite's current outputs, so actions aim at real controls.
function screenPoints(pair: Pair, values: Float32Array) {
  const windows = read(values, pair.rewrite.output.windows)
  const dockItems = read(values, pair.rewrite.output.dockItems)
  const photos = read(values, pair.rewrite.output.photos)
  const constants = pair.rewrite.source
  const cells = pair.rewrite.cells
  const buttonSize = constants[cells.buttonSize]!
  const buttonGap = constants[cells.buttonGap]!
  const titleHeight = constants[cells.titleHeight]!
  const grip = constants[cells.resizeGrip]!
  return {
    control(index: number, control: 'minimize' | 'maximize' | 'close') {
      const window = windows[index]!
      const closeX = window.translateX + window.width - buttonGap - buttonSize / 2
      const step = control === 'close' ? 0 : control === 'maximize' ? 1 : 2
      return {x: closeX - step * (buttonGap + buttonSize), y: window.translateY + titleHeight / 2}
    },
    dock(index: number) {
      const item = dockItems[index]!
      return {x: item.left + item.width / 2, y: item.top + item.height / 2}
    },
    // A point on the title bar, near its left end, or at a fraction of the window's width.
    title(index: number, along?: number) {
      const window = windows[index]!
      const x = along === undefined ? window.translateX + Math.min(40, window.width / 4) : window.translateX + window.width * along
      return {x, y: window.translateY + Math.min(titleHeight / 2, window.height / 4)}
    },
    grip(index: number) {
      const window = windows[index]!
      return {x: window.translateX + window.width - Math.min(grip / 2, window.width / 4), y: window.translateY + window.height - Math.min(grip / 2, window.height / 4)}
    },
    // A photo, thumbnail, or control center in Photos' local coordinates.
    photoTarget(random: () => number) {
      const pool = [...photos.photos, ...photos.thumbnails, photos.previousControl, photos.nextControl]
      const target = pool[Math.floor(random() * pool.length)]!
      return {x: target.left + target.width * random(), y: target.top + target.height * random()}
    },
    photosWindow: windows[windowCount - 1]!,
    titleHeight,
  }
}

export function randomFrame(pair: Pair, values: Float32Array, width: number, height: number, random: () => number): Frame {
  const points = screenPoints(pair, values)
  const index = Math.floor(random() * windowCount)
  const elapsed = 1 + random() * 40
  const {source, cells} = pair.rewrite
  // While a drag or resize is held, half of the frames move the pointer without a press.
  const held = [...cells.drag, ...cells.resize].some(wire => source[wire] === 1)
  const choice = held && random() < 0.5 ? 12 + Math.floor(random() * 2) : Math.floor(random() * 15)
  if (choice === 0) return {actions: [], width: Math.floor(random() * 1_500), height: Math.floor(random() * 1_000), elapsed}
  if (choice === 1) return {actions: [{kind: 'down', x: random() * width, y: random() * height}, {kind: 'up', x: random() * width, y: random() * height}], width, height, elapsed}
  if (choice >= 2 && choice <= 4) {
    const point = points.control(index, (['maximize', 'minimize', 'close'] as const)[choice - 2]!)
    return {actions: click(point.x, point.y), width, height, elapsed}
  }
  if (choice === 5) {
    const point = points.dock(index)
    return {actions: click(point.x, point.y), width, height, elapsed}
  }
  if (choice === 6 || choice === 7) {
    const start = choice === 6 ? points.title(index) : points.grip(index)
    const end = {x: start.x + (random() - 0.5) * width, y: start.y + (random() - 0.5) * height}
    const actions: Action[] = [{kind: 'down', ...start}, {kind: 'move', ...end}]
    // Sometimes the drag continues across frames instead of ending in this one.
    if (random() < 0.5) actions.push({kind: 'up', ...end})
    return {actions, width, height, elapsed}
  }
  if (choice === 8) {
    const point = points.photoTarget(random)
    const photosWindow = points.photosWindow
    const globalX = photosWindow.translateX + 1 + point.x
    const globalY = photosWindow.translateY + points.titleHeight + 1 + point.y
    return {actions: [...click(globalX, globalY), {kind: 'photoClick', x: point.x, y: point.y}], width, height, elapsed}
  }
  if (choice === 9) return {actions: [{kind: 'photoClick', ...points.photoTarget(random)}], width, height, elapsed}
  if (choice === 10) return {actions: [{kind: random() < 0.5 ? 'photoPrevious' : 'photoNext'}], width, height, elapsed}
  if (choice === 11) return {actions: [{kind: 'photoClose'}], width, height, elapsed}
  if (choice === 12 || choice === 13) {
    // A move without a press, so a drag or resize held since an earlier frame
    // continues: a near move of up to 120 px, or a far one that may reach the clamps.
    const pointer = read(source, cells.pointer)
    const reach = choice === 12 ? {x: 240, y: 240} : {x: width, y: height}
    return {actions: [{kind: 'move', x: pointer.x + (random() - 0.5) * reach.x, y: pointer.y + (random() - 0.5) * reach.y}], width, height, elapsed}
  }
  // Frames with no events while springs run.
  return {actions: [], width, height, elapsed}
}

export function runRandomTrace(seed: number, frameCount: number, pair = createPair()) {
  const random = createRandom(seed)
  const result = emptyResult()
  let width = 1280
  let height = 800
  let values = stepPair(pair, {actions: [], width, height, elapsed: 16}, result)
  for (let frame = 0; frame < frameCount; frame++) {
    const next = randomFrame(pair, values, width, height, random)
    width = next.width
    height = next.height
    values = stepPair(pair, next, result)
  }
  return result
}

// A scripted tour: drag past both viewport edges, resize down to the minimum
// size, maximize, minimize, dock restore, close, dock reopen, the Photos grid
// click, next, previous, a thumbnail click, close, one click that focuses Photos
// and opens a photo, and viewport resizes, with settling frames between steps.
// Every step records whether it took effect, read from the rewrite's state; the
// bits match the original's, so the checks hold for both machines.
export function runScriptedTrace() {
  const pair = createPair()
  const result = emptyResult()
  const checks: Record<string, boolean> = {}
  const {source, cells, photoCells, output} = pair.rewrite
  let width = 1280
  let height = 800
  let values = stepPair(pair, {actions: [], width, height, elapsed: 16}, result)
  const frame = (actions: Action[], elapsed = 16) => {
    values = stepPair(pair, {actions, width, height, elapsed}, result)
  }
  const settle = (frames = 45) => {
    for (let count = 0; count < frames; count++) frame([])
  }
  const points = () => screenPoints(pair, values)
  const windowState = (index: number) => read(source, cells.windows[index]!)
  const focusedWindow = () => read(values, output.windows).findIndex(window => window.focused === 1)
  const openPhoto = () => photoCells.focus.findIndex(wire => source[wire] === 1)
  const dockTop = () => height - Math.min(source[cells.dockHeight]!, height)
  const workspaceTop = () => Math.min(source[cells.systemBarHeight]!, dockTop())

  frame(click(100, 80))
  checks['a click raises and focuses window 0'] = focusedWindow() === 0
  // Window 0 now covers the left part of window 1's title bar, so press right of it.
  let start = points().title(1, 0.6)
  const beforeDrag = windowState(1)
  frame([{kind: 'down', ...start}, {kind: 'move', x: start.x + 30.5, y: start.y + 25.25}])
  checks['a title bar press starts a drag and moves window 1 in the same frame'] =
    source[cells.drag[1]!] === 1 && focusedWindow() === 1 && windowState(1).left === beforeDrag.left + 30.5 && windowState(1).top === beforeDrag.top + 25.25
  frame([{kind: 'move', x: start.x - 900, y: start.y - 900}])
  checks['a held drag stops at the left and top edges'] = source[cells.drag[1]!] === 1 && windowState(1).left === 0 && windowState(1).top === workspaceTop()
  frame([{kind: 'move', x: start.x + 2000, y: start.y + 2000}])
  checks['a held drag stops at the right and bottom edges'] =
    source[cells.drag[1]!] === 1 && windowState(1).left + windowState(1).width === width && windowState(1).top + windowState(1).height === dockTop()
  frame([{kind: 'up', x: start.x + 2000, y: start.y + 2000}])
  checks['releasing the pointer ends the drag'] = source[cells.drag[1]!] === 0
  start = points().grip(2)
  const beforeResize = windowState(2)
  frame([{kind: 'down', ...start}])
  checks['a grip press starts a resize'] = source[cells.resize[2]!] === 1 && focusedWindow() === 2
  frame([{kind: 'move', x: start.x + 120.75, y: start.y + 80.125}])
  checks['a held resize grows window 2'] = windowState(2).width === beforeResize.width + 120.75 && windowState(2).height === beforeResize.height + 80.125
  frame([{kind: 'move', x: start.x - 1000, y: start.y - 1000}])
  checks['a held resize stops at the minimum size'] = windowState(2).width === source[cells.minWidth] && windowState(2).height === source[cells.minHeight]
  frame([{kind: 'up', x: start.x - 1000, y: start.y - 1000}])
  checks['releasing the pointer ends the resize'] = source[cells.resize[2]!] === 0
  for (const control of ['maximize', 'minimize'] as const) {
    const point = points().control(3, control)
    frame(click(point.x, point.y))
    checks[`the ${control} button works on window 3`] = windowState(3)[control === 'maximize' ? 'maximized' : 'minimized'] === 1
    settle()
  }
  width = 900
  height = 600
  frame([])
  let point = points().dock(3)
  frame(click(point.x, point.y))
  checks['the dock item restores minimized window 3'] = windowState(3).open === 1 && windowState(3).minimized === 0
  settle()
  point = points().control(3, 'close')
  frame(click(point.x, point.y), 33)
  checks['the close button closes window 3'] = windowState(3).open === 0
  settle()
  point = points().dock(3)
  frame(click(point.x, point.y), 7)
  checks['the dock item reopens closed window 3'] = windowState(3).open === 1 && focusedWindow() === 3
  settle()
  width = 1440
  height = 900
  const photo = read(values, output.photos).photos[5]!
  frame([{kind: 'photoClick', x: photo.left + photo.width / 2, y: photo.top + photo.height / 2}])
  checks['a grid click opens photo 5'] = openPhoto() === 5
  frame([{kind: 'photoNext'}])
  checks['next shows photo 6'] = openPhoto() === 6
  settle(20)
  frame([{kind: 'photoPrevious'}])
  frame([{kind: 'photoPrevious'}])
  checks['previous twice shows photo 4'] = openPhoto() === 4
  settle(20)
  const thumbnail = read(values, output.photos).thumbnails[8]!
  frame([{kind: 'photoClick', x: thumbnail.left + thumbnail.width / 2, y: thumbnail.top + thumbnail.height / 2}])
  checks['a thumbnail click shows photo 8'] = openPhoto() === 8
  settle(20)
  frame([{kind: 'photoClose'}])
  checks['close returns to the grid'] = openPhoto() === -1
  // A point on window 0 only: Photos starts further right.
  frame(click(100, 200))
  checks['a click on window 0 takes focus from Photos'] = focusedWindow() === 0
  const photosWindow = points().photosWindow
  const target = read(values, output.photos).photos[3]!
  const localX = target.left + target.width / 2
  const localY = target.top + target.height / 2
  const focusBefore = focusedWindow()
  const coverageBefore = result.coverage.focusAndSelect
  frame([...click(photosWindow.translateX + 1 + localX, photosWindow.translateY + points().titleHeight + 1 + localY), {kind: 'photoClick', x: localX, y: localY}])
  checks['one click focuses Photos and opens photo 3 in the same evaluation'] =
    focusBefore === 0 && focusedWindow() === 3 && openPhoto() === 3 && result.coverage.focusAndSelect === coverageBefore + 1
  settle()
  width = 0
  height = 0
  frame([])
  width = 40
  height = 40
  frame([])
  width = 1280
  height = 800
  settle()
  checks['the lightbox stays open through viewports 0×0 and 40×40'] = openPhoto() === 3
  return {...result, checks}
}
