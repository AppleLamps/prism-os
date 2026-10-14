import {describe, expect, test} from 'bun:test'
import {validateTensorEvaluation} from '../../src/runtime/numeric-ui-core.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  valueListSourceField,
  photoSourceField,
  sourceField as windowSourceFieldTable,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'
import {rowCapacity as valueListRowCapacity} from '../../src/handwiredos/value-list.ts'
import {
  controlField,
  createPhotoGalleryMachine,
  itemCount as photoItemCount,
  photoField,
  thumbnailField,
} from '../../src/handwiredos/photo-gallery.ts'

// Seeded hash from numeric-ui-core.test.ts; the only source of "randomness".
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

// Irregular frame times in the 5..49 ms band, deterministically drawn.
function irregularFrameTime(random: () => number) {
  return 5 + Math.floor(random() * 45)
}

type Machine = {
  circuit: Parameters<typeof validateTensorEvaluation>[1]
  source: Float32Array
}

// Machines on host-timed springs run several evaluations per step: one per event
// timestamp, settle checks between frames, and the frame. The observer compares
// the reference and tensor evaluators on the exact table of every evaluation.
function verifyEvaluations(machine: Machine & {
  observe(observer: {beforeEvaluate?: (table: Float32Array) => void}): void
}) {
  const counts = {evaluations: 0, comparisons: 0}
  machine.observe({
    beforeEvaluate(table) {
      const tensorValues = machine.circuit.evaluateTensor(table)
      validateTensorEvaluation(table, machine.circuit, tensorValues)
      counts.evaluations++
      counts.comparisons += machine.circuit.tensorProgram!.wireOrder.length
    },
  })
  return counts
}

describe('production circuits match the reference interpreter across scripted traces', () => {
  test('window manager: drags, controls, photos, Notes texts, Monitor\'s list, and viewport resizes', () => {
    const machine = createWindowManagerMachine()
    // Monitor's list at its capacity, which a host writes before the first step, so
    // that the trace reaches scroll positions up to 2,400,000 px.
    for (const rowCount of valueListSourceField.rowCounts) machine.source[rowCount] = valueListRowCapacity
    const checked = verifyEvaluations(machine)
    const random = createRandom(0x0c1a5e)
    let frameClock = 0
    let steps = 0
    let width = 1280
    let height = 800
    // The scroll position of Monitor's list, as a host reads it at the top of a frame.
    // While undefined, the list stays where the machine's last step left it.
    let valueListScrollTop: number | undefined

    // Drive one frame. The observer checks every evaluation the step runs.
    function advance(elapsed: number) {
      frameClock += elapsed
      steps++
      return machine.step(width, height, frameClock, valueListScrollTop)
    }

    function projectWindow(values: Float32Array, windowIndex: number) {
      const start = windowIndex * windowOutputField.size
      const output = machine.output.windows
      return {
        left: values[output[start + windowOutputField.translateX]!]!,
        top: values[output[start + windowOutputField.translateY]!]!,
        width: values[output[start + windowOutputField.width]!]!,
        height: values[output[start + windowOutputField.height]!]!,
        contentWidth: values[output[start + windowOutputField.contentWidth]!]!,
        contentHeight: values[output[start + windowOutputField.contentHeight]!]!,
      }
    }

    function projectDock(values: Float32Array, windowIndex: number) {
      const start = windowIndex * dockOutputField.size
      const output = machine.output.dockItems
      return {
        left: values[output[start + dockOutputField.left]!]!,
        top: values[output[start + dockOutputField.top]!]!,
        width: values[output[start + dockOutputField.width]!]!,
        height: values[output[start + dockOutputField.height]!]!,
      }
    }

    function controlPoint(values: Float32Array, windowIndex: number, control: 'minimize' | 'maximize' | 'close') {
      const window = projectWindow(values, windowIndex)
      const size = machine.source[windowSourceFieldTable.buttonSize]!
      const gap = machine.source[windowSourceFieldTable.buttonGap]!
      const closeX = window.left + window.width - gap - size / 2
      const maximizeX = closeX - gap - size
      const minimizeX = maximizeX - gap - size
      const x = control === 'close' ? closeX : control === 'maximize' ? maximizeX : minimizeX
      return {x, y: window.top + machine.source[windowSourceFieldTable.titleHeight]! / 2}
    }

    let values = advance(16)

    // Phase 1: pointer-down/move/up drags across every window, with irregular
    // frame times and multi-step moves (including off-screen overshoot).
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const window = projectWindow(values, windowIndex)
      const downX = window.left + 40
      const downY = window.top + machine.source[windowSourceFieldTable.titleHeight]! / 2
      machine.pointerDown(downX, downY)
      values = advance(irregularFrameTime(random))
      const moveCount = 3 + Math.floor(random() * 4)
      let cursorX = downX
      let cursorY = downY
      for (let move = 0; move < moveCount; move++) {
        cursorX = downX + (random() - 0.5) * width
        cursorY = downY + (random() - 0.5) * height
        machine.pointerMove(cursorX, cursorY)
        values = advance(irregularFrameTime(random))
      }
      machine.pointerUp(cursorX, cursorY)
      values = advance(irregularFrameTime(random))
    }

    // Phase 2: resize-grip drags, including shrinking below the minimum.
    for (const windowIndex of [0, 2]) {
      const window = projectWindow(values, windowIndex)
      const grip = machine.source[windowSourceFieldTable.resizeGrip]!
      const downX = window.left + window.width - grip / 2
      const downY = window.top + window.height - grip / 2
      machine.pointerDown(downX, downY)
      values = advance(irregularFrameTime(random))
      machine.pointerMove(downX + 160, downY + 120)
      values = advance(irregularFrameTime(random))
      machine.pointerMove(downX - 4000, downY - 4000)
      values = advance(irregularFrameTime(random))
      machine.pointerUp(downX - 4000, downY - 4000)
      values = advance(irregularFrameTime(random))
    }

    // Phase 3: window controls, including the boundary-offset edges that the
    // product test exercises (just inside the visible control rectangle).
    for (const windowIndex of [2, 1, 0]) {
      for (const control of ['maximize', 'minimize', 'close'] as const) {
        const point = controlPoint(values, windowIndex, control)
        const edge = control === 'maximize' ? 0.5 : control === 'minimize' ? -0.4 : 0.3
        machine.pointerDown(point.x + edge, point.y)
        machine.pointerUp(point.x + edge, point.y)
        values = advance(irregularFrameTime(random))
        // Let the spring run a few irregular frames so spring wires move.
        for (let settle = 0; settle < 4; settle++) values = advance(irregularFrameTime(random))
      }
    }

    // Phase 4: dock clicks to restore minimized/closed windows.
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const dock = projectDock(values, windowIndex)
      const x = dock.left + dock.width / 2
      const y = dock.top + dock.height / 2
      machine.pointerDown(x, y)
      machine.pointerUp(x, y)
      values = advance(irregularFrameTime(random))
      for (let settle = 0; settle < 3; settle++) values = advance(irregularFrameTime(random))
    }

    // Phase 5: drive the inlined Photos surface. Focus the Photos window first,
    // then exercise photo selection, next/previous wraparound, and close.
    const photosWindowIndex = windowCount - 1
    {
      const window = projectWindow(values, photosWindowIndex)
      const x = window.left + 60
      const y = window.top + machine.source[windowSourceFieldTable.titleHeight]! / 2
      machine.pointerDown(x, y)
      machine.pointerUp(x, y)
      values = advance(irregularFrameTime(random))
    }
    function photoLocal(values: Float32Array, item: number) {
      const start = item * photoField.size
      const photos = machine.output.photos.photos
      return {
        left: values[photos[start + photoField.left]!]!,
        top: values[photos[start + photoField.top]!]!,
        width: values[photos[start + photoField.width]!]!,
        height: values[photos[start + photoField.height]!]!,
      }
    }
    // Select a grid photo with a press and a release on it. Pointer coordinates are
    // viewport coordinates, and Photos reads a release relative to its content box at
    // the window's destination, which for a window that isn't maximized is its stored
    // left and top.
    {
      const photo = photoLocal(values, 5)
      expect(machine.source[windowSourceField(photosWindowIndex, windowStateField.maximized)]).toBe(0)
      const contentLeft = machine.source[windowSourceField(photosWindowIndex, windowStateField.left)]! + 1
      const contentTop = machine.source[windowSourceField(photosWindowIndex, windowStateField.top)]!
        + machine.source[windowSourceFieldTable.titleHeight]! + 1
      const photoX = contentLeft + photo.left + photo.width / 2
      const photoY = contentTop + photo.top + photo.height / 2
      machine.pointerDown(photoX, photoY)
      machine.pointerUp(photoX, photoY)
      values = advance(irregularFrameTime(random))
      for (let settle = 0; settle < 3; settle++) values = advance(irregularFrameTime(random))
    }
    // Next/previous navigation, including wraparound past the ends.
    for (let nav = 0; nav < photoItemCount + 2; nav++) {
      machine.photoNext()
      values = advance(irregularFrameTime(random))
    }
    for (let nav = 0; nav < 3; nav++) {
      machine.photoPrevious()
      values = advance(irregularFrameTime(random))
    }
    // Close the lightbox.
    machine.photoClose()
    values = advance(irregularFrameTime(random))
    for (let settle = 0; settle < 3; settle++) values = advance(irregularFrameTime(random))

    // Phase 6: Notes texts, written the way typed text is: an empty text, one word,
    // narrow segments that fill the line walker's window, a segment wider than any
    // slot, more segments than Notes has cells, and random widths. Each text is laid
    // out around the windows where the phases above left them, then again after a
    // press on Notes' title bar raises Notes above them.
    const randomParagraph = (segments: number, widestWord: number) => ({
      widths: Array.from({length: segments}, (_, segment) => segment % 2 === 1 ? 4.375 : Math.round(random() * widestWord * 64) / 64),
      breakAfter: Array.from({length: segments}, (_, segment) => segment % 2),
    })
    const paragraphs = [
      {widths: [], breakAfter: []},
      {widths: [31.5], breakAfter: [0]},
      randomParagraph(119, 8),
      {widths: [20, 4.375, 500, 4.375, 20], breakAfter: [0, 1, 0, 1, 0]},
      randomParagraph(300, 60),
      randomParagraph(77, 90),
      randomParagraph(128, 200),
    ]
    let mostNotesLines = 0
    let mostWindowOverflow = 0
    let notesTruncations = 0
    for (const raiseNotes of [false, true]) {
      if (raiseNotes) {
        const window = projectWindow(values, 1)
        const x = window.left + 40
        const y = window.top + machine.source[windowSourceFieldTable.titleHeight]! / 2
        machine.pointerDown(x, y)
        machine.pointerUp(x, y)
        values = advance(irregularFrameTime(random))
      }
      for (const paragraph of paragraphs) {
        machine.notesText(paragraph)
        values = advance(irregularFrameTime(random))
        mostNotesLines = Math.max(mostNotesLines, values[machine.output.notes.lineCount]!)
        mostWindowOverflow = Math.max(mostWindowOverflow, values[machine.output.notes.windowOverflow]!)
        notesTruncations += values[machine.output.notes.truncated]!
      }
    }
    // The texts reached the flow's limits: each of the 13 bands that Notes' content box fits held a line, a line
    // wrapped at the walker's window, and the widest text left segments without a band, before and after the press.
    expect(mostNotesLines).toBe(13)
    expect(mostWindowOverflow).toBeGreaterThanOrEqual(1)
    expect(notesTruncations).toBeGreaterThanOrEqual(2)

    // Phase 7: Monitor's list. Monitor's dock item raises and focuses Monitor, which
    // earlier phases left at its minimum size. Then, at scroll positions on the
    // quarter pixel grid from the top of the list to its end, a press and a release
    // on the list and each of the six keys, at Monitor's normal size and maximized,
    // each time in another of the sidebar's three locations. A key's scroll request
    // moves the list for the frames until the next position is set.
    {
      const dock = projectDock(values, 0)
      machine.pointerDown(dock.left + dock.width / 2, dock.top + dock.height / 2)
      machine.pointerUp(dock.left + dock.width / 2, dock.top + dock.height / 2)
      values = advance(irregularFrameTime(random))
      const valueListKeys = ['down', 'pageDown', 'end', 'up', 'pageUp', 'home'] as const
      const scrollPositions = [0, 1000.25, 123_456.5, 2_399_000, 2_399_999.75, valueListRowCapacity * 24]
      for (const maximized of [false, true]) {
        if (maximized) {
          const point = controlPoint(values, 0, 'maximize')
          machine.pointerDown(point.x, point.y)
          machine.pointerUp(point.x, point.y)
          for (let settle = 0; settle < 4; settle++) values = advance(irregularFrameTime(random))
        }
        expect(machine.source[windowSourceField(0, windowStateField.maximized)]).toBe(maximized ? 1 : 0)
        // The content box starts 1 px inside the frame and below the title bar. The
        // list viewport starts right of the 152 px sidebar and below the 28 px header
        // row, and ends above the 32 px footer and left of the 16 px scrollbar strip.
        // The sidebar's locations are 136×24, 8 px in and from 28 px down. A maximized
        // window's rectangle isn't stored: it is at 12,48.
        const window = projectWindow(values, 0)
        const contentLeft = maximized ? 13 : machine.source[windowSourceField(0, windowStateField.left)]! + 1
        const contentTop = (maximized ? 48 : machine.source[windowSourceField(0, windowStateField.top)]!)
          + machine.source[windowSourceFieldTable.titleHeight]! + 1
        const listLeft = contentLeft + 152
        const listTop = contentTop + 28
        const listHeight = window.contentHeight - 28 - 32
        for (const [index, scrollTop] of scrollPositions.entries()) {
          const location = {x: contentLeft + 8 + 68, y: contentTop + 28 + 24 * (index % 3) + 12}
          machine.pointerDown(location.x, location.y)
          machine.pointerUp(location.x, location.y)
          values = advance(irregularFrameTime(random))
          expect(machine.source[valueListSourceField.location[index % 3]!]).toBe(1)
          valueListScrollTop = scrollTop
          // The list of a window at its minimum size is 110 px wide and 84 px tall.
          const x = listLeft + 10 + random() * 90
          const y = listTop + 0.5 + random() * (listHeight - 30)
          machine.pointerDown(x, y)
          values = advance(irregularFrameTime(random))
          machine.pointerUp(x, y)
          values = advance(irregularFrameTime(random))
          valueListScrollTop = undefined
          for (const key of valueListKeys) {
            machine.valueListKey(key)
            values = advance(irregularFrameTime(random))
          }
        }
      }
      // Home was the last key, so row 0 is selected and the list is at the top.
      expect(machine.source[valueListSourceField.selected]).toBe(0)
      expect(values[machine.output.valueList.scroll]).toBe(0)
      // Restore Monitor.
      const point = controlPoint(values, 0, 'maximize')
      machine.pointerDown(point.x, point.y)
      machine.pointerUp(point.x, point.y)
      for (let settle = 0; settle < 4; settle++) values = advance(irregularFrameTime(random))
    }

    // Phase 8: viewport resizes, including tiny and zero sizes, with idle frames.
    for (const [resizeWidth, resizeHeight] of [
      [960, 600],
      [320, 240],
      [40, 40],
      [1, 1],
      [0, 0],
      [1600, 900],
    ] as const) {
      width = resizeWidth
      height = resizeHeight
      values = advance(irregularFrameTime(random))
      values = advance(irregularFrameTime(random))
    }

    expect(steps).toBeGreaterThanOrEqual(100)
    expect(machine.source[photoSourceField.clickActive]).toBe(0)
    expect(checked.evaluations).toBeGreaterThan(steps)
    // Surface the totals for the run report.
    console.log(`window manager: ${steps} steps, ${checked.evaluations} evaluations, ${checked.comparisons} wire comparisons`)
  }, 30_000)

  test('photo gallery: selection, wraparound navigation, lightbox close, tiny viewports', () => {
    const machine = createPhotoGalleryMachine()
    const checked = verifyEvaluations(machine)
    const random = createRandom(0x70a9ce)
    let steps = 0
    let width = 1280
    let height = 720
    let present = 1
    let interactive = 1

    // Drive one frame. The observer checks every evaluation the step runs.
    function advance() {
      steps++
      return machine.step(width, height, present, interactive)
    }

    function projectPhoto(values: Float32Array, item: number) {
      const start = item * photoField.size
      const photos = machine.output.photos
      return {
        left: values[photos[start + photoField.left]!]!,
        top: values[photos[start + photoField.top]!]!,
        width: values[photos[start + photoField.width]!]!,
        height: values[photos[start + photoField.height]!]!,
      }
    }
    function projectThumbnail(values: Float32Array, item: number) {
      const start = item * thumbnailField.size
      const thumbnails = machine.output.thumbnails
      return {
        left: values[thumbnails[start + thumbnailField.left]!]!,
        top: values[thumbnails[start + thumbnailField.top]!]!,
        width: values[thumbnails[start + thumbnailField.width]!]!,
        height: values[thumbnails[start + thumbnailField.height]!]!,
      }
    }
    function controlCenter(values: Float32Array, control: readonly number[]) {
      return {
        x: values[control[controlField.left]!]! + values[control[controlField.width]!]! / 2,
        y: values[control[controlField.top]!]! + values[control[controlField.height]!]! / 2,
      }
    }

    let values = advance()

    // Select each grid photo in turn, closing between selections, so both the
    // grid layout and the open lightbox layout are exercised many times.
    for (let item = 0; item < photoItemCount; item++) {
      const photo = projectPhoto(values, item)
      // Use an irregular interior offset rather than dead-center every time.
      const offsetX = 0.5 + random() * (photo.width - 1)
      const offsetY = 0.5 + random() * (photo.height - 1)
      machine.click(photo.left + offsetX, photo.top + offsetY)
      values = advance()
      // Let the thumbnail strip spring settle over a few frames.
      for (let settle = 0; settle < 3; settle++) values = advance()
      // Close back to the grid (backdrop click at the corner).
      machine.click(2, 2)
      values = advance()
    }

    // Open one photo, then walk next/previous well past both ends to cover the
    // wraparound transitions, with intermittent thumbnail clicks.
    {
      const photo = projectPhoto(values, 0)
      machine.click(photo.left + 10, photo.top + 10)
      values = advance()
    }
    for (let nav = 0; nav < photoItemCount + 3; nav++) {
      machine.next()
      values = advance()
    }
    for (let nav = 0; nav < photoItemCount + 3; nav++) {
      machine.previous()
      values = advance()
    }
    // Drive the projected control rectangles directly.
    for (let nav = 0; nav < 4; nav++) {
      const next = controlCenter(values, machine.output.nextControl)
      machine.click(next.x, next.y)
      values = advance()
      const previous = controlCenter(values, machine.output.previousControl)
      machine.click(previous.x, previous.y)
      values = advance()
    }
    // Thumbnail click jumps focus to a visible neighbor.
    {
      const thumbnail = projectThumbnail(values, 2)
      if (thumbnail.width > 0) {
        machine.click(thumbnail.left + thumbnail.width / 2, thumbnail.top + thumbnail.height / 2)
        values = advance()
      }
    }
    // Close the lightbox.
    machine.close()
    values = advance()

    // Presence/interactivity toggles and tiny/zero viewports.
    for (const [resizeWidth, resizeHeight, nextPresent, nextInteractive] of [
      [558, 384, 1, 1],
      [278, 384, 1, 0],
      [40, 40, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 1, 1],
      [1281, 721, 1, 1],
    ] as const) {
      width = resizeWidth
      height = resizeHeight
      present = nextPresent
      interactive = nextInteractive
      values = advance()
      values = advance()
    }

    expect(steps).toBeGreaterThanOrEqual(100)
    expect(checked.evaluations).toBeGreaterThan(steps)
    console.log(`photo gallery: ${steps} steps, ${checked.evaluations} evaluations, ${checked.comparisons} wire comparisons`)
  })
})
