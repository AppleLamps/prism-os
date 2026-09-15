// A streamed chat whose words, bubbles and Stop all come from one circuit. The logic lives in
// chat-demo.ts; this file reads inputs into transient state, runs a frame, and projects the outputs.
import * as pretext from './pretext-src/layout.ts'
import {ChatDemo, demoLayout, maximumWidth, minimumWidth, columnWidthFor} from './chat-demo.ts'
import {type SpawnMode} from './stream-circuit.ts'
import {type ChunkMode} from './stream-model.ts'

const font = '16px Georgia, "Times New Roman", serif'

const app = document.getElementById('app')!
app.className = 'page'
app.innerHTML = `
  <h1>Streaming words circuit</h1>
  <p class="lead">Each word of this conversation is one segment in one compiled circuit of affine, ReGLU and boolean atoms. The circuit breaks lines, places every word, springs it, and reduces each speaker's words into a bubble. Stop writes back the count of segments that had arrived when you pressed.</p>
`

let demo: ChatDemo
try {
  demo = new ChatDemo(pretext, font, performance.now())
} catch (error) {
  const message = document.createElement('p')
  message.className = 'error'
  message.textContent = String(error)
  app.appendChild(message)
  throw error
}

// Transient input state, reset at the end of every render.
const st = {
  events: {
    stopDown: null as number | null,
    stopClick: null as number | null,
    restart: false,
    width: null as number | null,
    chunkMode: null as ChunkMode | null,
    spawn: null as SpawnMode | null,
  },
}

const layout = document.createElement('div')
layout.className = 'layout'
app.appendChild(layout)
const stage = document.createElement('div')
stage.className = 'stage'
stage.style.font = font
layout.appendChild(stage)

const panel = document.createElement('div')
panel.className = 'panel'
panel.innerHTML = `
  <div class="controls">
    <button class="stop" id="stop">Stop</button>
    <button id="restart">Restart</button>
  </div>
  <label>Chunks<select id="chunks"><option value="1">1 character</option><option value="3" selected>3 characters</option><option value="word">whole words</option></select></label>
  <label>Arriving words<select id="spawn"><option value="in-place" selected>fade in at their place</option><option value="from-previous">slide out of the previous word</option></select></label>
  <label>Bubble text width <span id="width-label"></span><input id="width" type="range" min="${minimumWidth}" max="${maximumWidth}" step="1" value="${demo.maxWidth}"></label>
  <table id="stats"></table>
  <p class="mismatch" id="mismatch"></p>
`
layout.appendChild(panel)
const stopButton = panel.querySelector<HTMLButtonElement>('#stop')!
const widthSlider = panel.querySelector<HTMLInputElement>('#width')!
const widthLabel = panel.querySelector<HTMLElement>('#width-label')!
const statsTable = panel.querySelector<HTMLElement>('#stats')!
const mismatchLine = panel.querySelector<HTMLElement>('#mismatch')!

stopButton.addEventListener('pointerdown', event => {
  st.events.stopDown = event.timeStamp
  scheduleRender()
})
stopButton.addEventListener('click', event => {
  st.events.stopClick = event.timeStamp
  scheduleRender()
})
panel.querySelector('#restart')!.addEventListener('click', () => {
  st.events.restart = true
  scheduleRender()
})
panel.querySelector<HTMLSelectElement>('#chunks')!.addEventListener('change', event => {
  const value = (event.target as HTMLSelectElement).value
  st.events.chunkMode = value === 'word' ? 'word' : value === '1' ? 1 : 3
  scheduleRender()
})
panel.querySelector<HTMLSelectElement>('#spawn')!.addEventListener('change', event => {
  st.events.spawn = (event.target as HTMLSelectElement).value === 'from-previous' ? 'from-previous' : 'in-place'
  scheduleRender()
})
widthSlider.addEventListener('input', () => {
  st.events.width = Number(widthSlider.value)
  scheduleRender()
})

type DomCache = {
  bubbles: HTMLDivElement[] // cache lifetime: same as the script
  words: {element: HTMLSpanElement, text: string}[] // cache lifetime: same as the script; text is the last written textContent
}
const domCache: DomCache = {bubbles: [], words: []}
function ensureNodes(segmentCount: number, turnCount: number) {
  while (domCache.bubbles.length < turnCount) {
    const element = document.createElement('div')
    element.className = `bubble ${domCache.bubbles.length % 2 === 0 ? 'user' : 'assistant'}`
    stage.appendChild(element)
    domCache.bubbles.push(element)
  }
  while (domCache.words.length < segmentCount) {
    const element = document.createElement('span')
    element.className = 'word'
    stage.appendChild(element)
    domCache.words.push({element, text: ''})
  }
}

let frameCount = 0
function render(now: number): boolean {
  // Handle inputs.
  const {events} = st
  if (events.chunkMode !== null) demo.setChunkMode(events.chunkMode, now)
  if (events.spawn !== null) demo.setSpawn(events.spawn, now)
  if (events.restart) demo.restart(now)
  if (events.width !== null) demo.setWidth(events.width)
  if (events.stopDown !== null) demo.pressStop(events.stopDown)
  if (events.stopClick !== null) demo.releaseStop(events.stopClick)
  st.events = {stopDown: null, stopClick: null, restart: false, width: null, chunkMode: null, spawn: null}

  // Layout, springs and bubbles: one evaluation.
  const outputs = demo.frame(now)
  const projection = demo.projection(outputs)
  const stats = demo.stats()

  // DOM writes.
  ensureNodes(projection.words.length, projection.bubbles.length)
  stage.style.width = `${columnWidthFor(demo.maxWidth) + 2 * demoLayout.left}px`
  stage.style.height = `${Math.max(320, projection.contentHeight)}px`
  projection.bubbles.forEach((bubble, index) => {
    const element = domCache.bubbles[index]!
    element.style.transform = `translate(${bubble.left}px, ${bubble.top}px)`
    element.style.width = `${Math.max(0, bubble.width)}px`
    element.style.height = `${Math.max(0, bubble.height)}px`
    element.style.opacity = `${bubble.opacity}`
  })
  projection.words.forEach((word, index) => {
    const cached = domCache.words[index]!
    if (cached.text !== word.text) {
      cached.element.textContent = word.text
      cached.text = word.text
    }
    // Georgia's glyphs sit a little high in a 24 px line.
    cached.element.style.transform = `translate(${word.x}px, ${word.y + 3}px)`
    cached.element.style.opacity = `${word.opacity}`
  })
  // The panel refreshes every 10th frame, and on the frame that ends a render loop, so a change that
  // settles within a few frames, e.g. a width change, doesn't leave the label and stats stale.
  const animating = demo.animating()
  if (frameCount++ % 10 === 0 || !animating) {
    widthLabel.textContent = `${demo.maxWidth}px`
    const rows: [string, string][] = [
      ['Segments arrived / capacity', `${stats.arrived} / ${stats.segments}`],
      ['Live operations', stats.liveOperations.toLocaleString('en-US')],
      ['Layers', `${stats.layers}`],
      ['Stored weights', stats.storedWeights.toLocaleString('en-US')],
      ['Compile time', `${stats.buildMilliseconds.toFixed(0)} ms`],
      ['Evaluation (median)', `${stats.medianEvaluationMicroseconds.toFixed(0)} µs`],
      ['States checked against pretext', `${stats.checkedStates}`],
      ['Mismatched states', `${stats.mismatchedStates}`],
      ['Line changes of visible words', `${stats.lineChanges}`],
      ['Cells written by the last Stop', stats.lastStopWrites === null ? '-' : `${stats.lastStopWrites}`],
      ['Words fading out after the last Stop', `${stats.lastStopFading}`],
    ]
    statsTable.innerHTML = rows.map(([name, value]) => `<tr><td>${name}</td><td>${value}</td></tr>`).join('')
    mismatchLine.textContent = demo.firstMismatch === null ? '' : `First mismatch: ${demo.firstMismatch}`
  }
  return animating
}

// The page stops rendering once everything settles, while the session steps springs from where its
// last frame ended. So when an input starts a new render loop, bring that time forward to the input:
// the springs were at rest, and otherwise the first frame would step through the idle time, up to 255
// steps (1,020 ms), and words would jump to their new places, e.g. after a width change.
let scheduledRaf: number | null = null
let renderLoopRunning = true
function scheduleRender() {
  if (scheduledRaf !== null) return
  if (!renderLoopRunning) {
    demo.session.animatedUntil = Math.max(demo.session.animatedUntil, performance.now())
    renderLoopRunning = true
  }
  scheduledRaf = requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduledRaf = null
    renderLoopRunning = render(now)
    if (renderLoopRunning) scheduleRender()
  })
}
scheduleRender()
