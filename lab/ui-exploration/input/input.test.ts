import {expect, test} from 'bun:test'
import type {QueuedEvent} from './events.ts'
import {keyNameOf, legalizePointerStream, quantizeEventTime, quantizeFrameDelta, splitIntoEvaluations, toQueuedEvents} from './input.ts'

test('event times sit on the 1/16 ms grid relative to the frame, clamped, never -0', () => {
  expect(quantizeEventTime(1000 - 3.03, 1000)).toBe(-3)
  expect(quantizeEventTime(1000 - 3.04, 1000)).toBe(-3.0625)
  expect(Object.is(quantizeEventTime(1000, 1000), 0)).toBe(true)
  expect(Object.is(quantizeEventTime(1000.01, 1000), 0)).toBe(true)
  expect(quantizeEventTime(0, 100000)).toBe(-4096)
  expect(quantizeFrameDelta(1016.7, 1000)).toBe(16.6875)
  expect(quantizeFrameDelta(1000, null)).toBe(0)
})

test('keys outside the vocabulary are ignored at the boundary', () => {
  expect(keyNameOf(' ')).toBe('Space')
  expect(keyNameOf('ArrowLeft')).toBe('ArrowLeft')
  expect(keyNameOf('a')).toBe(null)
})

test('pointer coordinates become whole world pixels', () => {
  const events = toQueuedEvents([{kind: 'down', clientX: 110.6, clientY: 20.2, timeStamp: 990}], 1000, (clientX, clientY) => ({x: clientX - 10, y: clientY * 2}))
  expect(events).toEqual([{kind: 'down', x: 101, y: 40, time: -10}])
})

test('the pointer stream is made legal', () => {
  const down: QueuedEvent = {kind: 'down', x: 1, y: 1, time: 0}
  const up: QueuedEvent = {kind: 'up', x: 1, y: 1, time: 0}
  expect(legalizePointerStream([up, down, down], false)).toEqual({events: [down, up, down], pressed: true})
})

test('splitting respects capacity and the downs per evaluation, and keeps order', () => {
  const events: QueuedEvent[] = [
    {kind: 'down', x: 0, y: 0, time: -5},
    {kind: 'up', x: 0, y: 0, time: -4},
    {kind: 'down', x: 0, y: 0, time: -3},
    {kind: 'move', x: 1, y: 0, time: -2},
    {kind: 'up', x: 1, y: 0, time: -1},
  ]
  const byDowns = splitIntoEvaluations(events, 16, 1)
  expect(byDowns.map(chunk => chunk.length)).toEqual([2, 3])
  const byCapacity = splitIntoEvaluations(events, 2)
  expect(byCapacity.map(chunk => chunk.length)).toEqual([2, 2, 1])
  expect(byCapacity.flat()).toEqual(events)
  expect(splitIntoEvaluations([], 8)).toEqual([[]])
})
