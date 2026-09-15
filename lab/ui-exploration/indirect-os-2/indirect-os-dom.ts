// The browser host: event handlers push raw input and schedule a render; the
// render reads the viewport, turns the frame's input into queued events, steps
// the circuit, and projects named outputs onto window-manager.css's markup plus
// one absolutely positioned span per Notes word. Run with:
//   bun lab/ui-exploration/indirect-os-2/indirect-os.html
import {invariant} from '../../../numeric-ui-core.ts'
import {type QueuedEvent, keyNameOf, wholePixel} from './events.ts'
import {type FastParagraph, fastParagraph} from './fast-walker.ts'
import {type IndirectOSMachine, type IndirectOSOutput, createIndirectOSMachine, originalOptions, windowCount} from './indirect-os.ts'
import {notesFont, notesOptionsFor, notesText} from './paragraph.ts'
import {photoCount} from './photos.ts'
import {queueInput} from './configurations.ts'
import {createTieredEvaluator} from './tiered.ts'
import {read} from '../notation/wires.ts'

// category: host
const photoNames = ['Misty Lake', 'Desert Light', 'Pacific Edge', 'Midnight City', 'Forest Path', 'Alpine Dawn', 'Amalfi Morning', 'North Falls', 'Lavender Hour', 'Concrete Curve', 'Blue Lagoon', 'Autumn Road']
type Box = {left: number, top: number, width: number, height: number}

export type IndirectOSDom = {
  windows: HTMLElement[] // cache lifetime: mount
  dockItems: HTMLElement[] // cache lifetime: mount
  photosRoot: HTMLElement // cache lifetime: mount
  backdrop: HTMLElement // cache lifetime: mount
  previousControl: HTMLElement // cache lifetime: mount
  nextControl: HTMLElement // cache lifetime: mount
  photoNodes: (HTMLElement | null)[] // cache lifetime: while visible
  thumbnailNodes: (HTMLElement | null)[] // cache lifetime: while visible
  wordNodes: HTMLElement[] // cache lifetime: mount
}

export type RawInput = {kind: 'down' | 'move' | 'up', clientX: number, clientY: number} | {kind: 'key', key: string}

// Whole pixels for pointers; only the keys the circuit understands.
export function toQueuedEvents(raw: readonly RawInput[]): QueuedEvent[] {
  const events: QueuedEvent[] = []
  for (const input of raw) {
    if (input.kind === 'key') {
      const key = keyNameOf(input.key)
      if (key !== null) events.push({kind: 'key', key})
    } else {
      events.push({kind: input.kind, x: wholePixel(input.clientX), y: wholePixel(input.clientY)})
    }
  }
  return events
}

// pretext's segments and widths for the Notes paragraph. Widths are rounded to
// 1/64 px, so prefix sums in the circuit stay exact in FP32.
export function measureNotesParagraph(prepare: (text: string, font: string) => object & {segments: string[]}, font = notesFont) {
  const prepared = prepare(notesText, font)
  const measured = fastParagraph(prepared)
  const paragraph: FastParagraph = {widths: measured.widths.map(width => Math.round(width * 64) / 64), breakAfter: measured.breakAfter}
  const words = prepared.segments.filter((_, index) => measured.breakAfter[index] === 0)
  return {paragraph, words}
}

function place(element: HTMLElement, box: Box) {
  element.style.width = `${box.width}px`
  element.style.height = `${box.height}px`
  element.style.transform = `translate3d(${box.left}px,${box.top}px,0)`
}

function projectPhoto(document: Pick<Document, 'createElement'>, dom: IndirectOSDom, nodes: (HTMLElement | null)[], item: number, photo: Box & {opacity: number, focused: number}, thumbnail: boolean) {
  let node = nodes[item] ?? null
  if (!(photo.width > 0 && photo.height > 0 && photo.opacity > 0)) {
    node?.remove()
    nodes[item] = null
    return
  }
  if (node === null) {
    node = document.createElement('div')
    node.className = `${thumbnail ? 'photos-thumbnail' : 'photos-photo'} image-${item}`
    if (!thumbnail) node.appendChild(document.createElement('span')).textContent = photoNames[item]!
    dom.photosRoot.appendChild(node)
    nodes[item] = node
  }
  place(node, photo)
  node.style.opacity = `${photo.opacity}`
  node.style.setProperty('--focused', `${photo.focused}`)
}

export function createWordNodes(document: Pick<Document, 'createElement'>, root: Pick<HTMLElement, 'appendChild'>, words: readonly string[]) {
  return words.map(word => {
    const node = document.createElement('span')
    node.className = 'notes-word'
    node.textContent = word
    root.appendChild(node)
    return node
  })
}

export function renderOutputs(document: Pick<Document, 'createElement'>, dom: IndirectOSDom, output: IndirectOSOutput) {
  output.windows.forEach((window, index) => {
    const style = dom.windows[index]!.style
    style.width = `${window.width}px`
    style.height = `${window.height}px`
    style.transform = `translate3d(${window.translateX}px,${window.translateY}px,0) scale(${window.scale})`
    style.opacity = `${window.opacity}`
    style.zIndex = `${10 + window.stack}`
    style.setProperty('--focused', `${window.focused}`)
    style.setProperty('--maximized', `${window.maximized}`)
  })
  output.dockItems.forEach((item, index) => {
    const style = dom.dockItems[index]!.style
    style.left = `${item.left}px`
    style.top = `${item.top}px`
    style.width = `${item.width}px`
    style.height = `${item.height}px`
    style.setProperty('--inactive', `${item.inactive}`)
    style.setProperty('--focused', `${item.focused}`)
    style.setProperty('--open', `${item.open}`)
  })
  const {photos} = output
  dom.backdrop.style.opacity = `${photos.backdropOpacity}`
  for (let item = 0; item < photoCount; item++) {
    projectPhoto(document, dom, dom.photoNodes, item, photos.photos[item]!, false)
    projectPhoto(document, dom, dom.thumbnailNodes, item, photos.thumbnails[item]!, true)
  }
  for (const [node, control] of [[dom.previousControl, photos.previousControl], [dom.nextControl, photos.nextControl]] as const) {
    place(node, control)
    node.style.opacity = `${control.opacity}`
  }
  output.notes?.words.forEach((word, index) => {
    const style = dom.wordNodes[index]!.style
    style.transform = `translate3d(${word.x}px,${word.y}px,0)`
    style.opacity = `${word.visible}`
  })
}

export function describeProgram(machine: IndirectOSMachine) {
  const program = machine.tensorProgram
  const count = (value: number) => value.toLocaleString('en-US')
  let booleans = 0
  let reglus = 0
  for (const layer of program.layers) {
    booleans += layer.booleanRows.length
    reglus += layer.gateRows.length
  }
  const live = program.valueCount - program.sourceSize
  return {
    values: `${count(program.sourceSize)} inputs · ${count(program.roots.length)} outputs`,
    operations: `${count(live - reglus - booleans)} affine · ${count(reglus)} ReGLU · ${count(booleans)} boolean`,
    layers: count(program.layers.length),
    weights: `${count(program.layers.reduce((total, layer) => total + layer.weights.length, 0))} sparse`,
  }
}

export function createDemoMachine(prepare: (text: string, font: string) => object & {segments: string[]}, epsilon: number, font = notesFont) {
  const {paragraph, words} = measureNotesParagraph(prepare, font)
  const options = {...originalOptions, springs: 'bank' as const, photosViewport: 'stepped-springs' as const, input: queueInput, notes: notesOptionsFor(paragraph, epsilon)}
  const machine = createIndirectOSMachine(options)
  const evaluator = createTieredEvaluator(machine.circuit, machine.roots)
  machine.setEvaluator(source => evaluator.evaluate(source))
  return {machine, evaluator, words}
}

export async function mountIndirectOS(document: Document, window: Window) {
  const pretext = await import('../text-walker/pretext-src/layout.ts')
  const measurement = await import('../text-walker/pretext-src/measurement.ts')
  const {machine, evaluator, words} = createDemoMachine(pretext.prepareWithSegments as never, measurement.getEngineProfile().lineFitEpsilon)
  const query = (selector: string) => {
    const node = document.querySelector<HTMLElement>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  const desktop = query('#desktop')
  const dom: IndirectOSDom = {
    windows: [...document.querySelectorAll<HTMLElement>('.window')],
    dockItems: [...document.querySelectorAll<HTMLElement>('.dock-item')],
    photosRoot: query('.photos-content'),
    backdrop: query('.photos-backdrop'),
    previousControl: query('.photos-previous'),
    nextControl: query('.photos-next'),
    photoNodes: Array<HTMLElement | null>(photoCount).fill(null),
    thumbnailNodes: Array<HTMLElement | null>(photoCount).fill(null),
    wordNodes: createWordNodes(document, query('.notes-content'), words),
  }
  invariant(dom.windows.length === windowCount && dom.dockItems.length === windowCount, 'the markup must have one window and one dock item per circuit window')
  const monitor = {frame: query('#monitor-frame'), tier: query('#monitor-tier'), raf: query('#monitor-raf')}
  for (const [field, text] of Object.entries(describeProgram(machine))) query(`#monitor-${field}`).textContent = text
  const {layout} = machine.cells
  const cssConstants = [['--title-height', layout.titleHeight], ['--button-size', layout.buttonSize], ['--button-gap', layout.buttonGap], ['--resize-grip', layout.resizeGrip], ['--dock-height', layout.dockHeight]] as const
  for (const [property, cell] of cssConstants) desktop.style.setProperty(property, `${machine.source[cell]}px`)
  desktop.style.setProperty('--system-bar-height', `${machine.source[machine.cells.systemBarHeight]}px`)

  const pending: RawInput[] = []
  let scheduledRaf: number | null = null
  let promotionScheduled = false
  // Generated code runs slowly until the engine has run it many times (tens of
  // thousands of evaluations for this program, see README.md), so the page warms
  // it on copies of the table during idle time and switches once every live wire
  // matches the executor. Compiling is one chunk of a few tens of milliseconds.
  const warmupBudgetMilliseconds = 3000
  function promoteWhenIdle() {
    let warmedMilliseconds = 0
    const idle = (step: (budget: number) => void) => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(deadline => step(Math.max(1, deadline.timeRemaining() - 2)))
      else window.setTimeout(() => step(8), 50)
    }
    const step = (budget: number) => {
      if (warmedMilliseconds === 0) evaluator.prepare()
      evaluator.warm(machine.source, budget)
      warmedMilliseconds += budget
      if (warmedMilliseconds < warmupBudgetMilliseconds) return idle(step)
      evaluator.switchIfIdentical(machine.source)
      monitor.tier.textContent = evaluator.tier
    }
    window.setTimeout(() => idle(step), 1000)
  }
  const scheduleRender = () => {
    scheduledRaf ??= window.requestAnimationFrame(render)
  }
  function render(frameTime: number) {
    scheduledRaf = null
    const renderStart = window.performance.now()
    const {values} = machine.stepFrame(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime, toQueuedEvents(pending.splice(0)))
    const output = read(values, machine.output)
    renderOutputs(document, dom, output)
    const animating = output.animationActive > 0
    if (animating) scheduleRender()
    if (!promotionScheduled) {
      promotionScheduled = true
      promoteWhenIdle()
    }
    monitor.raf.textContent = animating ? 'yes' : 'no'
    monitor.tier.textContent = evaluator.tier
    monitor.frame.textContent = `${(window.performance.now() - renderStart).toFixed(2)} ms`
  }
  const pointer = (kind: 'down' | 'move' | 'up') => (event: PointerEvent) => {
    const samples = kind === 'move' && typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event]
    for (const sample of samples.length === 0 ? [event] : samples) pending.push({kind, clientX: sample.clientX, clientY: sample.clientY})
    scheduleRender()
  }
  window.addEventListener('pointerdown', pointer('down'))
  window.addEventListener('pointermove', pointer('move'))
  window.addEventListener('pointerup', pointer('up'))
  window.addEventListener('pointercancel', pointer('up'))
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (keyNameOf(event.key) === null) return
    // The browser needs this decision inside the handler, before the circuit runs.
    event.preventDefault()
    pending.push({kind: 'key', key: event.key})
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)
  render(window.performance.now())
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') void mountIndirectOS(document, window)
