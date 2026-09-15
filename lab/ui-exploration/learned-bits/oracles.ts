// Copies of one-event-at-a-time oracles from lab/ui-exploration/input, so this
// folder doesn't import across folders. Behavior is unchanged; types are
// trimmed to what the oracles read.
// - cyclicNextEnabled: input/keyboard.ts
// - strictlyInside: input/windows.ts
// - the menu bar oracle and the placement helpers it reads: input/menu.ts

export type Rectangle = {left: number, top: number, width: number, height: number}

export function cyclicNextEnabled(enabled: readonly boolean[], from: number, backward: boolean): number {
  const count = enabled.length
  for (let step = 1; step <= count; step++) {
    const index = from === -1
      ? (backward ? count - step : step - 1)
      : (backward ? (from - step + count) % count : (from + step) % count)
    if (enabled[index]!) return index
  }
  return -1
}

export function strictlyInside(rectangle: Rectangle, x: number, y: number) {
  return x > rectangle.left && x < rectangle.left + rectangle.width && y > rectangle.top && y < rectangle.top + rectangle.height
}

export const keyNames = ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Space', 'Escape'] as const
export type KeyName = (typeof keyNames)[number]
export type QueuedEvent =
  | {kind: 'down' | 'move' | 'up', x: number, y: number, time: number}
  | {kind: 'key', key: KeyName, shift: boolean, time: number}

export type MenuDefinition = {anchor: Rectangle, panelWidth: number, present: readonly boolean[], enabled: readonly boolean[]}
export type MenuLayout = {
  viewportWidth: number
  viewportHeight: number
  itemHeight: number
  padding: number
  menus: readonly MenuDefinition[]
}
export type MenuState = {open: number, highlight: number, titleFocus: number}

export function insideHalfOpen(rectangle: Rectangle, x: number, y: number) {
  return x >= rectangle.left && x < rectangle.left + rectangle.width && y >= rectangle.top && y < rectangle.top + rectangle.height
}

export function menuItemCount(menu: MenuDefinition) {
  return menu.present.filter(Boolean).length
}

export function menuPlacementFlips(layout: MenuLayout, index: number) {
  const menu = layout.menus[index]!
  const anchor = menu.anchor
  const height = menuItemCount(menu) * layout.itemHeight + 2 * layout.padding
  return {
    up: anchor.top + anchor.height + height > layout.viewportHeight && anchor.top - height >= 0,
    left: anchor.left + menu.panelWidth > layout.viewportWidth,
  }
}

export function menuPlacement(layout: MenuLayout, index: number): Rectangle {
  const menu = layout.menus[index]!
  const anchor = menu.anchor
  const height = menuItemCount(menu) * layout.itemHeight + 2 * layout.padding
  const width = menu.panelWidth
  const belowTop = anchor.top + anchor.height
  const flips = menuPlacementFlips(layout, index)
  const top = Math.max(Math.min(flips.up ? anchor.top - height : belowTop, layout.viewportHeight - height), 0)
  const left = Math.max(Math.min(flips.left ? anchor.left + anchor.width - width : anchor.left, layout.viewportWidth - width), 0)
  return {left, top, width, height}
}

function titleAt(layout: MenuLayout, x: number, y: number) {
  return layout.menus.findIndex(menu => insideHalfOpen(menu.anchor, x, y))
}

export function availableItems(layout: MenuLayout, index: number) {
  const menu = layout.menus[index]!
  return menu.present.map((present, item) => present && menu.enabled[item]!)
}

// The available item under the pointer in the open menu, -1 otherwise.
function availableItemAt(layout: MenuLayout, index: number, x: number, y: number) {
  const panel = menuPlacement(layout, index)
  const available = availableItems(layout, index)
  for (let item = 0; item < available.length; item++) {
    const inside = x >= panel.left + layout.padding
      && x < panel.left + panel.width - layout.padding
      && y >= panel.top + layout.padding + item * layout.itemHeight
      && y < panel.top + layout.padding + (item + 1) * layout.itemHeight
    if (inside) return available[item]! ? item : -1
  }
  return -1
}

export function menuOracleEvent(layout: MenuLayout, state: MenuState, event: QueuedEvent, activations: number[][]) {
  const count = layout.menus.length
  if (event.kind === 'key') {
    if (state.open >= 0) {
      const available = availableItems(layout, state.open)
      switch (event.key) {
        case 'ArrowDown':
          state.highlight = cyclicNextEnabled(available, state.highlight, false)
          return
        case 'ArrowUp':
          state.highlight = cyclicNextEnabled(available, state.highlight, true)
          return
        case 'ArrowRight':
        case 'ArrowLeft':
          state.open = (state.open + (event.key === 'ArrowRight' ? 1 : count - 1)) % count
          state.highlight = cyclicNextEnabled(availableItems(layout, state.open), -1, false)
          return
        case 'Enter':
        case 'Space':
          if (state.highlight < 0) return
          activations[state.open]![state.highlight]!++
          state.titleFocus = state.open
          state.open = -1
          state.highlight = -1
          return
        case 'Escape':
          state.titleFocus = state.open
          state.open = -1
          state.highlight = -1
          return
        case 'Tab':
          state.titleFocus = -1
          state.open = -1
          state.highlight = -1
          return
      }
      return
    }
    if (state.titleFocus >= 0) {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowLeft':
          state.titleFocus = (state.titleFocus + (event.key === 'ArrowRight' ? 1 : count - 1)) % count
          return
        case 'ArrowDown':
        case 'Enter':
        case 'Space':
        case 'ArrowUp':
          state.open = state.titleFocus
          state.highlight = cyclicNextEnabled(availableItems(layout, state.open), -1, event.key === 'ArrowUp')
          return
        case 'Escape':
        case 'Tab':
          state.titleFocus = -1
          return
      }
      return
    }
    if (event.key === 'Tab') state.titleFocus = event.shift ? count - 1 : 0
    return
  }
  const {x, y} = event
  if (event.kind === 'down') {
    const title = titleAt(layout, x, y)
    if (title >= 0) {
      state.open = state.open === title ? -1 : title
      state.highlight = -1
    } else if (!(state.open >= 0 && insideHalfOpen(menuPlacement(layout, state.open), x, y))) {
      state.open = -1
      state.highlight = -1
    }
    state.titleFocus = -1
    return
  }
  if (state.open < 0) return
  if (event.kind === 'move') {
    const title = titleAt(layout, x, y)
    if (title >= 0 && title !== state.open) {
      state.open = title
      state.highlight = -1
      return
    }
    state.highlight = availableItemAt(layout, state.open, x, y)
    return
  }
  const item = availableItemAt(layout, state.open, x, y)
  if (item >= 0) {
    activations[state.open]![item]!++
    state.open = -1
    state.highlight = -1
    state.titleFocus = -1
  }
}
