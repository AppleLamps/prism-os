// Prints the README's tables from run.ts's raw results:
//   bun lab/json-search/gpu/summarize.ts --main <main run .json, comma-separated> [--checks <check run .json>]
// Each run is one fresh Chrome process. Where a table combines runs, a cell shows the median of the runs' medians, and
// their range in parentheses. The median of an even count is the mean of the two middle values.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}
type Timings = Record<'cellsMs' | 'uploadMs' | 'encodeAndSubmitMs' | 'waitMs' | 'copyMs' | 'totalMs' | 'totalWithCellsMs' | 'passMs' | 'gapMs', Summary | undefined>
type Idle = Timings & {idleMs: number, totals: number[], passes?: number[]}
type GpuResult = {
  variant: string, count: number, megabytesReadBack: number, megabytesOfCells: number,
  backToBack: Timings, withTimestamps?: Timings, everyValueCompared?: Timings, afterIdle?: Idle[], afterIdleWithTimestamps?: Idle[], afterIdleWithKeepWarm?: Idle & {dispatchesPerGap: number}, withUpload?: Timings,
  checks: {readbacks: number, values: number, mismatches: number},
}
type CpuTime = {microsecondsPerDocument: number}
type CpuEntry = {count: number, executorDocuments: number, generatedJsDocuments: number} & Record<typeof baselines[number]['key'], CpuTime>
type Check = {texts: number, values: number, mismatches: number}
type Page = {
  crossOriginIsolated: boolean, error?: string, userAgent: string,
  adapter: {info: {vendor: string, architecture: string, description: string}, grantedBufferBytes: number},
  programs: {rootSet: string, buildMs: number, operations: number, layers: number, storedWeights: number, indexReads: number, sourceCells: number, compileMs: number, emitMs: number, statements: number, shaderBytes: number}[],
  documents: {generateMs: number, writeCellsMs: number, megabytesOfCells: number, count: number, invalid: number, nonAscii: number, lengths: Record<string, number>, histogram: number[], shapes: Record<string, number>, defects: Record<string, number>},
  agreement: Record<string, number>,
  cpu: {byCount: CpuEntry[], executorEveryDocumentMs: number, generatedJsMismatchesAgainstExecutor: number, jsonParseValidOnly: CpuTime & {documents: number}, jsonParseThrowingOnly: CpuTime & {documents: number}},
  compile: {emptyPipelineMs: number, programs: {rootSet: string, shaderSalt: number, compileMs: number, corpusCheck: Check}[]},
  firstLoad: {documents: number, megabytesUploaded: number, uploadAndFirstEvaluationMs: number, mismatches: number},
  selfCheck: {documents: number, values: number, mismatches: number, cpuMs: number, gpuMs: number},
  results: GpuResult[],
}
type CheckResult = {rootSet: string, guard: string, statements: number, shaderBytes: number, guards: number, compileMs: number, corpusCheck: Check, generatedCheck: {documents: number, values: number, mismatches: number}, summaryBackToBackMs: Summary}
type Run<Results> = {driver: {startedAt: string, finishedAt?: string, browser: string, machine: string, bun: string, loadBefore: string, loadAfter?: string, loadSamples: {load: string}[], error?: string}, page: Results}

// The CPU baselines of page.ts, and which GPU variants each one is compared with: JSON.parse only says whether a text
// is valid, and the others also give a display kind per character.
const baselines = [
  {key: 'jsonParse', name: 'JSON.parse', sampled: false},
  {key: 'tableLoop', name: 'table loop', sampled: false},
  {key: 'reference', name: 'reference.ts', sampled: false},
  {key: 'generatedJsSummary', name: 'generated JavaScript, summary', sampled: true},
  {key: 'generatedJsDisplay', name: 'generated JavaScript, display', sampled: true},
  {key: 'executorSummary', name: 'executor, summary', sampled: true},
  {key: 'executorDisplay', name: 'executor, display', sampled: true},
] as const
const baselinesOfVariant: Record<string, typeof baselines[number]['key'][]> = {
  'summary': ['jsonParse', 'tableLoop', 'reference', 'generatedJsSummary', 'executorSummary'],
  'display-window': ['tableLoop', 'reference', 'generatedJsDisplay', 'executorDisplay'],
  'display-all': ['tableLoop', 'reference', 'generatedJsDisplay', 'executorDisplay'],
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const files = (name: string) => argument(name)?.split(',').filter(path => path !== '') ?? []
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const format = (value: number, digits = 0) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})
// Two decimals below 10, one below 100, none above.
const digitsFor = (value: number) => value < 10 ? 2 : value < 100 ? 1 : 0
const spread = (values: readonly number[], digits?: number) => {
  if (values.length === 0) return ''
  const shown = digits ?? digitsFor(median(values))
  return values.length === 1 ? format(values[0]!, shown) : `${format(median(values), shown)} (${format(Math.min(...values), shown)} to ${format(Math.max(...values), shown)})`
}
const defined = <Value>(values: readonly (Value | undefined)[]) => values.filter(value => value !== undefined)

const mainRuns = files('--main').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run<Page>)
const checkRuns = files('--checks').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run<{results: CheckResult[], error?: string, crossOriginIsolated: boolean, compile: {emptyPipelineMs: number}}>)

console.log('Runs:\n')
for (const run of [...mainRuns, ...checkRuns]) {
  // A run that hasn't finished has no load after it yet.
  const loads = defined([run.driver.loadBefore, ...run.driver.loadSamples.map(sample => sample.load), run.driver.loadAfter]).map(load => Number(load.split(' ')[1]))
  const minutes = run.driver.finishedAt === undefined ? '?' : format((Date.parse(run.driver.finishedAt) - Date.parse(run.driver.startedAt)) / 60_000, 1)
  console.log(`- ${run.driver.startedAt}, ${minutes} minutes, ${run.driver.browser}, Bun ${run.driver.bun}, ${run.driver.machine}, cross-origin isolated ${run.page.crossOriginIsolated}, 1-minute load average ${format(Math.min(...loads), 2)} to ${format(Math.max(...loads), 2)}${run.page.error === undefined ? '' : `, error ${run.page.error}`}${run.driver.error === undefined ? '' : `, driver error ${run.driver.error}`}`)
}
if (mainRuns.length === 0) process.exit(0)
const first = mainRuns[0]!.page
const pages = mainRuns.map(run => run.page)

console.log(`\nAdapter: ${first.adapter.info.vendor}, ${first.adapter.info.architecture}, ${first.adapter.info.description}. Storage buffer bytes requested: ${format(first.adapter.grantedBufferBytes)}.`)

console.log('\n| Outputs | Source cells | Live operations | Layers | Stored weights | Index reads | WGSL statements | WGSL bytes | Build ms | Compile program ms | Emit WGSL ms | Compile shader ms, cold |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
first.programs.forEach((program, index) => {
  console.log(`| ${program.rootSet} | ${format(program.sourceCells)} | ${format(program.operations)} | ${format(program.layers)} | ${format(program.storedWeights)} | ${format(program.indexReads)} | ${format(program.statements)} | ${format(program.shaderBytes)} | ${spread(pages.map(page => page.programs[index]!.buildMs))} | ${spread(pages.map(page => page.programs[index]!.compileMs))} | ${spread(pages.map(page => page.programs[index]!.emitMs))} | ${spread(pages.map(page => page.compile.programs[index]!.compileMs), 0)} |`)
})
console.log(`\nThe first pipeline of each Chrome process, a shader with one empty function: ${spread(pages.map(page => page.compile.emptyPipelineMs))} ms. Salts: ${pages.map(page => page.compile.programs[0]!.shaderSalt).join(', ')}.`)

const documents = first.documents
console.log(`\nDocuments: ${format(documents.count)}, of which ${format(documents.invalid)} are broken and ${format(documents.nonAscii)} hold characters past U+007F. Lengths in code points: ${JSON.stringify(documents.lengths)}. Generated in ${spread(pages.map(page => page.documents.generateMs))} ms, cells written in ${spread(pages.map(page => page.documents.writeCellsMs))} ms, ${format(documents.megabytesOfCells, 1)} MB of cells.`)
console.log('\n| Code points | ' + documents.histogram.map((_, bucket) => bucket === documents.histogram.length - 1 ? 'more than 512' : `${bucket * 64} to ${bucket === documents.histogram.length - 2 ? 512 : bucket * 64 + 63}`).join(' | ') + ' |')
console.log('| --- | ' + documents.histogram.map(() => '---').join(' | ') + ' |')
console.log('| Documents | ' + documents.histogram.map(bucket => format(bucket)).join(' | ') + ' |')
console.log(`\nShapes: ${Object.entries(documents.shapes).map(([name, count]) => `${name} ${format(count)}`).join(', ')}.`)
console.log(`Defects: ${Object.entries(documents.defects).map(([name, count]) => `${name} ${format(count)}`).join(', ')}.`)
console.log(`\nAgreement with the executor's outputs, per run: ${pages.map(page => JSON.stringify(page.agreement)).join('; ')}. Generated JavaScript against the executor, mismatched values per run: ${pages.map(page => page.cpu.generatedJsMismatchesAgainstExecutor).join(', ')}.`)

// µs per document of each baseline at each count, the median of the runs.
const counts = first.cpu.byCount.map(entry => entry.count)
const cpuMicroseconds = (key: typeof baselines[number]['key'], count: number) => pages.map(page => page.cpu.byCount.find(entry => entry.count === count)![key].microsecondsPerDocument)
console.log(`\n| Documents | ${baselines.map(baseline => `${baseline.name}${baseline.sampled ? ', sampled' : ''} µs per document`).join(' | ')} |`)
console.log(`| --- | ${baselines.map(() => '---').join(' | ')} |`)
for (const count of counts) console.log(`| ${format(count)} | ${baselines.map(baseline => spread(cpuMicroseconds(baseline.key, count))).join(' | ')} |`)
const sampledEntry = first.cpu.byCount.at(-1)!
console.log(`\nSampled: the executor ran the first ${format(sampledEntry.executorDocuments)} documents and generated JavaScript the first ${format(sampledEntry.generatedJsDocuments)}, or all of them at smaller counts, and the ms below multiply their µs per document by the count.`)
console.log(`The executor over every document for the expected outputs, display program, one pass: ${spread(pages.map(page => page.cpu.executorEveryDocumentMs), 0)} ms for ${format(documents.count)} documents.`)
console.log(`JSON.parse on the ${format(first.cpu.jsonParseValidOnly.documents)} valid documents: ${spread(pages.map(page => page.cpu.jsonParseValidOnly.microsecondsPerDocument))} µs per document. On the ${format(first.cpu.jsonParseThrowingOnly.documents)} documents where it throws: ${spread(pages.map(page => page.cpu.jsonParseThrowingOnly.microsecondsPerDocument))} µs per document.`)

console.log(`\n| Documents | ${baselines.map(baseline => `${baseline.name} ms${baseline.sampled ? ', extrapolated' : ''}`).join(' | ')} |`)
console.log(`| --- | ${baselines.map(() => '---').join(' | ')} |`)
for (const count of counts) console.log(`| ${format(count)} | ${baselines.map(baseline => spread(cpuMicroseconds(baseline.key, count).map(microseconds => microseconds * count / 1000))).join(' | ')} |`)

const variants = [...new Set(first.results.map(result => result.variant))]
const resultsOf = (variant: string, count: number) => defined(pages.map(page => page.results.find(result => result.variant === variant && result.count === count)))
const mediansOf = (results: readonly GpuResult[], pick: (result: GpuResult) => Summary | undefined) => defined(results.map(result => pick(result)?.median))
const idleAt = (result: GpuResult, idleMs: number) => result.afterIdle?.find(entry => entry.idleMs === idleMs)
const idleGaps = first.results[0]!.afterIdle?.map(entry => entry.idleMs) ?? []

console.log('\nOne evaluation with the documents already on the GPU, ms:\n')
console.log(`| Variant | Documents | MB read back | Back to back | Compute pass, timestamps | ${idleGaps.map(gap => `After ${format(gap)} ms idle`).join(' | ')} |`)
console.log(`| --- | --- | --- | --- | --- | ${idleGaps.map(() => '---').join(' | ')} |`)
for (const variant of variants) {
  for (const count of counts) {
    const results = resultsOf(variant, count)
    if (results.length === 0) continue
    console.log(`| ${variant} | ${format(count)} | ${format(results[0]!.megabytesReadBack, 3)} | ${spread(mediansOf(results, result => result.backToBack.totalMs))} | ${spread(mediansOf(results, result => result.withTimestamps?.passMs))} | ${idleGaps.map(gap => spread(mediansOf(results, result => idleAt(result, gap)?.totalMs))).join(' | ')} |`)
  }
}

console.log('\nThe parts of one back to back evaluation, ms, median of the runs\' medians:\n')
console.log('| Variant | Documents | Encode and submit | Submit to mapped | Copy out | Total | Gap before, ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const variant of variants) {
  for (const count of counts) {
    const results = resultsOf(variant, count)
    if (results.length === 0) continue
    const part = (pick: (timings: Timings) => Summary | undefined) => format(median(mediansOf(results, result => pick(result.backToBack))), 3)
    console.log(`| ${variant} | ${format(count)} | ${part(timings => timings.encodeAndSubmitMs)} | ${part(timings => timings.waitMs)} | ${part(timings => timings.copyMs)} | ${part(timings => timings.totalMs)} | ${part(timings => timings.gapMs)} |`)
    // display-all's second series, where every value of every readback is compared, which takes the gap shown.
    const compared = results.filter(result => result.everyValueCompared !== undefined)
    if (compared.length > 0) {
      const comparedPart = (pick: (timings: Timings) => Summary | undefined) => format(median(mediansOf(compared, result => pick(result.everyValueCompared!))), 3)
      console.log(`| ${variant}, every value compared | ${format(count)} | ${comparedPart(timings => timings.encodeAndSubmitMs)} | ${comparedPart(timings => timings.waitMs)} | ${comparedPart(timings => timings.copyMs)} | ${spread(mediansOf(compared, result => result.everyValueCompared!.totalMs))} | ${comparedPart(timings => timings.gapMs)} |`)
    }
  }
}

console.log('\nThe summary variant after idle, with a timestamp query: total ms and compute pass ms, median of the runs\' medians:\n')
console.log(`| Documents | Back to back: total, pass | ${idleGaps.map(gap => `${format(gap)} ms idle: total, pass`).join(' | ')} | ${first.results[0]!.afterIdleWithKeepWarm === undefined ? '' : `${format(first.results[0]!.afterIdleWithKeepWarm.idleMs)} ms with a one-document dispatch every 16 ms: total |`}`)
console.log(`| --- | --- | ${idleGaps.map(() => '---').join(' | ')} | --- |`)
for (const count of counts) {
  const results = resultsOf('summary', count)
  if (results.length === 0) continue
  const pair = (pick: (result: GpuResult) => Timings | undefined) => {
    const totals = mediansOf(results, result => pick(result)?.totalMs)
    const passes = mediansOf(results, result => pick(result)?.passMs)
    return totals.length === 0 ? '' : `${format(median(totals), 2)}, ${passes.length === 0 ? '' : format(median(passes), 2)}`
  }
  console.log(`| ${format(count)} | ${pair(result => result.withTimestamps)} | ${idleGaps.map(gap => pair(result => result.afterIdleWithTimestamps?.find(entry => entry.idleMs === gap))).join(' | ')} | ${spread(mediansOf(results, result => result.afterIdleWithKeepWarm?.totalMs))} |`)
}

console.log('\nOne evaluation that writes every document\'s cells in JavaScript and uploads them, ms:\n')
console.log('| Variant | Documents | MB uploaded | MB read back | Writing the cells in JavaScript | writeBuffer call | Submit to mapped | Copy out | Total with the cells |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const variant of variants) {
  for (const count of counts) {
    const results = resultsOf(variant, count).filter(result => result.withUpload !== undefined)
    if (results.length === 0) continue
    const part = (pick: (timings: Timings) => Summary | undefined) => spread(mediansOf(results, result => pick(result.withUpload!)))
    console.log(`| ${variant} | ${format(count)} | ${format(results[0]!.megabytesOfCells, 2)} | ${format(results[0]!.megabytesReadBack, 3)} | ${part(timings => timings.cellsMs)} | ${part(timings => timings.uploadMs)} | ${part(timings => timings.waitMs)} | ${part(timings => timings.copyMs)} | ${part(timings => timings.totalWithCellsMs)} |`)
  }
}
console.log(`\nThe first load, i.e. uploading ${format(first.firstLoad.megabytesUploaded, 1)} MB of cells and the first evaluation of ${format(first.firstLoad.documents)} documents: ${spread(pages.map(page => page.firstLoad.uploadAndFirstEvaluationMs))} ms.`)
console.log(`The self check over ${format(first.selfCheck.documents)} documents: executor ${spread(pages.map(page => page.selfCheck.cpuMs))} ms, GPU ${spread(pages.map(page => page.selfCheck.gpuMs))} ms, mismatches ${pages.map(page => page.selfCheck.mismatches).join(', ')}.`)

// The crossover: the document count where a GPU series takes as long as a CPU baseline, interpolated linearly between
// the two neighboring measured counts. The baseline's µs per document at a count without its own measurement comes
// from the nearest measured count.
type Series = {name: string, variant: string, pick: (result: GpuResult) => Summary | undefined}
const series: Series[] = [
  {name: 'summary, back to back', variant: 'summary', pick: result => result.backToBack.totalMs},
  {name: 'summary, after 16 ms idle', variant: 'summary', pick: result => idleAt(result, 16)?.totalMs},
  {name: 'summary, after 1,000 ms idle', variant: 'summary', pick: result => idleAt(result, 1000)?.totalMs},
  {name: 'summary, with upload', variant: 'summary', pick: result => result.withUpload?.totalWithCellsMs},
  {name: 'display-window, back to back', variant: 'display-window', pick: result => result.backToBack.totalMs},
  {name: 'display-window, after 16 ms idle', variant: 'display-window', pick: result => idleAt(result, 16)?.totalMs},
  {name: 'display-window, after 1,000 ms idle', variant: 'display-window', pick: result => idleAt(result, 1000)?.totalMs},
  {name: 'display-all, back to back', variant: 'display-all', pick: result => result.backToBack.totalMs},
  {name: 'display-all, with upload', variant: 'display-all', pick: result => result.withUpload?.totalWithCellsMs},
]
const nearestCount = (count: number) => counts.reduce((best, candidate) => Math.abs(Math.log(candidate / count)) < Math.abs(Math.log(best / count)) ? candidate : best)
type Point = {count: number, gpu: number, cpu: number}
// The count from which the GPU is faster at every larger measured count, or which end of the measured counts it lies
// past.
function crossoverCount(points: readonly Point[]): {count: number, below: number, above: number} | 'never' | 'always' | undefined {
  if (points.length === 0) return undefined
  let from: number | undefined
  for (let index = points.length - 1; index >= 0 && points[index]!.gpu < points[index]!.cpu; index--) from = index
  if (from === undefined) return 'never'
  if (from === 0) return 'always'
  const below = points[from - 1]!
  const above = points[from]!
  const differenceBelow = below.gpu - below.cpu
  const differenceAbove = above.gpu - above.cpu
  return {count: Number((below.count + (above.count - below.count) * differenceBelow / (differenceBelow - differenceAbove)).toPrecision(2)), below: below.count, above: above.count}
}
function crossover(points: readonly Point[]) {
  const found = crossoverCount(points)
  if (found === undefined) return 'not measured'
  if (found === 'never') return `slower up to ${format(points.at(-1)!.count)}`
  if (found === 'always') return `faster from ${format(points[0]!.count)}, the smallest count measured`
  return `about ${format(found.count)}, between ${format(found.below)} and ${format(found.above)}`
}
// One cell of the short table: the crossover of the runs' medians, and the range of the runs' own crossovers.
function crossoverCell(points: readonly Point[], perRun: readonly (readonly Point[])[]) {
  const found = crossoverCount(points)
  if (found === undefined) return ''
  if (found === 'never') return `slower up to ${format(points.at(-1)!.count)}`
  if (found === 'always') return `below ${format(points[0]!.count)}`
  const counts = perRun.map(crossoverCount).map(entry => typeof entry === 'object' ? entry.count : undefined)
  const numeric = defined(counts)
  return numeric.length === counts.length && numeric.length > 1 ? `${format(found.count)} (${format(Math.min(...numeric))} to ${format(Math.max(...numeric))})` : format(found.count)
}
const pointsOf = (entry: Series, key: typeof baselines[number]['key']) => {
  const seriesCounts = [...new Set(first.results.filter(result => result.variant === entry.variant && entry.pick(result) !== undefined).map(result => result.count))].sort((left, right) => left - right)
  return {
    points: seriesCounts.map(count => ({count, gpu: median(mediansOf(resultsOf(entry.variant, count), entry.pick)), cpu: median(cpuMicroseconds(key, nearestCount(count))) * count / 1000})),
    perRun: pages.map(page => seriesCounts.flatMap(count => {
      const gpu = entry.pick(page.results.find(result => result.variant === entry.variant && result.count === count)!)?.median
      return gpu === undefined ? [] : [{count, gpu, cpu: page.cpu.byCount.find(cpuEntry => cpuEntry.count === nearestCount(count))![key].microsecondsPerDocument * count / 1000}]
    })),
  }
}
// The short table: one row per GPU series, one column per kind of baseline. The summary variant is compared with the
// summary programs on the CPU, and the display variants with the display programs.
const columns: {name: string, keyOf: (variant: string) => typeof baselines[number]['key'] | undefined}[] = [
  {name: 'JSON.parse', keyOf: variant => variant === 'summary' ? 'jsonParse' : undefined},
  {name: 'table loop', keyOf: () => 'tableLoop'},
  {name: 'reference.ts', keyOf: () => 'reference'},
  {name: 'generated JavaScript, extrapolated', keyOf: variant => variant === 'summary' ? 'generatedJsSummary' : 'generatedJsDisplay'},
  {name: 'executor, extrapolated', keyOf: variant => variant === 'summary' ? 'executorSummary' : 'executorDisplay'},
]
console.log('\nThe document count from which the GPU takes less time, median of the runs (range of the runs):\n')
console.log(`| GPU series | ${columns.map(column => column.name).join(' | ')} |`)
console.log(`| --- | ${columns.map(() => '---').join(' | ')} |`)
for (const entry of series) {
  console.log(`| ${entry.name} | ${columns.map(column => {
    const key = column.keyOf(entry.variant)
    if (key === undefined) return ''
    const {points, perRun} = pointsOf(entry, key)
    return crossoverCell(points, perRun)
  }).join(' | ')} |`)
}

console.log('\n| GPU series | CPU baseline | GPU faster from, documents, median of the runs | Per run | GPU ms / CPU ms at each count |')
console.log('| --- | --- | --- | --- | --- |')
for (const entry of series) {
  for (const key of baselinesOfVariant[entry.variant]!) {
    const baseline = baselines.find(candidate => candidate.key === key)!
    const {points, perRun} = pointsOf(entry, key)
    console.log(`| ${entry.name} | ${baseline.name}${baseline.sampled ? ', extrapolated' : ''} | ${crossover(points)} | ${perRun.map(crossover).join('; ')} | ${points.map(point => `${format(point.count)}: ${format(point.gpu, digitsFor(point.gpu))} / ${format(point.cpu, digitsFor(point.cpu))}`).join(', ')} |`)
  }
}

console.log('\nBack to back at every measured count of the summary variant, ms:\n')
const everyCount = [...new Set(first.results.filter(result => result.variant === 'summary').map(result => result.count))].sort((left, right) => left - right)
console.log(`| Documents | ${everyCount.map(count => format(count)).join(' | ')} |`)
console.log(`| --- | ${everyCount.map(() => '---').join(' | ')} |`)
console.log(`| Total | ${everyCount.map(count => spread(mediansOf(resultsOf('summary', count), result => result.backToBack.totalMs))).join(' | ')} |`)
console.log(`| Compute pass | ${everyCount.map(count => spread(mediansOf(resultsOf('summary', count), result => result.withTimestamps?.passMs))).join(' | ')} |`)

console.log('\n| Run | Readbacks compared | Values compared | Mismatched values | Test texts on the GPU: values, mismatched |')
console.log('| --- | --- | --- | --- | --- |')
pages.forEach((page, index) => {
  const total = (pick: (result: GpuResult) => number) => page.results.reduce((sum, result) => sum + pick(result), 0)
  console.log(`| ${index + 1} | ${format(total(result => result.checks.readbacks))} | ${format(total(result => result.checks.values))} | ${format(total(result => result.checks.mismatches) + page.firstLoad.mismatches)} | ${page.compile.programs.map(program => `${program.rootSet} ${format(program.corpusCheck.values)}, ${program.corpusCheck.mismatches}`).join('; ')} |`)
})

if (checkRuns.length > 0) {
  console.log('\n| Outputs | Guard | WGSL statements | WGSL bytes | Guards | Compile shader ms | Test texts: values, mismatched | Generated documents: documents, values, mismatched | Summary back to back ms |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of checkRuns) {
    for (const result of run.page.results) {
      console.log(`| ${result.rootSet} | ${result.guard} | ${format(result.statements)} | ${format(result.shaderBytes)} | ${format(result.guards)} | ${format(result.compileMs)} | ${format(result.corpusCheck.values)}, ${result.corpusCheck.mismatches} | ${format(result.generatedCheck.documents)}, ${format(result.generatedCheck.values)}, ${result.generatedCheck.mismatches} | ${format(result.summaryBackToBackMs.median, 2)} (${format(result.summaryBackToBackMs.min, 2)} to ${format(result.summaryBackToBackMs.max, 2)}) |`)
    }
  }
}
