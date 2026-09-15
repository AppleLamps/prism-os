// Browser demo. Event handlers only queue editor events; one requestAnimationFrame callback runs the
// circuit (up to keysPerFrame events per evaluation) and projects the outputs onto spans.
// Run from the repo root: bun lab/ui-exploration/text-editing/demo.html

import {createEditorMachine, type EditorFrame} from './editor-circuit.ts'
import {measureCircuit} from './integer-circuits.ts'
import {eventForPointer, eventsForKey, eventsForText, takeFrameEvents} from './keyboard.ts'
import {type EditorView, projectFrame, selectedText} from './projection.ts'
import {type EditorConfig, type EditorEvent, emptyState, layoutSlotCount} from './reference.ts'
import {createWidthTable, encodeText} from './width-table.ts'

// Four keys per evaluation: the first may be any key, the other three only keys that don't read
// line geometry (typing, deleting, left and right, word jumps).
const config: EditorConfig = {capacity: 256, lineSlots: 12, pasteLimit: 8, codeLimit: 128, keysPerFrame: 4, layoutSlots: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky'}
const unitsPerPixel = 4
const fieldWidthPixels = 380
const lineHeightPixels = 26
const font = '17px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'

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
const stats = element<HTMLDivElement>('#stats')
const warning = element<HTMLDivElement>('#warning')

const measuringContext = document.createElement('canvas').getContext('2d')
if (measuringContext === null) throw new Error('no 2d canvas')
measuringContext.font = font
const table = createWidthTable(config.codeLimit, unitsPerPixel, text => measuringContext.measureText(text).width)

const buildStart = performance.now()
const machine = createEditorMachine(config)
const buildMilliseconds = performance.now() - buildStart
const size = measureCircuit(machine.build.circuit, machine.build.roots)
machine.setGeometry(fieldWidthPixels * unitsPerPixel, lineHeightPixels * unitsPerPixel)

let syncedEntries = 0
function syncTable() {
  for (; syncedEntries < table.packed.length; syncedEntries++) machine.setTableEntry(syncedEntries, table.packed[syncedEntries]!)
}

const starter = 'This text field keeps its editing model in one fixed circuit. Try typing, Option+arrows, Shift+arrows, up and down, or drag across the text.\nPaste works too.'
const initial = emptyState(config)
encodeText(table, starter).slice(0, config.capacity).forEach((code, cell) => {
  initial.cells[cell] = table.packed[code]!
})
initial.length = Math.min(config.capacity, encodeText(table, starter).length)
initial.caret = initial.length
initial.anchor = initial.length
syncTable()
machine.load(initial)

const queue: EditorEvent[] = []
let frame: EditorFrame = machine.runFrame([])
let scheduled = false
let dragging = false
let lastStats = {evaluations: 1, keys: 0, milliseconds: 0}

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

function pointerPosition(input: PointerEvent) {
  const box = content.getBoundingClientRect()
  return {x: input.clientX - box.left, y: input.clientY - box.top}
}

field.addEventListener('keydown', input => {
  const events = eventsForKey({key: input.key, shiftKey: input.shiftKey, altKey: input.altKey, metaKey: input.metaKey, ctrlKey: input.ctrlKey}, table, config.pasteLimit)
  if (events === null) return
  input.preventDefault()
  queue.push(...events)
  schedule()
})

field.addEventListener('pointerdown', input => {
  field.focus()
  field.setPointerCapture(input.pointerId)
  dragging = true
  queue.push(eventForPointer({kind: 'pointerDown', shiftKey: input.shiftKey, ...pointerPosition(input)}, unitsPerPixel, config.maxWidthLimit))
  input.preventDefault()
  schedule()
})

field.addEventListener('pointermove', input => {
  if (!dragging) return
  for (const coalesced of input.getCoalescedEvents?.() ?? [input]) {
    queue.push(eventForPointer({kind: 'pointerDrag', shiftKey: false, ...pointerPosition(coalesced)}, unitsPerPixel, config.maxWidthLimit))
  }
  schedule()
})

const endDrag = () => {
  dragging = false
}
field.addEventListener('pointerup', endDrag)
field.addEventListener('pointercancel', endDrag)

document.addEventListener('paste', input => {
  if (document.activeElement !== field) return
  input.preventDefault()
  queue.push(...eventsForText(input.clipboardData?.getData('text/plain') ?? '', table, config.pasteLimit))
  schedule()
})

document.addEventListener('copy', input => {
  if (document.activeElement !== field) return
  input.preventDefault()
  input.clipboardData?.setData('text/plain', selectedText(table, frame))
})

document.addEventListener('cut', input => {
  if (document.activeElement !== field) return
  input.preventDefault()
  input.clipboardData?.setData('text/plain', selectedText(table, frame))
  queue.push({kind: 'backspace', shift: false, codes: [], pointerX: 0, pointerY: 0})
  schedule()
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
  // Restart the blink so the caret is visible right after it moves.
  caret.style.animation = 'none'
  void caret.offsetWidth
  caret.style.animation = ''
  // While the text needs more than lineSlots lines, the lines past the last slot aren't laid out, and the circuit's caret
  // output can't be drawn, e.g. it put the caret at x = 4,096 px. The caret stays hidden until the text fits, and the
  // warning below says why.
  caret.hidden = view.overflow
  content.style.height = `${Math.max(1, view.lineCount) * lineHeightPixels}px`
  stats.textContent = [
    `circuit: ${size.liveOperations.toLocaleString()} live ops, ${size.layers} layers, ${size.storedWeights.toLocaleString()} stored weights, ${size.gatherReads} gather reads (built in ${buildMilliseconds.toFixed(0)} ms)`,
    `last frame: ${lastStats.keys} events in ${lastStats.evaluations} evaluation${lastStats.evaluations === 1 ? '' : 's'}, ${lastStats.milliseconds.toFixed(2)} ms`,
    `buffer: ${frame.state.length}/${config.capacity} cells, ${view.lineCount}/${config.lineSlots} lines, ${table.graphemes.length - 1}/${config.codeLimit - 1} table entries`,
  ].join('\n')
  warning.textContent = view.overflow ? `The text needs more than ${config.lineSlots} lines. Lines past the last slot aren't laid out, and the caret is hidden until the text fits; delete some text.` : ''
}

function render() {
  scheduled = false
  syncTable()
  const start = performance.now()
  let evaluations = 0
  let keys = 0
  do {
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    keys += events.length
    frame = machine.runFrame(events)
    evaluations++
  } while (queue.length > 0 && performance.now() - start < 10)
  lastStats = {evaluations, keys, milliseconds: performance.now() - start}
  draw(projectFrame(table, frame, lineHeightPixels * unitsPerPixel))
  if (queue.length > 0) schedule()
}

render()
field.focus()
