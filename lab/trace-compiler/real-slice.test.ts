import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  compile1DLayoutSlice,
  compile2DLayoutSlice,
  compileClampSlice,
  compileColsBoxSlice,
  compileHitTest1DSlice,
  compileOcclusionSlice,
  compileScrollCompensationSlice,
  compileSpringGoToEndSlice,
  compileSpringStepSlice,
  loadRealTarget,
  probeRejections,
} from './real-slice.ts'

const seed = 20260706
const target = loadRealTarget()

test('the real photo data has the expected shape', () => {
  assert.ok(target.photos.length >= 16, 'expected a non-toy photo count')
  for (const photo of target.photos) {
    assert.ok(photo.naturalSizeX > 0 && photo.aspectRatio > 0)
  }
})

test('clamp compiles from the real source and matches the twin', () => {
  const slice = compileClampSlice(target, 5000, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
})

test('colsBoxMaxSizeXF matches the twin exhaustively over every viewport width 0..4096', () => {
  const slice = compileColsBoxSlice(target, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
  assert.equal(slice.report.trials, 4097)
  // Both outputs (cols and boxMaxSizeX) checked for every width.
  assert.equal(slice.report.outputsChecked, 4097 * 2)
})

test('springStep and springGoToEnd compile with mutated fields as outputs', () => {
  const stepSlice = compileSpringStepSlice(target, 5000, seed)
  assert.deepEqual(stepSlice.report.mismatches, [])
  assert.deepEqual(stepSlice.report.sourceSemantics.mismatches, [])
  assert.deepEqual(stepSlice.program.outputs.map(output => output.name).sort(), ['config.pos', 'config.v'])
  const snapSlice = compileSpringGoToEndSlice(target, 2000, seed)
  assert.deepEqual(snapSlice.report.mismatches, [])
  assert.deepEqual(snapSlice.report.sourceSemantics.mismatches, [])
})

test('hitTest1DMode compiles to a presence bit plus a value and matches the twin', () => {
  const slice = compileHitTest1DSlice(target, 5000, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
  assert.deepEqual(slice.program.outputs.map(output => output.name), ['return.present', 'return.value'])
}, 20_000)

test('the 2D grid layout compiles via per-cols specialization and matches the twin', () => {
  const slice = compile2DLayoutSlice(target, 300, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
  // Six spring destinations per photo plus the total content height.
  assert.equal(slice.report.outputsChecked, 300 * (target.photos.length * 6 + 1))
  // The whole slice runs from one input: the viewport width.
  assert.equal(slice.program.inputs.length, 1)
}, 120_000)

test('the 1D lightbox layout compiles directly with masked loops and matches the twin', () => {
  const slice = compile1DLayoutSlice(target, 300, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
  assert.equal(slice.report.outputsChecked, 300 * target.photos.length * 7)
}, 120_000)

test('the occlusion culling condition compiles to one visibility bit per photo', () => {
  const slice = compileOcclusionSlice(target, 500, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
  assert.equal(slice.report.outputsChecked, 500 * target.photos.length)
}, 60_000)

test('the scroll compensation line compiles and matches the twin', () => {
  const slice = compileScrollCompensationSlice(target, 500, seed)
  assert.deepEqual(slice.report.mismatches, [])
  assert.deepEqual(slice.report.sourceSemantics.mismatches, [])
})

test('rejection probes give precise diagnostics for the two functions outside the subset', () => {
  const probes = probeRejections(target)
  const byName = new Map(probes.map(probe => [probe.name, probe.diagnostic]))
  assert.equal(byName.get('hitTest2DMode')!.category, 'early return')
  assert.equal(byName.get('stepSpring')!.category, 'dynamic loop bound')
  for (const probe of probes) assert.ok(probe.diagnostic.line > 0)
})
