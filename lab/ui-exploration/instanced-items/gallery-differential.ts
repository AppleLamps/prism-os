// Differential runs: the same interaction trace goes through the native fixture (reference.ts) and
// the gallery host (gallery-host.ts) over any GalleryEngine, each with its own FakeBrowser. After
// every frame, decisions are compared exactly and continuous values are compared as measured errors.
// Adapted from lab/ui-exploration/gallery/differential.ts: the harness reads the engine surface
// instead of the original circuit's wires, and accepts other photo lists.
import {FakeBrowser} from '../gallery/fake-dom.ts'
import {springNames} from '../gallery/gallery-circuit.ts'
import type {GalleryEngine} from './gallery-engine.ts'
import {createGalleryApp, type BoxStyle, type GalleryApp, type GalleryView} from './gallery-host.ts'
import type {PhotoData} from '../gallery/photo-data.ts'
import {createReferenceGallery, type ReferenceGallery} from '../gallery/reference.ts'

export type Action =
  | {kind: 'frame', duration: number}
  | {kind: 'mousemove', x: number, y: number}
  | {kind: 'click', x: number, y: number, target: 'box' | 'prompt' | 'background', photoIndex: number}
  | {kind: 'key', code: string}
  | {kind: 'resize', width: number, height: number}
  | {kind: 'scroll', y: number}
  | {kind: 'popstate', photoIndex: number}
  | {kind: 'reducedMotion', on: boolean}

export class RecordingView implements GalleryView {
  styles: (BoxStyle | null)[]
  sources: string[]
  cursor = ''
  overflowY = ''
  placeholderHeight = 0
  photoIds: string[]

  constructor(photoIds: string[]) {
    this.photoIds = photoIds
    this.styles = photoIds.map(() => null)
    this.sources = photoIds.map(() => '')
  }

  showBox(index: number, style: BoxStyle) {
    this.styles[index] = style
    if (style.fullResolution) this.sources[index] = `https://cdn.midjourney.com/${this.photoIds[index]}.webp`
  }

  hideBox(index: number) {
    this.styles[index] = null
  }

  setBody(cursor: string, overflowY: string, placeholderHeight: number) {
    this.cursor = cursor
    this.overflowY = overflowY
    this.placeholderHeight = placeholderHeight
  }
}

export type Mismatch = {frame: number, kind: string, detail: string}

export type ErrorStat = {maximumAbsolute: number, maximumRelative: number, worst: string}

export type DifferentialReport = {
  frames: number
  events: Record<string, number>
  framesIn1D: number
  animatingFrames: number
  reducedMotionFrames: number
  decisionChecks: number
  decisionMismatches: number
  checksByKind: Record<string, number>
  referenceChanges: Record<string, number>
  mismatchesByKind: Record<string, number>
  firstMismatches: Mismatch[]
  errors: Record<string, ErrorStat>
}

type Random = () => number

function seeded(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function numbers(text: string) {
  return (text.match(/-?\d+(\.\d+)?(e-?\d+)?/gi) ?? []).map(Number)
}

export type ScenarioOptions = {
  seed: number
  frames: number
  width: number
  height: number
  photos: readonly PhotoData[]
  engine: GalleryEngine
  // Copy the reference's committed state into the engine before every frame, so each frame checks one
  // render against the original (see lab/ui-exploration/gallery/differential.ts for the one artifact).
  resync?: boolean
  // 'dyadic' frame durations are exact in FP32; 'realistic' uses 16.667ms-style durations.
  durations?: 'dyadic' | 'realistic'
  eventRate?: number
  onFrame?: (context: {frame: number, now: number, reference: ReferenceGallery, app: GalleryApp}) => void
  // Scripted events instead of random ones, with a fixed 16.5ms frame duration.
  script?: (frame: number, context: ScriptContext) => Action[]
}

export type ScriptContext = {reference: ReferenceGallery, photos: readonly {id: string}[]}

const quarterPixel = (value: number) => Math.round(value * 4) / 4

function aimAt(reference: ReferenceGallery, index: number, promptArea = false) {
  const box = reference.data[index]!
  const imageHeight = box.sizeX.dest / box.ar
  const y = promptArea ? box.y.dest + imageHeight + 10 : box.y.dest + box.sizeY.dest / 3
  return {x: quarterPixel(box.x.dest + box.sizeX.dest / 2 - reference.browser.scrollX), y: quarterPixel(y - reference.browser.scrollY)}
}

// Hover a box, click to open the 1D view, arrow keys, resize while open, click the right region, hover
// the left region, Escape to close, scroll, resize (anchor), click a prompt, open the last photo from
// the URL, ArrowRight at the edge (rubber band), Escape (scroll back to the photo), then open and close
// from the URL. index.ts reads focus from the URL each frame, so closing from the URL doesn't scroll.
export function scriptedTrace(frame: number, {reference, photos}: ScriptContext): Action[] {
  const width = reference.browser.clientWidth
  const height = reference.browser.clientHeight
  switch (frame) {
    case 60: return [{kind: 'mousemove', ...aimAt(reference, 5)}]
    case 70: return [{kind: 'click', ...aimAt(reference, 5), target: 'box', photoIndex: 5}]
    case 100: case 110: return [{kind: 'key', code: 'ArrowRight'}]
    case 120: return [{kind: 'key', code: 'ArrowLeft'}]
    case 130: return [{kind: 'resize', width: 1024, height: 700}]
    case 160: return [{kind: 'click', x: width - 50, y: height / 2, target: 'background', photoIndex: 0}]
    case 190: return [{kind: 'mousemove', x: 50, y: height / 2}]
    case 200: return [{kind: 'key', code: 'Escape'}]
    case 240: return [{kind: 'scroll', y: 3000}]
    case 260: return [{kind: 'resize', width: 1600, height: 1000}]
    case 300: {
      const visible = reference.data.findIndex(box => box.node.parentNode !== null && box.y.dest > reference.browser.scrollY)
      return [{kind: 'click', ...aimAt(reference, visible, true), target: 'prompt', photoIndex: visible}]
    }
    case 320: return [{kind: 'popstate', photoIndex: photos.length - 1}]
    case 340: return [{kind: 'key', code: 'ArrowRight'}]
    case 360: return [{kind: 'key', code: 'ArrowLeft'}]
    case 380: return [{kind: 'key', code: 'Escape'}]
    case 400: return [{kind: 'popstate', photoIndex: 10}]
    case 410: return [{kind: 'popstate', photoIndex: -1}]
    default: return []
  }
}

export function createPair(options: ScenarioOptions) {
  const {photos, engine} = options
  const referenceBrowser = new FakeBrowser(options.width, options.height)
  const reference = createReferenceGallery(referenceBrowser, [...photos])
  const appBrowser = new FakeBrowser(options.width, options.height)
  const view = new RecordingView(photos.map(photo => photo.id))
  appBrowser.documentHeight = () => view.placeholderHeight
  const nodeByPrompt = reference.data.map(box => box.promptNode)
  const platform = {
    read: () => ({
      clientWidth: appBrowser.clientWidth,
      clientHeight: appBrowser.clientHeight,
      scrollX: appBrowser.scrollX,
      scrollY: appBrowser.scrollY,
      reducedMotion: appBrowser.reducedMotion,
      hash: appBrowser.hash,
    }),
    scrollTo: (top: number) => appBrowser.scrollTo(top),
    pushHash: (hash: string) => appBrowser.pushState(`/${hash}`),
    selectPrompt: (photoIndex: number) => { appBrowser.selectedNodes.push(nodeByPrompt[photoIndex]!) },
  }
  const app = createGalleryApp(photos, platform, view, engine)
  return {photos, reference, referenceBrowser, app, appBrowser, view}
}

export function syncFromReference(engine: GalleryEngine, reference: ReferenceGallery, previousNow: number | null) {
  // Spring displacements and velocities come from the reference. Destinations stay the engine's own,
  // so the small FP32 drift of recomputed layouts doesn't look like a new displacement.
  reference.data.forEach((box, index) => {
    for (const name of springNames) {
      engine.setSpring(index, name, 'displacement', box[name].pos - box[name].dest)
      engine.setSpring(index, name, 'velocity', box[name].v)
    }
  })
  const state = reference.state()
  engine.setCell('anchor', state.anchor)
  engine.setCell('previousWindowSizeX', state.windowSizeX)
  engine.setCell('committedScrollY', state.scrollY)
  const pointerPresent = Number.isFinite(state.pointerX)
  engine.setCell('pointerPresent', pointerPresent ? 1 : 0)
  engine.setCell('pointerX', pointerPresent ? state.pointerX : 0)
  engine.setCell('pointerY', pointerPresent ? state.pointerY : 0)
  engine.setCell('animating', state.animatedUntilTime === null ? 0 : 1)
  engine.setCell('leftoverMilliseconds', state.animatedUntilTime === null || previousNow === null ? 0 : previousNow - state.animatedUntilTime)
}

export function runScenario(options: ScenarioOptions): DifferentialReport {
  const random = seeded(options.seed)
  const pair = createPair(options)
  const {photos, reference, referenceBrowser, app, appBrowser, view} = pair
  const {engine} = options
  const eventRate = options.eventRate ?? 1
  const report: DifferentialReport = {
    frames: 0, events: {}, framesIn1D: 0, animatingFrames: 0, reducedMotionFrames: 0, decisionChecks: 0, decisionMismatches: 0,
    checksByKind: {}, referenceChanges: {}, mismatchesByKind: {}, firstMismatches: [], errors: {},
  }
  let now = 1000
  let previousNow: number | null = null
  let clickedThisFrame = false
  const quarter = quarterPixel

  const apply = (action: Action) => {
    report.events[action.kind] = (report.events[action.kind] ?? 0) + 1
    switch (action.kind) {
      case 'mousemove':
        reference.mousemove(action.x, action.y)
        app.mousemove(action.x, action.y)
        break
      case 'click':
        reference.click(action.x, action.y, action.target, action.photoIndex)
        app.click(action.x, action.y, action.target === 'prompt' ? action.photoIndex : -1)
        clickedThisFrame = true
        break
      case 'key':
        reference.keydown(action.code)
        app.keydown(action.code)
        break
      case 'resize':
        for (const browser of [referenceBrowser, appBrowser]) {
          browser.clientWidth = action.width
          browser.clientHeight = action.height
        }
        break
      case 'scroll':
        for (const browser of [referenceBrowser, appBrowser]) {
          browser.scrollY = Math.min(Math.max(0, action.y), Math.max(0, browser.documentHeight() - browser.clientHeight))
        }
        break
      case 'popstate':
        for (const browser of [referenceBrowser, appBrowser]) browser.hash = action.photoIndex < 0 ? '' : `#${photos[action.photoIndex]!.id}`
        break
      case 'reducedMotion':
        referenceBrowser.reducedMotion = action.on
        appBrowser.reducedMotion = action.on
        break
      case 'frame':
        break
    }
  }

  const mismatch = (kind: string, detail: string) => {
    report.decisionMismatches++
    report.mismatchesByKind[kind] = (report.mismatchesByKind[kind] ?? 0) + 1
    if (report.firstMismatches.length < 12) report.firstMismatches.push({frame: report.frames, kind, detail})
  }
  const countChange = (kind: string) => {
    report.referenceChanges[kind] = (report.referenceChanges[kind] ?? 0) + 1
  }
  const previousExpected = new Map<string, unknown>()
  const check = (kind: string, expected: unknown, actual: unknown, {photo, callCount = false}: {photo?: number, callCount?: boolean} = {}) => {
    report.decisionChecks++
    report.checksByKind[kind] = (report.checksByKind[kind] ?? 0) + 1
    const key = photo === undefined ? kind : `${kind} ${photo}`
    if (callCount ? expected !== 0 : previousExpected.has(key) && previousExpected.get(key) !== expected) countChange(kind)
    previousExpected.set(key, expected)
    if (expected !== actual) mismatch(kind, `${photo === undefined ? '' : `photo ${photo}: `}expected ${String(expected)}, got ${String(actual)}`)
  }
  const measure = (kind: string, expected: number, actual: number, context: string) => {
    const absolute = Math.abs(expected - actual)
    const relative = absolute / Math.max(1, Math.abs(expected))
    const stat = report.errors[kind] ??= {maximumAbsolute: 0, maximumRelative: 0, worst: ''}
    if (!(absolute <= stat.maximumAbsolute)) {
      stat.maximumAbsolute = Number.isNaN(absolute) ? Infinity : absolute
      stat.worst = `frame ${report.frames} ${context}: expected ${expected}, got ${actual}`
    }
    stat.maximumRelative = Math.max(stat.maximumRelative, relative)
  }

  const generateEvents = () => {
    const in1D = referenceBrowser.hash !== ''
    const visible = reference.data.map((box, index) => box.node.parentNode === null ? -1 : index).filter(index => index >= 0)
    const pointInBox = (index: number, promptArea: boolean) => {
      const box = reference.data[index]!
      const x = box.x.dest + random() * box.sizeX.dest
      const imageHeight = box.sizeX.dest / box.ar
      const y = promptArea ? box.y.dest + imageHeight + random() * (box.sizeY.dest - imageHeight) : box.y.dest + random() * box.sizeY.dest
      // Pointer events stay near the window, even when the aimed box is far offscreen.
      const clamp = (value: number, limit: number) => Math.min(Math.max(value, -20), limit + 20)
      return {
        x: quarter(clamp(x - referenceBrowser.scrollX, referenceBrowser.clientWidth)),
        y: quarter(clamp(y - referenceBrowser.scrollY, referenceBrowser.clientHeight)),
      }
    }
    const randomPoint = () => ({x: quarter(random() * referenceBrowser.clientWidth), y: quarter(random() * referenceBrowser.clientHeight)})
    if (random() < 0.5 * eventRate) {
      const point = visible.length > 0 && random() < 0.6 ? pointInBox(visible[Math.floor(random() * visible.length)]!, false) : randomPoint()
      apply({kind: 'mousemove', ...point})
    }
    if (random() < 0.12 * eventRate) {
      const choice = random()
      if (!in1D && visible.length > 0 && choice < 0.65) {
        const index = visible[Math.floor(random() * visible.length)]!
        const onPrompt = choice < 0.15
        apply({kind: 'click', ...pointInBox(index, onPrompt), target: onPrompt ? 'prompt' : 'box', photoIndex: index})
      } else if (in1D && choice < 0.6) {
        const x = choice < 0.3 ? quarter(random() * 100) : quarter(referenceBrowser.clientWidth - random() * 100)
        apply({kind: 'click', x, y: quarter(random() * referenceBrowser.clientHeight), target: 'background', photoIndex: 0})
      } else {
        apply({kind: 'click', ...randomPoint(), target: 'background', photoIndex: 0})
      }
    }
    if (random() < 0.1 * eventRate) {
      const choice = random()
      apply({kind: 'key', code: choice < 0.35 ? 'ArrowLeft' : choice < 0.7 ? 'ArrowRight' : choice < 0.9 ? 'Escape' : 'KeyB'})
    }
    if (random() < 0.025 * eventRate) {
      const boundary = random() < 0.3
      const width = boundary ? 24 + 244 * (2 + Math.floor(random() * 6)) + Math.floor(random() * 3) - 1 : 320 + Math.floor(random() * 2300)
      apply({kind: 'resize', width, height: 400 + Math.floor(random() * 1000)})
    }
    if (!in1D && random() < 0.06 * eventRate) {
      apply({kind: 'scroll', y: quarter(random() * Math.max(0, reference.browser.documentHeight() - referenceBrowser.clientHeight))})
    }
    if (random() < 0.01 * eventRate) apply({kind: 'popstate', photoIndex: random() < 0.3 ? -1 : Math.floor(random() * photos.length)})
    // Reduced motion comes in short episodes, so most frames still animate.
    if (referenceBrowser.reducedMotion ? random() < 0.15 : random() < 0.004 * eventRate) {
      apply({kind: 'reducedMotion', on: !referenceBrowser.reducedMotion})
    }
  }

  const nextDuration = () => {
    if (options.durations === 'realistic') {
      // rAF-like timestamps: vsync intervals with jitter, quantized to microseconds.
      const choice = random()
      const interval = choice < 0.03 ? 200 + random() * 1300 : choice < 0.5 ? 1000 / 60 : choice < 0.8 ? 1000 / 120 : 5 + random() * 30
      const nextNow = Math.round((now + interval + (random() - 0.5) * 0.2) * 1000) / 1000
      return nextNow - now
    }
    const choice = random()
    if (choice < 0.03) return Math.round((200 + random() * 1300) * 64) / 64
    if (choice < 0.04) return 0
    return [16.5, 16.75, 8.25, 33.5, 7.0625, 16.6875][Math.floor(random() * 6)]!
  }

  for (let frame = 0; frame < options.frames; frame++) {
    clickedThisFrame = false
    if (frame > 0) {
      if (options.script === undefined) generateEvents()
      else for (const action of options.script(frame, {reference, photos})) apply(action)
    }
    now += frame === 0 ? 0 : options.script === undefined ? nextDuration() : 16.5
    report.events['frame'] = (report.events['frame'] ?? 0) + 1
    const scrollCallsBefore = [referenceBrowser.scrollToCalls, appBrowser.scrollToCalls]
    const pushCallsBefore = [referenceBrowser.pushStateCalls, appBrowser.pushStateCalls]
    const selectionsBefore = [referenceBrowser.selectedNodes.length, appBrowser.selectedNodes.length]
    const hashBefore = referenceBrowser.hash
    if (options.resync === true && frame > 0) syncFromReference(engine, reference, previousNow)
    // index.ts:403-405 starts from animatedUntilTime (or now) and advances it by whole 4ms steps.
    const animatedUntilBefore = reference.state().animatedUntilTime ?? now
    const referenceAnimating = reference.render(now)
    const appAnimating = app.render(now)
    previousNow = now
    report.frames++
    if (referenceBrowser.hash !== '') report.framesIn1D++
    if (referenceAnimating) report.animatingFrames++
    if (referenceBrowser.reducedMotion) report.reducedMotionFrames++
    if (clickedThisFrame && hashBefore === '' && referenceBrowser.hash !== '') countChange('URL focus opened by a click')
    options.onFrame?.({frame, now, reference, app})

    check('still animating', referenceAnimating, appAnimating)
    check('URL focus', referenceBrowser.hash, appBrowser.hash)
    check('scrollTo called', referenceBrowser.scrollToCalls - scrollCallsBefore[0]!, appBrowser.scrollToCalls - scrollCallsBefore[1]!, {callCount: true})
    check('pushState called', referenceBrowser.pushStateCalls - pushCallsBefore[0]!, appBrowser.pushStateCalls - pushCallsBefore[1]!, {callCount: true})
    check('prompt selected', referenceBrowser.selectedNodes.length - selectionsBefore[0]!, appBrowser.selectedNodes.length - selectionsBefore[1]!, {callCount: true})
    check('cursor', reference.body.styleValues.get('cursor'), view.cursor)
    check('body overflow', reference.body.styleValues.get('overflowY'), view.overflowY)
    const state = reference.state()
    check('anchor', state.anchor, engine.getCell('anchor'))
    // When index.ts keeps animating, its step count is recoverable from animatedUntilTime.
    if (state.animatedUntilTime !== null) {
      check('animation steps', Math.round((state.animatedUntilTime - animatedUntilBefore) / 4), engine.output('steps'))
    }
    measure('scroll position', referenceBrowser.scrollY, appBrowser.scrollY, 'browser scrollY')
    measure('committed scroll', state.scrollY, engine.getCell('committedScrollY'), 'committed scrollY')
    measure('placeholder height', Number.parseFloat(String(reference.placeholder.style['height'])), view.placeholderHeight, 'placeholder')

    reference.data.forEach((box, index) => {
      for (const name of springNames) {
        measure(`${name} position`, box[name].pos, engine.photo(name, index), `photo ${index} ${name}`)
        measure(`${name} velocity`, box[name].v, engine.getSpring(index, name, 'velocity'), `photo ${index} ${name}`)
      }
      measure('destination x', box.x.dest, engine.getSpring(index, 'x', 'destination'), `photo ${index}`)
      measure('destination y', box.y.dest, engine.getSpring(index, 'y', 'destination'), `photo ${index}`)
      measure('destination width', box.sizeX.dest, engine.getSpring(index, 'sizeX', 'destination'), `photo ${index}`)
      measure('destination height', box.sizeY.dest, engine.getSpring(index, 'sizeY', 'destination'), `photo ${index}`)
      const referenceVisible = box.node.parentNode !== null
      const style = view.styles[index]!
      check('visible', referenceVisible, style !== null, {photo: index})
      if (!referenceVisible || style === null) return
      const node = box.node.styleValues
      const prompt = box.promptNode.styleValues
      check('z-index', node.get('zIndex'), style.zIndex, {photo: index})
      check('prompt overflow', prompt.get('overflowY'), style.promptOverflowY, {photo: index})
      check('prompt height', prompt.get('height'), style.promptHeight, {photo: index})
      check('line clamp', prompt.get('line-clamp'), style.lineClamp, {photo: index})
      check('image display', box.img.styleValues.get('display'), style.imageDisplay, {photo: index})
      check('full resolution source', box.img.src, view.sources[index], {photo: index})
      const referenceFilter = numbers(node.get('filter') ?? '')
      const appFilter = numbers(style.filter)
      check('filter kind', referenceFilter.length, appFilter.length, {photo: index})
      referenceFilter.forEach((value, position) => measure('style filter', value, appFilter[position] ?? NaN, `photo ${index}`))
      const referenceTransform = numbers(node.get('transform') ?? '')
      const appTransform = numbers(style.transform)
      referenceTransform.forEach((value, position) => measure('style transform', value, appTransform[position] ?? NaN, `photo ${index}`))
      measure('style width', Number.parseFloat(node.get('width') ?? ''), Number.parseFloat(style.width), `photo ${index}`)
      measure('style prompt top', Number.parseFloat(prompt.get('top') ?? ''), Number.parseFloat(style.promptTop), `photo ${index}`)
    })
  }
  return report
}
