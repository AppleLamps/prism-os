// Prints markdown tables from run.ts's and cpu-time.ts's raw results:
//   bun lab/ui-exploration/text-walker/batch/gpu/summarize.ts --gpu <main run .json, comma-separated> [--sweep <sweep run .json>]
//     [--checks <check run .json>] [--cpu <cpu-time.ts .jsonl files, comma-separated>]
// Where a table combines several runs or processes, it shows the median of their medians, and their range in parentheses.
// The median of an even count is the mean of the two middle values. When several --cpu files have records of the same
// variant, size, count and width, only the last file's records count, so a rerun replaces an earlier batch.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}
type Timings = Record<'cellsMs' | 'uploadMs' | 'encodeAndSubmitMs' | 'waitMs' | 'copyMs' | 'totalMs' | 'totalWithCellsMs' | 'passMs', Summary | undefined>
type Checks = {readbacks: number, lineCounts: number, mismatches: number}
type CpuInPage = {count: number, pretext: {microsecondsPerParagraph: number}, pretextMismatches: number, writeCells: {microsecondsPerParagraph: number}}
type SetupResult = {kind: 'setup', size: string, maxCount: number, prepareMs: number, heapAfterCellsMegabytes: number | undefined, pretextMismatchesAgainstBun: number, cellHashesEqualBun: boolean, megabytesPerParagraph: number, cpu: CpuInPage[]}
type GpuResult = {kind: 'gpu', size: string, plan: string, guard: string, workgroupSize: number, count: number, megabytesUploaded: number, sharedUploadMs?: number, firstEvaluationMs: number, readback: Timings, noReadback: Timings, passTimestamps: Timings, uploadOnly: Timings, checks: Checks}
type SweepResult = {kind: 'sweep', size: string, workgroupSize: number, count: number, readback: Timings, passTimestamps: Timings, checks: Checks}
type Instances = {instances: number, mismatches: number}
type CheckResult = {kind: 'check', size: string, guard: string, paragraphs: number, widths: number, ownWidthEachParagraph: Instances, ownWidthEveryWidth: Instances, sharedWidthEveryWidth: Instances, failures: unknown[]}
type CompileTime = {size: string, plan: string, guard: string, workgroupSize: number, statements: number, compileMs: number}
type Run = {driver: {loadBefore: string, loadAfter: string, startedAt: string, finishedAt?: string, browser: string, busiestBefore?: string[], error?: string, timedOut?: string}, page: {results: unknown[], compileTimes: CompileTime[], crossOriginIsolated: boolean, adapter?: {info: unknown}, error?: string, deviceLost?: string, uncapturedError?: string}}
type CpuRecord = {failed?: boolean, args: string[], killedFor?: string, variant: string, size: string, count: number, width: number, microsecondsPerParagraph: number, loadBefore?: string, loadAfter?: string}

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
const format = (value: number) => {
  const digits = value === 0 ? 0 : Math.abs(value) < 0.1 ? 3 : Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0
  return value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})
}
const spread = (values: readonly number[]) => values.length === 0 ? '' : values.length === 1 ? format(values[0]!) : `${format(median(values))} (${format(Math.min(...values))} to ${format(Math.max(...values))})`
const printRow = (cells: readonly (string | number)[]) => console.log(`| ${cells.map(cell => typeof cell === 'number' ? cell.toLocaleString('en-US') : cell).join(' | ')} |`)
const printHeader = (cells: readonly string[]) => {
  printRow(cells)
  printRow(cells.map(() => '---'))
}
const firstLoad = (load: string) => Number(load.replace(/[{}]/g, '').trim().split(/\s+/)[0])

const gpuRuns = files('--gpu').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run)
const sweepRuns = files('--sweep').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run)
const checkRuns = files('--checks').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run)
const cpuFiles = files('--cpu').map(path => ({path, records: readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CpuRecord)}))

console.log('Runs:')
for (const run of [...gpuRuns, ...sweepRuns, ...checkRuns]) {
  const problems = [run.driver.error, run.driver.timedOut, run.page.error, run.page.deviceLost, run.page.uncapturedError].filter(problem => problem !== undefined)
  console.log(`- ${run.driver.startedAt} to ${run.driver.finishedAt}, ${run.driver.browser}, cross-origin isolated ${run.page.crossOriginIsolated}, load before ${run.driver.loadBefore}, after ${run.driver.loadAfter}${problems.length === 0 ? '' : `, problems: ${problems.join('; ')}`}`)
  console.log(`  busiest before: ${(run.driver.busiestBefore ?? []).slice(0, 3).join(' / ')}`)
}
for (const {path, records} of cpuFiles) {
  for (const record of records.filter(entry => entry.failed === true)) console.log(`- failed in ${path}: ${record.args.join(' ')}, ${record.killedFor ?? 'nonzero exit'}`)
}

const resultsOf = <Result>(runs: readonly Run[], kind: string) => runs.map(run => (run.page.results as {kind: string}[]).filter(result => result.kind === kind) as Result[])
const sizes = ['short', 'long']

// ----- Checks -----
const checks = resultsOf<CheckResult>(checkRuns, 'check').flat()
if (checks.length > 0) {
  console.log('\nChecks against pretext\'s layout() in the page:\n')
  printHeader(['Size', 'Guard', 'Own-width shader, each paragraph at its own width', 'Own-width shader, first paragraphs at every width', 'Shared-width shader, every paragraph at every width', 'Mismatches'])
  for (const check of checks) {
    const mismatches = check.ownWidthEachParagraph.mismatches + check.ownWidthEveryWidth.mismatches + check.sharedWidthEveryWidth.mismatches
    printRow([check.size, check.guard, check.ownWidthEachParagraph.instances, check.ownWidthEveryWidth.instances, check.sharedWidthEveryWidth.instances, mismatches])
  }
  console.log(`\nTotal: ${checks.reduce((total, check) => total + check.ownWidthEachParagraph.instances + check.ownWidthEveryWidth.instances + check.sharedWidthEveryWidth.instances, 0).toLocaleString('en-US')} line counts, ${checks.reduce((total, check) => total + check.ownWidthEachParagraph.mismatches + check.ownWidthEveryWidth.mismatches + check.sharedWidthEveryWidth.mismatches, 0)} mismatches`)
}

// ----- Setup and CPU in the page -----
const setups = resultsOf<SetupResult>(gpuRuns, 'setup')
const gpuResults = resultsOf<GpuResult>(gpuRuns, 'gpu')
if (gpuRuns.length > 0) {
  console.log('\nPage setup per run: prepare ms, JS heap MB, pretext mismatches against Bun, cell hashes equal Bun:\n')
  for (const size of sizes) {
    const list = setups.flat().filter(setup => setup.size === size)
    console.log(`- ${size}: prepare ${spread(list.map(setup => setup.prepareMs))} ms for ${list[0]?.maxCount} paragraphs, heap ${spread(list.flatMap(setup => setup.heapAfterCellsMegabytes ?? []))} MB, pretext mismatches ${list.map(setup => setup.pretextMismatchesAgainstBun).join(', ')}, hashes equal ${list.map(setup => setup.cellHashesEqualBun).join(', ')}`)
  }
  const checkTotals = gpuResults.flat().reduce((total, result) => ({lineCounts: total.lineCounts + result.checks.lineCounts, mismatches: total.mismatches + result.checks.mismatches}), {lineCounts: 0, mismatches: 0})
  console.log(`- line counts compared in the main runs: ${checkTotals.lineCounts.toLocaleString('en-US')}, mismatches ${checkTotals.mismatches}`)

  console.log('\nCompile ms, from createShaderModule to createComputePipelineAsync, per run:\n')
  printHeader(['Size', 'Plan', 'Guard', 'Workgroup', 'Statements', 'Compile ms'])
  const compiles = new Map<string, CompileTime[]>()
  for (const run of [...gpuRuns, ...sweepRuns]) for (const entry of run.page.compileTimes) {
    const key = `${entry.size}/${entry.plan}/${entry.guard}/${entry.workgroupSize}`
    compiles.set(key, [...compiles.get(key) ?? [], entry])
  }
  for (const [, list] of compiles) printRow([list[0]!.size, list[0]!.plan, list[0]!.guard, list[0]!.workgroupSize, list[0]!.statements, spread(list.map(entry => entry.compileMs))])
}

// CPU records: variant/size/count at 320 px -> process medians, the last file with that key winning.
const cpuByKey = new Map<string, {values: number[], loads: number[]}>()
for (const {records} of cpuFiles) {
  const fromThisFile = new Map<string, CpuRecord[]>()
  for (const record of records.filter(entry => entry.failed !== true && entry.width === 320)) {
    const key = `${record.variant}/${record.size}/${record.count}`
    fromThisFile.set(key, [...fromThisFile.get(key) ?? [], record])
  }
  for (const [key, list] of fromThisFile) {
    cpuByKey.set(key, {values: list.map(record => record.microsecondsPerParagraph), loads: list.flatMap(record => [record.loadBefore, record.loadAfter]).filter(load => load !== undefined).map(firstLoad)})
  }
}
const cpuMs = (variant: string, size: string, count: number) => {
  const entry = cpuByKey.get(`${variant}/${size}/${count}`)
  return entry === undefined ? undefined : entry.values.map(value => value * count / 1000)
}
const inPage = (size: string, count: number, pick: (cpu: CpuInPage) => number) => setups.flatMap(list => list.filter(setup => setup.size === size).flatMap(setup => setup.cpu.filter(cpu => cpu.count === count).map(pick)))
const gpu = (size: string, plan: string, guard: string, count: number) => gpuResults.flatMap(list => list.filter(result => result.size === size && result.plan === plan && result.guard === guard && result.count === count))
const values = (list: readonly GpuResult[], pick: (result: GpuResult) => Summary | undefined) => list.flatMap(result => pick(result)?.median ?? [])

const countsOf = (size: string) => [...new Set(gpuResults.flat().filter(result => result.size === size).map(result => result.count))].sort((left, right) => left - right)
const guardsOf = [...new Set(gpuResults.flat().map(result => result.guard))]

if (gpuRuns.length > 0) {
  for (const size of sizes) {
    const counts = countsOf(size)
    if (counts.length === 0) continue
    console.log(`\n${size}: µs per paragraph on the CPU, pretext's layout() and writing the own-width cells:\n`)
    printHeader(['Paragraphs', 'pretext in Bun', 'pretext in the page', 'writing the cells in Bun', 'writing the cells in the page', 'generated JavaScript, segment walker, Bun', 'executor, segment walker, Bun', 'executor, index read, Bun'])
    for (const count of counts) {
      const cpu = (variant: string) => spread(cpuByKey.get(`${variant}/${size}/${count}`)?.values ?? [])
      printRow([count, cpu('pretext'), spread(inPage(size, count, entry => entry.pretext.microsecondsPerParagraph)), cpu('write-cells'), spread(inPage(size, count, entry => entry.writeCells.microsecondsPerParagraph)), cpu('generated-segment-walker'), cpu('executor-segment-walker'), cpu('executor-index-read')])
    }
    for (const guard of guardsOf) {
      console.log(`\n${size}, ${guard} guard: ms per evaluation of every paragraph on the GPU:\n`)
      printHeader(['Paragraphs', 'MB uploaded', 'New cells: writing, upload, compute and readback', 'GPU part', 'without readback, GPU part', 'compute pass (timestamp query)', 'only the upload', 'New width, cells on the GPU: with readback', 'without readback', 'compute pass (timestamp query)'])
      for (const count of counts) {
        const own = gpu(size, 'own-width', guard, count)
        const shared = gpu(size, 'shared-width', guard, count)
        printRow([
          count, own[0] === undefined ? '' : format(own[0].megabytesUploaded),
          spread(values(own, result => result.readback.totalWithCellsMs)), spread(values(own, result => result.readback.totalMs)),
          spread(values(own, result => result.noReadback.totalMs)), spread(values(own, result => result.passTimestamps.passMs)), spread(values(own, result => result.uploadOnly.totalMs)),
          spread(values(shared, result => result.readback.totalMs)), spread(values(shared, result => result.noReadback.totalMs)), spread(values(shared, result => result.passTimestamps.passMs)),
        ])
      }
      console.log(`\n${size}, ${guard} guard: where the time of one evaluation with new cells and readback goes, ms, median of runs:\n`)
      printHeader(['Paragraphs', 'writing the cells', 'writeBuffer calls', 'encode and submit', 'submit to mapAsync resolving', 'copying the line counts', 'compute pass (timestamp query)', 'shared-width: submit to mapAsync resolving'])
      for (const count of counts) {
        const own = gpu(size, 'own-width', guard, count)
        const shared = gpu(size, 'shared-width', guard, count)
        const medianOf = (list: readonly GpuResult[], pick: (result: GpuResult) => Summary | undefined) => {
          const picked = values(list, pick)
          return picked.length === 0 ? '' : format(median(picked))
        }
        printRow([count, medianOf(own, result => result.readback.cellsMs), medianOf(own, result => result.readback.uploadMs), medianOf(own, result => result.readback.encodeAndSubmitMs), medianOf(own, result => result.readback.waitMs), medianOf(own, result => result.readback.copyMs), medianOf(own, result => result.passTimestamps.passMs), medianOf(shared, result => result.readback.waitMs)])
      }
    }
  }

  for (const size of sizes) {
    const counts = countsOf(size)
    if (counts.length === 0) continue
    console.log(`\n${size}: ms for one evaluation of every paragraph. The CPU variants are µs per paragraph × paragraphs, and the GPU variants use the max guard:\n`)
    printHeader(['Paragraphs', 'pretext in Bun', 'pretext in the page', 'generated JavaScript, segment walker, Bun', 'executor, index read, Bun', 'executor, segment walker, Bun', 'GPU, new cells, including writing them', 'GPU, new width, cells on the GPU'])
    for (const count of counts) {
      const cpuCell = (variant: string) => spread(cpuMs(variant, size, count) ?? [])
      printRow([
        count, cpuCell('pretext'), spread(inPage(size, count, entry => entry.pretext.microsecondsPerParagraph * count / 1000)),
        cpuCell('generated-segment-walker'), cpuCell('executor-index-read'), cpuCell('executor-segment-walker'),
        spread(values(gpu(size, 'own-width', 'max', count), result => result.readback.totalWithCellsMs)), spread(values(gpu(size, 'shared-width', 'max', count), result => result.readback.totalMs)),
      ])
    }
  }

  console.log('\nCrossover: the smallest measured count from which the GPU variant takes less time than the CPU variant, at that count and every larger measured count, from medians of runs. "About" interpolates linearly between that count and the measured count below it. Each run is the same with that run\'s GPU medians, and that run\'s pretext in the page:\n')
  printHeader(['Size', 'Guard', 'GPU variant', 'CPU variant', 'Crossover', 'Each run'])
  const gpuVariants: {name: string, plan: string, pick: (result: GpuResult) => Summary | undefined}[] = [
    {name: 'new cells, with readback, including writing the cells', plan: 'own-width', pick: result => result.readback.totalWithCellsMs},
    {name: 'new cells, with readback, GPU part only', plan: 'own-width', pick: result => result.readback.totalMs},
    {name: 'new width, cells on the GPU, with readback', plan: 'shared-width', pick: result => result.readback.totalMs},
  ]
  const crossover = (counts: readonly number[], gpuMs: (count: number) => number | undefined, cpuMsAt: (count: number) => number | undefined) => {
    const measured = counts.flatMap(count => {
      const gpuValue = gpuMs(count)
      const cpuValue = cpuMsAt(count)
      return gpuValue === undefined || cpuValue === undefined ? [] : [{count, difference: gpuValue - cpuValue}]
    })
    let first = measured.length
    while (first > 0 && measured[first - 1]!.difference < 0) first--
    if (first === measured.length) return 'none measured'
    const from = measured[first]!
    if (first === 0) return `from ${from.count.toLocaleString('en-US')}, the smallest measured`
    const below = measured[first - 1]!
    const about = below.count + (from.count - below.count) * below.difference / (below.difference - from.difference)
    return `from ${from.count.toLocaleString('en-US')}, about ${Math.round(about).toLocaleString('en-US')}`
  }
  const medianOrUndefined = (list: readonly number[] | undefined) => list === undefined || list.length === 0 ? undefined : median(list)
  for (const size of sizes) {
    const counts = countsOf(size)
    for (const guard of guardsOf) {
      for (const variant of gpuVariants) {
        const gpuInRun = (run: number, count: number) => {
          const result = gpuResults[run]!.find(entry => entry.size === size && entry.plan === variant.plan && entry.guard === guard && entry.count === count)
          return result === undefined ? undefined : variant.pick(result)?.median
        }
        const pretextInPage = (run: number | undefined, count: number) => medianOrUndefined((run === undefined ? setups.flat() : setups[run]!).filter(setup => setup.size === size).flatMap(setup => setup.cpu.filter(cpu => cpu.count === count).map(cpu => cpu.pretext.microsecondsPerParagraph * count / 1000)))
        const cpuVariants: {name: string, ms: (run: number | undefined, count: number) => number | undefined}[] = [
          {name: 'pretext in Bun', ms: (_, count) => medianOrUndefined(cpuMs('pretext', size, count))},
          {name: 'pretext in the page', ms: pretextInPage},
          {name: 'generated JavaScript, segment walker, Bun', ms: (_, count) => medianOrUndefined(cpuMs('generated-segment-walker', size, count))},
        ]
        for (const cpu of cpuVariants) {
          const gpuMedian = (count: number) => medianOrUndefined(values(gpu(size, variant.plan, guard, count), variant.pick))
          const eachRun = gpuResults.map((_, run) => crossover(counts, count => gpuInRun(run, count), count => cpu.ms(run, count)))
          printRow([size, guard, variant.name, cpu.name, crossover(counts, gpuMedian, count => cpu.ms(undefined, count)), eachRun.join('; ')])
        }
      }
    }
  }
}

// ----- Sweep -----
const sweeps = resultsOf<SweepResult>(sweepRuns, 'sweep').flat()
if (sweeps.length > 0) {
  console.log('\nWorkgroup sizes, own-width shader with new cells and readback, ms:\n')
  printHeader(['Size', 'Paragraphs', 'Workgroup', 'GPU part', 'compute pass (timestamp query)', 'mismatches'])
  for (const result of sweeps) printRow([result.size, result.count, result.workgroupSize, format(result.readback.totalMs!.median), result.passTimestamps.passMs === undefined ? '' : format(result.passTimestamps.passMs.median), result.checks.mismatches])
}

// ----- CPU timings with load -----
if (cpuFiles.length > 0) {
  console.log('\nCPU timing processes in Bun, µs per paragraph at 320 px, and the 1-minute load average before and after each process:\n')
  printHeader(['Variant', 'Size', 'Paragraphs', 'µs per paragraph', 'Processes', 'Load average'])
  for (const [key, {values: list, loads}] of [...cpuByKey].sort(([left], [right]) => left.localeCompare(right, 'en', {numeric: true}))) {
    const [variant, size, count] = key.split('/')
    printRow([variant!, size!, Number(count), spread(list), list.length, loads.length === 0 ? '' : `${Math.min(...loads)} to ${Math.max(...loads)}`])
  }
}
