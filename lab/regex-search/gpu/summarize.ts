// Prints markdown tables from run.ts's and cpu-time.ts's raw results:
//   bun lab/regex-search/gpu/summarize.ts --gpu <main run .json, comma-separated> [--frames <frames run .json>] [--checks <check run .json>]
//     --cpu <.jsonl files, comma-separated>
// Where a table combines several runs or processes, it shows the median of their medians, and their range in parentheses.
// The median of an even count is the mean of the two middle values. When several --cpu files have records of the same
// variant and size, only the last file's records count, so a rerun replaces an earlier batch.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}
type Timings = Record<'leafMs' | 'uploadMs' | 'encodeAndSubmitMs' | 'waitMs' | 'copyMs' | 'totalMs' | 'totalWithLeavesMs' | 'passMs', Summary | undefined>
type Checks = Record<string, {readbacks: number, mismatchedPositions: number}>
type MainResult = {
  states: number, textLength: number, kernel: string, levels: number, leafMegabytes: number,
  readback: Timings, noReadback: Timings, passTimestamps: Timings, uploadOnly: Timings,
  // Runs before the gather input was added don't have it.
  gather?: {readback: Timings, passTimestamps: Timings, uploadOnly: Timings},
  levelBreakdown: {levels: {matrixCount: number, vectorCount: number, medianMs: number}[], packMs: Summary, passSumMs: Summary},
  denseReachInPageMicroseconds: {median: number}, checks: Checks,
}
type FramesResult = {states: number, textLength: number, input?: string, frameCount: number, callbackIntervalMs: Summary, arrivalMs: Summary, framesUntilDrawn: {framesUntilDrawn: number, evaluations: number}[], submitToDrawCallbackMs: Summary, checks: Checks}
type CheckResult = {states: number, textLength: number, cases: number, positions: number, positionsPastTheText: number, positionsWithHighestStateBit: number, mismatchedWithLeaves: number, mismatchedWithClasses: number, failures: unknown[]}
type CompileTime = {states: number, kernel: string, shaderSalt: number, matrixProductMs: number, vectorProductMs: number, packMs: number, gatherMs?: number}
type GpuRun = {driver: {loadBefore: string, loadAfter: string, startedAt: string, browser: string}, page: {results: unknown[], compileTimes: CompileTime[], crossOriginIsolated: boolean, error?: string}}
type CpuRecord = {failed?: boolean, args: string[], killedFor?: string, variant: string, states: number, textLength: number, medianMicroseconds: number, loadBefore?: string, loadAfter?: string}

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
const spread = (values: readonly number[], digits: number) => values.length === 0 ? '' : values.length === 1 ? format(values[0]!, digits) : `${format(median(values), digits)} (${format(Math.min(...values), digits)} to ${format(Math.max(...values), digits)})`
const key = (states: number, textLength: number) => `${states}/${textLength}`
const statesOf = (entryKey: string) => Number(entryKey.split('/')[0])
const lengthOf = (entryKey: string) => Number(entryKey.split('/')[1])
const pushTo = <Value>(map: Map<string, Value[]>, entryKey: string, value: Value) => {
  const list = map.get(entryKey)
  if (list === undefined) map.set(entryKey, [value])
  else list.push(value)
}

const gpuRuns = files('--gpu').map(path => JSON.parse(readFileSync(path, 'utf8')) as GpuRun)
const framesRuns = files('--frames').map(path => JSON.parse(readFileSync(path, 'utf8')) as GpuRun)
const checkRuns = files('--checks').map(path => JSON.parse(readFileSync(path, 'utf8')) as GpuRun)
const cpuFiles = files('--cpu').map(path => ({path, records: readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CpuRecord)}))

for (const run of [...gpuRuns, ...framesRuns, ...checkRuns]) {
  console.log(`- ${run.driver.startedAt}, ${run.driver.browser}, cross-origin isolated ${run.page.crossOriginIsolated}, load before ${run.driver.loadBefore}, after ${run.driver.loadAfter}${run.page.error === undefined ? '' : `, error ${run.page.error}`}`)
}
for (const {path, records} of cpuFiles) {
  for (const record of records.filter(entry => entry.failed === true)) console.log(`- failed in ${path}: ${record.args.join(' ')}, ${record.killedFor ?? 'nonzero exit'}`)
}

const gpuByKey = new Map<string, MainResult[]>()
for (const run of gpuRuns) for (const result of run.page.results as MainResult[]) pushTo(gpuByKey, key(result.states, result.textLength), result)
const cpuByVariant = new Map<string, Map<string, number[]>>()
const cpuLoads = new Map<string, string[]>()
for (const {records} of cpuFiles) {
  const fromThisFile = new Map<string, Map<string, CpuRecord[]>>()
  for (const record of records.filter(entry => entry.failed !== true)) {
    let byKey = fromThisFile.get(record.variant)
    if (byKey === undefined) fromThisFile.set(record.variant, byKey = new Map<string, CpuRecord[]>())
    pushTo(byKey, key(record.states, record.textLength), record)
  }
  for (const [variant, byKey] of fromThisFile) {
    let merged = cpuByVariant.get(variant)
    if (merged === undefined) cpuByVariant.set(variant, merged = new Map<string, number[]>())
    for (const [entryKey, list] of byKey) {
      merged.set(entryKey, list.map(record => record.medianMicroseconds))
      cpuLoads.set(`${variant}/${entryKey}`, list.flatMap(record => [record.loadBefore, record.loadAfter]).filter(load => load !== undefined).map(load => load.split(' ')[1]!))
    }
  }
}
// The same dense loop as js-dense, timed inside the GPU page in Chrome, once per run.
const inPageVariant = 'js-dense in the page'
for (const [entryKey, results] of gpuByKey) {
  let byKey = cpuByVariant.get(inPageVariant)
  if (byKey === undefined) cpuByVariant.set(inPageVariant, byKey = new Map<string, number[]>())
  byKey.set(entryKey, results.map(result => result.denseReachInPageMicroseconds.median))
}
const variants = [...cpuByVariant.keys()]
const allKeys = [...gpuByKey.keys(), ...[...cpuByVariant.values()].flatMap(byKey => [...byKey.keys()])]
const lengths = [...new Set(allKeys.map(lengthOf))].sort((left, right) => left - right)
const statesList = [...new Set(allKeys.map(statesOf))].sort((left, right) => left - right)
const medians = (results: readonly MainResult[], pick: (result: MainResult) => Summary | undefined) => results.map(result => pick(result)?.median).filter(value => value !== undefined)
const checkText = (checks: Checks[]) => {
  const entries = checks.flatMap(entry => Object.entries(entry))
  return [...new Set(entries.map(([name]) => name))].map(name => {
    const counts = entries.filter(([entryName]) => entryName === name).map(([, count]) => count)
    return `${name} ${format(counts.reduce((total, count) => total + count.readbacks, 0))}, ${format(counts.reduce((total, count) => total + count.mismatchedPositions, 0))}`
  }).join('; ')
}

console.log('\n| S | N | Runs | Levels | Leaves MB | With readback ms | Without readback ms | GPU pass ms, timestamps | Upload only ms | Leaf writing in JS ms | With readback and leaf writing ms | Readbacks checked, mismatched positions |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const states of statesList) {
  for (const textLength of lengths) {
    const results = gpuByKey.get(key(states, textLength))
    if (results === undefined) continue
    const first = results[0]!
    console.log(`| ${states} | ${format(textLength)} | ${results.length} | ${first.levels} | ${format(first.leafMegabytes, 1)} | ${spread(medians(results, result => result.readback.totalMs), 2)} | ${spread(medians(results, result => result.noReadback.totalMs), 2)} | ${spread(medians(results, result => result.passTimestamps.passMs), 2)} | ${spread(medians(results, result => result.uploadOnly.totalMs), 2)} | ${spread(medians(results, result => result.readback.leafMs), 2)} | ${spread(medians(results, result => result.readback.totalWithLeavesMs), 2)} | ${checkText(results.map(result => result.checks))} |`)
  }
}

// "Uploaded minus gathered" estimates what uploading the leaves costs, without writing them in JavaScript: both inputs run
// the same levels, and the gather adds one small upload and one dispatch. The upload-only figure doesn't add up with the
// pass, since its onSubmittedWorkDone waits about as long as a whole evaluation.
const gathered = (results: readonly MainResult[]) => results.filter(result => result.gather !== undefined)
console.log('\n| S | N | Runs | Gathered on the GPU: with readback ms | GPU pass ms, timestamps | Upload only ms | Class copy in JS ms | With readback and class copy ms | Uploaded leaves minus gathered leaves, with readback, same run, ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const states of statesList) {
  for (const textLength of lengths) {
    const results = gathered(gpuByKey.get(key(states, textLength)) ?? [])
    if (results.length === 0) continue
    const differences = results.map(result => result.readback.totalMs!.median - result.gather!.readback.totalMs!.median)
    console.log(`| ${states} | ${format(textLength)} | ${results.length} | ${spread(medians(results, result => result.gather!.readback.totalMs), 2)} | ${spread(medians(results, result => result.gather!.passTimestamps.passMs), 2)} | ${spread(medians(results, result => result.gather!.uploadOnly.totalMs), 2)} | ${spread(medians(results, result => result.gather!.readback.leafMs), 3)} | ${spread(medians(results, result => result.gather!.readback.totalWithLeavesMs), 2)} | ${spread(differences, 2)} |`)
  }
}

console.log(`\n| S | N | ${variants.map(variant => `${variant} µs`).join(' | ')} |`)
console.log(`| --- | --- | ${variants.map(() => '---').join(' | ')} |`)
for (const states of statesList) {
  for (const textLength of lengths) {
    const cells = variants.map(variant => spread(cpuByVariant.get(variant)!.get(key(states, textLength)) ?? [], 0))
    if (cells.every(cell => cell === '')) continue
    console.log(`| ${states} | ${format(textLength)} | ${cells.join(' | ')} |`)
  }
}
console.log('\nLoad average over 1 minute, before and after each CPU process, per variant: min to max')
for (const variant of variants.filter(name => name !== inPageVariant)) {
  const loads = [...cpuLoads.entries()].filter(([entryKey]) => entryKey.startsWith(`${variant}/`)).flatMap(([, list]) => list.map(Number))
  if (loads.length > 0) console.log(`- ${variant}: ${format(Math.min(...loads), 2)} to ${format(Math.max(...loads), 2)}`)
}

// The crossover: the smallest measured length from which the GPU, with readback and the JavaScript work before the upload,
// is faster than a CPU variant at that length and every larger one. A variant measured only up to some length is
// extrapolated linearly from its µs per code point at its largest measured length, since the programs' cost follows their
// operations. tree-ends isn't compared: form (c)'s program computes the integer longest ends, and the GPU only the reach
// bits, which form (a)'s reverse pass computes.
const gpuInputs = [
  {name: 'leaves uploaded', pick: (result: MainResult) => result.readback.totalWithLeavesMs},
  {name: 'gathered on the GPU', pick: (result: MainResult) => result.gather?.readback.totalWithLeavesMs},
]
const crossoverVariants = variants.filter(variant => variant !== 'tree-ends')
type Comparison = {length: number, gpu: number, cpu: number, extrapolated: boolean}
const cpuAt = (variant: string, states: number, length: number) => {
  const byKey = cpuByVariant.get(variant)!
  const values = byKey.get(key(states, length))
  if (values !== undefined) return {cpu: median(values) / 1000, extrapolated: false}
  const largest = lengths.filter(entry => byKey.has(key(states, entry))).at(-1)
  return largest === undefined ? undefined : {cpu: median(byKey.get(key(states, largest))!) / 1000 * length / largest, extrapolated: true}
}
const fromText = (comparisons: readonly Comparison[]) => {
  let from: number | undefined
  for (let index = comparisons.length - 1; index >= 0 && comparisons[index]!.gpu < comparisons[index]!.cpu; index--) from = comparisons[index]!.length
  if (from === undefined) return `slower at every N up to ${format(comparisons.at(-1)!.length)}`
  const index = comparisons.findIndex(comparison => comparison.length === from)
  return index === 0 ? `faster at every N from ${format(from)}` : `${format(from)}, slower at ${format(comparisons[index - 1]!.length)}`
}
console.log('\n| S | GPU input | CPU variant | GPU faster from N, median of runs | Per run | GPU ms / CPU ms at each N |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const states of statesList) {
  for (const gpuInput of gpuInputs) {
    const gpuLengths = lengths.filter(length => medians(gpuByKey.get(key(states, length)) ?? [], gpuInput.pick).length > 0)
    if (gpuLengths.length === 0) continue
    for (const variant of crossoverVariants) {
      if (cpuAt(variant, states, gpuLengths[0]!) === undefined) continue
      const comparisons = gpuLengths.map(length => ({length, gpu: median(medians(gpuByKey.get(key(states, length))!, gpuInput.pick)), ...cpuAt(variant, states, length)!}))
      const perRun = gpuRuns.map(run => {
        const results = (run.page.results as MainResult[]).filter(result => result.states === states && gpuInput.pick(result) !== undefined)
        return results.length === 0 ? undefined : fromText(results.map(result => ({length: result.textLength, gpu: gpuInput.pick(result)!.median, ...cpuAt(variant, states, result.textLength)!})))
      }).filter(text => text !== undefined)
      console.log(`| ${states} | ${gpuInput.name} | ${variant} | ${fromText(comparisons)} | ${perRun.join('; ')} | ${comparisons.map(comparison => `${format(comparison.length)}: ${format(comparison.gpu, 2)} / ${format(comparison.cpu, 2)}${comparison.extrapolated ? ' (extrapolated)' : ''}`).join(', ')} |`)
    }
  }
}

console.log('\n| S | Kernel | Salt | Matrix product ms | Vector product ms | Pack ms | Gather ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const run of [...gpuRuns, ...framesRuns, ...checkRuns]) {
  for (const time of run.page.compileTimes) console.log(`| ${time.states} | ${time.kernel} | ${time.shaderSalt} | ${format(time.matrixProductMs, 1)} | ${format(time.vectorProductMs, 1)} | ${format(time.packMs, 1)} | ${time.gatherMs === undefined ? '' : format(time.gatherMs, 1)} |`)
}

// One compute pass per level at the largest N of each S, from the first run. Levels of the upward pass have matrix
// products, and levels of the downward pass only products of a matrix with a vector.
console.log('\n| S | N | Levels with matrix products: count, ms | Levels with only vector products: count, ms | Pack ms | Sum of passes ms | One pass for everything ms | Smallest level ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
const firstRun = gpuRuns.length === 0 ? [] : gpuRuns[0]!.page.results as MainResult[]
for (const states of statesList) {
  const result = firstRun.filter(entry => entry.states === states).at(-1)
  if (result === undefined) continue
  const levels = result.levelBreakdown.levels
  const withMatrices = levels.filter(level => level.matrixCount > 0)
  const vectorsOnly = levels.filter(level => level.matrixCount === 0)
  const total = (list: typeof levels) => list.reduce((sum, level) => sum + level.medianMs, 0)
  console.log(`| ${states} | ${format(result.textLength)} | ${withMatrices.length}, ${format(total(withMatrices), 2)} | ${vectorsOnly.length}, ${format(total(vectorsOnly), 2)} | ${format(result.levelBreakdown.packMs.median, 3)} | ${format(result.levelBreakdown.passSumMs.median, 2)} | ${spread(medians([result], entry => entry.passTimestamps.passMs), 2)} | ${format(Math.min(...levels.map(level => level.medianMs)), 3)} |`)
}

if (framesRuns.length > 0) {
  console.log('\n| S | N | GPU input | Evaluations | rAF callback interval ms | Result arrives after the submitting callback ms, median (p90, max) | Frames from submit to the callback that can draw it: evaluations | Submit to that callback ms, median (max) | Mismatched positions |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of framesRuns) {
    for (const result of run.page.results as FramesResult[]) {
      const mismatched = Object.values(result.checks).reduce((total, count) => total + count.mismatchedPositions, 0)
      console.log(`| ${result.states} | ${format(result.textLength)} | ${result.input ?? 'leaves'} | ${result.frameCount} | ${format(result.callbackIntervalMs.median, 1)} | ${format(result.arrivalMs.median, 2)} (${format(result.arrivalMs.p90, 2)}, ${format(result.arrivalMs.max, 2)}) | ${result.framesUntilDrawn.map(entry => `${entry.framesUntilDrawn}: ${entry.evaluations}`).join(', ')} | ${format(result.submitToDrawCallbackMs.median, 1)} (${format(result.submitToDrawCallbackMs.max, 1)}) | ${mismatched} |`)
    }
  }
}

if (checkRuns.length > 0) {
  console.log('\n| S | N | Cases | Positions | Positions past the text | Positions with bit S − 1 set | Mismatched positions, uploaded leaves | Mismatched positions, gathered leaves | Failures kept |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of checkRuns) {
    for (const result of run.page.results as CheckResult[]) {
      console.log(`| ${result.states} | ${format(result.textLength)} | ${format(result.cases)} | ${format(result.positions)} | ${format(result.positionsPastTheText)} | ${format(result.positionsWithHighestStateBit)} | ${format(result.mismatchedWithLeaves)} | ${format(result.mismatchedWithClasses)} | ${result.failures.length} |`)
    }
  }
}
