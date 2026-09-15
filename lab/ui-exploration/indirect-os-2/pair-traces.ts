// Interaction traces that drive window-manager.ts and this folder's machine side
// by side, adapted from notation/traces.ts. Two comparisons:
// - 'all roots': every next-source value and projected output, bit for bit, for
//   variants that should compile to the same arithmetic;
// - 'discrete': focus, window geometry, open, minimized, maximized, drag and
//   resize owners, stacking, and photo focus, for variants whose springs differ.
import {
  createWindowManagerMachine,
  dragSourceField,
  photoFocusSourceField,
  resizeSourceField,
  stackSourceField,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../../window-manager.ts'
import {type IndirectOSMachine, type IndirectOSOptions, type MachineOptions, createIndirectOSMachine, windowCount} from './indirect-os.ts'
import {photoCount} from './photos.ts'
import {leafWires} from './table.ts'
import {read} from '../notation/wires.ts'

type OriginalMachine = ReturnType<typeof createWindowManagerMachine>
export type Comparison = 'all roots' | 'discrete'
export type Pair = {
  original: OriginalMachine
  rewrite: IndirectOSMachine
  comparison: Comparison
  originalRoots: number[]
  rewriteRoots: number[]
  frameTime: number
  // The Photos window's focused output from the previous frame, NaN before the first frame.
  photosFocused: number
  // Whether the Photos window's springs were settled in both machines last frame.
  photosSettledInBoth: boolean
}

export function createPair(options: IndirectOSOptions, comparison: Comparison, machineOptions: MachineOptions = {}): Pair {
  const original = createWindowManagerMachine()
  const rewrite = createIndirectOSMachine(options, machineOptions)
  const photos = original.output.photos
  const originalRoots = [
    ...original.output.nextSource, ...original.output.windows, ...original.output.dockItems, original.output.animationActive,
    photos.backdropOpacity, ...photos.photos, ...photos.thumbnails, ...photos.previousControl, ...photos.nextControl,
  ]
  const rewriteRoots = [...rewrite.nextSource, ...leafWires(rewrite.output)]
  return {original, rewrite, comparison, originalRoots, rewriteRoots, frameTime: 0, photosFocused: Number.NaN, photosSettledInBoth: true}
}

const bits = new Float32Array(2)
const bitView = new Uint32Array(bits.buffer)
function sameBits(left: number, right: number) {
  bits[0] = left
  bits[1] = right
  return bitView[0] === bitView[1]
}

export function originalDiscrete(machine: OriginalMachine, values: Float32Array) {
  const state: number[] = []
  for (let index = 0; index < windowCount; index++) {
    state.push(values[machine.output.windows[index * windowOutputField.size + windowOutputField.focused]!]!)
    for (const field of ['left', 'top', 'width', 'height', 'open', 'minimized', 'maximized'] as const) state.push(machine.source[windowSourceField(index, windowStateField[field])]!)
    state.push(machine.source[dragSourceField(index)]!, machine.source[resizeSourceField(index)]!)
    for (let rank = 0; rank < windowCount; rank++) state.push(machine.source[stackSourceField(rank, index)]!)
  }
  for (let item = 0; item < photoCount; item++) state.push(machine.source[photoFocusSourceField(item)]!)
  return state
}

export function rewriteDiscrete(machine: IndirectOSMachine, values: Float32Array) {
  const {cells, output, source} = machine
  const state: number[] = []
  for (let index = 0; index < windowCount; index++) {
    state.push(values[output.windows[index]!.focused]!)
    const window = cells.windows[index]!
    for (const field of ['left', 'top', 'width', 'height', 'open', 'minimized', 'maximized'] as const) state.push(source[window[field]]!)
    state.push(source[cells.pressLatches!.drag[index]!]!, source[cells.pressLatches!.resize[index]!]!)
    for (let rank = 0; rank < windowCount; rank++) state.push(source[cells.stack[rank]![index]!]!)
  }
  for (let item = 0; item < photoCount; item++) state.push(source[cells.photoState.focus[item]!]!)
  return state
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
  // Frames where a machine's runtime validator threw. The runner then evaluates
  // the same circuit on the same table and writes back, so the trace can continue.
  originalRejections: number
  rewriteRejections: number
  firstRewriteRejection: string | null
  coverage: {heldDragMoves: number, heldResizeMoves: number, focusAndSelect: number, photoFocusChanges: number, closes: number}
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
  const {source, cells, output} = pair.rewrite
  const latches = cells.latches!
  const pressLatches = cells.pressLatches!
  const hasDown = frame.actions.some(action => action.kind === 'down')
  const hasMotion = frame.actions.some(action => action.kind === 'move' || action.kind === 'up')
  const sameViewport = source[cells.layout.viewportWidth] === frame.width && source[cells.layout.viewportHeight] === frame.height
  const heldDrag = pressLatches.drag.map(wire => source[wire] === 1)
  const heldResize = pressLatches.resize.map(wire => source[wire] === 1)
  const windowsBefore = cells.windows.map(window => read(source, window))
  const focusBefore = cells.photoState.focus.map(wire => source[wire])
  const photoOpenBefore = focusBefore.some(value => value === 1)

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
  result.frames++
  if (originalStep.rejection !== null) result.originalRejections++
  if (rewriteStep.rejection !== null) {
    result.rewriteRejections++
    result.firstRewriteRejection ??= `frame ${result.frames}: ${rewriteStep.rejection}`
  }
  const compare = (left: readonly number[] | ArrayLike<number>, right: readonly number[] | ArrayLike<number>) => {
    for (let index = 0; index < left.length; index++) {
      result.comparedValues++
      if (!sameBits(left[index]!, right[index]!)) {
        result.mismatchedValues++
        result.firstMismatch ??= `frame ${result.frames}, value ${index}: ${left[index]} vs ${right[index]}`
      }
    }
  }
  if (pair.comparison === 'all roots') {
    compare(pair.originalRoots.map(wire => originalStep.values[wire]!), pair.rewriteRoots.map(wire => rewriteStep.values[wire]!))
  } else {
    compare(originalDiscrete(pair.original, originalStep.values), rewriteDiscrete(pair.rewrite, rewriteStep.values))
  }

  if (!hasDown && hasMotion && sameViewport) {
    cells.windows.forEach((window, index) => {
      const windowBefore = windowsBefore[index]!
      const after = read(source, window)
      if (heldDrag[index] && (after.left !== windowBefore.left || after.top !== windowBefore.top)) result.coverage.heldDragMoves++
      if (heldResize[index] && (after.width !== windowBefore.width || after.height !== windowBefore.height)) result.coverage.heldResizeMoves++
    })
  }
  cells.windows.forEach((window, index) => {
    if (windowsBefore[index]!.open === 1 && source[window.open] === 0) result.coverage.closes++
  })
  if (cells.photoState.focus.some((wire, item) => source[wire] !== focusBefore[item])) result.coverage.photoFocusChanges++
  const photosFocused = rewriteStep.values[output.windows[windowCount - 1]!.focused]!
  const photoOpenAfter = cells.photoState.focus.some(wire => source[wire] === 1)
  if (hasDown && pair.photosFocused === 0 && photosFocused === 1 && !photoOpenBefore && photoOpenAfter) result.coverage.focusAndSelect++
  pair.photosFocused = photosFocused
  // A window's stack output adds 40 while its springs are active.
  const photosStack = windowOutputField.stack
  pair.photosSettledInBoth = originalStep.values[pair.original.output.windows[(windowCount - 1) * windowOutputField.size + photosStack]!]! < 40
    && rewriteStep.values[output.windows[windowCount - 1]!.stack]! < 40
  void latches
  return rewriteStep.values
}

export const emptyResult = (): TraceResult => ({
  frames: 0, comparedValues: 0, mismatchedValues: 0, firstMismatch: null, originalRejections: 0, rewriteRejections: 0, firstRewriteRejection: null,
  coverage: {heldDragMoves: 0, heldResizeMoves: 0, focusAndSelect: 0, photoFocusChanges: 0, closes: 0},
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
  const {source, cells} = pair.rewrite
  const buttonSize = source[cells.layout.buttonSize]!
  const buttonGap = source[cells.layout.buttonGap]!
  const titleHeight = source[cells.layout.titleHeight]!
  const grip = source[cells.layout.resizeGrip]!
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
    title(index: number, along?: number) {
      const window = windows[index]!
      const x = along === undefined ? window.translateX + Math.min(40, window.width / 4) : window.translateX + window.width * along
      return {x, y: window.translateY + Math.min(titleHeight / 2, window.height / 4)}
    },
    grip(index: number) {
      const window = windows[index]!
      return {x: window.translateX + window.width - Math.min(grip / 2, window.width / 4), y: window.translateY + window.height - Math.min(grip / 2, window.height / 4)}
    },
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
  const pressLatches = cells.pressLatches!
  // While a drag or resize is held, half of the frames move the pointer without a press.
  const held = [...pressLatches.drag, ...pressLatches.resize].some(wire => source[wire] === 1)
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
  // Photos hit-tests a click against its layout at the animated window size, so
  // a click while the Photos window animates can land on different photos when
  // the springs differ. Clicks are sent only while both machines have settled it.
  if (choice === 8) {
    const point = points.photoTarget(random)
    const photosWindow = points.photosWindow
    const globalX = photosWindow.translateX + 1 + point.x
    const globalY = photosWindow.translateY + points.titleHeight + 1 + point.y
    const photoAction: Action[] = pair.photosSettledInBoth ? [{kind: 'photoClick', x: point.x, y: point.y}] : []
    return {actions: [...click(globalX, globalY), ...photoAction], width, height, elapsed}
  }
  if (choice === 9) return {actions: pair.photosSettledInBoth ? [{kind: 'photoClick', ...points.photoTarget(random)}] : [], width, height, elapsed}
  if (choice === 10) return {actions: [{kind: random() < 0.5 ? 'photoPrevious' : 'photoNext'}], width, height, elapsed}
  if (choice === 11) return {actions: [{kind: 'photoClose'}], width, height, elapsed}
  if (choice === 12 || choice === 13) {
    const pointer = read(source, cells.latches!.pointer)
    const reach = choice === 12 ? {x: 240, y: 240} : {x: width, y: height}
    return {actions: [{kind: 'move', x: pointer.x + (random() - 0.5) * reach.x, y: pointer.y + (random() - 0.5) * reach.y}], width, height, elapsed}
  }
  return {actions: [], width, height, elapsed}
}

export function runRandomTrace(pair: Pair, seed: number, frameCount: number) {
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
