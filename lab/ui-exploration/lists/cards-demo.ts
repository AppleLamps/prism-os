// DOM wiring for cards.html, following chenguini's draggable-cards render loop.
// Handling inputs, layout, animation, and committing state all happen in one
// circuit evaluation (cards.ts); this file records events and projects outputs.
import {measure, hash} from './common.ts'
import {buildCards, cardWidth, createCardsMachine, type CardsFrameInput} from './cards.ts'
import {demoCardSizes} from './traces.ts'

type EventRecord = {pageX: number, pageY: number, timeStamp: number}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`Missing element #${id}`)
  return found as T
}

// The circuit's host contract: times and coordinates on a 1/64 grid.
const onGrid = (value: number) => Math.round(value * 64) / 64
const record = (point: {pageX: number, pageY: number}, timeStamp: number): EventRecord => ({pageX: onGrid(point.pageX), pageY: onGrid(point.pageY), timeStamp: onGrid(timeStamp)})

const stats = element<HTMLDivElement>('stats')
const countInput = element<HTMLSelectElement>('count')
const spacer = element<HTMLDivElement>('spacer')

const events: CardsFrameInput['events'] = {mouseup: null, mousemove: null, pointerdown: null}
let sizes = demoCardSizes(5)
let built = buildCards(sizes)
let machine = createCardsMachine(built, document.documentElement.clientWidth)
let size = measure(built.circuit, built.roots)
// cache lifetime: same as the card count
let domCache: HTMLDivElement[] = []
const stepTimes: number[] = []
let failure: string | undefined

function mount(cardCount: number) {
  for (const node of domCache) node.remove()
  sizes = demoCardSizes(cardCount)
  built = buildCards(sizes)
  machine = createCardsMachine(built, document.documentElement.clientWidth)
  size = measure(built.circuit, built.roots)
  stepTimes.length = 0
  domCache = sizes.map((sizeY, i) => {
    const node = document.createElement('div')
    const rand = hash(i * 2 + 1) * 40 + 40
    node.className = 'row'
    node.textContent = 'Drag Me ' + i
    node.style.width = `${cardWidth}px`
    node.style.height = `${sizeY}px`
    node.style.outline = `1px solid hsl(205, 100%, ${rand}%)`
    node.style.backgroundColor = `hsl(205, 100%, ${rand + 10}%)`
    document.body.appendChild(node)
    return node
  })
  spacer.style.height = `${50 + sizes.reduce((total, sizeY) => total + sizeY, 0) + 100}px`
}

let scheduledRaf: number | null = null
function scheduleRender() {
  if (scheduledRaf != null) return
  scheduledRaf = requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
    scheduledRaf = null
    if (render(now)) scheduleRender()
  })
}

function render(now: number) {
  if (failure !== undefined) return false
  const input: CardsFrameInput = {frameTime: onGrid(now), windowSizeX: document.documentElement.clientWidth, events: {...events}}
  events.mouseup = events.mousemove = events.pointerdown = null
  let output
  const start = performance.now()
  try {
    output = machine.step(input)
  } catch (error) {
    failure = String(error)
    stats.textContent = `stopped: ${failure}`
    return false
  }
  stepTimes.push((performance.now() - start) * 1000)
  if (stepTimes.length > 120) stepTimes.shift()
  const sorted = [...stepTimes].sort((left, right) => left - right)

  // DOM writes
  for (let c = 0; c < domCache.length; c++) {
    const style = domCache[c]!.style
    style.transform = `translate3d(${output.x[c]}px,${output.y[c]}px,0) scale(${output.scale[c]})`
    style.zIndex = String(output.zIndex[c])
    style.boxShadow = output.dragged[c] ? 'rgba(0, 0, 0, 0.2) 0px 16px 32px 0px' : 'rgba(0, 0, 0, 0.2) 0px 1px 2px 0px'
    style.opacity = output.dragged[c] ? '0.7' : '1.0'
  }
  document.body.style.cursor = output.cursor
  stats.textContent = `${domCache.length} cards · ${size.liveOperations.toLocaleString()} live operations · ${size.layers} layers · ${size.storedWeights.toLocaleString()} stored weights · step median ${(sorted[sorted.length >> 1] ?? 0).toFixed(0)} µs`
  return output.stillAnimating
}

window.addEventListener('resize', () => scheduleRender())
window.addEventListener('mouseup', event => { events.mouseup = record(event, event.timeStamp); scheduleRender() })
window.addEventListener('mousemove', event => { events.mousemove = record(event, event.timeStamp); scheduleRender() })
window.addEventListener('pointerdown', event => { events.pointerdown = record(event, event.timeStamp); scheduleRender() })
// Touch events feed the same latches: one sample per kind per frame.
window.addEventListener('touchmove', event => { const touch = event.touches[0]; if (touch !== undefined) { events.mousemove = record(touch, event.timeStamp); scheduleRender() } })
window.addEventListener('touchend', event => { const touch = event.changedTouches[0]; if (touch !== undefined) { events.mouseup = record(touch, event.timeStamp); scheduleRender() } })
window.addEventListener('touchcancel', event => { const touch = event.changedTouches[0]; if (touch !== undefined) { events.mouseup = record(touch, event.timeStamp); scheduleRender() } })
countInput.addEventListener('change', () => {
  failure = undefined
  mount(Number(countInput.value))
  scheduleRender()
})
mount(5)
scheduleRender()
