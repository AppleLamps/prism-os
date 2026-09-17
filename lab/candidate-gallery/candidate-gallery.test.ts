import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createCandidateGalleryMachine,
  focusField,
  geometryField,
  layout,
  photoCount,
} from './candidate-gallery.ts'

type CandidateGalleryMachine = ReturnType<typeof createCandidateGalleryMachine>

function selectedLayout(machine: CandidateGalleryMachine, values: Float32Array) {
  return machine.output.selectedLayout.findIndex(wire => values[wire] === 1)
}

function geometry(
  values: Float32Array,
  output: readonly number[],
  item = 0,
) {
  const start = item * geometryField.size
  return {
    left: values[output[start + geometryField.left]!]!,
    top: values[output[start + geometryField.top]!]!,
    width: values[output[start + geometryField.width]!]!,
    height: values[output[start + geometryField.height]!]!,
  }
}

test('wide, balanced, and tall stages choose different complete layouts', () => {
  for (const [width, height, expectedLayout] of [
    [1400, 680, layout.cinema],
    [984, 730, layout.contact],
    [610, 830, layout.story],
  ] as const) {
    const machine = createCandidateGalleryMachine()
    const values = machine.step(width, height)
    const winner = selectedLayout(machine, values)

    assert.equal(winner, expectedLayout)
  }
})

test('Story takes over before the frame becomes extremely narrow', () => {
  const machine = createCandidateGalleryMachine()
  const balanced = machine.step(760, 517)
  assert.equal(selectedLayout(machine, balanced), layout.contact)

  const nearPortrait = machine.step(600, 517)
  assert.equal(selectedLayout(machine, nearPortrait), layout.story)
})

test('a chosen layout routes clicks back into the shared focus state', () => {
  const [width, height] = [1400, 680]
  const machine = createCandidateGalleryMachine()
  const values = machine.step(width, height)
  const target = geometry(values, machine.output.thumbnails, 7)
  machine.click(
    target.left + target.width / 2,
    target.top + target.height / 2,
  )
  const projectedValues = machine.step(width, height)

  for (let item = 0; item < photoCount; item++) {
    assert.equal(machine.source[focusField(item)], Number(item === 7))
  }
  assert.equal(projectedValues[machine.output.focus[7]!], 1)
})

test('hero layouts keep every thumbnail in a stable slot after focus changes', () => {
  for (const [width, height] of [
    [1400, 680],
    [600, 517],
  ] as const) {
    const machine = createCandidateGalleryMachine()
    const before = machine.step(width, height)
    const thumbnailGeometry = Array.from(
      {length: photoCount},
      (_, item) => geometry(before, machine.output.thumbnails, item),
    )
    const target = thumbnailGeometry[7]!
    machine.click(
      target.left + target.width / 2,
      target.top + target.height / 2,
    )
    const after = machine.step(width, height)

    for (let item = 0; item < photoCount; item++) {
      assert.deepEqual(
        geometry(after, machine.output.thumbnails, item),
        thumbnailGeometry[item],
      )
    }
    assert.equal(after[machine.output.focus[7]!], 1)
    assert.equal(after[machine.output.heroPresent], 1)
  }
})

test('candidate geometry remains finite and bounded at tiny sizes', () => {
  const machine = createCandidateGalleryMachine()
  for (const [width, height] of [
    [0, 0],
    [1, 1],
    [20, 300],
    [300, 20],
  ] as const) {
    const values = machine.step(width, height)
    for (let item = 0; item < photoCount; item++) {
      const thumbnail = geometry(values, machine.output.thumbnails, item)
      for (const value of Object.values(thumbnail)) {
        assert.ok(Number.isFinite(value))
        assert.ok(value >= 0)
      }
    }
    const hero = geometry(values, machine.output.hero)
    for (const value of Object.values(hero)) {
      assert.ok(Number.isFinite(value))
      assert.ok(value >= 0)
    }
  }
})
