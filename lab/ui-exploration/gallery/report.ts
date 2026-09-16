// Heavy measurements for the README: circuit sizes by configuration and by feature, standalone
// constructions, IndirectOS for comparison, rough CPU timings (including generated plain JS),
// long differential traces, a sweep over every integer viewport width, and the caption variant.
// Run: bun lab/ui-exploration/gallery/report.ts   (about a minute; writes report-output.json)
import {writeFileSync} from 'node:fs'
import {Circuit, type Wire} from '../../../numeric-ui-core.ts'
import {createWindowManagerMachine} from '../codegen/window-manager-copy.ts'
import {createPortLayout, loadCaptionBreakpoints} from './captions-reference.ts'
import {runScenario, scriptedTrace, type DifferentialReport} from './differential.ts'
import {probeEdges} from './edge-probe.ts'
import {FakeBrowser} from './fake-dom.ts'
import {createGalleryMachine, initializeSource} from './gallery-app.ts'
import {buildGalleryCircuit, type GalleryCircuitOptions} from './gallery-circuit.ts'
import {atLeastZero, emitAll, emitSaturateCount, emitSpring, emitSpringBank, emitStepMatrix, measureProgram, type Program} from './kit.ts'
import {photoGalleryData} from './photo-data.ts'
import {createReferenceGallery} from './reference.ts'

const output: Record<string, unknown> = {}
const log = (label: string, value: unknown) => {
  output[label] = value
  console.log(`\n=== ${label}`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}
const breakpoints = loadCaptionBreakpoints()

// --- sizes by configuration
const configurations: [string, GalleryCircuitOptions][] = [
  ['default (first-set-bit click tournament, one-layer prefix sums, signed spring products)', {}],
  ['click selection by prefix count', {clickSelection: 'prefix-count'}],
  ['click selection by the library emitFirstActive', {clickSelection: 'library-first-active'}],
  ['Brent-Kung prefix sums', {prefixMode: 'brent-kung'}],
  ['Brent-Kung prefix sums and click selection by prefix count', {prefixMode: 'brent-kung', clickSelection: 'prefix-count'}],
  ['offset spring products', {springProducts: 'offset'}],
  ['vibescript port captions (tabulated breakpoints)', {captions: breakpoints}],
]
log('sizes by configuration', configurations.map(([name, options]) => {
  const started = performance.now()
  const built = buildGalleryCircuit(photoGalleryData, options)
  const buildMilliseconds = Math.round(performance.now() - started)
  return {name, sourceCells: built.layout.size, builderOperations: built.circuit.operations.length, buildMilliseconds, ...measureProgram(built.circuit, built.roots).stats}
}))

const built = buildGalleryCircuit(photoGalleryData)
const measured = measureProgram(built.circuit, built.roots, built.sections)
log('default configuration by feature (live operations, stored weights, and the layers they occupy)', measured.bySection)
log('features compiled alone (roots = that feature only)', Object.fromEntries(Object.entries(built.slices).map(([name, roots]) => [name, measureProgram(built.circuit, roots).stats])))
{
  const urlFocus = buildGalleryCircuit(photoGalleryData, {focusFromUrlOnly: true})
  const brentKungGrid = buildGalleryCircuit(photoGalleryData, {prefixMode: 'brent-kung'})
  log('2D grid compiled alone with Brent-Kung prefix sums (trace compiler slice: 24,894 operations, 600 layers, 38,810 weights)',
    measureProgram(brentKungGrid.circuit, brentKungGrid.slices.layout2D).stats)
  log('1D strip compiled alone, focused index as an input (trace compiler slice: 21,213 operations, 1,580 layers, 31,290 weights)', {
    'one-layer prefix sums': measureProgram(urlFocus.circuit, urlFocus.slices.layout1D).stats,
    'Brent-Kung prefix sums': (() => {
      const brentKung = buildGalleryCircuit(photoGalleryData, {focusFromUrlOnly: true, prefixMode: 'brent-kung'})
      return measureProgram(brentKung.circuit, brentKung.slices.layout1D).stats
    })(),
  })
}

// --- standalone constructions
{
  const count = photoGalleryData.length
  const occlusion = new Circuit(3 + count * 4)
  for (let wire = 0; wire < 3 + count * 4; wire++) occlusion.assumeRange(wire, -(2 ** 22), 2 ** 22)
  const bits = Array.from({length: count}, (_, index) => {
    const [x, y, width, height] = [3 + index * 4, 4 + index * 4, 5 + index * 4, 6 + index * 4]
    return emitAll(occlusion, [
      atLeastZero(occlusion.roundAffine([[1, 1], [y, -1], [2, 1]], 150)),
      atLeastZero(occlusion.roundAffine([[y, 1], [height, 1], [2, -1]], 100)),
      atLeastZero(occlusion.roundAffine([[0, 1], [x, -1]])),
      atLeastZero(occlusion.roundAffine([[x, 1], [width, 1]])),
    ], {booleanAtom: true})
  })
  const springCount = count * 6
  const springs = new Circuit(2 + springCount * 2)
  springs.assumeRange(0, 0, 16380)
  springs.assumeRange(1, 0, 1)
  for (let wire = 2; wire < 2 + springCount * 2; wire++) springs.assumeRange(wire, -(2 ** 24), 2 ** 24)
  const stepMatrix = emitStepMatrix(springs, 0, {stiffness: 290, damping: 30, stepMilliseconds: 4})
  const results = (products: 'signed' | 'offset') => {
    const bank = emitSpringBank(springs, stepMatrix, springs.affine([[1, -1]], 1), products)
    const roots: Wire[] = []
    const actives: Wire[] = []
    for (let spring = 0; spring < springCount; spring++) {
      const result = emitSpring(springs, bank, 2 + spring * 2, 3 + spring * 2)
      roots.push(result.displacement, result.velocity)
      actives.push(result.active)
    }
    roots.push(emitSaturateCount(springs, springs.affine(actives.map(active => [active, 1] as const))))
    return measureProgram(springs, roots).stats
  }
  log('standalone constructions', {
    'occlusion bits for 221 boxes from positions (trace compiler slice: 25,416 operations, 32 layers, 34,477 weights)': measureProgram(occlusion, bits).stats,
    'step matrix from elapsed milliseconds (0..4095 steps)': measureProgram(springs, [...stepMatrix.matrix, stepMatrix.leftover]).stats,
    '1,326 springs sharing one step matrix, signed products': results('signed'),
    '1,326 springs sharing one step matrix, offset products': results('offset'),
  })
}

// --- IndirectOS for comparison
const windowManager = createWindowManagerMachine()
windowManager.step(1280, 800, 16)
windowManager.pointerDown(300, 70)
windowManager.step(1280, 800, 32)
windowManager.pointerMove(360, 110)
windowManager.step(1280, 800, 48)
{
  const program = windowManager.tensorProgram
  log('IndirectOS (window manager with Photos)', {
    sourceCells: program.sourceSize,
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
  })
}

// --- rough CPU timings (a dozen other processes share this machine)
function microsecondsPerCall(run: () => void, minimumWarmRuns = 1000, warmMilliseconds = 2500) {
  // Warm long enough, and often enough, for large generated functions to reach the optimizing tiers.
  const warmStart = performance.now()
  let warmRuns = 0
  while (performance.now() - warmStart < warmMilliseconds || warmRuns < minimumWarmRuns) {
    run()
    warmRuns++
  }
  const probe = performance.now()
  for (let index = 0; index < 5; index++) run()
  const once = Math.max(0.001, (performance.now() - probe) / 5)
  const iterations = Math.max(3, Math.round(60 / once))
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((performance.now() - start) / iterations * 1000)
  }
  return Number(samples.sort((left, right) => left - right)[3]!.toFixed(1))
}

// Plain JS generated from a compiled program, adapted from phase 1's runtime/codegen-study.ts. Each
// generated function holds at most about 150 statements. Measured on the gallery circuit: 150 statements
// per function reach 418µs after 6,000 runs (the first 1,000 runs take 14.7 seconds while the engine
// tiers up); 600 statements per function need about 125 seconds of warmup and end near 1,050µs.
function generateProgram(program: Program) {
  const literal = (value: number) => Object.is(value, -0) ? '-0' : String(value)
  const bodies: string[] = []
  let current: string[] = []
  let statementCount = 0
  let available = program.sourceSize
  let tableIndex = 0
  const tables: Int32Array[] = []
  const flush = () => {
    if (current.length > 0) bodies.push(`let a = 0, g = 0\n${current.join('\n')}`)
    current = []
    statementCount = 0
  }
  for (const layer of program.layers) {
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.gatherReads.map(read => [read.row, read]))
    const tableByRow = new Map<number, number>()
    for (const read of layer.gatherReads) {
      tableByRow.set(read.row, tableIndex++)
      tables.push(Int32Array.from(read.candidatePositions))
    }
    for (const compute of layer.gatherComputes) {
      const parts = [...compute.bitPositions].map((position, bitIndex) => `index += ${bitIndex} * v[${position}]; mass += v[${position}];`)
      current.push(`{ let index = 0, mass = 0; ${parts.join(' ')} gi[${compute.slot}] = index; gm[${compute.slot}] = mass }`)
    }
    const rowStatements = (row: number, variable: string, lines: string[]) => {
      lines.push(`${variable} = ${literal(layer.bias[row]!)}`)
      for (let index = layer.rowOffsets[row]!; index < layer.rowOffsets[row + 1]!; index++) {
        lines.push(`${variable} = f(${variable} + f(${literal(layer.weights[index]!)} * v[${layer.inputIndices[layer.columns[index]!]!}]))`)
      }
    }
    for (let row = 0; row < layer.outputSize; row++) {
      const lines: string[] = []
      rowStatements(row, 'a', lines)
      const read = readByRow.get(row)
      if (read !== undefined) {
        const contribution = `v[tables[${tableByRow.get(row)}][Math.min(Math.max(gi[${read.slot}], 0), ${read.candidatePositions.length - 1})]]`
        lines.push(read.masked ? `a = f(a + f(gm[${read.slot}] * ${contribution}))` : `a = f(a + ${contribution})`)
      }
      const gateProjection = gateProjectionByRow.get(row)
      if (gateProjection !== undefined) {
        rowStatements(gateProjection, 'g', lines)
        lines.push('a = f(a * Math.max(0, g))')
      } else if (booleanRows.has(row)) {
        lines.push('a = f(f(f(a) + 8388609) - 8388609)')
      }
      lines.push(`v[${available + row}] = a`)
      if (statementCount + lines.length > 150) flush()
      current.push(lines.join('\n'))
      statementCount += lines.length
    }
    available += layer.outputSize
  }
  flush()
  const functions = bodies.map(body => new Function('v', 'f', 'gi', 'gm', 'tables', body) as (v: Float32Array, f: (x: number) => number, gi: Int32Array, gm: Float32Array, tables: Int32Array[]) => void)
  const packed = new Float32Array(program.valueCount)
  const gatherIndices = new Int32Array(Math.max(1, program.gatherSlotCount))
  const gatherMasses = new Float32Array(Math.max(1, program.gatherSlotCount))
  return {
    functionCount: functions.length,
    packed,
    run(source: Float32Array) {
      packed.set(source)
      for (const generated of functions) generated(packed, Math.fround, gatherIndices, gatherMasses, tables)
    },
  }
}

function generatedMismatches(circuit: Circuit, program: Program, generated: ReturnType<typeof generateProgram>, source: Float32Array) {
  generated.run(source)
  const expected = circuit.evaluateTensor(source)
  let mismatches = 0
  for (let packed = 0; packed < program.valueCount; packed++) {
    const left = generated.packed[packed]!
    const right = expected[program.wireOrder[packed]!]!
    if (!(left === right || Object.is(left, right))) mismatches++
  }
  return mismatches
}

{
  // A mid-animation gallery state: open photo 40 and step a few frames.
  const machine = createGalleryMachine(built)
  initializeSource(machine, photoGalleryData, 1440, 900, 0)
  machine.source[built.cells.focusedIndex] = 40
  machine.source[built.cells.focusedPresent] = 1
  for (let frame = 0; frame < 5; frame++) {
    machine.source[built.cells.frameDuration] = 16.5
    machine.step()
  }
  const gallerySource = new Float32Array(machine.source)
  const galleryEvaluate = built.circuit.createTensorEvaluator(built.roots)
  const galleryProgram = built.circuit.compileTensorProgram(built.roots)
  built.circuit.tensorProgram = galleryProgram
  const galleryGenerated = generateProgram(galleryProgram)
  const windowEvaluate = windowManager.circuit.createTensorEvaluator([...windowManager.tensorProgram.roots])
  const windowGenerated = generateProgram(windowManager.tensorProgram)

  const referenceBrowser = new FakeBrowser(1440, 900)
  const reference = createReferenceGallery(referenceBrowser)
  let now = 1000
  let frame = 0
  const referenceRender = () => {
    // Alternate between opening and closing a photo every 40 frames, so springs keep moving.
    if (frame % 40 === 0) referenceBrowser.hash = frame % 80 === 0 ? `#${photoGalleryData[40]!.id}` : ''
    frame++
    now += 16.5
    reference.render(now)
  }
  log('rough CPU timings in microseconds per evaluation', {
    'gallery circuit, executor (createTensorEvaluator, includes source range validation)': microsecondsPerCall(() => galleryEvaluate(gallerySource)),
    'gallery circuit, generated plain JS, after 6,000 warm runs': microsecondsPerCall(() => galleryGenerated.run(gallerySource), 6000),
    'gallery generated JS functions': galleryGenerated.functionCount,
    'gallery generated JS live wire mismatches against the executor': generatedMismatches(built.circuit, galleryProgram, galleryGenerated, gallerySource),
    'IndirectOS, executor': microsecondsPerCall(() => windowEvaluate(windowManager.source)),
    'IndirectOS, generated plain JS, after 6,000 warm runs': microsecondsPerCall(() => windowGenerated.run(windowManager.source), 6000),
    'index.ts render() natively, with fake DOM writes, while animating': microsecondsPerCall(referenceRender),
  })
}

// --- every integer width: column count and 2D destinations against index.ts
{
  const referenceBrowser = new FakeBrowser(1440, 900)
  const reference = createReferenceGallery(referenceBrowser)
  const machine = createGalleryMachine(built)
  let columnMismatches = 0
  let maximumDestinationError = 0
  let worst = ''
  let widths = 0
  let now = 1000
  for (let width = 320; width <= 3840; width++) {
    referenceBrowser.clientWidth = width
    reference.render(now += 16)
    initializeSource(machine, photoGalleryData, width, 900, referenceBrowser.scrollY)
    machine.source[built.cells.scrollY] = referenceBrowser.scrollY
    machine.step()
    widths++
    if (machine.read(built.outputs.columns) !== reference.colsBoxMaxSizeXF(width).cols) columnMismatches++
    reference.data.forEach((box, index) => {
      const photo = built.outputs.photos[index]!
      for (const [expected, wire] of [[box.x.dest, photo.destX], [box.y.dest, photo.destY], [box.sizeX.dest, photo.destSizeX], [box.sizeY.dest, photo.destSizeY]] as const) {
        const error = Math.abs(expected - machine.read(wire))
        if (error > maximumDestinationError) {
          maximumDestinationError = error
          worst = `width ${width} photo ${index}: expected ${expected}, got ${machine.read(wire)}`
        }
      }
    })
  }
  log('every integer width 320..3840 at height 900', {widths, columnMismatches, maximumDestinationError, worst})
}

// --- pointers next to box edges, where index.ts's float64 edges and the circuit's FP32 edges disagree
log('pointers next to box edges: hover and click against index.ts', ([
  [500, 900, 1], [390, 844, 1], [320, 700, 0.97], [760, 900, 1], [1440, 900, 1], [500, 900, 0],
] as const).map(([width, height, scrollFraction]) => probeEdges({built, width, height, scrollFraction, maximumClickTrials: 40})))

// --- long differential traces
function summarize(reports: DifferentialReport[]) {
  const errors: Record<string, number> = {}
  for (const report of reports) {
    for (const [kind, stat] of Object.entries(report.errors)) errors[kind] = Math.max(errors[kind] ?? 0, stat.maximumAbsolute)
  }
  const sum = (pick: (report: DifferentialReport) => number) => reports.reduce((total, report) => total + pick(report), 0)
  const sumRecords = (pick: (report: DifferentialReport) => Record<string, number>) => {
    const totals: Record<string, number> = {}
    for (const report of reports) for (const [kind, count] of Object.entries(pick(report))) totals[kind] = (totals[kind] ?? 0) + count
    return totals
  }
  return {
    traces: reports.length,
    mismatchesPerTrace: reports.map(report => report.decisionMismatches),
    frames: sum(report => report.frames),
    framesIn1D: sum(report => report.framesIn1D),
    animatingFrames: sum(report => report.animatingFrames),
    reducedMotionFrames: sum(report => report.reducedMotionFrames),
    events: sumRecords(report => report.events),
    decisionChecks: sum(report => report.decisionChecks),
    decisionMismatches: sum(report => report.decisionMismatches),
    checksByKind: sumRecords(report => report.checksByKind),
    'how often index.ts changed each decision (for call counts: frames with a call)': sumRecords(report => report.referenceChanges),
    firstMismatches: reports.flatMap(report => report.firstMismatches).slice(0, 5),
    maximumAbsoluteErrors: errors,
  }
}
const viewports = [[1440, 900], [390, 844], [2560, 1400], [800, 600], [1024, 1366], [1920, 1080]] as const
for (const [label, resync, durations] of [
  ['dyadic frame times, free-running', false, 'dyadic'],
  ['dyadic frame times, state copied from the original before every frame', true, 'dyadic'],
  // Same seeds and viewports, but the durations draw different random values, so the events differ too.
  ['six more traces with the same seeds and viewports, microsecond timestamps with jitter, free-running', false, 'realistic'],
] as const) {
  log(`differential traces: ${label}`, summarize(viewports.map(([width, height], index) =>
    runScenario({seed: 5000 + index, frames: 600, width, height, resync, durations, built}))))
}
log('differential trace: scripted', summarize([runScenario({seed: 0, frames: 420, width: 1440, height: 900, resync: false, built, script: scriptedTrace})]))

// --- caption variant against the vibescript port's layout.ts
{
  const captionBuilt = buildGalleryCircuit(photoGalleryData, {captions: breakpoints})
  const machine = createGalleryMachine(captionBuilt)
  const port = createPortLayout(photoGalleryData, breakpoints)
  const sources = port.makeLayoutSources(photoGalleryData)
  const destinations = (width: number, height: number, scrollY: number, focused: number) => {
    initializeSource(machine, photoGalleryData, width, height, scrollY)
    machine.source[captionBuilt.cells.scrollY] = scrollY
    machine.source[captionBuilt.cells.committedScrollY] = scrollY
    machine.source[captionBuilt.cells.focusedIndex] = Math.max(0, focused)
    machine.source[captionBuilt.cells.focusedPresent] = focused >= 0 ? 1 : 0
    machine.step()
    return captionBuilt.outputs.photos.map(photo => [machine.read(photo.destX), machine.read(photo.destY), machine.read(photo.destSizeX), machine.read(photo.destSizeY)])
  }
  const stats = {layouts: 0, items: 0, lineDecisionMismatches: 0, maximumPositionError: 0, maximumSizeError: 0}
  const compare = (expected: {x: number, y: number, sizeX: number, sizeY: number}[], actual: number[][]) => {
    stats.layouts++
    expected.forEach((rect, index) => {
      const [x, y, sizeX, sizeY] = actual[index]!
      stats.items++
      if (Math.abs(rect.sizeY - sizeY!) > 1) stats.lineDecisionMismatches++
      else {
        stats.maximumPositionError = Math.max(stats.maximumPositionError, Math.abs(rect.x - x!), Math.abs(rect.y - y!))
        stats.maximumSizeError = Math.max(stats.maximumSizeError, Math.abs(rect.sizeX - sizeX!), Math.abs(rect.sizeY - sizeY!))
      }
    })
  }
  for (let width = 320; width <= 2000; width++) compare(port.getGridLayout(sources, width).items.map(item => item.layoutBox), destinations(width, 900, 0, -1))
  const gridStats = {...stats}
  Object.assign(stats, {layouts: 0, items: 0, lineDecisionMismatches: 0, maximumPositionError: 0, maximumSizeError: 0})
  let seed = 77
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let trial = 0; trial < 400; trial++) {
    const width = 320 + Math.floor(random() * 1680)
    const height = 480 + Math.floor(random() * 920)
    const focused = Math.floor(random() * photoGalleryData.length)
    const scrollY = Math.round(random() * 4000 * 4) / 4
    compare(port.getLineLayout(sources, focused, width, height, scrollY).items.map(item => item.layoutBox), destinations(width, height, scrollY, focused))
  }
  log('caption variant against vibescript layout.ts', {grid: gridStats, strip: {...stats}, breakpointTable: (await import('./caption-breakpoints.json')).default.checks})
}

writeFileSync(new URL('report-output.json', import.meta.url), `${JSON.stringify(output, null, 1)}\n`)
