// IndirectOS's window logic over a fixed-capacity event queue, handled in one
// evaluation with the folded form from lab/ui-exploration/input. oracle.ts states
// the rules and processes events one at a time; this circuit handles the whole
// queue at once:
// - Prefix counts of downs and ups give every slot its press session (the
//   events after the s-th down of this evaluation; session 0 continues a press
//   carried in from earlier). With a legal stream they're exact integers.
// - Moves only change what later events see through the pointer latch and "the
//   press crossed slop", an OR over the session's moves and up. Both fold.
// - Press sessions run in sequence (down, then up), because a down hit-tests
//   geometry the previous up may have changed: a drag commit, a maximize toggle,
//   a close, a raise. JS bounds downs per evaluation (events.ts).
// - Photos' focus runs its own sequence: each session's up may click Photos, and
//   the keys between two ups fold into "clear, or rotate by rights minus lefts".
//   A key reaches Photos only when Photos is focused at that key's position,
//   read from the window state after each down and up.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type DesktopContext, type DesktopResult, dockGeometry, frontmost, raiseToFront} from './desktop-latches.ts'
import {type Term, createKit} from '../input/kit.ts'
import {type PhotoInputs, type PhotoSprings, type PhotoStateCells, photoClick, photoKeys, photoLayout, renderPhotos} from './photos.ts'
import {withSection} from '../spring-bank/spring-bank.ts'
import {type Allocated, type SourceTable, bit, constant, event, input, list, oneHot, state} from './table.ts'
import {integerOneHot, maskedRead} from './text-kit.ts'
import type {Rect, Vec2} from '../notation/wires.ts'

// keyGates: how a key slot learns whether Photos is focused at its position.
// - 'gather': one gather over the focus bit at every chain point. Simple, but the
//   gather waits for the last chain point, so Photos' focus chain starts after the
//   whole window chain.
// - 'per-phase': an AND per (slot, chain point), and a key run only reads the
//   chain points of its own segment, so Photos' focus chain interleaves with the
//   window chain.
export type QueueOptions = {capacity: number, maximumDowns: number, keyGates?: 'gather' | 'per-phase'}
export const coordinateLimit = 16_384
export const regionNames = ['close', 'maximize', 'minimize', 'resize', 'drag', 'content'] as const
const regionIndex = (name: typeof regionNames[number]) => regionNames.indexOf(name)
const coordinate = [-coordinateLimit, coordinateLimit] as const
const pixel = [0, 16_384] as const
const photosIndex = 3

// category: declarations
export function queueCells(capacity: number) {
  return {
    slop: constant(4, [0, 64]),
    slots: list(capacity, () => ({
      down: event(), move: event(), up: event(),
      x: input(coordinate), y: input(coordinate),
      arrowLeft: event(), arrowRight: event(), escape: event(),
    })),
    pointer: {x: state(coordinate), y: state(coordinate)},
    press: {
      active: bit(),
      x: state(coordinate),
      y: state(coordinate),
      window: oneHot(list(4, () => bit()), {allowAllZero: true}),
      region: oneHot(list(regionNames.length, () => bit()), {allowAllZero: true}),
      dock: oneHot(list(4, () => bit()), {allowAllZero: true}),
      grab: {left: state(pixel), top: state(pixel), width: state(pixel), height: state(pixel)},
      slop: bit(),
    },
  }
}
export type QueueCells = Allocated<ReturnType<typeof queueCells>>

export function declareQueueRules(table: SourceTable, queue: QueueCells) {
  queue.slots.forEach((slot, index) => table.atMostOne(`queue slot ${index} kinds`, [slot.down, slot.move, slot.up, slot.arrowLeft, slot.arrowRight, slot.escape]))
}

type WindowState = {left: Wire, top: Wire, width: Wire, height: Wire, open: Wire, minimized: Wire, maximized: Wire}
type PressState = {active: Wire, x: Wire, y: Wire, window: Wire[], region: Wire[], dock: Wire[], grab: Rect, slop: Wire}
type ChainState = {windows: WindowState[], stack: Wire[][], press: PressState}

// category: behavior
export function buildQueueDesktop(context: DesktopContext, queue: QueueCells, options: QueueOptions): DesktopResult {
  const {$, table, layout, windows, stack, dockTop, workspaceTop, workspaceHeight, maximizedRect, photoConstants, photoState} = context
  const {sum, sub, half, relu, mul, min, clamp, not, select, rect, hit, zero, unit, assume, circuit} = $
  const kit = createKit(circuit)
  const {viewportWidth, titleHeight, buttonSize, buttonGap, resizeGrip} = layout
  const {slots} = queue
  const capacity = slots.length
  const {maximumDowns} = options
  const keyGates = options.keyGates ?? 'per-phase'
  const sessionCount = maximumDowns + 1
  invariant(capacity === options.capacity && maximumDowns >= 1, 'the queue cells must match the options')
  const dock = dockGeometry(context)
  const xs = slots.map(slot => slot.x)
  const ys = slots.map(slot => slot.y)

  // 1. Counts through each slot, as single rounding points (exact integers).
  const {downPrefix, upPrefix, sessionBits, sessions, sessionSlop, pointer} = withSection(circuit, 'queue counts, slop, pointer', () => {
    const prefix = (kinds: readonly ('down' | 'move' | 'up')[]) => slots.map((_, index) =>
      assume(circuit.roundAffine(slots.slice(0, index + 1).flatMap(slot => kinds.map(kind => [slot[kind], 1] as const))), 0, (index + 1) * kinds.length))
    const downPrefix = prefix(['down'])
    const upPrefix = prefix(['up'])
    // sessionBits[i][s] = [downs through slot i === s]
    const sessionBits = slots.map((_, index) => {
      const reached = (session: number) => kit.atLeast(downPrefix[index]!, session)
      const bits = list(sessionCount, session => {
        const terms: Term[] = []
        if (session > 0) terms.push([reached(session), 1])
        if (session + 1 < sessionCount) terms.push([reached(session + 1), -1])
        return kit.bitAffine(terms, session === 0 ? 1 : 0)
      })
      kit.declareOneHot(bits, false)
      return bits
    })
    const eventsOfSession = (kind: 'down' | 'up', session: number) => {
      const bits = slots.map((slot, index) => kit.atLeast([[slot[kind], 1], [sessionBits[index]![session]!, 1]], 2))
      kit.declareOneHot(bits, true)
      return bits
    }
    const sessions = list(sessionCount, session => {
      const downs = session === 0 ? null : eventsOfSession('down', session)
      const ups = eventsOfSession('up', session)
      return {
        hasDown: downs === null ? zero : kit.bitAffine(kit.sum(downs)),
        down: downs === null ? {x: queue.press.x, y: queue.press.y} : {x: kit.dot(downs, xs), y: kit.dot(downs, ys)},
        hasUp: kit.bitAffine(kit.sum(ups)),
        up: {x: kit.dot(ups, xs), y: kit.dot(ups, ys)},
      }
    })
    // 2. Slop: a move or up of session s farther than slop from its press point.
    const crossings = slots.map((slot, index) => {
      const pressX = kit.dot(sessionBits[index]!, sessions.map(session => session.down.x))
      const pressY = kit.dot(sessionBits[index]!, sessions.map(session => session.down.y))
      const far = kit.atLeast([[kit.chebyshev([[slot.x, 1], [pressX, -1]], [[slot.y, 1], [pressY, -1]]), 1], [queue.slop, -1]], 1)
      const pressedBefore: Term[] = index === 0 ? [[queue.press.active, 1]] : [[queue.press.active, 1], [downPrefix[index - 1]!, 1], [upPrefix[index - 1]!, -1]]
      return kit.atLeast([[slot.move, 1], [slot.up, 1], ...pressedBefore, [far, 1]], 3)
    })
    const sessionSlop = list(sessionCount, session => kit.atLeast([
      ...(session === 0 ? [[queue.press.slop, 1] as const] : []),
      ...slots.map((_, index) => [kit.mask(sessionBits[index]![session]!, crossings[index]!), 1] as const),
    ], 1))
    // 3. The pointer latch: the last pointer event of the evaluation.
    const pointerPrefix = prefix(['down', 'move', 'up'])
    const pointerTotal = pointerPrefix[capacity - 1]!
    const lastPointer = slots.map((slot, index) => kit.atLeast([[slot.down, 1], [slot.move, 1], [slot.up, 1], [pointerPrefix[index]!, 1], [pointerTotal, -1]], 1))
    kit.declareOneHot(lastPointer, true)
    const anyPointer = kit.atLeast([[pointerTotal, 1]], 1)
    const pointer: Vec2 = {x: kit.pick(anyPointer, queue.pointer.x, kit.dot(lastPointer, xs)), y: kit.pick(anyPointer, queue.pointer.y, kit.dot(lastPointer, ys))}
    return {downPrefix, upPrefix, sessionBits, sessions, sessionSlop, pointer}
  })

  // 4. Press sessions in sequence.
  const boxOf = (window: WindowState): Rect => ({
    left: kit.pick(window.maximized, window.left, maximizedRect.left),
    top: kit.pick(window.maximized, window.top, maximizedRect.top),
    width: kit.pick(window.maximized, window.width, maximizedRect.width),
    height: kit.pick(window.maximized, window.height, maximizedRect.height),
  })
  const contentRect = (box: Rect) => rect(sum(box.left, [unit, 1]), sum(box.top, titleHeight, [unit, 1]), relu(sum(box.width, [unit, -2])), relu(sum(box.height, [titleHeight, -1], [unit, -2])))
  const visibleOf = (window: WindowState) => mul(window.open, not(window.minimized))

  function geometryFromGrab(press: PressState, point: Vec2): Rect {
    const resize = press.region[regionIndex('resize')]!
    const drag = press.region[regionIndex('drag')]!
    const dx = sub(point.x, press.x)
    const dy = sub(point.y, press.y)
    const width = clamp(sum(press.grab.width, kit.gated(resize, dx)), min(layout.minWidth, viewportWidth), viewportWidth)
    const height = clamp(sum(press.grab.height, kit.gated(resize, dy)), min(layout.minHeight, workspaceHeight), workspaceHeight)
    const left = clamp(sum(press.grab.left, kit.gated(drag, dx)), zero, relu(sub(viewportWidth, width)))
    const top = clamp(sum(press.grab.top, kit.gated(drag, dy)), workspaceTop, relu(sub(dockTop, height)))
    return {left, top, width, height}
  }

  const downUpdate = (chain: ChainState, gate: Wire, point: Vec2): ChainState => withSection(circuit, 'down update', () => {
    const current = chain.windows.map(window => {
      const box = boxOf(window)
      const buttonTop = sum(box.top, [titleHeight, 0.5], [buttonSize, -0.5])
      const closeLeft = sum(box.left, box.width, [buttonGap, -1], [buttonSize, -1])
      const maximizeLeft = sum(closeLeft, [buttonGap, -1], [buttonSize, -1])
      const minimizeLeft = sum(maximizeLeft, [buttonGap, -1], [buttonSize, -1])
      const buttonHit = (left: Wire) => hit(point, $.outset(rect(left, buttonTop, buttonSize, buttonSize), half(buttonGap)))
      const normalWindow = not(window.maximized)
      const hits = [
        buttonHit(closeLeft), buttonHit(maximizeLeft), buttonHit(minimizeLeft),
        mul(hit(point, rect(sub($.right(box), resizeGrip), sub($.bottom(box), resizeGrip), resizeGrip, resizeGrip)), normalWindow),
        mul(hit(point, rect(box.left, box.top, relu(sub(minimizeLeft, buttonGap, box.left)), titleHeight)), normalWindow),
        hit(point, contentRect(box)),
      ]
      // The first region that hits wins, in regionNames order.
      const regions = hits.map((regionHit, index) => kit.atLeast([[regionHit, 1], ...hits.slice(0, index).map(earlier => [earlier, -1] as const)], 1))
      return {windowHit: mul(visibleOf(window), hit(point, box)), regions}
    })
    const pressed = frontmost($, chain.stack, current.map(window => window.windowHit))
    kit.declareOneHot(pressed, true)
    const freshRegions = regionNames.map((_, index) => assume(kit.dot(pressed, current.map(window => window.regions[index]!)), 0, 1))
    const dockHits = dock.map(item => hit(point, item.box))
    const grabField = (field: 'left' | 'top' | 'width' | 'height') => kit.pick(gate, chain.press.grab[field], kit.dot(pressed, chain.windows.map(window => window[field])))
    const press: PressState = {
      // A legal stream has no press when a down arrives, so the sum is a bit.
      active: kit.bitAffine([[chain.press.active, 1], [gate, 1]]),
      x: kit.pick(gate, chain.press.x, point.x),
      y: kit.pick(gate, chain.press.y, point.y),
      window: pressed.map((pressedBit, index) => kit.pickBit(gate, chain.press.window[index]!, pressedBit)),
      region: freshRegions.map((regionBit, index) => kit.pickBit(gate, chain.press.region[index]!, regionBit)),
      dock: dockHits.map((dockHit, index) => kit.pickBit(gate, chain.press.dock[index]!, dockHit)),
      grab: {left: grabField('left'), top: grabField('top'), width: grabField('width'), height: grabField('height')},
      slop: kit.pickBit(gate, chain.press.slop, zero),
    }
    for (const group of [press.window, press.region, press.dock]) kit.declareOneHot(group, true)
    return {windows: chain.windows, stack: raiseToFront($, chain.stack, pressed.map(pressedBit => kit.mask(gate, pressedBit))), press}
  })

  const upUpdate = (chain: ChainState, gate: Wire, point: Vec2, slop: Wire) => withSection(circuit, 'up update', () => {
    const {press} = chain
    const click = kit.atLeast([[gate, 1], [slop, -1]], 1)
    const moving = kit.bitAffine([[press.region[regionIndex('resize')]!, 1], [press.region[regionIndex('drag')]!, 1]])
    const committed = geometryFromGrab(press, point)
    const onRegion = (index: number, name: typeof regionNames[number]) => kit.atLeast([[click, 1], [press.window[index]!, 1], [press.region[regionIndex(name)]!, 1]], 3)
    const commits: Wire[] = []
    const dockClicks: Wire[] = []
    const nextWindows = chain.windows.map((window, index) => {
      const commit = kit.atLeast([[gate, 1], [press.window[index]!, 1], [moving, 1]], 3)
      commits.push(commit)
      const closeClick = onRegion(index, 'close')
      const maximizeClick = onRegion(index, 'maximize')
      const minimizeClick = onRegion(index, 'minimize')
      const dockClick = kit.atLeast([[click, 1], [press.dock[index]!, 1]], 2)
      dockClicks.push(dockClick)
      const afterClose = kit.pickBit(closeClick, window.open, zero)
      const open = kit.pickBit(dockClick, afterClose, unit)
      const afterMinimize = kit.pickBit(minimizeClick, window.minimized, unit)
      const afterDock = kit.pickBit(dockClick, afterMinimize, zero)
      const minimized = kit.pickBit(closeClick, afterDock, zero)
      const toggled = kit.bitAffine([[window.maximized, 1], [maximizeClick, 1], [kit.mask(window.maximized, maximizeClick), -2]])
      return {
        left: kit.pick(commit, window.left, committed.left),
        top: kit.pick(commit, window.top, committed.top),
        width: kit.pick(commit, window.width, committed.width),
        height: kit.pick(commit, window.height, committed.height),
        open,
        minimized,
        maximized: kit.pickBit(closeClick, toggled, zero),
      }
    })
    // A click on the Photos content reaches Photos at local coordinates, laid out at the window's destination size.
    const content = contentRect(boxOf(chain.windows[photosIndex]!))
    const photos = {
      gate: onRegion(photosIndex, 'content'),
      local: {x: sub(point.x, content.left), y: sub(point.y, content.top)},
      contentSize: {x: content.width, y: content.height},
    }
    const nextPress: PressState = {...press, active: kit.bitAffine([[press.active, 1], [gate, -1]]), slop: kit.pickBit(gate, press.slop, zero)}
    return {chain: {windows: nextWindows, stack: raiseToFront($, chain.stack, dockClicks), press: nextPress}, commits, photos}
  })

  let chain: ChainState = {
    windows: windows.map(({left, top, width, height, open, minimized, maximized}) => ({left, top, width, height, open, minimized, maximized})),
    stack: stack.map(row => [...row]),
    press: {...queue.press, window: [...queue.press.window], region: [...queue.press.region], dock: [...queue.press.dock], grab: {...queue.press.grab}},
  }
  // The window state after each down and each up: C0, after up 0, after down 1, after up 1, ...
  const chainPoints: ChainState[] = [chain]
  const commits: Wire[][] = []
  const photoClicks: ReturnType<typeof upUpdate>['photos'][] = []
  for (let session = 0; session < sessionCount; session++) {
    const events = sessions[session]!
    if (session > 0) {
      chain = downUpdate(chain, events.hasDown, events.down)
      chainPoints.push(chain)
    }
    const up = upUpdate(chain, events.hasUp, events.up, sessionSlop[session]!)
    chain = up.chain
    chainPoints.push(chain)
    commits.push(up.commits)
    photoClicks.push(up.photos)
  }

  // 5. Keys. A slot's phase counts the downs and ups through it: phase 2s is
  // "after down s" (or the initial state), phase 2s + 1 is "after up s". The
  // keys before up s, back to up s - 1, are phases 2s - 1 and 2s: one run.
  const phaseCount = 2 * maximumDowns + 2
  const runCount = maximumDowns + 2
  const photosFocusedAt = withSection(circuit, 'focus at chain points', () => chainPoints.map(point => frontmost($, point.stack, point.windows.map(visibleOf))[photosIndex]!))
  const phaseTerms = (index: number): Term[] => [[downPrefix[index]!, 1], [upPrefix[index]!, 1], [queue.press.active, -1]]
  const keyRuns = withSection(circuit, 'key gates', () => {
    if (keyGates === 'gather') {
      const keys = slots.map((slot, index) => {
        const phase = assume(circuit.roundAffine([...phaseTerms(index), [unit, 1]]), 0, phaseCount - 1)
        const photosFocused = assume(maskedRead(circuit, integerOneHot(circuit, unit, phase, 0, phaseCount, false).members, photosFocusedAt), 0, 1)
        const segment = assume(circuit.roundAffine([[upPrefix[index]!, 1], [queue.press.active, -1], [unit, 1]]), 0, runCount - 1)
        return {
          run: integerOneHot(circuit, unit, segment, 0, runCount, false).members,
          left: kit.and([slot.arrowLeft, photosFocused]),
          right: kit.and([slot.arrowRight, photosFocused]),
          escape: kit.and([slot.escape, photosFocused]),
        }
      })
      return list(runCount, run => {
        const rotationTerms: Term[] = []
        const escapeTerms: Term[] = []
        for (const key of keys) {
          rotationTerms.push([kit.mask(key.run[run]!, key.right), 1], [kit.mask(key.run[run]!, key.left), -1])
          escapeTerms.push([kit.mask(key.run[run]!, key.escape), 1])
        }
        return {rotationTerms, escapeTerms}
      })
    }
    // [phase >= k] for k = 1..phaseCount - 1; the relus are shared between neighbors.
    const thermometers = slots.map((_, index) => list(phaseCount + 1, threshold =>
      threshold === 0 ? kit.one : threshold === phaseCount ? kit.zero : kit.atLeast([...phaseTerms(index), [kit.one, 1]], threshold)))
    return list(runCount, run => {
      const rotationTerms: Term[] = []
      const escapeTerms: Term[] = []
      const phases = [2 * run - 1, 2 * run].filter(phase => phase >= 0 && phase < phaseCount)
      slots.forEach((slot, index) => {
        for (const phase of phases) {
          const inPhase: Term[] = [[thermometers[index]![phase]!, 1], [thermometers[index]![phase + 1]!, -1], [photosFocusedAt[phase]!, 1]]
          rotationTerms.push([kit.atLeast([...inPhase, [slot.arrowRight, 1]], 3), 1], [kit.atLeast([...inPhase, [slot.arrowLeft, 1]], 3), -1])
          escapeTerms.push([kit.atLeast([...inPhase, [slot.escape, 1]], 3), 1])
        }
      })
      return {rotationTerms, escapeTerms}
    })
  })
  let focus: Wire[] = [...photoState.focus]
  const applyKeys = (run: number) => withSection(circuit, 'photos keys', () => {
    const {rotationTerms, escapeTerms} = keyRuns[run]!
    const rotation = assume(circuit.roundAffine(rotationTerms), -capacity, capacity)
    const oneHot = integerOneHot(circuit, unit, rotation, -capacity, 2 * capacity + 1, false).members
    focus = photoKeys($, focus, {oneHot, low: -capacity}, kit.atLeast(escapeTerms, 1))
  })
  for (let session = 0; session < sessionCount; session++) {
    applyKeys(session)
    const click = photoClicks[session]!
    focus = withSection(circuit, 'photos clicks', () => photoClick($, photoLayout($, photoConstants, click.contentSize, unit), focus, click.gate, click.local))
  }
  applyKeys(sessionCount)
  table.next(photoState.focus, focus)

  // 6. The end of the evaluation: a held drag or resize follows the pointer from
  // the grab, and every other window is clamped to the current viewport.
  const {updated, slopLatch} = withSection(circuit, 'end of evaluation', () => {
    const {press} = chain
    const endMoving = kit.bitAffine([[press.region[regionIndex('resize')]!, 1], [press.region[regionIndex('drag')]!, 1]])
    const dragged = geometryFromGrab(press, pointer)
    const updated = chain.windows.map((window, index) => {
      const held = kit.atLeast([[press.active, 1], [press.window[index]!, 1], [endMoving, 1]], 3)
      const width = clamp(window.width, min(layout.minWidth, viewportWidth), viewportWidth)
      const height = clamp(window.height, min(layout.minHeight, workspaceHeight), workspaceHeight)
      const clamped = {left: clamp(window.left, zero, relu(sub(viewportWidth, width))), top: clamp(window.top, workspaceTop, relu(sub(dockTop, height))), width, height}
      const normal = rect(kit.pick(held, clamped.left, dragged.left), kit.pick(held, clamped.top, dragged.top), kit.pick(held, clamped.width, dragged.width), kit.pick(held, clamped.height, dragged.height))
      // Springs snap while the window is dragged or resized, including in an evaluation where the press ended.
      const direct = kit.atLeast([[held, 1], ...commits.map(sessionCommits => [sessionCommits[index]!, 1] as const)], 1)
      return {normal, open: window.open, minimized: window.minimized, maximized: window.maximized, direct}
    })
    const lastSession = sessionBits[capacity - 1]!
    const slopLatch = kit.atLeast([[press.active, 1], ...sessionSlop.map((slop, session) => [kit.mask(lastSession[session]!, slop), 1] as const)], 2)
    return {updated, slopLatch}
  })
  const {press} = chain
  table.next(queue.pointer, pointer)
  table.next(queue.press, {active: press.active, x: press.x, y: press.y, window: press.window, region: press.region, dock: press.dock, grab: press.grab, slop: slopLatch})

  const nextStack = chain.stack
  const next = updated.map(window => ({visible: mul(window.open, not(window.minimized)), box: select(window.maximized, window.normal, maximizedRect)}))
  const focused = frontmost($, nextStack, next.map(window => window.visible))
  const previousFocusMass = assume(sum(...photoState.focus), 0, 1)
  return {
    updated, nextStack, next, focused, dock,
    renderPhotos(inputs: PhotoInputs, cells: PhotoStateCells, springs: PhotoSprings) {
      assume(inputs.viewport.x, ...pixel)
      assume(inputs.viewport.y, ...pixel)
      assume(inputs.present, 0, 1)
      return withSection(circuit, 'photos render', () => renderPhotos($, table, cells, photoLayout($, photoConstants, inputs.viewport, inputs.present), previousFocusMass, focus, springs))
    },
    debug: {},
  }
}
