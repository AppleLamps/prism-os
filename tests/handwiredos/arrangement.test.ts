import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine, windowCount, windowOutputField} from '../../src/handwiredos/window-manager.ts'
import {type ArrangementMetrics, type Rectangle, arrangeInitialWindows, arrangeWindows} from '../../src/handwiredos/arrangement.ts'

// The program's numbers, see windowManagerCells in window-manager.ts.
const systemBarHeight = 36
const dockHeight = 76
const minimum = {width: 280, height: 190}
const natural = [
  {width: 540, height: 340},
  {width: 500, height: 366},
  {width: 560, height: 430},
]
// What arrangeInitialWindows reads from a machine's table: the 44 px title bar,
// Photos' 18 px gap, and the 12 px margin around a maximized window.
const metrics: ArrangementMetrics = {titleHeight: 44, photosGap: 18, maximizedMargin: 12}

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

test('at 1440 × 900 Monitor is a column as tall as Notes and Photos together, and Photos covers Notes\' lower right part', () => {
  assert.deepEqual(arrangeWindows(workspaceOf(1440, 900), minimum, natural, metrics), [
    {left: 38, top: 152, width: 540, height: 556},
    {left: 602, top: 152, width: 500, height: 366},
    {left: 842, top: 278, width: 560, height: 430},
  ])
  // The group is centered: 116 px lie between the system bar and the windows, and as
  // many between Photos and the dock, and 38 px at the left and at the right.
  assert.equal(152 - systemBarHeight, 900 - dockHeight - (278 + 430))
  assert.equal(38, 1440 - (842 + 560))
})

test('a viewport 1280 px wide narrows Photos, and Monitor keeps the width that shows five columns', () => {
  const rectangles = arrangeWindows(workspaceOf(1280, 800), minimum, natural, metrics)
  assert.deepEqual(rectangles, [
    {left: 24, top: 102, width: 534, height: 556},
    {left: 582, top: 102, width: 500, height: 366},
    {left: 822, top: 228, width: 434, height: 430},
  ])
  // The list is Monitor's content box without the 152 px sidebar, and Operations' five
  // columns take 372 px, see handwired-os.css.
  assert.ok(rectangles[0]!.width - 2 - 152 >= 372)
  // The group is centered between the system bar and the dock.
  assert.equal(102 - systemBarHeight, 800 - dockHeight - (228 + 430))
})

test('on a narrower desk Photos is shorter too, so that its photos are at most 1.25 times as tall as wide', () => {
  // A photo's size in Photos: 4 columns and 3 rows, with the 18 px gap around and
  // between them, inside the 1 px border and under the 44 px title bar.
  const photoOf = (photos: Rectangle) => ({width: (photos.width - 2 - 5 * 18) / 4, height: (photos.height - 44 - 2 - 4 * 18) / 3})
  for (const [width, height] of [[1100, 850], [1024, 768], [1000, 700]] as const) {
    const [monitor, notes, photos] = arrangeWindows(workspaceOf(width, height), minimum, natural, metrics) as [Rectangle, Rectangle, Rectangle]
    const photo = photoOf(photos)
    const label = `${width} × ${height}`
    assert.ok(photos.width < 400 && photos.height < 430, `${label}: Photos is ${photos.width} × ${photos.height}`)
    // Within the half pixel that rounding the window's height to whole pixels moves a photo's height.
    assert.ok(Math.abs(photo.height - 1.25 * photo.width) < 0.5, `${label}: a photo is ${photo.width} × ${photo.height}`)
    // Monitor is still as tall as Notes and Photos together.
    assert.deepEqual([monitor.top, monitor.top + monitor.height], [notes.top, photos.top + photos.height], label)
  }
  // At 1280 px of width, Photos is 434 px wide and keeps its height: a photo is 85.5 × 104 px.
  assert.deepEqual(photoOf(arrangeWindows(workspaceOf(1280, 800), minimum, natural, metrics)[2]!), {width: 85.5, height: 104})
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
  // In stacking order, Monitor, Notes, Photos: a window is covered only by the
  // windows after it. At least 44 × 44 px of each title bar, at its left end,
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
  // A phone: 12 px from the viewport's sides, the margin of a maximized window.
  const phone = arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics)
  for (const rectangle of phone) assert.deepEqual([rectangle.left, rectangle.width], [12, 366])
  const shown = (rectangles: readonly Rectangle[]) => rectangles.slice(1).map((rectangle, index) => rectangle.top - rectangles[index]!.top)
  // Monitor shows its title bar, the list's header and 3 whole rows: 45 px to its
  // content box, 28 px of header and 24 px a row. The sidebar's heading is as tall
  // as the header and its three locations as tall as the rows, so they are whole
  // too, and the caption under them is covered. Photos takes 45% of the height, and
  // Notes shows the rest: its title bar and 199 px of the note, of which the least
  // is 136 px, i.e. the 24 px above the first line, 4 lines of 22 px and 24 px
  // under them.
  const monitorShown = 45 + 28 + 3 * 24
  const notesLeast = 45 + 24 + 4 * 22 + 24
  assert.deepEqual(shown(phone), [monitorShown, 45 + 199])
  assert.ok(shown(phone)[1]! >= notesLeast)
  // The column fills the height: it starts 12 px under the system bar, and Photos,
  // in front, ends 12 px above the dock.
  assert.equal(phone[0]!.top, systemBarHeight + 12)
  assert.equal(phone[2]!.top + phone[2]!.height, 844 - dockHeight - 12)

  // A taller phone shows the same of Monitor, and more of the note.
  const taller = arrangeWindows(workspaceOf(414, 896), minimum, natural, metrics)
  assert.deepEqual(shown(taller), [monitorShown, 45 + 229])
  assert.equal(taller[0]!.top, systemBarHeight + 12)

  // A small phone has 111 px left for Monitor beside the least of Notes, which hold
  // its header and 1 row.
  const small = arrangeWindows(workspaceOf(375, 667), minimum, natural, metrics)
  assert.deepEqual(shown(small), [45 + 28 + 24, notesLeast + 14])

  // A wider and taller column shows 3 rows too, and 285 px of the note.
  const tall = arrangeWindows(workspaceOf(600, 1000), minimum, natural, metrics)
  for (const rectangle of tall) assert.deepEqual([rectangle.left, rectangle.width], [30, 540])
  assert.deepEqual(shown(tall), [monitorShown, 45 + 285])

  // A column tall enough for all of Monitor, Notes and Photos shows each whole, with
  // the 12 px margin under Monitor and under Notes.
  const whole = arrangeWindows(workspaceOf(600, 1400), minimum, natural, metrics)
  assert.deepEqual(shown(whole), [340 + 12, 366 + 12])
  assert.deepEqual(whole.map(rectangle => rectangle.height), [340, 366, 430])
})

test('two columns from 640 px of width: Monitor at the left, as tall as Notes and Photos at the right', () => {
  for (const [width, height] of [[999, 700], [820, 1180], [640, 800]] as const) {
    const [monitor, notes, photos] = arrangeWindows(workspaceOf(width, height), minimum, natural, metrics) as [Rectangle, Rectangle, Rectangle]
    const label = `${width} × ${height}`
    assert.deepEqual([monitor.width, notes.width, photos.width], [notes.width, notes.width, notes.width], label)
    assert.deepEqual([notes.left, photos.left], [monitor.left + monitor.width + 16, monitor.left + monitor.width + 16], label)
    assert.deepEqual([monitor.top, monitor.top + monitor.height], [notes.top, photos.top + photos.height], label)
    assert.equal(photos.top, notes.top + notes.height + 16, label)
  }
  // One px narrower, the windows are one column.
  const column = arrangeWindows(workspaceOf(639, 800), minimum, natural, metrics)
  assert.deepEqual(column.map(rectangle => rectangle.left), [50, 50, 50])
  // On a short desk, Notes is as short as a window gets, which still shows the
  // note's first 136 px in its content box of 144 px, and Photos gets the rest of
  // the column.
  const [, notes, photos] = arrangeWindows(workspaceOf(999, 700), minimum, natural, metrics) as [Rectangle, Rectangle, Rectangle]
  assert.deepEqual([notes.height, photos.height], [190, 350])
  assert.ok(notes.height - 44 - 2 >= 136)
})

test('in one row, Notes stands whole beside Photos, and covers the right part of Monitor', () => {
  // A phone held sideways: Photos and Notes at the minimum width, side by side, and
  // 260 px of Monitor in view left of Notes. The row keeps 12 px from each edge of
  // the workspace, the margin of a maximized window.
  assert.deepEqual(arrangeWindows(workspaceOf(844, 390), minimum, natural, metrics), [
    {left: 12, top: 48, width: 540, height: 254},
    {left: 272, top: 48, width: 280, height: 254},
    {left: 552, top: 48, width: 280, height: 254},
  ])
  // A wider desk of the same height shows Monitor whole too, and gives Notes the
  // rest, 344 px.
  assert.deepEqual(arrangeWindows(workspaceOf(1200, 400), minimum, natural, metrics), [
    {left: 12, top: 48, width: 540, height: 264},
    {left: 564, top: 48, width: 344, height: 264},
    {left: 908, top: 48, width: 280, height: 264},
  ])
  // Where the three don't fit, Monitor keeps 88 px of its title bar in view, and
  // Photos covers the right 72 px of Notes.
  assert.deepEqual(arrangeWindows(workspaceOf(600, 380), minimum, natural, metrics), [
    {left: 12, top: 48, width: 540, height: 244},
    {left: 100, top: 48, width: 280, height: 244},
    {left: 308, top: 48, width: 280, height: 244},
  ])
})

test('the arrangement reads the title bar, Photos\' gap and the margin of a maximized window from the table', () => {
  const machine = createWindowManagerMachine()
  assert.deepEqual(
    arrangeInitialWindows(machine.source, machine.cells, 390, 844),
    arrangeWindows(workspaceOf(390, 844), minimum, natural, metrics),
  )
  const shown = (rectangles: readonly Rectangle[]) => rectangles.slice(1).map((rectangle, index) => rectangle.top - rectangles[index]!.top)

  // A taller title bar and a smaller gap in the table move the column's parts by the
  // same amounts: with a 50 px title bar, Monitor shows 6 px more for the same header
  // and 3 rows, which Notes gives up.
  const taller = createWindowManagerMachine()
  taller.source[taller.cells.titleHeight] = 50
  taller.source[taller.cells.photos.gap] = 6
  const tallerRectangles = arrangeInitialWindows(taller.source, taller.cells, 390, 844)
  assert.deepEqual(tallerRectangles, arrangeWindows(workspaceOf(390, 844), minimum, natural, {titleHeight: 50, photosGap: 6, maximizedMargin: 12}))
  const sameGap = arrangeWindows(workspaceOf(390, 844), minimum, natural, {titleHeight: 44, photosGap: 6, maximizedMargin: 12})
  assert.deepEqual(shown(tallerRectangles), [51 + 28 + 3 * 24, shown(sameGap)[1]! - 6])

  // A wider margin in the table moves the column in from the workspace's edges by
  // as much.
  const wider = createWindowManagerMachine()
  wider.source[wider.cells.margin] = 20
  for (const rectangle of arrangeInitialWindows(wider.source, wider.cells, 390, 844)) assert.deepEqual([rectangle.left, rectangle.width], [20, 350])
})

test('in one column and in one row, a maximized window covers the other two windows', () => {
  // A phone held upright and sideways, and a smaller one. Photos' maximize button is
  // 47 px left of the window's right edge and 22 px under its top.
  for (const [width, height] of [[390, 844], [844, 390], [360, 640]] as const) {
    const machine = createWindowManagerMachine()
    const [monitor, notes, photos] = arrangeInitialWindows(machine.source, machine.cells, width, height) as [Rectangle, Rectangle, Rectangle]
    machine.step(width, height, 16)
    machine.pointerDown(photos.left + photos.width - 47, photos.top + 22, 20)
    machine.pointerUp(photos.left + photos.width - 47, photos.top + 22, 24)
    let values = machine.step(width, height, 32)
    for (let frameTime = 48; machine.clock.animatedUntilMs !== null; frameTime += 16) values = machine.step(width, height, frameTime)
    const read = (field: number) => values[machine.output.windows[2 * windowOutputField.size + field]!]!
    assert.equal(read(windowOutputField.maximized), 1)
    const maximized = {left: read(windowOutputField.translateX), top: read(windowOutputField.translateY), width: read(windowOutputField.width), height: read(windowOutputField.height)}
    assert.deepEqual(maximized, {left: 12, top: systemBarHeight + 12, width: width - 24, height: height - systemBarHeight - dockHeight - 24})
    for (const [name, rectangle] of [['Monitor', monitor], ['Notes', notes]] as const) {
      const label = `${width} × ${height}: ${name}`
      assert.ok(rectangle.left >= maximized.left && rectangle.top >= maximized.top, label)
      assert.ok(rectangle.left + rectangle.width <= maximized.left + maximized.width && rectangle.top + rectangle.height <= maximized.top + maximized.height, label)
    }
  }
})

test('the program keeps the arrangement as written, and starts at rest', () => {
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
  }
})
