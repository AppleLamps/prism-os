// Where Files' list and the note meet in HandwiredOS's program. Both take presses
// as "the frontmost window under the point", and the list's keys and the note's
// typing both depend on which window is focused. Each has its own tests, in
// files.test.ts and notes.test.ts. These tests check the two together: a press
// goes to the list or to the note and never to both, also where one window covers
// the other, and a list key moves Files' selection only while Files is the focused
// window at the key's time, e.g. not after a press on the note earlier in the same
// frame.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {validateGrids, validateIndexReads} from '../../src/runtime/numeric-ui-core.ts'
import {itemCount as photoCount} from '../../src/handwiredos/photo-gallery.ts'
import {
  armedSourceField,
  createWindowManagerMachine,
  filesSourceField,
  notesSourceField,
  photoFocusSourceField,
  resizeSourceField,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../../src/handwiredos/window-manager.ts'

const viewportWidth = 1280
const viewportHeight = 800
const frameDuration = 16
const rowHeight = 24

// The starting arrangement. Files is at 54,54 and 520x340, and its list's rows start
// right of the 132 px sidebar and below the 28 px header row, at 187,127. Notes is
// at 410,104 and 500x366, stacked above Files, and its content box starts at
// 411,149. So the list's rows from x 411 on and from y 149 on are under the note.
const list = {left: 187, top: 127}
const notesContent = {left: 411, top: 149}
const filesTitleBar = {x: 100, y: 76}
// On Notes' title bar, left of Photos, and on Photos' title bar, right of Notes.
const notesTitleBar = {x: 600, y: 126}
const photosTitleBar = {x: 1000, y: 212}
// On Files' list and on the note, where Notes covers the list: row 5 of the list.
const onBoth = {x: 480, y: 250}
// On the note only: right of Files, left of Photos and above System Monitor.
const onNoteOnly = {x: 600, y: 250}
// A point on a row of the list that Notes doesn't cover, 100 px from the list's left edge.
const rowPoint = (row: number) => ({x: list.left + 100, y: list.top + row * rowHeight + rowHeight / 2})
const rowAt = (point: {y: number}) => Math.floor((point.y - list.top) / rowHeight)

type Machine = ReturnType<typeof createWindowManagerMachine>
const frameTimeByMachine = new WeakMap<Machine, number>()

// A machine whose first frame ran. Every evaluation of its steps checks the table's
// grids and the index reads' ranges.
function createMachine() {
  const machine = createWindowManagerMachine()
  machine.observe({
    beforeEvaluate(table) {
      const values = machine.circuit.evaluateReference(table)
      validateGrids(machine.circuit, values)
      validateIndexReads(machine.circuit, values)
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

const selectedRow = (machine: Machine) => machine.source[filesSourceField.selected]!
// The count of presses on the note, and the last one's point in the note's content box.
const notePress = (machine: Machine) => [machine.source[notesSourceField.pressCount], machine.source[notesSourceField.pressX], machine.source[notesSourceField.pressY]]
const inNote = (point: {x: number, y: number}) => [point.x - notesContent.left, point.y - notesContent.top]
const focusedWindow = (machine: Machine, values: Float32Array) =>
  [0, 1, 2, 3].find(windowIndex => values[machine.output.windows[windowIndex * windowOutputField.size + windowOutputField.focused]!] === 1) ?? -1
const openPhoto = (machine: Machine) => Array.from({length: photoCount}, (_, item) => machine.source[photoFocusSourceField(item)]!).indexOf(1)

test('a press where the note covers the list places the caret and arms no row, and with Files in front the same point selects its row and counts no press on the note', () => {
  const machine = createMachine()
  // Notes starts above Files. The down is counted by the note, at its point in the
  // note's content box, and raises Notes. The list isn't armed, so the release
  // selects nothing.
  machine.pointerDown(onBoth.x, onBoth.y, eventTime(machine, 4))
  let values = step(machine)
  assert.deepEqual(notePress(machine), [1, ...inNote(onBoth)])
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  assert.equal(focusedWindow(machine, values), 1)
  machine.pointerUp(onBoth.x, onBoth.y, eventTime(machine, 4))
  step(machine)
  assert.equal(selectedRow(machine), -1)

  // Files in front: the down at the same point arms the list, the note counts
  // nothing, and the release selects the row there.
  values = click(machine, filesTitleBar)
  assert.equal(focusedWindow(machine, values), 0)
  machine.pointerDown(onBoth.x, onBoth.y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[armedSourceField('filesList')], 1)
  assert.deepEqual(notePress(machine), [1, ...inNote(onBoth)])
  machine.pointerUp(onBoth.x, onBoth.y, eventTime(machine, 4))
  values = step(machine)
  assert.equal(selectedRow(machine), rowAt(onBoth))
  assert.equal(rowAt(onBoth), 5)
  assert.deepEqual(notePress(machine), [1, ...inNote(onBoth)])
  assert.equal(focusedWindow(machine, values), 0)
})

test('a press on one of the two windows that is released over the other acts on neither the row nor the caret under the release', () => {
  const machine = createMachine()
  click(machine, filesTitleBar)
  click(machine, rowPoint(3))
  assert.equal(selectedRow(machine), 3)
  assert.equal(notePress(machine)[0], 0)

  // A press on a row, released over the note right of Files: the release is off the
  // list, so the selection stays, and the note counts a press only at a down on it.
  let values = click(machine, rowPoint(8), onNoteOnly)
  assert.equal(selectedRow(machine), 3)
  assert.equal(notePress(machine)[0], 0)
  assert.equal(focusedWindow(machine, values), 0)

  // A press on the note, released over a row of the list: the down places the caret
  // and raises Notes, and the release selects nothing, since the press armed no row.
  values = click(machine, onNoteOnly, rowPoint(8))
  assert.deepEqual(notePress(machine), [1, ...inNote(onNoteOnly)])
  assert.equal(selectedRow(machine), 3)
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  assert.equal(focusedWindow(machine, values), 1)

  // The same with the down on the part of the note that covers the list.
  click(machine, onBoth, rowPoint(8))
  assert.deepEqual(notePress(machine), [2, ...inNote(onBoth)])
  assert.equal(selectedRow(machine), 3)

  // A press on a row that Notes doesn't cover raises Files, so the release over the
  // part of the list that the note covered until that press selects the row there.
  const release = {x: 480, y: 300}
  values = click(machine, rowPoint(2), release)
  assert.equal(selectedRow(machine), rowAt(release))
  assert.equal(rowAt(release), 7)
  assert.deepEqual(notePress(machine), [2, ...inNote(onBoth)])
  assert.equal(focusedWindow(machine, values), 0)
})

test("a press on Files' grip where the note covers the grip goes to the note, and with Files in front the grip resizes and the note counts nothing", () => {
  const machine = createMachine()
  // Files' grip is the 24 px square at its bottom right corner, 550..574 by 370..394,
  // which lies inside the note's content box, and under System Monitor until a
  // press on Notes' title bar raises Notes above both.
  const grip = {x: 562, y: 382}
  let values = click(machine, notesTitleBar)
  assert.equal(focusedWindow(machine, values), 1)
  assert.equal(notePress(machine)[0], 0)
  machine.pointerDown(grip.x, grip.y, eventTime(machine, 4))
  step(machine)
  assert.deepEqual(notePress(machine), [1, ...inNote(grip)])
  assert.equal(machine.source[resizeSourceField(0)], 0)
  machine.pointerUp(grip.x, grip.y, eventTime(machine, 4))
  step(machine)

  values = click(machine, filesTitleBar)
  assert.equal(focusedWindow(machine, values), 0)
  machine.pointerDown(grip.x, grip.y, eventTime(machine, 4))
  step(machine)
  assert.equal(machine.source[resizeSourceField(0)], 1)
  assert.equal(machine.source[armedSourceField('filesList')], 0)
  assert.deepEqual(notePress(machine), [1, ...inNote(grip)])
  machine.pointerMove(grip.x + 40, grip.y + 20, eventTime(machine, 4))
  machine.pointerUp(grip.x + 40, grip.y + 20, eventTime(machine, 8))
  step(machine)
  assert.deepEqual(
    [machine.source[windowSourceField(0, windowStateField.width)], machine.source[windowSourceField(0, windowStateField.height)]],
    [560, 360],
  )
  assert.equal(selectedRow(machine), -1)
  assert.deepEqual(notePress(machine), [1, ...inNote(grip)])
})

test("a list key moves Files' selection only while Files is the focused window at the key's time, so a key after a press on the note in the same frame moves nothing", () => {
  const machine = createMachine()
  click(machine, filesTitleBar)
  click(machine, rowPoint(4))
  assert.equal(selectedRow(machine), 4)

  // A press on the note, then ArrowDown 2 ms later, before the next frame. A page
  // delivers such a key to its keydown listener and not to the note's textarea,
  // which gets the keyboard focus in the frame after the press. Notes is the
  // focused window at the key's time, so the key moves nothing.
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 6))
  machine.filesKey('down', eventTime(machine, 8))
  let values = step(machine)
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 1)
  assert.equal(notePress(machine)[0], 1)
  // The key had an evaluation of its own, after the press's.
  assert.deepEqual(
    machine.evaluations.filter(evaluation => evaluation.events.length > 0).map(evaluation => evaluation.events),
    [['pointer down'], ['pointer up'], ['files key']],
  )

  // While Notes is focused, none of the six keys moves the selection, and the list
  // asks for no scroll.
  for (const key of ['up', 'down', 'pageUp', 'pageDown', 'home', 'end'] as const) {
    machine.filesKey(key, eventTime(machine, 4))
    step(machine)
    assert.equal(selectedRow(machine), 4, key)
    assert.equal(machine.filesScrollTo, null, key)
  }

  // A key at the timestamp of the press that focuses Notes shares the press's
  // evaluation, and Files isn't focused after that evaluation's events.
  click(machine, filesTitleBar)
  machine.filesKey('down', eventTime(machine, 4))
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 1)

  // A key before the press, in the same frame, applies: Files was focused then.
  click(machine, filesTitleBar)
  machine.filesKey('down', eventTime(machine, 2))
  machine.pointerDown(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 4))
  machine.pointerUp(onNoteOnly.x, onNoteOnly.y, eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 5)
  assert.equal(focusedWindow(machine, values), 1)

  // From Notes back to Files: a key after the press that focuses Files, in the same
  // frame, applies.
  machine.pointerDown(filesTitleBar.x, filesTitleBar.y, eventTime(machine, 4))
  machine.pointerUp(filesTitleBar.x, filesTitleBar.y, eventTime(machine, 6))
  machine.filesKey('down', eventTime(machine, 8))
  values = step(machine)
  assert.equal(selectedRow(machine), 6)
  assert.equal(focusedWindow(machine, values), 0)
})

test("a text change and a list key at one timestamp each reach their own cells: the text is laid out, and the key moves the selection only while Files is focused", () => {
  const machine = createMachine()
  click(machine, filesTitleBar)
  click(machine, rowPoint(4))
  const text = (words: number) => ({
    widths: Array.from({length: 2 * words - 1}, (_, segment) => segment % 2 === 1 ? 4.375 : 30),
    breakAfter: Array.from({length: 2 * words - 1}, (_, segment) => segment % 2),
  })

  // While Notes is focused, typing changes the text and a list key at the same
  // timestamp moves nothing.
  click(machine, onNoteOnly)
  machine.notesText(text(7), eventTime(machine, 4))
  machine.filesKey('end', eventTime(machine, 4))
  let values = step(machine)
  assert.equal(machine.source[notesSourceField.arrivedCount], 13)
  assert.equal(selectedRow(machine), 4)
  assert.equal(focusedWindow(machine, values), 1)
  assert.deepEqual(machine.evaluations[0]!.events, ['notes text', 'files key'])

  // The program doesn't ask which window is focused before it takes a text: the page
  // types only while its textarea has the keyboard focus. So with Files focused, a
  // text event still rewrites the note, and the key in the same evaluation moves
  // Files' selection.
  click(machine, filesTitleBar)
  machine.notesText(text(3), eventTime(machine, 4))
  machine.filesKey('down', eventTime(machine, 4))
  values = step(machine)
  assert.equal(machine.source[notesSourceField.arrivedCount], 5)
  assert.equal(selectedRow(machine), 5)
  assert.equal(focusedWindow(machine, values), 0)
})

test("Photos' arrows and Escape act only while Photos is focused, so with a photo open they do nothing after a press on the note or on Files", () => {
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

  // The same with Files focused, where the list's keys act and Photos' don't.
  click(machine, filesTitleBar)
  machine.photoClose(eventTime(machine, 4))
  machine.filesKey('down', eventTime(machine, 8))
  values = step(machine)
  assert.equal(focusedWindow(machine, values), 0)
  assert.equal(openPhoto(machine), 6)
  assert.equal(selectedRow(machine), 0)

  // Photos focused again: Escape closes the photo, and a list key moves nothing.
  click(machine, photosTitleBar)
  machine.filesKey('down', eventTime(machine, 4))
  machine.photoClose(eventTime(machine, 8))
  values = step(machine)
  assert.equal(focusedWindow(machine, values), 3)
  assert.equal(openPhoto(machine), -1)
  assert.equal(selectedRow(machine), 0)
})
