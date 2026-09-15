// IndirectOS's window logic with one latch per pointer event kind, as in
// window-manager.ts and notation/indirect-os.ts, with the operations created in
// the same order. One frame may carry a down, a move, and an up, applied in that
// order; buttons act on the down.
import type {Wire} from '../../../numeric-ui-core.ts'
import type {PhotoConstantCells, PhotoDebug, PhotoInputs, PhotoOutputs, PhotoSprings, PhotoStateCells} from './photos.ts'
import {type SourceTable, list} from './table.ts'
import type {Notation, Rect, Vec2} from '../notation/wires.ts'

export type LayoutWires = {
  viewportWidth: Wire, viewportHeight: Wire, unit: Wire, margin: Wire, titleHeight: Wire, minWidth: Wire, minHeight: Wire,
  resizeGrip: Wire, buttonSize: Wire, buttonGap: Wire, dockHeight: Wire, dockGap: Wire, dockItemWidth: Wire,
}
export type WindowWires = {left: Wire, top: Wire, width: Wire, height: Wire, open: Wire, minimized: Wire, maximized: Wire, present: Wire}

export type DesktopContext = {
  $: Notation
  table: SourceTable
  layout: LayoutWires
  windows: readonly WindowWires[]
  stack: readonly (readonly Wire[])[]
  effectiveDockHeight: Wire
  dockTop: Wire
  workspaceTop: Wire
  workspaceHeight: Wire
  maximizedRect: Rect
  photoConstants: PhotoConstantCells
  photoState: PhotoStateCells
}

export type DesktopResult = {
  updated: {normal: Rect, open: Wire, minimized: Wire, maximized: Wire, direct: Wire}[]
  nextStack: Wire[][]
  next: {visible: Wire, box: Rect}[]
  focused: Wire[]
  dock: {box: Rect}[]
  // The queue build owns Photos' focus, so it also renders Photos.
  renderPhotos?: (inputs: PhotoInputs, state: PhotoStateCells, springs: PhotoSprings) => {output: PhotoOutputs, debug: PhotoDebug}
  debug: Record<string, unknown>
}

type LatchWires = {down: {active: Wire} & Vec2, move: {active: Wire} & Vec2, up: {active: Wire} & Vec2, pointer: Vec2}

// category: behavior
export function buildLatchDesktop(context: DesktopContext, latches: LatchWires, pressLatches: {drag: Wire[], resize: Wire[]}): DesktopResult {
  const {$, table, layout, windows, stack, dockTop, workspaceTop, workspaceHeight, maximizedRect} = context
  const {sum, sub, half, relu, mul, min, clamp, clamp01, not, select, rect, hit, zero, unit} = $
  const {viewportWidth, titleHeight, buttonSize, buttonGap, resizeGrip} = layout
  const down = $.vec2(latches.down.x, latches.down.y)

  const current = windows.map(window => {
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
  const pressedWindow = frontmost($, stack, current.map(window => window.windowHit))

  // window-manager.ts creates each dock item's hit test right after its box.
  const dockHits: Wire[] = []
  const dock = dockGeometry(context, box => dockHits.push(hit(down, box)))

  // Presses on window controls count only on the frontmost window under the pointer.
  const presses = current.map((window, index) => {
    const canvas = mul(latches.down.active, pressedWindow[index]!)
    const dockPress = mul(latches.down.active, dockHits[index]!)
    const selected = clamp01(sum(canvas, dockPress))
    const closePress = mul(canvas, window.closeHit)
    const minimizePress = mul(canvas, window.minimizeHit)
    const maximizePress = mul(canvas, window.maximizeHit)
    const normalWindow = not(windows[index]!.maximized)
    const dragPress = mul(mul(canvas, window.dragHit), normalWindow)
    const resizePress = mul(mul(canvas, window.resizeHit), normalWindow)
    return {dockPress, selected, closePress, minimizePress, maximizePress, dragPress, resizePress}
  })

  // One frame may carry a down, a move, and an up together.
  const baseline = select(latches.down.active, latches.pointer, {x: latches.down.x, y: latches.down.y})
  const moved = select(latches.move.active, baseline, {x: latches.move.x, y: latches.move.y})
  const pointer: Vec2 = select(latches.up.active, moved, {x: latches.up.x, y: latches.up.y})
  const delta = $.zip((to, from) => sub(to, from), pointer, baseline)
  const pointerStillDown = not(latches.up.active)

  const updated = windows.map((window, index) => {
    const press = presses[index]!
    const dragging = select(latches.down.active, pressLatches.drag[index]!, press.dragPress)
    const resizing = select(latches.down.active, pressLatches.resize[index]!, press.resizePress)
    const nextDrag = mul(dragging, pointerStillDown)
    const nextResize = mul(resizing, pointerStillDown)
    const direct = clamp01(sum(dragging, resizing))
    const widthCandidate = sum(window.width, mul(resizing, delta.x))
    const heightCandidate = sum(window.height, mul(resizing, delta.y))
    const width = clamp(widthCandidate, min(layout.minWidth, viewportWidth), viewportWidth)
    const height = clamp(heightCandidate, min(layout.minHeight, workspaceHeight), workspaceHeight)
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
    table.next(pressLatches.drag[index]!, nextDrag)
    table.next(pressLatches.resize[index]!, nextResize)
    return {normal: rect(left, top, width, height), open, minimized, maximized, direct}
  })

  const nextStack = raiseToFront($, stack, presses.map(press => press.selected))
  const next = updated.map(window => ({
    visible: mul(window.open, not(window.minimized)),
    box: select(window.maximized, window.normal, maximizedRect),
  }))
  const focused = frontmost($, nextStack, next.map(window => window.visible))
  table.next(latches.pointer, pointer)
  return {updated, nextStack, next, focused, dock, debug: {}}
}

// The dock's items: centered along the bottom, shrinking to fit narrow viewports.
// `afterItem` runs right after each item's box is created.
export function dockGeometry(context: DesktopContext, afterItem: (box: Rect) => void = () => {}) {
  const {$, layout, effectiveDockHeight: dockHeight, dockTop} = context
  const {sum, scale, half, relu, min, rect} = $
  const {viewportWidth} = layout
  const windowCount = context.windows.length
  const dockGap = min(layout.dockGap, min(scale(viewportWidth, 1 / (windowCount - 1)), half(dockHeight)))
  const dockHorizontalSpace = relu(sum(viewportWidth, [dockGap, -(windowCount - 1)]))
  const dockVerticalSpace = relu(sum(dockHeight, [dockGap, -2]))
  const dockItemSize = min(layout.dockItemWidth, min(scale(dockHorizontalSpace, 1 / windowCount), dockVerticalSpace))
  const dockLeft = sum([viewportWidth, 0.5], [sum([dockItemSize, windowCount], [dockGap, windowCount - 1]), -0.5])
  const dockItemTop = sum(dockTop, [dockHeight, 0.5], [dockItemSize, -0.5])
  return list(windowCount, index => {
    const box = rect(sum(dockLeft, [dockItemSize, index], [dockGap, index]), dockItemTop, dockItemSize, dockItemSize)
    afterItem(box)
    return {box}
  })
}

// Scan ranks from the top: a rank takes the hit only if nothing above it did.
export function frontmost($: Notation, order: readonly (readonly Wire[])[], candidates: readonly Wire[]) {
  const {sub, mul, relu, clamp01, dot, unit} = $
  const count = candidates.length
  const selectedRank = Array<Wire>(count)
  let remaining = unit
  for (let rank = count - 1; rank >= 0; rank--) {
    const rankHit = clamp01(dot(order[rank]!, candidates))
    selectedRank[rank] = mul(remaining, rankHit)
    remaining = relu(sub(remaining, rankHit))
  }
  return list(count, index => clamp01(dot(order.map(row => row[index]!), selectedRank)))
}

// The selected window moves to the top rank; the windows above it move down one rank.
export function raiseToFront($: Notation, order: readonly (readonly Wire[])[], selected: readonly Wire[]) {
  const {sum, mul, not, clamp01, dot} = $
  const count = selected.length
  const inactive = not(clamp01(sum(...selected)))
  const selectedRank = order.map(row => clamp01(dot(row, selected)))
  return list(count, rank => list(count, index => sum(
    mul(inactive, order[rank]![index]!),
    rank === count - 1
      ? selected[index]!
      : sum(...selectedRank.map((bitAtRank, from) => mul(bitAtRank, order[rank < from ? rank : rank + 1]![index]!))),
  )))
}
