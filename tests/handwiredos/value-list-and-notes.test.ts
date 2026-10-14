// Where Monitor's list and the Notes window meet in HandwiredOS's program. The note
// is the browser's own text field, so to the program a press on it is a press on a
// window's content that has no control: it raises and focuses Notes, and nothing
// else. These tests check that such a press arms nothing and moves nothing, also
// where Notes covers Monitor's list or Monitor's grip, and whatever the pointer does
// until the release, e.g. during a selection of the note's text that ends over a
// photo. And a list key moves Monitor's selection only while Monitor is the focused
// window at the key's time, e.g. not after a press on the note earlier in the same
// frame.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {validateGrids} from '../../src/runtime/numeric-ui-core.ts'
import {itemCount as photoCount} from '../../src/handwiredos/photo-gallery.ts'
import {
  armedSourceField,
  createWindowManagerMachine,
  dragSourceField,
  valueListSourceField,
  photoFocusSourceField,
  resizeSourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'

const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16
const rowHeight = 24

// The starting arrangement. Monitor is at 54,54 and 540x340, and its list's rows start
// right of the 152 px sidebar and below the 28 px header row, at 207,127. Notes is
// at 410,104 and 500x366, stacked above Monitor, and its content box starts at
// 411,149. So the list's rows from x 411 on and from y 149 on are under the note.
const list = {left: 207, top: 127}
const monitorTitleBar = {x: 100, y: 76}
// On Notes' title bar, left of Photos, and on Photos' title bar, right of Notes.
const notesTitleBar = {x: 600, y: 126}
const photosTitleBar = {x: 1000, y: 212}
// On Monitor's list and on the note, where Notes covers the list: row 5 of the list.
const onBoth = {x: 480, y: 250}
// On the note only: right of Monitor and left of Photos.
const onNoteOnly = {x: 600, y: 250}
// A point on a row of the list that Notes doesn't cover, 100 px from the list's left edge.
const rowPoint = (row: number) => ({x: list.left + 100, y: list.top + row * rowHeight + rowHeight / 2})
const rowAt = (point: {y: number}) => Math.floor((point.y - list.top) / rowHeight)

type Machine = ReturnType<typeof createWindowManagerMachine>
const frameTimeByMachine = new WeakMap<Machine, number>()

// A machine whose first frame ran. Every evaluation of its steps checks the table's
// grids.
function createMachine() {
  const machine = createWindowManagerMachine()
  machine.observe({
    beforeEvaluate(table) {
      validateGrids(machine.circuit, machine.circuit.evaluateReference(table))
    },
  })
  step(machine)
  return machine
}

// The next frame, 16 ms after the last one.
function step(machine: Machine) {
  const frameTime = (frameTimeByMachine.get(machine) ?? 0) + frameDuration
  frameTimeByMachine.set(machine, frameTime)
  return machine.step(viewportWidth, viewportHeight, frameTime)
}

// A time offsetMs after the last frame, before the next one.
const eventTime = (machine: Machine, offsetMs: number) => (frameTimeByMachine.get(machine) ?? 0) + offsetMs

// A press and a release 4 ms later, then a frame.
function click(machine: Machine, point: {x: number, y: number}, release = point) {
  machine.pointerDown(point.x, point.y, eventTime(machine, 4))
  machine.pointerUp(release.x, release.y, eventTime(machine, 8))
  return step(machine)
}

const selectedRow = (machine: Machine) => machine.source[valueListSourceField.selected]!
// What a held press does in the table: the bits of a drag, of a resize and of every
// armed control, e.g. all 0 while a press on the note is held.
function heldPress(machine: Machine) {
  const armed = [armedSourceField('photosContent'), armedSourceField('valueList')]
  for (let location = 0; location < 3; location++) armed.push(armedSourceField('valueListLocation', location))
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const control of ['close', 'minimize', 'maximize', 'dockItem'] as const) armed.push(armedSourceField(control, windowIndex))
  }
  return {
    drag: Array.from({length: windowCount}, (_, windowIndex) => machine.source[dragSourceField(windowIndex)]!),
    resize: Array.from({length: windowCount}, (_, windowIndex) => machine.source[resizeSourceField(windowIndex)]!),
    armed: armed.reduce((sum, cell) => sum + machine.source[cell]!, 0),
  }
}
const nothingHeld = {drag: [0, 0, 0], resize: [0, 0, 0], armed: 0}
// Each window's stored rectangle and its open, minimized and maximized bits.
const windowStates = (machine: Machine) => Array.from({length: windowCount}, (_, windowIndex) =>
  [windowStateField.left, windowStateField.top, windowStateField.width, windowStateField.height, windowStateField.open, windowStateField.minimized, windowStateField.maximized]
    .map(field => machine.source[windowSourceField(windowIndex, field)]!))
// The window indices from back to front.
const stackOrder = (machine: Machine) => Array.from({length: windowCount}, (_, rank) =>
  [0, 1, 2].find(windowIndex => machine.source[stackSourceField(rank, windowIndex)] === 1))
const focusedWindow = (machine: Machine, values: Float32Array) =>
  [0, 1, 2].find(windowIndex => values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!] === 1) ?? -1
const openPhoto = (machine: Machine) => Array.from({length: photoCount}, (_, item) => machine.source[photoFocusSourceField(item)]!).indexOf(1)

test('a press on the note raises and focuses Notes and nothing else: it starts no drag and no resize, arms no control, and its moves and its release move and act on nothing', () => {
  const machine = createMachine()
  // Monitor in front first, so the press has a window to raise Notes above.
  let values = click(machine, monitorTitleBar)
  assert.deepEqual(stackOrder(machine), [1, 2, 0])
  const before = windowStates(machine)

  // The press, on the part of the note that neither Monitor nor Photos covers.
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  values = step(machine)
  assert.equal(focusedWindow(machine, values), 1)
  assert.deepEqual(stackOrder(machine), [2, 0, 1])
  assert.deepEqual(heldPress(machine), nothingHeld)

  // The pointer leaves the note while the press is held, like a selection of the
  // note's text that is dragged across the desk: over a row of Monitor's list, over
  // Photos' close button, over a photo, over Notes' own title bar and grip, and over
  // Photos' dock item. Each move, and a release there, changes no window, opens no
  // photo and selects no row, and Notes stays in front.
  const photosClose = {x: 650 + 560 - 19, y: 190 + 22}
  const photo = {x: 862.5, y: 427}
  const notesGrip = {x: 410 + 500 - 12, y: 104 + 366 - 12}
  const photosDockItem = {x: 702, y: 762}
  for (const point of [rowPoint(8), photosClose, photo, notesTitleBar, notesGrip, photosDockItem, {x: 300, y: 600}]) {
    const label = `released at ${point.x},${point.y}`
    machine.pointerMove(point.x, point.y, eventTime(machine, 4))
    step(machine)
    assert.deepEqual(heldPress(machine), nothingHeld, label)
    machine.pointerUp(point.x, point.y, eventTime(machine, 4))
    values = step(machine)
    assert.deepEqual(windowStates(machine), before, label)
    assert.deepEqual(stackOrder(machine), [2, 0, 1], label)
    assert.equal(focusedWindow(machine, values), 1, label)
    assert.equal(selectedRow(machine), -1, label)
    assert.equal(openPhoto(machine), -1, label)
    assert.equal(machine.clock.animatedUntilMs, null, label)
    // The next press, on the note again.
    machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
    step(machine)
  }
  machine.pointerCancel(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  step(machine)
  assert.deepEqual(windowStates(machine), before)
})

test('a press where Notes covers the list arms no row, and with Monitor in front the same point selects its row', () => {
  const machine = createMachine()
  // Notes starts above Monitor. The down raises Notes and arms nothing, so the
  // release selects nothing.
  machine.pointerDown(onBoth.x, onBoth.y, eventTime(machine, 4))
  let values = step(machine)
  assert.deepEqual(heldPress(machine), nothingHeld)
  assert.equal(focusedWindow(machine, values), 1)
  machine.pointerUp(onBoth.x, onBoth.y, eventTime(machine, 4))
  step(machine)
  assert.equal(selectedRow(machine), -1)

  // Monitor in front: the down at the same point arms the list, and the release
  // selects the row there.
  values = click(machine, monitorTitleBar)
  assert.equal(focusedWindow(machine, values), 0)
  machine.pointerDown(onBoth.x, onBoth.y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[armedSourceField('valueList')], 1)
  machine.pointerUp(onBoth.x, onBoth.y, eventTime(machine, 4))
  values = step(machine)
  assert.equal(selectedRow(machine), rowAt(onBoth))
  assert.equal(rowAt(onBoth), 5)
  assert.equal(focusedWindow(machine, values), 0)
})

test('a press on one of the two windows that is released over the other acts on no row', () => {
  const machine = createMachine()
  click(machine, monitorTitleBar)
  click(machine, rowPoint(3))
  assert.equal(selectedRow(machine), 3)

  // A press on a row, released over the note right of Monitor: the release is off the
  // list, so the selection stays, and Monitor stays in front.
  let values = click(machine, rowPoint(8), onNoteOnly)
  assert.equal(selectedRow(machine), 3)
  assert.equal(focusedWindow(machine, values), 0)

  // A press on the note, released over a row of the list: the down raises Notes, and
  // the release selects nothing, since the press armed no row.
  values = click(machine, onNoteOnly, rowPoint(8))
  assert.equal(selectedRow(machine), 3)
  assert.equal(machine.source[armedSourceField('valueList')], 0)
  assert.equal(focusedWindow(machine, values), 1)

  // The same with the down on the part of the note that covers the list.
  click(machine, onBoth, rowPoint(8))
  assert.equal(selectedRow(machine), 3)

  // A press on a row that Notes doesn't cover raises Monitor, so the release over the
  // part of the list that the note covered until that press selects the row there.
  const release = {x: 480, y: 300}
  values = click(machine, rowPoint(2), release)
  assert.equal(selectedRow(machine), rowAt(release))
  assert.equal(rowAt(release), 7)
  assert.equal(focusedWindow(machine, values), 0)
})

test("a press on Monitor's grip where the note covers the grip resizes nothing, and with Monitor in front the grip resizes Monitor", () => {
  const machine = createMachine()
  // Monitor's grip is the 24 px square at its bottom right corner, 570..594 by
  // 370..394, which lies inside the note's content box. Notes starts above Monitor,
  // and a press on Notes' title bar also gives it the focus.
  const grip = {x: 582, y: 382}
  let values = click(machine, notesTitleBar)
  assert.equal(focusedWindow(machine, values), 1)
  machine.pointerDown(grip.x, grip.y, eventTime(machine, 4))
  step(machine)
  assert.deepEqual(heldPress(machine), nothingHeld)
  machine.pointerUp(grip.x, grip.y, eventTime(machine, 4))
  step(machine)

  values = click(machine, monitorTitleBar)
  assert.equal(focusedWindow(machine, values), 0)
  machine.pointerDown(grip.x, grip.y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[resizeSourceField(0)], 1)
  assert.equal(machine.source[armedSourceField('valueList')], 0)
  machine.pointerMove(grip.x + 40, grip.y + 20, eventTime(machine, 4))
  machine.pointerUp(grip.x + 40, grip.y + 20, eventTime(machine, 8))
  step(machine)
  assert.deepEqual(
    [machine.source[windowSourceField(0, windowStateField.width)], machine.source[windowSourceField(0, windowStateField.height)]],
    [580, 360],
  )
  assert.equal(selectedRow(machine), -1)
})

test("a list key moves Monitor's selection only while Monitor is the focused window at the key's time, so a key after a press on the note in the same frame moves nothing", () => {
  const machine = createMachine()
  click(machine, monitorTitleBar)
  click(machine, rowPoint(4))
  assert.equal(selectedRow(machine), 4)

  // A press on Notes' title bar, then ArrowDown 2 ms later, before the next frame. A
  // page delivers such a key to its keydown listener and not to the note, which
  // gets the keyboard focus in the frame after the press. Notes is the focused
  // window at the key's time, so the key moves nothing.
  machine.pointerDown(notesTitleBar.x, notesTitleBar.y, eventTime(machine, 4))
  machine.pointerUp(notesTitleBar.x, notesTitleBar.y, eventTime(machine, 6))
  machine.valueListKey('down', eventTime(machine, 8))
  let values = step(machine)
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 1)
  // The key had an evaluation of its own, after the press's.
  assert.deepEqual(
    machine.evaluations.filter(evaluation => evaluation.events.length > 0).map(evaluation => evaluation.events),
    [['pointer down'], ['pointer up'], ['value list key']],
  )

  // While Notes is focused, none of the six keys moves the selection, and the list
  // asks for no scroll.
  for (const key of ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'] as const) {
    machine.valueListKey(key, eventTime(machine, 4))
    step(machine)
    assert.equal(selectedRow(machine), 4, key)
    assert.equal(machine.valueListScrollTo, null, key)
  }

  // A key at the timestamp of the press that focuses Notes shares the press's
  // evaluation, and Monitor isn't focused after that evaluation's events.
  click(machine, monitorTitleBar)
  machine.valueListKey('down', eventTime(machine, 4))
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 1)

  // A key before the press, in the same frame, applies: Monitor was focused then.
  click(machine, monitorTitleBar)
  machine.valueListKey('down', eventTime(machine, 2))
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 5)
  assert.equal(focusedWindow(machine, values), 1)

  // From Notes back to Monitor: a key after the press that focuses Monitor, in the same
  // frame, applies.
  machine.pointerDown(monitorTitleBar.x, monitorTitleBar.y, eventTime(machine, 4))
  machine.pointerUp(monitorTitleBar.x, monitorTitleBar.y, eventTime(machine, 6))
  machine.valueListKey('down', eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 6)
  assert.equal(focusedWindow(machine, values), 0)
})

test("Photos' arrows and Escape act only while Photos is focused, so with a photo open they do nothing after a press on the note or on Monitor", () => {
  const machine = createMachine()
  // Open photo 5: Photos' content box starts at 651,235, and the photo's middle is at 862.5,427.
  click(machine, photosTitleBar)
  click(machine, {x: 862.5, y: 427})
  assert.equal(openPhoto(machine), 5)
  machine.photoNext(eventTime(machine, 4))
  step(machine)
  assert.equal(openPhoto(machine), 6)

  // A press on the note, then the three keys in the same frame and in later frames.
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 6))
  machine.photoNext(eventTime(machine, 8))
  let values = step(machine)
  assert.equal(focusedWindow(machine, values), 1)
  assert.equal(openPhoto(machine), 6)
  for (const key of ['photoPrevious', 'photoNext', 'photoClose'] as const) {
    machine[key](eventTime(machine, 4))
    step(machine)
    assert.equal(openPhoto(machine), 6, key)
  }

  // The same with Monitor focused, where the list's keys act and Photos' don't.
  click(machine, monitorTitleBar)
  machine.photoClose(eventTime(machine, 4))
  machine.valueListKey('down', eventTime(machine, 8))
  values = step(machine)
  assert.equal(focusedWindow(machine, values), 0)
  assert.equal(openPhoto(machine), 6)
  assert.equal(selectedRow(machine), 0)

  // Photos focused again: Escape closes the photo, and a list key moves nothing.
  click(machine, photosTitleBar)
  machine.valueListKey('down', eventTime(machine, 4))
  machine.photoClose(eventTime(machine, 8))
  values = step(machine)
  assert.equal(focusedWindow(machine, values), 2)
  assert.equal(openPhoto(machine), -1)
  assert.equal(selectedRow(machine), 0)
})
