// chenglou.github.io's gallery as a retiming workload (copied into copies/gallery):
// 221 photos, driven by the differential's random traces with dyadic frame times.
import {buildGraph, flattenProgram, type Graph} from './flat.ts'
import {type MetricSpec, type Model, OutputGroupBuilder, type Trace, type TraceRun, describeValue, outputLabelMap} from './retime.ts'
import {buildGalleryCircuit, springNames, type GalleryCircuit} from './copies/gallery/gallery-circuit.ts'
import {createGalleryApp, type GalleryMachine, type GalleryView} from './copies/gallery/gallery-app.ts'
import {FakeBrowser} from './copies/gallery/fake-dom.ts'
import {type Action} from './copies/gallery/differential.ts'
import {createReferenceGallery, loadFixturePhotos} from './copies/gallery/reference.ts'
import type {PhotoData} from './copies/gallery/photo-data.ts'

export type GalleryModel = Model & {
  built: GalleryCircuit
  photos: PhotoData[]
  graph: Graph
  nextSource: [cell: number, position: number][]
  sourceNames: Map<number, string>
  outputLabels: Map<number, string>
}

export function createGalleryModel(name: string): GalleryModel {
  const photos = loadFixturePhotos()
  const built = buildGalleryCircuit(photos)
  const program = flattenProgram(built.circuit.compileTensorProgram(built.roots))
  const position = (wire: number) => program.positionOfWire[wire]!
  const {outputs, cells} = built
  const px = new OutputGroupBuilder()
  const scale = new OutputGroupBuilder()
  const opacity = new OutputGroupBuilder()
  const decisions = new OutputGroupBuilder()
  outputs.photos.forEach((photo, index) => {
    const visible = position(photo.visible)
    for (const springName of ['x', 'y', 'sizeX', 'sizeY'] as const) px.add(position(photo.springs[springName]), `photos[${index}].${springName}`, visible)
    scale.add(position(photo.springs.scale), `photos[${index}].scale × width`, visible, -1, position(photo.springs.sizeX))
    scale.add(position(photo.springs.scale), `photos[${index}].scale × height`, visible, -1, position(photo.springs.sizeY))
    opacity.add(position(photo.springs.fxFactor), `photos[${index}].brightness`, visible)
    decisions.add(visible, `photos[${index}].visible`)
    decisions.add(position(photo.focused), `photos[${index}].focused`)
    decisions.add(position(photo.blurred), `photos[${index}].blurred`)
  })
  px.add(position(outputs.placeholderHeight), 'placeholderHeight')
  px.add(position(outputs.adjustedScrollTop), 'scrollTo top', position(outputs.scrollChanged))
  for (const outputName of ['newFocusedIndex', 'newFocusedPresent', 'focusChanged', 'scrollChanged', 'cursorZoomIn', 'cursorZoomOut', 'stillAnimating', 'selectPrompt', 'columns', 'steps'] as const) {
    decisions.add(position(outputs[outputName]), outputName)
  }
  const nextSource = built.nextSource.map(([cell, wire]): [number, number] => [cell, position(wire)])
  for (const cellName of ['anchor', 'pointerPresent', 'animating'] as const) {
    decisions.add(nextSource.find(([cell]) => cell === cells[cellName])![1], `next ${cellName}`)
  }
  const metric: MetricSpec = {px: px.build(), scale: scale.build(), opacity: opacity.build(), decisions: decisions.build(), unitless: new OutputGroupBuilder().build()}
  const sourceNames = new Map<number, string>()
  for (const [cellName, cell] of Object.entries(cells)) if (typeof cell === 'number') sourceNames.set(cell, cellName)
  cells.photos.forEach((photoCells, index) => {
    for (const springName of springNames) {
      for (const part of ['displacement', 'velocity', 'destination'] as const) sourceNames.set(photoCells.springs[springName][part], `photos[${index}].${springName}.${part}`)
    }
  })
  return {name, program, metric, built, photos, graph: buildGraph(program), nextSource, sourceNames, outputLabels: outputLabelMap(metric)}
}

export function describeGalleryValue(model: GalleryModel, position: number) {
  const wire = model.program.wireOrder[position]!
  const {circuit, sections} = model.built
  const place = wire < circuit.sourceSize ? 'source' : sections.sectionOf(wire - circuit.sourceSize)
  return {place, ...describeValue(model.graph, position, cell => model.sourceNames.get(cell) ?? `cell ${cell}`, model.outputLabels)}
}

type Random = () => number

function seeded(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const quarterPixel = (value: number) => Math.round(value * 4) / 4

export type GalleryActions = {seed: number, width: number, height: number, actions: Action[][], now: number[]}

// differential.ts's runScenario event generator, run against the original index.ts
// alone. Its events only read the original's state and one random stream, so the
// recorded actions equal the ones the differential applied to both sides.
export function recordGalleryActions(seed: number, frames: number, width: number, height: number): GalleryActions {
  const random = seeded(seed)
  const photos = loadFixturePhotos()
  const referenceBrowser = new FakeBrowser(width, height)
  const reference = createReferenceGallery(referenceBrowser, photos)
  const actions: Action[][] = []
  const nows: number[] = []
  let frameActions: Action[] = []
  const apply = (action: Action) => {
    frameActions.push(action)
    switch (action.kind) {
      case 'mousemove': reference.mousemove(action.x, action.y); break
      case 'click': reference.click(action.x, action.y, action.target, action.photoIndex); break
      case 'key': reference.keydown(action.code); break
      case 'resize':
        referenceBrowser.clientWidth = action.width
        referenceBrowser.clientHeight = action.height
        break
      case 'scroll':
        referenceBrowser.scrollY = Math.min(Math.max(0, action.y), Math.max(0, referenceBrowser.documentHeight() - referenceBrowser.clientHeight))
        break
      case 'popstate': referenceBrowser.hash = action.photoIndex < 0 ? '' : `#${photos[action.photoIndex]!.id}`; break
      case 'reducedMotion': referenceBrowser.reducedMotion = action.on; break
      case 'frame': break
    }
  }
  const generateEvents = () => {
    const in1D = referenceBrowser.hash !== ''
    const visible = reference.data.map((box, index) => box.node.parentNode === null ? -1 : index).filter(index => index >= 0)
    const pointInBox = (index: number, promptArea: boolean) => {
      const box = reference.data[index]!
      const x = box.x.dest + random() * box.sizeX.dest
      const imageHeight = box.sizeX.dest / box.ar
      const y = promptArea ? box.y.dest + imageHeight + random() * (box.sizeY.dest - imageHeight) : box.y.dest + random() * box.sizeY.dest
      const clamp = (value: number, limit: number) => Math.min(Math.max(value, -20), limit + 20)
      return {
        x: quarterPixel(clamp(x - referenceBrowser.scrollX, referenceBrowser.clientWidth)),
        y: quarterPixel(clamp(y - referenceBrowser.scrollY, referenceBrowser.clientHeight)),
      }
    }
    const randomPoint = () => ({x: quarterPixel(random() * referenceBrowser.clientWidth), y: quarterPixel(random() * referenceBrowser.clientHeight)})
    if (random() < 0.5) {
      const point = visible.length > 0 && random() < 0.6 ? pointInBox(visible[Math.floor(random() * visible.length)]!, false) : randomPoint()
      apply({kind: 'mousemove', ...point})
    }
    if (random() < 0.12) {
      const choice = random()
      if (!in1D && visible.length > 0 && choice < 0.65) {
        const index = visible[Math.floor(random() * visible.length)]!
        const onPrompt = choice < 0.15
        apply({kind: 'click', ...pointInBox(index, onPrompt), target: onPrompt ? 'prompt' : 'box', photoIndex: index})
      } else if (in1D && choice < 0.6) {
        const x = choice < 0.3 ? quarterPixel(random() * 100) : quarterPixel(referenceBrowser.clientWidth - random() * 100)
        apply({kind: 'click', x, y: quarterPixel(random() * referenceBrowser.clientHeight), target: 'background', photoIndex: 0})
      } else {
        apply({kind: 'click', ...randomPoint(), target: 'background', photoIndex: 0})
      }
    }
    if (random() < 0.1) {
      const choice = random()
      apply({kind: 'key', code: choice < 0.35 ? 'ArrowLeft' : choice < 0.7 ? 'ArrowRight' : choice < 0.9 ? 'Escape' : 'KeyB'})
    }
    if (random() < 0.025) {
      const boundary = random() < 0.3
      const newWidth = boundary ? 24 + 244 * (2 + Math.floor(random() * 6)) + Math.floor(random() * 3) - 1 : 320 + Math.floor(random() * 2300)
      apply({kind: 'resize', width: newWidth, height: 400 + Math.floor(random() * 1000)})
    }
    if (!in1D && random() < 0.06) {
      apply({kind: 'scroll', y: quarterPixel(random() * Math.max(0, reference.browser.documentHeight() - referenceBrowser.clientHeight))})
    }
    if (random() < 0.01) apply({kind: 'popstate', photoIndex: random() < 0.3 ? -1 : Math.floor(random() * photos.length)})
    if (referenceBrowser.reducedMotion ? random() < 0.15 : random() < 0.004) {
      apply({kind: 'reducedMotion', on: !referenceBrowser.reducedMotion})
    }
  }
  const nextDuration = () => {
    const choice = random()
    if (choice < 0.03) return Math.round((200 + random() * 1300) * 64) / 64
    if (choice < 0.04) return 0
    return [16.5, 16.75, 8.25, 33.5, 7.0625, 16.6875][Math.floor(random() * 6)]!
  }
  let now = 1000
  for (let frame = 0; frame < frames; frame++) {
    frameActions = []
    if (frame > 0) generateEvents()
    now += frame === 0 ? 0 : nextDuration()
    reference.render(now)
    actions.push(frameActions)
    nows.push(now)
  }
  return {seed, width, height, actions, now: nows}
}

// gallery/report.ts's viewports for seeds 5000..5005.
export const galleryViewports = [[1440, 900], [390, 844], [2560, 1400], [800, 600], [1024, 1366], [1920, 1080]] as const

export function galleryTrace(recorded: GalleryActions): Trace<GalleryModel> {
  return {
    name: `dyadic trace seed ${recorded.seed}, ${recorded.width}x${recorded.height}, ${recorded.actions.length} frames`,
    createRun(model): TraceRun {
      const browser = new FakeBrowser(recorded.width, recorded.height)
      let placeholderHeight = 0
      browser.documentHeight = () => placeholderHeight
      const view: GalleryView = {
        showBox() {},
        hideBox() {},
        setBody(_cursor, _overflowY, height) { placeholderHeight = height },
      }
      let evaluate: (source: Float32Array) => Float32Array = () => { throw new Error('no evaluator yet') }
      let values: Float32Array = new Float32Array(0)
      const {built} = model
      const latchCells = [built.cells.keyEscape, built.cells.keyArrowLeft, built.cells.keyArrowRight, built.cells.clickActive, built.cells.clickOnPrompt, built.cells.moveActive]
      const source = new Float32Array(built.layout.size)
      const machine: GalleryMachine = {
        built,
        source,
        step() {
          values = evaluate(source)
          for (const [cell, position] of model.nextSource) source[cell] = values[position]!
          for (const cell of latchCells) source[cell] = 0
        },
        read(wire) {
          return values[model.program.positionOfWire[wire]!]!
        },
      }
      const platform = {
        read: () => ({clientWidth: browser.clientWidth, clientHeight: browser.clientHeight, scrollX: browser.scrollX, scrollY: browser.scrollY, reducedMotion: browser.reducedMotion, hash: browser.hash}),
        scrollTo: (top: number) => browser.scrollTo(top),
        pushHash: (hash: string) => browser.pushState(`/${hash}`),
        selectPrompt: () => {},
      }
      const app = createGalleryApp(model.photos, platform, view, {}, built, machine)
      return {
        frames: recorded.actions.length,
        frame(index, frameEvaluate) {
          evaluate = frameEvaluate
          for (const action of recorded.actions[index]!) {
            switch (action.kind) {
              case 'mousemove': app.mousemove(action.x, action.y); break
              case 'click': app.click(action.x, action.y, action.target === 'prompt' ? action.photoIndex : -1); break
              case 'key': app.keydown(action.code); break
              case 'resize':
                browser.clientWidth = action.width
                browser.clientHeight = action.height
                break
              case 'scroll':
                browser.scrollY = Math.min(Math.max(0, action.y), Math.max(0, browser.documentHeight() - browser.clientHeight))
                break
              case 'popstate': browser.hash = action.photoIndex < 0 ? '' : `#${model.photos[action.photoIndex]!.id}`; break
              case 'reducedMotion': browser.reducedMotion = action.on; break
              case 'frame': break
            }
          }
          app.render(recorded.now[index]!)
        },
      }
    },
  }
}
