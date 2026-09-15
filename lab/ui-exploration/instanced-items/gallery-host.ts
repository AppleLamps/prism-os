// JS around the gallery engine: event latches, the render loop's DOM reads, the
// DOM projection (style strings), and side effects. A copy of
// lab/ui-exploration/gallery/gallery-app.ts that talks to a GalleryEngine
// instead of the original circuit, so the browser demo, the differential tests
// and the report drive every engine through the same code.
import {galleryConstants, springNames} from './gallery-circuit.ts'
import type {GalleryEngine} from './gallery-engine.ts'
import {sharedCellNames, springFields} from './gallery-staged.ts'
import type {PhotoData} from './photo-data.ts'

// index.ts:83-91 in float64, used only for the initial spring state at load (index.ts:132-166),
// which index.ts computes in JS before its first render.
function initialColumns(containerSizeX: number) {
  const K = galleryConstants
  const columns = Math.min(7, Math.max(1, Math.floor((containerSizeX - K.boxesGapX) / (K.boxMinSizeX + K.boxesGapX))))
  return {columns, boxMaxSizeX: Math.max(1, (containerSizeX - K.boxesGapX - columns * K.boxesGapX) / columns)}
}

export function initializeEngine(engine: GalleryEngine, photos: readonly PhotoData[], width: number, height: number, scrollY: number) {
  for (const name of sharedCellNames) engine.setCell(name, 0)
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
    for (const name of springNames) {
      for (const field of springFields) engine.setSpring(index, name, field, field === 'destination' ? initial[name] : 0)
    }
  })
  engine.setCell('previousWindowSizeX', width)
  engine.setCell('committedScrollY', scrollY)
  engine.setCell('windowSizeX', width)
  engine.setCell('windowSizeY', height)
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

// index.ts:420-446, from engine outputs.
export function projectBoxStyle(engine: GalleryEngine, photos: readonly PhotoData[], index: number): BoxStyle {
  const photo = photos[index]!
  const sizeX = engine.photo('sizeX', index)
  const sizeY = engine.photo('sizeY', index)
  const x = engine.photo('x', index)
  const y = engine.photo('y', index)
  const scale = engine.photo('scale', index)
  const fxFactor = engine.photo('fxFactor', index)
  const focused = engine.photo('focused', index) === 1
  const stillAnimating = engine.output('stillAnimating') === 1
  return {
    width: `${sizeX}px`,
    height: `${sizeY}px`,
    transform: `translate3d(${x}px,${y}px,0) scale(${scale})`,
    filter: engine.photo('blurred', index) === 1
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

export function createGalleryApp(photos: readonly PhotoData[], platform: GalleryPlatform, view: GalleryView, engine: GalleryEngine) {
  const initial = platform.read()
  initializeEngine(engine, photos, initial.clientWidth, initial.clientHeight, initial.scrollY)
  let previousNow: number | null = null
  let clickedPromptIndex = -1
  const indexById = new Map<string, number>()
  photos.forEach((photo, index) => indexById.set(photo.id, index))

  return {
    engine,
    // Event callbacks only write latches; the latest event of each kind wins (index.ts:201-203).
    keydown(code: string) {
      engine.setCell('keyEscape', code === 'Escape' ? 1 : 0)
      engine.setCell('keyArrowLeft', code === 'ArrowLeft' ? 1 : 0)
      engine.setCell('keyArrowRight', code === 'ArrowRight' ? 1 : 0)
    },
    // `promptIndex` is the photo whose caption was the click target, else -1: DOM identity stays in JS.
    click(clientX: number, clientY: number, promptIndex: number) {
      engine.setCell('clickActive', 1)
      engine.setCell('clickX', clientX)
      engine.setCell('clickY', clientY)
      engine.setCell('clickOnPrompt', promptIndex >= 0 ? 1 : 0)
      clickedPromptIndex = promptIndex
    },
    mousemove(clientX: number, clientY: number) {
      engine.setCell('moveActive', 1)
      engine.setCell('moveX', clientX)
      engine.setCell('moveY', clientY)
    },
    // Evaluate and apply side effects, without DOM writes. The demo projects
    // only visible photos itself; render() below does the full projection.
    evaluate(now: number) {
      // DOM reads (index.ts:255-263). The id scan against the URL hash stays in JS.
      const reads = platform.read()
      const focused = indexById.get(reads.hash.slice(1)) ?? -1
      engine.setCell('windowSizeX', reads.clientWidth)
      engine.setCell('windowSizeY', reads.clientHeight)
      engine.setCell('scrollX', reads.scrollX)
      engine.setCell('scrollY', reads.scrollY)
      engine.setCell('reducedMotion', reads.reducedMotion ? 1 : 0)
      engine.setCell('focusedIndex', Math.max(0, focused))
      engine.setCell('focusedPresent', focused >= 0 ? 1 : 0)
      engine.setCell('frameDuration', previousNow === null ? 0 : Math.max(0, now - previousNow))
      previousNow = now
      engine.step()
      // The circuit decides whether to select (index.ts:277); JS only knows which caption node was the target.
      if (engine.output('selectPrompt') === 1 && clickedPromptIndex >= 0) platform.selectPrompt(clickedPromptIndex)
    },
    sideEffects() {
      const present = engine.output('newFocusedPresent') === 1
      // Side effects (index.ts:457-463).
      if (engine.output('scrollChanged') === 1) platform.scrollTo(engine.output('adjustedScrollTop'))
      if (engine.output('focusChanged') === 1) {
        platform.pushHash(present ? `#${photos[engine.output('newFocusedIndex')]!.id}` : '')
      }
      return engine.output('stillAnimating') === 1
    },
    render(now: number): boolean {
      this.evaluate(now)
      // DOM writes (index.ts:411-453).
      for (let index = 0; index < photos.length; index++) {
        if (engine.photo('visible', index) === 1) view.showBox(index, projectBoxStyle(engine, photos, index))
        else view.hideBox(index)
      }
      const present = engine.output('newFocusedPresent') === 1
      const cursor = engine.output('cursorZoomIn') === 1 ? 'zoom-in' : engine.output('cursorZoomOut') === 1 ? 'zoom-out' : 'auto'
      view.setBody(cursor, present ? 'hidden' : 'auto', engine.output('placeholderHeight'))
      return this.sideEffects()
    },
  }
}
