// The ladder of UI decision rules, each enumerated over every input case.
//
// A task is a table of 0/1 input bits and 0/1 target bits per case, plus, for
// wiring biased toward prefix structure, a position per bit (a control index or
// a bit's significance), and a library of named intermediate predicates that
// inspect.ts looks for inside learned networks.

import {
  availableItems,
  cyclicNextEnabled,
  insideHalfOpen,
  keyNames,
  menuOracleEvent,
  menuPlacement,
  strictlyInside,
  type MenuLayout,
  type MenuState,
  type QueuedEvent,
  type Rectangle,
} from './oracles.ts'

export type Predicate = {name: string, values: Uint8Array}

export type Task = {
  name: string
  inputNames: readonly string[]
  outputNames: readonly string[]
  // -1 means the bit has no position, e.g. Shift. Positions 0..positionCount-1.
  inputPositions: Int32Array
  outputPositions: Int32Array
  positionCount: number
  cyclic: boolean
  inputCount: number
  outputCount: number
  caseCount: number
  inputs: Uint8Array // [case * inputCount + input]
  targets: Uint8Array // [case * outputCount + output]
  predicates: () => Predicate[]
}

type TaskSpec = Omit<Task, 'inputCount' | 'outputCount' | 'inputs' | 'targets'> & {
  enumerate: (emit: (input: ArrayLike<number>, target: ArrayLike<number>) => void) => void
}

function buildTask(spec: TaskSpec): Task {
  const inputCount = spec.inputNames.length
  const outputCount = spec.outputNames.length
  const inputs = new Uint8Array(spec.caseCount * inputCount)
  const targets = new Uint8Array(spec.caseCount * outputCount)
  let position = 0
  spec.enumerate((input, target) => {
    if (position >= spec.caseCount) throw new Error(`${spec.name}: more cases than declared`)
    for (let index = 0; index < inputCount; index++) inputs[position * inputCount + index] = input[index]!
    for (let index = 0; index < outputCount; index++) targets[position * outputCount + index] = target[index]!
    position++
  })
  if (position !== spec.caseCount) throw new Error(`${spec.name}: ${position} cases, declared ${spec.caseCount}`)
  const {enumerate: _enumerate, ...rest} = spec
  return {...rest, inputCount, outputCount, inputs, targets}
}

function predicate(caseCount: number, name: string, test: (caseIndex: number) => boolean): Predicate {
  const values = new Uint8Array(caseCount)
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) values[caseIndex] = test(caseIndex) ? 1 : 0
  return {name, values}
}

function range(count: number) {
  return Array.from({length: count}, (_, index) => index)
}

// ---------------------------------------------------------------------------
// First active of n bits: the lowest set bit as a one-hot, all zero when none.

export function firstActiveTask(bits = 8): Task {
  const caseCount = 2 ** bits
  const firstOf = (mask: number) => (mask === 0 ? -1 : Math.clz32(0) - 1 - Math.clz32(mask & -mask))
  return buildTask({
    name: `first-active-${bits}`,
    inputNames: range(bits).map(index => `x[${index}]`),
    outputNames: range(bits).map(index => `first[${index}]`),
    inputPositions: Int32Array.from(range(bits)),
    outputPositions: Int32Array.from(range(bits)),
    positionCount: bits,
    cyclic: false,
    caseCount,
    enumerate: emit => {
      const input = new Uint8Array(bits)
      const target = new Uint8Array(bits)
      for (let mask = 0; mask < caseCount; mask++) {
        target.fill(0)
        for (let index = 0; index < bits; index++) input[index] = (mask >> index) & 1
        const first = firstOf(mask)
        if (first >= 0) target[first] = 1
        emit(input, target)
      }
    },
    predicates: () => [
      ...range(bits).map(index => predicate(caseCount, `x[${index}]`, mask => ((mask >> index) & 1) === 1)),
      ...range(bits).slice(2).map(index => predicate(caseCount, `any of x[0..${index - 1}]`, mask => (mask & ((1 << index) - 1)) !== 0)),
      ...range(bits).map(index => predicate(caseCount, `first[${index}]`, mask => firstOf(mask) === index)),
    ],
  })
}

// ---------------------------------------------------------------------------
// Tab and Shift+Tab over n controls, input/keyboard.ts's cyclicNextEnabled.
// Inputs: focus[i] (one-hot, all zero when nothing is focused), enabled[i],
// shift. Outputs: the next focus one-hot.

export function tabTask(controls: number): Task {
  const caseCount = (controls + 1) * 2 ** controls * 2
  const decode = (caseIndex: number) => {
    const shift = caseIndex % 2
    const mask = Math.floor(caseIndex / 2) % 2 ** controls
    const from = Math.floor(caseIndex / 2 / 2 ** controls) - 1
    const enabled = range(controls).map(index => ((mask >> index) & 1) === 1)
    return {from, enabled, shift: shift === 1}
  }
  const task = buildTask({
    name: `tab-${controls}`,
    inputNames: [...range(controls).map(index => `focus[${index}]`), ...range(controls).map(index => `enabled[${index}]`), 'shift'],
    outputNames: range(controls).map(index => `next[${index}]`),
    inputPositions: Int32Array.from([...range(controls), ...range(controls), -1]),
    outputPositions: Int32Array.from(range(controls)),
    positionCount: controls,
    cyclic: true,
    caseCount,
    enumerate: emit => {
      const input = new Uint8Array(2 * controls + 1)
      const target = new Uint8Array(controls)
      for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
        const {from, enabled, shift} = decode(caseIndex)
        input.fill(0)
        target.fill(0)
        if (from >= 0) input[from] = 1
        enabled.forEach((flag, index) => { input[controls + index] = flag ? 1 : 0 })
        input[2 * controls] = shift ? 1 : 0
        const next = cyclicNextEnabled(enabled, from, shift)
        if (next >= 0) target[next] = 1
        emit(input, target)
      }
    },
    predicates: () => {
      const cases = range(caseCount).map(decode)
      const on = (name: string, test: (state: ReturnType<typeof decode>) => boolean) => predicate(caseCount, name, caseIndex => test(cases[caseIndex]!))
      const noneEnabledIn = (enabled: boolean[], from: number, to: number) => {
        for (let index = from; index < to; index++) if (enabled[index]!) return false
        return true
      }
      const list: Predicate[] = [on('shift', state => state.shift), on('no focus', state => state.from === -1)]
      for (const index of range(controls)) {
        list.push(on(`focus[${index}]`, state => state.from === index))
        list.push(on(`enabled[${index}]`, state => state.enabled[index]!))
        // input's cyclicNextAvailable, forward: "enabled and after the focus",
        // "the first of those", "the first enabled overall".
        list.push(on(`enabled[${index}] and focus before it`, state => state.enabled[index]! && state.from >= 0 && state.from < index))
        list.push(on(`first enabled after focus = [${index}] (no wrap)`, state => state.enabled[index]! && state.from >= 0 && state.from < index && noneEnabledIn(state.enabled, state.from + 1, index)))
        list.push(on(`first enabled overall = [${index}]`, state => state.enabled[index]! && noneEnabledIn(state.enabled, 0, index)))
        list.push(on(`enabled[${index}] and focus after it`, state => state.enabled[index]! && state.from > index))
        list.push(on(`first enabled before focus = [${index}] (no wrap)`, state => state.enabled[index]! && state.from > index && noneEnabledIn(state.enabled, index + 1, state.from)))
        list.push(on(`last enabled overall = [${index}]`, state => state.enabled[index]! && noneEnabledIn(state.enabled, index + 1, controls)))
        list.push(on(`tab forward = [${index}]`, state => cyclicNextEnabled(state.enabled, state.from, false) === index))
        list.push(on(`tab backward = [${index}]`, state => cyclicNextEnabled(state.enabled, state.from, true) === index))
        list.push(on(`next[${index}]`, state => cyclicNextEnabled(state.enabled, state.from, state.shift) === index))
      }
      list.push(on('some enabled control after focus (no wrap)', state => state.from >= 0 && !noneEnabledIn(state.enabled, state.from + 1, controls)))
      list.push(on('some enabled control before focus (no wrap)', state => state.from > 0 && !noneEnabledIn(state.enabled, 0, state.from)))
      list.push(on('some control enabled', state => state.enabled.some(Boolean)))
      return list
    },
  })
  return task
}

// ---------------------------------------------------------------------------
// Rectangle hit on 6-bit coordinates: strictlyInside a fixed rectangle, for a
// pointer whose x and y are 6-bit integers, most significant bit first.

export const hitRectangle: Rectangle = {left: 9, top: 22, width: 37, height: 29}
const coordinateBits = 6

export function rectangleHitTask(): Task {
  const caseCount = 2 ** (2 * coordinateBits)
  const decode = (caseIndex: number) => ({x: caseIndex >> coordinateBits, y: caseIndex & (2 ** coordinateBits - 1)})
  const right = hitRectangle.left + hitRectangle.width
  const bottom = hitRectangle.top + hitRectangle.height
  return buildTask({
    name: 'rectangle-hit',
    inputNames: [...range(coordinateBits).map(index => `x.bit${coordinateBits - 1 - index}`), ...range(coordinateBits).map(index => `y.bit${coordinateBits - 1 - index}`)],
    outputNames: ['inside'],
    // Position 0 is the most significant bit, so a bit's "prefix" is the bits above it.
    inputPositions: Int32Array.from([...range(coordinateBits), ...range(coordinateBits)]),
    outputPositions: Int32Array.from([coordinateBits - 1]),
    positionCount: coordinateBits,
    cyclic: false,
    caseCount,
    enumerate: emit => {
      const input = new Uint8Array(2 * coordinateBits)
      for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
        const {x, y} = decode(caseIndex)
        for (let index = 0; index < coordinateBits; index++) {
          input[index] = (x >> (coordinateBits - 1 - index)) & 1
          input[coordinateBits + index] = (y >> (coordinateBits - 1 - index)) & 1
        }
        emit(input, [strictlyInside(hitRectangle, x, y) ? 1 : 0])
      }
    },
    predicates: () => {
      const list: Predicate[] = []
      const on = (name: string, test: (x: number, y: number) => boolean) => predicate(caseCount, name, caseIndex => {
        const {x, y} = decode(caseIndex)
        return test(x, y)
      })
      list.push(on(`x > ${hitRectangle.left}`, x => x > hitRectangle.left))
      list.push(on(`x < ${right}`, x => x < right))
      list.push(on(`y > ${hitRectangle.top}`, (_, y) => y > hitRectangle.top))
      list.push(on(`y < ${bottom}`, (_, y) => y < bottom))
      list.push(on('x inside', x => x > hitRectangle.left && x < right))
      list.push(on('y inside', (_, y) => y > hitRectangle.top && y < bottom))
      // Carry-lookahead intermediates: comparisons of the top k bits.
      for (let k = 1; k < coordinateBits; k++) {
        const shift = coordinateBits - k
        for (const [axis, bound, relation] of [['x', hitRectangle.left, '>'], ['x', right, '<'], ['y', hitRectangle.top, '>'], ['y', bottom, '<']] as const) {
          const read = (x: number, y: number) => (axis === 'x' ? x : y) >> shift
          const boundTop = bound >> shift
          list.push(on(`top ${k} bits of ${axis} ${relation} top ${k} bits of ${bound}`, (x, y) => relation === '>' ? read(x, y) > boundTop : read(x, y) < boundTop))
          list.push(on(`top ${k} bits of ${axis} = top ${k} bits of ${bound}`, (x, y) => read(x, y) === boundTop))
        }
      }
      return list
    },
  })
}

// ---------------------------------------------------------------------------
// Click versus drag on 5-bit deltas: dx and dy are 5-bit two's complement
// integers (-16..15), sign bit first. The output is 1 for a drag, i.e. the
// Chebyshev distance from the press point exceeds the slop (input/windows.ts).

export const dragSlop = 4
const deltaBits = 5

export function dragTask(): Task {
  const caseCount = 2 ** (2 * deltaBits)
  const signed = (value: number) => (value >= 2 ** (deltaBits - 1) ? value - 2 ** deltaBits : value)
  const decode = (caseIndex: number) => ({dx: signed(caseIndex >> deltaBits), dy: signed(caseIndex & (2 ** deltaBits - 1))})
  return buildTask({
    name: 'click-or-drag',
    inputNames: [...range(deltaBits).map(index => `dx.bit${deltaBits - 1 - index}`), ...range(deltaBits).map(index => `dy.bit${deltaBits - 1 - index}`)],
    outputNames: ['drag'],
    inputPositions: Int32Array.from([...range(deltaBits), ...range(deltaBits)]),
    outputPositions: Int32Array.from([deltaBits - 1]),
    positionCount: deltaBits,
    cyclic: false,
    caseCount,
    enumerate: emit => {
      const input = new Uint8Array(2 * deltaBits)
      for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
        const {dx, dy} = decode(caseIndex)
        const rawX = dx & (2 ** deltaBits - 1)
        const rawY = dy & (2 ** deltaBits - 1)
        for (let index = 0; index < deltaBits; index++) {
          input[index] = (rawX >> (deltaBits - 1 - index)) & 1
          input[deltaBits + index] = (rawY >> (deltaBits - 1 - index)) & 1
        }
        emit(input, [Math.max(Math.abs(dx), Math.abs(dy)) > dragSlop ? 1 : 0])
      }
    },
    predicates: () => {
      const on = (name: string, test: (dx: number, dy: number) => boolean) => predicate(caseCount, name, caseIndex => {
        const {dx, dy} = decode(caseIndex)
        return test(dx, dy)
      })
      return [
        on('dx >= 0', dx => dx >= 0),
        on('dy >= 0', (_, dy) => dy >= 0),
        on(`dx > ${dragSlop}`, dx => dx > dragSlop),
        on(`dx < -${dragSlop}`, dx => dx < -dragSlop),
        on(`|dx| > ${dragSlop}`, dx => Math.abs(dx) > dragSlop),
        on(`dy > ${dragSlop}`, (_, dy) => dy > dragSlop),
        on(`dy < -${dragSlop}`, (_, dy) => dy < -dragSlop),
        on(`|dy| > ${dragSlop}`, (_, dy) => Math.abs(dy) > dragSlop),
        on('drag', (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy)) > dragSlop),
      ]
    },
  })
}

// ---------------------------------------------------------------------------
// One event slot of input/menu.ts's menu bar, with the layout fixed (the bar
// from input/menu.test.ts: 3 menus, 5 item slots) and the pointer reduced to
// region bits. The region bits are what the arithmetic part of a circuit
// computes from coordinates: which title is under the pointer, whether it is
// inside each menu's panel, and which item row of each panel it is on. The
// oracle itself runs on real coordinates at a representative point per region.

export const menuTaskLayout: MenuLayout = {
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

// Representative pointer positions: the three titles, a gap in the bar, the
// desktop, and item rows and paddings of each panel, including points where
// menu 0's and menu 1's panels overlap.
export const menuTaskPoints: readonly {x: number, y: number}[] = [
  {x: 30, y: 12}, {x: 90, y: 12}, {x: 770, y: 12}, {x: 300, y: 12}, {x: 500, y: 400},
  {x: 30, y: 26}, {x: 30, y: 40}, {x: 30, y: 64}, {x: 30, y: 88}, {x: 30, y: 112}, {x: 30, y: 126}, {x: 2, y: 40},
  {x: 100, y: 40}, {x: 100, y: 64}, {x: 100, y: 88}, {x: 100, y: 112},
  {x: 210, y: 40}, {x: 216, y: 40},
  {x: 650, y: 40}, {x: 650, y: 64}, {x: 650, y: 78},
]

export function menuSlotStates(layout: MenuLayout = menuTaskLayout): MenuState[] {
  const states: MenuState[] = []
  const menuCount = layout.menus.length
  for (let open = -1; open < menuCount; open++) {
    const highlights = open === -1 ? [-1] : [-1, ...availableItems(layout, open).flatMap((flag, item) => (flag ? [item] : []))]
    for (const highlight of highlights) {
      for (let titleFocus = -1; titleFocus < menuCount; titleFocus++) states.push({open, highlight, titleFocus})
    }
  }
  return states
}

export function menuSlotEvents(): (QueuedEvent | null)[] {
  const events: (QueuedEvent | null)[] = [null]
  for (const key of keyNames) for (const shift of [false, true]) events.push({kind: 'key', key, shift, time: 0})
  for (const kind of ['down', 'move', 'up'] as const) for (const point of menuTaskPoints) events.push({kind, x: point.x, y: point.y, time: 0})
  return events
}

export function menuSlotTask(): Task {
  const layout = menuTaskLayout
  const menuCount = layout.menus.length
  const itemSlots = layout.menus[0]!.present.length
  const states = menuSlotStates(layout)
  const events = menuSlotEvents()
  const caseCount = states.length * events.length
  const placements = range(menuCount).map(index => menuPlacement(layout, index))
  const inputNames = [
    ...range(menuCount).map(index => `open[${index}]`),
    ...range(itemSlots).map(index => `highlight[${index}]`),
    ...range(menuCount).map(index => `titleFocus[${index}]`),
    'event.down', 'event.move', 'event.up', 'event.key',
    ...keyNames.map(key => `key.${key}`),
    'shift',
    ...range(menuCount).map(index => `titleUnder[${index}]`),
    ...range(menuCount).map(index => `insidePanel[${index}]`),
    ...range(menuCount).flatMap(index => range(itemSlots).map(item => `itemRow[${index}][${item}]`)),
  ]
  const outputNames = [
    ...range(menuCount).map(index => `next open[${index}]`),
    ...range(itemSlots).map(index => `next highlight[${index}]`),
    ...range(menuCount).map(index => `next titleFocus[${index}]`),
    ...range(itemSlots).map(index => `activated[${index}]`),
  ]
  const encode = (state: MenuState, event: QueuedEvent | null) => {
    const bits: number[] = []
    for (let index = 0; index < menuCount; index++) bits.push(state.open === index ? 1 : 0)
    for (let item = 0; item < itemSlots; item++) bits.push(state.highlight === item ? 1 : 0)
    for (let index = 0; index < menuCount; index++) bits.push(state.titleFocus === index ? 1 : 0)
    for (const kind of ['down', 'move', 'up', 'key'] as const) bits.push(event?.kind === kind ? 1 : 0)
    for (const key of keyNames) bits.push(event?.kind === 'key' && event.key === key ? 1 : 0)
    bits.push(event?.kind === 'key' && event.shift ? 1 : 0)
    const pointer = event !== null && event.kind !== 'key' ? event : null
    for (let index = 0; index < menuCount; index++) bits.push(pointer !== null && insideHalfOpen(layout.menus[index]!.anchor, pointer.x, pointer.y) ? 1 : 0)
    for (let index = 0; index < menuCount; index++) bits.push(pointer !== null && insideHalfOpen(placements[index]!, pointer.x, pointer.y) ? 1 : 0)
    for (let index = 0; index < menuCount; index++) {
      const panel = placements[index]!
      for (let item = 0; item < itemSlots; item++) {
        const onRow = pointer !== null
          && pointer.x >= panel.left + layout.padding
          && pointer.x < panel.left + panel.width - layout.padding
          && pointer.y >= panel.top + layout.padding + item * layout.itemHeight
          && pointer.y < panel.top + layout.padding + (item + 1) * layout.itemHeight
        bits.push(onRow ? 1 : 0)
      }
    }
    return bits
  }
  const step = (state: MenuState, event: QueuedEvent | null) => {
    const next = {...state}
    const activations = range(menuCount).map(() => range(itemSlots).map(() => 0))
    if (event !== null) menuOracleEvent(layout, next, event, activations)
    return {next, activated: range(itemSlots).map(item => activations.some(row => row[item]! > 0))}
  }
  return buildTask({
    name: 'menu-slot',
    inputNames,
    outputNames,
    inputPositions: new Int32Array(inputNames.length).fill(-1),
    outputPositions: new Int32Array(outputNames.length).fill(-1),
    positionCount: 0,
    cyclic: false,
    caseCount,
    enumerate: emit => {
      for (const state of states) {
        for (const event of events) {
          const {next, activated} = step(state, event)
          const target = [
            ...range(menuCount).map(index => (next.open === index ? 1 : 0)),
            ...range(itemSlots).map(item => (next.highlight === item ? 1 : 0)),
            ...range(menuCount).map(index => (next.titleFocus === index ? 1 : 0)),
            ...activated.map(flag => (flag ? 1 : 0)),
          ]
          emit(encode(state, event), target)
        }
      }
    },
    predicates: () => {
      const cases = states.flatMap(state => events.map(event => ({state, event})))
      const on = (name: string, test: (state: MenuState, event: QueuedEvent | null) => boolean) => predicate(caseCount, name, caseIndex => test(cases[caseIndex]!.state, cases[caseIndex]!.event))
      const isKey = (event: QueuedEvent | null, ...keys: string[]) => event?.kind === 'key' && keys.includes(event.key)
      const list: Predicate[] = [
        on('a menu is open', state => state.open >= 0),
        on('an item is highlighted', state => state.highlight >= 0),
        on('a title has focus', state => state.titleFocus >= 0),
        on('title regime (title focus, no menu open)', state => state.titleFocus >= 0 && state.open < 0),
        on('no regime (nothing open or focused)', state => state.titleFocus < 0 && state.open < 0),
        on('key Enter or Space', (_, event) => isKey(event, 'Enter', 'Space')),
        on('any arrow key', (_, event) => isKey(event, 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown')),
        on('pointer on some title', (_, event) => event !== null && event.kind !== 'key' && layout.menus.some(menu => insideHalfOpen(menu.anchor, event.x, event.y))),
        on('activate by key', (state, event) => state.open >= 0 && state.highlight >= 0 && isKey(event, 'Enter', 'Space')),
        on('state unchanged', (state, event) => {
          const {next} = step(state, event)
          return next.open === state.open && next.highlight === state.highlight && next.titleFocus === state.titleFocus
        }),
      ]
      for (let item = 0; item < itemSlots; item++) {
        list.push(on(`available item [${item}] under pointer in the open menu`, (state, event) => {
          if (state.open < 0 || event === null || event.kind === 'key') return false
          const panel = placements[state.open]!
          return availableItems(layout, state.open)[item]!
            && event.x >= panel.left + layout.padding && event.x < panel.left + panel.width - layout.padding
            && event.y >= panel.top + layout.padding + item * layout.itemHeight && event.y < panel.top + layout.padding + (item + 1) * layout.itemHeight
        }))
      }
      return list
    },
  })
}

export type TaskName = 'first-active-8' | 'tab-4' | 'tab-6' | 'tab-8' | 'tab-12' | 'rectangle-hit' | 'click-or-drag' | 'menu-slot'

export function createTask(name: string): Task {
  if (name.startsWith('first-active-')) return firstActiveTask(Number(name.slice('first-active-'.length)))
  if (name.startsWith('tab-')) return tabTask(Number(name.slice('tab-'.length)))
  if (name === 'rectangle-hit') return rectangleHitTask()
  if (name === 'click-or-drag') return dragTask()
  if (name === 'menu-slot') return menuSlotTask()
  throw new Error(`unknown task ${name}`)
}
