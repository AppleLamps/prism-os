import {
  type Circuit,
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
} from '../runtime/numeric-ui-core.ts'
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
} from '../runtime/host-timing.ts'
import {
  type CellWires,
  type SourceTable,
  anyNumber,
  constant,
  createSourceTable,
  event,
  fieldIndices,
  input,
  inputBit,
  list,
  oneHot,
  state,
  stateBit,
  unitInterval,
} from '../runtime/cells.ts'

export const itemCount = 12
export const columnCount = 4
export const rowCount = 3

// Thumbnails and IndirectOS's windows share these constants, so one spring matrix
// serves both.
export const springConstants: SpringConstants = {stiffness: 650, damping: 45}
// Every FP32 matrix entry the host writes for up to 300 steps stays within this
// bound.
const matrixBound = springMatrixBound(springConstants)

// Per thumbnail: each spring's displacement from the destination in effect, its
// velocity, and that destination. The drawn value is destination + displacement,
// which the program computes and doesn't store. Displacements and velocities need
// no declared range. The destinations written back are this evaluation's thumbnail
// targets. A target center is the viewport's middle plus at most about 232 px
// either way, so -16,384..32,768 holds it for any viewport within 0..16,384.
const thumbnailSpringCells = {
  centerXDisplacement: state(anyNumber),
  centerXVelocity: state(anyNumber),
  centerXDestination: state([-16_384, 32_768]),
  scaleDisplacement: state(anyNumber),
  scaleVelocity: state(anyNumber),
  scaleDestination: state(unitInterval),
}

// Photos' own cells. A host declares them once, e.g. nested as {photos: photoCells}
// in IndirectOS, adds the rule for photoEvents, and passes the cells' wires to
// buildPhotos.
export const photoCells = {
  // Spacing and control-size constants live in the tens of pixels; 1024 is
  // generous.
  gap: constant(18, [0, 1024]),
  mainInset: constant(92, [0, 1024]),
  thumbnailHeight: constant(82, [0, 1024]),
  controlSize: constant(52, [0, 1024]),
  // x and y are in the host's coordinates, e.g. IndirectOS's viewport coordinates.
  // The host passes buildPhotos the click position relative to Photos' content box.
  click: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  previous: event(),
  next: event(),
  close: event(),
  // The open photo, or none while the grid shows.
  focus: oneHot(list(itemCount, () => stateBit()), {allowAllZero: true, declareToCircuit: false}),
  thumbnails: list(itemCount, () => thumbnailSpringCells),
}
type PhotoCells = CellWires<typeof photoCells>

// Photos' event cells. A later event within one evaluation replaces an earlier one,
// so at most one of them is 1, e.g. table.atMostOne('photos events',
// photoEvents(cells.photos)).
export function photoEvents(cells: PhotoCells) {
  return [cells.click.active, cells.previous, cells.next, cells.close]
}

const {thumbnails: thumbnailCells, ...photoCellsBeforeThumbnails} = photoCells
// Photos on its own, with the cells that a host otherwise provides: the viewport,
// how visible Photos is, whether Photos takes events, the unit, and what advanceFrame
// plans. The table keeps the layout it had before Photos became a component, with
// these cells between the focus cells and the thumbnails.
const photoGalleryCells = {
  viewportWidth: input([0, 16_384]),
  viewportHeight: input([0, 16_384]),
  ...photoCellsBeforeThumbnails,
  present: input(unitInterval, {initial: 1}),
  interactive: inputBit(1),
  unit: constant(1, [1, 1]),
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
  thumbnails: thumbnailCells,
}

// The standalone table's cell positions under their earlier names, e.g.
// sourceField.clickX is the position of click.x, and
// thumbnailSpringField.centerXDestination is the index of centerXDestination within
// one thumbnail's spring cells.
const layout = createSourceTable()
const positions = layout.declare(photoGalleryCells)

export const thumbnailSpringField = fieldIndices(thumbnailSpringCells)

export const sourceField = {
  viewportWidth: positions.viewportWidth,
  viewportHeight: positions.viewportHeight,
  gap: positions.gap,
  mainInset: positions.mainInset,
  thumbnailHeight: positions.thumbnailHeight,
  controlSize: positions.controlSize,
  clickActive: positions.click.active,
  clickX: positions.click.x,
  clickY: positions.click.y,
  previousActive: positions.previous,
  nextActive: positions.next,
  closeActive: positions.close,
  focusStart: positions.focus[0]!,
  present: positions.present,
  interactive: positions.interactive,
  unit: positions.unit,
  springMatrixStart: positions.springMatrix[0],
  settleCheck: positions.settleCheck,
  snap: positions.snap,
  thumbnailSpringStart: positions.thumbnails[0]!.centerXDisplacement,
  size: layout.size,
}

export function focusField(item: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < itemCount, 'photo index is invalid')
  return positions.focus[item]!
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

// What buildPhotos returns, e.g. IndirectOS's output.photos.
export type PhotoOutputs = {
  backdropOpacity: Wire
  animationActive: Wire
  photos: Wire[]
  thumbnails: Wire[]
  previousControl: Wire[]
  nextControl: Wire[]
}

// The standalone gallery's outputs, with the wire that holds each cell's next value.
export type PhotoGalleryOutput = PhotoOutputs & {nextSource: Wire[]}

// The host's wires that Photos reads: the content box's size, the click position
// relative to the content box, how visible Photos is, whether Photos takes events,
// the unit, and what advanceFrame plans.
type PhotoHost = {
  viewportWidth: Wire
  viewportHeight: Wire
  click: {x: Wire, y: Wire}
  present: Wire
  interactive: Wire
  unit: Wire
  springMatrix: SpringMatrixWires
  settleCheck: Wire
  snap: Wire
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

// Builds Photos into the host's circuit, pairs Photos' state cells with their next
// values, and returns Photos' outputs.
export function buildPhotos(circuit: Circuit, table: SourceTable, cells: PhotoCells, host: PhotoHost): PhotoOutputs {
  // The ranges that Photos assumes of the host's wires. Pixel-space sizes carry an
  // honest finite ceiling: 16384 covers the largest real displays (8K is 7680 wide)
  // with headroom while staying far inside FP32's exact-integer band
  // (execution-model.md's macro contracts keep min, max and clamp operands under
  // 2^23). Finite bounds also make the geometry eligible for gather lowering. In
  // IndirectOS, the bounds are contracts on the window's content size, which is
  // clamped to the viewport and so honors them.
  circuit.assumeRange(host.viewportWidth, 0, 16_384)
  circuit.assumeRange(host.viewportHeight, 0, 16_384)
  circuit.assumeRange(host.present, 0, 1)
  circuit.assumeRange(host.interactive, 0, 1)
  circuit.assumeRange(host.unit, 1, 1)
  for (const entry of host.springMatrix) circuit.assumeRange(entry, -matrixBound, matrixBound)
  circuit.assumeRange(host.settleCheck, 0, 1)
  circuit.assumeRange(host.snap, 0, 1)
  const {viewportWidth, viewportHeight, click, present, interactive, unit} = host
  const events = photoEvents(cells)
  const zero = circuit.constant(0)
  const gridWidth = emitRelu(
    circuit,
    circuit.affine([
      [viewportWidth, 1 / columnCount],
      [cells.gap, -(columnCount + 1) / columnCount],
    ]),
  )
  const gridHeight = emitRelu(
    circuit,
    circuit.affine([
      [viewportHeight, 1 / rowCount],
      [cells.gap, -(rowCount + 1) / rowCount],
    ]),
  )

  const gridLeft = Array.from({length: columnCount}, (_, column) =>
    circuit.affine([[cells.gap, 1 + column], [gridWidth, column]]))
  const gridTop = Array.from({length: rowCount}, (_, row) =>
    circuit.affine([[cells.gap, 1 + row], [gridHeight, row]]))
  const gridColumnHit = gridLeft.map(left =>
    emitIntervalHit(circuit, click.x, left, gridWidth))
  const gridRowHit = gridTop.map(top =>
    emitIntervalHit(circuit, click.y, top, gridHeight))
  const gridHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    gridHit.push(emitMinimum(circuit, gridColumnHit[column]!, gridRowHit[row]!))
  }

  const thumbnailBaseSize = emitMinimum(
    circuit,
    cells.thumbnailHeight,
    emitMinimum(
      circuit,
      circuit.affine([[viewportWidth, 1 / 6]]),
      circuit.affine([[viewportHeight, 0.24]]),
    ),
  )
  const mainInset = emitMinimum(
    circuit,
    cells.mainInset,
    circuit.affine([[viewportWidth, 0.08]]),
  )
  const main: Geometry = {
    left: mainInset,
    top: cells.gap,
    width: emitRelu(circuit, circuit.affine([
      [viewportWidth, 1],
      [mainInset, -2],
    ])),
    height: emitRelu(circuit, circuit.affine([
      [viewportHeight, 1],
      [thumbnailBaseSize, -1],
      [cells.gap, -3],
    ])),
  }
  const mainHit = emitRectangleHit(circuit, click, main)

  const previousFocusMass = circuit.affine(cells.focus.map(wire => [wire, 1]))
  circuit.assumeRange(previousFocusMass, 0, 1)
  const previousGridMass = circuit.affine([[previousFocusMass, -1]], 1)

  const thumbnailOuterInset = emitMinimum(
    circuit,
    cells.gap,
    circuit.affine([[viewportWidth, 0.5]]),
  )
  const thumbnailImageSpan = circuit.affine([
    [thumbnailBaseSize, thumbnailFalloffMass()],
  ])
  const thumbnailGap = emitMinimum(
    circuit,
    circuit.constant(12),
    emitRelu(circuit, circuit.affine([
      [viewportWidth, 1 / 8],
      [thumbnailOuterInset, -2 / 8],
      [thumbnailImageSpan, -1 / 8],
    ])),
  )
  const thumbnailCenterY = circuit.affine([
    [viewportHeight, 1],
    [cells.gap, -1],
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
        [viewportWidth, 0.5],
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
    const visibleScale = emitMultiply(circuit, present, target.scale)
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

  const currentThumbnailTargets = projectThumbnailTargets(cells.focus, previousFocusMass)
  const thumbnailHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    thumbnailHit.push(emitRectangleHit(circuit, click, projectThumbnail(currentThumbnailTargets[item]!)))
  }

  const controlTop = emitRelu(circuit, circuit.affine([
    [cells.gap, 1],
    [main.height, 0.5],
    [cells.controlSize, -0.5],
  ]))
  const controlInset = circuit.affine([[cells.gap, 0.5]])
  const previousControl: Geometry = {
    left: controlInset,
    top: controlTop,
    width: cells.controlSize,
    height: cells.controlSize,
  }
  const nextControl: Geometry = {
    left: emitRelu(circuit, circuit.affine([
      [viewportWidth, 1],
      [controlInset, -1],
      [cells.controlSize, -1],
    ])),
    top: controlTop,
    width: cells.controlSize,
    height: cells.controlSize,
  }
  const controlVerticalHit = emitIntervalHit(
    circuit,
    click.y,
    controlTop,
    cells.controlSize,
  )
  const previousControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      click.x,
      previousControl.left,
      previousControl.width,
    ),
    controlVerticalHit,
  )
  const nextControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      click.x,
      nextControl.left,
      nextControl.width,
    ),
    controlVerticalHit,
  )

  const effectiveEvents = events.map(wire =>
    emitMultiply(circuit, interactive, wire))
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
    const previousShift = cells.focus[(item + 1) % itemCount]!
    const nextShift = cells.focus[(item + itemCount - 1) % itemCount]!
    nextFocus.push(circuit.affine([
      [emitMultiply(circuit, currentFocusGate, cells.focus[item]!), 1],
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
    circuit.affine([[animateThumbnails, -1], [host.snap, 1]], 1),
  )
  const thumbnailProjections: PhotoProjection[] = []
  const thumbnailActivityTerms: [Wire, number][] = []
  for (let item = 0; item < itemCount; item++) {
    const target = thumbnailTargets[item]!
    // centerX and scale settle together. The steps simulate time before this
    // evaluation's events, so they pull toward the destinations that the previous
    // evaluation wrote back.
    const thumbnail = emitAnimatedObject(circuit, [
      {
        matrix: host.springMatrix,
        displacement: cells.thumbnails[item]!.centerXDisplacement,
        velocity: cells.thumbnails[item]!.centerXVelocity,
        destination: target.centerX,
        destinationDuringSteps: cells.thumbnails[item]!.centerXDestination,
      },
      {
        matrix: host.springMatrix,
        displacement: cells.thumbnails[item]!.scaleDisplacement,
        velocity: cells.thumbnails[item]!.scaleVelocity,
        destination: target.scale,
        destinationDuringSteps: cells.thumbnails[item]!.scaleDestination,
      },
    ], {settleCheck: host.settleCheck, snap: snapThumbnails})
    // Clamped only where drawn, e.g. a scale that undershoots 0 while springing
    // keeps its stored displacement.
    const centerX = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[0]!),
      viewportWidth,
    )
    const scale = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[1]!),
      unit,
    )
    table.next(cells.thumbnails[item]!, {
      centerXDisplacement: thumbnail.displacements[0]!,
      centerXVelocity: thumbnail.velocities[0]!,
      centerXDestination: target.centerX,
      scaleDisplacement: thumbnail.displacements[1]!,
      scaleVelocity: thumbnail.velocities[1]!,
      scaleDestination: target.scale,
    })
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
        present,
        circuit.affine([[nextGridMass, 1], [thisFocused, 1]]),
      ),
      focused: thisFocused,
    })
  }

  table.next(cells.focus, nextFocus)
  const previousControlOutput = [
    previousControl.left,
    previousControl.top,
    previousControl.width,
    previousControl.height,
    emitMultiply(circuit, present, nextFocusMass),
  ]
  const nextControlOutput = [
    nextControl.left,
    nextControl.top,
    nextControl.width,
    nextControl.height,
    emitMultiply(circuit, present, nextFocusMass),
  ]

  return {
    backdropOpacity: emitMultiply(circuit, present, nextFocusMass),
    animationActive,
    photos: flattenProjections(photos),
    thumbnails: flattenProjections(thumbnailProjections),
    previousControl: previousControlOutput,
    nextControl: nextControlOutput,
  }
}

// Photos on its own, in a table that also holds the host's cells. The program writes
// back the identity matrix and 0 settle check and snap bits.
export function createPhotoGalleryCircuit() {
  const table = createSourceTable()
  const cells = table.declare(photoGalleryCells)
  table.atMostOne('events', photoEvents(cells))
  const circuit = table.createCircuit()
  const photos = buildPhotos(circuit, table, cells, {
    viewportWidth: cells.viewportWidth,
    viewportHeight: cells.viewportHeight,
    click: cells.click,
    present: cells.present,
    interactive: cells.interactive,
    unit: cells.unit,
    springMatrix: cells.springMatrix,
    settleCheck: cells.settleCheck,
    snap: cells.snap,
  })
  // The stored table holds the identity matrix and no settle check or snap, so
  // evaluating it directly runs 0 steps.
  const zero = circuit.constant(0)
  table.next(
    {springMatrix: cells.springMatrix, settleCheck: cells.settleCheck, snap: cells.snap},
    {springMatrix: [cells.unit, zero, zero, cells.unit], settleCheck: zero, snap: zero},
  )
  const {nextSource, initialSource, validate} = table.finish()
  const output: PhotoGalleryOutput = {nextSource, ...photos}
  return {circuit, cells, output, initialSource, validate}
}

// What the host writes into the 4 matrix cells for each step count, see
// advanceFrame in host-timing.ts. IndirectOS writes the same matrices.
const springStep = springStepMatrix(springConstants)
export const springMatrixPowers = Array.from(
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
  const {circuit, cells, output, initialSource, validate} = createPhotoGalleryCircuit()
  const source = new Float32Array(initialSource)
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
  const evaluateRoots = circuit.createTensorProgramEvaluator(tensorProgram)
  const values = new Float32Array(wireCount)
  const scratch = new Float32Array(source.length)
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
      table[cells.viewportWidth] = width
      table[cells.viewportHeight] = height
    })
  }

  function receiveEvent(
    kind: 'click' | 'previous' | 'next' | 'close',
    field: Wire,
    timeStamp: number | undefined,
    x?: number,
    y?: number,
  ) {
    queue(kind, timeStamp, table => {
      for (const eventField of photoEvents(cells)) table[eventField] = 0
      table[field] = 1
      if (x !== undefined && y !== undefined) {
        table[cells.click.x] = x
        table[cells.click.y] = y
      }
    })
  }

  // One evaluation that advanceFrame planned: write the matrix, the settle check
  // and snap bits, present, interactive and the events, evaluate, and write next
  // state back when the evaluation writes back.
  function evaluate(evaluation: PlannedEvaluation<PhotoGalleryEvent>) {
    const table = evaluation.writesBack ? source : scratch
    if (!evaluation.writesBack) scratch.set(source)
    table.set(springMatrixPowers[evaluation.steps]!, cells.springMatrix[0])
    table[cells.settleCheck] = evaluation.settleCheck ? 1 : 0
    table[cells.snap] = evaluation.snap ? 1 : 0
    // present and interactive set no destination, so every evaluation of a step
    // reads the ones passed to that step, e.g. a click's evaluation.
    table[cells.present] = present
    table[cells.interactive] = interactive
    for (const event of evaluation.events) event.apply(table)
    validate(table)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    // The next-state values are the first roots. Only roots are written into
    // `values`, so the finite check covers the roots, not every wire.
    const nextSourceValues = rootValues.subarray(0, source.length)
    validate(nextSourceValues)
    assertFiniteValues(rootValues, 'tensor output')
    validatePhotoGalleryOutput(values, output, numericTolerance)
    if (evaluation.writesBack) source.set(nextSourceValues)
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
    evaluations: evaluations as readonly PhotoGalleryEvaluation[],
    observe(observer: PhotoGalleryObserver) {
      observers.push(observer)
    },
    // Runs the frame at frameTime, by default 16 ms after the previous frame, and
    // returns the values of its 'frame' evaluation. An event without a timestamp
    // applies at this frame's time. The returned values, indexed by wire, are the
    // machine's own array, which the next step overwrites, so a caller that keeps a
    // frame's values across steps copies them, e.g. with values.slice().
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
      return values
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', width, height, timeStamp)
    },
    click(x: number, y: number, timeStamp?: number) {
      receiveEvent('click', cells.click.active, timeStamp, x, y)
    },
    previous(timeStamp?: number) {
      receiveEvent('previous', cells.previous, timeStamp)
    },
    next(timeStamp?: number) {
      receiveEvent('next', cells.next, timeStamp)
    },
    close(timeStamp?: number) {
      receiveEvent('close', cells.close, timeStamp)
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
    render(values: Float32Array, output: PhotoOutputs) {
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

function emitRectangleHit(circuit: Circuit, click: {x: Wire, y: Wire}, geometry: Geometry): Wire {
  const horizontalHit = emitIntervalHit(
    circuit,
    click.x,
    geometry.left,
    geometry.width,
  )
  const verticalHit = emitIntervalHit(
    circuit,
    click.y,
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

// How far the position lies inside the interval from start to start + size: the
// smaller of its distances to the two ends, e.g. 3 when the position is 3 px past
// start in a 100 px interval, and negative outside the interval. IndirectOS's dock
// hit test uses it too.
export function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire): Wire {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(
    circuit,
    circuit.affine([[position, 1], [start, -1]]),
    circuit.affine([[end, 1], [position, -1]]),
  )
}

export function validatePhotoGalleryOutputWires(
  output: PhotoOutputs,
  wireCount: number,
) {
  assertWire(output.backdropOpacity, wireCount)
  assertWire(output.animationActive, wireCount)
  validateWireView(output.photos, itemCount * photoField.size, wireCount)
  validateWireView(output.thumbnails, itemCount * thumbnailField.size, wireCount)
  validateWireView(output.previousControl, controlField.size, wireCount)
  validateWireView(output.nextControl, controlField.size, wireCount)
}

export function validatePhotoGalleryOutput(
  values: Float32Array,
  output: PhotoOutputs,
  tolerance = 1e-9,
) {
  // The machine checks that every root value is finite before calling this.
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
      const value = values[output.thumbnails[outputStart + thumbnailField[field]]!]
      // A thumbnail's left is its springing center minus half its size, so it can
      // overshoot past 0, e.g. to -0.74 px when a photo is open and the viewport grows
      // from 33×339 to 1435×668.
      if (field === 'left') invariant(Number.isFinite(value), `thumbnail left must be finite, got ${value}`)
      else assertNonNegativeFinite(value, `thumbnail ${field}`)
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
