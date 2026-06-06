import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createRectangleMachine,
  focusField,
  itemCount,
  rectangleField,
  sourceField,
} from './numeric-ui-rectangles.ts'

const viewportWidth = 1280
const viewportHeight = 720
const gap = 24

function projectRectangles(machine: ReturnType<typeof createRectangleMachine>, values: Float64Array) {
  return Array.from({length: itemCount}, (_, item) => {
    const outputStart = machine.output.rectangleStart + item * rectangleField.size
    return {
      left: values[outputStart + rectangleField.left]!,
      top: values[outputStart + rectangleField.top]!,
      width: values[outputStart + rectangleField.width]!,
      height: values[outputStart + rectangleField.height]!,
      visible: values[outputStart + rectangleField.opacity]!,
    }
  })
}

function readFocus(machine: ReturnType<typeof createRectangleMachine>) {
  return Array.from({length: itemCount}, (_, item) => machine.source[focusField(item)]!)
}

function assertGrid(machine: ReturnType<typeof createRectangleMachine>, values: Float64Array) {
  assert.deepEqual(readFocus(machine), [0, 0, 0, 0])
  assert.deepEqual(projectRectangles(machine, values), [
    {left: 24, top: 24, width: 604, height: 324, visible: 1},
    {left: 652, top: 24, width: 604, height: 324, visible: 1},
    {left: 24, top: 372, width: 604, height: 324, visible: 1},
    {left: 652, top: 372, width: 604, height: 324, visible: 1},
  ])
}

test('interior clicks focus each rectangle and the next click returns to the grid', () => {
  const machine = createRectangleMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  assertGrid(machine, values)

  for (let item = 0; item < itemCount; item++) {
    const gridRectangle = projectRectangles(machine, values)[item]!
    machine.click(
      gridRectangle.left + gridRectangle.width / 2,
      gridRectangle.top + gridRectangle.height / 2,
    )
    values = machine.step(viewportWidth, viewportHeight)
    assert.deepEqual(readFocus(machine), Array.from({length: itemCount}, (_, index) => Number(index === item)))
    assert.deepEqual(
      projectRectangles(machine, values),
      Array.from({length: itemCount}, (_, rectangle) => rectangle === item
        ? {left: gap, top: gap, width: 1232, height: 672, visible: 1}
        : {left: 0, top: 0, width: 0, height: 0, visible: 0}),
    )

    machine.click(0, 0)
    values = machine.step(viewportWidth, viewportHeight)
    assertGrid(machine, values)
  }
})

test('odd viewport dimensions support exact interior focus and soft boundary focus', () => {
  const machine = createRectangleMachine()
  let values = machine.step(1281, 721)
  const rectangles = projectRectangles(machine, values)
  assert.deepEqual(rectangles[1], {left: 652.5, top: 24, width: 604.5, height: 324.5, visible: 1})

  const second = rectangles[1]
  machine.click(second.left + second.width / 2, second.top + second.height / 2)
  values = machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), [0, 1, 0, 0])

  machine.click(0, 0)
  values = machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), [0, 0, 0, 0])

  const first = projectRectangles(machine, values)[0]!
  machine.click(first.left + 0.5, first.top + first.height / 2)
  machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), [0.5, 0, 0, 0])
})

test('tiny viewports clamp rectangle dimensions and cannot produce a hit', () => {
  const machine = createRectangleMachine()
  let values = machine.step(40, 40)
  const rectangles = projectRectangles(machine, values)
  for (const rectangle of rectangles) {
    assert.equal(rectangle.width, 0)
    assert.equal(rectangle.height, 0)
  }

  machine.click(24, 24)
  values = machine.step(40, 40)
  assert.deepEqual(readFocus(machine), [0, 0, 0, 0])
  for (const rectangle of projectRectangles(machine, values)) {
    assert.ok(rectangle.width >= 0)
    assert.ok(rectangle.height >= 0)
  }
})

test('the complete next source table is one contiguous output block', () => {
  const machine = createRectangleMachine()
  machine.click(326, 186)
  const values = machine.step(viewportWidth, viewportHeight)
  const nextSource = values.subarray(
    machine.output.nextSourceStart,
    machine.output.nextSourceStart + sourceField.size,
  )

  assert.equal(nextSource.length, sourceField.size)
  assert.deepEqual([...nextSource], [...machine.source])
  assert.deepEqual([...nextSource], [
    viewportWidth,
    viewportHeight,
    gap,
    0,
    326,
    186,
    1,
    0,
    0,
    0,
  ])
})

test('all rectangle projections are one contiguous output block', () => {
  const machine = createRectangleMachine()
  const values = machine.step(viewportWidth, viewportHeight)
  const rectangleOutput = values.subarray(
    machine.output.rectangleStart,
    machine.output.rectangleStart + itemCount * rectangleField.size,
  )

  assert.equal(rectangleOutput.length, itemCount * rectangleField.size)
  assert.deepEqual([...rectangleOutput], [
    24, 24, 604, 324, 1,
    652, 24, 604, 324, 1,
    24, 372, 604, 324, 1,
    652, 372, 604, 324, 1,
  ])
})
