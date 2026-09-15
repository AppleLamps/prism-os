// Browser demo: the app shell driven by one compiled circuit per frame.
// The page measures each text once with canvas (the prepare step), writes the line-count
// staircases into the source table, then only feeds viewport size, wheel deltas, pointer
// presses and frame time into source cells and copies rectangles onto absolutely positioned
// elements. All layout, the sidebar toggle and its spring run inside the circuit.
import {createAppMachine, createAppShell, textStyles} from './app-shell.ts'
import {programStats} from './circuit-tools.ts'
import {greedyTextTable} from './text-table.ts'
import {walk, type TextTable} from './tree.ts'

const fontFamily = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const stage = document.getElementById('stage')!
const statsPanel = document.getElementById('stats')!

await document.fonts.ready
const shell = createAppShell()
const context = document.createElement('canvas').getContext('2d')!
const tables = new Map<string, TextTable>()
const prepareStarted = performance.now()
for (const [textId, entry] of shell.texts) {
  const style = textStyles[entry.style]
  context.font = `${style.fontWeight} ${style.fontSize}px ${fontFamily}`
  const words = entry.text.split(' ')
  tables.set(textId, greedyTextTable(words.map(word => context.measureText(word).width), context.measureText(' ').width))
}
const prepareMilliseconds = performance.now() - prepareStarted
const machine = createAppMachine(shell, tables)
const stats = programStats(shell.circuit, shell.roots)

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

// One element per node, nested like the tree so the sidebar and the scroll container clip.
const elements = new Map<string, HTMLElement>()
const parentNames = new Map<string, string | null>()
for (const {node, parent} of walk(shell.root)) {
  const element = document.createElement('div')
  element.className = `node role-${roleOf(node.name)}`
  if (node.kind === 'text') {
    const entry = shell.texts.get(node.textId)!
    const style = textStyles[entry.style]
    element.classList.add('text', `text-${entry.style}`)
    element.style.font = `${style.fontWeight} ${style.fontSize}px/${style.lineHeight}px ${fontFamily}`
    element.textContent = entry.text
  }
  const thumbIndex = /^card(\d+)\.thumb$/.exec(node.name)
  if (thumbIndex !== null) element.style.background = `linear-gradient(135deg, hsl(${Number(thumbIndex[1]) * 47 % 360} 55% 80%), hsl(${(Number(thumbIndex[1]) * 47 + 40) % 360} 45% 66%))`
  ;(parent === null ? stage : elements.get(parent.name)!).appendChild(element)
  elements.set(node.name, element)
  parentNames.set(node.name, parent?.name ?? null)
}

let pendingPointer: {x: number, y: number} | null = null
let pendingScroll = 0
let lastFrameTime: number | null = null
let scheduled = false
const schedule = () => {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

function render(now: number) {
  scheduled = false
  // The machine clamps long frames to 32 ms itself.
  const frameDuration = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000
  lastFrameTime = now
  const started = performance.now()
  const result = machine.step({
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
    frameDuration,
    pointerDown: pendingPointer,
    scrollDelta: pendingScroll,
  })
  const stepMicroseconds = (performance.now() - started) * 1000
  pendingPointer = null
  pendingScroll = 0
  for (const [name, rect] of result.layout.rects) {
    const element = elements.get(name)!
    const parentName = parentNames.get(name)!
    const parentRect = parentName === null ? {x: 0, y: 0} : result.layout.rects.get(parentName)!
    element.style.transform = `translate(${rect.x - parentRect.x}px, ${rect.y - parentRect.y}px)`
    element.style.width = `${Math.max(0, rect.width)}px`
    element.style.height = `${Math.max(0, rect.height)}px`
  }
  statsPanel.textContent = [
    `one circuit: ${stats.liveOperations.toLocaleString()} live ops, ${stats.layers} layers, ${stats.storedWeights.toLocaleString()} stored weights`,
    `frame step ${stepMicroseconds.toFixed(0)} µs, text prepare ${prepareMilliseconds.toFixed(0)} ms once`,
    `grid columns ${result.layout.gridColumns.get('recent.grid')}, sidebar ${result.sidebarWidth.toFixed(1)} px, scroll ${result.layout.scroll.get('main')!.toFixed(0)} px`,
  ].join('\n')
  if (result.animating) schedule()
  else lastFrameTime = null
}

stage.addEventListener('pointerdown', event => {
  pendingPointer = {x: event.clientX, y: event.clientY}
  schedule()
})
stage.addEventListener('wheel', event => {
  event.preventDefault()
  pendingScroll += event.deltaY
  schedule()
}, {passive: false})
window.addEventListener('resize', schedule)
schedule()
