import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine, windowCount, windowOutputField, wordOutputField} from '../../src/handwiredos/window-manager.ts'
import {type Rectangle, arrangeInitialWindows, arrangeWindows} from '../../src/handwiredos/arrangement.ts'

// The program's numbers, see windowManagerCellsFor in window-manager.ts.
const systemBarHeight = 36
const dockHeight = 76
const minimum = {width: 280, height: 190}
const natural = [
  {width: 520, height: 340},
  {width: 500, height: 366},
  {width: 470, height: 300},
  {width: 560, height: 430},
]

// The viewports that the page was checked at in a browser, and other common ones.
const viewports: readonly (readonly [width: number, height: number])[] = [
  [1920, 1080],
  [1440, 900],
  [1280, 720],
  [1024, 768],
  [820, 1180],
  [390, 844],
  [2560, 1300],
  [1728, 1000],
  [1512, 860],
  [1440, 790],
  [1280, 610],
  [1100, 700],
  [1000, 700],
  [999, 700],
  [900, 600],
  [768, 1024],
  [844, 390],
  [640, 800],
  [639, 800],
  [600, 1000],
  [375, 667],
  [360, 640],
]

function workspaceOf(viewportWidth: number, viewportHeight: number): Rectangle {
  const dockTop = viewportHeight - Math.min(dockHeight, viewportHeight)
  const top = Math.min(systemBarHeight, dockTop)
  return {left: 0, top, width: viewportWidth, height: dockTop - top}
}

function assertFits(rectangles: readonly Rectangle[], workspace: Rectangle, label: string) {
  assert.equal(rectangles.length, windowCount)
  for (const rectangle of rectangles) {
    for (const value of [rectangle.left, rectangle.top, rectangle.width, rectangle.height]) {
      assert.ok(Number.isInteger(value), `${label}: ${value} is not a whole pixel`)
    }
    assert.ok(rectangle.width >= Math.min(minimum.width, workspace.width), `${label}: width ${rectangle.width}`)
    assert.ok(rectangle.height >= Math.min(minimum.height, workspace.height), `${label}: height ${rectangle.height}`)
    assert.ok(rectangle.left >= workspace.left, `${label}: left ${rectangle.left}`)
    assert.ok(rectangle.top >= workspace.top, `${label}: top ${rectangle.top}`)
    assert.ok(rectangle.left + rectangle.width <= workspace.left + workspace.width, `${label}: right edge ${rectangle.left + rectangle.width}`)
    assert.ok(rectangle.top + rectangle.height <= workspace.top + workspace.height, `${label}: bottom edge ${rectangle.top + rectangle.height}`)
  }
}

test('at 1440 × 900 the windows open at the design\'s rectangles', () => {
  assert.deepEqual(arrangeWindows(workspaceOf(1440, 900), minimum, natural), [
    {left: 48, top: 60, width: 520, height: 340},
    {left: 592, top: 60, width: 500, height: 366},
    {left: 248, top: 440, width: 470, height: 300},
    {left: 832, top: 186, width: 560, height: 430},
  ])
})

test('a larger viewport centers the group, at the same sizes', () => {
  const reference = arrangeWindows(workspaceOf(1440, 900), minimum, natural)
  const large = arrangeWindows(workspaceOf(1920, 1080), minimum, natural)
  large.forEach((rectangle, windowIndex) => {
    // 240 px further right, and half of the 180 px of added height further down.
    assert.deepEqual(rectangle, {...reference[windowIndex]!, left: reference[windowIndex]!.left + 240, top: reference[windowIndex]!.top + 90})
  })
})

test('every window opens inside the workspace, at least at the minimum size, on whole pixels', () => {
  for (const [width, height] of viewports) {
    const workspace = workspaceOf(width, height)
    assertFits(arrangeWindows(workspace, minimum, natural), workspace, `${width} × ${height}`)
  }
  // Every size from a small phone to a large display, in steps that reach odd sizes.
  for (let width = 320; width <= 3000; width += 37) {
    for (let height = 320; height <= 1700; height += 41) {
      const workspace = workspaceOf(width, height)
      assertFits(arrangeWindows(workspace, minimum, natural), workspace, `${width} × ${height}`)
    }
  }
  // Viewports smaller than a window, down to nothing.
  for (const [width, height] of [[300, 300], [279, 189], [100, 100], [50, 400], [400, 50], [0, 0]] as const) {
    const workspace = workspaceOf(width, height)
    assertFits(arrangeWindows(workspace, minimum, natural), workspace, `${width} × ${height}`)
  }
})

test('every window keeps part of its title bar in view', () => {
  // In stacking order, Files, Notes, Monitor, Photos: a window is covered only by
  // the windows after it. At least 44 × 44 px of each title bar, at its left end,
  // lie under no later window.
  for (const [width, height] of viewports) {
    const rectangles = arrangeWindows(workspaceOf(width, height), minimum, natural)
    rectangles.forEach((rectangle, windowIndex) => {
      const covered = rectangles.slice(windowIndex + 1).some(other =>
        other.left < rectangle.left + 44 && other.left + other.width > rectangle.left
        && other.top < rectangle.top + 44 && other.top + other.height > rectangle.top)
      assert.ok(!covered, `${width} × ${height}: window ${windowIndex}'s title bar is covered`)
    })
  }
})

test('in one column, each window is covered just under a part of its content', () => {
  // A phone: 8 px from the viewport's sides.
  const phone = arrangeWindows(workspaceOf(390, 844), minimum, natural)
  for (const rectangle of phone) assert.deepEqual([rectangle.left, rectangle.width], [8, 374])
  const shown = (rectangles: readonly Rectangle[]) => rectangles.slice(1).map((rectangle, index) => rectangle.top - rectangles[index]!.top)
  // Files shows its title bar and 10 px, Notes its 7 lines of 22 px below the 69 px
  // above the first line, and Monitor its sentence on two lines.
  assert.deepEqual(shown(phone), [54, 69 + 7 * 22 + 4, 113])
  // Photos, in front, ends 8 px above the dock.
  assert.equal(phone[3]!.top + phone[3]!.height, 844 - dockHeight - 8)

  // A wider and taller column has room for Monitor's three figures, under its
  // sentence on one line, and for 5 lines of Notes.
  const tall = arrangeWindows(workspaceOf(600, 1000), minimum, natural)
  for (const rectangle of tall) assert.deepEqual([rectangle.left, rectangle.width], [40, 520])
  assert.deepEqual(shown(tall), [140, 69 + 5 * 22 + 4, 93 + 64])
})

test('the program keeps the arrangement as written, starts at rest, and lays out every Notes word', () => {
  for (const [width, height] of viewports.slice(0, 6)) {
    const machine = createWindowManagerMachine()
    const rectangles = arrangeInitialWindows(machine.source, machine.cells, width, height)
    assert.deepEqual(rectangles, arrangeWindows(workspaceOf(width, height), minimum, natural))
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
      assert.equal(read(windowOutputField.scale), 1)
      // The program's clamps left the stored rectangle alone.
      const stored = machine.cells.windows[windowIndex]!
      assert.deepEqual(
        {left: machine.source[stored.left], top: machine.source[stored.top], width: machine.source[stored.width], height: machine.source[stored.height]},
        rectangle,
      )
    })
    assert.equal(values[machine.output.animationActive], 0, `${width} × ${height}: nothing animates`)
    assert.equal(machine.clock.animatedUntilMs, null)
    const wordCount = machine.output.notes.words.length / wordOutputField.size
    let visibleWords = 0
    for (let word = 0; word < wordCount; word++) {
      visibleWords += values[machine.output.notes.words[word * wordOutputField.size + wordOutputField.visible]!]!
    }
    assert.equal(visibleWords, wordCount, `${width} × ${height}: Notes lays out every word`)
    assert.equal(values[machine.output.notes.truncated], 0)
  }
})
