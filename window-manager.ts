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
} from './numeric-ui-core.ts'
import {
  type EvaluationKind,
  type PlannedEvaluation,
  type SpringClock,
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  quantizeTimeMs,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from './host-timing.ts'
import {
  type PhotoOutputs,
  buildPhotos,
  createPhotoGalleryRenderer,
  photoCells,
  photoEvents,
  springConstants,
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
} from './cells.ts'
import {type NotesOutputs, bandOutputField, buildNotes, notesCells, notesWindowIndex, wordOutputField} from './notes.ts'
import type {FastParagraph} from './notes-walker.ts'
import {
  type NotesOptions,
  defaultLineFitEpsilon,
  defaultNotesParagraph,
  lineFitEpsilonFor,
  measureNotesParagraph,
  notesOptionsFor,
  notesWords,
} from './notes-paragraph.ts'

export {bandOutputField, notesWindowIndex, wordOutputField}

export const windowCount = 4

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
// geometry eligible for gather lowering (see lab/gather-lowering); a range
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
  [54, 54, 520, 340],
  [410, 104, 500, 366],
  [174, 344, 470, 300],
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

// The cells for a machine whose Notes paragraph is `paragraph`. Notes' cells come
// last, so every other cell keeps its position whatever the paragraph's widths.
const windowManagerCellsFor = (paragraph: FastParagraph) => ({
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
  // Window geometry is clamped to the viewport every frame before writeback,
  // so the viewport ceiling is honest for the stored state as well. Pointer
  // deltas and clamps against the viewport and the constants keep it on the
  // 1/64 px grid.
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
  // or maximize button, a window's dock item, or Photos' content. At most one is 1,
  // see buildWindowManager.
  armed: {
    close: list(windowCount, () => stateBit(0, {grid: 1})),
    minimize: list(windowCount, () => stateBit(0, {grid: 1})),
    maximize: list(windowCount, () => stateBit(0, {grid: 1})),
    dockItem: list(windowCount, () => stateBit(0, {grid: 1})),
    photosContent: stateBit(0, {grid: 1}),
  },
  // The stacking state is a permutation matrix: exactly one window per rank
  // and exactly one rank per window. Declared as one-hot groups, the
  // frontmost-window selection sums lower to gather reads (see lab/gather-lowering).
  stack: permutation(list(windowCount, windowIndex => windowIndex), {grid: 1}),
  // The destinations written back are this evaluation's targets. A center can
  // sit a little outside the viewport, e.g. a dock item in a 2 px wide viewport
  // is centered at -4.8e-7 px after FP32 rounds a third, so centers get
  // -16,384..32,768.
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
  photos: photoCells,
  notes: notesCells(paragraph),
})

// The cell positions under their earlier names, e.g. sourceField.downX is the
// position of down.x, and windowStateField.top is the index of top within one
// window's cells. Every paragraph has the segment count of the default one, see
// createWindowManagerMachine, so the positions hold for every machine.
const windowManagerCells = windowManagerCellsFor(defaultNotesParagraph)
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
  size: layout.size,
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
  notesStart: positions.notes.widths[0]!,
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
// while a press on Files' close button is held, and armedSourceField('photosContent')
// holds 1 while a press on Photos' content is held.
export function armedSourceField(control: 'close' | 'minimize' | 'maximize' | 'dockItem' | 'photosContent', windowIndex = photosWindowIndex) {
  if (control === 'photosContent') {
    invariant(windowIndex === photosWindowIndex, 'only Photos has an armed content bit')
    return positions.armed.photosContent
  }
  return cellAt(positions.armed[control], windowIndex, `${control} window index`)
}

export function stackSourceField(rank: number, windowIndex: number) {
  return cellAt(cellAt(positions.stack, rank, 'stack rank'), windowIndex, 'stack window index')
}

export function photoFocusSourceField(item: number) {
  return cellAt(positions.photos.focus, item, 'photo index')
}

export function photoThumbnailSpringSourceField(item: number, field: number) {
  return cellAt(
    Object.values(cellAt(positions.photos.thumbnails, item, 'photo index')),
    field,
    'photo thumbnail spring field',
  )
}

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
  notes: NotesOutputs
}

function buildWindowManager(notesOptions: NotesOptions) {
  const table = createSourceTable()
  const cells = table.declare(windowManagerCellsFor(notesOptions.paragraph))
  table.atMostOne('photos events', photoEvents(cells.photos))
  table.atMostOne('armed control', [
    ...cells.armed.close,
    ...cells.armed.minimize,
    ...cells.armed.maximize,
    ...cells.armed.dockItem,
    cells.armed.photosContent,
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
  const currentNormalGeometry: Geometry[] = []
  const currentOpen: Wire[] = []
  const currentMinimized: Wire[] = []
  const currentMaximized: Wire[] = []
  const currentPresent: Wire[] = []
  const currentVisible: Wire[] = []
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

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const normalGeometry = {
      left: cells.windows[windowIndex]!.left,
      top: cells.windows[windowIndex]!.top,
      width: cells.windows[windowIndex]!.width,
      height: cells.windows[windowIndex]!.height,
    }
    currentNormalGeometry.push(normalGeometry)
    const open = cells.windows[windowIndex]!.open
    const minimized = cells.windows[windowIndex]!.minimized
    const maximized = cells.windows[windowIndex]!.maximized
    const present = cells.windows[windowIndex]!.present
    currentOpen.push(open)
    currentMinimized.push(minimized)
    currentMaximized.push(maximized)
    currentPresent.push(present)
    const visible = emitMultiply(circuit, open, emitComplement(circuit, minimized, unit))
    currentVisible.push(visible)
    const geometry = {
      left: emitSelect(circuit, maximized, normalGeometry.left, maximumGeometry.left),
      top: emitSelect(circuit, maximized, normalGeometry.top, maximumGeometry.top),
      width: emitSelect(circuit, maximized, normalGeometry.width, maximumGeometry.width),
      height: emitSelect(circuit, maximized, normalGeometry.height, maximumGeometry.height),
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

  const currentStack = Array.from({length: windowCount}, (_, rank) =>
    Array.from({length: windowCount}, (_, windowIndex) =>
      cells.stack[rank]![windowIndex]!))
  const selectedCanvas = emitFrontmost(circuit, currentStack, windowHit, unit)

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
  // resizing start at the press. The window buttons, the dock items and Photos'
  // content act on release, like native buttons: a press over a control arms it, a
  // release over the armed control acts, and a release anywhere else, or a
  // pointercancel, acts on nothing. The path between the press and the release
  // doesn't matter, e.g. a press on Files' close button that moves off the button and
  // back, then releases over the button, closes Files. This differs from
  // lab/ui-exploration/indirect-os-2, where a press that moves more than 4 px away
  // from where it started acts on nothing, even when the pointer comes back.
  //
  // A release is tested against the stored geometry, like a press, e.g. the window's
  // destination during an animation. The armed button's window is frontmost from the
  // press on, so a release over that window's button is over no other window.
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
    const normalWindow = emitComplement(circuit, currentMaximized[windowIndex]!, unit)
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
  const photosGripAtUp = emitAll(circuit, [photosGripHitAtUp, emitComplement(circuit, currentMaximized[photosWindowIndex]!, unit)])
  const photosContentClick = emitAll(circuit, [
    release,
    armedPhotosContent,
    photosContentHitAtUp,
    emitComplement(circuit, photosGripAtUp, unit),
  ])

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

  const nextNormalGeometry: Geometry[] = []
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

    const current = currentNormalGeometry[windowIndex]!
    const widthCandidate = circuit.affine([
      [current.width, 1],
      [emitMultiply(circuit, resizeForMotion, deltaX), 1],
    ])
    const heightCandidate = circuit.affine([
      [current.height, 1],
      [emitMultiply(circuit, resizeForMotion, deltaY), 1],
    ])
    const width = emitClampDynamic(
      circuit,
      widthCandidate,
      emitMinimum(circuit, cells.minWidth, cells.viewportWidth),
      cells.viewportWidth,
    )
    const height = emitClampDynamic(
      circuit,
      heightCandidate,
      emitMinimum(circuit, cells.minHeight, workspaceHeight),
      workspaceHeight,
    )
    const maximumLeft = emitRelu(circuit, circuit.affine([
      [cells.viewportWidth, 1],
      [width, -1],
    ]))
    const maximumTop = emitRelu(circuit, circuit.affine([
      [dockTop, 1],
      [height, -1],
    ]))
    const left = emitClampDynamic(
      circuit,
      circuit.affine([
        [current.left, 1],
        [emitMultiply(circuit, dragForMotion, deltaX), 1],
      ]),
      zero,
      maximumLeft,
    )
    const top = emitClampDynamic(
      circuit,
      circuit.affine([
        [current.top, 1],
        [emitMultiply(circuit, dragForMotion, deltaY), 1],
      ]),
      workspaceTop,
      maximumTop,
    )
    nextNormalGeometry.push({left, top, width, height})

    const afterClose = emitSelect(
      circuit,
      closeClick[windowIndex]!,
      currentOpen[windowIndex]!,
      zero,
    )
    nextOpen.push(emitSelect(circuit, dockClick[windowIndex]!, afterClose, unit))
    const afterMinimize = emitSelect(
      circuit,
      minimizeClick[windowIndex]!,
      currentMinimized[windowIndex]!,
      unit,
    )
    const afterDock = emitSelect(circuit, dockClick[windowIndex]!, afterMinimize, zero)
    nextMinimized.push(emitSelect(circuit, closeClick[windowIndex]!, afterDock, zero))
    const toggledMaximized = circuit.affine([
      [currentMaximized[windowIndex]!, 1],
      [emitMultiply(
        circuit,
        maximizeClick[windowIndex]!,
        circuit.affine([[unit, 1], [currentMaximized[windowIndex]!, -2]]),
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
        emitMultiply(circuit, currentStack[rank]![windowIndex]!, selectedWindow[windowIndex]!),
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
              currentStack[sourceRank]![windowIndex]!,
            ),
            1,
          ])
        }
      }
      nextStack[rank]![windowIndex] = circuit.affine([
        [emitMultiply(
          circuit,
          selectionInactive,
          currentStack[rank]![windowIndex]!,
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
      emitComplement(circuit, currentPresent[windowIndex]!, unit),
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
          currentPresent[windowIndex]!,
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
      ...nextNormalGeometry[windowIndex]!,
      open: nextOpen[windowIndex]!,
      minimized: nextMinimized[windowIndex]!,
      maximized: nextMaximized[windowIndex]!,
      present: nextPresent[windowIndex]!,
    })
  }
  table.next(cells.drag, nextDrag)
  table.next(cells.resize, nextResize)
  table.next(cells.armed, {...nextArmed, photosContent: nextArmedFor(armedPhotosContent)})
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
  // content after a press there. The machine writes Photos' click event at every up,
  // see pointerUp, so a click event without a content click is blocked. Photos events
  // that share an evaluation are mutually exclusive, so a key sees only the focus bit.
  const photosFocused = windows[photosWindowOutputStart + windowOutputField.focused]!
  const photosClickBlocked = emitRelu(circuit, circuit.affine([[cells.photos.click.active, 1], [photosContentClick, -1]]))
  const photosInteractive = emitRelu(circuit, circuit.affine([[photosFocused, 1], [photosClickBlocked, -1]]))
  // Photos lays out, hit-tests and draws at the window's destination content size,
  // e.g. the maximized size from the press on, and not at the animated size. So
  // which photo a click lands on doesn't depend on spring timing, and the
  // thumbnail destinations change only at events, which keeps stored state
  // independent of frame times.
  const photos = buildPhotos(circuit, table, cells.photos, {
    viewportWidth: destinationContentWidth[photosWindowIndex]!,
    viewportHeight: destinationContentHeight[photosWindowIndex]!,
    // A click is at the up latch's point, in viewport coordinates, and Photos reads it
    // relative to the content box at the window's destination, like presses hit-test
    // window destinations. E.g. a click during a maximize lands on the photo that ends
    // up under the pointer. IndirectOS leaves Photos' own click coordinate cells at 0.
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
    // Thumbnails and windows share stiffness and damping, so one matrix serves both.
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

  // The Notes paragraph flows around the other windows' destination rectangles
  // while they're visible and stacked above Notes after this evaluation's events,
  // so it reflows once per event, like Photos lays out at its destination size.
  const notes = buildNotes(circuit, cells.notes, notesOptions, {
    unit,
    titleHeight: cells.titleHeight,
    windows: effectiveGeometry.map((destination, windowIndex) => ({destination, visible: nextVisible[windowIndex]!})),
    nextStack,
    contentHeight: destinationContentHeight[notesWindowIndex]!,
  })

  const {nextSource, initialSource, validate} = table.finish()
  const output: WindowManagerOutput = {nextSource, windows, dockItems, animationActive, photos, notes}
  return {circuit, cells, output, initialSource, validate}
}

// What the host writes into the 4 matrix cells for each step count, see
// advanceFrame in host-timing.ts.
const springStep = springStepMatrix(springConstants)
const springMatrixPowers = Array.from(
  {length: defaultSpringClockConfig.maxStepsPerFrame + 1},
  (_, steps) => springMatrixPower(springStep, steps),
)

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
//
// `notes` is the Notes paragraph's measurement and pretext's line fit epsilon, e.g.
// the browser's at mount, see measureNotesParagraph. The default is a baked
// measurement, so every process builds the same program. The paragraph must have
// the default's segments, since the exported cell positions come from the default;
// only the widths may differ.
export function createWindowManagerMachine(options: {writeBack?: WriteBack, notes?: {paragraph: FastParagraph, epsilon: number}} = {}) {
  const writeBack = options.writeBack ?? 'events and settle checks'
  const paragraph = options.notes?.paragraph ?? defaultNotesParagraph
  invariant(
    paragraph.widths.length === defaultNotesParagraph.widths.length
      && paragraph.breakAfter.every((bit, index) => bit === defaultNotesParagraph.breakAfter[index]),
    'the Notes paragraph must have the same segments as the default one; only the widths may differ',
  )
  const notesOptions = notesOptionsFor(paragraph, options.notes?.epsilon ?? defaultLineFitEpsilon)
  const {circuit, cells, output, initialSource, validate} = buildWindowManager(notesOptions)
  const source = new Float32Array(initialSource)
  const wireCount = validateCircuit(circuit)
  validateWindowManagerOutputWires(output, wireCount)
  const roots = [
    ...output.nextSource,
    ...output.windows,
    ...output.dockItems,
    output.animationActive,
    output.photos.backdropOpacity,
    ...output.photos.photos,
    ...output.photos.thumbnails,
    ...output.photos.previousControl,
    ...output.photos.nextControl,
    ...output.notes.words,
    ...output.notes.bands,
    output.notes.lineCount,
    output.notes.truncated,
    output.notes.windowOverflow,
    output.notes.runOverflow,
  ]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, tensorProgram)
  // Reuses its buffers across evaluations. Each evaluation copies the roots into
  // `values`, which the validators and callers index by wire.
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const values = new Float32Array(wireCount)
  const scratch = new Float32Array(source.length)
  const numericTolerance = 1e-5
  let clock: SpringClock = stoppedSpringClock
  let queued: (Omit<WindowManagerEvent, 'timeStamp'> & {timeStamp: number | undefined})[] = []
  let mounted = false
  let queuedViewport: readonly [width: number, height: number] = [0, 0]
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

  // width and height are already on the 1/64 px grid, see quantizePixels.
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
    for (const event of evaluation.events) event.apply(table)
    // Checks every declared range and grid. The window hit tests' integer bits rely
    // on the grids: a press written straight into the table at x = 54.5 - 1/256 px
    // put windows 0 and 3 each half in front, before the grids were checked.
    validate(table)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    // The next-state values are the first roots. Only roots are written into
    // `values`, so the finite check covers the roots, not every wire.
    validate(rootValues.subarray(0, output.nextSource.length))
    assertFiniteValues(rootValues, 'tensor output')
    validateWindowManagerOutput(values, output, numericTolerance)
    if (evaluation.writesBack) {
      for (let field = 0; field < source.length; field++) {
        source[field] = values[output.nextSource[field]!]!
      }
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
    // A host requests frames while clock.animatedUntilMs isn't null.
    get clock() {
      return clock
    },
    // The evaluations of the last step, in order.
    evaluations: evaluations as readonly WindowManagerEvaluation[],
    observe(observer: WindowManagerObserver) {
      observers.push(observer)
    },
    // Runs the frame at frameTime, e.g. a requestAnimationFrame timestamp, and
    // returns the values of its 'frame' evaluation. The first step mounts the
    // viewport, and a later step whose viewport differs from the last queued one
    // queues a resize at frameTime. An event without a timestamp applies at this
    // frame's time.
    step(
      viewportWidth: number,
      viewportHeight: number,
      frameTime: number,
    ) {
      invariant(Number.isFinite(frameTime) && frameTime >= 0, 'frame time must be nonnegative')
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
      const width = quantizePixels(viewportWidth)
      const height = quantizePixels(viewportHeight)
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
      // A copy of the values, indexed by wire. slice copies the memory, while
      // Float32Array.from walks the elements one by one, which took about 1 ms
      // for the Notes flow's wires.
      return values.slice()
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', quantizePixels(width), quantizePixels(height), timeStamp)
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
    photoPrevious(timeStamp?: number) {
      receivePhotoEvent('photo previous', cells.photos.previous, timeStamp)
    },
    photoNext(timeStamp?: number) {
      receivePhotoEvent('photo next', cells.photos.next, timeStamp)
    },
    photoClose(timeStamp?: number) {
      receivePhotoEvent('photo close', cells.photos.close, timeStamp)
    },
  }
}

function mountWindowManager(document: Document, window: Window) {
  // The Notes paragraph is measured in the page's font with pretext, and the
  // program is built to fit that measurement, with the line fit epsilon that
  // pretext uses in this browser.
  const {paragraph} = measureNotesParagraph()
  const machine = createWindowManagerMachine({notes: {paragraph, epsilon: lineFitEpsilonFor(window.navigator)}})
  const desktop = document.querySelector<HTMLElement>('#desktop')
  const windows = [...document.querySelectorAll<HTMLElement>('.window')]
  const dockItems = [...document.querySelectorAll<HTMLElement>('.dock-item')]
  const photosViewport = document.querySelector<HTMLElement>('.photos-content')
  const monitorValues = document.querySelector<HTMLElement>('#monitor-values')
  const monitorOperations = document.querySelector<HTMLElement>('#monitor-operations')
  const monitorLayers = document.querySelector<HTMLElement>('#monitor-layers')
  const monitorWeights = document.querySelector<HTMLElement>('#monitor-weights')
  const monitorMemory = document.querySelector<HTMLElement>('#monitor-memory')
  const monitorFrame = document.querySelector<HTMLElement>('#monitor-frame')
  const monitorRaf = document.querySelector<HTMLElement>('#monitor-raf')
  invariant(desktop !== null, 'desktop is missing')
  invariant(windows.length === windowCount, 'window node count mismatch')
  invariant(dockItems.length === windowCount, 'dock item count mismatch')
  invariant(photosViewport !== null, 'Photos viewport is missing')
  invariant(monitorValues !== null, 'monitor values row is missing')
  invariant(monitorOperations !== null, 'monitor operations row is missing')
  invariant(monitorLayers !== null, 'monitor layers row is missing')
  invariant(monitorWeights !== null, 'monitor weights row is missing')
  invariant(monitorMemory !== null, 'monitor memory row is missing')
  invariant(monitorFrame !== null, 'monitor frame row is missing')
  invariant(monitorRaf !== null, 'monitor RAF row is missing')
  const windowContents = windows.map(element => {
    const content = element.querySelector<HTMLElement>('.window-content')
    invariant(content !== null, 'window content is missing')
    return content
  })
  const domCache = {
    desktop, // mount lifetime
    windows, // mount lifetime
    windowContents, // mount lifetime
    dockItems, // mount lifetime
    photosViewport, // mount lifetime
    monitorFrame, // mount lifetime
    monitorRaf, // mount lifetime
    wordNodes: createWordNodes(document, windowContents[notesWindowIndex]!, notesWords), // mount lifetime
  }
  const photos = createPhotoGalleryRenderer(document, domCache.photosViewport)
  const program = machine.tensorProgram
  let affineCount = 0
  let regluCount = 0
  let booleanCount = 0
  let weightCount = 0
  let weightBytes = 0
  let biasBytes = 0
  let bookkeepingBytes = program.roots.byteLength + program.wireOrder.byteLength
  let denseWeightCount = 0
  let maximumLayerWidth = 0
  const inputCount = program.sourceSize
  const outputCount = program.roots.length
  const activationCount = program.valueCount - program.sourceSize
  const layerCount = program.layers.length
  for (const layer of program.layers) {
    const layerWidth = layer.outputSize + layer.gateRows.length
    regluCount += layer.gateRows.length
    booleanCount += layer.booleanRows.length
    affineCount += layer.outputSize - layer.gateRows.length - layer.booleanRows.length
    weightCount += layer.weights.length
    weightBytes += layer.weights.byteLength
    biasBytes += layer.bias.byteLength
    bookkeepingBytes +=
      layer.inputIndices.byteLength
      + layer.gateRows.byteLength
      + layer.booleanRows.byteLength
      + layer.rowOffsets.byteLength
      + layer.columns.byteLength
    denseWeightCount += layerWidth * layer.inputSize
    maximumLayerWidth = Math.max(maximumLayerWidth, layerWidth)
  }
  const formatCount = (value: number) => value.toLocaleString('en-US')
  const formatKilobytes = (bytes: number) => `${(bytes / 1_000).toFixed(1)} KB`
  monitorValues.textContent =
    `${formatCount(inputCount)} inputs · ${formatCount(outputCount)} outputs`
    + ` · ${formatCount(activationCount)} activations`
  monitorOperations.textContent =
    `${formatCount(affineCount)} affine · ${formatCount(regluCount)} ReGLU`
    + ` · ${formatCount(booleanCount)} boolean`
  monitorLayers.textContent =
    `${formatCount(layerCount)} · max width ${formatCount(maximumLayerWidth)}`
  monitorWeights.textContent =
    `${formatCount(denseWeightCount)} dense · ${formatCount(weightCount)} sparse`
  monitorMemory.textContent =
    `${formatKilobytes(weightBytes)} weights · ${formatKilobytes(biasBytes)} biases`
    + ` · ${formatKilobytes(bookkeepingBytes)} bookkeeping`
  domCache.monitorFrame.textContent = '—'
  domCache.monitorRaf.textContent = 'no'

  domCache.desktop.style.setProperty('--title-height', `${machine.source[machine.cells.titleHeight]}px`)
  domCache.desktop.style.setProperty('--button-size', `${machine.source[machine.cells.buttonSize]}px`)
  domCache.desktop.style.setProperty('--button-gap', `${machine.source[machine.cells.buttonGap]}px`)
  domCache.desktop.style.setProperty('--resize-grip', `${machine.source[machine.cells.resizeGrip]}px`)
  domCache.desktop.style.setProperty('--dock-height', `${machine.source[machine.cells.dockHeight]}px`)
  domCache.desktop.style.setProperty(
    '--system-bar-height',
    `${machine.source[machine.cells.systemBarHeight]}px`,
  )

  let scheduledRaf: number | null = null
  function scheduleRender() {
    if (scheduledRaf !== null) return
    scheduledRaf = window.requestAnimationFrame(renderWindowManager)
  }

  function renderWindowManager(frameTime: number) {
    scheduledRaf = null
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const executionStart = window.performance.now()
    const values = machine.step(viewportWidth, viewportHeight, frameTime)
    const executionMs = window.performance.now() - executionStart

    projectWindowElements(domCache.windows, domCache.windowContents, values, machine.output.windows)
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const element = domCache.dockItems[windowIndex]!
      const outputStart = windowIndex * dockOutputField.size
      projectDockGeometry(element, values, machine.output.dockItems, outputStart)
      element.style.setProperty(
        '--inactive',
        `${values[machine.output.dockItems[outputStart + dockOutputField.inactive]!]}`,
      )
      element.style.setProperty(
        '--focused',
        `${values[machine.output.dockItems[outputStart + dockOutputField.focused]!]}`,
      )
      element.style.setProperty(
        '--open',
        `${values[machine.output.dockItems[outputStart + dockOutputField.open]!]}`,
      )
    }

    photos.render(values, machine.output.photos)
    projectNotesWords(domCache.wordNodes, values, machine.output.notes.words)

    // Frames continue while springs are stepping, i.e. until an evaluation that
    // writes state back finds nothing animating.
    const nextRafRequested = machine.clock.animatedUntilMs !== null
    if (nextRafRequested) scheduleRender()
    domCache.monitorRaf.textContent = nextRafRequested ? 'yes' : 'no'
    const evaluationCount = machine.evaluations.length
    domCache.monitorFrame.textContent =
      `${executionMs.toFixed(2)} ms · ${evaluationCount} ${evaluationCount === 1 ? 'evaluation' : 'evaluations'}`
  }

  // Each event carries its own timestamp, which shares the time origin of
  // requestAnimationFrame timestamps, so springs step to the event's time before
  // it applies, at any frame rate.
  window.addEventListener('pointerdown', (event: PointerEvent) => {
    machine.pointerDown(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('pointermove', (event: PointerEvent) => {
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
  window.addEventListener('pointerup', (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('pointercancel', (event: PointerEvent) => {
    machine.pointerCancel(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('keydown', (event: KeyboardEvent) => {
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
    event.preventDefault()
    scheduleRender()
  })
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
  renderWindowManager(window.performance.now())
}

// Writes each window's outputs into its frame element and its .window-content
// element. The frame is drawn at the animated size, position and scale, and clips
// the content box, which takes the window's destination size as soon as an event
// changes the destination. So content such as Notes' text reflows once per
// destination change, instead of at every in-between frame size.
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
    frame.style.width = `${read(windowOutputField.width)}px`
    frame.style.height = `${read(windowOutputField.height)}px`
    frame.style.transform =
      `translate3d(${read(windowOutputField.translateX)}px,${read(windowOutputField.translateY)}px,0)`
      + ` scale(${read(windowOutputField.scale)})`
    frame.style.opacity = `${read(windowOutputField.opacity)}`
    frame.style.zIndex = `${10 + read(windowOutputField.stack)}`
    frame.style.setProperty('--focused', `${read(windowOutputField.focused)}`)
    frame.style.setProperty('--maximized', `${read(windowOutputField.maximized)}`)
    // window-manager.css anchors .window-content to all four sides of the frame,
    // and the lab demos that share the stylesheet rely on that. With left and top
    // set, the browser ignores right and bottom once width and height are set.
    content.style.width = `${read(windowOutputField.contentWidth)}px`
    content.style.height = `${read(windowOutputField.contentHeight)}px`
  }
}

// One absolutely positioned span per Notes word, in the Notes content box, which
// is the positioned parent, so a word's x and y are its transform.
export function createWordNodes(
  document: Pick<Document, 'createElement'>,
  content: Pick<HTMLElement, 'appendChild'>,
  words: readonly string[],
) {
  return words.map(word => {
    const node = document.createElement('span')
    node.className = 'notes-word'
    node.textContent = word
    content.appendChild(node)
    return node
  })
}

// Writes each word's position and whether a band laid it out.
export function projectNotesWords(nodes: readonly HTMLElement[], values: Float32Array, output: readonly Wire[]) {
  invariant(nodes.length * wordOutputField.size === output.length, 'word node count mismatch')
  nodes.forEach((node, word) => {
    const outputStart = word * wordOutputField.size
    const read = (field: number) => values[output[outputStart + field]!]!
    node.style.transform = `translate3d(${read(wordOutputField.x)}px,${read(wordOutputField.y)}px,0)`
    node.style.opacity = `${read(wordOutputField.visible)}`
  })
}

function projectDockGeometry(
  element: HTMLElement,
  values: Float32Array,
  output: readonly Wire[],
  outputStart: number,
) {
  for (const geometryField of geometryFields) {
    element.style[geometryField] =
      `${values[output[outputStart + dockOutputField[geometryField]]!]}px`
  }
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
// the viewport width by 3, which lies on no grid, so emitCompare would build a
// sign cascade for each edge instead of an integer bit.
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

function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire) {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(
    circuit,
    circuit.affine([[position, 1], [start, -1]]),
    circuit.affine([[end, 1], [position, -1]]),
  )
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
  validateWireView(output.notes.words, notesWords.length * wordOutputField.size, wireCount)
  validateWireView(output.notes.bands, notesOptionsFor(defaultNotesParagraph, defaultLineFitEpsilon).bands * bandOutputField.size, wireCount)
  validateWireView([output.notes.lineCount, output.notes.truncated, output.notes.windowOverflow, output.notes.runOverflow], 4, wireCount)
}

function validateWindowManagerOutput(
  values: Float32Array,
  output: WindowManagerOutput,
  tolerance = 1e-9,
) {
  validatePhotoGalleryOutput(values, output.photos, tolerance)
  assertUnitInterval(values[output.animationActive], 'animation active', tolerance)
  for (let word = 0; word < notesWords.length; word++) {
    const visible = values[output.notes.words[word * wordOutputField.size + wordOutputField.visible]!]
    invariant(visible === 0 || visible === 1, `Notes word visibility must equal zero or one, got ${visible}`)
  }
  const truncated = values[output.notes.truncated]
  invariant(truncated === 0 || truncated === 1, `Notes truncated must equal zero or one, got ${truncated}`)
  // Both are 0 for every table when the flow's options fit its paragraph, see notesOptionsFor.
  invariant(values[output.notes.windowOverflow] === 0, 'a Notes line reached past the walker window')
  invariant(values[output.notes.runOverflow] === 0, 'the Notes paragraph has a longer run of break-after segments than the flow was built for')
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

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountWindowManager(document, window)
}
