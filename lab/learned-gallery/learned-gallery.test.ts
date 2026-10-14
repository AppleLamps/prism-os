import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
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
  alignRectangles,
  createTrainableGeometryMachine,
  defaultAlignmentReach,
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

test('steps that raise the loss are taken back', () => {
  // Adam at a fixed learning rate doesn't come to rest: after Cinema's first 500 steps, a frame of 10 more steps
  // raises the loss 679 times at its worst, which the page showed as photos that jump and come back.
  const plain = createLearnedGalleryMachine('cinema')
  let loss = plain.train(trainingStepsAfterChange).loss
  let largestRise = 1
  for (let frame = 0; frame < 150; frame++) {
    const next = plain.train(10).loss
    largestRise = Math.max(largestRise, next / loss)
    loss = next
  }
  assert.ok(largestRise > 20, `the largest rise was ${largestRise} times`)

  // trainOrUndo takes such a frame's steps back: the loss never rises, and the weights and the outputs are the
  // ones from before the frame.
  const guarded = createLearnedGalleryMachine('cinema')
  loss = guarded.train(trainingStepsAfterChange).loss
  let undoneFrames = 0
  for (let frame = 0; frame < 150; frame++) {
    const sourceBefore = [...guarded.source]
    const valuesBefore = guarded.evaluate().values
    const result = guarded.trainOrUndo(10)
    assert.ok(result.loss <= loss, `frame ${frame} raised the loss from ${loss} to ${result.loss}`)
    if (result.undone) {
      undoneFrames++
      assert.equal(result.loss, loss)
      assert.deepEqual([...guarded.source], sourceBefore)
      assert.deepEqual(result.values, valuesBefore)
    }
    loss = result.loss
  }
  assert.ok(undoneFrames >= 5 && undoneFrames <= 60, `${undoneFrames} frames were undone`)
  // The steps that were taken back still count as steps taken.
  assert.equal(guarded.trainingStep, trainingStepsAfterChange + 1500)
  // The loss ends about where plain training leaves it, without the jumps on the way.
  assert.ok(loss < plain.evaluate().loss * 2, `${loss} against ${plain.evaluate().loss}`)
})

test('after steps were taken back, the next steps are half as large', () => {
  // How far 10 steps move the weights, from the same weights and the same optimizer state.
  function createSettledMachine() {
    const machine = createLearnedGalleryMachine('cinema')
    machine.train(trainingStepsAfterChange)
    return machine
  }
  function distanceMoved(machine: LearnedGalleryMachine, sourceBefore: readonly number[]) {
    return Math.hypot(...sourceBefore.map((value, parameter) => machine.source[parameter]! - value))
  }
  // Frames until one is undone, which halves the learning rate for the frame after it.
  const halved = createSettledMachine()
  const full = createSettledMachine()
  let frames = 0
  while (!halved.trainOrUndo(10).undone) frames++
  // The other machine takes the same kept frames with plain steps, and stands where the undone frame started.
  full.train(frames * 10)
  assert.deepEqual([...full.source], [...halved.source])
  const sourceBefore = [...halved.source]
  const next = halved.trainOrUndo(10)
  full.train(10)
  assert.equal(next.undone, false)
  // Adam's step is proportional to the learning rate, so half the rate moves the weights about half as far.
  const ratio = distanceMoved(halved, sourceBefore) / distanceMoved(full, sourceBefore)
  assert.ok(ratio > 0.3 && ratio < 0.7, `the halved rate moved the weights ${ratio} times as far`)
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

function alignedGeometries(target: TrainableGeometryTarget, reach: number, count: number) {
  const aligned = new Float32Array(target.geometries.length)
  alignRectangles(target, reach, aligned)
  return Array.from({length: count}, (_, item) => {
    const start = item * trainableGeometryField.size
    // Rounded to 6 decimals, since the target's numbers are 32-bit floats.
    return geometryFields.map(field => Math.round(aligned[start + trainableGeometryField[field]]! * 1e6) / 1e6)
  })
}

test('edges that are nearly on one line are moved onto it', () => {
  // A row of three rectangles and one below the row's middle, as left, top, width and height in fractions of the
  // stage. The middle one of the row was dragged last: its top is 0.012 below the row's, and its left is 0.02
  // right of the lower rectangle's.
  const row: TrainableGeometry[] = [
    {left: 0.1, top: 0.1, width: 0.2, height: 0.2},
    {left: 0.36, top: 0.112, width: 0.2, height: 0.2},
    {left: 0.58, top: 0.1, width: 0.2, height: 0.2},
    {left: 0.34, top: 0.4, width: 0.2, height: 0.3},
  ]
  const target = createTrainableGeometryTarget(row)
  target.editOrder = new Uint32Array(learnedSlotCount)
  target.editOrder[1] = 1
  // With a reach of 0.03, its top and bottom are on the row's lines and its left and right on the lower
  // rectangle's, and no other rectangle moved.
  assert.deepEqual(alignedGeometries(target, 0.03, 4), [
    [0.1, 0.1, 0.2, 0.2],
    [0.34, 0.1, 0.2, 0.2],
    [0.58, 0.1, 0.2, 0.2],
    [0.34, 0.4, 0.2, 0.3],
  ])
  // A reach shorter than both distances, and a reach of 0, leave the rectangles as they are drawn.
  const drawn = row.map(geometry => geometryFields.map(field => geometry[field]))
  assert.deepEqual(alignedGeometries(target, 0.01, 4), drawn)
  assert.deepEqual(alignedGeometries(target, 0, 4), drawn)
  // A reach between the two distances moves only the nearer edges, the top and the bottom.
  assert.deepEqual(alignedGeometries(target, 0.015, 4)[1], [0.36, 0.1, 0.2, 0.2])
  // When no rectangle is older than another, the edges meet at their mean, e.g. the three tops at 0.104.
  const unordered = createTrainableGeometryTarget(row)
  assert.deepEqual(alignedGeometries(unordered, 0.03, 4), [
    [0.1, 0.104, 0.2, 0.2],
    [0.35, 0.104, 0.2, 0.2],
    [0.58, 0.104, 0.2, 0.2],
    [0.35, 0.4, 0.2, 0.3],
  ])
  // Inactive slots don't count, e.g. a slot whose rectangle was deleted and that still holds zeros.
  assert.deepEqual([...unordered.geometries.subarray(4 * trainableGeometryField.size)].every(value => value === 0), true)

  // Edges that are each within reach of the next are one line: tops at 0.1, 0.12 and 0.14 all go to the top of
  // the rectangle edited longest ago, although the last one is 0.04 from it.
  const steps = createTrainableGeometryTarget([
    {left: 0.1, top: 0.1, width: 0.1, height: 0.3},
    {left: 0.4, top: 0.12, width: 0.1, height: 0.5},
    {left: 0.7, top: 0.14, width: 0.1, height: 0.7},
  ])
  steps.editOrder = Uint32Array.from({length: learnedSlotCount}, (_, item) => item)
  assert.deepEqual(alignedGeometries(steps, 0.03, 3).map(geometry => geometry[1]), [0.1, 0.1, 0.1])
  // Their bottoms are 0.2 apart, so they stay, and the two that moved up are taller by as much.
  assert.deepEqual(alignedGeometries(steps, 0.03, 3).map(geometry => geometry[3]), [0.3, 0.52, 0.74])

  // A rectangle that the lines would close keeps its own edges: this one is 0.04 wide, and one older rectangle's
  // left is 0.02 inside its left edge while another's right is 0.01 inside its right edge, which would leave it
  // 0.01 wide.
  const narrow = createTrainableGeometryTarget([
    {left: 0.5, top: 0.1, width: 0.04, height: 0.2},
    {left: 0.52, top: 0.5, width: 0.3, height: 0.2},
    {left: 0.2, top: 0.75, width: 0.33, height: 0.2},
  ])
  narrow.editOrder = new Uint32Array(learnedSlotCount)
  narrow.editOrder[0] = 1
  assert.deepEqual(alignedGeometries(narrow, 0.03, 3)[0], [0.5, 0.1, 0.04, 0.2])
})

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
  // Where the page's "Line up" slider is, as a fraction of the stage. A frame reads it like the stage's size.
  let alignmentReach = defaultAlignmentReach
  function frame(inputs: LearnedGalleryInput[] = []) {
    time += frameMs
    return editor.frame(time, stageWidth, stageHeight, alignmentReach, inputs)
  }
  return {
    editor,
    machine: editor.machine,
    frame,
    // Moves the slider. The next frame reads it.
    setAlignmentReach(reach: number) {
      alignmentReach = reach
    },
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
    assert.ok(first.loss > 0.005, `${name} starts at loss ${first.loss}`)
    const settled = page.settle()
    assert.equal(settled.step, trainingStepsAfterChange)
    // Story ends at 9.55e-9 with a largest error of 0.029% of the stage, and the other two closer.
    assert.ok(settled.loss < 0.000_000_03, `${name} loss ${settled.loss}`)
    assert.ok(largestError(page.machine, settled.values) < 0.0006, `${name} error ${largestError(page.machine, settled.values)}`)
    // A preset's edges are equal or far apart, so it reads as drawn at every reach that the page's slider has.
    const drawn = page.machine.target.geometries
    for (const reach of [0, defaultAlignmentReach, 0.06]) {
      page.machine.setAlignmentReach(reach)
      const aligned = page.machine.alignedTarget()
      assert.ok(aligned.every((value, field) => Math.abs(value - drawn[field]!) < 1e-6), `${name} at a reach of ${reach}`)
    }
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
  assert.equal(page.frame().loss, settled.loss)
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
  // Later frames train nothing either, e.g. at pointer moves, and "Train again" has nothing to train.
  const stepsBefore = page.machine.trainingStep
  for (let frameIndex = 0; frameIndex < 10; frameIndex++) {
    frame = page.frame([move(100 + frameIndex, 100, false, false)])
    assert.equal(frame.training, false)
    assert.equal(frame.stepsThisFrame, 0)
  }
  assert.equal(page.machine.trainingStep, stepsBefore)
  const costBefore = frame.msPerStep
  frame = page.frame([{kind: 'train again'}])
  assert.equal(frame.training, false)
  assert.equal(frame.step, 0)
  // This training takes no step, so the page's sentence "one step takes about 0.38 ms on this device" keeps the
  // number of the training before. With a number only for the current training, the sentence had none here.
  assert.notEqual(costBefore, null)
  assert.equal(frame.msPerStep, costBefore)
})

test('the cost of a step is unknown only until the first step', () => {
  const page = createEditorDriver()
  // The page's first frame draws the seeded weights' output and takes no step, so the page leaves the cost out.
  let frame = page.frame()
  assert.equal(frame.stepsThisFrame, 0)
  assert.equal(frame.msPerStep, null)
  // The driver's clock makes each frame's steps seem to take 0.01 ms together.
  frame = page.frame()
  assert.equal(frame.stepsThisFrame, unmeasuredTrainingStepsPerFrame)
  assert.ok(Math.abs(frame.msPerStep! - 0.01 / unmeasuredTrainingStepsPerFrame) < 1e-9)
  // The number is the average over the latest training: "Train again" starts a new average at its first step.
  const settled = page.settle()
  frame = page.frame([{kind: 'train again'}])
  assert.equal(frame.msPerStep, settled.msPerStep)
  frame = page.frame()
  assert.ok(Math.abs(frame.msPerStep! - 0.01 / frame.stepsThisFrame) < 1e-9)
})

test('the numbers in the page\'s text are the code\'s', () => {
  // The caption, the description and the instructions are static text, so their numbers are written by hand.
  const html = readFileSync(new URL('./learned-gallery.html', import.meta.url), 'utf8')
  const {parameterCount} = createLearnedGalleryMachine()
  assert.ok(html.includes(`but its ${parameterCount} weights are trained`))
  assert.ok(html.includes(`trains the network's ${parameterCount} weights`))
  assert.ok(html.includes(`empty space to add one, up to ${learnedPhotoCount}<`))
  // The slider is in percent of the stage: it starts at the reach that the network is fitted with before the
  // first frame reads it, and it ends below 9, the distance of a preset's closest edges that aren't equal.
  assert.ok(html.includes(`<input id="learning-align" class="range" type="range" min="0" max="6" step="0.5" value="${defaultAlignmentReach * 100}">`))
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
  fromSeed.target.editOrder = machine.target.editOrder!
  const fromSeedLoss = fromSeed.train(trainingStepsAfterChange)
  assert.ok(final.loss < fromSeedLoss.loss * 2, `loss ${final.loss} against ${fromSeedLoss.loss} from the seeded weights`)
})

// How far apart the photos of the given sketch rectangles are at one edge, in fractions of the stage: 0 when the
// photos are on one line.
function lineSpread(machine: LearnedGalleryMachine, values: Float32Array, slots: readonly number[], edge: 'left' | 'top' | 'right' | 'bottom') {
  const {targetItems, outputByTarget} = machine.match(values)
  const positions = slots.map(slot => {
    const geometry = outputGeometry(machine, values, outputByTarget[targetItems.indexOf(slot)]!)
    return edge === 'left' ? geometry.left : edge === 'top' ? geometry.top : edge === 'right' ? geometry.left + geometry.width : geometry.top + geometry.height
  })
  return Math.max(...positions) - Math.min(...positions)
}

test('a rectangle dragged roughly within its row gets a photo that is in the row', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'contact'}])
  const loaded = page.settle()
  const loadedPhotos = [...loaded.values]
  // Contact sheet is 4 columns and 3 rows. Rectangle 5 is in the second row and the second column.
  const row = [4, 5, 6, 7]
  const column = [1, 5, 9]
  const cell = pointOf(machine, 5)
  // 10 px right and 10 px down on a stage of 500 by 400, i.e. 0.02 and 0.025 of the stage, which is within the
  // reach of 0.03 that the page starts with.
  let frame = page.frame([press(cell.x, cell.y)])
  for (let moveIndex = 1; moveIndex <= 12; moveIndex++) {
    frame = page.frame([move(cell.x + 10 * moveIndex / 12, cell.y + 10 * moveIndex / 12)])
  }
  frame = page.frame([release])
  assert.equal(frame.layout, null)
  let settled = page.settle()
  // The photo is on the lines of its row and its column, within 0.1 px, and so 10 px from its rectangle.
  // Measured: 0.004% of the stage. Before the loss read such edges as one line, the photo ended 0.2% off its
  // row, about 1 px, and the row's other photos had moved 0.6% toward it.
  for (const edge of ['top', 'bottom'] as const) {
    assert.ok(lineSpread(machine, settled.values, row, edge) < 0.0002, `the row's ${edge}s are ${lineSpread(machine, settled.values, row, edge)} apart`)
  }
  for (const edge of ['left', 'right'] as const) {
    assert.ok(lineSpread(machine, settled.values, column, edge) < 0.0002, `the column's ${edge}s are ${lineSpread(machine, settled.values, column, edge)} apart`)
  }
  assert.ok(Math.abs(largestError(machine, settled.values, 5) - 0.025) < 0.0005)
  // No photo moved: the rectangles that weren't dragged are the older ones, so the lines are where they were.
  const largestMove = Math.max(...loadedPhotos.map((value, wire) => Math.abs(value - settled.values[wire]!)))
  assert.ok(largestMove < 0.0002, `a photo moved by ${largestMove} of the stage`)

  // With the slider at 0, the photos follow the sketch as it is drawn: training continues from the current
  // weights, and the photo ends on its rectangle, 0.025 of the stage below its row.
  page.setAlignmentReach(0)
  frame = page.frame()
  assert.equal(frame.training, true)
  assert.equal(frame.stepsThisFrame, 0)
  const stepsBefore = frame.step
  settled = page.settle()
  assert.equal(settled.step, stepsBefore + trainingStepsAfterChange)
  assert.ok(largestError(machine, settled.values) < 0.0006, `the largest error is ${largestError(machine, settled.values)}`)
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.025) < 0.0006)
  assert.ok(Math.abs(lineSpread(machine, settled.values, column, 'left') - 0.02) < 0.0006)

  // A reach shorter than the vertical distance and longer than the horizontal one lines up the column only.
  page.setAlignmentReach(0.022)
  page.frame()
  settled = page.settle()
  assert.ok(lineSpread(machine, settled.values, column, 'left') < 0.0006)
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.025) < 0.0006)

  // Back at the reach of 0.03, the photo is in its row again.
  page.setAlignmentReach(defaultAlignmentReach)
  page.frame()
  settled = page.settle()
  assert.ok(lineSpread(machine, settled.values, row, 'top') < 0.0006)
  assert.ok(lineSpread(machine, settled.values, column, 'left') < 0.0006)
})

test('a rectangle dragged farther than the reach keeps its photo', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'contact'}])
  page.settle()
  const cell = pointOf(machine, 5)
  // 20 px right and 16 px down, i.e. 0.04 of the stage both ways, past the reach of 0.03.
  page.frame([press(cell.x, cell.y)])
  for (let moveIndex = 1; moveIndex <= 12; moveIndex++) {
    page.frame([move(cell.x + 20 * moveIndex / 12, cell.y + 16 * moveIndex / 12)])
  }
  page.frame([release])
  const settled = page.settle()
  assert.ok(largestError(machine, settled.values) < 0.0006, `the largest error is ${largestError(machine, settled.values)}`)
  assert.ok(Math.abs(lineSpread(machine, settled.values, [4, 5, 6, 7], 'top') - 0.04) < 0.0006)
})

test('a move of the slider that changes no line starts no training', () => {
  const page = createEditorDriver()
  const loaded = page.settle()
  assert.equal(loaded.layout, 'story')
  // Story's edges are equal or at least 0.09 apart, so every reach up to the slider's 0.06 reads it the same.
  for (const reach of [0.06, 0, 0.045, defaultAlignmentReach]) {
    page.setAlignmentReach(reach)
    const frame = page.frame()
    assert.equal(frame.training, false)
    assert.equal(frame.stepsThisFrame, 0)
    assert.equal(frame.step, trainingStepsAfterChange)
    // The slider doesn't edit the sketch, so the preset stays marked.
    assert.equal(frame.layout, 'story')
  }
})

test('the loss never rises in a frame where the sketch stays the same', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'cinema'}])
  page.settle()
  // Six rough drags in a row, each followed by its 500 steps, as a visitor who rearranges the sketch makes them.
  // The page before trained with plain steps, and its photos jumped by up to 14 px in the frames after such drags.
  const offsets = [[7, -5], [-6, 8], [9, 6], [-8, -7], [5, 9], [-9, 4]] as const
  let framesWithoutChange = 0
  for (const [index, [horizontal, vertical]] of offsets.entries()) {
    const point = pointOf(machine, (index * 2 + 1) % machine.activeCount())
    let frame = page.frame([press(point.x, point.y)])
    for (let moveIndex = 1; moveIndex <= 8; moveIndex++) {
      frame = page.frame([move(point.x + horizontal * moveIndex / 8, point.y + vertical * moveIndex / 8)])
    }
    frame = page.frame([release])
    while (frame.training) {
      const lossBefore = frame.loss
      frame = page.frame()
      framesWithoutChange++
      assert.ok(frame.loss <= lossBefore, `after drag ${index + 1}, a frame raised the loss from ${lossBefore} to ${frame.loss}`)
    }
  }
  // Each drag's last move starts 500 steps, about 50 frames.
  assert.ok(framesWithoutChange >= 6 * 48, `${framesWithoutChange} frames`)
})

test('a photo follows its rectangle from the first frames of a drag, also after a rest', () => {
  for (const name of ['story', 'cinema'] as const) {
    const page = createEditorDriver()
    const {machine} = page
    page.frame([{kind: 'layout', name}])
    // With "Line up" off, a photo has only its rectangle to follow, and no line to stay on.
    page.setAlignmentReach(0)
    page.settle()
    // 3,000 more steps at rest, in the page's frames, e.g. after edits that changed little. By then frames have
    // been taken back, and the learning rate is low.
    for (let frameIndex = 0; frameIndex < 300; frameIndex++) machine.trainOrUndo(10)
    const atRest = [...machine.evaluate().values]
    // 30 frames, half a second: rectangle 4 goes 70 px to the right and 15 px up.
    const start = pointOf(machine, 4)
    let frame = page.frame([press(start.x, start.y)])
    let largestLag = 0
    let largestOtherMove = 0
    const {targetItems, outputByTarget} = machine.match(frame.values)
    const draggedOutput = outputByTarget[targetItems.indexOf(4)]!
    for (let moveIndex = 1; moveIndex <= 30; moveIndex++) {
      frame = page.frame([move(start.x + 70 * moveIndex / 30, start.y - 15 * moveIndex / 30)])
      const sketch = targetGeometry(machine, 4)
      const photo = outputGeometry(machine, frame.values, draggedOutput)
      largestLag = Math.max(largestLag, Math.abs(photo.left - sketch.left), Math.abs(photo.top - sketch.top))
      for (let output = 0; output < learnedSlotCount; output++) {
        if (output === draggedOutput || frame.outputs[output] !== 1) continue
        for (let field = 0; field < learnedGeometryField.size; field++) {
          const wire = machine.geometries[output * learnedGeometryField.size + field]!
          largestOtherMove = Math.max(largestOtherMove, Math.abs(frame.values[wire]! - atRest[wire]!))
        }
      }
    }
    // Measured: the photo is at most 0.7% of the stage behind, about 4 px, and no other photo moves by more than
    // 0.6%. With the full learning rate at every change of the sketch, each frame's steps were taken back, and
    // the photo stood still for the whole drag, 13% behind at its end. With plain steps in the frames of a change,
    // the first one threw the other photos up to 48% of the stage off.
    assert.ok(largestLag < 0.015, `${name}: the photo was ${largestLag} of the stage behind its rectangle`)
    assert.ok(largestOtherMove < 0.015, `${name}: another photo moved by ${largestOtherMove} of the stage`)
  }
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
  // The steps of each frame until training stops, e.g. 10, 10, 9, 10.
  const stepsPerFrame: number[] = []
  while (frame.training) {
    frame = page.frame()
    stepsPerFrame.push(frame.stepsThisFrame)
  }
  const again = frame
  assert.equal(again.step, trainingStepsAfterChange)
  // The same sketch from the same weights, trained in the same frames, ends at the same loss.
  const fromSeed = createLearnedGalleryMachine()
  fromSeed.target.geometries.set(machine.target.geometries)
  fromSeed.target.active.set(machine.target.active)
  fromSeed.target.editOrder = machine.target.editOrder!
  fromSeed.target.outputs = machine.target.outputs!
  let fromSeedLoss = fromSeed.evaluate().loss
  for (const steps of stepsPerFrame) fromSeedLoss = fromSeed.trainOrUndo(steps).loss
  assert.equal(again.loss, fromSeedLoss)

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
