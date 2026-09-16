// The UI traces measured here. Each runs its prototype's own host code (copied
// into copies/) and returns that prototype's own checks against its independent
// reference, so a perturbed mode is judged both against the stored interpreter
// and against the original UI's logic.
import type {Wire} from '../../../numeric-ui-core.ts'
import {itemCount as photoCount} from '../codegen/photo-gallery-copy.ts'
import {createWindowManagerMachine, photoFocusSourceField, sourceField, windowOutputField, windowSourceField, windowStateField} from '../codegen/window-manager-copy.ts'
import {applyInteraction, createIndirectOSMachine, interactionFrameTime} from './copies/codegen/indirect-os-machine.ts'
import {ownerCode, referenceOwnership, regionCode} from './copies/codegen/window-ownership.ts'
import {runScenario} from './copies/gallery/differential.ts'
import {buildGalleryCircuit, type GalleryCircuit} from './copies/gallery/gallery-circuit.ts'
import {loadFixturePhotos} from './copies/gallery/reference.ts'
import {runScenarioDifferential} from './copies/hn-thread/differential.ts'
import {installFakeCanvas} from './copies/hn-thread/fake-canvas.ts'
import {thread} from './copies/hn-thread/hn-data.ts'
import {buildThreadCircuit, type BuiltThreadCircuit} from './copies/hn-thread/thread-circuit.ts'
import {prepareThread, type PreparedThread} from './copies/hn-thread/thread-prepare.ts'
import {buildCards, type CardsCircuit} from './copies/lists/cards.ts'
import {demoCardSizes, runCardsDifferential} from './copies/lists/traces.ts'
import {createRandom as createNumericRandom, stepFloat32} from './copies/numeric-library/measure.ts'
import {createWorkloadCircuit, iconCount, randomWorkloadSource, referenceWorkload, tickCount, workloadField, workloadRoots} from './copies/numeric-library/workload.ts'
import {buildEditorCircuit, createEditorMachine, type EditorBuild} from './copies/text-editing/editor-circuit.ts'
import {fakeTextWidth} from './copies/text-editing/fake-canvas.ts'
import {takeFrameEvents} from './copies/text-editing/keyboard.ts'
import {emptyState, event, layoutSlotCount, referenceFrame, type EditorConfig, type EditorEvent} from './copies/text-editing/reference.ts'
import {createRandom as createEditorRandom, randomEvent, testTable} from './copies/text-editing/test-support.ts'
import {createWidthTable, encodeText} from './copies/text-editing/width-table.ts'
import type {Workload} from './measure.ts'

function lazy<T>(build: () => T): () => T {
  let value: T | undefined
  return () => value ??= build()
}

// ----- IndirectOS: codegen's 240-frame session -----

const pressTargets = new Map([
  [5, {owner: ownerCode.firstWindow + 0, region: regionCode.titleBar}],
  [60, {owner: ownerCode.firstWindow + 0, region: regionCode.resizeGrip}],
  [100, {owner: ownerCode.firstWindow + 1, region: regionCode.close}],
  [115, {owner: ownerCode.firstDockItem + 1, region: regionCode.content}],
  [130, {owner: ownerCode.firstWindow + 3, region: regionCode.maximize}],
  [210, {owner: ownerCode.firstWindow + 3, region: regionCode.maximize}],
  [225, {owner: ownerCode.firstWindow + 1, region: regionCode.minimize}],
])

function windowCell(source: Float32Array, windowIndex: number, field: keyof typeof windowStateField) {
  return source[windowSourceField(windowIndex, windowStateField[field])]
}

function focusedPhotos(source: Float32Array) {
  return Array.from({length: photoCount}, (_, item) => item).filter(item => source[photoFocusSourceField(item)] === 1).join(',')
}

// The state change each event causes, from codegen/indirect-os-machine.test.ts.
const transitions: [frame: number, description: string, holds: (source: Float32Array) => boolean][] = [
  [31, 'window 0 moved by its title bar', source => windowCell(source, 0, 'left') === 254 && windowCell(source, 0, 'top') === 154],
  [81, 'window 0 resized by its grip', source => windowCell(source, 0, 'width') === 620 && windowCell(source, 0, 'height') === 400],
  [100, 'window 1 closed', source => windowCell(source, 1, 'open') === 0],
  [115, 'window 1 reopened from the dock', source => windowCell(source, 1, 'open') === 1],
  [130, 'Photos maximized', source => windowCell(source, 3, 'maximized') === 1],
  [160, 'photo 5 focused by a click in the grid', source => focusedPhotos(source) === '5'],
  [175, 'Photos moved to photo 6', source => focusedPhotos(source) === '6'],
  [190, 'Photos moved back to photo 5', source => focusedPhotos(source) === '5'],
  [200, 'the focused photo closed', source => focusedPhotos(source) === ''],
  [210, 'Photos restored', source => windowCell(source, 3, 'maximized') === 0],
  [225, 'window 1 minimized', source => windowCell(source, 1, 'minimized') === 1],
]

function windowFields(windows: readonly Wire[], fields: readonly (keyof typeof windowOutputField)[]) {
  return windows.filter((_, index) => fields.some(field => windowOutputField[field] === index % windowOutputField.size))
}

export function indirectOSWorkload(): Workload {
  const production = lazy(() => createWindowManagerMachine())
  return {
    name: 'IndirectOS',
    description: "codegen's 240-frame session at 1280×800: drag, resize, close and reopen, maximize Photos, open photos, restore, minimize, with a 90 ms stall",
    create() {
      const machine = production()
      const {output} = machine
      return {
        circuit: machine.circuit,
        drift: [
          {name: 'window positions and sizes (px)', wires: windowFields(output.windows, ['translateX', 'translateY', 'width', 'height', 'contentWidth', 'contentHeight'])},
          {name: 'window scale and opacity', wires: windowFields(output.windows, ['scale', 'opacity'])},
          {name: 'window stack order', wires: windowFields(output.windows, ['stack'])},
          {name: 'dock outputs (px)', wires: output.dockItems},
          {name: 'Photos outputs', wires: [...output.photos.photos, ...output.photos.thumbnails, ...output.photos.previousControl, ...output.photos.nextControl]},
        ],
        settle: [{name: 'animation active (host reads > 0)', wires: [output.animationActive], decision: 'positive'}],
        nextSource: output.nextSource.map((wire, cell) => [cell, wire] as const),
        run() {
          const copy = createIndirectOSMachine({evaluator: 'executor', validate: false, production: machine})
          let pressesChecked = 0
          let pressTargetMismatches = 0
          let transitionFailures = 0
          for (let frame = 0; frame < 240; frame++) {
            applyInteraction(copy, frame)
            if (copy.source[sourceField.downActive] === 1) {
              pressesChecked++
              const target = referenceOwnership(copy.source, copy.source[sourceField.downX]!, copy.source[sourceField.downY]!)
              const expected = pressTargets.get(frame)
              if (expected === undefined || expected.owner !== target.owner || expected.region !== target.region) pressTargetMismatches++
            }
            copy.step(1280, 800, interactionFrameTime(frame))
            for (const [transitionFrame, , holds] of transitions) {
              if (transitionFrame === frame && !holds(copy.source)) transitionFailures++
            }
          }
          return {pressesChecked, pressTargetMismatches, transitionsChecked: transitions.length, transitionFailures}
        },
      }
    },
  }
}

// ----- gallery: dyadic random traces, where strip positions pass 170,000 px -----

export const galleryViewports = [[1440, 900], [390, 844], [2560, 1400], [800, 600], [1024, 1366], [1920, 1080]] as const

const galleryBuilt = lazy((): GalleryCircuit => buildGalleryCircuit(loadFixturePhotos()))

// Names of the gallery's output wires, e.g. 'stillAnimating' or 'photo 123 destX'.
export function galleryOutputNames(): Map<Wire, string> {
  const built = galleryBuilt()
  const names = new Map<Wire, string>()
  for (const [key, value] of Object.entries(built.outputs)) if (typeof value === 'number') names.set(value, key)
  built.outputs.photos.forEach((photo, index) => {
    for (const [key, value] of Object.entries(photo)) {
      if (typeof value === 'number') names.set(value, `photo ${index} ${key}`)
      else for (const [springName, wire] of Object.entries(value as Record<string, Wire>)) names.set(wire, `photo ${index} spring ${springName}`)
    }
  })
  for (const [cell, wire] of built.nextSource) if (!names.has(wire)) names.set(wire, `next source cell ${cell}`)
  return names
}

export function galleryWorkload(traceIndex: number, frames: number): Workload {
  const [width, height] = galleryViewports[traceIndex]!
  const seed = 5000 + traceIndex
  return {
    name: `gallery trace ${seed}`,
    description: `gallery's dyadic random trace, seed ${seed}, ${width}×${height}, ${frames} frames, free-running`,
    create() {
      const built = galleryBuilt()
      const {outputs} = built
      return {
        circuit: built.circuit,
        drift: [
          {name: 'photo springs x, y, width, height', wires: outputs.photos.flatMap(photo => [photo.springs.x, photo.springs.y, photo.springs.sizeX, photo.springs.sizeY])},
          {name: 'photo destinations', wires: outputs.photos.flatMap(photo => [photo.destX, photo.destY, photo.destSizeX, photo.destSizeY])},
          {name: 'placeholder height and scroll target', wires: [outputs.placeholderHeight, outputs.adjustedScrollTop]},
        ],
        settle: [{name: 'still animating', wires: [outputs.stillAnimating]}],
        nextSource: built.nextSource,
        run() {
          const report = runScenario({seed, frames, width, height, resync: false, durations: 'dyadic', built})
          const errors: Record<string, number> = {}
          for (const [kind, stat] of Object.entries(report.errors)) errors[`error ${kind}`] = stat.maximumAbsolute
          return {frames: report.frames, decisionChecks: report.decisionChecks, decisionMismatches: report.decisionMismatches, animatingFrames: report.animatingFrames, ...errors}
        },
      }
    },
  }
}

// ----- hn-thread: the scripted session -----

const hnPrepared = new Map<number, {prepared: PreparedThread, built: BuiltThreadCircuit}>()

function hnThread(commentCount: number) {
  let entry = hnPrepared.get(commentCount)
  if (entry === undefined) {
    installFakeCanvas()
    const prepared = prepareThread(thread.comments.slice(0, commentCount))
    const built = buildThreadCircuit(
      {tables: prepared.tables, staircases: prepared.staircases},
      {slotCount: commentCount >= 251 ? 48 : 16, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'},
    )
    entry = {prepared, built}
    hnPrepared.set(commentCount, entry)
  }
  return entry
}

export function hnThreadWorkload(commentCount: number, frames: number): Workload {
  return {
    name: `hn-thread ${commentCount} comments`,
    description: `hn-thread's scripted session over ${commentCount} comments, ${frames} frames: scroll, hold a gutter, collapse and expand, resize, scroll past the end`,
    create() {
      const {prepared, built} = hnThread(commentCount)
      const {layout, rowCount} = built
      const range = (start: number) => Array.from({length: rowCount}, (_, row) => start + row)
      const stateCells = [
        layout.cell.scrollTopPrevious, layout.cell.scrollDeltaPrevious, layout.cell.scrollerPeekUp, layout.cell.containerWidthPrevious,
        ...range(layout.collapsed), ...range(layout.restHeights), ...range(layout.heights), ...range(layout.restTargetsPrevious),
      ]
      return {
        circuit: built.circuit,
        drift: [{name: 'thread outputs', wires: built.roots}],
        settle: [{name: 'schedule next render', wires: [built.roots[built.globalOffset.scheduleNextRender]!]}],
        nextSource: stateCells.map((cell, index) => [cell, built.roots[built.stateOffset + index]!] as const),
        run() {
          const summary = runScenarioDifferential(prepared, built, frames)
          return {
            frames: summary.frames,
            decisions: summary.comparison.decisions,
            decisionMismatches: summary.comparison.decisionMismatches.length,
            tieMismatches: summary.comparison.tieMismatches.length,
            positionMismatches: summary.comparison.positionMismatches.length,
            maximumDriftAgainstReference: summary.comparison.maxDrift,
            tieFrames: summary.tieFrames,
            collapsedFrames: summary.collapsedFrames,
          }
        },
      }
    },
  }
}

// ----- lists: draggable cards with random pointer traces -----

const cardsBuilt = new Map<number, CardsCircuit>()

export function cardsWorkload(seed: number, cardCount: number, frames: number): Workload {
  return {
    name: `cards seed ${seed}, ${cardCount} cards`,
    description: `lists' draggable cards, incremental layout, seed ${seed}, ${cardCount} cards, ${frames} frames of random pointer input`,
    create() {
      let built = cardsBuilt.get(cardCount)
      if (built === undefined) {
        built = buildCards(demoCardSizes(cardCount), {layout: 'incremental'})
        cardsBuilt.set(cardCount, built)
      }
      const cards: CardsCircuit = built
      const stillAnimating: Wire = cards.roots[cards.roots.length - 2]!
      return {
        circuit: cards.circuit,
        drift: [{name: 'card x and y', wires: [...cards.outputs.x, ...cards.outputs.y]}],
        settle: [{name: 'still animating', wires: [stillAnimating]}],
        nextSource: cards.nextSource,
        run() {
          const result = runCardsDifferential(seed, cardCount, frames, cards)
          return {
            frames: result.frames,
            decisionMismatchFrames: result.decisionMismatchFrames,
            animatingMismatchFrames: result.animatingMismatchFrames,
            maximumPositionError: result.maximumPositionError,
            maximumPositionErrorBeforeAnimatingMismatch: result.maximumPositionErrorBeforeAnimatingMismatch,
            cardReleases: result.cardReleases,
            reorderFrames: result.reorderFrames,
          }
        },
      }
    },
  }
}

// The name of a cards source cell, e.g. 'card 7 xPos', once cardsWorkload(_, cardCount, _).create() has built the circuit.
export function cardsSourceCellName(cardCount: number, cell: number): string {
  const built = cardsBuilt.get(cardCount)
  if (built === undefined) return `cell ${cell}`
  for (const [c, card] of built.cells.cards.entries()) {
    for (const [field, wire] of Object.entries(card)) if (wire === cell) return `card ${c} ${field}`
  }
  for (const [name, value] of Object.entries(built.cells)) if (value === cell) return name
  return `cell ${cell}`
}

// ----- text-editing: the typing session from its report -----

const editorBuilds = new Map<number, EditorBuild>()

export function typingConfig(capacity: number): EditorConfig {
  return {capacity, lineSlots: 12, pasteLimit: 8, codeLimit: 96, keysPerFrame: 4, layoutSlots: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky'}
}

export function typingWorkload(capacity: number, frames: number): Workload {
  const config = typingConfig(capacity)
  return {
    name: `text-editing capacity ${capacity}`,
    description: `text-editing's typing session: a paragraph typed with random edits, fake canvas widths, capacity ${capacity}, 12 line slots, 4 keys per evaluation with 1 layout slot, 320 px field, ${frames} frames`,
    create() {
      let build = editorBuilds.get(capacity)
      if (build === undefined) {
        build = buildEditorCircuit(config)
        editorBuilds.set(capacity, build)
      }
      const editor: EditorBuild = build
      return {
        circuit: editor.circuit,
        drift: [],
        settle: [],
        run() {
          const unitsPerPixel = 4
          const widthTable = createWidthTable(config.codeLimit, unitsPerPixel, grapheme => fakeTextWidth(grapheme, '16px Test Sans'))
          const paragraph = 'The quick brown fox jumps over the lazy dog, while seven wizards quietly hex every jolly gnome.\nPack my box with five dozen liquor jugs! Sphinx of black quartz: judge my vow. Supercalifragilisticexpialidocious words break inside.'
          const paragraphCodes = encodeText(widthTable, paragraph)
          const machine = createEditorMachine(config, editor)
          const geometry = {maxWidth: 320 * unitsPerPixel, lineHeight: 20 * unitsPerPixel}
          machine.setGeometry(geometry.maxWidth, geometry.lineHeight)
          const random = createEditorRandom(99)
          const {codes: randomCodes} = testTable(12)
          const resetLength = Math.floor(capacity * 200 / 256)
          let state = emptyState(config)
          let checked = 0
          let mismatches = 0
          let outOfContract = 0
          let typedIndex = 0
          let keys = 0
          const queue: EditorEvent[] = []
          for (let frame = 0; frame < frames; frame++) {
            for (let burst = Math.floor(random() * 5); burst > 0; burst--) {
              const roll = random()
              if (typedIndex < paragraphCodes.length && roll < 0.7) {
                queue.push(event('insert', {codes: [paragraphCodes[typedIndex++]!]}))
              } else if (roll < 0.95) {
                const input = randomEvent(random, config, randomCodes, geometry)
                queue.push(input.kind === 'insert' ? event('insert', {codes: input.codes.map(code => paragraphCodes[code % paragraphCodes.length]!)}) : input)
              } else if (state.length > resetLength) {
                queue.push(event('selectAll'), event('delete'))
                typedIndex = 0
              }
            }
            const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
            widthTable.packed.forEach((packed, code) => machine.setTableEntry(code, packed))
            const expected = referenceFrame(config, widthTable.packed, geometry, state, events)
            if (expected.maximumLineCount > config.lineSlots) {
              outOfContract++
              state = emptyState(config)
              machine.load(state)
              typedIndex = 0
              queue.length = 0
              continue
            }
            const actual = machine.runFrame(events)
            checked++
            keys += events.length
            const {overflowCount: _, ...display} = actual.display
            const trimmed = {...display, glyphLine: display.glyphLine.slice(0, expected.state.length), glyphX: display.glyphX.slice(0, expected.state.length)}
            if (JSON.stringify(actual.state) !== JSON.stringify(expected.state) || JSON.stringify(trimmed) !== JSON.stringify(expected.display)) {
              mismatches++
              machine.load(expected.state)
            }
            state = expected.state
          }
          return {framesChecked: checked, keys, mismatches, outOfContract}
        },
      }
    },
  }
}

// ----- numeric-library: the dock and progress ring, with boundary values -----

const dockRing = lazy(() => {
  const {circuit, output} = createWorkloadCircuit()
  return {circuit, output, roots: workloadRoots(output)}
})

export function dockRingWorkload(trials: number): Workload {
  return {
    name: 'numeric-library dock and ring',
    description: `numeric-library's dock and progress ring: ${trials} random sources (a third within 3 FP32 steps of a tick boundary k/24, a third near a percent boundary k/100), then every boundary value k/24 and k/100 ± 3 FP32 steps`,
    create() {
      const {circuit, output, roots} = dockRing()
      return {
        circuit,
        drift: [
          {name: 'dock icons', wires: [...output.iconLeft, ...output.iconTop, ...output.iconSize]},
          {name: 'ring head and ticks', wires: [output.headX, output.headY, ...output.tickX, ...output.tickY]},
        ],
        settle: [],
        run() {
          const f = Math.fround
          const runWorkload = circuit.createTensorEvaluator(roots)
          const nearestStart = 3 * iconCount
          const headStart = 4 * iconCount
          const tickStart = headStart + 2
          const litStart = tickStart + 2 * tickCount
          const percentIndex = roots.length - 1
          const random = createNumericRandom(5)
          let worstPosition = 0
          let litMismatches = 0
          let percentMismatches = 0
          let nearestChecked = 0
          let nearestMismatches = 0
          for (let trial = 0; trial < trials; trial++) {
            const source = randomWorkloadSource(random, trial)
            const values = runWorkload(source)
            const reference = referenceWorkload(source)
            const positions = [...reference.iconLeft, ...reference.iconTop, ...reference.iconSize]
            for (let index = 0; index < positions.length; index++) worstPosition = Math.max(worstPosition, Math.abs(values[index]! - positions[index]!))
            worstPosition = Math.max(worstPosition, Math.abs(values[headStart]! - reference.headX), Math.abs(values[headStart + 1]! - reference.headY))
            for (let tick = 0; tick < tickCount; tick++) {
              worstPosition = Math.max(worstPosition, Math.abs(values[tickStart + tick]! - reference.tickX[tick]!), Math.abs(values[tickStart + tickCount + tick]! - reference.tickY[tick]!))
              if (values[litStart + tick] !== reference.tickLit[tick]) litMismatches++
            }
            if (values[percentIndex] !== reference.percent) percentMismatches++
            const sorted = [...reference.distances].sort((left, right) => left - right)
            if (sorted[1]! - sorted[0]! > 1e-3) {
              nearestChecked++
              for (let icon = 0; icon < iconCount; icon++) {
                if (values[nearestStart + icon] !== reference.nearestIcon[icon]) {
                  nearestMismatches++
                  break
                }
              }
            }
          }
          const boundarySource = Float32Array.from(randomWorkloadSource(createNumericRandom(8), 1))
          let boundaryValues = 0
          let boundaryMismatches = 0
          for (const denominator of [100, tickCount]) {
            for (let boundary = 0; boundary <= denominator; boundary++) {
              for (let step = -3; step <= 3; step++) {
                const progress = Math.min(1, Math.max(0, stepFloat32(f(boundary / denominator), step)))
                boundarySource[workloadField.progress] = progress
                const values = runWorkload(boundarySource)
                if (denominator === 100) {
                  boundaryValues++
                  if (values[percentIndex] !== Math.floor(progress * 100)) boundaryMismatches++
                } else if (boundary < tickCount) {
                  boundaryValues++
                  if (values[litStart + boundary] !== Number(progress >= boundary / tickCount)) boundaryMismatches++
                }
              }
            }
          }
          return {trials, litMismatches, percentMismatches, nearestChecked, nearestMismatches, worstPositionAgainstFloat64: worstPosition, boundaryValues, boundaryMismatches}
        },
      }
    },
  }
}
