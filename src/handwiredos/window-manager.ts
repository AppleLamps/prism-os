import {itemCount as photoItemCount} from './photo-gallery.ts'
import {
  type Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  emitAnimatedObject,
  emitCompare,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  emitSelect,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../runtime/numeric-ui-core.ts'
import {
  type EvaluationKind,
  type PlannedEvaluation,
  type SpringClock,
  type WriteBack,
  advanceFrame,
  quantizeTimeMs,
  springMatrixBound,
  stoppedSpringClock,
} from '../runtime/host-timing.ts'
import {
  type ValueListKey,
  type ValueListOutputs,
  buildValueList,
  createValueListRenderer,
  describeOperations,
  describeOutputs,
  describeState,
  locationCount,
  maximumScrollTop,
  monitorLayout,
  rowCapacity,
  scrollGrid,
  slotField,
  validateValueListOutput,
  validateValueListOutputWires,
  valueListCells,
  valueListKeys,
} from './value-list.ts'
import {
  type PhotoOutputs,
  buildPhotos,
  controlField,
  createPhotoGalleryRenderer,
  emitIntervalDistance,
  photoCells,
  photoEvents,
  photoField,
  springConstants,
  springMatrixPowers,
  thumbnailField,
  validatePhotoGalleryOutput,
  validatePhotoGalleryOutputWires,
} from './photo-gallery.ts'
import {
  type Range,
  anyNumber,
  constant,
  createSourceTable,
  event,
  fieldIndices,
  input,
  list,
  oneHot,
  permutation,
  state,
  stateBit,
  unitInterval,
} from '../runtime/cells.ts'
import {arrangeInitialWindows, type ArrangementCells} from './arrangement.ts'

export type ArrangeInitialWindows = (
  source: Float32Array,
  cells: ArrangementCells,
  viewportWidth: number,
  viewportHeight: number,
) => ReturnType<typeof arrangeInitialWindows>

export type WindowManagerMountOptions = {
  /** Window layout written before the first evaluation. Defaults to HandwiredOS's desk layout. */
  arrange?: ArrangeInitialWindows
}
import {averagedFrames as monitorAveragedFrames, createMonitorFooter, frameCapacity as monitorFrameCapacity} from './monitor-footer.ts'
import {createWiringRenderer} from './wiring.ts'

export const windowCount = 3

// translateX, translateY, width, height and scale are where a window's frame is
// drawn while its springs animate. contentWidth and contentHeight are the content
// box's size at the window's destination, and destinationWidth and
// destinationHeight are where the width and height springs are heading. The frame
// clips the content box while the frame grows or shrinks.
export const windowOutputField = {
  translateX: 0,
  translateY: 1,
  width: 2,
  height: 3,
  scale: 4,
  opacity: 5,
  focused: 6,
  stack: 7,
  maximized: 8,
  contentWidth: 9,
  contentHeight: 10,
  destinationWidth: 11,
  destinationHeight: 12,
  size: 13,
} as const

export const dockOutputField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  inactive: 4,
  focused: 5,
  open: 6,
  size: 7,
} as const

const animationFields = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
type AnimationField = (typeof animationFields)[number]

// The machine rounds pointer coordinates and the viewport to multiples of this
// many px, and clamps pointer coordinates within ±pointerCoordinateBound px.
const pixelGrid = 1 / 64
// Twice the viewport ceiling. At ±65,536 px, a title bar's right edge distance
// could span more than 2^24 steps of its 1/128 px grid, and emitCompare would
// build a sign cascade for it instead of integer bits.
const pointerCoordinateBound = 32_768
// Pixel-space cells carry an honest finite ceiling: 16384 covers the
// largest real displays (8K is 7680 wide) with headroom while staying far
// inside FP32's exact-integer band (execution-model.md's macro contracts
// keep min, max and clamp operands under 2^23). Finite bounds make
// geometry eligible for gather lowering (see execution-model.md); a range
// that admits Infinity cannot lower.
const pixel: Range = [0, 16_384]
// The machine writes the viewport and pointer coordinates on the 1/64 px grid.
// With the pixel constants, window geometry and bit cells below also declared on
// grids, the edge distances of every window rectangle lie on a grid, so the hit
// tests' comparisons are integer bits (see emitRectangleHit).
const coordinate = () => input([-pointerCoordinateBound, pointerCoordinateBound], {grid: pixelGrid})
// Margins, the title bar, buttons, and dock geometry are constants in the
// tens to hundreds of pixels; 1024 is generous.
const pixelConstant = (value: number) => constant(value, [0, 1024], {grid: pixelGrid})
// Every FP32 matrix entry the host writes for up to 300 steps stays within this
// bound.
const matrixBound = springMatrixBound(springConstants)
const initialGeometry = [
  [54, 54, 540, 340],
  [410, 104, 500, 366],
  [650, 190, 560, 430],
] as const

// One spring of a window: its displacement from the destination in effect, its
// velocity, and that destination. The drawn value is destination + displacement,
// which the program computes and doesn't store. Displacements and velocities need
// no declared range. Each window starts at rest on its destinations.
const springCells = (destination: Range, initialDestination: number) => ({
  displacement: state(anyNumber),
  velocity: state(anyNumber),
  destination: state(destination, {initial: initialDestination}),
})

const windowManagerCells = {
  viewportWidth: input(pixel, {grid: pixelGrid}),
  viewportHeight: input(pixel, {grid: pixelGrid}),
  unit: constant(1, [1, 1], {grid: 1}),
  margin: pixelConstant(12),
  titleHeight: pixelConstant(44),
  minWidth: pixelConstant(280),
  minHeight: pixelConstant(190),
  resizeGrip: pixelConstant(24),
  buttonSize: pixelConstant(18),
  buttonGap: pixelConstant(10),
  dockHeight: pixelConstant(76),
  dockGap: pixelConstant(12),
  dockItemWidth: pixelConstant(50),
  down: {active: event({grid: 1}), x: coordinate(), y: coordinate()},
  move: {active: event({grid: 1}), x: coordinate(), y: coordinate()},
  up: {active: event({grid: 1}), x: coordinate(), y: coordinate()},
  // A pointercancel. The machine writes it together with the up latch at the cancel's
  // point, so a drag or a resize ends there as at a release, and no control acts.
  cancel: event({grid: 1}),
  // Where the pointer was at the last event, which a drag or a resize measures from.
  pointer: {
    x: state([-pointerCoordinateBound, pointerCoordinateBound], {grid: pixelGrid}),
    y: state([-pointerCoordinateBound, pointerCoordinateBound], {grid: pixelGrid}),
  },
  systemBarHeight: pixelConstant(36),
  // The spring matrix, settle check bit and snap bit that the host writes before
  // each evaluation, see advanceFrame in host-timing.ts.
  springMatrix: [
    state([-matrixBound, matrixBound], {initial: 1}),
    state([-matrixBound, matrixBound]),
    state([-matrixBound, matrixBound]),
    state([-matrixBound, matrixBound], {initial: 1}),
  ] as const,
  settleCheck: stateBit(),
  snap: stateBit(),
  // A window's stored rectangle is where the starting arrangement, a drag or a
  // resize put it, see nextStoredGeometry in buildWindowManager. Each of them
  // writes values from inside the viewport of its time, so the viewport ceiling is
  // honest for the stored state as well. Pointer deltas and clamps against the
  // viewport and the constants keep it on the 1/64 px grid.
  windows: list(windowCount, windowIndex => {
    const [left, top, width, height] = initialGeometry[windowIndex]!
    return {
      left: state(pixel, {initial: left, grid: pixelGrid}),
      top: state(pixel, {initial: top, grid: pixelGrid}),
      width: state(pixel, {initial: width, grid: pixelGrid}),
      height: state(pixel, {initial: height, grid: pixelGrid}),
      open: stateBit(1, {grid: 1}),
      minimized: stateBit(0, {grid: 1}),
      maximized: stateBit(0, {grid: 1}),
      present: stateBit(1, {grid: 1}),
    }
  }),
  // The window that a title bar press drags, and the window that a grip press
  // resizes, if any.
  drag: oneHot(list(windowCount, () => stateBit(0, {grid: 1})), {allowAllZero: true, declareToCircuit: false}),
  resize: oneHot(list(windowCount, () => stateBit(0, {grid: 1})), {allowAllZero: true, declareToCircuit: false}),
  // The control that the press being held armed, if any: a window's close, minimize
  // or maximize button, a window's dock item, Photos' content, Monitor's list, or one
  // of Monitor's sidebar locations. At most one is 1, see buildWindowManager.
  armed: {
    close: list(windowCount, () => stateBit(0, {grid: 1})),
    minimize: list(windowCount, () => stateBit(0, {grid: 1})),
    maximize: list(windowCount, () => stateBit(0, {grid: 1})),
    dockItem: list(windowCount, () => stateBit(0, {grid: 1})),
    photosContent: stateBit(0, {grid: 1}),
    valueList: stateBit(0, {grid: 1}),
    valueListLocation: list(locationCount, () => stateBit(0, {grid: 1})),
  },
  // The stacking state is a permutation matrix: exactly one window per rank
  // and exactly one rank per window, declared as one-hot groups. With three
  // windows, the frontmost-window selection sums over a group have three terms,
  // too few for the compiler to lower to gather reads, which it did with four
  // windows (gather-lowering.test.ts).
  stack: permutation(list(windowCount, windowIndex => windowIndex), {grid: 1}),
  // The destinations written back are this evaluation's targets. The range of a
  // center has room on both sides of the viewport, -16,384..32,768, for a layout
  // whose FP32 rounding puts a center just outside. E.g. with four windows, the
  // dock's gap in a 2 px wide viewport was a rounded third of the width, and a dock
  // item was centered at -4.8e-7 px.
  springs: list(windowCount, windowIndex => {
    const [left, top, width, height] = initialGeometry[windowIndex]!
    return {
      centerX: springCells([-16_384, 32_768], left + width / 2),
      centerY: springCells([-16_384, 32_768], top + height / 2),
      width: springCells(pixel, width),
      height: springCells(pixel, height),
      scale: springCells(unitInterval, 1),
    }
  }),
  valueList: valueListCells,
  photos: photoCells,
}

// The cell positions under their earlier names, e.g. sourceField.downX is the
// position of down.x, and windowStateField.top is the index of top within one
// window's cells. Every machine declares the same cells, so the positions hold for
// every machine.
const layout = createSourceTable()
const positions = layout.declare(windowManagerCells)

export const windowStateField = fieldIndices(windowManagerCells.windows[0]!)

export const photoSourceField = {
  gap: positions.photos.gap,
  mainInset: positions.photos.mainInset,
  thumbnailHeight: positions.photos.thumbnailHeight,
  controlSize: positions.photos.controlSize,
  clickActive: positions.photos.click.active,
  clickX: positions.photos.click.x,
  clickY: positions.photos.click.y,
  previousActive: positions.photos.previous,
  nextActive: positions.photos.next,
  closeActive: positions.photos.close,
  focusStart: positions.photos.focus[0]!,
  thumbnailSpringStart: positions.photos.thumbnails[0]!.centerXDisplacement,
  zoomOpenSpring: positions.photos.zoom.openSpring,
  size: layout.size,
}

// rowCounts and location hold one position per sidebar location, in the sidebar's
// order: State, Operations, Outputs.
export const valueListSourceField = {
  scrollTop: positions.valueList.scrollTop,
  rowCounts: positions.valueList.rowCounts,
  location: positions.valueList.location,
  selected: positions.valueList.selected,
}

export const sourceField = {
  viewportWidth: positions.viewportWidth,
  viewportHeight: positions.viewportHeight,
  unit: positions.unit,
  margin: positions.margin,
  titleHeight: positions.titleHeight,
  minWidth: positions.minWidth,
  minHeight: positions.minHeight,
  resizeGrip: positions.resizeGrip,
  buttonSize: positions.buttonSize,
  buttonGap: positions.buttonGap,
  dockHeight: positions.dockHeight,
  dockGap: positions.dockGap,
  dockItemWidth: positions.dockItemWidth,
  downActive: positions.down.active,
  downX: positions.down.x,
  downY: positions.down.y,
  moveActive: positions.move.active,
  moveX: positions.move.x,
  moveY: positions.move.y,
  upActive: positions.up.active,
  upX: positions.up.x,
  upY: positions.up.y,
  pointerX: positions.pointer.x,
  pointerY: positions.pointer.y,
  systemBarHeight: positions.systemBarHeight,
  springMatrixStart: positions.springMatrix[0],
  settleCheck: positions.settleCheck,
  snap: positions.snap,
  windowStart: positions.windows[0]!.left,
  dragStart: positions.drag[0]!,
  resizeStart: positions.resize[0]!,
  stackStart: positions.stack[0]![0]!,
  springStart: positions.springs[0]!.centerX.displacement,
  photoStart: positions.photos.gap,
  size: layout.size,
}

// A list's element at a checked index, e.g. cellAt(positions.drag, 5, 'drag window
// index') throws 'drag window index is invalid'.
function cellAt<Element>(cells: readonly Element[], index: number, label: string) {
  invariant(Number.isInteger(index) && index >= 0 && index < cells.length, `${label} is invalid`)
  return cells[index]!
}

export function windowSourceField(windowIndex: number, field: number) {
  return cellAt(Object.values(cellAt(positions.windows, windowIndex, 'window index')), field, 'window field')
}

export function dragSourceField(windowIndex: number) {
  return cellAt(positions.drag, windowIndex, 'drag window index')
}

export function resizeSourceField(windowIndex: number) {
  return cellAt(positions.resize, windowIndex, 'resize window index')
}

// The position of an armed control's bit, e.g. armedSourceField('close', 0) holds 1
// while a press on Monitor's close button is held, armedSourceField('photosContent')
// holds 1 while a press on Photos' content is held, armedSourceField('valueList')
// while a press on Monitor's list is held, and armedSourceField('valueListLocation', 2)
// while a press on Monitor's third sidebar location is held.
export function armedSourceField(control: 'close' | 'minimize' | 'maximize' | 'dockItem' | 'photosContent' | 'valueList' | 'valueListLocation', windowIndex?: number) {
  if (control === 'photosContent') {
    invariant(windowIndex === undefined || windowIndex === photosWindowIndex, 'only Photos has an armed content bit')
    return positions.armed.photosContent
  }
  if (control === 'valueList') {
    invariant(windowIndex === undefined || windowIndex === monitorWindowIndex, 'only Monitor has an armed list bit')
    return positions.armed.valueList
  }
  invariant(windowIndex !== undefined, `${control} needs an index`)
  return cellAt(positions.armed[control], windowIndex, `${control} index`)
}

export function stackSourceField(rank: number, windowIndex: number) {
  return cellAt(cellAt(positions.stack, rank, 'stack rank'), windowIndex, 'stack window index')
}

export function photoFocusSourceField(item: number) {
  return cellAt(positions.photos.focus, item, 'photo index')
}

// The bit that is 1 for the photo that was closed last, see "The zoom" in photo-gallery.ts.
export function photoClosedLastSourceField(item: number) {
  return cellAt(positions.photos.zoom.closedLast, item, 'photo index')
}

export function photoThumbnailSpringSourceField(item: number, field: number) {
  return cellAt(
    Object.values(cellAt(positions.photos.thumbnails, item, 'photo index')),
    field,
    'photo thumbnail spring field',
  )
}

// The windows by index: Monitor, whose content is the list of the program's values,
// see value-list.ts, then Notes, whose content is the browser's own text field, see
// mountWindowManager, then Photos, see photo-gallery.ts.
const monitorWindowIndex = 0
const notesWindowIndex = 1
const photosWindowIndex = windowCount - 1
const geometryFields = ['left', 'top', 'width', 'height'] as const
const transformFields = ['translateX', 'translateY', 'scale'] as const
type Geometry = Record<(typeof geometryFields)[number], Wire>
type Transform = Record<(typeof transformFields)[number], Wire>
type WindowAnimation = {
  width: Wire
  height: Wire
  transform: Transform
  active: Wire
}

type WindowManagerOutput = {
  nextSource: Wire[]
  windows: Wire[]
  dockItems: Wire[]
  animationActive: Wire
  photos: PhotoOutputs
  valueList: ValueListOutputs
}

function buildWindowManager() {
  const table = createSourceTable()
  const cells = table.declare(windowManagerCells)
  table.atMostOne('photos events', photoEvents(cells.photos))
  table.atMostOne('value list keys', valueListKeys(cells.valueList))
  table.atMostOne('armed control', [
    ...cells.armed.close,
    ...cells.armed.minimize,
    ...cells.armed.maximize,
    ...cells.armed.dockItem,
    cells.armed.photosContent,
    cells.armed.valueList,
    ...cells.armed.valueListLocation,
  ])
  const circuit = table.createCircuit()

  const unit = cells.unit
  const zero = circuit.constant(0)
  const effectiveDockHeight = emitMinimum(
    circuit,
    cells.dockHeight,
    cells.viewportHeight,
  )
  const dockTop = circuit.affine([
    [cells.viewportHeight, 1],
    [effectiveDockHeight, -1],
  ])
  const workspaceTop = emitMinimum(circuit, cells.systemBarHeight, dockTop)
  const workspaceHeight = circuit.affine([[dockTop, 1], [workspaceTop, -1]])
  const maximumLeft = emitMinimum(
    circuit,
    cells.margin,
    circuit.affine([[cells.viewportWidth, 0.5]]),
  )
  const maximumTopInset = emitMinimum(
    circuit,
    cells.margin,
    circuit.affine([[workspaceHeight, 0.5]]),
  )
  const maximumGeometry: Geometry = {
    left: maximumLeft,
    top: circuit.affine([[workspaceTop, 1], [maximumTopInset, 1]]),
    width: emitRelu(circuit, circuit.affine([
      [cells.viewportWidth, 1],
      [maximumLeft, -2],
    ])),
    height: emitRelu(circuit, circuit.affine([
      [workspaceHeight, 1],
      [maximumTopInset, -2],
    ])),
  }
  // A window that isn't maximized is hit-tested and drawn at its stored rectangle
  // fitted into the workspace, and its springs head there. The fitted rectangle has
  // a size between the minimum size and the workspace's, where a workspace smaller
  // than the minimum size gives its own size, and a position that keeps the whole
  // window inside. E.g. Photos, stored at 842, 278 and 560 × 430 px, is fitted to
  // 340, 194 and 560 × 430 px in a viewport of 900 × 700 px.
  const minimumWidth = emitMinimum(circuit, cells.minWidth, cells.viewportWidth)
  const minimumHeight = emitMinimum(circuit, cells.minHeight, workspaceHeight)
  const fitIntoWorkspace = (rectangle: Geometry): Geometry => {
    // A fitted value lies inside the viewport, so within the viewport cells' range,
    // and on the 1/64 px grid of the cells that it is computed from. The builder
    // infers less from the clamps' sums, e.g. no grid for the fitted left edge, and
    // -414,720..412,672 px with no grid for the top edge after a drag. The hit
    // tests' comparisons are integer bits only for operands on grids within 2^24
    // grid steps: without these declarations they are sign cascades, and the program
    // has 844 more live operations and 5 more layers, measured on October 14, 2026.
    const inViewport = (wire: Wire) => {
      circuit.assumeRange(wire, pixel[0], pixel[1])
      circuit.assumeGrid(wire, pixelGrid)
      return wire
    }
    const width = inViewport(emitClampDynamic(circuit, rectangle.width, minimumWidth, cells.viewportWidth))
    const height = inViewport(emitClampDynamic(circuit, rectangle.height, minimumHeight, workspaceHeight))
    const maximumLeft = emitRelu(circuit, circuit.affine([
      [cells.viewportWidth, 1],
      [width, -1],
    ]))
    const maximumTop = emitRelu(circuit, circuit.affine([
      [dockTop, 1],
      [height, -1],
    ]))
    return {
      left: inViewport(emitClampDynamic(circuit, rectangle.left, zero, maximumLeft)),
      top: inViewport(emitClampDynamic(circuit, rectangle.top, workspaceTop, maximumTop)),
      width,
      height,
    }
  }
  // Each window's stored rectangle, fitted into the workspace as it is now, before
  // this evaluation's events.
  const fittedGeometry: Geometry[] = []
  const windowHit: Wire[] = []
  const closeHit: Wire[] = []
  const minimizeHit: Wire[] = []
  const maximizeHit: Wire[] = []
  const dragHit: Wire[] = []
  const resizeHit: Wire[] = []
  // The same buttons at the up latch's point, for the release that acts.
  const closeHitAtUp: Wire[] = []
  const minimizeHitAtUp: Wire[] = []
  const maximizeHitAtUp: Wire[] = []
  // Photos' content box and grip, at the down and at the up.
  let photosContentHit = zero
  let photosContentHitAtUp = zero
  let photosGripHitAtUp = zero
  // Monitor's list viewport, sidebar locations and grip, at the down and at the up,
  // and the list's top edge.
  let valueListHit = zero
  let valueListHitAtUp = zero
  let monitorGripHitAtUp = zero
  let valueListTop = zero
  const valueListLocationHit: Wire[] = []
  const valueListLocationHitAtUp: Wire[] = []

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const current = cells.windows[windowIndex]!
    const visible = emitMultiply(circuit, current.open, emitComplement(circuit, current.minimized, unit))
    const fitted = fitIntoWorkspace(current)
    fittedGeometry.push(fitted)
    const geometry = {
      left: emitSelect(circuit, current.maximized, fitted.left, maximumGeometry.left),
      top: emitSelect(circuit, current.maximized, fitted.top, maximumGeometry.top),
      width: emitSelect(circuit, current.maximized, fitted.width, maximumGeometry.width),
      height: emitSelect(circuit, current.maximized, fitted.height, maximumGeometry.height),
    }
    windowHit.push(emitMultiply(
      circuit,
      visible,
      emitRectangleHit(circuit, cells.down.x, cells.down.y, geometry),
    ))

    const buttonTop = circuit.affine([
      [geometry.top, 1],
      [cells.titleHeight, 0.5],
      [cells.buttonSize, -0.5],
    ])
    const closeLeft = circuit.affine([
      [geometry.left, 1],
      [geometry.width, 1],
      [cells.buttonGap, -1],
      [cells.buttonSize, -1],
    ])
    const maximizeLeft = circuit.affine([
      [closeLeft, 1],
      [cells.buttonGap, -1],
      [cells.buttonSize, -1],
    ])
    const minimizeLeft = circuit.affine([
      [maximizeLeft, 1],
      [cells.buttonGap, -1],
      [cells.buttonSize, -1],
    ])
    const buttonHitInset = circuit.affine([[cells.buttonGap, 0.5]])
    const buttonHitSize = circuit.affine([
      [cells.buttonSize, 1],
      [cells.buttonGap, 1],
    ])
    const buttonHitGeometry = (left: Wire): Geometry => ({
      left: circuit.affine([[left, 1], [buttonHitInset, -1]]),
      top: circuit.affine([[buttonTop, 1], [buttonHitInset, -1]]),
      width: buttonHitSize,
      height: buttonHitSize,
    })
    const closeRectangle = buttonHitGeometry(closeLeft)
    const maximizeRectangle = buttonHitGeometry(maximizeLeft)
    const minimizeRectangle = buttonHitGeometry(minimizeLeft)
    closeHit.push(emitRectangleHit(circuit, cells.down.x, cells.down.y, closeRectangle))
    maximizeHit.push(emitRectangleHit(circuit, cells.down.x, cells.down.y, maximizeRectangle))
    minimizeHit.push(emitRectangleHit(circuit, cells.down.x, cells.down.y, minimizeRectangle))
    closeHitAtUp.push(emitRectangleHit(circuit, cells.up.x, cells.up.y, closeRectangle))
    maximizeHitAtUp.push(emitRectangleHit(circuit, cells.up.x, cells.up.y, maximizeRectangle))
    minimizeHitAtUp.push(emitRectangleHit(circuit, cells.up.x, cells.up.y, minimizeRectangle))
    dragHit.push(emitRectangleHit(
      circuit,
      cells.down.x,
      cells.down.y,
      {
        left: geometry.left,
        top: geometry.top,
        width: emitRelu(circuit, circuit.affine([
          [minimizeLeft, 1],
          [cells.buttonGap, -1],
          [geometry.left, -1],
        ])),
        height: cells.titleHeight,
      },
    ))
    const gripRectangle: Geometry = {
      left: circuit.affine([
        [geometry.left, 1],
        [geometry.width, 1],
        [cells.resizeGrip, -1],
      ]),
      top: circuit.affine([
        [geometry.top, 1],
        [geometry.height, 1],
        [cells.resizeGrip, -1],
      ]),
      width: cells.resizeGrip,
      height: cells.resizeGrip,
    }
    resizeHit.push(emitRectangleHit(circuit, cells.down.x, cells.down.y, gripRectangle))
    if (windowIndex === monitorWindowIndex) {
      // The list viewport: the content box without the sidebar at its left, without
      // the header row at its top, without the footer at its bottom, and without the
      // strip at its right edge where the native scrollbar is drawn, so a press on the
      // scrollbar or on the footer is on no row.
      const listRectangle: Geometry = {
        left: circuit.affine([[geometry.left, 1], [unit, 1]], monitorLayout.sidebarWidth),
        top: circuit.affine([[geometry.top, 1], [cells.titleHeight, 1], [unit, 1]], monitorLayout.headerHeight),
        width: circuit.affine([[geometry.width, 1], [unit, -2]], -monitorLayout.sidebarWidth - monitorLayout.scrollbarStrip),
        height: circuit.affine([[geometry.height, 1], [cells.titleHeight, -1], [unit, -2]], -monitorLayout.headerHeight - monitorLayout.footerHeight),
      }
      valueListHit = emitRectangleHit(circuit, cells.down.x, cells.down.y, listRectangle)
      valueListHitAtUp = emitRectangleHit(circuit, cells.up.x, cells.up.y, listRectangle)
      monitorGripHitAtUp = emitRectangleHit(circuit, cells.up.x, cells.up.y, gripRectangle)
      valueListTop = listRectangle.top
      // The sidebar's locations, one below the other.
      for (let location = 0; location < locationCount; location++) {
        const locationRectangle: Geometry = {
          left: circuit.affine([[geometry.left, 1], [unit, 1]], monitorLayout.locationInset),
          top: circuit.affine(
            [[geometry.top, 1], [cells.titleHeight, 1], [unit, 1]],
            monitorLayout.locationTop + location * monitorLayout.locationHeight,
          ),
          width: circuit.constant(monitorLayout.sidebarWidth - 2 * monitorLayout.locationInset),
          height: circuit.constant(monitorLayout.locationHeight),
        }
        valueListLocationHit.push(emitRectangleHit(circuit, cells.down.x, cells.down.y, locationRectangle))
        valueListLocationHitAtUp.push(emitRectangleHit(circuit, cells.up.x, cells.up.y, locationRectangle))
      }
    }
    if (windowIndex === photosWindowIndex) {
      // The content box inside the 1 px border and below the title bar, where Photos
      // reads clicks.
      const contentRectangle: Geometry = {
        left: circuit.affine([[geometry.left, 1], [unit, 1]]),
        top: circuit.affine([[geometry.top, 1], [cells.titleHeight, 1], [unit, 1]]),
        width: circuit.affine([[geometry.width, 1], [unit, -2]]),
        height: circuit.affine([[geometry.height, 1], [cells.titleHeight, -1], [unit, -2]]),
      }
      photosContentHit = emitRectangleHit(circuit, cells.down.x, cells.down.y, contentRectangle)
      photosContentHitAtUp = emitRectangleHit(circuit, cells.up.x, cells.up.y, contentRectangle)
      photosGripHitAtUp = emitRectangleHit(circuit, cells.up.x, cells.up.y, gripRectangle)
    }
  }

  const selectedCanvas = emitFrontmost(circuit, cells.stack, windowHit, unit)

  const dockGap = emitMinimum(
    circuit,
    cells.dockGap,
    emitMinimum(
      circuit,
      circuit.affine([[cells.viewportWidth, 1 / (windowCount - 1)]]),
      circuit.affine([[effectiveDockHeight, 0.5]]),
    ),
  )
  const dockHorizontalSpace = emitRelu(circuit, circuit.affine([
    [cells.viewportWidth, 1],
    [dockGap, -(windowCount - 1)],
  ]))
  const dockVerticalSpace = emitRelu(circuit, circuit.affine([
    [effectiveDockHeight, 1],
    [dockGap, -2],
  ]))
  const dockItemSize = emitMinimum(
    circuit,
    cells.dockItemWidth,
    emitMinimum(
      circuit,
      circuit.affine([[dockHorizontalSpace, 1 / windowCount]]),
      dockVerticalSpace,
    ),
  )
  const dockTotalWidth = circuit.affine([
    [dockItemSize, windowCount],
    [dockGap, windowCount - 1],
  ])
  const dockLeft = circuit.affine([
    [cells.viewportWidth, 0.5],
    [dockTotalWidth, -0.5],
  ])
  const dockItemTop = circuit.affine([
    [dockTop, 1],
    [effectiveDockHeight, 0.5],
    [dockItemSize, -0.5],
  ])
  const dockGeometry: Geometry[] = []
  const dockHit: Wire[] = []
  const dockHitAtUp: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const geometry = {
      left: circuit.affine([
        [dockLeft, 1],
        [dockItemSize, windowIndex],
        [dockGap, windowIndex],
      ]),
      top: dockItemTop,
      width: dockItemSize,
      height: dockItemSize,
    }
    dockGeometry.push(geometry)
    dockHit.push(emitDockItemHit(circuit, cells.down.x, cells.down.y, geometry, unit))
    dockHitAtUp.push(emitDockItemHit(circuit, cells.up.x, cells.up.y, geometry, unit))
  }

  // Presses and releases. Within one evaluation, the latches apply in a fixed order:
  // the last down, then the last move, then the last up, where a pointercancel is an
  // up with the cancel bit.
  //
  // A press raises and focuses the frontmost window under it, and dragging and
  // resizing start at the press. A press on Notes' content does nothing else: the
  // note is the browser's own text field, and the browser places its caret and
  // selects its text. The window buttons, the dock items and Photos'
  // content act on release, like native buttons: a press over a control arms it, a
  // release over the armed control acts, and a release anywhere else, or a
  // pointercancel, acts on nothing. The path between the press and the release
  // doesn't matter, e.g. a press on Monitor's close button that moves off the button
  // and back, then releases over the button, closes Monitor. This differs from
  // lab/ui-exploration/input's window circuit, and from indirect-os-2 at the
  // exploration-2026-09 tag, where a press that moves more than 4 px away from where
  // it started turns into a drag, so a release back over the button doesn't click.
  //
  // A release is tested like a press, against each window's rectangle before this
  // evaluation's events, i.e. its stored rectangle fitted into the workspace, or the
  // maximized rectangle. During an animation that is the window's destination. The
  // armed button's window is frontmost from the press on, so a release over that
  // window's button is over no other window.
  const windowPressed = circuit.affine(selectedCanvas.map(wire => [wire, 1]))
  circuit.assumeRange(windowPressed, 0, 1)
  const release = emitRelu(circuit, circuit.affine([[cells.up.active, 1], [cells.cancel, -1]]))
  const pointerStillDown = emitComplement(circuit, cells.up.active, unit)
  // After an up, nothing is armed.
  const nextArmedFor = (armed: Wire) => emitAll(circuit, [armed, pointerStillDown])
  const nextArmed = {close: [] as Wire[], minimize: [] as Wire[], maximize: [] as Wire[], dockItem: [] as Wire[]}
  const canvasPress: Wire[] = []
  const selectedWindow: Wire[] = []
  const closeClick: Wire[] = []
  const minimizeClick: Wire[] = []
  const maximizeClick: Wire[] = []
  const dockClick: Wire[] = []
  const dragPress: Wire[] = []
  const resizePress: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const canvas = emitMultiply(circuit, cells.down.active, selectedCanvas[windowIndex]!)
    canvasPress.push(canvas)
    const normalWindow = emitComplement(circuit, cells.windows[windowIndex]!.maximized, unit)
    dragPress.push(emitMultiply(
      circuit,
      emitMultiply(circuit, canvas, dragHit[windowIndex]!),
      normalWindow,
    ))
    resizePress.push(emitMultiply(
      circuit,
      emitMultiply(circuit, canvas, resizeHit[windowIndex]!),
      normalWindow,
    ))

    // The armed controls after this evaluation's down: a down replaces the armed
    // control with the control that it presses, if any. A dock item is pressed only
    // when no window is under the point.
    const armedAfterDown = (stored: Wire, pressed: Wire) => emitSelect(circuit, cells.down.active, stored, pressed)
    const armedClose = armedAfterDown(cells.armed.close[windowIndex]!, emitMultiply(circuit, canvas, closeHit[windowIndex]!))
    const armedMinimize = armedAfterDown(cells.armed.minimize[windowIndex]!, emitMultiply(circuit, canvas, minimizeHit[windowIndex]!))
    const armedMaximize = armedAfterDown(cells.armed.maximize[windowIndex]!, emitMultiply(circuit, canvas, maximizeHit[windowIndex]!))
    const armedDockItem = armedAfterDown(
      cells.armed.dockItem[windowIndex]!,
      emitAll(circuit, [cells.down.active, dockHit[windowIndex]!, emitComplement(circuit, windowPressed, unit)]),
    )
    // A click is a release without a cancel over the armed control.
    closeClick.push(emitAll(circuit, [release, armedClose, closeHitAtUp[windowIndex]!]))
    minimizeClick.push(emitAll(circuit, [release, armedMinimize, minimizeHitAtUp[windowIndex]!]))
    maximizeClick.push(emitAll(circuit, [release, armedMaximize, maximizeHitAtUp[windowIndex]!]))
    dockClick.push(emitAll(circuit, [release, armedDockItem, dockHitAtUp[windowIndex]!]))
    nextArmed.close.push(nextArmedFor(armedClose))
    nextArmed.minimize.push(nextArmedFor(armedMinimize))
    nextArmed.maximize.push(nextArmedFor(armedMaximize))
    nextArmed.dockItem.push(nextArmedFor(armedDockItem))
    // A dock item raises and focuses its window at the click. A down that raises a
    // window arms no dock item, so at most one window is selected.
    selectedWindow.push(emitClampZeroOne(circuit, circuit.affine([[canvas, 1], [dockClick[windowIndex]!, 1]]), unit))
  }
  // Photos' content is pressed where no grip press starts a resize, and a release
  // over the grip of a Photos window that isn't maximized isn't over the content. So
  // a resize by the grip that ends over a photo opens no photo.
  const armedPhotosContent = emitSelect(
    circuit,
    cells.down.active,
    cells.armed.photosContent,
    emitAll(circuit, [
      canvasPress[photosWindowIndex]!,
      photosContentHit,
      emitComplement(circuit, resizePress[photosWindowIndex]!, unit),
    ]),
  )
  const photosGripAtUp = emitAll(circuit, [photosGripHitAtUp, emitComplement(circuit, cells.windows[photosWindowIndex]!.maximized, unit)])
  const photosContentClick = emitAll(circuit, [
    release,
    armedPhotosContent,
    photosContentHitAtUp,
    emitComplement(circuit, photosGripAtUp, unit),
  ])
  // Monitor's list is pressed and released like Photos' content. The release selects
  // the row under it, see buildValueList. A press alone selects nothing, so a touch
  // that the browser takes over to scroll the list, which ends in a pointercancel,
  // selects nothing.
  const armedValueList = emitSelect(
    circuit,
    cells.down.active,
    cells.armed.valueList,
    emitAll(circuit, [
      canvasPress[monitorWindowIndex]!,
      valueListHit,
      emitComplement(circuit, resizePress[monitorWindowIndex]!, unit),
    ]),
  )
  const monitorGripAtUp = emitAll(circuit, [monitorGripHitAtUp, emitComplement(circuit, cells.windows[monitorWindowIndex]!.maximized, unit)])
  const valueListClick = emitAll(circuit, [
    release,
    armedValueList,
    valueListHitAtUp,
    emitComplement(circuit, monitorGripAtUp, unit),
  ])
  // A sidebar location is pressed and released like a dock item: the press arms the
  // location, and a release over the same location shows it.
  const armedValueListLocation = valueListLocationHit.map((hit, location) => emitSelect(
    circuit,
    cells.down.active,
    cells.armed.valueListLocation[location]!,
    emitAll(circuit, [
      canvasPress[monitorWindowIndex]!,
      hit,
      emitComplement(circuit, resizePress[monitorWindowIndex]!, unit),
    ]),
  ))
  const valueListLocationClick = armedValueListLocation.map((armed, location) => emitAll(circuit, [
    release,
    armed,
    valueListLocationHitAtUp[location]!,
    emitComplement(circuit, monitorGripAtUp, unit),
  ]))

  const baselineX = emitSelect(
    circuit,
    cells.down.active,
    cells.pointer.x,
    cells.down.x,
  )
  const baselineY = emitSelect(
    circuit,
    cells.down.active,
    cells.pointer.y,
    cells.down.y,
  )
  const movedX = emitSelect(circuit, cells.move.active, baselineX, cells.move.x)
  const movedY = emitSelect(circuit, cells.move.active, baselineY, cells.move.y)
  const pointerX = emitSelect(circuit, cells.up.active, movedX, cells.up.x)
  const pointerY = emitSelect(circuit, cells.up.active, movedY, cells.up.y)
  const deltaX = circuit.affine([[pointerX, 1], [baselineX, -1]])
  const deltaY = circuit.affine([[pointerY, 1], [baselineY, -1]])

  // A window's rectangle while it isn't maximized, after this evaluation's events,
  // and the rectangle that the window stores.
  //
  // The stored rectangle is where the starting arrangement, a drag or a resize put
  // the window, and the viewport never changes it. The rectangle that the window is
  // drawn at is computed from it in every evaluation, see fitIntoWorkspace. So a
  // viewport that shrinks and grows back leaves every window where it was, e.g. a
  // phone turned on its side and back, or a browser window made small for a moment.
  // When the fitted rectangle was written back instead, the phone's three windows
  // ended on one rectangle, 12, 36 and 366 × 278 px, since the sideways workspace is
  // 278 px tall, and a window kept the smallest size that a viewport had ever given
  // it. chenguini's engineering.md, "Data Modeling", says to compute derived data
  // and not to store it on the data that it came from, and ui.md's "State The
  // Browser Keeps" counts the viewport's size among a frame's inputs.
  //
  // A drag or a resize starts from the fitted rectangle, where the window is drawn,
  // and stores what it leaves: a drag the position, and a resize the position and
  // the size. E.g. Photos, stored at 842, 278 px, is drawn at 340, 194 px in a
  // viewport of 900 × 700 px. A title bar drag of 60 px to the left there moves
  // Photos to 280 px and stores that, so Photos stays at 280 px in every viewport
  // that is at least 840 px wide.
  // - A drag keeps the stored size, so a window that was only moved while a small
  //   viewport made it smaller gets its size back in a larger viewport. E.g. on a
  //   phone held sideways, Photos is 278 px tall instead of 319 px, and after a drag
  //   there and a turn back, Photos is 319 px tall again.
  // - A resize stores the position too. If it stored the size alone, Photos above
  //   would keep its stored left edge of 842 px, and its fitted left edge, which is
  //   the viewport's width minus Photos' width, would move by as much as the grip
  //   moves.
  // - Only an evaluation in which the pointer moved stores, see pointerMoved. A
  //   press and a release at one point didn't put the window anywhere, so the
  //   stored rectangle stays, e.g. after a click on a title bar that only brings
  //   its window to the front. When the press alone stored the drawn position, a
  //   tap on Photos' title bar on a phone held sideways, where the three windows
  //   lie on one rectangle, left Photos at 12, 36 px after the turn back, on top of
  //   the other two, where it had been at 12, 437 px. A release at another point
  //   than the press is a move, however small: a finger that slides by 1 px during
  //   a tap drags the window by 1 px, and the window stores where that leaves it.
  //
  // Whether the pointer moved in this evaluation: 1 when the pointer is at another
  // point than at the event before, or than at the press when this evaluation
  // holds the press, and 0 otherwise. deltaX and deltaY are whole steps of the
  // 1/64 px grid, so 64 times their absolute values is a whole number, at most
  // 2^23, and its clamp is exactly 0 or 1.
  const gridStepsPerPixel = 1 / pixelGrid
  const pointerMoved = emitClampZeroOne(circuit, circuit.affine([
    [emitRelu(circuit, deltaX), gridStepsPerPixel],
    [emitRelu(circuit, circuit.affine([[deltaX, -1]])), gridStepsPerPixel],
    [emitRelu(circuit, deltaY), gridStepsPerPixel],
    [emitRelu(circuit, circuit.affine([[deltaY, -1]])), gridStepsPerPixel],
  ]), unit)
  const nextNormalGeometry: Geometry[] = []
  const nextStoredGeometry: Geometry[] = []
  const nextOpen: Wire[] = []
  const nextMinimized: Wire[] = []
  const nextMaximized: Wire[] = []
  const nextDrag: Wire[] = []
  const nextResize: Wire[] = []
  const directManipulation: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const dragForMotion = emitSelect(
      circuit,
      cells.down.active,
      cells.drag[windowIndex]!,
      dragPress[windowIndex]!,
    )
    const resizeForMotion = emitSelect(
      circuit,
      cells.down.active,
      cells.resize[windowIndex]!,
      resizePress[windowIndex]!,
    )
    nextDrag.push(emitMultiply(circuit, dragForMotion, pointerStillDown))
    nextResize.push(emitMultiply(circuit, resizeForMotion, pointerStillDown))
    directManipulation.push(emitClampZeroOne(
      circuit,
      circuit.affine([[dragForMotion, 1], [resizeForMotion, 1]]),
      unit,
    ))

    const current = cells.windows[windowIndex]!
    const fitted = fittedGeometry[windowIndex]!
    const normal = fitIntoWorkspace({
      left: circuit.affine([
        [fitted.left, 1],
        [emitMultiply(circuit, dragForMotion, deltaX), 1],
      ]),
      top: circuit.affine([
        [fitted.top, 1],
        [emitMultiply(circuit, dragForMotion, deltaY), 1],
      ]),
      width: circuit.affine([
        [fitted.width, 1],
        [emitMultiply(circuit, resizeForMotion, deltaX), 1],
      ]),
      height: circuit.affine([
        [fitted.height, 1],
        [emitMultiply(circuit, resizeForMotion, deltaY), 1],
      ]),
    })
    nextNormalGeometry.push(normal)
    const storesPosition = emitMultiply(circuit, directManipulation[windowIndex]!, pointerMoved)
    const storesSize = emitMultiply(circuit, resizeForMotion, pointerMoved)
    nextStoredGeometry.push({
      left: emitSelect(circuit, storesPosition, current.left, normal.left),
      top: emitSelect(circuit, storesPosition, current.top, normal.top),
      width: emitSelect(circuit, storesSize, current.width, normal.width),
      height: emitSelect(circuit, storesSize, current.height, normal.height),
    })

    const afterClose = emitSelect(
      circuit,
      closeClick[windowIndex]!,
      current.open,
      zero,
    )
    nextOpen.push(emitSelect(circuit, dockClick[windowIndex]!, afterClose, unit))
    const afterMinimize = emitSelect(
      circuit,
      minimizeClick[windowIndex]!,
      current.minimized,
      unit,
    )
    const afterDock = emitSelect(circuit, dockClick[windowIndex]!, afterMinimize, zero)
    nextMinimized.push(emitSelect(circuit, closeClick[windowIndex]!, afterDock, zero))
    const toggledMaximized = circuit.affine([
      [current.maximized, 1],
      [emitMultiply(
        circuit,
        maximizeClick[windowIndex]!,
        circuit.affine([[unit, 1], [current.maximized, -2]]),
      ), 1],
    ])
    nextMaximized.push(emitSelect(
      circuit,
      closeClick[windowIndex]!,
      toggledMaximized,
      zero,
    ))
  }

  const selectionMass = emitClampZeroOne(
    circuit,
    circuit.affine(selectedWindow.map(wire => [wire, 1])),
    unit,
  )
  const selectionInactive = emitComplement(circuit, selectionMass, unit)
  const selectedRank: Wire[] = []
  for (let rank = 0; rank < windowCount; rank++) {
    const terms: [Wire, number][] = []
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      terms.push([
        emitMultiply(circuit, cells.stack[rank]![windowIndex]!, selectedWindow[windowIndex]!),
        1,
      ])
    }
    selectedRank.push(emitClampZeroOne(circuit, circuit.affine(terms), unit))
  }

  const nextStack: Wire[][] = Array.from(
    {length: windowCount},
    () => Array<Wire>(windowCount),
  )
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const movedTerms: [Wire, number][] = []
      if (rank === windowCount - 1) {
        movedTerms.push([selectedWindow[windowIndex]!, 1])
      } else {
        for (let selectedRankIndex = 0; selectedRankIndex < windowCount; selectedRankIndex++) {
          const sourceRank = rank < selectedRankIndex ? rank : rank + 1
          movedTerms.push([
            emitMultiply(
              circuit,
              selectedRank[selectedRankIndex]!,
              cells.stack[sourceRank]![windowIndex]!,
            ),
            1,
          ])
        }
      }
      nextStack[rank]![windowIndex] = circuit.affine([
        [emitMultiply(
          circuit,
          selectionInactive,
          cells.stack[rank]![windowIndex]!,
        ), 1],
        [circuit.affine(movedTerms), 1],
      ])
    }
  }

  const nextVisible: Wire[] = []
  const effectiveGeometry: Geometry[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    nextVisible.push(emitMultiply(
      circuit,
      nextOpen[windowIndex]!,
      emitComplement(circuit, nextMinimized[windowIndex]!, unit),
    ))
    const normal = nextNormalGeometry[windowIndex]!
    const maximized = nextMaximized[windowIndex]!
    effectiveGeometry.push({
      left: emitSelect(circuit, maximized, normal.left, maximumGeometry.left),
      top: emitSelect(circuit, maximized, normal.top, maximumGeometry.top),
      width: emitSelect(circuit, maximized, normal.width, maximumGeometry.width),
      height: emitSelect(circuit, maximized, normal.height, maximumGeometry.height),
    })
  }
  // The content box sits inside a 1 px border and below the title bar, at the size
  // the window is heading to, e.g. the maximized size from the press on.
  const windowBorderSpan = circuit.affine([[unit, 2]])
  const destinationContentWidth = effectiveGeometry.map(geometry =>
    emitRelu(circuit, circuit.affine([[geometry.width, 1], [windowBorderSpan, -1]])))
  const destinationContentHeight = effectiveGeometry.map(geometry =>
    emitRelu(circuit, circuit.affine([
      [geometry.height, 1],
      [cells.titleHeight, -1],
      [windowBorderSpan, -1],
    ])))
  const focusedWindow = emitFrontmost(circuit, nextStack, nextVisible, unit)
  const windowAnimations: WindowAnimation[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const visibleTarget = effectiveGeometry[windowIndex]!
    const dockTarget = dockGeometry[windowIndex]!
    const visibleCenterX = circuit.affine([
      [visibleTarget.left, 1],
      [visibleTarget.width, 0.5],
    ])
    const visibleCenterY = circuit.affine([
      [visibleTarget.top, 1],
      [visibleTarget.height, 0.5],
    ])
    const dockCenterX = circuit.affine([
      [dockTarget.left, 1],
      [dockTarget.width, 0.5],
    ])
    const dockCenterY = circuit.affine([
      [dockTarget.top, 1],
      [dockTarget.height, 0.5],
    ])
    const target: Record<AnimationField, Wire> = {
      centerX: emitSelect(circuit, nextVisible[windowIndex]!, dockCenterX, visibleCenterX),
      centerY: emitSelect(circuit, nextVisible[windowIndex]!, dockCenterY, visibleCenterY),
      width: visibleTarget.width,
      height: visibleTarget.height,
      scale: nextVisible[windowIndex]!,
    }
    const hiddenAndAbsent = emitMultiply(
      circuit,
      emitComplement(circuit, cells.windows[windowIndex]!.present, unit),
      emitComplement(circuit, nextVisible[windowIndex]!, unit),
    )
    const direct = emitClampZeroOne(
      circuit,
      circuit.affine([
        [directManipulation[windowIndex]!, 1],
        [hiddenAndAbsent, 1],
      ]),
      unit,
    )
    // The 5 springs settle together. The steps simulate time before this
    // evaluation's events, so they pull toward the destinations that the previous
    // evaluation wrote back. Dragging, resizing, a hidden window that is no longer
    // drawn, and a snap that the host plans all land the window on its targets.
    const object = emitAnimatedObject(
      circuit,
      animationFields.map(field => ({
        matrix: cells.springMatrix,
        displacement: cells.springs[windowIndex]![field].displacement,
        velocity: cells.springs[windowIndex]![field].velocity,
        destination: target[field],
        destinationDuringSteps: cells.springs[windowIndex]![field].destination,
      })),
      {
        settleCheck: cells.settleCheck,
        snap: emitClampZeroOne(circuit, circuit.affine([[direct, 1], [cells.snap, 1]]), unit),
      },
    )
    const [centerXPosition, centerYPosition, widthPosition, heightPosition, scalePosition] =
      object.positions as [Wire, Wire, Wire, Wire, Wire]
    // Each spring's next displacement and velocity, and the destination that the
    // next evaluation's steps pull toward.
    const nextSpring = (springIndex: number, destination: Wire) =>
      ({displacement: object.displacements[springIndex]!, velocity: object.velocities[springIndex]!, destination})
    table.next(cells.springs[windowIndex]!, {
      centerX: nextSpring(0, target.centerX),
      centerY: nextSpring(1, target.centerY),
      width: nextSpring(2, target.width),
      height: nextSpring(3, target.height),
      scale: nextSpring(4, target.scale),
    })
    const width = emitClampDynamic(
      circuit,
      widthPosition,
      zero,
      cells.viewportWidth,
    )
    const height = emitClampDynamic(
      circuit,
      heightPosition,
      zero,
      cells.viewportHeight,
    )
    // Clamped only where drawn, e.g. a scale that undershoots 0 while springing
    // keeps its stored displacement.
    const scale = emitClampDynamic(circuit, scalePosition, zero, unit)
    const halfWidth = circuit.affine([[width, 0.5]])
    const halfHeight = circuit.affine([[height, 0.5]])
    const scaledHalfWidth = emitMultiply(circuit, halfWidth, scale)
    const scaledHalfHeight = emitMultiply(circuit, halfHeight, scale)
    const centerX = emitClampDynamic(
      circuit,
      centerXPosition,
      scaledHalfWidth,
      circuit.affine([[cells.viewportWidth, 1], [scaledHalfWidth, -1]]),
    )
    const centerY = emitClampDynamic(
      circuit,
      centerYPosition,
      scaledHalfHeight,
      circuit.affine([[cells.viewportHeight, 1], [scaledHalfHeight, -1]]),
    )
    windowAnimations.push({
      width,
      height,
      transform: {
        translateX: circuit.affine([
          [centerX, 1],
          [halfWidth, -1],
        ]),
        translateY: circuit.affine([
          [centerY, 1],
          [halfHeight, -1],
        ]),
        scale,
      },
      active: object.active,
    })
  }
  const windowAnimationActive = emitClampZeroOne(
    circuit,
    circuit.affine(windowAnimations.map(animation => [animation.active, 1])),
    unit,
  )
  const nextPresent = Array.from({length: windowCount}, (_, windowIndex) =>
    emitClampZeroOne(
      circuit,
      circuit.affine([
        [nextVisible[windowIndex]!, 1],
        [emitMultiply(
          circuit,
          cells.windows[windowIndex]!.present,
          windowAnimations[windowIndex]!.active,
        ), 1],
      ]),
      unit,
    ))

  table.next(cells.pointer, {x: pointerX, y: pointerY})
  // The stored table holds the identity matrix and no settle check or snap, so
  // evaluating it directly runs 0 steps.
  table.next(
    {springMatrix: cells.springMatrix, settleCheck: cells.settleCheck, snap: cells.snap},
    {springMatrix: [unit, zero, zero, unit], settleCheck: zero, snap: zero},
  )
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    table.next(cells.windows[windowIndex]!, {
      ...nextStoredGeometry[windowIndex]!,
      open: nextOpen[windowIndex]!,
      minimized: nextMinimized[windowIndex]!,
      maximized: nextMaximized[windowIndex]!,
      present: nextPresent[windowIndex]!,
    })
  }
  table.next(cells.drag, nextDrag)
  table.next(cells.resize, nextResize)
  table.next(cells.armed, {
    ...nextArmed,
    photosContent: nextArmedFor(armedPhotosContent),
    valueList: nextArmedFor(armedValueList),
    valueListLocation: armedValueListLocation.map(nextArmedFor),
  })
  table.next(cells.stack, nextStack)

  const windows: Wire[] = []
  const dockItems: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const animation = windowAnimations[windowIndex]!
    const stackTerms: [Wire, number][] = []
    for (let rank = 0; rank < windowCount; rank++) {
      stackTerms.push([nextStack[rank]![windowIndex]!, rank + 1])
    }
    stackTerms.push([animation.active, 40])
    windows.push(
      animation.transform.translateX,
      animation.transform.translateY,
      animation.width,
      animation.height,
      animation.transform.scale,
      nextPresent[windowIndex]!,
      focusedWindow[windowIndex]!,
      circuit.affine(stackTerms),
      nextMaximized[windowIndex]!,
      destinationContentWidth[windowIndex]!,
      destinationContentHeight[windowIndex]!,
      effectiveGeometry[windowIndex]!.width,
      effectiveGeometry[windowIndex]!.height,
    )
    const dock = dockGeometry[windowIndex]!
    dockItems.push(
      dock.left,
      dock.top,
      dock.width,
      dock.height,
      emitComplement(circuit, nextVisible[windowIndex]!, unit),
      focusedWindow[windowIndex]!,
      nextOpen[windowIndex]!,
    )
  }

  const photosWindowOutputStart = photosWindowIndex * windowOutputField.size
  const photosDestination = effectiveGeometry[photosWindowIndex]!
  // Photos takes a key only while focused, and a click only at a release over its
  // content after a press there. The machine writes Photos' click event at every up
  // that doesn't share an evaluation with a key, see receivePointer, so a click event
  // without a content click is blocked. Photos events that share an evaluation are
  // mutually exclusive, so a key sees only the focus bit.
  const photosFocused = windows[photosWindowOutputStart + windowOutputField.focused]!
  const photosClickBlocked = emitRelu(circuit, circuit.affine([[cells.photos.click.active, 1], [photosContentClick, -1]]))
  const photosInteractive = emitRelu(circuit, circuit.affine([[photosFocused, 1], [photosClickBlocked, -1]]))
  // Photos lays out, hit-tests and draws at the window's destination content size,
  // e.g. the maximized size from the press on, and not at the animated size. So
  // which photo a click lands on doesn't depend on spring timing, and neither does
  // how far a change of the open photo moves a thumbnail's spring, which keeps
  // stored state independent of frame times.
  const photos = buildPhotos(circuit, table, cells.photos, {
    viewportWidth: destinationContentWidth[photosWindowIndex]!,
    viewportHeight: destinationContentHeight[photosWindowIndex]!,
    // A click is at the up latch's point, in viewport coordinates, and Photos reads it
    // relative to the content box at the window's destination, like presses hit-test
    // window destinations. E.g. a click during a maximize lands on the photo that ends
    // up under the pointer. HandwiredOS leaves Photos' own click coordinate cells at 0.
    click: {
      x: circuit.affine([
        [cells.up.x, 1],
        [photosDestination.left, -1],
        [unit, -1],
      ]),
      y: circuit.affine([
        [cells.up.y, 1],
        [photosDestination.top, -1],
        [cells.titleHeight, -1],
        [unit, -1],
      ]),
    },
    present: windows[photosWindowOutputStart + windowOutputField.opacity]!,
    interactive: photosInteractive,
    unit,
    // The thumbnails, the zoom and the windows share stiffness and damping, so one
    // matrix serves all of them.
    springMatrix: cells.springMatrix,
    settleCheck: cells.settleCheck,
    snap: cells.snap,
  })
  const animationActive = emitClampZeroOne(
    circuit,
    circuit.affine([
      [windowAnimationActive, 1],
      [photos.animationActive, 1],
    ]),
    unit,
  )

  // Monitor's list is computed for the list viewport's height at the window's
  // destination, i.e. the content box without the header row and the footer, e.g.
  // the maximized height from the release of the maximize button on, so the rows
  // drawn change once per event, like Photos' layout. A release's y is relative to
  // the list's top edge in the rectangle that the release was hit-tested against,
  // Monitor's rectangle before this evaluation's events.
  const valueList = buildValueList(circuit, table, cells.valueList, {
    viewportHeight: emitRelu(circuit, circuit.affine([[destinationContentHeight[monitorWindowIndex]!, 1]], -monitorLayout.headerHeight - monitorLayout.footerHeight)),
    focused: focusedWindow[monitorWindowIndex]!,
    listClick: {
      active: valueListClick,
      y: circuit.affine([[cells.up.y, 1], [valueListTop, -1]]),
    },
    locationClicks: valueListLocationClick,
  })

  const {nextSource, initialSource, validate} = table.finish()
  const output: WindowManagerOutput = {nextSource, windows, dockItems, animationActive, photos, valueList}
  // Each cell's name and what happens to the cell around an evaluation, in table
  // order, e.g. {name: 'windows[2].left', policy: 'state'}. Monitor lists them.
  const sourceCells = Array.from({length: table.size}, (_, index) => {
    const cell = circuit.source(index)
    const policy = table.policyOf(cell)
    invariant(policy !== undefined, 'every source wire is a declared cell')
    return {name: table.nameOf(cell), policy}
  })
  return {circuit, cells, output, sourceCells, initialSource, validate}
}

// The wires of a flat output view with their names: 'prefix.item.field' for a view
// of several items, e.g. 'windows.0.translateX', and 'prefix.field' for a view of one
// item, e.g. 'photos.nextControl.left'. `fields` is the view's field table.
function nameOutputView(prefix: string, wires: readonly Wire[], fields: {readonly [field: string]: number}) {
  const fieldNames: string[] = []
  for (const [field, index] of Object.entries(fields)) {
    if (field !== 'size') fieldNames[index] = field
  }
  const single = wires.length === fieldNames.length
  return wires.map((wire, index) => ({
    wire,
    name: single
      ? `${prefix}.${fieldNames[index]}`
      : `${prefix}.${Math.floor(index / fieldNames.length)}.${fieldNames[index % fieldNames.length]}`,
  }))
}

// Every output that the page draws from, with its name, in the order of the
// compiled program's roots after the next-state values.
function nameWindowManagerOutputs(output: WindowManagerOutput) {
  const {photos, valueList} = output
  return [
    ...nameOutputView('windows', output.windows, windowOutputField),
    ...nameOutputView('dockItems', output.dockItems, dockOutputField),
    {wire: output.animationActive, name: 'animationActive'},
    {wire: photos.backdropOpacity, name: 'photos.backdropOpacity'},
    ...nameOutputView('photos.photos', photos.photos, photoField),
    ...nameOutputView('photos.thumbnails', photos.thumbnails, thumbnailField),
    ...nameOutputView('photos.previousControl', photos.previousControl, controlField),
    ...nameOutputView('photos.nextControl', photos.nextControl, controlField),
    {wire: valueList.totalHeight, name: 'valueList.totalHeight'},
    {wire: valueList.scroll, name: 'valueList.scroll'},
    {wire: valueList.scrollTarget, name: 'valueList.scrollTarget'},
    {wire: valueList.scrollRequest, name: 'valueList.scrollRequest'},
    {wire: valueList.slotOverflow, name: 'valueList.slotOverflow'},
    {wire: valueList.selected, name: 'valueList.selected'},
    ...valueList.locations.map((wire, location) => ({wire, name: `valueList.locations.${location}`})),
    ...nameOutputView('valueList.slots', valueList.slots, slotField),
  ]
}

type WindowManagerEvent = {
  kind:
    | 'mount'
    | 'resize'
    | 'pointer down'
    | 'pointer move'
    | 'pointer up'
    | 'pointer cancel'
    | 'photo previous'
    | 'photo next'
    | 'photo close'
    | 'photo page'
    | 'value list key'
  // Shares the time origin of requestAnimationFrame timestamps, e.g. event.timeStamp.
  timeStamp: number
  // Writes the event into the table: latches, or the viewport for a mount or resize.
  apply: (table: Float32Array) => void
}

type WindowManagerEvaluation = {
  kind: EvaluationKind
  timeMs: number
  steps: number
  writesBack: boolean
  events: WindowManagerEvent['kind'][]
}

type WindowManagerObserver = {
  // The table just before an evaluation, after the host wrote the matrix, the
  // bits and the events.
  beforeEvaluate?: (table: Float32Array, evaluation: PlannedEvaluation<WindowManagerEvent>) => void
  // The evaluated values, and the table: the stored table after write-back, or
  // the copy that a 'frame' evaluation ran on.
  afterEvaluate?: (
    values: Float32Array,
    table: Float32Array,
    evaluation: PlannedEvaluation<WindowManagerEvent>,
  ) => void
}

// With the default writeBack, 'events and settle checks', only evaluations that
// apply events, check settling or snap write state back, and a frame evaluates a
// copy of the table, so the stored table depends only on the timestamped events.
export function createWindowManagerMachine(options: {writeBack?: WriteBack} = {}) {
  const writeBack = options.writeBack ?? 'events and settle checks'
  const {circuit, cells, output, sourceCells, initialSource, validate} = buildWindowManager()
  const source = new Float32Array(initialSource)
  const wireCount = validateCircuit(circuit)
  validateWindowManagerOutputWires(output, wireCount)
  const namedOutputs = nameWindowManagerOutputs(output)
  const roots = [...output.nextSource, ...namedOutputs.map(({wire}) => wire)]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  // Monitor lists the program itself, so its three locations' row counts are the
  // program's own sizes: the source cells, the live operations and the outputs.
  // Values written before the first step commit with the mount.
  const valueListRowCounts = [tensorProgram.sourceSize, tensorProgram.valueCount - tensorProgram.sourceSize, namedOutputs.length]
  valueListRowCounts.forEach((rowCount, location) => {
    source[cells.valueList.rowCounts[location]!] = Math.min(rowCapacity, rowCount)
  })
  validateTensorProgram(circuit, tensorProgram)
  // Reuses its buffers across evaluations. Each evaluation copies the roots into
  // `values`, which the validators and callers index by wire.
  const evaluateRoots = circuit.createTensorProgramEvaluator(tensorProgram)
  const values = new Float32Array(wireCount)
  const scratch = new Float32Array(source.length)
  const numericTolerance = 1e-5
  let clock: SpringClock = stoppedSpringClock
  let queued: (Omit<WindowManagerEvent, 'timeStamp'> & {timeStamp: number | undefined})[] = []
  let mounted = false
  let queuedViewport: readonly [width: number, height: number] = [0, 0]
  // The scroll position of Monitor's list on the scroll grid, which evaluate() writes
  // into the table before every evaluation, like the spring matrix: the position
  // passed to the last step, or the position that an evaluation asked for since.
  let valueListScrollTop = 0
  // The position that the last step's evaluations asked the host to scroll
  // Monitor's list to, if any.
  let valueListScrollTo: number | null = null
  const observers: WindowManagerObserver[] = []
  const evaluations: WindowManagerEvaluation[] = []
  // The stored table as the last step left it. Only step() writes the stored table,
  // so a difference at the next step is a write from outside the machine.
  const storedAfterLastStep = Float32Array.from(source)

  function queue(
    kind: WindowManagerEvent['kind'],
    timeStamp: number | undefined,
    apply: (table: Float32Array) => void,
  ) {
    invariant(timeStamp === undefined || Number.isFinite(timeStamp), 'an event timestamp must be finite')
    const event = {kind, timeStamp, apply}
    // A mount applies before the events queued before the first step.
    if (kind === 'mount') queued.unshift(event)
    else queued.push(event)
  }

  // width and height are already on the 1/64 px grid and within the viewport
  // cells' range, see quantizeViewport.
  function queueViewport(kind: 'mount' | 'resize', width: number, height: number, timeStamp: number | undefined) {
    queuedViewport = [width, height]
    queue(kind, timeStamp, table => {
      table[cells.viewportWidth] = width
      table[cells.viewportHeight] = height
    })
  }

  // Rounds coordinates to 1/64 px and clamps them within ±32,768 px, as the program
  // declares, e.g. 100.001 becomes 100 and -50,000 becomes -32,768.
  function receivePointer(
    kind: 'pointer down' | 'pointer move' | 'pointer up' | 'pointer cancel',
    latch: {active: Wire, x: Wire, y: Wire},
    x: number,
    y: number,
    timeStamp: number | undefined,
  ) {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    const clampedX = Math.min(pointerCoordinateBound, Math.max(-pointerCoordinateBound, quantizePixels(x)))
    const clampedY = Math.min(pointerCoordinateBound, Math.max(-pointerCoordinateBound, quantizePixels(y)))
    queue(kind, timeStamp, table => {
      table[latch.active] = 1
      table[latch.x] = clampedX
      table[latch.y] = clampedY
      // A cancel writes the up latch and the cancel bit, see cells.cancel.
      if (kind === 'pointer cancel') table[cells.cancel] = 1
      // Every up is also a Photos click at the up's point, which Photos takes only
      // when the press armed Photos' content, see buildWindowManager. A key written
      // earlier in the same evaluation keeps its place, see writePhotoEvent.
      if (kind === 'pointer up' && photoEvents(cells.photos).every(field => table[field] === 0)) {
        table[cells.photos.click.active] = 1
      }
    })
  }

  // Photos events that share an evaluation are mutually exclusive, and a key takes
  // the place of a click. E.g. a key and an up at the same 1/64 ms timestamp, in either
  // order, deliver only the key: the up still ends a drag or acts on a window control,
  // but opens no photo. Among keys at one timestamp, the last one wins.
  function writePhotoEvent(table: Float32Array, field: Wire) {
    for (const eventField of photoEvents(cells.photos)) table[eventField] = 0
    table[field] = 1
  }

  function receivePhotoEvent(
    kind: 'photo previous' | 'photo next' | 'photo close',
    field: Wire,
    timeStamp: number | undefined,
  ) {
    queue(kind, timeStamp, table => writePhotoEvent(table, field))
  }

  // The cells that say a press is held: a drag, a resize, or an armed control.
  const heldPressCells = [
    ...cells.drag,
    ...cells.resize,
    ...cells.armed.close,
    ...cells.armed.minimize,
    ...cells.armed.maximize,
    ...cells.armed.dockItem,
    cells.armed.photosContent,
    cells.armed.valueList,
    ...cells.armed.valueListLocation,
  ]

  // While nothing animates and no press is held, a pointer move changes only the
  // stored pointer. So when every event of a frame is a pointer move, only the move
  // that advanceFrame would apply last runs, e.g. 4 hover samples take 1 evaluation
  // instead of 4, and the stored table after the frame is the same in every bit.
  // While something animates, each evaluation that writes back commits stepped
  // springs, and which evaluations run would change the springs' FP32 values, so every
  // move runs. While a press is held, a drag or a resize reads every move.
  function coalesceHoverMoves<Event extends {kind: WindowManagerEvent['kind'], timeStamp: number}>(events: Event[], frameTime: number) {
    if (clock.animatedUntilMs !== null || events.length < 2 || events.some(event => event.kind !== 'pointer move')) return events
    if (heldPressCells.some(cell => source[cell] !== 0)) return events
    // advanceFrame applies events in the order of their times on the time grid, clamped
    // to the frame's time, and in delivery order among equal times.
    const frameTimeMs = quantizeTimeMs(frameTime)
    const applyTime = (event: Event) => Math.min(frameTimeMs, quantizeTimeMs(event.timeStamp))
    return [events.reduce((latest, event) => applyTime(event) >= applyTime(latest) ? event : latest)]
  }

  // One evaluation that advanceFrame planned: write the matrix, the settle check
  // and snap bits and the events, evaluate, and write next state back when the
  // evaluation writes back.
  function evaluate(evaluation: PlannedEvaluation<WindowManagerEvent>) {
    const table = evaluation.writesBack ? source : scratch
    if (!evaluation.writesBack) scratch.set(source)
    table.set(springMatrixPowers[evaluation.steps]!, cells.springMatrix[0])
    table[cells.settleCheck] = evaluation.settleCheck ? 1 : 0
    table[cells.snap] = evaluation.snap ? 1 : 0
    // The scroll position has no timestamp: every evaluation reads the position
    // that the step was given, like a frame of ui.md's render loop reads scrollTop
    // once.
    table[cells.valueList.scrollTop] = valueListScrollTop
    for (const event of evaluation.events) event.apply(table)
    // Checks every declared range and grid. The window hit tests' integer bits rely
    // on the grids: a press written straight into the table at x = 54.5 - 1/256 px,
    // near window 0's left edge, put window 0 and the frontmost window each half in
    // front, before the grids were checked.
    validate(table)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    // The next-state values are the first roots. Only roots are written into
    // `values`, so the finite check covers the roots, not every wire.
    const nextSourceValues = rootValues.subarray(0, source.length)
    validate(nextSourceValues)
    assertFiniteValues(rootValues, 'tensor output')
    validateWindowManagerOutput(values, output, numericTolerance)
    if (evaluation.writesBack) source.set(nextSourceValues)
    // A scroll request comes from an event, e.g. a key that moves the selection out
    // of view, and the page only sees the frame's evaluation, which applies no
    // event. So the request is taken here: the step's later evaluations compute the
    // list at the requested position, and the host scrolls there after its DOM
    // writes.
    if (values[output.valueList.scrollRequest] === 1) {
      valueListScrollTop = values[output.valueList.scrollTarget]!
      valueListScrollTo = valueListScrollTop
    }
    evaluations.push({
      kind: evaluation.kind,
      timeMs: evaluation.timeMs,
      steps: evaluation.steps,
      writesBack: evaluation.writesBack,
      events: evaluation.events.map(event => event.kind),
    })
    for (const observer of observers) observer.afterEvaluate?.(values, table, evaluation)
    return values[output.animationActive]! > 0
  }

  return {
    circuit,
    cells,
    output,
    source,
    tensorProgram,
    // What Monitor lists. sourceCells holds each source cell's name and policy in
    // table order, and namedOutputs each output's wire and name in the order of the
    // program's roots after the next-state values, e.g. 'windows.0.translateX'.
    // After a step, `values` holds every root's value in the frame's evaluation,
    // indexed by wire, and packedValues the value of every source cell and live
    // operation in it, in the program's packed order, see
    // createTensorProgramEvaluator. step() returns `values`.
    sourceCells,
    namedOutputs,
    values,
    packedValues: evaluateRoots.packedValues,
    // A host requests frames while clock.animatedUntilMs isn't null.
    get clock() {
      return clock
    },
    // The evaluations of the last step, in order.
    evaluations: evaluations as readonly WindowManagerEvaluation[],
    // The scroll position that the last step asks the host to give the scroller of
    // Monitor's list, or null, e.g. after a key that moved the selection out of view.
    get valueListScrollTo() {
      return valueListScrollTo
    },
    observe(observer: WindowManagerObserver) {
      observers.push(observer)
    },
    // Runs the frame at frameTime, e.g. a requestAnimationFrame timestamp, and
    // returns the values of its 'frame' evaluation. The first step mounts the
    // viewport, and a later step whose viewport differs from the last queued one
    // queues a resize at frameTime. An event without a timestamp applies at this
    // frame's time. valueListScrollTopNow is the scrollTop of the scroller of
    // Monitor's list as the DOM reports it now, which the step floors onto the 1/4 px
    // grid and clamps to 0..2,400,000, e.g. a rubber-band's -12.3 becomes 0. Without
    // it, the list stays where the last step left it, at the position that the step
    // was given or that the step asked for, like a scroller that takes every
    // requested position. The returned values, indexed by wire, are the machine's own
    // array, which the next step overwrites, so a caller that keeps a frame's values
    // across steps copies them, e.g. with values.slice().
    step(
      viewportWidth: number,
      viewportHeight: number,
      frameTime: number,
      valueListScrollTopNow?: number,
    ) {
      invariant(Number.isFinite(frameTime) && frameTime >= 0, 'frame time must be nonnegative')
      if (valueListScrollTopNow !== undefined) valueListScrollTop = quantizeScrollTop(valueListScrollTopNow)
      valueListScrollTo = null
      // A value written straight into `source` between steps, e.g. a latch, would
      // apply only in 'frame' evaluations, which run on a copy, so it would never
      // commit, and a latch would apply again in every later frame. Values written
      // before the first step commit with the mount, e.g. a changed constant.
      if (mounted) {
        for (let field = 0; field < source.length; field++) {
          if (source[field] !== storedAfterLastStep[field]) {
            invariant(false, `source cell ${field} was written between steps. Queue input with the event methods instead, e.g. pointerDown(x, y, timeStamp) or resize(width, height, timeStamp)`)
          }
        }
      }
      const width = quantizeViewport(viewportWidth)
      const height = quantizeViewport(viewportHeight)
      if (!mounted) {
        mounted = true
        const earliest = queued.reduce((time, event) => Math.min(time, event.timeStamp ?? frameTime), frameTime)
        queueViewport('mount', width, height, earliest)
      } else if (width !== queuedViewport[0] || height !== queuedViewport[1]) {
        // The viewport sets destinations, so a change reaches the program as an
        // event. Written without one, it would change destinations only in frame
        // evaluations, which never start the clock.
        queueViewport('resize', width, height, frameTime)
      }
      const events = coalesceHoverMoves(queued.map(event => ({...event, timeStamp: event.timeStamp ?? frameTime})), frameTime)
      queued = []
      evaluations.length = 0
      clock = advanceFrame(clock, frameTime, events, evaluate, writeBack)
      storedAfterLastStep.set(source)
      return values
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', quantizeViewport(width), quantizeViewport(height), timeStamp)
    },
    pointerDown(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer down', cells.down, x, y, timeStamp)
    },
    pointerMove(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer move', cells.move, x, y, timeStamp)
    },
    // Also delivers the release to Photos as a click, see buildWindowManager.
    pointerUp(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer up', cells.up, x, y, timeStamp)
    },
    // A pointercancel, e.g. when the browser takes over a touch. Like pointerUp, it
    // ends a drag or a resize at its point, and it acts on no control.
    pointerCancel(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer cancel', cells.up, x, y, timeStamp)
    },
    photoPage(count: number, selected = -1, toolbarHeight = 0, timeStamp?: number) {
      invariant(Number.isInteger(count) && count >= 0 && count <= photoItemCount, 'invalid photo page size')
      invariant(Number.isInteger(selected) && selected >= -1 && selected < count, 'invalid photo page selection')
      invariant(Number.isFinite(toolbarHeight) && toolbarHeight >= 0 && toolbarHeight <= 64, 'invalid photo toolbar height')
      queue('photo page', timeStamp, table => {
        for (const field of photoEvents(cells.photos)) table[field] = 0
        table[cells.photos.toolbarHeight] = toolbarHeight
        for (let index = 0; index < photoItemCount; index++) {
          table[cells.photos.available[index]!] = index < count ? 1 : 0
          table[cells.photos.focus[index]!] = index === selected ? 1 : 0
          table[cells.photos.zoom.closedLast[index]!] = 0
          for (const field of Object.values(cells.photos.thumbnails[index]!)) table[field] = 0
        }
        table[cells.photos.zoom.openSpring] = 0
        for (const spring of cells.photos.zoom.springs) {
          table[spring.displacement] = 0; table[spring.velocity] = 0
        }
      })
    },
    photoPrevious(timeStamp?: number) {
      receivePhotoEvent('photo previous', cells.photos.previous, timeStamp)
    },
    photoNext(timeStamp?: number) {
      receivePhotoEvent('photo next', cells.photos.next, timeStamp)
    },
    photoClose(timeStamp?: number) {
      receivePhotoEvent('photo close', cells.photos.close, timeStamp)
    },
    // A key for Monitor's list, e.g. 'down' for ArrowDown, which the program takes
    // only while Monitor is the focused window. Among keys at one timestamp, the last
    // one delivered applies.
    valueListKey(key: ValueListKey, timeStamp?: number) {
      queue('value list key', timeStamp, table => {
        for (const cell of valueListKeys(cells.valueList)) table[cell] = 0
        table[cells.valueList.keys[key]] = 1
      })
    },
  }
}

// The keys that Monitor's list takes, by KeyboardEvent.key.
const valueListKeyNames = new Map<string, ValueListKey>([
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['PageUp', 'pageUp'],
  ['PageDown', 'pageDown'],
  ['Home', 'home'],
  ['End', 'end'],
])

// What a frame does to the keyboard focus of the note, Notes' text field: 'focus'
// and 'focus with the caret at the end' give it to the note, 'blur' takes it away,
// and null leaves it. The note's keyboard focus follows the focused window, like a
// text field in a window of a desktop:
// - While Notes isn't the focused window, the note has no keyboard focus. The frame
//   takes it away, e.g. after a press on another window, or after Notes was
//   minimized or closed, and the Tab key skips the note, see its tabIndex in
//   renderWindowManager.
// - A press or a release that leaves Notes the focused window gives the note the
//   keyboard focus, e.g. a press on Notes' title bar, the release that opens Notes
//   from the dock, or the release that closes the window in front of Notes. A press
//   in the text is the browser's own: it focuses the note and places the caret, and
//   the frame finds the note focused and leaves it alone. Otherwise the frame calls
//   focus(), which keeps the caret and the selection where they were.
// - The first keyboard focus that the note ever gets, when the frame gives it, comes
//   with the caret at the end of the text, 'focus with the caret at the end'. A text
//   field that never had the keyboard focus holds its caret before its first
//   character, so a letter typed after a press on Notes' title bar landed before the
//   note's first word, e.g. "xTODO: this week". Once the note has had the keyboard
//   focus, the caret or the selection is the visitor's, e.g. placed by a press in
//   the text or moved by an arrow key, and every later focus() keeps it.
//   "The note has had the keyboard focus" stands for "the visitor has placed a
//   caret", since every way to place one gives the note the keyboard focus first.
//   The two differ when the Tab key gives the note its first keyboard focus: the
//   browser puts the caret before the first character then, and a later focus()
//   keeps it there, although the visitor placed none. That takes a finger, a
//   keyboard and a mouse, e.g. on a laptop with a touch screen: a tap on Notes'
//   title bar, which makes Notes the focused window without a focus() call, see
//   below, then the Tab key, a mouse press on another window, and a mouse press on
//   Notes' title bar. Telling the two apart would take a record of every press in
//   the text and every key typed in the note, so the case is left as it is.
// - Except after a press outside every window, e.g. on the desk. The browser takes
//   the keyboard focus away there, as at a press outside a text field on any page,
//   and the frame leaves it so, while Notes stays the focused window.
// - And the frame calls focus() only after a press with a mouse. On a phone, focus()
//   from code can open the on-screen keyboard, e.g. while a finger drags Notes by its
//   title bar. So after a touch or a pen, only the browser focuses the note, at a
//   tap in the text.
// A frame without a press or a release never calls focus(), so the Tab key can move
// the keyboard focus away from the note.
/** @public */
export function noteFocusChange(frame: {
  notesIsFocusedWindow: boolean
  noteHasKeyboardFocus: boolean
  // Whether the note has had the keyboard focus at any time up to this frame, from
  // the browser, e.g. at a press in the text, or from an earlier frame.
  noteHasHadKeyboardFocus: boolean
  // Whether a press or a release happened since the last frame.
  pressedOrReleased: boolean
  // The last press: whether a mouse made it, and whether it was outside every window,
  // where Notes' dock item counts as a part of the Notes window.
  lastPress: {byMouse: boolean, outsideEveryWindow: boolean}
}): 'focus' | 'focus with the caret at the end' | 'blur' | null {
  if (!frame.notesIsFocusedWindow) return frame.noteHasKeyboardFocus ? 'blur' : null
  if (frame.noteHasKeyboardFocus || !frame.pressedOrReleased || !frame.lastPress.byMouse || frame.lastPress.outsideEveryWindow) return null
  return frame.noteHasHadKeyboardFocus ? 'focus' : 'focus with the caret at the end'
}

export function mountWindowManager(document: Document, window: Window, options: WindowManagerMountOptions = {}) {
  const arrange = options.arrange ?? arrangeInitialWindows
  const machine = createWindowManagerMachine()
  const desktop = document.querySelector<HTMLElement>('#desktop')
  const windows = [...document.querySelectorAll<HTMLElement>('.window')]
  const dockItems = [...document.querySelectorAll<HTMLElement>('.dock-item')]
  const photosViewport = document.querySelector<HTMLElement>('.photos-content')
  const monitorContent = document.querySelector<HTMLElement>('.monitor-content')
  const monitorFooter = document.querySelector<HTMLElement>('.monitor-footer')
  const note = document.querySelector<HTMLTextAreaElement>('.notes-text')
  const wiringCanvas = document.querySelector<HTMLCanvasElement>('.desk-wiring')
  invariant(desktop !== null, 'desktop is missing')
  invariant(windows.length === windowCount, 'window node count mismatch')
  invariant(dockItems.length === windowCount, 'dock item count mismatch')
  invariant(photosViewport !== null, 'Photos viewport is missing')
  invariant(monitorContent !== null, 'Monitor\'s content is missing')
  invariant(monitorFooter !== null, 'Monitor\'s footer is missing')
  invariant(note !== null, 'the note\'s text field is missing')
  invariant(wiringCanvas !== null, 'the desk\'s wiring canvas is missing')
  const windowContents = windows.map(element => {
    const content = element.querySelector<HTMLElement>('.window-content')
    invariant(content !== null, 'window content is missing')
    return content
  })
  const titleBars = windows.map(element => {
    const titleBar = element.querySelector<HTMLElement>('.titlebar')
    invariant(titleBar !== null, 'a title bar is missing')
    return titleBar
  })
  const domCache = {
    desktop, // mount lifetime
    windows, // mount lifetime
    titleBars, // mount lifetime
    windowContents, // mount lifetime
    dockItems, // mount lifetime
    photosViewport, // mount lifetime
    monitorContent, // mount lifetime
    // The note, Notes' whole content: the browser's own text field, which index.html
    // holds with its starting text. The browser edits, selects, wraps and scrolls
    // the text, and the program knows nothing of it. The page only moves the
    // keyboard focus, see noteFocusChange.
    note, // mount lifetime
  }
  const photos = createPhotoGalleryRenderer(document, domCache.photosViewport)
  // Monitor lists the program itself, one location per kind of number, each with
  // its value in the frame's evaluation. The rows' text stays in JavaScript, and
  // the program computes which rows the list's DOM slots show.
  const valueList = createValueListRenderer(document, domCache.monitorContent, [
    describeState(machine.sourceCells, machine.packedValues),
    describeOperations(machine.tensorProgram, machine.packedValues),
    describeOutputs(machine.namedOutputs, machine.values),
  ])
  // Monitor's footer, see monitor-footer.ts: the program's sizes, and the program's
  // time per frame over the last frames.
  const footer = createMonitorFooter(monitorFooter, machine.tensorProgram)

  domCache.desktop.style.setProperty('--title-height', `${machine.source[machine.cells.titleHeight]}px`)
  domCache.desktop.style.setProperty('--button-size', `${machine.source[machine.cells.buttonSize]}px`)
  domCache.desktop.style.setProperty('--button-gap', `${machine.source[machine.cells.buttonGap]}px`)
  domCache.desktop.style.setProperty('--resize-grip', `${machine.source[machine.cells.resizeGrip]}px`)
  domCache.desktop.style.setProperty(
    '--system-bar-height',
    `${machine.source[machine.cells.systemBarHeight]}px`,
  )
  // The desk's wallpaper, the program's weights as arcs, see wiring.ts. Its two
  // colors are the stylesheet's. The frame gives the canvas its rectangle and draws
  // the picture.
  const wiringStyle = window.getComputedStyle(wiringCanvas)
  const wiring = createWiringRenderer(
    wiringCanvas,
    machine.tensorProgram,
    {adds: wiringStyle.getPropertyValue('--copper').trim(), subtracts: wiringStyle.getPropertyValue('--wire-indigo').trim()},
    machine.source[machine.cells.systemBarHeight]!,
  )

  // The focused window in the last frame's outputs, or -1, for the keydown listener.
  let focusedWindowAtLastFrame = -1
  // Transient input for the note's keyboard focus, reset at the end of every frame:
  // the frame's last press, and whether a press was released. A press that the
  // browser cancels acts on no control, so it changes no window's focus.
  const events = {press: null as PointerEvent | null, released: false}
  // What the note's keyboard focus keeps of the last press, see noteFocusChange:
  // whether a mouse made it, and whether it was outside every window, e.g. on the
  // desk, as the browser hit-tested it.
  let lastPress = {byMouse: false, outsideEveryWindow: true}
  // Whether the note has had the keyboard focus so far, see noteFocusChange. Each
  // frame reads which element has the keyboard focus, and the focusin listener below
  // requests a frame whenever the keyboard focus arrives at an element, so the frame
  // after the browser gave the note the keyboard focus records it, e.g. after a
  // press in the text.
  let noteHasHadKeyboardFocus = false

  // How many more frames the page runs by itself after it loads. The chart in
  // Monitor's footer shows the program's time per frame over the last 60 frames,
  // each point an average of 10 frames, and a page that runs a frame only for an
  // input would open with a chart of one dot: the first frame, which takes about
  // 1.5 ms in Chrome where a later frame takes about 0.1 ms, since the browser hasn't
  // compiled the program's loops yet. So the page starts with as many frames as the
  // chart's points average, 69, after 3 more for the slow ones, which is 1.2 s at 60
  // frames a second. Each is a real frame with no input: it steps the machine,
  // writes the DOM and adds its time to the chart, so the chart is full of the
  // times of frames that ran. After them, a frame runs only for an input or while a
  // spring moves.
  let openingFramesLeft = monitorFrameCapacity + monitorAveragedFrames - 1 + 3

  let scheduledRaf: number | null = null
  // Callers waiting for the next frame to finish, see nextFrame in the returned handle.
  const frameWaiters: (() => void)[] = []
  function scheduleRender() {
    if (scheduledRaf !== null) return
    scheduledRaf = window.requestAnimationFrame(renderWindowManager)
  }

  // A frame in the order of chenguini's ui.md: DOM reads, the machine's step, DOM
  // writes, side effects, then scheduling the next frame.
  function renderWindowManager(frameTime: number) {
    scheduledRaf = null
    // DOM reads. The scroll position of Monitor's list and the keyboard focus are
    // browser state, which the frame reads like the viewport's size.
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const valueListScrollTop = valueList.readScrollTop()
    const noteHasKeyboardFocus = document.activeElement === domCache.note
    // Handle inputs. The pointer events are queued in the machine already. A note
    // that has the keyboard focus now has had it from now on, and a press since the
    // last frame replaces what the note's keyboard focus knows of the last one.
    if (noteHasKeyboardFocus) noteHasHadKeyboardFocus = true
    const pressedOrReleased = events.press !== null || events.released
    if (events.press !== null) {
      const {target} = events.press
      lastPress = {
        byMouse: events.press.pointerType === 'mouse',
        outsideEveryWindow: !(target instanceof Node)
          || !(domCache.dockItems[notesWindowIndex]!.contains(target) || domCache.windows.some(element => element.contains(target))),
      }
    }

    // The machine's step. The frame time that Monitor's footer shows is the time of
    // machine.step alone, i.e. of the program's evaluations.
    const executionStart = window.performance.now()
    const values = machine.step(viewportWidth, viewportHeight, frameTime, valueListScrollTop)
    const executionMs = window.performance.now() - executionStart
    focusedWindowAtLastFrame = -1
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      if (values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!] === 1) focusedWindowAtLastFrame = windowIndex
    }
    const notesIsFocusedWindow = focusedWindowAtLastFrame === notesWindowIndex
    // The cursors, from what the press holds in the program's table after the step's
    // events. While a title bar drags its window, the cursor is 'grabbing' on the
    // title bar and everywhere else on the desktop, e.g. where the window has stopped
    // at the workspace's edge and the pointer has gone on. While a grip resizes its
    // window, the cursor is the grip's everywhere. A press that drags nothing changes
    // no cursor, e.g. a press on a window button, or on the title bar of a maximized
    // window, which can't be dragged and whose title bar shows the default cursor.
    let draggedWindow = -1
    let resizing = false
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      if (machine.source[machine.cells.drag[windowIndex]!] === 1) draggedWindow = windowIndex
      if (machine.source[machine.cells.resize[windowIndex]!] === 1) resizing = true
    }

    // DOM writes.
    const wiringPending = wiring.render(viewportWidth, viewportHeight, frameTime)
    domCache.desktop.style.cursor = draggedWindow !== -1 ? 'grabbing' : resizing ? 'nwse-resize' : 'auto'
    projectWindowElements(domCache.windows, domCache.windowContents, values, machine.output.windows)
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const maximized = values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.maximized]!] === 1
      domCache.titleBars[windowIndex]!.style.cursor = maximized ? 'default' : windowIndex === draggedWindow ? 'grabbing' : 'grab'
    }
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      projectDockItem(domCache.dockItems[windowIndex]!, values, machine.output.dockItems, windowIndex * dockOutputField.size)
    }

    photos.render(values, machine.output.photos)
    // The Tab key reaches the note only while Notes is the focused window, e.g. not
    // while Notes is closed or minimized, or behind the window that has the focus.
    domCache.note.tabIndex = notesIsFocusedWindow ? 0 : -1
    valueList.render(values, machine.output.valueList)
    // The chart in Monitor's footer gets the time that the program took in this
    // frame, i.e. the time of machine.step. While Monitor sits in the dock, at
    // opacity 0, the chart keeps the frames' times and draws them when it's back.
    const monitorShown = values[machine.output.windows[monitorWindowIndex * windowOutputField.size + windowOutputField.opacity]!] !== 0
    footer.update(executionMs, monitorShown)

    // Side effects, after every DOM write. The note's keyboard focus follows the
    // focused window, see noteFocusChange. The focus call can't scroll a box: it
    // passes preventScroll, and the boxes around the note clip without a scroll
    // position. The caret is the browser's state like the keyboard focus, so the
    // frame writes it here too, before the focus call, which keeps it. The frame
    // that gives the note its first keyboard focus also records that the note has had
    // it, so the record doesn't depend on a later frame finding the note focused.
    switch (noteFocusChange({notesIsFocusedWindow, noteHasKeyboardFocus, noteHasHadKeyboardFocus, pressedOrReleased, lastPress})) {
      case 'focus with the caret at the end':
        domCache.note.setSelectionRange(domCache.note.textLength, domCache.note.textLength)
        domCache.note.focus({preventScroll: true})
        noteHasHadKeyboardFocus = true
        break
      case 'focus':
        domCache.note.focus({preventScroll: true})
        break
      case 'blur':
        domCache.note.blur()
        break
      case null:
        break
    }
    events.press = null
    events.released = false
    // The program asks for a scroll after a key that moved the selection of Monitor's
    // list out of view, and when the list shows another location. The scroll comes
    // after every DOM write, so the spacer already has its height and the browser
    // doesn't clamp the new position to an old height. The browser may still round
    // or clamp the position that it is given, and the next frame reads what the
    // browser kept, like any scroll. The host scrolls at no other time: a position
    // that the machine only clamped for its own cell, e.g. during a rubber-band, is
    // never written back.
    const valueListScrollTo = machine.valueListScrollTo
    if (valueListScrollTo !== null) valueList.scrollTo(valueListScrollTo)

    // Frames continue while springs are stepping, i.e. until an evaluation that
    // writes state back finds nothing animating, through the page's opening
    // frames, see openingFramesLeft, and while the wallpaper waits for its picture.
    if (openingFramesLeft > 0) openingFramesLeft--
    if (machine.clock.animatedUntilMs !== null || openingFramesLeft > 0 || wiringPending) scheduleRender()
    for (const resolve of frameWaiters.splice(0)) resolve()
  }

  // Each event carries its own timestamp, which shares the time origin of
  // requestAnimationFrame timestamps, so springs step to the event's time before
  // it applies, at any frame rate.
  //
  // The program has one pointer with one button. Only the primary button of the
  // primary pointer presses: a right-button press opens the browser's context menu
  // and sends no pointerup, so a title bar pressed with it would follow the pointer
  // with no button held, and a second finger's events would move and release the
  // first finger's drag.
  //
  // Another button's press on the note still makes Notes the focused window. The
  // browser gives the note the keyboard focus at a press of any button, e.g. of the
  // right button, whose menu then pastes into the note. If Notes weren't the focused
  // window, the frame would take the keyboard focus away under the open menu. So
  // such a press reaches the program as a press and a cancel at one time: the
  // program raises and focuses the window, and nothing is held afterwards.
  //
  // The note's keyboard focus follows every press of the primary pointer, whatever
  // the button: the browser moves the keyboard focus at a right button's press as
  // at a left button's, e.g. away from the note at a press on Notes' title bar or on
  // the desk. So the frame gets every press for noteFocusChange, also one that the
  // program doesn't get.
  window.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event.isPrimary) return
    events.press = event
    scheduleRender()
    if (event.button !== 0 && event.target !== domCache.note) return
    machine.pointerDown(event.clientX, event.clientY, event.timeStamp)
    if (event.button !== 0) machine.pointerCancel(event.clientX, event.clientY, event.timeStamp)
  })
  // A context menu takes the release of the press that opens it: the browser sends
  // no pointerup after it. On macOS a control-click opens the menu with the primary
  // button, whose press the listener above takes, so a control-click on a title bar
  // would drag the window with no button held. The menu's event ends the press like
  // a pointercancel. In Chrome the event names the kind of pointer that opened the
  // menu, and a touch's long press ends no press: the finger stays down and can
  // still drag.
  window.addEventListener('contextmenu', (event: MouseEvent) => {
    if ('pointerType' in event && event.pointerType !== 'mouse') return
    machine.pointerCancel(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('pointermove', (event: PointerEvent) => {
    if (!event.isPrimary) return
    // Chrome dispatches about one pointermove per frame, while the coalesced
    // samples keep their own timestamps, so which moves apply doesn't depend on
    // the frame rate.
    const samples = 'getCoalescedEvents' in event ? event.getCoalescedEvents() : []
    for (const sample of samples.length > 0 ? samples : [event]) {
      machine.pointerMove(sample.clientX, sample.clientY, sample.timeStamp)
    }
    scheduleRender()
  })
  // pointerUp also delivers the release to Photos as a click, in the up's evaluation,
  // and the program decides whether the release is a Photos click, see
  // buildWindowManager. The page listens for no DOM click: Chrome fires click at the
  // nearest element that contains both the pointerdown's and the pointerup's targets,
  // so a listener on the drawn .photos-content misses a release at a photo's
  // destination that the growing frame doesn't cover yet, and a listener on window
  // also gets the click after a drag or a resize.
  // A pointerup's button is the last button released, e.g. the right button when
  // both were held, so every pointerup of the primary pointer ends the press.
  window.addEventListener('pointerup', (event: PointerEvent) => {
    if (!event.isPrimary) return
    machine.pointerUp(event.clientX, event.clientY, event.timeStamp)
    events.released = true
    scheduleRender()
  })
  window.addEventListener('pointercancel', (event: PointerEvent) => {
    if (!event.isPrimary) return
    machine.pointerCancel(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    // A key goes to one receiver. A key typed into the note is the browser's, e.g.
    // ArrowDown moves the note's caret and never the selection of Monitor's list,
    // ArrowLeft never turns Photos' pages, and Escape closes no photo.
    if (event.target === domCache.note) return
    // A key held with Command, Control or Alt is the browser's or the system's too,
    // e.g. Command with ArrowLeft and Alt with ArrowLeft go back in the history.
    // Taken as Photos' ArrowLeft, with its default prevented, such a key would turn
    // a page of Photos instead.
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Every other key is queued for the program, which gives a list key to Monitor
    // and an arrow or Escape to Photos only while that window is focused at the key's
    // time. E.g. after a press on Notes' title bar earlier in the same frame, the note
    // doesn't have the keyboard focus yet, so ArrowDown arrives here, and the program
    // drops it, since Notes is the focused window at the key's time.
    let keyWindowIndex = photosWindowIndex
    const valueListKey = valueListKeyNames.get(event.key)
    if (valueListKey !== undefined) {
      machine.valueListKey(valueListKey, event.timeStamp)
      keyWindowIndex = monitorWindowIndex
    } else {
      switch (event.key) {
        case 'ArrowLeft':
          machine.photoPrevious(event.timeStamp)
          break
        case 'ArrowRight':
          machine.photoNext(event.timeStamp)
          break
        case 'Escape':
          machine.photoClose(event.timeStamp)
          break
        default:
          return
      }
    }
    // The program takes the key at the key's own time, when the key's window is
    // focused then, e.g. after a press earlier in the same frame. The browser's
    // default action, e.g. scrolling the list by a row for ArrowDown, has to be
    // prevented now, so that decision comes from the focus that the last frame drew.
    if (focusedWindowAtLastFrame === keyWindowIndex) event.preventDefault()
    scheduleRender()
  })
  // Scrolling Monitor's list moves its rows on the compositor. The frame reads the
  // new position and gives the DOM slots their rows. Scroll events don't bubble,
  // so the listener captures. It listens on Monitor's content alone: the note's own
  // scrolling needs no frame.
  domCache.monitorContent.addEventListener('scroll', () => scheduleRender(), true)
  // The keyboard focus can arrive at the note without a press, e.g. from a screen
  // reader, and the frame decides whether the note keeps it.
  window.addEventListener('focusin', () => scheduleRender())
  window.addEventListener('resize', (event: Event) => {
    // The viewport sets destinations, so a resize reaches the program as an event
    // at its own time.
    machine.resize(
      document.documentElement.clientWidth,
      document.documentElement.clientHeight,
      event.timeStamp,
    )
    scheduleRender()
  })
  // The windows' first rectangles are chosen for the viewport, and written before
  // the first step, so they commit with the mount, see arrangement.ts. The viewport
  // is clamped like the first step clamps the size that it reads, e.g. to 16,384 px
  // on a display wider than that, so the windows are arranged in the viewport that
  // the program lays out.
  arrange(
    machine.source,
    machine.cells,
    quantizeViewport(document.documentElement.clientWidth),
    quantizeViewport(document.documentElement.clientHeight),
  )
  renderWindowManager(window.performance.now())

  // What the page's other code may reach, e.g. Prism OS's command center, which queues
  // pointer and key events into the machine like the listeners above and waits for the
  // frames that apply them.
  return {
    machine,
    setPhotoItems: (items: Parameters<typeof photos.setItems>[0]) => photos.setItems(items),
    // Requests a frame and resolves after it ran.
    nextFrame() {
      return new Promise<void>(resolve => {
        frameWaiters.push(resolve)
        scheduleRender()
      })
    },
  }
}

// The values that each element was last given, so that a frame writes only the style
// properties whose values changed, e.g. while one window springs, the other two get no
// writes. Keyed by the element, NaN until the first write. Only this file writes these
// properties, so what was written last is what the element has.
const projectedValues = new WeakMap<HTMLElement, Float64Array>()
function projectedValuesOf(element: HTMLElement, count: number) {
  let projected = projectedValues.get(element)
  if (projected === undefined) {
    projected = new Float64Array(count).fill(Number.NaN)
    projectedValues.set(element, projected)
  }
  return projected
}

// Whether `value` differs from the value in `slot` of `last`, which it then becomes.
function takeChange(last: Float64Array, slot: number, value: number) {
  if (Object.is(last[slot], value)) return false
  last[slot] = value
  return true
}

// A frame's values in the order projectWindowElements keeps them.
const frameSlot = {width: 0, height: 1, translateX: 2, translateY: 3, scale: 4, opacity: 5, stack: 6, focused: 7, maximized: 8, size: 9}

// Writes each window's outputs into its frame element and its .window-content
// element. The frame is drawn at the animated size, position and scale, and clips
// the content box, which takes the window's destination size as soon as an event
// changes the destination. So content that the browser lays out, e.g. the note's
// text, wraps once per destination change, instead of at every in-between frame size.
export function projectWindowElements(
  frames: readonly HTMLElement[],
  contents: readonly HTMLElement[],
  values: Float32Array,
  output: readonly Wire[],
) {
  invariant(frames.length === windowCount && contents.length === windowCount, 'window element count mismatch')
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const frame = frames[windowIndex]!
    const content = contents[windowIndex]!
    const outputStart = windowIndex * windowOutputField.size
    const read = (field: number) => values[output[outputStart + field]!]!
    const last = projectedValuesOf(frame, frameSlot.size)
    const width = read(windowOutputField.width)
    if (takeChange(last, frameSlot.width, width)) frame.style.width = `${width}px`
    const height = read(windowOutputField.height)
    if (takeChange(last, frameSlot.height, height)) frame.style.height = `${height}px`
    // Three values in one property. Each comparison runs, so each slot takes its value.
    const translateX = read(windowOutputField.translateX)
    const translateY = read(windowOutputField.translateY)
    const scale = read(windowOutputField.scale)
    const movedX = takeChange(last, frameSlot.translateX, translateX)
    const movedY = takeChange(last, frameSlot.translateY, translateY)
    const scaled = takeChange(last, frameSlot.scale, scale)
    if (movedX || movedY || scaled) frame.style.transform = `translate3d(${translateX}px,${translateY}px,0) scale(${scale})`
    // The opacity output is 0 or 1: 0 once a closed or minimized window has landed
    // in the dock. A window at opacity 0 also gets visibility: hidden, so that the Tab
    // key skips what the window holds, e.g. the scroller of Monitor's list. At opacity
    // 0 alone, the Tab key gave the keyboard focus to a scroller that nobody sees.
    const opacity = read(windowOutputField.opacity)
    if (takeChange(last, frameSlot.opacity, opacity)) {
      frame.style.opacity = `${opacity}`
      frame.style.visibility = opacity === 0 ? 'hidden' : 'visible'
    }
    const stack = read(windowOutputField.stack)
    if (takeChange(last, frameSlot.stack, stack)) frame.style.zIndex = `${10 + stack}`
    const focused = read(windowOutputField.focused)
    if (takeChange(last, frameSlot.focused, focused)) frame.style.setProperty('--focused', `${focused}`)
    const maximized = read(windowOutputField.maximized)
    if (takeChange(last, frameSlot.maximized, maximized)) frame.style.setProperty('--maximized', `${maximized}`)
    // handwired-os.css gives .window-content its top and left only, so the box
    // takes its whole size from these two writes.
    const contentLast = projectedValuesOf(content, 2)
    const contentWidth = read(windowOutputField.contentWidth)
    if (takeChange(contentLast, 0, contentWidth)) content.style.width = `${contentWidth}px`
    const contentHeight = read(windowOutputField.contentHeight)
    if (takeChange(contentLast, 1, contentHeight)) content.style.height = `${contentHeight}px`
  }
}

// Writes a dock item's outputs, only those that changed: its rectangle, and the three
// custom properties that handwired-os.css draws it with.
const dockProperties = [['--inactive', 'inactive'], ['--focused', 'focused'], ['--open', 'open']] as const
function projectDockItem(
  element: HTMLElement,
  values: Float32Array,
  output: readonly Wire[],
  outputStart: number,
) {
  const last = projectedValuesOf(element, geometryFields.length + dockProperties.length)
  geometryFields.forEach((geometryField, slot) => {
    const value = values[output[outputStart + dockOutputField[geometryField]]!]!
    if (takeChange(last, slot, value)) element.style[geometryField] = `${value}px`
  })
  dockProperties.forEach(([property, field], index) => {
    const value = values[output[outputStart + dockOutputField[field]]!]!
    if (takeChange(last, geometryFields.length + index, value)) element.style.setProperty(property, `${value}`)
  })
}

function emitFrontmost(
  circuit: Circuit,
  stack: readonly (readonly Wire[])[],
  candidates: readonly Wire[],
  unit: Wire,
) {
  const selectedRank = Array<Wire>(windowCount)
  let remaining = unit
  for (let rank = windowCount - 1; rank >= 0; rank--) {
    const terms: [Wire, number][] = []
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      terms.push([
        emitMultiply(circuit, stack[rank]![windowIndex]!, candidates[windowIndex]!),
        1,
      ])
    }
    const rankHit = emitClampZeroOne(circuit, circuit.affine(terms), unit)
    selectedRank[rank] = emitMultiply(circuit, remaining, rankHit)
    remaining = emitRelu(circuit, circuit.affine([[remaining, 1], [rankHit, -1]]))
  }
  const selectedWindow: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const terms: [Wire, number][] = []
    for (let rank = 0; rank < windowCount; rank++) {
      terms.push([
        emitMultiply(circuit, stack[rank]![windowIndex]!, selectedRank[rank]!),
        1,
      ])
    }
    selectedWindow.push(emitClampZeroOne(circuit, circuit.affine(terms), unit))
  }
  return selectedWindow
}

// 1 when the point lies at least half a pixel inside the rectangle, otherwise 0.
// Each edge distance, e.g. x - left, is compared with 0.5 by emitCompare. The
// point and the geometry are declared on 1/64 px grids, so each comparison is an
// integer bit: 13 operations in 4 layers per rectangle once the edges exist, and
// rectangles that share an edge, e.g. a window and its title bar, share that
// edge's bit.
// The 4 bits combine as relu(sum - 3), which is 1 only when all 4 are 1.
function emitRectangleHit(
  circuit: Circuit,
  x: Wire,
  y: Wire,
  geometry: Geometry,
) {
  const half = circuit.constant(0.5)
  const edgeBits = [
    circuit.affine([[x, 1], [geometry.left, -1]]),
    circuit.affine([[geometry.left, 1], [geometry.width, 1], [x, -1]]),
    circuit.affine([[y, 1], [geometry.top, -1]]),
    circuit.affine([[geometry.top, 1], [geometry.height, 1], [y, -1]]),
  ].map(distance => emitCompare(circuit, distance, '>=', half))
  const hit = circuit.reglu([], 1, edgeBits.map(bit => [bit, 1] as [Wire, number]), -3)
  circuit.assumeRange(hit, 0, 1)
  return hit
}

// The same rule as emitRectangleHit, as boolean(clamp01(min of the 4 edge
// distances)), 16 operations in 9 layers per rectangle. The dock's layout divides
// the width that its 3 items share by 3, which lies on no grid, so emitCompare
// would build a sign cascade for each edge instead of an integer bit.
function emitDockItemHit(
  circuit: Circuit,
  x: Wire,
  y: Wire,
  geometry: Geometry,
  unit: Wire,
) {
  const score = emitClampZeroOne(
    circuit,
    emitMinimum(
      circuit,
      emitIntervalDistance(circuit, x, geometry.left, geometry.width),
      emitIntervalDistance(circuit, y, geometry.top, geometry.height),
    ),
    unit,
  )
  return circuit.boolean(score)
}

// 1 when every bit is 1, otherwise 0, as relu(sum of bits - (count - 1)), e.g. a
// release, while armed, over the armed control.
function emitAll(circuit: Circuit, bits: readonly Wire[]) {
  const all = circuit.reglu([], 1, bits.map(bit => [bit, 1] as [Wire, number]), 1 - bits.length)
  circuit.assumeRange(all, 0, 1)
  return all
}

function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// The nearest multiple of pixelGrid, e.g. 54.495 becomes 54.5. A viewport size,
// e.g. clientWidth, is a whole number and stays the same.
function quantizePixels(value: number) {
  invariant(Number.isFinite(value), 'a pixel coordinate or size must be finite')
  return Math.round(value / pixelGrid) * pixelGrid
}

// A viewport size on the 1/64 px grid, clamped into the viewport cells' range, e.g.
// 20,000 becomes 16,384. A browser can report more than 16,384 CSS px, e.g. an 8K
// display at 25% zoom, and a value outside a cell's range fails the table check
// before every later evaluation too, since the queued event never commits.
export function quantizeViewport(value: number) {
  return Math.min(pixel[1], Math.max(pixel[0], quantizePixels(value)))
}

// A scroll position floored onto the scroll grid and clamped into the scrollTop
// cell's range, e.g. 1000.6 becomes 1000.5, and -12.3, which a browser can report
// while the scroller rubber-bands past its top, becomes 0. Flooring keeps the
// first row in view the one that the browser shows.
function quantizeScrollTop(value: number) {
  invariant(Number.isFinite(value), 'a scroll position must be finite')
  return Math.min(maximumScrollTop, Math.max(0, Math.floor(value / scrollGrid) * scrollGrid))
}

function emitClampDynamic(circuit: Circuit, value: Wire, minimum: Wire, maximum: Wire) {
  return emitMinimum(circuit, emitMaximum(circuit, value, minimum), maximum)
}

function emitComplement(circuit: Circuit, value: Wire, unit: Wire) {
  return circuit.affine([[unit, 1], [value, -1]])
}

function validateWindowManagerOutputWires(output: WindowManagerOutput, wireCount: number) {
  validateWireView(output.windows, windowCount * windowOutputField.size, wireCount)
  validateWireView(output.dockItems, windowCount * dockOutputField.size, wireCount)
  validateWireView([output.animationActive], 1, wireCount)
  validatePhotoGalleryOutputWires(output.photos, wireCount)
  validateValueListOutputWires(output.valueList, wireCount)
}

function validateWindowManagerOutput(
  values: Float32Array,
  output: WindowManagerOutput,
  tolerance = 1e-9,
) {
  validatePhotoGalleryOutput(values, output.photos, tolerance)
  validateValueListOutput(values, output.valueList)
  assertUnitInterval(values[output.animationActive], 'animation active', tolerance)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * windowOutputField.size
    for (const field of [
      windowOutputField.width,
      windowOutputField.height,
      windowOutputField.contentWidth,
      windowOutputField.contentHeight,
      windowOutputField.destinationWidth,
      windowOutputField.destinationHeight,
    ]) {
      assertNonNegativeFinite(
        values[output.windows[outputStart + field]!],
        'projected window geometry',
        tolerance,
      )
    }
    for (const field of [
      windowOutputField.scale,
      windowOutputField.opacity,
      windowOutputField.focused,
      windowOutputField.maximized,
    ]) {
      assertUnitInterval(
        values[output.windows[outputStart + field]!],
        'projected window flag',
        tolerance,
      )
    }
    for (const field of [windowOutputField.translateX, windowOutputField.translateY]) {
      invariant(
        Number.isFinite(values[output.windows[outputStart + field]!]),
        'projected window translation must be finite',
      )
    }
    assertNonNegativeFinite(
      values[output.windows[outputStart + windowOutputField.stack]!],
      'projected stack',
      tolerance,
    )
  }
  // Photos reads the Photos window's focus bit as whether Photos takes events.
  const photosFocused = values[output.windows[photosWindowIndex * windowOutputField.size + windowOutputField.focused]!]
  invariant(photosFocused === 0 || photosFocused === 1, `Photos interactive must equal zero or one, got ${photosFocused}`)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * dockOutputField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(
        values[output.dockItems[outputStart + dockOutputField[field]]!],
        'projected dock geometry',
        tolerance,
      )
    }
    for (const field of [
      dockOutputField.inactive,
      dockOutputField.focused,
      dockOutputField.open,
    ]) {
      assertUnitInterval(
        values[output.dockItems[outputStart + field]!],
        'projected dock flag',
        tolerance,
      )
    }
  }
}
