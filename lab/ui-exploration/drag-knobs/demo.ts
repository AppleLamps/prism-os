// Browser demo: drag a card's left, right or bottom edge. The page runs one backward pass
// through the compiled app shell, moves the unlocked design knobs, and lists which knob change
// would flip the dragged card's grid column count or its title's line count. All logic lives
// in demo-model.ts; this file measures text, copies rectangles onto elements, and forwards events.
import {createAppShellTree, knobNames, knobSpecs, textStyles, type KnobName} from './app-shell.ts'
import {createDemoModel} from './demo-model.ts'
import {greedyTextTable} from './text-table.ts'
import {walk, type TextTable} from './tree.ts'

const fontFamily = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const stage = document.getElementById('stage')!
const panel = document.getElementById('panel')!

await document.fonts.ready
const {root, texts} = createAppShellTree()
const context = document.createElement('canvas').getContext('2d')!
const tables = new Map<string, TextTable>()
for (const [textId, entry] of texts) {
  const style = textStyles[entry.style]
  context.font = `${style.fontWeight} ${style.fontSize}px ${fontFamily}`
  const words = entry.text.split(' ')
  tables.set(textId, greedyTextTable(words.map(word => context.measureText(word).width), context.measureText(' ').width))
}
const model = createDemoModel(tables, document.documentElement.clientWidth, document.documentElement.clientHeight)

const roleOf = (name: string) => {
  if (/^card\d+$/.test(name)) return 'card'
  if (/^card\d+\.thumb$/.test(name)) return 'thumb'
  if (/^nav\d+$/.test(name)) return 'nav'
  if (/^tag\d+$/.test(name)) return 'chip'
  if (/\.header$/.test(name)) return 'section-header'
  if (name === 'menuButton') return 'menu'
  if (/Button$/.test(name)) return 'button'
  return name.replace(/[^a-zA-Z]/g, '-')
}

const elements = new Map<string, HTMLElement>()
const parentNames = new Map<string, string | null>()
const cardTitles: HTMLElement[] = []
for (const {node, parent} of walk(root)) {
  const element = document.createElement('div')
  element.className = `node role-${roleOf(node.name)}`
  if (node.kind === 'text') {
    const entry = texts.get(node.textId)!
    const style = textStyles[entry.style]
    element.classList.add('text', `text-${entry.style}`)
    element.style.font = `${style.fontWeight} ${style.fontSize}px/${style.lineHeight}px ${fontFamily}`
    element.textContent = entry.text
    if (entry.style === 'cardTitle') cardTitles.push(element)
  }
  const thumbIndex = /^card(\d+)\.thumb$/.exec(node.name)
  if (thumbIndex !== null) element.style.background = `linear-gradient(135deg, hsl(${Number(thumbIndex[1]) * 47 % 360} 55% 80%), hsl(${(Number(thumbIndex[1]) * 47 + 40) % 360} 45% 66%))`
  ;(parent === null ? stage : elements.get(parent.name)!).appendChild(element)
  elements.set(node.name, element)
  parentNames.set(node.name, parent?.name ?? null)
}
const edgeMarker = document.createElement('div')
edgeMarker.className = 'edge-marker'
stage.appendChild(edgeMarker)

// Panel: knobs with lock toggles, the last frame's solve, and flip sentences.
const knobRows = new Map<KnobName, HTMLElement>()
const knobList = document.createElement('div')
knobList.className = 'knobs'
for (const name of knobNames) {
  const row = document.createElement('label')
  row.className = 'knob'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = true
  checkbox.addEventListener('change', () => { model.setLocked(name, !checkbox.checked) })
  const title = document.createElement('span')
  title.textContent = name
  const value = document.createElement('b')
  row.append(checkbox, title, value)
  knobList.appendChild(row)
  knobRows.set(name, value)
}
const status = document.createElement('div')
status.className = 'status'
const flipList = document.createElement('ul')
flipList.className = 'flips'
const reset = document.createElement('button')
reset.textContent = 'Reset knobs'
reset.addEventListener('click', () => { model.resetKnobs(); schedule() })
const heading = document.createElement('div')
heading.className = 'heading'
heading.textContent = 'Drag a card edge. Checked knobs may move.'
panel.append(heading, knobList, status, flipList, reset)

let hovered: ReturnType<typeof model.hitTest> = null
let scheduled = false
const schedule = () => {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

function render() {
  scheduled = false
  const layout = model.layout()
  const knobs = model.knobs()
  for (const [name, rect] of layout.rects) {
    const element = elements.get(name)!
    const parentName = parentNames.get(name)!
    const parentRect = parentName === null ? {x: 0, y: 0} : layout.rects.get(parentName)!
    element.style.transform = `translate(${rect.x - parentRect.x}px, ${rect.y - parentRect.y}px)`
    element.style.width = `${Math.max(0, rect.width)}px`
    element.style.height = `${Math.max(0, rect.height)}px`
  }
  const titleStyle = textStyles.cardTitle
  for (const element of cardTitles) {
    element.style.font = `${titleStyle.fontWeight} ${titleStyle.fontSize * knobs.titleScale}px/${titleStyle.lineHeight * knobs.titleScale}px ${fontFamily}`
  }
  const state = model.state()
  const handle = state.dragging ?? hovered
  if (handle !== null) {
    const rect = layout.rects.get(handle.node)!
    edgeMarker.hidden = false
    const vertical = handle.side !== 'bottom'
    const x = handle.side === 'right' ? rect.x + rect.width : rect.x
    edgeMarker.style.transform = vertical ? `translate(${x - 2}px, ${rect.y}px)` : `translate(${rect.x}px, ${rect.y + rect.height - 2}px)`
    edgeMarker.style.width = vertical ? '4px' : `${rect.width}px`
    edgeMarker.style.height = vertical ? `${rect.height}px` : '4px'
  } else {
    edgeMarker.hidden = true
  }
  for (const [name, element] of knobRows) {
    element.textContent = knobSpecs[name].unit === 'px' ? `${knobs[name].toFixed(1)} px` : `${knobs[name].toFixed(3)}×`
  }
  const frame = state.lastFrame
  status.textContent = frame === null
    ? 'No drag yet.'
    : `${frame.outcome}: ${frame.steps} gradient step${frame.steps === 1 ? '' : 's'}${frame.searched ? `, searched (picked ${frame.picked})` : ''}, error ${frame.finalError.toFixed(2)} px, ${Math.round(frame.microseconds.gradient + frame.microseconds.search)} µs`
  flipList.replaceChildren(...model.flipSentences().map(sentence => {
    const item = document.createElement('li')
    item.textContent = sentence
    return item
  }))
}

stage.addEventListener('pointerdown', event => {
  if (model.pointerDown(event.clientX, event.clientY)) {
    stage.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  schedule()
})
stage.addEventListener('pointermove', event => {
  if (model.state().dragging !== null) model.pointerMove(event.clientX, event.clientY)
  else {
    hovered = model.hitTest(event.clientX, event.clientY)
    stage.style.cursor = hovered === null ? 'default' : hovered.side === 'bottom' ? 'row-resize' : 'col-resize'
  }
  schedule()
})
stage.addEventListener('pointerup', () => {
  model.pointerUp()
  schedule()
})
stage.addEventListener('wheel', event => {
  event.preventDefault()
  model.scroll(event.deltaY)
  schedule()
}, {passive: false})
window.addEventListener('resize', () => {
  model.setViewport(document.documentElement.clientWidth, document.documentElement.clientHeight)
  schedule()
})
schedule()
