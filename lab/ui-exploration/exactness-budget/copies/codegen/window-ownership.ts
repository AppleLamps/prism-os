// Which IndirectOS window or dock item receives a press at each pixel, and
// which part of the window (title bar, a button, the resize grip).
//
// The circuit reads IndirectOS's own source table layout, so a live IndirectOS
// source table is its shared input; the press position (downX, downY) is the
// per-instance input. The hit tests and the frontmost selection are copies of
// emitRectangleHit, emitFrontmost and the geometry lines in window-manager.ts,
// which keeps them private.
import {Circuit, type Wire, emitMinimum, emitMultiply, emitRelu, emitSelect} from '../../../../../numeric-ui-core.ts'
import {sourceField, stackSourceField, windowCount, windowSourceField, windowStateField} from '../../../codegen/window-manager-copy.ts'

type Geometry = {left: Wire, top: Wire, width: Wire, height: Wire}

export const ownerCode = {desktop: 0, firstWindow: 1, firstDockItem: 1 + windowCount} as const
export const regionCode = {content: 0, titleBar: 1, close: 2, maximize: 3, minimize: 4, resizeGrip: 5} as const

function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire) {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(circuit, circuit.affine([[position, 1], [start, -1]]), circuit.affine([[end, 1], [position, -1]]))
}

function emitRectangleHit(circuit: Circuit, x: Wire, y: Wire, geometry: Geometry, unit: Wire) {
  const score = emitClampZeroOne(circuit, emitMinimum(
    circuit,
    emitIntervalDistance(circuit, x, geometry.left, geometry.width),
    emitIntervalDistance(circuit, y, geometry.top, geometry.height),
  ), unit)
  return circuit.boolean(score)
}

function emitFrontmost(circuit: Circuit, stack: readonly (readonly Wire[])[], candidates: readonly Wire[], unit: Wire) {
  const selectedRank = Array<Wire>(windowCount)
  let remaining = unit
  for (let rank = windowCount - 1; rank >= 0; rank--) {
    const terms: [Wire, number][] = []
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      terms.push([emitMultiply(circuit, stack[rank]![windowIndex]!, candidates[windowIndex]!), 1])
    }
    const rankHit = emitClampZeroOne(circuit, circuit.affine(terms), unit)
    selectedRank[rank] = emitMultiply(circuit, remaining, rankHit)
    remaining = emitRelu(circuit, circuit.affine([[remaining, 1], [rankHit, -1]]))
  }
  const selectedWindow: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const terms: [Wire, number][] = []
    for (let rank = 0; rank < windowCount; rank++) {
      terms.push([emitMultiply(circuit, stack[rank]![windowIndex]!, selectedRank[rank]!), 1])
    }
    selectedWindow.push(emitClampZeroOne(circuit, circuit.affine(terms), unit))
  }
  return selectedWindow
}

export function createWindowOwnershipCircuit() {
  const circuit = new Circuit(sourceField.size)
  circuit.assumeRange(sourceField.viewportWidth, 0, 16_384)
  circuit.assumeRange(sourceField.viewportHeight, 0, 16_384)
  circuit.assumeRange(sourceField.unit, 1, 1)
  for (const field of [
    sourceField.margin, sourceField.titleHeight, sourceField.resizeGrip, sourceField.buttonSize, sourceField.buttonGap,
    sourceField.dockHeight, sourceField.dockGap, sourceField.dockItemWidth, sourceField.systemBarHeight,
  ]) {
    circuit.assumeRange(field, 0, 1024)
  }
  circuit.assumeRange(sourceField.downX, 0, 16_384)
  circuit.assumeRange(sourceField.downY, 0, 16_384)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [windowStateField.left, windowStateField.top, windowStateField.width, windowStateField.height]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 16_384)
    }
    for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 1)
    }
  }
  for (let rank = 0; rank < windowCount; rank++) {
    circuit.assumeOneHot(Array.from({length: windowCount}, (_, windowIndex) => stackSourceField(rank, windowIndex)))
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    circuit.assumeOneHot(Array.from({length: windowCount}, (_, rank) => stackSourceField(rank, windowIndex)))
  }
  const unit = sourceField.unit
  const x = sourceField.downX
  const y = sourceField.downY

  const effectiveDockHeight = emitMinimum(circuit, sourceField.dockHeight, sourceField.viewportHeight)
  const dockTop = circuit.affine([[sourceField.viewportHeight, 1], [effectiveDockHeight, -1]])
  const workspaceTop = emitMinimum(circuit, sourceField.systemBarHeight, dockTop)
  const workspaceHeight = circuit.affine([[dockTop, 1], [workspaceTop, -1]])
  const maximumLeft = emitMinimum(circuit, sourceField.margin, circuit.affine([[sourceField.viewportWidth, 0.5]]))
  const maximumTopInset = emitMinimum(circuit, sourceField.margin, circuit.affine([[workspaceHeight, 0.5]]))
  const maximumGeometry: Geometry = {
    left: maximumLeft,
    top: circuit.affine([[workspaceTop, 1], [maximumTopInset, 1]]),
    width: emitRelu(circuit, circuit.affine([[sourceField.viewportWidth, 1], [maximumLeft, -2]])),
    height: emitRelu(circuit, circuit.affine([[workspaceHeight, 1], [maximumTopInset, -2]])),
  }

  const windowHit: Wire[] = []
  const regionTerms: [Wire, number][][] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const open = windowSourceField(windowIndex, windowStateField.open)
    const minimized = windowSourceField(windowIndex, windowStateField.minimized)
    const maximized = windowSourceField(windowIndex, windowStateField.maximized)
    const visible = emitMultiply(circuit, open, circuit.affine([[unit, 1], [minimized, -1]]))
    const normal = {
      left: windowSourceField(windowIndex, windowStateField.left),
      top: windowSourceField(windowIndex, windowStateField.top),
      width: windowSourceField(windowIndex, windowStateField.width),
      height: windowSourceField(windowIndex, windowStateField.height),
    }
    const geometry: Geometry = {
      left: emitSelect(circuit, maximized, normal.left, maximumGeometry.left),
      top: emitSelect(circuit, maximized, normal.top, maximumGeometry.top),
      width: emitSelect(circuit, maximized, normal.width, maximumGeometry.width),
      height: emitSelect(circuit, maximized, normal.height, maximumGeometry.height),
    }
    windowHit.push(emitMultiply(circuit, visible, emitRectangleHit(circuit, x, y, geometry, unit)))
    const buttonTop = circuit.affine([[geometry.top, 1], [sourceField.titleHeight, 0.5], [sourceField.buttonSize, -0.5]])
    const closeLeft = circuit.affine([[geometry.left, 1], [geometry.width, 1], [sourceField.buttonGap, -1], [sourceField.buttonSize, -1]])
    const maximizeLeft = circuit.affine([[closeLeft, 1], [sourceField.buttonGap, -1], [sourceField.buttonSize, -1]])
    const minimizeLeft = circuit.affine([[maximizeLeft, 1], [sourceField.buttonGap, -1], [sourceField.buttonSize, -1]])
    const buttonHitInset = circuit.affine([[sourceField.buttonGap, 0.5]])
    const buttonHitSize = circuit.affine([[sourceField.buttonSize, 1], [sourceField.buttonGap, 1]])
    const buttonHit = (left: Wire) => emitRectangleHit(circuit, x, y, {
      left: circuit.affine([[left, 1], [buttonHitInset, -1]]),
      top: circuit.affine([[buttonTop, 1], [buttonHitInset, -1]]),
      width: buttonHitSize,
      height: buttonHitSize,
    }, unit)
    const dragHit = emitRectangleHit(circuit, x, y, {
      left: geometry.left,
      top: geometry.top,
      width: emitRelu(circuit, circuit.affine([[minimizeLeft, 1], [sourceField.buttonGap, -1], [geometry.left, -1]])),
      height: sourceField.titleHeight,
    }, unit)
    const resizeHit = emitRectangleHit(circuit, x, y, {
      left: circuit.affine([[geometry.left, 1], [geometry.width, 1], [sourceField.resizeGrip, -1]]),
      top: circuit.affine([[geometry.top, 1], [geometry.height, 1], [sourceField.resizeGrip, -1]]),
      width: sourceField.resizeGrip,
      height: sourceField.resizeGrip,
    }, unit)
    const normalWindow = circuit.affine([[unit, 1], [maximized, -1]])
    regionTerms.push([
      [emitMultiply(circuit, dragHit, normalWindow), regionCode.titleBar],
      [buttonHit(closeLeft), regionCode.close],
      [buttonHit(maximizeLeft), regionCode.maximize],
      [buttonHit(minimizeLeft), regionCode.minimize],
      [emitMultiply(circuit, resizeHit, normalWindow), regionCode.resizeGrip],
    ])
  }
  const stack = Array.from({length: windowCount}, (_, rank) =>
    Array.from({length: windowCount}, (_, windowIndex) => stackSourceField(rank, windowIndex)))
  const selectedWindow = emitFrontmost(circuit, stack, windowHit, unit)

  const dockGap = emitMinimum(circuit, sourceField.dockGap, emitMinimum(
    circuit,
    circuit.affine([[sourceField.viewportWidth, 1 / (windowCount - 1)]]),
    circuit.affine([[effectiveDockHeight, 0.5]]),
  ))
  const dockHorizontalSpace = emitRelu(circuit, circuit.affine([[sourceField.viewportWidth, 1], [dockGap, -(windowCount - 1)]]))
  const dockVerticalSpace = emitRelu(circuit, circuit.affine([[effectiveDockHeight, 1], [dockGap, -2]]))
  const dockItemSize = emitMinimum(circuit, sourceField.dockItemWidth, emitMinimum(
    circuit,
    circuit.affine([[dockHorizontalSpace, 1 / windowCount]]),
    dockVerticalSpace,
  ))
  const dockTotalWidth = circuit.affine([[dockItemSize, windowCount], [dockGap, windowCount - 1]])
  const dockLeft = circuit.affine([[sourceField.viewportWidth, 0.5], [dockTotalWidth, -0.5]])
  const dockItemTop = circuit.affine([[dockTop, 1], [effectiveDockHeight, 0.5], [dockItemSize, -0.5]])
  const dockHit = Array.from({length: windowCount}, (_, windowIndex) => emitRectangleHit(circuit, x, y, {
    left: circuit.affine([[dockLeft, 1], [dockItemSize, windowIndex], [dockGap, windowIndex]]),
    top: dockItemTop,
    width: dockItemSize,
    height: dockItemSize,
  }, unit))

  const anyWindow = emitClampZeroOne(circuit, circuit.affine(selectedWindow.map(wire => [wire, 1] as [Wire, number])), unit)
  const noWindow = circuit.affine([[unit, 1], [anyWindow, -1]])
  const owner = circuit.affine([
    ...selectedWindow.map((wire, windowIndex) => [wire, ownerCode.firstWindow + windowIndex] as [Wire, number]),
    ...dockHit.map((hit, windowIndex) => [emitMultiply(circuit, noWindow, hit), ownerCode.firstDockItem + windowIndex] as [Wire, number]),
  ])
  const region = circuit.affine(selectedWindow.flatMap((selected, windowIndex) =>
    regionTerms[windowIndex]!.map(([hit, code]) => [emitMultiply(circuit, selected, hit), code] as [Wire, number])))
  return {circuit, owner, region, outputs: [owner, region], instanceSources: [sourceField.downX, sourceField.downY]}
}

// An independent float64 reference: walk the stack from the top, test each
// visible window's rectangle, then the dock items.
export function referenceOwnership(source: Float32Array, x: number, y: number) {
  const cell = (field: number) => source[field]!
  const inside = (left: number, top: number, width: number, height: number) =>
    Math.min(x - left, left + width - x, y - top, top + height - y) >= 0.5
  const viewportWidth = cell(sourceField.viewportWidth)
  const viewportHeight = cell(sourceField.viewportHeight)
  const effectiveDockHeight = Math.min(cell(sourceField.dockHeight), viewportHeight)
  const dockTop = viewportHeight - effectiveDockHeight
  const workspaceTop = Math.min(cell(sourceField.systemBarHeight), dockTop)
  const workspaceHeight = dockTop - workspaceTop
  const maximumLeft = Math.min(cell(sourceField.margin), viewportWidth * 0.5)
  const maximumTopInset = Math.min(cell(sourceField.margin), workspaceHeight * 0.5)
  const titleHeight = cell(sourceField.titleHeight)
  const buttonSize = cell(sourceField.buttonSize)
  const buttonGap = cell(sourceField.buttonGap)
  const grip = cell(sourceField.resizeGrip)
  for (let rank = windowCount - 1; rank >= 0; rank--) {
    let windowIndex = 0
    while (cell(stackSourceField(rank, windowIndex)) !== 1) windowIndex++
    const field = (name: keyof typeof windowStateField) => cell(windowSourceField(windowIndex, windowStateField[name]))
    if (field('open') !== 1 || field('minimized') !== 0) continue
    const maximized = field('maximized') === 1
    const left = maximized ? maximumLeft : field('left')
    const top = maximized ? workspaceTop + maximumTopInset : field('top')
    const width = maximized ? Math.max(0, viewportWidth - 2 * maximumLeft) : field('width')
    const height = maximized ? Math.max(0, workspaceHeight - 2 * maximumTopInset) : field('height')
    if (!inside(left, top, width, height)) continue
    const buttonTop = top + titleHeight * 0.5 - buttonSize * 0.5
    const closeLeft = left + width - buttonGap - buttonSize
    const maximizeLeft = closeLeft - buttonGap - buttonSize
    const minimizeLeft = maximizeLeft - buttonGap - buttonSize
    const buttonHit = (buttonLeft: number) => inside(buttonLeft - buttonGap * 0.5, buttonTop - buttonGap * 0.5, buttonSize + buttonGap, buttonSize + buttonGap)
    let region = 0
    if (!maximized && inside(left, top, Math.max(0, minimizeLeft - buttonGap - left), titleHeight)) region += regionCode.titleBar
    if (buttonHit(closeLeft)) region += regionCode.close
    if (buttonHit(maximizeLeft)) region += regionCode.maximize
    if (buttonHit(minimizeLeft)) region += regionCode.minimize
    if (!maximized && inside(left + width - grip, top + height - grip, grip, grip)) region += regionCode.resizeGrip
    return {owner: ownerCode.firstWindow + windowIndex, region}
  }
  const dockGap = Math.min(cell(sourceField.dockGap), Math.min(viewportWidth / (windowCount - 1), effectiveDockHeight * 0.5))
  const horizontalSpace = Math.max(0, viewportWidth - (windowCount - 1) * dockGap)
  const verticalSpace = Math.max(0, effectiveDockHeight - 2 * dockGap)
  const itemSize = Math.min(cell(sourceField.dockItemWidth), Math.min(horizontalSpace / windowCount, verticalSpace))
  const totalWidth = windowCount * itemSize + (windowCount - 1) * dockGap
  const dockLeft = viewportWidth * 0.5 - totalWidth * 0.5
  const itemTop = dockTop + effectiveDockHeight * 0.5 - itemSize * 0.5
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    if (inside(dockLeft + windowIndex * (itemSize + dockGap), itemTop, itemSize, itemSize)) {
      return {owner: ownerCode.firstDockItem + windowIndex, region: 0}
    }
  }
  return {owner: ownerCode.desktop, region: 0}
}
