// The combined app for the demo: a menu bar (three menus at the top and one in
// a status bar at the bottom), three windows, and a keypad of twelve keys
// inside the first window. One circuit handles every queued event of a frame in
// one evaluation, unrolled per queue slot, and JS splits frames with more
// events than the capacity into more evaluations.
//
// Routing between the parts, per event, from the state before the event:
// - Keys go to the menu bar while a menu is open or a title has focus, and to
//   the keypad while a key has focus. With nothing focused, Tab goes to the
//   menu bar (first title) and every other key goes to the keypad (so arrows
//   and Shift+Tab focus a key). Tab while the menu bar has focus leaves it and
//   also reaches the keypad, which focuses its first key.
// - A down on a menu title, or any down while a menu is open, belongs to the
//   menu bar; the windows never see it. Moves and ups reach both.
// - A down focuses a keypad key only when the keypad window is the frontmost
//   window under the pointer. Any other down clears keypad focus.
// - Menu actions apply after the parts have handled the event: maximize the
//   focused window, cycle to the next window, reset positions, focus the
//   keypad, disable every other key, reset key counts, cascade windows,
//   restore all windows. "About" is a JS side effect, reported as a count.

import {invariant} from '../../../numeric-ui-core.ts'
import {allocateEventQueue, isOnTimeGrid, eventTimeLimit, writeEventQueue, type EventSlot, type KeyName, type QueuedEvent} from './events.ts'
import {cyclicNextAvailable, cyclicNextEnabled, keyboardEventStep, keyboardOracleEvent, type ControlGeometry, type ControlsLayout, type KeyboardCells, type KeyboardState} from './keyboard.ts'
import {createKit, readBit, readOneHot, SourceLayout, type Kit, type Term, type Wire} from './kit.ts'
import {firstAvailable, insideHalfOpen, menuEventStep, menuFocusTarget, menuOracleEvent, menuOracleFocusTarget, menuPlacement, menuPrecompute, type AnchorGeometry, type MenuCells, type MenuConstants, type MenuLayout, type MenuState} from './menu.ts'
import {
  allocateWindowsCells,
  createWindowsState,
  declareWindowsOneHots,
  flattenWindowsCells,
  raiseRanks,
  raiseWindow,
  readWindowsState,
  seenWindowRectangle,
  windowsAgeClickTime,
  windowsDisplay,
  windowsEventStep,
  windowsFrontmostHit,
  windowsOracleDisplay,
  windowsOracleEvent,
  windowsOracleFrameStart,
  writeWindowsState,
  type Rectangle,
  type WindowsCells,
  type WindowsConfig,
  type WindowsConstants,
  type WindowsDisplay,
  type WindowsState,
} from './windows.ts'

export const appMenuBarHeight = 28
export const appStatusBarHeight = 28
export const appItemSlots = 4
export const appKeyCount = 12
export const appKeyCountLimit = 99999

export const appWindows = [
  {title: 'Keypad', width: 400, height: 340, initialLeft: 40, initialTop: 70},
  {title: 'Notes', width: 360, height: 240, initialLeft: 480, initialTop: 110},
  {title: 'Inspector', width: 300, height: 280, initialLeft: 300, initialTop: 360},
] as const

export const appMenus = [
  {title: 'Window', titleWidth: 76, panelWidth: 230, items: ['Maximize focused window', 'Cycle to next window', 'Reset positions', 'Minimize all'], enabled: [true, true, true, false]},
  {title: 'Keypad', titleWidth: 72, panelWidth: 200, items: ['Focus the keypad', 'Disable every other key', 'Reset counts'], enabled: [true, true, true]},
  {title: 'Help', titleWidth: 56, panelWidth: 180, items: ['About this demo'], enabled: [true]},
  {title: 'Layout', titleWidth: 88, panelWidth: 200, items: ['Cascade windows', 'Restore all windows'], enabled: [true, true]},
] as const

export const appKeyLabels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const

const action = {
  maximizeFocused: [0, 0],
  cycleWindows: [0, 1],
  resetPositions: [0, 2],
  focusKeypad: [1, 0],
  disableOtherKeys: [1, 1],
  resetCounts: [1, 2],
  about: [2, 0],
  cascade: [3, 0],
  restoreAll: [3, 1],
} as const

export type AppViewport = {width: number, height: number}

export function validateAppViewport(viewport: AppViewport) {
  invariant(Number.isInteger(viewport.width) && viewport.width >= 480 && viewport.width <= 4096, `viewport width ${viewport.width} must be a whole number inside 480..4096`)
  invariant(Number.isInteger(viewport.height) && viewport.height >= 360 && viewport.height <= 4096, `viewport height ${viewport.height} must be a whole number inside 360..4096`)
}

export function appWindowsConfig(viewport: AppViewport): WindowsConfig {
  return {
    workspace: {left: 0, top: appMenuBarHeight, width: viewport.width, height: viewport.height - appMenuBarHeight - appStatusBarHeight},
    windows: appWindows.map(window => ({width: window.width, height: window.height, initialLeft: window.initialLeft, initialTop: window.initialTop})),
    titleHeight: 28,
    buttonWidth: 28,
    slop: 4,
    doubleClickInterval: 500,
  }
}

export function appMenuAnchors(viewport: AppViewport): Rectangle[] {
  let left = 8
  return appMenus.map((menu, index) => {
    if (index === appMenus.length - 1) {
      return {left: viewport.width - 8 - menu.titleWidth, top: viewport.height - appStatusBarHeight, width: menu.titleWidth, height: appStatusBarHeight}
    }
    const anchor = {left, top: 0, width: menu.titleWidth, height: appMenuBarHeight}
    left += menu.titleWidth + 4
    return anchor
  })
}

export function appMenuLayout(viewport: AppViewport): MenuLayout {
  const anchors = appMenuAnchors(viewport)
  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    itemHeight: 26,
    padding: 4,
    menus: appMenus.map((menu, index) => ({
      anchor: anchors[index]!,
      panelWidth: menu.panelWidth,
      present: Array.from({length: appItemSlots}, (_, item) => item < menu.items.length),
      enabled: Array.from({length: appItemSlots}, (_, item) => item < menu.items.length && menu.enabled[item]!),
    })),
  }
}

// Key rectangles relative to the keypad window: 3 x 4 normally, 6 x 2 while
// maximized.
export function appKeyOffset(index: number, maximized: boolean): Rectangle {
  if (maximized) return {left: 24 + (index % 6) * 170, top: 60 + Math.floor(index / 6) * 130, width: 150, height: 110}
  return {left: 16 + (index % 3) * 122, top: 44 + Math.floor(index / 3) * 70, width: 112, height: 60}
}

export function appKeyRectangles(windowRectangle: Rectangle, maximized: boolean): Rectangle[] {
  return Array.from({length: appKeyCount}, (_, index) => {
    const offset = appKeyOffset(index, maximized)
    return {left: windowRectangle.left + offset.left, top: windowRectangle.top + offset.top, width: offset.width, height: offset.height}
  })
}

export function cascadePosition(index: number) {
  return {left: 40 + 48 * index, top: appMenuBarHeight + 40 + 48 * index}
}

export type AppState = {
  windows: WindowsState
  menu: MenuState
  keypad: KeyboardState
  keyEnabled: boolean[]
  keyCounts: number[]
}

export function createAppState(viewport: AppViewport): AppState {
  return {
    windows: createWindowsState(appWindowsConfig(viewport)),
    menu: {open: -1, highlight: -1, titleFocus: -1},
    keypad: {focus: -1, pressedControl: -1},
    keyEnabled: Array.from({length: appKeyCount}, () => true),
    keyCounts: Array.from({length: appKeyCount}, () => 0),
  }
}

export function appOracleEvent(viewport: AppViewport, state: AppState, event: QueuedEvent): number {
  const windowsConfig = appWindowsConfig(viewport)
  const menuLayout = appMenuLayout(viewport)
  const keyLayout: ControlsLayout = {
    rectangles: appKeyRectangles(seenWindowRectangle(windowsConfig, state.windows, 0), state.windows.maximized[0]!),
    enabled: state.keyEnabled,
  }
  const menuActive = state.menu.open >= 0 || state.menu.titleFocus >= 0
  const keypadActive = state.keypad.focus >= 0
  const menuActivations = appMenus.map(() => Array.from({length: appItemSlots}, () => 0))
  const keyActivations = Array.from({length: appKeyCount}, () => 0)
  if (event.kind === 'key') {
    const tabForward = event.key === 'Tab' && !event.shift
    const toMenu = menuActive || (!keypadActive && tabForward)
    const toKeypad = keypadActive || (!menuActive && !tabForward) || (menuActive && tabForward)
    if (toMenu) menuOracleEvent(menuLayout, state.menu, event, menuActivations)
    if (toKeypad) keyboardOracleEvent(keyLayout, state.keypad, event, keyActivations)
  } else {
    const consumedDown = event.kind === 'down'
      && (menuLayout.menus.some(menu => insideHalfOpen(menu.anchor, event.x, event.y)) || state.menu.open >= 0)
    const frontmost = event.kind === 'down' && !consumedDown ? windowsFrontmostHit(windowsConfig, state.windows, event.x, event.y) : -1
    menuOracleEvent(menuLayout, state.menu, event, menuActivations)
    if (!consumedDown) windowsOracleEvent(windowsConfig, state.windows, event)
    if (event.kind === 'down' && frontmost !== 0) {
      state.keypad.focus = -1
      state.keypad.pressedControl = -1
    } else {
      keyboardOracleEvent(keyLayout, state.keypad, event, keyActivations)
    }
  }

  state.keyCounts = state.keyCounts.map((count, index) => Math.min(count + keyActivations[index]!, appKeyCountLimit))
  const activated = ([menu, item]: readonly [number, number]) => menuActivations[menu]![item]! > 0
  const windows = state.windows
  if (activated(action.maximizeFocused) && windows.focus >= 0) windows.maximized[windows.focus] = !windows.maximized[windows.focus]!
  if (activated(action.cycleWindows)) {
    windows.focus = (windows.focus + 1) % appWindows.length
    raiseWindow(windows, windows.focus)
  }
  if (activated(action.resetPositions)) {
    appWindows.forEach((window, index) => {
      windows.left[index] = window.initialLeft
      windows.top[index] = window.initialTop
    })
  }
  if (activated(action.cascade)) {
    appWindows.forEach((_, index) => {
      windows.left[index] = cascadePosition(index).left
      windows.top[index] = cascadePosition(index).top
    })
  }
  if (activated(action.resetPositions) || activated(action.cascade) || activated(action.restoreAll)) {
    windows.maximized = windows.maximized.map(() => false)
  }
  if (activated(action.focusKeypad)) {
    state.keypad.focus = cyclicNextEnabled(state.keyEnabled, -1, false)
    state.menu.titleFocus = -1
  }
  if (activated(action.disableOtherKeys)) state.keyEnabled = state.keyEnabled.map((enabled, index) => (index % 2 === 1 ? !enabled : enabled))
  if (activated(action.resetCounts)) state.keyCounts = state.keyCounts.map(() => 0)
  return menuActivations[action.about[0]]![action.about[1]]!
}

export type AppOutputs = {
  windows: WindowsDisplay
  placements: Rectangle[]
  keyRectangles: Rectangle[]
  focusTarget: number
  aboutActivations: number
}

export function appOracleFocusTarget(state: AppState) {
  const menuTarget = menuOracleFocusTarget(appMenuLayout({width: 480, height: 360}), state.menu, appItemSlots)
  if (menuTarget >= 0) return menuTarget
  return state.keypad.focus >= 0 ? appMenus.length + appMenus.length * appItemSlots + state.keypad.focus : -1
}

export function appOracleFrame(viewport: AppViewport, state: AppState, frameDelta: number, events: readonly QueuedEvent[]): AppOutputs {
  windowsOracleFrameStart(state.windows, frameDelta)
  let aboutActivations = 0
  for (const event of events) aboutActivations += appOracleEvent(viewport, state, event)
  const windowsConfig = appWindowsConfig(viewport)
  const display = windowsOracleDisplay(windowsConfig, state.windows)
  const layout = appMenuLayout(viewport)
  return {
    windows: display,
    placements: layout.menus.map((_, index) => menuPlacement(layout, index)),
    keyRectangles: appKeyRectangles(display.rectangles[0]!, state.windows.maximized[0]!),
    focusTarget: appOracleFocusTarget(state),
    aboutActivations,
  }
}

// ---------------------------------------------------------------------------
// Circuit

export type AppCells = {
  windows: WindowsCells
  menu: MenuCells
  keypad: KeyboardCells
  keyEnabled: Wire[]
  keyCounts: Wire[]
}

function flattenAppCells(cells: AppCells): Wire[] {
  return [
    ...flattenWindowsCells(cells.windows),
    ...cells.menu.open, ...cells.menu.highlight, ...cells.menu.titleFocus,
    ...cells.keypad.focus, ...cells.keypad.pressedControl,
    ...cells.keyEnabled, ...cells.keyCounts,
  ]
}

function keyGeometry(kit: Kit, window: {left: Wire, top: Wire}, maximized: Wire): ControlGeometry[] {
  return Array.from({length: appKeyCount}, (_, index) => {
    const normal = appKeyOffset(index, false)
    const wide = appKeyOffset(index, true)
    const offset = (field: 'left' | 'top' | 'width' | 'height'): Term[] => [[kit.one, normal[field]], [maximized, wide[field] - normal[field]]]
    return {
      left: [[window.left, 1], ...offset('left')],
      top: [[window.top, 1], ...offset('top')],
      width: offset('width'),
      height: offset('height'),
    }
  })
}

function withKeys(kit: Kit, slot: EventSlot, gate: Wire): EventSlot {
  const keys = {} as Record<KeyName, Wire>
  for (const name of Object.keys(slot.keys) as KeyName[]) keys[name] = kit.and([slot.keys[name], gate])
  return {...slot, key: kit.and([slot.key, gate]), keys}
}

export function buildAppCircuit(capacity: number) {
  const windowCount = appWindows.length
  const menuCount = appMenus.length
  const layout = new SourceLayout()
  const viewportWidth = layout.cell('viewportWidth', 480, 4096)
  const viewportHeight = layout.cell('viewportHeight', 360, 4096)
  const frameDelta = layout.cell('frameDelta', 0, eventTimeLimit)
  const windowWidths = layout.cells('windowWidth', windowCount, 1, 4096)
  const windowHeights = layout.cells('windowHeight', windowCount, 1, 4096)
  const menuConstants: MenuConstants = {
    viewportWidth,
    viewportHeight,
    itemHeight: layout.cell('itemHeight', 1, 256),
    padding: layout.cell('padding', 0, 64),
    panelWidth: layout.cells('panelWidth', menuCount, 1, 4096),
    present: Array.from({length: menuCount}, (_, index) => layout.cells(`present[${index}]`, appItemSlots, 0, 1)),
    enabled: Array.from({length: menuCount}, (_, index) => layout.cells(`enabled[${index}]`, appItemSlots, 0, 1)),
  }
  const cells: AppCells = {
    windows: allocateWindowsCells(layout, windowCount),
    menu: {
      open: layout.cells('open', menuCount, 0, 1),
      highlight: layout.cells('highlight', appItemSlots, 0, 1),
      titleFocus: layout.cells('titleFocus', menuCount, 0, 1),
    },
    keypad: {
      focus: layout.cells('keyFocus', appKeyCount, 0, 1),
      pressedControl: layout.cells('pressedKey', appKeyCount, 0, 1),
    },
    keyEnabled: layout.cells('keyEnabled', appKeyCount, 0, 1),
    keyCounts: layout.cells('keyCount', appKeyCount, 0, appKeyCountLimit),
  }
  const slots = allocateEventQueue(layout, capacity)
  const circuit = layout.createCircuit()
  const kit = createKit(circuit)
  declareWindowsOneHots(kit, cells.windows)
  kit.declareOneHot(cells.menu.open, true)
  kit.declareOneHot(cells.menu.highlight, true)
  kit.declareOneHot(cells.menu.titleFocus, true)
  kit.declareOneHot(cells.keypad.focus, true)
  kit.declareOneHot(cells.keypad.pressedControl, true)

  const windowsConstants: WindowsConstants = {
    workspaceLeft: kit.zero,
    workspaceTop: kit.affine([[kit.one, appMenuBarHeight]]),
    workspaceWidth: viewportWidth,
    workspaceHeight: kit.affine([[viewportHeight, 1]], -appMenuBarHeight - appStatusBarHeight),
    width: windowWidths,
    height: windowHeights,
    titleHeight: kit.affine([[kit.one, 28]]),
    buttonWidth: kit.affine([[kit.one, 28]]),
    slop: kit.affine([[kit.one, 4]]),
    doubleClickInterval: kit.affine([[kit.one, 500]]),
  }
  circuit.assumeRange(windowsConstants.workspaceHeight, 1, 4096)
  const anchors: AnchorGeometry[] = appMenuAnchors({width: 480, height: 360}).map((anchor, index) => index === menuCount - 1
    ? {left: [[viewportWidth, 1], [kit.one, -8 - anchor.width]], top: [[viewportHeight, 1], [kit.one, -appStatusBarHeight]], width: [[kit.one, anchor.width]], height: [[kit.one, anchor.height]]}
    : {left: [[kit.one, anchor.left]], top: [[kit.one, anchor.top]], width: [[kit.one, anchor.width]], height: [[kit.one, anchor.height]]})
  const menuPrecomputed = menuPrecompute(kit, menuConstants, anchors)

  let state: AppCells = {...cells, windows: {...cells.windows, lastClickTime: windowsAgeClickTime(kit, cells.windows.lastClickTime, frameDelta)}}
  const aboutTerms: Term[] = []
  for (const slot of slots) {
    const openAny = kit.bitAffine(kit.sum(state.menu.open))
    const titleAny = kit.bitAffine(kit.sum(state.menu.titleFocus))
    const menuActive = kit.atLeast([[openAny, 1], [titleAny, 1]], 1)
    const keypadActive = kit.atLeast(kit.sum(state.keypad.focus), 1)
    const tabForward = kit.atLeast([[slot.keys.Tab, 1], [slot.shift, -1]], 1)
    const toMenu = kit.or([menuActive, kit.atLeast([[tabForward, 1], [keypadActive, -1]], 1)])
    const toKeypad = kit.or([keypadActive, kit.atLeast([[menuActive, -1], [tabForward, -1]], 0), kit.and([menuActive, tabForward])])

    const menuStep = menuEventStep(kit, menuConstants, menuPrecomputed, state.menu, withKeys(kit, slot, toMenu))
    const windowStep = windowsEventStep(kit, windowsConstants, state.windows, {...slot, down: kit.atLeast([[slot.down, 1], [menuStep.consumesDown, -1]], 1)})
    const keysBefore = keyGeometry(kit, windowStep.rectangles[0]!, state.windows.maximized[0]!)
    const keypadStep = keyboardEventStep(kit, keysBefore, state.keyEnabled, state.keypad, withKeys(kit, slot, toKeypad), null, windowStep.hit[0]!)

    const activated = ([menu, item]: readonly [number, number]) => menuStep.activations[menu]![item]!
    aboutTerms.push([activated(action.about), 1])

    let windows = windowStep.state
    const cycleTarget = cyclicNextAvailable(kit, windows.focus, windows.focus.map(() => kit.one), false)
    const cycleSelected = cycleTarget.map(bit => kit.mask(activated(action.cycleWindows), bit))
    const restores = kit.bitAffine([[activated(action.resetPositions), 1], [activated(action.cascade), 1], [activated(action.restoreAll), 1]])
    windows = {
      ...windows,
      maximized: windows.maximized.map((bit, index) => {
        const toggle = kit.mask(activated(action.maximizeFocused), windows.focus[index]!)
        const flipped = kit.bitAffine([[bit, 1], [toggle, 1], [kit.mask(bit, toggle), -2]])
        return kit.atLeast([[flipped, 1], [restores, -1]], 1)
      }),
      focus: windows.focus.map((bit, index) => kit.pickBit(activated(action.cycleWindows), bit, cycleTarget[index]!)),
      rank: raiseRanks(kit, windows.rank, cycleSelected),
      left: windows.left.map((left, index) => kit.pick(activated(action.cascade), kit.pick(activated(action.resetPositions), left, [[kit.one, appWindows[index]!.initialLeft]]), [[kit.one, cascadePosition(index).left]])),
      top: windows.top.map((top, index) => kit.pick(activated(action.cascade), kit.pick(activated(action.resetPositions), top, [[kit.one, appWindows[index]!.initialTop]]), [[kit.one, cascadePosition(index).top]])),
    }
    declareWindowsOneHots(kit, windows)

    const firstKey = firstAvailable(kit, state.keyEnabled, false)
    const keypadFocus = keypadStep.state.focus.map((bit, index) => kit.pickBit(activated(action.focusKeypad), bit, firstKey[index]!))
    kit.declareOneHot(keypadFocus, true)
    const titleFocus = menuStep.state.titleFocus.map(bit => kit.atLeast([[bit, 1], [activated(action.focusKeypad), -1]], 1))
    kit.declareOneHot(titleFocus, true)
    const keepCounts = kit.not(activated(action.resetCounts))
    state = {
      windows,
      menu: {...menuStep.state, titleFocus},
      keypad: {focus: keypadFocus, pressedControl: keypadStep.state.pressedControl},
      keyEnabled: state.keyEnabled.map((bit, index) => (index % 2 === 1
        ? kit.bitAffine([[bit, 1], [activated(action.disableOtherKeys), 1], [kit.mask(bit, activated(action.disableOtherKeys)), -2]])
        : bit)),
      keyCounts: state.keyCounts.map((count, index) => kit.gated(keepCounts, kit.minimum([[count, 1], [keypadStep.activations[index]!, 1]], [[kit.one, appKeyCountLimit]]))),
    }
  }

  const display = windowsDisplay(kit, windowsConstants, state.windows)
  const keysAfter = keyGeometry(kit, display.rectangles[0]!, state.windows.maximized[0]!)
  const menuTarget = menuFocusTarget(kit, state.menu)
  const menuHasFocus = kit.atLeast([...kit.sum(state.menu.open), ...kit.sum(state.menu.titleFocus)], 1)
  const keypadAny = kit.bitAffine(kit.sum(state.keypad.focus))
  const keypadTarget = kit.pick(keypadAny, [[kit.one, -1]], [[kit.one, menuCount + menuCount * appItemSlots], ...state.keypad.focus.map((bit, index) => [bit, index] as const)])
  const focusTarget = kit.pick(menuHasFocus, keypadTarget, menuTarget)
  const stateOutputs = flattenAppCells(state)
  const roots = [
    ...stateOutputs,
    ...display.rectangles.flatMap(rectangle => [rectangle.left, rectangle.top, rectangle.width, rectangle.height]),
    ...display.dragOwner,
    ...menuPrecomputed.placements.flatMap(placement => [placement.left, placement.top, placement.width, placement.height]),
    ...keysAfter.flatMap(key => [key.left, key.top, key.width, key.height].map(expression => kit.affine(expression))),
    focusTarget,
    kit.affine(aboutTerms),
  ]
  return {capacity, layout, circuit, kit, viewportWidth, viewportHeight, frameDelta, windowWidths, windowHeights, menuConstants, cells, slots, roots, stateOutputCount: stateOutputs.length}
}

export type AppMachine = ReturnType<typeof createAppMachine>

export function createAppMachine(capacity: number, viewport: AppViewport) {
  const build = buildAppCircuit(capacity)
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const source = new Float32Array(build.layout.size)
  const stateCells = flattenAppCells(build.cells)
  let currentViewport = viewport

  function writeViewport(next: AppViewport) {
    validateAppViewport(next)
    currentViewport = next
    source[build.viewportWidth] = next.width
    source[build.viewportHeight] = next.height
  }

  function writeState(state: AppState) {
    writeWindowsState(source, build.cells.windows, state.windows)
    const oneHot = (wires: readonly Wire[], index: number) => wires.forEach((wire, position) => {
      source[wire] = position === index ? 1 : 0
    })
    oneHot(build.cells.menu.open, state.menu.open)
    oneHot(build.cells.menu.highlight, state.menu.highlight)
    oneHot(build.cells.menu.titleFocus, state.menu.titleFocus)
    oneHot(build.cells.keypad.focus, state.keypad.focus)
    oneHot(build.cells.keypad.pressedControl, state.keypad.pressedControl)
    state.keyEnabled.forEach((enabled, index) => {
      source[build.cells.keyEnabled[index]!] = enabled ? 1 : 0
      source[build.cells.keyCounts[index]!] = state.keyCounts[index]!
    })
  }

  function reset(next: AppViewport) {
    source.fill(0)
    writeViewport(next)
    appWindows.forEach((window, index) => {
      source[build.windowWidths[index]!] = window.width
      source[build.windowHeights[index]!] = window.height
    })
    const menuLayout = appMenuLayout(next)
    source[build.menuConstants.itemHeight] = menuLayout.itemHeight
    source[build.menuConstants.padding] = menuLayout.padding
    menuLayout.menus.forEach((menu, index) => {
      source[build.menuConstants.panelWidth[index]!] = menu.panelWidth
      menu.present.forEach((present, item) => {
        source[build.menuConstants.present[index]![item]!] = present ? 1 : 0
        source[build.menuConstants.enabled[index]![item]!] = menu.enabled[item]! ? 1 : 0
      })
    })
    writeState(createAppState(next))
  }
  reset(viewport)

  function readState(): AppState {
    return {
      windows: readWindowsState(source, build.cells.windows),
      menu: {
        open: readOneHot(source, build.cells.menu.open, 'open'),
        highlight: readOneHot(source, build.cells.menu.highlight, 'highlight'),
        titleFocus: readOneHot(source, build.cells.menu.titleFocus, 'title focus'),
      },
      keypad: {
        focus: readOneHot(source, build.cells.keypad.focus, 'key focus'),
        pressedControl: readOneHot(source, build.cells.keypad.pressedControl, 'pressed key'),
      },
      keyEnabled: build.cells.keyEnabled.map((wire, index) => readBit(source[wire]!, `key enabled ${index}`)),
      keyCounts: build.cells.keyCounts.map(wire => source[wire]!),
    }
  }

  function writeFrame(frameDelta: number, events: readonly QueuedEvent[]) {
    invariant(isOnTimeGrid(frameDelta) && frameDelta >= 0 && frameDelta <= eventTimeLimit, `frame delta ${frameDelta} is off the grid`)
    source[build.frameDelta] = frameDelta
    writeEventQueue(source, build.slots, events)
  }

  function step(frameDelta: number, events: readonly QueuedEvent[]): {state: AppState, outputs: AppOutputs} {
    writeFrame(frameDelta, events)
    const values = evaluate(source)
    for (let index = 0; index < stateCells.length; index++) source[stateCells[index]!] = values[index]!
    writeEventQueue(source, build.slots, [])
    let position = stateCells.length
    const rectangle = () => {
      const result = {left: values[position]!, top: values[position + 1]!, width: values[position + 2]!, height: values[position + 3]!}
      position += 4
      return result
    }
    const windowRectangles = appWindows.map(() => rectangle())
    const dragOwnerWires = appWindows.map((_, index) => position + index)
    position += appWindows.length
    const placements = appMenus.map(() => rectangle())
    const keyRectangles = Array.from({length: appKeyCount}, () => rectangle())
    const focusTarget = values[position++]!
    const aboutActivations = values[position++]!
    void currentViewport
    return {
      state: readState(),
      outputs: {
        windows: {rectangles: windowRectangles, dragOwner: readOneHot(values, dragOwnerWires, 'drag owner')},
        placements,
        keyRectangles,
        focusTarget,
        aboutActivations,
      },
    }
  }

  return {...build, source, reset, writeViewport, writeState, writeFrame, step, readState}
}
