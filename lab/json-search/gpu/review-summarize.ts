// Prints the review's tables from review-run.ts's raw results:
//   bun lab/json-search/gpu/review-summarize.ts --baselines <files, comma-separated> --edge <files> --many <files>
// Each run is one fresh Chrome process. A cell shows the median of the runs' medians, and their range in parentheses
// when the runs differ. The median of an even count is the mean of the two middle values.
import {readFileSync} from 'node:fs'

type Summary = {count: number, median: number, min: number, max: number}
type CpuTime = {microsecondsPerDocument: number}
type Driver = {startedAt: string, finishedAt?: string, browser: string, machine: string, bun: string, loadBefore: string, loadSamples: {load: string}[], error?: string}
type Run<Page> = {driver: Driver, page: Page & {error?: string, crossOriginIsolated: boolean, config: {documents: number}}}
type BaselinesPage = {
  validate: Record<string, CpuTime>
  regExp: {pattern: string, totals: Record<string, number>, times: Record<string, CpuTime>}[]
  workers: {workers: number, sendingTheDocumentsMs: number, jsonParse: {total: number, ms: Summary}, regExp: {pattern: string, total: number, ms: Summary}[]}[]
}
type Check = Record<string, unknown>
type EdgePage = {
  documents: {count: number, valid: number}
  againstWrittenOutProgramsOnTheExecutor: Check, at32StatesAgainstGeneratedJavaScript: Check, at32StatesAgainstTheLoopProgramOnTheExecutor: Check, selfCheck: Check,
  threeRequestsAtOnce: Check, firstStageShadersOverTheEdgeDocuments: Check[],
}
type ManyPage = {
  validationAgainstTheHighlighterOnTheExecutor: Check, validateBackToBack: {fromCallToResolveMs: Summary, evaluateMs: Summary},
  againstGeneratedJavaScript: Check & {validateMicrosecondsPerDocument: number, referenceSearchMs: number[], searchesRun: {pattern: string, scope: unknown}[]},
  at32StatesAgainstGeneratedJavaScript: Check & {documents: number, referenceSearchMs: number[]},
  againstTheLoopProgramsOnTheExecutor: Check & {documents: number, validateMicrosecondsPerDocument: number, referenceSearchMs: number[]},
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const read = <Page>(name: string) => (argument(name)?.split(',').filter(path => path !== '') ?? []).map(path => JSON.parse(readFileSync(path, 'utf8')) as Run<Page>)
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const digitsFor = (value: number) => value < 10 ? 2 : value < 100 ? 1 : 0
const format = (value: number, digits = digitsFor(value)) => value.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits})
const spread = (values: readonly number[]) => {
  const middle = median(values)
  const digits = digitsFor(middle)
  const [low, high] = [format(Math.min(...values), digits), format(Math.max(...values), digits)]
  return values.length === 1 || low === high ? format(middle, digits) : `${format(middle, digits)} (${low} to ${high})`
}
const describe = (label: string, runs: readonly Run<unknown>[]) => runs.forEach((run, index) => {
  const loads = run.driver.loadSamples.map(sample => Number(sample.load.replace(/[{}]/g, '').trim().split(/\s+/)[0]))
  const minutes = run.driver.finishedAt === undefined ? '?' : ((Date.parse(run.driver.finishedAt) - Date.parse(run.driver.startedAt)) / 60000).toFixed(1)
  console.log(`${label} run ${index + 1}: ${run.driver.browser}, ${run.driver.machine}, Bun ${run.driver.bun}, started ${run.driver.startedAt}, ${minutes} minutes, 1-minute load average ${loads.length === 0 ? run.driver.loadBefore : `${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}`}, cross-origin isolated ${run.page.crossOriginIsolated}${run.page.error === undefined && run.driver.error === undefined ? '' : `, ERROR ${run.page.error ?? run.driver.error}`}`)
})

const baselines = read<BaselinesPage>('--baselines')
const edge = read<EdgePage>('--edge')
const many = read<ManyPage>('--many')
describe('baselines', baselines)
describe('edge', edge)
describe('many', many)

if (baselines.length > 0) {
  const pages = baselines.map(run => run.page)
  const first = pages[0]!
  const count = first.config.documents
  const ms = (pick: (page: BaselinesPage) => number) => spread(pages.map(page => pick(page) * count / 1000))

  console.log(`\n### One thread in the page, ms for ${format(count, 0)} documents\n`)
  console.log('| JSON.parse | Table loop, every document\'s kinds into one array of 512 | Table loop, into an array of every document\'s kinds |')
  console.log('| --- | --- | --- |')
  console.log(`| ${ms(page => page.validate['jsonParse']!.microsecondsPerDocument)} | ${ms(page => page.validate['tableLoopIntoOneArrayOf512']!.microsecondsPerDocument)} | ${ms(page => page.validate['tableLoopIntoEveryDocumentsKinds']!.microsecondsPerDocument)} |`)

  const ways = Object.keys(first.regExp[0]!.times)
  console.log(`\n### Four ways to count a pattern's matches with RegExp, one thread, ms for ${format(count, 0)} documents\n`)
  console.log(`| Pattern | Matches | ${ways.join(' | ')} |`)
  console.log(`| --- | --- | ${ways.map(() => '---').join(' | ')} |`)
  first.regExp.forEach((entry, index) => {
    const sameTotals = new Set(Object.values(entry.totals)).size === 1
    console.log(`| \`${entry.pattern.replaceAll('|', '\\|')}\` | ${sameTotals ? format(entry.totals['match']!, 0) : `the ways differ: ${JSON.stringify(entry.totals)}`} | ${ways.map(way => ms(page => page.regExp[index]!.times[way]!.microsecondsPerDocument)).join(' | ')} |`)
  })

  const workerCounts = first.workers.map(entry => entry.workers)
  const worker = (workers: number, pick: (entry: BaselinesPage['workers'][number]) => number) => spread(pages.map(page => pick(page.workers.find(entry => entry.workers === workers)!)))
  console.log(`\n### JavaScript in several workers, ms for ${format(count, 0)} documents, from the request until every worker's answer has arrived\n`)
  console.log(`| What | One thread in the page | ${workerCounts.map(workers => `${workers} worker${workers === 1 ? '' : 's'}`).join(' | ')} |`)
  console.log(`| --- | --- | ${workerCounts.map(() => '---').join(' | ')} |`)
  console.log(`| Sending the documents to the workers, once | | ${workerCounts.map(workers => worker(workers, entry => entry.sendingTheDocumentsMs)).join(' | ')} |`)
  console.log(`| JSON.parse | ${ms(page => page.validate['jsonParse']!.microsecondsPerDocument)} | ${workerCounts.map(workers => worker(workers, entry => entry.jsonParse.ms.median)).join(' | ')} |`)
  first.regExp.forEach((entry, index) => {
    console.log(`| RegExp, every match, \`${entry.pattern.replaceAll('|', '\\|')}\` | ${ms(page => page.regExp[index]!.times['match']!.microsecondsPerDocument)} | ${workerCounts.map(workers => worker(workers, workerEntry => workerEntry.regExp[index]!.ms.median)).join(' | ')} |`)
  })
  const totalsAgree = pages.every(page => page.workers.every(entry => entry.regExp.every((result, index) => result.total === page.regExp[index]!.totals['match'])))
  console.log(`\nThe workers' match counts equal the page's for every pattern and worker count: ${totalsAgree}.`)
}

for (const run of edge) {
  const page = run.page
  console.log(`\n### Documents and patterns at the limits, on the GPU\n`)
  console.log(`${format(page.documents.count, 0)} documents, of which the GPU calls ${format(page.documents.valid, 0)} valid.`)
  console.log(`Against the programs with every position written out, on the CPU executor: ${JSON.stringify(page.againstWrittenOutProgramsOnTheExecutor)}`)
  console.log(`32 states, against the loop program as generated JavaScript: ${JSON.stringify(page.at32StatesAgainstGeneratedJavaScript)}`)
  console.log(`32 states, against the loop program on the CPU executor: ${JSON.stringify(page.at32StatesAgainstTheLoopProgramOnTheExecutor)}`)
  console.log(`The searcher's self check: ${JSON.stringify(page.selfCheck)}`)
  console.log(`Three requests at once: ${JSON.stringify(page.threeRequestsAtOnce)}`)
  console.log(`The first stage's shaders over the same documents, against the executor: ${JSON.stringify(page.firstStageShadersOverTheEdgeDocuments)}`)
}

for (const run of many) {
  const page = run.page
  const count = run.page.config.documents
  console.log(`\n### ${format(count, 0)} generated documents on the GPU\n`)
  console.log(`Validation and every display kind against the highlighter with every position written out, on the CPU executor: ${JSON.stringify(page.validationAgainstTheHighlighterOnTheExecutor)}`)
  console.log(`searcher.validate() back to back, ms: from the call until the promise resolves ${page.validateBackToBack.fromCallToResolveMs.median} (${page.validateBackToBack.fromCallToResolveMs.min} to ${page.validateBackToBack.fromCallToResolveMs.max}), its own evaluateMs ${page.validateBackToBack.evaluateMs.median}`)
  console.log(`Searches against the loop programs as generated JavaScript, every document: ${JSON.stringify(page.againstGeneratedJavaScript)}`)
  console.log(`32 states against generated JavaScript, the first ${format(page.at32StatesAgainstGeneratedJavaScript.documents, 0)} documents: ${JSON.stringify(page.at32StatesAgainstGeneratedJavaScript)}`)
  console.log(`Against the loop programs on the CPU executor, the first ${format(page.againstTheLoopProgramsOnTheExecutor.documents, 0)} documents: ${JSON.stringify(page.againstTheLoopProgramsOnTheExecutor)}`)
  console.log('\nThe loop programs on the CPU, µs per document, warm:')
  console.log(`- generated JavaScript, ${format(count, 0)} documents: the highlighter ${format(page.againstGeneratedJavaScript.validateMicrosecondsPerDocument)}, and the searches ${page.againstGeneratedJavaScript.referenceSearchMs.map((time, index) => `${format(time * 1000 / count)} (${page.againstGeneratedJavaScript.searchesRun[index]!.pattern})`).join(', ')}`)
  console.log(`- the CPU executor, ${format(page.againstTheLoopProgramsOnTheExecutor.documents, 0)} documents: the highlighter ${format(page.againstTheLoopProgramsOnTheExecutor.validateMicrosecondsPerDocument)}, and the searches ${page.againstTheLoopProgramsOnTheExecutor.referenceSearchMs.map(time => format(time * 1000 / page.againstTheLoopProgramsOnTheExecutor.documents)).join(', ')}`)
}
