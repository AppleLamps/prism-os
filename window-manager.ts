import {
  Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  inlineCircuit,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from './numeric-ui-core.ts'
import {
  type PhotoGalleryOutput,
  createPhotoGalleryCircuit,
  createPhotoGalleryRenderer,
  focusField as localPhotoFocusField,
  itemCount as photoCount,
  sourceField as localPhotoSourceField,
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
  size: 11,
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

const springStateField = {
  centerX: 0,
  centerY: 1,
  width: 2,
  height: 3,
  scale: 4,
  centerXVelocity: 5,
  centerYVelocity: 6,
  widthVelocity: 7,
  heightVelocity: 8,
  scaleVelocity: 9,
  size: 10,
} as const

const windowStateStart = 35
const dragStart = windowStateStart + windowCount * windowStateField.size
const resizeStart = dragStart + windowCount
const stackStart = resizeStart + windowCount
const springStart = stackStart + windowCount * windowCount
const photoStart = springStart + windowCount * springStateField.size

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
  size: photoStart + 10 + photoCount,
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
  frameTime: 25,
  previousFrameTime: 26,
  timeInitialized: 27,
  springStiffness: 28,
  springDamping: 29,
  springMaxFrameDuration: 30,
  springSettleDistance: 31,
  springSettleSpeed: 32,
  springSettleDistanceScale: 33,
  springSettleSpeedScale: 34,
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
const animationFields = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
type AnimationField = (typeof animationFields)[number]
const springPositionField: Record<AnimationField, number> = {
  centerX: springStateField.centerX,
  centerY: springStateField.centerY,
  width: springStateField.width,
  height: springStateField.height,
  scale: springStateField.scale,
}
const springVelocityField: Record<AnimationField, number> = {
  centerX: springStateField.centerXVelocity,
  centerY: springStateField.centerYVelocity,
  width: springStateField.widthVelocity,
  height: springStateField.heightVelocity,
  scale: springStateField.scaleVelocity,
}
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
const constantFields = [
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
  sourceField.springStiffness,
  sourceField.springDamping,
  sourceField.springMaxFrameDuration,
  sourceField.springSettleDistance,
  sourceField.springSettleSpeed,
  sourceField.springSettleDistanceScale,
  sourceField.springSettleSpeedScale,
] as const

type Geometry = Record<(typeof geometryFields)[number], Wire>
type Transform = Record<(typeof transformFields)[number], Wire>
type SpringState = {
  position: Wire
  velocity: Wire
}
type WindowAnimation = {
  width: Wire
  height: Wire
  transform: Transform
  springs: Record<AnimationField, SpringState>
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

function springSourceField(windowIndex: number, field: number) {
  invariant(
    Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windowCount,
    'spring window index is invalid',
  )
  invariant(
    Number.isInteger(field) && field >= 0 && field < springStateField.size,
    'spring field is invalid',
  )
  return sourceField.springStart + windowIndex * springStateField.size + field
}

export function photoFocusSourceField(item: number) {
  invariant(
    Number.isInteger(item) && item >= 0 && item < photoCount,
    'photo index is invalid',
  )
  return photoSourceField.focusStart + item
}

function compileWindowManagerCircuit() {
  const circuit = new Circuit(sourceField.size)
  circuit.assumeRange(sourceField.viewportWidth, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.viewportHeight, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.unit, 1, 1)
  circuit.assumeRange(sourceField.frameTime, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.previousFrameTime, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.timeInitialized, 0, 1)
  for (const field of constantFields) circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  for (const field of eventActiveFields) circuit.assumeRange(field, 0, 1)
  for (const field of photoConstantFields) {
    circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  }
  for (const field of photoEventActiveFields) circuit.assumeRange(field, 0, 1)
  for (let item = 0; item < photoCount; item++) {
    circuit.assumeRange(photoFocusSourceField(item), 0, 1)
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [
      windowStateField.left,
      windowStateField.top,
      windowStateField.width,
      windowStateField.height,
    ]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, Number.POSITIVE_INFINITY)
    }
    for (const field of [
      windowStateField.open,
      windowStateField.minimized,
      windowStateField.maximized,
      windowStateField.present,
    ]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 1)
    }
    circuit.assumeRange(dragSourceField(windowIndex), 0, 1)
    circuit.assumeRange(resizeSourceField(windowIndex), 0, 1)
    circuit.assumeRange(springSourceField(windowIndex, springStateField.scale), 0, 1)
    for (let rank = 0; rank < windowCount; rank++) {
      circuit.assumeRange(stackSourceField(rank, windowIndex), 0, 1)
    }
  }

  const unit = sourceField.unit
  const zero = circuit.affine([])
  const frameDuration = emitMultiply(
    circuit,
    sourceField.timeInitialized,
    emitClampDynamic(
      circuit,
      circuit.affine([
        [sourceField.frameTime, 1],
        [sourceField.previousFrameTime, -1],
      ]),
      zero,
      sourceField.springMaxFrameDuration,
    ),
  )
  const springTimestep = circuit.affine([[frameDuration, 0.001 / 4]])
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
      emitRectangleHit(circuit, sourceField.downX, sourceField.downY, geometry, unit),
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
      unit,
    ))
    maximizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonHitGeometry(maximizeLeft),
      unit,
    ))
    minimizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonHitGeometry(minimizeLeft),
      unit,
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
      unit,
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
      unit,
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
    dockHit.push(emitRectangleHit(
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
    const state = {} as Record<AnimationField, SpringState>
    const allActivity: Wire[] = []
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
    for (const field of animationFields) {
      const steppedSpring = emitSpring(
        circuit,
        springSourceField(windowIndex, springPositionField[field]),
        target[field],
        springSourceField(windowIndex, springVelocityField[field]),
        sourceField.springStiffness,
        sourceField.springDamping,
        springTimestep,
        sourceField.springSettleDistance,
        sourceField.springSettleSpeed,
        sourceField.springSettleDistanceScale,
        sourceField.springSettleSpeedScale,
        unit,
      )
      const position = field === 'scale'
        ? emitClampDynamic(circuit, steppedSpring.position, zero, unit)
        : steppedSpring.position
      const spring = {
        position: emitSelect(circuit, direct, position, target[field]),
        velocity: emitSelect(circuit, direct, steppedSpring.velocity, zero),
        active: emitMultiply(circuit, emitComplement(circuit, direct, unit), steppedSpring.active),
      }
      state[field] = spring
      allActivity.push(spring.active)
    }
    const width = emitClampDynamic(
      circuit,
      state.width.position,
      zero,
      sourceField.viewportWidth,
    )
    const height = emitClampDynamic(
      circuit,
      state.height.position,
      zero,
      sourceField.viewportHeight,
    )
    const halfWidth = circuit.affine([[width, 0.5]])
    const halfHeight = circuit.affine([[height, 0.5]])
    const scaledHalfWidth = emitMultiply(circuit, halfWidth, state.scale.position)
    const scaledHalfHeight = emitMultiply(circuit, halfHeight, state.scale.position)
    const centerX = emitClampDynamic(
      circuit,
      state.centerX.position,
      scaledHalfWidth,
      circuit.affine([[sourceField.viewportWidth, 1], [scaledHalfWidth, -1]]),
    )
    const centerY = emitClampDynamic(
      circuit,
      state.centerY.position,
      scaledHalfHeight,
      circuit.affine([[sourceField.viewportHeight, 1], [scaledHalfHeight, -1]]),
    )
    const active = emitClampZeroOne(
      circuit,
      circuit.affine(allActivity.map(laneActive => [laneActive, 1])),
      unit,
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
        scale: state.scale.position,
      },
      springs: state,
      active,
    })
  }
  const animationActive = emitClampZeroOne(
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

  const windowBorderSpan = circuit.affine([[unit, 2]])

  const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
  for (const field of eventActiveFields) nextSource[field] = zero
  nextSource[sourceField.pointerX] = pointerX
  nextSource[sourceField.pointerY] = pointerY
  nextSource[sourceField.previousFrameTime] = sourceField.frameTime
  nextSource[sourceField.timeInitialized] = unit
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
    for (const field of animationFields) {
      const spring = windowAnimations[windowIndex]!.springs[field]
      nextSource[springSourceField(windowIndex, springPositionField[field])] = spring.position
      nextSource[springSourceField(windowIndex, springVelocityField[field])] = spring.velocity
    }
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
      emitRelu(circuit, circuit.affine([
        [animation.width, 1],
        [windowBorderSpan, -1],
      ])),
      emitRelu(circuit, circuit.affine([
        [animation.height, 1],
        [sourceField.titleHeight, -1],
        [windowBorderSpan, -1],
      ])),
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
  const photoSourceWires = Array<Wire>(localPhotoSourceField.size)
  photoSourceWires[localPhotoSourceField.viewportWidth] =
    windows[photosWindowOutputStart + windowOutputField.contentWidth]!
  photoSourceWires[localPhotoSourceField.viewportHeight] =
    windows[photosWindowOutputStart + windowOutputField.contentHeight]!
  photoSourceWires[localPhotoSourceField.gap] = photoSourceField.gap
  photoSourceWires[localPhotoSourceField.mainInset] = photoSourceField.mainInset
  photoSourceWires[localPhotoSourceField.thumbnailHeight] =
    photoSourceField.thumbnailHeight
  photoSourceWires[localPhotoSourceField.controlSize] = photoSourceField.controlSize
  photoSourceWires[localPhotoSourceField.clickActive] = photoSourceField.clickActive
  photoSourceWires[localPhotoSourceField.clickX] = photoSourceField.clickX
  photoSourceWires[localPhotoSourceField.clickY] = photoSourceField.clickY
  photoSourceWires[localPhotoSourceField.previousActive] =
    photoSourceField.previousActive
  photoSourceWires[localPhotoSourceField.nextActive] = photoSourceField.nextActive
  photoSourceWires[localPhotoSourceField.closeActive] = photoSourceField.closeActive
  for (let item = 0; item < photoCount; item++) {
    photoSourceWires[localPhotoFocusField(item)] = photoFocusSourceField(item)
  }
  photoSourceWires[localPhotoSourceField.present] =
    windows[photosWindowOutputStart + windowOutputField.opacity]!
  photoSourceWires[localPhotoSourceField.interactive] =
    windows[photosWindowOutputStart + windowOutputField.focused]!

  const photoDefinition = createPhotoGalleryCircuit()
  const photoWireMap = inlineCircuit(circuit, photoDefinition.circuit, photoSourceWires)
  const mapPhotoWires = (wires: readonly Wire[]) =>
    wires.map(wire => photoWireMap[wire]!)
  const photos: PhotoGalleryOutput = {
    nextSource: mapPhotoWires(photoDefinition.output.nextSource),
    backdropOpacity: photoWireMap[photoDefinition.output.backdropOpacity]!,
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
    [localPhotoSourceField.clickX, photoSourceField.clickX],
    [localPhotoSourceField.clickY, photoSourceField.clickY],
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
  }

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

export function createWindowManagerMachine() {
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
  source[sourceField.springStiffness] = 650
  source[sourceField.springDamping] = 45
  source[sourceField.springMaxFrameDuration] = 32
  source[sourceField.springSettleDistance] = 0.01
  source[sourceField.springSettleSpeed] = 0.01
  source[sourceField.springSettleDistanceScale] = 100
  source[sourceField.springSettleSpeedScale] = 100
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
    source[springSourceField(windowIndex, springStateField.centerX)] =
      geometry[0] + geometry[2] / 2
    source[springSourceField(windowIndex, springStateField.centerY)] =
      geometry[1] + geometry[3] / 2
    source[springSourceField(windowIndex, springStateField.width)] = geometry[2]
    source[springSourceField(windowIndex, springStateField.height)] = geometry[3]
    source[springSourceField(windowIndex, springStateField.scale)] = 1
  }

  const {circuit, output} = compileWindowManagerCircuit()
  const wireCount = validateCircuit(circuit)
  validateWindowManagerOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    ...output.windows,
    ...output.dockItems,
    output.animationActive,
    output.photos.backdropOpacity,
    ...output.photos.photos,
    ...output.photos.thumbnails,
    ...output.photos.previousControl,
    ...output.photos.nextControl,
  ])
  validateTensorProgram(circuit, tensorProgram)
  const numericTolerance = 1e-5

  function receivePointer(activeField: number, xField: number, yField: number, x: number, y: number) {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[activeField] = 1
    source[xField] = x
    source[yField] = y
  }

  function receivePhotoEvent(
    field: number,
    x = source[photoSourceField.clickX]!,
    y = source[photoSourceField.clickY]!,
  ) {
    for (const eventField of photoEventActiveFields) source[eventField] = 0
    source[field] = 1
    source[photoSourceField.clickX] = x
    source[photoSourceField.clickY] = y
  }

  return {
    circuit,
    output,
    source,
    tensorProgram,
    step(
      viewportWidth: number,
      viewportHeight: number,
      frameTime: number,
    ) {
      invariant(Number.isFinite(frameTime) && frameTime >= 0, 'frame time must be nonnegative')
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      source[sourceField.frameTime] = frameTime
      validateWindowManagerSource(source, numericTolerance)
      const values = circuit.evaluateTensor(source)
      validateWindowManagerOutput(values, output, numericTolerance)
      for (let field = 0; field < source.length; field++) {
        source[field] = values[output.nextSource[field]!]!
      }
      return values
    },
    pointerDown(x: number, y: number) {
      receivePointer(sourceField.downActive, sourceField.downX, sourceField.downY, x, y)
    },
    pointerMove(x: number, y: number) {
      receivePointer(sourceField.moveActive, sourceField.moveX, sourceField.moveY, x, y)
    },
    pointerUp(x: number, y: number) {
      receivePointer(sourceField.upActive, sourceField.upX, sourceField.upY, x, y)
    },
    photoClick(x: number, y: number) {
      receivePhotoEvent(photoSourceField.clickActive, x, y)
    },
    photoPrevious() {
      receivePhotoEvent(photoSourceField.previousActive)
    },
    photoNext() {
      receivePhotoEvent(photoSourceField.nextActive)
    },
    photoClose() {
      receivePhotoEvent(photoSourceField.closeActive)
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
  const domCache = {
    desktop, // mount lifetime
    windows, // mount lifetime
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
    const renderStart = window.performance.now()
    scheduledRaf = null
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const values = machine.step(viewportWidth, viewportHeight, frameTime)

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const element = domCache.windows[windowIndex]!
      const outputStart = windowIndex * windowOutputField.size
      const translateX =
        values[machine.output.windows[outputStart + windowOutputField.translateX]!]!
      const translateY =
        values[machine.output.windows[outputStart + windowOutputField.translateY]!]!
      element.style.width =
        `${values[machine.output.windows[outputStart + windowOutputField.width]!]}px`
      element.style.height =
        `${values[machine.output.windows[outputStart + windowOutputField.height]!]}px`
      const scale = values[machine.output.windows[outputStart + windowOutputField.scale]!]!
      element.style.transform =
        `translate3d(${translateX}px,${translateY}px,0) scale(${scale})`
      element.style.opacity =
        `${values[machine.output.windows[outputStart + windowOutputField.opacity]!]}`
      element.style.zIndex =
        `${10 + values[machine.output.windows[outputStart + windowOutputField.stack]!]!}`
      element.style.setProperty(
        '--focused',
        `${values[machine.output.windows[outputStart + windowOutputField.focused]!]}`,
      )
      element.style.setProperty(
        '--maximized',
        `${values[machine.output.windows[outputStart + windowOutputField.maximized]!]}`,
      )
    }
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

    const nextRafRequested = values[machine.output.animationActive]! > 0
    if (nextRafRequested) scheduleRender()
    domCache.monitorRaf.textContent = nextRafRequested ? 'yes' : 'no'
    domCache.monitorFrame.textContent =
      `${(window.performance.now() - renderStart).toFixed(2)} ms`
  }

  window.addEventListener('pointerdown', (event: PointerEvent) => {
    machine.pointerDown(event.clientX, event.clientY)
    scheduleRender()
  })
  window.addEventListener('pointermove', (event: PointerEvent) => {
    machine.pointerMove(event.clientX, event.clientY)
    scheduleRender()
  })
  window.addEventListener('pointerup', (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY)
    scheduleRender()
  })
  window.addEventListener('pointercancel', (event: PointerEvent) => {
    machine.pointerUp(event.clientX, event.clientY)
    scheduleRender()
  })
  domCache.photosViewport.addEventListener('click', (event: MouseEvent) => {
    machine.photoClick(event.offsetX, event.offsetY)
    scheduleRender()
  })
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowLeft':
        machine.photoPrevious()
        break
      case 'ArrowRight':
        machine.photoNext()
        break
      case 'Escape':
        machine.photoClose()
        break
      default:
        return
    }
    event.preventDefault()
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)
  renderWindowManager(window.performance.now())
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

function emitSpring(
  circuit: Circuit,
  positionSource: Wire,
  destination: Wire,
  velocitySource: Wire,
  stiffness: Wire,
  damping: Wire,
  timestep: Wire,
  settleDistance: Wire,
  settleSpeed: Wire,
  settleDistanceScale: Wire,
  settleSpeedScale: Wire,
  unit: Wire,
) {
  let position = positionSource
  let velocity = velocitySource
  for (let step = 0; step < 4; step++) {
    const displacement = circuit.affine([[position, 1], [destination, -1]])
    const springForce = emitMultiply(circuit, stiffness, displacement)
    const dampingForce = emitMultiply(circuit, damping, velocity)
    const acceleration = circuit.affine([
      [springForce, -1],
      [dampingForce, -1],
    ])
    velocity = circuit.affine([
      [velocity, 1],
      [emitMultiply(circuit, acceleration, timestep), 1],
    ])
    position = circuit.affine([
      [position, 1],
      [emitMultiply(circuit, velocity, timestep), 1],
    ])
  }

  const distanceAboveThreshold = emitRelu(circuit, circuit.affine([
    [emitAbsolute(circuit, circuit.affine([[position, 1], [destination, -1]])), 1],
    [settleDistance, -1],
  ]))
  const speedAboveThreshold = emitRelu(circuit, circuit.affine([
    [emitAbsolute(circuit, velocity), 1],
    [settleSpeed, -1],
  ]))
  const active = emitClampZeroOne(
    circuit,
    circuit.affine([
      [emitMultiply(circuit, distanceAboveThreshold, settleDistanceScale), 1],
      [emitMultiply(circuit, speedAboveThreshold, settleSpeedScale), 1],
    ]),
    unit,
  )
  return {
    position: emitSelect(circuit, active, destination, position),
    velocity: emitMultiply(circuit, active, velocity),
    active,
  }
}

function emitAbsolute(circuit: Circuit, value: Wire) {
  return circuit.affine([
    [emitRelu(circuit, value), 1],
    [emitRelu(circuit, circuit.affine([[value, -1]])), 1],
  ])
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

function emitRectangleHit(
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

function emitClampDynamic(circuit: Circuit, value: Wire, minimum: Wire, maximum: Wire) {
  return emitMinimum(circuit, emitMaximum(circuit, value, minimum), maximum)
}

function emitComplement(circuit: Circuit, value: Wire, unit: Wire) {
  return circuit.affine([[unit, 1], [value, -1]])
}

function emitSelect(circuit: Circuit, gate: Wire, off: Wire, on: Wire) {
  return circuit.affine([
    [off, 1],
    [emitMultiply(circuit, gate, circuit.affine([[on, 1], [off, -1]])), 1],
  ])
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
  assertNonNegativeFinite(values[sourceField.frameTime], 'frame time')
  assertNonNegativeFinite(values[sourceField.previousFrameTime], 'previous frame time')
  assertUnitInterval(values[sourceField.timeInitialized], 'time initialized', tolerance)
  invariant(values[sourceField.unit] === 1, 'unit cell must equal one')
  for (const field of constantFields) {
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
        Number.isFinite(values[springSourceField(windowIndex, springPositionField[field])]),
        'spring position must be finite',
      )
      invariant(
        Number.isFinite(values[springSourceField(windowIndex, springVelocityField[field])]),
        'spring velocity must be finite',
      )
    }
    assertUnitInterval(
      values[springSourceField(windowIndex, springStateField.scale)],
      'spring scale',
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

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountWindowManager(document, window)
}
