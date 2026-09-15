// The browser host for the rewrite: DOM reads, event latches, and projecting
// named output structs onto the same markup and CSS as index.html. Run with:
//   bun lab/ui-exploration/notation/indirect-os.html
import {invariant} from '../../../numeric-ui-core.ts'
import {type IndirectOSOutput, createIndirectOSMachine, windowCount} from './indirect-os.ts'
import {photoCount} from './photos.ts'
import {read} from './wires.ts'

// category: host
const photoNames = ['Misty Lake', 'Desert Light', 'Pacific Edge', 'Midnight City', 'Forest Path', 'Alpine Dawn', 'Amalfi Morning', 'North Falls', 'Lavender Hour', 'Concrete Curve', 'Blue Lagoon', 'Autumn Road']
type Box = {left: number, top: number, width: number, height: number}

export function describeProgram(program: ReturnType<typeof createIndirectOSMachine>['tensorProgram']) {
  let regluCount = 0
  let booleanCount = 0
  let weightCount = 0
  let denseWeightCount = 0
  let maximumWidth = 0
  let weightBytes = 0
  let biasBytes = 0
  let bookkeepingBytes = program.roots.byteLength + program.wireOrder.byteLength
  for (const layer of program.layers) {
    const width = layer.outputSize + layer.gateRows.length
    regluCount += layer.gateRows.length
    booleanCount += layer.booleanRows.length
    weightCount += layer.weights.length
    denseWeightCount += width * layer.inputSize
    maximumWidth = Math.max(maximumWidth, width)
    weightBytes += layer.weights.byteLength
    biasBytes += layer.bias.byteLength
    bookkeepingBytes += layer.inputIndices.byteLength + layer.gateRows.byteLength + layer.booleanRows.byteLength + layer.rowOffsets.byteLength + layer.columns.byteLength
  }
  const live = program.valueCount - program.sourceSize
  const count = (value: number) => value.toLocaleString('en-US')
  const kilobytes = (bytes: number) => `${(bytes / 1_000).toFixed(1)} KB`
  return {
    values: `${count(program.sourceSize)} inputs · ${count(program.roots.length)} outputs · ${count(live)} activations`,
    operations: `${count(live - regluCount - booleanCount)} affine · ${count(regluCount)} ReGLU · ${count(booleanCount)} boolean`,
    layers: `${count(program.layers.length)} · max width ${count(maximumWidth)}`,
    weights: `${count(denseWeightCount)} dense · ${count(weightCount)} sparse`,
    memory: `${kilobytes(weightBytes)} weights · ${kilobytes(biasBytes)} biases · ${kilobytes(bookkeepingBytes)} bookkeeping`,
  }
}

export type IndirectOSDom = {
  windows: HTMLElement[]
  dockItems: HTMLElement[]
  photosRoot: HTMLElement
  backdrop: HTMLElement
  previousControl: HTMLElement
  nextControl: HTMLElement
  photoNodes: (HTMLElement | null)[]
  thumbnailNodes: (HTMLElement | null)[]
}

function place(element: HTMLElement, box: Box) {
  element.style.width = `${box.width}px`
  element.style.height = `${box.height}px`
  element.style.transform = `translate3d(${box.left}px,${box.top}px,0)`
}

// Photos and thumbnails are created while visible and removed otherwise.
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
}

export function mountIndirectOS(document: Document, window: Window) {
  const machine = createIndirectOSMachine()
  const query = (selector: string) => {
    const node = document.querySelector<HTMLElement>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  const desktop = query('#desktop')
  const dom: IndirectOSDom = {
    windows: [...document.querySelectorAll<HTMLElement>('.window')], // mount lifetime
    dockItems: [...document.querySelectorAll<HTMLElement>('.dock-item')], // mount lifetime
    photosRoot: query('.photos-content'),
    backdrop: query('.photos-backdrop'),
    previousControl: query('.photos-previous'),
    nextControl: query('.photos-next'),
    photoNodes: Array<HTMLElement | null>(photoCount).fill(null),
    thumbnailNodes: Array<HTMLElement | null>(photoCount).fill(null),
  }
  invariant(dom.windows.length === windowCount && dom.dockItems.length === windowCount, 'the markup must have one window and one dock item per circuit window')
  const monitor = {frame: query('#monitor-frame'), raf: query('#monitor-raf')}
  for (const [field, text] of Object.entries(describeProgram(machine.tensorProgram))) query(`#monitor-${field}`).textContent = text
  const {cells} = machine
  const cssConstants = [['--title-height', cells.titleHeight], ['--button-size', cells.buttonSize], ['--button-gap', cells.buttonGap], ['--resize-grip', cells.resizeGrip], ['--dock-height', cells.dockHeight], ['--system-bar-height', cells.systemBarHeight]] as const
  for (const [property, cell] of cssConstants) desktop.style.setProperty(property, `${machine.source[cell]}px`)

  let scheduledRaf: number | null = null
  const scheduleRender = () => {
    scheduledRaf ??= window.requestAnimationFrame(render)
  }
  function render(frameTime: number) {
    const renderStart = window.performance.now()
    scheduledRaf = null
    const values = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime)
    const output = read(values, machine.output)
    renderOutputs(document, dom, output)
    const animating = output.animationActive > 0
    if (animating) scheduleRender()
    monitor.raf.textContent = animating ? 'yes' : 'no'
    monitor.frame.textContent = `${(window.performance.now() - renderStart).toFixed(2)} ms`
  }
  const pointer = (receive: (x: number, y: number) => void) => (event: PointerEvent) => {
    receive(event.clientX, event.clientY)
    scheduleRender()
  }
  window.addEventListener('pointerdown', pointer(machine.pointerDown))
  window.addEventListener('pointermove', pointer(machine.pointerMove))
  window.addEventListener('pointerup', pointer(machine.pointerUp))
  window.addEventListener('pointercancel', pointer(machine.pointerUp))
  dom.photosRoot.addEventListener('click', (event: MouseEvent) => {
    machine.photoClick(event.offsetX, event.offsetY)
    scheduleRender()
  })
  const keys: Record<string, () => void> = {ArrowLeft: machine.photoPrevious, ArrowRight: machine.photoNext, Escape: machine.photoClose}
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const receive = keys[event.key]
    if (receive === undefined) return
    receive()
    event.preventDefault()
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)
  render(window.performance.now())
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') mountIndirectOS(document, window)
