import {
  Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertWire,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorEvaluation,
  validateTensorProgram,
} from './numeric-ui-core.ts'

export const windowCount = 4

export const windowStateField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  open: 4,
  minimized: 5,
  maximized: 6,
  size: 7,
} as const

export const windowOutputField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  focused: 5,
  stack: 6,
  maximized: 7,
  size: 8,
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

const windowStateStart = 25
const dragStart = windowStateStart + windowCount * windowStateField.size
const resizeStart = dragStart + windowCount
const stackStart = resizeStart + windowCount

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
  windowStart: windowStateStart,
  dragStart,
  resizeStart,
  stackStart,
  size: stackStart + windowCount * windowCount,
} as const

const geometryFields = ['left', 'top', 'width', 'height'] as const
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
] as const

type Geometry = Record<(typeof geometryFields)[number], Wire>

type WindowManagerOutput = {
  nextSource: Wire[]
  windows: Wire[]
  dockItems: Wire[]
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

export function compileWindowManagerCircuit() {
  const circuit = new Circuit(sourceField.size)
  circuit.assumeRange(sourceField.viewportWidth, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.viewportHeight, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.unit, 1, 1)
  for (const field of constantFields) circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  for (const field of eventActiveFields) circuit.assumeRange(field, 0, 1)
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
    ]) {
      circuit.assumeRange(windowSourceField(windowIndex, field), 0, 1)
    }
    circuit.assumeRange(dragSourceField(windowIndex), 0, 1)
    circuit.assumeRange(resizeSourceField(windowIndex), 0, 1)
    for (let rank = 0; rank < windowCount; rank++) {
      circuit.assumeRange(stackSourceField(rank, windowIndex), 0, 1)
    }
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
  const currentGeometry: Geometry[] = []
  const currentOpen: Wire[] = []
  const currentMinimized: Wire[] = []
  const currentMaximized: Wire[] = []
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
    currentOpen.push(open)
    currentMinimized.push(minimized)
    currentMaximized.push(maximized)
    const visible = emitMultiply(circuit, open, emitComplement(circuit, minimized, unit))
    currentVisible.push(visible)
    const geometry = {
      left: emitSelect(circuit, maximized, normalGeometry.left, maximumGeometry.left),
      top: emitSelect(circuit, maximized, normalGeometry.top, maximumGeometry.top),
      width: emitSelect(circuit, maximized, normalGeometry.width, maximumGeometry.width),
      height: emitSelect(circuit, maximized, normalGeometry.height, maximumGeometry.height),
    }
    currentGeometry.push(geometry)
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
    const buttonGeometry = (left: Wire): Geometry => ({
      left,
      top: buttonTop,
      width: sourceField.buttonSize,
      height: sourceField.buttonSize,
    })
    closeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonGeometry(closeLeft),
      unit,
    ))
    maximizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonGeometry(maximizeLeft),
      unit,
    ))
    minimizeHit.push(emitRectangleHit(
      circuit,
      sourceField.downX,
      sourceField.downY,
      buttonGeometry(minimizeLeft),
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

  const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
  nextSource[sourceField.downActive] = zero
  nextSource[sourceField.moveActive] = zero
  nextSource[sourceField.upActive] = zero
  nextSource[sourceField.pointerX] = pointerX
  nextSource[sourceField.pointerY] = pointerY
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
    nextSource[dragSourceField(windowIndex)] = nextDrag[windowIndex]!
    nextSource[resizeSourceField(windowIndex)] = nextResize[windowIndex]!
    for (let rank = 0; rank < windowCount; rank++) {
      nextSource[stackSourceField(rank, windowIndex)] = nextStack[rank]![windowIndex]!
    }
  }

  const windows: Wire[] = []
  const dockItems: Wire[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const geometry = effectiveGeometry[windowIndex]!
    const stackTerms: [Wire, number][] = []
    for (let rank = 0; rank < windowCount; rank++) {
      stackTerms.push([nextStack[rank]![windowIndex]!, rank + 1])
    }
    windows.push(
      geometry.left,
      geometry.top,
      geometry.width,
      geometry.height,
      nextVisible[windowIndex]!,
      focusedWindow[windowIndex]!,
      circuit.affine(stackTerms),
      nextMaximized[windowIndex]!,
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

  return {
    circuit,
    output: {
      nextSource,
      windows,
      dockItems,
    },
  }
}

export function createWindowManagerMachine(
  {checkTensorEvaluation = true}: {checkTensorEvaluation?: boolean} = {},
) {
  const source = new Float64Array(sourceField.size)
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
  const initialGeometry = [
    [54, 54, 520, 340],
    [410, 104, 500, 366],
    [174, 344, 470, 300],
    [744, 270, 430, 310],
  ] as const
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const geometry = initialGeometry[windowIndex]!
    source[windowSourceField(windowIndex, windowStateField.left)] = geometry[0]
    source[windowSourceField(windowIndex, windowStateField.top)] = geometry[1]
    source[windowSourceField(windowIndex, windowStateField.width)] = geometry[2]
    source[windowSourceField(windowIndex, windowStateField.height)] = geometry[3]
    source[windowSourceField(windowIndex, windowStateField.open)] = 1
    source[stackSourceField(windowIndex, windowIndex)] = 1
  }

  const {circuit, output} = compileWindowManagerCircuit()
  const wireCount = validateCircuit(circuit)
  validateWindowManagerOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    ...output.windows,
    ...output.dockItems,
  ])
  validateTensorProgram(circuit, tensorProgram)

  function receivePointer(activeField: number, xField: number, yField: number, x: number, y: number) {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[activeField] = 1
    source[xField] = x
    source[yField] = y
  }

  return {
    circuit,
    output,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number) {
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      validateWindowManagerSource(source)
      const values = circuit.evaluateTensor(source)
      if (checkTensorEvaluation) validateTensorEvaluation(source, circuit, values)
      validateWindowManagerOutput(values, output)
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
  }
}

export type WindowManagerMachine = ReturnType<typeof createWindowManagerMachine>

declare global {
  interface Window {
    numericWindowManager?: WindowManagerMachine
  }
}

export function mountWindowManager(document: Document, window: Window) {
  const machine = createWindowManagerMachine()
  const desktop = document.querySelector<HTMLElement>('#desktop')
  const windowElements = [...document.querySelectorAll<HTMLElement>('.window')]
  const dockItems = [...document.querySelectorAll<HTMLElement>('.dock-item')]
  const readout = document.querySelector<HTMLElement>('#readout')
  invariant(desktop !== null, 'desktop is missing')
  invariant(windowElements.length === windowCount, 'window node count mismatch')
  invariant(dockItems.length === windowCount, 'dock item count mismatch')
  invariant(readout !== null, 'readout is missing')
  const desktopElement = desktop
  const readoutElement = readout
  const storedWeightCount = machine.tensorProgram.layers.reduce(
    (sum, layer) => sum + layer.weights.length,
    0,
  )
  readoutElement.textContent =
    `${machine.source.length} table cells · ${machine.tensorProgram.layers.length} layers · `
    + `${storedWeightCount} weights`

  desktopElement.style.setProperty('--title-height', `${machine.source[sourceField.titleHeight]}px`)
  desktopElement.style.setProperty('--button-size', `${machine.source[sourceField.buttonSize]}px`)
  desktopElement.style.setProperty('--button-gap', `${machine.source[sourceField.buttonGap]}px`)
  desktopElement.style.setProperty('--resize-grip', `${machine.source[sourceField.resizeGrip]}px`)
  desktopElement.style.setProperty('--dock-height', `${machine.source[sourceField.dockHeight]}px`)
  desktopElement.style.setProperty(
    '--system-bar-height',
    `${machine.source[sourceField.systemBarHeight]}px`,
  )

  let scheduledRaf: number | null = null
  function scheduleRender() {
    if (scheduledRaf !== null) return
    scheduledRaf = window.requestAnimationFrame(renderWindowManager)
  }

  function renderWindowManager() {
    scheduledRaf = null
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const values = machine.step(viewportWidth, viewportHeight)

    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const element = windowElements[windowIndex]!
      const outputStart = windowIndex * windowOutputField.size
      projectGeometry(element, values, machine.output.windows, outputStart, windowOutputField)
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
      const element = dockItems[windowIndex]!
      const outputStart = windowIndex * dockOutputField.size
      projectGeometry(element, values, machine.output.dockItems, outputStart, dockOutputField)
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
  window.addEventListener('resize', scheduleRender)
  renderWindowManager()
  return machine
}

function projectGeometry(
  element: HTMLElement,
  values: Float64Array,
  output: readonly Wire[],
  outputStart: number,
  field: typeof windowOutputField | typeof dockOutputField,
) {
  for (const geometryField of geometryFields) {
    element.style[geometryField] =
      `${values[output[outputStart + field[geometryField]]!]}px`
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

function emitRectangleHit(
  circuit: Circuit,
  x: Wire,
  y: Wire,
  geometry: Geometry,
  unit: Wire,
) {
  return emitClampZeroOne(
    circuit,
    emitMinimum(
      circuit,
      emitIntervalDistance(circuit, x, geometry.left, geometry.width),
      emitIntervalDistance(circuit, y, geometry.top, geometry.height),
    ),
    unit,
  )
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

function validateWindowManagerSource(values: unknown) {
  invariant(values instanceof Float64Array, 'source table must be a Float64Array')
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  invariant(values[sourceField.unit] === 1, 'unit cell must equal one')
  for (const field of constantFields) {
    assertNonNegativeFinite(values[field], 'window manager constant')
  }
  for (const field of eventActiveFields) assertUnitInterval(values[field], 'event latch')
  for (const field of eventCoordinateFields) {
    invariant(Number.isFinite(values[field]), 'event coordinate must be finite')
  }
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
    ]) {
      assertUnitInterval(values[windowSourceField(windowIndex, field)], 'window flag')
    }
    const drag = values[dragSourceField(windowIndex)]
    const resize = values[resizeSourceField(windowIndex)]
    assertUnitInterval(drag, 'drag target')
    assertUnitInterval(resize, 'resize target')
    dragMass += drag
    resizeMass += resize
  }
  invariant(dragMass <= 1 + 1e-9, 'drag target mass must not exceed one')
  invariant(resizeMass <= 1 + 1e-9, 'resize target mass must not exceed one')

  for (let rank = 0; rank < windowCount; rank++) {
    let rankMass = 0
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const stack = values[stackSourceField(rank, windowIndex)]
      assertUnitInterval(stack, 'stack cell')
      rankMass += stack
    }
    assertApproximatelyOne(rankMass, 'stack rank mass')
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    let windowMass = 0
    for (let rank = 0; rank < windowCount; rank++) {
      windowMass += values[stackSourceField(rank, windowIndex)]!
    }
    assertApproximatelyOne(windowMass, 'stack window mass')
  }
}

function validateWindowManagerOutputWires(output: WindowManagerOutput, wireCount: number) {
  validateWireView(output.nextSource, sourceField.size, wireCount)
  validateWireView(output.windows, windowCount * windowOutputField.size, wireCount)
  validateWireView(output.dockItems, windowCount * dockOutputField.size, wireCount)
}

function validateWindowManagerOutput(values: Float64Array, output: WindowManagerOutput) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = Float64Array.from(output.nextSource, wire => values[wire]!)
  validateWindowManagerSource(nextSource)
  for (const field of eventActiveFields) {
    invariant(nextSource[field] === 0, 'event latch must reset after refresh')
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * windowOutputField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(
        values[output.windows[outputStart + windowOutputField[field]]!],
        'projected window geometry',
      )
    }
    for (const field of [
      windowOutputField.opacity,
      windowOutputField.focused,
      windowOutputField.maximized,
    ]) {
      assertUnitInterval(values[output.windows[outputStart + field]!], 'projected window flag')
    }
    assertNonNegativeFinite(
      values[output.windows[outputStart + windowOutputField.stack]!],
      'projected stack',
    )
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * dockOutputField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(
        values[output.dockItems[outputStart + dockOutputField[field]]!],
        'projected dock geometry',
      )
    }
    for (const field of [
      dockOutputField.inactive,
      dockOutputField.focused,
      dockOutputField.open,
    ]) {
      assertUnitInterval(values[output.dockItems[outputStart + field]!], 'projected dock flag')
    }
  }
}

function validateWireView(wires: readonly Wire[], size: number, wireCount: number) {
  invariant(wires.length === size, 'output wire view has the wrong length')
  for (const wire of wires) assertWire(wire, wireCount)
}

function assertUnitInterval(value: number | undefined, label: string): asserts value is number {
  invariant(
    value !== undefined && Number.isFinite(value) && value >= -1e-9 && value <= 1 + 1e-9,
    `${label} must be within zero and one`,
  )
}

function assertApproximatelyOne(value: number, label: string) {
  invariant(Math.abs(value - 1) <= 1e-8, `${label} must equal one`)
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.numericWindowManager = mountWindowManager(document, window)
}
