import {
  Circuit,
  type Wire,
  assertBoolean,
  assertFiniteValues,
  assertInteger,
  assertIntegerBetween,
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertWire,
  emitAnd,
  emitEqualForInteger,
  emitGreaterThanForInteger,
  emitGreaterThanOrEqualForInteger,
  emitMultiply,
  emitSelect,
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
  focusedPlusOne: 6, // 0 = grid; otherwise item index + 1
  size: 7,
}

type RectangleProjection = {
  left: Wire
  top: Wire
  width: Wire
  height: Wire
  visible: Wire
}

type RectangleOutput = {
  focusedPlusOne: Wire
  clickActive: Wire
  rectangles: RectangleProjection[]
}

type GridRectangle = {
  left: Wire
  top: Wire
  width: Wire
  height: Wire
}

export function compileRectangleCircuit() {
  const circuit = new Circuit(sourceField.size)
  const zero = circuit.affine([])
  const gridWidth = circuit.affine([[sourceField.viewportWidth, 0.5], [sourceField.gap, -1.5]])
  const gridHeight = circuit.affine([[sourceField.viewportHeight, 0.5], [sourceField.gap, -1.5]])
  const fullWidth = circuit.affine([[sourceField.viewportWidth, 1], [sourceField.gap, -2]])
  const fullHeight = circuit.affine([[sourceField.viewportHeight, 1], [sourceField.gap, -2]])

  const grid: GridRectangle[] = []
  const hit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % 2
    const row = Math.floor(item / 2)
    const left = circuit.affine([[sourceField.gap, 1 + column], [gridWidth, column]])
    const top = circuit.affine([[sourceField.gap, 1 + row], [gridHeight, row]])
    const right = circuit.affine([[left, 1], [gridWidth, 1]])
    const bottom = circuit.affine([[top, 1], [gridHeight, 1]])
    grid.push({left, top, width: gridWidth, height: gridHeight})
    hit.push(emitAnd(circuit, [
      emitGreaterThanOrEqualForInteger(circuit, sourceField.clickX, left),
      emitGreaterThanForInteger(circuit, right, sourceField.clickX),
      emitGreaterThanOrEqualForInteger(circuit, sourceField.clickY, top),
      emitGreaterThanForInteger(circuit, bottom, sourceField.clickY),
    ]))
  }

  const winner: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const survives = [hit[item]!]
    for (let higher = item + 1; higher < itemCount; higher++) {
      survives.push(circuit.affine([[hit[higher]!, -1]], 1))
    }
    winner.push(emitAnd(circuit, survives))
  }
  const hasHit = circuit.affine(winner.map(wire => [wire, 1]))
  const targetPlusOne = circuit.affine(winner.map((wire, item) => [wire, item + 1]))

  const gridMode = emitEqualForInteger(circuit, sourceField.focusedPlusOne, zero)
  const clickOnGrid = emitMultiply(circuit, sourceField.clickActive, gridMode)
  const focusFromGrid = emitSelect(circuit, hasHit, targetPlusOne, sourceField.focusedPlusOne)
  const focusAfterGridClick = emitSelect(circuit, clickOnGrid, focusFromGrid, sourceField.focusedPlusOne)
  const clickWhileFocused = emitMultiply(
    circuit,
    sourceField.clickActive,
    circuit.affine([[gridMode, -1]], 1),
  )
  const focusedPlusOne = emitSelect(circuit, clickWhileFocused, zero, focusAfterGridClick)

  const nextGridMode = emitEqualForInteger(circuit, focusedPlusOne, zero)
  const rectangles: RectangleProjection[] = []
  for (let item = 0; item < itemCount; item++) {
    const gridRectangle = grid[item]!
    const thisFocused = emitEqualForInteger(circuit, focusedPlusOne, circuit.affine([], item + 1))
    rectangles.push({
      left: circuit.affine([
        [emitMultiply(circuit, nextGridMode, gridRectangle.left), 1],
        [emitMultiply(circuit, thisFocused, sourceField.gap), 1],
      ]),
      top: circuit.affine([
        [emitMultiply(circuit, nextGridMode, gridRectangle.top), 1],
        [emitMultiply(circuit, thisFocused, sourceField.gap), 1],
      ]),
      width: circuit.affine([
        [emitMultiply(circuit, nextGridMode, gridRectangle.width), 1],
        [emitMultiply(circuit, thisFocused, fullWidth), 1],
      ]),
      height: circuit.affine([
        [emitMultiply(circuit, nextGridMode, gridRectangle.height), 1],
        [emitMultiply(circuit, thisFocused, fullHeight), 1],
      ]),
      visible: circuit.affine([[nextGridMode, 1], [thisFocused, 1]]),
    })
  }

  return {
    circuit,
    output: {
      focusedPlusOne,
      clickActive: zero,
      rectangles,
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
      source[sourceField.focusedPlusOne] = values[output.focusedPlusOne]!
      source[sourceField.clickActive] = values[output.clickActive]!
      return values
    },
    click(x: number, y: number) {
      source[sourceField.clickActive] = 1
      source[sourceField.clickX] = Math.floor(x)
      source[sourceField.clickY] = Math.floor(y)
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
      const projection = machine.output.rectangles[item]!
      rectangle.style.left = `${values[projection.left]}px`
      rectangle.style.top = `${values[projection.top]}px`
      rectangle.style.width = `${values[projection.width]}px`
      rectangle.style.height = `${values[projection.height]}px`
      rectangle.style.opacity = `${values[projection.visible]}`
      rectangle.style.pointerEvents = values[projection.visible] === 1 ? 'auto' : 'none'
    }

    const focusedPlusOne = machine.source[sourceField.focusedPlusOne]
    readoutElement.textContent =
      `table cells ${machine.source.length} | layers ${machine.tensorProgram.layers.length} | weights ${weightCount} | ` +
      (focusedPlusOne === 0 ? 'grid: click a rectangle' : `focused rectangle ${focusedPlusOne}: click to return`)
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
  assertNonNegativeInteger(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeInteger(values[sourceField.viewportHeight], 'viewport height')
  assertNonNegativeInteger(values[sourceField.gap], 'gap')
  assertBoolean(values[sourceField.clickActive], 'click latch')
  assertInteger(values[sourceField.clickX], 'click x')
  assertInteger(values[sourceField.clickY], 'click y')
  assertIntegerBetween(values[sourceField.focusedPlusOne], 0, itemCount, 'focused rectangle')
}

function validateRectangleOutputWires(output: RectangleOutput, wireCount: number) {
  assertWire(output.focusedPlusOne, wireCount)
  assertWire(output.clickActive, wireCount)
  for (const rectangle of output.rectangles) {
    assertWire(rectangle.left, wireCount)
    assertWire(rectangle.top, wireCount)
    assertWire(rectangle.width, wireCount)
    assertWire(rectangle.height, wireCount)
    assertWire(rectangle.visible, wireCount)
  }
}

function validateRectangleOutput(values: Float64Array, output: RectangleOutput) {
  assertFiniteValues(values, 'tensor output')
  assertIntegerBetween(values[output.focusedPlusOne], 0, itemCount, 'next focused rectangle')
  invariant(values[output.clickActive] === 0, 'click latch must reset after refresh')
  let visibleCount = 0
  for (const rectangle of output.rectangles) {
    assertNonNegativeFinite(values[rectangle.left], 'rectangle left')
    assertNonNegativeFinite(values[rectangle.top], 'rectangle top')
    assertNonNegativeFinite(values[rectangle.width], 'rectangle width')
    assertNonNegativeFinite(values[rectangle.height], 'rectangle height')
    const visibility = values[rectangle.visible]
    assertBoolean(visibility, 'rectangle visibility')
    visibleCount += visibility
  }
  const expectedVisibleCount = values[output.focusedPlusOne] === 0 ? itemCount : 1
  invariant(visibleCount === expectedVisibleCount, 'visible rectangle count mismatch')
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.numericUiDemo = mountRectangleDemo(document, window)
}
