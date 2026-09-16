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
