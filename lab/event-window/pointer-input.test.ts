import {expect, test} from 'bun:test'
import {createEventWindowMachine} from './circuit.ts'
import {createOracleState, oracleTick} from './oracle.ts'
import {appendPointerMoves, type RawPointerInput} from './pointer-input.ts'
import {createBehaviorConfig} from './trace.ts'

test('queued outward-and-back moves cancel a click in both evaluators', () => {
  const config = createBehaviorConfig(71)
  const rectangle = config.rectangles[0]!
  const clientX = rectangle.initialLeft + Math.floor(rectangle.width / 2)
  const clientY = rectangle.initialTop + config.titleHeight + 10
  const pending: RawPointerInput[] = [
    {kind: 'down', clientX, clientY},
    {kind: 'up', clientX, clientY},
    {kind: 'down', clientX, clientY},
  ]
  appendPointerMoves(pending, [{clientX: clientX + 20, clientY}, {clientX, clientY}])
  pending.push({kind: 'up', clientX, clientY})
  expect(pending.filter(input => input.kind === 'move')).toHaveLength(2)
  const machine = createEventWindowMachine(config)
  const state = createOracleState(config)
  for (const input of pending) {
    const frame = {kind: input.kind, x: input.clientX, y: input.clientY}
    expect(machine.step(frame).maximized).toEqual(oracleTick(config, state, frame).maximized)
  }
  expect(state.maximized[0]).toBe(false)
  const incomplete = createOracleState(config)
  for (const input of pending.filter((_, index) => index !== 3)) {
    oracleTick(config, incomplete, {kind: input.kind, x: input.clientX, y: input.clientY})
  }
  expect(incomplete.maximized[0]).toBe(true)
})
