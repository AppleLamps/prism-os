import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createEvaluator} from '../../src/runtime/cells.ts'
import {type Circuit, validateGrids} from '../../src/runtime/numeric-ui-core.ts'
import {
  createFilesCircuit,
  createFilesRenderer,
  describeOperations,
  describeOutputs,
  describeState,
  formatValue,
  maximumScrollTop,
  rowCapacity,
  scrollGrid,
  slotField,
} from '../../src/handwiredos/files.ts'
import {
  armedSourceField,
  createWindowManagerMachine,
  resizeSourceField,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'

// ---------- Files' list in plain JavaScript ----------
//
// Written from the "JS:" comments in src/handwiredos/files.ts, with its own copies
// of the constants. It uses no circuit code, so the tests below can compare the
// program with it.

const rowHeight = 24
const slotCount = 64
const overscanRows = 2
const maximumViewportHeight = 16_384
const pixelGrid = 1 / 64

const locationCount = 3
// The sidebar's locations, in order. The window opens on Operations.
const [stateLocation, operationsLocation, outputsLocation] = [0, 1, 2] as const

const keys = ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'] as const
type Key = (typeof keys)[number]

// What Files stores: the location that the list shows, and its selected row or -1.
type ReferenceState = {location: number, selected: number}

type ReferenceFrame = {
  viewportHeight: number
  scrollTop: number
  // Each location's number of rows.
  rowCounts: readonly number[]
  focused: boolean
  // The y of a release over the list after a press on the list, relative to the
  // list viewport's top edge, or null.
  listClickY: number | null
  // The location whose sidebar item a release is over, after a press on that item, or null.
  locationClick: number | null
  key: Key | null
}

function referenceFiles(state: ReferenceState, frame: ReferenceFrame) {
  const location = frame.locationClick ?? state.location
  const locationChanged = location !== state.location
  const rowCount = frame.rowCounts[location]!
  let selected = state.selected
  const totalHeight = rowCount * rowHeight
  const viewportFloor = Math.floor(frame.viewportHeight)
  const viewportCeil = Math.ceil(frame.viewportHeight)
  const maximumScroll = Math.max(0, totalHeight - viewportFloor)
  const scroll = Math.min(frame.scrollTop, maximumScroll)
  const firstVisible = Math.floor(scroll / rowHeight)
  const offsetInRow = scroll - firstVisible * rowHeight
  const endVisible = Math.ceil((scroll + viewportCeil) / rowHeight)
  const firstDrawn = Math.max(0, firstVisible - overscanRows)
  const endDrawn = Math.min(endVisible + overscanRows, rowCount)

  if (frame.listClickY !== null) {
    const clickY = Math.min(Math.max(frame.listClickY, 0), maximumViewportHeight)
    const clickedRow = firstVisible + Math.floor((clickY + offsetInRow) / rowHeight)
    if (clickedRow < rowCount) selected = clickedRow
  }
  const keyActive = frame.key !== null && frame.focused && rowCount >= 1
  if (keyActive) {
    const pageRows = Math.max(1, Math.floor(viewportFloor / rowHeight))
    let moved = firstVisible
    if (selected >= 0) {
      moved = selected
      if (frame.key === 'down') moved += 1
      if (frame.key === 'up') moved -= 1
      if (frame.key === 'pageDown') moved += pageRows
      if (frame.key === 'pageUp') moved -= pageRows
    }
    if (frame.key === 'home') moved = 0
    if (frame.key === 'end') moved = rowCount - 1
    selected = Math.min(Math.max(moved, 0), rowCount - 1)
  }
  selected = Math.min(selected, rowCount - 1)

  let scrollTarget = scroll
  if (keyActive) scrollTarget = Math.min(Math.max(scroll, (selected + 1) * rowHeight - viewportFloor), selected * rowHeight)
  // Another location starts with no selection and at the top.
  if (locationChanged) {
    selected = -1
    scrollTarget = 0
  }

  // The rows that get a DOM node, in row order. A row past the last slot gets none.
  const drawn: {slot: number, row: number, top: number, selected: boolean}[] = []
  for (let row = firstDrawn; row < Math.min(endDrawn, firstDrawn + slotCount); row++) {
    drawn.push({slot: row % slotCount, row, top: row * rowHeight, selected: row === selected})
  }
  return {
    location,
    selected,
    rowCount,
    totalHeight,
    scroll,
    scrollTarget,
    scrollRequest: scrollTarget !== scroll,
    slotOverflow: endDrawn - firstDrawn > slotCount,
    drawn,
    // Not outputs of the program: for the tests' counters.
    firstVisible,
    keyActive,
  }
}

type Reference = ReturnType<typeof referenceFiles>

// ---------- the program on its own ----------

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

// Files alone, with the host's wires as cells. Each step writes a frame into the
// table, evaluates it, and writes the next state back.
function createStandaloneFiles() {
  const program = createFilesCircuit()
  const evaluate = createEvaluator(program)
  const source = new Float32Array(program.initialSource)
  const {cells} = program
  return {
    program,
    source,
    get state(): ReferenceState {
      return {location: cells.files.location.findIndex(cell => source[cell] === 1), selected: source[cells.files.selected]!}
    },
    set state({location, selected}: ReferenceState) {
      cells.files.location.forEach((cell, index) => {
        source[cell] = Number(index === location)
      })
      source[cells.files.selected] = selected
    },
    step(frame: ReferenceFrame) {
      source[cells.viewportHeight] = frame.viewportHeight
      source[cells.focused] = frame.focused ? 1 : 0
      source[cells.listClick.active] = frame.listClickY === null ? 0 : 1
      source[cells.listClick.y] = frame.listClickY ?? 0
      cells.locationClicks.forEach((cell, index) => {
        source[cell] = Number(index === frame.locationClick)
      })
      source[cells.files.scrollTop] = frame.scrollTop
      cells.files.rowCounts.forEach((cell, index) => {
        source[cell] = frame.rowCounts[index]!
      })
      for (const key of keys) source[cells.files.keys[key]] = frame.key === key ? 1 : 0
      const result = evaluate(source)
      const table = Float32Array.from(source)
      source.set(result.nextValues)
      return {output: result.output, table}
    },
  }
}

type StandaloneOutput = ReturnType<ReturnType<typeof createStandaloneFiles>['step']>['output']

// The first difference between the program's outputs and the reference, if any.
function differenceFromReference(output: StandaloneOutput, expected: Reference): string | undefined {
  for (const field of ['totalHeight', 'scroll', 'scrollTarget', 'selected'] as const) {
    if (output[field] !== expected[field]) return `${field}: got ${output[field]}, expected ${expected[field]}`
  }
  if (output.scrollRequest !== Number(expected.scrollRequest)) return `scrollRequest: got ${output.scrollRequest}, expected ${expected.scrollRequest}`
  if (output.slotOverflow !== Number(expected.slotOverflow)) return `slotOverflow: got ${output.slotOverflow}, expected ${expected.slotOverflow}`
  const locations = Array.from({length: locationCount}, (_, index) => Number(index === expected.location))
  if (output.locations.join() !== locations.join()) return `locations: got ${output.locations.join()}, expected ${locations.join()}`
  const drawn: Reference['drawn'] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const read = (field: number) => output.slots[slot * slotField.size + field]!
    // Every slot's outputs are exact, whether or not the slot is drawn.
    if (!Number.isInteger(read(slotField.row)) || ![0, 1].includes(read(slotField.present)) || ![0, 1].includes(read(slotField.selected))) {
      return `slot ${slot} holds a value that isn't exact`
    }
    if (read(slotField.present) === 1) drawn.push({slot, row: read(slotField.row), top: read(slotField.top), selected: read(slotField.selected) === 1})
  }
  drawn.sort((left, right) => left.row - right.row)
  if (drawn.length !== expected.drawn.length) return `${drawn.length} slots drawn, expected ${expected.drawn.length}`
  for (let index = 0; index < drawn.length; index++) {
    const got = drawn[index]!
    const want = expected.drawn[index]!
    if (got.slot !== want.slot || got.row !== want.row || got.top !== want.top || got.selected !== want.selected) {
      return `drawn row ${index}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`
    }
  }
  return undefined
}

// Every one of `wires` holds a value within its range, declared or inferred. Only
// this check tests the ranges that files.ts declares on the wires it computes, e.g.
// 0..2,400,000 on the scroll position after a key.
function validateRanges(circuit: Circuit, values: Float32Array, wires: Iterable<number> = values.keys()) {
  for (const wire of wires) {
    const {minimum, maximum} = circuit.ranges[wire]!
    if (!(values[wire]! >= minimum && values[wire]! <= maximum)) throw new Error(`wire ${wire} holds ${values[wire]}, outside ${minimum}..${maximum}`)
  }
}

const onScrollGrid = (value: number) => Math.floor(value / scrollGrid) * scrollGrid
const onPixelGrid = (value: number) => Math.floor(value / pixelGrid) * pixelGrid

test('the reference and the program share their constants', () => {
  assert.equal(maximumScrollTop, rowCapacity * rowHeight)
  assert.equal(createFilesCircuit().output.slots.length, slotCount * slotField.size)
})

test('on 60,000 seeded random frames of scroll positions, viewport heights, releases, keys and location changes, every output equals the plain JavaScript reference', () => {
  const files = createStandaloneFiles()
  const random = createRandom(0xf11e5)
  const pick = <Value>(values: readonly Value[]) => values[Math.floor(random() * values.length)]!
  const counts = {
    clicks: 0, clicksThatChangedTheSelection: 0, clicksBelowTheLastRow: 0, keys: new Map<Key, number>(), keysFromNoSelection: 0,
    keysWhileNotFocused: 0, clickAndKey: 0, scrollRequests: 0, slotOverflows: 0, scrollAtARowEdge: 0, scrollPastTheEnd: 0,
    emptyLists: 0, selectionsPastTheEnd: 0, locationChanges: 0, locationChangesWhileScrolled: 0, clicksOnTheShownLocation: 0,
    locationChangesWithAKeyOrARelease: 0, keysWithALocationChange: 0, shownLocations: new Set<number>(), gridChecks: 0,
  }
  const rowCounts = [rowCapacity, rowCapacity, rowCapacity]
  for (let frame = 0; frame < 60_000; frame++) {
    // Now and then another row count for one location: any count, none, the
    // capacity, or a few rows.
    const rowCountKind = random()
    if (rowCountKind < 0.08) {
      rowCounts[Math.floor(random() * locationCount)] = rowCountKind < 0.03 ? Math.floor(random() * (rowCapacity + 1))
        : rowCountKind < 0.04 ? 0
          : rowCountKind < 0.06 ? rowCapacity
            : Math.floor(random() * 40)
    }
    if (random() < 0.05) files.state = {location: Math.floor(random() * locationCount), selected: Math.floor(random() * (rowCapacity + 1)) - 1}
    const stateBefore = files.state
    const locationClick = random() < 0.08 ? Math.floor(random() * locationCount) : null
    const rowCount = rowCounts[locationClick ?? stateBefore.location]!
    const viewportKind = random()
    const viewportHeight = viewportKind < 0.05 ? 0
      : viewportKind < 0.1 ? maximumViewportHeight
        : viewportKind < 0.6 ? onPixelGrid(random() * 1200)
          : viewportKind < 0.8 ? Math.floor(random() * 1200)
            : onPixelGrid(random() * maximumViewportHeight)
    const totalHeight = rowCount * rowHeight
    const scrollKind = random()
    const scrollTop = Math.max(0, Math.min(maximumScrollTop,
      // Next to a row's top edge, next to the last position for this viewport, at
      // the end of the rows, at the top, at the end of the cell's range, or anywhere.
      scrollKind < 0.2 ? Math.floor(random() * Math.max(1, rowCount)) * rowHeight + pick([-scrollGrid, 0, scrollGrid, rowHeight - scrollGrid])
        : scrollKind < 0.3 ? totalHeight - Math.floor(viewportHeight) + (Math.floor(random() * 9) - 4) * scrollGrid
          : scrollKind < 0.35 ? totalHeight
            : scrollKind < 0.4 ? 0
              : scrollKind < 0.45 ? maximumScrollTop
                : onScrollGrid(random() * (totalHeight + 1))))
    let listClickY: number | null = null
    if (random() < 0.3) {
      // Within 1/64 px of a row's edge at this scroll position, or anywhere from a
      // little above the viewport to a little below it.
      listClickY = random() < 0.4
        ? Math.floor(random() * 40) * rowHeight - scrollTop % rowHeight + pick([-pixelGrid, 0, pixelGrid])
        : onPixelGrid((random() * 1.2 - 0.1) * Math.max(64, viewportHeight))
      listClickY = Math.max(-49_152, Math.min(49_152, listClickY))
    }
    const key = random() < 0.3 ? pick(keys) : null
    const input: ReferenceFrame = {viewportHeight, scrollTop, rowCounts, focused: random() < 0.9, listClickY, locationClick, key}
    const expected = referenceFiles(stateBefore, input)
    const {output, table} = files.step(input)
    const difference = differenceFromReference(output, expected)
    assert.equal(difference, undefined, `frame ${frame}: ${difference} for ${JSON.stringify({input, stateBefore})}`)
    assert.deepEqual(files.state, {location: expected.location, selected: expected.selected}, `frame ${frame}: the stored state`)

    const locationChanged = expected.location !== stateBefore.location
    counts.shownLocations.add(expected.location)
    if (locationChanged) {
      counts.locationChanges++
      if (expected.scroll > 0) counts.locationChangesWhileScrolled++
      if (key !== null || listClickY !== null) counts.locationChangesWithAKeyOrARelease++
    } else if (locationClick !== null) {
      counts.clicksOnTheShownLocation++
    }
    if (listClickY !== null && !locationChanged) {
      counts.clicks++
      if (key !== null) counts.clickAndKey++
      const clickedRow = expected.firstVisible + Math.floor((Math.max(0, listClickY) + expected.scroll % rowHeight) / rowHeight)
      if (clickedRow >= rowCount) counts.clicksBelowTheLastRow++
      else if (key === null && expected.selected !== stateBefore.selected) counts.clicksThatChangedTheSelection++
    }
    if (key !== null && !locationChanged) {
      if (expected.keyActive) counts.keys.set(key, (counts.keys.get(key) ?? 0) + 1)
      if (expected.keyActive && listClickY === null && stateBefore.selected === -1) counts.keysFromNoSelection++
      if (!input.focused) counts.keysWhileNotFocused++
    }
    if (expected.scrollRequest) counts.scrollRequests++
    if (expected.slotOverflow) counts.slotOverflows++
    if (scrollTop % rowHeight === 0 || scrollTop % rowHeight === rowHeight - scrollGrid) counts.scrollAtARowEdge++
    if (expected.scroll !== scrollTop) counts.scrollPastTheEnd++
    if (rowCount === 0) counts.emptyLists++
    if (stateBefore.selected > rowCount - 1) counts.selectionsPastTheEnd++
    // A key that applies while the same evaluation shows another location: the
    // program computes the scroll position for the key's row, and then asks for
    // the top instead.
    const keyWithLocationChange = locationChanged && expected.keyActive
    if (keyWithLocationChange) counts.keysWithALocationChange++
    if (frame % 250 === 0 || keyWithLocationChange) {
      // Every declared and inferred grid and range holds on the evaluated values,
      // and the compiled program returns the literal instruction evaluator's values.
      const {circuit} = files.program
      const values = circuit.evaluateReference(table)
      validateGrids(circuit, values)
      validateRanges(circuit, values)
      const tensorValues = circuit.evaluateTensor(table)
      for (let wire = 0; wire < values.length; wire++) assert.equal(tensorValues[wire], values[wire], `wire ${wire}`)
      counts.gridChecks++
    }
  }
  // The frames reached every case.
  for (const key of keys) assert.ok((counts.keys.get(key) ?? 0) >= 1_000, `${counts.keys.get(key)} ${key} keys`)
  assert.equal(counts.shownLocations.size, locationCount)
  for (const [name, least] of [
    ['clicks', 15_000], ['clicksThatChangedTheSelection', 5_000], ['clicksBelowTheLastRow', 1_000], ['keysFromNoSelection', 200],
    ['keysWhileNotFocused', 1_000], ['clickAndKey', 3_000], ['scrollRequests', 5_000], ['slotOverflows', 5_000],
    ['scrollAtARowEdge', 10_000], ['scrollPastTheEnd', 10_000], ['emptyLists', 1_000], ['selectionsPastTheEnd', 1_000],
    ['locationChanges', 2_000], ['locationChangesWhileScrolled', 1_500], ['clicksOnTheShownLocation', 1_000],
    ['locationChangesWithAKeyOrARelease', 1_000], ['keysWithALocationChange', 500], ['gridChecks', 740],
  ] as const) {
    assert.ok(counts[name] >= least, `${counts[name]} ${name}, expected at least ${least}`)
  }
}, 30_000)

test('at every quarter pixel around row tops and at both ends of 100,000 rows, the slots and the row under a release equal the reference', () => {
  const files = createStandaloneFiles()
  const viewportHeight = 266
  let checked = 0
  const check = (scrollTop: number) => {
    if (scrollTop < 0 || scrollTop > maximumScrollTop) return
    // A release in the middle of the viewport selects a row at every position.
    const input: ReferenceFrame = {
      viewportHeight, scrollTop, rowCounts: [rowCapacity, rowCapacity, rowCapacity], focused: true, listClickY: viewportHeight / 2, locationClick: null, key: null,
    }
    const expected = referenceFiles(files.state, input)
    const difference = differenceFromReference(files.step(input).output, expected)
    assert.equal(difference, undefined, `scrollTop ${scrollTop}: ${difference}`)
    checked++
  }
  // Every quarter pixel of the first 40 rows and of the last 40.
  for (let scrollTop = 0; scrollTop <= 40 * rowHeight; scrollTop += scrollGrid) check(scrollTop)
  for (let scrollTop = maximumScrollTop - 40 * rowHeight; scrollTop <= maximumScrollTop; scrollTop += scrollGrid) check(scrollTop)
  // A quarter pixel either side of the top of every 7th row, and of every row in
  // the first and last 2,000, where a rounded quotient that is off by one would
  // show.
  for (let row = 0; row <= rowCapacity; row += row < 2_000 || row >= rowCapacity - 2_000 ? 1 : 7) {
    for (const offset of [-scrollGrid, 0, scrollGrid]) check(row * rowHeight + offset)
  }
  assert.ok(checked > 60_000, `${checked} positions checked`)
}, 60_000)

test('Files builds only integer bits and marked rounding points, and no sign cascade', () => {
  const {circuit} = createFilesCircuit()
  const kinds = new Map<string, number>()
  for (const point of circuit.roundingPoints()) kinds.set(point.kind, (kinds.get(point.kind) ?? 0) + 1)
  assert.equal(kinds.get('sign cascade') ?? 0, 0)
  assert.equal(kinds.get('boolean') ?? 0, 0)
  assert.ok((kinds.get('integer bit') ?? 0) > 400, `${kinds.get('integer bit')} integer bit operations`)
  // Two per rounded quotient or rounded height.
  assert.equal(kinds.get('marked'), 14)
  assert.equal(circuit.oneHotGroups.length, 0)
})

// ---------- Files inside HandwiredOS's machine ----------

const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16
// Files is window 0 at 54,54 520×340, so its content box starts at (55, 99) and is
// 518×294. The list viewport is the content box right of the 132 px sidebar, below
// the 28 px header row and left of the 16 px scrollbar strip: x from 187 to 557 and
// y from 127 to 393, 266 px tall.
const list = {left: 187, top: 127, right: 557, bottom: 393, height: 266}
// The center of a location's sidebar item: the items are 116×28, 8 px from the
// content box's left edge, and the first one starts 40 px below its top edge.
const locationPoint = (location: number) => ({x: 55 + 8 + 58, y: 99 + 40 + 28 * location + 14})
// Points on the title bars of Files and Notes that no other window covers.
const filesTitleBar = {x: 100, y: 76}
const notesTitleBar = {x: 800, y: 126}
// At 1280×800: Files' minimize, maximize and close buttons, and its dock item.
const filesMinimize = {x: 499, y: 76}
const filesMaximize = {x: 527, y: 76}
const filesClose = {x: 555, y: 76}
// The maximize button of a maximized window, which is at 12,48 and 1256×664.
const maximizedMaximize = {x: 1221, y: 70}
const filesDockItem = {x: 547, y: 762}

type Machine = ReturnType<typeof createWindowManagerMachine>
const frameTimeByMachine = new WeakMap<Machine, number>()

// A machine whose first frame ran, optionally with another row count for the
// Operations location, which a host writes before the first step.
function createMachine(operationsRowCount?: number) {
  const machine = createWindowManagerMachine()
  if (operationsRowCount !== undefined) machine.source[machine.cells.files.rowCounts[operationsLocation]!] = operationsRowCount
  step(machine)
  return machine
}

// The next frame, 16 ms after the last one. Without scrollTop, the list stays where
// the last step left it.
function step(machine: Machine, scrollTop?: number, width = viewportWidth, height = viewportHeight) {
  const frameTime = (frameTimeByMachine.get(machine) ?? 0) + frameDuration
  frameTimeByMachine.set(machine, frameTime)
  return machine.step(width, height, frameTime, scrollTop)
}

// A time offsetMs after the last frame, before the next one.
function eventTime(machine: Machine, offsetMs: number) {
  return (frameTimeByMachine.get(machine) ?? 0) + offsetMs
}

// A press and a release 4 ms later, then a frame.
function click(machine: Machine, point: {x: number, y: number}, release = point, scrollTop?: number) {
  machine.pointerDown(point.x, point.y, eventTime(machine, 4))
  machine.pointerUp(release.x, release.y, eventTime(machine, 8))
  return step(machine, scrollTop)
}

function pressKey(machine: Machine, key: Key, scrollTop?: number) {
  machine.filesKey(key, eventTime(machine, 4))
  return step(machine, scrollTop)
}

// A point on a row at a scroll position, 100 px from the list's left edge and
// `inset` px below the row's top edge.
function rowPoint(row: number, scrollTop = 0, inset = rowHeight / 2) {
  return {x: list.left + 100, y: list.top + row * rowHeight - scrollTop + inset}
}

const selectedRow = (machine: Machine) => machine.source[machine.cells.files.selected]!
const shownLocation = (machine: Machine) => machine.cells.files.location.findIndex(cell => machine.source[cell] === 1)
const rowCountsOf = (machine: Machine) => machine.cells.files.rowCounts.map(cell => machine.source[cell]!)
// The row count of the location that the list shows.
const rowCountOf = (machine: Machine) => rowCountsOf(machine)[shownLocation(machine)]!

// Files' outputs in the frame's values, in the form that differenceFromReference reads.
function filesOutput(machine: Machine, values: Float32Array): StandaloneOutput {
  const output = machine.output.files
  return {
    totalHeight: values[output.totalHeight]!,
    scroll: values[output.scroll]!,
    scrollTarget: values[output.scrollTarget]!,
    scrollRequest: values[output.scrollRequest]!,
    slotOverflow: values[output.slotOverflow]!,
    selected: values[output.selected]!,
    locations: output.locations.map(wire => values[wire]!),
    slots: output.slots.map(wire => values[wire]!),
  }
}

// The rows that have a DOM node in a frame's values, in row order.
function drawnRows(machine: Machine, values: Float32Array) {
  const {slots} = filesOutput(machine, values)
  const rows: {row: number, top: number, selected: number}[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const read = (field: number) => slots[slot * slotField.size + field]!
    if (read(slotField.present) === 1) rows.push({row: read(slotField.row), top: read(slotField.top), selected: read(slotField.selected)})
  }
  return rows.sort((left, right) => left.row - right.row)
}

// A frame without events draws what the reference draws for the same scroll
// position, viewport height and selection.
function assertDrawsLikeReference(machine: Machine, values: Float32Array, scrollTop: number, listViewportHeight: number) {
  const expected = referenceFiles({location: shownLocation(machine), selected: selectedRow(machine)}, {
    viewportHeight: listViewportHeight, scrollTop, rowCounts: rowCountsOf(machine), focused: true, listClickY: null, locationClick: null, key: null,
  })
  assert.equal(differenceFromReference(filesOutput(machine, values), expected), undefined)
  return expected
}

const focusedWindow = (machine: Machine, values: Float32Array) =>
  [0, 1, 2, 3].find(windowIndex => values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!] === 1) ?? -1

test("the three locations' row counts are the program's own numbers of source cells, live operations and outputs, and the first frame draws Operations from the top", () => {
  const machine = createWindowManagerMachine()
  const program = machine.tensorProgram
  const values = step(machine)
  assert.deepEqual(rowCountsOf(machine), [program.sourceSize, program.valueCount - program.sourceSize, program.roots.length - program.sourceSize])
  assert.deepEqual([machine.sourceCells.length, machine.namedOutputs.length], [rowCountsOf(machine)[stateLocation], rowCountsOf(machine)[outputsLocation]])
  assert.equal(shownLocation(machine), operationsLocation)
  assert.ok(rowCountOf(machine) > 14_000)
  assert.equal(values[machine.output.files.totalHeight], rowCountOf(machine) * rowHeight)
  // 266 px hold 12 rows, the last one partly, and 2 more are drawn below the view.
  assert.deepEqual(drawnRows(machine, values).map(row => row.row), Array.from({length: 14}, (_, row) => row))
  assertDrawsLikeReference(machine, values, 0, list.height)
  assert.equal(selectedRow(machine), -1)
})

test('a release over the list after a press on the list selects the row under the release, and a press alone selects nothing', () => {
  const machine = createMachine()
  // The press arms the list and selects nothing yet.
  machine.pointerDown(rowPoint(4).x, rowPoint(4).y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[armedSourceField('filesList')], 1)
  assert.equal(selectedRow(machine), -1)
  // The release is over row 6, which becomes the selected row.
  machine.pointerUp(rowPoint(6).x, rowPoint(6).y, eventTime(machine, 4))
  let values = step(machine)
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  assert.equal(selectedRow(machine), 6)
  assert.deepEqual(drawnRows(machine, values).filter(row => row.selected === 1).map(row => row.row), [6])
  // A press and a release at one timestamp select too.
  machine.pointerDown(rowPoint(2).x, rowPoint(2).y, eventTime(machine, 4))
  machine.pointerUp(rowPoint(2).x, rowPoint(2).y, eventTime(machine, 4))
  step(machine)
  assert.equal(selectedRow(machine), 2)
  // A row's edges: 1/64 px below a row's top edge is that row, and 1/64 px above the
  // edge is the row before.
  click(machine, rowPoint(5, 0, 1 / 64))
  assert.equal(selectedRow(machine), 5)
  click(machine, rowPoint(5, 0, -1 / 64))
  assert.equal(selectedRow(machine), 4)

  // Releases that select nothing: off the list after a press on a row, i.e. on the
  // header row, on the scrollbar strip, on the sidebar, on the title bar and outside
  // the window; on a row after a press on the header row, on the scrollbar strip or
  // on the sidebar; and a pointercancel over a row.
  const header = {x: list.left + 100, y: list.top - 10}
  const scrollbar = {x: list.right + 8, y: list.top + 100}
  const sidebar = {x: list.left - 40, y: list.top + 150}
  for (const [press, release] of [
    [rowPoint(8), header], [rowPoint(8), scrollbar], [rowPoint(8), sidebar], [rowPoint(8), filesTitleBar], [rowPoint(8), {x: 30, y: 600}],
    [header, rowPoint(8)], [scrollbar, rowPoint(8)], [sidebar, rowPoint(8)],
  ] as const) {
    click(machine, press, release)
    assert.equal(selectedRow(machine), 4, `a press at ${JSON.stringify(press)} released at ${JSON.stringify(release)}`)
    assert.equal(machine.source[armedSourceField('filesList')], 0)
  }
  machine.pointerDown(scrollbar.x, scrollbar.y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  machine.pointerUp(scrollbar.x, scrollbar.y, eventTime(machine, 4))
  machine.pointerDown(rowPoint(8).x, rowPoint(8).y, eventTime(machine, 8))
  machine.pointerCancel(rowPoint(8).x, rowPoint(8).y, eventTime(machine, 12))
  values = step(machine)
  assert.equal(selectedRow(machine), 4)
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  // The list's edges: a release at least half a pixel inside the list selects, like
  // every hit test of the window manager.
  click(machine, rowPoint(1), {x: list.left + 0.5, y: list.top + 0.5})
  assert.equal(selectedRow(machine), 0)
  click(machine, rowPoint(1), {x: list.left + 100, y: list.bottom - 0.5})
  assert.equal(selectedRow(machine), 11)
  click(machine, rowPoint(1), {x: list.right - 0.5, y: list.top + 60})
  assert.equal(selectedRow(machine), 2)
  for (const outside of [
    {x: list.left + 0.5 - 1 / 64, y: list.top + 100}, {x: list.left + 100, y: list.top + 0.5 - 1 / 64},
    {x: list.right - 0.5 + 1 / 64, y: list.top + 100}, {x: list.left + 100, y: list.bottom - 0.5 + 1 / 64},
  ]) {
    click(machine, rowPoint(1), outside)
    assert.equal(selectedRow(machine), 2, `a release at ${JSON.stringify(outside)}`)
  }
  // The window's grip covers the list's bottom-right corner, and a release over the
  // grip isn't over the list.
  click(machine, rowPoint(1), {x: list.right - 0.5, y: list.bottom - 0.5})
  assert.equal(selectedRow(machine), 2)
  assert.equal(focusedWindow(machine, values), 0)
})

test('a release below the last row of a short list selects nothing', () => {
  const machine = createMachine(3)
  click(machine, rowPoint(1))
  assert.equal(selectedRow(machine), 1)
  click(machine, rowPoint(3))
  assert.equal(selectedRow(machine), 1)
  const values = click(machine, rowPoint(2))
  assert.equal(selectedRow(machine), 2)
  assert.deepEqual(drawnRows(machine, values).map(row => row.row), [0, 1, 2])
})

test('a press reaches a row only when Files is the frontmost window at that point, so a row covered by another window is not selected', () => {
  const machine = createMachine()
  // (500, 300) is inside Files' list and inside Notes, which starts above Files.
  const covered = {x: 500, y: 300}
  let values = click(machine, covered)
  assert.equal(selectedRow(machine), -1)
  assert.equal(focusedWindow(machine, values), 1)
  // Row 4's point is inside Files only: the press raises Files, and the release selects.
  values = click(machine, rowPoint(4))
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 0)
  // With Files in front, the same point is on row 7.
  click(machine, covered)
  assert.equal(selectedRow(machine), 7)
  // Notes in front again: the press and the release go to Notes.
  click(machine, notesTitleBar)
  values = click(machine, covered)
  assert.equal(selectedRow(machine), 7)
  assert.equal(focusedWindow(machine, values), 1)
  // A press on a row of the list, released over the part that Notes would cover if
  // Notes were in front, still selects: the press raised Files.
  click(machine, rowPoint(4), covered)
  assert.equal(selectedRow(machine), 7)
  click(machine, rowPoint(2), {x: 420, y: 140})
  assert.equal(selectedRow(machine), 0)
})

test('a release on a sidebar location after a press on it shows that location: its row count, no selection, and the list at the top', () => {
  const machine = createMachine()
  const [stateRows, operationsRows, outputsRows] = rowCountsOf(machine)
  let values = click(machine, rowPoint(4))
  assert.equal(selectedRow(machine), 4)
  // The press arms the location and changes nothing yet.
  const point = locationPoint(stateLocation)
  machine.pointerDown(point.x, point.y, eventTime(machine, 4))
  values = step(machine)
  assert.equal(machine.source[armedSourceField('filesLocation', stateLocation)], 1)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [operationsLocation, 4])
  machine.pointerUp(point.x, point.y, eventTime(machine, 4))
  values = step(machine)
  assert.equal(machine.source[armedSourceField('filesLocation', stateLocation)], 0)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [stateLocation, -1])
  assert.equal(values[machine.output.files.totalHeight], stateRows! * rowHeight)
  assert.deepEqual(machine.output.files.locations.map(wire => values[wire]), [1, 0, 0])
  // The list was at the top already, so the program asks for no scroll.
  assert.equal(machine.filesScrollTo, null)
  assertDrawsLikeReference(machine, values, 0, list.height)
  // A row of the new location, then the location again: the same location keeps its
  // selection.
  click(machine, rowPoint(2))
  click(machine, point)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [stateLocation, 2])
  // Releases that show no other location: on another location than the pressed
  // one, off the sidebar, a pointercancel, and a release on a location after a
  // press on a row.
  for (const [press, release] of [
    [locationPoint(outputsLocation), locationPoint(operationsLocation)], [locationPoint(outputsLocation), rowPoint(1)], [rowPoint(1), locationPoint(outputsLocation)],
  ] as const) {
    click(machine, press, release)
    assert.equal(shownLocation(machine), stateLocation, `a press at ${JSON.stringify(press)} released at ${JSON.stringify(release)}`)
  }
  machine.pointerDown(locationPoint(outputsLocation).x, locationPoint(outputsLocation).y, eventTime(machine, 4))
  machine.pointerCancel(locationPoint(outputsLocation).x, locationPoint(outputsLocation).y, eventTime(machine, 8))
  step(machine)
  assert.equal(shownLocation(machine), stateLocation)
  // The items' edges: half a pixel inside the last item's bottom edge is that
  // item, and the heading above the first item is no location.
  click(machine, {x: 55 + 8 + 0.5, y: 99 + 40 + 3 * 28 - 0.5})
  assert.equal(shownLocation(machine), outputsLocation)
  click(machine, {x: 55 + 8 + 58, y: 99 + 40 - 0.5 + 1 / 64})
  click(machine, {x: 55 + 8 + 0.5 - 1 / 64, y: 99 + 40 + 14})
  click(machine, {x: 55 + 8 + 58, y: 99 + 40 + 3 * 28 - 0.5 + 1 / 64})
  assert.equal(shownLocation(machine), outputsLocation)
  values = step(machine)
  assert.equal(values[machine.output.files.totalHeight], outputsRows! * rowHeight)

  // From a scrolled list with a selection, another location starts at the top: the
  // program asks the host to scroll to 0, and the frame of the same step already
  // draws the new location's first rows.
  click(machine, locationPoint(operationsLocation))
  const scrolled = 100_000
  click(machine, rowPoint(4170, scrolled), undefined, scrolled)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [operationsLocation, 4170])
  values = click(machine, locationPoint(outputsLocation), undefined, scrolled)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [outputsLocation, -1])
  assert.equal(machine.filesScrollTo, 0)
  assert.equal(values[machine.output.files.scroll], 0)
  assert.equal(values[machine.output.files.totalHeight], outputsRows! * rowHeight)
  assert.deepEqual(drawnRows(machine, values).map(row => row.row), Array.from({length: 14}, (_, row) => row))
  assert.ok(operationsRows! > outputsRows! && outputsRows! > stateRows!)
  // A key in the same evaluation as the release that shows another location
  // doesn't select: the new location starts with no selection.
  click(machine, filesTitleBar)
  machine.pointerDown(locationPoint(stateLocation).x, locationPoint(stateLocation).y, eventTime(machine, 4))
  machine.pointerUp(locationPoint(stateLocation).x, locationPoint(stateLocation).y, eventTime(machine, 8))
  machine.filesKey('end', eventTime(machine, 8))
  step(machine)
  assert.deepEqual([shownLocation(machine), selectedRow(machine)], [stateLocation, -1])
  // The next key acts in the new location: End selects State's last row.
  pressKey(machine, 'end')
  assert.equal(selectedRow(machine), stateRows! - 1)
  assert.equal(machine.filesScrollTo, stateRows! * rowHeight - list.height)
})

test('a sidebar location covered by another window, or in a minimized Files, takes no press', () => {
  const machine = createMachine()
  // Drag Notes by its title bar over Files' sidebar: Notes moves from 410,104 to 60,84.
  machine.pointerDown(notesTitleBar.x, notesTitleBar.y, eventTime(machine, 4))
  machine.pointerMove(notesTitleBar.x - 350, notesTitleBar.y - 20, eventTime(machine, 8))
  machine.pointerUp(notesTitleBar.x - 350, notesTitleBar.y - 20, eventTime(machine, 12))
  let values = step(machine)
  assert.equal(machine.source[windowSourceField(1, windowStateField.left)], 60)
  click(machine, locationPoint(stateLocation))
  assert.equal(shownLocation(machine), operationsLocation)
  // Files' title bar is still free at x 100: raise Files, and the location takes the press.
  click(machine, {x: 57, y: 76})
  click(machine, locationPoint(stateLocation))
  assert.equal(shownLocation(machine), stateLocation)
  values = click(machine, filesMinimize)
  for (let frame = 0; frame < 60; frame++) values = step(machine)
  click(machine, locationPoint(outputsLocation))
  assert.equal(shownLocation(machine), stateLocation)
  assert.notEqual(focusedWindow(machine, values), 0)
})

test('ArrowUp, ArrowDown, PageUp, PageDown, Home and End move the selection only while Files is the focused window', () => {
  const machine = createMachine()
  const lastRow = rowCountOf(machine) - 1
  // Photos starts focused, and no key reaches Files.
  for (const key of keys) pressKey(machine, key)
  assert.equal(selectedRow(machine), -1)
  // Files takes focus with a press and a release on its title bar.
  let values = click(machine, filesTitleBar)
  assert.equal(focusedWindow(machine, values), 0)
  // From no selection, ArrowDown selects the row at the top of the view. 266 px hold
  // 11 whole rows, which is one page.
  const expected: [Key, number][] = [
    ['down', 0], ['down', 1], ['down', 2], ['up', 1], ['pageDown', 12], ['pageDown', 23], ['pageUp', 12], ['pageUp', 1],
    ['pageUp', 0], ['up', 0], ['end', lastRow], ['down', lastRow], ['pageDown', lastRow], ['pageUp', lastRow - 11], ['home', 0],
  ]
  for (const [key, row] of expected) {
    values = pressKey(machine, key)
    assert.equal(selectedRow(machine), row, `after ${key}`)
  }
  // Notes takes focus, and the keys change nothing.
  click(machine, notesTitleBar)
  for (const key of keys) pressKey(machine, key)
  assert.equal(selectedRow(machine), 0)
  // A key in the same evaluation as the press that focuses Files applies, since
  // Files is focused after that evaluation's events.
  machine.pointerDown(filesTitleBar.x, filesTitleBar.y, eventTime(machine, 4))
  machine.filesKey('down', eventTime(machine, 4))
  step(machine)
  assert.equal(selectedRow(machine), 1)

  // From no selection at scroll position 1000, where row 41 is at the top of the
  // view with its first 16 px above it, each of the four relative keys selects row 41.
  for (const key of ['up', 'down', 'pageUp', 'pageDown'] as const) {
    const scrolled = createMachine()
    click(scrolled, filesTitleBar)
    step(scrolled, 1000)
    pressKey(scrolled, key)
    assert.equal(selectedRow(scrolled), 41, key)
    // The program asks for the position that shows the whole row.
    assert.equal(scrolled.filesScrollTo, 41 * rowHeight)
  }
}, 30_000)

test('after a key that moves the selection out of view, the program asks the host to scroll, and draws the list at the requested position from that step on', () => {
  const machine = createMachine()
  const totalHeight = rowCountOf(machine) * rowHeight
  click(machine, filesTitleBar)
  click(machine, rowPoint(10))
  assert.equal(machine.filesScrollTo, null)
  // Row 10 ends at 264 px, inside the 266 px viewport. ArrowDown selects row 11,
  // which ends at 288 px, so the list has to scroll by 22 px.
  let values = pressKey(machine, 'down', 0)
  assert.equal(machine.filesScrollTo, 12 * rowHeight - list.height)
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [['events', ['files key']], ['frame', []]])
  // The frame of the same step already draws the list at that position.
  assert.equal(values[machine.output.files.scroll], 22)
  assert.equal(values[machine.output.files.scrollRequest], 0)
  assertDrawsLikeReference(machine, values, 22, list.height)
  // The next frame reads the position from the scroller, which the host scrolled:
  // no request, and the same rows.
  values = step(machine, 22)
  assert.equal(machine.filesScrollTo, null)
  assertDrawsLikeReference(machine, values, 22, list.height)
  // A key that leaves the selection in view asks for nothing.
  pressKey(machine, 'up', 22)
  assert.equal(selectedRow(machine), 10)
  assert.equal(machine.filesScrollTo, null)
  // ArrowUp past the top edge scrolls up to the row's top.
  click(machine, rowPoint(1, 22), undefined, 22)
  assert.equal(selectedRow(machine), 1)
  pressKey(machine, 'up', 22)
  assert.equal(machine.filesScrollTo, 0)

  // End asks for the last position of the list, and the frame draws the last rows.
  values = pressKey(machine, 'end', 0)
  assert.equal(machine.filesScrollTo, totalHeight - list.height)
  const rows = drawnRows(machine, values)
  assert.equal(rows.at(-1)!.row, rowCountOf(machine) - 1)
  assert.equal(rows.at(-1)!.selected, 1)
  assertDrawsLikeReference(machine, values, totalHeight - list.height, list.height)
  // A scroller that keeps another position than the requested one, e.g. half a
  // pixel less, is read like any scroll: the next frame draws the list there.
  values = step(machine, totalHeight - list.height - 0.5)
  assert.equal(machine.filesScrollTo, null)
  assertDrawsLikeReference(machine, values, totalHeight - list.height - 0.5, list.height)
  // Two keys in one frame: the second key's evaluation reads the position that the
  // first key asked for.
  machine.filesKey('home', eventTime(machine, 4))
  machine.filesKey('pageDown', eventTime(machine, 8))
  values = step(machine, totalHeight - list.height)
  assert.equal(selectedRow(machine), 11)
  assert.equal(machine.filesScrollTo, 12 * rowHeight - list.height)
  assert.equal(values[machine.output.files.scroll], 12 * rowHeight - list.height)
})

test('maximizing Files at the end of the list draws the rows for the new viewport in the same step, without asking for a scroll', () => {
  const machine = createMachine()
  const totalHeight = rowCountOf(machine) * rowHeight
  const end = totalHeight - list.height
  let values = step(machine, end)
  assertDrawsLikeReference(machine, values, end, list.height)
  // The release of the maximize button gives the list its maximized viewport, 590 px:
  // the 1256×664 window's content box is 618 px tall, minus the header row. The
  // scroller still reports the old position, which is past the new last position,
  // so the program draws the list at the new last position.
  values = click(machine, filesMaximize, undefined, end)
  assert.equal(machine.source[windowSourceField(0, windowStateField.maximized)], 1)
  const maximizedHeight = 664 - 46 - 28
  assert.equal(values[machine.output.files.scroll], totalHeight - maximizedHeight)
  assert.equal(machine.filesScrollTo, null)
  const expected = assertDrawsLikeReference(machine, values, end, maximizedHeight)
  assert.equal(expected.drawn.at(-1)!.row, rowCountOf(machine) - 1)
  assert.equal(expected.drawn.length, Math.ceil(maximizedHeight / rowHeight) + overscanRows)
  // Restoring the window keeps the position that the browser clamped to.
  values = click(machine, maximizedMaximize, undefined, totalHeight - maximizedHeight)
  assert.equal(machine.source[windowSourceField(0, windowStateField.maximized)], 0)
  assertDrawsLikeReference(machine, values, totalHeight - maximizedHeight, list.height)
})

test("resizing Files with its grip changes the rows drawn, and the list's hit rectangle follows the window", () => {
  const machine = createMachine()
  // Notes covers Files' grip until Files is raised.
  click(machine, filesTitleBar)
  // Drag the grip at the window's bottom-right corner 100 px right and 120 px down:
  // Files becomes 620×460, and its list viewport 386 px tall.
  const grip = {x: 54 + 520 - 12, y: 54 + 340 - 12}
  machine.pointerDown(grip.x, grip.y, eventTime(machine, 4))
  machine.pointerMove(grip.x + 100, grip.y + 120, eventTime(machine, 8))
  machine.pointerUp(grip.x + 100, grip.y + 120, eventTime(machine, 12))
  let values = step(machine)
  assert.deepEqual([machine.source[windowSourceField(0, windowStateField.width)], machine.source[windowSourceField(0, windowStateField.height)]], [620, 460])
  assert.equal(selectedRow(machine), -1)
  const expected = assertDrawsLikeReference(machine, values, 0, list.height + 120)
  assert.equal(expected.drawn.length, Math.ceil(386 / rowHeight) + overscanRows)
  // Row 15 lies below the old viewport, and x 600 right of the old list.
  click(machine, {x: 600, y: rowPoint(15).y})
  assert.equal(selectedRow(machine), 15)
  // The scrollbar strip moved with the window's right edge.
  click(machine, {x: list.right + 100 + 8, y: rowPoint(3).y})
  assert.equal(selectedRow(machine), 15)
  // A grip press that ends over a row selects nothing, like a resize that ends over a photo.
  machine.pointerDown(grip.x + 100, grip.y + 120, eventTime(machine, 4))
  machine.pointerMove(grip.x + 100, grip.y + 120 - 200, eventTime(machine, 8))
  machine.pointerUp(grip.x + 100, grip.y + 120 - 200, eventTime(machine, 12))
  values = step(machine)
  assert.equal(machine.source[windowSourceField(0, windowStateField.height)], 260)
  assert.equal(selectedRow(machine), 15)
  // The shorter viewport draws fewer rows, and the selected row is out of view.
  assertDrawsLikeReference(machine, values, 0, 260 - 46 - 28)
  // A release over the grip after a press on a row selects nothing either.
  click(machine, rowPoint(2), {x: 54 + 620 - 20, y: 54 + 260 - 4})
  assert.equal(selectedRow(machine), 15)
  // The grip's 24 px square reaches 7 px into the list's rectangle. A press there
  // starts a resize and doesn't arm the list. Dragged up and left until Files stops
  // at its minimum size, 280×190, the release is over row 3 of the smaller list and
  // off the grip, and it selects nothing.
  const gripInsideList = {x: 54 + 620 - 21, y: 54 + 260 - 12}
  machine.pointerDown(gripInsideList.x, gripInsideList.y, eventTime(machine, 4))
  step(machine)
  assert.deepEqual([machine.source[resizeSourceField(0)], machine.source[armedSourceField('filesList')]], [1, 0])
  machine.pointerMove(rowPoint(3).x, rowPoint(3).y, eventTime(machine, 4))
  machine.pointerUp(rowPoint(3).x, rowPoint(3).y, eventTime(machine, 8))
  step(machine)
  assert.deepEqual([machine.source[windowSourceField(0, windowStateField.width)], machine.source[windowSourceField(0, windowStateField.height)]], [280, 190])
  assert.equal(selectedRow(machine), 15)
  // The same point selects row 3 after a press on the list.
  click(machine, rowPoint(3))
  assert.equal(selectedRow(machine), 3)
})

test('while Files is minimized or closed, it takes no release and no key, and it keeps its selection for when it comes back', () => {
  for (const control of [filesMinimize, filesClose]) {
    const machine = createMachine()
    click(machine, rowPoint(3))
    assert.equal(selectedRow(machine), 3)
    let values = click(machine, control)
    assert.notEqual(focusedWindow(machine, values), 0)
    // The window flies to the dock: a press and a release where its list was reach
    // the desktop, and keys reach no list.
    values = click(machine, rowPoint(7))
    pressKey(machine, 'down')
    assert.equal(selectedRow(machine), 3)
    assert.notEqual(focusedWindow(machine, values), 0)
    for (let frame = 0; frame < 60; frame++) step(machine)
    click(machine, rowPoint(7))
    pressKey(machine, 'end')
    assert.equal(selectedRow(machine), 3)
    // The dock item brings Files back with its selection, and the list takes input again.
    values = click(machine, filesDockItem)
    assert.equal(focusedWindow(machine, values), 0)
    assert.equal(selectedRow(machine), 3)
    assert.deepEqual(drawnRows(machine, values).filter(row => row.selected === 1).map(row => row.row), [3])
    pressKey(machine, 'down')
    assert.equal(selectedRow(machine), 4)
    click(machine, rowPoint(7))
    assert.equal(selectedRow(machine), 7)
  }
})

test('at 100,000 rows, a release 2,399,000 px down the list selects the exact row for a pointer on the 1/64 px grid', () => {
  const machine = createMachine(rowCapacity)
  click(machine, filesTitleBar)
  const scrollTop = 2_399_000
  let values = step(machine, scrollTop)
  assertDrawsLikeReference(machine, values, scrollTop, list.height)
  // 2,399,000 + 100.984375 isn't an FP32 value, so the program can't add a release's
  // y to the scroll position. Row 99,962 starts at 2,399,088 px, 88 px into the view.
  for (const [y, row] of [[100.984375, 99_962], [88, 99_962], [88 - 1 / 64, 99_961], [112 - 1 / 64, 99_962], [112, 99_963]] as const) {
    values = click(machine, {x: list.left + 100.015625, y: list.top + y}, undefined, scrollTop)
    assert.equal(selectedRow(machine), row, `a release ${y} px into the list`)
    assert.equal(Math.floor((y + scrollTop) / rowHeight), row)
  }
  // Scroll positions on the quarter pixel grid around a row's top.
  for (const offset of [-0.25, 0, 0.25]) {
    const position = 99_000 * rowHeight + offset
    values = step(machine, position)
    const expected = assertDrawsLikeReference(machine, values, position, list.height)
    assert.equal(expected.firstVisible, offset < 0 ? 98_999 : 99_000)
  }
  values = pressKey(machine, 'end')
  assert.equal(selectedRow(machine), rowCapacity - 1)
  assert.equal(machine.filesScrollTo, maximumScrollTop - list.height)
})

test("the machine floors the scroller's position onto the quarter pixel grid and clamps it into the scroll cell's range, so a rubber-band's position is safe", () => {
  const machine = createMachine()
  const totalHeight = rowCountOf(machine) * rowHeight
  const scrollCell = machine.cells.files.scrollTop
  // Browsers report positions before the start and past the end while a scroller
  // rubber-bands, and fractions of a device pixel.
  for (const [reported, cell, drawnAt] of [
    [-30.2, 0, 0], [1000.6, 1000.5, 1000.5], [1000.26, 1000.25, 1000.25], [1000.74, 1000.5, 1000.5], [totalHeight + 40, totalHeight + 40, totalHeight - list.height],
    [5_000_000, maximumScrollTop, totalHeight - list.height], [0, 0, 0],
  ] as const) {
    let table: Float32Array | null = null
    machine.observe({
      beforeEvaluate(evaluated) {
        table = evaluated
      },
    })
    const values = step(machine, reported)
    assert.equal(table![scrollCell], cell, `the cell for a reported ${reported}`)
    assert.equal(values[machine.output.files.scroll], drawnAt, `the list's position for a reported ${reported}`)
    // The host never scrolls to a position that the machine only clamped.
    assert.equal(machine.filesScrollTo, null)
  }
  assert.throws(() => step(machine, Number.NaN), /a scroll position must be finite/)
})

test('with more rows in view than DOM slots, 64 rows get a node and slotOverflow is 1', () => {
  const machine = createWindowManagerMachine()
  const tall = 2000
  step(machine, undefined, viewportWidth, tall)
  let values = click(machine, filesMaximize, undefined, undefined)
  // The second frame after the release passes the same viewport.
  values = step(machine, 1200, viewportWidth, tall)
  const maximizedHeight = tall - 36 - 76 - 24 - 46 - 28
  assert.equal(values[machine.output.files.slotOverflow], 1)
  const rows = drawnRows(machine, values)
  assert.equal(rows.length, slotCount)
  const expected = assertDrawsLikeReference(machine, values, 1200, maximizedHeight)
  assert.equal(expected.slotOverflow, true)
  // The rows that get a node are the first 64 from 2 rows above the view.
  assert.deepEqual(rows.map(row => row.row), Array.from({length: slotCount}, (_, index) => 1200 / rowHeight - overscanRows + index))
})

test('HandwiredOS with Files builds no sign cascade, and every declared and inferred grid and range holds on each evaluation of a Files session', () => {
  const machine = createWindowManagerMachine()
  for (const cell of machine.cells.files.rowCounts) machine.source[cell] = rowCapacity
  assert.equal(machine.circuit.roundingPoints().filter(point => point.kind === 'sign cascade').length, 0)
  let evaluations = 0
  // The compiled program's values, with 0 for the wires that the compiler removed,
  // so the ranges are checked on the wires that the program kept.
  machine.observe({
    beforeEvaluate(table) {
      const values = machine.circuit.evaluateTensor(table)
      validateGrids(machine.circuit, values)
      validateRanges(machine.circuit, values, machine.tensorProgram.wireOrder)
      evaluations++
    },
  })
  step(machine)
  click(machine, filesTitleBar)
  const random = createRandom(0x9a1d5)
  for (let frame = 0; frame < 120; frame++) {
    const scrollTop = onScrollGrid(random() * maximumScrollTop)
    const kind = random()
    if (kind < 0.3) click(machine, {x: list.left + onPixelGrid(random() * 400), y: list.top + onPixelGrid(random() * list.height)}, undefined, scrollTop)
    else if (kind < 0.6) pressKey(machine, keys[Math.floor(random() * keys.length)]!, scrollTop)
    else if (kind < 0.7) click(machine, machine.source[windowSourceField(0, windowStateField.maximized)] === 1 ? maximizedMaximize : filesMaximize, undefined, scrollTop)
    else if (kind < 0.8 && machine.source[windowSourceField(0, windowStateField.maximized)] === 0) click(machine, locationPoint(Math.floor(random() * locationCount)), undefined, scrollTop)
    else step(machine, scrollTop, viewportWidth, viewportHeight)
  }
  assert.ok(evaluations > 250, `${evaluations} evaluations checked`)
}, 30_000)

// ---------- what the host shows ----------

test("after a step, the machine's packed values hold every source cell and live operation of the frame's evaluation, and the three locations read their rows from them", () => {
  const machine = createWindowManagerMachine()
  const program = machine.tensorProgram
  let frameTable: Float32Array | null = null
  machine.observe({
    beforeEvaluate(table, evaluation) {
      if (evaluation.kind === 'frame') frameTable = Float32Array.from(table)
    },
  })
  machine.pointerDown(rowPoint(3).x, rowPoint(3).y, 4)
  machine.pointerUp(rowPoint(3).x, rowPoint(3).y, 8)
  const values = step(machine, 480)
  assert.equal(machine.values, values)
  // The compiled program again, on the table that the frame's evaluation ran on.
  const expected = machine.circuit.evaluateTensor(frameTable!)
  assert.equal(machine.packedValues.length, program.valueCount)
  for (let index = 0; index < program.valueCount; index++) {
    assert.equal(machine.packedValues[index], expected[program.wireOrder[index]!], `packed value ${index}`)
  }

  const state = describeState(machine.sourceCells, machine.packedValues)
  assert.equal(state.rowCount, program.sourceSize)
  assert.deepEqual(state.text(0), ['viewportWidth', 'input', '', ''])
  assert.equal(state.value(0), viewportWidth)
  // A cell's name follows its place in the cell declarations, written with dots.
  const row = (name: string) => machine.sourceCells.findIndex(cell => cell.name === name)
  assert.deepEqual(state.text(row('windows[3].left')), ['windows.3.left', 'state', '', ''])
  assert.equal(state.value(row('windows[3].left')), 650)
  assert.deepEqual(state.text(row('springs[0].centerX.velocity')), ['springs.0.centerX.velocity', 'state', '', ''])
  assert.deepEqual(state.text(row('titleHeight')), ['titleHeight', 'constant', '', ''])
  assert.deepEqual(state.text(row('files.keys.down')), ['files.keys.down', 'event', '', ''])
  assert.equal(state.value(row('files.scrollTop')), 480)
  assert.equal(state.value(row('files.selected')), 23)
  assert.deepEqual(new Set(machine.sourceCells.map(cell => cell.policy)), new Set(['constant', 'input', 'event', 'state']))

  const operations = describeOperations(program, machine.packedValues)
  assert.equal(operations.rowCount, program.valueCount - program.sourceSize)
  // Each row's kind is the kind of the operation that the circuit built at the row's
  // wire, under the name and with the class of that kind, the layers go from 1 to the
  // program's layer count in order, and the weights add up to the program's stored
  // weights, which include each ReGLU's gate and each index read's index.
  const kindOf = {
    affine: {name: 'affine', className: 'kind-affine'},
    reglu: {name: 'ReGLU', className: 'kind-reglu'},
    boolean: {name: 'boolean', className: 'kind-boolean'},
    index: {name: 'index read', className: 'kind-index'},
  }
  const kindCounts = new Map<string, number>()
  let weights = 0
  let lastLayer = 1
  for (let operation = 0; operation < operations.rowCount; operation++) {
    const [wire, kind, layer, storedWeights] = operations.text(operation)
    assert.equal(Number(wire), program.wireOrder[program.sourceSize + operation])
    const built = kindOf[machine.circuit.operations[Number(wire) - program.sourceSize]!.kind]
    assert.equal(kind, built.name, `the kind of wire ${wire}`)
    assert.equal(operations.kindClass?.(operation), built.className, `the kind class of wire ${wire}`)
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
    assert.ok(Number(layer) === lastLayer || Number(layer) === lastLayer + 1, `layer ${layer} after layer ${lastLayer}`)
    lastLayer = Number(layer)
    weights += Number(storedWeights)
    assert.equal(operations.value(operation), expected[Number(wire)])
  }
  assert.equal(lastLayer, program.layers.length)
  assert.equal(weights, program.layers.reduce((sum, layer) => sum + layer.weights.length, 0))
  // The counts of the four kinds are the compiled program's: its layers' ReGLU
  // rows, boolean rows and index reads, and every other row is a sum. A sum that the
  // compiler lowered to a gather read is an affine row with no stored weight. The
  // Notes flow's line walker is what reads by index, 2,320 times.
  const regluCount = program.layers.reduce((sum, layer) => sum + layer.gateRows.length, 0)
  const booleanCount = program.layers.reduce((sum, layer) => sum + layer.booleanRows.length, 0)
  const indexReadCount = program.layers.reduce((sum, layer) => sum + layer.indexReads.length, 0)
  assert.deepEqual(
    [...kindCounts].sort(([left], [right]) => left < right ? -1 : 1),
    [['ReGLU', regluCount], ['affine', operations.rowCount - regluCount - booleanCount - indexReadCount], ['boolean', booleanCount], ['index read', indexReadCount]],
  )
  assert.equal(indexReadCount, 2320)
  // An index read's weights are its index's, here always one wire's value, and a
  // gather read has none.
  let rowsBefore = 0
  let gatherReadCount = 0
  for (const layer of program.layers) {
    for (const read of layer.indexReads) assert.deepEqual(operations.text(rowsBefore + read.row).slice(1), ['index read', operations.text(rowsBefore + read.row)[2], '1'])
    for (const read of layer.gatherReads) assert.deepEqual(operations.text(rowsBefore + read.row).slice(1), ['affine', operations.text(rowsBefore + read.row)[2], '0'])
    gatherReadCount += layer.gatherReads.length
    rowsBefore += layer.outputSize
  }
  assert.equal(gatherReadCount, 60)
  // The other two locations give their kind cells no class.
  assert.equal(state.kindClass, undefined)

  const outputs = describeOutputs(machine.namedOutputs, machine.values)
  assert.equal(outputs.rowCount, program.roots.length - program.sourceSize)
  // The names follow the order of the program's roots after the next-state values.
  machine.namedOutputs.forEach(({wire}, output) => {
    assert.equal(wire, program.roots[program.sourceSize + output])
    assert.equal(outputs.value(output), expected[wire])
  })
  const names = machine.namedOutputs.map(({name}) => name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(outputs.text(0), ['windows.0.translateX', '', '', ''])
  assert.equal(outputs.value(0), 54)
  for (const name of ['windows.3.destinationHeight', 'dockItems.2.left', 'animationActive', 'photos.backdropOpacity', 'photos.photos.11.focused',
    'photos.thumbnails.0.left', 'photos.nextControl.opacity', 'notes.segments.0.x', 'notes.segments.255.visible', 'notes.bands.15.start', 'notes.runOverflow',
    'notes.press.count', 'notes.press.x', 'notes.press.y', 'files.totalHeight', 'files.locations.2', 'files.slots.63.selected']) {
    assert.ok(names.includes(name), name)
  }
  assert.equal(outputs.value(names.indexOf('files.totalHeight')), operations.rowCount * rowHeight)
  assert.equal(outputs.value(names.indexOf('files.selected')), 23)
  assert.equal(outputs.value(names.indexOf('files.scroll')), 480)
})

test('a value is shown as the shortest decimal that reads back as the same FP32 value', () => {
  for (const [value, text] of [
    [0, '0'], [-0, '0'], [1, '1'], [-1, '-1'], [2_399_976, '2399976'], [0.5, '0.5'], [Math.fround(0.1), '0.1'], [Math.fround(-0.3), '-0.3'],
    [Math.fround(1 / 3), '0.33333334'], [Math.fround(54.015625), '54.015625'], [Math.fround(1234.5677), '1234.5677'], [2 ** -20, '9.536743e-7'],
    [Math.fround(1e-7), '1e-7'], [Math.fround(16_777_216.5), '16777216'], [Math.fround(3.4e38), '3.4e+38'], [Number.NaN, 'NaN'], [Number.POSITIVE_INFINITY, 'Infinity'],
  ] as const) {
    assert.equal(formatValue(value), text)
    // -0 is shown as 0.
    if (Number.isFinite(value)) assert.ok(Math.fround(Number(text)) === value, text)
  }
  const random = createRandom(0xf0a7)
  for (let index = 0; index < 20_000; index++) {
    const value = Math.fround((random() - 0.5) * 10 ** Math.floor(random() * 14 - 6))
    const text = formatValue(value)
    assert.equal(Math.fround(Number(text)), value, text)
    assert.ok(text.length <= 16, text)
  }
})

// A stand-in for the elements that the renderer uses: children, style properties, a
// scroll position, and a text and a class name that count how often they're written.
type FakeElement = {
  className: string
  children: FakeElement[]
  style: Record<string, string> & {setProperty: (name: string, value: string) => void}
  scrollTop: number
  textContent: string
  appendChild: (child: FakeElement) => FakeElement
  querySelector: (selector: string) => FakeElement | null
}

function createFakeDom() {
  const counts = {textWrites: 0, classWrites: 0}
  function createElement(initialClassName = ''): FakeElement {
    let text = ''
    let className = initialClassName
    const style = {} as FakeElement['style']
    Object.defineProperty(style, 'setProperty', {enumerable: false, value: (name: string, value: string) => {
      style[name] = value
    }})
    const element: FakeElement = {
      get className() {
        return className
      },
      set className(value: string) {
        className = value
        counts.classWrites++
      },
      children: [],
      style,
      scrollTop: 0,
      get textContent() {
        return text
      },
      set textContent(value: string) {
        text = value
        counts.textWrites++
      },
      appendChild(child) {
        element.children.push(child)
        return child
      },
      // The first descendant with the class, e.g. '.files-header'.
      querySelector(selector) {
        for (const child of element.children) {
          if (child.className.split(' ').includes(selector.slice(1))) return child
          const found = child.querySelector(selector)
          if (found !== null) return found
        }
        return null
      },
    }
    return element
  }
  // The static markup of assets/index.html inside .files-content.
  const root = createElement('window-content files-content')
  const sidebar = root.appendChild(createElement('files-sidebar'))
  const list = root.appendChild(createElement('files-list'))
  const header = list.appendChild(createElement('files-header'))
  const scroller = list.appendChild(createElement('files-scroller'))
  const spacer = scroller.appendChild(createElement('files-spacer'))
  const overflow = list.appendChild(createElement('files-overflow'))
  return {counts, document: {createElement: () => createElement()}, root, sidebar, list, header, scroller, spacer, overflow}
}

test("the renderer writes a row's text only when a slot's row changes, its kind cell's class only when the kind changes, a value's text only when the value changes, and every slot's display and transform in every frame", () => {
  const machine = createMachine()
  const dom = createFakeDom()
  const locations = [
    describeState(machine.sourceCells, machine.packedValues),
    describeOperations(machine.tensorProgram, machine.packedValues),
    describeOutputs(machine.namedOutputs, machine.values),
  ]
  const renderer = createFilesRenderer(dom.document as unknown as Document, dom.root as unknown as HTMLElement, locations)
  const rowNodes = dom.spacer.children
  const rowTexts = (node: FakeElement) => node.children.map(cell => cell.textContent)
  const drawnNodes = () => rowNodes.filter(node => node.style['display'] === 'grid').sort((left, right) => Number.parseFloat(left.style['transform']!.slice(11)) - Number.parseFloat(right.style['transform']!.slice(11)))
  const expectedTexts = (location: number, row: number) => [...locations[location]!.text(row), formatValue(locations[location]!.value(row))]
  // The kind cell is a row node's second cell. In Operations its class ends with the
  // row's kind, e.g. 'files-cell files-cell-kind kind-reglu', and in the other two
  // locations it is 'files-cell files-cell-kind' alone.
  const kindClasses = () => rowNodes.map(node => node.children[1]!.className)
  const expectedKindClass = (location: number, row: number) => {
    const kindClass = locations[location]!.kindClass?.(row)
    return kindClass === undefined ? 'files-cell files-cell-kind' : `files-cell files-cell-kind ${kindClass}`
  }
  // Renders a frame and returns how many kind cells got another class in it. The
  // renderer may write a class only where it changes, so the test fails when the
  // frame wrote more classes than that, e.g. every drawn row's class in every frame.
  const renderAndCountKindChanges = (values: Float32Array, otherClassWrites = 0) => {
    const before = kindClasses()
    const classWrites = dom.counts.classWrites
    renderer.render(values, machine.output.files)
    const changed = kindClasses().filter((kindClass, slot) => kindClass !== before[slot]).length
    assert.equal(dom.counts.classWrites - classWrites, changed + otherClassWrites, 'class writes in the frame')
    return changed
  }

  // At mount: the layout numbers, 64 row nodes of 5 cells, and one sidebar item per
  // location on the rectangle that the program hit-tests.
  assert.deepEqual(
    ['--files-sidebar-width', '--files-header-height', '--files-row-height', '--files-scrollbar-strip'].map(name => dom.root.style[name]),
    ['132px', '28px', '24px', '16px'],
  )
  assert.equal(rowNodes.length, slotCount)
  assert.ok(rowNodes.every(node => node.className === 'files-row' && node.children.length === 5))
  assert.deepEqual(rowNodes[0]!.children.map(cell => cell.className), ['name', 'kind', 'layer', 'weights', 'value'].map(column => `files-cell files-cell-${column}`))
  assert.deepEqual(
    dom.sidebar.children.map(node => [node.className, node.textContent, node.style['left'], node.style['top'], node.style['width'], node.style['height']]),
    [['files-location', 'State', '8px', '40px', '116px', '28px'], ['files-location', 'Operations', '8px', '68px', '116px', '28px'], ['files-location', 'Outputs', '8px', '96px', '116px', '28px']],
  )

  // The first frame shows Operations from the top: 14 rows, each in the slot of its
  // index, with its text, its kind's class and its value. The frame also writes the
  // list's class once, for the location.
  let values = step(machine)
  assert.equal(renderAndCountKindChanges(values, 1), 14)
  assert.deepEqual(kindClasses().slice(0, 14), Array.from({length: 14}, (_, row) => expectedKindClass(operationsLocation, row)))
  assert.ok(kindClasses().slice(14).every(kindClass => kindClass === 'files-cell files-cell-kind'))
  assert.equal(dom.list.className, 'files-list files-list-operations')
  assert.deepEqual(dom.header.children.map(cell => cell.textContent), ['wire', 'kind', 'layer', 'weights', 'value'])
  assert.deepEqual(dom.sidebar.children.map(node => node.style['--selected']), ['0', '1', '0'])
  assert.equal(dom.spacer.style['height'], `${rowCountOf(machine) * rowHeight}px`)
  assert.equal(dom.overflow.style['display'], 'none')
  assert.deepEqual(rowNodes.map(node => node.style['display']), Array.from({length: slotCount}, (_, slot) => slot < 14 ? 'grid' : 'none'))
  for (let row = 0; row < 14; row++) {
    assert.equal(rowNodes[row]!.style['transform'], `translateY(${row * rowHeight}px)`)
    assert.equal(rowNodes[row]!.style['--selected'], '0')
    assert.deepEqual(rowTexts(rowNodes[row]!), expectedTexts(operationsLocation, row))
  }
  // The same frame again writes no text and no class.
  let textWrites = dom.counts.textWrites
  for (const node of rowNodes) node.style['display'] = 'stale'
  values = step(machine)
  assert.equal(renderAndCountKindChanges(values), 0)
  assert.equal(dom.counts.textWrites, textWrites)
  // The display, which the renderer writes for every slot in every frame, is back.
  assert.equal(drawnNodes().length, 14)

  // The list scrolled by one row: the rows that stay drawn keep their nodes and
  // their text, and the one row that comes into the drawn range is written, 4 texts
  // and a value.
  values = step(machine, rowHeight)
  assert.equal(renderAndCountKindChanges(values), 1)
  assert.equal(dom.counts.textWrites, textWrites + 5)
  assert.deepEqual(rowTexts(rowNodes[14]!), expectedTexts(operationsLocation, 14))
  assert.equal(kindClasses()[14], expectedKindClass(operationsLocation, 14))
  assert.deepEqual(drawnNodes().map(node => rowNodes.indexOf(node)), Array.from({length: 15}, (_, row) => row))
  // Far down the list, a slot shows another row of its own: row 4,174 is in slot 14.
  // Every drawn row has its own kind's class, and the rows drawn there are of more
  // than one kind.
  values = step(machine, 100_000)
  renderAndCountKindChanges(values)
  assert.deepEqual(rowTexts(rowNodes[4174 % slotCount]!), expectedTexts(operationsLocation, 4174))
  assert.equal(rowNodes[4174 % slotCount]!.style['transform'], `translateY(${4174 * rowHeight}px)`)
  const rowsFarDown = drawnNodes().map(node => Number.parseFloat(node.style['transform']!.slice(11)) / rowHeight)
  assert.equal(rowsFarDown.length, 16)
  assert.deepEqual(drawnNodes().map(node => node.children[1]!.className), rowsFarDown.map(row => expectedKindClass(operationsLocation, row)))
  assert.ok(new Set(rowsFarDown.map(row => expectedKindClass(operationsLocation, row))).size > 1)
  // A selected row.
  values = click(machine, rowPoint(4170, 100_000), undefined, 100_000)
  renderer.render(values, machine.output.files)
  assert.deepEqual(rowNodes.filter(node => node.style['--selected'] === '1').map(node => rowNodes.indexOf(node)), [4170 % slotCount])

  // Another location: the header's titles, the list's class name, and the text of
  // every drawn row, which the program draws from the top. State's rows have no kind
  // class, so each of its 14 drawn slots that held an operation's class loses it.
  textWrites = dom.counts.textWrites
  values = click(machine, locationPoint(stateLocation), undefined, 100_000)
  const slotsWithKind = kindClasses().slice(0, 14).filter(kindClass => kindClass !== 'files-cell files-cell-kind').length
  assert.equal(slotsWithKind, 14)
  assert.equal(renderAndCountKindChanges(values, 1), slotsWithKind)
  assert.ok(kindClasses().slice(0, 14).every(kindClass => kindClass === 'files-cell files-cell-kind'))
  assert.equal(dom.list.className, 'files-list files-list-state')
  assert.deepEqual(dom.header.children.map(cell => cell.textContent), ['cell', 'kind', '', '', 'value'])
  assert.deepEqual(dom.sidebar.children.map(node => node.style['--selected']), ['1', '0', '0'])
  assert.equal(dom.counts.textWrites, textWrites + 5 + 14 * 5)
  assert.deepEqual(rowTexts(rowNodes[0]!), ['viewportWidth', 'input', '', '', '1280'])
  // The program asked for the top, which the host gives the scroller after its DOM
  // writes, and the position read back is what the scroller kept.
  assert.equal(machine.filesScrollTo, 0)
  dom.scroller.scrollTop = 100_000
  assert.equal(renderer.readScrollTop(), 100_000)
  assert.equal(renderer.scrollTo(0), 0)
  assert.equal(dom.scroller.scrollTop, 0)

  // A value that changed: the viewport is 1 px wider, and only that cell's value is
  // written.
  textWrites = dom.counts.textWrites
  values = step(machine, 0, viewportWidth + 1)
  renderer.render(values, machine.output.files)
  assert.equal(dom.counts.textWrites, textWrites + 1)
  assert.deepEqual(rowTexts(rowNodes[0]!), ['viewportWidth', 'input', '', '', '1281'])
})
