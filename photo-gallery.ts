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
  nextSourceStart: Wire
  backdropOpacity: Wire
  photoStart: Wire
  thumbnailStart: Wire
  previousControlStart: Wire
  nextControlStart: Wire
}

export function focusField(item: number) {
  return sourceField.focusStart + item
}

export function compilePhotoGalleryCircuit() {
  const circuit = new Circuit(sourceField.size)
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

  const grid: Geometry[] = []
  const gridHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    const left = circuit.affine([[sourceField.gap, 1 + column], [gridWidth, column]])
    const top = circuit.affine([[sourceField.gap, 1 + row], [gridHeight, row]])
    const geometry = {left, top, width: gridWidth, height: gridHeight}
    grid.push(geometry)
    gridHit.push(emitRectangleHit(circuit, geometry))
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
  const previousGridMass = emitClampZeroOne(circuit, circuit.affine([[previousFocusMass, -1]], 1))
  const thumbnails: Geometry[] = []
  const thumbnailHit: Wire[] = []
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
    thumbnailHit.push(emitRectangleHit(circuit, geometry))
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
  const previousControlHit = emitRectangleHit(circuit, previousControl)
  const nextControlHit = emitRectangleHit(circuit, nextControl)

  const eventMass = circuit.affine(eventFields.map(wire => [wire, 1]))
  const eventInactive = circuit.affine([[eventMass, -1]], 1)
  const nextFocus: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const previousShift = previousFocus[(item + 1) % itemCount]!
    const nextShift = previousFocus[(item + itemCount - 1) % itemCount]!
    const gridSelection = emitMultiply(circuit, previousGridMass, gridHit[item]!)
    const focusedSelection = circuit.affine([
      [thumbnailHit[item]!, 1],
      [emitMultiply(circuit, mainHit, previousFocus[item]!), 1],
      [emitMultiply(circuit, previousControlHit, previousShift), 1],
      [emitMultiply(circuit, nextControlHit, nextShift), 1],
    ])
    const clickSelection = circuit.affine([
      [gridSelection, 1],
      [emitMultiply(circuit, previousFocusMass, focusedSelection), 1],
    ])
    nextFocus.push(circuit.affine([
      [emitMultiply(circuit, eventInactive, previousFocus[item]!), 1],
      [emitMultiply(circuit, sourceField.clickActive, clickSelection), 1],
      [emitMultiply(circuit, sourceField.previousActive, previousShift), 1],
      [emitMultiply(circuit, sourceField.nextActive, nextShift), 1],
    ]))
  }

  const nextFocusMass = circuit.affine(nextFocus.map(wire => [wire, 1]))
  const nextGridMass = emitClampZeroOne(circuit, circuit.affine([[nextFocusMass, -1]], 1))
  const photos: PhotoProjection[] = []
  const thumbnailProjections: PhotoProjection[] = []
  for (let item = 0; item < itemCount; item++) {
    const thisFocused = nextFocus[item]!
    const project = (gridValue: Wire, mainValue: Wire) => circuit.affine([
      [emitMultiply(circuit, nextGridMass, gridValue), 1],
      [emitMultiply(circuit, thisFocused, mainValue), 1],
    ])
    photos.push({
      left: project(grid[item]!.left, main.left),
      top: project(grid[item]!.top, main.top),
      width: project(grid[item]!.width, main.width),
      height: project(grid[item]!.height, main.height),
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
  const renderOutput = [
    nextFocusMass,
    ...photos.flatMap(photo => [
      photo.left,
      photo.top,
      photo.width,
      photo.height,
      photo.opacity,
      photo.focused,
    ]),
    ...thumbnailProjections.flatMap(thumbnail => [
      thumbnail.left,
      thumbnail.top,
      thumbnail.width,
      thumbnail.height,
      thumbnail.opacity,
      thumbnail.focused,
    ]),
    previousControl.left,
    previousControl.top,
    previousControl.width,
    previousControl.height,
    nextFocusMass,
    nextControl.left,
    nextControl.top,
    nextControl.width,
    nextControl.height,
    nextFocusMass,
  ].map(wire => circuit.affine([[wire, 1]]))

  return {
    circuit,
    output: {
      nextSourceStart: nextSource[0]!,
      backdropOpacity: renderOutput[0]!,
      photoStart: renderOutput[1]!,
      thumbnailStart: renderOutput[1 + itemCount * photoField.size]!,
      previousControlStart:
        renderOutput[1 + itemCount * photoField.size + itemCount * thumbnailField.size]!,
      nextControlStart:
        renderOutput[
          1 + itemCount * photoField.size + itemCount * thumbnailField.size + controlField.size
        ]!,
    },
  }
}

export function createPhotoGalleryMachine({checkTensorEvaluation = true}: {checkTensorEvaluation?: boolean} = {}) {
  const source = new Float64Array(sourceField.size)
  source[sourceField.gap] = 18
  source[sourceField.mainInset] = 92
  source[sourceField.thumbnailHeight] = 82
  source[sourceField.controlSize] = 52
  const {circuit, output} = compilePhotoGalleryCircuit()
  const wireCount = validateCircuit(circuit)
  validateGalleryOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram()
  validateTensorProgram(circuit, tensorProgram)

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
      validateGallerySource(source)
      const values = circuit.evaluateTensor(source)
      if (checkTensorEvaluation) validateTensorEvaluation(source, circuit, values)
      validateGalleryOutput(values, output)
      source.set(values.subarray(output.nextSourceStart, output.nextSourceStart + source.length))
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
  const machine = createPhotoGalleryMachine()
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
    (sum, layer) => sum + layer.leftWeights.length + layer.gateWeights.length,
    0,
  )
  readout.textContent =
    `table cells ${machine.source.length} | layers ${machine.tensorProgram.layers.length} | weights ${weightCount}`

  function projectGeometry(element: HTMLElement, values: Float64Array, outputStart: number) {
    for (const field of geometryFields) {
      element.style[field] = `${values[outputStart + controlField[field]]}px`
    }
  }

  function refresh() {
    const values = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight)
    backdropElement.style.opacity = `${values[machine.output.backdropOpacity]}`
    for (let item = 0; item < itemCount; item++) {
      const photo = photos[item]!
      const outputStart = machine.output.photoStart + item * photoField.size
      projectGeometry(photo, values, outputStart)
      photo.style.opacity = `${values[outputStart + photoField.opacity]}`
      photo.style.setProperty('--focused', `${values[outputStart + photoField.focused]}`)
      const thumbnail = thumbnails[item]!
      const thumbnailStart = machine.output.thumbnailStart + item * thumbnailField.size
      projectGeometry(thumbnail, values, thumbnailStart)
      thumbnail.style.opacity = `${values[thumbnailStart + thumbnailField.opacity]}`
      thumbnail.style.setProperty('--focused', `${values[thumbnailStart + thumbnailField.focused]}`)
    }
    projectGeometry(previousControlElement, values, machine.output.previousControlStart)
    projectGeometry(nextControlElement, values, machine.output.nextControlStart)
    previousControlElement.style.opacity =
      `${values[machine.output.previousControlStart + controlField.opacity]}`
    nextControlElement.style.opacity =
      `${values[machine.output.nextControlStart + controlField.opacity]}`
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
  const right = circuit.affine([[geometry.left, 1], [geometry.width, 1]])
  const bottom = circuit.affine([[geometry.top, 1], [geometry.height, 1]])
  const horizontalDistance = emitMinimum(
    circuit,
    circuit.affine([[sourceField.clickX, 1], [geometry.left, -1]]),
    circuit.affine([[right, 1], [sourceField.clickX, -1]]),
  )
  const verticalDistance = emitMinimum(
    circuit,
    circuit.affine([[sourceField.clickY, 1], [geometry.top, -1]]),
    circuit.affine([[bottom, 1], [sourceField.clickY, -1]]),
  )
  return emitClampZeroOne(circuit, emitMinimum(circuit, horizontalDistance, verticalDistance))
}

function validateGallerySource(values: unknown) {
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
    assertUnitInterval(values[eventField], 'event latch')
    eventMass += values[eventField]
  }
  invariant(eventMass <= 1 + 1e-9, 'event mass must not exceed 1')
  let focusMass = 0
  for (let item = 0; item < itemCount; item++) {
    const focus = values[focusField(item)]
    assertUnitInterval(focus, `focus ${item}`)
    focusMass += focus
  }
  invariant(focusMass <= 1 + 1e-9, 'focus mass must not exceed 1')
}

function validateGalleryOutputWires(output: GalleryOutput, wireCount: number) {
  assertWire(output.nextSourceStart, wireCount)
  assertWire(output.nextSourceStart + sourceField.size - 1, wireCount)
  assertWire(output.backdropOpacity, wireCount)
  assertWire(output.photoStart, wireCount)
  assertWire(output.photoStart + itemCount * photoField.size - 1, wireCount)
  assertWire(output.thumbnailStart, wireCount)
  assertWire(output.thumbnailStart + itemCount * thumbnailField.size - 1, wireCount)
  assertWire(output.previousControlStart, wireCount)
  assertWire(output.previousControlStart + controlField.size - 1, wireCount)
  assertWire(output.nextControlStart, wireCount)
  assertWire(output.nextControlStart + controlField.size - 1, wireCount)
}

function validateGalleryOutput(values: Float64Array, output: GalleryOutput) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = values.subarray(output.nextSourceStart, output.nextSourceStart + sourceField.size)
  validateGallerySource(nextSource)
  for (const eventField of eventFields) {
    invariant(nextSource[eventField] === 0, 'event latch must reset after refresh')
  }
  assertUnitInterval(values[output.backdropOpacity], 'backdrop opacity')
  for (let item = 0; item < itemCount; item++) {
    const outputStart = output.photoStart + item * photoField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[outputStart + photoField[field]], `photo ${field}`)
    }
    assertUnitInterval(values[outputStart + photoField.opacity], 'photo opacity')
    assertUnitInterval(values[outputStart + photoField.focused], 'photo focus')
  }
  for (let item = 0; item < itemCount; item++) {
    const outputStart = output.thumbnailStart + item * thumbnailField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[outputStart + thumbnailField[field]], `thumbnail ${field}`)
    }
    assertUnitInterval(values[outputStart + thumbnailField.opacity], 'thumbnail opacity')
    assertUnitInterval(values[outputStart + thumbnailField.focused], 'thumbnail focus')
  }
  for (const controlStart of [output.previousControlStart, output.nextControlStart]) {
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[controlStart + controlField[field]], `control ${field}`)
    }
    assertUnitInterval(values[controlStart + controlField.opacity], 'control opacity')
  }
}

function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  return circuit.affine([[positive, 1], [aboveOne, -1]])
}

function assertUnitInterval(value: number | undefined, label: string): asserts value is number {
  invariant(
    value !== undefined && Number.isFinite(value) && value >= -1e-9 && value <= 1 + 1e-9,
    `${label} must be within 0..1`,
  )
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.photoGalleryDemo = mountPhotoGallery(document, window)
}
