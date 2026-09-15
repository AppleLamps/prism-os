// Measurements for the notation prototype. Run from the repository root:
//   bun lab/ui-exploration/notation/report.ts
// Prints tables and writes report-output.json next to this file. Timings are
// rough: other processes share the machine. Counts are exact.
import {Circuit} from '../../../numeric-ui-core.ts'
import {compareCircuits, programStats} from './compare.ts'
import {buildIndirectOS} from './indirect-os.ts'
import {createSettingsMachine} from './settings-panel.ts'
import {leafWires} from './table.ts'
import {createPair, runRandomTrace, runScriptedTrace} from './traces.ts'
import {createNotation} from './wires.ts'

const folder = import.meta.dir
const repository = `${folder}/../../..`
const results: Partial<Record<'structure' | 'traces' | 'timestepVariant' | 'lines' | 'timings' | 'settingsPanel' | 'reciprocal', unknown>> = {}
const table = (rows: readonly (readonly (string | number)[])[]) =>
  console.log(rows.map(row => `| ${row.join(' | ')} |`).join('\n') + '\n')
const withoutWidths = ({layerWidths: _, ...stats}: ReturnType<typeof programStats>) => stats

// 1. Structure
const pair = createPair()
const comparison = compareCircuits(
  {circuit: pair.original.circuit, roots: pair.originalRoots},
  {circuit: pair.rewrite.circuit, roots: pair.rewriteRoots},
)
results.structure = {
  rootCount: comparison.rootCount,
  strict: comparison.strict,
  relaxed: comparison.relaxed,
  original: withoutWidths(comparison.original),
  rewrite: withoutWidths(comparison.rewrite),
  sameLayerWidths: comparison.original.layerWidths.join() === comparison.rewrite.layerWidths.join(),
}
console.log('## Structure\n')
table([
  ['circuit', 'built operations', 'live operations', 'layers', 'stored weights', 'gather reads'],
  ['original', ...Object.values(withoutWidths(comparison.original))],
  ['rewrite', ...Object.values(withoutWidths(comparison.rewrite))],
])
console.log('strict structural match:', comparison.strict, '\n')

// 2. Traces
const scripted = runScriptedTrace()
const seeds = [1, 2, 3, 4, 5]
const random = seeds.map(seed => runRandomTrace(seed, 3000))
results.traces = {scripted, random}
console.log('## Traces\n')
const traceRow = (name: string, result: typeof scripted | typeof random[0]) => [
  name, result.frames, result.comparedValues, result.mismatchedValues, result.originalRejections, result.rewriteRejections, result.disagreements,
  result.coverage.heldDragMoves, result.coverage.heldResizeMoves, result.coverage.focusAndSelect,
]
table([
  ['trace', 'frames', 'compared values', 'mismatched bits', 'original rejections', 'rewrite rejections', 'disagreements', 'held drag moves', 'held resize moves', 'focus and select'],
  traceRow('scripted', scripted),
  ...random.map((result, index) => traceRow(`random seed ${seeds[index]}`, result)),
])
const failedChecks = Object.entries(scripted.checks).filter(([, passed]) => !passed).map(([name]) => name)
console.log(`scripted checks: ${Object.keys(scripted.checks).length - failedChecks.length} of ${Object.keys(scripted.checks).length} took effect`, failedChecks)
console.log('first rejections:', scripted.firstOriginalRejection, '|', scripted.firstRewriteRejection)
random.forEach((result, index) => console.log(`seed ${seeds[index]}:`, result.firstOriginalRejection, '|', result.firstRewriteRejection))
console.log()

// 3. Declaring the spring timestep nonnegative before the window springs are built
const variant = buildIndirectOS({declareTimestepNonNegative: true})
const variantRoots = [...variant.nextSource, ...leafWires(variant.output)]
const variantStats = withoutWidths(programStats(variant.circuit, variantRoots))
const checkPair = createPair()
const rewriteStep = checkPair.rewrite.step
let variantCompared = 0
let variantMismatches = 0
checkPair.rewrite.step = (width, height, frameTime) => {
  const source = new Float32Array(checkPair.rewrite.source)
  source[checkPair.rewrite.cells.viewportWidth] = width
  source[checkPair.rewrite.cells.viewportHeight] = height
  source[checkPair.rewrite.cells.frameTime] = frameTime
  const variantValues = variant.circuit.evaluateTensor(source)
  const values = rewriteStep(width, height, frameTime)
  checkPair.rewriteRoots.forEach((wire, index) => {
    variantCompared++
    if (!Object.is(values[wire], variantValues[variantRoots[index]!])) variantMismatches++
  })
  return values
}
runRandomTrace(11, 2000, checkPair)
results.timestepVariant = {stats: variantStats, comparedValues: variantCompared, mismatchedValues: variantMismatches}
console.log('## Declaring the timestep range where it is computed\n')
table([
  ['circuit', 'built operations', 'live operations', 'layers', 'stored weights', 'gather reads'],
  ['as the original', ...Object.values(withoutWidths(comparison.rewrite))],
  ['timestep declared nonnegative first', ...Object.values(variantStats)],
])
console.log(`variant against the rewrite over 2,000 random frames: ${variantCompared} values, ${variantMismatches} mismatches\n`)

// 4. Lines and characters by category
// Generic helpers (hit tests, interval distance, clamps, complement) get their own
// category: the rewrite's equivalents live in wires.ts, which the library row counts.
type Category = 'imports' | 'declarations' | 'wiring' | 'behavior' | 'helpers' | 'validation' | 'host' | 'standalone' | 'library'
type Anchors = readonly (readonly [prefix: string, category: Category])[]
const windowManagerAnchors: Anchors = [
  ['export const windowCount = 4', 'declarations'],
  ['export const windowOutputField = {', 'wiring'],
  ['const springStateField = {', 'declarations'],
  ['const windowStateStart = 35', 'wiring'],
  ['export const photoSourceField = {', 'declarations'],
  ['const sourceSize = photoSourceField.size', 'wiring'],
  ['export const sourceField = {', 'declarations'],
  ['const photosWindowIndex = windowCount - 1', 'wiring'],
  ['function compileWindowManagerCircuit() {', 'declarations'],
  ['  const unit = sourceField.unit', 'behavior'],
  ['  const nextSource = Array.from({length: sourceField.size}', 'wiring'],
  ['  const windows: Wire[] = []', 'behavior'],
  ['  const photosWindowOutputStart = photosWindowIndex * windowOutputField.size', 'wiring'],
  ['  const animationActive = emitClampZeroOne(', 'behavior'],
  ['export function createWindowManagerMachine() {', 'declarations'],
  ['  const {circuit, output} = compileWindowManagerCircuit()', 'host'],
  ['function emitFrontmost(', 'behavior'],
  ['function emitRectangleHit(', 'helpers'],
  ['function validateWindowManagerSource(values: unknown, tolerance = 1e-9) {', 'validation'],
  ['if (typeof document !== \'undefined\' && typeof window !== \'undefined\') {', 'host'],
]
const photoGalleryAnchors: Anchors = [
  ['export const itemCount = 12', 'declarations'],
  ['export const photoField = {', 'wiring'],
  ['const photoNames = [', 'host'],
  ['export function focusField(item: number) {', 'wiring'],
  ['export function createPhotoGalleryCircuit() {', 'declarations'],
  ['  const zero = circuit.affine([])', 'behavior'],
  ['  const nextSource = Array.from({length: sourceField.size}', 'wiring'],
  ['  const previousControlOutput = [', 'behavior'],
  ['export function createPhotoGalleryMachine() {', 'standalone'],
  ['function thumbnailFalloff(distance: number) {', 'behavior'],
  ['function flattenProjections(projections: readonly PhotoProjection[]) {', 'wiring'],
  ['export function createPhotoGalleryRenderer(document: Document, root: HTMLElement) {', 'host'],
  ['function emitRectangleHit(circuit: Circuit, geometry: Geometry): Wire {', 'helpers'],
  ['function validateGallerySource(values: unknown, tolerance = 1e-9) {', 'validation'],
  ['function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {', 'helpers'],
  ['function assertBit(value: number | undefined, label: string): asserts value is number {', 'validation'],
]
// In rewrite files, `// category:` markers switch the category, and statements
// that talk to the table (allocate, next, finish) count as wiring.
const wiringStatement = /\btable\.(next|allocate|scope|createCircuit|finish|atMostOne)\(|createSourceTable\(\)|declarePhotoRules\(/

type Tally = Record<Category, {lines: number, characters: number}> & {comments: number}
const emptyTally = (): Tally => ({
  imports: {lines: 0, characters: 0}, declarations: {lines: 0, characters: 0}, wiring: {lines: 0, characters: 0},
  behavior: {lines: 0, characters: 0}, helpers: {lines: 0, characters: 0}, validation: {lines: 0, characters: 0}, host: {lines: 0, characters: 0},
  standalone: {lines: 0, characters: 0}, library: {lines: 0, characters: 0}, comments: 0,
})

async function measureFile(path: string, rule: Anchors | 'markers' | 'library', tally: Tally) {
  const lines = (await Bun.file(path).text()).split('\n')
  let category: Category = rule === 'library' ? 'library' : 'imports'
  let anchorIndex = 0
  let openParentheses = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (rule === 'markers') {
      const marker = /^\/\/ category: (\w+)$/.exec(trimmed)
      if (marker !== null) category = marker[1] as Category
    } else if (rule !== 'library' && anchorIndex < rule.length && line.startsWith(rule[anchorIndex]![0])) {
      category = rule[anchorIndex]![1]
      anchorIndex++
    }
    if (trimmed === '') continue
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      tally.comments++
      continue
    }
    let lineCategory = category
    if (rule === 'markers' && (openParentheses > 0 || wiringStatement.test(trimmed))) {
      lineCategory = 'wiring'
      openParentheses += (trimmed.match(/\(/g) ?? []).length - (trimmed.match(/\)/g) ?? []).length
    }
    tally[lineCategory].lines++
    tally[lineCategory].characters += trimmed.length
  }
  if (rule !== 'markers' && rule !== 'library' && anchorIndex !== rule.length) {
    throw new Error(`${path}: anchor not found: ${rule[anchorIndex]![0]}`)
  }
}

const before = emptyTally()
await measureFile(`${repository}/window-manager.ts`, windowManagerAnchors, before)
await measureFile(`${repository}/photo-gallery.ts`, photoGalleryAnchors, before)
const after = emptyTally()
const rewriteFiles = ['indirect-os.ts', 'photos.ts', 'indirect-os-dom.ts']
for (const file of rewriteFiles) {
  if (await Bun.file(`${folder}/${file}`).exists()) await measureFile(`${folder}/${file}`, 'markers', after)
}
const library = emptyTally()
for (const file of ['table.ts', 'wires.ts']) await measureFile(`${folder}/${file}`, 'library', library)
const settings = emptyTally()
await measureFile(`${folder}/settings-panel.ts`, 'markers', settings)

const countedCategories = ['behavior', 'helpers', 'declarations', 'wiring', 'validation', 'host', 'imports'] as const
const coarse = (tally: Tally) => ({
  behavior: tally.behavior,
  helpers: tally.helpers,
  bookkeeping: {lines: tally.declarations.lines + tally.wiring.lines, characters: tally.declarations.characters + tally.wiring.characters},
  declarations: tally.declarations,
  wiring: tally.wiring,
  validation: tally.validation,
  host: tally.host,
  imports: tally.imports,
  total: {
    lines: countedCategories.reduce((sum, key) => sum + tally[key].lines, 0),
    characters: countedCategories.reduce((sum, key) => sum + tally[key].characters, 0),
  },
  standalone: tally.standalone,
  comments: tally.comments,
})
results.lines = {before: coarse(before), after: coarse(after), library: library.library, settingsPanel: coarse(settings)}
console.log('## Non-blank, non-comment lines and characters (without indentation)\n')
const beforeCoarse = coarse(before)
const afterCoarse = coarse(after)
table([
  ['category', 'before lines', 'before characters', 'after lines', 'after characters'],
  ...(['behavior', 'helpers', 'bookkeeping', 'declarations', 'wiring', 'validation', 'host', 'imports', 'total'] as const).map(key =>
    [key, beforeCoarse[key].lines, beforeCoarse[key].characters, afterCoarse[key].lines, afterCoarse[key].characters]),
  ['standalone Photos machine (not rewritten)', beforeCoarse.standalone.lines, beforeCoarse.standalone.characters, 0, 0],
  ['comment lines', beforeCoarse.comments, '', afterCoarse.comments, ''],
])
console.log(`library (table.ts, wires.ts): ${library.library.lines} lines, ${library.library.characters} characters`)
console.log('settings panel:', coarse(settings), '\n')

// 5. Rough timings
function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}
function timeMicroseconds(run: () => void, iterations: number) {
  for (let warmup = 0; warmup < 1000; warmup++) run()
  const samples: number[] = []
  for (let iteration = 0; iteration < iterations; iteration++) {
    const start = performance.now()
    run()
    samples.push((performance.now() - start) * 1000)
  }
  return Number(median(samples).toFixed(1))
}
const timingPair = createPair()
let originalTime = 0
let rewriteTime = 0
results.timings = {
  originalStep: timeMicroseconds(() => { timingPair.original.step(1280, 800, originalTime += 16) }, 3000),
  rewriteStep: timeMicroseconds(() => { timingPair.rewrite.step(1280, 800, rewriteTime += 16) }, 3000),
  evaluateTensor: timeMicroseconds(() => { timingPair.rewrite.circuit.evaluateTensor(timingPair.rewrite.source) }, 3000),
  derivedSourceValidator: timeMicroseconds(() => timingPair.rewrite.validate(timingPair.rewrite.source), 3000),
}
console.log('## Rough median µs per call\n', results.timings, '\n')

// 6. Settings panel and the Newton reciprocal
const settingsMachine = createSettingsMachine()
const settingsStats = withoutWidths(programStats(settingsMachine.circuit, [...settingsMachine.nextSource, ...leafWires(settingsMachine.output)]))
const reciprocalCircuit = new Circuit(2)
reciprocalCircuit.assumeRange(0, 1, 1)
reciprocalCircuit.assumeRange(1, 1, 16_384)
const reciprocalWire = createNotation(reciprocalCircuit, 0).reciprocal(1, 1, 16_384)
const reciprocalStats = withoutWidths(programStats(reciprocalCircuit, [reciprocalWire]))
const evaluateReciprocal = reciprocalCircuit.createTensorEvaluator([reciprocalWire])
const reciprocalSource = new Float32Array([1, 1])
let maximumRelativeError = 0
let bitEqual = 0
let samples = 0
const sampleReciprocal = (x: number) => {
  reciprocalSource[1] = x
  const estimate = evaluateReciprocal(reciprocalSource)[0]!
  maximumRelativeError = Math.max(maximumRelativeError, Math.abs(estimate * reciprocalSource[1]! - 1))
  if (estimate === Math.fround(1 / reciprocalSource[1]!)) bitEqual++
  samples++
}
for (let x = 1; x <= 16_384; x++) sampleReciprocal(x)
for (let sample = 0; sample < 20_000; sample++) sampleReciprocal(1 + Math.random() * 16_383)
results.settingsPanel = {stats: settingsStats, sources: settingsMachine.source.length}
results.reciprocal = {stats: reciprocalStats, samples, maximumRelativeError, bitEqualShare: bitEqual / samples}
console.log('## Settings panel\n')
table([
  ['circuit', 'built operations', 'live operations', 'layers', 'stored weights', 'gather reads'],
  ['settings panel', ...Object.values(settingsStats)],
  ['Newton reciprocal alone, 1..16384', ...Object.values(reciprocalStats)],
])
console.log(`reciprocal over ${samples} samples: max relative error ${maximumRelativeError.toExponential(2)}, bit-equal to fround(1 / x) ${(100 * bitEqual / samples).toFixed(1)}%\n`)

await Bun.write(`${folder}/report-output.json`, `${JSON.stringify(results, null, 2)}\n`)
console.log('wrote report-output.json')
