import {expect, test} from 'bun:test'
import {checkRouting, routingPatterns} from './checks.ts'
import {buildRouting} from './routing.ts'

test('capacity routing: 1,000 items into 20 slots is exact on edge patterns and random filters, and the slot one-hots hold', () => {
  const routing = buildRouting({itemCount: 1000, slotCount: 20, prefix: 'brentKung'})
  const result = checkRouting(routing, routingPatterns(1000, 20, 40, 1), 4)
  expect(result.firstMismatch).toBeUndefined()
})

test('capacity routing gives the same answers with every prefix-count mode', () => {
  for (const prefix of ['chain', 'wide', 'blocked', 'brentKung'] as const) {
    const routing = buildRouting({itemCount: 70, slotCount: 8, prefix})
    expect(checkRouting(routing, routingPatterns(70, 8, 30, 2), 2).firstMismatch).toBeUndefined()
  }
})
