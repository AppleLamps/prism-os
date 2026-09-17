// Prints markdown tables from run.ts's and cpu-time.ts's raw results:
//   bun lab/knuth-plass/gpu/summarize.ts --gpu <main run .json, comma-separated> [--checks <check run .json>] --cpu <.jsonl files, comma-separated>
// Where a table combines several runs or processes, it shows the median of their medians, and their range in parentheses.
// The median of an even count is the mean of the two middle values. When several --cpu files have records of the same
// variant and size, only the last file's records count, so a rerun replaces an earlier batch.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}
type Timings = Record<'jsMs' | 'uploadMs' | 'encodeAndSubmitMs' | 'waitMs' | 'copyMs' | 'backtrackMs' | 'totalMs' | 'totalWithJsMs' | 'passMs', Summary | undefined>
type Input = 'line-costs' | 'positions' | 'widths'
type Stages = {leavesAndFirstStateMs: number, levels: {matrixCount: number, vectorCount: number, medianMs: number}[], pointersMs: number, sumMs: Summary}
type GpuResult = {
  kind: 'gpu', breaks: number, window: number, paragraphs: number, kernel: string, skipped?: string,
  levels: number, matrixProducts: number, vectorProducts: number, matrixMegabytes: number, lineCostMegabytes: number, positionMegabytes: number,
  // A run with --inputs measures only some inputs.
  prepareMs: number, firstEvaluationMs: number, inputs: Partial<Record<Input, {readback: Timings, pass: Timings}>>, stages?: Stages,
  checks: {readbacks: number, mismatchedValues: number, breakChecks: number, mismatchedBreaks: number},
}
type CpuInPage = {kind: 'cpu-in-page', breaks: number, window: number, paragraphs: number, referenceMicroseconds: {median: number}, typedMicroseconds: {median: number}}
type CheckResult = {kernel: string, window: number, breaks: number, batches: number, paragraphs: number, evaluations: number, comparedValues: number, mismatchedValues: number, mismatchedBreaks: number, paragraphsWithTies: number, paragraphsWithTotalsPast2To22: number}
type CompileTime = {kernel: string, window: number, shaderSalt: number} & Record<string, number>
type GpuRun = {driver: {loadBefore: string, loadAfter: string, startedAt: string, finishedAt?: string, browser: string, busiestBefore?: string[], busiestAfter?: string[]}, page: {results: unknown[], compileTimes: CompileTime[], crossOriginIsolated: boolean, error?: string, deviceLost?: string}}
type CpuRecord = {failed?: boolean, args: string[], killedFor?: string, stderr?: string, variant: string, breaks: number, window: number, paragraphs: number, medianMilliseconds: number, loadBefore?: string, loadAfter?: string, maxRssMegabytes?: number, buildMs?: number, compileMs?: number}

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
const digitsFor = (value: number) => value < 0.1 ? 3 : value < 10 ? 2 : value < 100 ? 1 : 0
const spread = (values: readonly number[]) => {
  if (values.length === 0) return ''
  const middle = median(values)
  const digits = digitsFor(middle)
  return values.length === 1 ? format(values[0]!, digits) : `${format(middle, digits)} (${format(Math.min(...values), digits)} to ${format(Math.max(...values), digits)})`
}
const sizeKey = (breaks: number, window: number, paragraphs: number) => `${breaks}/${window}/${paragraphs}`
const pushTo = <Value>(map: Map<string, Value[]>, entryKey: string, value: Value) => {
  const list = map.get(entryKey)
  if (list === undefined) map.set(entryKey, [value])
  else list.push(value)
}
const firstLoad = (load: string | undefined) => load === undefined ? undefined : Number(load.replace(/[{}]/g, '').trim().split(/\s+/)[0])

const gpuRuns = files('--gpu').map(path => JSON.parse(readFileSync(path, 'utf8')) as GpuRun)
const checkRuns = files('--checks').map(path => JSON.parse(readFileSync(path, 'utf8')) as GpuRun)
const cpuFiles = files('--cpu').map(path => ({path, records: readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CpuRecord)}))

console.log('Runs:')
for (const run of [...gpuRuns, ...checkRuns]) {
  console.log(`- ${run.driver.startedAt} to ${run.driver.finishedAt}, ${run.driver.browser}, cross-origin isolated ${run.page.crossOriginIsolated}, load before ${run.driver.loadBefore}, after ${run.driver.loadAfter}${run.page.error === undefined ? '' : `, error ${run.page.error}`}${run.page.deviceLost === undefined ? '' : `, device lost ${run.page.deviceLost}`}`)
  const busiest = (lines: string[] | undefined) => lines?.slice(1, 5).map(line => {
    const [cpu, rss, ...command] = line.trim().split(/\s+/)
    return `${command.join(' ').split('/').at(-1)} ${cpu}% ${format(Number(rss) / 1024)} MB`
  }).join('; ')
  if (run.driver.busiestBefore !== undefined) console.log(`  busiest before: ${busiest(run.driver.busiestBefore)}; after: ${busiest(run.driver.busiestAfter)}`)
}
for (const {path, records} of cpuFiles) {
  for (const record of records.filter(entry => entry.failed === true)) console.log(`- failed in ${path}: ${record.args.join(' ')}, ${record.killedFor ?? 'nonzero exit'}: ${record.stderr?.split('\n').find(line => line.startsWith('error:')) ?? ''}`)
}

// GPU results by size and kernel, and the page's CPU timings by size.
const gpuByKey = new Map<string, GpuResult[]>()
const inPage = new Map<string, CpuInPage[]>()
for (const run of gpuRuns) {
  for (const result of run.page.results as (GpuResult | CpuInPage)[]) {
    if (result.kind === 'cpu-in-page') pushTo(inPage, sizeKey(result.breaks, result.window, result.paragraphs), result)
    else if (result.skipped === undefined) pushTo(gpuByKey, `${sizeKey(result.breaks, result.window, result.paragraphs)}/${result.kernel}`, result)
  }
}
const skipped = [...new Set(gpuRuns.flatMap(run => (run.page.results as (GpuResult | CpuInPage)[]).flatMap(result => result.kind === 'gpu' && result.skipped !== undefined ? [`${result.kernel} at n = ${result.breaks}, W = ${result.window}, P = ${result.paragraphs}: ${result.skipped}`] : [])))]
for (const line of skipped) console.log(`- skipped ${line}`)

// CPU variants in ms per batch: Bun processes, and the page's loops.
const cpuMs = new Map<string, Map<string, number[]>>()
const cpuLoads = new Map<string, number[]>()
for (const {records} of cpuFiles) {
  const fromThisFile = new Map<string, Map<string, CpuRecord[]>>()
  for (const record of records.filter(entry => entry.failed !== true)) {
    let byKey = fromThisFile.get(record.variant)
    if (byKey === undefined) fromThisFile.set(record.variant, byKey = new Map<string, CpuRecord[]>())
    pushTo(byKey, sizeKey(record.breaks, record.window, record.paragraphs), record)
  }
  for (const [variant, byKey] of fromThisFile) {
    const name = `${variant} in Bun`
    let merged = cpuMs.get(name)
    if (merged === undefined) cpuMs.set(name, merged = new Map<string, number[]>())
    for (const [entryKey, list] of byKey) {
      merged.set(entryKey, list.map(record => record.medianMilliseconds))
      cpuLoads.set(`${name}/${entryKey}`, list.flatMap(record => [firstLoad(record.loadBefore), firstLoad(record.loadAfter)]).filter(load => load !== undefined))
    }
  }
}
for (const [variant, pick] of [['reference in the page', (entry: CpuInPage) => entry.referenceMicroseconds.median], ['typed in the page', (entry: CpuInPage) => entry.typedMicroseconds.median]] as const) {
  const byKey = new Map<string, number[]>()
  for (const [entryKey, list] of inPage) byKey.set(entryKey, list.map(entry => pick(entry) / 1000))
  cpuMs.set(variant, byKey)
}
const cpuVariants = [...cpuMs.keys()]
const kernels = [...new Set([...gpuByKey.values()].flatMap(list => list.map(result => result.kernel)))]
const inputs: Input[] = ['line-costs', 'positions', 'widths']
const gpuTotal = (results: readonly GpuResult[], input: Input) => results.map(result => result.inputs[input]?.readback.totalWithJsMs?.median).filter(value => value !== undefined)
const gpuPass = (results: readonly GpuResult[], input: Input) => results.map(result => result.inputs[input]?.pass.passMs?.median).filter(value => value !== undefined)
const allSizes = [...new Set([...gpuByKey.values()].flatMap(list => list.map(result => sizeKey(result.breaks, result.window, result.paragraphs))))].map(entry => entry.split('/').map(Number) as [number, number, number])
const singles = allSizes.filter(([, , paragraphs]) => paragraphs === 1).sort((left, right) => left[1] - right[1] || left[0] - right[0])
const batchBreaks = 256
const batches = allSizes.filter(([breaks]) => breaks === batchBreaks).sort((left, right) => left[1] - right[1] || left[2] - right[2])

const checkTotals = [...gpuByKey.values()].flat().reduce((totals, result) => ({readbacks: totals.readbacks + result.checks.readbacks, mismatchedValues: totals.mismatchedValues + result.checks.mismatchedValues, breakChecks: totals.breakChecks + result.checks.breakChecks, mismatchedBreaks: totals.mismatchedBreaks + result.checks.mismatchedBreaks, values: totals.values + result.checks.readbacks * result.paragraphs * (result.breaks + 1)}), {readbacks: 0, mismatchedValues: 0, breakChecks: 0, mismatchedBreaks: 0, values: 0})
console.log(`\nMain runs: ${format(checkTotals.readbacks)} readbacks, ${format(checkTotals.values)} values compared, ${format(checkTotals.mismatchedValues)} mismatched; ${format(checkTotals.breakChecks)} paragraphs' breaks compared, ${format(checkTotals.mismatchedBreaks)} mismatched`)

if (checkRuns.length > 0) {
  console.log('\n| Kernel | W | Break counts | Paragraphs | Evaluations | Values compared | Mismatched values | Mismatched breaks | Paragraphs and widths with ties | Totals past 2^22 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const byGroup = new Map<string, CheckResult[]>()
  for (const run of checkRuns) for (const result of run.page.results as CheckResult[]) pushTo(byGroup, `${result.kernel}/${result.window}`, result)
  for (const [group, list] of byGroup) {
    const [kernel, window] = group.split('/')
    const sum = (pick: (result: CheckResult) => number) => format(list.reduce((total, result) => total + pick(result), 0))
    console.log(`| ${kernel} | ${window} | ${list.map(result => result.breaks).join(', ')} | ${sum(result => result.paragraphs)} | ${sum(result => result.evaluations)} | ${sum(result => result.comparedValues)} | ${sum(result => result.mismatchedValues)} | ${sum(result => result.mismatchedBreaks)} | ${sum(result => result.paragraphsWithTies)} | ${sum(result => result.paragraphsWithTotalsPast2To22)} |`)
  }
}

console.log(`\nGPU, ms per evaluation including JavaScript's work before the upload, with readback and backtracking:`)
console.log(`\n| n | W | P | Kernel | Runs | Levels | Matrix products per paragraph | Matrices MB | ${inputs.map(input => `${input} ms`).join(' | ')} | Compute pass ms, positions | First evaluation ms |`)
console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | ${inputs.map(() => '---').join(' | ')} | --- | --- |`)
for (const [breaks, window, paragraphs] of [...singles, ...batches.filter(([, , count]) => count > 1)]) {
  for (const kernel of kernels) {
    const results = gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`)
    if (results === undefined) continue
    const first = results[0]!
    console.log(`| ${format(breaks)} | ${window} | ${format(paragraphs)} | ${kernel} | ${results.length} | ${first.levels} | ${format(first.matrixProducts)} | ${format(first.matrixMegabytes, digitsFor(first.matrixMegabytes))} | ${inputs.map(input => spread(gpuTotal(results, input))).join(' | ')} | ${spread(gpuPass(results, 'positions'))} | ${spread(results.map(result => result.firstEvaluationMs))} |`)
  }
}

console.log(`\nCPU, ms per batch: every paragraph's breaks and total cost:`)
console.log(`\n| n | W | P | ${cpuVariants.join(' | ')} |`)
console.log(`| --- | --- | --- | ${cpuVariants.map(() => '---').join(' | ')} |`)
const cpuSizes = [...new Set([...cpuMs.values()].flatMap(byKey => [...byKey.keys()]))].map(entry => entry.split('/').map(Number) as [number, number, number]).sort((left, right) => (left[2] === 1 ? 0 : 1) - (right[2] === 1 ? 0 : 1) || left[1] - right[1] || left[0] - right[0] || left[2] - right[2])
for (const [breaks, window, paragraphs] of cpuSizes) {
  console.log(`| ${format(breaks)} | ${window} | ${format(paragraphs)} | ${cpuVariants.map(variant => spread(cpuMs.get(variant)!.get(sizeKey(breaks, window, paragraphs)) ?? [])).join(' | ')} |`)
}
console.log('\nLoad average over 1 minute, before and after each CPU process, per variant: min to max')
for (const variant of cpuVariants.filter(name => name.endsWith('in Bun'))) {
  const loads = [...cpuLoads.entries()].filter(([entryKey]) => entryKey.startsWith(`${variant}/`)).flatMap(([, list]) => list)
  if (loads.length > 0) console.log(`- ${variant}: ${format(Math.min(...loads), 1)} to ${format(Math.max(...loads), 1)}`)
}

// Where the time goes, from the medians of each run.
console.log('\n| n | W | P | Kernel | Input | JavaScript before the upload ms | writeBuffer ms | Encode and submit ms | Submit to mapAsync ms | Copy ms | Backtracking ms | Total ms | Compute pass ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const [breaks, window, paragraphs] of [...singles, ...batches]) {
  if (!(paragraphs === 1 && breaks === 4096) && !(paragraphs >= 1000)) continue
  for (const kernel of kernels) {
    const results = gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`)
    if (results === undefined) continue
    for (const input of inputs) {
      const pick = (field: keyof Timings) => spread(results.map(result => result.inputs[input]?.readback[field]?.median).filter(value => value !== undefined))
      console.log(`| ${format(breaks)} | ${window} | ${format(paragraphs)} | ${kernel} | ${input} | ${pick('jsMs')} | ${pick('uploadMs')} | ${pick('encodeAndSubmitMs')} | ${pick('waitMs')} | ${pick('copyMs')} | ${pick('backtrackMs')} | ${pick('totalMs')} | ${spread(gpuPass(results, input))} |`)
    }
  }
}

// The crossover along one axis: the smallest measured value from which the GPU takes less time than the CPU variant, at
// that value and every larger measured value. "About" interpolates linearly between that value and the measured value
// below it. A CPU variant not measured at some value is extrapolated linearly from its largest measured value on the
// same axis, e.g. the chain past 1,000 paragraphs.
type Point = {at: number, gpu: number, cpu: number, extrapolated: boolean}
const crossoverText = (points: readonly Point[]) => {
  if (points.length === 0) return ''
  let from: number | undefined
  for (let index = points.length - 1; index >= 0 && points[index]!.gpu < points[index]!.cpu; index--) from = index
  if (from === undefined) return `slower at every measured value up to ${format(points.at(-1)!.at)}`
  if (from === 0) return `faster at every measured value from ${format(points[0]!.at)}`
  const low = points[from - 1]!
  const high = points[from]!
  const lowDifference = low.gpu - low.cpu
  const highDifference = high.gpu - high.cpu
  const about = low.at + (high.at - low.at) * lowDifference / (lowDifference - highDifference)
  return `from ${format(high.at)}, about ${format(about, about < 10 ? 1 : 0)}`
}
const cpuAt = (variant: string, breaks: number, window: number, paragraphs: number, axis: 'paragraphs' | 'breaks') => {
  const byKey = cpuMs.get(variant)!
  const values = byKey.get(sizeKey(breaks, window, paragraphs))
  if (values !== undefined) return {cpu: median(values), extrapolated: false}
  const measured = [...byKey.keys()].map(entry => entry.split('/').map(Number) as [number, number, number])
    .filter(([otherBreaks, otherWindow, otherParagraphs]) => otherWindow === window && (axis === 'paragraphs' ? otherBreaks === breaks : otherParagraphs === paragraphs))
    .sort((left, right) => axis === 'paragraphs' ? left[2] - right[2] : left[0] - right[0])
  const largest = measured.at(-1)
  if (largest === undefined) return undefined
  const scale = axis === 'paragraphs' ? paragraphs / largest[2] : breaks / largest[0]
  return {cpu: median(byKey.get(sizeKey(...largest))!) * scale, extrapolated: true}
}
for (const axis of ['paragraphs', 'breaks'] as const) {
  console.log(axis === 'paragraphs'
    ? `\nCrossover in paragraphs, at n = ${batchBreaks}, P = 1 is the one-paragraph size:`
    : '\nCrossover in break points, one paragraph:')
  console.log(`\n| W | Kernel | GPU input | CPU variant | GPU takes less time from ${axis === 'paragraphs' ? 'P' : 'n'}, median of runs | Per run | GPU ms / CPU ms at each ${axis === 'paragraphs' ? 'P' : 'n'} |`)
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  const sizes = axis === 'paragraphs' ? batches : singles
  for (const window of [...new Set(sizes.map(([, otherWindow]) => otherWindow))]) {
    for (const kernel of kernels) {
      for (const input of inputs) {
        for (const variant of cpuVariants) {
          const along = sizes.filter(([, otherWindow]) => otherWindow === window)
          const pointsFrom = (gpuOf: (results: GpuResult[]) => number | undefined) => along.flatMap(([breaks, , paragraphs]): Point[] => {
            const results = gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`)
            const cpu = cpuAt(variant, breaks, window, paragraphs, axis)
            const gpu = results === undefined ? undefined : gpuOf(results)
            return gpu === undefined || cpu === undefined ? [] : [{at: axis === 'paragraphs' ? paragraphs : breaks, gpu, ...cpu}]
          })
          const points = pointsFrom(results => {
            const values = gpuTotal(results, input)
            return values.length === 0 ? undefined : median(values)
          })
          if (points.length === 0) continue
          const perRun = gpuRuns.map((_, runIndex) => crossoverText(pointsFrom(results => results.length > runIndex ? results[runIndex]!.inputs[input]?.readback.totalWithJsMs?.median : undefined)))
          console.log(`| ${window} | ${kernel} | ${input} | ${variant} | ${crossoverText(points)} | ${perRun.join('; ')} | ${points.map(point => `${format(point.at)}: ${format(point.gpu, digitsFor(point.gpu))} / ${format(point.cpu, digitsFor(point.cpu))}${point.extrapolated ? ' (extrapolated)' : ''}`).join(', ')} |`)
        }
      }
    }
  }
}

console.log('\nCompile ms, from createShaderModule to createComputePipelineAsync resolving, median of runs (range):')
console.log('\n| Kernel | W | Matrix products | Matrix-vector products | Leaves from line costs | Leaves from positions | First state | Pointers |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
const compileGroups = new Map<string, CompileTime[]>()
for (const run of gpuRuns) for (const time of run.page.compileTimes) pushTo(compileGroups, `${time.kernel}/${time.window}`, time)
for (const [group, list] of compileGroups) {
  const [kernel, window] = group.split('/')
  const field = (name: string) => spread(list.map(time => time[name]!))
  console.log(`| ${kernel} | ${window} | ${field('matrixProductMs')} | ${field('vectorProductMs')} | ${field('leavesFromLineCostsMs')} | ${field('leavesFromPositionsMs')} | ${field('firstStateMs')} | ${field('pointerMs')} |`)
}

console.log('\nOne compute pass per stage, positions input, median of runs:')
console.log('\n| n | W | P | Kernel | Leaves and s[1] ms | Levels with matrix products: count, ms | Levels with only matrix-vector products: count, ms | Pointers ms | Sum of passes ms | One pass ms |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const [breaks, window, paragraphs] of [...singles, ...batches]) {
  if (!(paragraphs === 1 && breaks === 4096) && paragraphs !== 1000) continue
  for (const kernel of kernels) {
    const results = (gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`) ?? []).filter(result => result.stages !== undefined)
    if (results.length === 0) continue
    const withMatrices = (stages: Stages) => stages.levels.filter(level => level.matrixCount > 0)
    const vectorsOnly = (stages: Stages) => stages.levels.filter(level => level.matrixCount === 0)
    const total = (list: Stages['levels']) => list.reduce((sum, level) => sum + level.medianMs, 0)
    console.log(`| ${format(breaks)} | ${window} | ${format(paragraphs)} | ${kernel} | ${spread(results.map(result => result.stages!.leavesAndFirstStateMs))} | ${withMatrices(results[0]!.stages!).length}, ${spread(results.map(result => total(withMatrices(result.stages!))))} | ${vectorsOnly(results[0]!.stages!).length}, ${spread(results.map(result => total(vectorsOnly(result.stages!))))} | ${spread(results.map(result => result.stages!.pointersMs))} | ${spread(results.map(result => result.stages!.sumMs.median))} | ${spread(gpuPass(results, 'positions'))} |`)
  }
}

// The README's tables: the GPU with the dense-rows kernel and each input, and the full kernel with positions, next to every
// CPU variant. One paragraph: GPU in ms, CPU in µs. Batches: ms.
const readmeGpuColumns: {kernel: string, input: Input}[] = [{kernel: 'full', input: 'positions'}, {kernel: 'dense-rows', input: 'line-costs'}, {kernel: 'dense-rows', input: 'positions'}, {kernel: 'dense-rows', input: 'widths'}]
const scaledSpread = (values: readonly number[], scale: number) => spread(values.map(value => value * scale))
for (const [title, sizes, cpuScale] of [['One paragraph, GPU ms and CPU µs:', singles, 1000], [`Batches of ${batchBreaks} break points, ms:`, batches, 1]] as const) {
  console.log(`\nREADME: ${title}`)
  console.log(`\n| n | W | P | ${readmeGpuColumns.map(({kernel, input}) => `GPU, ${kernel}, ${input}`).join(' | ')} | ${cpuVariants.join(' | ')} |`)
  console.log(`| --- | --- | --- | ${readmeGpuColumns.map(() => '---').join(' | ')} | ${cpuVariants.map(() => '---').join(' | ')} |`)
  for (const [breaks, window, paragraphs] of sizes) {
    const gpuCells = readmeGpuColumns.map(({kernel, input}) => spread(gpuTotal(gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`) ?? [], input)))
    const cpuCells = cpuVariants.map(variant => scaledSpread(cpuMs.get(variant)!.get(sizeKey(breaks, window, paragraphs)) ?? [], cpuScale))
    console.log(`| ${format(breaks)} | ${window} | ${format(paragraphs)} | ${gpuCells.join(' | ')} | ${cpuCells.join(' | ')} |`)
  }
}
const shortText = (text: string) => text.replace('slower at every measured value up to', 'slower up to').replace('faster at every measured value from', 'faster from')
for (const axis of ['paragraphs', 'breaks'] as const) {
  const sizes = axis === 'paragraphs' ? batches : singles
  console.log(`\nREADME: crossover in ${axis === 'paragraphs' ? `paragraphs of ${batchBreaks} break points` : 'break points of one paragraph'}, median of runs:`)
  console.log(`\n| W | GPU | ${cpuVariants.join(' | ')} |`)
  console.log(`| --- | --- | ${cpuVariants.map(() => '---').join(' | ')} |`)
  for (const window of [...new Set(sizes.map(([, otherWindow]) => otherWindow))]) {
    for (const {kernel, input} of readmeGpuColumns) {
      const cells = cpuVariants.map(variant => {
        const points = sizes.filter(([, otherWindow]) => otherWindow === window).flatMap(([breaks, , paragraphs]): Point[] => {
          const values = gpuTotal(gpuByKey.get(`${sizeKey(breaks, window, paragraphs)}/${kernel}`) ?? [], input)
          const cpu = cpuAt(variant, breaks, window, paragraphs, axis)
          return values.length === 0 || cpu === undefined ? [] : [{at: axis === 'paragraphs' ? paragraphs : breaks, gpu: median(values), ...cpu}]
        })
        return shortText(crossoverText(points))
      })
      console.log(`| ${window} | ${kernel}, ${input} | ${cells.join(' | ')} |`)
    }
  }
}
