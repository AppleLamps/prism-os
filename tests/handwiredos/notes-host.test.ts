// The DOM side of the Notes text, run against HandwiredOS's machine with a fake
// document: frames run in mountWindowManager's order, the fake textarea plays the
// browser, and the test reads what the host wrote into its nodes.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {fakeTextWidth, testFont} from './fake-canvas.ts'
import {type NotesRead, createNotesHost} from '../../src/handwiredos/notes-host.ts'
import {defaultLineFitEpsilon, notesOptionsFor, notesText, notesWords} from '../../src/handwiredos/notes-paragraph.ts'
import {createWindowManagerMachine, notesWindowIndex, segmentOutputField, windowOutputField} from '../../src/handwiredos/window-manager.ts'

const measure = (text: string) => fakeTextWidth(text, testFont)
const notesOptions = notesOptionsFor(defaultLineFitEpsilon)

// An element with the properties that the host writes. Every assignment of textContent is counted, since the host
// must write a word's text only when it changes.
class FakeElement {
  className = ''
  style: Record<string, string> = {}
  children: FakeElement[] = []
  attributes: Record<string, string> = {}
  listeners = new Map<string, ((event: {timeStamp: number}) => void)[]>()
  textWrites = 0
  // A textarea's state, which the test changes like a browser would. Assigning the value moves the caret to the end
  // of the text, as the HTML standard says.
  selectionStart = 0
  selectionEnd = 0
  selectionDirection: 'none' | 'forward' | 'backward' = 'none'
  spellcheck = true
  autocapitalize = ''
  focusCalls: unknown[] = []
  blurCalls = 0
  #text = ''
  #value = ''
  constructor(readonly tagName: string, readonly document: FakeDocument) {}
  get value() {
    return this.#value
  }
  set value(value: string) {
    this.#value = value
    this.selectionStart = this.selectionEnd = value.length
  }
  get textContent() {
    return this.#text
  }
  set textContent(text: string) {
    this.#text = text
    this.textWrites++
  }
  appendChild(child: FakeElement) {
    this.children.push(child)
    return child
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }
  addEventListener(type: string, listener: (event: {timeStamp: number}) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
  dispatch(type: string, timeStamp: number) {
    for (const listener of this.listeners.get(type) ?? []) listener({timeStamp})
  }
  focus(options?: unknown) {
    this.focusCalls.push(options)
    this.document.activeElement = this
  }
  blur() {
    this.blurCalls++
    this.document.activeElement = null
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null
  listeners = new Map<string, (() => void)[]>()
  createElement(tagName: string) {
    return new FakeElement(tagName, this)
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
}

// A mounted host and its machine, with one function that runs a frame the way mountWindowManager's render does.
function mount() {
  const machine = createWindowManagerMachine()
  const document = new FakeDocument()
  const content = document.createElement('div')
  const scheduled = {renders: 0}
  const notesWindow = notesWindowIndex * windowOutputField.size
  const host = createNotesHost(
    document as unknown as Document,
    content as unknown as HTMLElement,
    machine,
    {
      notes: machine.output.notes,
      focused: machine.output.windows[notesWindow + windowOutputField.focused]!,
      contentWidth: machine.output.windows[notesWindow + windowOutputField.contentWidth]!,
      contentHeight: machine.output.windows[notesWindow + windowOutputField.contentHeight]!,
    },
    notesOptions,
    notesText,
    measure,
    () => {
      scheduled.renders++
    },
  )
  const nodesOf = (className: string) => content.children.filter(child => child.className === className)
  const input = nodesOf('notes-input')[0]!
  const caret = nodesOf('notes-caret')[0]!
  let frameTime = 0
  let lastRead: NotesRead | null = null
  function frame() {
    frameTime += 16
    const read = host.read()
    host.queueText(read)
    const values = machine.step(1280, 800, frameTime)
    host.write(read, values)
    host.applySideEffects(read, values)
    lastRead = read
    return values
  }
  // Like a browser after a key: the textarea holds the new value with the caret at `caretOffset`, and its input
  // event fires `beforeFrame` ms before the next frame.
  function type(value: string, caretOffset = value.length, beforeFrame = 8) {
    input.value = value
    input.selectionStart = input.selectionEnd = caretOffset
    input.dispatch('input', frameTime + 16 - beforeFrame)
  }
  function press(x: number, y: number) {
    machine.pointerDown(x, y, frameTime + 4)
    machine.pointerUp(x, y, frameTime + 4)
  }
  const words = () => nodesOf('notes-word')
  const shownWords = () => words().filter(node => node.style['display'] === 'block')
  return {machine, document, content, host, input, caret, scheduled, frame, type, press, words, shownWords, lastRead: () => lastRead}
}

// The outputs of a segment cell in a frame's values.
function placeOf(machine: ReturnType<typeof createWindowManagerMachine>, values: Float32Array, cell: number) {
  const read = (field: number) => values[machine.output.notes.segments[cell * segmentOutputField.size + field]!]!
  return {x: read(segmentOutputField.x), y: read(segmentOutputField.y), visible: read(segmentOutputField.visible)}
}

test('the textarea is created once with the starting text, and the first frame draws one span per word from the program\'s outputs', () => {
  const {machine, content, input, caret, frame, words} = mount()
  assert.deepEqual([input.tagName, input.value, input.spellcheck, input.attributes['aria-label']], ['textarea', notesText, false, 'Note'])
  // The measured text was queued before the first step, so it applies with the mount.
  const values = frame()
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.events]), [['events', ['mount', 'notes text']], ['frame', []]])
  assert.deepEqual(words().map(node => node.textContent), notesWords)
  assert.equal(content.children.length, notesWords.length + 2)
  words().forEach((node, word) => {
    const place = placeOf(machine, values, 2 * word)
    assert.deepEqual(
      [node.style['display'], node.style['transform'], node.style['opacity']],
      ['block', `translate3d(${place.x}px,${place.y}px,0)`, `${place.visible}`],
    )
  })
  // At the starting arrangement the last 10 words have no line, and Photos is the focused window: no caret, and
  // the textarea isn't focused.
  assert.equal(words().filter(node => node.style['opacity'] === '1').length, 35)
  assert.equal(caret.style['display'], 'none')
  assert.deepEqual([input.focusCalls.length, input.blurCalls], [0, 0])
  // Later frames write no text again.
  frame()
  frame()
  assert.ok(words().every(node => node.textWrites === 1))
})

test('the textarea has the keyboard focus exactly while Notes is the focused window, and each call changes what the browser holds', () => {
  const {document, input, caret, frame, press, machine} = mount()
  frame()
  // A press on Notes' title bar raises and focuses Notes: the frame of the press focuses the textarea, once.
  press(450, 126)
  let values = frame()
  assert.deepEqual(input.focusCalls, [{preventScroll: true}])
  assert.equal(document.activeElement, input)
  for (let frames = 0; frames < 5; frames++) values = frame()
  assert.deepEqual([input.focusCalls.length, input.blurCalls], [1, 0])
  // The caret sits after the last word, which the cells hold as segment 88.
  const last = placeOf(machine, values, 88)
  assert.deepEqual([caret.style['display'], caret.style['transform']], ['block', `translate3d(${last.x + measure('them.')}px,${last.y}px,0)`])
  // The browser blurs the textarea at a press anywhere, e.g. on the note itself, and the host focuses it again.
  document.activeElement = null
  frame()
  assert.equal(input.focusCalls.length, 2)
  // A press on Photos' title bar, right of Notes, focuses Photos: the textarea is blurred, once, and the caret isn't
  // drawn.
  press(1000, 212)
  frame()
  frame()
  assert.deepEqual([input.focusCalls.length, input.blurCalls, document.activeElement], [2, 1, null])
  assert.equal(caret.style['display'], 'none')
})

test('a typed character reaches the program as one event at the input event\'s time, and only changed words are written', () => {
  const {machine, input, caret, scheduled, frame, type, press, words, shownWords} = mount()
  frame()
  press(450, 126)
  frame()
  const before = scheduled.renders
  type(`${notesText} More`)
  assert.equal(scheduled.renders, before + 1)
  let values = frame()
  // The frame ran at 48 ms, and the text event applied 8 ms before it.
  assert.deepEqual(machine.evaluations.map(evaluation => [evaluation.kind, evaluation.timeMs, evaluation.events]), [['events', 40, ['notes text']], ['frame', 48, []]])
  assert.equal(words().length, 46)
  assert.deepEqual(words().map(node => node.textWrites), [...Array.from({length: 45}, () => 1), 1])
  assert.equal(words()[45]!.textContent, 'More')
  const more = placeOf(machine, values, 90)
  assert.equal(words()[45]!.style['transform'], `translate3d(${more.x}px,${more.y}px,0)`)
  assert.equal(caret.style['transform'], `translate3d(${more.x + measure('More')}px,${more.y}px,0)`)
  // A letter typed inside the first word rewrites that word's node only, and the caret follows the textarea's.
  type(`Thiis${notesText.slice(4)} More`, 3)
  values = frame()
  assert.deepEqual(words().map(node => node.textWrites), [2, ...Array.from({length: 45}, () => 1)])
  const first = placeOf(machine, values, 0)
  assert.equal(caret.style['transform'], `translate3d(${first.x + measure('Thi')}px,${first.y}px,0)`)
  // A caret that only moves needs no event: the frame reads the textarea's selection.
  input.selectionStart = input.selectionEnd = 0
  frame()
  assert.deepEqual(machine.evaluations.map(evaluation => evaluation.kind), ['frame'])
  assert.equal(caret.style['transform'], `translate3d(${first.x}px,${first.y}px,0)`)
  // A shorter text hides the nodes it doesn't need, and a longer one shows them again.
  type('Two words')
  frame()
  assert.deepEqual(shownWords().map(node => node.textContent), ['Two', 'words'])
  assert.equal(words().length, 46)
  assert.ok(words().slice(2).every(node => node.style['display'] === 'none' && node.style['opacity'] === '0'))
  type('Two words and one more')
  frame()
  assert.deepEqual(shownWords().map(node => node.textContent), ['Two', 'words', 'and', 'one', 'more'])
  // A trailing space adds no segment, and the caret moves one space further.
  type('Two words and one more ')
  values = frame()
  assert.deepEqual(machine.evaluations.map(evaluation => evaluation.events), [['notes text'], []])
  const lastWord = placeOf(machine, values, 8)
  assert.equal(caret.style['transform'], `translate3d(${lastWord.x + measure('more') + measure(' ')}px,${lastWord.y}px,0)`)
})

test('an empty note keeps its caret in the first usable band, and the textarea stays inside the content box', () => {
  const {input, caret, frame, type, press} = mount()
  frame()
  press(450, 126)
  frame()
  type('')
  frame()
  // The column starts 24 px in, and the first band 24 px down.
  assert.deepEqual([caret.style['display'], caret.style['transform']], ['block', 'translate3d(24px,24px,0)'])
  assert.equal(input.style['transform'], 'translate3d(24px,24px,0)')
  // A caret past the right edge of the 498 px content box, after a word that is wider than the box: the textarea
  // stops at the last pixel inside the box.
  const run = 'mmmmmmmmmm'.repeat(8)
  type(run)
  frame()
  assert.ok(measure(run) > 498)
  assert.equal(caret.style['transform'], `translate3d(${24 + measure(run)}px,24px,0)`)
  assert.equal(input.style['transform'], 'translate3d(497px,24px,0)')
})
