// The demo page's logic without the DOM: building a pixel program for a variant,
// scroll clamping, the CPU fallback's drawing, and a glyph atlas from canvas coverage.
// demo.ts only wires events, the canvas and WebGPU.
import type {HNThread} from '../hn-thread/hn-data.ts'
import {createPixelMachine, pixelCenters, type GlyphTextOptions, type PixelMachine} from './pixel-machine.ts'
import {paintTables, pixelOutputField, type MeasureText} from './pixel-model.ts'
import type {RowLookup} from './pixel-circuit.ts'
import {atlasFromJson, layoutTextTables, textCapacity, type GlyphAtlas, type GlyphAtlasJson} from './text-table.ts'
import type {FrameInputs} from './thread-frame.ts'
import {initialThreadState, prepareThread} from './thread-prepare.ts'
import {emitInstanceWgsl, packSharedBuffer, type WgslModule} from './wgsl.ts'

export type DemoVariant = 'binary-search-glyphs' | 'binary-search-bars' | 'count-bars'

export const demoVariants: {name: DemoVariant, title: string, rowLookup: RowLookup, text: 'bars' | 'glyphs'}[] = [
  {name: 'binary-search-glyphs', title: 'index reads, glyph text', rowLookup: 'binary-search', text: 'glyphs'},
  {name: 'binary-search-bars', title: 'index reads, gray bars', rowLookup: 'binary-search', text: 'bars'},
  {name: 'count-bars', title: 'row counts and gathers, gray bars (large shader)', rowLookup: 'count', text: 'bars'},
]

export type DemoModel = {
  variant: DemoVariant
  machine: PixelMachine
  atlas: GlyphAtlas
  fragment: WgslModule
  setupMilliseconds: number
  // Runs the thread logic for these inputs; returns the shared buffer the fragment shader reads.
  frame(inputs: FrameInputs, devicePixelRatio: number): Float32Array
  // Writes this frame's next state into the source table and clears the click latch.
  commit(): void
  // The CPU fallback: every `stride`-th CSS pixel into RGBA bytes of a (width / stride) × (height / stride) image.
  drawCpu(width: number, height: number, stride: number, pixels: Uint8ClampedArray): number
  maximumScrollTop(): number
}

// A glyph atlas from per-character coverage: ink where coverage is at least half.
export function atlasFromCoverage(characters: readonly string[], cellWidth: number, cellHeight: number, coverage: (character: string) => Uint8ClampedArray | Uint8Array): GlyphAtlasJson {
  const glyphs: Record<string, string[]> = {}
  for (const character of characters) {
    const alpha = coverage(character)
    glyphs[character] = Array.from({length: cellHeight}, (_, row) =>
      Array.from({length: cellWidth}, (_, column) => alpha[row * cellWidth + column]! >= 128 ? '1' : '0').join(''))
  }
  return {cellWidth, cellHeight, glyphs}
}

export function createDemoModel(thread: HNThread, variant: DemoVariant, measure: MeasureText, atlasJson: GlyphAtlasJson, windowWidth: number): DemoModel {
  const start = performance.now()
  const entry = demoVariants.find(candidate => candidate.name === variant)!
  const prepared = prepareThread(thread.comments)
  const paint = paintTables(thread, prepared.tables, measure)
  const atlas = atlasFromJson(atlasJson)
  const glyphText: GlyphTextOptions | undefined = entry.text === 'glyphs'
    ? {atlas, capacity: textCapacity(prepared, atlas, measure), layout: containerWidth => layoutTextTables(prepared, containerWidth, atlas, measure)}
    : undefined
  const machine = createPixelMachine(prepared, paint, {rowLookup: entry.rowLookup, text: entry.text}, initialThreadState(prepared, windowWidth), glyphText)
  const fragment = emitInstanceWgsl(machine.plan, {guard: 'max', stage: 'fragment'})
  const shared = new Float32Array(fragment.sharedLength)
  let centers = new Float32Array(0)
  let outputs = new Float32Array(0)
  let centersKey = ''
  return {
    variant,
    machine,
    atlas,
    fragment,
    setupMilliseconds: performance.now() - start,
    frame(inputs, devicePixelRatio) {
      machine.setInputs(inputs)
      machine.runShared()
      packSharedBuffer(fragment, machine.runner, shared)
      shared[fragment.pixelScaleOffset] = 1 / devicePixelRatio
      return shared
    },
    commit() {
      machine.commit()
    },
    drawCpu(width, height, stride, pixels) {
      const columns = Math.floor(width / stride)
      const rows = Math.floor(height / stride)
      const key = `${columns}×${rows}×${stride}`
      if (key !== centersKey) {
        centers = pixelCenters(columns, rows, stride, stride / 2)
        outputs = new Float32Array(columns * rows * pixelOutputField.size)
        centersKey = key
      }
      const drawStart = performance.now()
      machine.runner.runInstances(centers, columns * rows, outputs)
      for (let pixel = 0; pixel < columns * rows; pixel++) {
        pixels[pixel * 4] = outputs[pixel * pixelOutputField.size + pixelOutputField.red]!
        pixels[pixel * 4 + 1] = outputs[pixel * pixelOutputField.size + pixelOutputField.green]!
        pixels[pixel * 4 + 2] = outputs[pixel * pixelOutputField.size + pixelOutputField.blue]!
        pixels[pixel * 4 + 3] = 255
      }
      return performance.now() - drawStart
    },
    maximumScrollTop() {
      return Math.max(0, machine.global('placeholderHeight') - machine.global('scrollerHeight'))
    },
  }
}
