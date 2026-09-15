// DOM wiring for list.html. All decisions (which rows are visible, which slot
// holds which row, where each slot sits) come from the circuit in list.ts.
import {demoRowHeights} from './checks.ts'
import {measure} from './common.ts'
import {buildList, createListRunner, slotCount, type ListVariant} from './list.ts'

const rowCount = 10_000

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`Missing element #${id}`)
  return found as T
}

const scroller = element<HTMLDivElement>('scroller')
const spacer = element<HTMLDivElement>('spacer')
const stats = element<HTMLDivElement>('stats')
const oneHotInput = element<HTMLInputElement>('one-hot')
const newHeightsButton = element<HTMLButtonElement>('new-heights')

// cache lifetime: same as the page (a fixed pool of slots)
const domCache = Array.from({length: slotCount}, (_, slot) => {
  const node = document.createElement('div')
  node.className = 'slot'
  const swatch = document.createElement('div')
  swatch.className = 'swatch'
  const label = document.createElement('span')
  const slotLabel = document.createElement('span')
  slotLabel.className = 'slot-index'
  slotLabel.textContent = `slot ${slot}`
  node.append(swatch, label, slotLabel)
  spacer.append(node)
  return {node, swatch, label, row: -1}
})

// Row data that stays in JS, keyed by the circuit's row index.
const labels = Array.from({length: rowCount}, (_, row) => `Row ${row}`)
// Numeric row data that can also live in the source table and be read through the slot one-hots.
const hues = Array.from({length: rowCount}, (_, row) => (row * 137) % 360)

const state = {kind: 'uniform' as 'uniform' | 'variable', oneHot: false, heightSeed: 1}
let heights: number[] = []
let list = buildList({kind: 'uniform', rowCount, rowHeight: 40, dataRead: 'js'})
let runner = createListRunner(list)
let size = measure(list.circuit, list.roots)
let buildMs = 0
const evaluationTimes: number[] = []

function rebuild() {
  const variant: ListVariant = state.kind === 'uniform'
    ? {kind: 'uniform', rowCount, rowHeight: 40, dataRead: state.oneHot ? 'oneHot' : 'js'}
    : {kind: 'variable', rowCount, minimumHeight: 36, maximumHeight: 72, prefix: 'brentKung', dataRead: state.oneHot ? 'oneHot' : 'js'}
  const start = performance.now()
  list = buildList(variant)
  runner = createListRunner(list)
  buildMs = performance.now() - start
  heights = state.kind === 'uniform' ? Array.from({length: rowCount}, () => 40) : demoRowHeights(rowCount, state.heightSeed, 36, 72)
  if (state.kind === 'variable') runner.setRows(heights)
  if (state.oneHot) runner.setData(hues)
  size = measure(list.circuit, list.roots)
  evaluationTimes.length = 0
  for (const cache of domCache) cache.row = -1
}

let scheduled = false
function scheduleRender() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(function renderList() {
    scheduled = false
    render()
  })
}

function render() {
  // DOM reads. Floor scrollTop onto the circuit's quarter-pixel grid. At devicePixelRatio 1, 2, and 4 it's already on that grid; at ratios like 1.5 or 3 the floor moves it by less than 1/4 px.
  const scrollTop = Math.floor(scroller.scrollTop * 4) / 4
  const viewportHeight = Math.min(list.maximumViewportHeight, scroller.clientHeight)
  const start = performance.now()
  const frame = runner.run(scrollTop, viewportHeight)
  evaluationTimes.push((performance.now() - start) * 1000)
  if (evaluationTimes.length > 120) evaluationTimes.shift()
  const sorted = [...evaluationTimes].sort((left, right) => left - right)

  // DOM writes
  spacer.style.height = `${frame.totalHeight}px`
  const present = Array<boolean>(slotCount).fill(false)
  for (const entry of frame.rows) {
    present[entry.slot] = true
    const cache = domCache[entry.slot]!
    cache.node.style.display = 'flex'
    cache.node.style.transform = `translateY(${entry.y}px)`
    cache.node.style.height = `${heights[entry.row]}px`
    cache.swatch.style.background = `hsl(${entry.data ?? hues[entry.row]} 70% 55%)`
    if (cache.row !== entry.row) {
      cache.label.textContent = labels[entry.row]!
      cache.row = entry.row
    }
  }
  domCache.forEach((cache, slot) => {
    if (!present[slot]) cache.node.style.display = 'none'
  })
  stats.textContent = `${rowCount.toLocaleString()} rows, ${frame.rows.length} drawn · ${size.liveOperations.toLocaleString()} live operations · ${size.layers} layers · ${size.storedWeights.toLocaleString()} stored weights · ${list.circuit.sourceSize.toLocaleString()} source cells · build ${buildMs.toFixed(0)} ms · evaluation median ${(sorted[sorted.length >> 1] ?? 0).toFixed(1)} µs`
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="kind"]')) {
  radio.addEventListener('change', () => {
    state.kind = radio.value as 'uniform' | 'variable'
    rebuild()
    scheduleRender()
  })
}
oneHotInput.addEventListener('change', () => {
  state.oneHot = oneHotInput.checked
  rebuild()
  scheduleRender()
})
newHeightsButton.addEventListener('click', () => {
  state.heightSeed++
  if (state.kind === 'variable') {
    heights = demoRowHeights(rowCount, state.heightSeed, 36, 72)
    runner.setRows(heights)
  }
  scheduleRender()
})
scroller.addEventListener('scroll', () => scheduleRender())
window.addEventListener('resize', () => scheduleRender())
rebuild()
render()
