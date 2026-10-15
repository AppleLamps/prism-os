import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine, windowCount, windowOutputField} from '../../src/handwiredos/window-manager.ts'
import {arrangeInitialWindows} from '../../src/handwiredos/arrangement.ts'
import {arrangePrismWindows} from '../../src/prismos/arrangement.ts'

// The program's numbers, see windowManagerCells in window-manager.ts.
const systemBarHeight = 36
const dockHeight = 76

const viewports: readonly (readonly [width: number, height: number])[] = [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
  [1280, 720],
  [1024, 768],
  [820, 1180],
  [640, 800],
  [639, 800],
  [390, 844],
  [375, 667],
  [360, 640],
  [844, 390],
  [300, 300],
  [100, 100],
  [0, 0],
]

// One machine's cells and a fresh copy of its starting table for each arrangement: an
// arrangement reads the windows' natural sizes from the table and overwrites them.
const base = createWindowManagerMachine()
const arrangeBoth = (width: number, height: number) => ({
  tiled: arrangeInitialWindows(base.source.slice(), base.cells, width, height),
  prism: arrangePrismWindows(base.source.slice(), base.cells, width, height),
})

test('every Prism window opens inside the workspace, on whole pixels, at HandwiredOS\'s sizes', () => {
  const sweep: [number, number][] = [...viewports.map(([width, height]): [number, number] => [width, height])]
  // Every size from a small phone to a large display, in steps that reach odd sizes.
  for (let width = 320; width <= 3000; width += 37) {
    for (let height = 320; height <= 1700; height += 41) sweep.push([width, height])
  }
  for (const [width, height] of sweep) {
    const label = `${width} × ${height}`
    const {tiled, prism} = arrangeBoth(width, height)
    assert.equal(prism.length, windowCount)
    const dockTop = height - Math.min(dockHeight, height)
    const workspaceTop = Math.min(systemBarHeight, dockTop)
    prism.forEach((rectangle, windowIndex) => {
      for (const value of [rectangle.left, rectangle.top]) assert.ok(Number.isInteger(value), `${label}: ${value} is not a whole pixel`)
      assert.equal(rectangle.width, tiled[windowIndex]!.width, `${label}: window ${windowIndex}'s width`)
      assert.equal(rectangle.height, tiled[windowIndex]!.height, `${label}: window ${windowIndex}'s height`)
      assert.ok(rectangle.left >= 0, `${label}: window ${windowIndex}'s left ${rectangle.left}`)
      assert.ok(rectangle.top >= workspaceTop, `${label}: window ${windowIndex}'s top ${rectangle.top}`)
      assert.ok(rectangle.left + rectangle.width <= width, `${label}: window ${windowIndex}'s right edge`)
      assert.ok(rectangle.top + rectangle.height <= dockTop, `${label}: window ${windowIndex}'s bottom edge`)
    })
  }
})

test('on a wide desk each window sits 36 px further down and right than HandwiredOS puts it', () => {
  const {tiled, prism} = arrangeBoth(1920, 1080)
  prism.forEach((rectangle, windowIndex) => {
    assert.equal(rectangle.left, tiled[windowIndex]!.left + windowIndex * 36)
    assert.equal(rectangle.top, tiled[windowIndex]!.top + windowIndex * 36)
  })
})

test('the program draws the Prism windows where the arrangement wrote them, at rest', () => {
  for (const [width, height] of viewports.slice(0, 11)) {
    const machine = createWindowManagerMachine()
    const rectangles = arrangePrismWindows(machine.source, machine.cells, width, height)
    const values = machine.step(width, height, 16)
    rectangles.forEach((rectangle, windowIndex) => {
      const read = (field: number) => values[machine.output.windows[windowIndex * windowOutputField.size + field]!]!
      assert.deepEqual(
        {
          left: read(windowOutputField.translateX),
          top: read(windowOutputField.translateY),
          width: read(windowOutputField.width),
          height: read(windowOutputField.height),
        },
        rectangle,
        `${width} × ${height}: window ${windowIndex} is drawn where it was written`,
      )
    })
    assert.equal(values[machine.output.animationActive], 0, `${width} × ${height}: nothing animates`)
  }
})
