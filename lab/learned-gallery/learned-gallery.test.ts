import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createLearnedGalleryMachine,
  learnedGeometryField,
  learnedSlotCount,
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
  assert.equal(item, 13)
  assert.equal(machine.activeCount(), initialCount + 1)
  machine.reset()
  assert.ok(Number.isFinite(machine.train(500).loss))

  machine.removeTargetGeometry(item)
  assert.equal(machine.activeCount(), initialCount)
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
