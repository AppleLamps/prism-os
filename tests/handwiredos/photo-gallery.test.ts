import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'bun:test'
import {Circuit, emitRelu} from '../../src/runtime/numeric-ui-core.ts'
import {
  columnCount,
  controlField,
  createPhotoGalleryMachine,
  createPhotoGalleryRenderer,
  focusField,
  gridFadeRate,
  itemCount,
  maximumOpenPhotoTallness,
  maximumOpenPhotoWideness,
  maximumPhotoTallness,
  maximumPhotoWideness,
  photoField,
  photoStack,
  rowCount,
  smallestDrawnSize,
  sourceField,
  thumbnailField,
} from '../../src/handwiredos/photo-gallery.ts'

const viewportWidth = 1280
const viewportHeight = 720
const gap = 18

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

function projectPhotos(machine: ReturnType<typeof createPhotoGalleryMachine>, values: Float32Array) {
  return Array.from({length: itemCount}, (_, item) => {
    const outputStart = item * photoField.size
    return {
      left: values[machine.output.photos[outputStart + photoField.left]!]!,
      top: values[machine.output.photos[outputStart + photoField.top]!]!,
      width: values[machine.output.photos[outputStart + photoField.width]!]!,
      height: values[machine.output.photos[outputStart + photoField.height]!]!,
      opacity: values[machine.output.photos[outputStart + photoField.opacity]!]!,
      zoom: values[machine.output.photos[outputStart + photoField.zoom]!]!,
      stack: values[machine.output.photos[outputStart + photoField.stack]!]!,
    }
  })
}

function projectThumbnails(machine: ReturnType<typeof createPhotoGalleryMachine>, values: Float32Array) {
  return Array.from({length: itemCount}, (_, item) => {
    const outputStart = item * thumbnailField.size
    return {
      left: values[machine.output.thumbnails[outputStart + thumbnailField.left]!]!,
      top: values[machine.output.thumbnails[outputStart + thumbnailField.top]!]!,
      width: values[machine.output.thumbnails[outputStart + thumbnailField.width]!]!,
      height: values[machine.output.thumbnails[outputStart + thumbnailField.height]!]!,
      opacity: values[machine.output.thumbnails[outputStart + thumbnailField.opacity]!]!,
      focused: values[machine.output.thumbnails[outputStart + thumbnailField.focused]!]!,
    }
  })
}

function readFocus(machine: ReturnType<typeof createPhotoGalleryMachine>) {
  return Array.from({length: itemCount}, (_, item) => machine.source[focusField(item)]!)
}

function assertOneFocus(machine: ReturnType<typeof createPhotoGalleryMachine>, item: number) {
  assert.deepEqual(
    readFocus(machine),
    Array.from({length: itemCount}, (_, index) => Number(index === item)),
  )
}

// Runs frames 16 ms apart until the zoom's springs and the thumbnails' are at rest.
function settle(machine: ReturnType<typeof createPhotoGalleryMachine>, width = viewportWidth, height = viewportHeight) {
  for (let frames = 1; frames <= 120; frames++) {
    const values = machine.step(width, height)
    if (values[machine.output.animationActive] === 0) return {values, frames}
  }
  assert.fail('the zoom and the thumbnails did not settle')
}

test('the fixed grid opens every photo with a tapered thumbnail carousel', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const grid = projectPhotos(machine, values)
  const gridWidth = (viewportWidth - (columnCount + 1) * gap) / columnCount
  const gridHeight = (viewportHeight - (rowCount + 1) * gap) / rowCount

  assert.ok(machine.source instanceof Float32Array)
  assert.ok(values instanceof Float32Array)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
  assert.deepEqual(grid[0], {
    left: 18,
    top: 18,
    width: gridWidth,
    height: gridHeight,
    opacity: 1,
    zoom: 0,
    stack: 0,
  })
  assert.deepEqual(grid[itemCount - 1], {
    left: 3 * gridWidth + 4 * gap,
    top: 2 * gridHeight + 3 * gap,
    width: gridWidth,
    height: gridHeight,
    opacity: 1,
    zoom: 0,
    stack: 0,
  })

  const target = grid[6]!
  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 6)
  // The photo zooms from its cell, see the zoom's tests below. Once it is at rest:
  values = settle(machine).values

  const photos = projectPhotos(machine, values)
  assert.deepEqual(photos[6], {
    left: 92,
    top: 18,
    width: 1096,
    height: 584,
    opacity: 1,
    zoom: 1,
    stack: 3,
  })
  // The other photos keep their cells, at opacity 0, so the page takes their nodes
  // out of the DOM.
  assert.deepEqual(photos[0], {...grid[0], opacity: 0})
  const thumbnails = projectThumbnails(machine, values)
  const focusedThumbnail = thumbnails[6]!
  assert.deepEqual({
    left: focusedThumbnail.left,
    top: focusedThumbnail.top,
    width: focusedThumbnail.width,
    height: focusedThumbnail.height,
    opacity: focusedThumbnail.opacity,
    focused: focusedThumbnail.focused,
  }, {
    left: 599,
    top: 620,
    width: 82,
    height: 82,
    opacity: 1,
    focused: 1,
  })
  assert.ok(thumbnails[5]!.width < focusedThumbnail.width)
  assert.ok(thumbnails[4]!.width < thumbnails[5]!.width)
  assert.ok(thumbnails[2]!.width > 0)
  assert.equal(thumbnails[1]!.width, 0)
  assert.equal(thumbnails.filter(thumbnail => thumbnail.width > 0).length, 9)
  assert.equal(thumbnails.length, itemCount)
  assert.equal(photos[6].top + photos[6].height + gap, focusedThumbnail.top)
  const visibleThumbnails = thumbnails
    .filter(thumbnail => thumbnail.width > 0)
    .sort((left, right) => left.left - right.left)
  const centerGaps = visibleThumbnails.slice(1).map((thumbnail, index) => {
    const previous = visibleThumbnails[index]!
    return thumbnail.left + thumbnail.width / 2
      - (previous.left + previous.width / 2)
  })
  assert.ok(centerGaps[3]! > centerGaps[2]!)
  assert.ok(centerGaps[2]! > centerGaps[1]!)
  assert.ok(centerGaps[1]! > centerGaps[0]!)
  const stripWidth =
    visibleThumbnails.at(-1)!.left + visibleThumbnails.at(-1)!.width
    - visibleThumbnails[0]!.left
  assert.ok(stripWidth > 473 && stripWidth < 474)
  assert.equal(values[machine.output.backdropOpacity], 1)
})

// FP32 keeps a limited photo's size within a few millionths of a pixel.
function assertNear(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`)
}

test('in a tall box a photo is at most 1.25 times as tall as wide, in a wide box at most twice as wide as tall, and the grid is centered', () => {
  // The content box of a maximized Photos on a phone 390 × 844 px. A photo's slot is
  // 68.5 × 196.7 px there, and the photo is 68.5 × 85.625 px.
  const tall = createPhotoGalleryMachine()
  let values = tall.step(364, 662)
  let grid = projectPhotos(tall, values)
  const tallPhotoHeight = maximumPhotoTallness * 68.5
  // The grid's 3 rows and 4 gaps are 328.875 px tall, with 166.5625 px free above and below.
  const freeAbove = (662 - (rowCount * tallPhotoHeight + (rowCount + 1) * gap)) / 2
  grid.forEach((photo, item) => {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    assert.equal(photo.width, 68.5)
    assertNear(photo.height, tallPhotoHeight, `photo ${item}'s height`)
    assert.equal(photo.left, gap + column * (68.5 + gap))
    assertNear(photo.top, freeAbove + gap + row * (tallPhotoHeight + gap), `photo ${item}'s top`)
    assert.equal(photo.opacity, 1)
  })
  assertNear(freeAbove, 166.5625, 'the free part above the grid')
  // A click in the free part above the grid opens no photo, also where the first
  // photo's slot is, and a click on a photo opens that photo.
  for (const [x, y] of [[182, 100], [gap + 34, gap + 10], [182, 662 - 100]] as const) {
    tall.click(x, y)
    values = tall.step(364, 662)
    assert.deepEqual(readFocus(tall), Array(itemCount).fill(0), `a click at ${x}, ${y}`)
  }
  const target = grid[5]!
  tall.click(target.left + target.width / 2, target.top + target.height / 2)
  values = tall.step(364, 662)
  assertOneFocus(tall, 5)

  // The content box of a maximized Photos on the same phone held sideways. A slot is
  // 182 × 45.3 px, and the photo is 90.7 × 45.3 px, with 182.7 px free at the left
  // and at the right of the grid.
  const wide = createPhotoGalleryMachine()
  values = wide.step(818, 208)
  grid = projectPhotos(wide, values)
  const widePhotoHeight = (208 - (rowCount + 1) * gap) / rowCount
  const widePhotoWidth = maximumPhotoWideness * widePhotoHeight
  const freeLeft = (818 - (columnCount * widePhotoWidth + (columnCount + 1) * gap)) / 2
  grid.forEach((photo, item) => {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    assertNear(photo.width, widePhotoWidth, `photo ${item}'s width`)
    assertNear(photo.height, widePhotoHeight, `photo ${item}'s height`)
    assertNear(photo.left, freeLeft + gap + column * (widePhotoWidth + gap), `photo ${item}'s left`)
    assertNear(photo.top, gap + row * (widePhotoHeight + gap), `photo ${item}'s top`)
  })
  wide.click(100, 104)
  values = wide.step(818, 208)
  assert.deepEqual(readFocus(wide), Array(itemCount).fill(0))
  const wideTarget = grid[11]!
  wide.click(wideTarget.left + wideTarget.width / 2, wideTarget.top + wideTarget.height / 2)
  wide.step(818, 208)
  assertOneFocus(wide, 11)
})

test('at every box size the photos keep their proportions within the two limits, fill their slots in one direction at least, and lie centered inside the box', () => {
  const machine = createPhotoGalleryMachine()
  let limitedInHeight = 0
  let limitedInWidth = 0
  let unlimited = 0
  // From the content box of the smallest Photos window, 278 × 144 px, to a box larger
  // than a maximized window on a 2560 × 1440 px display, in steps that reach odd sizes.
  for (let width = 278; width <= 2600; width += 129) {
    for (let height = 144; height <= 1400; height += 97) {
      const values = machine.step(width, height)
      const grid = projectPhotos(machine, values)
      const slotWidth = (width - (columnCount + 1) * gap) / columnCount
      const slotHeight = (height - (rowCount + 1) * gap) / rowCount
      const first = grid[0]!
      const last = grid[itemCount - 1]!
      const label = `${width} × ${height}`
      assert.ok(first.height <= maximumPhotoTallness * first.width + 1e-3, `${label}: a photo is ${first.width} × ${first.height}`)
      assert.ok(first.width <= maximumPhotoWideness * first.height + 1e-3, `${label}: a photo is ${first.width} × ${first.height}`)
      assert.ok(first.width <= slotWidth + 1e-3 && first.height <= slotHeight + 1e-3, label)
      assert.ok(Math.abs(first.width - slotWidth) < 1e-3 || Math.abs(first.height - slotHeight) < 1e-3, `${label}: a photo fills its slot in neither direction`)
      if (first.height < slotHeight - 1e-3) limitedInHeight++
      else if (first.width < slotWidth - 1e-3) limitedInWidth++
      else unlimited++
      for (const photo of grid) {
        assert.equal(photo.width, first.width, label)
        assert.equal(photo.height, first.height, label)
      }
      // As much free at the left as at the right, and above as below, the gap at least.
      assertNear(first.left, width - (last.left + last.width), `${label}: left and right`)
      assertNear(first.top, height - (last.top + last.height), `${label}: above and below`)
      assert.ok(first.left >= gap - 1e-3 && first.top >= gap - 1e-3, label)
    }
  }
  // The sizes cover all three cases.
  assert.ok(limitedInHeight > 20 && limitedInWidth > 20 && unlimited > 20, `${limitedInHeight} limited in height, ${limitedInWidth} in width, ${unlimited} not limited`)
})

test('in a box within both limits, the grid has the same FP32 values as a grid built without the limits', () => {
  // The grid without the limits, built here from the same sums: a slot is what the
  // box leaves for one photo, and photo c of a row starts at (1 + c) gaps and c slots.
  const circuit = new Circuit(3)
  const [boxWidth, boxHeight, gapCell] = [circuit.source(0), circuit.source(1), circuit.source(2)]
  const slotWidth = emitRelu(circuit, circuit.affine([[boxWidth, 1 / columnCount], [gapCell, -(columnCount + 1) / columnCount]]))
  const slotHeight = emitRelu(circuit, circuit.affine([[boxHeight, 1 / rowCount], [gapCell, -(rowCount + 1) / rowCount]]))
  const lefts = Array.from({length: columnCount}, (_, column) => circuit.affine([[gapCell, 1 + column], [slotWidth, column]]))
  const tops = Array.from({length: rowCount}, (_, row) => circuit.affine([[gapCell, 1 + row], [slotHeight, row]]))
  const program = circuit.compileTensorProgram([slotWidth, slotHeight, ...lefts, ...tops])

  const machine = createPhotoGalleryMachine()
  let boxes = 0
  // Window sizes from the smallest Photos window to 1600 × 1000 px, as content boxes,
  // in steps that reach slots of every third and every quarter of a pixel, e.g.
  // 215.33 px tall in the box of a maximized Photos at 1440 × 900 px, 1414 × 718 px.
  for (let width = 278; width <= 1598; width += 11) {
    for (let height = 144; height <= 954; height += 7) {
      const unlimited = circuit.evaluateTensor(Float32Array.of(width, height, gap), program)
      if (unlimited[slotHeight]! > maximumPhotoTallness * unlimited[slotWidth]! || unlimited[slotWidth]! > maximumPhotoWideness * unlimited[slotHeight]!) continue
      boxes++
      const grid = projectPhotos(machine, machine.step(width, height))
      grid.forEach((photo, item) => {
        const label = `photo ${item} in ${width} × ${height}`
        assert.equal(photo.width, unlimited[slotWidth], label)
        assert.equal(photo.height, unlimited[slotHeight], label)
        assert.equal(photo.left, unlimited[lefts[item % columnCount]!], label)
        assert.equal(photo.top, unlimited[tops[Math.floor(item / columnCount)]!], label)
      })
    }
  }
  assert.ok(boxes > 5000 && boxes < 14_000, `${boxes} boxes within both limits`)
})

// Opens a photo of the grid, waits for the zoom to end, and returns the photo's
// rectangle as the open photo.
function openPhoto(machine: ReturnType<typeof createPhotoGalleryMachine>, width: number, height: number, item: number) {
  const target = projectPhotos(machine, machine.step(width, height))[item]!
  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  machine.step(width, height)
  assertOneFocus(machine, item)
  const {values} = settle(machine, width, height)
  return {values, photo: projectPhotos(machine, values)[item]!}
}

// The open photo's box: the content box without the insets at its sides, the gap
// above it, and the thumbnails with the gap above and below them.
function openPhotoBox(width: number, height: number) {
  const inset = Math.min(92, 0.08 * width)
  const thumbnail = Math.min(82, width / 6, 0.24 * height)
  return {left: inset, top: gap, width: Math.max(0, width - 2 * inset), height: Math.max(0, height - thumbnail - 3 * gap)}
}

test('the open photo has limits too: in a wide and short box it is 2.5 times as wide as tall, in a tall box twice as tall as wide, centered, and a click beside it closes it', () => {
  // The content box of a maximized Photos on a phone held sideways, 844 × 390 px.
  // The open photo's box is 687.12 × 104.08 px, and the photo 260.2 × 104.08 px,
  // with 213.46 px free at each side.
  const wide = createPhotoGalleryMachine()
  let {values, photo} = openPhoto(wide, 818, 208, 5)
  let box = openPhotoBox(818, 208)
  assertNear(box.width, 687.12, 'the box\'s width')
  assertNear(box.height, 104.08, 'the box\'s height')
  assertNear(photo.height, box.height, 'the open photo\'s height')
  assertNear(photo.width, maximumOpenPhotoWideness * box.height, 'the open photo\'s width')
  assertNear(photo.left, box.left + (box.width - photo.width) / 2, 'the open photo\'s left')
  assertNear(photo.left - box.left, 213.46, 'the free part left of the open photo')
  assert.equal(photo.top, gap)
  // The controls stay at the box's sides, at the middle of its height.
  assertNear(values[wide.output.previousControl[controlField.top]!]!, gap + box.height / 2 - 26, 'the controls\' top')
  assert.equal(values[wide.output.previousControl[controlField.left]!], 9)
  assert.equal(values[wide.output.nextControl[controlField.left]!], 818 - 9 - 52)
  // A click on the open photo keeps it open, and a click in the free part of the
  // box, 100 px left of the photo and right of the previous control, closes it.
  wide.click(photo.left + 10, photo.top + photo.height / 2)
  wide.step(818, 208)
  assertOneFocus(wide, 5)
  wide.click(photo.left - 100, photo.top + photo.height / 2)
  wide.step(818, 208)
  assert.deepEqual(readFocus(wide), Array(itemCount).fill(0))

  // The content box of a Photos window 280 px wide and 788 px tall, the narrowest
  // and tallest on a desk of 1440 × 900 px. The box is 233.52 × 641.67 px, and the
  // photo 233.52 × 467.04 px, with 87.31 px free above and below.
  const tall = createPhotoGalleryMachine()
  ;({values, photo} = openPhoto(tall, 278, 742, 5))
  box = openPhotoBox(278, 742)
  assertNear(photo.width, box.width, 'the open photo\'s width')
  assertNear(photo.height, maximumOpenPhotoTallness * box.width, 'the open photo\'s height')
  assertNear(photo.left, box.left, 'the open photo\'s left')
  assertNear(photo.top, box.top + (box.height - photo.height) / 2, 'the open photo\'s top')
  assertNear(photo.top - box.top, (742 - 278 / 6 - 54 - 467.04) / 2, 'the free part above the open photo')
  tall.click(photo.left + photo.width / 2, photo.top + 10)
  tall.step(278, 742)
  assertOneFocus(tall, 5)
  tall.click(photo.left + photo.width / 2, photo.top - 40)
  tall.step(278, 742)
  assert.deepEqual(readFocus(tall), Array(itemCount).fill(0))

  // The boxes that people see most are within both limits, and the open photo fills
  // them: HandwiredOS's Photos at its default size, a maximized Photos at
  // 1512 × 860 px, and a maximized Photos on a phone 390 × 844 px.
  for (const [width, height, photoWidth, photoHeight] of [[558, 384, 468.72, 248], [1486, 678, 1302, 542], [364, 662, 305.76, 662 - 364 / 6 - 54]] as const) {
    const filled = createPhotoGalleryMachine()
    ;({photo} = openPhoto(filled, width, height, 5))
    box = openPhotoBox(width, height)
    assertNear(photo.left, box.left, `the open photo's left in ${width} × ${height}`)
    assert.equal(photo.top, gap)
    assertNear(photo.width, photoWidth, `the open photo's width in ${width} × ${height}`)
    assertNear(photo.height, photoHeight, `the open photo's height in ${width} × ${height}`)
  }
})

test('at every box size the open photo keeps its proportions within its two limits, fills its box in one direction at least, and lies centered in the box', () => {
  let limitedInHeight = 0
  let limitedInWidth = 0
  let unlimited = 0
  // From the content box of the smallest Photos window, 278 × 144 px, to a box larger
  // than a maximized window on a 2560 × 1440 px display, in steps that reach odd sizes.
  for (let width = 278; width <= 2600; width += 129) {
    for (let height = 144; height <= 1400; height += 97) {
      const machine = createPhotoGalleryMachine()
      const {photo} = openPhoto(machine, width, height, 0)
      const box = openPhotoBox(width, height)
      const label = `${width} × ${height}: the open photo is ${photo.width} × ${photo.height}`
      assert.ok(photo.height <= maximumOpenPhotoTallness * photo.width + 1e-3, label)
      assert.ok(photo.width <= maximumOpenPhotoWideness * photo.height + 1e-3, label)
      assert.ok(photo.width <= box.width + 1e-3 && photo.height <= box.height + 1e-3, label)
      assert.ok(Math.abs(photo.width - box.width) < 1e-3 || Math.abs(photo.height - box.height) < 1e-3, `${label}, and fills its box in neither direction`)
      if (photo.height < box.height - 1e-3) limitedInHeight++
      else if (photo.width < box.width - 1e-3) limitedInWidth++
      else unlimited++
      // As much free at the left as at the right of the box, and above as below.
      assert.ok(Math.abs((photo.left - box.left) - (box.left + box.width - photo.left - photo.width)) < 1e-3, label)
      assert.ok(Math.abs((photo.top - box.top) - (box.top + box.height - photo.top - photo.height)) < 1e-3, label)
    }
  }
  // The sizes cover all three cases.
  assert.ok(limitedInHeight > 5 && limitedInWidth > 20 && unlimited > 20, `${limitedInHeight} limited in height, ${limitedInWidth} in width, ${unlimited} not limited`)
})

test('the gallery keeps focus decisions exact across representative items', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const grid = projectPhotos(machine, values)

  for (const item of [0, 6, itemCount - 1]) {
    machine.click(0, 0)
    machine.step(viewportWidth, viewportHeight)
    const target = grid[item]!
    machine.click(target.left + target.width / 2, target.top + target.height / 2)
    values = machine.step(viewportWidth, viewportHeight)
    assertOneFocus(machine, item)
  }
})

test('thumbnail clicks switch focus and backdrop clicks close', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const target = projectPhotos(machine, values)[4]!
  machine.click(target.left + 20, target.top + 20)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 4)

  // The thumbnails grow out of the strip's middle, and a click is tested against
  // where they are going, so the click below needs them at rest only to read where
  // that is.
  values = settle(machine).values
  const thumbnail = projectThumbnails(machine, values)[8]!
  machine.click(thumbnail.left + thumbnail.width / 2, thumbnail.top + thumbnail.height / 2)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 8)

  machine.click(4, 4)
  values = machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
  // The backdrop fades with the photo on its way back to its cell.
  assert.equal(values[machine.output.backdropOpacity], 1)
  assert.equal(settle(machine).values[machine.output.backdropOpacity], 0)
})

test('numeric and projected previous/next drive the same wrap-around transitions, while close clears focus', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const first = projectPhotos(machine, values)[0]!
  machine.click(first.left + 20, first.top + 20)
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 0)

  // numeric signals wrap around at the boundary
  machine.previous()
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, itemCount - 1)

  machine.next()
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 0)

  // projected control rects drive the same transitions
  const nextControl = machine.output.nextControl
  machine.click(
    values[nextControl[controlField.left]!]! + values[nextControl[controlField.width]!]! / 2,
    values[nextControl[controlField.top]!]! + values[nextControl[controlField.height]!]! / 2,
  )
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 1)

  const previousControl = machine.output.previousControl
  machine.click(
    values[previousControl[controlField.left]!]!
      + values[previousControl[controlField.width]!]! / 2,
    values[previousControl[controlField.top]!]!
      + values[previousControl[controlField.height]!]! / 2,
  )
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 0)

  machine.close()
  machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
})

test('visual presence and exact interactivity remain separate host facts', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight, 0)
  assert.equal(values[machine.output.backdropOpacity], 0)
  assert.equal(projectPhotos(machine, values).filter(photo => photo.opacity > 0).length, 0)
  assert.equal(
    projectThumbnails(machine, values).filter(thumbnail => thumbnail.width > 0).length,
    0,
  )

  values = machine.step(viewportWidth, viewportHeight, 0.35)
  const target = projectPhotos(machine, values)[3]!
  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  machine.step(viewportWidth, viewportHeight, 0.35, 0)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))

  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  machine.step(viewportWidth, viewportHeight, 0.35, 1)
  assertOneFocus(machine, 3)
  assert.throws(
    () => machine.step(viewportWidth, viewportHeight, 0.35, 0.5),
    /interactive must be exactly 0 or 1, got 0.5/,
  )
})

test('the machine checks the table against its rules before an evaluation, and the next-state values after it', () => {
  // Values written before the first step commit with the mount, so the table check before the mount evaluation sees them.
  const writtenBeforeFirstStep = (write: (machine: ReturnType<typeof createPhotoGalleryMachine>) => void) => () => {
    const machine = createPhotoGalleryMachine()
    write(machine)
    machine.step(viewportWidth, viewportHeight)
  }
  assert.throws(writtenBeforeFirstStep(machine => {
    machine.source[machine.cells.previous] = 1
    machine.source[machine.cells.next] = 1
  }), /events breaks its atMostOne rule with mass 2/)
  assert.throws(writtenBeforeFirstStep(machine => {
    machine.source[machine.cells.focus[0]!] = 1
    machine.source[machine.cells.focus[1]!] = 1
  }), /focus breaks its oneHot rule with mass 2/)
  // Written after the table check, just before the frame's own evaluation, e.g. by an observer with a bug. With two
  // photos focused, the thumbnails' scale destinations add up past their range. The frame's evaluation runs on a copy
  // of the table, so no later table check sees the focus bits, and the next-state check is what throws.
  const machine = createPhotoGalleryMachine()
  machine.observe({
    beforeEvaluate(table, evaluation) {
      if (evaluation.writesBack) return
      table[machine.cells.focus[0]!] = 1
      table[machine.cells.focus[1]!] = 1
    },
  })
  assert.throws(() => machine.step(viewportWidth, viewportHeight), /thumbnails\[0\]\.scaleDestination must be finite and within 0\.\.1, got 1\.77/)
})

test('clicking the main image preserves it and tiny viewports remain finite', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const target = projectPhotos(machine, values)[2]!
  machine.click(target.left + 20, target.top + 20)
  machine.step(viewportWidth, viewportHeight)
  values = settle(machine).values
  const main = projectPhotos(machine, values)[2]!
  machine.click(main.left + main.width / 2, main.top + main.height / 2)
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 2)

  values = machine.step(40, 40)
  for (const photo of projectPhotos(machine, values)) {
    assert.ok(Number.isFinite(photo.left))
    assert.ok(Number.isFinite(photo.top))
    assert.ok(photo.width >= 0)
    assert.ok(photo.height >= 0)
  }

  for (const hostedWidth of [278, 558]) {
    const hostedMachine = createPhotoGalleryMachine()
    values = hostedMachine.step(hostedWidth, 384)
    const hostedTarget = projectPhotos(hostedMachine, values)[0]!
    hostedMachine.click(
      hostedTarget.left + hostedTarget.width / 2,
      hostedTarget.top + hostedTarget.height / 2,
    )
    hostedMachine.step(hostedWidth, 384)
    values = settle(hostedMachine, hostedWidth, 384).values
    const hostedThumbnails = projectThumbnails(hostedMachine, values)
    for (const thumbnail of hostedThumbnails) {
      assert.ok(thumbnail.left >= 0 && thumbnail.left <= hostedWidth)
      assert.ok(thumbnail.top >= 0)
      assert.ok(thumbnail.width >= 0)
      assert.ok(thumbnail.height >= 0)
    }
    const visible = hostedThumbnails.filter(thumbnail => thumbnail.width > 0)
    const stripLeft = Math.min(...visible.map(thumbnail => thumbnail.left))
    const stripRight = Math.max(...visible.map(thumbnail => thumbnail.left + thumbnail.width))
    assert.ok(
      stripRight - stripLeft <= Math.min(473.3, hostedWidth - 36) + 1e-3,
    )
  }
})

test('edge and overlapping clicks commit exactly one complete focused item', () => {
  const width = 558
  const height = 384
  const machine = createPhotoGalleryMachine()
  let values = machine.step(width, height)
  const first = projectPhotos(machine, values)[0]!

  // a sub-pixel edge click commits exactly one complete item, with finite geometry
  machine.click(first.left + 0.5, first.top + first.height / 2)
  values = machine.step(width, height)
  assert.deepEqual(readFocus(machine), [1, ...Array<number>(itemCount - 1).fill(0)])
  for (const photo of projectPhotos(machine, values)) {
    assert.ok(Number.isFinite(photo.left))
    assert.ok(Number.isFinite(photo.top))
    assert.ok(Number.isFinite(photo.width))
    assert.ok(Number.isFinite(photo.height))
  }

  // clicking the main image preserves the current focus
  machine.click(first.left + first.width / 2, first.top + first.height / 2)
  machine.step(width, height)
  assert.deepEqual(readFocus(machine), [1, ...Array<number>(itemCount - 1).fill(0)])
  values = settle(machine, width, height).values

  // when a control overlaps the focused photo, the control click wins
  const nextControl = machine.output.nextControl
  const nextLeft = values[nextControl[controlField.left]!]!
  const nextTop = values[nextControl[controlField.top]!]!
  const nextHeight = values[nextControl[controlField.height]!]!
  const focusedPhoto = projectPhotos(machine, values)[0]!
  const overlappingX = nextLeft + 5
  assert.ok(overlappingX < focusedPhoto.left + focusedPhoto.width)
  machine.click(overlappingX, nextTop + nextHeight / 2)
  machine.step(width, height)
  const shiftedFocus = readFocus(machine)
  assert.equal(shiftedFocus[1], 1)
  assert.equal(shiftedFocus.reduce((sum, focus) => sum + focus, 0), 1)

  // a backdrop click clears focus
  machine.click(0, 0)
  machine.step(width, height)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
})

test('thumbnail movement and scale spring between focused photos', () => {
  const machine = createPhotoGalleryMachine()
  let frameTime = 16
  let values = machine.step(viewportWidth, viewportHeight, 1, 1, frameTime)
  const firstPhoto = projectPhotos(machine, values)[0]!
  machine.click(
    firstPhoto.left + firstPhoto.width / 2,
    firstPhoto.top + firstPhoto.height / 2,
  )
  // The open: the photo zooms and the thumbnails grow out of the strip's middle.
  // 60 frames later all of them are at rest.
  for (let frame = 0; frame < 60; frame++) {
    frameTime += 16
    values = machine.step(viewportWidth, viewportHeight, 1, 1, frameTime)
  }
  const openThumbnails = projectThumbnails(machine, values)
  assert.equal(values[machine.output.animationActive], 0)

  // 8 ms before the next frame, so that frame steps the springs for 8 ms after
  // the event. An event at the frame's own time would show the thumbnails where
  // they started.
  machine.next(frameTime + 8)
  frameTime += 16
  values = machine.step(viewportWidth, viewportHeight, 1, 1, frameTime)
  const movingThumbnails = projectThumbnails(machine, values)
  assert.equal(values[machine.output.animationActive], 1)
  assert.ok(movingThumbnails[1]!.width > openThumbnails[1]!.width)
  assert.ok(movingThumbnails[0]!.left < openThumbnails[0]!.left)

  const settled = settle(machine)
  const settledThumbnails = projectThumbnails(machine, settled.values)
  assert.ok(settled.frames < 60)
  assert.equal(settledThumbnails[1]!.width, machine.source[sourceField.thumbnailHeight])
  assert.ok(settledThumbnails[1]!.width > movingThumbnails[1]!.width)
  assert.equal(settled.values[machine.output.animationActive], 0)
})

test('next state and render projections are direct wire views', () => {
  const machine = createPhotoGalleryMachine()
  let commits = 0
  machine.observe({
    afterEvaluate(values, table, evaluation) {
      if (!evaluation.writesBack) return
      commits++
      // An evaluation that writes state back copies exactly these wires into the table.
      assert.deepEqual(machine.output.nextSource.map(wire => values[wire]!), [...table])
    },
  })
  const values = machine.step(viewportWidth, viewportHeight)
  const nextSource = machine.output.nextSource.map(wire => values[wire]!)

  assert.equal(commits, 1)
  assert.equal(nextSource.length, sourceField.size)
  // The frame evaluates a copy of the table at rest, so its next state equals the
  // stored table, up to the sign of zero.
  nextSource.forEach((value, field) => assert.ok(value === machine.source[field], `field ${field}`))
  assert.equal(machine.output.photos.length, itemCount * photoField.size)
  assert.equal(machine.output.thumbnails.length, itemCount * thumbnailField.size)
  assert.equal(machine.output.previousControl.length, controlField.size)
  assert.equal(machine.output.nextControl.length, controlField.size)
})

// The zoom's tests run in the content box of HandwiredOS's Photos at its default size,
// 558 × 384 px, where a cell is 117 × 104 px and the open photo 468.72 × 248 px.
const boxWidth = 558
const boxHeight = 384

type Rectangle = {left: number, top: number, width: number, height: number}
const rectangleFields = ['left', 'top', 'width', 'height'] as const

// A machine with its own clock, whose frames come 16 ms apart, i.e. 4 spring steps.
function createZoomSession(width = boxWidth, height = boxHeight) {
  const machine = createPhotoGalleryMachine()
  let time = 0
  let size = {width, height}
  let present = 1
  function frame() {
    time += 16
    const values = machine.step(size.width, size.height, present, 1, time)
    return {
      photos: projectPhotos(machine, values),
      thumbnails: projectThumbnails(machine, values),
      backdrop: values[machine.output.backdropOpacity]!,
      controls: values[machine.output.previousControl[controlField.opacity]!]!,
      moving: values[machine.output.animationActive]!,
    }
  }
  // The photos' cells, from the first frame, which draws the grid at rest.
  const cells: Rectangle[] = frame().photos.map(({left, top, width, height}) => ({left, top, width, height}))
  return {
    machine,
    cells,
    frame,
    frames: (count: number) => Array.from({length: count}, frame),
    // Runs frames until nothing moves, and returns the last one.
    rest() {
      for (let count = 0; count < 120; count++) {
        const drawn = frame()
        if (drawn.moving === 0) return drawn
      }
      assert.fail('the zoom and the thumbnails did not settle')
    },
    // The time of an event `after` ms after the last frame, e.g. 8 ms, half a frame.
    at: (after = 8) => time + after,
    // A click on the middle of a photo's cell.
    clickCell(item: number, after = 8) {
      const cell = cells[item]!
      machine.click(cell.left + cell.width / 2, cell.top + cell.height / 2, time + after)
    },
    // A click 4 px inside the box's corner, beside the open photo's rectangle, the
    // controls and the thumbnails.
    clickBeside(after = 8) {
      machine.click(4, 4, time + after)
    },
    resize(nextWidth: number, nextHeight: number, after = 8) {
      size = {width: nextWidth, height: nextHeight}
      machine.resize(nextWidth, nextHeight, time + after)
    },
    setPresent(value: number) {
      present = value
    },
  }
}

// The open photo's rectangle in a box, from a machine that opened a photo and came to rest.
function openRectangle(width = boxWidth, height = boxHeight): Rectangle {
  const {left, top, width: openWidth, height: openHeight} = openPhoto(createPhotoGalleryMachine(), width, height, 0).photo
  return {left, top, width: openWidth, height: openHeight}
}

// A photo's rectangle is its zoom's share of the way from its cell to the open
// photo's rectangle. FP32 keeps each number within a few millionths of a pixel.
function assertBetween(photo: Rectangle & {zoom: number}, cell: Rectangle, open: Rectangle, label: string) {
  for (const field of rectangleFields) {
    assertNear(photo[field], (1 - photo.zoom) * cell[field] + photo.zoom * open[field], `${label}: ${field}`)
  }
}

test("a click on a photo in the grid moves and grows it from its cell to the open photo's rectangle on a spring, and a close takes it back", () => {
  const session = createZoomSession()
  const cell = session.cells[5]!
  const open = openRectangle()
  // The open photo's rectangle has the FP32 values that it had before the zoom existed.
  assert.deepEqual(open, {left: Math.fround(44.64), top: 18, width: Math.fround(468.72), height: 248})
  assert.deepEqual(cell, {left: 153, top: 140, width: 117, height: 104})

  // The click comes 8 ms before the next frame, so that frame shows the photo two
  // spring steps on its way.
  session.clickCell(5)
  const opening = session.frames(45)
  assertOneFocus(session.machine, 5)
  const first = opening[0]!.photos[5]!
  assert.ok(first.zoom > 0.01 && first.zoom < 0.05, `the first frame's zoom is ${first.zoom}`)
  let zoomBefore = 0
  let reachedEndAt = -1
  let hiddenFrom = -1
  opening.forEach((drawn, frame) => {
    const photo = drawn.photos[5]!
    const label = `opening, frame ${frame}`
    // One motion: the zoom only grows, until it stays at 1. After its overshoot, which
    // isn't drawn, the spring swings back under 1 by less than a millionth.
    assert.ok(photo.zoom >= zoomBefore - 1e-6 && photo.zoom <= 1, `${label}: zoom ${photo.zoom} after ${zoomBefore}`)
    zoomBefore = photo.zoom
    if (reachedEndAt === -1 && photo.zoom === 1) reachedEndAt = frame
    assertBetween(photo, cell, open, label)
    // The open photo is drawn whole and above the others, which stay in their cells
    // and fade: each has 1 - gridFadeRate × this zoom, 0 at least.
    assert.deepEqual([photo.opacity, photo.stack], [1, 3], label)
    const fading = Math.max(0, 1 - gridFadeRate * photo.zoom)
    drawn.photos.forEach((other, item) => {
      if (item === 5) return
      assert.deepEqual({left: other.left, top: other.top, width: other.width, height: other.height}, session.cells[item], label)
      assert.deepEqual([other.zoom, other.stack], [0, 0], label)
      assert.ok(Math.abs(other.opacity - fading) < 1e-6, `${label}: photo ${item} has opacity ${other.opacity}, not ${fading}`)
    })
    // Once the others are at opacity 0, they stay there, so their nodes leave the DOM once.
    if (hiddenFrom === -1 && drawn.photos[0]!.opacity === 0) hiddenFrom = frame
    if (hiddenFrom !== -1) assert.equal(drawn.photos[0]!.opacity, 0, label)
    // The backdrop and the controls fade in with the zoom.
    assert.ok(Math.abs(drawn.backdrop - photo.zoom) < 1e-6 && drawn.controls === drawn.backdrop, label)
  })
  // About a quarter of a second to the end.
  assert.ok(reachedEndAt >= 12 && reachedEndAt <= 20, `the zoom reached 1 in frame ${reachedEndAt}`)
  assert.ok(hiddenFrom >= 10 && hiddenFrom <= reachedEndAt, `the others were hidden from frame ${hiddenFrom}`)
  const atRest = session.rest()
  assert.deepEqual(atRest.photos[5], {...open, opacity: 1, zoom: 1, stack: 3})

  // A click beside the open photo closes it, and the photo returns the same way.
  session.clickBeside()
  const closing = session.frames(45)
  assert.deepEqual(readFocus(session.machine), Array(itemCount).fill(0))
  zoomBefore = 1
  let atRestFrom = -1
  closing.forEach((drawn, frame) => {
    const photo = drawn.photos[5]!
    const label = `closing, frame ${frame}`
    assert.ok(photo.zoom <= zoomBefore + 1e-6 && photo.zoom >= 0, `${label}: zoom ${photo.zoom} after ${zoomBefore}`)
    zoomBefore = photo.zoom
    assertBetween(photo, cell, open, label)
    // The returning photo is whole. Until its spring is at rest, it is above the
    // thumbnails and the photos in their cells, which come back.
    if (atRestFrom === -1 && photo.stack === 0) atRestFrom = frame
    assert.deepEqual([photo.opacity, photo.stack], [1, atRestFrom === -1 ? 2 : 0], label)
    if (photo.zoom > 0) assert.equal(photo.stack, 2, label)
    const fading = Math.max(0, 1 - gridFadeRate * photo.zoom)
    drawn.photos.forEach((other, item) => {
      if (item !== 5) assert.ok(Math.abs(other.opacity - fading) < 1e-6 && other.stack === 0, `${label}: photo ${item}`)
    })
    assert.ok(Math.abs(drawn.backdrop - photo.zoom) < 1e-6, label)
  })
  assert.ok(atRestFrom > 30, `the returning photo's spring was at rest from frame ${atRestFrom}`)
  const closed = session.rest()
  assert.deepEqual(closed.photos[5], {...cell, opacity: 1, zoom: 0, stack: 0})
  assert.equal(closed.backdrop, 0)
  closed.photos.forEach((photo, item) => {
    if (item !== 5) assert.deepEqual(photo, {...session.cells[item]!, opacity: 1, zoom: 0, stack: 0})
  })
})

test('a close during the opening turns the photo around where it is, and a click on its cell during the return opens it again from where it is', () => {
  const session = createZoomSession()
  session.clickCell(5)
  const opening = session.frames(4)
  const reached = opening.at(-1)!.photos[5]!.zoom
  assert.ok(reached > 0.4 && reached < 0.7, `the zoom is ${reached} after 4 frames`)
  // Closed 64 ms after the click: the photo keeps its velocity, so it still grows a
  // little in the next frame, then returns. No frame jumps.
  session.clickBeside()
  const returning = session.frames(5)
  assert.deepEqual(readFocus(session.machine), Array(itemCount).fill(0))
  const zooms = [reached, ...returning.map(drawn => drawn.photos[5]!.zoom)]
  assert.ok(zooms[1]! > zooms[0]!, `the photo still grows right after the close: ${zooms.join(', ')}`)
  assert.ok(zooms[5]! < zooms[2]!, `the photo returns: ${zooms.join(', ')}`)
  // At its fastest the spring moves the zoom by 0.17 in a frame.
  for (let frame = 1; frame < zooms.length; frame++) {
    assert.ok(Math.abs(zooms[frame]! - zooms[frame - 1]!) < 0.2, `no jump between frames: ${zooms.join(', ')}`)
  }
  assert.deepEqual(returning.map(drawn => drawn.photos[5]!.stack), [2, 2, 2, 2, 2])
  // A click on the middle of the returning photo's cell, where the photo is going,
  // opens it again, from where it is.
  const before = zooms.at(-1)!
  assert.ok(before > 0.2 && before < 0.6, `the zoom is ${before} when the photo is clicked again`)
  session.clickCell(5)
  const reopening = session.frames(8)
  assertOneFocus(session.machine, 5)
  const reopened = [before, ...reopening.map(drawn => drawn.photos[5]!.zoom)]
  assert.ok(reopened[2]! > reopened[1]!, `the photo grows again: ${reopened.join(', ')}`)
  for (let frame = 1; frame < reopened.length; frame++) {
    assert.ok(Math.abs(reopened[frame]! - reopened[frame - 1]!) < 0.2, `no jump between frames: ${reopened.join(', ')}`)
  }
  assert.equal(session.rest().photos[5]!.zoom, 1)
})

test('a photo opened while another returns: both move, the open one above, its opacity goes on from what it was in its cell, and a second close within the zoom puts the first photo in its cell at once', () => {
  const session = createZoomSession()
  const open = openRectangle()
  session.clickCell(5)
  session.rest()
  session.clickBeside()
  // 48 ms after the close, photo 5 is still two thirds open, and photo 6 is faded in
  // its cell like every photo of the grid.
  const inCell = session.frames(3).at(-1)!.photos[6]!
  assert.ok(inCell.opacity > 0.25 && inCell.opacity < 0.45, `photo 6 has opacity ${inCell.opacity} in its cell`)
  // A click on photo 6's cell opens photo 6.
  session.clickCell(6)
  const both = session.frames(4)
  assertOneFocus(session.machine, 6)
  let returningBefore = 1
  let openingBefore = 0
  both.forEach((drawn, frame) => {
    const [returning, opening] = [drawn.photos[5]!, drawn.photos[6]!]
    const label = `frame ${frame}`
    assert.ok(returning.zoom < returningBefore && returning.zoom > 0, `${label}: photo 5 returns, zoom ${returning.zoom}`)
    assert.ok(opening.zoom > openingBefore && opening.zoom < 1, `${label}: photo 6 opens, zoom ${opening.zoom}`)
    returningBefore = returning.zoom
    openingBefore = opening.zoom
    assertBetween(returning, session.cells[5]!, open, label)
    assertBetween(opening, session.cells[6]!, open, label)
    // The open photo is above the returning one, which fades with the open photo's
    // zoom alone. The photos in their cells fade with both.
    assert.deepEqual([opening.stack, returning.stack], [3, 2], label)
    assert.ok(Math.abs(returning.opacity - (1 - gridFadeRate * opening.zoom)) < 1e-6, label)
    const together = Math.min(1, opening.zoom + returning.zoom)
    assert.ok(Math.abs(drawn.photos[0]!.opacity - Math.max(0, 1 - gridFadeRate * together)) < 1e-6, label)
    assert.ok(Math.abs(drawn.backdrop - together) < 1e-6, label)
    // The open photo keeps the fade that the returning photo gave it in its cell, minus
    // its own zoom.
    const fadedBy = Math.max(0, returning.zoom - opening.zoom)
    assert.ok(Math.abs(opening.opacity - (1 - gridFadeRate * fadedBy)) < 1e-6, `${label}: photo 6 has opacity ${opening.opacity}`)
  })
  // So photo 6's opacity doesn't jump at the click, where it went from 0.36 to 1 in
  // one frame, and it is whole once photo 6 is as far open as photo 5 still is.
  const opacities = [inCell.opacity, ...both.map(drawn => drawn.photos[6]!.opacity)]
  for (let frame = 1; frame < opacities.length; frame++) {
    assert.ok(opacities[frame]! >= opacities[frame - 1]! && opacities[frame]! - opacities[frame - 1]! < 0.35, `photo 6's opacity: ${opacities.join(', ')}`)
  }
  assert.ok(opacities[1]! < 0.6 && opacities.at(-1) === 1, `photo 6's opacity: ${opacities.join(', ')}`)
  assert.ok(returningBefore > 0.05, `photo 5 is still ${returningBefore} open`)
  // Escape, 112 ms after the first close: photo 6's spring takes photo 6 back, and
  // photo 5, which the other spring was still taking back, is in its cell at once.
  session.machine.close(session.at())
  const after = session.frames(3)
  after.forEach((drawn, frame) => {
    const {opacity, ...landed} = drawn.photos[5]!
    assert.deepEqual(landed, {...session.cells[5]!, zoom: 0, stack: 0}, `frame ${frame}`)
    assert.ok(Math.abs(opacity - (1 - gridFadeRate * drawn.photos[6]!.zoom)) < 1e-6, `frame ${frame}`)
    assert.deepEqual([drawn.photos[6]!.stack, drawn.photos[6]!.opacity], [2, 1], `frame ${frame}`)
  })
  const turned = [openingBefore, ...after.map(drawn => drawn.photos[6]!.zoom)]
  for (let frame = 1; frame < turned.length; frame++) {
    assert.ok(Math.abs(turned[frame]! - turned[frame - 1]!) < 0.2, `photo 6 doesn't jump: ${turned.join(', ')}`)
  }
  const closed = session.rest()
  assert.deepEqual(closed.photos[6], {...session.cells[6]!, opacity: 1, zoom: 0, stack: 0})
  assert.deepEqual(closed.photos[5], {...session.cells[5]!, opacity: 1, zoom: 0, stack: 0})
})

test('a step during the opening shows the next photo as far open as the old one was, bit for bit, and a step at rest shows it at once', () => {
  // Two machines open photo 5. 32 ms later one of them gets ArrowRight, and the
  // other a click on the open photo's rectangle, which changes nothing, so that
  // both run the same evaluations.
  const stepped = createZoomSession()
  const twin = createZoomSession()
  stepped.clickCell(5)
  twin.clickCell(5)
  const beforeStep = stepped.frames(2).at(-1)!.photos[5]!.zoom
  twin.frames(2)
  assert.ok(beforeStep > 0.1 && beforeStep < 0.9, `the zoom is ${beforeStep} when the step comes`)
  stepped.machine.next(stepped.at())
  twin.machine.click(279, 142, twin.at())
  assertOneFocus(stepped.machine, 5)
  for (let frame = 0; frame < 45; frame++) {
    const [withStep, without] = [stepped.frame(), twin.frame()]
    const label = `frame ${frame}`
    // Photo 6 has the zoom that photo 5 has in the other machine, and photo 5 is
    // back in its cell, faded like every photo in its cell.
    assert.equal(withStep.photos[6]!.zoom, without.photos[5]!.zoom, label)
    if (frame === 0) assert.ok(withStep.photos[6]!.zoom > beforeStep && withStep.photos[6]!.zoom < 0.9, `photo 6 is ${withStep.photos[6]!.zoom} open in the frame after the step`)
    assert.deepEqual([withStep.photos[6]!.stack, withStep.photos[6]!.opacity], [3, 1], label)
    assert.deepEqual(withStep.photos[5], {...stepped.cells[5]!, opacity: without.photos[0]!.opacity, zoom: 0, stack: 0}, label)
    assert.equal(withStep.backdrop, without.backdrop, label)
  }
  assertOneFocus(stepped.machine, 6)
  // At rest, ArrowLeft shows photo 5 in the open rectangle in the same evaluation.
  // Only the thumbnails move.
  stepped.machine.previous(stepped.at())
  const next = stepped.frame()
  assert.deepEqual(next.photos[5], {...openRectangle(), opacity: 1, zoom: 1, stack: 3})
  assert.deepEqual(next.photos[6], {...stepped.cells[6]!, opacity: 0, zoom: 0, stack: 0})
  assert.equal(next.moving, 1)
  assert.ok(next.thumbnails[5]!.width < 82 && next.thumbnails[5]!.width > 64, `the thumbnail of photo 5 is ${next.thumbnails[5]!.width} px wide`)
})

test('a step onto the photo that is on its way back ends that return, and the next close takes the photo back from the open rectangle', () => {
  const session = createZoomSession()
  session.clickCell(5)
  session.rest()
  session.clickBeside()
  session.frames(2)
  session.clickCell(6)
  session.frames(2)
  // Photo 5 returns and photo 6 opens. ArrowLeft steps onto photo 5.
  session.machine.previous(session.at())
  const stepped = session.frame()
  assertOneFocus(session.machine, 5)
  assert.ok(stepped.photos[5]!.zoom > 0.2 && stepped.photos[5]!.zoom < 0.6, `photo 5 is ${stepped.photos[5]!.zoom} open`)
  assert.deepEqual([stepped.photos[5]!.stack, stepped.photos[6]!.zoom, stepped.photos[6]!.stack], [3, 0, 0])
  // The spring that was taking photo 5 back is at rest.
  const {springs, openSpring} = session.machine.cells.zoom
  const other = springs[1 - session.machine.source[openSpring]!]!
  assert.ok(session.machine.source[other.displacement] === 0 && session.machine.source[other.velocity] === 0)
  const open = session.rest()
  assert.equal(open.photos[5]!.zoom, 1)
  session.machine.close(session.at())
  const returning = session.frames(3).map(drawn => drawn.photos[5]!.zoom)
  assert.ok(returning[0]! > 0.9 && returning[2]! < returning[0]!, `photo 5 returns from the open rectangle: ${returning.join(', ')}`)
})

test("a change of the box's size moves a zooming photo at once and leaves its zoom alone, bit for bit", () => {
  // Two machines open photo 5. 32 ms later the box of one grows from 558 × 384 to
  // 900 × 600 px, like a window that is resized, and the other gets a resize to the
  // size that it has, so that both run the same evaluations.
  const resized = createZoomSession()
  const twin = createZoomSession()
  resized.clickCell(5)
  twin.clickCell(5)
  const beforeResize = resized.frames(2).at(-1)!.photos[5]!.zoom
  twin.frames(2)
  assert.ok(beforeResize > 0.1 && beforeResize < 0.9, `the zoom is ${beforeResize} when the box's size changes`)
  resized.resize(900, 600)
  twin.resize(boxWidth, boxHeight)
  const largeCells = createZoomSession(900, 600).cells
  const largeOpen = openRectangle(900, 600)
  for (let frame = 0; frame < 45; frame++) {
    const [large, small] = [resized.frame(), twin.frame()]
    const label = `frame ${frame}`
    assert.equal(large.photos[5]!.zoom, small.photos[5]!.zoom, label)
    // From the first frame on, every photo is laid out in the new box: the zooming
    // photo between its new cell and the new open rectangle, the others in their cells.
    assertBetween(large.photos[5]!, largeCells[5]!, largeOpen, label)
    large.photos.forEach((photo, item) => {
      if (item !== 5) assert.deepEqual({left: photo.left, top: photo.top, width: photo.width, height: photo.height}, largeCells[item], label)
    })
  }
  assert.deepEqual(resized.rest().photos[5], {...largeOpen, opacity: 1, zoom: 1, stack: 3})
  // The same on the way back.
  resized.clickBeside()
  twin.clickBeside()
  const beforeResizeBack = resized.frames(2).at(-1)!.photos[5]!.zoom
  twin.frames(2)
  assert.ok(beforeResizeBack > 0.1 && beforeResizeBack < 0.9, `the zoom is ${beforeResizeBack} when the box's size changes back`)
  resized.resize(boxWidth, boxHeight)
  twin.resize(boxWidth, boxHeight)
  const open = openRectangle()
  for (let frame = 0; frame < 45; frame++) {
    const [back, small] = [resized.frame(), twin.frame()]
    assert.equal(back.photos[5]!.zoom, small.photos[5]!.zoom, `frame ${frame}`)
    assertBetween(back.photos[5]!, resized.cells[5]!, open, `frame ${frame}`)
  }
})

test('while a photo opens, a click acts on the lightbox, also where a photo of the grid is still drawn', () => {
  const session = createZoomSession()
  session.clickCell(5)
  const drawn = session.frames(3).at(-1)!
  // 40 ms into the opening, photo 0 is drawn in its cell at about two thirds of its
  // opacity. Its cell's middle lies inside the open photo's rectangle, so a click
  // there is a click on the open photo, which keeps it open.
  assert.ok(drawn.photos[0]!.opacity > 0.5 && drawn.photos[5]!.zoom < 0.5)
  session.clickCell(0)
  session.frame()
  assertOneFocus(session.machine, 5)
  // Photo 8's cell lies beside the open photo's rectangle and left of the
  // thumbnails, so a click there closes photo 5 and doesn't open photo 8.
  const cell = session.cells[8]!
  session.machine.click(cell.left + 2, cell.top + cell.height / 2, session.at())
  session.frame()
  assert.deepEqual(readFocus(session.machine), Array(itemCount).fill(0))
})

test("the thumbnails grow out of the strip's middle at an open and shrink back into it at a close, and with no photo open and no zoom under way they snap", () => {
  const session = createZoomSession()
  const middle = boxWidth / 2
  session.clickCell(5)
  const first = session.frame()
  // Two spring steps after the click, all 9 thumbnails of the strip are within 10 px
  // of its middle and under 3 px wide.
  const drawnFirst = first.thumbnails.filter(thumbnail => thumbnail.width > 0)
  assert.equal(drawnFirst.length, 9)
  // The ring of the open photo's thumbnail is as strong as the photo is open.
  assert.ok(first.thumbnails[5]!.focused > 0.01 && first.thumbnails[5]!.focused < 0.05)
  first.thumbnails.forEach((thumbnail, item) => assert.equal(thumbnail.focused, first.photos[item]!.zoom))
  for (const thumbnail of drawnFirst) {
    assert.ok(Math.abs(thumbnail.left + thumbnail.width / 2 - middle) < 10 && thumbnail.width < 3, `a thumbnail at ${thumbnail.left}, ${thumbnail.width} px wide`)
  }
  const open = session.rest()
  assert.deepEqual(
    open.thumbnails.map(thumbnail => Math.round(thumbnail.left + thumbnail.width / 2)),
    [279, 47, 78, 127, 194, 279, 364, 431, 480, 511, 279, 279],
  )
  assert.equal(open.thumbnails[5]!.width, 82)
  // At the close every thumbnail's destination is the strip's middle at size 0.
  session.clickBeside()
  const closing = session.frames(6)
  const widths = closing.map(drawn => drawn.thumbnails[5]!.width)
  widths.forEach((width, frame) => assert.ok(width < (widths[frame - 1] ?? 82), `the open photo's thumbnail shrinks: ${widths.join(', ')}`))
  // The ring fades with the returning photo's zoom. It isn't gone in the first frame
  // of the close, in which the thumbnail is still 79.6 px wide.
  const rings = closing.map(drawn => drawn.thumbnails[5]!.focused)
  assert.ok(widths[0]! > 79 && rings[0]! > 0.95 && rings[0]! < 1, `in the first frame the thumbnail is ${widths[0]} px wide and its ring has ${rings[0]}`)
  closing.forEach((drawn, frame) => {
    const ring = drawn.thumbnails[5]!.focused
    assert.ok(ring === drawn.photos[5]!.zoom && ring < (rings[frame - 1] ?? 1), `the ring fades with the photo: ${rings.join(', ')}`)
    drawn.thumbnails.forEach((thumbnail, item) => { if (item !== 5) assert.equal(thumbnail.focused, 0) })
  })
  assert.ok(closing.at(-1)!.thumbnails[1]!.left > 47 && closing.at(-1)!.thumbnails[9]!.left < 511 - 10)
  const closed = session.rest()
  assert.equal(closed.thumbnails.filter(thumbnail => thumbnail.width > 0).length, 0)
  // With the grid in view and nothing moving, a change of the box's size moves no
  // thumbnail spring: the thumbnails snap onto the new middle.
  const {thumbnails, zoom} = session.machine.cells
  assert.equal(session.machine.source[zoom.underWay], 0)
  session.resize(900, 600)
  assert.equal(session.frame().moving, 0)
  for (const thumbnail of thumbnails) {
    assert.deepEqual(
      // + 0 turns a stored -0 into 0.
      [thumbnail.centerXDestination, thumbnail.centerXDisplacement, thumbnail.centerXVelocity, thumbnail.scaleDisplacement].map(cell => session.machine.source[cell]! + 0),
      [450, 0, 0, 0],
    )
  }
})

test('a returning photo is above the thumbnails until its spring is at rest, and then it has the z-index of every photo in its cell', () => {
  const session = createZoomSession()
  // Photo 9 is in the bottom row, whose cells lie under the strip of thumbnails.
  session.clickCell(9)
  const opening = session.frames(5)
  opening.forEach(drawn => assert.equal(drawn.photos[9]!.stack, 3))
  // A close in the middle of the opening: the photo stays above the thumbnails, which
  // have z-index 1 in the stylesheet, where it was below them from this frame on.
  session.machine.close(session.at())
  const returning = session.frames(60)
  const stacks = returning.map(drawn => drawn.photos[9]!.stack)
  const atRestFrom = stacks.indexOf(0)
  assert.deepEqual(stacks, stacks.map((_, frame) => frame < atRestFrom ? 2 : 0))
  // The photo is in its cell after about 0.3 s, and the spring is at rest about 0.3 s
  // later, when its swing is under 1/65,536 of the way. By then no thumbnail is drawn.
  const landedFrom = returning.findIndex(drawn => drawn.photos[9]!.zoom === 0)
  assert.ok(landedFrom > 12 && landedFrom < atRestFrom && atRestFrom < 50, `in its cell from frame ${landedFrom}, at rest from frame ${atRestFrom}`)
  assert.ok(returning[landedFrom]!.thumbnails.every(thumbnail => thumbnail.width < smallestDrawnSize))
  const {springs} = session.machine.cells.zoom
  for (const spring of springs) assert.ok(session.machine.source[spring.displacement] === 0 && session.machine.source[spring.velocity] === 0)
  // Another photo opens: photo 9, the photo that was closed last, fades in its cell
  // under the thumbnails like the photos beside it.
  session.clickCell(5)
  session.frames(12).forEach((drawn, frame) => {
    assert.deepEqual([drawn.photos[9]!.stack, drawn.photos[9]!.opacity], [0, drawn.photos[10]!.opacity], `frame ${frame}`)
    assert.equal(drawn.photos[5]!.stack, 3)
  })
  // Reopened while it returns, the photo is the open photo again.
  session.rest()
  session.machine.close(session.at())
  session.frames(3)
  session.clickCell(5)
  assert.equal(session.frame().photos[5]!.stack, 3)
})

test('the stylesheet puts the thumbnails between the photos in their cells and a returning photo, and the controls above the open photo', () => {
  const stylesheet = readFileSync(new URL('../../assets/handwired-os.css', import.meta.url), 'utf8')
  // The z-index in the rule that starts with the selector, e.g. ".photos-thumbnail {".
  const zIndexOf = (selector: string) => {
    const rule = new RegExp(`^\\${selector} \\{[^}]*?z-index: (\\d+);`, 'm').exec(stylesheet)
    assert.ok(rule !== null, `${selector} has no z-index`)
    return Number(rule[1])
  }
  // A photo in its cell has the z-index 0.
  const thumbnail = zIndexOf('.photos-thumbnail')
  assert.ok(thumbnail > 0 && thumbnail < photoStack.returning && photoStack.returning < photoStack.open, `the thumbnails have the z-index ${thumbnail}`)
  assert.ok(zIndexOf('.photos-control') > photoStack.open)
})

// A stand-in for the DOM under Photos' renderer: the content box with its backdrop
// and its two controls, and a count of how often a node of each class name was put
// into the content box.
function createRecordingContent() {
  type RecordingElement = {
    className: string
    textContent: string
    style: Record<string, unknown>
    children: RecordingElement[]
    parent: RecordingElement | null
    appendChild(child: RecordingElement): void
    remove(): void
    querySelector(selector: string): RecordingElement | null
  }
  const attached = new Map<string, number>()
  function createElement(className = ''): RecordingElement {
    const element: RecordingElement = {
      className,
      textContent: '',
      style: {setProperty() {}},
      children: [],
      parent: null,
      appendChild(child) {
        child.parent = element
        element.children.push(child)
        if (element === content) attached.set(child.className, (attached.get(child.className) ?? 0) + 1)
      },
      remove() {
        if (element.parent === null) return
        element.parent.children.splice(element.parent.children.indexOf(element), 1)
        element.parent = null
      },
      querySelector(selector) {
        return element.children.find(child => child.className.split(' ').includes(selector.slice(1))) ?? null
      },
    }
    return element
  }
  const content = createElement('photos-content')
  for (const className of ['photos-backdrop', 'photos-control photos-previous', 'photos-control photos-next']) {
    const child = createElement(className)
    child.parent = content
    content.children.push(child)
  }
  return {
    document: {createElement: () => createElement()} as unknown as Document,
    root: content as unknown as HTMLElement,
    attached,
    thumbnailsInContent: () => content.children.filter(child => child.className.startsWith('photos-thumbnail')).length,
  }
}

test("after a close the thumbnails' nodes leave the DOM once, also when their springs swing back above size 0 by a millionth of a pixel", () => {
  // A photo opens, and a close comes 20 to 700 ms later. In about 4 of 10 of these
  // sessions the program draws thumbnails again 0.3 s after all of them reached size
  // 0, for 1 to 3 frames and a few millionths of a pixel wide.
  let sessionsWithASwingBack = 0
  for (let delay = 20; delay <= 700; delay += 20) {
    const machine = createPhotoGalleryMachine()
    const page = createRecordingContent()
    const renderer = createPhotoGalleryRenderer(page.document, page.root)
    let time = 16
    let values = machine.step(boxWidth, boxHeight, 1, 1, time)
    renderer.render(values, machine.output)
    const cell = projectPhotos(machine, values)[5]!
    machine.click(cell.left + cell.width / 2, cell.top + cell.height / 2, time + 5)
    const closeAt = time + 5 + delay
    let closed = false
    let goneAfterTheClose = false
    let swungBack = false
    while (time < closeAt + 1500) {
      // The machine takes a queued event in its next step, so the close is queued
      // before the first frame after its time.
      if (!closed && time + 16 >= closeAt) {
        machine.close(closeAt)
        closed = true
      }
      time += 16
      values = machine.step(boxWidth, boxHeight, 1, 1, time)
      renderer.render(values, machine.output)
      if (time < closeAt) continue
      const widths = projectThumbnails(machine, values).map(thumbnail => thumbnail.width)
      if (widths.every(width => width === 0)) goneAfterTheClose = true
      else if (goneAfterTheClose) {
        swungBack = true
        for (const width of widths) assert.ok(width < 1e-4, `a thumbnail is ${width} px wide after the strip was gone`)
      }
      if (goneAfterTheClose) assert.equal(page.thumbnailsInContent(), 0, `${time - closeAt} ms after a close that came ${delay} ms after the open`)
    }
    assert.ok(goneAfterTheClose)
    if (swungBack) sessionsWithASwingBack++
    // 9 thumbnails are drawn while a photo is open, and each got its node once.
    const thumbnailNodes = [...page.attached].filter(([className]) => className.startsWith('photos-thumbnail'))
    assert.equal(thumbnailNodes.length, 9, `a close ${delay} ms after the open`)
    for (const [className, count] of thumbnailNodes) assert.equal(count, 1, `${className}, a close ${delay} ms after the open`)
  }
  assert.ok(sessionsWithASwingBack >= 10, `the program drew thumbnails again in ${sessionsWithASwingBack} of 35 sessions`)
})

test('how visible Photos is only decides whether the photos are drawn: the zoom goes on, bit for bit', () => {
  // Two machines open photo 5. One of them isn't drawn from the third frame to the
  // eighth, like a Photos window that has landed in the dock and comes back.
  const hidden = createZoomSession()
  const twin = createZoomSession()
  hidden.clickCell(5)
  twin.clickCell(5)
  for (let frame = 0; frame < 45; frame++) {
    hidden.setPresent(frame >= 2 && frame < 8 ? 0 : 1)
    const [maybeHidden, shown] = [hidden.frame(), twin.frame()]
    // The zoom is under way in the first frame in which Photos isn't drawn, and
    // still in the last one.
    if (frame === 2) assert.ok(shown.photos[5]!.zoom > 0.1 && shown.photos[5]!.zoom < 0.9, `the zoom is ${shown.photos[5]!.zoom} in frame 2`)
    if (frame === 7) assert.ok(shown.photos[5]!.zoom > 0.5 && shown.photos[5]!.zoom < 1, `the zoom is ${shown.photos[5]!.zoom} in frame 7`)
    maybeHidden.photos.forEach((photo, item) => {
      const expected = shown.photos[item]!
      assert.deepEqual(photo, frame >= 2 && frame < 8 ? {...expected, opacity: 0} : expected, `frame ${frame}, photo ${item}`)
    })
    assert.equal(maybeHidden.backdrop, frame >= 2 && frame < 8 ? 0 : shown.backdrop)
  }
})

// The zoom as plain JavaScript would have it, see "The zoom" in buildPhotos: a
// float64 spring per photo, whose destination is 1 for the open photo and 0 for the
// others, stepped 4 ms at a time. It has neither the program's two springs nor its
// openSpring and closedLast cells, and it states its constants itself, so it reads
// nothing from the module under test. The two cases in which two springs draw
// something else than 12 springs are events here:
// - A close puts every other photo in its cell, e.g. a photo that still returns.
// - A step to another photo hands the open photo's position and velocity to that
//   photo, and puts the photo that was open in its cell.
// It gets each evaluation's spring steps, settle check and snap as the host planned
// them, and which photo was open before and after the evaluation's events, -1 for none.
function createPlainZoom() {
  const stiffness = 650
  const damping = 45
  const stepSeconds = 0.004
  const settleThreshold = 2 ** -16
  const fadeRate = 1 + 2 ** -10
  type PlainSpring = {position: number, velocity: number, destination: number}
  const inItsCell = (): PlainSpring => ({position: 0, velocity: 0, destination: 0})
  const moves = (spring: PlainSpring) => spring.position !== spring.destination || spring.velocity !== 0
  let springs = Array.from({length: itemCount}, inItsCell)
  return {
    // Whether a photo's spring moves, as of the last evaluation that wrote state back.
    moves: (item: number) => moves(springs[item]!),
    evaluate(evaluation: {steps: number, settleCheck: boolean, snap: boolean, writesBack: boolean}, before: number, after: number) {
      const next = springs.map(spring => ({...spring}))
      for (const spring of next) {
        for (let step = 0; step < evaluation.steps; step++) {
          spring.velocity += (-stiffness * (spring.position - spring.destination) - damping * spring.velocity) * stepSeconds
          spring.position += spring.velocity * stepSeconds
        }
      }
      if (before === -1 && after !== -1) {
        next[after]!.destination = 1
      } else if (before !== -1 && after === -1) {
        for (let item = 0; item < itemCount; item++) {
          if (item !== before) next[item] = inItsCell()
        }
        next[before]!.destination = 0
      } else if (before !== after) {
        next[after] = next[before]!
        next[before] = inItsCell()
      }
      for (const spring of next) {
        const settles = evaluation.settleCheck
          && Math.abs(spring.position - spring.destination) <= settleThreshold && Math.abs(spring.velocity) <= settleThreshold
        if (evaluation.snap || settles) {
          spring.position = spring.destination
          spring.velocity = 0
        }
      }
      const zooms = next.map(spring => Math.min(1, Math.max(0, spring.position)))
      const zoomSum = zooms.reduce((sum, zoom) => sum + zoom, 0)
      // How far the lightbox covers the grid: the backdrop's and the controls' opacity.
      const cover = Math.min(1, zoomSum)
      const photos = zooms.map((zoom, item) => {
        // A photo is faded by the other photos' zoom. The open photo is faded by the
        // other photos' part of the cover minus its own zoom.
        const fadedBy = item === after ? Math.max(0, cover - zoom - zoom) : Math.min(1, zoomSum - zoom)
        return {
          zoom,
          opacity: Math.max(0, 1 - fadeRate * fadedBy),
          // The open photo, then a photo on its way back, then the photos in their cells.
          stack: item === after ? 3 : moves(next[item]!) ? 2 : 0,
          // Within 1/4,096 of its end and slow: where a float64 spring and an FP32
          // spring can settle at different checks.
          aboutAtRest: Math.abs(next[item]!.position - next[item]!.destination) < 2 ** -12 && Math.abs(next[item]!.velocity) < 2 ** -8,
        }
      })
      if (evaluation.writesBack) springs = next
      return {photos, cover}
    },
  }
}

test('over 4,000 random frames of opens, closes, steps and thumbnail clicks, most of them within the half second of a zoom and some after a stall, every evaluation draws what the plain JavaScript zoom draws', () => {
  const machine = createPhotoGalleryMachine()
  const plain = createPlainZoom()
  const open = openRectangle()
  const openOf = (focus: ArrayLike<number>) => Array.from(focus).indexOf(1)
  const focusCells = machine.cells.focus
  let cells: Rectangle[] = []
  let before = -1
  let evaluations = 0
  let largestZoomDifference = 0
  let settledAtDifferentChecks = 0
  const counts = {closes: 0, closesDuringAnOpening: 0, opensDuringAReturn: 0, reopenings: 0, stepsDuringAnOpening: 0, stepsOntoAReturningPhoto: 0, photosPutInTheirCells: 0, snapsDuringAZoom: 0}
  machine.observe({
    beforeEvaluate(table) {
      before = openOf(focusCells.map(cell => table[cell]!))
    },
    afterEvaluate(values, _table, evaluation) {
      const after = openOf(focusCells.map(cell => values[machine.output.nextSource[cell]!]!))
      if (evaluation.writesBack) {
        const moving = Array.from({length: itemCount}, (_, item) => plain.moves(item))
        const anotherMoves = (item: number) => moving.some((isMoving, other) => isMoving && other !== item)
        if (evaluation.snap && moving.includes(true)) counts.snapsDuringAZoom++
        if (before !== -1 && after === -1) {
          counts.closes++
          if (moving[before]) counts.closesDuringAnOpening++
          if (anotherMoves(before)) counts.photosPutInTheirCells++
        } else if (before === -1 && after !== -1) {
          if (moving[after]) counts.reopenings++
          else if (anotherMoves(after)) counts.opensDuringAReturn++
        } else if (before !== after) {
          if (moving[before]) counts.stepsDuringAnOpening++
          if (moving[after]) counts.stepsOntoAReturningPhoto++
        }
      }
      const expected = plain.evaluate(evaluation, before, after)
      const drawn = projectPhotos(machine, values)
      const thumbnails = projectThumbnails(machine, values)
      const label = `evaluation ${evaluations++}, a ${evaluation.kind} at ${evaluation.timeMs} ms with photo ${before} open before and ${after} after`
      drawn.forEach((photo, item) => {
        const {zoom, opacity, stack, aboutAtRest} = expected.photos[item]!
        // FP32 springs stay within 4e-5 of float64 ones, also where one of the two
        // settles a check before the other, which is the one case in which the stack
        // may differ: a photo that is in its cell within a hundredth of a pixel has 2
        // in one and 0 in the other.
        largestZoomDifference = Math.max(largestZoomDifference, Math.abs(photo.zoom - zoom))
        assert.ok(Math.abs(photo.zoom - zoom) < 4e-5, `${label}: photo ${item} has zoom ${photo.zoom}, not ${zoom}`)
        assert.ok(Math.abs(photo.opacity - opacity) < 8e-5, `${label}: photo ${item} has opacity ${photo.opacity}, not ${opacity}`)
        if (photo.stack !== stack) {
          assert.ok(aboutAtRest && item !== after && (photo.stack === 0 || photo.stack === 2), `${label}: photo ${item} has stack ${photo.stack}, not ${stack}`)
          settledAtDifferentChecks++
        }
        if (cells.length > 0) assertBetween(photo, cells[item]!, open, `${label}: photo ${item}`)
        // The ring of a thumbnail is as strong as its photo is open.
        assert.equal(thumbnails[item]!.focused, photo.zoom, `${label}: thumbnail ${item}`)
      })
      assert.ok(Math.abs(values[machine.output.backdropOpacity]! - expected.cover) < 8e-5, label)
    },
  })
  let time = 16
  cells = projectPhotos(machine, machine.step(boxWidth, boxHeight, 1, 1, time)).map(({left, top, width, height}) => ({left, top, width, height}))
  const random = createRandom(0x200f)
  // The middles of the strip's 9 places, e.g. 279 for the open photo's thumbnail and
  // 364 for the next photo's.
  const thumbnailCenters = [47, 78, 127, 194, 279, 364, 431, 480, 511]
  let nextEventAt = time + 40
  let lastClosed = -1
  for (let frame = 0; frame < 4000; frame++) {
    // Every 97th frame comes 1.3 s late, like a tab that stalled, so the host plans
    // a snap for the springs that move.
    time += frame % 97 === 96 ? 1300 : 5 + Math.floor(random() * 28)
    while (nextEventAt <= time) {
      const openPhoto = openOf(readFocus(machine))
      const choice = random()
      if (openPhoto === -1) {
        // Any photo, and the photo that was closed last more often than the others.
        const cell = cells[lastClosed !== -1 && random() < 0.3 ? lastClosed : Math.floor(random() * itemCount)]!
        machine.click(cell.left + cell.width / 2, cell.top + cell.height / 2, nextEventAt)
      } else if (choice < 0.4) {
        if (random() < 0.5) machine.close(nextEventAt)
        else machine.click(4, 4, nextEventAt)
      } else if (choice < 0.6) {
        machine.next(nextEventAt)
      } else if (choice < 0.8) {
        machine.previous(nextEventAt)
      } else if (choice < 0.95) {
        machine.click(thumbnailCenters[Math.floor(random() * thumbnailCenters.length)]!, 325, nextEventAt)
      } else {
        // A click on the open photo's rectangle, which changes nothing.
        machine.click(279, 142, nextEventAt)
      }
      // Most events come within the half second of a zoom, some after it.
      nextEventAt += random() < 0.8 ? 5 + Math.floor(random() * 250) : 400 + Math.floor(random() * 400)
    }
    const openBefore = openOf(readFocus(machine))
    machine.step(boxWidth, boxHeight, 1, 1, time)
    if (openBefore !== -1 && openOf(readFocus(machine)) === -1) lastClosed = openBefore
  }
  // The frames covered every rule many times, and a spring settled at different
  // checks in the two at most a few times.
  assert.ok(evaluations > 5000, `${evaluations} evaluations`)
  assert.ok(largestZoomDifference < 1e-6 || settledAtDifferentChecks > 0, `the largest difference of a zoom is ${largestZoomDifference}`)
  assert.ok(settledAtDifferentChecks <= 20, `${settledAtDifferentChecks} stacks differed around a settle check`)
  assert.ok(
    counts.closes > 60 && counts.closesDuringAnOpening > 30 && counts.opensDuringAReturn > 30 && counts.reopenings > 10
      && counts.stepsDuringAnOpening > 30 && counts.stepsOntoAReturningPhoto > 3 && counts.photosPutInTheirCells > 15 && counts.snapsDuringAZoom > 10,
    JSON.stringify(counts),
  )
})
