import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {type WriteBack, quantizeTimeMs} from './host-timing.ts'
import {validateGrids} from './numeric-ui-core.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
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
} from './window-manager.ts'
import {itemCount as photoCount, photoField, thumbnailSpringField} from './photo-gallery.ts'

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
// bits rely on.
function checkGridsOnEveryEvaluation(machine: Machine) {
  const counts = {evaluations: 0}
  machine.observe({
    beforeEvaluate(table) {
      validateGrids(machine.circuit, machine.circuit.evaluateReference(table))
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
    contentWidth: 518,
    contentHeight: 294,
    destinationWidth: 520,
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

test('window control edges produce one complete maximize decision', () => {
  const machine = createWindowManagerMachine()
  let values = step(machine)
  const projected = projectWindows(machine, values)[3]!
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
  assert.equal(machine.source[windowSourceField(3, windowStateField.maximized)], 1)
  assert.equal(machine.source[windowSourceField(3, windowStateField.minimized)], 0)
  values = settle(machine)
  const maximized = projectWindows(machine, values)[3]!
  assert.deepEqual(
    {left: maximized.left, top: maximized.top, width: maximized.width, height: maximized.height},
    {left: 12, top: 48, width: 1256, height: 664},
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
  assert.equal(window.width, 560)
  assert.equal(window.height, 430)
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
    {left: 650, top: 190, width: 560, height: 430},
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
})

test('a press hits a window when it is at least half a pixel inside, with pointer coordinates on a 1/64 px grid within ±32,768 px', () => {
  // Window 0 spans x from 54 to 574, and no other window covers (54.5, 224).
  // Window 3 starts in front.
  for (const {x, focused} of [
    {x: 54.5 - 1 / 64, focused: 3},
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

test('next state is a direct numeric view and runtime atoms remain fixed', () => {
  const machine = createWindowManagerMachine()
  machine.pointerDown(100, 80)
  step(machine)

  // nextSource being a direct wire view of the source is owned generically by
  // photo-gallery.test.ts and re-checked for this machine in the Photos test
  // below; here we pin the window-manager-specific output wiring and atoms.
  assert.equal(machine.output.windows.length, windowCount * windowOutputField.size)
  assert.equal(machine.output.dockItems.length, windowCount * dockOutputField.size)
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

  // photoClick takes viewport coordinates. Photos rests at its destination, so its
  // content box starts 1 px inside the frame and below the title bar.
  const photosWindow = projectWindows(machine, values)[3]!
  machine.photoClick(
    photosWindow.left + 1 + firstPhoto.left + firstPhoto.width / 2,
    photosWindow.top + machine.source[sourceField.titleHeight]! + 1 + firstPhoto.top + firstPhoto.height / 2,
  )
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
  const photosWindow = projectWindows(machine, values)[3]!
  const globalX = photosWindow.left + 1 + localX
  const globalY =
    photosWindow.top + machine.source[sourceField.titleHeight]! + 1 + localY

  machine.pointerDown(globalX, globalY)
  machine.pointerUp(globalX, globalY)
  machine.photoClick(globalX, globalY)
  values = step(machine)

  assertFocused(projectWindows(machine, values), 3)
  assert.equal(machine.source[photoFocusSourceField(item)], 1)
})

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
  // content box has the destination size, so Notes' text reflows once per press,
  // while the frame draws in-between widths.
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
  const maximizePoint = windowControlPoint(settledMachine, settledValues, 3, 'maximize')
  clickWindowControl(settledMachine, settledValues, 3, 'maximize')
  settledValues = settle(settledMachine)
  const maximized = projectWindows(settledMachine, settledValues)[3]!
  const localCenter = photoCenter(settledMachine, settledValues, 5)
  const titleHeight = settledMachine.source[sourceField.titleHeight]!
  const clickX = maximized.left + 1 + localCenter.x
  const clickY = maximized.top + titleHeight + 1 + localCenter.y

  for (const hz of [30, 60, 120]) {
    const machine = createWindowManagerMachine()
    // Press maximize, then about 80 ms later press photo 5 and release, which the
    // browser follows with a click at the same time.
    const events: {timeStamp: number, send: () => void}[] = [
      {timeStamp: 103.3, send: () => machine.pointerDown(maximizePoint.x, maximizePoint.y, 103.3)},
      {timeStamp: 151.7, send: () => machine.pointerUp(maximizePoint.x, maximizePoint.y, 151.7)},
      {timeStamp: 160.1, send: () => machine.pointerDown(clickX, clickY, 160.1)},
      {
        timeStamp: 183.9,
        send: () => {
          machine.pointerUp(clickX, clickY, 183.9)
          machine.photoClick(clickX, clickY, 183.9)
        },
      },
    ]
    let lastFrameBeforeClick: Float32Array | null = null
    for (let frame = 0; frame * 1000 / hz <= 1500; frame++) {
      const frameTime = frame * 1000 / hz
      while (events.length > 0 && events[0]!.timeStamp <= frameTime) events.shift()!.send()
      const values = machine.step(viewportWidth, viewportHeight, frameTime)
      if (frameTime < 183.9) lastFrameBeforeClick = values
    }
    // The last frame before the click draws Photos mid-maximize, and the click point
    // lies inside that frame's content box, so the page delivers the click to Photos.
    const drawn = projectWindows(machine, lastFrameBeforeClick!)[3]!
    assert.equal(drawn.maximized, 1)
    assert.ok(drawn.width < maximized.width, `drawn width ${drawn.width} at ${hz} fps`)
    assert.ok(
      clickX > drawn.left + 1 && clickX < drawn.left + drawn.width - 1
        && clickY > drawn.top + titleHeight + 1 && clickY < drawn.top + drawn.height - 1,
      `the click point lies inside the drawn content box at ${hz} fps`,
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
  | {kind: 'down' | 'move' | 'up', x: number, y: number, timeStamp: number}
  | {kind: 'photo click', x: number, y: number, timeStamp: number}
  | {kind: 'photo next' | 'photo close', timeStamp: number}
  | {kind: 'resize', width: number, height: number, timeStamp: number}

const sessionEndMs = 9500
// The Photos click during the second maximize, 68.6 ms after the maximize press.
const sessionPhotoClickMs = 4912.1

function createSessionEvents() {
  const events: SessionEvent[] = []
  const press = (x: number, y: number, downTime: number, upTime: number) => {
    events.push({kind: 'down', x, y, timeStamp: downTime}, {kind: 'up', x, y, timeStamp: upTime})
  }
  // Minimize Files, and restore it from its dock item while it flies to the dock.
  press(499, 76, 203.3, 251.9)
  press(547, 762, 331.1, 380.6)
  // Hover moves during that animation.
  for (let index = 0; index <= 20; index++) {
    events.push({kind: 'move', x: 900 + 4 * index, y: 700 + 2 * index, timeStamp: 400.2 + 4 * index})
  }
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
  // Resize System Monitor with its grip past the minimum size and back, which
  // ends at 480×350.
  time = 1603.3
  let gripX = 632
  let gripY = 632
  events.push({kind: 'down', x: gripX, y: gripY, timeStamp: time})
  for (let index = 0; index < 20; index++) {
    events.push({kind: 'move', x: gripX -= 20, y: gripY -= 15, timeStamp: time += 4})
  }
  for (let index = 0; index < 8; index++) {
    events.push({kind: 'move', x: gripX += 25, y: gripY += 20, timeStamp: time += 4})
  }
  events.push({kind: 'up', x: gripX, y: gripY, timeStamp: time + 4})
  // Close System Monitor, focus Photos, open photo 5, and maximize Photos while
  // the photo is open. Photos clicks are in viewport coordinates: Photos' content
  // box starts at (651, 235) at its normal size, and at (13, 93) maximized.
  press(635, 366, 2003.3, 2051.7)
  press(900, 212, 2203.4, 2250.8)
  events.push({kind: 'photo click', x: 862.5, y: 427, timeStamp: 2403.2})
  press(1163, 212, 2803.7, 2851.1)
  events.push({kind: 'photo next', timeStamp: 3003.3})
  events.push({kind: 'photo close', timeStamp: 3603.9})
  // Restore Photos, maximize it again, and click photo 5 while the window grows, at
  // the photo's center in the maximized layout. At 10 fps too, a frame drawn
  // mid-maximize covers the click point, and a Photos laid out at the drawn size
  // would put photo 4 under the point instead.
  press(1221, 70, 4003.2, 4051.6)
  press(1163, 212, 4843.5, 4891.9)
  events.push({kind: 'photo click', x: 485.5, y: 402, timeStamp: sessionPhotoClickMs})
  events.push({kind: 'photo next', timeStamp: 5303.7})
  // Resize the viewport while Photos is maximized with a photo open, and back.
  events.push({kind: 'resize', width: 1100, height: 760, timeStamp: 5503.4})
  events.push({kind: 'resize', width: 1280, height: 800, timeStamp: 5903.9})
  events.push({kind: 'photo close', timeStamp: 6103.1})
  // Restore Photos, minimize Files, and resize the viewport while Files is minimized.
  press(1221, 70, 6503.2, 6551.6)
  press(499, 76, 7103.3, 7151.7)
  events.push({kind: 'resize', width: 1000, height: 700, timeStamp: 7803.6})
  events.push({kind: 'resize', width: 1280, height: 800, timeStamp: 8203.1})
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
  // Each frame's window, dock, Photos and animationActive outputs.
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
        case 'photo click':
          machine.photoClick(event.x, event.y, event.timeStamp)
          break
        case 'photo next':
          machine.photoNext(event.timeStamp)
          break
        case 'photo close':
          machine.photoClose(event.timeStamp)
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
  // The session did what it says.
  const final = baseline.commits.at(-1)!.table
  assert.equal(final[windowSourceField(0, windowStateField.minimized)], 1)
  assert.equal(final[windowSourceField(1, windowStateField.left)], 300)
  assert.deepEqual(
    [final[windowSourceField(2, windowStateField.open)], final[windowSourceField(2, windowStateField.width)], final[windowSourceField(2, windowStateField.height)]],
    [0, 480, 350],
  )
  const photoClick = baseline.commits.find(commit => commit.events.includes('photo click') && commit.timeMs > 4800)!
  assert.equal(photoClick.table[photoFocusSourceField(5)], 1)
  assert.equal(baseline.clockStops.length > 5, true)

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
    // The page can deliver the Photos click at this rate: the content box of the
    // Photos frame drawn before the click covers the click point.
    const frameBeforeClick = run.frames.get(Math.max(...[...run.frames.keys()].filter(time => time < sessionPhotoClickMs)))!
    const photosFrame = (field: number) => frameBeforeClick[3 * windowOutputField.size + field]!
    const left = photosFrame(windowOutputField.translateX)
    const top = photosFrame(windowOutputField.translateY)
    assert.ok(
      485.5 > left + 1 && 485.5 < left + photosFrame(windowOutputField.width) - 1
        && 402 > top + 45 && 402 < top + photosFrame(windowOutputField.height) - 1,
      'the Photos click point lies inside the drawn content box',
    )
  }
  // A stall loses no time: the first frame after the stall draws what 120 fps
  // draws at the same time.
  const stalled = runs[4]!
  const resumeTime = [...stalled.frames.keys()].find(time => time >= stall.startMs + stall.lengthMs)!
  assert.equal(resumeTime, 3400)
  assert.equal(differingBits(stalled.frames.get(resumeTime)!, baseline.frames.get(resumeTime)!), 0)
})

test('a 2 s stall that holds presses and resizes snaps once, applies each event at its own timestamp, and commits the same tables at 60 and 120 fps', () => {
  const stall = {startMs: 7000, lengthMs: 2000}
  const runs = [60, 120].map(hz => runSession(sessionFrameTimes(hz, stall), 'events and settle checks'))
  for (const run of runs) {
    assert.equal(run.commits.filter(commit => commit.kind === 'snap').length, 1)
    assert.ok(run.mostStepsInOneFrame <= 300)
    // No frame ran between 7,000 and 9,000 ms, and the press that minimizes Files
    // still applies at its own time.
    assert.ok(run.commits.some(commit =>
      commit.kind === 'events' && commit.events.includes('pointer down') && commit.timeMs === quantizeTimeMs(7103.3)))
    assert.deepEqual(run.commits.map(commitLabel), runs[0]!.commits.map(commitLabel))
    run.commits.forEach((commit, index) => {
      assert.equal(differingBits(commit.table, runs[0]!.commits[index]!.table), 0, `table after ${commitLabel(commit)}`)
    })
  }
})

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
})
