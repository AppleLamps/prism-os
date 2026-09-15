// Browser demo: a text field that types mixed Chinese, Japanese, Korean and Latin text and wraps it,
// with one Unicode code point per cell and every break opportunity decided in the circuit. Event
// handlers only queue editor events; one requestAnimationFrame callback runs the circuit (up to 4
// events per evaluation) and projects the outputs onto spans. A hidden textarea receives typed text
// and IME composition, so input methods for CJK work.
// Run from the repo root: bun lab/ui-exploration/code-points/demo.html

import {createEditorMachine, type EditorFrame} from './editor-circuit.ts'
import {measureCircuit} from './integer-circuits.ts'
import {eventForPointer, eventsForKey, eventsForText, takeFrameEvents} from './keyboard.ts'
import {codePointsOf} from './line-break-classes.ts'
import {type EditorView, projectFrame, selectedText} from './projection.ts'
import {type EditorConfig, type EditorEvent, emptyState, layoutSlotCount} from './reference.ts'

// The first slot accepts any key; the other three only keys that don't read line geometry.
const config: EditorConfig = {capacity: 256, lineSlots: 12, pasteLimit: 8, advancePageLimit: 64, keysPerFrame: 4, layoutSlots: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky', positionReads: 'index', overflow: 'cjk whole'}
const unitsPerPixel = 4
const lineHeightPixels = 28
const fontFamily = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Noto Sans CJK SC", Arial, sans-serif'
const fontSizes = [17, 22]
let fontSize = fontSizes[0]!
let fieldWidthPixels = 380

const samples: Record<string, string> = {
  chinese: '排版引擎在浏览器里测量文字，然后用算术决定每一行在哪里结束。',
  japanese: '「かな」と漢字が混ざった文章でも、句読点は行頭に来ません。ラーメンを食べました。',
  korean: '한국어 텍스트도 음절 사이에서 줄을 바꿉니다. 좋아요!',
  mixed: 'Pretext 在 2025年9月 用 $1,299.99 买了 42% 的「well-known」text…',
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found
}

const field = element<HTMLDivElement>('#field')
const content = element<HTMLDivElement>('#content')
const glyphLayer = element<HTMLDivElement>('#glyphs')
const selectionLayer = element<HTMLDivElement>('#selections')
const caret = element<HTMLDivElement>('#caret')
const input = element<HTMLTextAreaElement>('#input')
const stats = element<HTMLDivElement>('#stats')
const warning = element<HTMLDivElement>('#warning')
const widthSlider = element<HTMLInputElement>('#width')
const widthLabel = element<HTMLSpanElement>('#width-label')
const fontButton = element<HTMLButtonElement>('#font')

const measuringContext = document.createElement('canvas').getContext('2d')
if (measuringContext === null) throw new Error('no 2d canvas')
const canvas = measuringContext
function measureAt(size: number) {
  return (codePoint: number) => {
    canvas.font = `${size}px ${fontFamily}`
    return canvas.measureText(String.fromCodePoint(codePoint)).width * unitsPerPixel
  }
}

const buildStart = performance.now()
const machine = createEditorMachine(config, measureAt(fontSize))
const buildMilliseconds = performance.now() - buildStart
const size = measureCircuit(machine.build.circuit, machine.build.roots)

function applyGeometry() {
  machine.setGeometry(fieldWidthPixels * unitsPerPixel, lineHeightPixels * unitsPerPixel)
  content.style.width = `${fieldWidthPixels}px`
  field.style.width = `${fieldWidthPixels}px`
  widthLabel.textContent = `${fieldWidthPixels}px`
}
applyGeometry()

const initial = emptyState(config)
const starterCodes = codePointsOf('Type in any script: 中文、日本語のかな、한국어, or English. 句読点「。」は行頭に来ません。')
starterCodes.slice(0, config.capacity).forEach((codePoint, cell) => {
  initial.cells[cell] = codePoint
})
initial.length = Math.min(config.capacity, starterCodes.length)
initial.caret = initial.length
initial.anchor = initial.length
machine.load(initial)

const queue: EditorEvent[] = []
let frame: EditorFrame = machine.runFrame([])
let scheduled = false
let dragging = false
let droppedCodePoints = 0
let lastStats = {evaluations: 1, keys: 0, milliseconds: 0}
let lastFontChange = ''

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

function queueText(text: string) {
  queue.push(...eventsForText(text, config.pasteLimit))
  schedule()
}

function pointerPosition(pointer: PointerEvent) {
  const box = content.getBoundingClientRect()
  return {x: pointer.clientX - box.left, y: pointer.clientY - box.top}
}

// Keys that move, delete or select go through keydown. Text goes through beforeinput and
// compositionend, so an IME can compose before anything reaches the circuit.
input.addEventListener('keydown', key => {
  const events = eventsForKey({key: key.key, shiftKey: key.shiftKey, altKey: key.altKey, metaKey: key.metaKey, ctrlKey: key.ctrlKey, isComposing: key.isComposing}, config.pasteLimit)
  if (events === null) return
  if (key.key !== 'Enter' && events.every(queued => queued.kind === 'insert')) return
  key.preventDefault()
  queue.push(...events)
  schedule()
})

input.addEventListener('beforeinput', edit => {
  if (edit.isComposing || edit.inputType === 'insertCompositionText') return
  if (edit.inputType === 'insertText' && edit.data !== null) {
    edit.preventDefault()
    queueText(edit.data)
  }
})

input.addEventListener('compositionend', composition => {
  queueText(composition.data)
  input.value = ''
})

field.addEventListener('pointerdown', pointer => {
  input.focus()
  field.setPointerCapture(pointer.pointerId)
  dragging = true
  queue.push(eventForPointer({kind: 'pointerDown', shiftKey: pointer.shiftKey, ...pointerPosition(pointer)}, unitsPerPixel, config.maxWidthLimit))
  pointer.preventDefault()
  schedule()
})

field.addEventListener('pointermove', pointer => {
  if (!dragging) return
  for (const coalesced of pointer.getCoalescedEvents?.() ?? [pointer]) {
    queue.push(eventForPointer({kind: 'pointerDrag', shiftKey: false, ...pointerPosition(coalesced)}, unitsPerPixel, config.maxWidthLimit))
  }
  schedule()
})

const endDrag = () => {
  dragging = false
}
field.addEventListener('pointerup', endDrag)
field.addEventListener('pointercancel', endDrag)

input.addEventListener('paste', paste => {
  paste.preventDefault()
  queueText(paste.clipboardData?.getData('text/plain') ?? '')
})

input.addEventListener('copy', copy => {
  copy.preventDefault()
  copy.clipboardData?.setData('text/plain', selectedText(frame))
})

input.addEventListener('cut', cut => {
  cut.preventDefault()
  cut.clipboardData?.setData('text/plain', selectedText(frame))
  queue.push({kind: 'backspace', shift: false, codes: [], pointerX: 0, pointerY: 0})
  schedule()
})

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
  button.addEventListener('click', () => {
    queueText(samples[button.dataset['sample'] ?? ''] ?? '')
    input.focus()
  })
}

widthSlider.addEventListener('input', () => {
  fieldWidthPixels = Number(widthSlider.value)
  applyGeometry()
  schedule()
})

// A font change re-measures every code point seen so far. Text cells and Unicode tables stay.
fontButton.addEventListener('click', () => {
  fontSize = fontSize === fontSizes[0] ? fontSizes[1]! : fontSizes[0]!
  const rewrite = machine.setFont(measureAt(fontSize))
  document.documentElement.style.setProperty('--glyph-size', `${fontSize}px`)
  fontButton.textContent = `Font size: ${fontSize}px`
  lastFontChange = `font change to ${fontSize}px: ${rewrite.rewrittenEntries} advance entries rewritten (${rewrite.changedEntries} changed), ${rewrite.sourceCellsWritten} source cells written, 0 text cells rewritten`
  schedule()
  input.focus()
})

const glyphSpans: HTMLSpanElement[] = []
const glyphTexts: string[] = []
const selectionBoxes: HTMLDivElement[] = []

function draw(view: EditorView) {
  while (glyphSpans.length < view.glyphs.length) {
    const span = document.createElement('span')
    span.className = 'glyph'
    glyphLayer.appendChild(span)
    glyphSpans.push(span)
    glyphTexts.push('')
  }
  glyphSpans.forEach((span, index) => {
    const glyph = view.glyphs[index]
    if (glyph === undefined) {
      span.style.display = 'none'
      return
    }
    if (glyphTexts[index] !== glyph.text) {
      span.textContent = glyph.text
      glyphTexts[index] = glyph.text
    }
    span.style.display = ''
    span.style.transform = `translate(${glyph.left}px, ${glyph.top}px)`
  })
  while (selectionBoxes.length < view.selections.length) {
    const box = document.createElement('div')
    box.className = 'selection'
    selectionLayer.appendChild(box)
    selectionBoxes.push(box)
  }
  selectionBoxes.forEach((box, index) => {
    const rectangle = view.selections[index]
    box.style.display = rectangle === undefined ? 'none' : ''
    if (rectangle === undefined) return
    box.style.transform = `translate(${rectangle.left}px, ${rectangle.top}px)`
    box.style.width = `${rectangle.width}px`
    box.style.height = `${rectangle.height}px`
  })
  caret.style.transform = `translate(${view.caret.left}px, ${view.caret.top}px)`
  caret.style.height = `${view.caret.height}px`
  // The IME candidate window opens near the focused textarea, so keep it at the caret.
  input.style.transform = `translate(${view.caret.left}px, ${view.caret.top}px)`
  caret.style.animation = 'none'
  void caret.offsetWidth
  caret.style.animation = ''
  content.style.height = `${Math.max(1, view.lineCount) * lineHeightPixels}px`
  stats.textContent = [
    `circuit: ${size.liveOperations.toLocaleString()} live ops (${size.indexReads.toLocaleString()} index reads), ${size.layers} layers, ${size.storedWeights.toLocaleString()} stored weights, built in ${buildMilliseconds.toFixed(0)} ms`,
    `last frame: ${lastStats.keys} events in ${lastStats.evaluations} evaluation${lastStats.evaluations === 1 ? '' : 's'}, ${lastStats.milliseconds.toFixed(2)} ms`,
    `buffer: ${frame.state.length}/${config.capacity} code points, ${view.lineCount}/${config.lineSlots} lines`,
    `advance table: ${machine.advances.seen.length} code points measured, ${machine.advances.pagesInUse()}/${config.advancePageLimit} pages${droppedCodePoints > 0 ? `, ${droppedCodePoints} code points dropped for lack of a page` : ''}`,
    lastFontChange,
  ].filter(line => line !== '').join('\n')
  warning.textContent = view.overflow ? `The text needs more than ${config.lineSlots} lines. Lines past the last slot aren't laid out; delete some text.` : ''
}

function render() {
  scheduled = false
  const start = performance.now()
  let evaluations = 0
  let keys = 0
  do {
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    keys += events.length
    const next = machine.runFrame(events)
    droppedCodePoints += next.droppedCodePoints
    frame = next
    evaluations++
  } while (queue.length > 0 && performance.now() - start < 10)
  lastStats = {evaluations, keys, milliseconds: performance.now() - start}
  draw(projectFrame(machine.advances.advanceOf, frame, unitsPerPixel, lineHeightPixels * unitsPerPixel))
  if (queue.length > 0) schedule()
}

render()
input.focus()
