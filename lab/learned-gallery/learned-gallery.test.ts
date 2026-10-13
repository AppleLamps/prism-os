import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createLearnedGalleryEditor,
  createLearnedGalleryMachine,
  learnedGeometryField,
  learnedPhotoCount,
  learnedSlotCount,
  maximumTrainingStepsPerFrame,
  msPerTrainingStep,
  trainingMsPerFrame,
  trainingStepsAfterChange,
  unmeasuredTrainingStepsPerFrame,
  type LearnedGalleryInput,
  type LearnedLayoutName,
  type LearnedTargetGeometry,
} from './learned-gallery.ts'
import {
  createTrainableGeometryMachine,
  trainableGeometryField,
  type TrainableGeometry,
  type TrainableGeometryTarget,
} from './trainable-geometry.ts'

type LearnedGalleryMachine = ReturnType<typeof createLearnedGalleryMachine>

const geometryFields = [
  'left',
  'top',
  'width',
  'height',
] as const satisfies readonly (keyof LearnedTargetGeometry)[]

function replaceTarget(
  machine: LearnedGalleryMachine,
  geometries: readonly LearnedTargetGeometry[],
  slots = geometries.map((_, item) => item),
) {
  assert.equal(slots.length, geometries.length)
  machine.target.active.fill(0)
  machine.target.geometries.fill(0)
  for (let item = 0; item < geometries.length; item++) {
    machine.setTargetGeometry(slots[item]!, geometries[item]!)
  }
  machine.reset()
}

function outputGeometry(
  machine: LearnedGalleryMachine,
  values: Float32Array,
  item: number,
) {
  const start = item * learnedGeometryField.size
  return {
    left: values[machine.geometries[start + learnedGeometryField.left]!]!,
    top: values[machine.geometries[start + learnedGeometryField.top]!]!,
    width: values[machine.geometries[start + learnedGeometryField.width]!]!,
    height: values[machine.geometries[start + learnedGeometryField.height]!]!,
  }
}

function matchedRootMeanSquareError(
  machine: LearnedGalleryMachine,
  values: Float32Array,
  expected: readonly LearnedTargetGeometry[],
) {
  const {targetItems, outputByTarget} = machine.match(values)
  assert.equal(targetItems.length, expected.length)
  let squaredError = 0
  let fieldCount = 0
  for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
    const actual = outputGeometry(
      machine,
      values,
      outputByTarget[targetIndex]!,
    )
    const geometry = expected[targetIndex]!
    for (const field of geometryFields) {
      const error = actual[field] - geometry[field]
      squaredError += error * error
      fieldCount++
    }
  }
  return Math.sqrt(squaredError / fieldCount)
}

function createSidebarGrid() {
  const gap = 0.025
  const sidebarWidth = 0.3
  const cellWidth = (1 - sidebarWidth - gap * 4) / 3
  const cellHeight = (1 - gap * 5) / 4
  const geometries: LearnedTargetGeometry[] = [{
    left: gap,
    top: gap,
    width: sidebarWidth,
    height: 1 - gap * 2,
  }]
  for (let item = 0; item < 11; item++) {
    geometries.push({
      left: sidebarWidth + gap * 2 + item % 3 * (cellWidth + gap),
      top: gap + Math.floor(item / 3) * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    })
  }
  return geometries
}

// One parameterized convergence/RMSE test stands in for the former quartet
// (in-distribution product sketches, layouts absent from the product source,
// permutation invariance, and the irregular masonry layout). Each case keeps
// the distinct facts the originals defended: the 244-parameter count and the
// loss-vs-initial ratio for the in-distribution fit, the source-coefficients-
// moved check for an unseen layout, and the per-layout RMSE ceilings.
const irregularMasonry: LearnedTargetGeometry[] = [
  {left: 0.025, top: 0.025, width: 0.3, height: 0.44},
  {left: 0.35, top: 0.025, width: 0.28, height: 0.28},
  {left: 0.655, top: 0.025, width: 0.32, height: 0.58},
  {left: 0.025, top: 0.49, width: 0.3, height: 0.485},
  {left: 0.35, top: 0.33, width: 0.28, height: 0.645},
  {left: 0.655, top: 0.63, width: 0.32, height: 0.345},
]

const convergenceCases = [
  {name: 'in-distribution product sketch', kind: 'distribution', rmse: 0.005},
  {name: 'layout absent from product source', kind: 'sidebar', rmse: 0.005},
  {name: 'deliberately irregular masonry', kind: 'masonry', rmse: 0.007},
] as const

for (const {name, kind, rmse} of convergenceCases) {
  test(`the raw geometry network fits a ${name}`, () => {
    if (kind === 'distribution') {
      // In-distribution: built straight from a product layout name.
      const machine = createLearnedGalleryMachine('cinema')
      const initial = machine.evaluate()
      const trained = machine.train(500)

      assert.ok(trained.loss < 0.000_01, `cinema loss ${trained.loss}`)
      assert.ok(trained.loss < initial.loss * 0.01)
      assert.equal(machine.parameterCount, 244)
      return
    }

    const geometries = kind === 'masonry' ? irregularMasonry : createSidebarGrid()
    const machine = createLearnedGalleryMachine()
    replaceTarget(machine, geometries)
    const trained = machine.train(500)

    assert.ok(trained.loss < 0.000_01)
    assert.ok(matchedRootMeanSquareError(machine, trained.values, geometries) < rmse)

    if (kind === 'sidebar') {
      // The trainable coefficients must actually move to fit an unseen layout.
      assert.ok(
        machine.source.some((value, field) =>
          Math.abs(value - machine.initialSource[field]!) > 0.01),
      )

      // Permutation invariance: reversing the rectangles across scattered
      // slots reaches the same fit, so identities do not steer the layout.
      const permuted = createLearnedGalleryMachine()
      const slots = [0, 2, 5, 7, 9, 12, 13, 14, 16, 17, 18, 19]
      replaceTarget(permuted, geometries.toReversed(), slots)
      const permutedTrained = permuted.train(500)

      assert.ok(permutedTrained.loss < 0.000_01)
      assert.ok(
        matchedRootMeanSquareError(
          permuted,
          permutedTrained.values,
          geometries.toReversed(),
        ) < rmse,
      )
    }
  })
}

test('soft relation loss rejects much of a rough grid drag', () => {
  const clean = createSidebarGrid()
  const rough = clean.map((geometry, item) => {
    const horizontal = ((item * 17) % 7 - 3) * 0.01
    const vertical = ((item * 11) % 7 - 3) * 0.01
    const width = geometry.width + vertical * 0.4
    const height = geometry.height + horizontal * 0.4
    return {
      left: Math.min(1 - width, Math.max(0, geometry.left + horizontal)),
      top: Math.min(1 - height, Math.max(0, geometry.top + vertical)),
      width,
      height,
    }
  })
  const machine = createLearnedGalleryMachine()
  replaceTarget(machine, rough)
  const trained = machine.train(500)
  const roughError = Math.sqrt(
    rough.reduce((sum, geometry, item) => {
      for (const field of geometryFields) {
        const error = geometry[field] - clean[item]![field]
        sum += error * error
      }
      return sum
    }, 0) / (rough.length * learnedGeometryField.size),
  )
  const learnedError = matchedRootMeanSquareError(
    machine,
    trained.values,
    clean,
  )

  assert.ok(learnedError < roughError * 0.75)
})

test('reset restores the initial coefficient tensor and optimizer', () => {
  const machine = createLearnedGalleryMachine()
  const initialSource = [...machine.source]
  machine.train(40)
  // The wrapper once copied trainingStep when it was made, so it read 0 here, and the assertion after the reset
  // couldn't fail.
  assert.equal(machine.trainingStep, 40)
  machine.reset()

  assert.equal(machine.trainingStep, 0)
  assert.deepEqual([...machine.source], initialSource)
})

test('adding and deleting rectangles changes the fitted output count', () => {
  const machine = createLearnedGalleryMachine()
  const initialCount = machine.activeCount()
  const item = machine.addTargetGeometry({
    left: 0.72,
    top: 0.72,
    width: 0.2,
    height: 0.18,
  })
  // The default sketch fills the first slots, so the new rectangle takes the next one.
  assert.equal(item, initialCount)
  assert.equal(machine.activeCount(), initialCount + 1)
  machine.reset()
  assert.ok(Number.isFinite(machine.train(500).loss))

  machine.removeTargetGeometry(item)
  assert.equal(machine.activeCount(), initialCount)
})

test('the sketch holds at most one rectangle per photo', () => {
  const machine = createLearnedGalleryMachine()
  const added = {left: 0.4, top: 0.4, width: 0.2, height: 0.16}
  while (machine.activeCount() < learnedPhotoCount) assert.ok(machine.addTargetGeometry(added) >= 0)
  // The network has 20 slots and the page 12 photos, so a 13th rectangle would show the first photo again.
  assert.equal(machine.addTargetGeometry(added), -1)
  assert.equal(machine.activeCount(), learnedPhotoCount)
})

// Direct exercise of the underlying geometry machine that the learned gallery
// wraps: build a TrainableGeometryTarget by hand and drive
// createTrainableGeometryMachine straight, a path the wrapper tests never hit.
// Folded in from the deleted trainable-geometry.test.ts. The longer schedule
// and looser thresholds are the shared coefficients' raw convergence floor.
function createTrainableGeometryTarget(
  geometries: readonly TrainableGeometry[],
): TrainableGeometryTarget {
  const target = {
    geometries: new Float32Array(learnedSlotCount * trainableGeometryField.size),
    active: new Uint8Array(learnedSlotCount),
  }
  for (let item = 0; item < geometries.length; item++) {
    const geometry = geometries[item]!
    const start = item * trainableGeometryField.size
    target.active[item] = 1
    target.geometries[start + trainableGeometryField.left] = geometry.left
    target.geometries[start + trainableGeometryField.top] = geometry.top
    target.geometries[start + trainableGeometryField.width] = geometry.width
    target.geometries[start + trainableGeometryField.height] = geometry.height
  }
  return target
}

test('shared trainable coefficients fit an unseen sidebar grid', () => {
  const target = createTrainableGeometryTarget(createSidebarGrid())
  const machine = createTrainableGeometryMachine(target)
  const initial = machine.evaluate()
  const trained = machine.train(2_500)

  assert.ok(trained.loss < initial.loss * 0.05)
  assert.ok(trained.loss < 0.000_08)
  assert.ok(
    machine.source.some((value, field) =>
      Math.abs(value - machine.initialSource[field]!) > 0.01),
  )
})

// The page's editor, driven the way the page drives it: one call per animation frame, with what the pointer, the
// keys and the buttons did since the frame before. Positions are CSS pixels on a stage of 500 by 400. The editor
// times its training steps to keep a frame within its budget, and readClock is the clock it times them with. The
// default advances 0.01 ms per reading, so a frame's steps always seem to take 0.01 ms, and the number of steps per
// frame doesn't depend on how busy the machine is.
const stageWidth = 500
const stageHeight = 400

function createEditorDriver(frameMs = 1000 / 60, readClock?: () => number) {
  let readings = 0
  const editor = createLearnedGalleryEditor(readClock ?? (() => readings++ * 0.01))
  let time = 0
  function frame(inputs: LearnedGalleryInput[] = []) {
    time += frameMs
    return editor.frame(time, stageWidth, stageHeight, inputs)
  }
  return {
    editor,
    machine: editor.machine,
    frame,
    // Frames until training stops, which is when the page stops requesting them.
    settle() {
      let last = frame()
      while (last.training) last = frame()
      return last
    },
    // Time without frames, e.g. while the tab is in the background.
    pause(ms: number) {
      time += ms
    },
  }
}

function targetGeometry(machine: LearnedGalleryMachine, item: number): LearnedTargetGeometry {
  const start = item * learnedGeometryField.size
  return {
    left: machine.target.geometries[start + learnedGeometryField.left]!,
    top: machine.target.geometries[start + learnedGeometryField.top]!,
    width: machine.target.geometries[start + learnedGeometryField.width]!,
    height: machine.target.geometries[start + learnedGeometryField.height]!,
  }
}

// A point of a sketch rectangle in pixels: (0, 0) is its top left corner and (1, 1) its bottom right corner.
function pointOf(machine: LearnedGalleryMachine, item: number, horizontal = 0.5, vertical = 0.5) {
  const geometry = targetGeometry(machine, item)
  return {
    x: (geometry.left + geometry.width * horizontal) * stageWidth,
    y: (geometry.top + geometry.height * vertical) * stageHeight,
  }
}

function press(x: number, y: number, touch = false): LearnedGalleryInput {
  return {kind: 'pointer down', pointerId: 1, x, y, touch}
}

// A move with the button or the finger down, as during a drag. A mouse that only hovers moves without it.
function move(x: number, y: number, touch = false, pressed = true): LearnedGalleryInput {
  return {kind: 'pointer move', pointerId: 1, x, y, touch, pressed}
}

const release: LearnedGalleryInput = {kind: 'pointer up', pointerId: 1}

// Which output rectangle, i.e. which photo, the loss pairs with each sketch rectangle.
function pairing(machine: LearnedGalleryMachine, values: Float32Array) {
  const {targetItems, outputByTarget} = machine.match(values)
  return targetItems.map((targetItem, index) => `${targetItem}:${outputByTarget[index]!}`).join(' ')
}

// The largest difference between a sketch rectangle's four numbers and its output rectangle's, in fractions of
// the stage.
function largestError(machine: LearnedGalleryMachine, values: Float32Array, onlyTarget?: number) {
  const {targetItems, outputByTarget} = machine.match(values)
  let largest = 0
  for (let index = 0; index < targetItems.length; index++) {
    if (onlyTarget !== undefined && targetItems[index] !== onlyTarget) continue
    const actual = outputGeometry(machine, values, outputByTarget[index]!)
    const expected = targetGeometry(machine, targetItems[index]!)
    for (const field of geometryFields) {
      largest = Math.max(largest, Math.abs(actual[field] - expected[field]))
    }
  }
  return largest
}

test('each preset sketch is fitted closely by the first 500 steps', () => {
  for (const [name, count] of [['story', 10], ['cinema', 9], ['contact', 11]] as [LearnedLayoutName, number][]) {
    const page = createEditorDriver()
    const first = page.frame([{kind: 'layout', name}])
    assert.equal(first.layout, name)
    assert.equal(first.activeCount, count)
    // The first frame draws the seeded weights' output, before any step.
    assert.equal(first.step, 0)
    assert.ok(first.loss > 0.1, `${name} starts at loss ${first.loss}`)
    const settled = page.settle()
    assert.equal(settled.step, trainingStepsAfterChange)
    assert.ok(settled.loss < 0.000_001, `${name} loss ${settled.loss}`)
    assert.ok(largestError(page.machine, settled.values) < 0.003, `${name} error ${largestError(page.machine, settled.values)}`)
  }
})

test('pointer moves over the sketch train nothing once training has settled', () => {
  const page = createEditorDriver()
  const settled = page.settle()
  assert.equal(settled.step, trainingStepsAfterChange)
  for (let frameIndex = 0; frameIndex < 40; frameIndex++) {
    const frame = page.frame([move(40 + frameIndex * 5, 60 + frameIndex * 2, false, false)])
    assert.equal(frame.stepsThisFrame, 0)
    assert.equal(frame.training, false)
  }
  // The page before trained 10 steps at each of these moves.
  assert.equal(page.machine.trainingStep, trainingStepsAfterChange)
  assert.deepEqual(page.frame().loss, settled.loss)
})

test('a sketch without rectangles asks for no more frames', () => {
  const page = createEditorDriver()
  page.settle()
  let frame = page.frame()
  for (let count = page.machine.activeCount(); count > 0; count--) {
    const point = pointOf(page.machine, page.machine.target.active.indexOf(1))
    frame = page.frame([press(point.x, point.y), release])
    assert.notEqual(frame.selected, null)
    frame = page.frame([{kind: 'delete'}])
    assert.equal(frame.activeCount, count - 1)
  }
  // The page before requested a frame after every frame here, 60 a second, since its step count stayed at 0.
  assert.equal(frame.training, false)
  assert.equal(frame.loss, 0)
  assert.equal(frame.selected, null)
  const step = page.machine.trainingStep
  for (let frameIndex = 0; frameIndex < 10; frameIndex++) {
    frame = page.frame([move(100 + frameIndex, 100)])
    assert.equal(frame.training, false)
    assert.equal(frame.stepsThisFrame, 0)
  }
  frame = page.frame([{kind: 'train again'}])
  assert.equal(frame.training, false)
  assert.equal(page.machine.trainingStep, 0)
  assert.equal(step > 0, true)
})

test('training continues from the current weights while a rectangle is dragged', () => {
  const page = createEditorDriver()
  const {machine} = page
  const settled = page.settle()
  const pairingBefore = pairing(machine, settled.values)
  const item = 3
  const start = pointOf(machine, item)
  let frame = page.frame([press(start.x, start.y)])
  assert.equal(frame.selected, item)
  assert.equal(frame.capturedPointer, 1)
  assert.equal(frame.cursor, 'grabbing')
  // 40 frames of 1/60 s: up and to the right by about a third of the stage.
  const moveCount = 40
  let worstError = 0
  let stepBeforeLastMove = 0
  for (let moveIndex = 1; moveIndex <= moveCount; moveIndex++) {
    const stepBefore = machine.trainingStep
    stepBeforeLastMove = stepBefore
    frame = page.frame([move(
      start.x + 0.35 * stageWidth * moveIndex / moveCount,
      start.y - 0.37 * stageHeight * moveIndex / moveCount,
    )])
    assert.equal(frame.layout, null)
    assert.equal(frame.training, true)
    // The weights are never reset: the step count only grows, by the steps that 1/60 s holds. The first move's
    // frame starts the training's clock and takes no step.
    assert.equal(frame.step, stepBefore + frame.stepsThisFrame)
    assert.ok(moveIndex === 1 ? frame.stepsThisFrame === 0 : frame.stepsThisFrame >= 9 && frame.stepsThisFrame <= 11)
    // The photo follows its rectangle, and no photo changes places.
    worstError = Math.max(worstError, largestError(machine, frame.values, item))
    assert.equal(pairing(machine, frame.values), pairingBefore)
  }
  assert.ok(worstError < 0.06, `the dragged rectangle's photo was ${worstError} of the stage away`)

  frame = page.frame([release])
  assert.equal(frame.cursor, 'grab')
  // A reset at the release would put the loss back near 0.2, where the seeded weights start.
  assert.ok(frame.loss < 0.001, `loss at the release ${frame.loss}`)
  const final = page.settle()
  assert.equal(final.step, stepBeforeLastMove + trainingStepsAfterChange)
  assert.equal(pairing(machine, final.values), pairingBefore)

  // The same sketch fitted from the seeded weights, as the page before did at each release.
  const fromSeed = createLearnedGalleryMachine()
  fromSeed.target.geometries.set(machine.target.geometries)
  fromSeed.target.active.set(machine.target.active)
  const fromSeedLoss = fromSeed.train(trainingStepsAfterChange)
  assert.ok(final.loss < fromSeedLoss.loss * 2, `loss ${final.loss} against ${fromSeedLoss.loss} from the seeded weights`)
})

test('training takes as many steps per second at 120 Hz as at 60 Hz', () => {
  const stepsAfterHalfASecond: number[] = []
  const frameCounts: number[] = []
  for (const framesPerSecond of [60, 120]) {
    const page = createEditorDriver(1000 / framesPerSecond)
    // The first frame starts the training's clock, the second measures the cost of a step with at most 4 steps, and
    // the third makes up for the second.
    assert.equal(page.frame().stepsThisFrame, 0)
    assert.equal(page.frame().stepsThisFrame, unmeasuredTrainingStepsPerFrame)
    let frame = page.frame()
    let frameCount = 3
    while (frameCount < framesPerSecond / 2) {
      frame = page.frame()
      frameCount++
      // 600 steps a second is 10 steps in a 60 Hz frame and 5 in a 120 Hz frame, give or take one step of rounding.
      assert.ok(Math.abs(frame.stepsThisFrame - 1000 / framesPerSecond / msPerTrainingStep) <= 1)
    }
    stepsAfterHalfASecond.push(frame.step)
    while (frame.training) {
      frame = page.frame()
      frameCount++
    }
    assert.equal(frame.step, trainingStepsAfterChange)
    frameCounts.push(frameCount)
  }
  // The first frame takes no step, so half a second holds 600 / 2 steps minus one frame's.
  assert.ok(Math.abs(stepsAfterHalfASecond[0]! - 290) <= 1)
  assert.ok(Math.abs(stepsAfterHalfASecond[1]! - 295) <= 1)
  // 500 steps last 0.83 s on both displays: 50 frames after the first at 60 Hz, 100 at 120 Hz.
  assert.ok(Math.abs(frameCounts[0]! - 51) <= 1)
  assert.ok(Math.abs(frameCounts[1]! - 101) <= 1)
})

test('a frame trains a capped number of steps after a pause', () => {
  const page = createEditorDriver()
  page.frame()
  const stepsBeforePause = page.frame().step
  // 10 s without frames, e.g. the tab was in the background: 6,000 steps' worth of time.
  page.pause(10_000)
  let frame = page.frame()
  let frameCount = 1
  assert.equal(frame.stepsThisFrame, maximumTrainingStepsPerFrame)
  while (frame.training) {
    frame = page.frame()
    frameCount++
    assert.ok(frame.stepsThisFrame === maximumTrainingStepsPerFrame || !frame.training)
  }
  // The frames after the pause catch up at the cap, and training still stops at its 500 steps.
  assert.equal(frame.step, trainingStepsAfterChange)
  assert.equal(frameCount, Math.ceil((trainingStepsAfterChange - stepsBeforePause) / maximumTrainingStepsPerFrame))
})

test('a slow device trains as many steps per frame as fit in the budget', () => {
  // A device where one step takes 2.5 ms: the clock advances by that much per optimizer step.
  const msPerStep = 2.5
  const holder: {machine: LearnedGalleryMachine | null} = {machine: null}
  const page = createEditorDriver(1000 / 60, () => (holder.machine?.trainingStep ?? 0) * msPerStep)
  holder.machine = page.machine
  page.frame()
  // The first training frame has no measurement yet, so it takes 4 of the 10 steps that its 1/60 s holds.
  let frame = page.frame()
  assert.equal(frame.stepsThisFrame, unmeasuredTrainingStepsPerFrame)
  assert.equal(frame.msPerStep, msPerStep)
  let frameCount = 2
  while (frame.training) {
    frame = page.frame()
    frameCount++
    assert.equal(frame.stepsThisFrame, Math.floor(trainingMsPerFrame / msPerStep))
    assert.ok(frame.stepsThisFrame * msPerStep <= trainingMsPerFrame)
  }
  assert.equal(frame.step, trainingStepsAfterChange)
  // Training takes more frames instead of longer frames: 2 steps per frame for the 496 steps after the first 4.
  assert.equal(frameCount, 2 + 496 / 2)
})

test('a press on empty space adds a rectangle until every photo has one', () => {
  const page = createEditorDriver()
  page.settle()
  // The default sketch leaves the last cell of its lower rows empty.
  const emptyCell = {x: 0.86 * stageWidth, y: 0.87 * stageHeight}
  let frame = page.frame([move(emptyCell.x, emptyCell.y)])
  assert.equal(frame.cursor, 'crosshair')
  assert.equal(frame.hovered, null)
  frame = page.frame([press(emptyCell.x, emptyCell.y)])
  assert.equal(frame.activeCount, 11)
  assert.equal(frame.selected, 10)
  assert.equal(frame.layout, null)
  assert.equal(frame.training, true)
  const added = targetGeometry(page.machine, 10)
  assert.ok(Math.abs(added.left + added.width / 2 - 0.86) < 1e-6)
  assert.ok(Math.abs(added.top + added.height / 2 - 0.87) < 1e-6)
  // The press keeps dragging the new rectangle.
  assert.equal(frame.capturedPointer, 1)
  frame = page.frame([move(emptyCell.x - 50, emptyCell.y), release])
  assert.ok(Math.abs(targetGeometry(page.machine, 10).left - (added.left - 50 / stageWidth)) < 1e-6)

  frame = page.frame([press(0.93 * stageWidth, emptyCell.y), release])
  assert.equal(frame.activeCount, learnedPhotoCount)
  assert.equal(frame.selected, 11)

  // With 12 rectangles, a press on empty space, e.g. in the sketch's left margin, only clears the selection.
  const margin = {x: 0.015 * stageWidth, y: 0.5 * stageHeight}
  frame = page.frame([move(margin.x, margin.y)])
  assert.equal(frame.cursor, 'default')
  frame = page.frame([press(margin.x, margin.y)])
  assert.equal(frame.activeCount, learnedPhotoCount)
  assert.equal(frame.selected, null)
  assert.equal(frame.capturedPointer, null)
  page.frame([release])
  const settled = page.settle()
  assert.ok(Number.isFinite(settled.loss))
})

test('deleting a rectangle removes its photo, and no other photo moves', () => {
  const page = createEditorDriver()
  const {machine} = page
  const settled = page.settle()
  assert.deepEqual([...settled.outputs.subarray(0, learnedPhotoCount)], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
  const pairs = pairing(machine, settled.values).split(' ')

  // Select the large rectangle, whose photo is output 1 after the first training, and delete it.
  const point = pointOf(machine, 0)
  let frame = page.frame([press(point.x, point.y), release])
  const photo = frame.selectedOutput!
  assert.equal(`0:${photo}`, pairs[0])
  frame = page.frame([{kind: 'delete'}])
  assert.equal(frame.activeCount, 9)
  assert.equal(frame.outputs[photo], 0)
  // The other rectangles keep their photos, so the loss stays near where it was. The page before fitted all
  // rectangles again from the seeded weights, where the loss starts near 0.2.
  assert.equal(pairing(machine, frame.values), pairs.slice(1).join(' '))
  assert.ok(frame.loss < 0.000_01, `loss after the delete ${frame.loss}`)
  frame = page.settle()
  assert.equal(pairing(machine, frame.values), pairs.slice(1).join(' '))

  // A new rectangle takes the lowest free photo, here the one that the delete freed.
  frame = page.frame([press(point.x, point.y), release])
  assert.equal(frame.activeCount, 10)
  assert.equal(frame.selected, 0)
  assert.equal(frame.outputs[photo], 1)
  assert.equal(frame.selectedOutput, photo)
  assert.deepEqual([...frame.outputs.subarray(0, learnedPhotoCount)], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
})

test('a drag by the corner resizes, and a smaller rectangle is above a larger one', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.settle()
  const large = targetGeometry(machine, 0)
  // 5 px inside the large rectangle's bottom right corner.
  const corner = pointOf(machine, 0, 1, 1)
  let frame = page.frame([move(corner.x - 5, corner.y - 5)])
  assert.equal(frame.cursor, 'nwse-resize')
  assert.equal(frame.hovered, 0)
  frame = page.frame([press(corner.x - 5, corner.y - 5), move(corner.x - 105, corner.y - 65)])
  assert.equal(frame.selected, 0)
  const resized = targetGeometry(machine, 0)
  assert.equal(resized.left, large.left)
  assert.equal(resized.top, large.top)
  assert.ok(Math.abs(resized.width - (large.width - 100 / stageWidth)) < 1e-6)
  assert.ok(Math.abs(resized.height - (large.height - 60 / stageHeight)) < 1e-6)
  // A rectangle keeps at least 4% of the stage per side, however far the corner is dragged.
  frame = page.frame([move(0, 0)])
  assert.ok(Math.abs(targetGeometry(machine, 0).width - 0.04) < 1e-6)
  assert.ok(Math.abs(targetGeometry(machine, 0).height - 0.04) < 1e-6)
  frame = page.frame([move(corner.x - 5, corner.y - 5), release])
  assert.ok(Math.abs(targetGeometry(machine, 0).width - large.width) < 1e-6)

  // Drag a cell of the lower rows onto the large rectangle. A press where both are takes the cell.
  const cell = pointOf(machine, 3)
  const overLarge = pointOf(machine, 0, 0.4, 0.4)
  frame = page.frame([press(cell.x, cell.y), move(overLarge.x, overLarge.y), release])
  assert.equal(frame.selected, 3)
  assert.ok(frame.sketchStack[3]! > frame.sketchStack[0]!)
  frame = page.frame([press(overLarge.x, overLarge.y), release])
  assert.equal(frame.selected, 3)
  // A press on the large rectangle beside the cell takes the large rectangle, and its photo is marked.
  const besideCell = pointOf(machine, 0, 0.9, 0.1)
  frame = page.frame([press(besideCell.x, besideCell.y), release])
  assert.equal(frame.selected, 0)
  assert.equal(`0:${frame.selectedOutput}`, pairing(machine, frame.values).split(' ')[0])
  // The stage's edges stop a move.
  frame = page.frame([press(besideCell.x, besideCell.y), move(besideCell.x - 2000, besideCell.y - 2000), release])
  assert.equal(targetGeometry(machine, 0).left, 0)
  assert.equal(targetGeometry(machine, 0).top, 0)
})

test('a move without a button held ends a drag whose release never arrived', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.settle()
  const cell = pointOf(machine, 3)
  let frame = page.frame([press(cell.x, cell.y), move(cell.x + 30, cell.y)])
  assert.equal(frame.cursor, 'grabbing')
  const dragged = targetGeometry(machine, 3)
  // The button went up where the page got no event, e.g. over another window. The next move reports no button.
  frame = page.frame([move(cell.x + 90, cell.y, false, false)])
  assert.deepEqual(targetGeometry(machine, 3), dragged)
  assert.equal(frame.cursor, 'grab')
  frame = page.frame([move(cell.x + 120, cell.y - 40, false, false)])
  assert.deepEqual(targetGeometry(machine, 3), dragged)
})

test('a finger adds a rectangle with a tap, and has a larger corner to grab', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.settle()
  const emptyCell = {x: 0.86 * stageWidth, y: 0.87 * stageHeight}
  // The press alone adds nothing: the finger may be about to scroll the page.
  let frame = page.frame([press(emptyCell.x, emptyCell.y, true)])
  assert.equal(frame.activeCount, 10)
  assert.equal(frame.capturedPointer, null)
  frame = page.frame([release])
  assert.equal(frame.activeCount, 11)
  assert.equal(frame.selected, 10)
  frame = page.frame([{kind: 'delete'}])
  assert.equal(frame.activeCount, 10)

  // A finger that moves more than 10 px before it lifts, and a press that the browser cancels, add nothing.
  frame = page.frame([press(emptyCell.x, emptyCell.y, true), move(emptyCell.x + 14, emptyCell.y, true), release])
  assert.equal(frame.activeCount, 10)
  frame = page.frame([press(emptyCell.x, emptyCell.y, true), {kind: 'pointer cancel', pointerId: 1}])
  assert.equal(frame.activeCount, 10)

  // 20 px inside a corner is the rectangle's body for a mouse, which reaches 16 px, and its corner for a finger,
  // which reaches 28 px.
  const corner = pointOf(machine, 0, 1, 1)
  const before = targetGeometry(machine, 0)
  frame = page.frame([press(corner.x - 20, corner.y - 20), move(corner.x - 30, corner.y - 20), release])
  assert.ok(Math.abs(targetGeometry(machine, 0).left - (before.left - 10 / stageWidth)) < 1e-6)
  assert.equal(targetGeometry(machine, 0).width, before.width)
  frame = page.frame([press(corner.x - 30, corner.y - 20, true), move(corner.x - 50, corner.y - 20, true), release])
  assert.ok(Math.abs(targetGeometry(machine, 0).width - (before.width - 20 / stageWidth)) < 1e-6)
  // A finger leaves no hover behind, so no rectangle stays marked and the cursor doesn't change.
  assert.equal(frame.hovered, null)
  assert.equal(frame.cursor, 'default')
})

test('a preset and "Train again" start over from the seeded weights', () => {
  const page = createEditorDriver()
  const {machine} = page
  const first = page.settle()
  const cell = pointOf(machine, 3)
  page.frame([press(cell.x, cell.y), move(cell.x + 60, cell.y - 90), release])
  const edited = page.settle()
  assert.equal(edited.layout, null)
  assert.ok(edited.step > trainingStepsAfterChange)

  // "Train again" keeps the edited sketch and fits it from the seeded weights.
  let frame = page.frame([{kind: 'train again'}])
  assert.equal(frame.step, 0)
  assert.deepEqual([...machine.source], [...machine.initialSource])
  assert.equal(frame.history.length, 1)
  assert.equal(frame.layout, null)
  const again = page.settle()
  assert.equal(again.step, trainingStepsAfterChange)
  const fromSeed = createLearnedGalleryMachine()
  fromSeed.target.geometries.set(machine.target.geometries)
  fromSeed.target.active.set(machine.target.active)
  assert.equal(again.loss, fromSeed.train(trainingStepsAfterChange).loss)

  // A preset replaces the sketch, and the same sketch from the same weights trains to the same result.
  frame = page.frame([{kind: 'layout', name: 'story'}])
  assert.equal(frame.step, 0)
  assert.equal(frame.layout, 'story')
  assert.equal(frame.selected, null)
  const story = page.settle()
  assert.equal(story.loss, first.loss)

  // In the middle of training too, the frame of the restart shows the seeded weights' output, at step 0.
  page.frame([{kind: 'layout', name: 'cinema'}])
  for (let frameIndex = 0; frameIndex < 10; frameIndex++) page.frame()
  frame = page.frame([{kind: 'train again'}])
  assert.equal(frame.step, 0)
  assert.equal(frame.stepsThisFrame, 0)
  assert.deepEqual(frame.history, [{step: 0, loss: frame.loss}])
  assert.equal(page.settle().step, trainingStepsAfterChange)
})

test('the loss chart gets one sample per frame of training, for the latest 500 steps', () => {
  const page = createEditorDriver()
  let frame = page.frame()
  assert.deepEqual(frame.history, [{step: 0, loss: frame.loss}])
  frame = page.settle()
  assert.equal(frame.history[0]!.step, 0)
  assert.equal(frame.history.at(-1)!.step, trainingStepsAfterChange)
  assert.equal(frame.history.at(-1)!.loss, frame.loss)
  assert.ok(frame.history.length >= 50 && frame.history.length <= 53)
  assert.ok(frame.history.every((sample, index) => index === 0 || sample.step > frame.history[index - 1]!.step))
  // The loss falls by more than five powers of ten, which is why the chart's axis is logarithmic.
  assert.ok(frame.history[0]!.loss / frame.loss > 100_000)

  // After an edit and its 500 steps, the samples start where the chart starts: one sample at or before the first
  // of the latest 500 steps, and the others after it.
  const cell = pointOf(page.machine, 3)
  page.frame([press(cell.x, cell.y), move(cell.x + 60, cell.y - 90), release])
  frame = page.settle()
  const firstChartStep = frame.step - trainingStepsAfterChange
  assert.ok(frame.history[0]!.step <= firstChartStep)
  assert.ok(frame.history[1]!.step > firstChartStep)
})
