import {expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {appItemSlots, appMenus, appOracleFrame, createAppMachine, createAppState, type AppState, type AppViewport} from './app.ts'
import type {KeyName, QueuedEvent} from './events.ts'
import {generateAppTrace, type AppFrame} from './traces.ts'

const viewport: AppViewport = {width: 1200, height: 760}
const machine = createAppMachine(8, viewport)

const key = (name: KeyName, shift = false): QueuedEvent => ({kind: 'key', key: name, shift, time: 0})
const pointer = (kind: 'down' | 'move' | 'up', x: number, y: number): QueuedEvent => ({kind, x, y, time: 0})

function run(frames: readonly AppFrame[]): {state: AppState, focusTarget: number, placementTops: number[]} {
  machine.reset(frames[0]?.viewport ?? viewport)
  const oracle = createAppState(frames[0]?.viewport ?? viewport)
  let focusTarget = -1
  let placementTops: number[] = []
  for (const frame of frames) {
    machine.writeViewport(frame.viewport)
    const expected = appOracleFrame(frame.viewport, oracle, frame.frameDelta, frame.events)
    const actual = machine.step(frame.frameDelta, frame.events)
    expect(actual.state).toEqual(oracle)
    expect(actual.outputs).toEqual(expected)
    focusTarget = actual.outputs.focusTarget
    placementTops = actual.outputs.placements.map(placement => placement.top)
  }
  return {state: oracle, focusTarget, placementTops}
}

const frame = (...events: QueuedEvent[]): AppFrame => ({viewport, frameDelta: 16.6875, events})
const keyTarget = (index: number) => appMenus.length + appMenus.length * appItemSlots + index

test('keyboard reaches the menu bar and a menu action changes window state in the same frame', () => {
  const result = run([frame(key('Tab'), key('ArrowDown'), key('ArrowDown'), key('Enter'))])
  // "Cycle to next window" from nothing focused focuses and raises window 0.
  expect(result.state.windows.focus).toBe(0)
  expect(result.state.windows.rank[0]).toBe(2)
  expect(result.state.menu).toEqual({open: -1, highlight: -1, titleFocus: 0})
  expect(result.focusTarget).toBe(0)
})

test('a click on a key focuses it, arrows move between keys, Enter counts', () => {
  const result = run([frame(pointer('down', 200, 200), pointer('up', 200, 200), key('ArrowRight'), key('Enter'), key('Space'))])
  expect(result.state.keypad.focus).toBe(5)
  expect(result.state.keyCounts[4]).toBe(1)
  expect(result.state.keyCounts[5]).toBe(2)
  expect(result.state.windows.focus).toBe(0)
  expect(result.focusTarget).toBe(keyTarget(5))
})

// Open the Keypad menu with the pointer, release on "Disable every other key".
// The Keypad panel sits below its title: item 1 spans y 56..81. Releasing on
// the item closes the menu and leaves nothing focused.
const disableOtherKeys = frame(pointer('down', 100, 10), pointer('move', 120, 70), pointer('up', 120, 70))

test('after the menu disables every other key, Shift+Tab from nothing focused reaches the last enabled key, and Tab wraps to the first', () => {
  const disabled = run([disableOtherKeys])
  expect(disabled.state.keyEnabled).toEqual([true, false, true, false, true, false, true, false, true, false, true, false])
  expect(disabled.state.menu).toEqual({open: -1, highlight: -1, titleFocus: -1})
  expect(disabled.state.keypad.focus).toBe(-1)
  expect(run([disableOtherKeys, frame(key('Tab', true))]).state.keypad.focus).toBe(10)
  expect(run([disableOtherKeys, frame(key('Tab', true), key('Tab'))]).state.keypad.focus).toBe(0)
})

test('Tab while a menu title has focus leaves the menu bar and focuses the first key, and the next Tab skips a disabled key', () => {
  const titleFocused = run([disableOtherKeys, frame(key('Tab'))])
  expect(titleFocused.state.menu).toEqual({open: -1, highlight: -1, titleFocus: 0})
  expect(titleFocused.state.keypad.focus).toBe(-1)
  expect(titleFocused.focusTarget).toBe(0)
  const leftBar = run([disableOtherKeys, frame(key('Tab'), key('Tab'))])
  expect(leftBar.state.menu).toEqual({open: -1, highlight: -1, titleFocus: -1})
  expect(leftBar.state.keypad.focus).toBe(0)
  expect(leftBar.focusTarget).toBe(keyTarget(0))
  expect(run([disableOtherKeys, frame(key('Tab'), key('Tab'), key('Tab'))]).state.keypad.focus).toBe(2)
})

test('an outside press closes the menu and never reaches the windows', () => {
  const result = run([frame(pointer('down', 20, 10), pointer('up', 20, 10), pointer('down', 600, 200), pointer('up', 600, 200))])
  expect(result.state.menu.open).toBe(-1)
  expect(result.state.windows.focus).toBe(-1)
  expect(result.state.windows.pressed).toBe(false)
})

test('the status bar menu opens upward', () => {
  const result = run([frame()])
  expect(result.placementTops[3]).toBe(viewport.height - 28 - (2 * 26 + 8))
})

test('random mixed traces match the oracle every frame, and declared one-hot groups hold', () => {
  for (const seed of [61, 62, 63]) {
    const frames = generateAppTrace({seed, frames: 300, capacity: 8})
    machine.reset(frames[0]!.viewport)
    const oracle = createAppState(frames[0]!.viewport)
    frames.forEach((traceFrame, index) => {
      machine.writeViewport(traceFrame.viewport)
      const expected = appOracleFrame(traceFrame.viewport, oracle, traceFrame.frameDelta, traceFrame.events)
      if (index % 60 === 0) {
        machine.writeFrame(traceFrame.frameDelta, traceFrame.events)
        validateOneHotGroups(machine.circuit, machine.circuit.evaluateTensor(new Float32Array(machine.source)))
      }
      const actual = machine.step(traceFrame.frameDelta, traceFrame.events)
      expect(actual.state).toEqual(oracle)
      expect(actual.outputs).toEqual(expected)
    })
  }
})
