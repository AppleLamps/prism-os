// Stages 1 and 2: the notation base, and the spring bank inside it.
import {expect, test} from 'bun:test'
import {createWindowManagerMachine} from '../../../window-manager.ts'
import {createBoxCheck, windowAndPhotoBoxes} from './box-check.ts'
import {compareCircuits, programStats} from './compare.ts'
import {buildIndirectOS, createIndirectOSMachine, originalOptions} from './indirect-os.ts'
import {createPair, runRandomTrace} from './pair-traces.ts'
import {leafWires} from './table.ts'

const sizes = (options: typeof originalOptions) => {
  const built = buildIndirectOS(options)
  const {built: _, layerWidths: __, ...stats} = programStats(built.circuit, [...built.nextSource, ...leafWires(built.output)])
  return stats
}
const bankOptions = {...originalOptions, springs: 'bank' as const}

test('the original options rebuild window-manager.ts operation for operation', () => {
  const original = createWindowManagerMachine()
  const photos = original.output.photos
  const originalRoots = [
    ...original.output.nextSource, ...original.output.windows, ...original.output.dockItems, original.output.animationActive,
    photos.backdropOpacity, ...photos.photos, ...photos.thumbnails, ...photos.previousControl, ...photos.nextControl,
  ]
  const rewrite = buildIndirectOS(originalOptions)
  const comparison = compareCircuits({circuit: original.circuit, roots: originalRoots}, {circuit: rewrite.circuit, roots: [...rewrite.nextSource, ...leafWires(rewrite.output)]})
  expect(comparison.strict).toEqual({matchingRoots: 429, liveOnlyInOriginal: 0, liveOnlyInRewrite: 0})
  expect([comparison.rewrite.live, comparison.rewrite.layers, comparison.rewrite.weights]).toEqual([5253, 192, 11598])
})

test('declaring the timestep nonnegative where it is computed saves 320 operations and changes no bit along a random trace', () => {
  expect(sizes({...originalOptions, declareTimestep: true})).toEqual({live: 4933, layers: 184, weights: 10958, gatherReads: 12})
  const result = runRandomTrace(createPair({...originalOptions, declareTimestep: true}, 'all roots'), 1, 300)
  expect(result.comparedValues).toBe(301 * 429)
  expect(result.mismatchedValues).toBe(0)
  expect(result.coverage.heldDragMoves).toBeGreaterThan(0)
})

test('the spring bank takes IndirectOS to 3,580 operations, and to 91 layers when Photos reads stepped springs', () => {
  expect(sizes(bankOptions)).toEqual({live: 3580, layers: 137, weights: 8447, gatherReads: 12})
  expect(sizes({...bankOptions, photosViewport: 'stepped-springs'})).toEqual({live: 3583, layers: 91, weights: 8455, gatherReads: 12})
})

test('with the bank, focus, geometry, flags, drag and resize owners, stacking and photo focus match window-manager.ts frame by frame', () => {
  for (const [seed, photosViewport] of [[5, 'current-frame'], [12, 'stepped-springs']] as const) {
    const result = runRandomTrace(createPair({...bankOptions, photosViewport}, 'discrete'), seed, 400)
    expect(result.firstMismatch).toBeNull()
    expect(result.comparedValues).toBe(401 * (4 * 14 + 12))
    expect(result.coverage.photoFocusChanges).toBeGreaterThan(5)
    expect(result.coverage.closes).toBeGreaterThan(0)
  }
})

test('every window and thumbnail box matches float64 doctrine springs, restarted from the circuit state each evaluation', () => {
  const pair = createPair({...bankOptions, photosViewport: 'stepped-springs'}, 'discrete', {debugOutputs: true})
  const check = createBoxCheck(pair.rewrite, windowAndPhotoBoxes(pair.rewrite))
  runRandomTrace(pair, 4, 400)
  expect(check.evaluationsWithSteps).toBeGreaterThan(300)
  expect(check.boxesChecked).toBe(check.evaluations * 16)
  expect(check.clockMismatches).toBe(0)
  expect(check.firstSettleMismatch).toBeNull()
  expect(check.maxPositionError).toBeLessThan(1e-3)
  void createIndirectOSMachine
})
