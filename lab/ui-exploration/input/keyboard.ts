// Part 2: keyboard focus over a fixed set of focusable controls.
//
// Focus is a one-hot over the controls (all zero when nothing is focused).
// Tab and Shift+Tab move to the next or previous enabled control in index
// order, wrapping around. Arrow keys move to the nearest enabled control in the
// pressed direction. Enter and Space activate the focused control. Escape
// clears focus. A down on a control focuses it, and an up on the same control
// activates it.
//
// Two navigation forms, both exact against `keyboardOracleEvent`:
// - 'per-event': each key event computes its target from the current focus:
//   a cyclic "next available" count for Tab, and one argmin over the controls
//   for arrows.
// - 'tables': once per frame, the circuit computes transition tables for every
//   possible focus (Tab, Shift+Tab, and four arrow directions). Each key event
//   then reads its row through the focus one-hot, which gather lowering turns
//   into indexed reads.

import {invariant} from '../../../numeric-ui-core.ts'
import {allocateEventQueue, coordinateLimit, writeEventQueue, type EventSlot, type KeyName, type QueuedEvent} from './events.ts'
import {createKit, readOneHot, scaled, SourceLayout, termsOf, type Expression, type Kit, type Term, type Wire} from './kit.ts'
import {strictlyInside, type Rectangle} from './windows.ts'

export const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const
export type ArrowKey = (typeof arrowKeys)[number]

export type ControlsLayout = {rectangles: readonly Rectangle[], enabled: readonly boolean[]}
export type KeyboardState = {focus: number, pressedControl: number}

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

// Centers are doubled (2 * left + width) so they stay whole numbers.
export function doubledCenter(rectangle: Rectangle) {
  return {x: 2 * rectangle.left + rectangle.width, y: 2 * rectangle.top + rectangle.height}
}

// The enabled control with the smallest `distance along the direction + 2 *
// distance across it`, among controls strictly ahead in that direction. Ties go
// to the lower index. -1 when no control is ahead.
export function nearestControlInDirection(layout: ControlsLayout, from: number, direction: ArrowKey): number {
  const origin = doubledCenter(layout.rectangles[from]!)
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  layout.rectangles.forEach((rectangle, index) => {
    if (index === from || !layout.enabled[index]!) return
    const center = doubledCenter(rectangle)
    const dx = center.x - origin.x
    const dy = center.y - origin.y
    const primary = direction === 'ArrowRight' ? dx : direction === 'ArrowLeft' ? -dx : direction === 'ArrowDown' ? dy : -dy
    if (primary < 1) return
    const across = direction === 'ArrowLeft' || direction === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx)
    const score = primary + 2 * across
    if (score < bestScore) {
      best = index
      bestScore = score
    }
  })
  return best
}

export function keyboardOracleEvent(layout: ControlsLayout, state: KeyboardState, event: QueuedEvent, activations: number[]) {
  if (event.kind !== 'key') {
    if (event.kind === 'down') {
      const hit = layout.rectangles.findIndex(rectangle => strictlyInside(rectangle, event.x, event.y))
      state.focus = hit >= 0 && layout.enabled[hit]! ? hit : -1
      state.pressedControl = state.focus
    } else if (event.kind === 'up') {
      if (state.pressedControl >= 0 && strictlyInside(layout.rectangles[state.pressedControl]!, event.x, event.y)) {
        activations[state.pressedControl]!++
      }
      state.pressedControl = -1
    }
    return
  }
  switch (event.key) {
    case 'Tab':
      state.focus = cyclicNextEnabled(layout.enabled, state.focus, event.shift)
      return
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (state.focus === -1) {
        state.focus = cyclicNextEnabled(layout.enabled, -1, false)
        return
      }
      const target = nearestControlInDirection(layout, state.focus, event.key)
      if (target >= 0) state.focus = target
      return
    }
    case 'Enter':
    case 'Space':
      if (state.focus >= 0 && layout.enabled[state.focus]!) activations[state.focus]!++
      return
    case 'Escape':
      state.focus = -1
      return
  }
}

// ---------------------------------------------------------------------------
// Circuit pieces

// The next available index after the current one in cyclic order (or before
// it, backward), as a one-hot. From no current index, the first available one
// (the last, backward). All zero only when nothing is available.
export function cyclicNextAvailable(kit: Kit, current: readonly Wire[], available: readonly Wire[], backward: boolean): Wire[] {
  if (backward) return cyclicNextAvailable(kit, [...current].reverse(), [...available].reverse(), false).reverse()
  const count = current.length
  const candidateAfter = available.map((bit, index) => kit.atLeast([[bit, 1], ...kit.sum(current.slice(0, index))], 2))
  const firstAfter = candidateAfter.map((bit, index) => kit.atLeast([[bit, 1], ...scaled(kit.sum(candidateAfter.slice(0, index)), -1)], 1))
  const anyAfter = kit.bitAffine(kit.sum(firstAfter))
  const firstOverall = available.map((bit, index) => kit.atLeast([[bit, 1], ...scaled(kit.sum(available.slice(0, index)), -1)], 1))
  const result = Array.from({length: count}, (_, index) => kit.bitAffine([
    [firstAfter[index]!, 1],
    [kit.atLeast([[firstOverall[index]!, 1], [anyAfter, -1]], 1), 1],
  ]))
  kit.declareOneHot(result, true)
  return result
}

export type ControlGeometry = {left: Expression, top: Expression, width: Expression, height: Expression}

function doubledCenterTerms(control: ControlGeometry) {
  return {
    x: [...scaled(control.left, 2), ...termsOf(control.width)],
    y: [...scaled(control.top, 2), ...termsOf(control.height)],
  }
}

// Scores are below 2^17 for coordinates inside ±4096. An invalid candidate's
// score is replaced by 2^18, so every valid candidate wins over every invalid
// one. The replacement is a pick, not `score + 2^18 * (1 - valid)`: scaling a
// composed bit by 2^18 scales its relus too, and those partial sums round.
const invalidPenalty = 262144

function penalizedScore(kit: Kit, valid: Wire, score: readonly Term[]): Wire {
  return kit.pick(valid, [[kit.one, invalidPenalty]], score)
}

// Per-event arrow target: stay when nothing is ahead, and the fallback (the
// first enabled control) when nothing is focused.
export function arrowTargetPerEvent(kit: Kit, controls: readonly ControlGeometry[], enabled: readonly Wire[], focus: readonly Wire[], keys: Record<KeyName, Wire>, noFocus: Wire, fallback: readonly Wire[]): Wire[] {
  const centers = controls.map(doubledCenterTerms)
  const focusX = kit.dot(focus, centers.map(center => kit.affine(center.x)))
  const focusY = kit.dot(focus, centers.map(center => kit.affine(center.y)))
  const horizontal = kit.bitAffine([[keys.ArrowLeft, 1], [keys.ArrowRight, 1]])
  const vertical = kit.bitAffine([[keys.ArrowUp, 1], [keys.ArrowDown, 1]])
  const valid: Wire[] = []
  const scores = centers.map((center, index) => {
    const dx: Term[] = [...center.x, [focusX, -1]]
    const dy: Term[] = [...center.y, [focusY, -1]]
    const primary = kit.affine([
      [kit.gated(keys.ArrowRight, dx), 1],
      [kit.gated(keys.ArrowLeft, dx), -1],
      [kit.gated(keys.ArrowDown, dy), 1],
      [kit.gated(keys.ArrowUp, dy), -1],
    ])
    const across: Term[] = [[kit.gated(horizontal, kit.absolute(dy)), 2], [kit.gated(vertical, kit.absolute(dx)), 2]]
    const validBit = kit.atLeast([[primary, 1], [enabled[index]!, invalidPenalty]], invalidPenalty + 1)
    valid.push(validBit)
    return penalizedScore(kit, validBit, [[primary, 1], ...across])
  })
  const {selected} = kit.argminInteger(scores)
  const anyValid = kit.atLeast(kit.sum(valid), 1)
  const result = focus.map((bit, index) => kit.pickBit(noFocus, kit.pickBit(anyValid, bit, selected[index]!), fallback[index]!))
  kit.declareOneHot(result, true)
  return result
}

// Transition tables for every possible focus: table[from][to].
export function tabTables(kit: Kit, enabled: readonly Wire[]) {
  const count = enabled.length
  const firstInOrder = (order: readonly number[]) => {
    const row = Array<Wire>(count).fill(kit.zero)
    order.forEach((index, position) => {
      row[index] = kit.atLeast([[enabled[index]!, 1], ...scaled(kit.sum(order.slice(0, position).map(earlier => enabled[earlier]!)), -1)], 1)
    })
    return row
  }
  const indices = Array.from({length: count}, (_, index) => index)
  return {
    next: indices.map(from => firstInOrder(indices.map(step => (from + 1 + step) % count))),
    previous: indices.map(from => firstInOrder(indices.map(step => (from - 1 - step + count * 2) % count))),
    start: firstInOrder(indices),
    end: firstInOrder([...indices].reverse()),
  }
}

export function arrowTables(kit: Kit, controls: readonly ControlGeometry[], enabled: readonly Wire[]) {
  const centers = controls.map(doubledCenterTerms)
  const count = controls.length
  const absoluteCache = new Map<string, Wire>()
  const absoluteDifference = (axis: 'x' | 'y', a: number, b: number) => {
    const key = `${axis}${Math.min(a, b)},${Math.max(a, b)}`
    let wire = absoluteCache.get(key)
    if (wire === undefined) {
      wire = kit.absolute([...centers[Math.max(a, b)]![axis], ...scaled(centers[Math.min(a, b)]![axis], -1)])
      absoluteCache.set(key, wire)
    }
    return wire
  }
  const tables = {} as Record<ArrowKey, Wire[][]>
  for (const direction of arrowKeys) {
    tables[direction] = Array.from({length: count}, (_, from) => {
      const candidates = Array.from({length: count}, (_, index) => index).filter(index => index !== from)
      const valid: Wire[] = []
      const scores = candidates.map(index => {
        const dx: Term[] = [...centers[index]!.x, ...scaled(centers[from]!.x, -1)]
        const dy: Term[] = [...centers[index]!.y, ...scaled(centers[from]!.y, -1)]
        const primary = direction === 'ArrowRight' ? dx : direction === 'ArrowLeft' ? scaled(dx, -1) : direction === 'ArrowDown' ? dy : scaled(dy, -1)
        const across = direction === 'ArrowLeft' || direction === 'ArrowRight' ? absoluteDifference('y', from, index) : absoluteDifference('x', from, index)
        const validBit = kit.atLeast([...primary, [enabled[index]!, invalidPenalty]], invalidPenalty + 1)
        valid.push(validBit)
        return penalizedScore(kit, validBit, [...primary, [across, 2]])
      })
      const {selected} = kit.argminInteger(scores)
      const anyValid = kit.atLeast(kit.sum(valid), 1)
      const row = Array<Wire>(count)
      row[from] = kit.not(anyValid)
      candidates.forEach((index, position) => {
        row[index] = kit.mask(anyValid, selected[position]!)
      })
      return row
    })
  }
  return tables
}

export type NavigationTables = {tabs: ReturnType<typeof tabTables>, arrows: ReturnType<typeof arrowTables>}

function readTableRow(kit: Kit, table: readonly Wire[][], focus: readonly Wire[], column: number) {
  return kit.dot(focus, table.map(row => row[column]!))
}

export type ControlsConstants = {left: Wire[], top: Wire[], width: Wire[], height: Wire[], enabled: Wire[]}
export type KeyboardCells = {focus: Wire[], pressedControl: Wire[]}

// `downAllowed`, when given, replaces the down bit for hit-testing controls
// (e.g. the down reached the window holding the controls), while any down
// still clears focus.
export function keyboardEventStep(
  kit: Kit,
  controls: readonly ControlGeometry[],
  enabled: readonly Wire[],
  state: KeyboardCells,
  slot: EventSlot,
  tables: NavigationTables | null,
  downAllowed: Wire | null,
) {
  const count = state.focus.length
  const keys = slot.keys
  const tabForward = kit.atLeast([[keys.Tab, 1], [slot.shift, -1]], 1)
  const tabBackward = kit.and([keys.Tab, slot.shift])
  const arrowAny = kit.bitAffine(arrowKeys.map(key => [keys[key], 1] as const))
  const noFocus = kit.bitAffine(scaled(kit.sum(state.focus), -1), 1)

  let forwardTarget: Wire[]
  let backwardTarget: Wire[]
  let arrowTarget: Wire[]
  if (tables === null) {
    forwardTarget = cyclicNextAvailable(kit, state.focus, enabled, false)
    backwardTarget = cyclicNextAvailable(kit, state.focus, enabled, true)
    arrowTarget = arrowTargetPerEvent(kit, controls, enabled, state.focus, keys, noFocus, forwardTarget)
  } else {
    forwardTarget = state.focus.map((_, column) => kit.pickBit(noFocus, readTableRow(kit, tables.tabs.next, state.focus, column), tables.tabs.start[column]!))
    backwardTarget = state.focus.map((_, column) => kit.pickBit(noFocus, readTableRow(kit, tables.tabs.previous, state.focus, column), tables.tabs.end[column]!))
    arrowTarget = state.focus.map((_, column) => {
      const moved = kit.affine(arrowKeys.map(key => [kit.mask(keys[key], readTableRow(kit, tables.arrows[key], state.focus, column)), 1] as const))
      return kit.pickBit(noFocus, moved, tables.tabs.start[column]!)
    })
  }

  const inside = controls.map(control => kit.and([
    kit.atLeast([[slot.x, 1], ...scaled(control.left, -1)], 1),
    kit.atLeast([...termsOf(control.left), ...termsOf(control.width), [slot.x, -1]], 1),
    kit.atLeast([[slot.y, 1], ...scaled(control.top, -1)], 1),
    kit.atLeast([...termsOf(control.top), ...termsOf(control.height), [slot.y, -1]], 1),
  ]))
  const downHit = inside.map((bit, index) => kit.atLeast([[bit, 1], [downAllowed ?? slot.down, 1], [enabled[index]!, 1], ...scaled(kit.sum(inside.slice(0, index)), -1)], 3))
  kit.declareOneHot(downHit, true)

  const focusEvent = kit.bitAffine([[keys.Tab, 1], [arrowAny, 1], [keys.Escape, 1], [slot.down, 1]])
  const keep = kit.not(focusEvent)
  const focus = state.focus.map((bit, index) => kit.bitAffine([
    [kit.gated(keep, bit), 1],
    [kit.mask(tabForward, forwardTarget[index]!), 1],
    [kit.mask(tabBackward, backwardTarget[index]!), 1],
    [kit.mask(arrowAny, arrowTarget[index]!), 1],
    [downHit[index]!, 1],
  ]))
  kit.declareOneHot(focus, true)
  const pointerEnds = kit.bitAffine([[slot.down, 1], [slot.up, 1]])
  const keepPress = kit.not(pointerEnds)
  const pressedControl = state.pressedControl.map((bit, index) => kit.bitAffine([[kit.gated(keepPress, bit), 1], [downHit[index]!, 1]]))
  kit.declareOneHot(pressedControl, true)
  const activations = Array.from({length: count}, (_, index) => kit.bitAffine([
    [kit.atLeast([[keys.Enter, 1], [keys.Space, 1], [state.focus[index]!, 1], [enabled[index]!, 1]], 3), 1],
    [kit.atLeast([[slot.up, 1], [state.pressedControl[index]!, 1], [inside[index]!, 1]], 3), 1],
  ]))
  return {state: {focus, pressedControl}, activations, inside}
}

export type KeyboardNavigation = 'per-event' | 'tables'

export function buildKeyboardCircuit(controlCount: number, capacity: number, navigation: KeyboardNavigation) {
  invariant(controlCount >= 2, 'keyboard navigation needs at least two controls')
  const layout = new SourceLayout()
  const constants: ControlsConstants = {
    left: layout.cells('controlLeft', controlCount, -coordinateLimit, coordinateLimit),
    top: layout.cells('controlTop', controlCount, -coordinateLimit, coordinateLimit),
    width: layout.cells('controlWidth', controlCount, 1, coordinateLimit),
    height: layout.cells('controlHeight', controlCount, 1, coordinateLimit),
    enabled: layout.cells('controlEnabled', controlCount, 0, 1),
  }
  const cells: KeyboardCells = {
    focus: layout.cells('focus', controlCount, 0, 1),
    pressedControl: layout.cells('pressedControl', controlCount, 0, 1),
  }
  const slots = allocateEventQueue(layout, capacity)
  const circuit = layout.createCircuit()
  const kit = createKit(circuit)
  kit.declareOneHot(cells.focus, true)
  kit.declareOneHot(cells.pressedControl, true)
  const controls: ControlGeometry[] = constants.left.map((left, index) => ({
    left,
    top: constants.top[index]!,
    width: constants.width[index]!,
    height: constants.height[index]!,
  }))
  const tables = navigation === 'tables'
    ? {tabs: tabTables(kit, constants.enabled), arrows: arrowTables(kit, controls, constants.enabled)}
    : null
  let state = cells
  const activationTerms: Term[][] = Array.from({length: controlCount}, () => [])
  for (const slot of slots) {
    const step = keyboardEventStep(kit, controls, constants.enabled, state, slot, tables, null)
    state = step.state
    step.activations.forEach((wire, index) => activationTerms[index]!.push([wire, 1]))
  }
  const activations = activationTerms.map(terms => kit.affine(terms))
  const focusedIndex = kit.affine(state.focus.map((wire, index) => [wire, index + 1] as const), -1)
  const roots = [...state.focus, ...state.pressedControl, ...activations, focusedIndex]
  return {controlCount, capacity, navigation, layout, circuit, kit, constants, cells, slots, next: state, activations, focusedIndex, roots}
}

export type KeyboardMachine = ReturnType<typeof createKeyboardMachine>

export function createKeyboardMachine(controlCount: number, capacity: number, navigation: KeyboardNavigation) {
  const build = buildKeyboardCircuit(controlCount, capacity, navigation)
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const source = new Float32Array(build.layout.size)
  const stateCells = [...build.cells.focus, ...build.cells.pressedControl]

  function writeControls(layout: ControlsLayout) {
    invariant(layout.rectangles.length === controlCount && layout.enabled.length === controlCount, 'control layout has the wrong size')
    layout.rectangles.forEach((rectangle, index) => {
      source[build.constants.left[index]!] = rectangle.left
      source[build.constants.top[index]!] = rectangle.top
      source[build.constants.width[index]!] = rectangle.width
      source[build.constants.height[index]!] = rectangle.height
      source[build.constants.enabled[index]!] = layout.enabled[index]! ? 1 : 0
    })
  }

  function step(events: readonly QueuedEvent[]) {
    writeEventQueue(source, build.slots, events)
    const outputs = evaluate(source)
    for (let index = 0; index < stateCells.length; index++) source[stateCells[index]!] = outputs[index]!
    writeEventQueue(source, build.slots, [])
    const activationStart = stateCells.length
    return {
      state: {
        focus: readOneHot(source, build.cells.focus, 'focus'),
        pressedControl: readOneHot(source, build.cells.pressedControl, 'pressed control'),
      },
      activations: Array.from({length: controlCount}, (_, index) => outputs[activationStart + index]!),
      focusedIndex: outputs[activationStart + controlCount]!,
    }
  }

  function reset(layout: ControlsLayout) {
    source.fill(0)
    writeControls(layout)
  }

  return {...build, source, reset, writeControls, step}
}
