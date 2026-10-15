import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine, photoFocusSourceField, windowOutputField} from '../../src/handwiredos/window-manager.ts'
import {arrangePrismWindows} from '../../src/prismos/arrangement.ts'
import {itemCount, photoField} from '../../src/handwiredos/photo-gallery.ts'

test('queued gallery pages reset focus and springs, hide empty slots and wrap within occupied slots', () => {
  const machine = createWindowManagerMachine()
  arrangePrismWindows(machine.source, machine.cells, 1280, 800)
  let time = 0
  const step = () => { time += 16; machine.step(1280, 800, time) }
  step()
  // Bring Chroma to the front by a press on its title bar.
  const offset = 2 * windowOutputField.size
  const x = machine.values[machine.output.windows[offset + windowOutputField.translateX]!]! + 50
  const y = machine.values[machine.output.windows[offset + windowOutputField.translateY]!]! + 20
  machine.pointerDown(x, y); machine.pointerUp(x, y); step()
  for (const count of [0, 1, 12, 1, 12, 1]) {
    machine.photoPage(count, count === 0 ? -1 : count - 1, 36)
    step()
    for (let index = count; index < itemCount; index++) {
      assert.equal(machine.source[photoFocusSourceField(index)], 0)
      assert.equal(machine.values[machine.output.photos.photos[index * photoField.size + photoField.opacity]!], 0)
    }
    if (count > 0) {
      machine.photoNext(); step(); assert.equal(machine.source[photoFocusSourceField(0)], 1)
      machine.photoPrevious(); step(); assert.equal(machine.source[photoFocusSourceField(count - 1)], 1)
    }
  }
  assert.throws(() => machine.photoPage(13))
  assert.throws(() => machine.photoPage(1, 1))
  assert.throws(() => machine.photoPage(1, 0, 100))
})
