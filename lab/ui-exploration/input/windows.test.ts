import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import type {QueuedEvent} from './events.ts'
import {testWindowsConfig as config} from './fixtures.ts'
import {generateWindowsTrace, type Frame} from './traces.ts'
import {createWindowsMachine, createWindowsState, windowsOracleFrame, type WindowsMachine, type WindowsState} from './windows.ts'

const machines = [
  ['unrolled', createWindowsMachine(config, 16, {kind: 'unrolled'})],
  ['folded with session reads', createWindowsMachine(config, 16, {kind: 'folded', maximumDowns: 2, pressPoint: 'session'})],
  ['folded with a prefix scan', createWindowsMachine(config, 16, {kind: 'folded', maximumDowns: 2, pressPoint: 'prefix-scan'})],
] as const

// Runs frames through the oracle and one circuit from the initial state,
// requiring equal state and display after every frame.
function runFrames(machine: WindowsMachine, frames: readonly Frame[]): WindowsState {
  machine.reset()
  const oracle = createWindowsState(config)
  for (const frame of frames) {
    const expectedDisplay = windowsOracleFrame(config, oracle, frame.frameDelta, frame.events)
    const actual = machine.step(frame.frameDelta, frame.events)
    expect(actual.state).toEqual(oracle)
    expect(actual.display).toEqual(expectedDisplay)
  }
  return oracle
}

const down = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'down', x, y, time})
const move = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'move', x, y, time})
const up = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'up', x, y, time})

// Window 0: title band y 1..27, maximize button x 472..499.
const button0 = {x: 485, y: 10}
const title0 = {x: 200, y: 10}

describe.each(machines)('%s', (_, machine) => {
  test('a click on the maximize button toggles maximize', () => {
    const state = runFrames(machine, [{frameDelta: 16.6875, events: [down(button0.x, button0.y, -9), up(button0.x, button0.y, -2)]}])
    expect(state.maximized[0]).toBe(true)
    expect(state.focus).toBe(0)
  })

  test('moving outward past slop and back cancels the click, within one frame', () => {
    const state = runFrames(machine, [{
      frameDelta: 16.6875,
      events: [down(button0.x, button0.y, -12), move(button0.x + 20, button0.y, -8), move(button0.x, button0.y, -4), up(button0.x, button0.y, 0)],
    }])
    expect(state.maximized[0]).toBe(false)
    expect(state.pressed).toBe(false)
  })

  test('moving outward past slop and back cancels the click, across frames', () => {
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(button0.x, button0.y)]},
      {frameDelta: 16.6875, events: [move(button0.x + 20, button0.y)]},
      {frameDelta: 16.6875, events: [move(button0.x, button0.y)]},
      {frameDelta: 16.6875, events: [up(button0.x, button0.y)]},
    ])
    expect(state.maximized[0]).toBe(false)
  })

  test('down, up, down within one frame: the second down sees the maximized window', () => {
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(button0.x, button0.y, -12), up(button0.x, button0.y, -8), down(button0.x, button0.y, -4)]},
    ])
    expect(state.maximized[0]).toBe(true)
    expect(state.pressed).toBe(true)
    expect(state.pressWindow).toBe(0)
    expect(state.pressWasMaximized).toBe(true)
    // The maximized window's button sits at the workspace's right edge, so the
    // same point is now on the title bar.
    expect(state.pressOnButton).toBe(false)
    expect(state.pressOnTitle).toBe(true)
  })

  test('a drag commit is visible to a down later in the same frame', () => {
    // Window 2's title band is y 421..447. Drag it up and right by 100, then
    // press where its title bar landed.
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(800, 430, -12), move(900, 330, -9), up(900, 330, -6), down(870, 330, -3)]},
    ])
    expect(state.left[2]).toBe(860)
    expect(state.top[2]).toBe(320)
    expect(state.pressWindow).toBe(2)
    expect(state.pressOnTitle).toBe(true)
  })

  test('raise to front changes which window a later down in the frame hits', () => {
    // (450, 250) is covered by window 1 first. After window 0 is pressed and
    // raised, the same point hits window 0.
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(450, 250, -10), up(450, 250, -8)]},
      {frameDelta: 0, events: [down(title0.x, title0.y, -6), up(title0.x, title0.y, -4), down(450, 250, -2)]},
    ])
    expect(state.pressWindow).toBe(0)
    expect(state.rank[0]).toBe(3)
  })

  test('double click on the title toggles maximize, across frames', () => {
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(title0.x, title0.y, -10), up(title0.x, title0.y, -2)]},
      {frameDelta: 120, events: [down(title0.x + 2, title0.y, -6), up(title0.x + 2, title0.y, 0)]},
    ])
    expect(state.maximized[0]).toBe(true)
    expect(state.lastClickValid).toBe(false)
  })

  test('double click on the title toggles maximize, within one frame', () => {
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(title0.x, title0.y, -40), up(title0.x, title0.y, -30), down(title0.x, title0.y, -20), up(title0.x, title0.y, -10)]},
    ])
    expect(state.maximized[0]).toBe(true)
  })

  test('a slow second click starts a new double click instead of toggling', () => {
    const firstClick: Frame = {frameDelta: 16.6875, events: [down(title0.x, title0.y, -10), up(title0.x, title0.y, -2)]}
    const slowClick: Frame = {frameDelta: 600, events: [down(title0.x, title0.y, -6), up(title0.x, title0.y, 0)]}
    expect(runFrames(machine, [firstClick, slowClick]).maximized[0]).toBe(false)
    const fastClick: Frame = {frameDelta: 100, events: [down(title0.x, title0.y, -6), up(title0.x, title0.y, 0)]}
    expect(runFrames(machine, [firstClick, slowClick, fastClick]).maximized[0]).toBe(true)
  })

  test('a second click farther than slop does not toggle', () => {
    const state = runFrames(machine, [
      {frameDelta: 16.6875, events: [down(title0.x, title0.y, -10), up(title0.x, title0.y, -2)]},
      {frameDelta: 16.6875, events: [down(title0.x + 10, title0.y, -6), up(title0.x + 10, title0.y, 0)]},
    ])
    expect(state.maximized[0]).toBe(false)
  })

  test('three quick clicks toggle once, four toggle twice', () => {
    // At most two downs per evaluation for the folded circuits, so the clicks
    // go into zero-duration evaluations, as the JS splitter does.
    const clicks = (count: number): Frame[] => Array.from({length: count}, (_, index) => ({
      frameDelta: index === 0 ? 16.6875 : 0,
      events: [down(title0.x, title0.y, -40 + index * 10), up(title0.x, title0.y, -36 + index * 10)],
    }))
    expect(runFrames(machine, clicks(3)).maximized[0]).toBe(true)
    expect(runFrames(machine, clicks(4)).maximized[0]).toBe(false)
  })

  test('random traces match the oracle every frame, and declared one-hot groups hold', () => {
    const frames = generateWindowsTrace(config, {seed: 11, frames: 600, capacity: 16, maximumDowns: 2})
    machine.reset()
    const oracle = createWindowsState(config)
    let toggles = 0
    let commits = 0
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!
      const maximizedBefore = [...oracle.maximized]
      const leftBefore = [...oracle.left]
      const expectedDisplay = windowsOracleFrame(config, oracle, frame.frameDelta, frame.events)
      toggles += oracle.maximized.filter((value, window) => value !== maximizedBefore[window]).length
      commits += oracle.left.filter((value, window) => value !== leftBefore[window]).length
      if (index % 40 === 0) {
        machine.writeFrame(frame.frameDelta, frame.events)
        validateOneHotGroups(machine.circuit, machine.circuit.evaluateTensor(machine.source))
      }
      const actual = machine.step(frame.frameDelta, frame.events)
      expect(actual.state).toEqual(oracle)
      expect(actual.display).toEqual(expectedDisplay)
    }
    expect(toggles).toBeGreaterThan(10)
    expect(commits).toBeGreaterThan(10)
  })
})

test('the folded circuit refuses more downs than it was built for', () => {
  const machine = createWindowsMachine(config, 8, {kind: 'folded', maximumDowns: 1, pressPoint: 'session'})
  expect(() => machine.step(0, [down(10, 10), up(10, 10), down(10, 10)])).toThrow()
})
