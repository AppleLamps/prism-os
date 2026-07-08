import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {runGauntlet} from './gauntlet.ts'

test('every gauntlet function compiles and matches the fround twin bit-for-bit', () => {
  const runs = runGauntlet()
  for (const {entry, compiled, report} of runs) {
    assert.deepEqual(report.mismatches, [], `${entry.name} diverged from the twin`)
    assert.ok(report.outputsChecked > 0, `${entry.name} checked no outputs`)
    // The actual exactness claim: every comparison lowers without an unresolved margin, so no
    // site carries an epsilon (a margin-violation count would be vacuous).
    assert.ok(
      compiled.program.comparisonSites.every(site => site.epsilon === null),
      `${entry.name} emitted a margin-based comparison`,
    )
  }
  // responsiveColumnCount is verified exhaustively over every integer viewport width.
  const columns = runs.find(run => run.entry.name === 'responsiveColumnCount')!
  assert.equal(columns.report.trials, 4097)
})

test('decision-bit policy: no gauntlet circuit needs the boolean atom', () => {
  // Integer comparisons use relu(d) - relu(d - 1). Continuous comparisons use the exact sign
  // cascade (relu + power-of-two scaling + clamp01 rounds), which already produces an exact
  // 0/1, so even pointer hit tests compile without the rounding atom.
  const runs = runGauntlet()
  for (const {entry, compiled} of runs) {
    assert.equal(compiled.program.opCounts.boolean, 0, entry.name)
  }
  // The continuous comparisons are still there, just lowered exactly.
  const hit = runs.find(run => run.entry.name === 'hitTestBox')!
  assert.ok(hit.compiled.program.comparisonSites.some(site => site.kind === 'continuous'))
})
