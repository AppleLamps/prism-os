import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine, notesSourceField, segmentOutputField, windowCount, windowOutputField} from '../../src/handwiredos/window-manager.ts'
import {type ArrangementMetrics, type Rectangle, arrangeInitialWindows, arrangeWindows} from '../../src/handwiredos/arrangement.ts'
import {defaultNotesParagraph, notesWords} from '../../src/handwiredos/notes-paragraph.ts'

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
// What arrangeInitialWindows reads from the table of a machine that starts with the
// default paragraph: the 44 px title bar, Photos' 18 px gap, and the paragraph's
// length on one line, 1,735.34375 px at the baked widths, rounded up to 1,800 px.
const metrics: ArrangementMetrics = {titleHeight: 44, notesTextWidth: 1800, photosGap: 18}

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
  assert.deepEqual(arrangeWindows(workspaceOf(1440, 900), minimum, natural, metrics), [
    {left: 48, top: 60, width: 520, height: 340},
    {left: 592, top: 60, width: 500, height: 366},
    {left: 248, top: 440, width: 470, height: 300},
    {left: 832, top: 186, width: 560, height: 430},
  ])
})

test('a larger viewport centers the group, at the same sizes', () => {
  const reference = arrangeWindows(workspaceOf(1440, 900), minimum, natural, metrics)
  const large = arrangeWindows(workspaceOf(1920, 1080), minimum, natural, metrics)
  large.forEach((rectangle, windowIndex) => {
    // 240 px further right, and half of the 180 px of added height further down.
    assert.deepEqual(rectangle, {...reference[windowIndex]!, left: reference[windowIndex]!.left + 240, top: reference[windowIndex]!.top + 90})
  })
})

test('every window opens inside the workspace, at least at the minimum size, on whole pixels', () => {
  for (const [width, height] of viewports) {
    const workspace = workspaceOf(width, height)
    assertFits(arrangeWindows(workspace, minimum, natural, metrics), workspace, `${width} × ${height}`)
  }
  // Every size from a small phone to a large display, in steps that reach odd sizes.
  for (let width = 320; width <= 3000; width += 37) {
    for (let height = 320; height <= 1700; height += 41) {
      const workspace = workspaceOf(width, height)
      assertFits(arrangeWindows(workspace, minimum, natural, metrics), workspace, `${width} × ${height}`)
    }
  }
  // Viewports smaller than a window, down to nothing.
  for (const [width, height] of [[300, 300], [279, 189], [100, 100], [50, 400], [400, 50], [0, 0]] as const) {
    const workspace = workspaceOf(width, height)
    assertFits(arrangeWindows(workspace, minimum, natural, metrics), workspace, `${width} × ${height}`)
  }
})

test('every window keeps part of its title bar in view', () => {
  // In stacking order, Files, Notes, Monitor, Photos: a window is covered only by
  // the windows after it. At least 44 × 44 px of each title bar, at its left end,
  // lie under no later window.
  for (const [width, height] of viewports) {
    const rectangles = arrangeWindows(workspaceOf(width, height), minimum, natural, metrics)
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
  const phone = arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics)
  for (const rectangle of phone) assert.deepEqual([rectangle.left, rectangle.width], [8, 374])
  const shown = (rectangles: readonly Rectangle[]) => rectangles.slice(1).map((rectangle, index) => rectangle.top - rectangles[index]!.top)
  // Files shows its title bar alone, since 10 px of its content would show half a
  // line of letters. Notes shows its 7 lines of 22 px below the 69 px above the first
  // line, and Monitor its sentence on two lines.
  assert.deepEqual(shown(phone), [44, 69 + 7 * 22 + 4, 113])
  // The column is centered in the 10 px that Files gave up: 13 px under the system
  // bar, and Photos, in front, ends 13 px above the dock.
  assert.equal(phone[0]!.top, systemBarHeight + 13)
  assert.equal(phone[3]!.top + phone[3]!.height, 844 - dockHeight - 13)

  // A taller phone has 38 px for Files' content, which hold the list's 28 px header,
  // so Files shows them, and the column starts 8 px under the system bar.
  const taller = arrangeWindows(workspaceOf(414, 896), minimum, natural, metrics)
  assert.equal(shown(taller)[0], 44 + 38)
  assert.equal(taller[0]!.top, systemBarHeight + 8)

  // A wider and taller column has room for Monitor's three figures, under its
  // sentence on one line, and for 5 lines of Notes.
  const tall = arrangeWindows(workspaceOf(600, 1000), minimum, natural, metrics)
  for (const rectangle of tall) assert.deepEqual([rectangle.left, rectangle.width], [40, 520])
  assert.deepEqual(shown(tall), [140, 69 + 5 * 22 + 4, 93 + 64])
})

test('the arrangement reads the title bar, Photos\' gap and the length of Notes\' text from the table, and a longer text gets more lines', () => {
  // The default paragraph's widths add up to 1,735.34375 px on October 13, 2026, which
  // the arrangement rounds up to the next 100 px.
  const paragraphWidth = defaultNotesParagraph.widths.reduce((sum, width) => sum + width, 0)
  assert.equal(Math.ceil(paragraphWidth / 100) * 100, metrics.notesTextWidth)
  const machine = createWindowManagerMachine()
  assert.deepEqual(
    arrangeInitialWindows(machine.source, machine.cells, 390, 844),
    arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics),
  )
  const shown = (rectangles: readonly Rectangle[]) => rectangles.slice(1).map((rectangle, index) => rectangle.top - rectangles[index]!.top)

  // The same paragraph twice, with the space between the two, is 3,475.0625 px long
  // at those widths, i.e. 3,500 px for the arrangement. In the phone's column of
  // 324 px that is 11 lines and one to spare, where the default paragraph has 6 and
  // one. So Notes shows 12 lines and not 7, Photos gives up 31 px of its 322, and
  // Monitor is left with its title bar.
  const doubled = {
    widths: [...defaultNotesParagraph.widths, 4.375, ...defaultNotesParagraph.widths],
    breakAfter: [...defaultNotesParagraph.breakAfter, 1, ...defaultNotesParagraph.breakAfter],
  }
  const longer = createWindowManagerMachine({notes: {paragraph: doubled}})
  const longerRectangles = arrangeInitialWindows(longer.source, longer.cells, 390, 844)
  assert.deepEqual(longerRectangles, arrangeWindows(workspaceOf(390, 844), minimum, natural, {...metrics, notesTextWidth: Math.ceil((2 * paragraphWidth + 4.375) / 100) * 100}))
  assert.deepEqual(shown(arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics)), [44, 69 + 7 * 22 + 4, 113])
  assert.deepEqual(shown(longerRectangles), [44, 69 + 12 * 22 + 4, 44])
  assert.deepEqual([arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics)[3]!.height, longerRectangles[3]!.height], [322, 291])

  // A taller title bar and a smaller gap in the table move the column's parts by the
  // same amounts: with a 50 px title bar, Notes' first line starts 6 px lower.
  const taller = createWindowManagerMachine()
  taller.source[taller.cells.titleHeight] = 50
  taller.source[taller.cells.photos.gap] = 6
  const tallerRectangles = arrangeInitialWindows(taller.source, taller.cells, 390, 844)
  assert.deepEqual(tallerRectangles, arrangeWindows(workspaceOf(390, 844), minimum, natural, {titleHeight: 50, notesTextWidth: 1800, photosGap: 6}))
  assert.equal(shown(tallerRectangles)[1], 75 + 7 * 22 + 4)
})

test('the program keeps the arrangement as written, starts at rest, and lays out Notes\' whole paragraph', () => {
  for (const [width, height] of viewports.slice(0, 6)) {
    const machine = createWindowManagerMachine()
    const rectangles = arrangeInitialWindows(machine.source, machine.cells, width, height)
    assert.deepEqual(rectangles, arrangeWindows(workspaceOf(width, height), minimum, natural, metrics))
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
    // Every word of the paragraph is laid out: `truncated` is 0, i.e. no segment of the
    // text comes after the last line, and each of the 45 words, the segment cells that
    // hold text and don't break after themselves, has its visible output at 1.
    assert.equal(values[machine.output.notes.truncated], 0, `${width} × ${height}: Notes lays out its whole paragraph`)
    let visibleWords = 0
    for (let segment = 0; segment < machine.source[notesSourceField.arrivedCount]!; segment++) {
      if (machine.source[notesSourceField.breakAfterStart + segment] === 1) continue
      visibleWords += values[machine.output.notes.segments[segment * segmentOutputField.size + segmentOutputField.visible]!]!
    }
    assert.equal(visibleWords, notesWords.length, `${width} × ${height}: ${visibleWords} of the 45 words are laid out`)
  }
})
