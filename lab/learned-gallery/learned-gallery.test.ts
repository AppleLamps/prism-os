import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'bun:test'
import {
  chartStepCount,
  createLearnedGalleryEditor,
  createLearnedGalleryMachine,
  defaultHoldDistance,
  learnedGeometryField,
  learnedPhotoCount,
  learnedSlotCount,
  maximumTrainingStepsAfterChange,
  maximumTrainingStepsPerFrame,
  minimumTrainingStepsPerFrame,
  msPerTrainingStep,
  restDistance,
  restSteps,
  trainingMsPerFrame,
  trainingStepsAfterChange,
  trainingStepsLeft,
  unmeasuredTrainingStepsPerFrame,
  type LearnedGalleryInput,
  type LearnedLayoutName,
  type LearnedTargetGeometry,
} from './learned-gallery.ts'
import {
  createTrainableGeometryMachine,
  pairCost,
  pairPull,
  penaltyStrength,
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

// The tests that take over a second on a quiet machine have a limit of 30 s, which `bun run test` gives every test.
// Bare `bun test` gives 5 s, and with every core busy a test of 2 s ran out of that.
test('steps that raise the loss are taken back', () => {
  // Adam at a fixed learning rate doesn't come to rest: after Cinema's first 500 steps, a frame of 10 more steps
  // raises the loss 342 times at its worst, which the page showed as photos that jump and come back. The penalty
  // is off here, as it is for a machine until setPenaltyReach, so the loss is the distance from the target alone.
  const plain = createLearnedGalleryMachine('cinema')
  let loss = plain.train(trainingStepsAfterChange).loss
  const lossAfterFirstSteps = loss
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
  // Measured: 24 of the 150 frames.
  assert.ok(undoneFrames >= 5 && undoneFrames <= 100, `${undoneFrames} frames were undone`)
  // The steps that were taken back still count as steps taken.
  assert.equal(guarded.trainingStep, trainingStepsAfterChange + 1500)
  // The loss keeps falling without the jumps on the way. Measured: from 7.5e-8 to 1.6e-9.
  assert.ok(loss < lossAfterFirstSteps * 0.1, `${loss} against ${lossAfterFirstSteps} after the first steps`)
}, 30_000)

test('after steps were taken back, the next steps are half as large, and after steps that were kept, 1.15 times as large', () => {
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
  while (!halved.trainOrUndo(10).undone) {
    frames++
    // Measured: 12 frames. Without the limit, this loop would never end if no frame were taken back.
    assert.ok(frames < 200, 'no frame was taken back')
  }
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

  // That frame was kept, which raises the rate by 15%, to 0.575 of the full rate. A third machine takes the same
  // frames up to here, and then one plain step where the first takes one step of a frame. One step from the same
  // weights and the same optimizer state moves the weights exactly as far as its rate says.
  const plain = createSettledMachine()
  for (let frame = 0; frame < frames + 2; frame++) plain.trainOrUndo(10)
  assert.deepEqual([...plain.source], [...halved.source])
  const sourceAfterKeptFrame = [...halved.source]
  assert.equal(halved.trainOrUndo(1).undone, false)
  plain.train(1)
  const raisedRatio = distanceMoved(halved, sourceAfterKeptFrame) / distanceMoved(plain, sourceAfterKeptFrame)
  assert.ok(Math.abs(raisedRatio - 0.5 * 1.15) < 0.005, `after the kept frame, a step moved the weights ${raisedRatio} times as far as a plain step`)
})

test('when frames at 1/64 of the learning rate keep being taken back, the steps get smaller still', () => {
  const reach = defaultHoldDistance / penaltyStrength
  function createMachine() {
    const machine = createLearnedGalleryMachine('contact')
    machine.setPenaltyReach(reach, reach * 5 / 4)
    return machine
  }
  // Frames of one step are taken back in rows: a frame that is taken back puts Adam's momentum back too, so the
  // next frame takes the same step at half the rate, and where the momentum points uphill, that is taken back as
  // well, until the multipliers have changed the slopes. This waits for a row of 11 or more that ends with a kept
  // frame. 6 frames halve the rate from 1 to 1/64, and from the 5th frame at 1/64 on the rate goes on halving, so
  // the kept frame ran at 1/128 of the rate or less. Measured: the row is 25 frames long. With no rate below
  // 1/64, the kept frame's step was 1/64 of a plain step.
  const machine = createMachine()
  let frames = 0
  let takenBackInARow = 0
  let sourceBefore: number[] = []
  for (;;) {
    sourceBefore = [...machine.source]
    const result = machine.trainOrUndo(1)
    frames++
    if (!result.undone && takenBackInARow >= 11) break
    takenBackInARow = result.undone ? takenBackInARow + 1 : 0
    assert.ok(frames < 3000, 'no 11 frames in a row were taken back')
  }
  // A second machine takes the same frames, and then one plain step where the first took the kept frame's step.
  const plain = createMachine()
  for (let frame = 1; frame < frames; frame++) plain.trainOrUndo(1)
  assert.deepEqual([...plain.source], sourceBefore)
  plain.train(1)
  const moved = (other: LearnedGalleryMachine) => Math.hypot(...sourceBefore.map((value, parameter) => other.source[parameter]! - value))
  const ratio = moved(machine) / moved(plain)
  assert.ok(ratio > 0 && ratio < 1 / 127, `the kept frame's step moved the weights ${ratio} times as far as a plain step`)
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

test('the penalty\'s pull is the slope of its cost', () => {
  const reach = 0.02
  // A pair's multiplier is within the reach either way. 0 is the loss's own charge.
  for (const multiplier of [0, 0.004, -0.004, 0.019, -0.019]) {
    for (let index = -60; index <= 60; index++) {
      const gap = index * 0.0005 + 0.0001
      // The cost's change over a small step of the gap, against the pull in the step's middle. The pull has
      // corners, e.g. where it meets its limit, so the two differ by up to the step times the pull's steepest
      // change, which is the stiffness of 5 plus the limit's 1.
      const step = 1e-6
      const slope = (pairCost(gap + step, multiplier, reach) - pairCost(gap - step, multiplier, reach)) / (2 * step)
      assert.ok(Math.abs(slope - pairPull(gap, multiplier, reach)) < 1e-5, `multiplier ${multiplier}, gap ${gap}: slope ${slope}, pull ${pairPull(gap, multiplier, reach)}`)
    }
    // The mirrored pair is charged the same and pulled the other way.
    assert.equal(pairCost(-0.003, -multiplier, reach), pairCost(0.003, multiplier, reach))
    assert.equal(pairPull(-0.003, -multiplier, reach), -pairPull(0.003, multiplier, reach))
  }
  // Without a multiplier, the pull is 5 times a small gap, and the reach minus the gap from where the two meet.
  assert.ok(Math.abs(pairPull(0.001, 0, reach) - 0.005) < 1e-12)
  assert.ok(Math.abs(pairPull(0.015, 0, reach) - 0.005) < 1e-12)
  assert.ok(Math.abs(pairPull(-0.015, 0, reach) + 0.005) < 1e-12)
  // A multiplier adds to the pull, within the same limit.
  assert.ok(Math.abs(pairPull(0.001, 0.004, reach) - 0.009) < 1e-12)
  assert.ok(Math.abs(pairPull(0.001, 0.019, reach) - 0.019) < 1e-12)
  // Edges a reach or more apart aren't pulled, whatever the multiplier, and their cost stays what it is at the
  // reach. An aligned pair costs nothing.
  for (const gap of [0.02, 0.03, -0.02, -0.5]) {
    // Math.abs, since the pull of such a pair with a negative gap is -0.
    assert.equal(Math.abs(pairPull(gap, 0, reach)), 0)
    assert.equal(Math.abs(pairPull(gap, 0.01, reach)), 0)
    assert.equal(pairCost(gap, 0, reach), pairCost(reach, 0, reach))
  }
  assert.equal(pairCost(0, 0, reach), 0)
  // The cost rises with the gap up to the reach: half the stiffness times the squared gap at first.
  assert.ok(Math.abs(pairCost(0.001, 0, reach) - 0.5 * 5 * 0.001 ** 2) < 1e-15)
  assert.ok(pairCost(0.01, 0, reach) > pairCost(0.005, 0, reach))
  assert.ok(pairCost(0.02, 0, reach) > pairCost(0.015, 0, reach))
  // With a reach of 0, the penalty is off.
  assert.equal(Math.abs(pairPull(0.001, 0, 0)), 0)
  assert.equal(pairCost(0.001, 0, 0), 0)
})

// The top, the bottom and the two sides of each output rectangle, by the slot of the target that it is paired with.
function outputEdges(machine: ReturnType<typeof createTrainableGeometryMachine>, values: Float32Array) {
  const {targetItems, outputByTarget} = machine.match(values)
  const edges = new Map<number, {left: number, top: number, right: number, bottom: number}>()
  for (let index = 0; index < targetItems.length; index++) {
    const start = outputByTarget[index]! * trainableGeometryField.size
    const read = (field: number) => values[machine.geometries[start + field]!]!
    const left = read(trainableGeometryField.left)
    const top = read(trainableGeometryField.top)
    edges.set(targetItems[index]!, {left, top, right: left + read(trainableGeometryField.width), bottom: top + read(trainableGeometryField.height)})
  }
  return edges
}

test('the penalty pulls output edges within its reach onto one line, and leaves the others', () => {
  // Three rectangles side by side. The tops of the first two are 0.012 apart, and the third's is 0.05 below the
  // first's. All three bottoms are 0.6 or more apart.
  const drawn: TrainableGeometry[] = [
    {left: 0.05, top: 0.1, width: 0.25, height: 0.2},
    {left: 0.375, top: 0.112, width: 0.25, height: 0.4},
    {left: 0.7, top: 0.15, width: 0.25, height: 0.75},
  ]
  function fit(reach: number) {
    const machine = createTrainableGeometryMachine(createTrainableGeometryTarget(drawn))
    machine.setPenaltyReach(reach, reach)
    // The page's frames of 10 steps, for 2,000 steps.
    let result = machine.trainOrUndo(10)
    for (let frame = 1; frame < 200; frame++) result = machine.trainOrUndo(10)
    return {result, edges: outputEdges(machine, result.values)}
  }
  // Without the penalty the outputs are where the target is: the loss is its first part alone and near 0.
  const plain = fit(0)
  assert.equal(plain.result.misalignment, 0)
  assert.equal(plain.result.loss, plain.result.fromTarget)
  assert.ok(plain.result.loss < 1e-8, `loss ${plain.result.loss}`)
  assert.ok(Math.abs(plain.edges.get(1)!.top - plain.edges.get(0)!.top - 0.012) < 0.0005)
  // With a reach of 0.02 the first two tops are on one line, at the mean of where they are drawn, since the
  // penalty reads only the outputs and pulls both edges equally. The third top is beyond the reach and stays.
  const pulled = fit(0.02)
  const tops = [0, 1, 2].map(slot => pulled.edges.get(slot)!.top)
  assert.ok(Math.abs(tops[0]! - tops[1]!) < 0.0001, `the two tops are ${Math.abs(tops[0]! - tops[1]!)} apart`)
  assert.ok(Math.abs(tops[0]! - 0.106) < 0.0005, `the line is at ${tops[0]}`)
  assert.ok(Math.abs(tops[2]! - 0.15) < 0.0005, `the third top is at ${tops[2]}`)
  // No other edge moved: lefts and rights are 0.3 apart, and the bottoms 0.2 and more.
  for (const slot of [0, 1, 2]) {
    const edges = pulled.edges.get(slot)!
    const geometry = drawn[slot]!
    assert.ok(Math.abs(edges.left - geometry.left) < 0.0005)
    assert.ok(Math.abs(edges.right - geometry.left - geometry.width) < 0.0005)
    assert.ok(Math.abs(edges.bottom - geometry.top - geometry.height) < 0.0005)
  }
  // The loss rests where its two parts balance: the first part is what the two held edges cost, each 0.006 from
  // where it is drawn, as a mean over the 12 edges, and the second part is near 0, since the gap is closed.
  assert.ok(Math.abs(pulled.result.fromTarget - 2 * 0.5 * 0.006 ** 2 / 12) < 5e-7, `distance from the target ${pulled.result.fromTarget}`)
  assert.ok(pulled.result.misalignment < 1e-8, `penalty ${pulled.result.misalignment}`)
  assert.equal(pulled.result.loss, pulled.result.fromTarget + pulled.result.misalignment)
  // The penalty's strength of 2 sets how far a target can be from its line before the edge lets go: 2 reaches.
  // With a reach of 0.005 the two tops, 0.012 apart, are left as drawn.
  assert.equal(penaltyStrength, 2)
  const apart = fit(0.005)
  assert.ok(Math.abs(apart.edges.get(1)!.top - apart.edges.get(0)!.top - 0.012) < 0.0005)
}, 30_000)

test('the multipliers grow by the training step: a look at the outputs between frames changes nothing', () => {
  // Two rectangles whose tops are 0.012 apart, within the penalty's reach of 0.02, so the pair's multiplier grows
  // while the gap closes, and a third one out of reach.
  const drawn: TrainableGeometry[] = [
    {left: 0.05, top: 0.1, width: 0.25, height: 0.2},
    {left: 0.375, top: 0.112, width: 0.25, height: 0.4},
    {left: 0.7, top: 0.15, width: 0.25, height: 0.75},
  ]
  function fit(evaluationsPerFrame: number) {
    const machine = createTrainableGeometryMachine(createTrainableGeometryTarget(drawn))
    machine.setPenaltyReach(0.02, 0.02)
    let result = machine.evaluate()
    for (let frame = 0; frame < 120; frame++) {
      // The page evaluates in a frame that changes the sketch and trains no step, e.g. on a display so fast that
      // a frame's time holds less than two steps. Such a frame is a frame of no steps, and grows no multiplier.
      for (let evaluation = 0; evaluation < evaluationsPerFrame; evaluation++) machine.evaluate()
      result = machine.trainOrUndo(10)
    }
    return {source: [...machine.source], result, edges: outputEdges(machine, result.values)}
  }
  const plain = fit(0)
  // The penalty came on, and the two tops are on one line.
  assert.ok(plain.result.misalignment > 0)
  assert.ok(Math.abs(plain.edges.get(0)!.top - plain.edges.get(1)!.top) < 0.0001)
  assert.deepEqual(fit(3).source, plain.source)
})

test('a rectangle added in the slot of a deleted one starts without the deleted one\'s multipliers', () => {
  const reach = defaultHoldDistance / penaltyStrength
  function run(clearBeforeDelete: boolean) {
    const machine = createLearnedGalleryMachine('contact')
    const outputs = new Uint8Array(learnedSlotCount)
    outputs.fill(1, 0, machine.activeCount())
    machine.target.outputs = outputs
    machine.setPenaltyReach(reach, reach * 5 / 4)
    // Off and on again with an evaluation between: with a reach of 0, the evaluation sets the multiplier of
    // every pair of rectangles that the sketch has to 0, and it takes no step.
    function clearMultipliers() {
      machine.setPenaltyReach(0, 0)
      machine.evaluate()
      machine.setPenaltyReach(reach, reach * 5 / 4)
    }
    for (let frame = 0; frame < 100; frame++) machine.trainOrUndo(10)
    // Rectangle 5, in the second row, goes 0.035 of the stage down, which is within the distance at which a
    // photo lets go, 0.05 of the height. Its photo stays in the row, held by the multipliers of its pairs.
    const held = targetGeometry(machine, 5)
    machine.setTargetGeometry(5, {...held, top: held.top + 0.035})
    let result = machine.trainOrUndo(10)
    for (let frame = 1; frame < 60; frame++) result = machine.trainOrUndo(10)
    assert.ok(lineSpread(machine, result.values, [4, 5, 6, 7], 'top') < 0.0001)
    if (clearBeforeDelete) clearMultipliers()
    // Delete it as the page does: the photo that it was paired with goes with it.
    const {targetItems, outputByTarget} = machine.match(result.values)
    const photo = outputByTarget[targetItems.indexOf(5)]!
    machine.removeTargetGeometry(5)
    outputs[photo] = 0
    clearMultipliers()
    // A rectangle in the same place takes the slot and the photo.
    assert.equal(machine.addTargetGeometry({...held, top: held.top + 0.035}), 5)
    outputs[photo] = 1
    for (let frame = 0; frame < 30; frame++) machine.trainOrUndo(10)
    return [...machine.source]
  }
  // In the first run the deleted rectangle's pairs still have their multipliers when it is deleted, and in the
  // second they are 0 before. Both runs train the same from there, so the delete left no multiplier behind.
  assert.deepEqual(run(false), run(true))
}, 30_000)

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
// The largest value of the page's "Misalignment penalty" slider, as a fraction of the stage's width. The page's
// markup has it, in percent.
const sliderMarkup = /<input id="learning-penalty"[^>]* max="([0-9.]+)"/.exec(readFileSync(new URL('./learned-gallery.html', import.meta.url), 'utf8'))
assert.ok(sliderMarkup !== null, 'the page has no slider')
const maximumHoldDistance = Number(sliderMarkup[1]) / 100

function createEditorDriver(frameMs = 1000 / 60, readClock?: () => number) {
  let readings = 0
  const editor = createLearnedGalleryEditor(readClock ?? (() => readings++ * 0.01))
  let time = 0
  // Where the page's "Misalignment penalty" slider is, as a fraction of the stage's width. A frame reads it like
  // the stage's size.
  let holdDistance = defaultHoldDistance
  let frameCount = 0
  function frame(inputs: LearnedGalleryInput[] = []) {
    // No test takes more than about 1,500 frames. The limit makes training that never stops fail a test, where
    // a loop that waits for training to stop would otherwise never return.
    assert.ok(++frameCount <= 6000, 'more than 6,000 frames: training did not stop')
    time += frameMs
    return editor.frame(time, stageWidth, stageHeight, holdDistance, inputs)
  }
  return {
    editor,
    machine: editor.machine,
    frame,
    // Moves the slider. The next frame reads it.
    setHoldDistance(distance: number) {
      holdDistance = distance
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

// A rough drag or resize as a visitor makes it: a press in the rectangle's middle, or 5 px inside its bottom right
// corner, then 12 moves and a release. Returns the step count before the last move, which is the change that the
// edit's training starts from.
function roughEdit(page: ReturnType<typeof createEditorDriver>, item: number, byCorner: boolean, right: number, down: number) {
  const point = byCorner ? pointOf(page.machine, item, 1, 1) : pointOf(page.machine, item)
  const x = point.x - (byCorner ? 5 : 0)
  const y = point.y - (byCorner ? 5 : 0)
  page.frame([press(x, y)])
  let stepBeforeLastMove = 0
  for (let moveIndex = 1; moveIndex <= 12; moveIndex++) {
    stepBeforeLastMove = page.machine.trainingStep
    page.frame([move(x + right * moveIndex / 12, y + down * moveIndex / 12)])
  }
  page.frame([release])
  return stepBeforeLastMove
}

test('each preset sketch is fitted closely, with its photos in line, and training stops by itself', () => {
  for (const [name, count] of [['story', 10], ['cinema', 9], ['contact', 11]] as [LearnedLayoutName, number][]) {
    const page = createEditorDriver()
    const first = page.frame([{kind: 'layout', name}])
    assert.equal(first.layout, name)
    assert.equal(first.activeCount, count)
    // The first frame draws the seeded weights' output, before any step.
    assert.equal(first.step, 0)
    assert.ok(first.loss > 0.005, `${name} starts at loss ${first.loss}`)
    // The penalty is off while the photos leave the pile that the seeded weights put them in.
    assert.equal(first.misalignment, 0)
    let frame = page.frame()
    while (frame.step < 100) frame = page.frame()
    assert.equal(frame.misalignment, 0)
    assert.equal(frame.loss, frame.fromSketch)
    // It comes on once the photos are close to the sketch. Measured: it is positive from step 160, 150 and 180 on.
    while (frame.misalignment === 0) frame = page.frame()
    assert.ok(frame.step > 100 && frame.step < 400, `${name}: the penalty came on at step ${frame.step}`)
    assert.ok(frame.fromSketch < 2e-6, `${name}: the distance from the sketch was ${frame.fromSketch}`)
    const settled = page.settle()
    assert.equal(settled.training, false)
    // Measured: 679, 1,389 and 879 steps.
    assert.ok(settled.step >= trainingStepsAfterChange && settled.step < maximumTrainingStepsAfterChange, `${name} trained ${settled.step} steps`)
    // Story ends at a loss of 9.7e-8 with a largest error of 0.20% of the stage: the top of its second rectangle
    // rests 0.15% from where it is drawn, and its height takes that error with it. The other two end closer.
    assert.equal(settled.loss, settled.fromSketch + settled.misalignment)
    assert.ok(settled.loss < 0.000_000_3, `${name} loss ${settled.loss}`)
    assert.ok(largestError(page.machine, settled.values) < 0.003, `${name} error ${largestError(page.machine, settled.values)}`)
    // A preset's edges of one kind are equal or at least 0.09 apart, which is more than the penalty's largest
    // reach, so the penalty has nothing to move, and it is small at the end. Measured: 1.5e-8 for Cinema.
    assert.ok(settled.misalignment < 1e-7, `${name} penalty ${settled.misalignment}`)
    // Every line of the preset is a line of photos, within 0.03% of the stage, which is 0.2 px on a stage of
    // 620 px. Measured: 0.001% for Story, 0.020% for Cinema and 0.008% for Contact sheet.
    for (const line of sketchLines(page.machine)) {
      const spread = lineSpread(page.machine, settled.values, line.slots, line.edge)
      assert.ok(spread < 0.0003, `${name}: the ${line.edge} edges of rectangles ${line.slots.join(', ')} are ${spread} apart`)
    }
  }
})

test('a sketch that is fitted slowly still ends with its photos in line', () => {
  // Story with a large rectangle of 0.475 by 0.4 of the stage, where the preset's is 0.6 by 0.52. Its fit from the
  // seeded weights is slow: the photos are close enough to the sketch for the penalty after about 900 steps, where
  // the presets take 150 to 180, and training uses all of its 2,000 steps. With a fixed wait of 200 steps before
  // the penalty, this sketch ended with the tops of a row 2.5% of the stage apart after those 2,000 steps.
  const page = createEditorDriver()
  const {machine} = page
  page.frame()
  const heroWidth = 0.475
  const heroHeight = 0.4
  const marginX = 0.036
  const marginY = 0.045
  const cellWidth = (1 - marginX * 2 - 0.02 * 3) / 4
  const railHeight = (heroHeight - 0.025) / 2
  const rowHeight = (1 - marginY * 2 - heroHeight - 0.025 * 2) / 2
  const sketch: LearnedTargetGeometry[] = [{left: marginX, top: marginY, width: heroWidth, height: heroHeight}]
  for (let cell = 0; cell < 2; cell++) {
    sketch.push({left: marginX + heroWidth + 0.02, top: marginY + cell * (railHeight + 0.025), width: 1 - marginX * 2 - heroWidth - 0.02, height: railHeight})
  }
  for (let cell = 0; cell < 7; cell++) {
    sketch.push({left: marginX + cell % 4 * (cellWidth + 0.02), top: marginY + heroHeight + 0.025 + Math.floor(cell / 4) * (rowHeight + 0.025), width: cellWidth, height: rowHeight})
  }
  sketch.forEach((geometry, item) => machine.setTargetGeometry(item, geometry))
  let frame = page.frame([{kind: 'retrain'}])
  while (frame.step < 200) frame = page.frame()
  // Measured: the penalty comes on at step 909, and the lines end within 0.004% of the stage.
  assert.equal(frame.misalignment, 0)
  const settled = page.settle()
  assert.ok(settled.misalignment > 0)
  for (const line of sketchLines(machine)) {
    const spread = lineSpread(machine, settled.values, line.slots, line.edge)
    assert.ok(spread < 0.0003, `the ${line.edge} edges of rectangles ${line.slots.join(', ')} are ${spread} apart`)
  }
})

test('pointer moves over the sketch train nothing once training has settled', () => {
  const page = createEditorDriver()
  const settled = page.settle()
  for (let frameIndex = 0; frameIndex < 40; frameIndex++) {
    const frame = page.frame([move(40 + frameIndex * 5, 60 + frameIndex * 2, false, false)])
    assert.equal(frame.stepsThisFrame, 0)
    assert.equal(frame.training, false)
  }
  // The page before trained 10 steps at each of these moves.
  assert.equal(page.machine.trainingStep, settled.step)
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
  // Later frames train nothing either, e.g. at pointer moves, and "Retrain" has nothing to train.
  const stepsBefore = page.machine.trainingStep
  for (let frameIndex = 0; frameIndex < 10; frameIndex++) {
    frame = page.frame([move(100 + frameIndex, 100, false, false)])
    assert.equal(frame.training, false)
    assert.equal(frame.stepsThisFrame, 0)
  }
  assert.equal(page.machine.trainingStep, stepsBefore)
  const costBefore = frame.msPerStep
  frame = page.frame([{kind: 'retrain'}])
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
  // The number is the average over the latest training: "Retrain" starts a new average at its first step.
  const settled = page.settle()
  frame = page.frame([{kind: 'retrain'}])
  assert.equal(frame.msPerStep, settled.msPerStep)
  frame = page.frame()
  assert.ok(Math.abs(frame.msPerStep! - 0.01 / frame.stepsThisFrame) < 1e-9)
})

test('the numbers in the page\'s text are the code\'s', () => {
  // The description and the instructions are static text, so their numbers are written by hand.
  const html = readFileSync(new URL('./learned-gallery.html', import.meta.url), 'utf8')
  const {parameterCount} = createLearnedGalleryMachine()
  assert.ok(html.includes(`trains the network's ${parameterCount} weights`))
  assert.ok(html.includes(`empty space to add one, up to ${learnedPhotoCount}<`))
  // The slider is in percent of the stage's width: it starts where the editor starts, before the first frame
  // reads it. Half of its largest value, the penalty's largest reach, is below 0.09, the distance of a preset's
  // closest edges of one kind that aren't equal.
  assert.ok(html.includes(`<input id="learning-penalty" class="range" type="range" min="0" max="${maximumHoldDistance * 100}" step="0.5" value="${defaultHoldDistance * 100}">`))
  assert.ok(html.includes('<label class="label" for="learning-penalty">Misalignment penalty</label>'))
  assert.ok(maximumHoldDistance / penaltyStrength < 0.09)
  // The detail text's example is the slider as the page loads, and the penalty's reach there.
  assert.ok(html.includes(`at ${defaultHoldDistance * 100}%, edges closer than ${defaultHoldDistance / penaltyStrength * 100}% of the stage&rsquo;s width end on one line`))
  // The chart's label names its window of steps.
  assert.ok(html.includes(`over the latest ${chartStepCount.toLocaleString('en-US')} training steps`))
  // The numbers of the detail text are written by the page's script, into these elements.
  for (const id of ['learning-coefficients', 'learning-steps-after-change', 'learning-rest-steps', 'learning-steps-at-most', 'learning-steps-per-second', 'learning-operations', 'learning-layers']) {
    assert.ok(html.includes(`<b id="${id}"></b>`), `${id} is missing`)
  }
  // The detail text is closed as the page loads.
  assert.ok(html.includes('<details class="disclosure">'))
  assert.ok(html.includes('<summary>More detail</summary>'))
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
  // Measured: 2.8% of the stage at most. The photo stays in its row until the rectangle is about 5% of the
  // stage's height away, the slider's 4% of the width, and then follows.
  assert.ok(worstError < 0.06, `the dragged rectangle's photo was ${worstError} of the stage away`)

  frame = page.frame([release])
  assert.equal(frame.cursor, 'grab')
  // A reset at the release would put the loss back near 0.2, where the seeded weights start.
  assert.ok(frame.loss < 0.001, `loss at the release ${frame.loss}`)
  const final = page.settle()
  const steps = final.step - stepBeforeLastMove
  assert.ok(steps >= trainingStepsAfterChange && steps < maximumTrainingStepsAfterChange, `${steps} steps after the last move`)
  assert.equal(pairing(machine, final.values), pairingBefore)
  // The rectangle is far from every line now, so its photo is on it, and so is every other photo on its own.
  // Measured: the largest error is 0.27% of the stage, which is 1.3 px here.
  assert.ok(largestError(machine, final.values) < 0.005, `the largest error is ${largestError(machine, final.values)}`)
})

// The lines of the sketch: groups of two or more rectangles that have one edge at the same place, e.g. the tops of
// a row.
function sketchLines(machine: LearnedGalleryMachine) {
  const lines: {edge: 'left' | 'top' | 'right' | 'bottom', slots: number[]}[] = []
  const slots: number[] = []
  for (let slot = 0; slot < learnedSlotCount; slot++) {
    if (machine.target.active[slot] === 1) slots.push(slot)
  }
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    const position = (slot: number) => {
      const geometry = targetGeometry(machine, slot)
      return edge === 'left' ? geometry.left : edge === 'top' ? geometry.top : edge === 'right' ? geometry.left + geometry.width : geometry.top + geometry.height
    }
    const sorted = slots.toSorted((a, b) => position(a) - position(b))
    for (let lineStart = 0; lineStart < sorted.length;) {
      let lineEnd = lineStart + 1
      // The sketch's numbers are 32-bit floats, so two sums that are equal as drawn can differ in their last digits.
      while (lineEnd < sorted.length && position(sorted[lineEnd]!) - position(sorted[lineEnd - 1]!) < 1e-6) lineEnd++
      if (lineEnd - lineStart >= 2) lines.push({edge, slots: sorted.slice(lineStart, lineEnd)})
      lineStart = lineEnd
    }
  }
  return lines
}

// The left, top, right and bottom edges of the photos in use, in fractions of the stage.
function photoEdges(machine: LearnedGalleryMachine, values: Float32Array, outputs: Uint8Array) {
  const edges: number[] = []
  for (let output = 0; output < learnedSlotCount; output++) {
    if (outputs[output] !== 1) continue
    const geometry = outputGeometry(machine, values, output)
    edges.push(geometry.left, geometry.top, geometry.left + geometry.width, geometry.top + geometry.height)
  }
  return edges
}

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

// The mean of the photos' positions at one edge, for the given sketch rectangles.
function lineMean(machine: LearnedGalleryMachine, values: Float32Array, slots: readonly number[], edge: 'left' | 'top' | 'right' | 'bottom') {
  const {targetItems, outputByTarget} = machine.match(values)
  let sum = 0
  for (const slot of slots) {
    const geometry = outputGeometry(machine, values, outputByTarget[targetItems.indexOf(slot)]!)
    sum += edge === 'left' ? geometry.left : edge === 'top' ? geometry.top : edge === 'right' ? geometry.left + geometry.width : geometry.top + geometry.height
  }
  return sum / slots.length
}

test('a rectangle nudged within its row gets a photo that is in the row, and the row meets it', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'contact'}])
  const loaded = page.settle()
  // Contact sheet is 4 columns and 3 rows. Rectangle 5 is in the second row and the second column.
  const row = [4, 5, 6, 7]
  const column = [1, 5, 9]
  const rowTop = lineMean(machine, loaded.values, row, 'top')
  const columnLeft = lineMean(machine, loaded.values, column, 'left')
  // 6 px right and 6 px down on a stage of 500 by 400, i.e. 0.012 and 0.015 of the stage. The slider's 4% of the
  // width is 20 px, both ways.
  roughEdit(page, 5, false, 6, 6)
  let settled = page.settle()
  assert.equal(settled.layout, null)
  // The photo is on the lines of its row and its column, within 0.01% of the stage. Measured: 0.0006%.
  for (const edge of ['top', 'bottom'] as const) {
    assert.ok(lineSpread(machine, settled.values, row, edge) < 0.0001, `the row's ${edge}s are ${lineSpread(machine, settled.values, row, edge)} apart`)
  }
  for (const edge of ['left', 'right'] as const) {
    assert.ok(lineSpread(machine, settled.values, column, edge) < 0.0001, `the column's ${edge}s are ${lineSpread(machine, settled.values, column, edge)} apart`)
  }
  // The lines moved toward the rectangle: the penalty reads only the photos' edges, so it pulls every edge of a
  // line equally, and the line rests at the mean of where its rectangles are drawn. The row of 4 moved down by a
  // quarter of 0.015, and the column of 3 moved right by a third of 0.012.
  assert.ok(Math.abs(lineMean(machine, settled.values, row, 'top') - rowTop - 0.015 / 4) < 0.0003)
  assert.ok(Math.abs(lineMean(machine, settled.values, column, 'left') - columnLeft - 0.012 / 3) < 0.0003)
  // So the loss doesn't fall to 0: it rests where the cost of the photos' distance from the sketch balances the
  // penalty, whose own part is near 0 once the lines are closed. Measured: 6.0e-6 and 1.2e-11.
  assert.ok(settled.fromSketch > 1e-6, `the distance from the sketch is ${settled.fromSketch}`)
  assert.ok(settled.misalignment < 1e-8, `the penalty is ${settled.misalignment}`)

  // With the slider at off, the photos follow the sketch as it is drawn: training continues from the current
  // weights, and the photo ends on its rectangle, 0.015 of the stage below its row.
  page.setHoldDistance(0)
  let frame = page.frame()
  assert.equal(frame.training, true)
  assert.equal(frame.stepsThisFrame, 0)
  assert.equal(frame.layout, null)
  settled = page.settle()
  assert.equal(settled.misalignment, 0)
  assert.ok(settled.loss < 0.000_000_1, `the loss is ${settled.loss}`)
  assert.ok(largestError(machine, settled.values) < 0.001, `the largest error is ${largestError(machine, settled.values)}`)
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.015) < 0.001)
  assert.ok(Math.abs(lineSpread(machine, settled.values, column, 'left') - 0.012) < 0.001)

  // Back at 4%, the penalty's reach is 2% of the width, i.e. 10 px here, so the photo's edges, 6 px from their
  // lines, are pulled back onto them.
  page.setHoldDistance(defaultHoldDistance)
  page.frame()
  settled = page.settle()
  assert.ok(lineSpread(machine, settled.values, row, 'top') < 0.0001)
  assert.ok(lineSpread(machine, settled.values, column, 'left') < 0.0001)

  // At 1%, the reach is 2.5 px: the photo was on its lines, and its rectangle is 6 px from them, which is more
  // than the 5 px at which a photo lets go, so it ends on its rectangle.
  page.setHoldDistance(0.01)
  page.frame()
  settled = page.settle()
  assert.ok(largestError(machine, settled.values) < 0.001, `the largest error is ${largestError(machine, settled.values)}`)
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.015) < 0.001)
})

test('a photo joins a line at half the distance at which it lets go of one', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'contact'}])
  page.settle()
  const row = [4, 5, 6, 7]
  // 14 px down, i.e. 0.035 of the stage's height. The photo was in its row, and it lets go of the row when its
  // rectangle is the slider's distance away, 4% of the width or 20 px, so it stays.
  roughEdit(page, 5, false, 0, 14)
  let settled = page.settle()
  assert.ok(lineSpread(machine, settled.values, row, 'top') < 0.0001, `the row's tops are ${lineSpread(machine, settled.values, row, 'top')} apart`)
  // Off and on again: the photo starts on its rectangle now, 14 px from the row, and the penalty reaches 10 px,
  // half the slider's distance. So the same sketch at the same slider ends as drawn.
  page.setHoldDistance(0)
  page.frame()
  page.settle()
  page.setHoldDistance(defaultHoldDistance)
  page.frame()
  settled = page.settle()
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.035) < 0.001, `the row's tops are ${lineSpread(machine, settled.values, row, 'top')} apart`)
  assert.ok(largestError(machine, settled.values) < 0.001)
  // "Retrain" fits the sketch from the seeded weights with the penalty off at first, so it ends as drawn too.
  page.frame([{kind: 'retrain'}])
  settled = page.settle()
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.035) < 0.001)
})

test('a rectangle dragged far lets go of its line', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'contact'}])
  const loaded = page.settle()
  const row = [4, 5, 6, 7]
  const others = [4, 6, 7]
  const rowTop = lineMean(machine, loaded.values, row, 'top')
  // 30 px right and 30 px down, i.e. 0.06 and 0.075 of the stage, past the slider's 4% of the width, 20 px.
  roughEdit(page, 5, false, 30, 30)
  const settled = page.settle()
  // The photo is on its rectangle, and the row's other photos are in line where they were.
  assert.ok(largestError(machine, settled.values) < 0.001, `the largest error is ${largestError(machine, settled.values)}`)
  assert.ok(Math.abs(lineSpread(machine, settled.values, row, 'top') - 0.075) < 0.001)
  assert.ok(lineSpread(machine, settled.values, others, 'top') < 0.0001)
  assert.ok(Math.abs(lineMean(machine, settled.values, others, 'top') - rowTop) < 0.0005)
  // The loss is near 0 again, since no photo is held off its rectangle.
  assert.ok(settled.loss < 0.000_000_1, `the loss is ${settled.loss}`)
})

test('a move of the slider continues training, and a preset stays as it is drawn', () => {
  const page = createEditorDriver()
  const loaded = page.settle()
  assert.equal(loaded.layout, 'story')
  const loadedPhotos = [...loaded.values]
  // Story's edges of one kind are equal or at least 0.09 apart, and the penalty reaches 0.04 at most.
  for (const distance of [maximumHoldDistance, 0, 0.025, defaultHoldDistance]) {
    page.setHoldDistance(distance)
    let frame = page.frame()
    // The loss changed, so training continues from the current weights.
    assert.equal(frame.training, true)
    assert.equal(frame.stepsThisFrame, 0)
    // The slider doesn't edit the sketch, so the preset stays marked.
    assert.equal(frame.layout, 'story')
    const stepsBefore = frame.step
    frame = page.settle()
    assert.ok(frame.step - stepsBefore >= trainingStepsAfterChange)
    assert.equal(frame.layout, 'story')
    // No photo moves by more than 0.2% of the stage. Measured: 0.10% at off, where Story's fit is closer: its
    // largest edge error is 0.07% of the stage there, against 0.15% with the penalty on.
    const largestMove = Math.max(...page.machine.geometries.slice(0, 10 * learnedGeometryField.size).map(wire => Math.abs(frame.values[wire]! - loadedPhotos[wire]!)))
    assert.ok(largestMove < 0.002, `at ${distance}, a photo moved by ${largestMove} of the stage`)
  }
})

test('a change gets 500 steps, and more until the photos rest, up to 2,000', () => {
  // Until the 500 steps are over, photos at rest don't end training: the steps left are the ones up to 2,000.
  assert.equal(trainingStepsLeft(0, true), maximumTrainingStepsAfterChange)
  assert.equal(trainingStepsLeft(trainingStepsAfterChange - 1, true), maximumTrainingStepsAfterChange - trainingStepsAfterChange + 1)
  // After them, photos at rest end training, and photos that still move get the steps that are left of 2,000.
  assert.equal(trainingStepsLeft(trainingStepsAfterChange, true), 0)
  assert.equal(trainingStepsLeft(trainingStepsAfterChange, false), maximumTrainingStepsAfterChange - trainingStepsAfterChange)
  assert.equal(trainingStepsLeft(maximumTrainingStepsAfterChange - 10, false), 10)
  assert.equal(trainingStepsLeft(maximumTrainingStepsAfterChange, false), 0)
  assert.equal(trainingStepsLeft(maximumTrainingStepsAfterChange + 7, false), 0)
})

test('training stops once no photo has moved for 100 steps', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'cinema'}])
  page.settle()
  // Rough edits of Cinema's small rectangles, as [rectangle, by its corner, px right, px down].
  const edits = [[2, false, -9.9, 8.2], [6, false, 11.7, 4.6], [2, false, 2.0, -9.1], [4, false, -6.7, 12.6], [6, true, -8.4, -9.4], [6, false, 9.7, -9.3]] as const
  let longest = 0
  for (const [item, byCorner, right, down] of edits) {
    const stepBeforeLastMove = roughEdit(page, item, byCorner, right, down)
    // The photos' edges after every frame of the edit's training, in fractions of the stage.
    const edgesByStep: {step: number, edges: number[]}[] = []
    let frame = page.frame()
    while (frame.training) {
      frame = page.frame()
      edgesByStep.push({step: frame.step, edges: [...photoEdges(machine, frame.values, frame.outputs)]})
    }
    const steps = frame.step - stepBeforeLastMove
    longest = Math.max(longest, steps)
    assert.ok(steps >= trainingStepsAfterChange && steps <= maximumTrainingStepsAfterChange + maximumTrainingStepsPerFrame, `${steps} steps`)
    // Unless the edit used all of its steps, no photo edge moved more than restDistance over the last restSteps.
    if (steps < maximumTrainingStepsAfterChange) {
      const last = edgesByStep.at(-1)!
      for (const earlier of edgesByStep) {
        if (earlier.step < last.step - restSteps) continue
        const moved = Math.max(...earlier.edges.map((edge, index) => Math.abs(edge - last.edges[index]!)))
        assert.ok(moved <= restDistance + 1e-7, `a photo edge moved ${moved} of the stage in the last ${last.step - earlier.step} steps`)
      }
      // One frame earlier, the photos hadn't rested for that long yet.
      assert.ok(edgesByStep.length >= restSteps / 10)
    }
    // Later frames train nothing, e.g. at pointer moves.
    frame = page.frame([move(40, 60, false, false)])
    assert.equal(frame.stepsThisFrame, 0)
    assert.equal(frame.training, false)
    assert.equal(machine.trainingStep, frame.step)
  }
  // Measured: the longest of the six trainings is 1,950 steps.
  assert.ok(longest > trainingStepsAfterChange + 50, `the longest training was ${longest} steps`)
}, 30_000)

test('photos that stood still for 100 steps and then move again are not at rest', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.settle()
  // Story without its first small rectangle of the lower rows, and then a rectangle added in the lower left.
  const point = pointOf(machine, 3)
  page.frame([press(point.x, point.y), release])
  page.frame([{kind: 'delete'}])
  page.settle()
  const stepBefore = machine.trainingStep
  let frame = page.frame([press(136, 276), release])
  assert.equal(frame.selected, 3)
  // The rule for rest, replayed from the photos' edges after each frame: restStep is the step of the edges that
  // no photo has moved more than restDistance from since.
  let restEdges = photoEdges(machine, frame.values, frame.outputs)
  let restStep = frame.step
  let movedAfterEarlyRest = false
  while (frame.training) {
    frame = page.frame()
    const edges = photoEdges(machine, frame.values, frame.outputs)
    if (Math.max(...edges.map((edge, index) => Math.abs(edge - restEdges[index]!))) > restDistance) {
      // A move after restSteps steps of rest, while the edit's first 500 steps are still running.
      if (frame.step - restStep >= restSteps && frame.step - stepBefore < trainingStepsAfterChange) movedAfterEarlyRest = true
      restEdges = edges
      restStep = frame.step
    }
  }
  // Measured: the photos stand still from step 239 to step 339 of the edit and from there to step 479, while
  // frames are taken back, and training stops after 579 steps, 100 steps after the last move. With a rest that
  // counted for good, it stopped after 509 steps, 30 steps after that move.
  assert.ok(movedAfterEarlyRest, 'the photos did not stand still and move again within the first 500 steps')
  assert.ok(frame.step - stepBefore < maximumTrainingStepsAfterChange)
  assert.ok(frame.step - restStep >= restSteps, `training stopped ${frame.step - restStep} steps after a photo last moved`)
})

test('with the slider at off, the loss never rises in a frame where the sketch stays the same', () => {
  const page = createEditorDriver()
  const {machine} = page
  page.frame([{kind: 'layout', name: 'cinema'}])
  // With the penalty off, what a frame's steps follow is the loss itself.
  page.setHoldDistance(0)
  page.settle()
  // Six rough drags in a row, each followed by its training, as a visitor who rearranges the sketch makes them.
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
      assert.equal(frame.misalignment, 0)
      assert.ok(frame.loss <= lossBefore, `after drag ${index + 1}, a frame raised the loss from ${lossBefore} to ${frame.loss}`)
    }
  }
  // Each drag's last move starts 500 steps or more, about 50 frames.
  assert.ok(framesWithoutChange >= 6 * 48, `${framesWithoutChange} frames`)
})

test('a photo follows its rectangle from the first frames of a drag, also after a rest', () => {
  for (const name of ['story', 'cinema'] as const) {
    const page = createEditorDriver()
    const {machine} = page
    page.frame([{kind: 'layout', name}])
    // With the slider at off, a photo has only its rectangle to follow, and no line to stay on.
    page.setHoldDistance(0)
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
    // Measured: the photo is at most 0.6% of the stage behind, about 3 px, and no other photo moves by more than
    // 0.3%. With the full learning rate at every change of the sketch, each frame's steps were taken back, and
    // the photo stood still for the whole drag, 13% behind at its end. With plain steps in the frames of a change,
    // the first one threw the other photos up to 48% of the stage off.
    assert.ok(largestLag < 0.015, `${name}: the photo was ${largestLag} of the stage behind its rectangle`)
    assert.ok(largestOtherMove < 0.015, `${name}: another photo moved by ${largestOtherMove} of the stage`)
  }
}, 30_000)

test('training takes as many steps per second at 120 Hz as at 60 Hz, and ends the same', () => {
  const stepsAfterHalfASecond: number[] = []
  const stepsAtTheEnd: number[] = []
  const rowTops: number[] = []
  for (const framesPerSecond of [60, 120]) {
    const page = createEditorDriver(1000 / framesPerSecond)
    const {machine} = page
    // The first frame starts the training's clock, the second measures the cost of a step with at most 4 steps, and
    // the third makes up for the second.
    assert.equal(page.frame([{kind: 'layout', name: 'contact'}]).stepsThisFrame, 0)
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
    const loaded = page.settle()
    // A rectangle nudged 6 px down, as in the test above: both displays end with the row in line, a quarter of
    // the nudge down.
    const row = [4, 5, 6, 7]
    const stepBeforeLastMove = roughEdit(page, 5, false, 0, 6)
    const settled = page.settle()
    assert.ok(lineSpread(machine, settled.values, row, 'top') < 0.0001, `at ${framesPerSecond} Hz the row's tops are ${lineSpread(machine, settled.values, row, 'top')} apart`)
    rowTops.push(lineMean(machine, settled.values, row, 'top') - lineMean(machine, loaded.values, row, 'top'))
    stepsAtTheEnd.push(settled.step - stepBeforeLastMove)
  }
  // The first frame takes no step, so half a second holds 600 / 2 steps minus one frame's.
  assert.ok(Math.abs(stepsAfterHalfASecond[0]! - 290) <= 1)
  assert.ok(Math.abs(stepsAfterHalfASecond[1]! - 295) <= 1)
  // The row moved down by a quarter of the nudge on both, 0.015 / 4 of the stage.
  assert.ok(Math.abs(rowTops[0]! - 0.015 / 4) < 0.0003 && Math.abs(rowTops[1]! - 0.015 / 4) < 0.0003, `the row moved by ${rowTops[0]} and ${rowTops[1]}`)
  // Training lasts about as long on both. Measured: 509 and 501 steps.
  assert.ok(Math.abs(stepsAtTheEnd[0]! - stepsAtTheEnd[1]!) <= 200, `${stepsAtTheEnd[0]} steps at 60 Hz and ${stepsAtTheEnd[1]} at 120 Hz`)
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
  // The frames after the pause catch up at the cap, and training still stops by itself.
  assert.ok(frame.step >= trainingStepsAfterChange && frame.step < maximumTrainingStepsAfterChange, `${frame.step} steps`)
  assert.equal(frameCount, Math.ceil((frame.step - stepsBeforePause) / maximumTrainingStepsPerFrame))
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
  // Training takes more frames instead of longer frames: 2 steps per frame after the first 4, and it stops by
  // itself, as with 10 steps per frame.
  assert.ok(frame.step >= trainingStepsAfterChange && frame.step < maximumTrainingStepsAfterChange, `${frame.step} steps`)
  assert.equal(frameCount, 2 + (frame.step - unmeasuredTrainingStepsPerFrame) / 2)
})

test('a frame trains two steps or none, and the photos end in line where the budget or the time holds one step', () => {
  // A device where one step takes 5 ms, so the budget of 6 ms holds one step: a frame trains two. With one step
  // per frame, Contact sheet's first fit stopped after 529 steps with a line of photos 0.09% of the stage apart:
  // the last 100 frames were all taken back, so the photos stood still and counted as at rest.
  const msPerStep = 5
  const holder: {machine: LearnedGalleryMachine | null} = {machine: null}
  const slow = createEditorDriver(1000 / 60, () => (holder.machine?.trainingStep ?? 0) * msPerStep)
  holder.machine = slow.machine
  slow.frame([{kind: 'layout', name: 'contact'}])
  let frame = slow.frame()
  assert.equal(frame.stepsThisFrame, unmeasuredTrainingStepsPerFrame)
  while (frame.training) {
    frame = slow.frame()
    assert.equal(frame.stepsThisFrame, minimumTrainingStepsPerFrame)
  }
  // Measured: 874 steps, and the lines of photos within 0.007% of the stage.
  for (const line of sketchLines(slow.machine)) {
    const spread = lineSpread(slow.machine, frame.values, line.slots, line.edge)
    assert.ok(spread < 0.0003, `the ${line.edge} edges of rectangles ${line.slots.join(', ')} are ${spread} apart`)
  }
  // A rectangle nudged 6 px down ends in its row, and the row a quarter of the nudge down.
  const row = [4, 5, 6, 7]
  const rowTop = lineMean(slow.machine, frame.values, row, 'top')
  roughEdit(slow, 5, false, 0, 6)
  frame = slow.settle()
  assert.ok(lineSpread(slow.machine, frame.values, row, 'top') < 0.0001, `the row's tops are ${lineSpread(slow.machine, frame.values, row, 'top')} apart`)
  assert.ok(Math.abs(lineMean(slow.machine, frame.values, row, 'top') - rowTop - 0.015 / 4) < 0.0003)

  // A 500 Hz display, where a frame's 2 ms hold 1.2 steps: a frame trains no step until the time holds two, so
  // training still takes 600 steps a second.
  const fast = createEditorDriver(1000 / 500)
  fast.frame([{kind: 'layout', name: 'contact'}])
  frame = fast.frame()
  let frameCount = 2
  let framesWithoutSteps = 0
  while (frame.training) {
    frame = fast.frame()
    frameCount++
    if (frame.stepsThisFrame === 0) framesWithoutSteps++
    assert.notEqual(frame.stepsThisFrame, 1)
    if (frameCount === 250) assert.ok(Math.abs(frame.step - 300) <= 3, `${frame.step} steps in half a second`)
  }
  assert.ok(framesWithoutSteps > frameCount / 3, `${framesWithoutSteps} of ${frameCount} frames trained no step`)
  for (const line of sketchLines(fast.machine)) {
    const spread = lineSpread(fast.machine, frame.values, line.slots, line.edge)
    assert.ok(spread < 0.0003, `the ${line.edge} edges of rectangles ${line.slots.join(', ')} are ${spread} apart`)
  }
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
  // Both new photos went to their rectangles: each is within the slider's distance of it, 5% of the stage's
  // height, where it may be held on a line with other photos. Measured: 0.7% at most.
  assert.ok(largestError(page.machine, settled.values) < 0.05, `the largest error is ${largestError(page.machine, settled.values)}`)
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

test('a preset and "Retrain" start over from the seeded weights', () => {
  const page = createEditorDriver()
  const {machine} = page
  const first = page.settle()
  const firstPhotos = [...first.values]
  const cell = pointOf(machine, 3)
  page.frame([press(cell.x, cell.y), move(cell.x + 60, cell.y - 90), release])
  const edited = page.settle()
  assert.equal(edited.layout, null)
  assert.ok(edited.step > first.step)

  // "Retrain" keeps the edited sketch and fits it from the seeded weights.
  let frame = page.frame([{kind: 'retrain'}])
  assert.equal(frame.step, 0)
  assert.deepEqual([...machine.source], [...machine.initialSource])
  assert.equal(frame.history.length, 1)
  assert.equal(frame.layout, null)
  // The penalty is off again until the photos are close to the sketch.
  assert.equal(frame.misalignment, 0)
  // The steps of each frame until training stops, e.g. 10, 10, 9, 10.
  const stepsPerFrame: number[] = []
  while (frame.training) {
    frame = page.frame()
    stepsPerFrame.push(frame.stepsThisFrame)
  }
  const again = frame
  assert.ok(again.step >= trainingStepsAfterChange && again.step < maximumTrainingStepsAfterChange)
  // The same sketch from the same weights, trained in the same frames with the same penalty, ends at the same loss.
  const fromSeed = createLearnedGalleryMachine()
  fromSeed.target.geometries.set(machine.target.geometries)
  fromSeed.target.active.set(machine.target.active)
  fromSeed.target.outputs = machine.target.outputs!
  fromSeed.setPenaltyReach(defaultHoldDistance / penaltyStrength, defaultHoldDistance / penaltyStrength * 5 / 4)
  let fromSeedLoss = fromSeed.evaluate().loss
  for (const steps of stepsPerFrame) fromSeedLoss = fromSeed.trainOrUndo(steps).loss
  assert.equal(again.loss, fromSeedLoss)

  // A preset replaces the sketch and starts over too. Its frames hold other steps than the page's first frames
  // did, e.g. 10 where the first frame after the page loads holds 4, so the photos end within 0.05% of the stage
  // of where the first fit put them, and not at the very same numbers.
  frame = page.frame([{kind: 'layout', name: 'story'}])
  assert.equal(frame.step, 0)
  assert.equal(frame.layout, 'story')
  assert.equal(frame.selected, null)
  const story = page.settle()
  const largestDifference = Math.max(...machine.geometries.slice(0, 10 * learnedGeometryField.size).map(wire => Math.abs(story.values[wire]! - firstPhotos[wire]!)))
  assert.ok(largestDifference < 0.0005, `a photo is ${largestDifference} of the stage from where the first fit put it`)

  // In the middle of training too, the frame of the restart shows the seeded weights' output, at step 0.
  page.frame([{kind: 'layout', name: 'cinema'}])
  for (let frameIndex = 0; frameIndex < 10; frameIndex++) page.frame()
  frame = page.frame([{kind: 'retrain'}])
  assert.equal(frame.step, 0)
  assert.equal(frame.stepsThisFrame, 0)
  assert.deepEqual(frame.history, [{step: 0, fromSketch: frame.loss, misalignment: 0}])
  assert.ok(page.settle().step >= trainingStepsAfterChange)
}, 30_000)

test('the loss chart gets one sample per frame of training, with the loss\'s two parts, for the latest 1,000 steps', () => {
  const page = createEditorDriver()
  let frame = page.frame()
  assert.deepEqual(frame.history, [{step: 0, fromSketch: frame.loss, misalignment: 0}])
  frame = page.settle()
  assert.equal(frame.history[0]!.step, 0)
  assert.equal(frame.history.at(-1)!.step, frame.step)
  assert.equal(frame.history.at(-1)!.fromSketch, frame.fromSketch)
  assert.equal(frame.history.at(-1)!.misalignment, frame.misalignment)
  // About one sample per 10 steps.
  assert.ok(Math.abs(frame.history.length - frame.step / 10) <= 3, `${frame.history.length} samples for ${frame.step} steps`)
  assert.ok(frame.history.every((sample, index) => index === 0 || sample.step > frame.history[index - 1]!.step))
  // The distance from the sketch falls by more than four powers of ten, which is why the chart's axis is
  // logarithmic.
  assert.ok(frame.history[0]!.fromSketch / frame.fromSketch > 10_000)
  // The penalty is 0 in the first samples, where the chart draws no line for it, and positive later.
  assert.equal(frame.history[5]!.misalignment, 0)
  assert.ok(frame.history.some(sample => sample.misalignment > 0))

  // After edits whose training takes the count past 1,000 steps, the samples start where the chart starts: one
  // sample at or before the first of the latest 1,000 steps, and the others after it.
  const cell = pointOf(page.machine, 3)
  page.frame([press(cell.x, cell.y), move(cell.x + 60, cell.y - 90), release])
  page.settle()
  page.frame([press(cell.x + 60, cell.y - 90), move(cell.x, cell.y), release])
  frame = page.settle()
  assert.ok(frame.step > chartStepCount + 500)
  const firstChartStep = frame.step - chartStepCount
  assert.ok(frame.history[0]!.step <= firstChartStep)
  assert.ok(frame.history[1]!.step > firstChartStep)
})
