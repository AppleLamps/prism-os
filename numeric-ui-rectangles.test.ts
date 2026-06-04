import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createRectangleMachine, itemCount, sourceField} from './numeric-ui-rectangles.ts'

const viewportWidth = 1280
const viewportHeight = 720
const gap = 24
const machine = createRectangleMachine()

function step() {
  return machine.step(viewportWidth, viewportHeight)
}

function projectRectangles(values: Float64Array) {
  return machine.output.rectangles.map(rectangle => ({
    left: values[rectangle.left]!,
    top: values[rectangle.top]!,
    width: values[rectangle.width]!,
    height: values[rectangle.height]!,
    visible: values[rectangle.visible]!,
  }))
}

function assertGrid(values: Float64Array) {
  assert.equal(machine.source[sourceField.focusedPlusOne], 0)
  assert.deepEqual(projectRectangles(values), [
    {left: 24, top: 24, width: 604, height: 324, visible: 1},
    {left: 652, top: 24, width: 604, height: 324, visible: 1},
    {left: 24, top: 372, width: 604, height: 324, visible: 1},
    {left: 652, top: 372, width: 604, height: 324, visible: 1},
  ])
}

test('grid rectangles focus and return to the grid', () => {
  let values = step()
  assertGrid(values)

  for (let item = 0; item < itemCount; item++) {
    const gridRectangle = projectRectangles(values)[item]!
    machine.click(gridRectangle.left, gridRectangle.top)
    values = step()
    assert.equal(machine.source[sourceField.focusedPlusOne], item + 1)
    assert.deepEqual(
      projectRectangles(values),
      Array.from({length: itemCount}, (_, rectangle) => rectangle === item
        ? {left: gap, top: gap, width: 1232, height: 672, visible: 1}
        : {left: 0, top: 0, width: 0, height: 0, visible: 0}),
    )

    machine.click(0, 0)
    values = step()
    assertGrid(values)
  }

  console.log(`Verified grid, focus, and return-to-grid for ${itemCount} fixed rectangle slots.`)
})
