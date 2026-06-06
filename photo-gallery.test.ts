import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  columnCount,
  controlField,
  createPhotoGalleryMachine,
  focusField,
  itemCount,
  photoField,
  rowCount,
  sourceField,
  thumbnailField,
} from './photo-gallery.ts'

const viewportWidth = 1280
const viewportHeight = 720
const gap = 18

function projectPhotos(machine: ReturnType<typeof createPhotoGalleryMachine>, values: Float64Array) {
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

function projectThumbnails(machine: ReturnType<typeof createPhotoGalleryMachine>, values: Float64Array) {
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

test('the fixed grid opens every photo with all twelve thumbnails', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const grid = projectPhotos(machine, values)
  const gridWidth = (viewportWidth - (columnCount + 1) * gap) / columnCount
  const gridHeight = (viewportHeight - (rowCount + 1) * gap) / rowCount

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
  const thumbnailWidth =
    viewportWidth * (1 / itemCount) + gap * (-(itemCount + 1) / itemCount)
  assert.deepEqual(thumbnails[0], {
    left: gap,
    top: 620,
    width: thumbnailWidth,
    height: 82,
    opacity: 1,
    focused: 0,
  })
  assert.deepEqual(thumbnails[6], {
    left: gap + 6 * (thumbnailWidth + gap),
    top: 620,
    width: thumbnailWidth,
    height: 82,
    opacity: 1,
    focused: 1,
  })
  assert.equal(thumbnails.length, itemCount)
  assert.equal(photos[6].top + photos[6].height + gap, thumbnails[0].top)
  assert.equal(values[machine.output.backdropOpacity], 1)
})

test('thumbnail clicks switch focus and backdrop clicks close', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const target = projectPhotos(machine, values)[4]!
  machine.click(target.left + 20, target.top + 20)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 4)

  const thumbnail = projectThumbnails(machine, values)[9]!
  machine.click(thumbnail.left + thumbnail.width / 2, thumbnail.top + thumbnail.height / 2)
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 9)

  machine.click(4, 4)
  values = machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
  assert.equal(values[machine.output.backdropOpacity], 0)
})

test('numeric previous and next signals wrap around, while close clears focus', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const first = projectPhotos(machine, values)[0]!
  machine.click(first.left + 20, first.top + 20)
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 0)

  machine.previous()
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, itemCount - 1)

  machine.next()
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 0)

  machine.close()
  machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
})

test('the projected previous and next controls drive the same numeric transitions', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const target = projectPhotos(machine, values)[5]!
  machine.click(target.left + 20, target.top + 20)
  values = machine.step(viewportWidth, viewportHeight)

  const nextControl = machine.output.nextControl
  machine.click(
    values[nextControl[controlField.left]!]! + values[nextControl[controlField.width]!]! / 2,
    values[nextControl[controlField.top]!]! + values[nextControl[controlField.height]!]! / 2,
  )
  values = machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 6)

  const previousControl = machine.output.previousControl
  machine.click(
    values[previousControl[controlField.left]!]!
      + values[previousControl[controlField.width]!]! / 2,
    values[previousControl[controlField.top]!]!
      + values[previousControl[controlField.height]!]! / 2,
  )
  machine.step(viewportWidth, viewportHeight)
  assertOneFocus(machine, 5)
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
})

test('soft edge focus remains a valid differentiable state', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(1281, 721)
  const first = projectPhotos(machine, values)[0]!
  machine.click(first.left + 0.5, first.top + first.height / 2)
  values = machine.step(1281, 721)

  assert.deepEqual(readFocus(machine), [0.5, ...Array<number>(itemCount - 1).fill(0)])
  for (const photo of projectPhotos(machine, values)) {
    assert.ok(Number.isFinite(photo.left))
    assert.ok(Number.isFinite(photo.top))
    assert.ok(Number.isFinite(photo.width))
    assert.ok(Number.isFinite(photo.height))
  }

  machine.click(0, 0)
  machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), Array(itemCount).fill(0))
})

test('main and control clicks do not shrink fractional focused components', () => {
  const machine = createPhotoGalleryMachine()
  let values = machine.step(1281, 721)
  const first = projectPhotos(machine, values)[0]!
  machine.click(first.left + 0.5, first.top + first.height / 2)
  values = machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), [0.5, ...Array<number>(itemCount - 1).fill(0)])

  machine.click(640, 300)
  values = machine.step(1281, 721)
  assert.deepEqual(readFocus(machine), [0.5, ...Array<number>(itemCount - 1).fill(0)])

  const nextControl = machine.output.nextControl
  machine.click(
    values[nextControl[controlField.left]!]! + values[nextControl[controlField.width]!]! / 2,
    values[nextControl[controlField.top]!]! + values[nextControl[controlField.height]!]! / 2,
  )
  machine.step(1281, 721)
  const shiftedFocus = readFocus(machine)
  assert.equal(shiftedFocus[1], 0.5)
  assert.equal(shiftedFocus.reduce((sum, focus) => sum + focus, 0), 1)
})

test('next state and render projections are direct wire views', () => {
  const machine = createPhotoGalleryMachine()
  const values = machine.step(viewportWidth, viewportHeight)
  const nextSource = machine.output.nextSource.map(wire => values[wire]!)

  assert.equal(nextSource.length, sourceField.size)
  assert.deepEqual(nextSource, [...machine.source])
  assert.equal(machine.output.photos.length, itemCount * photoField.size)
  assert.equal(machine.output.thumbnails.length, itemCount * thumbnailField.size)
  assert.equal(machine.output.previousControl.length, controlField.size)
  assert.equal(machine.output.nextControl.length, controlField.size)
})
