// Browser glue for two workloads from workloads.ts: a fixed-height list of
// 10,000 rows filling 24 DOM slots, and a photo strip centered on the focused
// photo. Event listeners write source cells; the circuit computes every slot's
// row, position, and fields, and every photo's position; this file only copies
// outputs into styles and text. Run: bun lab/ui-exploration/index-read/demo.html
import {type CompileMode, compileModes, programStatistics} from './measure.ts'
import {buildPhotoStrip, buildVirtualList, type Construction} from './workloads.ts'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing #${id}`)
  return found as T
}

// ---------------------------------------------------------------- list

const listOptions = {rowCount: 10_000, fieldCount: 3, slotCount: 24, rowHeight: 28}
const listVariants: Record<string, {construction: Construction, mode: CompileMode}> = {
  instruction: {construction: 'instruction', mode: compileModes.all},
  lowered: {construction: 'one-hot', mode: compileModes.lowered},
  gather: {construction: 'one-hot', mode: compileModes.gather},
}

const scroller = element<HTMLDivElement>('scroller')
const spacer = element<HTMLDivElement>('spacer')
const listStats = element<HTMLParagraphElement>('list-stats')
const constructionSelect = element<HTMLSelectElement>('construction')
spacer.style.height = `${listOptions.rowCount * listOptions.rowHeight}px`
const slotElements = Array.from({length: listOptions.slotCount}, () => {
  const slot = document.createElement('div')
  slot.className = 'slot'
  spacer.append(slot)
  return slot
})

function createList(variantName: string) {
  const variant = listVariants[variantName]!
  const started = performance.now()
  const built = buildVirtualList(listOptions, variant.construction)
  const statistics = programStatistics(
    built.circuit.compileTensorProgram(built.roots, variant.mode.lowerGathers, variant.mode.options),
  )
  const evaluate = built.circuit.createTensorEvaluator(built.roots, variant.mode.lowerGathers, variant.mode.options)
  return {built, evaluate, source: built.layout.table(), statistics, buildMilliseconds: performance.now() - started}
}

let list = createList('instruction')
let listScheduled = false

function renderList() {
  listScheduled = false
  const maximum = (listOptions.rowCount - 1) * listOptions.rowHeight
  const scrollTop = Math.min(maximum, Math.max(0, Math.round(scroller.scrollTop)))
  list.source[list.built.scrollTop] = scrollTop
  const started = performance.now()
  const output = list.evaluate(list.source)
  const elapsed = performance.now() - started
  // Outputs: firstRow, then per slot present, translateY, and the three fields.
  const perSlot = 2 + listOptions.fieldCount
  slotElements.forEach((slot, index) => {
    const at = 1 + index * perSlot
    slot.hidden = output[at] === 0
    slot.style.transform = `translateY(${output[at + 1]! + scrollTop}px)`
    slot.style.background = `hsl(${output[at + 4]} 70% 94%)`
    slot.textContent = `row ${output[at + 2]}   value ${output[at + 3]}   hue ${output[at + 4]}`
  })
  const {statistics} = list
  listStats.textContent = `first row ${output[0]} · ${statistics.liveOperations} live operations · ${statistics.layers} layers · ${statistics.storedWeights} stored weights · ${statistics.indexReads + statistics.gatherReads} reads · ${elapsed.toFixed(3)} ms per evaluation · built in ${list.buildMilliseconds.toFixed(0)} ms`
}

function scheduleList() {
  if (listScheduled) return
  listScheduled = true
  requestAnimationFrame(renderList)
}

scroller.addEventListener('scroll', scheduleList)
constructionSelect.addEventListener('change', () => {
  listStats.textContent = 'building…'
  // Let the text paint before a long build.
  setTimeout(() => {
    list = createList(constructionSelect.value)
    scheduleList()
  }, 20)
})

// ---------------------------------------------------------------- photo strip

const photoCount = 221
const strip = buildPhotoStrip(photoCount, 'instruction')
const stripStatistics = programStatistics(strip.circuit.compileTensorProgram(strip.roots))
const evaluateStrip = strip.circuit.createTensorEvaluator(strip.roots)
const stripSource = strip.layout.table()
const stripElement = element<HTMLDivElement>('strip')
const stripStats = element<HTMLParagraphElement>('strip-stats')
let focused = Math.floor(photoCount / 2)
let stripScheduled = false
const photoElements = Array.from({length: photoCount}, (_, index) => {
  const photo = document.createElement('div')
  photo.className = 'photo'
  photo.style.background = `hsl(${(index * 47) % 360} 55% 62%)`
  photo.addEventListener('click', () => {
    focused = index
    scheduleStrip()
  })
  stripElement.append(photo)
  return photo
})

function renderStrip() {
  stripScheduled = false
  stripSource[strip.focus[0]!] = focused
  stripSource[strip.viewportWidth] = Math.min(16_384, stripElement.clientWidth)
  const output = evaluateStrip(stripSource)
  // Outputs: offset, then each photo's translateX, then each photo's width.
  photoElements.forEach((photo, index) => {
    photo.style.transform = `translateX(${output[1 + index]}px)`
    photo.style.width = `${output[1 + photoCount + index]}px`
    photo.classList.toggle('focused', index === focused)
  })
  stripStats.textContent = `focused ${focused} · ${stripStatistics.liveOperations} live operations · ${stripStatistics.layers} layers · ${stripStatistics.indexReads} index reads`
}

function scheduleStrip() {
  if (stripScheduled) return
  stripScheduled = true
  requestAnimationFrame(renderStrip)
}

window.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') focused = Math.max(0, focused - 1)
  else if (event.key === 'ArrowRight') focused = Math.min(photoCount - 1, focused + 1)
  else return
  event.preventDefault()
  scheduleStrip()
})
window.addEventListener('resize', () => {
  scheduleList()
  scheduleStrip()
})

scheduleList()
scheduleStrip()
