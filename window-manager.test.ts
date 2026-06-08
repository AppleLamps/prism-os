import assert from 'node:assert/strict'
import {test} from 'bun:test'
import type {NumericArray} from './numeric-ui-core.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from './window-manager.ts'

const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16

type Machine = ReturnType<typeof createWindowManagerMachine>
const frameTimeByMachine = new WeakMap<Machine, number>()

function step(
  machine: Machine,
  width = viewportWidth,
  height = viewportHeight,
  elapsed = frameDuration,
) {
  const frameTime = (frameTimeByMachine.get(machine) ?? 0) + elapsed
  frameTimeByMachine.set(machine, frameTime)
  return machine.step(width, height, frameTime)
}

function animationActive(machine: Machine, values: NumericArray) {
  return values[machine.output.animationActive]!
}

function assertClose(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`)
}

function settleFrames(machine: Machine, width = viewportWidth, height = viewportHeight) {
  for (let frames = 1; frames <= 240; frames++) {
    const values = step(machine, width, height)
    if (animationActive(machine, values) === 0) return {values, frames}
  }
  assert.fail('spring animation did not settle')
}

function settle(machine: Machine, width = viewportWidth, height = viewportHeight) {
  return settleFrames(machine, width, height).values
}

function projectWindows(machine: Machine, values: NumericArray) {
  return Array.from({length: windowCount}, (_, windowIndex) => {
    const start = windowIndex * windowOutputField.size
    const output = machine.output.windows
    return {
      left: values[output[start + windowOutputField.translateX]!]!,
      top: values[output[start + windowOutputField.translateY]!]!,
      width: values[output[start + windowOutputField.width]!]!,
      height: values[output[start + windowOutputField.height]!]!,
      scale: values[output[start + windowOutputField.scale]!]!,
      opacity: values[output[start + windowOutputField.opacity]!]!,
      focused: values[output[start + windowOutputField.focused]!]!,
      stack: values[output[start + windowOutputField.stack]!]!,
      maximized: values[output[start + windowOutputField.maximized]!]!,
    }
  })
}

function projectDock(machine: Machine, values: NumericArray) {
  return Array.from({length: windowCount}, (_, windowIndex) => {
    const start = windowIndex * dockOutputField.size
    const output = machine.output.dockItems
    return {
      left: values[output[start + dockOutputField.left]!]!,
      top: values[output[start + dockOutputField.top]!]!,
      width: values[output[start + dockOutputField.width]!]!,
      height: values[output[start + dockOutputField.height]!]!,
      inactive: values[output[start + dockOutputField.inactive]!]!,
      focused: values[output[start + dockOutputField.focused]!]!,
      open: values[output[start + dockOutputField.open]!]!,
    }
  })
}

function assertCenteredOnDock(
  window: ReturnType<typeof projectWindows>[number],
  dock: ReturnType<typeof projectDock>[number],
) {
  assert.ok(Math.abs(
    window.left + window.width / 2 - (dock.left + dock.width / 2),
  ) < 1e-9)
  assert.ok(Math.abs(
    window.top + window.height / 2 - (dock.top + dock.height / 2),
  ) < 1e-9)
}

function click(machine: Machine, x: number, y: number) {
  machine.pointerDown(x, y)
  machine.pointerUp(x, y)
  return step(machine)
}

function clickWindowControl(
  machine: Machine,
  values: NumericArray,
  windowIndex: number,
  control: 'minimize' | 'maximize' | 'close',
) {
  const point = windowControlPoint(machine, values, windowIndex, control)
  return click(machine, point.x, point.y)
}

function windowControlPoint(
  machine: Machine,
  values: NumericArray,
  windowIndex: number,
  control: 'minimize' | 'maximize' | 'close',
) {
  const projected = projectWindows(machine, values)[windowIndex]!
  const size = machine.source[sourceField.buttonSize]!
  const gap = machine.source[sourceField.buttonGap]!
  const closeX = projected.left + projected.width - gap - size / 2
  const maximizeX = closeX - gap - size
  const minimizeX = maximizeX - gap - size
  const x = control === 'close'
    ? closeX
    : control === 'maximize'
      ? maximizeX
      : minimizeX
  return {
    x,
    y: projected.top + machine.source[sourceField.titleHeight]! / 2,
  }
}

function clickDock(machine: Machine, values: NumericArray, windowIndex: number) {
  const dock = projectDock(machine, values)[windowIndex]!
  return click(machine, dock.left + dock.width / 2, dock.top + dock.height / 2)
}

function assertFocused(windows: ReturnType<typeof projectWindows>, windowIndex: number) {
  assert.deepEqual(
    windows.map(window => window.focused),
    Array.from({length: windowCount}, (_, index) => Number(index === windowIndex)),
  )
}

function assertBit(value: number, label: string) {
  assert.ok(value === 0 || value === 1, `${label} must be exactly zero or one, got ${value}`)
}

function assertWindowManagerInvariants(
  machine: Machine,
  values: NumericArray,
  width: number,
  height: number,
) {
  const windows = projectWindows(machine, values)
  const docks = projectDock(machine, values)
  let visibleCount = 0
  let focusMass = 0
  let dragMass = 0
  let resizeMass = 0

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const open = machine.source[windowSourceField(windowIndex, windowStateField.open)]!
    const minimized = machine.source[windowSourceField(windowIndex, windowStateField.minimized)]!
    const maximized = machine.source[windowSourceField(windowIndex, windowStateField.maximized)]!
    assertBit(open, `window ${windowIndex} open`)
    assertBit(minimized, `window ${windowIndex} minimized`)
    assertBit(maximized, `window ${windowIndex} maximized`)
    visibleCount += open * (1 - minimized)

    const drag = machine.source[dragSourceField(windowIndex)]!
    const resize = machine.source[resizeSourceField(windowIndex)]!
    assertBit(drag, `window ${windowIndex} drag owner`)
    assertBit(resize, `window ${windowIndex} resize owner`)
    dragMass += drag
    resizeMass += resize

    assertBit(windows[windowIndex]!.focused, `window ${windowIndex} focus`)
    assertBit(windows[windowIndex]!.maximized, `window ${windowIndex} projected maximized`)
    assertBit(docks[windowIndex]!.inactive, `dock ${windowIndex} inactive`)
    assertBit(docks[windowIndex]!.focused, `dock ${windowIndex} focus`)
    assertBit(docks[windowIndex]!.open, `dock ${windowIndex} open`)
    focusMass += windows[windowIndex]!.focused

    for (const value of [
      windows[windowIndex]!.left,
      windows[windowIndex]!.top,
      windows[windowIndex]!.width,
      windows[windowIndex]!.height,
      windows[windowIndex]!.scale,
    ]) {
      assert.ok(Number.isFinite(value), `window ${windowIndex} geometry must remain finite`)
    }
    assert.ok(windows[windowIndex]!.width >= 0 && windows[windowIndex]!.width <= width)
    assert.ok(windows[windowIndex]!.height >= 0 && windows[windowIndex]!.height <= height)
  }

  assert.ok(dragMass <= 1, `drag ownership mass must not exceed one, got ${dragMass}`)
  assert.ok(resizeMass <= 1, `resize ownership mass must not exceed one, got ${resizeMass}`)
  assert.equal(focusMass, visibleCount === 0 ? 0 : 1)

  for (let rank = 0; rank < windowCount; rank++) {
    let rankMass = 0
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const cell = machine.source[stackSourceField(rank, windowIndex)]!
      assertBit(cell, `stack rank ${rank}, window ${windowIndex}`)
      rankMass += cell
    }
    assert.equal(rankMass, 1)
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    let windowMass = 0
    for (let rank = 0; rank < windowCount; rank++) {
      windowMass += machine.source[stackSourceField(rank, windowIndex)]!
    }
    assert.equal(windowMass, 1)
  }
}

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

type RandomAction = {
  width: number
  height: number
  events: readonly {
    kind: 'down' | 'move' | 'up'
    x: number
    y: number
  }[]
}

function createRandomAction(
  machine: Machine,
  values: NumericArray,
  width: number,
  height: number,
  random: () => number,
): RandomAction {
  const windows = projectWindows(machine, values)
  const docks = projectDock(machine, values)
  const windowIndex = Math.floor(random() * windowCount)
  const window = windows[windowIndex]!
  const dock = docks[windowIndex]!
  const choice = Math.floor(random() * 9)

  if (choice === 0) {
    return {
      width: Math.floor(random() * 1_500),
      height: Math.floor(random() * 1_000),
      events: [],
    }
  }
  if (choice === 1) {
    return {
      width,
      height,
      events: [
        {kind: 'down', x: random() * width, y: random() * height},
        {kind: 'up', x: random() * width, y: random() * height},
      ],
    }
  }
  if (choice >= 2 && choice <= 4) {
    const controls = ['maximize', 'minimize', 'close'] as const
    const point = windowControlPoint(machine, values, windowIndex, controls[choice - 2]!)
    return {
      width,
      height,
      events: [
        {kind: 'down', ...point},
        {kind: 'up', ...point},
      ],
    }
  }
  if (choice === 5) {
    const point = {
      x: dock.left + dock.width / 2,
      y: dock.top + dock.height / 2,
    }
    return {
      width,
      height,
      events: [
        {kind: 'down', ...point},
        {kind: 'up', ...point},
      ],
    }
  }

  const grip = machine.source[sourceField.resizeGrip]!
  const start = choice === 6
    ? {
        x: window.left + Math.min(40, window.width / 4),
        y: window.top
          + Math.min(machine.source[sourceField.titleHeight]! / 2, window.height / 4),
      }
    : {
        x: window.left + window.width - Math.min(grip / 2, window.width / 4),
        y: window.top + window.height - Math.min(grip / 2, window.height / 4),
      }
  const end = {
    x: start.x + (random() - 0.5) * width,
    y: start.y + (random() - 0.5) * height,
  }
  return {
    width,
    height,
    events: [
      {kind: 'down', ...start},
      {kind: 'move', ...end},
      {kind: 'up', ...end},
    ],
  }
}

function applyRandomAction(machine: Machine, action: RandomAction) {
  for (const event of action.events) {
    if (event.kind === 'down') machine.pointerDown(event.x, event.y)
    else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
    else machine.pointerUp(event.x, event.y)
  }
}

function discreteState(machine: Machine, values: NumericArray) {
  const state: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [
      windowStateField.open,
      windowStateField.minimized,
      windowStateField.maximized,
    ]) {
      state.push(machine.source[windowSourceField(windowIndex, field)]!)
    }
    state.push(
      machine.source[dragSourceField(windowIndex)]!,
      machine.source[resizeSourceField(windowIndex)]!,
      projectWindows(machine, values)[windowIndex]!.focused,
    )
  }
  for (let rank = 0; rank < windowCount; rank++) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      state.push(machine.source[stackSourceField(rank, windowIndex)]!)
    }
  }
  return state
}

function maximumProductDifference(
  leftMachine: Machine,
  leftValues: NumericArray,
  rightMachine: Machine,
  rightValues: NumericArray,
) {
  const leftWindows = projectWindows(leftMachine, leftValues)
  const rightWindows = projectWindows(rightMachine, rightValues)
  const leftDock = projectDock(leftMachine, leftValues)
  const rightDock = projectDock(rightMachine, rightValues)
  const pairs: {label: string, left: number, right: number}[] = []
  const windowFields = [
    'left',
    'top',
    'width',
    'height',
    'scale',
    'opacity',
  ] as const
  const dockFields = ['left', 'top', 'width', 'height'] as const
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of windowFields) {
      pairs.push({
        label: `window ${windowIndex} ${field}`,
        left: leftWindows[windowIndex]![field],
        right: rightWindows[windowIndex]![field],
      })
    }
    for (const field of dockFields) {
      pairs.push({
        label: `dock ${windowIndex} ${field}`,
        left: leftDock[windowIndex]![field],
        right: rightDock[windowIndex]![field],
      })
    }
  }
  return pairs.reduce(
    (maximum, pair) => {
      const absolute = Math.abs(pair.left - pair.right)
      if (absolute <= maximum.absolute) return maximum
      return {
        absolute,
        relative: absolute / Math.max(1, Math.abs(pair.left), Math.abs(pair.right)),
        label: pair.label,
      }
    },
    {absolute: 0, relative: 0, label: ''},
  )
}

test('the fixed table projects four bounded windows and one focused front window', () => {
  const machine = createWindowManagerMachine()
  const values = step(machine)
  const windows = projectWindows(machine, values)

  assert.ok(machine.source instanceof Float32Array)
  assert.ok(values instanceof Float32Array)
  assert.equal(machine.source.length, sourceField.size)
  assert.deepEqual(windows.map(window => window.stack), [1, 2, 3, 4])
  assert.deepEqual(windows.map(window => window.opacity), [1, 1, 1, 1])
  assertFocused(windows, 3)
  assert.deepEqual(windows[0], {
    left: 54,
    top: 54,
    width: 520,
    height: 340,
    scale: 1,
    opacity: 1,
    focused: 0,
    stack: 1,
    maximized: 0,
  })
  for (let rank = 0; rank < windowCount; rank++) {
    assert.equal(machine.source[stackSourceField(rank, rank)], 1)
  }
})

test('pointer selection raises a window and topmost overlap remains deterministic', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)

  values = click(machine, 100, 80)
  let windows = projectWindows(machine, values)
  assertFocused(windows, 0)
  assert.deepEqual(windows.map(window => window.stack), [4, 1, 2, 3])

  values = click(machine, 500, 200)
  windows = projectWindows(machine, values)
  assertFocused(windows, 0)
  assert.deepEqual(windows.map(window => window.stack), [4, 1, 2, 3])
})

test('title dragging updates numeric geometry and clamps the whole window to the workspace', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const initial = projectWindows(machine, values)[0]!
  const downX = initial.left + 46
  const downY = initial.top + 22

  machine.pointerDown(downX, downY)
  values = step(machine)
  assert.equal(machine.source[dragSourceField(0)], 1)

  machine.pointerMove(downX + 100, downY + 70)
  values = step(machine)
  let moved = projectWindows(machine, values)[0]!
  assert.equal(moved.left, initial.left + 100)
  assert.equal(moved.top, initial.top + 70)
  assert.equal(
    machine.source[windowSourceField(0, windowStateField.left)],
    initial.left + 100,
  )
  assert.equal(
    machine.source[windowSourceField(0, windowStateField.top)],
    initial.top + 70,
  )
  assert.equal(animationActive(machine, values), 0)
  assert.deepEqual(moved, {
    ...initial,
    left: initial.left + 100,
    top: initial.top + 70,
    focused: 1,
    stack: 4,
  })

  machine.pointerMove(-500, -500)
  values = step(machine)
  assert.equal(projectWindows(machine, values)[0]!.left, 0)
  assert.equal(
    projectWindows(machine, values)[0]!.top,
    machine.source[sourceField.systemBarHeight],
  )

  machine.pointerMove(2000, 2000)
  values = step(machine)
  const bounded = projectWindows(machine, values)[0]!
  assert.equal(bounded.left + bounded.width, viewportWidth)
  assert.equal(
    bounded.top + bounded.height,
    viewportHeight - machine.source[sourceField.dockHeight]!,
  )

  machine.pointerUp(2000, 2000)
  values = step(machine)
  assert.equal(machine.source[dragSourceField(0)], 0)
  assert.equal(projectWindows(machine, values)[0]!.stack, 4)
})

test('resize grip changes both dimensions and enforces numeric minimums', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const initial = projectWindows(machine, values)[2]!
  const grip = machine.source[sourceField.resizeGrip]!
  const downX = initial.left + initial.width - grip / 2
  const downY = initial.top + initial.height - grip / 2

  machine.pointerDown(downX, downY)
  values = step(machine)
  assert.equal(machine.source[resizeSourceField(2)], 1)

  machine.pointerMove(downX + 120, downY + 80)
  values = step(machine)
  let resized = projectWindows(machine, values)[2]!
  assert.equal(resized.width, initial.width + 120)
  assert.equal(resized.height, initial.height + 80)
  assert.equal(animationActive(machine, values), 0)

  machine.pointerMove(downX - 1000, downY - 1000)
  values = step(machine)
  resized = projectWindows(machine, values)[2]!
  assertClose(resized.width, machine.source[sourceField.minWidth]!)
  assertClose(resized.height, machine.source[sourceField.minHeight]!)

  machine.pointerUp(downX - 1000, downY - 1000)
  step(machine)
  assert.equal(machine.source[resizeSourceField(2)], 0)
})

test('a down and move received before one refresh still begin the correct drag', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const initial = projectWindows(machine, values)[1]!
  const downX = initial.left + 36
  const downY = initial.top + 20

  machine.pointerDown(downX, downY)
  machine.pointerMove(downX + 30, downY + 25)
  values = step(machine)
  const moved = projectWindows(machine, values)[1]!

  assert.equal(moved.left, initial.left + 30)
  assert.equal(moved.top, initial.top + 25)
  assert.equal(
    machine.source[windowSourceField(1, windowStateField.left)],
    initial.left + 30,
  )
  assert.equal(
    machine.source[windowSourceField(1, windowStateField.top)],
    initial.top + 25,
  )
  assert.equal(machine.source[dragSourceField(1)], 1)
})

test('window control visual edges produce full-strength actions', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const projected = projectWindows(machine, values)[3]!
  const size = machine.source[sourceField.buttonSize]!
  const gap = machine.source[sourceField.buttonGap]!
  const closeLeft = projected.left + projected.width - gap - size
  const maximizeLeft = closeLeft - gap - size
  const y = projected.top + machine.source[sourceField.titleHeight]! / 2

  values = click(machine, maximizeLeft + 0.5, y)
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.maximized)],
    1,
  )
  values = settle(machine)
  const maximized = projectWindows(machine, values)[3]!
  assert.deepEqual(
    {left: maximized.left, top: maximized.top, width: maximized.width, height: maximized.height},
    {left: 12, top: 48, width: 1256, height: 664},
  )
})

test('a click between minimize and maximize becomes one complete decision', () => {
  const machine = createWindowManagerMachine()
  const values = step(machine)
  const projected = projectWindows(machine, values)[3]!
  const size = machine.source[sourceField.buttonSize]!
  const gap = machine.source[sourceField.buttonGap]!
  const closeLeft = projected.left + projected.width - gap - size
  const maximizeLeft = closeLeft - gap - size
  const expandedMaximizeLeft = maximizeLeft - gap / 2

  click(
    machine,
    expandedMaximizeLeft + 0.5031247387902,
    projected.top + machine.source[sourceField.titleHeight]! / 2,
  )

  assert.equal(
    machine.source[windowSourceField(3, windowStateField.maximized)],
    1,
  )
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.minimized)],
    0,
  )
})

test('maximize, minimize, close, and dock restore all update the same table', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)

  values = clickWindowControl(machine, values, 3, 'maximize')
  let window = projectWindows(machine, values)[3]!
  assert.equal(window.maximized, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.notEqual(window.left, 12)
  values = settle(machine)
  window = projectWindows(machine, values)[3]!
  assert.deepEqual(
    {
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
      maximized: window.maximized,
    },
    {
      left: 12,
      top: 48,
      width: 1256,
      height: 664,
      maximized: 1,
    },
  )

  values = clickWindowControl(machine, values, 3, 'minimize')
  window = projectWindows(machine, values)[3]!
  const dock = projectDock(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.ok(window.stack > 30)
  assert.equal(window.width, 1256)
  assert.equal(window.height, 664)
  assert.ok(window.scale > 0 && window.scale < 1)
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.minimized)],
    1,
  )
  assert.equal(dock.inactive, 1)

  values = settle(machine)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 0)
  assert.equal(window.stack, 4)
  assert.equal(window.width, 1256)
  assert.equal(window.height, 664)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)

  values = clickDock(machine, values, 3)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.ok(window.stack > 30)
  assert.equal(window.width, 1256)
  assert.ok(window.scale > 0 && window.scale < 1)
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.minimized)],
    0,
  )
  assert.equal(window.maximized, 1)
  assertFocused(projectWindows(machine, values), 3)
  values = settle(machine)
  window = projectWindows(machine, values)[3]!
  assert.deepEqual(
    {left: window.left, top: window.top, width: window.width, height: window.height},
    {left: 12, top: 48, width: 1256, height: 664},
  )
  assert.equal(window.scale, 1)
  assert.equal(window.stack, 4)

  values = clickWindowControl(machine, values, 3, 'maximize')
  values = settle(machine)
  values = clickWindowControl(machine, values, 3, 'close')
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.open)], 0)
  assert.equal(window.maximized, 0)
  values = settle(machine)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 0)
  assert.equal(window.width, 430)
  assert.equal(window.height, 310)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)

  values = clickDock(machine, values, 3)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.open)], 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.minimized)], 0)
  assertFocused(projectWindows(machine, values), 3)
  values = settle(machine)
  window = projectWindows(machine, values)[3]!
  assert.deepEqual(
    {left: window.left, top: window.top, width: window.width, height: window.height},
    {left: 744, top: 270, width: 430, height: 310},
  )
  assert.equal(window.scale, 1)
})

test('dock transitions settle within the faster spring budget', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = clickWindowControl(machine, values, 3, 'minimize')

  const settled = settleFrames(machine)
  assert.ok((settled.frames + 1) * frameDuration <= 600)
  assert.equal(projectWindows(machine, settled.values)[3]!.scale, 0)
})

test('all geometry remains finite and bounded down to a zero-sized viewport', () => {
  const viewportCases: readonly (readonly [width: number, height: number])[] = [
    [160, 140],
    [40, 40],
    [0, 0],
  ]
  for (const [width, height] of viewportCases) {
    const machine = createWindowManagerMachine()
    const values = step(machine, width, height)
    for (const window of projectWindows(machine, values)) {
      assert.ok(Number.isFinite(window.left))
      assert.ok(Number.isFinite(window.top))
      assert.ok(window.left >= 0)
      assert.ok(window.top >= 0)
      assert.ok(window.width >= 0 && window.width <= width)
      assert.ok(window.height >= 0 && window.height <= height)
    }
    for (const dock of projectDock(machine, values)) {
      assert.ok(Number.isFinite(dock.left))
      assert.ok(Number.isFinite(dock.top))
      assert.ok(dock.left >= 0)
      assert.ok(dock.top >= 0)
      assert.ok(dock.width >= 0 && dock.width <= width)
      assert.ok(dock.height >= 0 && dock.height <= height)
    }
  }
})

test('a hidden window tracks a resized dock without becoming visible', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = clickWindowControl(machine, values, 3, 'minimize')
  values = settle(machine)
  assert.equal(projectWindows(machine, values)[3]!.opacity, 0)

  values = step(machine, 900, 600)
  const window = projectWindows(machine, values)[3]!
  const dock = projectDock(machine, values)[3]!
  assert.equal(window.opacity, 0)
  assert.equal(machine.source[windowSourceField(3, windowStateField.present)], 0)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)
})

test('long mixed event sequences preserve Boolean state and stacking', () => {
  const machine = createWindowManagerMachine()
  const random = createRandom(0x51a7e)
  let width = viewportWidth
  let height = viewportHeight
  let values = step(machine, width, height)

  for (let action = 0; action < 1_000; action++) {
    const nextAction = createRandomAction(machine, values, width, height, random)
    width = nextAction.width
    height = nextAction.height
    applyRandomAction(machine, nextAction)
    values = step(machine, width, height, 1 + random() * 40)
    assertWindowManagerInvariants(machine, values, width, height)
  }
})

test('FP32 and Float64 keep the same decisions through mixed event sequences', () => {
  const float64 = createWindowManagerMachine({precision: 'float64'})
  const float32 = createWindowManagerMachine()
  const random = createRandom(0xf32)
  let width = viewportWidth
  let height = viewportHeight
  let float64Values = step(float64, width, height)
  let float32Values = step(float32, width, height)
  assert.ok(float64.source instanceof Float64Array)
  assert.ok(float64Values instanceof Float64Array)
  assert.ok(float32.source instanceof Float32Array)
  assert.ok(float32Values instanceof Float32Array)
  let maximumDifference = {absolute: 0, relative: 0, label: ''}

  for (let action = 0; action < 1_000; action++) {
    const nextAction = createRandomAction(float64, float64Values, width, height, random)
    const elapsed = 1 + random() * 40
    width = nextAction.width
    height = nextAction.height
    applyRandomAction(float64, nextAction)
    applyRandomAction(float32, nextAction)
    float64Values = step(float64, width, height, elapsed)
    float32Values = step(float32, width, height, elapsed)

    assertWindowManagerInvariants(float32, float32Values, width, height)
    assert.deepEqual(
      discreteState(float32, float32Values),
      discreteState(float64, float64Values),
    )
    const difference = maximumProductDifference(
      float32,
      float32Values,
      float64,
      float64Values,
    )
    if (difference.absolute > maximumDifference.absolute) maximumDifference = difference
  }

  assert.ok(
    maximumDifference.absolute < 0.1 && maximumDifference.relative < 0.001,
    `FP32 ${maximumDifference.label} difference reached `
      + `${maximumDifference.absolute} (${maximumDifference.relative} relative)`,
  )
})

test('next state is a direct numeric view and runtime atoms remain fixed', () => {
  const machine = createWindowManagerMachine()
  machine.pointerDown(100, 80)
  const values = step(machine)
  const nextSource = machine.output.nextSource.map(wire => values[wire]!)

  assert.deepEqual(nextSource, [...machine.source])
  assert.equal(machine.output.nextSource.length, sourceField.size)
  assert.equal(machine.output.windows.length, windowCount * windowOutputField.size)
  assert.equal(machine.output.dockItems.length, windowCount * dockOutputField.size)
  assert.deepEqual(
    [...new Set(machine.circuit.operations.map(operation => operation.kind))].sort(),
    ['affine', 'boolean', 'reglu'],
  )
  assert.equal(machine.source[sourceField.downActive], 0)
  assert.equal(machine.source[windowSourceField(0, windowStateField.left)], 54)
})
