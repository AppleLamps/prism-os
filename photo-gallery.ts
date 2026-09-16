import {
  Circuit,
  type SpringMatrixWires,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  assertWire,
  emitAnimatedObject,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from './numeric-ui-core.ts'
import {
  type EvaluationKind,
  type PlannedEvaluation,
  type SpringClock,
  type SpringConstants,
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from './host-timing.ts'

export const itemCount = 12
export const columnCount = 4
export const rowCount = 3

// Thumbnails and IndirectOS's windows share these constants, so one spring matrix
// serves both.
export const springConstants: SpringConstants = {stiffness: 650, damping: 45}

// Per thumbnail: each spring's displacement from the destination in effect, its
// velocity, and that destination. The drawn value is destination + displacement,
// which the program computes and doesn't store.
export const thumbnailSpringField = {
  centerXDisplacement: 0,
  centerXVelocity: 1,
  centerXDestination: 2,
  scaleDisplacement: 3,
  scaleVelocity: 4,
  scaleDestination: 5,
  size: 6,
} as const

export const sourceField = {
  viewportWidth: 0,
  viewportHeight: 1,
  gap: 2,
  mainInset: 3,
  thumbnailHeight: 4,
  controlSize: 5,
  clickActive: 6,
  clickX: 7,
  clickY: 8,
  previousActive: 9,
  nextActive: 10,
  closeActive: 11,
  focusStart: 12,
  present: 24,
  interactive: 25,
  unit: 26,
  // The spring matrix, settle check bit and snap bit that the host writes before
  // each evaluation, see advanceFrame in host-timing.ts.
  springMatrixStart: 27,
  settleCheck: 31,
  snap: 32,
  thumbnailSpringStart: 33,
  size: 33 + itemCount * thumbnailSpringField.size,
}

export const photoField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  focused: 5,
  size: 6,
}

export const thumbnailField = photoField

export const controlField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  size: 5,
}

const geometryFields = ['left', 'top', 'width', 'height'] as const
const eventFields = [
  sourceField.clickActive,
  sourceField.previousActive,
  sourceField.nextActive,
  sourceField.closeActive,
] as const

type Geometry = Record<(typeof geometryFields)[number], Wire>

type PhotoProjection = Geometry & {
  opacity: Wire
  focused: Wire
}

type ThumbnailTarget = {
  centerX: Wire
  scale: Wire
  focused: Wire
}

export type PhotoGalleryOutput = {
  nextSource: Wire[]
  backdropOpacity: Wire
  animationActive: Wire
  photos: Wire[]
  thumbnails: Wire[]
  previousControl: Wire[]
  nextControl: Wire[]
}

const photoNames = [
  'Misty Lake',
  'Desert Light',
  'Pacific Edge',
  'Midnight City',
  'Forest Path',
  'Alpine Dawn',
  'Amalfi Morning',
  'North Falls',
  'Lavender Hour',
  'Concrete Curve',
  'Blue Lagoon',
  'Autumn Road',
] as const

export function focusField(item: number) {
  return sourceField.focusStart + item
}

export function thumbnailSpringSourceField(item: number, field: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < itemCount, 'photo index is invalid')
  invariant(
    Number.isInteger(field) && field >= 0 && field < thumbnailSpringField.size,
    'thumbnail spring field is invalid',
  )
  return sourceField.thumbnailSpringStart + item * thumbnailSpringField.size + field
}

export function createPhotoGalleryCircuit() {
  const circuit = new Circuit(sourceField.size)
  // Pixel-space sources carry an honest finite ceiling: 16384 covers the
  // largest real displays (8K is 7680 wide) with headroom while staying far
  // inside FP32's exact-integer band (macro-ranges.md keeps operands well
  // under 2^23). Finite bounds also make the geometry eligible for gather
  // lowering, and when this circuit is inlined into the window manager the
  // bounds become contracts on the window content dimensions, which are
  // clamped to the viewport and so honor them.
  circuit.assumeRange(sourceField.viewportWidth, 0, 16_384)
  circuit.assumeRange(sourceField.viewportHeight, 0, 16_384)
  // Spacing and control-size constants live in the tens of pixels; 1024 is
  // generous.
  for (const field of [
    sourceField.gap,
    sourceField.mainInset,
    sourceField.thumbnailHeight,
    sourceField.controlSize,
  ]) {
    circuit.assumeRange(field, 0, 1024)
  }
  for (const field of eventFields) circuit.assumeRange(field, 0, 1)
  circuit.assumeRange(sourceField.present, 0, 1)
  circuit.assumeRange(sourceField.interactive, 0, 1)
  circuit.assumeRange(sourceField.unit, 1, 1)
  // Every FP32 matrix entry the host writes for up to 300 steps stays within this
  // bound.
  const matrixBound = springMatrixBound(springConstants)
  for (let entry = 0; entry < 4; entry++) {
    circuit.assumeRange(sourceField.springMatrixStart + entry, -matrixBound, matrixBound)
  }
  circuit.assumeRange(sourceField.settleCheck, 0, 1)
  circuit.assumeRange(sourceField.snap, 0, 1)
  for (let item = 0; item < itemCount; item++) circuit.assumeRange(focusField(item), 0, 1)
  for (let item = 0; item < itemCount; item++) {
    // The destinations written back are this evaluation's thumbnail targets. A
    // target center is the viewport's middle plus at most about 232 px either
    // way, so -16,384..32,768 holds it for any viewport within 0..16,384.
    // Displacements and velocities need no declared range.
    circuit.assumeRange(
      thumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination),
      -16_384,
      32_768,
    )
    circuit.assumeRange(
      thumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination),
      0,
      1,
    )
  }
  const zero = circuit.affine([])
  const gridWidth = emitRelu(
    circuit,
    circuit.affine([
      [sourceField.viewportWidth, 1 / columnCount],
      [sourceField.gap, -(columnCount + 1) / columnCount],
    ]),
  )
  const gridHeight = emitRelu(
    circuit,
    circuit.affine([
      [sourceField.viewportHeight, 1 / rowCount],
      [sourceField.gap, -(rowCount + 1) / rowCount],
    ]),
  )

  const gridLeft = Array.from({length: columnCount}, (_, column) =>
    circuit.affine([[sourceField.gap, 1 + column], [gridWidth, column]]))
  const gridTop = Array.from({length: rowCount}, (_, row) =>
    circuit.affine([[sourceField.gap, 1 + row], [gridHeight, row]]))
  const gridColumnHit = gridLeft.map(left =>
    emitIntervalHit(circuit, sourceField.clickX, left, gridWidth))
  const gridRowHit = gridTop.map(top =>
    emitIntervalHit(circuit, sourceField.clickY, top, gridHeight))
  const gridHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    gridHit.push(emitMinimum(circuit, gridColumnHit[column]!, gridRowHit[row]!))
  }

  const thumbnailBaseSize = emitMinimum(
    circuit,
    sourceField.thumbnailHeight,
    emitMinimum(
      circuit,
      circuit.affine([[sourceField.viewportWidth, 1 / 6]]),
      circuit.affine([[sourceField.viewportHeight, 0.24]]),
    ),
  )
  const mainInset = emitMinimum(
    circuit,
    sourceField.mainInset,
    circuit.affine([[sourceField.viewportWidth, 0.08]]),
  )
  const main: Geometry = {
    left: mainInset,
    top: sourceField.gap,
    width: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [mainInset, -2],
    ])),
    height: emitRelu(circuit, circuit.affine([
      [sourceField.viewportHeight, 1],
      [thumbnailBaseSize, -1],
      [sourceField.gap, -3],
    ])),
  }
  const mainHit = emitRectangleHit(circuit, main)

  const previousFocus = Array.from({length: itemCount}, (_, item) => focusField(item))
  const previousFocusMass = circuit.affine(previousFocus.map(wire => [wire, 1]))
  circuit.assumeRange(previousFocusMass, 0, 1)
  const previousGridMass = circuit.affine([[previousFocusMass, -1]], 1)

  const thumbnailOuterInset = emitMinimum(
    circuit,
    sourceField.gap,
    circuit.affine([[sourceField.viewportWidth, 0.5]]),
  )
  const thumbnailImageSpan = circuit.affine([
    [thumbnailBaseSize, thumbnailFalloffMass()],
  ])
  const thumbnailGap = emitMinimum(
    circuit,
    circuit.affine([], 12),
    emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1 / 8],
      [thumbnailOuterInset, -2 / 8],
      [thumbnailImageSpan, -1 / 8],
    ])),
  )
  const thumbnailCenterY = circuit.affine([
    [sourceField.viewportHeight, 1],
    [sourceField.gap, -1],
    [thumbnailBaseSize, -0.5],
  ])
  function projectThumbnailTargets(focus: readonly Wire[], focusMass: Wire) {
    const result: ThumbnailTarget[] = []
    for (let item = 0; item < itemCount; item++) {
      const offsetTerms: [Wire, number][] = []
      const distanceTerms: [Wire, number][] = []
      const spreadTerms: [Wire, number][] = []
      for (let focusedItem = 0; focusedItem < itemCount; focusedItem++) {
        let offset = item - focusedItem
        if (offset > itemCount / 2) offset -= itemCount
        if (offset < -itemCount / 2) offset += itemCount
        const visibleOffset = Math.abs(offset) < 5 ? offset : 0
        offsetTerms.push([
          focus[focusedItem]!,
          visibleOffset,
        ])
        distanceTerms.push([focus[focusedItem]!, Math.abs(offset)])
        spreadTerms.push([
          focus[focusedItem]!,
          Math.sign(visibleOffset) * thumbnailSpread(Math.abs(visibleOffset)),
        ])
      }
      const offset = circuit.affine(offsetTerms)
      const distance = circuit.affine(distanceTerms)
      const spread = circuit.affine(spreadTerms)
      const falloff = emitRelu(circuit, circuit.affine([
        [focusMass, 1],
        [distance, -0.22],
      ]))
      const centerX = circuit.affine([
        [sourceField.viewportWidth, 0.5],
        [emitMultiply(circuit, thumbnailBaseSize, spread), 1],
        [emitMultiply(circuit, thumbnailGap, offset), 1],
      ])
      result.push({
        centerX,
        scale: falloff,
        focused: focus[item]!,
      })
    }
    return result
  }

  function projectThumbnail(target: ThumbnailTarget): PhotoProjection {
    const visibleScale = emitMultiply(circuit, sourceField.present, target.scale)
    const size = emitMultiply(circuit, thumbnailBaseSize, visibleScale)
    return {
      left: circuit.affine([[target.centerX, 1], [size, -0.5]]),
      top: emitRelu(circuit, circuit.affine([[thumbnailCenterY, 1], [size, -0.5]])),
      width: size,
      height: size,
      opacity: visibleScale,
      focused: target.focused,
    }
  }

  const currentThumbnailTargets = projectThumbnailTargets(previousFocus, previousFocusMass)
  const thumbnailHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    thumbnailHit.push(emitRectangleHit(circuit, projectThumbnail(currentThumbnailTargets[item]!)))
  }

  const controlTop = emitRelu(circuit, circuit.affine([
    [sourceField.gap, 1],
    [main.height, 0.5],
    [sourceField.controlSize, -0.5],
  ]))
  const controlInset = circuit.affine([[sourceField.gap, 0.5]])
  const previousControl: Geometry = {
    left: controlInset,
    top: controlTop,
    width: sourceField.controlSize,
    height: sourceField.controlSize,
  }
  const nextControl: Geometry = {
    left: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [controlInset, -1],
      [sourceField.controlSize, -1],
    ])),
    top: controlTop,
    width: sourceField.controlSize,
    height: sourceField.controlSize,
  }
  const controlVerticalHit = emitIntervalHit(
    circuit,
    sourceField.clickY,
    controlTop,
    sourceField.controlSize,
  )
  const previousControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      sourceField.clickX,
      previousControl.left,
      previousControl.width,
    ),
    controlVerticalHit,
  )
  const nextControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      sourceField.clickX,
      nextControl.left,
      nextControl.width,
    ),
    controlVerticalHit,
  )

  const effectiveEvents = eventFields.map(wire =>
    emitMultiply(circuit, sourceField.interactive, wire))
  const eventMass = circuit.affine(effectiveEvents.map(wire => [wire, 1]))
  circuit.assumeRange(eventMass, 0, 1)
  const eventInactive = circuit.affine([[eventMass, -1]], 1)
  const clickActive = effectiveEvents[0]!
  const clickGridGate = emitMultiply(circuit, clickActive, previousGridMass)
  const focusedClick = emitMultiply(circuit, clickActive, previousFocusMass)
  circuit.assumeRange(focusedClick, 0, 1)
  const [
    previousControlClick,
    nextControlClick,
    ...focusedSurfaceClicks
  ] = emitFirstActive(
    circuit,
    focusedClick,
    [previousControlHit, nextControlHit, ...thumbnailHit, mainHit],
  )
  const thumbnailClicks = focusedSurfaceClicks.slice(0, itemCount)
  const clickMainGate = focusedSurfaceClicks[itemCount]!
  const currentFocusGate = circuit.affine([[eventInactive, 1], [clickMainGate, 1]])
  const previousFocusGate = circuit.affine([
    [effectiveEvents[1]!, 1],
    [previousControlClick!, 1],
  ])
  const nextFocusGate = circuit.affine([
    [effectiveEvents[2]!, 1],
    [nextControlClick!, 1],
  ])
  const nextFocus: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const previousShift = previousFocus[(item + 1) % itemCount]!
    const nextShift = previousFocus[(item + itemCount - 1) % itemCount]!
    nextFocus.push(circuit.affine([
      [emitMultiply(circuit, currentFocusGate, previousFocus[item]!), 1],
      [emitMultiply(circuit, clickGridGate, gridHit[item]!), 1],
      [thumbnailClicks[item]!, 1],
      [emitMultiply(circuit, previousFocusGate, previousShift), 1],
      [emitMultiply(circuit, nextFocusGate, nextShift), 1],
    ]))
  }

  const nextFocusMass = circuit.affine(nextFocus.map(wire => [wire, 1]))
  circuit.assumeRange(nextFocusMass, 0, 1)
  const nextGridMass = circuit.affine([[nextFocusMass, -1]], 1)
  const projectedGridLeft = gridLeft.map(left => emitMultiply(circuit, nextGridMass, left))
  const projectedGridTop = gridTop.map(top => emitMultiply(circuit, nextGridMass, top))
  const projectedGridWidth = emitMultiply(circuit, nextGridMass, gridWidth)
  const projectedGridHeight = emitMultiply(circuit, nextGridMass, gridHeight)
  const photos: PhotoProjection[] = []
  const thumbnailTargets = projectThumbnailTargets(nextFocus, nextFocusMass)
  // Thumbnails animate while a photo stays open, and snap onto their targets when
  // the carousel opens or closes, or when the host plans a snap.
  const animateThumbnails = emitMultiply(circuit, previousFocusMass, nextFocusMass)
  const snapThumbnails = emitClampZeroOne(
    circuit,
    circuit.affine([[animateThumbnails, -1], [sourceField.snap, 1]], 1),
  )
  const springMatrix: SpringMatrixWires = [
    sourceField.springMatrixStart,
    sourceField.springMatrixStart + 1,
    sourceField.springMatrixStart + 2,
    sourceField.springMatrixStart + 3,
  ]
  const thumbnailProjections: PhotoProjection[] = []
  const thumbnailActivityTerms: [Wire, number][] = []
  const nextThumbnailSprings: Wire[][] = []
  for (let item = 0; item < itemCount; item++) {
    const target = thumbnailTargets[item]!
    // centerX and scale settle together. The steps simulate time before this
    // evaluation's events, so they pull toward the destinations that the previous
    // evaluation wrote back.
    const thumbnail = emitAnimatedObject(circuit, [
      {
        matrix: springMatrix,
        displacement: thumbnailSpringSourceField(item, thumbnailSpringField.centerXDisplacement),
        velocity: thumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity),
        destination: target.centerX,
        destinationDuringSteps: thumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination),
      },
      {
        matrix: springMatrix,
        displacement: thumbnailSpringSourceField(item, thumbnailSpringField.scaleDisplacement),
        velocity: thumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity),
        destination: target.scale,
        destinationDuringSteps: thumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination),
      },
    ], {settleCheck: sourceField.settleCheck, snap: snapThumbnails})
    // Clamped only where drawn, e.g. a scale that undershoots 0 while springing
    // keeps its stored displacement.
    const centerX = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[0]!),
      sourceField.viewportWidth,
    )
    const scale = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[1]!),
      sourceField.unit,
    )
    nextThumbnailSprings.push([
      thumbnail.displacements[0]!,
      thumbnail.velocities[0]!,
      target.centerX,
      thumbnail.displacements[1]!,
      thumbnail.velocities[1]!,
      target.scale,
    ])
    thumbnailProjections.push(projectThumbnail({
      centerX,
      scale,
      focused: target.focused,
    }))
    thumbnailActivityTerms.push([thumbnail.active, 1])
  }
  const animationActive = emitClampZeroOne(
    circuit,
    circuit.affine(thumbnailActivityTerms),
  )
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    const thisFocused = nextFocus[item]!
    const project = (gridProjection: Wire, mainValue: Wire) => circuit.affine([
      [gridProjection, 1],
      [emitMultiply(circuit, thisFocused, mainValue), 1],
    ])
    photos.push({
      left: project(projectedGridLeft[column]!, main.left),
      top: project(projectedGridTop[row]!, main.top),
      width: project(projectedGridWidth, main.width),
      height: project(projectedGridHeight, main.height),
      opacity: emitMultiply(
        circuit,
        sourceField.present,
        circuit.affine([[nextGridMass, 1], [thisFocused, 1]]),
      ),
      focused: thisFocused,
    })
  }

  const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
  for (const eventField of eventFields) nextSource[eventField] = zero
  // The stored table holds the identity matrix and no settle check or snap, so
  // evaluating it directly runs 0 steps.
  nextSource[sourceField.springMatrixStart] = sourceField.unit
  nextSource[sourceField.springMatrixStart + 1] = zero
  nextSource[sourceField.springMatrixStart + 2] = zero
  nextSource[sourceField.springMatrixStart + 3] = sourceField.unit
  nextSource[sourceField.settleCheck] = zero
  nextSource[sourceField.snap] = zero
  for (let item = 0; item < itemCount; item++) {
    nextSource[focusField(item)] = nextFocus[item]!
    const spring = nextThumbnailSprings[item]!
    for (let field = 0; field < thumbnailSpringField.size; field++) {
      nextSource[thumbnailSpringSourceField(item, field)] = spring[field]!
    }
  }
  const previousControlOutput = [
    previousControl.left,
    previousControl.top,
    previousControl.width,
    previousControl.height,
    emitMultiply(circuit, sourceField.present, nextFocusMass),
  ]
  const nextControlOutput = [
    nextControl.left,
    nextControl.top,
    nextControl.width,
    nextControl.height,
    emitMultiply(circuit, sourceField.present, nextFocusMass),
  ]

  return {
    circuit,
    output: {
      nextSource,
      backdropOpacity: emitMultiply(circuit, sourceField.present, nextFocusMass),
      animationActive,
      photos: flattenProjections(photos),
      thumbnails: flattenProjections(thumbnailProjections),
      previousControl: previousControlOutput,
      nextControl: nextControlOutput,
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

type PhotoGalleryEvent = {
  kind: 'mount' | 'resize' | 'click' | 'previous' | 'next' | 'close'
  // Shares the time origin of requestAnimationFrame timestamps, e.g. event.timeStamp.
  timeStamp: number
  // Writes the event into the table: a latch, or the viewport for a mount or resize.
  apply: (table: Float32Array) => void
}

type PhotoGalleryEvaluation = {
  kind: EvaluationKind
  timeMs: number
  steps: number
  writesBack: boolean
  events: PhotoGalleryEvent['kind'][]
}

type PhotoGalleryObserver = {
  // The table just before an evaluation, after the host wrote the matrix, the
  // bits, present, interactive and the events.
  beforeEvaluate?: (table: Float32Array, evaluation: PlannedEvaluation<PhotoGalleryEvent>) => void
  // The evaluated values, and the table: the stored table after write-back, or
  // the copy that a 'frame' evaluation ran on.
  afterEvaluate?: (values: Float32Array, table: Float32Array, evaluation: PlannedEvaluation<PhotoGalleryEvent>) => void
}

export function createPhotoGalleryMachine(options: {writeBack?: WriteBack} = {}) {
  const writeBack = options.writeBack ?? 'events and settle checks'
  const source = new Float32Array(sourceField.size)
  source[sourceField.gap] = 18
  source[sourceField.mainInset] = 92
  source[sourceField.thumbnailHeight] = 82
  source[sourceField.controlSize] = 52
  source[sourceField.present] = 1
  source[sourceField.interactive] = 1
  source[sourceField.unit] = 1
  source.set(springMatrixPowers[0]!, sourceField.springMatrixStart)
  const {circuit, output} = createPhotoGalleryCircuit()
  const wireCount = validateCircuit(circuit)
  validatePhotoGalleryOutputWires(output, wireCount)
  const roots = [
    ...output.nextSource,
    output.backdropOpacity,
    output.animationActive,
    ...output.photos,
    ...output.thumbnails,
    ...output.previousControl,
    ...output.nextControl,
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
  let queued: (Omit<PhotoGalleryEvent, 'timeStamp'> & {timeStamp: number | undefined})[] = []
  let mounted = false
  let queuedViewport: readonly [width: number, height: number] = [0, 0]
  let previousFrameTime = 0
  let present = 1
  let interactive = 1
  const observers: PhotoGalleryObserver[] = []
  const evaluations: PhotoGalleryEvaluation[] = []
  // The stored table as the last step left it. Only step() writes the stored table,
  // so a difference at the next step is a write from outside the machine.
  const storedAfterLastStep = Float32Array.from(source)

  function queue(kind: PhotoGalleryEvent['kind'], timeStamp: number | undefined, apply: (table: Float32Array) => void) {
    invariant(timeStamp === undefined || Number.isFinite(timeStamp), 'an event timestamp must be finite')
    const event = {kind, timeStamp, apply}
    // A mount applies before the events queued before the first step.
    if (kind === 'mount') queued.unshift(event)
    else queued.push(event)
  }

  function queueViewport(kind: 'mount' | 'resize', width: number, height: number, timeStamp: number | undefined) {
    queuedViewport = [width, height]
    queue(kind, timeStamp, table => {
      table[sourceField.viewportWidth] = width
      table[sourceField.viewportHeight] = height
    })
  }

  function receiveEvent(
    kind: 'click' | 'previous' | 'next' | 'close',
    field: number,
    timeStamp: number | undefined,
    x?: number,
    y?: number,
  ) {
    queue(kind, timeStamp, table => {
      for (const eventField of eventFields) table[eventField] = 0
      table[field] = 1
      if (x !== undefined && y !== undefined) {
        table[sourceField.clickX] = x
        table[sourceField.clickY] = y
      }
    })
  }

  // One evaluation that advanceFrame planned: write the matrix, the settle check
  // and snap bits, present, interactive and the events, evaluate, and write next
  // state back when the evaluation writes back.
  function evaluate(evaluation: PlannedEvaluation<PhotoGalleryEvent>) {
    const table = evaluation.writesBack ? source : scratch
    if (!evaluation.writesBack) scratch.set(source)
    table.set(springMatrixPowers[evaluation.steps]!, sourceField.springMatrixStart)
    table[sourceField.settleCheck] = evaluation.settleCheck ? 1 : 0
    table[sourceField.snap] = evaluation.snap ? 1 : 0
    // present and interactive set no destination, so every evaluation of a step
    // reads the ones passed to that step, e.g. a click's evaluation.
    table[sourceField.present] = present
    table[sourceField.interactive] = interactive
    for (const event of evaluation.events) event.apply(table)
    validateGallerySource(table, numericTolerance)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    validatePhotoGalleryOutput(values, output, numericTolerance)
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
    evaluations: evaluations as readonly PhotoGalleryEvaluation[],
    observe(observer: PhotoGalleryObserver) {
      observers.push(observer)
    },
    // Runs the frame at frameTime, by default 16 ms after the previous frame, and
    // returns the values of its 'frame' evaluation. An event without a timestamp
    // applies at this frame's time.
    step(
      viewportWidth: number,
      viewportHeight: number,
      nextPresent = 1,
      nextInteractive = 1,
      frameTime = previousFrameTime + 16,
    ) {
      invariant(Number.isFinite(frameTime), 'frame time must be finite')
      // A value written straight into `source` between steps, e.g. a latch, would
      // apply only in 'frame' evaluations, which run on a copy, so it would never
      // commit, and a latch would apply again in every later frame. Values written
      // before the first step commit with the mount, e.g. a changed constant.
      if (mounted) {
        for (let field = 0; field < source.length; field++) {
          if (source[field] !== storedAfterLastStep[field]) {
            invariant(false, `source cell ${field} was written between steps. Queue input with the event methods instead, e.g. click(x, y, timeStamp) or resize(width, height, timeStamp)`)
          }
        }
      }
      present = nextPresent
      interactive = nextInteractive
      if (!mounted) {
        mounted = true
        const earliest = queued.reduce((time, event) => Math.min(time, event.timeStamp ?? frameTime), frameTime)
        queueViewport('mount', viewportWidth, viewportHeight, earliest)
      } else if (viewportWidth !== queuedViewport[0] || viewportHeight !== queuedViewport[1]) {
        // The viewport sets thumbnail destinations, so a change reaches the program
        // as an event. Written without one, it would change destinations only in
        // frame evaluations, which never start the clock.
        queueViewport('resize', viewportWidth, viewportHeight, frameTime)
      }
      const events = queued.map(event => ({...event, timeStamp: event.timeStamp ?? frameTime}))
      queued = []
      evaluations.length = 0
      clock = advanceFrame(clock, frameTime, events, evaluate, writeBack)
      previousFrameTime = frameTime
      storedAfterLastStep.set(source)
      return Float32Array.from(values)
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', width, height, timeStamp)
    },
    click(x: number, y: number, timeStamp?: number) {
      receiveEvent('click', sourceField.clickActive, timeStamp, x, y)
    },
    previous(timeStamp?: number) {
      receiveEvent('previous', sourceField.previousActive, timeStamp)
    },
    next(timeStamp?: number) {
      receiveEvent('next', sourceField.nextActive, timeStamp)
    },
    close(timeStamp?: number) {
      receiveEvent('close', sourceField.closeActive, timeStamp)
    },
  }
}

function thumbnailFalloff(distance: number) {
  return Math.max(0, 1 - 0.22 * distance)
}

function thumbnailFalloffMass() {
  let mass = thumbnailFalloff(0)
  for (let distance = 1; distance < 5; distance++) {
    mass += 2 * thumbnailFalloff(distance)
  }
  return mass
}

function thumbnailSpread(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) {
    spread += (
      thumbnailFalloff(step - 1)
      + thumbnailFalloff(step)
    ) / 2
  }
  return spread
}

function flattenProjections(projections: readonly PhotoProjection[]) {
  const output: Wire[] = []
  for (const projection of projections) {
    output.push(
      projection.left,
      projection.top,
      projection.width,
      projection.height,
      projection.opacity,
      projection.focused,
    )
  }
  return output
}

export function createPhotoGalleryRenderer(document: Document, root: HTMLElement) {
  const backdrop = root.querySelector<HTMLElement>('.photos-backdrop')
  const previousControl = root.querySelector<HTMLElement>('.photos-previous')
  const nextControl = root.querySelector<HTMLElement>('.photos-next')
  invariant(backdrop !== null, 'backdrop is missing')
  invariant(previousControl !== null, 'previous control is missing')
  invariant(nextControl !== null, 'next control is missing')
  const photoElements = Array<HTMLElement | null>(itemCount).fill(null)
  const thumbnailElements = Array<HTMLElement | null>(itemCount).fill(null)

  function projectGeometry(
    element: HTMLElement,
    values: Float32Array,
    output: readonly Wire[],
    outputStart = 0,
  ) {
    const left = values[output[outputStart + controlField.left]!]!
    const top = values[output[outputStart + controlField.top]!]!
    element.style.width = `${values[output[outputStart + controlField.width]!]!}px`
    element.style.height = `${values[output[outputStart + controlField.height]!]!}px`
    element.style.transform = `translate3d(${left}px,${top}px,0)`
  }

  function createPhotoElement(item: number, thumbnail: boolean) {
    const element = document.createElement('div')
    element.className =
      `${thumbnail ? 'photos-thumbnail' : 'photos-photo'} image-${item}`
    if (!thumbnail) {
      const title = document.createElement('span')
      title.textContent = photoNames[item]!
      element.appendChild(title)
    }
    root.appendChild(element)
    return element
  }

  function projectItem(
    elements: (HTMLElement | null)[],
    item: number,
    values: Float32Array,
    output: readonly Wire[],
    fields: typeof photoField,
    classKind: 'photo' | 'thumbnail',
  ) {
    const outputStart = item * fields.size
    const width = values[output[outputStart + fields.width]!]!
    const height = values[output[outputStart + fields.height]!]!
    const opacity = values[output[outputStart + fields.opacity]!]!
    const visible = width > 0 && height > 0 && opacity > 0
    let element = elements[item] ?? null
    if (!visible) {
      if (element !== null) {
        element.remove()
        elements[item] = null
      }
      return
    }
    if (element === null) {
      element = createPhotoElement(item, classKind === 'thumbnail')
      elements[item] = element
    }
    projectGeometry(element, values, output, outputStart)
    element.style.opacity = `${opacity}`
    element.style.setProperty(
      '--focused',
      `${values[output[outputStart + fields.focused]!]}`,
    )
  }

  return {
    render(values: Float32Array, output: PhotoGalleryOutput) {
      backdrop.style.opacity = `${values[output.backdropOpacity]}`
      for (let item = 0; item < itemCount; item++) {
        projectItem(
          photoElements,
          item,
          values,
          output.photos,
          photoField,
          'photo',
        )
        projectItem(
          thumbnailElements,
          item,
          values,
          output.thumbnails,
          thumbnailField,
          'thumbnail',
        )
      }
      projectGeometry(previousControl, values, output.previousControl)
      projectGeometry(nextControl, values, output.nextControl)
      previousControl.style.opacity =
        `${values[output.previousControl[controlField.opacity]!]}`
      nextControl.style.opacity =
        `${values[output.nextControl[controlField.opacity]!]}`
    },
  }
}

function emitRectangleHit(circuit: Circuit, geometry: Geometry): Wire {
  const horizontalHit = emitIntervalHit(
    circuit,
    sourceField.clickX,
    geometry.left,
    geometry.width,
  )
  const verticalHit = emitIntervalHit(
    circuit,
    sourceField.clickY,
    geometry.top,
    geometry.height,
  )
  return emitMinimum(circuit, horizontalHit, verticalHit)
}

function emitIntervalHit(circuit: Circuit, position: Wire, start: Wire, size: Wire): Wire {
  return circuit.boolean(
    emitClampZeroOne(circuit, emitIntervalDistance(circuit, position, start, size)),
  )
}

function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire): Wire {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(
    circuit,
    circuit.affine([[position, 1], [start, -1]]),
    circuit.affine([[end, 1], [position, -1]]),
  )
}

function validateGallerySource(values: unknown, tolerance = 1e-9) {
  invariant(
    values instanceof Float32Array,
    'source table must be a Float32Array',
  )
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  assertNonNegativeFinite(values[sourceField.gap], 'gap')
  assertNonNegativeFinite(values[sourceField.mainInset], 'main inset')
  assertNonNegativeFinite(values[sourceField.thumbnailHeight], 'thumbnail height')
  assertNonNegativeFinite(values[sourceField.controlSize], 'control size')
  assertUnitInterval(values[sourceField.present], 'present', tolerance)
  assertBit(values[sourceField.interactive], 'interactive')
  invariant(values[sourceField.unit] === 1, 'unit must equal one')
  for (let entry = 0; entry < 4; entry++) {
    invariant(
      Number.isFinite(values[sourceField.springMatrixStart + entry]),
      'spring matrix entries must be finite',
    )
  }
  assertBit(values[sourceField.settleCheck], 'settle check')
  assertBit(values[sourceField.snap], 'snap')
  invariant(Number.isFinite(values[sourceField.clickX]), 'click x must be finite')
  invariant(Number.isFinite(values[sourceField.clickY]), 'click y must be finite')
  let eventMass = 0
  for (const eventField of eventFields) {
    assertUnitInterval(values[eventField], 'event latch', tolerance)
    eventMass += values[eventField]
  }
  invariant(eventMass <= 1 + tolerance, 'event mass must not exceed 1')
  let focusMass = 0
  for (let item = 0; item < itemCount; item++) {
    const focus = values[focusField(item)]
    assertUnitInterval(focus, `focus ${item}`, tolerance)
    focusMass += focus
    for (const field of [
      thumbnailSpringField.centerXDisplacement,
      thumbnailSpringField.centerXVelocity,
      thumbnailSpringField.scaleDisplacement,
      thumbnailSpringField.scaleVelocity,
    ]) {
      invariant(
        Number.isFinite(values[thumbnailSpringSourceField(item, field)]),
        `thumbnail ${item} spring state must be finite`,
      )
    }
    const centerDestination =
      values[thumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination)]!
    invariant(
      centerDestination >= -16_384 && centerDestination <= 32_768,
      `thumbnail ${item} center destination must be within -16384..32768, got ${centerDestination}`,
    )
    assertUnitInterval(
      values[thumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination)],
      `thumbnail ${item} scale destination`,
      tolerance,
    )
  }
  invariant(focusMass <= 1 + tolerance, 'focus mass must not exceed 1')
}

export function validatePhotoGalleryOutputWires(
  output: PhotoGalleryOutput,
  wireCount: number,
) {
  validateWireView(output.nextSource, sourceField.size, wireCount)
  assertWire(output.backdropOpacity, wireCount)
  assertWire(output.animationActive, wireCount)
  validateWireView(output.photos, itemCount * photoField.size, wireCount)
  validateWireView(output.thumbnails, itemCount * thumbnailField.size, wireCount)
  validateWireView(output.previousControl, controlField.size, wireCount)
  validateWireView(output.nextControl, controlField.size, wireCount)
}

export function validatePhotoGalleryOutput(
  values: Float32Array,
  output: PhotoGalleryOutput,
  tolerance = 1e-9,
) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = Float32Array.from(output.nextSource, wire => values[wire]!)
  validateGallerySource(nextSource, tolerance)
  for (const eventField of eventFields) {
    invariant(nextSource[eventField] === 0, 'event latch must reset after refresh')
  }
  assertUnitInterval(values[output.backdropOpacity], 'backdrop opacity', tolerance)
  assertUnitInterval(values[output.animationActive], 'animation active', tolerance)
  for (let item = 0; item < itemCount; item++) {
    const outputStart = item * photoField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[output.photos[outputStart + photoField[field]]!], `photo ${field}`)
    }
    assertUnitInterval(
      values[output.photos[outputStart + photoField.opacity]!],
      'photo opacity',
      tolerance,
    )
    assertUnitInterval(
      values[output.photos[outputStart + photoField.focused]!],
      'photo focus',
      tolerance,
    )
  }
  for (let item = 0; item < itemCount; item++) {
    const outputStart = item * thumbnailField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(
        values[output.thumbnails[outputStart + thumbnailField[field]]!],
        `thumbnail ${field}`,
      )
    }
    assertUnitInterval(
      values[output.thumbnails[outputStart + thumbnailField.opacity]!],
      'thumbnail opacity',
      tolerance,
    )
    assertUnitInterval(
      values[output.thumbnails[outputStart + thumbnailField.focused]!],
      'thumbnail focus',
      tolerance,
    )
  }
  for (const control of [output.previousControl, output.nextControl]) {
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[control[controlField[field]]!], `control ${field}`)
    }
    assertUnitInterval(values[control[controlField.opacity]!], 'control opacity', tolerance)
  }
}

function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

function assertBit(value: number | undefined, label: string): asserts value is number {
  invariant(value === 0 || value === 1, `${label} must equal zero or one, got ${value}`)
}
