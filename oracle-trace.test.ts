import {describe, expect, test} from 'bun:test'
import {validateTensorEvaluation} from './numeric-ui-core.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  photoSourceField,
  sourceField as windowSourceFieldTable,
  windowCount,
  windowOutputField,
} from './window-manager.ts'
import {
  controlField,
  createPhotoGalleryMachine,
  itemCount as photoItemCount,
  photoField,
  sourceField as photoSourceTable,
  thumbnailField,
} from './photo-gallery.ts'
import {
  createCandidateGalleryMachine,
  geometryField,
  photoCount as candidatePhotoCount,
  sourceField as candidateSourceTable,
} from './candidate-gallery.ts'

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

// Snapshot the source exactly as the machine sees it at the top of step(),
// before its writeback: copy the live table, then overwrite the fields that
// step() assigns from its arguments prior to evaluating the circuit. Comparing
// the reference and tensor evaluators on this snapshot is bit-for-bit identical
// to what the machine itself evaluates that frame.
function verifyStep(machine: Machine, prefields: readonly (readonly [number, number])[]) {
  const snapshot = new Float32Array(machine.source)
  for (const [field, value] of prefields) snapshot[field] = value
  const tensorValues = machine.circuit.evaluateTensor(snapshot)
  validateTensorEvaluation(snapshot, machine.circuit, tensorValues)
  return machine.circuit.tensorProgram!.wireOrder.length
}

describe('production circuits match the reference interpreter across scripted traces', () => {
  test('window manager: drags, controls, photos, and viewport resizes', () => {
    const machine = createWindowManagerMachine()
    const random = createRandom(0x0c1a5e)
    let frameClock = 0
    let comparisons = 0
    let steps = 0
    let width = 1280
    let height = 800

    // Drive one frame: snapshot/verify against the exact pre-writeback source,
    // then let the machine advance and write nextSource back into its table.
    function advance(elapsed: number) {
      frameClock += elapsed
      comparisons += verifyStep(machine, [
        [windowSourceFieldTable.viewportWidth, width],
        [windowSourceFieldTable.viewportHeight, height],
        [windowSourceFieldTable.frameTime, frameClock],
      ])
      steps++
      return machine.step(width, height, frameClock)
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
    for (const windowIndex of [3, 1, 2, 0]) {
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
    // Select a grid photo (local coordinates feed the inlined photo click latch).
    {
      const photo = photoLocal(values, 5)
      machine.photoClick(photo.left + photo.width / 2, photo.top + photo.height / 2)
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

    // Phase 6: viewport resizes, including tiny and zero sizes, with idle frames.
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
    expect(comparisons).toBeGreaterThan(0)
    // Surface the totals for the run report.
    console.log(`window manager: ${steps} steps, ${comparisons} wire comparisons`)
  })

  test('photo gallery: selection, wraparound navigation, lightbox close, tiny viewports', () => {
    const machine = createPhotoGalleryMachine()
    const random = createRandom(0x70a9ce)
    let comparisons = 0
    let steps = 0
    let width = 1280
    let height = 720
    let present = 1
    let interactive = 1

    function advance() {
      comparisons += verifyStep(machine, [
        [photoSourceTable.viewportWidth, width],
        [photoSourceTable.viewportHeight, height],
        [photoSourceTable.present, present],
        [photoSourceTable.interactive, interactive],
      ])
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
    expect(comparisons).toBeGreaterThan(0)
    console.log(`photo gallery: ${steps} steps, ${comparisons} wire comparisons`)
  })

  test('candidate gallery: layout tournament, focus clicks, tiny viewports', () => {
    const machine = createCandidateGalleryMachine()
    const random = createRandom(0x1ca4e5)
    let comparisons = 0
    let steps = 0
    let width = 1400
    let height = 680

    function advance() {
      comparisons += verifyStep(machine, [
        [candidateSourceTable.viewportWidth, width],
        [candidateSourceTable.viewportHeight, height],
      ])
      steps++
      return machine.step(width, height)
    }

    function thumbnail(values: Float32Array, item: number) {
      const start = item * geometryField.size
      const thumbnails = machine.output.thumbnails
      return {
        left: values[thumbnails[start + geometryField.left]!]!,
        top: values[thumbnails[start + geometryField.top]!]!,
        width: values[thumbnails[start + geometryField.width]!]!,
        height: values[thumbnails[start + geometryField.height]!]!,
      }
    }

    // Cycle through wide/balanced/tall viewports so every layout wins, clicking
    // a different thumbnail in each so focus routes through the shared state.
    const viewportCycle = [
      [1400, 680],
      [984, 730],
      [760, 517],
      [610, 830],
      [600, 517],
    ] as const
    let values = advance()
    for (let round = 0; round < 22; round++) {
      const [cycleWidth, cycleHeight] = viewportCycle[round % viewportCycle.length]!
      width = cycleWidth
      height = cycleHeight
      values = advance()
      const item = round % candidatePhotoCount
      const target = thumbnail(values, item)
      if (target.width > 0 && target.height > 0) {
        const offsetX = 0.5 + random() * Math.max(0, target.width - 1)
        const offsetY = 0.5 + random() * Math.max(0, target.height - 1)
        machine.click(target.left + offsetX, target.top + offsetY)
      } else {
        // Click into empty space; focus must stay exactly where it is.
        machine.click(-50, -50)
      }
      values = advance()
    }

    // Tiny and zero viewports, plus a click that lands nowhere.
    for (const [resizeWidth, resizeHeight] of [
      [0, 0],
      [1, 1],
      [20, 300],
      [300, 20],
      [2000, 400],
    ] as const) {
      width = resizeWidth
      height = resizeHeight
      machine.click(random() * resizeWidth, random() * resizeHeight)
      values = advance()
      values = advance()
    }

    expect(steps).toBeGreaterThanOrEqual(50)
    expect(comparisons).toBeGreaterThan(0)
    console.log(`candidate gallery: ${steps} steps, ${comparisons} wire comparisons`)
  })
})
