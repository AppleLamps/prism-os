import {
  Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  assertWire,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  emitSelect,
  emitSpring,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../../../../../numeric-ui-core.ts'
import {type SpringPowers, createSourceMatrixGroup, emitSpringBox} from './spring-bank.ts'
import {type RetargetTiming, defaultClockConfig, eulerStepMatrix, matrixPower} from './spring-math.ts'

export const itemCount = 12
export const columnCount = 4
export const rowCount = 3

export const thumbnailSpringField = {
  centerX: 0,
  centerXVelocity: 1,
  scale: 2,
  scaleVelocity: 3,
  size: 4,
} as const

// Added for the spring bank: the destination each thumbnail lane stepped toward
// last frame.
export const thumbnailDestinationField = {
  centerX: 0,
  scale: 1,
  size: 2,
} as const

const originalSourceSize = 34 + itemCount * thumbnailSpringField.size

export type PhotoSpringOptions = {
  springs: 'original' | SpringPowers
  retarget: RetargetTiming
}

export const originalPhotoSpringOptions: PhotoSpringOptions = {springs: 'original', retarget: 'doctrine'}

// The frame matrix cells accept any matrix a parent circuit can produce; the
// parent narrows the range when it inlines Photos.
export const photoFrameBound = 256

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
  springTimestep: 27,
  springStiffness: 28,
  springDamping: 29,
  springSettleDistance: 30,
  springSettleSpeed: 31,
  springSettleDistanceScale: 32,
  springSettleSpeedScale: 33,
  thumbnailSpringStart: 34,
  // Spring bank cells, appended after the original layout so every original
  // wire keeps its index: the shared frame matrix M^steps, then each lane's
  // previous destination.
  springFrameStart: originalSourceSize,
  thumbnailDestinationStart: originalSourceSize + 4,
  size: originalSourceSize + 4 + itemCount * thumbnailDestinationField.size,
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

export function thumbnailDestinationSourceField(item: number, lane: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < itemCount, 'photo index is invalid')
  invariant(
    Number.isInteger(lane) && lane >= 0 && lane < thumbnailDestinationField.size,
    'thumbnail destination lane is invalid',
  )
  return sourceField.thumbnailDestinationStart + item * thumbnailDestinationField.size + lane
}

export function createPhotoGalleryCircuit(options: PhotoSpringOptions = originalPhotoSpringOptions) {
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
  for (const field of [
    sourceField.springTimestep,
    sourceField.springStiffness,
    sourceField.springDamping,
    sourceField.springSettleDistance,
    sourceField.springSettleSpeed,
    sourceField.springSettleDistanceScale,
    sourceField.springSettleSpeedScale,
  ]) {
    circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  }
  for (let item = 0; item < itemCount; item++) circuit.assumeRange(focusField(item), 0, 1)
  for (let item = 0; item < itemCount; item++) {
    // A thumbnail's spring center is clamped to the viewport before it is
    // written back, so the viewport ceiling is honest here too.
    circuit.assumeRange(
      thumbnailSpringSourceField(item, thumbnailSpringField.centerX),
      0,
      16_384,
    )
    circuit.assumeRange(
      thumbnailSpringSourceField(item, thumbnailSpringField.scale),
      0,
      1,
    )
  }
  for (let entry = 0; entry < 4; entry++) {
    circuit.assumeRange(sourceField.springFrameStart + entry, -photoFrameBound, photoFrameBound)
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
  const animateThumbnails = emitMultiply(circuit, previousFocusMass, nextFocusMass)
  const snapThumbnails = circuit.affine([[animateThumbnails, -1]], 1)
  const thumbnailProjections: PhotoProjection[] = []
  const thumbnailAnimationTerms: [Wire, number][] = []
  const nextThumbnailSprings: Wire[][] = []
  const nextThumbnailDestinations: Wire[][] = []
  const frameGroup = options.springs === 'original'
    ? undefined
    : createSourceMatrixGroup(circuit, [
        sourceField.springFrameStart,
        sourceField.springFrameStart + 1,
        sourceField.springFrameStart + 2,
        sourceField.springFrameStart + 3,
      ], photoFrameBound)
  for (let item = 0; item < itemCount; item++) {
    const target = thumbnailTargets[item]!
    if (frameGroup !== undefined) {
      const box = emitSpringBox(circuit, [
        {
          group: frameGroup,
          position: thumbnailSpringSourceField(item, thumbnailSpringField.centerX),
          velocity: thumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity),
          destination: target.centerX,
          previousDestination: thumbnailDestinationSourceField(item, thumbnailDestinationField.centerX),
        },
        {
          group: frameGroup,
          position: thumbnailSpringSourceField(item, thumbnailSpringField.scale),
          velocity: thumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity),
          destination: target.scale,
          previousDestination: thumbnailDestinationSourceField(item, thumbnailDestinationField.scale),
        },
      ], {
        unit: sourceField.unit,
        settleDistance: sourceField.springSettleDistance,
        settleSpeed: sourceField.springSettleSpeed,
        retarget: options.retarget,
        snap: snapThumbnails,
      })
      // The original selects the unclamped target when snapping. The strip
      // layout keeps every target inside 0..viewport (the gap shrinks to fit),
      // so clamping both branches gives the same values without a select.
      const centerX = emitMinimum(
        circuit,
        emitMaximum(circuit, zero, box.positions[0]!),
        sourceField.viewportWidth,
      )
      const scale = emitMinimum(circuit, emitMaximum(circuit, zero, box.positions[1]!), sourceField.unit)
      nextThumbnailSprings.push([centerX, box.velocities[0]!, scale, box.velocities[1]!])
      nextThumbnailDestinations.push(box.nextPreviousDestinations)
      thumbnailProjections.push(projectThumbnail({centerX, scale, focused: target.focused}))
      thumbnailAnimationTerms.push([box.active, 1])
      continue
    }
    nextThumbnailDestinations.push([
      thumbnailDestinationSourceField(item, thumbnailDestinationField.centerX),
      thumbnailDestinationSourceField(item, thumbnailDestinationField.scale),
    ])
    const centerSpring = emitSpring(
      circuit,
      thumbnailSpringSourceField(item, thumbnailSpringField.centerX),
      target.centerX,
      thumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity),
      sourceField.springStiffness,
      sourceField.springDamping,
      sourceField.springTimestep,
      sourceField.springSettleDistance,
      sourceField.springSettleSpeed,
      sourceField.springSettleDistanceScale,
      sourceField.springSettleSpeedScale,
      sourceField.unit,
    )
    const scaleSpring = emitSpring(
      circuit,
      thumbnailSpringSourceField(item, thumbnailSpringField.scale),
      target.scale,
      thumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity),
      sourceField.springStiffness,
      sourceField.springDamping,
      sourceField.springTimestep,
      sourceField.springSettleDistance,
      sourceField.springSettleSpeed,
      sourceField.springSettleDistanceScale,
      sourceField.springSettleSpeedScale,
      sourceField.unit,
    )
    const centerX = emitSelect(
      circuit,
      snapThumbnails,
      emitMinimum(
        circuit,
        emitMaximum(circuit, zero, centerSpring.position),
        sourceField.viewportWidth,
      ),
      target.centerX,
    )
    const scale = emitSelect(
      circuit,
      snapThumbnails,
      emitMinimum(
        circuit,
        emitMaximum(circuit, zero, scaleSpring.position),
        sourceField.unit,
      ),
      target.scale,
    )
    const centerVelocity = emitSelect(
      circuit,
      snapThumbnails,
      centerSpring.velocity,
      zero,
    )
    const scaleVelocity = emitSelect(
      circuit,
      snapThumbnails,
      scaleSpring.velocity,
      zero,
    )
    nextThumbnailSprings.push([centerX, centerVelocity, scale, scaleVelocity])
    thumbnailProjections.push(projectThumbnail({
      centerX,
      scale,
      focused: target.focused,
    }))
    thumbnailAnimationTerms.push(
      [emitMultiply(circuit, animateThumbnails, centerSpring.active), 1],
      [emitMultiply(circuit, animateThumbnails, scaleSpring.active), 1],
    )
  }
  const animationActive = emitClampZeroOne(
    circuit,
    circuit.affine(thumbnailAnimationTerms),
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
  for (let item = 0; item < itemCount; item++) {
    nextSource[focusField(item)] = nextFocus[item]!
    const spring = nextThumbnailSprings[item]!
    for (let field = 0; field < thumbnailSpringField.size; field++) {
      nextSource[thumbnailSpringSourceField(item, field)] = spring[field]!
    }
    for (let lane = 0; lane < thumbnailDestinationField.size; lane++) {
      nextSource[thumbnailDestinationSourceField(item, lane)] = nextThumbnailDestinations[item]![lane]!
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

export function createPhotoGalleryMachine(options: PhotoSpringOptions = originalPhotoSpringOptions) {
  const source = new Float32Array(sourceField.size)
  // Standalone Photos advances 16 ms per call: four fixed 4 ms steps as one
  // matrix, the same simulated time as the original's four 4 ms substeps.
  const standaloneFrame = matrixPower(eulerStepMatrix({stiffness: 650, damping: 45}, defaultClockConfig.stepMs), 4)
  for (let entry = 0; entry < 4; entry++) source[sourceField.springFrameStart + entry] = standaloneFrame[entry]!
  source[sourceField.gap] = 18
  source[sourceField.mainInset] = 92
  source[sourceField.thumbnailHeight] = 82
  source[sourceField.controlSize] = 52
  source[sourceField.present] = 1
  source[sourceField.interactive] = 1
  source[sourceField.unit] = 1
  source[sourceField.springTimestep] = 0.004
  source[sourceField.springStiffness] = 650
  source[sourceField.springDamping] = 45
  source[sourceField.springSettleDistance] = 0.01
  source[sourceField.springSettleSpeed] = 0.01
  source[sourceField.springSettleDistanceScale] = 100
  source[sourceField.springSettleSpeedScale] = 100
  const {circuit, output} = createPhotoGalleryCircuit(options)
  const wireCount = validateCircuit(circuit)
  validatePhotoGalleryOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    output.backdropOpacity,
    output.animationActive,
    ...output.photos,
    ...output.thumbnails,
    ...output.previousControl,
    ...output.nextControl,
  ])
  validateTensorProgram(circuit, tensorProgram)
  const numericTolerance = 1e-5

  function receiveEvent(field: number, x = source[sourceField.clickX]!, y = source[sourceField.clickY]!) {
    for (const eventField of eventFields) source[eventField] = 0
    source[field] = 1
    source[sourceField.clickX] = x
    source[sourceField.clickY] = y
  }

  return {
    circuit,
    output,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number, present = 1, interactive = 1) {
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      source[sourceField.present] = present
      source[sourceField.interactive] = interactive
      validateGallerySource(source, numericTolerance)
      const values = circuit.evaluateTensor(source)
      validatePhotoGalleryOutput(values, output, numericTolerance)
      for (let field = 0; field < source.length; field++) {
        source[field] = values[output.nextSource[field]!]!
      }
      return values
    },
    click(x: number, y: number) {
      receiveEvent(sourceField.clickActive, x, y)
    },
    previous() {
      receiveEvent(sourceField.previousActive)
    },
    next() {
      receiveEvent(sourceField.nextActive)
    },
    close() {
      receiveEvent(sourceField.closeActive)
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
  for (const field of [
    sourceField.springTimestep,
    sourceField.springStiffness,
    sourceField.springDamping,
    sourceField.springSettleDistance,
    sourceField.springSettleSpeed,
    sourceField.springSettleDistanceScale,
    sourceField.springSettleSpeedScale,
  ]) {
    assertNonNegativeFinite(values[field], 'spring constant')
  }
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
    assertNonNegativeFinite(
      values[thumbnailSpringSourceField(item, thumbnailSpringField.centerX)],
      `thumbnail ${item} center`,
      tolerance,
    )
    invariant(
      Number.isFinite(
        values[thumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity)],
      ),
      `thumbnail ${item} center velocity must be finite`,
    )
    assertUnitInterval(
      values[thumbnailSpringSourceField(item, thumbnailSpringField.scale)],
      `thumbnail ${item} scale`,
      tolerance,
    )
    invariant(
      Number.isFinite(
        values[thumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity)],
      ),
      `thumbnail ${item} scale velocity must be finite`,
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
