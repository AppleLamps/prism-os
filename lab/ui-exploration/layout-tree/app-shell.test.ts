import {describe as suite, expect, test} from 'bun:test'
import {createAppMachine, createAppShell, sidebarOpenWidth} from './app-shell.ts'
import {appTextTables} from './app-text-tables.ts'
import {compareLayouts} from './compare.ts'
import {layoutReference} from './reference.ts'

const tables = new Map(Object.entries(appTextTables))
const shell = createAppShell()

const frame = (viewportWidth: number, overrides: {pointerDown?: {x: number, y: number}, scrollDelta?: number, frameDuration?: number} = {}) => ({
  viewportWidth,
  viewportHeight: 820,
  frameDuration: overrides.frameDuration ?? 1 / 60,
  pointerDown: overrides.pointerDown ?? null,
  scrollDelta: overrides.scrollDelta ?? 0,
})

suite('app shell', () => {
  test('every frame matches the JS reference at the inputs the circuit used', () => {
    const machine = createAppMachine(shell, tables)
    let worst = 0
    const mismatches: string[] = []
    for (const viewportWidth of [320, 480, 639, 640, 800, 1024, 1280, 1600, 2400]) {
      for (let settle = 0; settle < 90; settle++) machine.step(frame(viewportWidth))
      for (const scrollDelta of [0, 300, 700, 5000]) {
        const result = machine.step(frame(viewportWidth, {scrollDelta}))
        const difference = compareLayouts(layoutReference(shell.root, result.inputs, tables), result.layout)
        worst = Math.max(worst, difference.maxDrift)
        mismatches.push(...difference.discreteMismatches)
      }
      machine.step(frame(viewportWidth, {scrollDelta: -10_000}))
    }
    expect(mismatches).toEqual([])
    expect(worst).toBeLessThan(0.01)
  })

  test('the grid reflows with the viewport width', () => {
    const machine = createAppMachine(shell, tables)
    const columnsAt = (viewportWidth: number) => {
      let result = machine.step(frame(viewportWidth))
      for (let settle = 0; settle < 90; settle++) result = machine.step(frame(viewportWidth))
      return result.layout.gridColumns.get('recent.grid')
    }
    expect(columnsAt(400)).toBe(1)
    expect(columnsAt(900)).toBe(2)
    expect(columnsAt(1600)).toBe(5)
  })

  test('the menu button toggles the sidebar through the spring, and narrow viewports hide it', () => {
    const machine = createAppMachine(shell, tables)
    let result = machine.step(frame(1280))
    for (let settle = 0; settle < 60; settle++) result = machine.step(frame(1280))
    expect(result.sidebarWidth).toBe(sidebarOpenWidth)
    expect(result.animating).toBe(false)
    const menu = result.layout.rects.get('menuButton')!
    result = machine.step(frame(1280, {pointerDown: {x: menu.x + 10, y: menu.y + 10}}))
    expect(result.animating).toBe(true)
    const widths: number[] = []
    for (let settle = 0; settle < 120; settle++) {
      result = machine.step(frame(1280))
      widths.push(result.sidebarWidth)
    }
    expect(widths.some(width => width > 1 && width < sidebarOpenWidth - 1)).toBe(true)
    expect(result.sidebarWidth).toBe(0)
    expect(result.animating).toBe(false)
    expect(result.layout.rects.get('main')!.x).toBe(0)
    // A press outside the button changes nothing.
    result = machine.step(frame(1280, {pointerDown: {x: menu.x + 60, y: menu.y + 10}}))
    for (let settle = 0; settle < 60; settle++) result = machine.step(frame(1280))
    expect(result.sidebarWidth).toBe(0)
    result = machine.step(frame(1280, {pointerDown: {x: menu.x + 1, y: menu.y + 39}}))
    for (let settle = 0; settle < 120; settle++) result = machine.step(frame(1280))
    expect(result.sidebarWidth).toBe(sidebarOpenWidth)
    for (let settle = 0; settle < 120; settle++) result = machine.step(frame(600))
    expect(result.sidebarWidth).toBe(0)
  })

  test('a 100 ms frame writes the clamped timestep, stays within the source ranges, and still matches the JS reference', () => {
    const machine = createAppMachine(shell, tables)
    let result = machine.step(frame(1280))
    const menu = result.layout.rects.get('menuButton')!
    // The machine clamps the frame to 32 ms and writes a quarter of it, which the Float32Array stores as 0.0080000004.
    result = machine.step(frame(1280, {pointerDown: {x: menu.x + 10, y: menu.y + 10}, frameDuration: 0.1}))
    expect(machine.values[shell.table.wire('spring.timestep')]).toBe(Math.fround(0.008))
    expect(result.animating).toBe(true)
    const mismatches: string[] = []
    for (let settle = 0; settle < 120; settle++) {
      result = machine.step(frame(1280, {frameDuration: 0.1}))
      mismatches.push(...compareLayouts(layoutReference(shell.root, result.inputs, tables), result.layout).discreteMismatches)
    }
    expect(mismatches).toEqual([])
    expect(result.sidebarWidth).toBe(0)
    expect(result.animating).toBe(false)
  })

  test('a section header sticks to the top of the scroll container, then leaves with its section', () => {
    const machine = createAppMachine(shell, tables)
    // A narrow viewport stacks one card per row, so the content is long enough to scroll through a section.
    let result = machine.step(frame(480))
    for (let settle = 0; settle < 90; settle++) result = machine.step(frame(480))
    const main = result.layout.rects.get('main')!
    const naturalTop = result.layout.rects.get('recent.header')!.y
    const recent = result.layout.rects.get('recent')!
    const headerHeight = result.layout.rects.get('recent.header')!.height
    expect(naturalTop).toBeGreaterThan(main.y)
    // Scroll a little past the header: it pins to the scroll container's top.
    const pinnedScroll = naturalTop - main.y + 150
    result = machine.step(frame(480, {scrollDelta: pinnedScroll}))
    expect(result.layout.scroll.get('main')).toBeCloseTo(pinnedScroll, 3)
    expect(result.layout.rects.get('recent.header')!.y).toBeCloseTo(main.y, 3)
    // Scroll until the section's bottom sits half a header below the top: the header rides up with it.
    const leavingScroll = recent.y + recent.height - main.y - headerHeight / 2
    result = machine.step(frame(480, {scrollDelta: leavingScroll - pinnedScroll}))
    expect(result.layout.scroll.get('main')).toBeCloseTo(leavingScroll, 3)
    const header = result.layout.rects.get('recent.header')!
    const section = result.layout.rects.get('recent')!
    expect(header.y).toBeCloseTo(main.y - headerHeight / 2, 3)
    expect(header.y + header.height).toBeCloseTo(section.y + section.height, 3)
    // The next section's header is still in its natural place below.
    expect(result.layout.rects.get('shared.header')!.y).toBeGreaterThan(main.y)
    // Scrolling far past the end clamps to the content's bottom.
    result = machine.step(frame(480, {scrollDelta: 100_000}))
    const lastCard = result.layout.rects.get('card13')!
    expect(lastCard.y + lastCard.height + 16).toBeCloseTo(main.y + main.height, 2)
    expect(result.layout.scroll.get('main')).toBeGreaterThan(0)
  })
})
