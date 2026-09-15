// Agreement between the IndirectOS copy and native float64 arithmetic, and between
// minimum and maximum modes.
// 1. Settled layout: after springs settle, window, dock, Photos grid, and Photos
//    control geometry are plain layout functions of the viewport and the stored
//    window rectangles, written here with Math.min and Math.max.
// 2. Press decisions at window edges: which window a press raises, against a
//    float64 hit test and the stacking order.
// 3. Random action sequences run through several modes side by side.
// Every step also checks the promised mode's operand bound at evaluation time.
import {type MinMaxMode, promisedMagnitude} from './min-max-mode.ts'
import {createRandom, f} from './measure.ts'
import {columnCount, controlField, itemCount as photoCount, photoField} from './photo-gallery-copy.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  photoFocusSourceField,
  photoSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from './window-manager-copy.ts'

export type Machine = ReturnType<typeof createWindowManagerMachine>
export type Rectangle = readonly [left: number, top: number, width: number, height: number]

const photosWindowIndex = windowCount - 1
const springFieldCount = 10
const springStart = sourceField.springStart

export function countPromiseViolations(machine: Machine, values: Float32Array) {
  let violations = 0
  for (const wire of machine.minMaxSites.promisedOperands) {
    if (!(Math.abs(values[wire]!) <= promisedMagnitude)) violations++
  }
  return violations
}

export function createAgreementMachine(mode: MinMaxMode) {
  const machine = createWindowManagerMachine(mode)
  const initialSource = Float32Array.from(machine.source)
  let frameTime = 0
  let promiseViolations = 0
  return {
    machine,
    promiseViolations: () => promiseViolations,
    // Restores the initial table with new stored rectangles and matching spring state.
    reset(rectangles: readonly Rectangle[]) {
      machine.source.set(initialSource)
      frameTime = 0
      rectangles.forEach(([left, top, width, height], windowIndex) => {
        machine.source[windowSourceField(windowIndex, windowStateField.left)] = left
        machine.source[windowSourceField(windowIndex, windowStateField.top)] = top
        machine.source[windowSourceField(windowIndex, windowStateField.width)] = width
        machine.source[windowSourceField(windowIndex, windowStateField.height)] = height
        const springs = springStart + windowIndex * springFieldCount
        machine.source[springs] = f(left + width / 2)
        machine.source[springs + 1] = f(top + height / 2)
        machine.source[springs + 2] = width
        machine.source[springs + 3] = height
      })
    },
    step(viewportWidth: number, viewportHeight: number, elapsed = 16) {
      frameTime += elapsed
      const values = machine.step(viewportWidth, viewportHeight, frameTime)
      promiseViolations += countPromiseViolations(machine, values)
      return values
    },
  }
}

export type LayoutOutputs = {
  windows: number[]
  dock: number[]
  photos: number[]
  controls: number[]
  storedRectangles: number[]
}

// Output groups read from the circuit, in the same order as referenceLayout.
function readLayout(machine: Machine, values: Float32Array): LayoutOutputs {
  const windows: number[] = []
  const dock: number[] = []
  const storedRectangles: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const start = windowIndex * windowOutputField.size
    for (const field of [windowOutputField.translateX, windowOutputField.translateY, windowOutputField.width, windowOutputField.height, windowOutputField.contentWidth, windowOutputField.contentHeight]) {
      windows.push(values[machine.output.windows[start + field]!]!)
    }
    const dockStart = windowIndex * dockOutputField.size
    for (const field of [dockOutputField.left, dockOutputField.top, dockOutputField.width, dockOutputField.height]) {
      dock.push(values[machine.output.dockItems[dockStart + field]!]!)
    }
    for (const field of [windowStateField.left, windowStateField.top, windowStateField.width, windowStateField.height]) {
      storedRectangles.push(machine.source[windowSourceField(windowIndex, field)]!)
    }
  }
  const photos: number[] = []
  for (let item = 0; item < photoCount; item++) {
    const start = item * photoField.size
    for (const field of [photoField.left, photoField.top, photoField.width, photoField.height]) {
      photos.push(values[machine.output.photos.photos[start + field]!]!)
    }
  }
  const controls: number[] = []
  for (const control of [machine.output.photos.previousControl, machine.output.photos.nextControl]) {
    for (const field of [controlField.left, controlField.top, controlField.width, controlField.height]) {
      controls.push(values[control[field]!]!)
    }
  }
  return {windows, dock, photos, controls, storedRectangles}
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum)
const relu = (value: number) => Math.max(0, value)

// The settled layout in float64, for visible, unmaximized windows.
export function referenceLayout(source: Float32Array, viewportWidth: number, viewportHeight: number, rectangles: readonly Rectangle[]): LayoutOutputs {
  const constant = (field: number) => source[field]!
  const effectiveDockHeight = Math.min(constant(sourceField.dockHeight), viewportHeight)
  const dockTop = viewportHeight - effectiveDockHeight
  const workspaceTop = Math.min(constant(sourceField.systemBarHeight), dockTop)
  const workspaceHeight = dockTop - workspaceTop
  const windows: number[] = []
  const storedRectangles: number[] = []
  const projectedSizes: [number, number][] = []
  for (const [initialLeft, initialTop, initialWidth, initialHeight] of rectangles) {
    const width = clamp(initialWidth, Math.min(constant(sourceField.minWidth), viewportWidth), viewportWidth)
    const height = clamp(initialHeight, Math.min(constant(sourceField.minHeight), workspaceHeight), workspaceHeight)
    const left = clamp(initialLeft, 0, relu(viewportWidth - width))
    const top = clamp(initialTop, workspaceTop, relu(dockTop - height))
    storedRectangles.push(left, top, width, height)
    const projectedWidth = clamp(width, 0, viewportWidth)
    const projectedHeight = clamp(height, 0, viewportHeight)
    const halfWidth = projectedWidth * 0.5
    const halfHeight = projectedHeight * 0.5
    const centerX = clamp(left + width * 0.5, halfWidth, viewportWidth - halfWidth)
    const centerY = clamp(top + height * 0.5, halfHeight, viewportHeight - halfHeight)
    windows.push(
      centerX - halfWidth,
      centerY - halfHeight,
      projectedWidth,
      projectedHeight,
      relu(projectedWidth - 2),
      relu(projectedHeight - constant(sourceField.titleHeight) - 2),
    )
    projectedSizes.push([projectedWidth, projectedHeight])
  }
  const dockGap = Math.min(constant(sourceField.dockGap), Math.min(viewportWidth / 3, effectiveDockHeight * 0.5))
  const dockHorizontalSpace = relu(viewportWidth - 3 * dockGap)
  const dockVerticalSpace = relu(effectiveDockHeight - 2 * dockGap)
  const dockItemSize = Math.min(constant(sourceField.dockItemWidth), Math.min(dockHorizontalSpace / 4, dockVerticalSpace))
  const dockLeft = viewportWidth * 0.5 - (4 * dockItemSize + 3 * dockGap) * 0.5
  const dockItemTop = dockTop + effectiveDockHeight * 0.5 - dockItemSize * 0.5
  const dock: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    dock.push(dockLeft + dockItemSize * windowIndex + dockGap * windowIndex, dockItemTop, dockItemSize, dockItemSize)
  }
  const [photosWidth, photosHeight] = projectedSizes[photosWindowIndex]!
  const contentWidth = relu(photosWidth - 2)
  const contentHeight = relu(photosHeight - constant(sourceField.titleHeight) - 2)
  const gap = constant(photoSourceField.gap)
  const gridWidth = relu(contentWidth / 4 - gap * 5 / 4)
  const gridHeight = relu(contentHeight / 3 - gap * 4 / 3)
  const photos: number[] = []
  for (let item = 0; item < photoCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    photos.push(gap * (1 + column) + gridWidth * column, gap * (1 + row) + gridHeight * row, gridWidth, gridHeight)
  }
  const thumbnailBaseSize = Math.min(constant(photoSourceField.thumbnailHeight), Math.min(contentWidth / 6, contentHeight * 0.24))
  const mainHeight = relu(contentHeight - thumbnailBaseSize - 3 * gap)
  const controlSize = constant(photoSourceField.controlSize)
  const controlTop = relu(gap + mainHeight * 0.5 - controlSize * 0.5)
  const controls = [
    gap * 0.5, controlTop, controlSize, controlSize,
    relu(contentWidth - gap * 0.5 - controlSize), controlTop, controlSize, controlSize,
  ]
  return {windows, dock, photos, controls, storedRectangles}
}

export type GroupAgreement = {
  outputs: number
  notEqualToFround: number
  // The same count split by output field, e.g. dock `left` against dock `width`.
  notEqualToFroundByField: Record<string, number>
  maximumAbsoluteDifference: number
}

// Field names in the order readLayout and referenceLayout push them.
const layoutFieldNames: Record<keyof LayoutOutputs, readonly string[]> = {
  windows: ['translateX', 'translateY', 'width', 'height', 'contentWidth', 'contentHeight'],
  dock: ['left', 'top', 'width', 'height'],
  photos: ['left', 'top', 'width', 'height'],
  controls: ['left', 'top', 'width', 'height'],
  storedRectangles: ['left', 'top', 'width', 'height'],
}

export function createAgreementTotals(): Record<keyof LayoutOutputs, GroupAgreement> {
  const group = (key: keyof LayoutOutputs): GroupAgreement => ({
    outputs: 0,
    notEqualToFround: 0,
    notEqualToFroundByField: Object.fromEntries(layoutFieldNames[key].map(name => [name, 0])),
    maximumAbsoluteDifference: 0,
  })
  return {windows: group('windows'), dock: group('dock'), photos: group('photos'), controls: group('controls'), storedRectangles: group('storedRectangles')}
}

function accumulate(totals: Record<keyof LayoutOutputs, GroupAgreement>, circuit: LayoutOutputs, reference: LayoutOutputs) {
  for (const key of Object.keys(totals) as (keyof LayoutOutputs)[]) {
    const circuitValues = circuit[key]
    const referenceValues = reference[key]
    const total = totals[key]
    const names = layoutFieldNames[key]
    for (let index = 0; index < circuitValues.length; index++) {
      total.outputs++
      if (circuitValues[index] !== f(referenceValues[index]!)) {
        total.notEqualToFround++
        const name = names[index % names.length]!
        total.notEqualToFroundByField[name] = (total.notEqualToFroundByField[name] ?? 0) + 1
      }
      total.maximumAbsoluteDifference = Math.max(total.maximumAbsoluteDifference, Math.abs(circuitValues[index]! - referenceValues[index]!))
    }
  }
}

// Random fractional rectangles, as left after drags with fractional pointer coordinates.
export function randomRectangles(random: () => number): Rectangle[] {
  return Array.from({length: windowCount}, (): Rectangle => [
    f(random() * 900),
    f(36 + random() * 500),
    f(280 + random() * 700),
    f(190 + random() * 500),
  ])
}

export function viewportCases(count: number, seed: number) {
  const random = createRandom(seed)
  return Array.from({length: count}, (_, index): [number, number] => {
    // Every fourth case is small, where fractional dock and Photos terms become the minimum.
    const small = index % 4 === 0
    const width = small ? 20 + random() * 400 : 320 + random() * 2600
    const height = small ? 80 + random() * 380 : 250 + random() * 1400
    // Half the viewports are fractional, as with a CSS zoom or device pixel scaling.
    return index % 2 === 0 ? [Math.round(width), Math.round(height)] : [f(width), f(height)]
  })
}

export function settledLayoutAgreement(mode: MinMaxMode, viewports: readonly [number, number][], seed: number) {
  const harness = createAgreementMachine(mode)
  const random = createRandom(seed)
  const totals = createAgreementTotals()
  let unsettled = 0
  let framesTotal = 0
  for (const [viewportWidth, viewportHeight] of viewports) {
    const rectangles = randomRectangles(random)
    harness.reset(rectangles)
    let values = harness.step(viewportWidth, viewportHeight)
    let frames = 1
    while (values[harness.machine.output.animationActive] !== 0 && frames < 600) {
      values = harness.step(viewportWidth, viewportHeight)
      frames++
    }
    framesTotal += frames
    if (values[harness.machine.output.animationActive] !== 0) {
      unsettled++
      continue
    }
    accumulate(totals, readLayout(harness.machine, values), referenceLayout(harness.machine.source, viewportWidth, viewportHeight, rectangles))
  }
  return {totals, unsettled, averageFrames: framesTotal / viewports.length, promiseViolations: harness.promiseViolations()}
}

// Presses near a window's right or bottom edge, where the second operand of a
// minimum is the smaller one and the drifting macro reconstructs it with rounding.
export function edgePressAgreement(mode: MinMaxMode, trials: number, seed: number) {
  const harness = createAgreementMachine(mode)
  const {machine} = harness
  const random = createRandom(seed)
  const viewportWidth = 2400
  const viewportHeight = 1600
  let mismatches = 0
  let nearDecisions = 0
  let skipped = 0
  const examples: string[] = []
  for (let trial = 0; trial < trials; trial++) {
    // Rectangles on a 1/64 grid keep left + width representable, so a float64 hit
    // test and FP32 interval distances agree on which side of 0.5 px a press lands.
    const rectangles = randomRectangles(random).map(([left, top, width, height]): Rectangle =>
      [Math.round(left * 64) / 64, Math.round(top * 64) / 64, Math.round(width * 64) / 64, Math.round(height * 64) / 64])
    harness.reset(rectangles)
    harness.step(viewportWidth, viewportHeight)
    const target = Math.floor(random() * windowCount)
    const [left, top, width, height] = rectangles[target]!
    const titleHeight = machine.source[sourceField.titleHeight]!
    const nearRight = random() < 0.5
    const jitter = (random() * 2 - 1) * 2e-4
    const x = f(nearRight ? left + width - 0.5 + jitter : left + width * random())
    const y = f(nearRight ? top + titleHeight + 20 + random() * (height - titleHeight - 60) : top + height - 0.5 + jitter)
    const stack = Array.from({length: windowCount}, (_, rank) =>
      Array.from({length: windowCount}, (_, windowIndex) => machine.source[stackSourceField(rank, windowIndex)]!))
    let expected = -1
    for (let rank = windowCount - 1; rank >= 0 && expected < 0; rank--) {
      const windowIndex = stack[rank]!.indexOf(1)
      const [windowLeft, windowTop, windowWidth, windowHeight] = rectangles[windowIndex]!
      const score = Math.min(x - windowLeft, windowLeft + windowWidth - x, y - windowTop, windowTop + windowHeight - y)
      if (Math.abs(score - 0.5) < 1e-3) nearDecisions++
      if (Math.max(0, Math.min(1, score)) >= 0.5) expected = windowIndex
    }
    // A press in the hit window's title bar can land on close or minimize, which changes
    // visibility; those trials test buttons rather than edges.
    if (expected >= 0 && y - rectangles[expected]![1] < titleHeight) {
      skipped++
      continue
    }
    if (expected < 0) expected = stack[windowCount - 1]!.indexOf(1)
    machine.pointerDown(x, y)
    machine.pointerUp(x, y)
    const values = harness.step(viewportWidth, viewportHeight)
    const focused = Array.from({length: windowCount}, (_, windowIndex) =>
      values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!]!)
    if (focused.indexOf(1) !== expected || focused.reduce((total, bit) => total + bit, 0) !== 1) {
      mismatches++
      if (examples.length < 3) examples.push(`press (${x}, ${y}) near window ${target}: expected ${expected}, focused ${focused.join('')}`)
    }
  }
  return {trials, skipped, mismatches, nearDecisions, examples, promiseViolations: harness.promiseViolations()}
}

type Event = {kind: 'down' | 'move' | 'up', x: number, y: number}

// The random actions of window-manager.test.ts, generated from the first machine's
// projected state and applied to every machine.
function createRandomAction(machine: Machine, values: Float32Array, width: number, height: number, random: () => number): {width: number, height: number, events: Event[]} {
  const windowIndex = Math.floor(random() * windowCount)
  const windowStart = windowIndex * windowOutputField.size
  const read = (field: number) => values[machine.output.windows[windowStart + field]!]!
  const window = {left: read(windowOutputField.translateX), top: read(windowOutputField.translateY), width: read(windowOutputField.width), height: read(windowOutputField.height)}
  const dockStart = windowIndex * dockOutputField.size
  const readDock = (field: number) => values[machine.output.dockItems[dockStart + field]!]!
  const choice = Math.floor(random() * 9)
  if (choice === 0) return {width: Math.floor(random() * 1_500), height: Math.floor(random() * 1_000), events: []}
  if (choice === 1) return {width, height, events: [{kind: 'down', x: random() * width, y: random() * height}, {kind: 'up', x: random() * width, y: random() * height}]}
  const size = machine.source[sourceField.buttonSize]!
  const gap = machine.source[sourceField.buttonGap]!
  const titleHeight = machine.source[sourceField.titleHeight]!
  if (choice <= 4) {
    const closeX = window.left + window.width - gap - size / 2
    const x = closeX - (4 - choice) * (gap + size)
    const point = {x, y: window.top + titleHeight / 2}
    return {width, height, events: [{kind: 'down', ...point}, {kind: 'up', ...point}]}
  }
  if (choice === 5) {
    const point = {x: readDock(dockOutputField.left) + readDock(dockOutputField.width) / 2, y: readDock(dockOutputField.top) + readDock(dockOutputField.height) / 2}
    return {width, height, events: [{kind: 'down', ...point}, {kind: 'up', ...point}]}
  }
  const grip = machine.source[sourceField.resizeGrip]!
  const start = choice === 6
    ? {x: window.left + Math.min(40, window.width / 4), y: window.top + Math.min(titleHeight / 2, window.height / 4)}
    : {x: window.left + window.width - Math.min(grip / 2, window.width / 4), y: window.top + window.height - Math.min(grip / 2, window.height / 4)}
  const end = {x: start.x + (random() - 0.5) * width, y: start.y + (random() - 0.5) * height}
  return {width, height, events: [{kind: 'down', ...start}, {kind: 'move', ...end}, {kind: 'up', ...end}]}
}

// Exact bits in the source table. `present` is left out: it is clamp01 of visibility
// plus present times the spring activity, which is fractional while a window animates.
function decisionCells(machine: Machine) {
  const cells: number[] = []
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized]) {
      cells.push(machine.source[windowSourceField(windowIndex, field)]!)
    }
    cells.push(machine.source[dragSourceField(windowIndex)]!, machine.source[resizeSourceField(windowIndex)]!)
    for (let rank = 0; rank < windowCount; rank++) cells.push(machine.source[stackSourceField(rank, windowIndex)]!)
  }
  for (let item = 0; item < photoCount; item++) cells.push(machine.source[photoFocusSourceField(item)]!)
  return cells
}

export function randomActionComparison(modes: readonly MinMaxMode[], actionCount: number, seed: number) {
  const machines = modes.map(mode => createWindowManagerMachine(mode))
  const random = createRandom(seed)
  let width = 1280
  let height = 800
  let frameTime = 16
  let values = machines.map(machine => machine.step(width, height, frameTime))
  const decisionDivergences = modes.map(() => 0)
  const firstDivergence = modes.map((): number | null => null)
  const maximumSourceDifference = modes.map(() => 0)
  const promiseViolations = modes.map(() => 0)
  let nonBitDecisions = 0
  for (let action = 0; action < actionCount; action++) {
    const next = createRandomAction(machines[0]!, values[0]!, width, height, random)
    width = next.width
    height = next.height
    frameTime += 1 + random() * 40
    values = machines.map(machine => {
      for (const event of next.events) {
        if (event.kind === 'down') machine.pointerDown(event.x, event.y)
        else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
        else machine.pointerUp(event.x, event.y)
      }
      return machine.step(width, height, frameTime)
    })
    const baseDecisions = decisionCells(machines[0]!)
    for (let index = 0; index < machines.length; index++) {
      const machine = machines[index]!
      promiseViolations[index]! += countPromiseViolations(machine, values[index]!)
      const decisions = decisionCells(machine)
      for (const bit of decisions) if (bit !== 0 && bit !== 1) nonBitDecisions++
      if (decisions.some((bit, cell) => bit !== baseDecisions[cell])) {
        decisionDivergences[index]!++
        firstDivergence[index] ??= action
      }
      for (let field = 0; field < machine.source.length; field++) {
        const difference = Math.abs(machine.source[field]! - machines[0]!.source[field]!)
        if (difference > maximumSourceDifference[index]!) maximumSourceDifference[index] = difference
      }
    }
  }
  return {
    actions: actionCount,
    modes: modes.map((mode, index) => ({
      mode,
      decisionDivergences: decisionDivergences[index],
      firstDivergence: firstDivergence[index],
      maximumSourceDifferenceFromFirstMode: maximumSourceDifference[index],
      promiseViolations: promiseViolations[index],
    })),
    nonBitDecisions,
  }
}
