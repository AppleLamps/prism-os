import assert from 'node:assert/strict'
import {test} from 'bun:test'
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

type Machine = ReturnType<typeof createWindowManagerMachine>

function projectWindows(machine: Machine, values: Float64Array) {
  return Array.from({length: windowCount}, (_, windowIndex) => {
    const start = windowIndex * windowOutputField.size
    const output = machine.output.windows
    return {
      left: values[output[start + windowOutputField.left]!]!,
      top: values[output[start + windowOutputField.top]!]!,
      width: values[output[start + windowOutputField.width]!]!,
      height: values[output[start + windowOutputField.height]!]!,
      opacity: values[output[start + windowOutputField.opacity]!]!,
      focused: values[output[start + windowOutputField.focused]!]!,
      stack: values[output[start + windowOutputField.stack]!]!,
      maximized: values[output[start + windowOutputField.maximized]!]!,
    }
  })
}

function projectDock(machine: Machine, values: Float64Array) {
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

function click(machine: Machine, x: number, y: number) {
  machine.pointerDown(x, y)
  machine.pointerUp(x, y)
  return machine.step(viewportWidth, viewportHeight)
}

function clickWindowControl(
  machine: Machine,
  values: Float64Array,
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
  return click(
    machine,
    x,
    projected.top + machine.source[sourceField.titleHeight]! / 2,
  )
}

function clickDock(machine: Machine, values: Float64Array, windowIndex: number) {
  const dock = projectDock(machine, values)[windowIndex]!
  return click(machine, dock.left + dock.width / 2, dock.top + dock.height / 2)
}

function assertFocused(windows: ReturnType<typeof projectWindows>, windowIndex: number) {
  assert.deepEqual(
    windows.map(window => window.focused),
    Array.from({length: windowCount}, (_, index) => Number(index === windowIndex)),
  )
}

test('the fixed table projects four bounded windows and one focused front window', () => {
  const machine = createWindowManagerMachine()
  const values = machine.step(viewportWidth, viewportHeight)
  const windows = projectWindows(machine, values)

  assert.equal(machine.source.length, sourceField.size)
  assert.deepEqual(windows.map(window => window.stack), [1, 2, 3, 4])
  assert.deepEqual(windows.map(window => window.opacity), [1, 1, 1, 1])
  assertFocused(windows, 3)
  assert.deepEqual(windows[0], {
    left: 54,
    top: 54,
    width: 520,
    height: 340,
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
  let values = machine.step(viewportWidth, viewportHeight)

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
  let values = machine.step(viewportWidth, viewportHeight)
  const initial = projectWindows(machine, values)[0]!
  const downX = initial.left + 46
  const downY = initial.top + 22

  machine.pointerDown(downX, downY)
  values = machine.step(viewportWidth, viewportHeight)
  assert.equal(machine.source[dragSourceField(0)], 1)

  machine.pointerMove(downX + 100, downY + 70)
  values = machine.step(viewportWidth, viewportHeight)
  assert.deepEqual(projectWindows(machine, values)[0], {
    ...initial,
    left: initial.left + 100,
    top: initial.top + 70,
    focused: 1,
    stack: 4,
  })

  machine.pointerMove(-500, -500)
  values = machine.step(viewportWidth, viewportHeight)
  assert.equal(projectWindows(machine, values)[0]!.left, 0)
  assert.equal(
    projectWindows(machine, values)[0]!.top,
    machine.source[sourceField.systemBarHeight],
  )

  machine.pointerMove(2000, 2000)
  values = machine.step(viewportWidth, viewportHeight)
  const bounded = projectWindows(machine, values)[0]!
  assert.equal(bounded.left + bounded.width, viewportWidth)
  assert.equal(
    bounded.top + bounded.height,
    viewportHeight - machine.source[sourceField.dockHeight]!,
  )

  machine.pointerUp(2000, 2000)
  machine.step(viewportWidth, viewportHeight)
  assert.equal(machine.source[dragSourceField(0)], 0)
})

test('resize grip changes both dimensions and enforces numeric minimums', () => {
  const machine = createWindowManagerMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const initial = projectWindows(machine, values)[2]!
  const grip = machine.source[sourceField.resizeGrip]!
  const downX = initial.left + initial.width - grip / 2
  const downY = initial.top + initial.height - grip / 2

  machine.pointerDown(downX, downY)
  values = machine.step(viewportWidth, viewportHeight)
  assert.equal(machine.source[resizeSourceField(2)], 1)

  machine.pointerMove(downX + 120, downY + 80)
  values = machine.step(viewportWidth, viewportHeight)
  let resized = projectWindows(machine, values)[2]!
  assert.equal(resized.width, initial.width + 120)
  assert.equal(resized.height, initial.height + 80)

  machine.pointerMove(downX - 1000, downY - 1000)
  values = machine.step(viewportWidth, viewportHeight)
  resized = projectWindows(machine, values)[2]!
  assert.equal(resized.width, machine.source[sourceField.minWidth])
  assert.equal(resized.height, machine.source[sourceField.minHeight])

  machine.pointerUp(downX - 1000, downY - 1000)
  machine.step(viewportWidth, viewportHeight)
  assert.equal(machine.source[resizeSourceField(2)], 0)
})

test('a down and move received before one refresh still begin the correct drag', () => {
  const machine = createWindowManagerMachine()
  let values = machine.step(viewportWidth, viewportHeight)
  const initial = projectWindows(machine, values)[1]!
  const downX = initial.left + 36
  const downY = initial.top + 20

  machine.pointerDown(downX, downY)
  machine.pointerMove(downX + 30, downY + 25)
  values = machine.step(viewportWidth, viewportHeight)
  const moved = projectWindows(machine, values)[1]!

  assert.equal(moved.left, initial.left + 30)
  assert.equal(moved.top, initial.top + 25)
  assert.equal(machine.source[dragSourceField(1)], 1)
})

test('maximize, minimize, close, and dock restore all update the same table', () => {
  const machine = createWindowManagerMachine()
  let values = machine.step(viewportWidth, viewportHeight)

  values = clickWindowControl(machine, values, 3, 'maximize')
  let window = projectWindows(machine, values)[3]!
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
  assert.equal(window.opacity, 0)
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.minimized)],
    1,
  )
  assert.equal(projectDock(machine, values)[3]!.inactive, 1)

  values = clickDock(machine, values, 3)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(
    machine.source[windowSourceField(3, windowStateField.minimized)],
    0,
  )
  assert.equal(window.maximized, 1)
  assertFocused(projectWindows(machine, values), 3)

  values = clickWindowControl(machine, values, 3, 'maximize')
  values = clickWindowControl(machine, values, 3, 'close')
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 0)
  assert.equal(machine.source[windowSourceField(3, windowStateField.open)], 0)
  assert.equal(window.maximized, 0)

  values = clickDock(machine, values, 3)
  window = projectWindows(machine, values)[3]!
  assert.equal(window.opacity, 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.open)], 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.minimized)], 0)
  assertFocused(projectWindows(machine, values), 3)
})

test('all geometry remains finite and bounded down to a zero-sized viewport', () => {
  const viewportCases: readonly (readonly [width: number, height: number])[] = [
    [160, 140],
    [40, 40],
    [0, 0],
  ]
  for (const [width, height] of viewportCases) {
    const machine = createWindowManagerMachine()
    const values = machine.step(width, height)
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

test('next state is a direct numeric view and runtime atoms remain affine and ReGLU', () => {
  const machine = createWindowManagerMachine()
  machine.pointerDown(100, 80)
  const values = machine.step(viewportWidth, viewportHeight)
  const nextSource = machine.output.nextSource.map(wire => values[wire]!)

  assert.deepEqual(nextSource, [...machine.source])
  assert.equal(machine.output.nextSource.length, sourceField.size)
  assert.equal(machine.output.windows.length, windowCount * windowOutputField.size)
  assert.equal(machine.output.dockItems.length, windowCount * dockOutputField.size)
  assert.deepEqual(
    [...new Set(machine.circuit.operations.map(operation => operation.kind))].sort(),
    ['affine', 'reglu'],
  )
  assert.equal(machine.source[sourceField.downActive], 0)
  assert.equal(machine.source[windowSourceField(0, windowStateField.left)], 54)
})
