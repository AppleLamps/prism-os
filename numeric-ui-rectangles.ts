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

export const itemCount = 4

export const sourceField = {
  viewportWidth: 0,
  viewportHeight: 1,
  gap: 2,
  clickActive: 3,
  clickX: 4,
  clickY: 5,
  focusStart: 6,
  size: 10,
}

export const rectangleField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  size: 5,
}

const geometryFields = ['left', 'top', 'width', 'height'] as const

type RectangleGeometry = Record<(typeof geometryFields)[number], Wire>

type RectangleProjection = RectangleGeometry & {
  visible: Wire
}

type RectangleOutput = {
  nextSourceStart: Wire
  rectangleStart: Wire
}

export function focusField(item: number) {
  return sourceField.focusStart + item
}

export function compileRectangleCircuit() {
  const circuit = new Circuit(sourceField.size)
  const zero = circuit.affine([])
  const gridWidth = emitRelu(
    circuit,
    circuit.affine([[sourceField.viewportWidth, 0.5], [sourceField.gap, -1.5]]),
  )
  const gridHeight = emitRelu(
    circuit,
    circuit.affine([[sourceField.viewportHeight, 0.5], [sourceField.gap, -1.5]]),
  )
  const fullWidth = emitRelu(circuit, circuit.affine([[sourceField.viewportWidth, 1], [sourceField.gap, -2]]))
  const fullHeight = emitRelu(circuit, circuit.affine([[sourceField.viewportHeight, 1], [sourceField.gap, -2]]))

  const grid: RectangleGeometry[] = []
  const hit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % 2
    const row = Math.floor(item / 2)
    const left = circuit.affine([[sourceField.gap, 1 + column], [gridWidth, column]])
    const top = circuit.affine([[sourceField.gap, 1 + row], [gridHeight, row]])
    const right = circuit.affine([[left, 1], [gridWidth, 1]])
    const bottom = circuit.affine([[top, 1], [gridHeight, 1]])
    grid.push({left, top, width: gridWidth, height: gridHeight})
    const horizontalDistance = emitMinimum(
      circuit,
      circuit.affine([[sourceField.clickX, 1], [left, -1]]),
      circuit.affine([[right, 1], [sourceField.clickX, -1]]),
    )
    const verticalDistance = emitMinimum(
      circuit,
      circuit.affine([[sourceField.clickY, 1], [top, -1]]),
      circuit.affine([[bottom, 1], [sourceField.clickY, -1]]),
    )
    hit.push(emitClampZeroOne(circuit, emitMinimum(circuit, horizontalDistance, verticalDistance)))
  }

  // Higher slots suppress lower slots when hit regions overlap. Fractional
  // activations remain smooth; ordinary interior clicks produce exact 0/1.
  const winner: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    let survives = hit[item]!
    for (let higher = item + 1; higher < itemCount; higher++) {
      survives = emitMultiply(circuit, survives, circuit.affine([[hit[higher]!, -1]], 1))
    }
    winner.push(survives)
  }

  const previousFocus = Array.from({length: itemCount}, (_, item) => focusField(item))
  const previousFocusMass = circuit.affine(previousFocus.map(wire => [wire, 1]))
  const gridMass = emitClampZeroOne(circuit, circuit.affine([[previousFocusMass, -1]], 1))
  const clickInactive = circuit.affine([[sourceField.clickActive, -1]], 1)
  const nextFocus = previousFocus.map((focus, item) => circuit.affine([
    [emitMultiply(circuit, clickInactive, focus), 1],
    [emitMultiply(
      circuit,
      sourceField.clickActive,
      emitMultiply(circuit, gridMass, winner[item]!),
    ), 1],
  ]))

  const nextFocusMass = circuit.affine(nextFocus.map(wire => [wire, 1]))
  const nextGridMass = emitClampZeroOne(circuit, circuit.affine([[nextFocusMass, -1]], 1))
  const rectangles: RectangleProjection[] = []
  for (let item = 0; item < itemCount; item++) {
    const gridRectangle = grid[item]!
    const thisFocused = nextFocus[item]!
    const project = (gridValue: Wire, focusedValue: Wire) => circuit.affine([
      [emitMultiply(circuit, nextGridMass, gridValue), 1],
      [emitMultiply(circuit, thisFocused, focusedValue), 1],
    ])
    rectangles.push({
      left: project(gridRectangle.left, sourceField.gap),
      top: project(gridRectangle.top, sourceField.gap),
      width: project(gridRectangle.width, fullWidth),
      height: project(gridRectangle.height, fullHeight),
      visible: circuit.affine([[nextGridMass, 1], [thisFocused, 1]]),
    })
  }

  const nextSource = [
    sourceField.viewportWidth,
    sourceField.viewportHeight,
    sourceField.gap,
    zero,
    sourceField.clickX,
    sourceField.clickY,
    ...nextFocus,
  ].map(wire => circuit.affine([[wire, 1]]))
  const rectangleOutput = rectangles.flatMap(rectangle => [
    rectangle.left,
    rectangle.top,
    rectangle.width,
    rectangle.height,
    rectangle.visible,
  ]).map(wire => circuit.affine([[wire, 1]]))

  return {
    circuit,
    output: {
      nextSourceStart: nextSource[0]!,
      rectangleStart: rectangleOutput[0]!,
    },
  }
}

export function createRectangleMachine({checkTensorEvaluation = true}: {checkTensorEvaluation?: boolean} = {}) {
  const source = new Float64Array(sourceField.size)
  source[sourceField.gap] = 24
  const {circuit, output} = compileRectangleCircuit()
  const wireCount = validateCircuit(circuit)
  validateRectangleOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram()
  validateTensorProgram(circuit, tensorProgram)

  return {
    circuit,
    output,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number) {
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      validateRectangleSource(source)
      const values = circuit.evaluateTensor(source)
      if (checkTensorEvaluation) validateTensorEvaluation(source, circuit, values)
      validateRectangleOutput(values, output)
      source.set(values.subarray(output.nextSourceStart, output.nextSourceStart + source.length))
      return values
    },
    click(x: number, y: number) {
      source[sourceField.clickActive] = 1
      source[sourceField.clickX] = x
      source[sourceField.clickY] = y
    },
  }
}

export type RectangleMachine = ReturnType<typeof createRectangleMachine>

declare global {
  interface Window {
    numericUiDemo?: RectangleMachine
  }
}

export function mountRectangleDemo(document: Document, window: Window) {
  const machine = createRectangleMachine()
  const rectangles = [...document.querySelectorAll<HTMLElement>('.rectangle')]
  const readout = document.querySelector<HTMLElement>('#readout')
  invariant(rectangles.length === itemCount, 'rectangle slot count mismatch')
  invariant(readout !== null, 'readout is missing')
  const readoutElement = readout
  const weightCount = machine.tensorProgram.layers.reduce(
    (sum, layer) => sum + layer.leftWeights.length + layer.gateWeights.length,
    0,
  )

  function refresh() {
    const values = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight)
    for (let item = 0; item < itemCount; item++) {
      const rectangle = rectangles[item]!
      const outputStart = machine.output.rectangleStart + item * rectangleField.size
      for (const field of geometryFields) {
        rectangle.style[field] = `${values[outputStart + rectangleField[field]]}px`
      }
      const opacity = values[outputStart + rectangleField.opacity]!
      rectangle.style.opacity = `${opacity}`
      rectangle.style.pointerEvents = opacity === 1 ? 'auto' : 'none'
    }

    const focus = Array.from({length: itemCount}, (_, item) => machine.source[focusField(item)]!)
    const focusedItem = focus.indexOf(Math.max(...focus))
    const focusAmount = focus[focusedItem]!
    readoutElement.textContent =
      `table cells ${machine.source.length} | layers ${machine.tensorProgram.layers.length} | weights ${weightCount} | ` +
      (focusAmount === 0
        ? 'grid: click a rectangle'
        : `focus rectangle ${focusedItem + 1}: ${focusAmount.toFixed(2)} | click to return`)
  }

  window.addEventListener('click', (event: MouseEvent) => {
    machine.click(event.clientX, event.clientY)
    refresh()
  })
  window.addEventListener('resize', refresh)
  refresh()
  return machine
}

function validateRectangleSource(values: unknown) {
  invariant(values instanceof Float64Array, 'source table must be a Float64Array')
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  assertNonNegativeFinite(values[sourceField.gap], 'gap')
  assertUnitInterval(values[sourceField.clickActive], 'click latch')
  invariant(Number.isFinite(values[sourceField.clickX]), 'click x must be finite')
  invariant(Number.isFinite(values[sourceField.clickY]), 'click y must be finite')
  let focusMass = 0
  for (let item = 0; item < itemCount; item++) {
    const focus = values[focusField(item)]
    assertUnitInterval(focus, `focus ${item}`)
    focusMass += focus
  }
  invariant(focusMass <= 1 + 1e-9, 'focus mass must not exceed 1')
}

function validateRectangleOutputWires(output: RectangleOutput, wireCount: number) {
  assertWire(output.nextSourceStart, wireCount)
  assertWire(output.nextSourceStart + sourceField.size - 1, wireCount)
  assertWire(output.rectangleStart, wireCount)
  assertWire(output.rectangleStart + itemCount * rectangleField.size - 1, wireCount)
}

function validateRectangleOutput(values: Float64Array, output: RectangleOutput) {
  assertFiniteValues(values, 'tensor output')
  const nextSource = values.subarray(output.nextSourceStart, output.nextSourceStart + sourceField.size)
  validateRectangleSource(nextSource)
  invariant(nextSource[sourceField.clickActive] === 0, 'click latch must reset after refresh')
  let focusMass = 0
  for (let item = 0; item < itemCount; item++) {
    const focus = nextSource[focusField(item)]
    assertUnitInterval(focus, `next focus ${item}`)
    focusMass += focus
  }
  invariant(focusMass <= 1 + 1e-9, 'next focus mass must not exceed 1')
  for (let item = 0; item < itemCount; item++) {
    const outputStart = output.rectangleStart + item * rectangleField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[outputStart + rectangleField[field]], `rectangle ${field}`)
    }
    assertUnitInterval(values[outputStart + rectangleField.opacity], 'rectangle opacity')
  }
}

function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  return circuit.affine([[positive, 1], [aboveOne, -1]])
}

function assertUnitInterval(value: number | undefined, label: string): asserts value is number {
  invariant(value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be within 0..1`)
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.numericUiDemo = mountRectangleDemo(document, window)
}
