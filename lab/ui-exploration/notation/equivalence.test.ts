import {expect, test} from 'bun:test'
import {
  dragSourceField,
  photoFocusSourceField,
  photoSourceField,
  photoThumbnailSpringSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowSourceField,
  windowStateField,
} from '../../../window-manager.ts'
import {thumbnailSpringField} from '../../../photo-gallery.ts'
import {compareCircuits} from './compare.ts'
import {windowCount} from './indirect-os.ts'
import {photoCount} from './photos.ts'
import {createPair, originalFieldOrder, runRandomTrace, runScriptedTrace} from './traces.ts'

const pair = createPair()

test('the allocator derives the original source layout from declarations', () => {
  const {cells, photoCells} = pair.rewrite
  const scalarPairs: [number, number][] = [
    [cells.viewportWidth, sourceField.viewportWidth], [cells.viewportHeight, sourceField.viewportHeight], [cells.unit, sourceField.unit],
    [cells.margin, sourceField.margin], [cells.titleHeight, sourceField.titleHeight], [cells.minWidth, sourceField.minWidth],
    [cells.minHeight, sourceField.minHeight], [cells.resizeGrip, sourceField.resizeGrip], [cells.buttonSize, sourceField.buttonSize],
    [cells.buttonGap, sourceField.buttonGap], [cells.dockHeight, sourceField.dockHeight], [cells.dockGap, sourceField.dockGap],
    [cells.dockItemWidth, sourceField.dockItemWidth], [cells.down.active, sourceField.downActive], [cells.down.x, sourceField.downX],
    [cells.down.y, sourceField.downY], [cells.move.active, sourceField.moveActive], [cells.move.x, sourceField.moveX], [cells.move.y, sourceField.moveY],
    [cells.up.active, sourceField.upActive], [cells.up.x, sourceField.upX], [cells.up.y, sourceField.upY], [cells.pointer.x, sourceField.pointerX],
    [cells.pointer.y, sourceField.pointerY], [cells.systemBarHeight, sourceField.systemBarHeight], [cells.frameTime, sourceField.frameTime],
    [cells.previousFrameTime, sourceField.previousFrameTime], [cells.timeInitialized, sourceField.timeInitialized],
    [cells.springs.stiffness, sourceField.springStiffness], [cells.springs.damping, sourceField.springDamping],
    [cells.springs.maxFrameDuration, sourceField.springMaxFrameDuration], [cells.springs.settleDistance, sourceField.springSettleDistance],
    [cells.springs.settleSpeed, sourceField.springSettleSpeed], [cells.springs.settleDistanceScale, sourceField.springSettleDistanceScale],
    [cells.springs.settleSpeedScale, sourceField.springSettleSpeedScale],
    [photoCells.gap, photoSourceField.gap], [photoCells.mainInset, photoSourceField.mainInset], [photoCells.thumbnailHeight, photoSourceField.thumbnailHeight],
    [photoCells.controlSize, photoSourceField.controlSize], [photoCells.clickActive, photoSourceField.clickActive], [photoCells.clickX, photoSourceField.clickX],
    [photoCells.clickY, photoSourceField.clickY], [photoCells.previousActive, photoSourceField.previousActive],
    [photoCells.nextActive, photoSourceField.nextActive], [photoCells.closeActive, photoSourceField.closeActive],
  ]
  const layoutPairs = [...scalarPairs]
  for (let index = 0; index < windowCount; index++) {
    for (const field of ['left', 'top', 'width', 'height', 'open', 'minimized', 'maximized', 'present'] as const) {
      layoutPairs.push([cells.windows[index]![field], windowSourceField(index, windowStateField[field])])
    }
    layoutPairs.push([cells.drag[index]!, dragSourceField(index)], [cells.resize[index]!, resizeSourceField(index)])
    for (let rank = 0; rank < windowCount; rank++) layoutPairs.push([cells.stack[rank]![index]!, stackSourceField(rank, index)])
    // window-manager.ts does not export its spring accessor: positions, then velocities, 10 cells per window.
    const springFields = ['centerX', 'centerY', 'width', 'height', 'scale'] as const
    springFields.forEach((field, fieldIndex) => {
      layoutPairs.push([cells.windowSprings[index]!.position[field], sourceField.springStart + index * 10 + fieldIndex])
      layoutPairs.push([cells.windowSprings[index]!.velocity[field], sourceField.springStart + index * 10 + 5 + fieldIndex])
    })
  }
  for (let item = 0; item < photoCount; item++) {
    layoutPairs.push([photoCells.focus[item]!, photoFocusSourceField(item)])
    for (const field of ['centerX', 'centerXVelocity', 'scale', 'scaleVelocity'] as const) {
      layoutPairs.push([photoCells.thumbnails[item]![field], photoThumbnailSpringSourceField(item, thumbnailSpringField[field])])
    }
  }
  expect(layoutPairs.length).toBe(sourceField.size)
  expect(layoutPairs.map(([rewrite]) => rewrite)).toEqual(layoutPairs.map(([, original]) => original))
  expect([...pair.rewrite.source]).toEqual([...pair.original.source])
})

test('the compiled circuit is structurally identical to the original', () => {
  const comparison = compareCircuits(
    {circuit: pair.original.circuit, roots: pair.originalRoots},
    {circuit: pair.rewrite.circuit, roots: pair.rewriteRoots},
  )
  expect(comparison.rootCount).toBe(429)
  expect(comparison.strict).toEqual({matchingRoots: 429, liveOnlyInOriginal: 0, liveOnlyInRewrite: 0})
  expect(comparison.rewrite).toEqual(comparison.original)
  expect(comparison.original.live).toBe(5253)
  expect(comparison.original.layers).toBe(192)
  expect(comparison.original.weights).toBe(11598)
})

test('named output structs list fields in the original flat order', () => {
  const order = originalFieldOrder()
  const {output} = pair.rewrite
  expect(Object.keys(output.windows[0]!)).toEqual(order.windows)
  expect(Object.keys(output.dockItems[0]!)).toEqual(order.dockItems)
  expect(Object.keys(output.photos.photos[0]!)).toEqual(order.photos)
  expect(Object.keys(output.photos.thumbnails[0]!)).toEqual(order.photos)
  expect(Object.keys(output.photos.previousControl)).toEqual(order.controls)
  expect(pair.rewriteRoots.length).toBe(pair.originalRoots.length)
})

test('a scripted tour matches the original bit for bit, and every scripted step takes effect', () => {
  const result = runScriptedTrace()
  expect(result.frames).toBe(401)
  expect(result.mismatchedValues).toBe(0)
  // Each check reads the rewrite's state after a step, e.g. the drag bit is 1
  // and the window moved. The bits match the original's, so the checks hold for both.
  expect(Object.keys(result.checks).length).toBe(22)
  expect(Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name)).toEqual([])
  expect(result.coverage.heldDragMoves).toBeGreaterThan(0)
  expect(result.coverage.heldResizeMoves).toBeGreaterThan(0)
  expect(result.coverage.focusAndSelect).toBe(1)
  // Both validators reject frame 357: thumbnails spring in past the left edge
  // after the viewport grows from 40x40 while the lightbox is open.
  expect(result.originalRejections).toBe(1)
  expect(result.rewriteRejections).toBe(1)
  expect(result.disagreements).toBe(0)
})

test('a randomized trace matches the original bit for bit, with drags and resizes held across frames', () => {
  // The first 300 frames of report.ts's seed 1.
  const result = runRandomTrace(1, 300)
  expect(result.comparedValues).toBe(301 * 429)
  expect(result.mismatchedValues).toBe(0)
  expect(result.disagreements).toBe(0)
  expect(result.coverage.heldDragMoves).toBeGreaterThan(0)
  expect(result.coverage.heldResizeMoves).toBeGreaterThan(0)
})
