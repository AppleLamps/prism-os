// DOM wiring for text-rows.html. JavaScript prepares row texts with pretext and the browser's canvas, writes each row's
// table into cells, reads the scroller's size and scrollTop, and writes the program's outputs into styles. Which rows
// are in view, where each one sits, how tall it is and where the view scrolls to come from text-rows.ts.
//
// Query parameters: capacity (default 10000), rows (the rows prepared at load, default capacity - 100) and breakpoints
// (the breakpoint cells per row, default 7), e.g. text-rows.html?capacity=1000&rows=900.
import {measure} from './common.ts'
import {generateMessage, prepareText, prepareTextRows, tabulateTextRow, textRowLayout} from './text-rows-prepare.ts'
import {buildTextRows, createTextRowsMachine, quantizeTextRowsInput, textRowsRoots, type TextRowsInput, type TextRowsOutput} from './text-rows.ts'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`Missing element #${id}`)
  return found as T
}

const scroller = element<HTMLDivElement>('scroller')
const spacer = element<HTMLDivElement>('spacer')
const stats = element<HTMLDivElement>('stats')
const widthInput = element<HTMLInputElement>('width')
const widthValue = element<HTMLSpanElement>('width-value')
const autoAppendInput = element<HTMLInputElement>('auto-append')
const editButton = element<HTMLButtonElement>('edit-above')

const parameters = new URLSearchParams(location.search)
const capacity = Number(parameters.get('capacity') ?? 10_000)
const breakpointCapacity = Number(parameters.get('breakpoints') ?? 7)
const initialRows = Math.min(capacity, Number(parameters.get('rows') ?? capacity - 100))
const slotCount = 64

// Let the page paint "Preparing rows…" before the work below.
await new Promise(resolve => setTimeout(resolve, 0))
const texts = Array.from({length: initialRows}, (_, row) => generateMessage(row))
const prepared = prepareTextRows(texts, breakpointCapacity)
let start = performance.now()
const program = buildTextRows({capacity, slotCount, breakpointCapacity})
const buildMilliseconds = performance.now() - start
start = performance.now()
const machine = createTextRowsMachine(program)
const compileMilliseconds = performance.now() - start
const size = measure(program.circuit, textRowsRoots(program))
prepared.tables.forEach((rowTable, row) => machine.writeRow(row, rowTable))
let rowCount = initialRows
let refusedAppends = 0
let refusedTexts = 0

// cache lifetime: the page, a fixed pool of DOM slots
const slotNodes = Array.from({length: slotCount}, () => {
  const node = document.createElement('div')
  node.className = 'row'
  node.style.display = 'none'
  const text = document.createElement('div')
  text.className = 'text'
  node.append(text)
  spacer.append(node)
  return {node, text, row: -1}
})

let frameRequest: number | undefined
function scheduleRender() {
  if (frameRequest !== undefined) return
  frameRequest = requestAnimationFrame(render)
}

// The same rule as the program's `full` output: the table has no cells past `capacity` rows.
function appendRow(text: string) {
  if (rowCount >= capacity) {
    refusedAppends++
    return false
  }
  try {
    machine.writeRow(rowCount, tabulateTextRow(prepareText(text), breakpointCapacity))
  } catch (error) {
    // Only a text taller than 256 px at 1200 px is refused. Any other error is a bug.
    if (!(error instanceof Error && error.message.startsWith('a text row must be at most'))) throw error
    refusedTexts++
    return false
  }
  texts[rowCount] = text
  rowCount++
  scheduleRender()
  return true
}

let appended = 0
const nextMessage = () => generateMessage(1_000_000 + appended++)

function setRowText(row: number, text: string) {
  machine.writeRow(row, tabulateTextRow(prepareText(text), breakpointCapacity))
  texts[row] = text
  for (const cache of slotNodes) if (cache.row === row) cache.row = -1
  scheduleRender()
}

// Gives the row 2 rows above the top of the view a long text, or a short one when its text is already long. When the
// first row in view is row 0 or 1, no row is 2 rows above it, and the button is disabled.
function editAboveView() {
  const firstRow = lastOutput?.firstRow ?? 0
  if (firstRow < 2) return false
  const row = firstRow - 2
  let text = `Edited row ${row}.`
  if (texts[row]!.length < 300) for (let index = 0; text.length < 600; index++) text += ` ${generateMessage(2_000_000 + row * 16 + index)}`
  setRowText(row, text)
  return true
}

function setContainerWidth(width: number) {
  // The scroller's border and scrollbar, so that clientWidth, the width the program reads, is `width`.
  const gutter = scroller.offsetWidth - scroller.clientWidth
  scroller.style.width = `${width + gutter}px`
  widthInput.value = String(width)
  scheduleRender()
}

const evaluationTimes: number[] = []
const writeTimes: number[] = []
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[values.length >> 1] ?? 0
let lastOutput: TextRowsOutput | undefined
let lastInput: TextRowsInput | undefined
let frames = 0

function render() {
  if (frameRequest !== undefined) cancelAnimationFrame(frameRequest)
  frameRequest = undefined
  // DOM reads
  const frameInput = quantizeTextRowsInput({containerWidth: scroller.clientWidth, viewportHeight: scroller.clientHeight, scrollTop: scroller.scrollTop, rowCount}, capacity)
  const evaluationStart = performance.now()
  const output = machine.step(frameInput)
  const writeStart = performance.now()

  // DOM writes. The spacer's height goes first, so the browser doesn't clamp the new scrollTop.
  spacer.style.height = `${output.totalHeight}px`
  if (output.scrollTop !== frameInput.scrollTop) scroller.scrollTop = output.scrollTop
  let drawn = 0
  let clamped = 0
  output.slots.forEach((slot, index) => {
    const cache = slotNodes[index]!
    if (slot.present !== 1) {
      if (cache.node.style.display !== 'none') cache.node.style.display = 'none'
      return
    }
    drawn++
    clamped += slot.clamped
    cache.node.style.display = 'block'
    cache.node.style.transform = `translateY(${slot.top}px)`
    cache.node.style.height = `${slot.height}px`
    cache.node.style.width = `${slot.layoutWidth}px`
    cache.node.classList.toggle('clamped', slot.clamped === 1)
    if (cache.row !== slot.row) {
      cache.text.textContent = texts[slot.row]!
      cache.node.classList.toggle('odd', slot.row % 2 === 1)
      cache.row = slot.row
    }
  })
  const writeEnd = performance.now()
  evaluationTimes.push((writeStart - evaluationStart) * 1000)
  writeTimes.push((writeEnd - writeStart) * 1000)
  if (evaluationTimes.length > 120) {
    evaluationTimes.shift()
    writeTimes.shift()
  }
  editButton.disabled = output.firstRow < 2
  lastOutput = output
  lastInput = frameInput
  frames++
  widthValue.textContent = `${frameInput.containerWidth} px`
  stats.textContent = [
    `${rowCount.toLocaleString()} of ${capacity.toLocaleString()} rows${output.full === 1 ? `, full (${refusedAppends} appends refused)` : ''}${refusedTexts > 0 ? `, ${refusedTexts} texts refused as too tall` : ''} · first row ${output.firstRow} · ${drawn} of ${slotCount} slots drawn${output.slotOverflow === 1 ? ', rows past the last slot not drawn' : ''} · ${clamped} rows in view laid out at their minimum width`,
    `${size.liveOperations.toLocaleString()} live operations · ${size.layers} layers · ${size.storedWeights.toLocaleString()} stored weights · ${program.circuit.sourceSize.toLocaleString()} source cells, ${(capacity * (breakpointCapacity + 2)).toLocaleString()} of them row tables`,
    `prepare ${initialRows.toLocaleString()} rows: pretext ${prepared.prepareMilliseconds.toFixed(0)} ms, breakpoints ${prepared.tabulateMilliseconds.toFixed(0)} ms · build ${buildMilliseconds.toFixed(0)} ms · compile ${compileMilliseconds.toFixed(0)} ms · median of the last 120 frames: evaluation ${median(evaluationTimes).toFixed(0)} µs, DOM writes ${median(writeTimes).toFixed(0)} µs`,
  ].join('\n')
  window.textRowsDemo = {
    ready: true, frames, capacity, slotCount, breakpointCapacity, rowCount, texts, slotNodes, lastInput, lastOutput,
    evaluationMicroseconds: (writeStart - evaluationStart) * 1000,
    writeMicroseconds: (writeEnd - writeStart) * 1000,
    prepareMilliseconds: prepared.prepareMilliseconds, tabulateMilliseconds: prepared.tabulateMilliseconds, buildMilliseconds, compileMilliseconds, size,
    appendRow, nextMessage, editAboveView, setContainerWidth, textRowLayout, renderNow: render,
  }
}

declare global {
  interface Window {
    // What the browser check reads and drives, see text-rows-browser.ts.
    textRowsDemo?: {
      ready: boolean, frames: number, capacity: number, slotCount: number, breakpointCapacity: number, rowCount: number
      texts: string[], slotNodes: {node: HTMLDivElement, text: HTMLDivElement, row: number}[]
      lastInput: TextRowsInput | undefined, lastOutput: TextRowsOutput | undefined
      evaluationMicroseconds: number, writeMicroseconds: number
      prepareMilliseconds: number, tabulateMilliseconds: number, buildMilliseconds: number, compileMilliseconds: number
      size: ReturnType<typeof measure>
      appendRow: (text: string) => boolean, nextMessage: () => string, editAboveView: () => boolean, setContainerWidth: (width: number) => void
      textRowLayout: typeof textRowLayout
      // Runs a frame now instead of at the next requestAnimationFrame.
      renderNow: () => void
    }
  }
}

widthInput.addEventListener('input', () => setContainerWidth(Number(widthInput.value)))
element<HTMLButtonElement>('append-one').addEventListener('click', () => appendRow(nextMessage()))
element<HTMLButtonElement>('append-many').addEventListener('click', () => {
  for (let index = 0; index < 100; index++) appendRow(nextMessage())
})
editButton.addEventListener('click', editAboveView)
element<HTMLButtonElement>('to-top').addEventListener('click', () => {
  scroller.scrollTop = 0
})
let autoAppendTimer: ReturnType<typeof setInterval> | undefined
autoAppendInput.addEventListener('change', () => {
  if (autoAppendTimer !== undefined) clearInterval(autoAppendTimer)
  autoAppendTimer = autoAppendInput.checked ? setInterval(() => appendRow(nextMessage()), 100) : undefined
})
scroller.addEventListener('scroll', scheduleRender)
// A window resize reaches the ResizeObserver after this frame's animation frame callbacks, so a scheduled render would
// only run in the next frame, and this frame would paint rows laid out for the old width. Rendering now runs before
// paint. A slider resize already rendered in this frame's animation frame callbacks, at this size, so it's skipped.
new ResizeObserver(() => {
  const size = quantizeTextRowsInput({containerWidth: scroller.clientWidth, viewportHeight: scroller.clientHeight, scrollTop: 0, rowCount}, capacity)
  if (lastInput === undefined || size.containerWidth !== lastInput.containerWidth || size.viewportHeight !== lastInput.viewportHeight) render()
}).observe(scroller)
setContainerWidth(Math.max(textRowLayout.minimumContainerWidth, Math.min(textRowLayout.maximumContainerWidth, Math.floor(window.innerWidth - 32 - (scroller.offsetWidth - scroller.clientWidth)))))
render()
