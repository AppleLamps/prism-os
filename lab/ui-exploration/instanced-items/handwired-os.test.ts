import {expect, test} from 'bun:test'
import {expandDuplicated, measureCircuit} from './expand.ts'
import {runHandwiredOSComparison} from './handwired-os-compare.ts'

test('staged HandwiredOS, free-running beside window-manager.ts through the session: every decision matches every frame, and the session did what it says', () => {
  const result = runHandwiredOSComparison({resync: false})
  if (result.decisionMismatches > 0) console.log(result.firstDecisionMismatches)
  expect(result.decisionMismatches).toBe(0)
  const at = (frame: number) => result.states[frame]!
  expect([at(7).windowLeft0, at(7).windowTop0]).toEqual([114, 104])
  expect([at(22).windowWidth0, at(22).windowHeight0]).toEqual([598, 388])
  expect(at(41).window1Open).toBe(0)
  expect(at(61).window1Open).toBe(1)
  expect(at(81).photosMaximized).toBe(1)
  expect(at(100).focusedPhoto).toBe(0)
  expect(at(130).focusedPhoto).toBe(2)
  expect(at(140).focusedPhoto).toBe(1)
  expect(at(160).focusedPhoto).toBe(-1)
  expect(at(181).photosMaximized).toBe(0)
  expect(at(201).window1Minimized).toBe(1)
  // Positions drift by FP32 rounding where a per-item table changed the atoms: thumbnail falloff
  // multiplies f32(-0.22) by an integer distance, where photo-gallery.ts rounds -0.22 × k once.
  for (const [label, entry] of result.byLabel) {
    const bound = label.includes('velocity') ? 0.05 : 0.005
    if (entry.maximumDifference > bound) throw new Error(`${label}: ${entry.worst}`)
    if (!label.includes('thumbnail')) expect(entry.identical).toBe(entry.compared)
  }
})

test('staged HandwiredOS with cells copied from window-manager.ts every frame: every decision matches, most values are bit-identical', () => {
  const result = runHandwiredOSComparison({resync: true})
  expect(result.decisionMismatches).toBe(0)
  expect(result.identical / result.compared).toBeGreaterThan(0.8)
})

test('staged HandwiredOS expands into a duplicated circuit of 6,282 live operations, 215 layers and 13,346 stored weights, next to window-manager.ts\'s 5,253 / 192 / 11,598', () => {
  const {original, staged} = runHandwiredOSComparison({resync: false, frames: 1})
  const originalSize = measureCircuit(original.circuit, [...original.tensorProgram.roots])
  expect([originalSize.liveOperations, originalSize.layers, originalSize.storedWeights]).toEqual([5253, 192, 11_598])
  const duplicated = expandDuplicated(staged.built.program)
  const stagedSize = measureCircuit(duplicated.circuit, duplicated.roots)
  expect([stagedSize.liveOperations, stagedSize.layers, stagedSize.storedWeights]).toEqual([6282, 215, 13_346])
})
