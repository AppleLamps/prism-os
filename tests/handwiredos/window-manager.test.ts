import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {type WriteBack, quantizeTimeMs} from '../../src/runtime/host-timing.ts'
import {validateGrids} from '../../src/runtime/numeric-ui-core.ts'
import {
  armedSourceField,
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  noteFocusChange,
  valueListSourceField,
  photoFocusSourceField,
  photoSourceField,
  photoThumbnailSpringSourceField,
  projectWindowElements,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'
import {itemCount as photoCount, photoField, thumbnailSpringField} from '../../src/handwiredos/photo-gallery.ts'

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

function animationActive(machine: Machine, values: Float32Array) {
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

function projectWindows(machine: Machine, values: Float32Array) {
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
      contentWidth: values[output[start + windowOutputField.contentWidth]!]!,
      contentHeight: values[output[start + windowOutputField.contentHeight]!]!,
      destinationWidth: values[output[start + windowOutputField.destinationWidth]!]!,
      destinationHeight: values[output[start + windowOutputField.destinationHeight]!]!,
    }
  })
}

function projectDock(machine: Machine, values: Float32Array) {
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

// 8 ms before the next frame of step(), so that frame steps springs for 8 ms after
// the press. A press at the frame's own time runs 0 steps in that frame, and the
// frame shows where the animation starts.
function pressTime(machine: Machine) {
  return (frameTimeByMachine.get(machine) ?? 0) + frameDuration - 8
}

function click(machine: Machine, x: number, y: number) {
  const timeStamp = pressTime(machine)
  machine.pointerDown(x, y, timeStamp)
  machine.pointerUp(x, y, timeStamp)
  return step(machine)
}

function clickWindowControl(
  machine: Machine,
  values: Float32Array,
  windowIndex: number,
  control: 'minimize' | 'maximize' | 'close',
) {
  const point = windowControlPoint(machine, values, windowIndex, control)
  return click(machine, point.x, point.y)
}

function windowControlPoint(
  machine: Machine,
  values: Float32Array,
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

function clickDock(machine: Machine, values: Float32Array, windowIndex: number) {
  const dock = projectDock(machine, values)[windowIndex]!
  return click(machine, dock.left + dock.width / 2, dock.top + dock.height / 2)
}

function assertFocused(windows: ReturnType<typeof projectWindows>, windowIndex: number) {
  assert.deepEqual(
    windows.map(window => window.focused),
    Array.from({length: windowCount}, (_, index) => Number(index === windowIndex)),
  )
}

const armedControls = ['close', 'minimize', 'maximize', 'dockItem'] as const

// The number of armed controls in a table: 1 while a press on a control is held,
// otherwise 0.
function armedMass(table: Float32Array) {
  let mass = table[armedSourceField('photosContent')]! + table[armedSourceField('valueList')]!
  for (let location = 0; location < 3; location++) mass += table[armedSourceField('valueListLocation', location)]!
  for (const control of armedControls) {
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) mass += table[armedSourceField(control, windowIndex)]!
  }
  return mass
}

// The frontmost open window that isn't minimized, or -1.
function focusedWindowOf(table: Float32Array) {
  for (let rank = windowCount - 1; rank >= 0; rank--) {
    const windowIndex = Array.from({length: windowCount}, (_, index) => index).find(index => table[stackSourceField(rank, index)] === 1)!
    if (table[windowSourceField(windowIndex, windowStateField.open)] === 1 && table[windowSourceField(windowIndex, windowStateField.minimized)] === 0) return windowIndex
  }
  return -1
}

function assertBit(value: number, label: string) {
  assert.ok(value === 0 || value === 1, `${label} must be exactly zero or one, got ${value}`)
}

function assertWindowManagerInvariants(
  machine: Machine,
  values: Float32Array,
  width: number,
  height: number,
) {
  const windows = projectWindows(machine, values)
  const docks = projectDock(machine, values)
  let visibleCount = 0
  let focusMass = 0

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    // The runtime validate* tolerates near-Boolean values; tighten to exact bits.
    const open = machine.source[windowSourceField(windowIndex, windowStateField.open)]!
    const minimized = machine.source[windowSourceField(windowIndex, windowStateField.minimized)]!
    const maximized = machine.source[windowSourceField(windowIndex, windowStateField.maximized)]!
    assertBit(open, `window ${windowIndex} open`)
    assertBit(minimized, `window ${windowIndex} minimized`)
    assertBit(maximized, `window ${windowIndex} maximized`)
    visibleCount += open * (1 - minimized)

    assertBit(machine.source[dragSourceField(windowIndex)]!, `window ${windowIndex} drag owner`)
    assertBit(machine.source[resizeSourceField(windowIndex)]!, `window ${windowIndex} resize owner`)
    for (const control of armedControls) {
      assertBit(machine.source[armedSourceField(control, windowIndex)]!, `window ${windowIndex} armed ${control}`)
    }

    assertBit(windows[windowIndex]!.focused, `window ${windowIndex} focus`)
    assertBit(windows[windowIndex]!.maximized, `window ${windowIndex} projected maximized`)
    assertBit(docks[windowIndex]!.inactive, `dock ${windowIndex} inactive`)
    assertBit(docks[windowIndex]!.focused, `dock ${windowIndex} focus`)
    assertBit(docks[windowIndex]!.open, `dock ${windowIndex} open`)
    focusMass += windows[windowIndex]!.focused

    for (let rank = 0; rank < windowCount; rank++) {
      assertBit(
        machine.source[stackSourceField(rank, windowIndex)]!,
        `stack rank ${rank}, window ${windowIndex}`,
      )
    }

    // The viewport-bounded geometry is a product fact the runtime does not check.
    assert.ok(windows[windowIndex]!.width >= 0 && windows[windowIndex]!.width <= width)
    assert.ok(windows[windowIndex]!.height >= 0 && windows[windowIndex]!.height <= height)
  }

  assert.equal(focusMass, visibleCount === 0 ? 0 : 1)
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
  values: Float32Array,
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

// Checks every declared and inferred grid on every evaluation's table, e.g. that
// stored window geometry stays on the 1/64 px grid, which the hit tests' integer
// bits rely on. The values come from the compiled program, which leaves the wires
// it removed at 0.
function checkGridsOnEveryEvaluation(machine: Machine) {
  const counts = {evaluations: 0}
  machine.observe({
    beforeEvaluate(table) {
      const values = machine.circuit.evaluateTensor(table)
      validateGrids(machine.circuit, values)
      counts.evaluations++
    },
  })
  return counts
}

function applyRandomAction(machine: Machine, action: RandomAction) {
  for (const event of action.events) {
    if (event.kind === 'down') machine.pointerDown(event.x, event.y)
    else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
    else machine.pointerUp(event.x, event.y)
  }
}

test('the fixed table projects three bounded windows and one focused front window', () => {
  const machine = createWindowManagerMachine()
  const values = step(machine)
  const windows = projectWindows(machine, values)

  assert.ok(machine.source instanceof Float32Array)
  assert.ok(values instanceof Float32Array)
  assert.equal(machine.source.length, sourceField.size)
  assert.deepEqual(windows.map(window => window.stack), [1, 2, 3])
  assert.deepEqual(windows.map(window => window.opacity), [1, 1, 1])
  assertFocused(windows, 2)
  assert.deepEqual(windows[0], {
    left: 54,
    top: 54,
    width: 540,
    height: 340,
    scale: 1,
    opacity: 1,
    focused: 0,
    stack: 1,
    maximized: 0,
    contentWidth: 538,
    contentHeight: 294,
    destinationWidth: 540,
    destinationHeight: 340,
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
  assert.deepEqual(windows.map(window => window.stack), [3, 1, 2])

  values = click(machine, 500, 200)
  windows = projectWindows(machine, values)
  assertFocused(windows, 0)
  assert.deepEqual(windows.map(window => window.stack), [3, 1, 2])
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
    stack: 3,
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
  assert.equal(projectWindows(machine, values)[0]!.stack, 3)
})

test('resize grip changes both dimensions and enforces numeric minimums', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  // Photos, the frontmost window, at 650,190 and 560×430: no window covers its grip,
  // and 60 px more of width still end inside the 1280 px viewport.
  const initial = projectWindows(machine, values)[2]!
  const grip = machine.source[sourceField.resizeGrip]!
  const downX = initial.left + initial.width - grip / 2
  const downY = initial.top + initial.height - grip / 2

  machine.pointerDown(downX, downY)
  values = step(machine)
  assert.equal(machine.source[resizeSourceField(2)], 1)

  machine.pointerMove(downX + 60, downY + 80)
  values = step(machine)
  let resized = projectWindows(machine, values)[2]!
  assert.equal(resized.left, initial.left)
  assert.equal(resized.width, initial.width + 60)
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

test('window control edges produce one complete maximize decision', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const projected = projectWindows(machine, values)[2]!
  const size = machine.source[sourceField.buttonSize]!
  const gap = machine.source[sourceField.buttonGap]!
  const closeLeft = projected.left + projected.width - gap - size
  const maximizeLeft = closeLeft - gap - size
  const y = projected.top + machine.source[sourceField.titleHeight]! / 2

  // Click the extended hit region of the maximize button: gap/2 past its visual
  // edge, toward the minimize button. This boundary point resolves to exactly
  // the maximize decision (maximize on, minimize never flipped on) and then
  // settles to the exact maximized rectangle. The visual-edge offset
  // (maximizeLeft + 0.5) is the easier interior of the same control.
  const expandedMaximizeLeft = maximizeLeft - gap / 2
  values = click(machine, expandedMaximizeLeft + 0.5031247387902, y)
  assert.equal(machine.source[windowSourceField(2, windowStateField.maximized)], 1)
  assert.equal(machine.source[windowSourceField(2, windowStateField.minimized)], 0)
  values = settle(machine)
  const maximized = projectWindows(machine, values)[2]!
  assert.deepEqual(
    {left: maximized.left, top: maximized.top, width: maximized.width, height: maximized.height},
    {left: 12, top: 48, width: 1256, height: 664},
  )
})

test('maximize, minimize, close, and dock restore all update the same table', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)

  values = clickWindowControl(machine, values, 2, 'maximize')
  let window = projectWindows(machine, values)[2]!
  assert.equal(window.maximized, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.notEqual(window.left, 12)
  values = settle(machine)
  window = projectWindows(machine, values)[2]!
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

  values = clickWindowControl(machine, values, 2, 'minimize')
  window = projectWindows(machine, values)[2]!
  const dock = projectDock(machine, values)[2]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.ok(window.stack > 30)
  assert.equal(window.width, 1256)
  assert.equal(window.height, 664)
  assert.ok(window.scale > 0 && window.scale < 1)
  assert.equal(
    machine.source[windowSourceField(2, windowStateField.minimized)],
    1,
  )
  assert.equal(dock.inactive, 1)

  values = settle(machine)
  window = projectWindows(machine, values)[2]!
  assert.equal(window.opacity, 0)
  assert.equal(window.stack, 3)
  assert.equal(window.width, 1256)
  assert.equal(window.height, 664)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)

  values = clickDock(machine, values, 2)
  window = projectWindows(machine, values)[2]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.ok(window.stack > 30)
  assert.equal(window.width, 1256)
  assert.ok(window.scale > 0 && window.scale < 1)
  assert.equal(
    machine.source[windowSourceField(2, windowStateField.minimized)],
    0,
  )
  assert.equal(window.maximized, 1)
  assertFocused(projectWindows(machine, values), 2)
  values = settle(machine)
  window = projectWindows(machine, values)[2]!
  assert.deepEqual(
    {left: window.left, top: window.top, width: window.width, height: window.height},
    {left: 12, top: 48, width: 1256, height: 664},
  )
  assert.equal(window.scale, 1)
  assert.equal(window.stack, 3)

  values = clickWindowControl(machine, values, 2, 'maximize')
  values = settle(machine)
  values = clickWindowControl(machine, values, 2, 'close')
  window = projectWindows(machine, values)[2]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[windowSourceField(2, windowStateField.open)], 0)
  assert.equal(window.maximized, 0)
  values = settle(machine)
  window = projectWindows(machine, values)[2]!
  assert.equal(window.opacity, 0)
  assert.equal(window.width, 560)
  assert.equal(window.height, 430)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)

  values = clickDock(machine, values, 2)
  window = projectWindows(machine, values)[2]!
  assert.equal(window.opacity, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[windowSourceField(2, windowStateField.open)], 1)
  assert.equal(machine.source[windowSourceField(2, windowStateField.minimized)], 0)
  assertFocused(projectWindows(machine, values), 2)
  values = settle(machine)
  window = projectWindows(machine, values)[2]!
  assert.deepEqual(
    {left: window.left, top: window.top, width: window.width, height: window.height},
    {left: 650, top: 190, width: 560, height: 430},
  )
  assert.equal(window.scale, 1)
})

test('dock transitions settle within the faster spring budget', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = clickWindowControl(machine, values, 2, 'minimize')

  const settled = settleFrames(machine)
  assert.ok((settled.frames + 1) * frameDuration <= 600)
  assert.equal(projectWindows(machine, settled.values)[2]!.scale, 0)
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
  values = clickWindowControl(machine, values, 2, 'minimize')
  values = settle(machine)
  assert.equal(projectWindows(machine, values)[2]!.opacity, 0)

  values = step(machine, 900, 600)
  const window = projectWindows(machine, values)[2]!
  const dock = projectDock(machine, values)[2]!
  assert.equal(window.opacity, 0)
  assert.equal(machine.source[windowSourceField(2, windowStateField.present)], 0)
  assert.equal(window.scale, 0)
  assertCenteredOnDock(window, dock)
})

test('long mixed event sequences preserve Boolean state, stacking and grids', () => {
  const machine = createWindowManagerMachine()
  const gridChecks = checkGridsOnEveryEvaluation(machine)
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
  assert.ok(gridChecks.evaluations > 2_000, `${gridChecks.evaluations} evaluations checked`)
}, 60_000)

test('a press hits a window when it is at least half a pixel inside, with pointer coordinates on a 1/64 px grid within ±32,768 px', () => {
  // Window 0 spans x from 54 to 594, and no other window covers (54.5, 224).
  // Window 2 starts in front.
  for (const {x, focused} of [
    {x: 54.5 - 1 / 64, focused: 2},
    {x: 54.5, focused: 0},
    // Rounds to 54.5.
    {x: 54.495, focused: 0},
  ]) {
    const machine = createWindowManagerMachine()
    step(machine)
    assertFocused(projectWindows(machine, click(machine, x, 224)), focused)
  }

  const machine = createWindowManagerMachine()
  step(machine)
  machine.pointerMove(-50_000, 100.001)
  step(machine)
  assert.deepEqual(
    [machine.source[sourceField.pointerX], machine.source[sourceField.pointerY]],
    [-32_768, 100],
  )
})

test('a viewport past the 16,384 px that the program declares is clamped, so the machine keeps running', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  // E.g. an 8K display at 25% browser zoom reports 30,720 CSS px. Unclamped, the
  // resize failed the table check, and every later step failed too.
  let values = step(machine, 30_720, 17_280)
  assert.deepEqual([machine.source[sourceField.viewportWidth], machine.source[sourceField.viewportHeight]], [16_384, 16_384])
  assertWindowManagerInvariants(machine, values, 16_384, 16_384)
  machine.resize(20_000.4, 500, eventTime(machine, 4))
  values = step(machine, 20_000.4, 500)
  assert.deepEqual([machine.source[sourceField.viewportWidth], machine.source[sourceField.viewportHeight]], [16_384, 500])
  values = settle(machine, 20_000.4, 500)
  assertWindowManagerInvariants(machine, values, 16_384, 500)
  // The windows were clamped into the 388 px between the system bar and the dock.
  assert.deepEqual(projectWindows(machine, values).map(window => window.top + window.height <= 424), [true, true, true])
  // A first step past the range mounts the clamped viewport.
  const mounted = createWindowManagerMachine()
  step(mounted, 1e9, 1e9)
  assert.deepEqual([mounted.source[sourceField.viewportWidth], mounted.source[sourceField.viewportHeight]], [16_384, 16_384])
})

test('the machine checks the table against its rules before an evaluation, and the next-state values after it', () => {
  // Values written before the first step commit with the mount, so the table check before the mount evaluation sees them.
  const writtenBeforeFirstStep = (write: (machine: Machine) => void) => () => {
    const machine = createWindowManagerMachine()
    write(machine)
    step(machine)
  }
  assert.throws(writtenBeforeFirstStep(machine => {
    machine.source[machine.cells.photos.previous] = 1
    machine.source[machine.cells.photos.next] = 1
  }), /photos events breaks its atMostOne rule with mass 2/)
  assert.throws(writtenBeforeFirstStep(machine => {
    machine.source[machine.cells.drag[0]!] = 1
    machine.source[machine.cells.drag[1]!] = 1
  }), /drag breaks its oneHot rule with mass 2/)
  assert.throws(writtenBeforeFirstStep(machine => {
    machine.source[machine.cells.stack[0]![0]!] = 0.5
  }), /stack\[0\]\[0\] must be exactly 0 or 1, got 0.5/)
  // Written after the table check, just before the frame's own evaluation, e.g. by an observer with a bug. No event
  // releases a drag, so both drag bits reach the next-state values. The frame's evaluation runs on a copy of the table,
  // so no later table check sees the bits, and the next-state check is what throws.
  const machine = createWindowManagerMachine()
  machine.observe({
    beforeEvaluate(table, evaluation) {
      if (evaluation.writesBack) return
      table[machine.cells.drag[0]!] = 1
      table[machine.cells.drag[1]!] = 1
    },
  })
  assert.throws(() => step(machine), /drag breaks its oneHot rule with mass 2/)
})

test('next state is a direct numeric view and runtime atoms remain fixed', () => {
  const machine = createWindowManagerMachine()
  machine.pointerDown(100, 80)
  step(machine)

  // nextSource being a direct wire view of the source is owned generically by
  // photo-gallery.test.ts and re-checked for this machine in the Photos test
  // below; here we pin the window-manager-specific output wiring and atoms.
  assert.equal(machine.output.windows.length, windowCount * windowOutputField.size)
  assert.equal(machine.output.dockItems.length, windowCount * dockOutputField.size)
  // The program reads no table by index: the Notes text layout, which did, left the
  // program on October 13, 2026.
  assert.deepEqual(
    [...new Set(machine.circuit.operations.map(operation => operation.kind))].sort(),
    ['affine', 'boolean', 'reglu'],
  )
  assert.equal(machine.source[sourceField.downActive], 0)
  assert.equal(machine.source[windowSourceField(0, windowStateField.left)], 54)
})

test('Photos state and behavior run inside the one window-manager program', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const firstPhotoStart = 0
  const firstPhoto = {
    left: values[machine.output.photos.photos[firstPhotoStart + photoField.left]!]!,
    top: values[machine.output.photos.photos[firstPhotoStart + photoField.top]!]!,
    width: values[machine.output.photos.photos[firstPhotoStart + photoField.width]!]!,
    height: values[machine.output.photos.photos[firstPhotoStart + photoField.height]!]!,
  }

  // A press and a release on the first photo, in viewport coordinates. Photos rests at
  // its destination, so its content box starts 1 px inside the frame and below the
  // title bar.
  const photosWindow = projectWindows(machine, values)[2]!
  const photoX = photosWindow.left + 1 + firstPhoto.left + firstPhoto.width / 2
  const photoY = photosWindow.top + machine.source[sourceField.titleHeight]! + 1 + firstPhoto.top + firstPhoto.height / 2
  machine.pointerDown(photoX, photoY)
  machine.pointerUp(photoX, photoY)
  values = step(machine)
  assert.equal(machine.source[photoFocusSourceField(0)], 1)
  assert.equal(machine.source[photoSourceField.clickActive], 0)

  // A frame evaluates a copy of the table, and its next state has stepped springs
  // since the last commit, so the direct wire view is checked on the evaluation
  // that applies the event and writes its next state back.
  let commits = 0
  machine.observe({
    afterEvaluate(evaluationValues, table, evaluation) {
      if (!evaluation.events.some(event => event.kind === 'photo next')) return
      assert.equal(evaluation.writesBack, true)
      commits++
      assert.deepEqual(
        machine.output.nextSource.map(wire => evaluationValues[wire]!),
        [...table],
      )
    },
  })
  machine.photoNext(pressTime(machine))
  values = step(machine)
  assert.equal(commits, 1)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[photoFocusSourceField(0)], 0)
  assert.equal(machine.source[photoFocusSourceField(1)], 1)
  assert.equal(
    Array.from({length: photoCount}, (_, item) =>
      machine.source[photoFocusSourceField(item)]!)
      .reduce((sum, focus) => sum + focus, 0),
    1,
  )
  assert.equal(machine.tensorProgram.sourceSize, machine.source.length)
  values = settle(machine)
  assert.equal(animationActive(machine, values), 0)
})

test('one click can focus Photos and select a photo in the same evaluation', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = click(machine, 450, 126)
  assertFocused(projectWindows(machine, values), 1)

  const item = 3
  const outputStart = item * photoField.size
  const localLeft =
    values[machine.output.photos.photos[outputStart + photoField.left]!]!
  const localTop =
    values[machine.output.photos.photos[outputStart + photoField.top]!]!
  const localX = localLeft
    + values[machine.output.photos.photos[outputStart + photoField.width]!]! / 2
  const localY = localTop
    + values[machine.output.photos.photos[outputStart + photoField.height]!]! / 2
  const photosWindow = projectWindows(machine, values)[2]!
  const globalX = photosWindow.left + 1 + localX
  const globalY =
    photosWindow.top + machine.source[sourceField.titleHeight]! + 1 + localY

  machine.pointerDown(globalX, globalY)
  machine.pointerUp(globalX, globalY)
  values = step(machine)

  assertFocused(projectWindows(machine, values), 2)
  assert.equal(machine.source[photoFocusSourceField(item)], 1)
})

type PressEvent = {kind: 'down' | 'move' | 'up' | 'cancel', x: number, y: number, timeStamp: number}

function sendPressEvent(machine: Machine, event: PressEvent) {
  if (event.kind === 'down') machine.pointerDown(event.x, event.y, event.timeStamp)
  else if (event.kind === 'move') machine.pointerMove(event.x, event.y, event.timeStamp)
  else if (event.kind === 'up') machine.pointerUp(event.x, event.y, event.timeStamp)
  else machine.pointerCancel(event.x, event.y, event.timeStamp)
}

// A time offsetMs after the last frame of step(), which runs 16 ms later, so events
// at distinct offsets each get their own evaluation.
function eventTime(machine: Machine, offsetMs = 1) {
  return (frameTimeByMachine.get(machine) ?? 0) + offsetMs
}

// The windows' open, minimized and maximized bits and the stacking cells.
function windowsAndStack(table: Float32Array) {
  return {
    windows: Array.from({length: windowCount}, (_, windowIndex) =>
      [windowStateField.open, windowStateField.minimized, windowStateField.maximized].map(field => table[windowSourceField(windowIndex, field)])),
    stack: Array.from({length: windowCount * windowCount}, (_, index) => table[sourceField.stackStart + index]),
  }
}

// The open photo, or -1 while Photos shows the grid.
function openPhotoOf(table: Float32Array) {
  return Array.from({length: photoCount}, (_, item) => table[photoFocusSourceField(item)]!).indexOf(1)
}

// A photo's center in viewport coordinates, while Photos rests at its destination.
function photoPoint(machine: Machine, values: Float32Array, item: number) {
  const photos = projectWindows(machine, values)[2]!
  const center = photoCenter(machine, values, item)
  return {x: photos.left + 1 + center.x, y: photos.top + machine.source[sourceField.titleHeight]! + 1 + center.y}
}

// Whether a viewport point lies at least half a pixel inside a photo's rectangle.
function pointOnPhoto(machine: Machine, values: Float32Array, item: number, point: {x: number, y: number}) {
  const photos = projectWindows(machine, values)[2]!
  const start = item * photoField.size
  const read = (field: number) => values[machine.output.photos.photos[start + field]!]!
  const left = photos.left + 1 + read(photoField.left)
  const top = photos.top + machine.source[sourceField.titleHeight]! + 1 + read(photoField.top)
  return point.x - left >= 0.5 && left + read(photoField.width) - point.x >= 0.5
    && point.y - top >= 0.5 && top + read(photoField.height) - point.y >= 0.5
}

// At 1280×800: Monitor (window 0) is 54,54 540×340, and its close and maximize buttons
// are centered at 575,76 and 547,76. A maximized window's close button is centered at
// 1249,70, and the dock items at 578,762, 640,762 and 702,762.
const monitorClose = {x: 575, y: 76}
const monitorMaximize = {x: 547, y: 76}
const maximizedClose = {x: 1249, y: 70}
const dockItemCenter = (windowIndex: number) => ({x: 578 + 62 * windowIndex, y: 762})

test('a window button acts at a release over the button that the press armed, even after the pointer moved off the button and back', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  const monitorOpen = () => machine.source[windowSourceField(0, windowStateField.open)]
  // The press arms Monitor's close button and acts on nothing yet.
  machine.pointerDown(monitorClose.x, monitorClose.y, eventTime(machine))
  step(machine)
  assert.equal(machine.source[armedSourceField('close', 0)], 1)
  assert.equal(monitorOpen(), 1)
  // The pointer moves off the button and back, 4 ms apart, and the release over the
  // button closes Monitor. In lab/ui-exploration/input, windows.test.ts's case "moving
  // outward past slop and back cancels the click, within one frame" expects no click
  // on this path, since the pointer moved more than 4 px away from the press.
  machine.pointerMove(monitorClose.x + 40, monitorClose.y + 30, eventTime(machine, 1))
  machine.pointerMove(monitorClose.x, monitorClose.y, eventTime(machine, 5))
  step(machine)
  assert.equal(monitorOpen(), 1)
  machine.pointerUp(monitorClose.x, monitorClose.y, eventTime(machine))
  step(machine)
  assert.equal(monitorOpen(), 0)
  assert.equal(armedMass(machine.source), 0)
})

test('a release off the pressed control, a release over another control, and a pointercancel act on nothing', () => {
  // A press on Monitor's button raises and focuses Monitor, and a press on a dock item
  // leaves Photos focused.
  const cases: {label: string, press: {x: number, y: number}, release: PressEvent[], focused: number}[] = [
    {label: 'a release off the button', press: monitorClose, focused: 0, release: [
      {kind: 'move', x: monitorClose.x, y: monitorClose.y + 30, timeStamp: 1},
      {kind: 'up', x: monitorClose.x, y: monitorClose.y + 30, timeStamp: 5},
    ]},
    {label: 'a release over another button', press: monitorClose, focused: 0, release: [{kind: 'up', ...monitorMaximize, timeStamp: 1}]},
    {label: 'a pointercancel over the button', press: monitorClose, focused: 0, release: [{kind: 'cancel', ...monitorClose, timeStamp: 1}]},
    {label: 'a release over another dock item', press: dockItemCenter(1), focused: 2, release: [{kind: 'up', ...dockItemCenter(2), timeStamp: 1}]},
  ]
  for (const {label, press, release, focused} of cases) {
    const machine = createWindowManagerMachine()
    step(machine)
    machine.pointerDown(press.x, press.y, eventTime(machine))
    step(machine)
    assert.equal(armedMass(machine.source), 1, label)
    const afterPress = windowsAndStack(machine.source)
    for (const event of release) sendPressEvent(machine, {...event, timeStamp: eventTime(machine, event.timeStamp)})
    const values = step(machine)
    assert.deepEqual(windowsAndStack(machine.source), afterPress, label)
    assert.equal(armedMass(machine.source), 0, label)
    assertFocused(projectWindows(machine, values), focused)
  }
})

test('a pointercancel ends a drag at its point, like a release', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  // Monitor's title bar at 100,76.
  machine.pointerDown(100, 76, eventTime(machine, 1))
  machine.pointerMove(150, 96, eventTime(machine, 5))
  machine.pointerCancel(160, 100, eventTime(machine, 9))
  step(machine)
  assert.equal(machine.source[dragSourceField(0)], 0)
  assert.deepEqual(
    [machine.source[windowSourceField(0, windowStateField.left)], machine.source[windowSourceField(0, windowStateField.top)]],
    [114, 78],
  )
})

test('a dock item raises and focuses its window at the release, and a key between the press and the release goes to the window focused before', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  // Open photo 5 while Photos (window 2) is focused, then focus Monitor with a press
  // and a release on its content.
  values = click(machine, photoPoint(machine, values, 5).x, photoPoint(machine, values, 5).y)
  assert.equal(openPhotoOf(machine.source), 5)
  values = click(machine, 314, 246)
  assertFocused(projectWindows(machine, values), 0)

  // A press on Photos' dock item that moves off and releases elsewhere changes neither
  // the focus nor the stack.
  const photosDockItem = dockItemCenter(2)
  const beforePress = windowsAndStack(machine.source)
  machine.pointerDown(photosDockItem.x, photosDockItem.y, eventTime(machine, 1))
  machine.pointerMove(photosDockItem.x, photosDockItem.y - 200, eventTime(machine, 5))
  machine.pointerUp(photosDockItem.x, photosDockItem.y - 200, eventTime(machine, 9))
  values = step(machine)
  assertFocused(projectWindows(machine, values), 0)
  assert.deepEqual(windowsAndStack(machine.source), beforePress)

  // A press alone doesn't focus Photos, so ArrowRight goes to Monitor and photo 5 stays open.
  machine.pointerDown(photosDockItem.x, photosDockItem.y, eventTime(machine, 1))
  machine.photoNext(eventTime(machine, 5))
  values = step(machine)
  assertFocused(projectWindows(machine, values), 0)
  assert.deepEqual(windowsAndStack(machine.source), beforePress)
  assert.equal(openPhotoOf(machine.source), 5)
  // The release over the dock item raises and focuses Photos, and ArrowRight now opens photo 6.
  machine.pointerUp(photosDockItem.x, photosDockItem.y, eventTime(machine))
  values = step(machine)
  assertFocused(projectWindows(machine, values), 2)
  assert.equal(machine.source[stackSourceField(windowCount - 1, 2)], 1)
  machine.photoNext(eventTime(machine))
  step(machine)
  assert.equal(openPhotoOf(machine.source), 6)
})

test('ArrowLeft, ArrowRight and Escape reach Photos only while Photos is the focused window', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = click(machine, photoPoint(machine, values, 5).x, photoPoint(machine, values, 5).y)
  // Monitor takes focus, and no key changes Photos' state.
  values = click(machine, 314, 246)
  assertFocused(projectWindows(machine, values), 0)
  const photosFocusCells = () => Array.from({length: photoCount}, (_, item) => machine.source[photoFocusSourceField(item)])
  const focusWithMonitorFocused = photosFocusCells()
  // ArrowRight, ArrowLeft and Escape.
  const keys = [
    (timeStamp: number) => machine.photoNext(timeStamp),
    (timeStamp: number) => machine.photoPrevious(timeStamp),
    (timeStamp: number) => machine.photoClose(timeStamp),
  ]
  for (const sendKey of keys) {
    sendKey(eventTime(machine))
    step(machine)
    assert.deepEqual(photosFocusCells(), focusWithMonitorFocused)
  }
  assert.equal(openPhotoOf(machine.source), 5)
  // A press and a release on Photos' title bar focus Photos, and the same keys change its state.
  values = click(machine, 900, 212)
  assertFocused(projectWindows(machine, values), 2)
  const openPhotos: number[] = []
  for (const sendKey of keys) {
    sendKey(eventTime(machine))
    step(machine)
    openPhotos.push(openPhotoOf(machine.source))
  }
  assert.deepEqual(openPhotos, [6, 5, -1])
  // A key and a release at one timestamp deliver the key in either order, and so do a
  // key and a release queued without timestamps, which both apply at the frame's time.
  // The press and the release are on the empty desktop, so they change nothing else.
  values = settle(machine)
  values = click(machine, photoPoint(machine, values, 5).x, photoPoint(machine, values, 5).y)
  assert.equal(openPhotoOf(machine.source), 5)
  const keyAndRelease = [
    () => {
      machine.photoNext(eventTime(machine, 5))
      machine.pointerUp(20, 700, eventTime(machine, 5))
    },
    () => {
      machine.pointerUp(20, 700, eventTime(machine, 5))
      machine.photoNext(eventTime(machine, 5))
    },
    () => {
      machine.photoNext()
      machine.pointerUp(20, 700)
    },
    () => {
      machine.pointerUp(20, 700)
      machine.photoNext()
    },
  ]
  const openAfterKeyAndRelease: number[] = []
  for (const sendKeyAndRelease of keyAndRelease) {
    machine.pointerDown(20, 700, eventTime(machine, 1))
    sendKeyAndRelease()
    values = step(machine)
    assertFocused(projectWindows(machine, values), 2)
    openAfterKeyAndRelease.push(openPhotoOf(machine.source))
  }
  assert.deepEqual(openAfterKeyAndRelease, [6, 7, 8, 9])
})

test("Photos takes a release over its content after a press there as a click, and not the release of a grip resize, a title bar drag, a press elsewhere, or a pointercancel", () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  // A press on photo 11, released 21 px inside Photos' bottom-right corner, where the
  // grip overlaps photo 11's cell: a release over the grip isn't over the content.
  const cornerPoint = {x: 650 + 560 - 21, y: 190 + 430 - 21}
  assert.ok(pointOnPhoto(machine, values, 11, cornerPoint))
  machine.pointerDown(photoPoint(machine, values, 11).x, photoPoint(machine, values, 11).y, eventTime(machine, 1))
  machine.pointerUp(cornerPoint.x, cornerPoint.y, eventTime(machine, 5))
  values = step(machine)
  assert.equal(openPhotoOf(machine.source), -1)
  // A grip press at that point resizes Photos to 470×370, and the release, again 21 px
  // inside the corner and over photo 11's cell, opens no photo.
  machine.pointerDown(cornerPoint.x, cornerPoint.y, eventTime(machine, 1))
  machine.pointerMove(cornerPoint.x - 90, cornerPoint.y - 60, eventTime(machine, 5))
  machine.pointerUp(cornerPoint.x - 90, cornerPoint.y - 60, eventTime(machine, 9))
  values = step(machine)
  assert.deepEqual([machine.source[windowSourceField(2, windowStateField.width)], machine.source[windowSourceField(2, windowStateField.height)]], [470, 370])
  assert.ok(pointOnPhoto(machine, values, 11, {x: cornerPoint.x - 90, y: cornerPoint.y - 60}))
  assert.equal(openPhotoOf(machine.source), -1)
  // A title bar drag that the workspace stops at the dock, released over photo 10,
  // opens no photo.
  machine.pointerDown(900, 212, eventTime(machine, 1))
  machine.pointerMove(900, 700, eventTime(machine, 5))
  machine.pointerUp(900, 700, eventTime(machine, 9))
  values = step(machine)
  assert.equal(machine.source[windowSourceField(2, windowStateField.top)], 724 - 370)
  assert.ok(pointOnPhoto(machine, values, 10, {x: 900, y: 700}))
  assert.equal(openPhotoOf(machine.source), -1)
  // A press on Monitor's content, released over photo 5, opens no photo.
  const photo5 = photoPoint(machine, values, 5)
  machine.pointerDown(314, 246, eventTime(machine, 1))
  machine.pointerUp(photo5.x, photo5.y, eventTime(machine, 5))
  values = step(machine)
  assert.equal(openPhotoOf(machine.source), -1)
  // A press on photo 5 and a pointercancel over it open no photo, and a press and a
  // release on photo 5 open it.
  machine.pointerDown(photo5.x, photo5.y, eventTime(machine, 1))
  machine.pointerCancel(photo5.x, photo5.y, eventTime(machine, 5))
  step(machine)
  assert.equal(openPhotoOf(machine.source), -1)
  machine.pointerDown(photo5.x, photo5.y, eventTime(machine, 1))
  machine.pointerUp(photo5.x, photo5.y, eventTime(machine, 5))
  step(machine)
  assert.equal(openPhotoOf(machine.source), 5)

  // On a new machine, a grip press that resizes Photos past its minimum size, to
  // 280×190, and releases over photo 4, away from the new grip. The grip press armed
  // nothing, so the release opens no photo.
  const resized = createWindowManagerMachine()
  step(resized)
  resized.pointerDown(cornerPoint.x, cornerPoint.y, eventTime(resized, 1))
  resized.pointerMove(700, 300, eventTime(resized, 5))
  step(resized)
  assert.equal(resized.source[armedSourceField('photosContent')], 0)
  resized.pointerUp(700, 300, eventTime(resized, 1))
  values = step(resized)
  assert.deepEqual(
    [windowStateField.left, windowStateField.top, windowStateField.width, windowStateField.height].map(field => resized.source[windowSourceField(2, field)]),
    [650, 190, 280, 190],
  )
  assert.ok(pointOnPhoto(resized, values, 4, {x: 700, y: 300}))
  assert.equal(openPhotoOf(resized.source), -1)
  // A maximized Photos has no grip, so a press and a release on photo 11 inside the
  // window's bottom-right 24 px open photo 11. The maximized window is 12,48 1256×664,
  // so those 24 px span 1244..1268 × 688..712.
  clickWindowControl(resized, values, 2, 'maximize')
  values = settle(resized)
  assert.equal(projectWindows(resized, values)[2]!.maximized, 1)
  const maximizedCorner = {x: 1245, y: 689}
  assert.ok(pointOnPhoto(resized, values, 11, maximizedCorner))
  click(resized, maximizedCorner.x, maximizedCorner.y)
  assert.equal(openPhotoOf(resized.source), 11)
})

test('presses within one frame at distinct timestamps each see what the earlier ones did', () => {
  const machine = createWindowManagerMachine()
  step(machine)
  // Maximize Monitor, then press and release its close button at the maximized
  // position, all within one 16 ms frame.
  machine.pointerDown(monitorMaximize.x, monitorMaximize.y, eventTime(machine, 1))
  machine.pointerUp(monitorMaximize.x, monitorMaximize.y, eventTime(machine, 4))
  machine.pointerDown(maximizedClose.x, maximizedClose.y, eventTime(machine, 8))
  machine.pointerUp(maximizedClose.x, maximizedClose.y, eventTime(machine, 12))
  step(machine)
  assert.deepEqual(
    machine.evaluations.filter(evaluation => evaluation.kind === 'events').map(evaluation => evaluation.events),
    [['pointer down'], ['pointer up'], ['pointer down'], ['pointer up']],
  )
  assert.deepEqual(windowsAndStack(machine.source).windows[0], [0, 0, 0])
})

test('during a window animation, presses and releases hit-test where the windows are going', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  values = clickWindowControl(machine, values, 0, 'maximize')
  // The next frame still draws Monitor far from its maximized rectangle, and a press
  // and a release at the maximized close button close Monitor.
  values = step(machine)
  const drawn = projectWindows(machine, values)[0]!
  assert.equal(animationActive(machine, values), 1)
  assert.ok(drawn.left + drawn.width < maximizedClose.x - 14, `drawn right edge ${drawn.left + drawn.width}`)
  machine.pointerDown(maximizedClose.x, maximizedClose.y, eventTime(machine, 1))
  values = step(machine)
  assert.equal(machine.source[armedSourceField('close', 0)], 1)
  machine.pointerUp(maximizedClose.x, maximizedClose.y, eventTime(machine, 1))
  values = step(machine)
  assert.equal(machine.source[windowSourceField(0, windowStateField.open)], 0)
  // While Monitor flies to its dock item, a press on the dock item acts on nothing, and
  // the release restores and focuses Monitor.
  const monitorDockItem = dockItemCenter(0)
  machine.pointerDown(monitorDockItem.x, monitorDockItem.y, eventTime(machine, 1))
  values = step(machine)
  assert.equal(animationActive(machine, values), 1)
  assert.equal(machine.source[windowSourceField(0, windowStateField.open)], 0)
  machine.pointerUp(monitorDockItem.x, monitorDockItem.y, eventTime(machine, 1))
  values = step(machine)
  assert.equal(machine.source[windowSourceField(0, windowStateField.open)], 1)
  assertFocused(projectWindows(machine, values), 0)
})

// The press rule in plain JavaScript, over each window's open, minimized and
// maximized bits, the stacking order, the armed control and the row selected in
// Monitor's list. It covers traces with no drags or resizes in a 1280×800 viewport,
// so every rectangle comes from constants: the initial rectangles, and 12,48 1256×664
// for a maximized window. The list stays at scroll position 0, and valueListRowCounts
// holds each sidebar location's number of rows. Events that share a 1/64 ms timestamp
// apply together, in the order that the program handles them within one evaluation:
// the last down, then the last up or cancel, where a cancel among them acts on
// nothing.
function createPressReference(valueListRowCounts: readonly number[]) {
  type Point = {x: number, y: number}
  type Rectangle = {left: number, top: number, width: number, height: number}
  const normalRectangles: Rectangle[] = [[54, 54, 540, 340], [410, 104, 500, 366], [650, 190, 560, 430]]
    .map(([left, top, width, height]) => ({left: left!, top: top!, width: width!, height: height!}))
  const state = {
    windows: normalRectangles.map(() => ({open: 1, minimized: 0, maximized: 0})),
    // Window indices from back to front.
    order: [0, 1, 2],
    // e.g. 'close 0' for Monitor's close button, 'dock 2' for Photos' dock item, 'photos content', 'list', or
    // 'location 2' for Monitor's third sidebar location.
    armed: null as string | null,
    // The sidebar location that Monitor's list shows, and its selected row or -1.
    valueListLocation: 1,
    valueListSelected: -1,
  }
  // At least half a pixel inside, like emitRectangleHit.
  const inside = (point: Point, rectangle: Rectangle) =>
    point.x - rectangle.left >= 0.5 && rectangle.left + rectangle.width - point.x >= 0.5
      && point.y - rectangle.top >= 0.5 && rectangle.top + rectangle.height - point.y >= 0.5
  const visible = (windowIndex: number) => state.windows[windowIndex]!.open === 1 && state.windows[windowIndex]!.minimized === 0
  const rectangleOf = (windowIndex: number) =>
    state.windows[windowIndex]!.maximized === 1 ? {left: 12, top: 48, width: 1256, height: 664} : normalRectangles[windowIndex]!
  const raise = (windowIndex: number) => {
    state.order = [...state.order.filter(index => index !== windowIndex), windowIndex]
  }

  // The frontmost visible window under the point, if any, and the control under the point, if any.
  function hitAt(point: Point): {windowIndex: number | undefined, control: string | null} {
    const windowIndex = state.order.findLast(index => visible(index) && inside(point, rectangleOf(index)))
    if (windowIndex === undefined) {
      const dockItem = [0, 1, 2].find(index => inside(point, {left: 553 + 62 * index, top: 737, width: 50, height: 50}))
      return {windowIndex, control: dockItem === undefined ? null : `dock ${dockItem}`}
    }
    const {left, top, width, height} = rectangleOf(windowIndex)
    // A button's hit rectangle is its 18 px square and half of the 10 px gap around it.
    for (const [name, buttonLeft] of [['close', left + width - 28], ['maximize', left + width - 56], ['minimize', left + width - 84]] as const) {
      if (inside(point, {left: buttonLeft - 5, top: top + 8, width: 28, height: 28})) return {windowIndex, control: `${name} ${windowIndex}`}
    }
    const onGrip = state.windows[windowIndex]!.maximized === 0 && inside(point, {left: left + width - 24, top: top + height - 24, width: 24, height: 24})
    if (windowIndex === 2 && !onGrip && inside(point, {left: left + 1, top: top + 45, width: width - 2, height: height - 46})) {
      return {windowIndex, control: 'photos content'}
    }
    // Monitor's list is the content box right of the 152 px sidebar, below the 28 px
    // header row, above the 32 px footer and left of the 16 px scrollbar strip. The
    // sidebar's three locations are 136×24, 8 px from the content box's left edge,
    // from 28 px below its top edge.
    if (windowIndex === 0 && !onGrip) {
      if (inside(point, {left: left + 153, top: top + 73, width: width - 170, height: height - 106})) return {windowIndex, control: 'list'}
      const location = [0, 1, 2].find(index => inside(point, {left: left + 9, top: top + 73 + 24 * index, width: 136, height: 24}))
      if (location !== undefined) return {windowIndex, control: `location ${location}`}
    }
    return {windowIndex, control: null}
  }

  // `point` is where the release that acts is.
  function act(control: string, point: Point) {
    const [name, index] = control.split(' ')
    if (name === 'photos') return
    if (name === 'list') {
      // The 24 px row under the release, if the shown location has that many rows.
      const row = Math.floor((point.y - rectangleOf(0).top - 73) / 24)
      if (row < valueListRowCounts[state.valueListLocation]!) state.valueListSelected = row
      return
    }
    if (name === 'location') {
      // Another location starts with no row selected.
      if (Number(index) !== state.valueListLocation) state.valueListSelected = -1
      state.valueListLocation = Number(index)
      return
    }
    const window = state.windows[Number(index)]!
    if (name === 'close') Object.assign(window, {open: 0, minimized: 0, maximized: 0})
    else if (name === 'minimize') window.minimized = 1
    else if (name === 'maximize') window.maximized = 1 - window.maximized
    else {
      Object.assign(window, {open: 1, minimized: 0})
      raise(Number(index))
    }
  }

  // The last down among events that share a timestamp raises the window under it and arms the control under it.
  function press(events: readonly PressEvent[]) {
    const down = events.findLast(event => event.kind === 'down')
    if (down === undefined) return
    const hit = hitAt(down)
    if (hit.windowIndex !== undefined) raise(hit.windowIndex)
    state.armed = hit.control
  }

  // Then the last up or cancel acts on the armed control when it's over that control
  // and no cancel is among the events, and disarms. Returns the control that acted.
  function release(events: readonly PressEvent[]) {
    const last = events.findLast(event => event.kind === 'up' || event.kind === 'cancel')
    if (last === undefined) return null
    const armed = state.armed
    state.armed = null
    if (armed === null || events.some(event => event.kind === 'cancel') || hitAt(last).control !== armed) return null
    act(armed, last)
    return armed
  }

  return {state, hitAt, press, release, focusedWindow: () => state.order.findLast(visible) ?? -1}
}

test('random presses, moves, releases and cancels at distinct and shared timestamps match the plain JavaScript press rule after every frame', () => {
  const machine = createWindowManagerMachine()
  const reference = createPressReference(valueListSourceField.rowCounts.map(cell => machine.source[cell]!))
  const random = createRandom(0x5eed5)
  // Button centers at each normal rectangle and at the maximized one, a point in each
  // title bar just past the close button, points on each window's content, among them
  // a row of Monitor's list, a point in Monitor's footer and one in its sidebar under
  // the locations, a point on the desk under Notes, Monitor's three sidebar
  // locations, which a maximized Monitor has under the same points, the dock items, a
  // point between two dock items, and a point on the system bar. None of them lies in
  // a normal window's title bar left of its buttons or on its grip, so no press drags
  // or resizes.
  const targets = [
    ...[[54, 54, 540], [410, 104, 500], [650, 190, 560], [12, 48, 1256]]
      .flatMap(([left, top, width]) => [19, 47, 75, 3].map(inset => ({x: left! + width! - inset, y: top! + 22}))),
    {x: 314, y: 246}, {x: 660, y: 309}, {x: 409, y: 516}, {x: 930, y: 427}, {x: 640, y: 402}, {x: 300, y: 380}, {x: 120, y: 300},
    {x: 131, y: 139}, {x: 131, y: 163}, {x: 131, y: 187},
    ...[0, 1, 2].map(dockItemCenter),
    {x: 609, y: 762}, {x: 640, y: 20},
  ]
  const at = () => targets[Math.floor(random() * targets.length)]!
  const events: PressEvent[] = []
  let time = 20
  for (let gesture = 0; gesture < 2_400; gesture++) {
    // Sometimes the press shares the previous release's timestamp.
    time += random() < 0.05 ? 0 : 1 + Math.floor(random() * 90)
    const down = at()
    events.push({kind: 'down', ...down, timeStamp: time})
    for (let move = Math.floor(random() * 4); move > 0; move--) {
      time += random() < 0.2 ? 0 : 1 + Math.floor(random() * 30)
      events.push({kind: 'move', ...at(), timeStamp: time})
    }
    // Sometimes the release is lost, and the next press replaces the armed control.
    if (random() < 0.08) continue
    time += random() < 0.15 ? 0 : 1 + Math.floor(random() * 60)
    events.push({kind: random() < 0.15 ? 'cancel' : 'up', ...(random() < 0.5 ? down : at()), timeStamp: time})
  }

  const counts = {acts: new Map<string, number>(), releasesActingOnNothingWhileArmed: 0, cancelsWhileArmed: 0, actsAfterMovingOff: 0, actsWhileAnimating: 0, sharedTimestamps: 0}
  const valueListRowsSelected = new Set<number>()
  const valueListLocationsShown = new Set<number>()
  let movedOffArmed = false
  let frameTime = 0
  let nextEvent = 0
  step(machine)
  while (nextEvent < events.length) {
    frameTime += 5 + Math.floor(random() * 36)
    const animating = machine.clock.animatedUntilMs !== null
    const frameEvents: PressEvent[] = []
    while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) frameEvents.push(events[nextEvent++]!)
    for (const event of frameEvents) sendPressEvent(machine, event)
    for (let start = 0; start < frameEvents.length;) {
      let end = start + 1
      while (end < frameEvents.length && frameEvents[end]!.timeStamp === frameEvents[start]!.timeStamp) end++
      const group = frameEvents.slice(start, end)
      start = end
      if (group.length > 1) counts.sharedTimestamps++
      reference.press(group)
      if (group.some(event => event.kind === 'down')) movedOffArmed = false
      const armed = reference.state.armed
      if (armed !== null && group.some(event => event.kind === 'move' && reference.hitAt(event).control !== armed)) movedOffArmed = true
      const acted = reference.release(group)
      if (acted !== null) {
        const kind = acted.split(' ')[0]!
        counts.acts.set(kind, (counts.acts.get(kind) ?? 0) + 1)
        if (movedOffArmed) counts.actsAfterMovingOff++
        if (animating) counts.actsWhileAnimating++
      } else if (armed !== null && group.some(event => event.kind === 'up' || event.kind === 'cancel')) {
        if (group.some(event => event.kind === 'cancel')) counts.cancelsWhileArmed++
        else counts.releasesActingOnNothingWhileArmed++
      }
    }
    frameTimeByMachine.set(machine, frameTime)
    const values = machine.step(viewportWidth, viewportHeight, frameTime)
    const label = `frame at ${frameTime} ms`
    const {state} = reference
    assert.deepEqual(windowsAndStack(machine.source).windows, state.windows.map(window => [window.open, window.minimized, window.maximized]), label)
    assert.deepEqual(
      Array.from({length: windowCount}, (_, rank) => Array.from({length: windowCount}, (_, index) => index).find(index => machine.source[stackSourceField(rank, index)] === 1)),
      state.order,
      label,
    )
    const [name, index] = (state.armed ?? '').split(' ')
    assert.equal(armedMass(machine.source), state.armed === null ? 0 : 1, label)
    if (state.armed !== null) {
      const field = name === 'photos' ? armedSourceField('photosContent')
        : name === 'list' ? armedSourceField('valueList')
          : name === 'location' ? armedSourceField('valueListLocation', Number(index))
            : armedSourceField(name === 'dock' ? 'dockItem' : name as 'close' | 'minimize' | 'maximize', Number(index))
      assert.equal(machine.source[field], 1, label)
    }
    assert.equal(projectWindows(machine, values).map(window => window.focused).indexOf(1), reference.focusedWindow(), label)
    assert.equal(machine.source[valueListSourceField.selected], state.valueListSelected, label)
    assert.equal(valueListSourceField.location.findIndex(cell => machine.source[cell] === 1), state.valueListLocation, label)
    valueListRowsSelected.add(state.valueListSelected)
    valueListLocationsShown.add(state.valueListLocation)
  }
  // The trace reached every kind of act and the cases the rule is about.
  assert.equal(valueListLocationsShown.size, 3)
  for (const kind of ['close', 'minimize', 'maximize', 'dock', 'photos', 'list', 'location']) {
    assert.ok((counts.acts.get(kind) ?? 0) >= 10, `${counts.acts.get(kind)} ${kind} acts`)
  }
  // Releases selected rows of Monitor's list at its normal and at its maximized
  // rectangle.
  assert.ok(valueListRowsSelected.size >= 4, `${[...valueListRowsSelected].join(', ')} selected in Monitor`)
  assert.ok(counts.releasesActingOnNothingWhileArmed >= 30, `${counts.releasesActingOnNothingWhileArmed} releases acting on nothing while armed`)
  assert.ok(counts.cancelsWhileArmed >= 10, `${counts.cancelsWhileArmed} cancels while armed`)
  assert.ok(counts.actsAfterMovingOff >= 10, `${counts.actsAfterMovingOff} acts after moving off the armed control`)
  assert.ok(counts.actsWhileAnimating >= 10, `${counts.actsWhileAnimating} acts while something animates`)
  assert.ok(counts.sharedTimestamps >= 30, `${counts.sharedTimestamps} timestamps shared by several events`)
}, 30_000)

test("while nothing animates and no press is held, a frame's pointer moves run as one evaluation, and the stored tables stay bit-identical to running every move", () => {
  // Hover, drag Monitor by its title bar, maximize Monitor and hover while it grows,
  // then hover again once everything rests. Moves are 4 ms apart.
  const events: PressEvent[] = []
  for (let index = 0; index <= 250; index++) events.push({kind: 'move', x: 300 + 3 * index, y: 500 - index, timeStamp: 100.3 + 4 * index})
  events.push({kind: 'down', x: 100, y: 76, timeStamp: 1203.3})
  for (let index = 1; index <= 20; index++) events.push({kind: 'move', x: 100 + 5 * index, y: 76 + 2 * index, timeStamp: 1203.3 + 4 * index})
  events.push({kind: 'up', x: 200, y: 116, timeStamp: 1287.3})
  // Monitor is at 154,94 after the drag, and its maximize button is centered at
  // 647,116.
  events.push({kind: 'down', x: 647, y: 116, timeStamp: 1403.3}, {kind: 'up', x: 647, y: 116, timeStamp: 1451.7})
  for (let index = 0; index < 50; index++) events.push({kind: 'move', x: 900 - 2 * index, y: 600, timeStamp: 1455.3 + 4 * index})
  for (let index = 0; index < 100; index++) events.push({kind: 'move', x: 400 + index, y: 300, timeStamp: 2503.1 + 4 * index})

  // At 960 fps, no frame gets more than one move, so every move runs, and every 120 fps
  // frame time is also a 960 fps frame time.
  const run = (hz: number) => {
    const machine = createWindowManagerMachine()
    const moveEvaluationTimes: number[] = []
    machine.observe({
      afterEvaluate(_values, _table, evaluation) {
        if (evaluation.events.some(event => event.kind === 'pointer move')) moveEvaluationTimes.push(evaluation.timeMs)
      },
    })
    const tables = new Map<number, Float32Array>()
    let nextEvent = 0
    for (let tick = 0; tick * 1000 / 960 <= 3500; tick += 960 / hz) {
      const frameTime = tick * 1000 / 960
      while (nextEvent < events.length && events[nextEvent]!.timeStamp <= frameTime) sendPressEvent(machine, events[nextEvent++]!)
      machine.step(viewportWidth, viewportHeight, frameTime)
      tables.set(frameTime, Float32Array.from(machine.source))
    }
    const movesBetween = (startMs: number, endMs: number) => moveEvaluationTimes.filter(time => time > startMs && time < endMs).length
    return {tables, idleHover: movesBetween(100, 1110), drag: movesBetween(1203, 1290), hoverWhileAnimating: movesBetween(1455, 1660)}
  }
  const everyMove = run(960)
  assert.deepEqual([everyMove.idleHover, everyMove.drag, everyMove.hoverWhileAnimating], [251, 20, 50])
  for (const hz of [120, 60, 30, 10]) {
    const result = run(hz)
    for (const [time, table] of result.tables) {
      assert.equal(differingBits(table, everyMove.tables.get(time)!), 0, `table after the frame at ${time} ms at ${hz} fps`)
    }
    // Moves during a drag and during an animation all run.
    assert.deepEqual([result.drag, result.hoverWhileAnimating], [20, 50], `${hz} fps`)
    assert.ok(result.idleHover <= Math.ceil(1010 * hz / 1000) + 1, `${result.idleHover} idle hover evaluations at ${hz} fps`)
  }

  // Moves whose timestamps lie after the frame's time all apply at the frame's time,
  // in delivery order. So the move delivered last sets the stored pointer, e.g. 700,600
  // here, although its timestamp is the earlier one. A second machine also gets a resize
  // to the same viewport before the moves, so its frame isn't all moves and every move
  // runs, and both machines store the same table in every bit.
  const coalescing = createWindowManagerMachine()
  const runningEveryMove = createWindowManagerMachine()
  for (const machine of [coalescing, runningEveryMove]) {
    settle(machine)
    const nextFrameTime = eventTime(machine, frameDuration)
    if (machine === runningEveryMove) machine.resize(viewportWidth, viewportHeight, nextFrameTime + 1)
    machine.pointerMove(300, 500, nextFrameTime + 3)
    machine.pointerMove(700, 600, nextFrameTime + 2)
    step(machine)
  }
  assert.deepEqual(coalescing.evaluations.map(evaluation => evaluation.events), [['pointer move'], []])
  assert.deepEqual(runningEveryMove.evaluations.map(evaluation => evaluation.events), [['resize', 'pointer move', 'pointer move'], []])
  assert.deepEqual([coalescing.source[coalescing.cells.pointer.x], coalescing.source[coalescing.cells.pointer.y]], [700, 600])
  assert.equal(differingBits(coalescing.source, runningEveryMove.source), 0)
}, 60_000)

// A stand-in for an element: projectWindowElements only writes style properties.
function createFakeElement() {
  const style: Record<string, unknown> = {}
  style['setProperty'] = (name: string, value: string) => {
    style[name] = value
  }
  return {style} as unknown as HTMLElement
}

test('while a window frame animates its size, the content box already has the destination size', () => {
  const machine = createWindowManagerMachine()
  const frames = Array.from({length: windowCount}, createFakeElement)
  const contents = Array.from({length: windowCount}, createFakeElement)
  const notes = 1
  let values = step(machine)
  projectWindowElements(frames, contents, values, machine.output.windows)
  assert.deepEqual(
    [frames[notes]!.style.width, frames[notes]!.style.height, contents[notes]!.style.width, contents[notes]!.style.height],
    ['500px', '366px', '498px', '320px'],
  )

  // Maximize Notes, then restore it. From the first frame after each press, the
  // content box has the destination size, so the browser wraps the note's text once
  // per press, while the frame draws in-between widths.
  const presses = [
    {contentWidth: '1254px', contentHeight: '618px', frameWidth: 1256},
    {contentWidth: '498px', contentHeight: '320px', frameWidth: 500},
  ]
  for (const press of presses) {
    values = clickWindowControl(machine, values, notes, 'maximize')
    let inBetweenFrames = 0
    for (let frame = 0; ; frame++) {
      assert.ok(frame < 240, 'the animation did not settle')
      projectWindowElements(frames, contents, values, machine.output.windows)
      assert.equal(contents[notes]!.style.width, press.contentWidth)
      assert.equal(contents[notes]!.style.height, press.contentHeight)
      if (Number.parseFloat(frames[notes]!.style.width) !== press.frameWidth) inBetweenFrames++
      if (animationActive(machine, values) === 0) break
      values = step(machine)
    }
    assert.ok(inBetweenFrames > 5, `${inBetweenFrames} frames at in-between widths`)
    assert.equal(frames[notes]!.style.width, `${press.frameWidth}px`)
  }
})

test("the note's keyboard focus follows the focused window: a frame focuses the note after a mouse press that leaves Notes focused, and blurs it while Notes isn't", () => {
  const mouseOnAWindow = {byMouse: true, outsideEveryWindow: false}
  const frame = {notesIsFocusedWindow: true, noteHasKeyboardFocus: false, pressedOrReleased: true, lastPress: mouseOnAWindow}
  // A press on Notes' title bar, or the release that opens Notes from the dock: Notes
  // is the focused window, the note isn't focused yet, and a mouse did it.
  assert.equal(noteFocusChange(frame), 'focus')
  // A press in the text: the browser focused the note already, and the frame leaves
  // it alone, so the caret stays where the press put it.
  assert.equal(noteFocusChange({...frame, noteHasKeyboardFocus: true}), null)
  // A press on the desk while Notes is the focused window: the browser took the
  // keyboard focus away, and the frame doesn't give it back.
  assert.equal(noteFocusChange({...frame, lastPress: {byMouse: true, outsideEveryWindow: true}}), null)
  // A finger, e.g. one that drags Notes by its title bar: the frame never calls
  // focus(), which could open the on-screen keyboard.
  assert.equal(noteFocusChange({...frame, lastPress: {byMouse: false, outsideEveryWindow: false}}), null)
  // The Tab key moved the keyboard focus away from the note: a frame without a
  // press or a release doesn't take it back.
  assert.equal(noteFocusChange({...frame, pressedOrReleased: false}), null)
  // While Notes isn't the focused window, e.g. after a press on another window, or
  // while Notes is minimized or closed, the note loses the keyboard focus, however
  // it got it and whatever the last press was.
  for (const pressedOrReleased of [true, false]) {
    for (const lastPress of [mouseOnAWindow, {byMouse: false, outsideEveryWindow: true}]) {
      assert.equal(noteFocusChange({notesIsFocusedWindow: false, noteHasKeyboardFocus: true, pressedOrReleased, lastPress}), 'blur')
      assert.equal(noteFocusChange({notesIsFocusedWindow: false, noteHasKeyboardFocus: false, pressedOrReleased, lastPress}), null)
    }
  }
  // The page's first frame: no press yet, so nothing is focused, also if Notes were
  // the focused window at load.
  assert.equal(noteFocusChange({notesIsFocusedWindow: true, noteHasKeyboardFocus: false, pressedOrReleased: false, lastPress: {byMouse: false, outsideEveryWindow: true}}), null)
})

function photoCenter(machine: Machine, values: Float32Array, item: number) {
  const start = item * photoField.size
  const photos = machine.output.photos.photos
  return {
    x: values[photos[start + photoField.left]!]! + values[photos[start + photoField.width]!]! / 2,
    y: values[photos[start + photoField.top]!]! + values[photos[start + photoField.height]!]! / 2,
  }
}

test('a Photos click during a maximize lands on the photo whose destination is under the pointer, at 30, 60 and 120 fps', () => {
  // Photo 5's center in the maximized layout, in viewport coordinates, from a
  // machine that maximized Photos and settled. At this click's time, a Photos laid
  // out at the drawn frame's size, reading the click relative to the drawn frame,
  // has no photo under this point. Photo 11, the bottom-right cell, would be under
  // the point in both layouts, so a click on photo 11 couldn't tell them apart.
  const settledMachine = createWindowManagerMachine()
  let settledValues = step(settledMachine)
  const maximizePoint = windowControlPoint(settledMachine, settledValues, 2, 'maximize')
  clickWindowControl(settledMachine, settledValues, 2, 'maximize')
  settledValues = settle(settledMachine)
  const maximized = projectWindows(settledMachine, settledValues)[2]!
  const localCenter = photoCenter(settledMachine, settledValues, 5)
  const titleHeight = settledMachine.source[sourceField.titleHeight]!
  const clickX = maximized.left + 1 + localCenter.x
  const clickY = maximized.top + titleHeight + 1 + localCenter.y

  for (const hz of [30, 60, 120]) {
    const machine = createWindowManagerMachine()
    // Press maximize and release, then press photo 5 and release, 32 ms after the
    // release that maximizes Photos.
    const events: {timeStamp: number, send: () => void}[] = [
      {timeStamp: 103.3, send: () => machine.pointerDown(maximizePoint.x, maximizePoint.y, 103.3)},
      {timeStamp: 151.7, send: () => machine.pointerUp(maximizePoint.x, maximizePoint.y, 151.7)},
      {timeStamp: 160.1, send: () => machine.pointerDown(clickX, clickY, 160.1)},
      {timeStamp: 183.9, send: () => machine.pointerUp(clickX, clickY, 183.9)},
    ]
    let lastFrameBeforeClick: Float32Array | null = null
    for (let frame = 0; frame * 1000 / hz <= 1500; frame++) {
      const frameTime = frame * 1000 / hz
      while (events.length > 0 && events[0]!.timeStamp <= frameTime) events.shift()!.send()
      const values = machine.step(viewportWidth, viewportHeight, frameTime)
      if (frameTime < 183.9) lastFrameBeforeClick = values.slice()
    }
    // The last frame before the release draws Photos mid-maximize, and the point lies
    // outside that frame's content box. The page delivers every release to the
    // machine, and the program reads Photos' content at its destination, so photo 5
    // opens anyway. A DOM click listener on the drawn .photos-content would never see
    // this click.
    const drawn = projectWindows(machine, lastFrameBeforeClick!)[2]!
    assert.equal(drawn.maximized, 1)
    assert.ok(drawn.width < maximized.width, `drawn width ${drawn.width} at ${hz} fps`)
    assert.ok(
      !(clickX > drawn.left + 1 && clickX < drawn.left + drawn.width - 1
        && clickY > drawn.top + titleHeight + 1 && clickY < drawn.top + drawn.height - 1),
      `the point lies outside the drawn content box at ${hz} fps`,
    )
    assert.equal(machine.source[photoFocusSourceField(5)], 1, `photo 5 focused at ${hz} fps`)
  }
})

test('the first step mounts the viewport as an event, so a small viewport clamps the windows and animates them there', () => {
  const machine = createWindowManagerMachine()
  step(machine, 400, 300)
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [
    ['events', ['mount']],
    ['frame', []],
  ])
  assert.notEqual(machine.clock.animatedUntilMs, null)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const left = machine.source[windowSourceField(windowIndex, windowStateField.left)]!
    const width = machine.source[windowSourceField(windowIndex, windowStateField.width)]!
    assert.ok(left + width <= 400)
  }
  const settled = projectWindows(machine, settle(machine, 400, 300))
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    assert.equal(settled[windowIndex]!.left, machine.source[windowSourceField(windowIndex, windowStateField.left)])
    assert.equal(settled[windowIndex]!.width, machine.source[windowSourceField(windowIndex, windowStateField.width)])
  }
})

// A session of timestamped events off the frame grid, replayed at several frame
// rates. Presses sit between frames, pointer moves are 4 ms apart like coalesced
// samples, and every destination change, including each viewport resize, reaches
// the machine as an event.
type SessionEvent =
  | {kind: 'down' | 'move' | 'up' | 'cancel', x: number, y: number, timeStamp: number}
  | {kind: 'photo previous' | 'photo next' | 'photo close', timeStamp: number}
  | {kind: 'value list key', key: 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end', timeStamp: number}
  | {kind: 'resize', width: number, height: number, timeStamp: number}

const sessionEndMs = 9500
// The press on the note's content, while Monitor flies to the dock.
const sessionNotePressMs = 2153.3
// The release that opens photo 5 during the second maximize, 20.2 ms after the
// release that maximizes Photos.
const sessionPhotoClickMs = 4912.1
// The releases on Monitor's list, the End key between them, and the release on
// Monitor's first sidebar location.
const sessionValueListClickMs = 3262.9
const sessionValueListEndMs = 3270.7
const sessionValueListClickAtEndMs = 3278.5
const sessionValueListLocationMs = 3289.7

function createSessionEvents() {
  const events: SessionEvent[] = []
  const press = (x: number, y: number, downTime: number, upTime: number) => {
    events.push({kind: 'down', x, y, timeStamp: downTime}, {kind: 'up', x, y, timeStamp: upTime})
  }
  // Minimize Monitor, and restore it from its dock item while it flies to the dock.
  // Buttons and dock items act at the release.
  press(519, 76, 203.3, 251.9)
  press(578, 762, 331.1, 380.6)
  // Hover moves during that animation.
  for (let index = 0; index <= 20; index++) {
    events.push({kind: 'move', x: 900 + 4 * index, y: 700 + 2 * index, timeStamp: 400.2 + 4 * index})
  }
  // While Monitor still flies back, press Notes' close button, which raises Notes, move
  // off the button 4 ms apart across the settle check at 635.9 ms, and release off the
  // button: Notes stays open.
  events.push({kind: 'down', x: 891, y: 126, timeStamp: 603.3})
  for (let index = 1; index <= 10; index++) {
    events.push({kind: 'move', x: 891, y: 126 + 6 * index, timeStamp: 603.3 + 4 * index})
  }
  events.push({kind: 'up', x: 891, y: 186, timeStamp: 647.3})
  // Press Notes' maximize button and cancel the press over the button: Notes stays at
  // its normal size, so the drag below moves it.
  events.push({kind: 'down', x: 863, y: 126, timeStamp: 803.3})
  events.push({kind: 'cancel', x: 863, y: 126, timeStamp: 851.7})
  // Drag Notes by its title bar past the left edge and back. The drag clamps the
  // window at every move, so Notes ends at left 300.
  let time = 1003.1
  let pointerX = 700
  events.push({kind: 'down', x: pointerX, y: 126, timeStamp: time})
  for (let index = 0; index < 25; index++) {
    events.push({kind: 'move', x: pointerX -= 40, y: 126, timeStamp: time += 4})
  }
  for (let index = 0; index < 10; index++) {
    events.push({kind: 'move', x: pointerX += 30, y: 126, timeStamp: time += 4})
  }
  events.push({kind: 'up', x: pointerX, y: 126, timeStamp: time + 4})
  // Resize Notes, which the drag left at 300,104 and in front, with its grip past
  // the minimum size and back, which ends at 480×350.
  time = 1603.3
  let gripX = 792
  let gripY = 462
  events.push({kind: 'down', x: gripX, y: gripY, timeStamp: time})
  for (let index = 0; index < 20; index++) {
    events.push({kind: 'move', x: gripX -= 20, y: gripY -= 15, timeStamp: time += 4})
  }
  for (let index = 0; index < 8; index++) {
    events.push({kind: 'move', x: gripX += 25, y: gripY += 20, timeStamp: time += 4})
  }
  events.push({kind: 'up', x: gripX, y: gripY, timeStamp: time + 4})
  // Close Monitor with a press that moves off its close button and back, 4 ms apart,
  // and releases over the button: Monitor closes at the release.
  events.push({kind: 'down', x: 575, y: 76, timeStamp: 2003.3})
  for (let index = 1; index <= 10; index++) {
    events.push({kind: 'move', x: 575 + 8 * Math.min(index, 10 - index), y: 76, timeStamp: 2003.3 + 4 * index})
  }
  events.push({kind: 'up', x: 575, y: 76, timeStamp: 2051.7})
  // A press on the note's content while Monitor still flies to the dock: Notes is at
  // 300,104 since the drag, so its content box starts at 301,149.
  press(400, 300, sessionNotePressMs, 2161.7)
  // Focus Photos, open photo 5 with a press and a release on it, and maximize Photos
  // while the photo is open. Pointer coordinates are viewport coordinates: Photos'
  // content box starts at (651, 235) at its normal size, and at (13, 93) maximized.
  press(900, 212, 2203.4, 2250.8)
  press(862.5, 427, 2381.1, 2403.2)
  press(1163, 212, 2803.7, 2851.1)
  events.push({kind: 'photo next', timeStamp: 3003.3})
  // Keys reach Photos only while Photos is focused: ArrowRight opens photo 7. Monitor's
  // dock item opens Monitor again, and raises and focuses it at its release, and
  // ArrowLeft and Escape leave photo 7 open. Photos' dock item focuses Photos again,
  // and ArrowLeft opens photo 6.
  events.push({kind: 'photo next', timeStamp: 3103.3})
  press(578, 762, 3203.1, 3251.5)
  // While Monitor is focused, its list takes a press and a release on row 4 and the
  // keys: ArrowDown selects row 5, and End selects the last row and asks for the
  // list's last scroll position. The session runs without a scroller, so the list
  // stays at each requested position, and the next release, at the same point,
  // selects the row there. PageUp then moves the selection 9 rows up, above the
  // view, and the program asks for that row's top. A press and a release on the
  // sidebar's first location show State, with no selection and at the top, where
  // the same point is on row 4 again, and ArrowDown selects row 5.
  press(314, 246, sessionValueListClickMs - 5.6, sessionValueListClickMs)
  events.push({kind: 'value list key', key: 'down', timeStamp: 3266.3})
  events.push({kind: 'value list key', key: 'end', timeStamp: sessionValueListEndMs})
  press(314, 246, 3274.1, sessionValueListClickAtEndMs)
  events.push({kind: 'value list key', key: 'pageUp', timeStamp: 3281.9})
  press(131, 139, 3285.3, sessionValueListLocationMs)
  press(314, 246, 3292.1, 3296.5)
  events.push({kind: 'value list key', key: 'down', timeStamp: 3299.3})
  events.push({kind: 'photo previous', timeStamp: 3303.7})
  events.push({kind: 'photo close', timeStamp: 3353.3})
  press(702, 762, 3403.3, 3451.9)
  events.push({kind: 'photo previous', timeStamp: 3503.1})
  events.push({kind: 'photo close', timeStamp: 3603.9})
  // Restore Photos, maximize it again, and open photo 5 with a press and a release
  // while the window grows, at the photo's center in the maximized layout. A Photos
  // laid out at the drawn size would put photo 4 under the point instead.
  press(1221, 70, 4003.2, 4051.6)
  press(1163, 212, 4843.5, 4891.9)
  press(485.5, 402, 4900.3, sessionPhotoClickMs)
  events.push({kind: 'photo next', timeStamp: 5303.7})
  // Resize the viewport while Photos is maximized with a photo open, and back.
  events.push({kind: 'resize', width: 1100, height: 760, timeStamp: 5503.4})
  events.push({kind: 'resize', width: 1280, height: 800, timeStamp: 5903.9})
  events.push({kind: 'photo close', timeStamp: 6103.1})
  // Restore Photos, minimize Monitor, and resize the viewport while Monitor is
  // minimized.
  press(1221, 70, 6503.2, 6551.6)
  press(519, 76, 7103.3, 7151.7)
  events.push({kind: 'resize', width: 1000, height: 700, timeStamp: 7803.6})
  events.push({kind: 'resize', width: 1280, height: 800, timeStamp: 8203.1})
  // Drag Photos, which the 1000 px viewport moved to left 440 and which is stacked
  // above Notes, right by its title bar until the viewport clamps it at left 720.
  time = 8503.3
  pointerX = 700
  events.push({kind: 'down', x: pointerX, y: 212, timeStamp: time})
  for (let index = 0; index < 10; index++) {
    events.push({kind: 'move', x: pointerX += 30, y: 212, timeStamp: time += 4})
  }
  events.push({kind: 'up', x: pointerX, y: 212, timeStamp: time + 4})
  return events
}

const sessionEvents = createSessionEvents()

// A rate of 120, 60, 30 or 10 fps takes every (120 / hz)th tick of k × 1000 / 120,
// so shared frame times are the same numbers. A stall drops the ticks inside it.
function sessionFrameTimes(hz: number, stall?: {startMs: number, lengthMs: number}) {
  const frameTimes: number[] = []
  for (let tick = 0; tick * 1000 / 120 <= sessionEndMs; tick += 120 / hz) {
    const frameTime = tick * 1000 / 120
    if (stall !== undefined && frameTime > stall.startMs && frameTime < stall.startMs + stall.lengthMs) continue
    frameTimes.push(frameTime)
  }
  return frameTimes
}

type SessionRun = {
  // Every evaluation that wrote state back, with the table after it.
  commits: {kind: string, timeMs: number, events: string[], table: Float32Array}[]
  // Each frame's window, dock, Photos, value list and animationActive outputs.
  frames: Map<number, Float32Array>
  mostStepsInOneFrame: number
  // Times of the evaluations after which nothing animated anymore.
  clockStops: number[]
  // Destination cells where a 'frame' evaluation's next state differed from the
  // stored table. Destinations must change only at events.
  destinationMismatches: number
  // The kind of each evaluation that applied a resize.
  resizeEvaluationKinds: string[]
}

function runSession(frameTimes: readonly number[], writeBack: WriteBack): SessionRun {
  const machine = createWindowManagerMachine({writeBack})
  const outputWires = [
    ...machine.output.windows,
    ...machine.output.dockItems,
    machine.output.animationActive,
    machine.output.photos.backdropOpacity,
    ...machine.output.photos.photos,
    ...machine.output.photos.thumbnails,
    ...machine.output.photos.previousControl,
    ...machine.output.photos.nextControl,
    machine.output.valueList.totalHeight,
    machine.output.valueList.scroll,
    machine.output.valueList.scrollTarget,
    machine.output.valueList.scrollRequest,
    machine.output.valueList.slotOverflow,
    machine.output.valueList.selected,
    ...machine.output.valueList.locations,
    ...machine.output.valueList.slots,
  ]
  // Each window stores 5 springs as displacement, velocity and destination, and
  // each thumbnail stores 2 destinations.
  const destinationCells = [
    ...Array.from({length: windowCount * 5}, (_, spring) => sourceField.springStart + 3 * spring + 2),
    ...Array.from({length: photoCount}, (_, item) => [
      photoThumbnailSpringSourceField(item, thumbnailSpringField.centerXDestination),
      photoThumbnailSpringSourceField(item, thumbnailSpringField.scaleDestination),
    ]).flat(),
  ]
  const run: SessionRun = {
    commits: [],
    frames: new Map(),
    mostStepsInOneFrame: 0,
    clockStops: [],
    destinationMismatches: 0,
    resizeEvaluationKinds: [],
  }
  let animating = false
  checkGridsOnEveryEvaluation(machine)
  machine.observe({
    afterEvaluate(values, table, evaluation) {
      const eventKinds = evaluation.events.map(event => event.kind)
      if (eventKinds.includes('resize')) run.resizeEvaluationKinds.push(evaluation.kind)
      if (!evaluation.writesBack) {
        for (const cell of destinationCells) {
          if (values[machine.output.nextSource[cell]!] !== table[cell]) run.destinationMismatches++
        }
        return
      }
      run.commits.push({kind: evaluation.kind, timeMs: evaluation.timeMs, events: eventKinds, table: Float32Array.from(table)})
      const nowAnimating = values[machine.output.animationActive]! > 0
      if (animating && !nowAnimating) run.clockStops.push(evaluation.timeMs)
      animating = nowAnimating
    },
  })
  let viewport = {width: 1280, height: 800}
  let nextEvent = 0
  for (const frameTime of frameTimes) {
    while (nextEvent < sessionEvents.length && sessionEvents[nextEvent]!.timeStamp <= frameTime) {
      const event = sessionEvents[nextEvent++]!
      switch (event.kind) {
        case 'down':
          machine.pointerDown(event.x, event.y, event.timeStamp)
          break
        case 'move':
          machine.pointerMove(event.x, event.y, event.timeStamp)
          break
        case 'up':
          machine.pointerUp(event.x, event.y, event.timeStamp)
          break
        case 'cancel':
          machine.pointerCancel(event.x, event.y, event.timeStamp)
          break
        case 'photo previous':
          machine.photoPrevious(event.timeStamp)
          break
        case 'photo next':
          machine.photoNext(event.timeStamp)
          break
        case 'photo close':
          machine.photoClose(event.timeStamp)
          break
        case 'value list key':
          machine.valueListKey(event.key, event.timeStamp)
          break
        case 'resize':
          // Like the page: the resize handler queues the event, and later frames
          // pass the same viewport to step().
          viewport = {width: event.width, height: event.height}
          machine.resize(event.width, event.height, event.timeStamp)
          break
      }
    }
    const values = machine.step(viewport.width, viewport.height, frameTime)
    run.frames.set(frameTime, Float32Array.from(outputWires, wire => values[wire]!))
    const steps = machine.evaluations.reduce((sum, evaluation) => sum + evaluation.steps, 0)
    run.mostStepsInOneFrame = Math.max(run.mostStepsInOneFrame, steps)
  }
  return run
}

function differingBits(left: Float32Array, right: Float32Array) {
  let count = 0
  for (let index = 0; index < left.length; index++) {
    if (!Object.is(left[index], right[index])) count++
  }
  return count
}

const commitLabel = (commit: SessionRun['commits'][number]) => `${commit.kind}@${commit.timeMs}`

test("with 'events and settle checks', the session commits bit-identical tables and draws bit-identical outputs at shared times at 120, 60, 30 and 10 fps and through 500 ms stalls", () => {
  const baseline = runSession(sessionFrameTimes(120), 'events and settle checks')
  const commitAt = (timeStamp: number, kind: string) => {
    const found = baseline.commits.find(commit => commit.timeMs === quantizeTimeMs(timeStamp) && commit.events.includes(kind))
    assert.ok(found !== undefined, `a commit with a ${kind} at ${timeStamp} ms`)
    return found
  }
  const commitsBetween = (startMs: number, endMs: number) => baseline.commits.filter(commit => commit.timeMs > startMs && commit.timeMs < endMs)
  const commitBefore = (commit: SessionRun['commits'][number]) => baseline.commits[baseline.commits.indexOf(commit) - 1]!
  const bit = (table: Float32Array, windowIndex: number, field: number) => table[windowSourceField(windowIndex, field)]!
  // The session did what it says.
  const final = baseline.commits.at(-1)!.table
  assert.deepEqual([bit(final, 0, windowStateField.open), bit(final, 0, windowStateField.minimized)], [1, 1])
  assert.deepEqual(
    [final[windowSourceField(1, windowStateField.left)], final[windowSourceField(1, windowStateField.width)], final[windowSourceField(1, windowStateField.height)]],
    [300, 480, 350],
  )
  assert.equal(final[windowSourceField(2, windowStateField.left)], 720)
  assert.equal(baseline.clockStops.length > 5, true)
  // The press on Notes' close button that moved off and released off the button
  // acted on nothing, while Monitor still animated: a settle check ran between its
  // moves, and the clock didn't stop.
  assert.equal(bit(commitAt(647.3, 'pointer up').table, 1, windowStateField.open), 1)
  assert.ok(commitsBetween(607.3, 643.3).some(commit => commit.kind === 'settle check'))
  assert.ok(baseline.clockStops.every(time => time < 603.3 || time > 647.3))
  // The pointercancel over Notes' maximize button acted on nothing, and nothing is
  // armed after it.
  const afterCancel = commitAt(851.7, 'pointer cancel').table
  assert.equal(bit(afterCancel, 1, windowStateField.maximized), 0)
  assert.equal(armedMass(afterCancel), 0)
  // The press that moved off Monitor's close button and back closed the window at the
  // release, and not before. Monitor's dock item opened it again.
  assert.ok(commitsBetween(2003.3, 2051.7).every(commit => bit(commit.table, 0, windowStateField.open) === 1))
  assert.equal(bit(commitAt(2051.7, 'pointer up').table, 0, windowStateField.open), 0)
  assert.equal(bit(commitAt(3251.5, 'pointer up').table, 0, windowStateField.open), 1)
  // Keys changed the open photo once per key while Photos was focused, and not while
  // Monitor was focused: ArrowLeft and Escape leave photo 7 open in the commits of
  // those keys.
  const openPhoto = (table: Float32Array) => Array.from({length: photoCount}, (_, item) => table[photoFocusSourceField(item)]!).indexOf(1)
  assert.equal(openPhoto(commitAt(2403.2, 'pointer up').table), 5)
  assert.equal(focusedWindowOf(commitAt(3251.5, 'pointer up').table), 0)
  assert.equal(focusedWindowOf(commitAt(3353.3, 'photo close').table), 0)
  assert.equal(focusedWindowOf(commitAt(3451.9, 'pointer up').table), 2)
  const keyCommits = [
    {timeStamp: 3003.3, kind: 'photo next', focusedWindow: 2, openPhoto: 6},
    {timeStamp: 3103.3, kind: 'photo next', focusedWindow: 2, openPhoto: 7},
    {timeStamp: 3303.7, kind: 'photo previous', focusedWindow: 0, openPhoto: 7},
    {timeStamp: 3353.3, kind: 'photo close', focusedWindow: 0, openPhoto: 7},
    {timeStamp: 3503.1, kind: 'photo previous', focusedWindow: 2, openPhoto: 6},
    {timeStamp: 3603.9, kind: 'photo close', focusedWindow: 2, openPhoto: -1},
  ]
  assert.deepEqual(
    keyCommits.map(key => {
      const table = commitAt(key.timeStamp, key.kind).table
      return {...key, focusedWindow: focusedWindowOf(table), openPhoto: openPhoto(table)}
    }),
    keyCommits,
  )
  const openPhotos = commitsBetween(2900, 3700).map(commit => openPhoto(commit.table))
  assert.deepEqual(openPhotos.filter((photo, index) => index === 0 || photo !== openPhotos[index - 1]), [5, 6, 7, 6, -1])
  // The release during the second maximize opened photo 5.
  assert.equal(openPhoto(commitAt(sessionPhotoClickMs, 'pointer up').table), 5)
  // Monitor's list: the release selected row 4, ArrowDown row 5, and End the last row.
  // The list is 234 px tall, so End asked for the position 234 px before the end of
  // the rows, and the evaluations after it read the list there: the same point is on
  // the row 119 px below that position, and PageUp selects 9 rows above that row,
  // which starts above the view, so the program asked for the position of its top.
  const valueListSelected = (commit: SessionRun['commits'][number]) => commit.table[valueListSourceField.selected]!
  const valueListLocation = (commit: SessionRun['commits'][number]) => valueListSourceField.location.findIndex(cell => commit.table[cell] === 1)
  const valueListScrollTop = (commit: SessionRun['commits'][number]) => commit.table[valueListSourceField.scrollTop]!
  const operationsRowCount = final[valueListSourceField.rowCounts[1]!]!
  const valueListEnd = operationsRowCount * 24 - 234
  const valueListRowAtEnd = Math.floor((valueListEnd + 119) / 24)
  assert.equal(valueListSelected(commitAt(sessionValueListClickMs, 'pointer up')), 4)
  assert.equal(valueListSelected(commitAt(3266.3, 'value list key')), 5)
  assert.equal(valueListScrollTop(commitAt(3266.3, 'value list key')), 0)
  assert.equal(valueListSelected(commitAt(sessionValueListEndMs, 'value list key')), operationsRowCount - 1)
  assert.equal(valueListScrollTop(commitAt(3274.1, 'pointer down')), valueListEnd)
  assert.equal(valueListSelected(commitAt(sessionValueListClickAtEndMs, 'pointer up')), valueListRowAtEnd)
  assert.equal(valueListSelected(commitAt(3281.9, 'value list key')), valueListRowAtEnd - 9)
  assert.equal(valueListScrollTop(commitAt(3285.3, 'pointer down')), (valueListRowAtEnd - 9) * 24)
  // The release on the sidebar's first location showed State with no selection, and
  // asked for the top of the list, where the next release selected row 4.
  const locationRelease = commitAt(sessionValueListLocationMs, 'pointer up')
  assert.deepEqual([valueListLocation(commitAt(3285.3, 'pointer down')), valueListLocation(locationRelease), valueListSelected(locationRelease)], [1, 0, -1])
  assert.equal(valueListScrollTop(commitAt(3292.1, 'pointer down')), 0)
  assert.equal(valueListSelected(commitAt(3296.5, 'pointer up')), 4)
  assert.equal(valueListSelected(commitAt(3299.3, 'value list key')), 5)
  assert.deepEqual([valueListLocation(baseline.commits.at(-1)!), final[valueListSourceField.selected], final[valueListSourceField.scrollTop]], [0, 5, 0])
  // The press on the note's content raised nothing new, since Notes was in front
  // already, and held nothing: no drag, no resize and no armed control are stored
  // after its down, so its release 8.4 ms later acted on nothing. Monitor still flew
  // to the dock around it.
  const notePress = commitAt(sessionNotePressMs, 'pointer down').table
  assert.equal(focusedWindowOf(notePress), 1)
  assert.equal(armedMass(notePress), 0)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    assert.deepEqual([notePress[dragSourceField(windowIndex)], notePress[resizeSourceField(windowIndex)]], [0, 0])
  }
  const noteRelease = commitAt(2161.7, 'pointer up').table
  const storedWindows = (table: Float32Array) => Array.from({length: windowCount * windowStateField.size}, (_, cell) => table[sourceField.windowStart + cell])
  assert.deepEqual(storedWindows(noteRelease), storedWindows(commitBefore(commitAt(sessionNotePressMs, 'pointer down')).table))
  assert.ok(baseline.clockStops.every(time => time < 2051.7 || time > 2161.7), 'Monitor still animated at the press on the note')
  const photosDragCommits = baseline.commits.filter(commit => commit.timeMs > 8500 && commit.events.includes('pointer move'))
  assert.equal(photosDragCommits.length, 10)

  const stall = {startMs: 2900, lengthMs: 500}
  const runs = [
    baseline,
    runSession(sessionFrameTimes(60), 'events and settle checks'),
    runSession(sessionFrameTimes(30), 'events and settle checks'),
    runSession(sessionFrameTimes(10), 'events and settle checks'),
    runSession(sessionFrameTimes(60, stall), 'events and settle checks'),
    runSession(sessionFrameTimes(120, stall), 'events and settle checks'),
  ]
  for (const run of runs) {
    assert.deepEqual(run.commits.map(commitLabel), baseline.commits.map(commitLabel))
    run.commits.forEach((commit, index) => {
      assert.equal(differingBits(commit.table, baseline.commits[index]!.table), 0, `table after ${commitLabel(commit)}`)
    })
    for (const [time, outputs] of run.frames) {
      assert.equal(differingBits(outputs, baseline.frames.get(time)!), 0, `outputs at ${time} ms`)
    }
    assert.ok(run.mostStepsInOneFrame <= 300)
    assert.equal(run.commits.some(commit => commit.kind === 'snap'), false)
    assert.equal(run.destinationMismatches, 0)
    // One 'events' evaluation per resize event: step() adds no resize of its own.
    assert.deepEqual(run.resizeEvaluationKinds, ['events', 'events', 'events', 'events'])
  }
  // A stall loses no time: the first frame after the stall draws what 120 fps
  // draws at the same time.
  const stalled = runs[4]!
  const resumeTime = [...stalled.frames.keys()].find(time => time >= stall.startMs + stall.lengthMs)!
  assert.equal(resumeTime, 3400)
  assert.equal(differingBits(stalled.frames.get(resumeTime)!, baseline.frames.get(resumeTime)!), 0)
}, 30_000)

test('a 2 s stall that holds presses and resizes snaps once, applies each event at its own timestamp, and commits the same tables at 60 and 120 fps', () => {
  const stall = {startMs: 7000, lengthMs: 2000}
  const runs = [60, 120].map(hz => runSession(sessionFrameTimes(hz, stall), 'events and settle checks'))
  for (const run of runs) {
    assert.equal(run.commits.filter(commit => commit.kind === 'snap').length, 1)
    assert.ok(run.mostStepsInOneFrame <= 300)
    // No frame ran between 7,000 and 9,000 ms, and the release that minimizes Monitor
    // still applies at its own time.
    const minimizeRelease = run.commits.find(commit =>
      commit.kind === 'events' && commit.events.includes('pointer up') && commit.timeMs === quantizeTimeMs(7151.7))
    assert.equal(minimizeRelease?.table[windowSourceField(0, windowStateField.minimized)], 1)
    assert.deepEqual(run.commits.map(commitLabel), runs[0]!.commits.map(commitLabel))
    run.commits.forEach((commit, index) => {
      assert.equal(differingBits(commit.table, runs[0]!.commits[index]!.table), 0, `table after ${commitLabel(commit)}`)
    })
  }
}, 60_000)

test("writing back every evaluation draws within 5e-4 px of the committed session at 60 fps, and stops the clock at the same times", () => {
  const frameTimes = sessionFrameTimes(60)
  const committed = runSession(frameTimes, 'events and settle checks')
  const everyEvaluation = runSession(frameTimes, 'every evaluation')
  let worst = 0
  for (const [time, outputs] of everyEvaluation.frames) {
    const other = committed.frames.get(time)!
    outputs.forEach((value, index) => {
      worst = Math.max(worst, Math.abs(value - other[index]!))
    })
  }
  assert.ok(worst < 5e-4, `worst difference ${worst} px`)
  assert.deepEqual(everyEvaluation.clockStops, committed.clockStops)
}, 60_000)
