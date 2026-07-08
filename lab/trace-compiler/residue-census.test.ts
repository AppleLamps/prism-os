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
} from './real-slice.ts'
import {categoryFixability, runCensus, summarizeCensus} from './residue-census.ts'

test('the residue census classifies every render-path unit and the taxonomy has real counts', () => {
  const target = loadRealTarget()
  // Tiny trial counts: this test needs the slices' line coverage, not their full verification
  // (real-slice.test.ts runs that).
  const slices = [
    compileClampSlice(target, 5, 1),
    compileColsBoxSlice(target, 1),
    compileSpringStepSlice(target, 5, 1),
    compileSpringGoToEndSlice(target, 5, 1),
    compileHitTest1DSlice(target, 5, 1),
    compile2DLayoutSlice(target, 3, 1),
    compile1DLayoutSlice(target, 3, 1),
    compileOcclusionSlice(target, 3, 1),
    compileScrollCompensationSlice(target, 3, 1),
  ]
  const units = runCensus(target, slices)
  const summary = summarizeCensus(units)

  // Every unit lands in a known category with a fixability judgment; nothing is unclassified.
  for (const row of summary.rows) {
    assert.ok(row.category in categoryFixability, row.category)
    assert.ok(row.count > 0)
    assert.ok(row.exampleLine > 0)
  }

  // Exact counts, pinned to the current snapshot of the target file. The census is
  // deterministic, so any drift in the file or the classifier fails here loudly instead of
  // silently invalidating the README's taxonomy table.
  const byCategory = Object.fromEntries(summary.rows.map(row => [row.category, row.count]))
  assert.deepEqual(byCategory, {
    'compiled and verified in a slice': 64,
    'compilable numeric (not sliced)': 49,
    'DOM write': 27,
    'nullable state': 15,
    'event object plumbing': 14,
    'string work': 9,
    'browser side effect': 9,
    'dynamic loop bound': 8,
    'debug-only': 6,
    'DOM read': 6,
    'dynamic index': 6,
    'state commit (write-back)': 4,
    'loop early exit (first match)': 3,
    'unbounded range (needs a finite @fit)': 1,
  })
  assert.equal(summary.totalUnits, 221)
  assert.equal(summary.compiledUnits, 64)
  assert.equal(summary.numericUnits, 173)
  assert.equal(summary.numericCompiledUnits, 113)
}, 60_000)
