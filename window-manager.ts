import {
  Circuit,
  type SpringMatrixWires,
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
  inlineCircuit,
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
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from './host-timing.ts'
import {
  type PhotoGalleryOutput,
  createPhotoGalleryCircuit,
  createPhotoGalleryRenderer,
  focusField as localPhotoFocusField,
  itemCount as photoCount,
  sourceField as localPhotoSourceField,
  springConstants,
  thumbnailSpringField,
  thumbnailSpringSourceField as localThumbnailSpringSourceField,
  validatePhotoGalleryOutput,
  validatePhotoGalleryOutputWires,
} from './photo-gallery.ts'

export const windowCount = 4

export const windowStateField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  open: 4,
  minimized: 5,
  maximized: 6,
  present: 7,
  size: 8,
} as const

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

// Per window, for each of the 5 springs in animationFields order: its displacement
// from the destination in effect, its velocity, and that destination. The drawn
// value is destination + displacement, which the program computes and doesn't store.
const springStateField = {
  displacement: 0,
  velocity: 1,
  destination: 2,
  size: 3,
} as const
const windowSpringSize = animationFields.length * springStateField.size

const windowStateStart = 31
const dragStart = windowStateStart + windowCount * windowStateField.size
const resizeStart = dragStart + windowCount
const stackStart = resizeStart + windowCount
const springStart = stackStart + windowCount * windowCount
const photoStart = springStart + windowCount * windowSpringSize

export const photoSourceField = {
  gap: photoStart,
  mainInset: photoStart + 1,
  thumbnailHeight: photoStart + 2,
  controlSize: photoStart + 3,
  clickActive: photoStart + 4,
  clickX: photoStart + 5,
  clickY: photoStart + 6,
  previousActive: photoStart + 7,
  nextActive: photoStart + 8,
  closeActive: photoStart + 9,
  focusStart: photoStart + 10,
  thumbnailSpringStart: photoStart + 10 + photoCount,
  size: photoStart + 10 + photoCount + photoCount * thumbnailSpringField.size,
} as const
const sourceSize = photoSourceField.size

export const sourceField = {
  viewportWidth: 0,
  viewportHeight: 1,
  unit: 2,
  margin: 3,
  titleHeight: 4,
  minWidth: 5,
  minHeight: 6,
  resizeGrip: 7,
  buttonSize: 8,
  buttonGap: 9,
  dockHeight: 10,
  dockGap: 11,
  dockItemWidth: 12,
  downActive: 13,
  downX: 14,
  downY: 15,
  moveActive: 16,
  moveX: 17,
  moveY: 18,
  upActive: 19,
  upX: 20,
  upY: 21,
  pointerX: 22,
  pointerY: 23,
  systemBarHeight: 24,
  // The spring matrix, settle check bit and snap bit that the host writes before
  // each evaluation, see advanceFrame in host-timing.ts.
  springMatrixStart: 25,
  settleCheck: 29,
  snap: 30,
  windowStart: windowStateStart,
  dragStart,
  resizeStart,
  stackStart,
  springStart,
  photoStart,
  size: sourceSize,
} as const

const photosWindowIndex = windowCount - 1
const geometryFields = ['left', 'top', 'width', 'height'] as const
const transformFields = ['translateX', 'translateY', 'scale'] as const
const springMatrixFields: SpringMatrixWires = [
  sourceField.springMatrixStart,
  sourceField.springMatrixStart + 1,
  sourceField.springMatrixStart + 2,
  sourceField.springMatrixStart + 3,
]
const eventActiveFields = [
  sourceField.downActive,
  sourceField.moveActive,
  sourceField.upActive,
] as const
const eventCoordinateFields = [
  sourceField.downX,
  sourceField.downY,
  sourceField.moveX,
  sourceField.moveY,
  sourceField.upX,
  sourceField.upY,
] as const
// The machine rounds pointer coordinates and the viewport to multiples of this
// many px, and clamps pointer coordinates within ±pointerCoordinateBound px.
const pixelGrid = 1 / 64
// Twice the viewport ceiling. At ±65,536 px, a title bar's right edge distance
// could span more than 2^24 steps of its 1/128 px grid, and emitCompare would
// build a sign cascade for it instead of integer bits.
const pointerCoordinateBound = 32_768
const pointerCoordinateFields = [
  ...eventCoordinateFields,
  sourceField.pointerX,
  sourceField.pointerY,
] as const
const photoEventActiveFields = [
  photoSourceField.clickActive,
  photoSourceField.previousActive,
  photoSourceField.nextActive,
  photoSourceField.closeActive,
] as const
const photoEventCoordinateFields = [
  photoSourceField.clickX,
  photoSourceField.clickY,
] as const
const photoConstantFields = [
  photoSourceField.gap,
  photoSourceField.mainInset,
  photoSourceField.thumbnailHeight,
  photoSourceField.controlSize,
] as const
const pixelConstantFields = [
  sourceField.margin,
  sourceField.titleHeight,
  sourceField.minWidth,
  sourceField.minHeight,
  sourceField.resizeGrip,
  sourceField.buttonSize,
  sourceField.buttonGap,
  sourceField.dockHeight,
  sourceField.dockGap,
  sourceField.dockItemWidth,
  sourceField.systemBarHeight,
] as const
type Geometry = Record<(typeof geometryFields)[number], Wire>
type Transform = Record<(typeof transformFields)[number], Wire>
type WindowAnimation = {
  width: Wire
  height: Wire
  transform: Transform
  // Next state, in animationFields order.
  displacements: Wire[]
  velocities: Wire[]
  destinations: Record<AnimationField, Wire>
  active: Wire
}

type WindowManagerOutput = {
  nextSource: Wire[]
  windows: Wire[]
  dockItems: Wire[]
  animationActive: Wire
  photos: PhotoGalleryOutput
}

export function windowSourceField(windowIndex: number, field: number) {
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'window index is invalid',
  )
  invariant(
    Number.isInteger(field) && field >= 0 && field < windowStateField.size,
    'window field is invalid',
  )
  return sourceField.windowStart + windowIndex * windowStateField.size + field
}

export function dragSourceField(windowIndex: number) {
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'drag window index is invalid',
  )
  return sourceField.dragStart + windowIndex
}

export function resizeSourceField(windowIndex: number) {
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'resize window index is invalid',
  )
  return sourceField.resizeStart + windowIndex
}

export function stackSourceField(rank: number, windowIndex: number) {
  invariant(Number.isInteger(rank) && rank >= 0 && rank < windowCount, 'stack rank is invalid')
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'stack window index is invalid',
  )
  return sourceField.stackStart + rank * windowCount + windowIndex
}

function springSourceField(windowIndex: number, spring: AnimationField, field: number) {
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'spring window index is invalid',
  )
  invariant(
    Number.isInteger(field) && field >= 0 && field < springStateField.size,
    'spring field is invalid',
  )
  return sourceField.springStart
    + windowIndex * windowSpringSize
    + animationFields.indexOf(spring) * springStateField.size
    + field
}

export function photoFocusSourceField(item: number) {
  invariant(
    Number.isInteger(item) && item >= 0 && item < photoCount,
    'photo index is invalid',
  )
  return photoSourceField.focusStart + item
}

export function photoThumbnailSpringSourceField(item: number, field: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < photoCount, 'photo index is invalid')
  invariant(
    Number.isInteger(field) && field >= 0 && field < thumbnailSpringField.size,
    'photo thumbnail spring field is invalid',
  )
  return photoSourceField.thumbnailSpringStart + item * thumbnailSpringField.size + field
}

function compileWindowManagerCircuit() {
  const circuit = new Circuit(sourceField.size)
  // Pixel-space sources carry an honest finite ceiling: 16384 covers the
  // largest real displays (8K is 7680 wide) with headroom while staying far
  // inside FP32's exact-integer band (macro-ranges.md keeps operands well
  // under 2^23). Finite bounds make geometry eligible for gather lowering
  // (see lab/gather-lowering); a range that admits Infinity cannot lower.
  circuit.assumeRange(sourceField.viewportWidth, 0, 16_384)
  circuit.assumeRange(sourceField.viewportHeight, 0, 16_384)
  circuit.assumeRange(sourceField.unit, 1, 1)
  // The machine writes the viewport and pointer coordinates on the 1/64 px grid.
  // With the pixel constants, window geometry and bit cells below also declared on
  // grids, the edge distances of every window rectangle lie on a grid, so the hit
  // tests' comparisons are integer bits (see emitRectangleHit).
  circuit.assumeGrid(sourceField.viewportWidth, pixelGrid)
  circuit.assumeGrid(sourceField.viewportHeight, pixelGrid)
  circuit.assumeGrid(sourceField.unit, 1)
  for (const field of pointerCoordinateFields) {
    circuit.assumeRange(field, -pointerCoordinateBound, pointerCoordinateBound)
    circuit.assumeGrid(field, pixelGrid)
  }
  // Every FP32 matrix entry the host writes for up to 300 steps stays within this
  // bound.
  const matrixBound = springMatrixBound(springConstants)
  for (const field of springMatrixFields) circuit.assumeRange(field, -matrixBound, matrixBound)
  circuit.assumeRange(sourceField.settleCheck, 0, 1)
  circuit.assumeRange(sourceField.snap, 0, 1)
  // Margins, the title bar, buttons, and dock geometry are constants in the
  // tens to hundreds of pixels; 1024 is generous.
  for (const field of pixelConstantFields) {
    circuit.assumeRange(field, 0, 1024)
    circuit.assumeGrid(field, pixelGrid)
  }
  for (const field of eventActiveFields) {
    circuit.assumeRange(field, 0, 1)
    circuit.assumeGrid(field, 1)
  }
  for (const field of photoConstantFields) {
    circuit.assumeRange(field, 0, 1024)
  }
  for (const field of photoEventActiveFields) circuit.assumeRange(field, 0, 1)
  for (let item = 0; item < photoCount; item++) {
    circuit.assumeRange(photoFocusSourceField(item), 0, 1)
    // The same ranges as photo-gallery.ts declares, whose inlined declarations
    // land on these wires.
    circuit.assumeRange(
      photoThumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination),
      -16_384,
      32_768,
    )
    circuit.assumeRange(
      photoThumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination),
      0,
      1,
    )
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    // Window geometry is clamped to the viewport every frame before writeback,
    // so the viewport ceiling is honest for the stored state as well. Pointer
    // deltas and clamps against the viewport and the constants keep it on the
    // 1/64 px grid.
    for (const field of [
      windowStateField.left,
      windowStateField.top,
      windowStateField.width,
      windowStateField.height,
    ]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 16_384)
      circuit.assumeGrid(windowSourceField(windowIndex, field), pixelGrid)
    }
    for (const field of [
      windowStateField.open,
      windowStateField.minimized,
      windowStateField.maximized,
      windowStateField.present,
    ]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 1)
      circuit.assumeGrid(windowSourceField(windowIndex, field), 1)
    }
    circuit.assumeRange(dragSourceField(windowIndex), 0, 1)
    circuit.assumeGrid(dragSourceField(windowIndex), 1)
    circuit.assumeRange(resizeSourceField(windowIndex), 0, 1)
    circuit.assumeGrid(resizeSourceField(windowIndex), 1)
    // The destinations written back are this evaluation's targets. A center can
    // sit a little outside the viewport, e.g. a dock item in a 2 px wide viewport
    // is centered at -4.8e-7 px after FP32 rounds a third, so centers get
    // -16,384..32,768. Displacements and velocities need no declared range.
    for (const field of ['centerX', 'centerY'] as const) {
      circuit.assumeRange(
        springSourceField(windowIndex, field, springStateField.destination),
        -16_384,
        32_768,
      )
    }
    for (const field of ['width', 'height'] as const) {
      circuit.assumeRange(
        springSourceField(windowIndex, field, springStateField.destination),
        0,
        16_384,
      )
    }
    circuit.assumeRange(springSourceField(windowIndex, 'scale', springStateField.destination), 0, 1)
    for (let rank = 0; rank < windowCount; rank++) {
      circuit.assumeRange(stackSourceField(rank, windowIndex), 0, 1)
      circuit.assumeGrid(stackSourceField(rank, windowIndex), 1)
    }
  }
  // The stacking state is a permutation matrix: exactly one window per rank
  // and exactly one rank per window, asserted by validateWindowManagerSource
  // every frame. Declared as one-hot groups, the frontmost-window selection
  // sums lower to gather reads (see lab/gather-lowering).
  for (let rank = 0; rank < windowCount; rank++) {
    circuit.assumeOneHot(Array.from(
      {length: windowCount},
      (_, windowIndex) => stackSourceField(rank, windowIndex),
    ))
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    circuit.assumeOneHot(Array.from(
      {length: windowCount},
      (_, rank) => stackSourceField(rank, windowIndex),
    ))
  }

  const unit = sourceField.unit
  const zero = circuit.affine([])
  const effectiveDockHeight = emitMinimum(
    circuit,
    sourceField.dockHeight,
    sourceField.viewportHeight,
  )
  const dockTop = circuit.affine([
    [sourceField.viewportHeight, 1],
    [effectiveDockHeight, -1],
  ])
  const workspaceTop = emitMinimum(circuit, sourceField.systemBarHeight, dockTop)
  const workspaceHeight = circuit.affine([[dockTop, 1], [workspaceTop, -1]])
  const maximumLeft = emitMinimum(
    circuit,
    sourceField.margin,
    circuit.affine([[sourceField.viewportWidth, 0.5]]),
  )
  const maximumTopInset = emitMinimum(
    circuit,
    sourceField.margin,
    circuit.affine([[workspaceHeight, 0.5]]),
  )
  const maximumGeometry: Geometry = {
    left: maximumLeft,
    top: circuit.affine([[workspaceTop, 1], [maximumTopInset, 1]]),
    width: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
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

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const normalGeometry = {
      left: windowSourceField(windowIndex, windowStateField.left),
      top: windowSourceField(windowIndex, windowStateField.top),
      width: windowSourceField(windowIndex, windowStateField.width),
      height: windowSourceField(windowIndex, windowStateField.height),
    }
    currentNormalGeometry.push(normalGeometry)
    const open = windowSourceField(windowIndex, windowStateField.open)
    const minimized = windowSourceField(windowIndex, windowStateField.minimized)
    const maximized = windowSourceField(windowIndex, windowStateField.maximized)
    const present = windowSourceField(windowIndex, windowStateField.present)
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
      emitRectangleHit(circuit, sourceField.downX, sourceField.downY, geometry),
    ))

    const buttonTop = circuit.affine([
      [geometry.top, 1],
      [sourceField.titleHeight, 0.5],
      [sourceField.buttonSize, -0.5],
    ])
    const closeLeft = circuit.affine([
      [geometry.left, 1],
      [geometry.width, 1],
      [sourceField.buttonGap, -1],
      [sourceField.buttonSize, -1],
    ])
    const maximizeLeft = circuit.affine([
      [closeLeft, 1],
      [sourceField.buttonGap, -1],
      [sourceField.buttonSize, -1],
    ])
    const minimizeLeft = circuit.affine([
      [maximizeLeft, 1],
      [sourceField.buttonGap, -1],
      [sourceField.buttonSize, -1],
    ])
    const buttonHitInset = circuit.affine([[sourceField.buttonGap, 0.5]])
    const buttonHitSize = circuit.affine([
      [sourceField.buttonSize, 1],
      [sourceField.buttonGap, 1],
    ])
    const buttonHitGeometry = (left: Wire): Geometry => ({
      left: circuit.affine([[left, 1], [buttonHitInset, -1]]),
      top: circuit.affine([[buttonTop, 1], [buttonHitInset, -1]]),
      width: buttonHitSize,
      height: buttonHitSize,
    })
    closeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonHitGeometry(closeLeft),
    ))
    maximizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonHitGeometry(maximizeLeft),
    ))
    minimizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonHitGeometry(minimizeLeft),
    ))
    dragHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      {
        left: geometry.left,
        top: geometry.top,
        width: emitRelu(circuit, circuit.affine([
          [minimizeLeft, 1],
          [sourceField.buttonGap, -1],
          [geometry.left, -1],
        ])),
        height: sourceField.titleHeight,
      },
    ))
    resizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      {
        left: circuit.affine([
          [geometry.left, 1],
          [geometry.width, 1],
          [sourceField.resizeGrip, -1],
        ]),
        top: circuit.affine([
          [geometry.top, 1],
          [geometry.height, 1],
          [sourceField.resizeGrip, -1],
        ]),
        width: sourceField.resizeGrip,
        height: sourceField.resizeGrip,
      },
    ))
  }

  const currentStack = Array.from({length: windowCount}, (_, rank) =>
    Array.from({length: windowCount}, (_, windowIndex) =>
      stackSourceField(rank, windowIndex)))
  const selectedCanvas = emitFrontmost(circuit, currentStack, windowHit, unit)

  const dockGap = emitMinimum(
    circuit,
    sourceField.dockGap,
    emitMinimum(
      circuit,
      circuit.affine([[sourceField.viewportWidth, 1 / (windowCount - 1)]]),
      circuit.affine([[effectiveDockHeight, 0.5]]),
    ),
  )
  const dockHorizontalSpace = emitRelu(circuit, circuit.affine([
    [sourceField.viewportWidth, 1],
    [dockGap, -(windowCount - 1)],
  ]))
  const dockVerticalSpace = emitRelu(circuit, circuit.affine([
    [effectiveDockHeight, 1],
    [dockGap, -2],
  ]))
  const dockItemSize = emitMinimum(
    circuit,
    sourceField.dockItemWidth,
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
    [sourceField.viewportWidth, 0.5],
    [dockTotalWidth, -0.5],
  ])
  const dockItemTop = circuit.affine([
    [dockTop, 1],
    [effectiveDockHeight, 0.5],
    [dockItemSize, -0.5],
  ])
  const dockGeometry: Geometry[] = []
  const dockHit: Wire[] = []
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
    dockHit.push(emitDockItemHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      geometry,
      unit,
    ))
  }

  const canvasPress: Wire[] = []
  const dockPress: Wire[] = []
  const selectedWindow: Wire[] = []
  const closePress: Wire[] = []
  const minimizePress: Wire[] = []
  const maximizePress: Wire[] = []
  const dragPress: Wire[] = []
  const resizePress: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const canvas = emitMultiply(circuit, sourceField.downActive, selectedCanvas[windowIndex]!)
    const dock = emitMultiply(circuit, sourceField.downActive, dockHit[windowIndex]!)
    canvasPress.push(canvas)
    dockPress.push(dock)
    const selected = emitClampZeroOne(circuit, circuit.affine([[canvas, 1], [dock, 1]]), unit)
    selectedWindow.push(selected)
    closePress.push(emitMultiply(circuit, canvas, closeHit[windowIndex]!))
    minimizePress.push(emitMultiply(circuit, canvas, minimizeHit[windowIndex]!))
    maximizePress.push(emitMultiply(circuit, canvas, maximizeHit[windowIndex]!))
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
  }

  const baselineX = emitSelect(
    circuit,
    sourceField.downActive,
    sourceField.pointerX,
    sourceField.downX,
  )
  const baselineY = emitSelect(
    circuit,
    sourceField.downActive,
    sourceField.pointerY,
    sourceField.downY,
  )
  const movedX = emitSelect(circuit, sourceField.moveActive, baselineX, sourceField.moveX)
  const movedY = emitSelect(circuit, sourceField.moveActive, baselineY, sourceField.moveY)
  const pointerX = emitSelect(circuit, sourceField.upActive, movedX, sourceField.upX)
  const pointerY = emitSelect(circuit, sourceField.upActive, movedY, sourceField.upY)
  const deltaX = circuit.affine([[pointerX, 1], [baselineX, -1]])
  const deltaY = circuit.affine([[pointerY, 1], [baselineY, -1]])
  const pointerStillDown = emitComplement(circuit, sourceField.upActive, unit)

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
      sourceField.downActive,
      dragSourceField(windowIndex),
      dragPress[windowIndex]!,
    )
    const resizeForMotion = emitSelect(
      circuit,
      sourceField.downActive,
      resizeSourceField(windowIndex),
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
      emitMinimum(circuit, sourceField.minWidth, sourceField.viewportWidth),
      sourceField.viewportWidth,
    )
    const height = emitClampDynamic(
      circuit,
      heightCandidate,
      emitMinimum(circuit, sourceField.minHeight, workspaceHeight),
      workspaceHeight,
    )
    const maximumLeft = emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
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
      closePress[windowIndex]!,
      currentOpen[windowIndex]!,
      zero,
    )
    nextOpen.push(emitSelect(circuit, dockPress[windowIndex]!, afterClose, unit))
    const afterMinimize = emitSelect(
      circuit,
      minimizePress[windowIndex]!,
      currentMinimized[windowIndex]!,
      unit,
    )
    const afterDock = emitSelect(circuit, dockPress[windowIndex]!, afterMinimize, zero)
    nextMinimized.push(emitSelect(circuit, closePress[windowIndex]!, afterDock, zero))
    const toggledMaximized = circuit.affine([
      [currentMaximized[windowIndex]!, 1],
      [emitMultiply(
        circuit,
        maximizePress[windowIndex]!,
        circuit.affine([[unit, 1], [currentMaximized[windowIndex]!, -2]]),
      ), 1],
    ])
    nextMaximized.push(emitSelect(
      circuit,
      closePress[windowIndex]!,
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
      [sourceField.titleHeight, -1],
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
        matrix: springMatrixFields,
        displacement: springSourceField(windowIndex, field, springStateField.displacement),
        velocity: springSourceField(windowIndex, field, springStateField.velocity),
        destination: target[field],
        destinationDuringSteps: springSourceField(windowIndex, field, springStateField.destination),
      })),
      {
        settleCheck: sourceField.settleCheck,
        snap: emitClampZeroOne(circuit, circuit.affine([[direct, 1], [sourceField.snap, 1]]), unit),
      },
    )
    const [centerXPosition, centerYPosition, widthPosition, heightPosition, scalePosition] =
      object.positions as [Wire, Wire, Wire, Wire, Wire]
    const width = emitClampDynamic(
      circuit,
      widthPosition,
      zero,
      sourceField.viewportWidth,
    )
    const height = emitClampDynamic(
      circuit,
      heightPosition,
      zero,
      sourceField.viewportHeight,
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
      circuit.affine([[sourceField.viewportWidth, 1], [scaledHalfWidth, -1]]),
    )
    const centerY = emitClampDynamic(
      circuit,
      centerYPosition,
      scaledHalfHeight,
      circuit.affine([[sourceField.viewportHeight, 1], [scaledHalfHeight, -1]]),
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
      displacements: object.displacements,
      velocities: object.velocities,
      destinations: target,
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

  const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
  for (const field of eventActiveFields) nextSource[field] = zero
  nextSource[sourceField.pointerX] = pointerX
  nextSource[sourceField.pointerY] = pointerY
  // The stored table holds the identity matrix and no settle check or snap, so
  // evaluating it directly runs 0 steps.
  nextSource[sourceField.springMatrixStart] = unit
  nextSource[sourceField.springMatrixStart + 1] = zero
  nextSource[sourceField.springMatrixStart + 2] = zero
  nextSource[sourceField.springMatrixStart + 3] = unit
  nextSource[sourceField.settleCheck] = zero
  nextSource[sourceField.snap] = zero
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const geometry = nextNormalGeometry[windowIndex]!
    nextSource[windowSourceField(windowIndex, windowStateField.left)] = geometry.left
    nextSource[windowSourceField(windowIndex, windowStateField.top)] = geometry.top
    nextSource[windowSourceField(windowIndex, windowStateField.width)] = geometry.width
    nextSource[windowSourceField(windowIndex, windowStateField.height)] = geometry.height
    nextSource[windowSourceField(windowIndex, windowStateField.open)] = nextOpen[windowIndex]!
    nextSource[windowSourceField(windowIndex, windowStateField.minimized)] =
      nextMinimized[windowIndex]!
    nextSource[windowSourceField(windowIndex, windowStateField.maximized)] =
      nextMaximized[windowIndex]!
    nextSource[windowSourceField(windowIndex, windowStateField.present)] =
      nextPresent[windowIndex]!
    nextSource[dragSourceField(windowIndex)] = nextDrag[windowIndex]!
    nextSource[resizeSourceField(windowIndex)] = nextResize[windowIndex]!
    for (let rank = 0; rank < windowCount; rank++) {
      nextSource[stackSourceField(rank, windowIndex)] = nextStack[rank]![windowIndex]!
    }
    const animation = windowAnimations[windowIndex]!
    animationFields.forEach((field, springIndex) => {
      nextSource[springSourceField(windowIndex, field, springStateField.displacement)] =
        animation.displacements[springIndex]!
      nextSource[springSourceField(windowIndex, field, springStateField.velocity)] =
        animation.velocities[springIndex]!
      nextSource[springSourceField(windowIndex, field, springStateField.destination)] =
        animation.destinations[field]
    })
  }

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
  const photoSourceWires = Array<Wire>(localPhotoSourceField.size)
  // Photos lays out, hit-tests and draws at the window's destination content size,
  // e.g. the maximized size from the press on, and not at the animated size. So
  // which photo a click lands on doesn't depend on spring timing, and the
  // thumbnail destinations change only at events, which keeps stored state
  // independent of frame times.
  photoSourceWires[localPhotoSourceField.viewportWidth] = destinationContentWidth[photosWindowIndex]!
  photoSourceWires[localPhotoSourceField.viewportHeight] = destinationContentHeight[photosWindowIndex]!
  photoSourceWires[localPhotoSourceField.gap] = photoSourceField.gap
  photoSourceWires[localPhotoSourceField.mainInset] = photoSourceField.mainInset
  photoSourceWires[localPhotoSourceField.thumbnailHeight] =
    photoSourceField.thumbnailHeight
  photoSourceWires[localPhotoSourceField.controlSize] = photoSourceField.controlSize
  photoSourceWires[localPhotoSourceField.clickActive] = photoSourceField.clickActive
  // A click arrives in viewport coordinates, and Photos reads it relative to the
  // content box at the window's destination, like presses hit-test window
  // destinations. E.g. a click during a maximize lands on the photo that ends up
  // under the pointer.
  photoSourceWires[localPhotoSourceField.clickX] = circuit.affine([
    [photoSourceField.clickX, 1],
    [photosDestination.left, -1],
    [unit, -1],
  ])
  photoSourceWires[localPhotoSourceField.clickY] = circuit.affine([
    [photoSourceField.clickY, 1],
    [photosDestination.top, -1],
    [sourceField.titleHeight, -1],
    [unit, -1],
  ])
  photoSourceWires[localPhotoSourceField.previousActive] =
    photoSourceField.previousActive
  photoSourceWires[localPhotoSourceField.nextActive] = photoSourceField.nextActive
  photoSourceWires[localPhotoSourceField.closeActive] = photoSourceField.closeActive
  for (let item = 0; item < photoCount; item++) {
    photoSourceWires[localPhotoFocusField(item)] = photoFocusSourceField(item)
    for (let field = 0; field < thumbnailSpringField.size; field++) {
      photoSourceWires[localThumbnailSpringSourceField(item, field)] =
        photoThumbnailSpringSourceField(item, field)
    }
  }
  photoSourceWires[localPhotoSourceField.present] =
    windows[photosWindowOutputStart + windowOutputField.opacity]!
  photoSourceWires[localPhotoSourceField.interactive] =
    windows[photosWindowOutputStart + windowOutputField.focused]!
  photoSourceWires[localPhotoSourceField.unit] = sourceField.unit
  // Thumbnails and windows share stiffness and damping, so one matrix serves both.
  springMatrixFields.forEach((field, entry) => {
    photoSourceWires[localPhotoSourceField.springMatrixStart + entry] = field
  })
  photoSourceWires[localPhotoSourceField.settleCheck] = sourceField.settleCheck
  photoSourceWires[localPhotoSourceField.snap] = sourceField.snap

  const photoDefinition = createPhotoGalleryCircuit()
  const photoWireMap = inlineCircuit(circuit, photoDefinition.circuit, photoSourceWires)
  const mapPhotoWires = (wires: readonly Wire[]) =>
    wires.map(wire => photoWireMap[wire]!)
  const photos: PhotoGalleryOutput = {
    nextSource: mapPhotoWires(photoDefinition.output.nextSource),
    backdropOpacity: photoWireMap[photoDefinition.output.backdropOpacity]!,
    animationActive: photoWireMap[photoDefinition.output.animationActive]!,
    photos: mapPhotoWires(photoDefinition.output.photos),
    thumbnails: mapPhotoWires(photoDefinition.output.thumbnails),
    previousControl: mapPhotoWires(photoDefinition.output.previousControl),
    nextControl: mapPhotoWires(photoDefinition.output.nextControl),
  }
  const photoSourceBindings = [
    [localPhotoSourceField.gap, photoSourceField.gap],
    [localPhotoSourceField.mainInset, photoSourceField.mainInset],
    [localPhotoSourceField.thumbnailHeight, photoSourceField.thumbnailHeight],
    [localPhotoSourceField.controlSize, photoSourceField.controlSize],
    [localPhotoSourceField.clickActive, photoSourceField.clickActive],
    // clickX and clickY aren't bound: Photos' next state passes its local click
    // coordinates through, and the stored cells keep the viewport coordinates.
    [localPhotoSourceField.previousActive, photoSourceField.previousActive],
    [localPhotoSourceField.nextActive, photoSourceField.nextActive],
    [localPhotoSourceField.closeActive, photoSourceField.closeActive],
  ] as const
  for (const [localField, field] of photoSourceBindings) {
    nextSource[field] = photos.nextSource[localField]!
  }
  for (let item = 0; item < photoCount; item++) {
    nextSource[photoFocusSourceField(item)] =
      photos.nextSource[localPhotoFocusField(item)]!
    for (let field = 0; field < thumbnailSpringField.size; field++) {
      nextSource[photoThumbnailSpringSourceField(item, field)] =
        photos.nextSource[localThumbnailSpringSourceField(item, field)]!
    }
  }
  const animationActive = emitClampZeroOne(
    circuit,
    circuit.affine([
      [windowAnimationActive, 1],
      [photos.animationActive, 1],
    ]),
    unit,
  )

  return {
    circuit,
    output: {
      nextSource,
      windows,
      dockItems,
      animationActive,
      photos,
    },
  }
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
    | 'photo click'
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
export function createWindowManagerMachine(options: {writeBack?: WriteBack} = {}) {
  const writeBack = options.writeBack ?? 'events and settle checks'
  const source = new Float32Array(sourceField.size)
  source[sourceField.unit] = 1
  source[sourceField.margin] = 12
  source[sourceField.titleHeight] = 44
  source[sourceField.minWidth] = 280
  source[sourceField.minHeight] = 190
  source[sourceField.resizeGrip] = 24
  source[sourceField.buttonSize] = 18
  source[sourceField.buttonGap] = 10
  source[sourceField.dockHeight] = 76
  source[sourceField.dockGap] = 12
  source[sourceField.dockItemWidth] = 50
  source[sourceField.systemBarHeight] = 36
  source.set(springMatrixPowers[0]!, sourceField.springMatrixStart)
  source[photoSourceField.gap] = 18
  source[photoSourceField.mainInset] = 92
  source[photoSourceField.thumbnailHeight] = 82
  source[photoSourceField.controlSize] = 52
  const initialGeometry = [
    [54, 54, 520, 340],
    [410, 104, 500, 366],
    [174, 344, 470, 300],
    [650, 190, 560, 430],
  ] as const
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const geometry = initialGeometry[windowIndex]!
    source[windowSourceField(windowIndex, windowStateField.left)] = geometry[0]
    source[windowSourceField(windowIndex, windowStateField.top)] = geometry[1]
    source[windowSourceField(windowIndex, windowStateField.width)] = geometry[2]
    source[windowSourceField(windowIndex, windowStateField.height)] = geometry[3]
    source[windowSourceField(windowIndex, windowStateField.open)] = 1
    source[windowSourceField(windowIndex, windowStateField.present)] = 1
    source[stackSourceField(windowIndex, windowIndex)] = 1
    // Each window rests on its destinations, with displacements and velocities 0.
    const destinations: Record<AnimationField, number> = {
      centerX: geometry[0] + geometry[2] / 2,
      centerY: geometry[1] + geometry[3] / 2,
      width: geometry[2],
      height: geometry[3],
      scale: 1,
    }
    for (const field of animationFields) {
      source[springSourceField(windowIndex, field, springStateField.destination)] = destinations[field]
    }
  }

  const {circuit, output} = compileWindowManagerCircuit()
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
  ]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, tensorProgram)
  // Reuses its buffers across evaluations. Each evaluation copies the roots into
  // `values`, which the validators and callers index by wire.
  const evaluateRoots = circuit.createTensorEvaluator(roots)
  const values = new Float32Array(wireCount)
  const scratch = new Float32Array(sourceField.size)
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
      table[sourceField.viewportWidth] = width
      table[sourceField.viewportHeight] = height
    })
  }

  // Rounds coordinates to 1/64 px and clamps them within ±32,768 px, as the program
  // declares, e.g. 100.001 becomes 100 and -50,000 becomes -32,768.
  function receivePointer(
    kind: 'pointer down' | 'pointer move' | 'pointer up',
    activeField: number,
    xField: number,
    yField: number,
    x: number,
    y: number,
    timeStamp: number | undefined,
  ) {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    const clampedX = Math.min(pointerCoordinateBound, Math.max(-pointerCoordinateBound, quantizePixels(x)))
    const clampedY = Math.min(pointerCoordinateBound, Math.max(-pointerCoordinateBound, quantizePixels(y)))
    queue(kind, timeStamp, table => {
      table[activeField] = 1
      table[xField] = clampedX
      table[yField] = clampedY
    })
  }

  // Photos events that share an evaluation are mutually exclusive; the last one wins.
  function receivePhotoEvent(
    kind: 'photo click' | 'photo previous' | 'photo next' | 'photo close',
    field: number,
    timeStamp: number | undefined,
    x?: number,
    y?: number,
  ) {
    queue(kind, timeStamp, table => {
      for (const eventField of photoEventActiveFields) table[eventField] = 0
      table[field] = 1
      if (x !== undefined && y !== undefined) {
        table[photoSourceField.clickX] = x
        table[photoSourceField.clickY] = y
      }
    })
  }

  // One evaluation that advanceFrame planned: write the matrix, the settle check
  // and snap bits and the events, evaluate, and write next state back when the
  // evaluation writes back.
  function evaluate(evaluation: PlannedEvaluation<WindowManagerEvent>) {
    const table = evaluation.writesBack ? source : scratch
    if (!evaluation.writesBack) scratch.set(source)
    table.set(springMatrixPowers[evaluation.steps]!, sourceField.springMatrixStart)
    table[sourceField.settleCheck] = evaluation.settleCheck ? 1 : 0
    table[sourceField.snap] = evaluation.snap ? 1 : 0
    for (const event of evaluation.events) event.apply(table)
    validateWindowManagerSource(table, numericTolerance)
    validateSourceGrids(circuit, table)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
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
      const events = queued.map(event => ({...event, timeStamp: event.timeStamp ?? frameTime}))
      queued = []
      evaluations.length = 0
      clock = advanceFrame(clock, frameTime, events, evaluate, writeBack)
      storedAfterLastStep.set(source)
      return Float32Array.from(values)
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', quantizePixels(width), quantizePixels(height), timeStamp)
    },
    pointerDown(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer down', sourceField.downActive, sourceField.downX, sourceField.downY, x, y, timeStamp)
    },
    pointerMove(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer move', sourceField.moveActive, sourceField.moveX, sourceField.moveY, x, y, timeStamp)
    },
    pointerUp(x: number, y: number, timeStamp?: number) {
      receivePointer('pointer up', sourceField.upActive, sourceField.upX, sourceField.upY, x, y, timeStamp)
    },
    // x and y are viewport coordinates, e.g. event.clientX and event.clientY, like
    // the pointer methods. The program reads them relative to Photos' content box at
    // the window's destination.
    photoClick(x: number, y: number, timeStamp?: number) {
      receivePhotoEvent('photo click', photoSourceField.clickActive, timeStamp, x, y)
    },
    photoPrevious(timeStamp?: number) {
      receivePhotoEvent('photo previous', photoSourceField.previousActive, timeStamp)
    },
    photoNext(timeStamp?: number) {
      receivePhotoEvent('photo next', photoSourceField.nextActive, timeStamp)
    },
    photoClose(timeStamp?: number) {
      receivePhotoEvent('photo close', photoSourceField.closeActive, timeStamp)
    },
  }
}

function mountWindowManager(document: Document, window: Window) {
  const machine = createWindowManagerMachine()
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

  domCache.desktop.style.setProperty('--title-height', `${machine.source[sourceField.titleHeight]}px`)
  domCache.desktop.style.setProperty('--button-size', `${machine.source[sourceField.buttonSize]}px`)
  domCache.desktop.style.setProperty('--button-gap', `${machine.source[sourceField.buttonGap]}px`)
  domCache.desktop.style.setProperty('--resize-grip', `${machine.source[sourceField.resizeGrip]}px`)
  domCache.desktop.style.setProperty('--dock-height', `${machine.source[sourceField.dockHeight]}px`)
  domCache.desktop.style.setProperty(
    '--system-bar-height',
    `${machine.source[sourceField.systemBarHeight]}px`,
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
  window.addEventListener('pointerup', (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  window.addEventListener('pointercancel', (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY, event.timeStamp)
    scheduleRender()
  })
  domCache.photosViewport.addEventListener('click', (event: MouseEvent) => {
    // A click fires after pointerup, so the press that focuses Photos applies first.
    // The program reads the viewport coordinates relative to Photos' content box at
    // the window's destination, not at where the frame is drawn.
    machine.photoClick(event.clientX, event.clientY, event.timeStamp)
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
  const half = circuit.affine([], 0.5)
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

// Every source cell declared on a grid must hold a multiple of that grid, e.g. a
// pointer coordinate on the 1/64 px grid. The window hit tests' integer bits rely on
// these grids: a press written straight into the table at x = 54.5 - 1/256 px put
// windows 0 and 3 each half in front, instead of throwing.
function validateSourceGrids(circuit: Circuit, table: Float32Array) {
  for (let field = 0; field < table.length; field++) {
    const grid = circuit.grids[field]
    if (grid !== undefined && !Number.isInteger(table[field]! / grid)) {
      invariant(false, `source cell ${field} must be a multiple of ${grid}, got ${table[field]}`)
    }
  }
}

function validateWindowManagerSource(values: unknown, tolerance = 1e-9) {
  invariant(
    values instanceof Float32Array,
    'source table must be a Float32Array',
  )
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  invariant(values[sourceField.unit] === 1, 'unit cell must equal one')
  for (const field of springMatrixFields) {
    invariant(Number.isFinite(values[field]), 'spring matrix entries must be finite')
  }
  assertBit(values[sourceField.settleCheck], 'settle check')
  assertBit(values[sourceField.snap], 'snap')
  for (const field of pixelConstantFields) {
    assertNonNegativeFinite(values[field], 'window manager constant')
  }
  for (const field of eventActiveFields) {
    assertUnitInterval(values[field], 'event latch', tolerance)
  }
  for (const field of eventCoordinateFields) {
    invariant(Number.isFinite(values[field]), 'event coordinate must be finite')
  }
  for (const field of photoConstantFields) {
    assertNonNegativeFinite(values[field], 'Photos constant')
  }
  let photoEventMass = 0
  for (const field of photoEventActiveFields) {
    assertUnitInterval(values[field], 'Photos event latch', tolerance)
    photoEventMass += values[field]
  }
  invariant(photoEventMass <= 1 + tolerance, 'Photos event mass must not exceed one')
  for (const field of photoEventCoordinateFields) {
    invariant(Number.isFinite(values[field]), 'Photos event coordinate must be finite')
  }
  let photoFocusMass = 0
  for (let item = 0; item < photoCount; item++) {
    const focus = values[photoFocusSourceField(item)]
    assertUnitInterval(focus, `photo focus ${item}`, tolerance)
    photoFocusMass += focus
    for (const field of [
      thumbnailSpringField.centerXDisplacement,
      thumbnailSpringField.centerXVelocity,
      thumbnailSpringField.scaleDisplacement,
      thumbnailSpringField.scaleVelocity,
    ]) {
      invariant(
        Number.isFinite(values[photoThumbnailSpringSourceField(item, field)]),
        `photo thumbnail ${item} spring state must be finite`,
      )
    }
    assertWithin(
      values[photoThumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination)],
      -16_384,
      32_768,
      `photo thumbnail ${item} center destination`,
    )
    assertUnitInterval(
      values[photoThumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination)],
      `photo thumbnail ${item} scale destination`,
      tolerance,
    )
  }
  invariant(photoFocusMass <= 1 + tolerance, 'photo focus mass must not exceed one')
  invariant(Number.isFinite(values[sourceField.pointerX]), 'pointer x must be finite')
  invariant(Number.isFinite(values[sourceField.pointerY]), 'pointer y must be finite')
  let dragMass = 0
  let resizeMass = 0
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [
      windowStateField.left,
      windowStateField.top,
      windowStateField.width,
      windowStateField.height,
    ]) {
      assertNonNegativeFinite(
        values[windowSourceField(windowIndex, field)],
        'window geometry',
      )
    }
    for (const field of [
      windowStateField.open,
      windowStateField.minimized,
      windowStateField.maximized,
      windowStateField.present,
    ]) {
      assertUnitInterval(
        values[windowSourceField(windowIndex, field)],
        'window flag',
        tolerance,
      )
    }
    const drag = values[dragSourceField(windowIndex)]
    const resize = values[resizeSourceField(windowIndex)]
    assertUnitInterval(drag, 'drag target', tolerance)
    assertUnitInterval(resize, 'resize target', tolerance)
    dragMass += drag
    resizeMass += resize
    for (const field of animationFields) {
      invariant(
        Number.isFinite(values[springSourceField(windowIndex, field, springStateField.displacement)]),
        'spring displacement must be finite',
      )
      invariant(
        Number.isFinite(values[springSourceField(windowIndex, field, springStateField.velocity)]),
        'spring velocity must be finite',
      )
    }
    for (const field of ['centerX', 'centerY'] as const) {
      assertWithin(
        values[springSourceField(windowIndex, field, springStateField.destination)],
        -16_384,
        32_768,
        'spring center destination',
      )
    }
    for (const field of ['width', 'height'] as const) {
      assertWithin(
        values[springSourceField(windowIndex, field, springStateField.destination)],
        0,
        16_384,
        'spring size destination',
      )
    }
    assertUnitInterval(
      values[springSourceField(windowIndex, 'scale', springStateField.destination)],
      'spring scale destination',
      tolerance,
    )
  }
  invariant(dragMass <= 1 + tolerance, 'drag target mass must not exceed one')
  invariant(resizeMass <= 1 + tolerance, 'resize target mass must not exceed one')

  for (let rank = 0; rank < windowCount; rank++) {
    let rankMass = 0
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const stack = values[stackSourceField(rank, windowIndex)]
      assertUnitInterval(stack, 'stack cell', tolerance)
      rankMass += stack
    }
    assertApproximatelyOne(rankMass, 'stack rank mass', tolerance)
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    let windowMass = 0
    for (let rank = 0; rank < windowCount; rank++) {
      windowMass += values[stackSourceField(rank, windowIndex)]!
    }
    assertApproximatelyOne(windowMass, 'stack window mass', tolerance)
  }
}

function validateWindowManagerOutputWires(output: WindowManagerOutput, wireCount: number) {
  validateWireView(output.nextSource, sourceField.size, wireCount)
  validateWireView(output.windows, windowCount * windowOutputField.size, wireCount)
  validateWireView(output.dockItems, windowCount * dockOutputField.size, wireCount)
  validateWireView([output.animationActive], 1, wireCount)
  validatePhotoGalleryOutputWires(output.photos, wireCount)
}

function validateWindowManagerOutput(
  values: Float32Array,
  output: WindowManagerOutput,
  tolerance = 1e-9,
) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = Float32Array.from(output.nextSource, wire => values[wire]!)
  validateWindowManagerSource(nextSource, tolerance)
  for (const field of eventActiveFields) {
    invariant(nextSource[field] === 0, 'event latch must reset after refresh')
  }
  for (const field of photoEventActiveFields) {
    invariant(nextSource[field] === 0, 'Photos event latch must reset after refresh')
  }
  validatePhotoGalleryOutput(values, output.photos, tolerance)
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

function assertApproximatelyOne(value: number, label: string, tolerance = 1e-8) {
  invariant(Math.abs(value - 1) <= tolerance, `${label} must equal one`)
}

function assertBit(value: number | undefined, label: string) {
  invariant(value === 0 || value === 1, `${label} must equal zero or one, got ${value}`)
}

function assertWithin(value: number | undefined, minimum: number, maximum: number, label: string) {
  invariant(
    value !== undefined && value >= minimum && value <= maximum,
    `${label} must be within ${minimum}..${maximum}, got ${value}`,
  )
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountWindowManager(document, window)
}
