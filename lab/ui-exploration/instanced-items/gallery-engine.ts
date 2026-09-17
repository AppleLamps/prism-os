// One read and write surface over every way this folder runs the gallery: the
// original duplicated circuit (gallery-circuit.ts), the staged program through
// the staged executor, the staged program's own duplicated circuit, and a tee
// that steps two engines from the same cells and compares every output.
import type {Wire} from '../../../src/runtime/numeric-ui-core.ts'
import type {DuplicatedMachine} from './expand.ts'
import type {StagedExecutor} from './executor.ts'
import {springNames, type GalleryCircuit, type SpringName} from './gallery-circuit.ts'
import {
  photoOutputNames,
  sharedCellNames,
  sharedOutputNames,
  springFields,
  type PhotoOutputName,
  type SharedCellName,
  type SharedOutputName,
  type SpringField,
  type StagedGallery,
} from './gallery-staged.ts'

export type GalleryEngine = {
  count: number
  // Evaluate, write next values back, clear the event latches.
  step(): void
  setCell(name: SharedCellName, value: number): void
  getCell(name: SharedCellName): number
  output(name: SharedOutputName): number
  photo(name: PhotoOutputName, index: number): number
  setSpring(index: number, spring: SpringName, field: SpringField, value: number): void
  getSpring(index: number, spring: SpringName, field: SpringField): number
}

export const latchNames: readonly SharedCellName[] = ['keyEscape', 'keyArrowLeft', 'keyArrowRight', 'clickActive', 'clickOnPrompt', 'moveActive']

export function createOriginalEngine(built: GalleryCircuit): GalleryEngine {
  const {circuit, roots, nextSource, cells, outputs} = built
  const evaluate = circuit.createTensorEvaluator(roots)
  const positions = new Map<Wire, number>()
  roots.forEach((wire, index) => positions.set(wire, index))
  const writeBack = nextSource.map(([cell, wire]) => [cell, positions.get(wire)!] as const)
  const source = new Float32Array(built.layout.size)
  let values: Float32Array = new Float32Array(roots.length)
  const read = (wire: Wire) => {
    const position = positions.get(wire)
    if (position === undefined) throw new Error(`wire ${wire} is not an output`)
    return values[position]!
  }
  const photoWire = (name: PhotoOutputName, index: number): Wire => {
    const photo = outputs.photos[index]!
    switch (name) {
      case 'visible': case 'focused': case 'blurred': case 'destX': case 'destY': case 'destSizeX': case 'destSizeY': return photo[name]
      default: return photo.springs[name]
    }
  }
  const outputWire = (name: SharedOutputName): Wire => outputs[name]
  return {
    count: outputs.photos.length,
    step() {
      values = evaluate(source)
      for (const [cell, index] of writeBack) source[cell] = values[index]!
      for (const name of latchNames) source[cells[name]] = 0
    },
    setCell: (name, value) => {
      source[cells[name]] = value
    },
    getCell: name => source[cells[name]]!,
    output: name => read(outputWire(name)),
    photo: (name, index) => read(photoWire(name, index)),
    setSpring: (index, spring, field, value) => {
      source[cells.photos[index]!.springs[spring][field]] = value
    },
    getSpring: (index, spring, field) => source[cells.photos[index]!.springs[spring][field]]!,
  }
}

export function createStagedEngine(gallery: StagedGallery, executor: StagedExecutor): GalleryEngine {
  const {cells, state, sharedOutputs, photoOutputs} = gallery
  const latchSlots = latchNames.map(name => executor.slot(cells[name]))
  const photoColumns = Object.fromEntries(photoOutputNames.map(name => [name, executor.column(photoOutputs[name])])) as Record<PhotoOutputName, Float32Array>
  const springColumns = Object.fromEntries(springNames.map(name => [name, Object.fromEntries(springFields.map(field => [field, executor.column(state[name][field])]))])) as Record<SpringName, Record<SpringField, Float32Array>>
  const cellSlots = Object.fromEntries(sharedCellNames.map(name => [name, executor.slot(cells[name])])) as Record<SharedCellName, number>
  const outputSlots = Object.fromEntries(sharedOutputNames.map(name => [name, executor.slot(sharedOutputs[name])])) as Record<SharedOutputName, number>
  const {shared} = executor
  return {
    count: gallery.count,
    step() {
      executor.step()
      for (const slot of latchSlots) shared[slot] = 0
    },
    setCell: (name, value) => {
      shared[cellSlots[name]] = value
    },
    getCell: name => shared[cellSlots[name]]!,
    output: name => shared[outputSlots[name]]!,
    photo: (name, index) => photoColumns[name][index]!,
    setSpring: (index, spring, field, value) => {
      springColumns[spring][field][index] = value
    },
    getSpring: (index, spring, field) => springColumns[spring][field][index]!,
  }
}

export function createDuplicatedEngine(gallery: StagedGallery, machine: DuplicatedMachine): GalleryEngine {
  const {cells, state, sharedOutputs, photoOutputs} = gallery
  const {source} = machine
  const latchWires = latchNames.map(name => machine.cellWire(cells[name].id))
  return {
    count: gallery.count,
    step() {
      machine.step()
      for (const wire of latchWires) source[wire] = 0
    },
    setCell: (name, value) => {
      source[machine.cellWire(cells[name].id)] = value
    },
    getCell: name => source[machine.cellWire(cells[name].id)]!,
    output: name => machine.read(sharedOutputs[name].id),
    photo: (name, index) => machine.read(photoOutputs[name].id, index),
    setSpring: (index, spring, field, value) => {
      source[machine.cellWire(state[spring][field].id, index)] = value
    },
    getSpring: (index, spring, field) => source[machine.cellWire(state[spring][field].id, index)]!,
  }
}

// Outputs whose values are bits or integers. The tee checks them for identity
// separately, because they're decisions.
export const decisionOutputs = new Set<string>([
  'newFocusedIndex', 'newFocusedPresent', 'focusChanged', 'scrollChanged', 'cursorZoomIn', 'cursorZoomOut',
  'stillAnimating', 'selectPrompt', 'columns', 'steps', 'visible', 'focused', 'blurred',
  'cell anchor', 'cell animating', 'cell pointerPresent',
])

export type OutputComparison = {compared: number, identical: number, maximumDifference: number, worst: string}

export type TeeStats = {
  frames: number
  byOutput: Map<string, OutputComparison>
  decisionMismatches: number
  firstDecisionMismatches: string[]
}

export function createTeeStats(): TeeStats {
  return {frames: 0, byOutput: new Map(), decisionMismatches: 0, firstDecisionMismatches: []}
}

export function summarizeTee(stats: TeeStats) {
  let compared = 0
  let identical = 0
  const outputs: Record<string, OutputComparison> = {}
  for (const [name, entry] of [...stats.byOutput].sort(([left], [right]) => left.localeCompare(right))) {
    compared += entry.compared
    identical += entry.identical
    outputs[name] = entry
  }
  return {frames: stats.frames, compared, identical, decisionMismatches: stats.decisionMismatches, firstDecisionMismatches: stats.firstDecisionMismatches, outputs}
}

// Steps the secondary engine from the primary's cells every frame, so each
// frame compares one evaluation from identical state. The host reads the primary.
export function createTeeEngine(primary: GalleryEngine, secondary: GalleryEngine, stats: TeeStats, copiedCells: readonly SharedCellName[] = sharedCellNames): GalleryEngine {
  const count = primary.count
  const record = (name: string, expected: number, actual: number, context: string) => {
    let entry = stats.byOutput.get(name)
    if (entry === undefined) {
      entry = {compared: 0, identical: 0, maximumDifference: 0, worst: ''}
      stats.byOutput.set(name, entry)
    }
    entry.compared++
    if (expected === actual) {
      entry.identical++
      return
    }
    const difference = Math.abs(expected - actual)
    if (!(difference <= entry.maximumDifference)) {
      entry.maximumDifference = Number.isNaN(difference) ? Infinity : difference
      entry.worst = `frame ${stats.frames} ${context}: primary ${expected}, secondary ${actual}`
    }
    if (decisionOutputs.has(name)) {
      stats.decisionMismatches++
      if (stats.firstDecisionMismatches.length < 10) stats.firstDecisionMismatches.push(`frame ${stats.frames} ${name} ${context}: primary ${expected}, secondary ${actual}`)
    }
  }
  return {
    count,
    step() {
      for (const name of copiedCells) secondary.setCell(name, primary.getCell(name))
      for (let index = 0; index < count; index++) {
        for (const spring of springNames) {
          for (const field of springFields) secondary.setSpring(index, spring, field, primary.getSpring(index, spring, field))
        }
      }
      primary.step()
      secondary.step()
      for (const name of sharedOutputNames) record(name, primary.output(name), secondary.output(name), '')
      for (const name of ['pointerX', 'pointerY', 'pointerPresent', 'anchor', 'committedScrollY', 'leftoverMilliseconds', 'animating'] as const) {
        record(`cell ${name}`, primary.getCell(name), secondary.getCell(name), '')
      }
      for (let index = 0; index < count; index++) {
        for (const name of photoOutputNames) record(name, primary.photo(name, index), secondary.photo(name, index), `photo ${index}`)
        for (const spring of springNames) {
          for (const field of springFields) record(`${spring}.${field}`, primary.getSpring(index, spring, field), secondary.getSpring(index, spring, field), `photo ${index}`)
        }
      }
      stats.frames++
    },
    setCell: (name, value) => primary.setCell(name, value),
    getCell: name => primary.getCell(name),
    output: name => primary.output(name),
    photo: (name, index) => primary.photo(name, index),
    setSpring: (index, spring, field, value) => primary.setSpring(index, spring, field, value),
    getSpring: (index, spring, field) => primary.getSpring(index, spring, field),
  }
}
