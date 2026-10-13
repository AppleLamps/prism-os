// The DOM side of the Notes text, run against HandwiredOS's machine with a fake
// document: frames run in mountWindowManager's order, the fake textarea plays the
// browser, and the test reads what the host wrote into its nodes.
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {fakeTextWidth, testFont} from './fake-canvas.ts'
import {type NotesRead, createNotesHost} from '../../src/handwiredos/notes-host.ts'
import {defaultLineFitEpsilon, notesCapacity, notesOptionsFor, notesText, notesWords} from '../../src/handwiredos/notes-paragraph.ts'
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
  listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>()
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
  selectionCalls: [start: number, end: number, direction?: string][] = []
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
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
  dispatch(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  focus(options?: unknown) {
    this.focusCalls.push(options)
    this.document.activeElement = this
  }
  blur() {
    this.blurCalls++
    this.document.activeElement = null
  }
  setSelectionRange(start: number, end: number, direction: 'none' | 'forward' | 'backward' = 'none') {
    this.selectionCalls.push(direction === 'none' ? [start, end] : [start, end, direction])
    this.selectionStart = start
    this.selectionEnd = end
    this.selectionDirection = direction
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

// The page's limits: a run wider than the narrowest column is cut into pieces that fit the narrowest slot.
const pageLimits = {longestWholeSegment: 230, pieceWidth: 80}

// A mounted host and its machine, with one function that runs a frame the way mountWindowManager's render does.
function mount(limits = pageLimits) {
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
    limits,
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
    input.dispatch('input', {timeStamp: frameTime + 16 - beforeFrame})
  }
  function press(x: number, y: number) {
    machine.pointerDown(x, y, frameTime + 4)
    machine.pointerUp(x, y, frameTime + 4)
  }
  // A keydown at the textarea, as the window's keydown listener passes it to the host. Returns whether the host
  // prevented the browser's own handling of the key.
  function key(name: string, modifiers: {shift?: boolean, meta?: boolean} = {}) {
    let prevented = false
    const event = {
      target: input,
      key: name,
      shiftKey: modifiers.shift ?? false,
      metaKey: modifiers.meta ?? false,
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      preventDefault() {
        prevented = true
      },
    }
    assert.equal(host.takesKey(event as unknown as KeyboardEvent), true)
    return prevented
  }
  const words = () => nodesOf('notes-word')
  const shownWords = () => words().filter(node => node.style['display'] === 'block')
  const selections = nodesOf('notes-selection')
  const notice = nodesOf('notes-notice')[0]!
  return {machine, document, content, host, input, caret, selections, notice, scheduled, frame, type, press, key, words, shownWords, lastRead: () => lastRead}
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
  // One rectangle per band for the selection, the caret, the notice, the textarea, and the words.
  assert.equal(content.children.length, notesOptions.bands + 3 + notesWords.length)
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
  // Without the cut of long runs, so that a word can reach past the content box.
  const {input, caret, frame, type, press} = mount({longestWholeSegment: Number.POSITIVE_INFINITY, pieceWidth: 80})
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

test('a press on the note moves the textarea\'s caret to the character that is under the pointer after the press', () => {
  const {machine, input, caret, frame, press} = mount()
  frame()
  // 520,209 is on the note, 109,60 in its content box, left of Photos and above System Monitor. The press raises
  // Notes, the paragraph reflows from lines of 205 px into the whole column, and the caret goes to the character at
  // 109,60 of the new layout: on the second line, whose band spans y 46 to 68, in the word that spans x 109 there.
  press(520, 209)
  let values = frame()
  assert.equal(values[machine.output.notes.lineCount], 5)
  const secondLine = Array.from({length: 89}, (_, segment) => ({segment, ...placeOf(machine, values, segment)})).filter(place => place.y === 46)
  const under = secondLine.filter(place => place.x <= 109).at(-1)!
  assert.equal(under.segment % 2, 0, 'the point is over a word')
  const word = {...under, text: notesWords[under.segment / 2]!}
  assert.ok(109 < word.x + measure(word.text), `'${word.text}' starts at ${word.x}`)
  // The boundary between two of the word's characters that is nearest to x 109.
  let nearest = 0
  for (let characters = 1; characters <= word.text.length; characters++) {
    if (Math.abs(word.x + measure(word.text.slice(0, characters)) - 109) < Math.abs(word.x + measure(word.text.slice(0, nearest)) - 109)) nearest = characters
  }
  assert.ok(nearest > 0 && nearest < word.text.length, 'the caret lands inside the word')
  const offset = notesWords.slice(0, under.segment / 2).join(' ').length + 1 + nearest
  assert.deepEqual(input.selectionCalls, [[offset, offset]])
  // The caret is drawn there in the frame of the press, and the textarea is focused in that frame too.
  assert.deepEqual([caret.style['display'], caret.style['transform']], ['block', `translate3d(${word.x + measure(word.text.slice(0, nearest))}px,${word.y}px,0)`])
  assert.equal(input.focusCalls.length, 1)
  // Later frames move no caret.
  frame()
  frame()
  assert.equal(input.selectionCalls.length, 1)
  // A press right of the last line's end, at 300,120 in the content box, puts the caret at the end of the text.
  press(711, 269)
  values = frame()
  const lastWord = placeOf(machine, values, 88)
  assert.ok(lastWord.y === 112 && lastWord.x + measure('them.') < 300)
  assert.deepEqual(input.selectionCalls, [[offset, offset], [notesText.length, notesText.length]])
  assert.equal(caret.style['transform'], `translate3d(${lastWord.x + measure('them.')}px,112px,0)`)
  // A press that isn't on the note moves no caret, e.g. on Photos' title bar, right of Notes.
  press(1000, 212)
  frame()
  frame()
  assert.equal(input.selectionCalls.length, 2)
})

test('the selection is drawn as one rectangle per line while Notes is focused, and the caret isn\'t drawn with it', () => {
  const {machine, input, caret, selections, frame, press} = mount()
  frame()
  press(450, 126)
  frame()
  assert.ok(selections.every(selection => selection.style['display'] === 'none'))
  // From the second character to the middle of the second line's first word, as Shift and the arrow keys select.
  let values = frame()
  const secondLineStart = Array.from({length: 89}, (_, segment) => segment).find(segment => placeOf(machine, values, segment).y === 46)!
  const secondLineWord = notesWords[secondLineStart / 2]!
  const selectionEnd = notesWords.slice(0, secondLineStart / 2).join(' ').length + 1 + 2
  input.selectionStart = 1
  input.selectionEnd = selectionEnd
  input.selectionDirection = 'forward'
  values = frame()
  const firstLineSegments = Array.from({length: secondLineStart}, (_, segment) => segment)
  const firstLineRight = placeOf(machine, values, secondLineStart - 1).x + measure(' ')
  assert.deepEqual(firstLineSegments.map(segment => placeOf(machine, values, segment).y), firstLineSegments.map(() => 24))
  assert.deepEqual(
    selections.slice(0, 3).map(selection => [selection.style['display'], selection.style['transform'], selection.style['width']]),
    [
      ['block', `translate3d(${24 + measure('T')}px,24px,0)`, `${firstLineRight - 24 - measure('T')}px`],
      ['block', 'translate3d(24px,46px,0)', `${measure(secondLineWord.slice(0, 2))}px`],
      ['none', 'translate3d(0px,68px,0)', '0px'],
    ],
  )
  assert.equal(caret.style['display'], 'none')
  // A collapsed selection draws the caret again, and no rectangle.
  input.selectionStart = input.selectionEnd = 5
  frame()
  assert.equal(caret.style['display'], 'block')
  assert.ok(selections.every(selection => selection.style['display'] === 'none'))
  // While another window is focused, a selection isn't drawn.
  input.selectionStart = 1
  input.selectionEnd = selectionEnd
  press(1000, 212)
  frame()
  assert.ok(selections.every(selection => selection.style['display'] === 'none'))
})

test('the keys that move by lines move the textarea\'s caret along the lines that the program laid out, and other keys stay the browser\'s', () => {
  const {machine, host, input, caret, selections, frame, press, key} = mount()
  frame()
  press(450, 126)
  let values = frame()
  // Notes is in front, and the paragraph has 5 lines. The caret starts at the end of the text, on the fifth.
  const lineOf = (segment: number) => (placeOf(machine, values, segment).y - 24) / 22
  const lineStarts = [0, 1, 2, 3, 4].map(line => Array.from({length: 45}, (_, word) => word).find(word => lineOf(2 * word) === line)!)
  const offsetOfWord = (word: number) => notesWords.slice(0, word).join(' ').length + (word > 0 ? 1 : 0)
  assert.deepEqual([input.selectionStart, lineOf(88)], [notesText.length, 4])
  // The browser keeps the keys that it can handle in a text of one line.
  assert.deepEqual(['ArrowLeft', 'ArrowRight', 'Backspace', 'a', 'Enter'].map(name => key(name)), [false, false, false, false, false])
  // A key at another element isn't the note's.
  assert.equal(host.takesKey({target: null, key: 'ArrowUp'} as unknown as KeyboardEvent), false)
  // ArrowUp: the browser's move is prevented, and the frame moves the caret to the fourth line, at the place
  // nearest to the caret's x.
  const startX = placeOf(machine, values, 88).x + measure('them.')
  assert.equal(key('ArrowUp'), true)
  values = frame()
  const afterUp = input.selectionStart
  assert.deepEqual(input.selectionCalls, [[afterUp, afterUp]])
  assert.ok(afterUp >= offsetOfWord(lineStarts[3]!) && afterUp < offsetOfWord(lineStarts[4]!), `offset ${afterUp} is on the fourth line`)
  const caretX = () => Number(/translate3d\(([-\d.]+)px/.exec(caret.style['transform']!)![1])
  assert.ok(Math.abs(caretX() - startX) < 5, `the caret is at x ${caretX()}, near ${startX}`)
  // Two more ArrowUp keys in one frame, then ArrowUp twice more: the first line, then the start of the text.
  key('ArrowUp')
  key('ArrowUp')
  values = frame()
  assert.ok(input.selectionStart >= offsetOfWord(lineStarts[1]!) && input.selectionStart < offsetOfWord(lineStarts[2]!))
  key('ArrowUp')
  frame()
  assert.ok(input.selectionStart > 0 && input.selectionStart < offsetOfWord(lineStarts[1]!))
  assert.ok(Math.abs(caretX() - startX) < 5, 'the run of moves kept its x')
  key('ArrowUp')
  frame()
  assert.equal(input.selectionStart, 0)
  // End goes to the end of the first line, before the space that hangs there, and Home back to its start.
  assert.equal(key('End'), true)
  frame()
  const firstLineEnd = offsetOfWord(lineStarts[1]!) - 1
  assert.deepEqual([input.selectionStart, input.selectionEnd], [firstLineEnd, firstLineEnd])
  // Shift with ArrowDown selects to the same x on the second line, and Shift with Home shrinks the selection to the
  // second line's start: the first line's hanging space is all that stays selected.
  key('ArrowDown', {shift: true})
  frame()
  assert.equal(input.selectionCalls.at(-1)![2], 'forward')
  assert.deepEqual([input.selectionStart, selections[0]!.style['display'], selections[1]!.style['display'], caret.style['display']], [firstLineEnd, 'block', 'block', 'none'])
  key('ArrowLeft', {shift: true, meta: true})
  frame()
  assert.deepEqual([input.selectionStart, input.selectionEnd], [firstLineEnd, offsetOfWord(lineStarts[1]!)])
  // Command with ArrowRight, without Shift, collapses the selection at the second line's end.
  key('ArrowRight', {meta: true})
  frame()
  const secondLineEnd = offsetOfWord(lineStarts[2]!) - 1
  assert.deepEqual([input.selectionStart, input.selectionEnd, caret.style['display']], [secondLineEnd, secondLineEnd, 'block'])
})

test('a run of letters wider than the column is drawn as pieces that wrap inside the column', () => {
  const {machine, frame, type, press, shownWords, notice} = mount()
  frame()
  press(450, 126)
  frame()
  const run = 'qwertyuiopasdfghjklzxcvbnm'.repeat(3).slice(0, 70)
  type(`see ${run} end`)
  const values = frame()
  const drawn = shownWords().map(node => node.textContent)
  assert.deepEqual([drawn[0], drawn.at(-1), drawn.slice(1, -1).join('')], ['see', 'end', run])
  assert.ok(drawn.length >= 9)
  // Every piece ends inside the 440 px column, which starts at x 24, and the run takes more than one line.
  const places = shownWords().map(node => /translate3d\(([-\d.]+)px,([-\d.]+)px/.exec(node.style['transform']!)!.slice(1).map(Number))
  places.forEach(([x], index) => assert.ok(x! >= 24 && x! + measure(drawn[index]!) <= 24 + 440, `${drawn[index]} at ${x}`))
  assert.deepEqual([...new Set(places.map(([, y]) => y))], [24, 46])
  assert.deepEqual([values[machine.output.notes.lineCount], values[machine.output.notes.truncated], values[machine.output.notes.windowOverflow]], [2, 0, 0])
  assert.equal(notice.style['display'], 'none')
})

test('the note says which capacity its text passes, and writes the sentence only when it changes', () => {
  const {frame, type, press, notice, shownWords, input} = mount()
  // At the start, Photos and System Monitor leave 7 lines, and the paragraph's last 10 words have none.
  frame()
  assert.deepEqual([notice.style['display'], notice.textContent], ['block', 'The last 10 words don\'t fit in the lines that are free.'])
  frame()
  assert.equal(notice.textWrites, 1)
  // With Notes in front, the paragraph fits, and the notice is hidden.
  press(450, 126)
  frame()
  assert.deepEqual([notice.style['display'], notice.textContent, notice.textWrites], ['none', '', 2])
  // 200 words are 399 segments: the cells hold as many segments as there are cells, i.e. half as many words, and
  // the textarea keeps the whole text.
  const long = Array.from({length: 200}, (_, index) => index % 2 === 0 ? 'word' : 'another').join(' ')
  type(long)
  frame()
  assert.deepEqual([notice.style['display'], notice.textContent], ['block', `This text has 399 words and spaces, and the note lays out the first ${notesCapacity}.`])
  assert.equal(shownWords().length, notesCapacity / 2)
  assert.equal(input.value, long)
  // 60 one-letter words: two lines wrap at the walker's window.
  type(Array.from({length: 60}, () => 'i').join(' '))
  frame()
  assert.equal(notice.textContent, 'A line holds 40 words and spaces at most, so 2 lines wrap early.')
  type('short again')
  frame()
  assert.deepEqual([notice.style['display'], notice.textContent], ['none', ''])
})

test('Enter inserts nothing: the textarea refuses a line break before the browser inserts it', () => {
  const {input} = mount()
  const prevented = (inputType: string) => {
    let wasPrevented = false
    input.dispatch('beforeinput', {
      inputType,
      preventDefault() {
        wasPrevented = true
      },
    })
    return wasPrevented
  }
  assert.deepEqual(['insertLineBreak', 'insertParagraph', 'insertText', 'insertFromPaste', 'deleteContentBackward'].map(prevented), [true, true, false, false, false])
})
