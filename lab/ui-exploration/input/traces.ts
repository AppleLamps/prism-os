// Seeded random traces. Each frame has a duration and an event queue. A shadow
// copy of the oracle aims presses at what is currently on screen, keeps the
// pointer stream legal (downs and ups alternate), bounds downs per frame, and
// repeats press points so double clicks happen.

import {appKeyRectangles, appMenuLayout, appOracleEvent, appWindowsConfig, createAppState, type AppViewport} from './app.ts'
import type {KeyName, QueuedEvent} from './events.ts'
import type {ControlsLayout} from './keyboard.ts'
import {createRandom, randomInteger} from './kit.ts'
import {menuPlacement, type MenuDefinition, type MenuLayout} from './menu.ts'
import {createWindowsState, seenWindowRectangle, windowsOracleEvent, windowsOracleFrameStart, type Rectangle, type WindowsConfig} from './windows.ts'

export type Frame = {frameDelta: number, events: QueuedEvent[]}

const frameDeltas = [0, 4, 8.3125, 16.6875, 16.6875, 16.6875, 33.375, 120, 480, 900]

// Sorted times on the 1/16 ms grid inside -span..0.
export function randomEventTimes(random: () => number, count: number, span: number) {
  const ticks = Math.max(0, Math.floor(span * 16))
  // `0 - x` rather than `-x`, so a zero tick is +0 and not -0.
  return Array.from({length: count}, () => (0 - randomInteger(random, 0, ticks)) / 16).sort((a, b) => a - b)
}

export function generateWindowsTrace(config: WindowsConfig, options: {seed: number, frames: number, capacity: number, maximumDowns: number}): Frame[] {
  const random = createRandom(options.seed)
  const shadow = createWindowsState(config)
  const frames: Frame[] = []
  const count = config.windows.length
  const clampCoordinate = (value: number) => Math.max(-512, Math.min(2048, Math.round(value)))
  let lastPressX = 400
  let lastPressY = 300

  function aimDown(): {x: number, y: number} {
    const roll = random()
    const index = randomInteger(random, 0, count - 1)
    const rectangle = seenWindowRectangle(config, shadow, index)
    const title = config.titleHeight
    const button = config.buttonWidth
    if (roll < 0.15) return {x: lastPressX + randomInteger(random, -3, 3), y: lastPressY + randomInteger(random, -3, 3)}
    if (roll < 0.45) {
      return {
        x: rectangle.left + randomInteger(random, 1, Math.max(1, rectangle.width - button - 1)),
        y: rectangle.top + randomInteger(random, 1, title - 1),
      }
    }
    if (roll < 0.6) {
      return {
        x: rectangle.left + rectangle.width - randomInteger(random, 1, button),
        y: rectangle.top + randomInteger(random, 1, title - 1),
      }
    }
    if (roll < 0.85) {
      return {
        x: rectangle.left + randomInteger(random, 1, rectangle.width - 1),
        y: rectangle.top + randomInteger(random, title, rectangle.height - 1),
      }
    }
    return {x: randomInteger(random, -40, config.workspace.width + 40), y: randomInteger(random, -40, config.workspace.height + 40)}
  }

  for (let frame = 0; frame < options.frames; frame++) {
    const frameDelta = frameDeltas[randomInteger(random, 0, frameDeltas.length - 1)]!
    windowsOracleFrameStart(shadow, frameDelta)
    const eventCount = random() < 0.25 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const times = randomEventTimes(random, Math.min(eventCount, options.capacity), Math.min(frameDelta, 240))
    const events: QueuedEvent[] = []
    let downs = 0
    for (const time of times) {
      let event: QueuedEvent
      if (shadow.pressed) {
        const roll = random()
        if (roll < 0.6) {
          const reach = random() < 0.5 ? 3 : 60
          event = {kind: 'move', x: clampCoordinate(shadow.pointerX + randomInteger(random, -reach, reach)), y: clampCoordinate(shadow.pointerY + randomInteger(random, -reach, reach)), time}
        } else {
          const back = random() < 0.3
          event = {kind: 'up', x: back ? shadow.pressX : shadow.pointerX, y: back ? shadow.pressY : shadow.pointerY, time}
        }
      } else if (random() < 0.6 && downs < options.maximumDowns) {
        const target = aimDown()
        event = {kind: 'down', x: clampCoordinate(target.x), y: clampCoordinate(target.y), time}
        lastPressX = event.x
        lastPressY = event.y
        downs++
      } else {
        event = {kind: 'move', x: clampCoordinate(shadow.pointerX + randomInteger(random, -30, 30)), y: clampCoordinate(shadow.pointerY + randomInteger(random, -30, 30)), time}
      }
      windowsOracleEvent(config, shadow, event)
      events.push(event)
    }
    frames.push({frameDelta, events})
  }
  return frames
}

export type KeyboardFrame = {layout: ControlsLayout, events: QueuedEvent[]}

export function randomControlsLayout(random: () => number, count: number): ControlsLayout {
  return {
    rectangles: Array.from({length: count}, () => ({
      left: randomInteger(random, 0, 1000),
      top: randomInteger(random, 0, 700),
      width: randomInteger(random, 30, 220),
      height: randomInteger(random, 20, 120),
    })),
    enabled: Array.from({length: count}, () => random() < 0.8),
  }
}

// Key-heavy frames over one layout per trace, with enabled bits that change
// between some frames.
export function generateKeyboardTrace(options: {seed: number, frames: number, capacity: number, rectangles: readonly Rectangle[] | null, controlCount: number}): KeyboardFrame[] {
  const random = createRandom(options.seed)
  const base = options.rectangles === null ? randomControlsLayout(random, options.controlCount) : {rectangles: options.rectangles, enabled: options.rectangles.map(() => true)}
  let enabled = [...base.enabled]
  let pressed = false
  const frames: KeyboardFrame[] = []
  for (let frame = 0; frame < options.frames; frame++) {
    if (random() < 0.08) enabled = enabled.map(value => (random() < 0.15 ? !value : value))
    const eventCount = random() < 0.2 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const times = randomEventTimes(random, Math.min(eventCount, options.capacity), 48)
    const events: QueuedEvent[] = times.map((time): QueuedEvent => {
      const roll = random()
      if (pressed || roll < 0.12) {
        const target = base.rectangles[randomInteger(random, 0, base.rectangles.length - 1)]!
        const onTarget = random() < 0.85
        const x = onTarget ? target.left + randomInteger(random, 1, target.width - 1) : randomInteger(random, 0, 1280)
        const y = onTarget ? target.top + randomInteger(random, 1, target.height - 1) : randomInteger(random, 0, 800)
        const kind = pressed ? (random() < 0.3 ? 'move' : 'up') : 'down'
        if (kind === 'down') pressed = true
        if (kind === 'up') pressed = false
        return {kind, x, y, time}
      }
      const key = navigationKeys[randomInteger(random, 0, navigationKeys.length - 1)]!
      return {kind: 'key', key, shift: random() < 0.3, time}
    })
    frames.push({layout: {rectangles: base.rectangles, enabled}, events})
  }
  return frames
}

export const navigationKeys: readonly KeyName[] = ['Tab', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'Enter', 'Space', 'Escape']

export type AppFrame = {viewport: AppViewport, frameDelta: number, events: QueuedEvent[]}

// Mixed pointer and key frames for the combined app, aimed at menu titles,
// open menu items, window regions, and keypad keys through a shadow oracle.
export function generateAppTrace(options: {seed: number, frames: number, capacity: number}): AppFrame[] {
  const random = createRandom(options.seed)
  let viewport: AppViewport = {width: randomInteger(random, 720, 1400), height: randomInteger(random, 480, 900)}
  const shadow = createAppState(viewport)
  let pressed = false
  const frames: AppFrame[] = []
  const pointInside = (rectangle: Rectangle) => ({
    x: rectangle.left + randomInteger(random, 1, Math.max(1, rectangle.width - 1)),
    y: rectangle.top + randomInteger(random, 1, Math.max(1, rectangle.height - 1)),
  })
  for (let frame = 0; frame < options.frames; frame++) {
    if (random() < 0.03) viewport = {width: randomInteger(random, 720, 1400), height: randomInteger(random, 480, 900)}
    const frameDelta = frameDeltas[randomInteger(random, 0, frameDeltas.length - 1)]!
    windowsOracleFrameStart(shadow.windows, frameDelta)
    const eventCount = random() < 0.2 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const times = randomEventTimes(random, Math.min(eventCount, options.capacity), Math.min(frameDelta, 240))
    const events: QueuedEvent[] = []
    for (const time of times) {
      let event: QueuedEvent
      if (random() < 0.35) {
        event = {kind: 'key', key: navigationKeys[randomInteger(random, 0, navigationKeys.length - 1)]!, shift: random() < 0.3, time}
      } else {
        const aim = random()
        const windowsConfig = appWindowsConfig(viewport)
        const menuLayout = appMenuLayout(viewport)
        let point: {x: number, y: number}
        if (aim < 0.15) {
          point = pointInside(menuLayout.menus[randomInteger(random, 0, menuLayout.menus.length - 1)]!.anchor)
        } else if (aim < 0.35) {
          const menuIndex = shadow.menu.open >= 0 ? shadow.menu.open : randomInteger(random, 0, menuLayout.menus.length - 1)
          point = pointInside(menuPlacement(menuLayout, menuIndex))
        } else if (aim < 0.6) {
          const rectangle = seenWindowRectangle(windowsConfig, shadow.windows, randomInteger(random, 0, windowsConfig.windows.length - 1))
          point = random() < 0.5 ? pointInside({...rectangle, height: windowsConfig.titleHeight}) : pointInside(rectangle)
        } else if (aim < 0.85) {
          const keys = appKeyRectangles(seenWindowRectangle(windowsConfig, shadow.windows, 0), shadow.windows.maximized[0]!)
          point = pointInside(keys[randomInteger(random, 0, keys.length - 1)]!)
        } else {
          point = {x: randomInteger(random, 0, viewport.width), y: randomInteger(random, 0, viewport.height)}
        }
        if (pressed) {
          const kind = random() < 0.6 ? 'move' : 'up'
          if (kind === 'up') pressed = false
          event = {kind, x: point.x, y: point.y, time}
        } else if (random() < 0.45) {
          pressed = true
          event = {kind: 'down', x: point.x, y: point.y, time}
        } else {
          event = {kind: 'move', x: point.x, y: point.y, time}
        }
      }
      appOracleEvent(viewport, shadow, event)
      events.push(event)
    }
    frames.push({viewport, frameDelta, events})
  }
  return frames
}

export type MenuFrame = {layout: MenuLayout, events: QueuedEvent[]}

// A menu bar with titles side by side, random panel widths, item counts, and
// enabled items. Pointer events aim at titles, items, and empty space. Between
// some frames the viewport changes and the bar moves: to the top edge, to the
// bottom edge, or to a random height, with its titles starting near the left
// or ending near the right edge. That moves placements across both flip
// boundaries within every trace.
export function generateMenuTrace(options: {seed: number, frames: number, capacity: number, menuCount: number, itemSlots: number}): MenuFrame[] {
  const random = createRandom(options.seed)
  const definitions = Array.from({length: options.menuCount}, () => {
    const itemCount = randomInteger(random, 1, options.itemSlots)
    return {
      titleWidth: randomInteger(random, 40, 160),
      gap: randomInteger(random, 0, 12),
      panelWidth: randomInteger(random, 80, 360),
      present: Array.from({length: options.itemSlots}, (_, item) => item < itemCount),
      enabled: Array.from({length: options.itemSlots}, () => random() < 0.75),
    }
  })
  const barWidth = definitions.reduce((total, definition) => total + definition.titleWidth + definition.gap, 0)
  const itemHeight = randomInteger(random, 18, 32)
  const padding = randomInteger(random, 0, 8)
  let viewportWidth = randomInteger(random, 500, 1280)
  let viewportHeight = randomInteger(random, 300, 800)
  const placeBar = (): MenuDefinition[] => {
    const topRoll = random()
    const barTop = topRoll < 0.4 ? 0 : topRoll < 0.7 ? viewportHeight - 24 - randomInteger(random, 0, 24) : randomInteger(random, 0, viewportHeight)
    let titleLeft = random() < 0.7 ? randomInteger(random, 0, 200) : viewportWidth - barWidth - randomInteger(random, 0, 24)
    return definitions.map(definition => {
      const anchor = {left: titleLeft, top: barTop, width: definition.titleWidth, height: 24}
      titleLeft += definition.titleWidth + definition.gap
      return {anchor, panelWidth: definition.panelWidth, present: definition.present, enabled: definition.enabled}
    })
  }
  let menus = placeBar()
  let pressed = false
  const frames: MenuFrame[] = []
  for (let frame = 0; frame < options.frames; frame++) {
    if (random() < 0.05) {
      viewportWidth = randomInteger(random, 500, 1280)
      viewportHeight = randomInteger(random, 300, 800)
      menus = placeBar()
    }
    const layout: MenuLayout = {viewportWidth, viewportHeight, itemHeight, padding, menus}
    const eventCount = random() < 0.2 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const times = randomEventTimes(random, Math.min(eventCount, options.capacity), 48)
    const events = times.map((time): QueuedEvent => {
      const roll = random()
      if (roll < 0.35) {
        const key = navigationKeys[randomInteger(random, 0, navigationKeys.length - 1)]!
        return {kind: 'key', key, shift: random() < 0.3, time}
      }
      const aim = random()
      const menuIndex = randomInteger(random, 0, options.menuCount - 1)
      let x: number
      let y: number
      if (aim < 0.3) {
        const anchor = menus[menuIndex]!.anchor
        x = anchor.left + randomInteger(random, 0, anchor.width - 1)
        y = anchor.top + randomInteger(random, 0, anchor.height - 1)
      } else if (aim < 0.8) {
        const panel = menuPlacement(layout, menuIndex)
        x = panel.left + randomInteger(random, 0, Math.max(0, panel.width - 1))
        y = panel.top + randomInteger(random, 0, Math.max(0, panel.height - 1))
      } else {
        x = randomInteger(random, -20, viewportWidth + 20)
        y = randomInteger(random, -20, viewportHeight + 20)
      }
      if (pressed) {
        const kind = random() < 0.5 ? 'move' : 'up'
        if (kind === 'up') pressed = false
        return {kind, x, y, time}
      }
      if (random() < 0.4) {
        pressed = true
        return {kind: 'down', x, y, time}
      }
      return {kind: 'move', x, y, time}
    })
    frames.push({layout, events})
  }
  return frames
}
