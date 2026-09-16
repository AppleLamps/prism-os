// Heavy measurements for the README. Run from the repo root:
//   bun lab/ui-exploration/pixel-output/report.ts                  counts, cpu, random, session, wgsl
//   bun lab/ui-exploration/pixel-output/report.ts counts           one section (random takes an optional frame count)
//   bun lab/ui-exploration/pixel-output/report.ts gpu-export <directory>
//   bun lab/ui-exploration/pixel-output/report.ts gpu-compare <directory>
// A run replaces only its sections' entries in results.json. CPU and GPU timings are rough: other agents share the machine.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {relative, resolve} from 'node:path'
import {installFakeCanvas, fakeTextWidth} from '../hn-thread/fake-canvas.ts'
import {thread} from '../hn-thread/hn-data.ts'
import {initialThreadState, type PreparedThread, prepareThread} from './thread-prepare.ts'
import {buildThreadCircuit, type BuiltThreadCircuit, type ThreadCircuitOptions} from './thread-circuit.ts'
import {referenceFrame, type ThreadFrame, type ThreadState} from './thread-frame.ts'
import {randomInputs, randomState, scenarioInputs, seededRandom} from './differential.ts'
import {buildPixelThread, createPixelMachine, pixelCenters, pixelCompileOptions, type GlyphTextOptions, type PixelMachine} from './pixel-machine.ts'
import {paintTables, pixelOutputField, type PaintTables, type TextMode} from './pixel-model.ts'
import type {RowLookup} from './pixel-circuit.ts'
import {compareRaster, countEmphasisSamples, geometryFromCheckValues, geometryFromReference, rasterize, topsSorted, type RasterComparison, type SampleGrid} from './pixel-reference.ts'
import {atlasFromJson, layoutTextTables, textCapacity, type GlyphAtlasJson} from './text-table.ts'
import {emitInstanceWgsl, packSharedBuffer} from './wgsl.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'
import {compareGpuCases, exportGpuCases, gpuCompileTimes, writeGpuFramePng} from './gpu-cases.ts'
import type {Wire} from '../index-read/numeric-ui-core.ts'

installFakeCanvas()

const [section, argument] = process.argv.slice(2)
const results: Record<string, unknown> = {}
const run = (name: string) => section === undefined ? !name.startsWith('gpu-') : section === name

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[values.length >> 1]!
}

function printTable(title: string, rows: readonly Record<string, unknown>[]) {
  console.log(`\n## ${title}`)
  if (rows.length === 0) return
  const columns = Object.keys(rows[0]!)
  console.log(`| ${columns.join(' | ')} |`)
  console.log(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${columns.map(column => String(row[column])).join(' | ')} |`)
}

const prepared: PreparedThread = prepareThread(thread.comments)
const paint: PaintTables = paintTables(thread, prepared.tables, fakeTextWidth)
const atlas = atlasFromJson(JSON.parse(readFileSync(new URL('./glyph-atlas.json', import.meta.url).pathname, 'utf8')) as GlyphAtlasJson)
const glyphText: GlyphTextOptions = {
  atlas,
  capacity: textCapacity(prepared, atlas, fakeTextWidth),
  layout: containerWidth => layoutTextTables(prepared, containerWidth, atlas, fakeTextWidth),
}

// The three pixel programs.
const variants: {rowLookup: RowLookup, text: TextMode}[] = [
  {rowLookup: 'count', text: 'bars'},
  {rowLookup: 'binary-search', text: 'bars'},
  {rowLookup: 'binary-search', text: 'glyphs'},
]
const variantName = (variant: {rowLookup: RowLookup, text: TextMode}) => `${variant.rowLookup}, ${variant.text}`
const createMachine = (variant: {rowLookup: RowLookup, text: TextMode}, state: ThreadState) =>
  createPixelMachine(prepared, paint, variant, state, variant.text === 'glyphs' ? glyphText : undefined)

// Live operations, stored weights and layers with the shared runtime's compile behavior, and per build section.
function programCounts(built: BuiltThreadCircuit, roots: readonly Wire[]) {
  const program = built.circuit.compileTensorProgram(roots, true, pixelCompileOptions)
  let storedWeights = 0
  let gatherReads = 0
  let indexReads = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    indexReads += layer.indexReads.length
  }
  const bySection = built.sections.map(entry => ({name: entry.name, liveOperations: 0, storedWeights: 0}))
  const sectionOf = (wire: Wire) => built.sections.findIndex(entry => wire >= entry.firstWire && wire < entry.endWire)
  let available = program.sourceSize
  for (const layer of program.layers) {
    const attribute = (outputRow: number, projectionRow: number, countOperation: boolean) => {
      const index = sectionOf(program.wireOrder[available + outputRow]!)
      if (index < 0) return
      if (countOperation) bySection[index]!.liveOperations++
      bySection[index]!.storedWeights += layer.rowOffsets[projectionRow + 1]! - layer.rowOffsets[projectionRow]!
    }
    for (let row = 0; row < layer.outputSize; row++) attribute(row, row, true)
    layer.gateRows.forEach((row, gateIndex) => attribute(row, layer.outputSize + gateIndex, false))
    for (const read of layer.indexReads) attribute(read.row, read.indexRow, false)
    available += layer.outputSize
  }
  return {liveOperations: program.valueCount - program.sourceSize, sourceCells: program.sourceSize, layers: program.layers.length, storedWeights, gatherReads, indexReads, bySection}
}

if (run('counts')) {
  const threadOptions = (slotCount: number, slotMode: ThreadCircuitOptions['slotMode']): ThreadCircuitOptions => ({slotCount, slotMode, naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
  const model = {tables: prepared.tables, staircases: prepared.staircases}
  const withSlots = buildThreadCircuit(model, threadOptions(48, 'rank'))
  const withSlotsCounts = programCounts(withSlots, withSlots.roots)
  const noSlots = buildThreadCircuit(model, threadOptions(0, 'rank'))
  const noSlotsCounts = programCounts(noSlots, noSlots.roots)
  const none = buildThreadCircuit(model, threadOptions(0, 'none'))
  const noneCounts = programCounts(none, none.roots)
  const slotSection = (counts: ReturnType<typeof programCounts>) => counts.bySection.find(entry => entry.name === 'DOM slots')!
  const threadRows = [
    {variant: 'hn-thread default: 48 rank slots, every per-row output', liveOperations: withSlotsCounts.liveOperations, layers: withSlotsCounts.layers, storedWeights: withSlotsCounts.storedWeights, slotSectionOperations: slotSection(withSlotsCounts).liveOperations, slotSectionWeights: slotSection(withSlotsCounts).storedWeights},
    {variant: 'rank slots with slotCount 0 (hn-thread "no slots")', liveOperations: noSlotsCounts.liveOperations, layers: noSlotsCounts.layers, storedWeights: noSlotsCounts.storedWeights, slotSectionOperations: slotSection(noSlotsCounts).liveOperations, slotSectionWeights: slotSection(noSlotsCounts).storedWeights},
    {variant: "slotMode 'none', every per-row output", liveOperations: noneCounts.liveOperations, layers: noneCounts.layers, storedWeights: noneCounts.storedWeights, slotSectionOperations: 0, slotSectionWeights: 0},
  ]
  printTable('Thread circuit with and without slots, 251 comments', threadRows)
  const pixelRows: Record<string, unknown>[] = []
  const sectionRows: Record<string, unknown>[] = []
  for (const variant of variants) {
    const build = buildPixelThread(prepared, paint, {...variant, checkWires: false}, variant.text === 'glyphs' ? glyphText : undefined)
    const counts = programCounts(build.built, build.roots)
    const guarded = emitInstanceWgsl(build.plan, {guard: 'max'})
    pixelRows.push({
      variant: variantName(variant),
      sourceCells: counts.sourceCells,
      liveOperations: counts.liveOperations,
      layers: counts.layers,
      storedWeights: counts.storedWeights,
      sharedRows: build.plan.counts.sharedRows,
      sharedWeights: build.plan.counts.sharedWeights,
      perPixelRows: build.plan.counts.instanceRows,
      perPixelWeights: build.plan.counts.instanceWeights,
      perPixelLayers: build.plan.counts.instanceLayers,
      perPixelComparisons: build.pixel.comparisons,
      gatherReads: counts.gatherReads,
      indexReads: counts.indexReads,
      // The binary search's first probe reads tops[128] at a constant index, so it runs in the shared part.
      perPixelIndexReads: guarded.exposure.indexReads,
      shaderStatements: guarded.statementCount,
      shaderKilobytes: Math.round(guarded.code.length / 1024),
      guards: guarded.exposure.guards,
      buildMs: build.buildMilliseconds.toFixed(0),
      compileAndPlanMs: build.compileMilliseconds.toFixed(0),
    })
    for (const entry of counts.bySection) sectionRows.push({variant: variantName(variant), section: entry.name, liveOperations: entry.liveOperations, storedWeights: entry.storedWeights})
  }
  printTable('Pixel programs, 251 comments, roots: next state, 7 globals for JS, 6 pixel outputs', pixelRows)
  printTable('Live operations by section', sectionRows)
  // Per-pixel rows by comment count, bars. The binary search has 8 probes up to 256 rows; the gutter level count grows with the deepest indent.
  const scalingRows = [60, 120, 180, 251].map(comments => {
    const subset = prepareThread(thread.comments.slice(0, comments))
    const subsetPaint = paintTables(thread, subset.tables, fakeTextWidth)
    const perPixelRows = (rowLookup: RowLookup) => buildPixelThread(subset, subsetPaint, {rowLookup, text: 'bars', checkWires: false}).plan.counts.instanceRows
    return {comments, maxIndent: subset.tables.maxIndent, countPerPixelRows: perPixelRows('count'), binarySearchPerPixelRows: perPixelRows('binary-search')}
  })
  printTable('Per-pixel rows by comment count, bars', scalingRows)
  const text = glyphText.layout(1280)
  const textRows = [375, 1024, 1200].map(width => {
    const tables = glyphText.layout(width)
    return {containerWidth: width, lines: tables.lineTop.length, characters: tables.charCode.length, mostLinesPerComment: Math.max(...tables.lineCount), mostCharactersPerLine: Math.max(...tables.lineLength)}
  })
  printTable(`Glyph text tables (capacity ${glyphText.capacity.lines} lines, ${glyphText.capacity.characters} characters, atlas ${atlas.characters.length} glyphs of ${atlas.cellWidth}×${atlas.cellHeight}, ${text.missingCharacters} characters missing from the atlas at 1280px)`, textRows)
  results['counts'] = {threadRows, pixelRows, sectionRows, scalingRows, textRows, textCapacity: glyphText.capacity}
}

const cpuGrid: SampleGrid = {width: 320, height: 200, stride: 4, offset: 0.5}
const cpuCenters = pixelCenters(cpuGrid.width, cpuGrid.height, cpuGrid.stride, cpuGrid.offset)
const cpuCount = cpuGrid.width * cpuGrid.height

if (run('cpu')) {
  const rows: Record<string, unknown>[] = []
  const state = initialThreadState(prepared, 1280)
  const inputs = {windowWidth: 1280, windowHeight: 800, scrollTopReal: 2400, pointerX: 88.5, pointerY: 500.25, pointerDown: 0, click: 0}
  for (const variant of variants) {
    const machine = createMachine(variant, state)
    machine.setInputs(inputs)
    const outputs = new Float32Array(cpuCount * pixelOutputField.size)
    const first = performance.now()
    machine.draw(cpuCenters, cpuCount, outputs)
    const firstMs = performance.now() - first
    for (let warm = 0; warm < 5; warm++) machine.draw(cpuCenters, cpuCount, outputs)
    const drawTimes: number[] = []
    const sharedTimes: number[] = []
    for (let repeat = 0; repeat < 9; repeat++) {
      let start = performance.now()
      machine.runShared()
      sharedTimes.push(performance.now() - start)
      start = performance.now()
      machine.draw(cpuCenters, cpuCount, outputs)
      drawTimes.push(performance.now() - start)
    }
    rows.push({
      variant: variantName(variant),
      pixels: cpuCount,
      firstFrameMs: firstMs.toFixed(0),
      frameMs: median(drawTimes).toFixed(1),
      sharedPartMs: median(sharedTimes).toFixed(2),
      nanosecondsPerPixel: ((median(drawTimes) - median(sharedTimes)) * 1e6 / cpuCount).toFixed(0),
      textLayoutMsOnWidthChange: variant.text === 'glyphs' ? machine.textLayoutMilliseconds().toFixed(1) : '-',
    })
  }
  printTable('CPU, generated JS instance loop, 320×200 samples of a 1280×800 frame (every 4th pixel)', rows)
  results['cpu'] = rows
}

type Totals = {frames: number, ambiguousSamples: number, decisionMismatches: number, ambiguousMismatches: number, largestColorDifference: number, inkSamples: number, inkSamplesCompared: number, firstMismatches: string[]}
const emptyTotals = (): Totals => ({frames: 0, ambiguousSamples: 0, decisionMismatches: 0, ambiguousMismatches: 0, largestColorDifference: 0, inkSamples: 0, inkSamplesCompared: 0, firstMismatches: []})
function addComparison(totals: Totals, comparison: RasterComparison, label: string) {
  totals.frames++
  totals.ambiguousSamples += comparison.ambiguousSamples
  totals.decisionMismatches += comparison.decisionMismatches
  totals.ambiguousMismatches += comparison.ambiguousMismatches
  totals.inkSamples += comparison.inkSamples
  totals.inkSamplesCompared += comparison.inkSamplesCompared
  totals.largestColorDifference = Math.max(totals.largestColorDifference, comparison.largestColorDifference)
  if (comparison.firstMismatch !== null && totals.firstMismatches.length < 3) totals.firstMismatches.push(`${label}: ${comparison.firstMismatch}`)
}

function checkFrame(machine: PixelMachine, text: TextMode, frame: ThreadFrame, outputs: Float32Array, band: number) {
  const geometry = geometryFromReference(frame)
  const textTables = machine.textTables()
  const glyphs = textTables === null ? undefined : {tables: textTables, atlas}
  return {
    sorted: topsSorted(geometry),
    endToEnd: compareRaster(rasterize(geometry, prepared.tables, paint, text, cpuGrid, band, glyphs), outputs, pixelOutputField.size),
    perPixel: compareRaster(rasterize(geometryFromCheckValues(machine.checkValues(), machine.built.rowCount), prepared.tables, paint, text, cpuGrid, 1 / 32, glyphs), outputs, pixelOutputField.size),
  }
}

if (run('random')) {
  const frames = Number(argument ?? 60)
  const rows: Record<string, unknown>[] = []
  const barsOutputs: Float32Array[][] = []
  for (const variant of variants) {
    const machine = createMachine(variant, initialThreadState(prepared, 1280))
    const random = seededRandom(41)
    const sorted = {endToEnd: emptyTotals(), perPixel: emptyTotals()}
    const unsorted = {endToEnd: emptyTotals(), perPixel: emptyTotals()}
    let peekFrames = 0
    let collapseClicks = 0
    // Sorted frames with emphasized banner or label samples, and with emphasized gutter samples (1px wide, so a 4px grid often misses them).
    let sortedFramesWithBannerEmphasis = 0
    let sortedFramesWithGutterEmphasis = 0
    const allOutputs: Float32Array[] = []
    for (let trial = 0; trial < frames; trial++) {
      const state: ThreadState = randomState(prepared, random, Math.round(320 + random() * 1100))
      const inputs = randomInputs(prepared, random, state)
      const {frame} = referenceFrame(prepared, state, inputs, 0, 'none')
      if (frame.global.peeking === 1) peekFrames++
      if (frame.next.collapsed.some((bit, row) => bit !== state.collapsed[row])) collapseClicks++
      machine.setState(state)
      machine.setInputs(inputs)
      const outputs = new Float32Array(cpuCount * pixelOutputField.size)
      machine.draw(cpuCenters, cpuCount, outputs)
      const check = checkFrame(machine, variant.text, frame, outputs, 0.05)
      // The two lookups only promise the same answer when row tops are sorted.
      if (variant.text === 'bars' && check.sorted) allOutputs.push(outputs)
      if (check.sorted) {
        const emphasis = countEmphasisSamples(outputs, pixelOutputField.size)
        if (emphasis.banner > 0) sortedFramesWithBannerEmphasis++
        if (emphasis.gutter > 0) sortedFramesWithGutterEmphasis++
      }
      const into = check.sorted ? sorted : unsorted
      addComparison(into.endToEnd, check.endToEnd, `frame ${trial}`)
      addComparison(into.perPixel, check.perPixel, `frame ${trial}`)
    }
    if (variant.text === 'bars') barsOutputs.push(allOutputs)
    rows.push({variant: variantName(variant), frames, peekFrames, collapseClicks, sortedFramesWithBannerEmphasis, sortedFramesWithGutterEmphasis, sorted, unsorted})
  }
  let differing = 0
  barsOutputs[0]!.forEach((outputs, frame) => {
    for (let index = 0; index < outputs.length; index++) if (!Object.is(outputs[index], barsOutputs[1]![frame]![index])) differing++
  })
  console.log(JSON.stringify(rows, null, 2))
  console.log(`count and binary-search bar outputs differing, over every frame and sample: ${differing}`)
  results['random'] = {grid: cpuGrid, rows, countVersusBinarySearchDifferingValues: differing}
}

if (run('session')) {
  // hn-thread's scripted session (scroll, gutter peek, collapse and expand, resize, overscroll), closed loop: the machine
  // and the reference each run on their own state. Every 5th frame is rasterized; positions drift up to 0.5px, so the
  // end-to-end band is 0.5px. That band makes every glyph ink sample of a line whose top isn't on a whole pixel
  // ambiguous, so the per-pixel comparison (the circuit's own geometry, 1/32px band) is the one that covers glyph text;
  // inkSamplesCompared in each totals says how much.
  const frames = 300
  const rows: Record<string, unknown>[] = []
  for (const variant of variants) {
    let referenceState = initialThreadState(prepared, 1024)
    const machine = createMachine(variant, referenceState)
    const inputsAt = scenarioInputs(prepared, frames)
    let previous: ThreadFrame | null = null
    const sorted = {endToEnd: emptyTotals(), perPixel: emptyTotals()}
    const unsorted = {endToEnd: emptyTotals(), perPixel: emptyTotals()}
    const outputs = new Float32Array(cpuCount * pixelOutputField.size)
    let unsortedFrames = 0
    let textLayouts = 0
    let lastWidth = Number.NaN
    let rasterizedFramesWithBannerEmphasis = 0
    let rasterizedFramesWithGutterEmphasis = 0
    for (let frame = 0; frame < frames; frame++) {
      const inputs = inputsAt(frame, previous)
      const {frame: expected} = referenceFrame(prepared, referenceState, inputs, 0, 'none')
      machine.setInputs(inputs)
      if (expected.global.containerWidth !== lastWidth) {
        textLayouts++
        lastWidth = expected.global.containerWidth
      }
      if (frame % 5 === 0) {
        machine.draw(cpuCenters, cpuCount, outputs)
        const check = checkFrame(machine, variant.text, expected, outputs, 0.5)
        const emphasis = countEmphasisSamples(outputs, pixelOutputField.size)
        if (emphasis.banner > 0) rasterizedFramesWithBannerEmphasis++
        if (emphasis.gutter > 0) rasterizedFramesWithGutterEmphasis++
        const into = check.sorted ? sorted : unsorted
        addComparison(into.endToEnd, check.endToEnd, `frame ${frame}`)
        addComparison(into.perPixel, check.perPixel, `frame ${frame}`)
      } else {
        machine.runShared()
      }
      if (!topsSorted(geometryFromReference(expected))) unsortedFrames++
      machine.commit()
      referenceState = expected.next
      previous = expected
    }
    rows.push({variant: variantName(variant), frames, unsortedFrames, containerWidthChanges: textLayouts, rasterizedFramesWithBannerEmphasis, rasterizedFramesWithGutterEmphasis, sorted, unsorted})
  }
  console.log(JSON.stringify(rows, null, 2))
  results['session'] = rows
}

if (run('wgsl')) {
  const grid = {width: 64, height: 40, stride: 20, offset: 3.25}
  const count = grid.width * grid.height
  const centers = pixelCenters(grid.width, grid.height, grid.stride, grid.offset)
  const rows: Record<string, unknown>[] = []
  for (const variant of variants) {
    const machine = createMachine(variant, initialThreadState(prepared, 1280))
    machine.setInputs({windowWidth: 1280, windowHeight: 800, scrollTopReal: 2400.5, pointerX: 88.5, pointerY: 500.25, pointerDown: 1, click: 0})
    const cpu = new Float32Array(count * pixelOutputField.size)
    machine.draw(centers, count, cpu)
    for (const guard of ['none', 'max'] as const) {
      const module = emitInstanceWgsl(machine.plan, {guard})
      const interpreted = new Float32Array(cpu.length)
      createWgslInterpreter(module.code)(packSharedBuffer(module, machine.runner), centers, count, interpreted)
      let mismatches = 0
      for (let index = 0; index < cpu.length; index++) if (!(interpreted[index] === cpu[index])) mismatches++
      rows.push({variant: variantName(variant), guard, statements: module.statementCount, kilobytes: Math.round(module.code.length / 1024), guards: module.exposure.guards, gatherSwitches: module.exposure.gatherReads, indexReads: module.exposure.indexReads, packedTables: module.packedTables.length, compared: cpu.length, mismatches})
    }
  }
  printTable('WGSL interpreted with strict f32 rounding, against the CPU instance loop', rows)
  results['wgsl'] = rows
}

if (run('gpu-export')) {
  if (argument === undefined) throw new Error('usage: report.ts gpu-export <directory>')
  console.log([...exportGpuCases(argument, prepared, paint, 'bars'), ...exportGpuCases(argument, prepared, paint, 'glyphs', glyphText)].join('\n'))
}

if (run('gpu-compare')) {
  if (argument === undefined) throw new Error('usage: report.ts gpu-compare <directory>')
  const rows = [...compareGpuCases(argument, prepared, paint, 'bars'), ...compareGpuCases(argument, prepared, paint, 'glyphs', glyphText)]
  printTable('GPU against the CPU instance loop and the float64 rasterizer, 1280×800', rows)
  const compileRows = gpuCompileTimes(argument)
  printTable('Shader compile times (compileMilliseconds with a token unique to the run, warmCompileMilliseconds for the same text again)', compileRows)
  const written = writeGpuFramePng(argument, prepared, new URL('./gpu-frame-glyphs.png', import.meta.url).pathname)
  // results.json records the PNG's path relative to the repo root, not this machine's absolute path.
  const png = written === null ? null : {...written, file: relative(resolve(import.meta.dir, '../../..'), written.file)}
  console.log(png === null ? '\nno GPU glyph output for the animated state, gpu-frame-glyphs.png not written' : `\nwrote ${png.file} from ${png.state}: ${png.emphasis.banner} emphasized banner samples, ${png.emphasis.gutter} emphasized gutter samples`)
  results['gpu-compare'] = {rows, compileRows, png}
}

if (Object.keys(results).length > 0) {
  const file = new URL('./results.json', import.meta.url).pathname
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
  writeFileSync(file, JSON.stringify({...existing, ...results}, null, 2))
}
