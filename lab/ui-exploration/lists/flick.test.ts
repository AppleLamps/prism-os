import {expect, test} from 'bun:test'
import {buildFlick} from './flick.ts'
import {runFlickDifferential} from './traces.ts'

test('flick to a snap target: one spring per axis matches the demo two springs in decisions, within 0.05 px in position', () => {
  const built = buildFlick()
  for (const seed of [1, 2]) {
    const result = runFlickDifferential(seed, 1000, built)
    expect(result.firstDecisionMismatch).toBeUndefined()
    expect(result.flicks).toBeGreaterThan(20)
    expect(result.maximumPositionError).toBeLessThan(0.05)
    expect(result.maximumRestError).toBeLessThan(0.05)
  }
})
