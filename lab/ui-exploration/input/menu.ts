// Part 3: a menu bar with dropdown menus.
//
// State: which menu is open (a one-hot, all zero when closed), which item slot
// is highlighted (a one-hot over the open menu's slots), and which menu title
// has keyboard focus while no menu is open.
//
// - A down on a title toggles that menu. A down inside the open panel does
//   nothing. Any other down closes the menu (outside-press dismissal).
// - While a menu is open, moving over another title switches to that menu, and
//   moving over an enabled item highlights it (anything else clears the
//   highlight). An up over an enabled item activates it and closes the menu,
//   so press on a title, drag to an item, release also works.
// - Keys while open: ArrowDown and ArrowUp cycle through enabled items,
//   ArrowRight and ArrowLeft switch menus and highlight the first enabled item,
//   Enter and Space activate the highlighted item and return focus to its
//   title, Escape closes and returns focus to the title, Tab closes and leaves.
// - Keys while a title has focus: ArrowRight and ArrowLeft move between titles,
//   ArrowDown, Enter, and Space open with the first enabled item highlighted,
//   ArrowUp opens with the last, Escape and Tab leave. With nothing focused,
//   Tab focuses the first title (Shift+Tab the last).
// - Placement: below the anchor, flipped above when it would overflow the
//   bottom and fits above; left-aligned, flipped to right-aligned when it would
//   overflow the right edge; then clamped into the viewport.
// - The focus target output tells JS which element should have DOM focus:
//   -1 for none, m for title m, and menuCount + m * itemSlots + k for item k of
//   menu m.

import {invariant} from '../../../numeric-ui-core.ts'
import {allocateEventQueue, coordinateLimit, writeEventQueue, type EventSlot, type QueuedEvent} from './events.ts'
import {cyclicNextAvailable, cyclicNextEnabled} from './keyboard.ts'
import {createKit, readOneHot, scaled, SourceLayout, termsOf, type Expression, type Kit, type Term, type Wire} from './kit.ts'
import type {Rectangle} from './windows.ts'

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

// Whether menu `index` opens above its anchor (it would overflow the bottom and
// fits above) and whether it is right-aligned (it would overflow the right edge).
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

function availableItems(layout: MenuLayout, index: number) {
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

export function validateMenuLayout(layout: MenuLayout) {
  for (const menu of layout.menus) {
    const firstMissing = menu.present.indexOf(false)
    invariant(firstMissing === -1 || menu.present.slice(firstMissing).every(present => !present), 'present items must come first')
  }
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

export function menuOracleFocusTarget(layout: MenuLayout, state: MenuState, itemSlots: number) {
  if (state.open >= 0) return state.highlight >= 0 ? layout.menus.length + state.open * itemSlots + state.highlight : state.open
  return state.titleFocus
}

// ---------------------------------------------------------------------------
// Circuit pieces

export type AnchorGeometry = {left: Expression, top: Expression, width: Expression, height: Expression}

export type MenuConstants = {
  viewportWidth: Wire
  viewportHeight: Wire
  itemHeight: Wire
  padding: Wire
  panelWidth: Wire[]
  present: Wire[][]
  enabled: Wire[][]
}

export type MenuCells = {open: Wire[], highlight: Wire[], titleFocus: Wire[]}

export function firstAvailable(kit: Kit, available: readonly Wire[], backward: boolean): Wire[] {
  if (backward) return firstAvailable(kit, [...available].reverse(), false).reverse()
  return available.map((bit, index) => kit.atLeast([[bit, 1], ...scaled(kit.sum(available.slice(0, index)), -1)], 1))
}

function insideHalfOpenBit(kit: Kit, x: Wire, y: Wire, left: Expression, top: Expression, width: Expression, height: Expression) {
  return kit.and([
    kit.atLeast([[x, 1], ...scaled(left, -1)], 0),
    kit.atLeast([...termsOf(left), ...termsOf(width), [x, -1]], 1),
    kit.atLeast([[y, 1], ...scaled(top, -1)], 0),
    kit.atLeast([...termsOf(top), ...termsOf(height), [y, -1]], 1),
  ])
}

// Placement and per-menu item tables depend only on the layout, so they are
// computed once per evaluation.
export function menuPrecompute(kit: Kit, constants: MenuConstants, anchors: readonly AnchorGeometry[]) {
  const placements = anchors.map((anchor, index) => {
    const itemCount = kit.affine(kit.sum(constants.present[index]!))
    const height = kit.affine([[kit.circuit.multiply(itemCount, constants.itemHeight), 1], [constants.padding, 2]])
    const width = constants.panelWidth[index]!
    const belowTop: Term[] = [...termsOf(anchor.top), ...termsOf(anchor.height)]
    const aboveTop: Term[] = [...termsOf(anchor.top), [height, -1]]
    const flipUp = kit.and([
      kit.atLeast([...belowTop, [height, 1], [constants.viewportHeight, -1]], 1),
      kit.atLeast(aboveTop, 0),
    ])
    const top = kit.maximum(kit.minimum(kit.pick(flipUp, belowTop, aboveTop), [[constants.viewportHeight, 1], [height, -1]]), [])
    const flipLeft = kit.atLeast([...termsOf(anchor.left), [width, 1], [constants.viewportWidth, -1]], 1)
    const rightAligned: Term[] = [...termsOf(anchor.left), ...termsOf(anchor.width), [width, -1]]
    const left = kit.maximum(kit.minimum(kit.pick(flipLeft, anchor.left, rightAligned), [[constants.viewportWidth, 1], [width, -1]]), [])
    return {left, top, width, height}
  })
  const available = constants.present.map((row, index) => row.map((present, item) => kit.and([present, constants.enabled[index]![item]!])))
  return {
    anchors,
    placements,
    available,
    first: available.map(row => firstAvailable(kit, row, false)),
    last: available.map(row => firstAvailable(kit, row, true)),
  }
}

export type MenuPrecomputed = ReturnType<typeof menuPrecompute>

function rotated(bits: readonly Wire[], by: number) {
  const count = bits.length
  return bits.map((_, index) => bits[(((index - by) % count) + count) % count]!)
}

export function menuEventStep(kit: Kit, constants: MenuConstants, precomputed: MenuPrecomputed, state: MenuCells, slot: EventSlot) {
  const menuCount = state.open.length
  const itemSlots = state.highlight.length
  const keys = slot.keys
  const {x, y} = slot

  const titleInside = precomputed.anchors.map(anchor => insideHalfOpenBit(kit, x, y, anchor.left, anchor.top, anchor.width, anchor.height))
  const titleHit = titleInside.map((bit, index) => kit.atLeast([[bit, 1], ...scaled(kit.sum(titleInside.slice(0, index)), -1)], 1))
  const hitAny = kit.bitAffine(kit.sum(titleHit))
  const openAny = kit.bitAffine(kit.sum(state.open))
  const highlightAny = kit.bitAffine(kit.sum(state.highlight))
  const titleAny = kit.bitAffine(kit.sum(state.titleFocus))

  const openLeft = kit.dot(state.open, precomputed.placements.map(placement => placement.left))
  const openTop = kit.dot(state.open, precomputed.placements.map(placement => placement.top))
  const openWidth = kit.dot(state.open, precomputed.placements.map(placement => placement.width))
  const openHeight = kit.dot(state.open, precomputed.placements.map(placement => placement.height))
  const insidePanel = insideHalfOpenBit(kit, x, y, openLeft, openTop, openWidth, openHeight)
  const openAvailable = Array.from({length: itemSlots}, (_, item) => kit.bitAffine(kit.dot(state.open, precomputed.available.map(row => row[item]!))))
  const itemUnder = Array.from({length: itemSlots}, (_, item) => kit.and([
    kit.atLeast([[x, 1], [openLeft, -1], [constants.padding, -1]], 0),
    kit.atLeast([[openLeft, 1], [openWidth, 1], [constants.padding, -1], [x, -1]], 1),
    kit.atLeast([[y, 1], [openTop, -1], [constants.padding, -1], [constants.itemHeight, -item]], 0),
    kit.atLeast([[openTop, 1], [constants.padding, 1], [constants.itemHeight, item + 1], [y, -1]], 1),
    openAvailable[item]!,
  ]))
  const anyItemUnder = kit.bitAffine(kit.sum(itemUnder))

  // Down.
  const keepOnDown = kit.atLeast([[insidePanel, 1], [hitAny, -1]], 1)
  const openOnDown = state.open.map((bit, index) => kit.bitAffine([[kit.atLeast([[titleHit[index]!, 1], [bit, -1]], 1), 1], [kit.mask(keepOnDown, bit), 1]]))
  const highlightOnDown = state.highlight.map(bit => kit.mask(keepOnDown, bit))

  // Move.
  const switchTitle = state.open.map((bit, index) => kit.atLeast([[titleHit[index]!, 1], [bit, -1], [openAny, 1]], 2))
  const switchAny = kit.bitAffine(kit.sum(switchTitle))
  const notSwitch = kit.not(switchAny)
  const openOnMove = state.open.map((bit, index) => kit.bitAffine([[switchTitle[index]!, 1], [kit.gated(notSwitch, bit), 1]]))
  const highlightOnMove = itemUnder.map(bit => kit.atLeast([[bit, 1], [switchAny, -1]], 1))

  // Up.
  const openOnUp = state.open.map(bit => kit.atLeast([[bit, 1], [anyItemUnder, -1]], 1))
  const highlightOnUp = state.highlight.map(bit => kit.atLeast([[bit, 1], [anyItemUnder, -1]], 1))
  const titleFocusOnUp = state.titleFocus.map(bit => kit.atLeast([[bit, 1], [anyItemUnder, -1]], 1))

  // Keys while a menu is open.
  const enterOrSpace = kit.bitAffine([[keys.Enter, 1], [keys.Space, 1]])
  const activateKey = kit.and([enterOrSpace, highlightAny, openAny])
  const leaveKeys = kit.bitAffine([[keys.Escape, 1], [keys.Tab, 1], [activateKey, 1]])
  const switchKeys = kit.bitAffine([[keys.ArrowRight, 1], [keys.ArrowLeft, 1]])
  const anyArrow = kit.bitAffine([[keys.ArrowRight, 1], [keys.ArrowLeft, 1], [keys.ArrowUp, 1], [keys.ArrowDown, 1]])
  const nextItem = cyclicNextAvailable(kit, state.highlight, openAvailable, false)
  const previousItem = cyclicNextAvailable(kit, state.highlight, openAvailable, true)
  const openRight = rotated(state.open, 1)
  const openLeftward = rotated(state.open, -1)
  const firstRight = Array.from({length: itemSlots}, (_, item) => kit.dot(state.open, precomputed.first.map((_, index) => precomputed.first[(index + 1) % menuCount]![item]!)))
  const firstLeft = Array.from({length: itemSlots}, (_, item) => kit.dot(state.open, precomputed.first.map((_, index) => precomputed.first[(index - 1 + menuCount) % menuCount]![item]!)))
  const openWhileOpen = state.open.map((bit, index) => kit.bitAffine([
    [kit.mask(keys.ArrowRight, openRight[index]!), 1],
    [kit.mask(keys.ArrowLeft, openLeftward[index]!), 1],
    [kit.atLeast([[bit, 1], [switchKeys, -1], [leaveKeys, -1]], 1), 1],
  ]))
  const highlightWhileOpen = state.highlight.map((bit, item) => kit.bitAffine([
    [kit.mask(keys.ArrowDown, nextItem[item]!), 1],
    [kit.mask(keys.ArrowUp, previousItem[item]!), 1],
    [kit.mask(keys.ArrowRight, firstRight[item]!), 1],
    [kit.mask(keys.ArrowLeft, firstLeft[item]!), 1],
    [kit.atLeast([[bit, 1], [anyArrow, -1], [leaveKeys, -1]], 1), 1],
  ]))
  const escapeOrActivate = kit.bitAffine([[keys.Escape, 1], [activateKey, 1]])
  const titleFocusWhileOpen = state.titleFocus.map((bit, index) => kit.bitAffine([
    [kit.mask(escapeOrActivate, state.open[index]!), 1],
    [kit.atLeast([[bit, 1], [leaveKeys, -1]], 1), 1],
  ]))

  // Keys while a title has focus and no menu is open.
  const opensFromTitle = kit.bitAffine([[keys.ArrowDown, 1], [keys.Enter, 1], [keys.Space, 1], [keys.ArrowUp, 1]])
  const opensAtFirst = kit.bitAffine([[keys.ArrowDown, 1], [keys.Enter, 1], [keys.Space, 1]])
  const openWhileTitle = state.titleFocus.map(bit => kit.mask(opensFromTitle, bit))
  const highlightWhileTitle = state.highlight.map((_, item) => kit.bitAffine([
    [kit.mask(opensAtFirst, kit.dot(state.titleFocus, precomputed.first.map(row => row[item]!))), 1],
    [kit.mask(keys.ArrowUp, kit.dot(state.titleFocus, precomputed.last.map(row => row[item]!))), 1],
  ]))
  const titleMoves = kit.bitAffine([[keys.ArrowRight, 1], [keys.ArrowLeft, 1], [keys.Escape, 1], [keys.Tab, 1]])
  const titleRight = rotated(state.titleFocus, 1)
  const titleLeftward = rotated(state.titleFocus, -1)
  const titleWhileTitle = state.titleFocus.map((bit, index) => kit.bitAffine([
    [kit.mask(keys.ArrowRight, titleRight[index]!), 1],
    [kit.mask(keys.ArrowLeft, titleLeftward[index]!), 1],
    [kit.atLeast([[bit, 1], [titleMoves, -1]], 1), 1],
  ]))

  // Keys with nothing focused.
  const tabForward = kit.atLeast([[keys.Tab, 1], [slot.shift, -1]], 1)
  const tabBackward = kit.and([keys.Tab, slot.shift])

  const titleRegime = kit.atLeast([[titleAny, 1], [openAny, -1]], 1)
  const noneRegime = kit.atLeast([[titleAny, -1], [openAny, -1]], 0)
  const openOnKey = state.open.map((_, index) => kit.bitAffine([[kit.mask(openAny, openWhileOpen[index]!), 1], [kit.mask(titleRegime, openWhileTitle[index]!), 1]]))
  const highlightOnKey = state.highlight.map((_, item) => kit.bitAffine([[kit.mask(openAny, highlightWhileOpen[item]!), 1], [kit.mask(titleRegime, highlightWhileTitle[item]!), 1]]))
  const titleFocusOnKey = state.titleFocus.map((_, index) => {
    const terms: Term[] = [[kit.mask(openAny, titleFocusWhileOpen[index]!), 1], [kit.mask(titleRegime, titleWhileTitle[index]!), 1]]
    if (index === 0) terms.push([kit.and([noneRegime, tabForward]), 1])
    if (index === menuCount - 1) terms.push([kit.and([noneRegime, tabBackward]), 1])
    return kit.bitAffine(terms)
  })

  // Merge by event kind; the kinds are exclusive.
  const idle = kit.not(kit.bitAffine([[slot.down, 1], [slot.move, 1], [slot.up, 1], [slot.key, 1]]))
  const merge = (kept: Wire, onDown: Wire | null, onMove: Wire | null, onUp: Wire | null, onKey: Wire) => {
    const terms: Term[] = [[kit.gated(idle, kept), 1], [kit.mask(slot.key, onKey), 1]]
    terms.push([onDown === null ? kit.zero : kit.mask(slot.down, onDown), 1])
    terms.push([kit.gated(slot.move, onMove ?? kept), 1])
    terms.push([kit.gated(slot.up, onUp ?? kept), 1])
    return kit.bitAffine(terms)
  }
  const next: MenuCells = {
    open: state.open.map((bit, index) => merge(bit, openOnDown[index]!, openOnMove[index]!, openOnUp[index]!, openOnKey[index]!)),
    highlight: state.highlight.map((bit, item) => merge(bit, highlightOnDown[item]!, highlightOnMove[item]!, highlightOnUp[item]!, highlightOnKey[item]!)),
    titleFocus: state.titleFocus.map((bit, index) => merge(bit, null, null, titleFocusOnUp[index]!, titleFocusOnKey[index]!)),
  }
  kit.declareOneHot(next.open, true)
  kit.declareOneHot(next.highlight, true)
  kit.declareOneHot(next.titleFocus, true)

  const upActivate = itemUnder.map(bit => kit.and([slot.up, bit]))
  const keyActivate = state.highlight.map(bit => kit.and([slot.key, enterOrSpace, bit]))
  const activations = state.open.map(openBit => upActivate.map((upBit, item) => kit.mask(openBit, kit.bitAffine([[upBit, 1], [keyActivate[item]!, 1]]))))
  // What app.ts routes elsewhere: a down the menu takes, and keys the menu takes.
  const consumesDown = kit.and([slot.down, kit.atLeast([[hitAny, 1], [openAny, 1]], 1)])
  const consumesKey = kit.and([slot.key, kit.atLeast([[openAny, 1], [titleAny, 1]], 1)])
  return {state: next, activations, consumesDown, consumesKey, openAny}
}

export function menuFocusTarget(kit: Kit, state: MenuCells) {
  const menuCount = state.open.length
  const itemSlots = state.highlight.length
  const openAny = kit.bitAffine(kit.sum(state.open))
  const highlightAny = kit.bitAffine(kit.sum(state.highlight))
  const openIndex: Term[] = state.open.map((bit, index) => [bit, index] as const)
  const itemTarget: Term[] = [[kit.one, menuCount], ...state.open.map((bit, index) => [bit, index * itemSlots] as const), ...state.highlight.map((bit, item) => [bit, item] as const)]
  const titleTarget: Term[] = [[kit.one, -1], ...state.titleFocus.map((bit, index) => [bit, index + 1] as const)]
  return kit.pick(openAny, titleTarget, kit.pick(highlightAny, openIndex, itemTarget))
}

export function buildMenuCircuit(menuCount: number, itemSlots: number, capacity: number) {
  const layout = new SourceLayout()
  const constants: MenuConstants = {
    viewportWidth: layout.cell('viewportWidth', 1, coordinateLimit),
    viewportHeight: layout.cell('viewportHeight', 1, coordinateLimit),
    itemHeight: layout.cell('itemHeight', 1, 256),
    padding: layout.cell('padding', 0, 64),
    panelWidth: layout.cells('panelWidth', menuCount, 1, coordinateLimit),
    present: Array.from({length: menuCount}, (_, index) => layout.cells(`present[${index}]`, itemSlots, 0, 1)),
    enabled: Array.from({length: menuCount}, (_, index) => layout.cells(`enabled[${index}]`, itemSlots, 0, 1)),
  }
  const anchorCells = Array.from({length: menuCount}, (_, index) => ({
    left: layout.cell(`anchor[${index}].left`, -coordinateLimit, coordinateLimit),
    top: layout.cell(`anchor[${index}].top`, -coordinateLimit, coordinateLimit),
    width: layout.cell(`anchor[${index}].width`, 1, coordinateLimit),
    height: layout.cell(`anchor[${index}].height`, 1, coordinateLimit),
  }))
  const cells: MenuCells = {
    open: layout.cells('open', menuCount, 0, 1),
    highlight: layout.cells('highlight', itemSlots, 0, 1),
    titleFocus: layout.cells('titleFocus', menuCount, 0, 1),
  }
  const slots = allocateEventQueue(layout, capacity)
  const circuit = layout.createCircuit()
  const kit = createKit(circuit)
  kit.declareOneHot(cells.open, true)
  kit.declareOneHot(cells.highlight, true)
  kit.declareOneHot(cells.titleFocus, true)
  const precomputed = menuPrecompute(kit, constants, anchorCells)
  let state = cells
  const activationTerms: Term[][][] = Array.from({length: menuCount}, () => Array.from({length: itemSlots}, () => []))
  for (const slot of slots) {
    const step = menuEventStep(kit, constants, precomputed, state, slot)
    state = step.state
    step.activations.forEach((row, index) => row.forEach((wire, item) => activationTerms[index]![item]!.push([wire, 1])))
  }
  const activations = activationTerms.map(row => row.map(terms => kit.affine(terms)))
  const focusTarget = menuFocusTarget(kit, state)
  const placementWires = precomputed.placements.flatMap(placement => [placement.left, placement.top, placement.width, placement.height])
  const stateOutputs = [...state.open, ...state.highlight, ...state.titleFocus]
  const roots = [...stateOutputs, ...activations.flat(), focusTarget, ...placementWires]
  return {menuCount, itemSlots, capacity, layout, circuit, kit, constants, anchorCells, cells, slots, roots, stateOutputCount: stateOutputs.length}
}

export type MenuMachine = ReturnType<typeof createMenuMachine>

export function createMenuMachine(menuCount: number, itemSlots: number, capacity: number) {
  const build = buildMenuCircuit(menuCount, itemSlots, capacity)
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const source = new Float32Array(build.layout.size)
  const stateCells = [...build.cells.open, ...build.cells.highlight, ...build.cells.titleFocus]

  function writeLayout(layout: MenuLayout) {
    validateMenuLayout(layout)
    invariant(layout.menus.length === menuCount, 'menu layout has the wrong number of menus')
    source[build.constants.viewportWidth] = layout.viewportWidth
    source[build.constants.viewportHeight] = layout.viewportHeight
    source[build.constants.itemHeight] = layout.itemHeight
    source[build.constants.padding] = layout.padding
    layout.menus.forEach((menu, index) => {
      invariant(menu.present.length === itemSlots && menu.enabled.length === itemSlots, 'menu item slots have the wrong size')
      const anchor = build.anchorCells[index]!
      source[anchor.left] = menu.anchor.left
      source[anchor.top] = menu.anchor.top
      source[anchor.width] = menu.anchor.width
      source[anchor.height] = menu.anchor.height
      source[build.constants.panelWidth[index]!] = menu.panelWidth
      menu.present.forEach((present, item) => {
        source[build.constants.present[index]![item]!] = present ? 1 : 0
        source[build.constants.enabled[index]![item]!] = menu.enabled[item]! ? 1 : 0
      })
    })
  }

  function reset(layout: MenuLayout) {
    source.fill(0)
    writeLayout(layout)
  }

  function step(events: readonly QueuedEvent[]) {
    writeEventQueue(source, build.slots, events)
    const outputs = evaluate(source)
    for (let index = 0; index < stateCells.length; index++) source[stateCells[index]!] = outputs[index]!
    writeEventQueue(source, build.slots, [])
    let position = stateCells.length
    const activations = Array.from({length: menuCount}, () => Array.from({length: itemSlots}, () => outputs[position++]!))
    const focusTarget = outputs[position++]!
    const placements = Array.from({length: menuCount}, () => {
      const placement = {left: outputs[position]!, top: outputs[position + 1]!, width: outputs[position + 2]!, height: outputs[position + 3]!}
      position += 4
      return placement
    })
    return {
      state: {
        open: readOneHot(source, build.cells.open, 'open'),
        highlight: readOneHot(source, build.cells.highlight, 'highlight'),
        titleFocus: readOneHot(source, build.cells.titleFocus, 'title focus'),
      },
      activations,
      focusTarget,
      placements,
    }
  }

  return {...build, source, reset, writeLayout, step}
}
