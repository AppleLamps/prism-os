import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {writeEventQueue, type KeyName, type QueuedEvent} from './events.ts'
import {testControlRectangles} from './fixtures.ts'
import {createKeyboardMachine, keyboardOracleEvent, type ControlsLayout, type KeyboardMachine, type KeyboardState} from './keyboard.ts'
import {generateKeyboardTrace} from './traces.ts'

const machines = [
  ['per-event navigation', createKeyboardMachine(12, 8, 'per-event')],
  ['navigation tables', createKeyboardMachine(12, 8, 'tables')],
] as const

const key = (name: KeyName, shift = false): QueuedEvent => ({kind: 'key', key: name, shift, time: 0})
const allEnabled: ControlsLayout = {rectangles: testControlRectangles, enabled: testControlRectangles.map(() => true)}

function run(machine: KeyboardMachine, layout: ControlsLayout, frames: readonly QueuedEvent[][]) {
  machine.reset(layout)
  const oracle: KeyboardState = {focus: -1, pressedControl: -1}
  let result = machine.step([])
  for (const events of frames) {
    const activations = layout.rectangles.map(() => 0)
    for (const event of events) keyboardOracleEvent(layout, oracle, event, activations)
    result = machine.step(events)
    expect(result.state).toEqual(oracle)
    expect(result.activations).toEqual(activations)
    expect(result.focusedIndex).toBe(oracle.focus)
  }
  return result
}

describe.each(machines)('%s', (_, machine) => {
  test('Tab cycles forward and Shift+Tab backward, starting from nothing focused', () => {
    expect(run(machine, allEnabled, [[key('Tab')]]).state.focus).toBe(0)
    expect(run(machine, allEnabled, [[key('Tab', true)]]).state.focus).toBe(11)
    expect(run(machine, allEnabled, [[key('Tab', true)], [key('Tab')]]).state.focus).toBe(0)
  })

  test('Tab skips disabled controls', () => {
    const layout: ControlsLayout = {rectangles: testControlRectangles, enabled: testControlRectangles.map((_, index) => index !== 1 && index !== 2)}
    expect(run(machine, layout, [[key('Tab'), key('Tab')]]).state.focus).toBe(3)
    expect(run(machine, layout, [[key('Tab'), key('Tab'), key('Tab', true)]]).state.focus).toBe(0)
  })

  test('arrows move to the nearest control in the pressed direction', () => {
    // Control 5 sits in the middle of the grid. Up from it reaches toolbar
    // control 1, whose center is closest across.
    const focusFive: QueuedEvent = {kind: 'down', x: 150, y: 90, time: 0}
    const release: QueuedEvent = {kind: 'up', x: 150, y: 90, time: 0}
    expect(run(machine, allEnabled, [[focusFive, release, key('ArrowUp')]]).state.focus).toBe(1)
    expect(run(machine, allEnabled, [[focusFive, release, key('ArrowDown')]]).state.focus).toBe(8)
    expect(run(machine, allEnabled, [[focusFive, release, key('ArrowRight')]]).state.focus).toBe(6)
    expect(run(machine, allEnabled, [[focusFive, release, key('ArrowLeft')]]).state.focus).toBe(4)
    // From control 4, toolbar control 0's center is still 10 px to the left.
    expect(run(machine, allEnabled, [[focusFive, release, key('ArrowLeft'), key('ArrowLeft')]]).state.focus).toBe(0)
    // Nothing is below the wide bottom-left button, so focus stays.
    expect(run(machine, allEnabled, [[{kind: 'down', x: 50, y: 250, time: 0}, {kind: 'up', x: 50, y: 250, time: 0}, key('ArrowDown')]]).state.focus).toBe(10)
  })

  test('several keys in one frame apply in order, and Enter activates the result', () => {
    const result = run(machine, allEnabled, [[key('Tab'), key('ArrowDown'), key('ArrowRight'), key('Enter'), key('Space')]])
    expect(result.state.focus).toBe(5)
    expect(result.activations[5]).toBe(2)
  })

  test('a click focuses and activates, and Escape clears focus', () => {
    const result = run(machine, allEnabled, [[{kind: 'down', x: 300, y: 100, time: 0}, {kind: 'up', x: 301, y: 101, time: 0}]])
    expect(result.state.focus).toBe(6)
    expect(result.activations[6]).toBe(1)
    expect(run(machine, allEnabled, [[{kind: 'down', x: 300, y: 100, time: 0}], [key('Escape')]]).state.focus).toBe(-1)
  })

  test('random traces match the oracle every frame, and declared one-hot groups hold', () => {
    for (const [seed, rectangles] of [[3, testControlRectangles], [4, null]] as const) {
      const frames = generateKeyboardTrace({seed, frames: 400, capacity: 8, rectangles, controlCount: 12})
      machine.reset(frames[0]!.layout)
      const oracle: KeyboardState = {focus: -1, pressedControl: -1}
      frames.forEach((frame, index) => {
        machine.writeControls(frame.layout)
        const activations = frame.layout.rectangles.map(() => 0)
        for (const event of frame.events) keyboardOracleEvent(frame.layout, oracle, event, activations)
        if (index % 50 === 0) {
          // The previous step cleared the queue, so write this frame's events first.
          writeEventQueue(machine.source, machine.slots, frame.events)
          const snapshot = new Float32Array(machine.source)
          const values = machine.circuit.evaluateTensor(snapshot)
          validateOneHotGroups(machine.circuit, values)
        }
        const result = machine.step(frame.events)
        expect(result.state).toEqual(oracle)
        expect(result.activations).toEqual(activations)
      })
    }
  })
})
