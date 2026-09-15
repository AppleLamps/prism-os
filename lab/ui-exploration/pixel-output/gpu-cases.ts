// GPU cases, exported from Bun and compared in Bun. The GPU runs in Deno (wgpu) or
// Node (Dawn) through gpu-headless.ts, which only loads files, so it never imports
// pretext or the circuit builder.
//
//   bun lab/ui-exploration/pixel-output/report.ts gpu-export <directory>
//   deno run --unstable-webgpu --allow-all lab/ui-exploration/pixel-output/gpu-headless.ts <directory>
//   DAWN_WEBGPU=<path to webgpu/index.js> node lab/ui-exploration/pixel-output/gpu-headless.ts <directory>
//   bun lab/ui-exploration/pixel-output/report.ts gpu-compare <directory>
import {mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {containerWidthF, pointerOnCode, referenceFrame, type FrameInputs, type ThreadFrame, type ThreadState} from './thread-frame.ts'
import {initialThreadState, type PreparedThread} from './thread-prepare.ts'
import {randomState, seededRandom, targetedInputs} from './differential.ts'
import {createPixelMachine, pixelCenters, type GlyphTextOptions, type PixelMachine} from './pixel-machine.ts'
import {pixelOutputField, type PaintTables, type TextMode} from './pixel-model.ts'
import type {RowLookup} from './pixel-circuit.ts'
import {emitInstanceWgsl, packSharedBuffer} from './wgsl.ts'
import {compareRaster, countEmphasisSamples, geometryFromReference, rasterize, topsSorted} from './pixel-reference.ts'
import {compareOutputs} from './gpu-runner.ts'
import {threadLayout} from './thread-model.ts'
import {encodePng} from './png.ts'

export const gpuGrid = {width: 1280, height: 800, stride: 1, offset: 0.5} as const

export type GpuState = {name: string, state: ThreadState, inputs: FrameInputs}

// How many px of the emphasized banner and of the emphasized gutter lie inside the window, from a reference frame.
// Banners are clipped to the scroller; gutters are drawn above everything, down to the container's bottom edge.
export function emphasisOnScreen(frame: ThreadFrame, windowHeight: number) {
  const global = frame.global
  const scrollerPageTop = threadLayout.currentContainerTop + global.scrollerTop
  const viewTop = Math.max(scrollerPageTop, 0)
  const bannerViewBottom = Math.min(scrollerPageTop + global.scrollerHeight, windowHeight)
  const gutterViewBottom = Math.min(threadLayout.currentContainerTop + global.containerHeight, windowHeight)
  let bannerPixels = 0
  let gutterPixels = 0
  for (const row of frame.rows) {
    if (row.emphasis === 1) {
      const top = scrollerPageTop + row.userTop
      bannerPixels = Math.max(bannerPixels, Math.min(top + row.userHeight, bannerViewBottom) - Math.max(top, viewTop))
    }
    if (row.gutterEmphasis === 1 && row.gutterVisible === 1) {
      gutterPixels = Math.max(gutterPixels, Math.min(scrollerPageTop + row.gutterBottom, gutterViewBottom) - Math.max(scrollerPageTop + row.gutterTop, viewTop))
    }
  }
  return {bannerPixels, gutterPixels}
}

// Two states with emphasis in the window, so the GPU comparison covers emphasis decisions:
// - a settled thread at scrollTop 800 with the pointer over the level-2 gutter column of comment 10 (indent 3), which
//   hovers comment 9's gutter (indent 2);
// - the first random animated state (by seed) that presses a gutter at level 1 or deeper, keeps every row height
//   nonnegative (so row tops are sorted), and has the pressed comment's banner and gutter in the window.
export function gpuStates(prepared: PreparedThread): GpuState[] {
  const settled: GpuState = {
    name: 'settled-hover-level-2',
    state: initialThreadState(prepared, 1280),
    // The container is 1200px wide at x = 40, so x = 98.5 is 10.5px into the level-2 column.
    inputs: {windowWidth: 1280, windowHeight: 800, scrollTopReal: 800, pointerX: 40 + 2 * threadLayout.indentWidth + 10.5, pointerY: 198.25, pointerDown: 0, click: 0},
  }
  const {frame: settledFrame} = referenceFrame(prepared, settled.state, settled.inputs, 0, 'none')
  if (settledFrame.global.pointerOn !== pointerOnCode.gutter || prepared.tables.indents[settledFrame.global.ancestor] !== 2 || emphasisOnScreen(settledFrame, 800).gutterPixels < 100) {
    throw new Error('the settled GPU state no longer hovers a level-2 gutter with at least 100px in the window')
  }
  for (let seed = 1; seed < 10_000; seed++) {
    const random = seededRandom(seed)
    const state = randomState(prepared, random, 1280)
    state.containerWidthPrevious = containerWidthF(1280)
    // A comment at indent 2 or deeper that is expanded and visible, so its gutter can be pressed.
    const candidates = prepared.tables.indents.flatMap((indent, row) =>
      indent >= 2 && state.collapsed[row] === 0 && prepared.tables.ancestors[row]!.every(ancestor => state.collapsed[ancestor] === 0) ? [row] : [])
    const row = candidates[Math.floor(random() * candidates.length)]
    if (row === undefined) continue
    const inputs = targetedInputs(prepared, random, state, row, 'gutter', 1280, 800)
    const {frame} = referenceFrame(prepared, state, inputs, 0, 'none')
    if (frame.global.peeking !== 1 || !topsSorted(geometryFromReference(frame))) continue
    const seen = emphasisOnScreen(frame, inputs.windowHeight)
    if (prepared.tables.indents[frame.global.ancestor]! < 1 || seen.bannerPixels < 12 || seen.gutterPixels < 24) continue
    return [settled, {name: `animated-peek-seed-${seed}`, state, inputs}]
  }
  throw new Error('no seed below 10,000 gives a sorted, peeking frame with emphasis in the window')
}

export const gpuGuards = ['none', 'max'] as const

// Bars run both lookups; glyph text needs the binary search.
export function gpuLookups(text: TextMode): readonly RowLookup[] {
  return text === 'bars' ? ['count', 'binary-search'] : ['binary-search']
}

export type GpuCaseMeta = {
  lookup: RowLookup
  text: TextMode
  count: number
  width: number
  height: number
  workgroupSize: number
  sharedLength: number
  instanceSourceCount: number
  outputCount: number
  states: string[]
  shaders: {guard: typeof gpuGuards[number], file: string, statements: number, bytes: number, guards: number}[]
}

export function exportGpuCases(directory: string, prepared: PreparedThread, paint: PaintTables, text: TextMode = 'bars', glyphText?: GlyphTextOptions) {
  const states = gpuStates(prepared)
  const count = gpuGrid.width * gpuGrid.height
  const cases: string[] = []
  for (const lookup of gpuLookups(text)) {
    const caseDirectory = join(directory, `${lookup}-${text}`)
    mkdirSync(caseDirectory, {recursive: true})
    const machine = createPixelMachine(prepared, paint, {rowLookup: lookup, text}, states[0]!.state, glyphText)
    const modules = gpuGuards.map(guard => ({guard, module: emitInstanceWgsl(machine.plan, {guard})}))
    const meta: GpuCaseMeta = {
      lookup,
      text,
      count,
      width: gpuGrid.width,
      height: gpuGrid.height,
      workgroupSize: modules[0]!.module.workgroupSize,
      sharedLength: modules[0]!.module.sharedLength,
      instanceSourceCount: 2,
      outputCount: pixelOutputField.size,
      states: states.map(state => state.name),
      shaders: modules.map(({guard, module}) => ({guard, file: `shader-${guard}.wgsl`, statements: module.statementCount, bytes: module.code.length, guards: module.exposure.guards})),
    }
    for (const {guard, module} of modules) writeFileSync(join(caseDirectory, `shader-${guard}.wgsl`), module.code)
    for (const {name, state, inputs} of states) {
      machine.setState(state)
      machine.setInputs(inputs)
      machine.runShared()
      const shared = packSharedBuffer(modules[1]!.module, machine.runner)
      writeFileSync(join(caseDirectory, `shared-${name}.f32`), new Uint8Array(shared.buffer))
    }
    writeFileSync(join(caseDirectory, 'meta.json'), JSON.stringify(meta, null, 2))
    cases.push(caseDirectory)
  }
  return cases
}

export type GpuComparisonRow = {
  runtime: string
  lookup: RowLookup
  text: TextMode
  guard: string
  state: string
  outputsCompared: number
  gpuCpuMismatches: number
  largestGpuCpuDifference: number
  referenceDecisionMismatches: number
  referenceAmbiguousSamples: number
  largestReferenceColorDifference: number
  // Emphasized samples in these outputs: on a banner or its label, and on a gutter.
  bannerEmphasisSamples: number
  gutterEmphasisSamples: number
  gpuMilliseconds: number | null
  gpuDispatchOnlyMilliseconds: number | null
  cpuMilliseconds: number
}

// Runs the CPU instance loop at full resolution, and compares every GPU output file found with it and with the rasterizer.
export function compareGpuCases(directory: string, prepared: PreparedThread, paint: PaintTables, text: TextMode = 'bars', glyphText?: GlyphTextOptions): GpuComparisonRow[] {
  const states = gpuStates(prepared)
  const count = gpuGrid.width * gpuGrid.height
  const centers = pixelCenters(gpuGrid.width, gpuGrid.height, gpuGrid.stride, gpuGrid.offset)
  const rows: GpuComparisonRow[] = []
  for (const lookup of gpuLookups(text)) {
    const caseDirectory = join(directory, `${lookup}-${text}`)
    if (!existsSync(caseDirectory)) continue
    const machine: PixelMachine = createPixelMachine(prepared, paint, {rowLookup: lookup, text}, states[0]!.state, glyphText)
    const timings = readdirSync(caseDirectory).filter(file => file.startsWith('gpu-') && file.endsWith('.json'))
    for (const {name, state, inputs} of states) {
      machine.setState(state)
      machine.setInputs(inputs)
      const cpu = new Float32Array(count * pixelOutputField.size)
      machine.draw(centers, count, cpu)
      const cpuTimes: number[] = []
      for (let repeat = 0; repeat < 3; repeat++) {
        const start = performance.now()
        machine.draw(centers, count, cpu)
        cpuTimes.push(performance.now() - start)
      }
      const {frame} = referenceFrame(prepared, state, inputs, 0, 'none')
      // A comparison without emphasized samples would say nothing about hover and press emphasis.
      const cpuEmphasis = countEmphasisSamples(cpu, pixelOutputField.size)
      if (cpuEmphasis.gutter === 0 || (frame.global.peeking === 1 && cpuEmphasis.banner === 0)) {
        throw new Error(`${lookup} ${text}, ${name}: the CPU outputs have no emphasized samples, so the GPU comparison wouldn't cover emphasis`)
      }
      const textTables = machine.textTables()
      const glyphs = glyphText !== undefined && textTables !== null ? {tables: textTables, atlas: glyphText.atlas} : undefined
      const raster = rasterize(geometryFromReference(frame), prepared.tables, paint, text, gpuGrid, 0.05, glyphs)
      const reference = compareRaster(raster, cpu, pixelOutputField.size)
      const cpuMilliseconds = Number(cpuTimes.sort((a, b) => a - b)[1]!.toFixed(1))
      rows.push({
        runtime: 'cpu (generated JS instance loop)', lookup, text, guard: '-', state: name, outputsCompared: cpu.length, gpuCpuMismatches: 0, largestGpuCpuDifference: 0,
        referenceDecisionMismatches: reference.decisionMismatches, referenceAmbiguousSamples: reference.ambiguousSamples, largestReferenceColorDifference: reference.largestColorDifference,
        bannerEmphasisSamples: cpuEmphasis.banner, gutterEmphasisSamples: cpuEmphasis.gutter,
        gpuMilliseconds: null, gpuDispatchOnlyMilliseconds: null, cpuMilliseconds,
      })
      for (const timingFile of timings) {
        const timing = JSON.parse(readFileSync(join(caseDirectory, timingFile), 'utf8')) as {runtime: string, key: string, results: {guard?: string, state?: string, file?: string, milliseconds?: number, dispatchOnlyMilliseconds?: number}[]}
        for (const result of timing.results.filter(entry => entry.state === name && entry.file !== undefined)) {
          const bytes = readFileSync(join(caseDirectory, result.file!))
          const gpu = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
          const comparison = compareOutputs(gpu, cpu, cpu.length)
          const gpuReference = compareRaster(raster, gpu, pixelOutputField.size)
          const gpuEmphasis = countEmphasisSamples(gpu, pixelOutputField.size)
          rows.push({
            runtime: timing.runtime, lookup, text, guard: result.guard!, state: name, outputsCompared: cpu.length,
            gpuCpuMismatches: comparison.mismatches, largestGpuCpuDifference: comparison.maximumDifference,
            referenceDecisionMismatches: gpuReference.decisionMismatches, referenceAmbiguousSamples: gpuReference.ambiguousSamples, largestReferenceColorDifference: gpuReference.largestColorDifference,
            bannerEmphasisSamples: gpuEmphasis.banner, gutterEmphasisSamples: gpuEmphasis.gutter,
            gpuMilliseconds: result.milliseconds ?? null, gpuDispatchOnlyMilliseconds: result.dispatchOnlyMilliseconds ?? null, cpuMilliseconds,
          })
        }
      }
    }
  }
  return rows
}

// compileMilliseconds: the shader text carries a token unique to that run, so the system shader cache can't answer.
// warmCompileMilliseconds: the same text compiled a second time in the same process.
export function gpuCompileTimes(directory: string) {
  const rows: {caseName: string, runtime: string, guard: string, statements: number, compileMilliseconds: number, warmCompileMilliseconds: number | null}[] = []
  for (const caseName of readdirSync(directory)) {
    const caseDirectory = join(directory, caseName)
    if (!existsSync(join(caseDirectory, 'meta.json'))) continue
    for (const file of readdirSync(caseDirectory).filter(name => name.startsWith('gpu-') && name.endsWith('.json'))) {
      const timing = JSON.parse(readFileSync(join(caseDirectory, file), 'utf8')) as {runtime: string, results: {guard?: string, compileMilliseconds?: number, warmCompileMilliseconds?: number, statements?: number}[]}
      for (const result of timing.results) {
        if (result.compileMilliseconds === undefined) continue
        rows.push({caseName, runtime: timing.runtime, guard: result.guard!, statements: result.statements!, compileMilliseconds: result.compileMilliseconds, warmCompileMilliseconds: result.warmCompileMilliseconds ?? null})
      }
    }
  }
  return rows
}

// The GPU's glyph frame of the animated state, max guard, as a PNG. Returns null when that output file isn't there.
export function writeGpuFramePng(directory: string, prepared: PreparedThread, file: string) {
  const animated = gpuStates(prepared)[1]!
  const outputFile = join(directory, 'binary-search-glyphs', `gpu-wgpu-max-${animated.name}.f32`)
  if (!existsSync(outputFile)) return null
  const bytes = readFileSync(outputFile)
  const outputs = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const count = gpuGrid.width * gpuGrid.height
  const pixels = new Uint8ClampedArray(count * 4)
  for (let sample = 0; sample < count; sample++) {
    for (let channel = 0; channel < 3; channel++) pixels[sample * 4 + channel] = outputs[sample * pixelOutputField.size + channel]!
    pixels[sample * 4 + 3] = 255
  }
  writeFileSync(file, encodePng(gpuGrid.width, gpuGrid.height, pixels))
  return {file, state: animated.name, emphasis: countEmphasisSamples(outputs, pixelOutputField.size)}
}
