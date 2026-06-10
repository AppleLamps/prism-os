import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  createTrainableGeometryMachine,
  trainableGeometryField,
  type TrainableGeometry,
  type TrainableGeometryTarget,
} from './trainable-geometry.ts'

const slotCount = 20

function createTarget(geometries: readonly TrainableGeometry[]): TrainableGeometryTarget {
  const target = {
    geometries: new Float32Array(slotCount * trainableGeometryField.size),
    active: new Uint8Array(slotCount),
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

function createSidebarGrid() {
  const gap = 0.025
  const sidebarWidth = 0.3
  const cellWidth = (1 - sidebarWidth - gap * 4) / 3
  const cellHeight = (1 - gap * 5) / 4
  const geometries: TrainableGeometry[] = [{
    left: gap,
    top: gap,
    width: sidebarWidth,
    height: 1 - gap * 2,
  }]
  for (let item = 0; item < 11; item++) {
    const column = item % 3
    const row = Math.floor(item / 3)
    geometries.push({
      left: sidebarWidth + gap * 2 + column * (cellWidth + gap),
      top: gap + row * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    })
  }
  return geometries
}

test('shared trainable coefficients fit an unseen sidebar grid', () => {
  const target = createTarget(createSidebarGrid())
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
