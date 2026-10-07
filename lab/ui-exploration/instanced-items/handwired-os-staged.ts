// HandwiredOS (window-manager.ts with Photos from photo-gallery.ts) as a staged program: windows,
// dock items and photos are instance arrays, each per-item section is a map stage written once,
// and the loops across items are reductions.
//
// Section by section against window-manager.ts and photo-gallery.ts, where the window-manager.ts
// line ranges in the section comments below are at commit e3311d1:
// - window hits, presses, geometry, the stack update, springs and projection are map stages over
//   the 4 windows; dock geometry and hits a map stage over the 4 dock items;
// - the frontmost window under a press, and the frontmost visible window, are a max over each
//   window's key (rank + 1 when the window qualifies, else 0), then each window compares its own key
//   with the max. window-manager.ts scans ranks from the top instead (emitFrontmost);
// - the selected window's rank is a sum of selected × rank, and each window computes its next rank
//   bits from its own rank and that shared rank, with the same products as raiseToFront;
// - Photos' thumbnail targets come from each thumbnail comparing its own index with the focused
//   index: the cyclic offset, distance and spread are integer tables read by per-item equality
//   bits. photo-gallery.ts writes them as build-time weights over all 12 focus bits;
// - Photos' click priority (previous, next, a thumbnail, the main image) is a first active over the
//   thumbnails plus a shared stage for the fixed order around it; the neighbor reads for previous
//   and next are gathers at per-instance constant indices.
import {emitMaximum, emitMinimum, emitMultiply, emitRelu, emitSelect, emitSpring, type Circuit, type Terms, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {createExecutor} from './executor.ts'
import {emitAnd, emitGather} from './kit.ts'
import {StagedProgram, type Value} from './staged.ts'

export const windowCount = 4
export const photoCount = 12
const photoColumns = 4
const photoRows = 3
const any = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] as const
const pixel = [0, 16_384] as const
const smallPixel = [0, 1024] as const
const nonNegative = [0, Number.POSITIVE_INFINITY] as const
const unitInterval = [0, 1] as const
export const animationFields = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
type AnimationField = typeof animationFields[number]
type Geometry = {left: Wire, top: Wire, width: Wire, height: Wire}

// window-manager.ts's private helpers, copied.
function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}
const emitClampDynamic = (circuit: Circuit, value: Wire, minimum: Wire, maximum: Wire) => emitMinimum(circuit, emitMaximum(circuit, value, minimum), maximum)
const emitComplement = (circuit: Circuit, value: Wire, unit: Wire) => circuit.affine([[unit, 1], [value, -1]])
function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire) {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(circuit, circuit.affine([[position, 1], [start, -1]]), circuit.affine([[end, 1], [position, -1]]))
}
function emitRectangleHit(circuit: Circuit, x: Wire, y: Wire, geometry: Geometry, unit: Wire) {
  const score = emitClampZeroOne(circuit, emitMinimum(circuit, emitIntervalDistance(circuit, x, geometry.left, geometry.width), emitIntervalDistance(circuit, y, geometry.top, geometry.height)), unit)
  return circuit.boolean(score)
}
// photo-gallery.ts's private helpers, copied.
function photoClampZeroOne(circuit: Circuit, value: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}
const photoIntervalHit = (circuit: Circuit, position: Wire, start: Wire, size: Wire) => circuit.boolean(photoClampZeroOne(circuit, emitIntervalDistance(circuit, position, start, size)))
const photoRectangleHit = (circuit: Circuit, x: Wire, y: Wire, geometry: Geometry) => emitMinimum(circuit, photoIntervalHit(circuit, x, geometry.left, geometry.width), photoIntervalHit(circuit, y, geometry.top, geometry.height))

// Integer comparisons on an integer affine form, from ramps relu(value + offset).
const ramp = (circuit: Circuit, terms: Terms, offset: number) => circuit.reglu([], 1, terms, offset)
function integerEqual(circuit: Circuit, terms: Terms, target: number) {
  const bit = circuit.affine([[ramp(circuit, terms, 1 - target), 1], [ramp(circuit, terms, -target), -2], [ramp(circuit, terms, -1 - target), 1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}
function integerAtLeast(circuit: Circuit, terms: Terms, target: number) {
  const bit = circuit.affine([[ramp(circuit, terms, 1 - target), 1], [ramp(circuit, terms, -target), -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}
// [key = maximum and maximum >= 1], for integer keys.
function isFrontmost(circuit: Circuit, key: Wire, maximum: Wire) {
  const bit = circuit.reglu([], 1, [[integerEqual(circuit, [[key, 1], [maximum, -1]], 0), 1], [integerAtLeast(circuit, [[maximum, 1]], 1), 1]], -1)
  circuit.assumeRange(bit, 0, 1)
  return bit
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

type ThumbnailInputs = {index: Wire, focusIndex: Wire, focusMass: Wire, viewportX: Wire, baseSize: Wire, gap: Wire}
// photo-gallery.ts projectThumbnailTargets for one thumbnail, from the focused index instead of
// the focus bits. d = index - focus, wrapped like cyclicOffset into -6..6.
function thumbnailTarget(circuit: Circuit, input: ThumbnailInputs) {
  const wrapDown = integerAtLeast(circuit, [[input.index, 1], [input.focusIndex, -1]], 7)
  const wrapUp = integerAtLeast(circuit, [[input.index, -1], [input.focusIndex, 1]], 7)
  const offset = circuit.affine([[input.index, 1], [input.focusIndex, -1], [wrapDown, -12], [wrapUp, 12]])
  circuit.assumeRange(offset, -6, 6)
  const offsetIs = new Map<number, Wire>()
  for (let value = -6; value <= 6; value++) offsetIs.set(value, integerEqual(circuit, [[offset, 1]], value))
  const lookup = (table: (value: number) => number) => {
    const terms: [Wire, number][] = []
    for (const [value, bit] of offsetIs) if (table(value) !== 0) terms.push([bit, table(value)])
    return circuit.affine(terms)
  }
  const visible = (value: number) => Math.abs(value) < 5 ? value : 0
  const gated = (value: Wire) => emitMultiply(circuit, input.focusMass, value)
  const visibleOffset = gated(lookup(visible))
  const distance = gated(lookup(Math.abs))
  const spread = gated(lookup(value => Math.sign(visible(value)) * spreadAt(Math.abs(visible(value)))))
  const scale = emitRelu(circuit, circuit.affine([[input.focusMass, 1], [distance, -0.22]]))
  const centerX = circuit.affine([[input.viewportX, 0.5], [emitMultiply(circuit, input.baseSize, spread), 1], [emitMultiply(circuit, input.gap, visibleOffset), 1]])
  return {centerX, scale}
}
function projectThumbnail(circuit: Circuit, centerX: Wire, scale: Wire, present: Wire, baseSize: Wire, centerY: Wire) {
  const visibleScale = emitMultiply(circuit, present, scale)
  const size = emitMultiply(circuit, baseSize, visibleScale)
  return {
    left: circuit.affine([[centerX, 1], [size, -0.5]]),
    top: emitRelu(circuit, circuit.affine([[centerY, 1], [size, -0.5]])),
    width: size,
    height: size,
    opacity: visibleScale,
  }
}

export function buildStagedHandwiredOS(options: {rebuildSmallAffines?: boolean | undefined} = {}) {
  const program = new StagedProgram(options)
  const cell = (name: string, [minimum, maximum]: readonly [number, number]) => program.sharedCell(name, minimum, maximum)
  const shared = {
    viewportWidth: cell('viewportWidth', pixel), viewportHeight: cell('viewportHeight', pixel), unit: cell('unit', [1, 1]),
    margin: cell('margin', smallPixel), titleHeight: cell('titleHeight', smallPixel), minWidth: cell('minWidth', smallPixel), minHeight: cell('minHeight', smallPixel),
    resizeGrip: cell('resizeGrip', smallPixel), buttonSize: cell('buttonSize', smallPixel), buttonGap: cell('buttonGap', smallPixel),
    dockHeight: cell('dockHeight', smallPixel), dockGap: cell('dockGap', smallPixel), dockItemWidth: cell('dockItemWidth', smallPixel),
    downActive: cell('downActive', unitInterval), downX: cell('downX', any), downY: cell('downY', any),
    moveActive: cell('moveActive', unitInterval), moveX: cell('moveX', any), moveY: cell('moveY', any),
    upActive: cell('upActive', unitInterval), upX: cell('upX', any), upY: cell('upY', any),
    pointerX: cell('pointerX', any), pointerY: cell('pointerY', any), systemBarHeight: cell('systemBarHeight', smallPixel),
    frameTime: cell('frameTime', nonNegative), previousFrameTime: cell('previousFrameTime', nonNegative), timeInitialized: cell('timeInitialized', unitInterval),
    springStiffness: cell('springStiffness', nonNegative), springDamping: cell('springDamping', nonNegative), springMaxFrameDuration: cell('springMaxFrameDuration', nonNegative),
    springSettleDistance: cell('springSettleDistance', nonNegative), springSettleSpeed: cell('springSettleSpeed', nonNegative),
    springSettleDistanceScale: cell('springSettleDistanceScale', nonNegative), springSettleSpeedScale: cell('springSettleSpeedScale', nonNegative),
    photoGap: cell('photoGap', smallPixel), mainInset: cell('mainInset', smallPixel), thumbnailHeight: cell('thumbnailHeight', smallPixel), controlSize: cell('controlSize', smallPixel),
    clickActive: cell('clickActive', unitInterval), clickX: cell('clickX', any), clickY: cell('clickY', any),
    previousActive: cell('previousActive', unitInterval), nextActive: cell('nextActive', unitInterval), closeActive: cell('closeActive', unitInterval),
  }
  const windows = program.array('windows', windowCount)
  const windowCell = (name: string, [minimum, maximum]: readonly [number, number]) => windows.cell(name, minimum, maximum)
  const window = {
    left: windowCell('left', pixel), top: windowCell('top', pixel), width: windowCell('width', pixel), height: windowCell('height', pixel),
    open: windowCell('open', unitInterval), minimized: windowCell('minimized', unitInterval), maximized: windowCell('maximized', unitInterval), present: windowCell('present', unitInterval),
    drag: windowCell('drag', unitInterval), resize: windowCell('resize', unitInterval),
    ranks: [0, 1, 2, 3].map(rank => windowCell(`rank ${rank}`, unitInterval)),
    springs: Object.fromEntries(animationFields.map(field => [field, {
      position: windowCell(`${field} position`, field === 'scale' ? unitInterval : any),
      velocity: windowCell(`${field} velocity`, any),
    }])) as Record<AnimationField, {position: Value, velocity: Value}>,
  }
  const windowIndex = windows.constant('index', [0, 1, 2, 3])
  const dock = program.array('dock items', windowCount)
  const dockIndex = dock.constant('index', [0, 1, 2, 3])
  const photos = program.array('photos', photoCount)
  const photo = {
    focus: photos.cell('focus', 0, 1),
    centerX: photos.cell('thumbnail centerX', ...pixel), centerXVelocity: photos.cell('thumbnail centerX velocity', ...any),
    scale: photos.cell('thumbnail scale', 0, 1), scaleVelocity: photos.cell('thumbnail scale velocity', ...any),
  }
  const photoIndex = photos.constant('index', Array.from({length: photoCount}, (_, item) => item))
  const columnBits = [0, 1, 2, 3].map(column => photos.constant(`column ${column}`, Array.from({length: photoCount}, (_, item) => item % photoColumns === column ? 1 : 0), {minimum: 0, maximum: 1}))
  const rowBits = [0, 1, 2].map(row => photos.constant(`row ${row}`, Array.from({length: photoCount}, (_, item) => Math.floor(item / photoColumns) === row ? 1 : 0), {minimum: 0, maximum: 1}))
  const nextNeighbor = photos.constant('next neighbor', Array.from({length: photoCount}, (_, item) => (item + 1) % photoCount))
  const previousNeighbor = photos.constant('previous neighbor', Array.from({length: photoCount}, (_, item) => (item + photoCount - 1) % photoCount))
  const springParameters = {
    stiffness: shared.springStiffness, damping: shared.springDamping, settleDistance: shared.springSettleDistance, settleSpeed: shared.springSettleSpeed,
    settleDistanceScale: shared.springSettleDistanceScale, settleSpeedScale: shared.springSettleSpeedScale,
  }

  // === timestep, workspace, maximized geometry, dock layout, pointer latches
  const workspace = program.shared('workspace, dock layout, pointer', shared, (circuit, input) => {
    const zero = circuit.affine([])
    const frameDuration = emitMultiply(circuit, input.timeInitialized, emitClampDynamic(circuit, circuit.affine([[input.frameTime, 1], [input.previousFrameTime, -1]]), zero, input.springMaxFrameDuration))
    const springTimestep = circuit.affine([[frameDuration, 0.001 / 4]])
    const effectiveDockHeight = emitMinimum(circuit, input.dockHeight, input.viewportHeight)
    const dockTop = circuit.affine([[input.viewportHeight, 1], [effectiveDockHeight, -1]])
    const workspaceTop = emitMinimum(circuit, input.systemBarHeight, dockTop)
    const workspaceHeight = circuit.affine([[dockTop, 1], [workspaceTop, -1]])
    const maximumLeft = emitMinimum(circuit, input.margin, circuit.affine([[input.viewportWidth, 0.5]]))
    const maximumTopInset = emitMinimum(circuit, input.margin, circuit.affine([[workspaceHeight, 0.5]]))
    const maximum = {
      left: maximumLeft,
      top: circuit.affine([[workspaceTop, 1], [maximumTopInset, 1]]),
      width: emitRelu(circuit, circuit.affine([[input.viewportWidth, 1], [maximumLeft, -2]])),
      height: emitRelu(circuit, circuit.affine([[workspaceHeight, 1], [maximumTopInset, -2]])),
    }
    const dockGap = emitMinimum(circuit, input.dockGap, emitMinimum(circuit, circuit.affine([[input.viewportWidth, 1 / (windowCount - 1)]]), circuit.affine([[effectiveDockHeight, 0.5]])))
    const dockHorizontalSpace = emitRelu(circuit, circuit.affine([[input.viewportWidth, 1], [dockGap, -(windowCount - 1)]]))
    const dockVerticalSpace = emitRelu(circuit, circuit.affine([[effectiveDockHeight, 1], [dockGap, -2]]))
    const dockItemSize = emitMinimum(circuit, input.dockItemWidth, emitMinimum(circuit, circuit.affine([[dockHorizontalSpace, 1 / windowCount]]), dockVerticalSpace))
    const dockTotalWidth = circuit.affine([[dockItemSize, windowCount], [dockGap, windowCount - 1]])
    const dockLeft = circuit.affine([[input.viewportWidth, 0.5], [dockTotalWidth, -0.5]])
    const dockItemTop = circuit.affine([[dockTop, 1], [effectiveDockHeight, 0.5], [dockItemSize, -0.5]])
    const baselineX = emitSelect(circuit, input.downActive, input.pointerX, input.downX)
    const baselineY = emitSelect(circuit, input.downActive, input.pointerY, input.downY)
    const movedX = emitSelect(circuit, input.moveActive, baselineX, input.moveX)
    const movedY = emitSelect(circuit, input.moveActive, baselineY, input.moveY)
    const pointerX = emitSelect(circuit, input.upActive, movedX, input.upX)
    const pointerY = emitSelect(circuit, input.upActive, movedY, input.upY)
    return {
      zero, springTimestep, dockTop, workspaceTop, workspaceHeight, maximum,
      dockGap, dockItemSize, dockLeft, dockItemTop,
      pointerX, pointerY,
      deltaX: circuit.affine([[pointerX, 1], [baselineX, -1]]),
      deltaY: circuit.affine([[pointerY, 1], [baselineY, -1]]),
      pointerStillDown: emitComplement(circuit, input.upActive, input.unit),
      minWidthLimit: emitMinimum(circuit, input.minWidth, input.viewportWidth),
      minHeightLimit: emitMinimum(circuit, input.minHeight, workspaceHeight),
      windowBorderSpan: circuit.affine([[input.unit, 2]]),
    }
  })

  // === what a press hits on each window (window-manager.ts:463-582)
  const hits = program.map(windows, 'window hits', {
    left: window.left, top: window.top, width: window.width, height: window.height, open: window.open, minimized: window.minimized, maximized: window.maximized,
    ranks: window.ranks, maximum: workspace.maximum, downX: shared.downX, downY: shared.downY, unit: shared.unit,
    titleHeight: shared.titleHeight, buttonSize: shared.buttonSize, buttonGap: shared.buttonGap, resizeGrip: shared.resizeGrip,
  }, (circuit, input) => {
    circuit.assumeOneHot(input.ranks)
    const visible = emitMultiply(circuit, input.open, emitComplement(circuit, input.minimized, input.unit))
    const geometry = {
      left: emitSelect(circuit, input.maximized, input.left, input.maximum.left),
      top: emitSelect(circuit, input.maximized, input.top, input.maximum.top),
      width: emitSelect(circuit, input.maximized, input.width, input.maximum.width),
      height: emitSelect(circuit, input.maximized, input.height, input.maximum.height),
    }
    const windowHit = emitMultiply(circuit, visible, emitRectangleHit(circuit, input.downX, input.downY, geometry, input.unit))
    const buttonTop = circuit.affine([[geometry.top, 1], [input.titleHeight, 0.5], [input.buttonSize, -0.5]])
    const closeLeft = circuit.affine([[geometry.left, 1], [geometry.width, 1], [input.buttonGap, -1], [input.buttonSize, -1]])
    const maximizeLeft = circuit.affine([[closeLeft, 1], [input.buttonGap, -1], [input.buttonSize, -1]])
    const minimizeLeft = circuit.affine([[maximizeLeft, 1], [input.buttonGap, -1], [input.buttonSize, -1]])
    const buttonHitInset = circuit.affine([[input.buttonGap, 0.5]])
    const buttonHitSize = circuit.affine([[input.buttonSize, 1], [input.buttonGap, 1]])
    const buttonHit = (left: Wire) => emitRectangleHit(circuit, input.downX, input.downY, {
      left: circuit.affine([[left, 1], [buttonHitInset, -1]]), top: circuit.affine([[buttonTop, 1], [buttonHitInset, -1]]), width: buttonHitSize, height: buttonHitSize,
    }, input.unit)
    const closeHit = buttonHit(closeLeft)
    const maximizeHit = buttonHit(maximizeLeft)
    const minimizeHit = buttonHit(minimizeLeft)
    const dragHit = emitRectangleHit(circuit, input.downX, input.downY, {
      left: geometry.left, top: geometry.top, width: emitRelu(circuit, circuit.affine([[minimizeLeft, 1], [input.buttonGap, -1], [geometry.left, -1]])), height: input.titleHeight,
    }, input.unit)
    const resizeHit = emitRectangleHit(circuit, input.downX, input.downY, {
      left: circuit.affine([[geometry.left, 1], [geometry.width, 1], [input.resizeGrip, -1]]),
      top: circuit.affine([[geometry.top, 1], [geometry.height, 1], [input.resizeGrip, -1]]),
      width: input.resizeGrip, height: input.resizeGrip,
    }, input.unit)
    const rankValue = circuit.affine(input.ranks.map((bit, rank) => [bit, rank] as const))
    circuit.assumeRange(rankValue, 0, windowCount - 1)
    return {closeHit, maximizeHit, minimizeHit, dragHit, resizeHit, rankValue, pressKey: emitMultiply(circuit, windowHit, circuit.affine([[rankValue, 1]], 1))}
  })
  const frontPressKey = program.max(hits.pressKey, 'frontmost press key')

  // === dock items (window-manager.ts:589-649)
  const dockItems = program.map(dock, 'dock items', {
    dockLeft: workspace.dockLeft, dockItemSize: workspace.dockItemSize, dockGap: workspace.dockGap, dockItemTop: workspace.dockItemTop,
    downX: shared.downX, downY: shared.downY, unit: shared.unit, index: dockIndex,
  }, (circuit, input) => {
    const left = circuit.affine([[input.dockLeft, 1], [emitMultiply(circuit, input.dockItemSize, input.index), 1], [emitMultiply(circuit, input.dockGap, input.index), 1]])
    return {left, hit: emitRectangleHit(circuit, input.downX, input.downY, {left, top: input.dockItemTop, width: input.dockItemSize, height: input.dockItemSize}, input.unit)}
  })
  const dockForWindow = program.gatherIndexed({left: dockItems.left, hit: dockItems.hit}, windows, windowIndex, 'dock item of each window')

  // === presses, drag and resize geometry, flags (window-manager.ts:651-808)
  const updated = program.map(windows, 'presses and geometry', {
    downActive: shared.downActive, frontPressKey, pressKey: hits.pressKey, dockHit: dockForWindow.hit,
    closeHit: hits.closeHit, minimizeHit: hits.minimizeHit, maximizeHit: hits.maximizeHit, dragHit: hits.dragHit, resizeHit: hits.resizeHit,
    rankValue: hits.rankValue, left: window.left, top: window.top, width: window.width, height: window.height,
    open: window.open, minimized: window.minimized, maximized: window.maximized, drag: window.drag, resize: window.resize,
    unit: shared.unit, zero: workspace.zero, pointerStillDown: workspace.pointerStillDown, deltaX: workspace.deltaX, deltaY: workspace.deltaY,
    minWidthLimit: workspace.minWidthLimit, minHeightLimit: workspace.minHeightLimit, viewportWidth: shared.viewportWidth,
    workspaceHeight: workspace.workspaceHeight, dockTop: workspace.dockTop, workspaceTop: workspace.workspaceTop,
  }, (circuit, input) => {
    const canvas = emitMultiply(circuit, input.downActive, isFrontmost(circuit, input.pressKey, input.frontPressKey))
    const dockPress = emitMultiply(circuit, input.downActive, input.dockHit)
    const selected = emitClampZeroOne(circuit, circuit.affine([[canvas, 1], [dockPress, 1]]), input.unit)
    const closePress = emitMultiply(circuit, canvas, input.closeHit)
    const minimizePress = emitMultiply(circuit, canvas, input.minimizeHit)
    const maximizePress = emitMultiply(circuit, canvas, input.maximizeHit)
    const normalWindow = emitComplement(circuit, input.maximized, input.unit)
    const dragPress = emitMultiply(circuit, emitMultiply(circuit, canvas, input.dragHit), normalWindow)
    const resizePress = emitMultiply(circuit, emitMultiply(circuit, canvas, input.resizeHit), normalWindow)
    const dragForMotion = emitSelect(circuit, input.downActive, input.drag, dragPress)
    const resizeForMotion = emitSelect(circuit, input.downActive, input.resize, resizePress)
    const width = emitClampDynamic(circuit, circuit.affine([[input.width, 1], [emitMultiply(circuit, resizeForMotion, input.deltaX), 1]]), input.minWidthLimit, input.viewportWidth)
    const height = emitClampDynamic(circuit, circuit.affine([[input.height, 1], [emitMultiply(circuit, resizeForMotion, input.deltaY), 1]]), input.minHeightLimit, input.workspaceHeight)
    const maximumLeft = emitRelu(circuit, circuit.affine([[input.viewportWidth, 1], [width, -1]]))
    const maximumTop = emitRelu(circuit, circuit.affine([[input.dockTop, 1], [height, -1]]))
    const left = emitClampDynamic(circuit, circuit.affine([[input.left, 1], [emitMultiply(circuit, dragForMotion, input.deltaX), 1]]), input.zero, maximumLeft)
    const top = emitClampDynamic(circuit, circuit.affine([[input.top, 1], [emitMultiply(circuit, dragForMotion, input.deltaY), 1]]), input.workspaceTop, maximumTop)
    const afterClose = emitSelect(circuit, closePress, input.open, input.zero)
    const open = emitSelect(circuit, dockPress, afterClose, input.unit)
    const afterMinimize = emitSelect(circuit, minimizePress, input.minimized, input.unit)
    const afterDock = emitSelect(circuit, dockPress, afterMinimize, input.zero)
    const minimized = emitSelect(circuit, closePress, afterDock, input.zero)
    const toggledMaximized = circuit.affine([[input.maximized, 1], [emitMultiply(circuit, maximizePress, circuit.affine([[input.unit, 1], [input.maximized, -2]])), 1]])
    const maximized = emitSelect(circuit, closePress, toggledMaximized, input.zero)
    return {
      selected, selectedRank: emitMultiply(circuit, selected, input.rankValue),
      nextDrag: emitMultiply(circuit, dragForMotion, input.pointerStillDown), nextResize: emitMultiply(circuit, resizeForMotion, input.pointerStillDown),
      direct: emitClampZeroOne(circuit, circuit.affine([[dragForMotion, 1], [resizeForMotion, 1]]), input.unit),
      normal: {left, top, width, height}, open, minimized, maximized,
    }
  })
  const selectionCount = program.sum(updated.selected, 'selection mass', {minimum: 0, maximum: windowCount})
  const selectedRankSum = program.sum(updated.selectedRank, 'selected rank', {minimum: 0, maximum: windowCount * (windowCount - 1)})
  const selection = program.shared('selection', {selectionCount, selectedRankSum, unit: shared.unit}, (circuit, input) => {
    const mass = emitClampZeroOne(circuit, input.selectionCount, input.unit)
    return {
      inactive: emitComplement(circuit, mass, input.unit),
      rankIs: [0, 1, 2, 3].map(rank => emitAnd(circuit, [integerEqual(circuit, [[input.selectedRankSum, 1]], rank), mass])),
    }
  })

  // === raise the selected window to the front; next visibility and geometry (window-manager.ts:810-877)
  const stacked = program.map(windows, 'next stack and visibility', {
    ranks: window.ranks, inactive: selection.inactive, rankIs: selection.rankIs, selected: updated.selected,
    open: updated.open, minimized: updated.minimized, maximized: updated.maximized, normal: updated.normal, maximum: workspace.maximum, unit: shared.unit,
  }, (circuit, input) => {
    const nextRanks = [0, 1, 2, 3].map(rank => {
      const moved = rank === windowCount - 1
        ? input.selected
        : circuit.affine(input.rankIs.map((bitAtRank, from) => [emitMultiply(circuit, bitAtRank, input.ranks[rank < from ? rank : rank + 1]!), 1] as const))
      return circuit.affine([[emitMultiply(circuit, input.inactive, input.ranks[rank]!), 1], [moved, 1]])
    })
    const nextVisible = emitMultiply(circuit, input.open, emitComplement(circuit, input.minimized, input.unit))
    const box = {
      left: emitSelect(circuit, input.maximized, input.normal.left, input.maximum.left),
      top: emitSelect(circuit, input.maximized, input.normal.top, input.maximum.top),
      width: emitSelect(circuit, input.maximized, input.normal.width, input.maximum.width),
      height: emitSelect(circuit, input.maximized, input.normal.height, input.maximum.height),
    }
    const nextRankValue = circuit.affine(nextRanks.map((bit, rank) => [bit, rank] as const))
    circuit.assumeRange(nextRankValue, 0, windowCount - 1)
    return {nextRanks, nextVisible, box, focusKey: emitMultiply(circuit, nextVisible, circuit.affine([[nextRankValue, 1]], 1))}
  })
  const frontFocusKey = program.max(stacked.focusKey, 'frontmost visible key')

  // === springs and projection (window-manager.ts:878-1089)
  const animated = program.map(windows, 'window springs and projection', {
    box: stacked.box, dockLeft: dockForWindow.left, dockItemSize: workspace.dockItemSize, dockItemTop: workspace.dockItemTop,
    nextVisible: stacked.nextVisible, nextRanks: stacked.nextRanks, focusKey: stacked.focusKey, frontFocusKey,
    present: window.present, direct: updated.direct, springs: window.springs, parameters: springParameters, timestep: workspace.springTimestep,
    unit: shared.unit, zero: workspace.zero, viewportWidth: shared.viewportWidth, viewportHeight: shared.viewportHeight,
    titleHeight: shared.titleHeight, borderSpan: workspace.windowBorderSpan,
  }, (circuit, input) => {
    const target: Record<AnimationField, Wire> = {
      centerX: emitSelect(circuit, input.nextVisible, circuit.affine([[input.dockLeft, 1], [input.dockItemSize, 0.5]]), circuit.affine([[input.box.left, 1], [input.box.width, 0.5]])),
      centerY: emitSelect(circuit, input.nextVisible, circuit.affine([[input.dockItemTop, 1], [input.dockItemSize, 0.5]]), circuit.affine([[input.box.top, 1], [input.box.height, 0.5]])),
      width: input.box.width,
      height: input.box.height,
      scale: input.nextVisible,
    }
    const hiddenAndAbsent = emitMultiply(circuit, emitComplement(circuit, input.present, input.unit), emitComplement(circuit, input.nextVisible, input.unit))
    const direct = emitClampZeroOne(circuit, circuit.affine([[input.direct, 1], [hiddenAndAbsent, 1]]), input.unit)
    const p = input.parameters
    const lanes = Object.fromEntries(animationFields.map(field => {
      const stepped = emitSpring(circuit, input.springs[field].position, target[field], input.springs[field].velocity, p.stiffness, p.damping, input.timestep, p.settleDistance, p.settleSpeed, p.settleDistanceScale, p.settleSpeedScale, input.unit)
      const position = field === 'scale' ? emitClampDynamic(circuit, stepped.position, input.zero, input.unit) : stepped.position
      return [field, {
        position: emitSelect(circuit, direct, position, target[field]),
        velocity: emitSelect(circuit, direct, stepped.velocity, input.zero),
        active: emitMultiply(circuit, emitComplement(circuit, direct, input.unit), stepped.active),
      }]
    })) as Record<AnimationField, {position: Wire, velocity: Wire, active: Wire}>
    const width = emitClampDynamic(circuit, lanes.width.position, input.zero, input.viewportWidth)
    const height = emitClampDynamic(circuit, lanes.height.position, input.zero, input.viewportHeight)
    const halfWidth = circuit.affine([[width, 0.5]])
    const halfHeight = circuit.affine([[height, 0.5]])
    const scaledHalfWidth = emitMultiply(circuit, halfWidth, lanes.scale.position)
    const scaledHalfHeight = emitMultiply(circuit, halfHeight, lanes.scale.position)
    const centerX = emitClampDynamic(circuit, lanes.centerX.position, scaledHalfWidth, circuit.affine([[input.viewportWidth, 1], [scaledHalfWidth, -1]]))
    const centerY = emitClampDynamic(circuit, lanes.centerY.position, scaledHalfHeight, circuit.affine([[input.viewportHeight, 1], [scaledHalfHeight, -1]]))
    const active = emitClampZeroOne(circuit, circuit.affine(animationFields.map(field => [lanes[field].active, 1] as const)), input.unit)
    const nextPresent = emitClampZeroOne(circuit, circuit.affine([[input.nextVisible, 1], [emitMultiply(circuit, input.present, active), 1]]), input.unit)
    const focused = isFrontmost(circuit, input.focusKey, input.frontFocusKey)
    return {
      lanes: Object.fromEntries(animationFields.map(field => [field, {position: lanes[field].position, velocity: lanes[field].velocity}])) as Record<AnimationField, {position: Wire, velocity: Wire}>,
      active, nextPresent,
      output: {
        translateX: circuit.affine([[centerX, 1], [halfWidth, -1]]),
        translateY: circuit.affine([[centerY, 1], [halfHeight, -1]]),
        width, height, scale: lanes.scale.position, opacity: nextPresent, focused,
        stack: circuit.affine([...input.nextRanks.map((bit, rank) => [bit, rank + 1] as const), [active, 40]]),
        contentWidth: emitRelu(circuit, circuit.affine([[width, 1], [input.borderSpan, -1]])),
        contentHeight: emitRelu(circuit, circuit.affine([[height, 1], [input.titleHeight, -1], [input.borderSpan, -1]])),
      },
      dockInactive: emitComplement(circuit, input.nextVisible, input.unit),
    }
  })
  const windowActiveCount = program.sum(animated.active, 'active windows', {minimum: 0, maximum: windowCount})

  // === Photos, inlined in window 3 (window-manager.ts:1091-1167, photo-gallery.ts)
  const photosWindow = program.shared('Photos window index', {}, circuit => ({index: circuit.affine([], windowCount - 1)}))
  const photoInputs = {
    viewportX: program.gatherAt(animated.output.contentWidth, photosWindow.index, 'Photos content width'),
    viewportY: program.gatherAt(animated.output.contentHeight, photosWindow.index, 'Photos content height'),
    present: program.gatherAt(animated.output.opacity, photosWindow.index, 'Photos opacity'),
    interactive: program.gatherAt(animated.output.focused, photosWindow.index, 'Photos focused'),
  }
  const previousFocus = program.firstActive(photo.focus, shared.unit, 'previous focus')
  const layout = program.shared('Photos layout and controls', {
    ...photoInputs, gap: shared.photoGap, mainInset: shared.mainInset, thumbnailHeight: shared.thumbnailHeight, controlSize: shared.controlSize,
    clickX: shared.clickX, clickY: shared.clickY, events: [shared.clickActive, shared.previousActive, shared.nextActive, shared.closeActive],
    previousFocusMass: previousFocus.present,
  }, (circuit, input) => {
    // The host's wires honor the ranges Photos assumes (photo-gallery.ts:150-176).
    circuit.assumeRange(input.viewportX, ...pixel)
    circuit.assumeRange(input.viewportY, ...pixel)
    circuit.assumeRange(input.present, 0, 1)
    circuit.assumeRange(input.interactive, 0, 1)
    const gridWidth = emitRelu(circuit, circuit.affine([[input.viewportX, 1 / photoColumns], [input.gap, -(photoColumns + 1) / photoColumns]]))
    const gridHeight = emitRelu(circuit, circuit.affine([[input.viewportY, 1 / photoRows], [input.gap, -(photoRows + 1) / photoRows]]))
    const gridLeft = [0, 1, 2, 3].map(column => circuit.affine([[input.gap, 1 + column], [gridWidth, column]]))
    const gridTop = [0, 1, 2].map(row => circuit.affine([[input.gap, 1 + row], [gridHeight, row]]))
    const columnHit = gridLeft.map(left => photoIntervalHit(circuit, input.clickX, left, gridWidth))
    const rowHit = gridTop.map(top => photoIntervalHit(circuit, input.clickY, top, gridHeight))
    const baseSize = emitMinimum(circuit, input.thumbnailHeight, emitMinimum(circuit, circuit.affine([[input.viewportX, 1 / 6]]), circuit.affine([[input.viewportY, 0.24]])))
    const mainInset = emitMinimum(circuit, input.mainInset, circuit.affine([[input.viewportX, 0.08]]))
    const main = {
      left: mainInset, top: input.gap,
      width: emitRelu(circuit, circuit.affine([[input.viewportX, 1], [mainInset, -2]])),
      height: emitRelu(circuit, circuit.affine([[input.viewportY, 1], [baseSize, -1], [input.gap, -3]])),
    }
    const mainHit = photoRectangleHit(circuit, input.clickX, input.clickY, main)
    const previousGridMass = circuit.affine([[input.previousFocusMass, -1]], 1)
    const outerInset = emitMinimum(circuit, input.gap, circuit.affine([[input.viewportX, 0.5]]))
    const imageSpan = circuit.affine([[baseSize, falloffMass()]])
    const thumbnailGap = emitMinimum(circuit, circuit.affine([], 12), emitRelu(circuit, circuit.affine([[input.viewportX, 1 / 8], [outerInset, -2 / 8], [imageSpan, -1 / 8]])))
    const thumbnailCenterY = circuit.affine([[input.viewportY, 1], [input.gap, -1], [baseSize, -0.5]])
    const controlTop = emitRelu(circuit, circuit.affine([[input.gap, 1], [main.height, 0.5], [input.controlSize, -0.5]]))
    const controlInset = circuit.affine([[input.gap, 0.5]])
    const previousControl = {left: controlInset, top: controlTop, width: input.controlSize, height: input.controlSize}
    const nextControl = {left: emitRelu(circuit, circuit.affine([[input.viewportX, 1], [controlInset, -1], [input.controlSize, -1]])), top: controlTop, width: input.controlSize, height: input.controlSize}
    const controlVerticalHit = photoIntervalHit(circuit, input.clickY, controlTop, input.controlSize)
    const previousControlHit = emitMinimum(circuit, photoIntervalHit(circuit, input.clickX, previousControl.left, previousControl.width), controlVerticalHit)
    const nextControlHit = emitMinimum(circuit, photoIntervalHit(circuit, input.clickX, nextControl.left, nextControl.width), controlVerticalHit)
    const effectiveEvents = input.events.map(latch => emitMultiply(circuit, input.interactive, latch))
    const eventMass = circuit.affine(effectiveEvents.map(wire => [wire, 1] as const))
    circuit.assumeRange(eventMass, 0, 1)
    const focusedClick = emitMultiply(circuit, effectiveEvents[0]!, input.previousFocusMass)
    circuit.assumeRange(focusedClick, 0, 1)
    return {
      gridWidth, gridHeight, gridLeft, gridTop, columnHit, rowHit, baseSize, main, mainHit, thumbnailGap, thumbnailCenterY,
      previousControl, nextControl, previousControlHit, nextControlHit,
      eventInactive: circuit.affine([[eventMass, -1]], 1), previousEvent: effectiveEvents[1]!, nextEvent: effectiveEvents[2]!,
      clickGridGate: emitMultiply(circuit, effectiveEvents[0]!, previousGridMass), focusedClick,
    }
  })
  const thumbnailHits = program.map(photos, 'thumbnail and grid hits', {
    index: photoIndex, focusIndex: previousFocus.index, focusMass: previousFocus.present, viewportX: photoInputs.viewportX, present: photoInputs.present,
    baseSize: layout.baseSize, gap: layout.thumbnailGap, centerY: layout.thumbnailCenterY, clickX: shared.clickX, clickY: shared.clickY,
    columnBits, rowBits, columnHit: layout.columnHit, rowHit: layout.rowHit,
  }, (circuit, input) => {
    const target = thumbnailTarget(circuit, input)
    const box = projectThumbnail(circuit, target.centerX, target.scale, input.present, input.baseSize, input.centerY)
    circuit.assumeOneHot(input.columnBits)
    circuit.assumeOneHot(input.rowBits)
    return {
      thumbnailHit: photoRectangleHit(circuit, input.clickX, input.clickY, box),
      gridHit: emitMinimum(circuit, emitGather(circuit, input.columnBits, input.columnHit), emitGather(circuit, input.rowBits, input.rowHit)),
    }
  })
  const thumbnailClickCandidate = program.firstActive(thumbnailHits.thumbnailHit, shared.unit, 'first thumbnail under the click')
  // In the lightbox, one click picks previous, next, a thumbnail, or the main image, in that order.
  const clicks = program.shared('Photos click priority', {
    focusedClick: layout.focusedClick, previousControlHit: layout.previousControlHit, nextControlHit: layout.nextControlHit,
    thumbnailPresent: thumbnailClickCandidate.present, mainHit: layout.mainHit,
    eventInactive: layout.eventInactive, previousEvent: layout.previousEvent, nextEvent: layout.nextEvent,
  }, (circuit, input) => {
    const previousControlClick = emitAnd(circuit, [input.focusedClick, input.previousControlHit])
    const nextControlClick = emitAnd(circuit, [input.focusedClick, input.nextControlHit], [input.previousControlHit])
    const thumbnailClick = emitAnd(circuit, [input.focusedClick, input.thumbnailPresent], [input.previousControlHit, input.nextControlHit])
    const mainClick = emitAnd(circuit, [input.focusedClick, input.mainHit], [input.previousControlHit, input.nextControlHit, input.thumbnailPresent])
    return {
      thumbnailClick,
      keepFocusGate: circuit.affine([[input.eventInactive, 1], [mainClick, 1]]),
      previousGate: circuit.affine([[input.previousEvent, 1], [previousControlClick, 1]]),
      nextGate: circuit.affine([[input.nextEvent, 1], [nextControlClick, 1]]),
    }
  })
  const thumbnailClick = program.scatter(photos, thumbnailClickCandidate.index, 'thumbnail click', {present: clicks.thumbnailClick})
  const focusAfter = program.gatherIndexed({focus: photo.focus}, photos, nextNeighbor, 'focus of the next photo')
  const focusBefore = program.gatherIndexed({focus: photo.focus}, photos, previousNeighbor, 'focus of the previous photo')
  const nextFocus = program.map(photos, 'next focus', {
    focus: photo.focus, gridHit: thumbnailHits.gridHit, thumbnailClick, focusAfter: focusAfter.focus, focusBefore: focusBefore.focus,
    keepFocusGate: clicks.keepFocusGate, clickGridGate: layout.clickGridGate, previousGate: clicks.previousGate, nextGate: clicks.nextGate,
  }, (circuit, input) => ({
    focus: circuit.affine([
      [emitMultiply(circuit, input.keepFocusGate, input.focus), 1],
      [emitMultiply(circuit, input.clickGridGate, input.gridHit), 1],
      [input.thumbnailClick, 1],
      [emitMultiply(circuit, input.previousGate, input.focusAfter), 1],
      [emitMultiply(circuit, input.nextGate, input.focusBefore), 1],
    ]),
  }))
  const newFocus = program.firstActive(nextFocus.focus, shared.unit, 'new focus')
  const shown = program.shared('Photos grid shown', {
    nextFocusMass: newFocus.present, previousFocusMass: previousFocus.present, present: photoInputs.present,
    gridLeft: layout.gridLeft, gridTop: layout.gridTop, gridWidth: layout.gridWidth, gridHeight: layout.gridHeight,
  }, (circuit, input) => {
    const nextGridMass = circuit.affine([[input.nextFocusMass, -1]], 1)
    const animateThumbnails = emitMultiply(circuit, input.previousFocusMass, input.nextFocusMass)
    return {
      nextGridMass,
      gridLeftShown: input.gridLeft.map(left => emitMultiply(circuit, nextGridMass, left)),
      gridTopShown: input.gridTop.map(top => emitMultiply(circuit, nextGridMass, top)),
      gridWidthShown: emitMultiply(circuit, nextGridMass, input.gridWidth),
      gridHeightShown: emitMultiply(circuit, nextGridMass, input.gridHeight),
      animateThumbnails,
      snapThumbnails: circuit.affine([[animateThumbnails, -1]], 1),
      lightboxOpacity: emitMultiply(circuit, input.present, input.nextFocusMass),
    }
  })
  const photoBoxes = program.map(photos, 'thumbnails and photo boxes', {
    index: photoIndex, focusIndex: newFocus.index, focusMass: newFocus.present, viewportX: photoInputs.viewportX, present: photoInputs.present,
    baseSize: layout.baseSize, gap: layout.thumbnailGap, centerY: layout.thumbnailCenterY, main: layout.main,
    centerXCell: photo.centerX, centerXVelocity: photo.centerXVelocity, scaleCell: photo.scale, scaleVelocity: photo.scaleVelocity,
    parameters: springParameters, timestep: workspace.springTimestep, unit: shared.unit,
    snap: shown.snapThumbnails, animate: shown.animateThumbnails, focus: nextFocus.focus, nextGridMass: shown.nextGridMass,
    columnBits, rowBits, gridLeftShown: shown.gridLeftShown, gridTopShown: shown.gridTopShown, gridWidthShown: shown.gridWidthShown, gridHeightShown: shown.gridHeightShown,
  }, (circuit, input) => {
    circuit.assumeOneHot(input.columnBits)
    circuit.assumeOneHot(input.rowBits)
    const zero = circuit.affine([])
    const target = thumbnailTarget(circuit, input)
    const p = input.parameters
    const spring = (position: Wire, destination: Wire, velocity: Wire) => emitSpring(circuit, position, destination, velocity, p.stiffness, p.damping, input.timestep, p.settleDistance, p.settleSpeed, p.settleDistanceScale, p.settleSpeedScale, input.unit)
    const centerSpring = spring(input.centerXCell, target.centerX, input.centerXVelocity)
    const scaleSpring = spring(input.scaleCell, target.scale, input.scaleVelocity)
    const centerX = emitSelect(circuit, input.snap, emitMinimum(circuit, emitMaximum(circuit, zero, centerSpring.position), input.viewportX), target.centerX)
    const scale = emitSelect(circuit, input.snap, emitMinimum(circuit, emitMaximum(circuit, zero, scaleSpring.position), input.unit), target.scale)
    const thumbnail = projectThumbnail(circuit, centerX, scale, input.present, input.baseSize, input.centerY)
    const show = (gridValue: Wire, mainValue: Wire) => circuit.affine([[gridValue, 1], [emitMultiply(circuit, input.focus, mainValue), 1]])
    return {
      springs: {centerX, centerXVelocity: emitSelect(circuit, input.snap, centerSpring.velocity, zero), scale, scaleVelocity: emitSelect(circuit, input.snap, scaleSpring.velocity, zero)},
      thumbnail: {...thumbnail, focused: input.focus},
      photo: {
        left: show(emitGather(circuit, input.columnBits, input.gridLeftShown), input.main.left),
        top: show(emitGather(circuit, input.rowBits, input.gridTopShown), input.main.top),
        width: show(input.gridWidthShown, input.main.width),
        height: show(input.gridHeightShown, input.main.height),
        opacity: emitMultiply(circuit, input.present, circuit.affine([[input.nextGridMass, 1], [input.focus, 1]])),
        focused: input.focus,
      },
      animationTerms: circuit.affine([[emitMultiply(circuit, input.animate, centerSpring.active), 1], [emitMultiply(circuit, input.animate, scaleSpring.active), 1]]),
    }
  })
  const photoActiveCount = program.sum(photoBoxes.animationTerms, 'active thumbnail springs', {minimum: 0, maximum: 2 * photoCount})
  const activity = program.shared('animation activity', {windowActiveCount, photoActiveCount, unit: shared.unit}, (circuit, input) => ({
    animationActive: emitClampZeroOne(circuit, circuit.affine([[emitClampZeroOne(circuit, input.windowActiveCount, input.unit), 1], [photoClampZeroOne(circuit, input.photoActiveCount), 1]]), input.unit),
  }))

  const outputs = {
    windows: animated.output,
    dock: {left: dockItems.left, top: workspace.dockItemTop, width: workspace.dockItemSize, height: workspace.dockItemSize},
    dockFlags: {inactive: animated.dockInactive, focused: animated.output.focused, open: updated.open, maximized: updated.maximized},
    animationActive: activity.animationActive,
    backdropOpacity: shown.lightboxOpacity,
    photos: photoBoxes.photo,
    thumbnails: photoBoxes.thumbnail,
    previousControl: {...layout.previousControl, opacity: shown.lightboxOpacity},
    nextControl: {...layout.nextControl, opacity: shown.lightboxOpacity},
  }
  program.output(outputs)
  program.next(shared.pointerX, workspace.pointerX)
  program.next(shared.pointerY, workspace.pointerY)
  program.next(shared.previousFrameTime, shared.frameTime)
  program.next(shared.timeInitialized, shared.unit)
  program.nextStruct({left: window.left, top: window.top, width: window.width, height: window.height}, updated.normal)
  program.next(window.open, updated.open)
  program.next(window.minimized, updated.minimized)
  program.next(window.maximized, updated.maximized)
  program.next(window.present, animated.nextPresent)
  program.next(window.drag, updated.nextDrag)
  program.next(window.resize, updated.nextResize)
  window.ranks.forEach((rank, index) => program.next(rank, stacked.nextRanks[index]!))
  for (const field of animationFields) {
    program.next(window.springs[field].position, animated.lanes[field].position)
    program.next(window.springs[field].velocity, animated.lanes[field].velocity)
  }
  program.next(photo.focus, nextFocus.focus)
  program.next(photo.centerX, photoBoxes.springs.centerX)
  program.next(photo.centerXVelocity, photoBoxes.springs.centerXVelocity)
  program.next(photo.scale, photoBoxes.springs.scale)
  program.next(photo.scaleVelocity, photoBoxes.springs.scaleVelocity)
  return {program, shared, window, photo, outputs}
}

export type StagedHandwiredOS = ReturnType<typeof buildStagedHandwiredOS>

export const latchCells = ['downActive', 'moveActive', 'upActive', 'clickActive', 'previousActive', 'nextActive', 'closeActive'] as const

export function createStagedHandwiredOSMachine(options: {rebuildSmallAffines?: boolean | undefined} = {}) {
  const built = buildStagedHandwiredOS(options)
  const executor = createExecutor(built.program)
  const {shared, window, photo} = built
  const set = executor.set
  const constants: [keyof typeof shared, number][] = [
    ['unit', 1], ['margin', 12], ['titleHeight', 44], ['minWidth', 280], ['minHeight', 190], ['resizeGrip', 24], ['buttonSize', 18], ['buttonGap', 10],
    ['dockHeight', 76], ['dockGap', 12], ['dockItemWidth', 50], ['systemBarHeight', 36], ['springStiffness', 650], ['springDamping', 45],
    ['springMaxFrameDuration', 32], ['springSettleDistance', 0.01], ['springSettleSpeed', 0.01], ['springSettleDistanceScale', 100], ['springSettleSpeedScale', 100],
    ['photoGap', 18], ['mainInset', 92], ['thumbnailHeight', 82], ['controlSize', 52],
  ]
  for (const [name, value] of constants) set(shared[name], value)
  const initialGeometry = [[54, 54, 520, 340], [410, 104, 500, 366], [174, 344, 470, 300], [650, 190, 560, 430]] as const
  initialGeometry.forEach(([left, top, width, height], index) => {
    set(window.left, left, index)
    set(window.top, top, index)
    set(window.width, width, index)
    set(window.height, height, index)
    set(window.open, 1, index)
    set(window.present, 1, index)
    set(window.ranks[index]!, 1, index)
    set(window.springs.centerX.position, left + width / 2, index)
    set(window.springs.centerY.position, top + height / 2, index)
    set(window.springs.width.position, width, index)
    set(window.springs.height.position, height, index)
    set(window.springs.scale.position, 1, index)
  })
  const pointer = (active: 'downActive' | 'moveActive' | 'upActive', x: 'downX' | 'moveX' | 'upX', y: 'downY' | 'moveY' | 'upY') => (xValue: number, yValue: number) => {
    set(shared[active], 1)
    set(shared[x], xValue)
    set(shared[y], yValue)
  }
  const photoEvent = (latch: 'clickActive' | 'previousActive' | 'nextActive' | 'closeActive') => (x = executor.get(shared.clickX), y = executor.get(shared.clickY)) => {
    for (const other of ['clickActive', 'previousActive', 'nextActive', 'closeActive'] as const) set(shared[other], 0)
    set(shared[latch], 1)
    set(shared.clickX, x)
    set(shared.clickY, y)
  }
  return {
    built,
    executor,
    step(viewportWidth: number, viewportHeight: number, frameTime: number) {
      set(shared.viewportWidth, viewportWidth)
      set(shared.viewportHeight, viewportHeight)
      set(shared.frameTime, frameTime)
      executor.step()
      for (const latch of latchCells) set(shared[latch], 0)
    },
    pointerDown: pointer('downActive', 'downX', 'downY'),
    pointerMove: pointer('moveActive', 'moveX', 'moveY'),
    pointerUp: pointer('upActive', 'upX', 'upY'),
    photoClick: (x: number, y: number) => photoEvent('clickActive')(x, y),
    photoPrevious: () => photoEvent('previousActive')(),
    photoNext: () => photoEvent('nextActive')(),
    photoClose: () => photoEvent('closeActive')(),
    photo,
  }
}

export type StagedHandwiredOSMachine = ReturnType<typeof createStagedHandwiredOSMachine>
