import {expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {writeEventQueue, type KeyName, type QueuedEvent} from './events.ts'
import {createMenuMachine, menuOracleEvent, menuOracleFocusTarget, menuPlacement, menuPlacementFlips, type MenuLayout, type MenuState} from './menu.ts'
import {generateMenuTrace} from './traces.ts'

const itemSlots = 5
const machine = createMenuMachine(3, itemSlots, 8)

const barLayout: MenuLayout = {
  viewportWidth: 800,
  viewportHeight: 600,
  itemHeight: 24,
  padding: 4,
  menus: [
    {anchor: {left: 0, top: 0, width: 60, height: 24}, panelWidth: 200, present: [true, true, true, true, false], enabled: [true, false, true, true, false]},
    {anchor: {left: 60, top: 0, width: 60, height: 24}, panelWidth: 160, present: [true, true, true, false, false], enabled: [true, true, true, false, false]},
    {anchor: {left: 740, top: 0, width: 60, height: 24}, panelWidth: 220, present: [true, true, false, false, false], enabled: [false, true, false, false, false]},
  ],
}

const key = (name: KeyName, shift = false): QueuedEvent => ({kind: 'key', key: name, shift, time: 0})
const pointer = (kind: 'down' | 'move' | 'up', x: number, y: number): QueuedEvent => ({kind, x, y, time: 0})

function run(layout: MenuLayout, frames: readonly QueuedEvent[][]) {
  machine.reset(layout)
  const oracle: MenuState = {open: -1, highlight: -1, titleFocus: -1}
  let result = machine.step([])
  let totalActivations = layout.menus.map(() => Array.from({length: itemSlots}, () => 0))
  for (const events of frames) {
    const activations = layout.menus.map(() => Array.from({length: itemSlots}, () => 0))
    for (const event of events) menuOracleEvent(layout, oracle, event, activations)
    result = machine.step(events)
    expect(result.state).toEqual(oracle)
    expect(result.activations).toEqual(activations)
    expect(result.focusTarget).toBe(menuOracleFocusTarget(layout, oracle, itemSlots))
    expect(result.placements).toEqual(layout.menus.map((_, index) => menuPlacement(layout, index)))
    totalActivations = totalActivations.map((row, index) => row.map((value, item) => value + activations[index]![item]!))
  }
  return {...result, totalActivations}
}

// Menu 0's panel: left 0, top 24, items at y 28..51, 52..75, 76..99, 100..123.
const itemCenter = (item: number) => ({x: 50, y: 28 + item * 24 + 12})

test('press on a title opens it, hovering highlights, releasing on an item activates and closes', () => {
  const result = run(barLayout, [
    [pointer('down', 20, 10), pointer('up', 20, 10)],
    [pointer('move', itemCenter(2).x, itemCenter(2).y)],
  ])
  expect(result.state).toEqual({open: 0, highlight: 2, titleFocus: -1})
  const released = run(barLayout, [
    [pointer('down', 20, 10), pointer('move', itemCenter(2).x, itemCenter(2).y), pointer('up', itemCenter(2).x, itemCenter(2).y)],
  ])
  expect(released.state.open).toBe(-1)
  expect(released.totalActivations[0]![2]).toBe(1)
})

test('hovering a disabled item clears the highlight, and releasing on it does nothing', () => {
  const result = run(barLayout, [[pointer('down', 20, 10), pointer('move', itemCenter(1).x, itemCenter(1).y), pointer('up', itemCenter(1).x, itemCenter(1).y)]])
  expect(result.state).toEqual({open: 0, highlight: -1, titleFocus: -1})
  expect(result.totalActivations.flat().every(count => count === 0)).toBe(true)
})

test('an outside press dismisses the open menu; a press on its title toggles it closed', () => {
  expect(run(barLayout, [[pointer('down', 20, 10), pointer('up', 20, 10), pointer('down', 500, 400)]]).state.open).toBe(-1)
  expect(run(barLayout, [[pointer('down', 20, 10), pointer('up', 20, 10), pointer('down', 20, 10)]]).state.open).toBe(-1)
})

test('moving across titles while a menu is open switches menus', () => {
  expect(run(barLayout, [[pointer('down', 20, 10), pointer('up', 20, 10), pointer('move', 90, 10)]]).state.open).toBe(1)
})

test('keyboard: Tab focuses the bar, arrows open and navigate, Enter activates and returns focus to the title', () => {
  const opened = run(barLayout, [[key('Tab'), key('ArrowDown')]])
  // Item 1 of menu 0 is disabled, so the first ArrowDown lands on item 0 and
  // the next skips to item 2.
  expect(opened.state).toEqual({open: 0, highlight: 0, titleFocus: 0})
  // Item targets start after the three titles: 3 + menu * itemSlots + item.
  const menuCount = 3
  expect(opened.focusTarget).toBe(menuCount)
  const moved = run(barLayout, [[key('Tab'), key('ArrowDown'), key('ArrowDown'), key('Enter')]])
  expect(moved.totalActivations[0]![2]).toBe(1)
  expect(moved.state).toEqual({open: -1, highlight: -1, titleFocus: 0})
  expect(moved.focusTarget).toBe(0)
  const switched = run(barLayout, [[key('Tab', true), key('ArrowUp'), key('ArrowRight')]])
  // Shift+Tab focuses the last title. ArrowUp opens it at its last enabled
  // item, and ArrowRight wraps to menu 0 at its first enabled item.
  expect(switched.state).toEqual({open: 0, highlight: 0, titleFocus: 2})
  expect(run(barLayout, [[key('Tab'), key('ArrowDown'), key('Escape')]]).state).toEqual({open: -1, highlight: -1, titleFocus: 0})
})

test('placement flips right-aligned near the right edge and above near the bottom', () => {
  const result = run(barLayout, [[]])
  expect(result.placements[2]).toEqual({left: 580, top: 24, width: 220, height: 56})
  const bottomBar: MenuLayout = {...barLayout, menus: barLayout.menus.map(menu => ({...menu, anchor: {...menu.anchor, top: 576}}))}
  const flipped = run(bottomBar, [[]])
  expect(flipped.placements[0]).toEqual({left: 0, top: 472, width: 200, height: 104})
})

test('random traces match the oracle every frame, and declared one-hot groups hold', () => {
  let upwardFlipFrames = 0
  let rightAlignedFrames = 0
  for (const seed of [21, 22, 23, 24]) {
    const frames = generateMenuTrace({seed, frames: 250, capacity: 8, menuCount: 3, itemSlots})
    machine.reset(frames[0]!.layout)
    const oracle: MenuState = {open: -1, highlight: -1, titleFocus: -1}
    let activationCount = 0
    frames.forEach((frame, index) => {
      machine.writeLayout(frame.layout)
      const activations = frame.layout.menus.map(() => Array.from({length: itemSlots}, () => 0))
      for (const event of frame.events) menuOracleEvent(frame.layout, oracle, event, activations)
      if (index % 50 === 0) {
        // The previous step cleared the queue, so write this frame's events first.
        writeEventQueue(machine.source, machine.slots, frame.events)
        validateOneHotGroups(machine.circuit, machine.circuit.evaluateTensor(new Float32Array(machine.source)))
      }
      const result = machine.step(frame.events)
      expect(result.state).toEqual(oracle)
      expect(result.activations).toEqual(activations)
      expect(result.focusTarget).toBe(menuOracleFocusTarget(frame.layout, oracle, itemSlots))
      expect(result.placements).toEqual(frame.layout.menus.map((_, menuIndex) => menuPlacement(frame.layout, menuIndex)))
      activationCount += activations.flat().reduce((total, value) => total + value, 0)
      const flips = frame.layout.menus.map((_, menuIndex) => menuPlacementFlips(frame.layout, menuIndex))
      if (flips.some(flip => flip.up)) upwardFlipFrames++
      if (flips.some(flip => flip.left)) rightAlignedFrames++
    })
    expect(activationCount).toBeGreaterThan(0)
  }
  expect(upwardFlipFrames).toBeGreaterThan(0)
  expect(rightAlignedFrames).toBeGreaterThan(0)
})
