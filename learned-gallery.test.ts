import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createLearnedGalleryMachine,
  learnedGeometryField,
  learnedLayoutNames,
  type LearnedLayoutName,
} from './learned-gallery.ts'

type LearnedGalleryMachine = ReturnType<typeof createLearnedGalleryMachine>

function outputGeometry(
  machine: LearnedGalleryMachine,
  values: Float32Array,
  item: number,
) {
  const start = item * learnedGeometryField.size
  return {
    left: values[machine.output.geometries[start + learnedGeometryField.left]!]!,
    top: values[machine.output.geometries[start + learnedGeometryField.top]!]!,
    width: values[machine.output.geometries[start + learnedGeometryField.width]!]!,
    height: values[machine.output.geometries[start + learnedGeometryField.height]!]!,
  }
}

function targetGeometry(machine: LearnedGalleryMachine, item: number) {
  const start = item * learnedGeometryField.size
  return {
    left: machine.target.geometries[start + learnedGeometryField.left]!,
    top: machine.target.geometries[start + learnedGeometryField.top]!,
    width: machine.target.geometries[start + learnedGeometryField.width]!,
    height: machine.target.geometries[start + learnedGeometryField.height]!,
  }
}

function presentOutputItems(
  machine: LearnedGalleryMachine,
  values: Float32Array,
) {
  return machine.output.presence.flatMap((wire, item) =>
    values[wire]! > 0.5 ? [item] : [])
}

function activeTargetGeometries(machine: LearnedGalleryMachine) {
  const geometries: ReturnType<typeof targetGeometry>[] = []
  for (let item = 0; item < machine.target.active.length; item++) {
    if (machine.target.active[item] === 1) {
      geometries.push(targetGeometry(machine, item))
    }
  }
  return geometries
}

function replaceTarget(
  machine: LearnedGalleryMachine,
  slots: readonly number[],
  geometries: readonly ReturnType<typeof targetGeometry>[],
) {
  assert.equal(slots.length, geometries.length)
  machine.target.active.fill(0)
  machine.target.geometries.fill(0)
  for (let index = 0; index < slots.length; index++) {
    machine.setTargetGeometry(slots[index]!, geometries[index]!)
  }
}

test('backprop fits each rough rectangle sketch toward its gallery basis', () => {
  for (const [targetName, expectedWinner] of [
    ['cinema', 0],
    ['contact', 1],
    ['story', 2],
  ] as const satisfies readonly [LearnedLayoutName, number][]) {
    const machine = createLearnedGalleryMachine(targetName)
    const initial = machine.evaluate()
    const trained = machine.train(900)
    const weights = machine.output.weights.map(wire => trained.values[wire]!)
    const winner = weights.indexOf(Math.max(...weights))

    assert.equal(winner, expectedWinner, `${targetName} should fit ${learnedLayoutNames[expectedWinner]}`)
    assert.ok(trained.loss < initial.loss * 0.08)
    assert.ok(weights[expectedWinner]! > 0.85)
  }
})

test('rectangle identities do not affect the learned layout', () => {
  const machine = createLearnedGalleryMachine('cinema')
  const geometries = activeTargetGeometries(machine)
  const slots = geometries.map((_, item) => item)
  replaceTarget(machine, slots, geometries.toReversed())
  const trained = machine.train(900)
  const weights = machine.output.weights.map(wire => trained.values[wire]!)

  assert.ok(weights[0]! > 0.95)
  assert.ok(trained.loss < 1e-5)
  assert.equal(presentOutputItems(machine, trained.values).length, geometries.length)
})

test('sparse target slots still describe one unlabeled rectangle set', () => {
  const machine = createLearnedGalleryMachine('cinema')
  const geometries = activeTargetGeometries(machine)
  const slots = [0, 2, 5, 7, 9, 12, 13, 17, 19]
  replaceTarget(machine, slots, geometries.slice(0, slots.length).toReversed())
  const trained = machine.train(900)
  const weights = machine.output.weights.map(wire => trained.values[wire]!)

  assert.ok(weights[0]! > 0.95)
  assert.ok(trained.loss < 1e-5)
  assert.equal(presentOutputItems(machine, trained.values).length, slots.length)
})

test('reset restores the same initial fit and optimizer state', () => {
  const machine = createLearnedGalleryMachine()
  const initial = machine.evaluate()
  const initialSource = [...machine.source]
  machine.train(40)
  machine.reset()
  const reset = machine.evaluate()

  assert.equal(reset.step, 0)
  assert.equal(reset.loss, initial.loss)
  assert.deepEqual([...machine.source], initialSource)
})

test('an inaccurate dragged rectangle does not pull the learned grid apart', () => {
  const machine = createLearnedGalleryMachine()
  const clean = machine.train(900)
  const cleanGeometry = outputGeometry(machine, clean.values, 7)
  const target = {left: 0.62, top: 0.08, width: 0.25, height: 0.18}
  machine.setTargetGeometry(7, target)
  assert.equal(machine.trainingStep, 0)
  const trained = machine.train(900)
  const actual = outputGeometry(machine, trained.values, 7)
  const weights = machine.output.weights.map(wire => trained.values[wire]!)

  assert.ok(weights[2]! > 0.95)
  for (const field of Object.keys(target) as (keyof typeof target)[]) {
    assert.ok(Math.abs(actual[field] - cleanGeometry[field]) < 0.015)
    assert.ok(
      Math.abs(actual[field] - cleanGeometry[field])
        < Math.abs(actual[field] - target[field]),
    )
  }
})

test('adding and deleting rectangles changes learned presence without slot coupling', () => {
  const machine = createLearnedGalleryMachine()
  const initial = machine.train(900)
  const initialPresent = presentOutputItems(machine, initial.values)
  const target = {left: 0.72, top: 0.72, width: 0.2, height: 0.18}
  const item = machine.addTargetGeometry(target)
  assert.equal(item, 13)
  const added = machine.train(900)
  assert.equal(
    presentOutputItems(machine, added.values).length,
    initialPresent.length + 1,
  )

  machine.removeTargetGeometry(item)
  const removed = machine.train(600)
  assert.equal(presentOutputItems(machine, removed.values).length, initialPresent.length)

  assert.equal(machine.addTargetGeometry(target), item)
  const readded = machine.train(600)
  assert.equal(
    presentOutputItems(machine, readded.values).length,
    initialPresent.length + 1,
  )
})
