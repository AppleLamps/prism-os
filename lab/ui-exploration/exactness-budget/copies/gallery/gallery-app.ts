// JS around the circuit: the source table, event latches, the render loop's DOM reads, the
// next-source write-back, the DOM projection (style strings), and side effects. Shared by the
// browser demo and the headless differential tests, which plug in a real or a fake platform.
import {buildGalleryCircuit, galleryConstants, springNames, type GalleryCircuit, type GalleryCircuitOptions} from './gallery-circuit.ts'
import type {Wire} from '../../../../../numeric-ui-core.ts'
import type {PhotoData} from './photo-data.ts'

export type GalleryMachine = ReturnType<typeof createGalleryMachine>

export function createGalleryMachine(built: GalleryCircuit) {
  const {circuit, roots, nextSource, cells} = built
  const evaluate = circuit.createTensorEvaluator(roots)
  const positions = new Map<Wire, number>()
  roots.forEach((wire, index) => positions.set(wire, index))
  const writeBack = nextSource.map(([cell, wire]) => [cell, positions.get(wire)!] as const)
  const latchCells = [cells.keyEscape, cells.keyArrowLeft, cells.keyArrowRight, cells.clickActive, cells.clickOnPrompt, cells.moveActive]
  const source = new Float32Array(built.layout.size)
  let values: Float32Array = new Float32Array(roots.length)
  return {
    built,
    source,
    step() {
      values = evaluate(source)
      for (const [cell, index] of writeBack) source[cell] = values[index]!
      for (const cell of latchCells) source[cell] = 0
    },
    read(wire: Wire) {
      const index = positions.get(wire)
      if (index === undefined) throw new Error(`wire ${wire} is not an output`)
      return values[index]!
    },
  }
}

// index.ts:83-91 in float64, used only for the initial spring state at load (index.ts:132-166),
// which index.ts computes in JS before the first render.
function initialColumns(containerSizeX: number) {
  const K = galleryConstants
  const columns = Math.min(7, Math.max(1, Math.floor((containerSizeX - K.boxesGapX) / (K.boxMinSizeX + K.boxesGapX))))
  return {columns, boxMaxSizeX: Math.max(1, (containerSizeX - K.boxesGapX - columns * K.boxesGapX) / columns)}
}

export function initializeSource(machine: GalleryMachine, photos: readonly PhotoData[], width: number, height: number, scrollY: number) {
  const {cells} = machine.built
  const source = machine.source
  source.fill(0)
  const {columns, boxMaxSizeX} = initialColumns(width)
  const imageMaxSizeY = boxMaxSizeX + 100
  photos.forEach((photo, index) => {
    const ar = photo.w / photo.h
    const sizeX = Math.min(photo.w, boxMaxSizeX, imageMaxSizeY * ar)
    const initial = {
      sizeX,
      sizeY: sizeX / ar + galleryConstants.promptSizeY,
      x: Math.floor(index / columns) * -width - width,
      y: height + Math.floor(index / columns) * imageMaxSizeY,
      scale: 1,
      fxFactor: 20,
    }
    // spring(pos) starts at rest: destination = position, displacement and velocity 0.
    const photoCells = cells.photos[index]!
    for (const name of springNames) source[photoCells.springs[name].destination] = initial[name]
  })
  source[cells.previousWindowSizeX] = width
  source[cells.committedScrollY] = scrollY
  source[cells.windowSizeX] = width
  source[cells.windowSizeY] = height
}

export type PlatformReads = {
  clientWidth: number
  clientHeight: number
  scrollX: number
  scrollY: number
  reducedMotion: boolean
  hash: string
}

export type GalleryPlatform = {
  read(): PlatformReads
  scrollTo(top: number): void
  pushHash(hash: string): void
  selectPrompt(photoIndex: number): void
}

export type BoxStyle = {
  width: string
  height: string
  transform: string
  filter: string
  zIndex: string
  promptTop: string
  promptOverflowY: string
  promptHeight: string
  lineClamp: string
  imageDisplay: string
  // index.ts:438: load the full resolution image once the focused photo stops animating
  fullResolution: boolean
}

export type GalleryView = {
  showBox(index: number, style: BoxStyle): void
  hideBox(index: number): void
  setBody(cursor: string, overflowY: string, placeholderHeight: number): void
}

// index.ts:420-446, from circuit outputs.
export function projectBoxStyle(machine: GalleryMachine, photos: readonly PhotoData[], index: number): BoxStyle {
  const photo = photos[index]!
  const output = machine.built.outputs.photos[index]!
  const sizeX = machine.read(output.springs.sizeX)
  const sizeY = machine.read(output.springs.sizeY)
  const x = machine.read(output.springs.x)
  const y = machine.read(output.springs.y)
  const scale = machine.read(output.springs.scale)
  const fxFactor = machine.read(output.springs.fxFactor)
  const focused = machine.read(output.focused) === 1
  const stillAnimating = machine.read(machine.built.outputs.stillAnimating) === 1
  return {
    width: `${sizeX}px`,
    height: `${sizeY}px`,
    transform: `translate3d(${x}px,${y}px,0) scale(${scale})`,
    filter: machine.read(output.blurred) === 1
      ? `brightness(${fxFactor * 100}%) blur(${Math.max(0, 6 - fxFactor * 6)}px)`
      : `brightness(${fxFactor * 100}%)`,
    zIndex: focused ? `${photos.length + 1}` : `${index + 1}`,
    promptTop: `${sizeX / (photo.w / photo.h)}px`,
    promptOverflowY: focused ? 'auto' : 'hidden',
    promptHeight: focused ? `${galleryConstants.prompt1DSizeY - 8}px` : `${galleryConstants.promptSizeY - 8}px`,
    lineClamp: focused ? '999' : '2',
    imageDisplay: focused ? 'block' : 'none',
    fullResolution: focused && !stillAnimating,
  }
}

export type GalleryApp = ReturnType<typeof createGalleryApp>

export function createGalleryApp(
  photos: readonly PhotoData[],
  platform: GalleryPlatform,
  view: GalleryView,
  options: GalleryCircuitOptions = {},
  built: GalleryCircuit = buildGalleryCircuit(photos, options),
) {
  const machine = createGalleryMachine(built)
  const {cells, outputs} = built
  const initial = platform.read()
  initializeSource(machine, photos, initial.clientWidth, initial.clientHeight, initial.scrollY)
  const source = machine.source
  let previousNow: number | null = null
  let clickedPromptIndex = -1
  const indexById = new Map<string, number>()
  photos.forEach((photo, index) => indexById.set(photo.id, index))

  return {
    machine,
    // Event callbacks only write latches; the latest event of each kind wins (index.ts:201-203).
    keydown(code: string) {
      source[cells.keyEscape] = code === 'Escape' ? 1 : 0
      source[cells.keyArrowLeft] = code === 'ArrowLeft' ? 1 : 0
      source[cells.keyArrowRight] = code === 'ArrowRight' ? 1 : 0
    },
    // `promptIndex` is the photo whose caption was the click target, else -1: DOM identity stays in JS.
    click(clientX: number, clientY: number, promptIndex: number) {
      source[cells.clickActive] = 1
      source[cells.clickX] = clientX
      source[cells.clickY] = clientY
      source[cells.clickOnPrompt] = promptIndex >= 0 ? 1 : 0
      clickedPromptIndex = promptIndex
    },
    mousemove(clientX: number, clientY: number) {
      source[cells.moveActive] = 1
      source[cells.moveX] = clientX
      source[cells.moveY] = clientY
    },
    render(now: number): boolean {
      // DOM reads (index.ts:255-263). The id scan against the URL hash stays in JS.
      const reads = platform.read()
      const focused = indexById.get(reads.hash.slice(1)) ?? -1
      source[cells.windowSizeX] = reads.clientWidth
      source[cells.windowSizeY] = reads.clientHeight
      source[cells.scrollX] = reads.scrollX
      source[cells.scrollY] = reads.scrollY
      source[cells.reducedMotion] = reads.reducedMotion ? 1 : 0
      source[cells.focusedIndex] = Math.max(0, focused)
      source[cells.focusedPresent] = focused >= 0 ? 1 : 0
      source[cells.frameDuration] = previousNow === null ? 0 : Math.max(0, now - previousNow)
      previousNow = now
      machine.step()
      // The circuit decides whether to select (index.ts:277); JS only knows which caption node was the target.
      if (machine.read(outputs.selectPrompt) === 1 && clickedPromptIndex >= 0) platform.selectPrompt(clickedPromptIndex)

      // DOM writes (index.ts:411-453).
      for (let index = 0; index < photos.length; index++) {
        if (machine.read(outputs.photos[index]!.visible) === 1) view.showBox(index, projectBoxStyle(machine, photos, index))
        else view.hideBox(index)
      }
      const present = machine.read(outputs.newFocusedPresent) === 1
      const cursor = machine.read(outputs.cursorZoomIn) === 1 ? 'zoom-in' : machine.read(outputs.cursorZoomOut) === 1 ? 'zoom-out' : 'auto'
      view.setBody(cursor, present ? 'hidden' : 'auto', machine.read(outputs.placeholderHeight))

      // Side effects (index.ts:457-463).
      if (machine.read(outputs.scrollChanged) === 1) platform.scrollTo(machine.read(outputs.adjustedScrollTop))
      if (machine.read(outputs.focusChanged) === 1) {
        platform.pushHash(present ? `#${photos[machine.read(outputs.newFocusedIndex)]!.id}` : '')
      }
      return machine.read(outputs.stillAnimating) === 1
    },
  }
}
