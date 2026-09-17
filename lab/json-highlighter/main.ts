// The page: a textarea over a <pre> of 512 character slots. Each input or caret move schedules one frame, which writes
// the text and the caret into the program's cells, evaluates it, and writes the DOM from output numbers only.
// ?form=brent-kung or ?form=sklansky picks another build of the same program.
import {type ScanForm, createHighlighterMachine, scanForms} from './highlighter.ts'
import {capacity, errorKinds} from './kinds.ts'

const requestedForm = new URLSearchParams(location.search).get('form') as ScanForm | null
const form: ScanForm = requestedForm !== null && scanForms.includes(requestedForm) ? requestedForm : 'loop'
const machine = createHighlighterMachine(form)

const textarea = document.querySelector('textarea')!
const pre = document.querySelector('pre')!
const status = document.querySelector<HTMLElement>('.status')!
const timings = document.querySelector<HTMLElement>('.timings')!

// One span per cell, whose text and class change only when the character or its kind changes.
const slots = Array.from({length: capacity}, () => pre.appendChild(document.createElement('span')))
const endMarker = pre.appendChild(document.createElement('span'))
const pastCapacity = pre.appendChild(document.createElement('span'))
pastCapacity.className = 'past-capacity'
// A textarea shows an empty last line after a trailing line feed, and a <pre> doesn't, so the <pre> gets a space there,
// which keeps both the same height and lets them scroll together.
const lastLine = pre.appendChild(document.createElement('span'))
const slotText = Array<string>(capacity).fill('')
const slotClass = Array<string>(capacity).fill('')

// For the headless Chrome measurement: one entry per rendered frame.
type FrameTiming = {inputToFrameMs: number, evaluateMs: number, domMs: number}
const frameTimings: FrameTiming[] = []
;(window as unknown as {jsonHighlighter: unknown}).jsonHighlighter = {form, frameTimings}

let scheduledFrame: number | null = null
let firstInputTime: number | null = null
const scheduleRender = (event: Event) => {
  firstInputTime ??= event.timeStamp
  scheduledFrame ??= requestAnimationFrame(render)
}
const syncScroll = () => {
  pre.scrollTop = textarea.scrollTop
  pre.scrollLeft = textarea.scrollLeft
}

let renderedText: string | null = null
let renderedCaret = -1

function render(frameTime: number) {
  scheduledFrame = null
  const text = textarea.value
  const codePoints = Array.from(text)
  // The textarea's caret counts UTF-16 code units, and the program counts code points.
  const caret = Array.from(text.slice(0, textarea.selectionStart)).length
  // A keystroke fires input, selectionchange and keyup, and only the first frame after them has anything new.
  if (text === renderedText && caret === renderedCaret) {
    firstInputTime = null
    return
  }
  renderedText = text
  renderedCaret = caret
  const evaluateStart = performance.now()
  const output = machine.run(text, caret)
  const domStart = performance.now()

  const errorPosition = output.firstErrorPosition
  for (let index = 0; index < capacity; index++) {
    const character = codePoints[index] ?? ''
    let className = `k${output.displayKinds[index]}`
    if (index === output.caretBracket || index === output.matchingBracket) className += ' match'
    if (index === errorPosition) className += ' first-error'
    if (slotText[index] !== character) slots[index]!.textContent = slotText[index] = character
    if (slotClass[index] !== className) slots[index]!.className = slotClass[index] = className
  }
  // An error at the end of the text, e.g. unexpectedEnd, has no character to underline.
  endMarker.className = errorPosition !== -1 && errorPosition >= Math.min(codePoints.length, capacity) && output.truncated === 0 ? 'end-marker' : ''
  pastCapacity.textContent = codePoints.length > capacity ? codePoints.slice(capacity).join('') : ''
  lastLine.textContent = text.endsWith('\n') ? ' ' : ''

  if (output.valid === 1) {
    status.textContent = 'Valid JSON.'
  } else {
    const before = codePoints.slice(0, errorPosition)
    const line = before.filter(character => character === '\n').length + 1
    const column = before.length - (before.lastIndexOf('\n') + 1) + 1
    const kind = errorKinds[output.firstErrorKind] ?? 'unknown'
    const extra = output.truncated === 1
      ? ` The text has ${codePoints.length} code points, and the program reads the first ${capacity}.`
      : output.depthExceeded === 1 ? ' Containers nest past depth 16, the program\'s maximum.' : ''
    status.innerHTML = ''
    const message = status.appendChild(document.createElement('span'))
    message.className = 'bad'
    message.textContent = `${kind} at line ${line}, column ${column} (code point ${errorPosition}).${extra}`
  }
  const domEnd = performance.now()
  // A keystroke that adds a line scrolls the textarea before this frame adds the line to the <pre>, where the scroll
  // position was clamped to the shorter content, so both scroll positions are copied again after the DOM writes. Setting
  // them lays out the <pre> here instead of later in the frame, and that layout isn't part of domMs.
  syncScroll()
  const inputTime = firstInputTime ?? frameTime
  firstInputTime = null
  // The frame after the DOM writes, as a stand-in for when the change reaches the screen.
  requestAnimationFrame(() => {
    const timing = {inputToFrameMs: performance.now() - inputTime, evaluateMs: domStart - evaluateStart, domMs: domEnd - domStart}
    frameTimings.push(timing)
    timings.textContent = `${form} build, ${machine.built.circuit.sourceSize} source cells. Last keystroke: evaluate ${timing.evaluateMs.toFixed(2)} ms, DOM writes ${timing.domMs.toFixed(2)} ms, input to next frame ${timing.inputToFrameMs.toFixed(1)} ms.`
  })
}

for (const type of ['input', 'keyup', 'pointerup', 'select']) textarea.addEventListener(type, scheduleRender)
document.addEventListener('selectionchange', scheduleRender)
textarea.addEventListener('scroll', syncScroll)

// Tab types a tab, since the tokenizer has rules for tabs, e.g. a tab between quotes is controlCharacterInString.
// Escape and then Tab moves focus out of the editor, so a keyboard user can still leave it.
let escapePressed = false
textarea.addEventListener('keydown', event => {
  const plainTab = event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  if (plainTab && !escapePressed) {
    event.preventDefault()
    // setRangeText fires no input event, so the frame is scheduled here.
    textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end')
    scheduleRender(event)
  }
  escapePressed = event.key === 'Escape'
})

textarea.value = `{
  "name": "indirect",
  "version": "0.0.1",
  "private": true,
  "scripts": {"test": "bun test", "start": "bun ./index.html"},
  "tags": ["circuit", "ui", 12, -1.5e3, null],
  "escaped": "caf\\u00e9 \\"quoted\\""
}
`
textarea.focus()
textarea.setSelectionRange(1, 1)
scheduleRender(new Event('input'))
