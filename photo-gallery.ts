import {
  Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertWire,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorEvaluation,
  validateTensorFloat32Evaluation,
  validateTensorProgram,
} from './numeric-ui-core.ts'

export const itemCount = 12
export const columnCount = 4
export const rowCount = 3

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
  size: 24,
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

export const thumbnailField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  focused: 5,
  size: 6,
}

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

type GalleryOutput = {
  nextSource: Wire[]
  backdropOpacity: Wire
  photos: Wire[]
  thumbnails: Wire[]
  previousControl: Wire[]
  nextControl: Wire[]
}

export function focusField(item: number) {
  return sourceField.focusStart + item
}

export function compilePhotoGalleryCircuit() {
  const circuit = new Circuit(sourceField.size)
  for (const field of [
    sourceField.viewportWidth,
    sourceField.viewportHeight,
    sourceField.gap,
    sourceField.mainInset,
    sourceField.thumbnailHeight,
    sourceField.controlSize,
  ]) {
    circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  }
  for (const field of eventFields) circuit.assumeRange(field, 0, 1)
  for (let item = 0; item < itemCount; item++) circuit.assumeRange(focusField(item), 0, 1)
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
  const grid: Geometry[] = []
  const gridHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    const geometry = {
      left: gridLeft[column]!,
      top: gridTop[row]!,
      width: gridWidth,
      height: gridHeight,
    }
    grid.push(geometry)
    gridHit.push(emitMinimum(circuit, gridColumnHit[column]!, gridRowHit[row]!))
  }

  const main: Geometry = {
    left: sourceField.mainInset,
    top: sourceField.gap,
    width: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [sourceField.mainInset, -2],
    ])),
    height: emitRelu(circuit, circuit.affine([
      [sourceField.viewportHeight, 1],
      [sourceField.thumbnailHeight, -1],
      [sourceField.gap, -3],
    ])),
  }
  const mainHit = emitRectangleHit(circuit, main)

  const thumbnailWidth = emitRelu(
    circuit,
    circuit.affine([
      [sourceField.viewportWidth, 1 / itemCount],
      [sourceField.gap, -(itemCount + 1) / itemCount],
    ]),
  )
  const thumbnailStride = circuit.affine([[thumbnailWidth, 1], [sourceField.gap, 1]])
  const thumbnailTop = emitRelu(circuit, circuit.affine([
    [sourceField.viewportHeight, 1],
    [sourceField.thumbnailHeight, -1],
    [sourceField.gap, -1],
  ]))

  const previousFocus = Array.from({length: itemCount}, (_, item) => focusField(item))
  const previousFocusMass = circuit.affine(previousFocus.map(wire => [wire, 1]))
  circuit.assumeRange(previousFocusMass, 0, 1)
  const previousGridMass = circuit.affine([[previousFocusMass, -1]], 1)
  const thumbnails: Geometry[] = []
  const thumbnailHit: Wire[] = []
  const thumbnailVerticalHit = emitIntervalHit(
    circuit,
    sourceField.clickY,
    thumbnailTop,
    sourceField.thumbnailHeight,
  )
  for (let item = 0; item < itemCount; item++) {
    const left = circuit.affine([
      [sourceField.gap, 1],
      [thumbnailStride, item],
    ])
    const geometry = {
      left,
      top: thumbnailTop,
      width: thumbnailWidth,
      height: sourceField.thumbnailHeight,
    }
    thumbnails.push(geometry)
    thumbnailHit.push(emitMinimum(
      circuit,
      emitIntervalHit(circuit, sourceField.clickX, left, thumbnailWidth),
      thumbnailVerticalHit,
    ))
  }

  const controlTop = emitRelu(circuit, circuit.affine([
    [sourceField.gap, 1],
    [main.height, 0.5],
    [sourceField.controlSize, -0.5],
  ]))
  const previousControl: Geometry = {
    left: sourceField.gap,
    top: controlTop,
    width: sourceField.controlSize,
    height: sourceField.controlSize,
  }
  const nextControl: Geometry = {
    left: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [sourceField.gap, -1],
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

  const eventMass = circuit.affine(eventFields.map(wire => [wire, 1]))
  circuit.assumeRange(eventMass, 0, 1)
  const eventInactive = circuit.affine([[eventMass, -1]], 1)
  const clickGridGate = emitMultiply(circuit, sourceField.clickActive, previousGridMass)
  const clickThumbnailGate = emitMultiply(circuit, sourceField.clickActive, previousFocusMass)
  const clickMainGate = emitMultiply(circuit, sourceField.clickActive, mainHit)
  const currentFocusGate = circuit.affine([[eventInactive, 1], [clickMainGate, 1]])
  const previousFocusGate = circuit.affine([
    [sourceField.previousActive, 1],
    [emitMultiply(circuit, sourceField.clickActive, previousControlHit), 1],
  ])
  const nextFocusGate = circuit.affine([
    [sourceField.nextActive, 1],
    [emitMultiply(circuit, sourceField.clickActive, nextControlHit), 1],
  ])
  const nextFocus: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const previousShift = previousFocus[(item + 1) % itemCount]!
    const nextShift = previousFocus[(item + itemCount - 1) % itemCount]!
    nextFocus.push(circuit.affine([
      [emitMultiply(circuit, currentFocusGate, previousFocus[item]!), 1],
      [emitMultiply(circuit, clickGridGate, gridHit[item]!), 1],
      [emitMultiply(circuit, clickThumbnailGate, thumbnailHit[item]!), 1],
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
  const thumbnailProjections: PhotoProjection[] = []
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
      opacity: circuit.affine([[nextGridMass, 1], [thisFocused, 1]]),
      focused: thisFocused,
    })
    thumbnailProjections.push({
      ...thumbnails[item]!,
      opacity: nextFocusMass,
      focused: thisFocused,
    })
  }

  const nextSource = [
    sourceField.viewportWidth,
    sourceField.viewportHeight,
    sourceField.gap,
    sourceField.mainInset,
    sourceField.thumbnailHeight,
    sourceField.controlSize,
    zero,
    sourceField.clickX,
    sourceField.clickY,
    zero,
    zero,
    zero,
    ...nextFocus,
  ].map(wire => circuit.affine([[wire, 1]]))
  const photoOutput = photos.flatMap(photo => [
    photo.left,
    photo.top,
    photo.width,
    photo.height,
    photo.opacity,
    photo.focused,
  ])
  const thumbnailOutput = thumbnailProjections.flatMap(thumbnail => [
    thumbnail.left,
    thumbnail.top,
    thumbnail.width,
    thumbnail.height,
    thumbnail.opacity,
    thumbnail.focused,
  ])
  const previousControlOutput = [
    previousControl.left,
    previousControl.top,
    previousControl.width,
    previousControl.height,
    nextFocusMass,
  ]
  const nextControlOutput = [
    nextControl.left,
    nextControl.top,
    nextControl.width,
    nextControl.height,
    nextFocusMass,
  ]

  return {
    circuit,
    output: {
      nextSource,
      backdropOpacity: nextFocusMass,
      photos: photoOutput,
      thumbnails: thumbnailOutput,
      previousControl: previousControlOutput,
      nextControl: nextControlOutput,
    },
  }
}

export function createPhotoGalleryMachine(
  {
    checkTensorEvaluation = true,
    precision = 'float32',
  }: {
    checkTensorEvaluation?: boolean
    precision?: 'float64' | 'float32'
  } = {},
) {
  const source = new Float64Array(sourceField.size)
  source[sourceField.gap] = 18
  source[sourceField.mainInset] = 92
  source[sourceField.thumbnailHeight] = 82
  source[sourceField.controlSize] = 52
  const {circuit, output} = compilePhotoGalleryCircuit()
  const wireCount = validateCircuit(circuit)
  validateGalleryOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    output.backdropOpacity,
    ...output.photos,
    ...output.thumbnails,
    ...output.previousControl,
    ...output.nextControl,
  ])
  validateTensorProgram(circuit, tensorProgram)
  const numericTolerance = precision === 'float32' ? 1e-5 : 1e-9

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
    step(viewportWidth: number, viewportHeight: number) {
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      validateGallerySource(source, numericTolerance)
      const values = precision === 'float32'
        ? circuit.evaluateTensorFloat32(source)
        : circuit.evaluateTensor(source)
      if (checkTensorEvaluation) {
        if (precision === 'float32') validateTensorFloat32Evaluation(source, circuit, values)
        else validateTensorEvaluation(source, circuit, values)
      }
      validateGalleryOutput(values, output, numericTolerance)
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

export type PhotoGalleryMachine = ReturnType<typeof createPhotoGalleryMachine>

declare global {
  interface Window {
    photoGalleryDemo?: PhotoGalleryMachine
  }
}

export function mountPhotoGallery(document: Document, window: Window) {
  const machine = createPhotoGalleryMachine({precision: 'float32'})
  const photos = [...document.querySelectorAll<HTMLElement>('.photo')]
  const thumbnails = [...document.querySelectorAll<HTMLElement>('.thumbnail')]
  const backdrop = document.querySelector<HTMLElement>('#backdrop')
  const previousControl = document.querySelector<HTMLElement>('#previous')
  const nextControl = document.querySelector<HTMLElement>('#next')
  const readout = document.querySelector<HTMLElement>('#readout')
  invariant(photos.length === itemCount, 'photo slot count mismatch')
  invariant(thumbnails.length === itemCount, 'thumbnail slot count mismatch')
  invariant(backdrop !== null, 'backdrop is missing')
  invariant(previousControl !== null, 'previous control is missing')
  invariant(nextControl !== null, 'next control is missing')
  invariant(readout !== null, 'readout is missing')
  const backdropElement = backdrop
  const previousControlElement = previousControl
  const nextControlElement = nextControl
  const weightCount = machine.tensorProgram.layers.reduce(
    (sum, layer) => sum + layer.weights.length,
    0,
  )
  readout.textContent =
    `table cells ${machine.source.length} | layers ${machine.tensorProgram.layers.length} | weights ${weightCount}`

  function projectGeometry(
    element: HTMLElement,
    values: Float64Array,
    output: readonly Wire[],
    outputStart = 0,
  ) {
    for (const field of geometryFields) {
      element.style[field] = `${values[output[outputStart + controlField[field]]!]}px`
    }
  }

  function refresh() {
    const values = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight)
    backdropElement.style.opacity = `${values[machine.output.backdropOpacity]}`
    for (let item = 0; item < itemCount; item++) {
      const photo = photos[item]!
      const photoOutputStart = item * photoField.size
      projectGeometry(photo, values, machine.output.photos, photoOutputStart)
      photo.style.opacity =
        `${values[machine.output.photos[photoOutputStart + photoField.opacity]!]}`
      photo.style.setProperty(
        '--focused',
        `${values[machine.output.photos[photoOutputStart + photoField.focused]!]}`,
      )
      const thumbnail = thumbnails[item]!
      const thumbnailOutputStart = item * thumbnailField.size
      projectGeometry(thumbnail, values, machine.output.thumbnails, thumbnailOutputStart)
      thumbnail.style.opacity =
        `${values[machine.output.thumbnails[thumbnailOutputStart + thumbnailField.opacity]!]}`
      thumbnail.style.setProperty(
        '--focused',
        `${values[machine.output.thumbnails[thumbnailOutputStart + thumbnailField.focused]!]}`,
      )
    }
    projectGeometry(previousControlElement, values, machine.output.previousControl)
    projectGeometry(nextControlElement, values, machine.output.nextControl)
    previousControlElement.style.opacity =
      `${values[machine.output.previousControl[controlField.opacity]!]}`
    nextControlElement.style.opacity =
      `${values[machine.output.nextControl[controlField.opacity]!]}`
  }

  window.addEventListener('click', (event: MouseEvent) => {
    machine.click(event.clientX, event.clientY)
    refresh()
  })
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') machine.previous()
    else if (event.key === 'ArrowRight') machine.next()
    else if (event.key === 'Escape') machine.close()
    else return
    event.preventDefault()
    refresh()
  })
  window.addEventListener('resize', refresh)
  refresh()
  return machine
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
  invariant(values instanceof Float64Array, 'source table must be a Float64Array')
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  assertNonNegativeFinite(values[sourceField.gap], 'gap')
  assertNonNegativeFinite(values[sourceField.mainInset], 'main inset')
  assertNonNegativeFinite(values[sourceField.thumbnailHeight], 'thumbnail height')
  assertNonNegativeFinite(values[sourceField.controlSize], 'control size')
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
  }
  invariant(focusMass <= 1 + tolerance, 'focus mass must not exceed 1')
}

function validateGalleryOutputWires(output: GalleryOutput, wireCount: number) {
  validateWireView(output.nextSource, sourceField.size, wireCount)
  assertWire(output.backdropOpacity, wireCount)
  validateWireView(output.photos, itemCount * photoField.size, wireCount)
  validateWireView(output.thumbnails, itemCount * thumbnailField.size, wireCount)
  validateWireView(output.previousControl, controlField.size, wireCount)
  validateWireView(output.nextControl, controlField.size, wireCount)
}

function validateGalleryOutput(
  values: Float64Array,
  output: GalleryOutput,
  tolerance = 1e-9,
) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = Float64Array.from(output.nextSource, wire => values[wire]!)
  validateGallerySource(nextSource, tolerance)
  for (const eventField of eventFields) {
    invariant(nextSource[eventField] === 0, 'event latch must reset after refresh')
  }
  assertUnitInterval(values[output.backdropOpacity], 'backdrop opacity', tolerance)
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

function validateWireView(wires: readonly Wire[], size: number, wireCount: number) {
  invariant(wires.length === size, 'output wire view has the wrong length')
  for (const wire of wires) assertWire(wire, wireCount)
}

function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

function assertUnitInterval(
  value: number | undefined,
  label: string,
  tolerance = 1e-9,
): asserts value is number {
  invariant(
    value !== undefined
      && Number.isFinite(value)
      && value >= -tolerance
      && value <= 1 + tolerance,
    `${label} must be within 0..1, got ${value}`,
  )
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.photoGalleryDemo = mountPhotoGallery(document, window)
}
