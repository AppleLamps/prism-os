// Prints the README's regex search and combination tables from the raw results of search-run.ts and combined-run.ts:
//   bun lab/json-search/gpu/search-summarize.ts --search <search run .json, comma-separated> --combined <combined run .json, comma-separated>
// Each run is one fresh Chrome process. Where a table combines runs, a cell shows the median of the runs' medians, and
// their range in parentheses when the runs differ. The median of an even count is the mean of the two middle values.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}
type Timings = Record<'totalMs' | 'patternMs' | 'evaluateMs' | 'uploadMs' | 'waitMs' | 'copyMs' | 'passMs' | 'gapMs', Summary | undefined>
type Idle = Timings & {idleMs: number}
type CpuTime = {microsecondsPerDocument: number, documents?: number}
type Driver = {startedAt: string, finishedAt?: string, browser: string, machine: string, bun: string, loadBefore: string, loadAfter?: string, loadSamples: {load: string}[], error?: string}
type EngineResult = {
  engine: string, statements?: number, shaderBytes: number, compileMs: number, checks: {searches: number, values: number, mismatches: number},
  byCount: {count: number, firstSearchMs: number, backToBack: Timings, withTimestamps?: Timings, afterIdle?: Idle[]}[],
}
type SearchPage = {
  crossOriginIsolated: boolean, error?: string, emptyPipelineMs: number,
  regExp: {positions: number, pattern: string, matches: number, documentsWithMatch: number, meanCodePoints: number, byCount: {count: number, countAll: CpuTime, test: CpuTime}[]}[],
  results: {
    states: number, positions: number,
    patterns: {pattern: string, states: number, classes: number, boundaries: number, matches: number, documentsWhereRegExpCountsTheSame: number}[],
    program: {stages: {name: string, operations: number, indexReads: number}[], operationsPerDocument: number, sharedCells: number, patternCells: number},
    cpuCheck: {stepDocuments: number, stepValues: number, stepMismatches: number, executorDocuments: number, executorValues: number, executorMismatches: number},
    cpu: {pattern: string, bitRowLoop: ({count: number} & CpuTime)[], stepGenerated: CpuTime, stepExecutor: CpuTime, fullExecutor?: CpuTime},
    engines: EngineResult[],
  }[],
}
type CombinedSearch = {states: number, scope: string, patterns: string[], prepareMs: number, backToBack: Timings, withTimestamps?: Timings, afterIdle?: Idle[], windowOnly?: Timings}
type CombinedPage = {
  crossOriginIsolated: boolean, error?: string, emptyPipelineMs: number,
  // Only the runs since October 14, 2026 say which writer wrote the shaders. The ones before are loop-emit.ts's.
  config?: {writers?: {search: string, highlighter: string}},
  results: {
    count: number,
    plainJavaScript: {tableLoop: CpuTime, jsonParse: CpuTime, regExp: ({pattern: string, scope: string, states: number, matches: number, documentsWhereTheProgramCountsTheSame: number, runs?: number, findingTheRunsMs?: number} & CpuTime)[]},
    load: {cellsMs: number, validateMs: number, totalMs: number, megabytesOfCells: number},
    validationCheck: {documents: number, values: number, mismatches: number, validDocuments: number},
    selfCheck: {documents: number, searches: number, values: number, mismatches: number, cpuMs: number, gpuMs: number},
    validate: {backToBack: Timings, withTimestamps?: Timings, afterIdle: Idle[]},
    plainLoopAgainstTheProgramOnTheCpu: {documents: number, searches: number, values: number, mismatches: number},
    searches: CombinedSearch[],
    searchChecks: {searches: number, values: number, mismatches: number},
    programs: {name: string, operations: number[], statements?: number, compileMs?: number}[],
    programsOnTheCpu: ({name: string, documents: number, validateMicrosecondsPerDocument: number} & Record<string, number | undefined>)[],
  }[],
  straightLineDisplayShader?: {statements: number, shaderBytes: number, compileMs: number, byCount: {count: number, backToBackMs: Summary}[]},
}
type Run<Page> = {driver: Driver, page: Page}

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
const digitsFor = (value: number) => value < 10 ? 2 : value < 100 ? 1 : 0
const format = (value: number, digits = digitsFor(value)) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})
const whole = (value: number) => value.toLocaleString('en-US', {maximumFractionDigits: 0})
const defined = <Value>(values: readonly (Value | undefined)[]) => values.filter(value => value !== undefined)
// The median of the runs' values, with their range when there is more than one run and they differ.
const spread = (values: readonly (number | undefined)[], digits?: number) => {
  const present = defined(values)
  if (present.length === 0) return ''
  const middle = median(present)
  const used = digits ?? digitsFor(middle)
  const text = format(middle, used)
  const low = format(Math.min(...present), used)
  const high = format(Math.max(...present), used)
  return present.length === 1 || low === high ? text : `${text} (${low} to ${high})`
}
const loadRange = (driver: Driver) => {
  const loads = driver.loadSamples.map(sample => Number(sample.load.replace(/[{}]/g, '').trim().split(/\s+/)[0]))
  return loads.length === 0 ? driver.loadBefore : `${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}`
}
const describeRuns = (label: string, runs: readonly Run<{crossOriginIsolated: boolean, error?: string}>[]) => {
  runs.forEach((run, index) => {
    const minutes = run.driver.finishedAt === undefined ? '?' : ((Date.parse(run.driver.finishedAt) - Date.parse(run.driver.startedAt)) / 60000).toFixed(1)
    console.log(`${label} run ${index + 1}: ${run.driver.browser}, ${run.driver.machine}, Bun ${run.driver.bun}, started ${run.driver.startedAt}, ${minutes} minutes, 1-minute load average ${loadRange(run.driver)}, cross-origin isolated ${run.page.crossOriginIsolated}${run.page.error === undefined && run.driver.error === undefined ? '' : `, ERROR ${run.page.error ?? run.driver.error}`}`)
  })
}

// The smallest count from which the GPU takes less time at every larger measured count, interpolated on a logarithmic
// count axis between the two neighboring measured counts.
function crossoverOf(counts: readonly number[], gpu: readonly number[], cpu: readonly number[]) {
  let from = counts.length
  while (from > 0 && gpu[from - 1]! < cpu[from - 1]!) from--
  if (from === counts.length) return `never, up to ${whole(counts.at(-1)!)}`
  if (from === 0) return `below ${whole(counts[0]!)}`
  const [lowCount, highCount] = [counts[from - 1]!, counts[from]!]
  const lowGap = cpu[from - 1]! - gpu[from - 1]!
  const highGap = cpu[from]! - gpu[from]!
  const fraction = lowGap / (lowGap - highGap)
  return whole(Number((lowCount * (highCount / lowCount) ** fraction).toPrecision(2)))
}

const searchRuns = files('--search').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run<SearchPage>)
const combinedRuns = files('--combined').map(path => JSON.parse(readFileSync(path, 'utf8')) as Run<CombinedPage>)
describeRuns('search', searchRuns)
describeRuns('combined', combinedRuns)

if (searchRuns.length > 0) {
  const pages = searchRuns.map(run => run.page)
  const first = pages[0]!
  const sizes = first.results.map(result => [result.states, result.positions] as const)
  const resultOf = (page: SearchPage, states: number, positions: number) => page.results.find(result => result.states === states && result.positions === positions)
  const engineOf = (page: SearchPage, states: number, positions: number, engine: string) => resultOf(page, states, positions)?.engines.find(entry => entry.engine === engine)
  const counts = first.results[0]!.engines[0]!.byCount.map(entry => entry.count)
  const largest = Math.max(...counts)

  console.log('\n### The step and its shader\n')
  console.log('| States | Operations per position: reverse step, forward step | Operations per document at 256 positions | At 512 positions | Cells a pattern writes | WGSL statements | WGSL bytes | Compile shader ms, cold, 256 positions | 512 positions | Hand-written kernel, compile ms |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const states of [...new Set(sizes.map(size => size[0]))]) {
    const at = (positions: number) => resultOf(first, states, positions)
    const one = at(256) ?? at(512)!
    const stages = one.program.stages
    // The newest run's shader, since an earlier run's may lack a statement that was added between runs.
    const shader = defined(pages.map(page => engineOf(page, states, one.positions, 'step'))).at(-1)!
    const compile = (positions: number, engine: string) => spread(pages.map(page => engineOf(page, states, positions, engine)?.compileMs), 0)
    console.log(`| ${states} | ${stages.filter(stage => stage.name !== 'start').map(stage => whole(stage.operations)).join(', ')} | ${at(256) === undefined ? '' : whole(at(256)!.program.operationsPerDocument)} | ${at(512) === undefined ? '' : whole(at(512)!.program.operationsPerDocument)} | ${whole(one.program.patternCells)} | ${whole(shader.statements!)} | ${whole(shader.shaderBytes)} | ${compile(256, 'step')} | ${compile(512, 'step')} | ${spread(pages.flatMap(page => [256, 512].map(positions => engineOf(page, states, positions, 'kernel')?.compileMs)), 0)} |`)
  }
  console.log(`\nThe shader of one empty function that each process compiles first: ${spread(pages.map(page => page.emptyPipelineMs), 1)} ms.`)

  console.log('\n### The patterns, and RegExp in the same page\n')
  for (const positions of [...new Set(first.regExp.map(entry => entry.positions))]) {
    const entries = first.regExp.filter(entry => entry.positions === positions)
    console.log(`The first ${positions} code points of each document, a mean of ${format(entries[0]!.meanCodePoints, 1)} code points. ms for ${whole(largest)} documents, and µs per document at ${whole(largest)} and at 1,000:\n`)
    console.log('| Pattern | States | Matches | Documents with a match | RegExp, every match: ms | µs per document | µs per document at 1,000 documents | RegExp test: ms | µs per document |')
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const entry of entries) {
      const time = (count: number, key: 'countAll' | 'test') => pages.map(page => page.regExp.find(other => other.positions === positions && other.pattern === entry.pattern)?.byCount.find(other => other.count === count)?.[key].microsecondsPerDocument)
      const states = first.results.flatMap(result => result.patterns).find(pattern => pattern.pattern === entry.pattern)?.states
      console.log(`| \`${entry.pattern.replaceAll('|', '\\|')}\` | ${states ?? ''} | ${whole(entry.matches)} | ${whole(entry.documentsWithMatch)} | ${spread(time(largest, 'countAll').map(value => value === undefined ? undefined : value * largest / 1000))} | ${spread(time(largest, 'countAll'), 3)} | ${spread(time(1000, 'countAll'), 3)} | ${spread(time(largest, 'test').map(value => value === undefined ? undefined : value * largest / 1000))} | ${spread(time(largest, 'test'), 3)} |`)
    }
    console.log('')
  }
  const disagreements = pages.flatMap(page => page.results.flatMap(result => result.patterns.filter(pattern => pattern.documentsWhereRegExpCountsTheSame !== largest)))
  console.log(`Patterns and sizes where RegExp's count differs from the automaton's for some document: ${disagreements.length}.`)

  console.log('\n### The CPU, µs per document\n')
  console.log('| States | Positions | Plain JavaScript loop over 32-bit rows | The loop program as generated JavaScript, sampled | The loop program on the CPU executor, sampled | Form (a) with every position written out, on the CPU executor, sampled |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const [states, positions] of sizes) {
    const cpu = (pick: (result: SearchPage['results'][number]) => number | undefined) => spread(pages.map(page => {
      const result = resultOf(page, states, positions)
      return result === undefined ? undefined : pick(result)
    }))
    console.log(`| ${states} | ${positions} | ${cpu(result => result.cpu.bitRowLoop.find(entry => entry.count === largest)?.microsecondsPerDocument)} | ${cpu(result => result.cpu.stepGenerated.microsecondsPerDocument)} | ${cpu(result => result.cpu.stepExecutor.microsecondsPerDocument)} | ${cpu(result => result.cpu.fullExecutor?.microsecondsPerDocument)} |`)
  }

  const idleGaps = defined(first.results.flatMap(result => result.engines.flatMap(engine => engine.byCount.flatMap(entry => entry.afterIdle?.map(idle => idle.idleMs))))).filter((gap, index, all) => all.indexOf(gap) === index)
  for (const engine of ['step', 'kernel', 'step-stop']) {
    if (!pages.some(page => page.results.some(result => result.engines.some(entry => entry.engine === engine)))) continue
    const withEngine = pages.filter(page => page.results.some(result => result.engines.some(entry => entry.engine === engine)))
    console.log(`\n### One search, ms: ${engine === 'step' ? 'the program\'s step in a loop' : engine === 'kernel' ? 'the hand-written kernel' : 'the step, with both loops stopping at the text\'s end'} (${withEngine.length} run${withEngine.length === 1 ? '' : 's'})\n`)
    console.log(`| States | Positions | Documents | Back to back | Compute pass, timestamps | ${idleGaps.map(gap => `After a pause of ${whole(gap)} ms`).join(' | ')} | First search |`)
    console.log(`| --- | --- | --- | --- | --- | ${idleGaps.map(() => '---').join(' | ')} | --- |`)
    for (const [states, positions] of sizes) {
      for (const count of counts) {
        const entries = defined(withEngine.map(page => engineOf(page, states, positions, engine)?.byCount.find(entry => entry.count === count)))
        if (entries.length === 0) continue
        console.log(`| ${states} | ${positions} | ${whole(count)} | ${spread(entries.map(entry => entry.backToBack.totalMs?.median))} | ${spread(entries.map(entry => entry.withTimestamps?.passMs?.median))} | ${idleGaps.map(gap => spread(entries.map(entry => entry.afterIdle?.find(idle => idle.idleMs === gap)?.totalMs?.median))).join(' | ')} | ${spread(entries.map(entry => entry.firstSearchMs))} |`)
      }
    }
  }

  console.log('\n### The parts of one back to back search of the step, ms\n')
  console.log('| States | Positions | Documents | JavaScript: compile the pattern, write its cells | writeBuffer calls | Submit to mapped | Copy out | Total |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const [states, positions] of sizes) {
    const entries = defined(pages.map(page => engineOf(page, states, positions, 'step')?.byCount.find(entry => entry.count === largest)))
    const part = (key: keyof Timings) => spread(entries.map(entry => entry.backToBack[key]?.median), 3)
    console.log(`| ${states} | ${positions} | ${whole(largest)} | ${part('patternMs')} | ${part('uploadMs')} | ${part('waitMs')} | ${part('copyMs')} | ${part('totalMs')} |`)
  }

  console.log('\n### Checks\n')
  pages.forEach((page, index) => {
    const engines = page.results.flatMap(result => result.engines)
    const total = (pick: (engine: EngineResult) => number) => engines.reduce((sum, engine) => sum + pick(engine), 0)
    const cpu = page.results.map(result => result.cpuCheck)
    console.log(`Run ${index + 1}: ${whole(total(engine => engine.checks.searches))} searches read back, ${whole(total(engine => engine.checks.values))} values compared with the plain JavaScript loop, ${whole(total(engine => engine.checks.mismatches))} mismatched. The plain loop against the loop program as generated JavaScript: ${whole(cpu.reduce((sum, check) => sum + check.stepValues, 0))} values, ${cpu.reduce((sum, check) => sum + check.stepMismatches, 0)} mismatched. Against form (a) with every position written out on the executor: ${whole(cpu.reduce((sum, check) => sum + check.executorValues, 0))} values, ${cpu.reduce((sum, check) => sum + check.executorMismatches, 0)} mismatched.`)
  })

  // Where the step on the GPU takes less time than RegExp counting every match, per pattern, at 512 positions.
  console.log('\n### The step at 8 states and 512 positions against RegExp counting every match\n')
  const stepAt = (count: number, pick: (entry: EngineResult['byCount'][number]) => number | undefined) => median(defined(pages.map(page => {
    const entry = engineOf(page, 8, 512, 'step')?.byCount.find(other => other.count === count)
    return entry === undefined ? undefined : pick(entry)
  })))
  const pauses = idleGaps.filter(gap => gap >= 200).slice(0, 1)
  console.log(`| What runs | ${counts.map(count => `ms at ${whole(count)} documents`).join(' | ')} | Documents from which the GPU takes less time, back to back | ${pauses.map(gap => `After a pause of ${whole(gap)} ms`).join(' | ')} |`)
  console.log(`| --- | ${counts.map(() => '---').join(' | ')} | --- | ${pauses.map(() => '---').join(' | ')} |`)
  const crossover = (gpu: number[], cpu: number[]) => crossoverOf(counts, gpu, cpu)
  console.log(`| the step on the GPU, back to back | ${counts.map(count => format(stepAt(count, entry => entry.backToBack.totalMs?.median))).join(' | ')} | | ${pauses.map(() => '').join(' | ')} |`)
  for (const gap of pauses) console.log(`| the step on the GPU, after a pause of ${whole(gap)} ms | ${counts.map(count => format(stepAt(count, entry => entry.afterIdle?.find(idle => idle.idleMs === gap)?.totalMs?.median))).join(' | ')} | | ${pauses.map(() => '').join(' | ')} |`)
  for (const entry of first.regExp.filter(other => other.positions === 512)) {
    const states = first.results.flatMap(result => result.patterns).find(pattern => pattern.pattern === entry.pattern)?.states
    if (states === undefined || states > 8) continue
    const regExpMs = counts.map(count => median(defined(pages.map(page => page.regExp.find(other => other.positions === 512 && other.pattern === entry.pattern)?.byCount.find(other => other.count === count)?.countAll.microsecondsPerDocument))) * count / 1000)
    console.log(`| RegExp, \`${entry.pattern.replaceAll('|', '\\|')}\` | ${regExpMs.map(value => format(value)).join(' | ')} | ${crossover(counts.map(count => stepAt(count, other => other.backToBack.totalMs?.median)), regExpMs)} | ${pauses.map(gap => crossover(counts.map(count => stepAt(count, other => other.afterIdle?.find(idle => idle.idleMs === gap)?.totalMs?.median)), regExpMs)).join(' | ')} |`)
  }
}

if (combinedRuns.length > 0) {
  const pages = combinedRuns.map(run => run.page)
  const first = pages[0]!
  const counts = first.results.map(result => result.count)
  const at = (page: CombinedPage, count: number) => page.results.find(result => result.count === count)
  const cell = (count: number, pick: (result: CombinedPage['results'][number]) => number | undefined, digits?: number) => spread(pages.map(page => {
    const result = at(page, count)
    return result === undefined ? undefined : pick(result)
  }), digits)
  const gaps = first.results[0]!.validate.afterIdle.map(idle => idle.idleMs)

  // Since October 14, 2026 the searcher compiles every search program when it is created, at the same time as the
  // highlighter's pass, so its two times are the cells and everything else.
  const compilesEverySearchProgram = first.config?.writers !== undefined
  if (compilesEverySearchProgram) console.log(`\nThe search programs' shaders are ${first.config!.writers!.search}.ts's, and the highlighter's is ${first.config!.writers!.highlighter}.ts's.`)
  console.log('\n### The searcher: creating it\n')
  console.log(compilesEverySearchProgram
    ? '| Documents | MB of cells | JavaScript writing the cells, ms | Upload, the highlighter\'s shader and pass, and every search program built and compiled, ms | Total, ms |'
    : '| Documents | MB of cells | JavaScript writing the cells, ms | Upload, compile the highlighter\'s shader, validate, ms | Total with the first search shader, ms |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const count of counts) console.log(`| ${whole(count)} | ${cell(count, result => result.load.megabytesOfCells)} | ${cell(count, result => result.load.cellsMs)} | ${cell(count, result => result.load.validateMs)} | ${cell(count, result => result.load.totalMs)} |`)
  console.log('\n| Program | Operations per stage | WGSL statements | Compile shader ms, by document count |')
  console.log('| --- | --- | --- | --- |')
  const programNames = [...new Set(pages.flatMap(page => page.results.flatMap(result => result.programs.map(program => program.name))))]
  for (const name of programNames) {
    const example = first.results.flatMap(result => result.programs).find(program => program.name === name) ?? pages.flatMap(page => page.results.flatMap(result => result.programs)).find(program => program.name === name)!
    console.log(`| ${name} | ${example.operations.map(whole).join(', ')} | ${example.statements === undefined ? '' : whole(example.statements)} | ${counts.map(count => `${whole(count)}: ${cell(count, result => result.programs.find(program => program.name === name)?.compileMs, 0)}`).join('; ')} |`)
  }
  if (first.straightLineDisplayShader !== undefined) {
    const straight = defined(pages.map(page => page.straightLineDisplayShader))
    console.log(`\nThe first stage's display shader, every position written out, in the same processes: ${whole(straight[0]!.statements)} statements, compiled in ${spread(straight.map(entry => entry.compileMs), 0)} ms.`)
  }

  console.log('\n### The highlighter\'s pass over every document, ms\n')
  console.log(`| Documents | The loop: back to back | Compute pass, timestamps | ${gaps.map(gap => `After a pause of ${whole(gap)} ms`).join(' | ')} | Every position written out, back to back | Table loop, plain JavaScript | JSON.parse |`)
  console.log(`| --- | --- | --- | ${gaps.map(() => '---').join(' | ')} | --- | --- | --- |`)
  for (const count of counts) {
    const straight = spread(pages.map(page => page.straightLineDisplayShader?.byCount.find(entry => entry.count === count)?.backToBackMs.median))
    console.log(`| ${whole(count)} | ${cell(count, result => result.validate.backToBack.totalMs?.median)} | ${cell(count, result => result.validate.withTimestamps?.passMs?.median)} | ${gaps.map(gap => cell(count, result => result.validate.afterIdle.find(idle => idle.idleMs === gap)?.totalMs?.median)).join(' | ')} | ${straight} | ${cell(count, result => result.plainJavaScript.tableLoop.microsecondsPerDocument * count / 1000)} | ${cell(count, result => result.plainJavaScript.jsonParse.microsecondsPerDocument * count / 1000)} |`)
  }

  console.log('\n### One search through the searcher, ms\n')
  console.log(`| States | Scope | Documents | Back to back | Compute pass, timestamps | ${gaps.map(gap => `After a pause of ${whole(gap)} ms`).join(' | ')} | Only the window's 64 documents |`)
  console.log(`| --- | --- | --- | --- | --- | ${gaps.map(() => '---').join(' | ')} | --- |`)
  const searchKeys = [...new Set(pages.flatMap(page => page.results.flatMap(result => result.searches.map(search => `${search.states} ${search.scope}`))))]
  for (const key of searchKeys) {
    const [states, scope] = key.split(' ') as [string, string]
    for (const count of counts) {
      const pick = (choose: (search: CombinedSearch) => number | undefined) => cell(count, result => {
        const search = result.searches.find(other => String(other.states) === states && other.scope === scope)
        return search === undefined ? undefined : choose(search)
      })
      if (pick(search => search.backToBack.totalMs?.median) === '') continue
      console.log(`| ${states} | ${scope} | ${whole(count)} | ${pick(search => search.backToBack.totalMs?.median)} | ${pick(search => search.withTimestamps?.passMs?.median)} | ${gaps.map(gap => pick(search => search.afterIdle?.find(idle => idle.idleMs === gap)?.totalMs?.median)).join(' | ')} | ${pick(search => search.windowOnly?.totalMs?.median)} |`)
    }
  }

  // Only the runs whose plain JavaScript baseline keeps each scope's runs as strings: an earlier version of
  // plain-search.ts found the runs again in every search, and the first runs were measured with it.
  const largest = Math.max(...counts)
  const baselinePages = pages.filter(page => page.results[0]!.plainJavaScript.regExp[0]!.findingTheRunsMs !== undefined)
  console.log(`\n### The same searches in plain JavaScript: RegExp on each run of searched characters (${baselinePages.length} of ${pages.length} runs)\n`)
  const scopes = [...new Set(first.results[0]!.plainJavaScript.regExp.map(entry => entry.scope))]
  console.log(`| Pattern | States | ${scopes.map(scope => `${scope}: matches | ms for ${whole(largest)} documents | µs per document | at 1,000 documents`).join(' | ')} |`)
  console.log(`| --- | --- | ${scopes.map(() => '--- | --- | --- | ---').join(' | ')} |`)
  for (const pattern of [...new Set(first.results[0]!.plainJavaScript.regExp.map(entry => entry.pattern))]) {
    const entryAt = (page: CombinedPage, count: number, scope: string) => at(page, count)?.plainJavaScript.regExp.find(entry => entry.pattern === pattern && entry.scope === scope)
    const example = entryAt(first, largest, scopes[0]!)!
    console.log(`| \`${pattern.replaceAll('|', '\\|')}\` | ${example.states} | ${scopes.map(scope => `${whole(entryAt(first, largest, scope)!.matches)} | ${spread(baselinePages.map(page => entryAt(page, largest, scope)?.microsecondsPerDocument).map(value => value === undefined ? undefined : value * largest / 1000))} | ${spread(baselinePages.map(page => entryAt(page, largest, scope)?.microsecondsPerDocument), 3)} | ${spread(baselinePages.map(page => entryAt(page, 1000, scope)?.microsecondsPerDocument), 3)}`).join(' | ')} |`)
  }
  for (const scope of scopes) {
    const entries = defined(baselinePages.map(page => at(page, largest)?.plainJavaScript.regExp.find(entry => entry.scope === scope)))
    if (entries.length > 0) console.log(`\n${scope}: ${whole(entries[0]!.runs ?? 0)} runs in ${whole(largest)} documents, found once in ${spread(entries.map(entry => entry.findingTheRunsMs))} ms.`)
  }
  const differing = pages.flatMap(page => page.results.flatMap(result => result.plainJavaScript.regExp.filter(entry => entry.documentsWhereTheProgramCountsTheSame !== result.count)))
  console.log(`\nPatterns, scopes and counts where RegExp's count differs from the program's for some document: ${differing.length}${differing.length === 0 ? '' : `, e.g. ${JSON.stringify(differing[0])}`}.`)

  // Where a search through the searcher takes less time than RegExp, per pattern, for the scope that was also timed
  // after a pause. A pattern runs on the smallest program that holds it.
  const pausedScope = first.results[0]!.searches.find(search => search.afterIdle !== undefined)?.scope
  if (pausedScope !== undefined && baselinePages.length > 0) {
    const pause = gaps.find(gap => gap >= 200)
    const searchAt = (states: number, count: number, pick: (search: CombinedSearch) => number | undefined) => {
      const values = defined(pages.map(page => {
        const search = at(page, count)?.searches.find(other => other.states === states && other.scope === pausedScope)
        return search === undefined ? undefined : pick(search)
      }))
      return values.length === 0 ? undefined : median(values)
    }
    console.log(`\n### One search through the searcher against RegExp, ${pausedScope}: ms at each document count, and the count from which the GPU takes less time\n`)
    console.log(`| What runs | ${counts.map(count => `ms at ${whole(count)} documents`).join(' | ')} | Documents from which the GPU takes less time, back to back | ${pause === undefined ? '' : `After a pause of ${whole(pause)} ms |`}`)
    console.log(`| --- | ${counts.map(() => '---').join(' | ')} | --- | ${pause === undefined ? '' : '--- |'}`)
    const programs = [...new Set(first.results.flatMap(result => result.searches.map(search => search.states)))]
    const timesOf = (states: number, pick: (search: CombinedSearch) => number | undefined) => counts.map(count => searchAt(states, count, pick))
    const show = (values: readonly (number | undefined)[]) => values.map(value => value === undefined ? '' : format(value)).join(' | ')
    for (const states of programs) {
      console.log(`| the searcher's program of ${states} states, back to back | ${show(timesOf(states, search => search.backToBack.totalMs?.median))} | | ${pause === undefined ? '' : ' |'}`)
      if (pause !== undefined) console.log(`| the same after a pause of ${whole(pause)} ms | ${show(timesOf(states, search => search.afterIdle?.find(idle => idle.idleMs === pause)?.totalMs?.median))} | | |`)
    }
    for (const pattern of [...new Set(first.results[0]!.plainJavaScript.regExp.map(entry => entry.pattern))]) {
      const patternStates = first.results[0]!.plainJavaScript.regExp.find(entry => entry.pattern === pattern)!.states
      const states = programs.find(program => program >= patternStates)
      if (states === undefined) continue
      const regExpMs = counts.map(count => median(defined(baselinePages.map(page => at(page, count)?.plainJavaScript.regExp.find(entry => entry.pattern === pattern && entry.scope === pausedScope)?.microsecondsPerDocument))) * count / 1000)
      // A program that wasn't timed at every count has no crossover, e.g. loop-emit.ts's of 32 states at 100,000 documents.
      const against = (gpu: readonly (number | undefined)[]) => gpu.includes(undefined) ? '' : crossoverOf(counts, gpu as number[], regExpMs)
      console.log(`| RegExp, \`${pattern.replaceAll('|', '\\|')}\`, which the searcher runs on ${states} states | ${show(regExpMs)} | ${against(timesOf(states, search => search.backToBack.totalMs?.median))} | ${pause === undefined ? '' : `${against(timesOf(states, search => search.afterIdle?.find(idle => idle.idleMs === pause)?.totalMs?.median))} |`}`)
    }
  }

  console.log('\n### The same programs on the CPU, µs per document\n')
  console.log('| Backend | Documents sampled | Validate | Search, 8 states | 16 states | 32 states |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const name of [...new Set(first.results.flatMap(result => result.programsOnTheCpu.map(program => program.name)))]) {
    const pick = (choose: (program: CombinedPage['results'][number]['programsOnTheCpu'][number]) => number | undefined) => spread(pages.map(page => {
      const program = at(page, largest)?.programsOnTheCpu.find(other => other.name === name)
      return program === undefined ? undefined : choose(program)
    }))
    console.log(`| ${name} | ${whole(at(first, largest)!.programsOnTheCpu.find(program => program.name === name)!.documents)} | ${pick(program => program.validateMicrosecondsPerDocument)} | ${pick(program => program['searchMicrosecondsPerDocumentAt8States'])} | ${pick(program => program['searchMicrosecondsPerDocumentAt16States'])} | ${pick(program => program['searchMicrosecondsPerDocumentAt32States'])} |`)
  }

  console.log('\n### Checks\n')
  pages.forEach((page, index) => {
    const total = (pick: (result: CombinedPage['results'][number]) => number) => page.results.reduce((sum, result) => sum + pick(result), 0)
    console.log(`Run ${index + 1}: validation of ${whole(total(result => result.validationCheck.documents))} documents against the table loop, ${whole(total(result => result.validationCheck.values))} values, ${total(result => result.validationCheck.mismatches)} mismatched. ${whole(total(result => result.searchChecks.searches))} searches read back, ${whole(total(result => result.searchChecks.values))} values compared with the plain JavaScript loop, ${total(result => result.searchChecks.mismatches)} mismatched. The plain loop against the loop program on the CPU: ${whole(total(result => result.plainLoopAgainstTheProgramOnTheCpu.values))} values, ${total(result => result.plainLoopAgainstTheProgramOnTheCpu.mismatches)} mismatched. The searcher's self check: ${whole(total(result => result.selfCheck.values))} values, ${total(result => result.selfCheck.mismatches)} mismatched.`)
  })
}
