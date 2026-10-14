import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, emitRelu} from '../../src/runtime/numeric-ui-core.ts'
import {
  columnCount,
  controlField,
  createPhotoGalleryMachine,
  focusField,
  itemCount,
  maximumOpenPhotoTallness,
  maximumOpenPhotoWideness,
  maximumPhotoTallness,
  maximumPhotoWideness,
  photoField,
  rowCount,
  sourceField,
  thumbnailField,
} from '../../src/handwiredos/photo-gallery.ts'

const viewportWidth = 1280
const viewportHeight = 720
const gap = 18

function projectPhotos(machine: ReturnType<typeof createPhotoGalleryMachine>, values: Float32Array) {
  return Array.from({length: itemCount}, (_, item) => {
    const outputStart = item * photoField.size
    return {
      left: values[machine.output.photos[outputStart + photoField.left]!]!,
      top: values[machine.output.photos[outputStart + photoField.top]!]!,
      width: values[machine.output.photos[outputStart + photoField.width]!]!,
      height: values[machine.output.photos[outputStart + photoField.height]!]!,
      opacity: values[machine.output.photos[outputStart + photoField.opacity]!]!,
      focused: values[machine.output.photos[outputStart + photoField.focused]!]!,
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

function settleThumbnails(machine: ReturnType<typeof createPhotoGalleryMachine>) {
  for (let frames = 1; frames <= 120; frames++) {
    const values = machine.step(viewportWidth, viewportHeight)
    if (values[machine.output.animationActive] === 0) return {values, frames}
  }
  assert.fail('thumbnail animation did not settle')
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
    focused: 0,
  })
  assert.deepEqual(grid[itemCount - 1], {
    left: 3 * gridWidth + 4 * gap,
    top: 2 * gridHeight + 3 * gap,
    width: gridWidth,
    height: gridHeight,
    opacity: 1,
    focused: 0,
  })

  const target = grid[6]!
  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 6)

  const photos = projectPhotos(machine, values)
  assert.deepEqual(photos[6], {
    left: 92,
    top: 18,
    width: 1096,
    height: 584,
    opacity: 1,
    focused: 1,
  })
  assert.equal(photos[0]!.left, 0)
  assert.equal(photos[0]!.opacity, 0)
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

// Opens a photo of the grid and returns its rectangle as the open photo.
function openPhoto(machine: ReturnType<typeof createPhotoGalleryMachine>, width: number, height: number, item: number) {
  const target = projectPhotos(machine, machine.step(width, height))[item]!
  machine.click(target.left + target.width / 2, target.top + target.height / 2)
  const values = machine.step(width, height)
  assertOneFocus(machine, item)
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

  const thumbnail = projectThumbnails(machine, values)[8]!
  machine.click(thumbnail.left + thumbnail.width / 2, thumbnail.top + thumbnail.height / 2)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 8)

  machine.click(4, 4)
  values = machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
  assert.equal(values[machine.output.backdropOpacity], 0)
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
  values = machine.step(viewportWidth, viewportHeight)
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
    values = hostedMachine.step(hostedWidth, 384)
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
  values = machine.step(width, height)
  assert.deepEqual(readFocus(machine), [1, ...Array<number>(itemCount - 1).fill(0)])

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
  frameTime += 16
  values = machine.step(viewportWidth, viewportHeight, 1, 1, frameTime)
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

  const settled = settleThumbnails(machine)
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
