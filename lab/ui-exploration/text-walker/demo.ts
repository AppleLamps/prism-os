// A paragraph flowing around a draggable window, with one spring per word, all from one circuit.
// All layout logic lives in flow.ts, fast-walker.ts and word-springs.ts; this file only measures
// the text, writes pointer and time inputs into the source table, and projects outputs onto the DOM.
import {layoutNextLineRange, prepareWithSegments} from './pretext-src/layout.ts'
import {getEngineProfile} from './pretext-src/measurement.ts'
import {viewPrepared} from './fake-canvas.ts'
import {fastParagraph, fastWindow} from './fast-walker.ts'
import {buildFlowCircuit, referenceFlow, writeFlowState, writeSpringState, type FlowOutputs, type FlowState} from './flow.ts'
import {defaultSpringConfig} from './word-springs.ts'

const font = '18px Georgia, "Times New Roman", serif'
const boldFont = `bold ${font}`
const lineHeight = 28
const bandCount = 20
const top = 16
const columnLeft = 20
const maximumColumnWidth = 600
const text =
  'Text layout is usually a loop: take the next word, check whether it still fits, and start a new line when it does not. ' +
  'Here that loop is written as arithmetic instead. Every band of this paragraph asks the same question of the same numbers, ' +
  'where would a line that starts at this word end if it were this wide, and a count of comparisons answers it. ' +
  'Drag the window over the text and every line narrows around it. Click a word to make it bold; its width changes in the table, ' +
  'and the paragraph breaks again without compiling anything new. Each word then follows its own spring to its new place.'

const app = document.getElementById('app')!
app.className = 'page'
app.innerHTML = `
  <h1>Text walker circuit</h1>
  <p class="lead">pretext measures the words once. One compiled circuit of affine, ReGLU and boolean atoms then carves each band around the window, breaks the lines with each band's own width, places every word, and steps every word's spring.</p>
`

function fail(message: string): never {
  const error = document.createElement('p')
  error.className = 'error'
  error.textContent = message
  app.appendChild(error)
  throw new Error(message)
}

const prepared = prepareWithSegments(text, font)
const boldPrepared = prepareWithSegments(text, boldFont)
const view = viewPrepared(prepared)
if (!view.simpleLineWalkFastPath) fail('This text needs pretext features beyond the fast path.')
if (boldPrepared.segments.length !== prepared.segments.length) fail('Bold text segmented differently.')
const paragraph = fastParagraph(prepared)
const regularWidths = [...paragraph.widths]
const boldWidths = [...viewPrepared(boldPrepared).widths]
const epsilon = getEngineProfile().lineFitEpsilon
// Bold words are wider, so the window from the regular widths bounds every line.
const window = fastWindow(paragraph, maximumColumnWidth, epsilon)
const textSegments = paragraph.breakAfter.flatMap((bit, index) => bit === 0 ? [index] : [])
// Every slot is at least as wide as the widest bold word, so the fast path never needs an emergency break.
const minimumSlotWidth = Math.max(80, Math.ceil(Math.max(...boldWidths)) + 1)
const flowOptions = {top, lineHeight, bandCount, horizontalPadding: 12, verticalPadding: 4, minimumSlotWidth}

const buildStarted = performance.now()
const build = buildFlowCircuit(paragraph, {...flowOptions, window, epsilon, springSegments: textSegments, springConfig: defaultSpringConfig})
const buildMilliseconds = performance.now() - buildStarted
const table = build.fc.source.table()

const state: FlowState = {columnLeft, columnWidth: 520, obstacleX: 300, obstacleY: 120, obstacleWidth: 200, obstacleHeight: 150}
writeFlowState(build, table, state)

const layout = document.createElement('div')
layout.className = 'layout'
app.appendChild(layout)
const stage = document.createElement('div')
stage.className = 'stage'
stage.style.width = `${columnLeft * 2 + maximumColumnWidth}px`
stage.style.height = `${top * 2 + bandCount * lineHeight}px`
stage.style.font = font
layout.appendChild(stage)

const slotElements = Array.from({length: bandCount}, () => {
  const element = document.createElement('div')
  element.className = 'slot'
  stage.appendChild(element)
  return element
})
const bold = paragraph.widths.map(() => false)
const wordElements = textSegments.map((segment, index) => {
  const element = document.createElement('span')
  element.className = 'word'
  element.textContent = prepared.segments[segment]!
  element.addEventListener('click', () => {
    bold[segment] = !bold[segment]
    element.classList.toggle('bold', bold[segment])
    const width = bold[segment] ? boldWidths[segment]! : regularWidths[segment]!
    table[build.fc.widthCells[segment]!] = width
    // The reference walker reads the prepared widths, so it sees the same edit.
    view.widths[segment] = width
    paragraph.widths[segment] = width
    geometryChanged = true
  })
  stage.appendChild(element)
  return {element, index}
})

const windowElement = document.createElement('div')
windowElement.className = 'window'
windowElement.innerHTML = '<div class="title"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>Drag me</span></div><div class="body">The text flows around this rectangle.</div>'
stage.appendChild(windowElement)
const titleBar = windowElement.querySelector<HTMLElement>('.title')!
let grab: {x: number, y: number} | null = null
titleBar.addEventListener('pointerdown', event => {
  titleBar.setPointerCapture(event.pointerId)
  grab = {x: event.clientX - state.obstacleX, y: event.clientY - state.obstacleY}
})
titleBar.addEventListener('pointermove', event => {
  if (grab === null) return
  // Rounded once at the boundary, so every geometry comparison in the circuit is an integer comparison.
  // Clamped to stay inside the declared ranges of the obstacle cells.
  state.obstacleX = Math.max(-2000, Math.min(4000, Math.round(event.clientX - grab.x)))
  state.obstacleY = Math.max(-2000, Math.min(4000, Math.round(event.clientY - grab.y)))
  writeFlowState(build, table, state)
  geometryChanged = true
})
titleBar.addEventListener('pointerup', () => { grab = null })

const panel = document.createElement('div')
panel.className = 'panel'
panel.innerHTML = `
  <label>Column width <span id="column-width"></span><input id="column-slider" type="range" min="280" max="${maximumColumnWidth}" step="1" value="${state.columnWidth}"></label>
  <table id="stats"></table>
`
layout.appendChild(panel)
const columnSlider = panel.querySelector<HTMLInputElement>('#column-slider')!
const columnLabel = panel.querySelector<HTMLElement>('#column-width')!
columnSlider.addEventListener('input', () => {
  state.columnWidth = Number(columnSlider.value)
  writeFlowState(build, table, state)
  geometryChanged = true
})

let geometryChanged = true
let checkedStates = 0
let mismatchedStates = 0
const recentMicroseconds: number[] = []

// Real canvas widths aren't multiples of 1/4 px, so FP32 sums in the circuit and float64 sums in
// pretext can differ in their last bits. Widths and x are compared within 0.01 px; line starts,
// usable bands, visibility and y must be equal.
function checkAgainstPretext(outputs: FlowOutputs) {
  const reference = referenceFlow(layoutNextLineRange as never, prepared, paragraph, state, flowOptions)
  let mismatch = outputs.windowOverflow !== 0 || outputs.runOverflow !== 0
  reference.bands.forEach((band, index) => {
    const actual = outputs.bands[index]!
    if (actual.usable !== (band.usable ? 1 : 0)) mismatch = true
    if (band.line !== null && (actual.start !== band.line.start.segmentIndex || Math.abs(actual.lineWidth - band.line.width) > 0.01)) mismatch = true
  })
  for (const segment of textSegments) {
    const expected = reference.segments[segment]!
    const actual = outputs.segments[segment]!
    if (actual.visible !== (expected.visible ? 1 : 0) || (expected.visible && (Math.abs(actual.x - expected.x) > 0.01 || actual.y !== expected.y))) mismatch = true
  }
  checkedStates++
  if (mismatch) {
    mismatchedStates++
    console.warn('circuit and pretext disagree', {state: {...state}, outputs, reference})
  }
}

function evaluate(steps: number): FlowOutputs {
  table[build.cells.stepCount] = steps
  const started = performance.now()
  const values = build.compiled.evaluate(table)
  recentMicroseconds.push((performance.now() - started) * 1000)
  if (recentMicroseconds.length > 120) recentMicroseconds.shift()
  return build.decode(values)
}

// Start every word at its first position, without animation.
{
  const outputs = evaluate(0)
  textSegments.forEach((segment, index) => {
    table[build.cells.positionX[index]!] = outputs.segments[segment]!.x
    table[build.cells.positionY[index]!] = outputs.segments[segment]!.y
  })
}

const stepMilliseconds = defaultSpringConfig.stepSeconds * 1000
const maximumSteps = 2 ** defaultSpringConfig.stepBits - 1
let previousTime = performance.now()
let leftoverMilliseconds = 0
let frameCount = 0

function renderStats() {
  const size = build.compiled.size
  const sorted = [...recentMicroseconds].sort((left, right) => left - right)
  const median = sorted[sorted.length >> 1] ?? 0
  const rows: [string, string][] = [
    ['Segments / words', `${paragraph.widths.length} / ${textSegments.length}`],
    ['Bands', `${bandCount}`],
    ['Source cells', `${size.sourceCells}`],
    ['Live operations', `${size.liveOperations}`],
    ['Of which integer one-hots', `${size.oneHotOperations}`],
    ['Layers', `${size.layers}`],
    ['Stored weights', `${size.storedWeights}`],
    ['Gather reads', `${size.gatherReads}`],
    ['Compile time', `${buildMilliseconds.toFixed(0)} ms`],
    ['Evaluation (median)', `${median.toFixed(0)} µs`],
    ['States checked against pretext', `${checkedStates}`],
    ['Mismatches', `${mismatchedStates}`],
  ]
  panel.querySelector('#stats')!.innerHTML = rows.map(([name, value]) => `<tr><td>${name}</td><td>${value}</td></tr>`).join('')
  columnLabel.textContent = `${state.columnWidth}px`
}

function frame(now: number) {
  // A frame's timestamp can be earlier than the performance.now() taken before the frame was requested, e.g. on the
  // first frame after the long circuit build, so a negative elapsed time counts as 0 and the step count stays within 0..maximumSteps.
  const elapsed = Math.min(Math.max(0, now - previousTime), 1000) + leftoverMilliseconds
  previousTime = now
  const steps = Math.min(maximumSteps, Math.floor(elapsed / stepMilliseconds))
  leftoverMilliseconds = steps === maximumSteps ? 0 : elapsed - steps * stepMilliseconds
  const outputs = evaluate(steps)
  writeSpringState(build, table, outputs)
  if (geometryChanged) {
    checkAgainstPretext(outputs)
    geometryChanged = false
  }
  outputs.bands.forEach((band, index) => {
    const element = slotElements[index]!
    element.style.opacity = band.usable === 1 ? '1' : '0'
    element.style.transform = `translate(${band.left}px, ${top + index * lineHeight}px)`
    element.style.width = `${band.slotWidth}px`
    element.style.height = `${lineHeight}px`
  })
  for (const {element, index} of wordElements) {
    const spring = outputs.springs[index]!
    const segment = textSegments[index]!
    element.style.transform = `translate(${spring.x}px, ${spring.y + (lineHeight - 18) / 2 - 3}px)`
    element.style.opacity = outputs.segments[segment]!.visible === 1 ? '1' : '0'
  }
  windowElement.style.transform = `translate(${state.obstacleX}px, ${state.obstacleY}px)`
  windowElement.style.width = `${state.obstacleWidth}px`
  windowElement.style.height = `${state.obstacleHeight}px`
  if (frameCount++ % 15 === 0) renderStats()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
