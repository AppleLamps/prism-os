import {expect, test} from 'bun:test'
import {checkReleaseVelocity} from './checks.ts'

test('release velocity: window search and bounded Newton division match the demo loop within 1e-6 relative', () => {
  const result = checkReleaseVelocity(4000, 11)
  expect(result.checked).toBeGreaterThan(2500)
  expect(result.failures).toBe(0)
})

test('release velocity with the ±2^16 px/s clamp matches the clamped loop', () => {
  const result = checkReleaseVelocity(4000, 12, 2 ** 16)
  expect(result.checked).toBeGreaterThan(2500)
  expect(result.clampedTrials).toBeGreaterThan(50)
  expect(result.failures).toBe(0)
})
