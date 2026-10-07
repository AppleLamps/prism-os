import {expect, test} from 'bun:test'
import {compileInstanceProgram, type InstanceRunner} from './instance.ts'
import {lifeOutputField} from './life-calendar.ts'
import {renderCandidateGrid, renderLifeCalendar, renderOwnership, renderShapes} from './render.ts'
import {createCandidateGridWorkload, createLifeCalendarWorkload, createOwnershipWorkload, createShapesWorkload, sessionHandwiredOSSource, type Workload} from './workloads.ts'

function run(workload: Workload): {outputs: Float32Array, runner: InstanceRunner} {
  const runner = compileInstanceProgram(workload.plan, {rowsPerFunction: 128, blockSize: 1024})
  const outputs = new Float32Array(workload.count * workload.plan.outputs.length)
  runner.runShared(workload.sharedSources[0]!)
  runner.runInstances(workload.instanceSources, workload.count, outputs)
  return {outputs, runner}
}

function distinctColors(pixels: Uint8ClampedArray) {
  const colors = new Set<number>()
  for (let index = 0; index < pixels.length; index += 4) colors.add((pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!)
  return colors.size
}

test('each projection paints its workload outputs into pixels', () => {
  const ownership = createOwnershipWorkload(sessionHandwiredOSSource(), 128, 80)
  const ownershipPixels = new Uint8ClampedArray(ownership.count * 4)
  renderOwnership(run(ownership).outputs, ownership.count, ownershipPixels)
  expect(distinctColors(ownershipPixels)).toBeGreaterThan(5)

  const shapes = createShapesWorkload(140, 90)
  const shapeResult = run(shapes)
  const shapePixels = new Uint8ClampedArray(shapes.count * 4)
  renderShapes(shapeResult.outputs, shapes.count, shapePixels)
  expect(shapePixels[0]).toBe(Math.round(shapeResult.outputs[0]!))
  expect(distinctColors(shapePixels)).toBeGreaterThan(8)

  const grid = createCandidateGridWorkload()
  const gridPixels = new Uint8ClampedArray(grid.count * 4)
  renderCandidateGrid(run(grid).outputs, grid.width, grid.plan.outputs.length, gridPixels)
  expect(distinctColors(gridPixels)).toBeGreaterThan(30)

  const calendar = createLifeCalendarWorkload(720, 450)
  const calendarResult = run(calendar)
  const blockSizePosition = calendar.plan.flat.positionOfWire[calendar.program.roots[lifeOutputField.size + 2]!]!
  const blockSize = calendarResult.runner.shared[blockSizePosition]!
  expect(blockSize).toBeGreaterThan(1)
  const calendarPixels = new Uint8ClampedArray(720 * 450 * 4)
  renderLifeCalendar(calendarResult.outputs, calendar.count, blockSize, 720, 450, calendarPixels)
  expect(distinctColors(calendarPixels)).toBeGreaterThan(3)
})
