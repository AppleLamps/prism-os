// Prints the million-document check's tables as markdown from the JSON files that all.ts wrote.
//
//   bun lab/json-search/million/summarize.ts --from <folder> [--table fit,load,kernels,counts,program,rewrite,js,checks,paint]
//   bun lab/json-search/million/summarize.ts --from lab/json-search/million/results/writer --table writer
//
// A cell of a timing is the median in ms, with the smallest and the largest sample in parentheses. Each table says
// which runs it comes from and the 1-minute load average during them.
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const from = argument('--from')
if (from === undefined) throw new Error('summarize.ts needs --from <folder>')
const wanted = argument('--table')?.split(',')

type Summary = {count: number, median: number, min: number, max: number}
type Series = {totalMs?: Summary, passMs?: Summary, waitMs?: Summary, copyMs?: Summary, patternMs?: Summary, gapMs?: Summary}
type Scope = {scope: string, load: number, loadAfter: number, firstSearchMs: number, backToBack: Series, withTimestamps?: Series, afterPause: (Series & {pauseMs: number, everyMs?: number})[]}
type Checks = {searches: number, values: number, mismatches: number}
type CompactResult = {states: number, engine: string, what: string, patterns: string[], compileMs?: number, error?: string, scopes?: Scope[], checks?: Checks}
type ProgramResult = Scope & {states: number, engine: string, patterns: string[], checks: Checks}
type Process = {pid: number, type: string, residentBytes: number, footprintBytes: number, footprintPeakBytes: number}
type Memory = {javaScriptBytes?: number, usedHeapBytes?: number, processes: {processes: Process[], availableGigabytes: number, swap: string}}
type PatternInfo = {pattern: string, states: number, capacity: number, exactOnBytes: boolean, matches: Record<string, number>, documentsWithMatch: Record<string, number>, regExpDiffers: number, walkDiffers: {keys: number, strings: number}}
type Page = {
  // Only the runs since October 14, 2026 have `searchWriter`. Their searcher compiles every search program when it is
  // created, where the one before compiled the program of 8 states and the others at their first search.
  config: {count: number, mode: string, layout: string, limits: string, keepTexts: boolean, searchWriter?: string},
  error?: string, finishedAt?: string, loadAtStart?: number, loadAtEnd?: number, deviceLost?: string, uncapturedError?: string, f32Error?: string,
  results?: (CompactResult | ProgramResult)[], patterns?: PatternInfo[], memory?: Record<string, Memory>, prepare?: Record<string, number>, buffers?: Record<string, number>,
  paint?: Record<string, {width: number, height: number, fillMs: Summary, putImageDataMs: Summary, fillAndPutMs: Summary, toSecondFrameMs: Summary} & Summary>,
  searcher?: {generateMs: number, createMs: number, load: {cellsMs: number, validateMs: number, totalMs: number}, bufferBytes: Record<string, number>, validCount: number},
  load?: Record<string, unknown> & {bufferBytes: Record<string, number | number[]>, workerMs: Record<string, number>, firstAnswer: {documents: number, searchMs: number}, load: number},
  timeline?: Record<string, number>, deviceLimits?: Record<string, number>,
  js?: Record<string, unknown>, scopes?: Record<string, unknown>,
  // The 'writers' mode: one entry per program, pattern and scope, and their totals.
  comparisons?: {program: string, values: number, mismatches: number, total: number, differFromJavaScript: number}[], compared?: {comparisons: number, values: number, mismatches: number},
}
// A run that is still in progress has no loadAfter yet.
type Run = {name: string, driver: {loadBefore: string, loadAfter?: string, loadSamples: {load: string}[], timedOut?: string, error?: string, browser?: string, machine?: string}, page?: Page}

const runs = new Map<string, Run>()
for (const file of readdirSync(from).filter(name => name.endsWith('.json')).sort()) {
  const parsed = JSON.parse(readFileSync(join(from, file), 'utf8')) as Omit<Run, 'name'>
  runs.set(file.replace(/\.json$/, ''), {name: file.replace(/\.json$/, ''), ...parsed})
}
const run = (name: string) => runs.get(name)
const counts = [100_000, 250_000, 500_000, 1_000_000]
const thousands = (value: number) => value.toLocaleString('en-US')
const digits = (value: number) => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
const cell = (summary: Summary | undefined) => summary === undefined ? '' : `${digits(summary.median)} (${digits(summary.min)} to ${digits(summary.max)})`
const megabytes = (bytes: number | undefined) => bytes === undefined || Number.isNaN(bytes) ? '' : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`
// The 1-minute load average of a run: the smallest and the largest of the driver's samples, every 10 s.
function loadOf(names: readonly string[]) {
  const loads = names.flatMap(name => {
    const driver = run(name)?.driver
    return driver === undefined ? [] : [driver.loadBefore, ...(driver.loadAfter === undefined ? [] : [driver.loadAfter]), ...driver.loadSamples.map(sample => sample.load)].map(text => Number(text.trim().split(/\s+/)[1]))
  }).filter(value => !Number.isNaN(value))
  return loads.length === 0 ? 'not run' : `${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)}`
}
const whole = (value: unknown) => String(Math.round(Number(value)))
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
const tick = (text: string) => `\`${text.replaceAll('|', '\\|')}\``
function section(name: string, title: string, body: () => string) {
  if (wanted !== undefined && !wanted.includes(name)) return
  console.log(`### ${title}\n\n${body()}\n`)
}
const problemsOr = (name: string, otherwise: string) => {
  const found = problems(name)
  return found === '' ? otherwise : found
}
const problems = (name: string): string => {
  const found = run(name)
  if (found === undefined) return 'not run'
  const {driver, page} = found
  return [driver.timedOut, driver.error, page?.error?.split('\n')[0], page?.deviceLost, page?.uncapturedError, page?.finishedAt === undefined ? 'did not finish' : undefined].filter(text => text !== undefined).join('; ')
}
const compactResults = (name: string) => (run(name)?.page?.results ?? []) as CompactResult[]
const pauseOf = (scope: Scope | undefined, pauseMs: number, everyMs?: number) => scope?.afterPause.find(pause => pause.pauseMs === pauseMs && pause.everyMs === everyMs)?.totalMs
// The page's renderer is the one with the largest footprint.
const processesOf = (memory: Memory | undefined) => {
  const processes = memory?.processes.processes ?? []
  const renderer = processes.filter(process => process.type === 'renderer').sort((left, right) => right.footprintBytes - left.footprintBytes)[0]
  return {gpu: processes.find(process => process.type === 'gpu-process'), renderer}
}
const processCell = (process: Process | undefined) => process === undefined ? '' : `${megabytes(process.footprintBytes)} (${megabytes(process.residentBytes)})`
// The footprint when the page measured it, and the largest footprint the process had until then, e.g. while 8 workers
// wrote the documents and the page uploaded them.
const peakCell = (process: Process | undefined) => process === undefined ? '' : `${megabytes(process.footprintBytes)}, at most ${megabytes(process.footprintPeakBytes)}`

section('fit', 'Memory per layout and document count', () => {
  const rows: string[][] = []
  for (const count of counts) {
    const program = run(`program-${count}`)?.page
    const programMemory = program?.memory?.['after creating the searcher']
    const bytes = program?.searcher?.bufferBytes
    const {gpu, renderer} = processesOf(programMemory)
    rows.push([
      'today\'s: one f32 per code point, and one f32 per display kind', thousands(count),
      megabytes(count * 513 * 4), megabytes(count * 512 * 4), megabytes(count * 4 + count * 16),
      megabytes((bytes?.['cells'] ?? count * 2052) + (bytes?.['kinds'] ?? count * 2048) + count * 20),
      megabytes(programMemory?.javaScriptBytes), processCell(gpu), processCell(renderer), problemsOr(`program-${count}`, 'ran'),
    ])
  }
  for (const layout of ['fixed', 'packed']) {
    for (const count of counts) {
      const page = run(`load-${layout}-${count}`)?.page
      const memory = page?.memory?.['after the load']
      const bytes = page?.load?.bufferBytes
      const {gpu, renderer} = processesOf(memory)
      const documentBytes = bytes === undefined ? undefined : layout === 'packed' ? Number(bytes['documentBytesUsed']) + Number(bytes['starts']) : (bytes['documents'] as number[]).reduce((total, size) => total + size, 0)
      const scopeBytes = bytes === undefined ? undefined : Number(bytes['scopes'])
      const resultBytes = bytes === undefined ? undefined : Number(bytes['results'])
      rows.push([
        layout === 'fixed' ? '512 bytes per document, and 2 scope bits per position' : 'packed bytes with a start per document, and 2 scope bits per position', thousands(count),
        megabytes(documentBytes), megabytes(scopeBytes), megabytes(resultBytes),
        megabytes((documentBytes ?? 0) + (scopeBytes ?? 0) + (resultBytes ?? 0)),
        megabytes(memory?.javaScriptBytes), processCell(gpu), processCell(renderer), problemsOr(`load-${layout}-${count}`, 'ran'),
      ])
    }
  }
  const names = [...counts.map(count => `program-${count}`), ...counts.flatMap(count => [`load-fixed-${count}`, `load-packed-${count}`])]
  const noTexts = run('load-fixed-1000000-no-texts')?.page?.memory?.['after the load']
  const defaults = run('load-fixed-1000000-default-limits')?.page
  return [
    `From the \`program\` and \`load\` runs, load average ${loadOf(names)}. The page's thread holds the documents' texts in every row. A process's memory is its footprint, which counts the GPU buffers that the process owns, with the resident size from \`ps\` in parentheses.`,
    '',
    table(['Layout', 'Documents', 'Documents on the GPU', 'Display kinds or scope bits', 'Results', 'GPU buffers in all', 'JavaScript memory', 'Chrome\'s GPU process', 'The page\'s renderer process', 'The run'], rows),
    '',
    `- Without the texts in the page, 1,000,000 documents in the fixed layout: JavaScript ${megabytes(noTexts?.javaScriptBytes)}, GPU process ${processCell(processesOf(noTexts).gpu)}, renderer ${processCell(processesOf(noTexts).renderer)}.`,
    `- With the device that every browser gives without being asked, limits ${JSON.stringify(defaults?.deviceLimits)}: 1,000,000 documents in buffers of ${JSON.stringify(defaults?.load?.bufferBytes['documents'])} bytes, ${String(defaults?.load?.['documentsWithMatch'])} documents with a match for \`${String(defaults?.load?.['pattern'])}\`, the search in ${String(defaults?.load?.['wholeSearchMs'])} ms. ${problemsOr('load-fixed-1000000-default-limits', 'It ran.')}`,
  ].join('\n')
})

section('limits', 'The device limits that each layout needs', () => {
  // WebGPU's default limits, which every device has without being asked.
  const defaultBinding = 134_217_728
  const defaultBuffer = 268_435_456
  const layouts: [name: string, bytesPerDocument: number][] = [
    ['today\'s: one f32 per code point, 2,052 bytes per document, and as much again for the display kinds', 2052],
    ['512 bytes per document', 512],
    ['packed bytes, 301 per document on average', 300.7],
    ['2 scope bits per position, 128 bytes per document', 128],
    ['one match count per document, 4 bytes', 4],
  ]
  const need = (bytes: number) => bytes <= defaultBinding ? `${megabytes(bytes)}, within the defaults` : bytes <= defaultBuffer ? `${megabytes(bytes)}: a larger binding, or 2 buffers` : `${megabytes(bytes)}: a larger binding and buffer, or ${Math.ceil(bytes / defaultBinding)} buffers`
  const adapter = (run('compact-1000000')?.page as {adapter?: {info: {description: string}, limits: Record<string, number>}} | undefined)?.adapter
  return [
    `A device binds ${thousands(defaultBinding)} bytes per storage buffer and creates buffers of up to ${thousands(defaultBuffer)} bytes unless the page asks for more. A cell is the largest buffer of the layout at that count, and what it needs when the documents are in one buffer. The adapter of these runs, ${adapter?.info.description ?? ''}, allows ${thousands(adapter?.limits['maxStorageBufferBindingSize'] ?? 0)} bytes per binding and per buffer.`,
    '',
    table(['Buffer', ...counts.map(thousands), 'Documents per binding of 128 MiB'], layouts.map(([name, bytes]) => [name, ...counts.map(count => need(Math.round(count * bytes))), thousands(Math.floor(defaultBinding / bytes))])),
  ].join('\n')
})

section('load', 'The load, from the navigation, in ms', () => {
  const names = counts.flatMap(count => [`load-fixed-${count}`, `load-packed-${count}`])
  const rows = names.flatMap(name => {
    const page = run(name)?.page
    if (page?.load === undefined || page.timeline === undefined) return []
    const {timeline, load} = page
    return [[
      page.config.layout, thousands(page.config.count), whole(timeline['navigationToScriptMs']), whole(timeline['kernelCompiledMs']), whole(load['firstPieceArrivedMs']),
      whole(timeline['firstAnswerMs']), whole(load['lastPieceArrivedMs']), whole(timeline['everyPieceUploadedMs']), whole(timeline['everyDocumentSearchedMs']),
      `${whole(load.workerMs['generate'])}, ${whole(load.workerMs['pack'])}, ${whole(load.workerMs['highlight'])}`, whole(load['uploadCallsMs']), String(load.load),
    ]]
  })
  const scopeRows = [100_000, 1_000_000].flatMap(count => {
    const scopes = run(`scopes-${count}`)?.page?.scopes as {pieces: number, pieceDocuments: number, firstMs: number, ms: Summary, afterPauseOf1000Ms: Summary, valid: number, comparedWords: number, mismatchedWords: number, onOneThread: {highlightMs: number, scopeBitsMs: number}, compileMs: Record<string, number>, load: number} | undefined
    if (scopes === undefined) return []
    return [[thousands(count), `${scopes.pieces} of ${thousands(scopes.pieceDocuments)}`, digits(scopes.firstMs), cell(scopes.ms), cell(scopes.afterPauseOf1000Ms), `${scopes.compileMs['highlighter']}, ${scopes.compileMs['unpack']}, ${scopes.compileMs['pack']}`, `${digits(scopes.onOneThread.highlightMs)} and ${digits(scopes.onOneThread.scopeBitsMs)}`, `${thousands(scopes.comparedWords)}, ${scopes.mismatchedWords}`, String(scopes.load)]]
  })
  return [
    `From the \`load\` runs: 8 workers write the documents in pieces of 25,000, with their bytes and their scope bits, the page uploads each piece, searches the first piece when it is there, and every document after the last one. One run each, load average ${loadOf(names)}.`,
    '',
    table(['Layout', 'Documents', 'The page\'s script starts', 'The kernel is compiled', 'The first piece arrives', 'The first piece\'s answer', 'The last piece arrives', 'Every piece uploaded', 'Every document searched', 'The workers\' time, summed: writing the texts, the bytes, the scope bits', 'The page\'s writeBuffer calls', 'Load average'], rows),
    '',
    `The scope bits from the JSON highlighter's own pass on the GPU instead, from the \`scopes\` runs, load average ${loadOf(['scopes-100000', 'scopes-1000000'])}. One time is every piece: unpack its bytes, run the highlighter, read back its summary, pack its kinds.`,
    '',
    table(['Documents', 'Pieces', 'The first time, ms', 'Back to back, ms', 'After a pause of 1 s, ms', 'Compile ms: the highlighter, the unpacking kernel, the packing kernel', 'The same in plain JavaScript on one thread, ms: the table loop, and packing the bits', 'Scope words compared with the table loop\'s, and how many differ', 'Load average'], scopeRows),
  ].join('\n')
})

const engineOrder = ['f32-kernel', 'bytes-boundaries', 'bytes', 'bytes-split', 'bytes-scope', 'packed', 'packed-scope', 'bytes-bits', 'bytes-has', 'bytes-scope-has', 'packed-scope-has']
const engineNames: Record<string, string> = {
  'f32-kernel': '`bitRowKernel` as it is, one f32 per code point, a count per document',
  'bytes-boundaries': 'the same kernel on 512 bytes per document',
  bytes: 'with the class of a byte from one table read',
  'bytes-split': 'the same, the documents in four buffers of 128 MiB',
  'bytes-scope': 'with 2 scope bits per position',
  packed: 'packed bytes, no scope bits',
  'packed-scope': 'packed bytes, with scope bits',
  'bytes-bits': 'counts, then a second pass packs them into one bit per document',
  'bytes-has': 'the reverse pass alone, one bit per document',
  'bytes-scope-has': 'the reverse pass alone with scope bits, one bit per document',
  'packed-scope-has': 'packed bytes, the reverse pass alone with scope bits, one bit per document',
  'rewrite-1': 'rewrite 1: every 0-or-1 value as a bit, one table read per pair of states',
  'rewrite-2': 'rewrite 2: also the reads of one sum as one word',
  'program-step': 'the program\'s own step, as loop-emit.ts writes it',
  'program-bits': 'the same step, as bit-emit.ts writes it',
  'program-step-masked': 'the step with a scope, which the demo page runs, as loop-emit.ts writes it',
  'program-bits-masked': 'the step with a scope, as bit-emit.ts writes it',
}
const scopeWords: Record<string, string> = {everything: 'everything', keys: 'keys', strings: 'string values'}

function kernelRows(name: string, engines: readonly string[]) {
  const results = compactResults(name)
  const rows: string[][] = []
  for (const engine of engines) {
    const scopes = [...new Set(results.filter(result => result.engine === engine).flatMap(result => result.scopes?.map(scope => scope.scope) ?? []))]
    for (const scope of scopes) {
      const row = [engineNames[engine] ?? engine, scopeWords[scope] ?? scope]
      for (const states of [8, 16, 32]) {
        const found = results.find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scope)
        row.push(cell(found?.backToBack.totalMs), cell(pauseOf(found, 200)))
      }
      rows.push(row)
    }
  }
  return rows
}
const kernelHead = ['What runs on the GPU', 'The search reads', '8 states: back to back', 'after a pause of 200 ms', '16 states: back to back', 'after a pause of 200 ms', '32 states: back to back', 'after a pause of 200 ms']

const kernelRuns: [name: string, title: string][] = [
  ['compact-1000000', 'One search of 1,000,000 documents with a hand-written kernel, ms, the first run'],
  ['compact-1000000-rested', 'The same again, with a rest of 2 s before each series, on a busier machine'],
  ['compact-1000000-short', 'The main kernels a third time, with a rest of 3 s before each series, and series of 15 searches'],
]
for (const [name, title] of kernelRuns) section('kernels', title, () => {
  const results = compactResults(name)
  const detail: string[][] = []
  for (const engine of ['f32-kernel', 'bytes', 'bytes-scope-has']) {
    for (const states of [8, 16, 32]) {
      const result = results.find(entry => entry.engine === engine && entry.states === states)
      const scope = result?.scopes?.find(entry => entry.scope === (engine === 'bytes-scope-has' ? 'strings' : 'everything'))
      if (scope === undefined) continue
      detail.push([engineNames[engine]!, scopeWords[scope.scope]!, String(states), cell(scope.backToBack.totalMs), cell(scope.withTimestamps?.passMs), cell(scope.backToBack.copyMs), cell(pauseOf(scope, 200)), cell(pauseOf(scope, 1000)), digits(scope.firstSearchMs), digits(result?.compileMs ?? Number.NaN)])
    }
  }
  const page = run(name)?.page
  return [
    `From \`${name}\`, load average ${loadOf([name])}. ${problems(name)} One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.`,
    '',
    table(kernelHead, kernelRows(name, engineOrder)),
    '',
    table(['What runs on the GPU', 'The search reads', 'States', 'Back to back', 'The compute pass alone, from timestamps', 'Copying the results out of the mapped buffer', 'After a pause of 200 ms', 'After a pause of 1 s', 'The first search', 'Compile ms'], detail),
    '',
    `Buffers in this run, bytes: ${JSON.stringify(page?.buffers)}. ${page?.f32Error ?? ''}`,
  ].join('\n')
})

// The run of a million documents that the report's table 3 shows: 'compact-1000000' unless --kernel-run names another
// one, e.g. 'compact-1000000-short', whose series are 15 searches after a rest. The other one of the two is the line
// under the table.
const mainKernelRun = argument('--kernel-run') ?? 'compact-1000000'
const otherKernelRun = mainKernelRun === 'compact-1000000' ? 'compact-1000000-short' : 'compact-1000000'
const seriesOf = (name: string) => name === 'compact-1000000-short' ? 'a series is 15 searches after a rest of 3 s' : 'a series is at least 15 searches and 1 s, with no rest before it'

section('steady', 'How steady a back to back series was: its first three and its last three searches, ms', () => {
  const rows: string[][] = []
  for (const [name] of kernelRuns) {
    for (const [engine, scopeName] of [['f32-kernel', 'everything'], ['bytes', 'everything'], ['bytes-has', 'everything'], ['bytes-scope-has', 'strings']] as const) {
      for (const states of [8, 16, 32]) {
        const scope = compactResults(name).find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scopeName)
        const totals = (scope?.backToBack as {totals?: number[]} | undefined)?.totals
        if (scope === undefined || totals === undefined) continue
        rows.push([name, engineNames[engine]!, String(states), String(totals.length), totals.slice(0, 3).map(digits).join(', '), totals.slice(-3).map(digits).join(', '), cell(pauseOf(scope, 200)), `${scope.load} to ${scope.loadAfter}`])
      }
    }
  }
  return [
    'A back to back series is at least 15 searches and 1 s. Where the last searches of a series took much longer than the first ones, the GPU got slower while the series ran, and the series\' median says little: the first searches, or the smallest sample, are the better estimate of one search on a GPU that is awake.',
    '',
    table(['Run', 'What runs on the GPU', 'States', 'Searches', 'The first three', 'The last three', 'After a pause of 200 ms, for comparison', 'Load average'], rows),
  ].join('\n')
})

section('warm', 'A search after a pause in which the GPU was kept busy, ms', () => {
  const rows: string[][] = []
  for (const name of [...runs.keys()].filter(key => key.startsWith('warm-'))) {
    for (const result of compactResults(name)) {
      for (const scope of result.scopes ?? []) {
        for (const pause of scope.afterPause) {
          rows.push([thousands(run(name)!.page!.config.count), engineNames[result.engine] ?? result.engine, scopeWords[scope.scope] ?? scope.scope, String(result.states), cell(scope.backToBack.totalMs), pause.everyMs === undefined ? `${pause.pauseMs} ms, nothing in between` : `${pause.pauseMs} ms, a search of 64 documents every ${pause.everyMs} ms`, cell(pause.totalMs), `${scope.load} to ${scope.loadAfter}`])
        }
      }
    }
  }
  return table(['Documents', 'What runs on the GPU', 'The search reads', 'States', 'Back to back', 'The pause', 'The search after it', 'Load average'], rows)
})

section('counts', 'One search by document count, 8 states, ms', () => {
  const rows: string[][] = []
  const picks: [engine: string, scope: string][] = [['f32-kernel', 'everything'], ['bytes', 'everything'], ['bytes-scope', 'strings'], ['packed', 'everything'], ['bytes-has', 'everything'], ['bytes-scope-has', 'strings']]
  for (const [engine, scopeName] of picks) {
    for (const states of [8, 16, 32]) {
      const row = [engineNames[engine]!, scopeWords[scopeName]!, String(states)]
      for (const count of counts) {
        const scope = compactResults(`compact-${count}`).find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scopeName)
        row.push(scope === undefined ? '' : `${cell(scope.backToBack.totalMs)}; ${cell(pauseOf(scope, 200))}`)
      }
      rows.push(row)
    }
  }
  return [
    `From the \`compact\` runs, load average ${counts.map(count => `${thousands(count)}: ${loadOf([`compact-${count}`])}`).join(', ')}. A cell is back to back; after a pause of 200 ms.`,
    '',
    table(['What runs on the GPU', 'The search reads', 'States', ...counts.map(thousands)], rows),
  ].join('\n')
})

section('program', 'The program\'s own kernel, searcher.ts, as the demo page ran it when this check was made, ms', () => {
  const rows: string[][] = []
  for (const count of counts) {
    const page = run(`program-${count}`)?.page
    for (const result of (page?.results ?? []) as ProgramResult[]) {
      rows.push([thousands(count), String(result.states), scopeWords[result.scope] ?? result.scope, result.patterns.map(tick).join(', '), cell(result.backToBack.totalMs), cell(result.withTimestamps?.passMs), cell(pauseOf(result, 200)), cell(pauseOf(result, 1000)), `${result.checks.searches}, ${thousands(result.checks.values)}, ${result.checks.mismatches}`, `${result.load} to ${result.loadAfter}`])
    }
    if (page?.results === undefined || page.results.length === 0) rows.push([thousands(count), '', '', '', problems(`program-${count}`), '', '', '', '', ''])
  }
  const created = counts.flatMap(count => {
    const page = run(`program-${count}`)?.page
    const searcher = page?.searcher
    if (page === undefined || searcher === undefined) return []
    // What `load.validateMs` holds follows from when the searcher compiles its search programs.
    const rest = page.config.searchWriter === undefined
      ? `the upload, the highlighter's compile and its pass ${digits(searcher.load.validateMs)} ms, in all with the search shader ${digits(searcher.createMs)} ms`
      : `the upload, the highlighter's shader and pass, and every search program built and compiled, as ${page.config.searchWriter}.ts writes its shader, ${digits(searcher.load.validateMs)} ms, in all ${digits(searcher.createMs)} ms`
    return [`${thousands(count)}: the texts ${digits(searcher.generateMs)} ms, their cells ${digits(searcher.load.cellsMs)} ms, ${rest}`]
  })
  return [
    'From the `program` runs. The time is `timings.totalMs` of the searcher\'s result, which the demo page\'s line shows. A search of more than 1.5 s has no pause series.',
    '',
    table(['Documents', 'States', 'The search reads', 'Patterns', 'Back to back', 'The compute pass alone', 'After a pause of 200 ms', 'After a pause of 1 s', 'Searches compared, values, mismatched', 'Load average'], rows),
    '',
    `Creating the searcher on the page's thread: ${created.join('. ')}.`,
  ].join('\n')
})

section('rewrite', 'The program\'s step, two rewrites of it and the hand-written kernel, 100,000 documents as one f32 per code point, ms', () => {
  const name = 'compact-100000'
  const rows = kernelRows(name, ['program-step', 'rewrite-1', 'rewrite-2', 'f32-kernel', 'bytes', 'bytes-has'])
  const results = compactResults(name)
  const compile = ['program-step', 'rewrite-1', 'rewrite-2', 'f32-kernel'].map(engine => `${engine}: ${[8, 16, 32].map(states => digits(results.find(result => result.engine === engine && result.states === states)?.compileMs ?? Number.NaN)).join(', ')}`)
  return [
    `From \`${name}\`, load average ${loadOf([name])}. ${problems(name)} Every engine's answers were compared with the same plain JavaScript loop for every document.`,
    '',
    table(kernelHead, rows),
    '',
    `Compile ms at 8, 16 and 32 states: ${compile.join('; ')}.`,
  ].join('\n')
})

section('js', 'Regular JavaScript on one thread, ms', () => {
  const out: string[] = []
  for (const count of [1_000_000, 100_000]) {
    const name = `js-${count}`
    const js = run(name)?.page?.js as {
      generateMs: number, characters: number, load: number[], parseAndKeepMs?: number, collectMs?: number, collectedStrings?: {values: number, keys: number},
      wholeText?: {pattern: string, documentsWithMatch: number, ms: Summary}[], jsonParse?: {valid: number, ms: Summary},
      walk?: {pattern: string, stringValues: {documentsWithMatch: number, ms: Summary}, keys: {documentsWithMatch: number, ms: Summary}}[],
      collected?: {pattern: string, stringValues: {documentsWithMatch: number, ms: Summary}, keys: {documentsWithMatch: number, ms: Summary}}[],
      workers?: {workers: number, writingTheDocumentsMs: number, patterns: {pattern: string, documentsWithMatch: number, documentsThatDifferFromOneThread: number, ms: Summary}[]},
    } | undefined
    if (js === undefined) {
      out.push(`${thousands(count)} documents: ${problems(name)}`)
      continue
    }
    const rows = (js.wholeText ?? []).map(whole => {
      const walk = js.walk?.find(entry => entry.pattern === whole.pattern)
      const collected = js.collected?.find(entry => entry.pattern === whole.pattern)
      const workers = js.workers?.patterns.find(entry => entry.pattern === whole.pattern)
      return [tick(whole.pattern), thousands(whole.documentsWithMatch), cell(whole.ms), cell(walk?.stringValues.ms), cell(walk?.keys.ms), cell(collected?.stringValues.ms), cell(collected?.keys.ms), cell(workers?.ms)]
    })
    const memory = run(name)?.page?.memory ?? {}
    out.push(
      `${thousands(count)} documents, from \`${name}\`, load average ${loadOf([name])}. ${problems(name)} Each cell is 9 runs after one run of warmup.`,
      '',
      table(['Pattern', 'Documents with a match', '`texts.filter(text => pattern.test(text)).length`', 'A walk over objects parsed once: string values', 'keys', 'Arrays of strings collected once: string values', 'keys', `The whole-text filter in ${js.workers?.workers ?? 8} workers, which isn't what Cheng asked about`], rows),
      '',
      `- \`JSON.parse\` of every document in a \`try\`: ${cell(js.jsonParse?.ms)} ms, ${thousands(js.jsonParse?.valid ?? 0)} valid.`,
      `- Once: writing the texts ${digits(js.generateMs)} ms, parsing and keeping every object ${digits(js.parseAndKeepMs ?? Number.NaN)} ms, collecting ${thousands(js.collectedStrings?.values ?? 0)} string values and ${thousands(js.collectedStrings?.keys ?? 0)} keys ${digits(js.collectMs ?? Number.NaN)} ms, and the ${js.workers?.workers ?? 8} workers writing their own share of the texts ${digits(js.workers?.writingTheDocumentsMs ?? Number.NaN)} ms.`,
      `- JavaScript memory: ${Object.entries(memory).map(([label, entry]) => `${label}: ${megabytes(entry.javaScriptBytes)}, renderer process ${processCell(processesOf(entry).renderer)}`).join('. ')}.`,
      '',
    )
  }
  return out.join('\n')
})

section('js', 'The whole-text search after a pause of 200 ms, 1,000,000 documents, ms', () => {
  type Paused = {pattern: string, ms: Summary, afterPause?: {ms: Summary}}
  const name = 'js-pause-1000000'
  const js = run(name)?.page?.js as {wholeText?: Paused[], workers?: {workers: number, patterns: Paused[]}} | undefined
  if (js === undefined) return problems(name)
  const rows = (js.wholeText ?? []).map(whole => {
    const workers = js.workers?.patterns.find(entry => entry.pattern === whole.pattern)
    return [tick(whole.pattern), cell(whole.ms), cell(whole.afterPause?.ms), cell(workers?.ms), cell(workers?.afterPause?.ms)]
  })
  return [
    `From \`${name}\`, load average ${loadOf([name])}. ${problems(name)} A search of more than 1.5 s has no series after a pause.`,
    '',
    table(['Pattern', 'One thread, one run after the other', 'One thread, after a pause', `${js.workers?.workers ?? 8} workers, one request after the other`, `${js.workers?.workers ?? 8} workers, after a pause`], rows),
  ].join('\n')
})

section('checks', 'What was compared', () => {
  const rows: string[][] = []
  const grand = {searches: 0, values: 0, mismatches: 0}
  for (const name of [...runs.keys()].filter(key => key.startsWith('compact-') || key.startsWith('program-') || key.startsWith('warm-'))) {
    const page = run(name)?.page
    const results = (page?.results ?? []) as CompactResult[]
    const checks = results.flatMap(result => result.checks === undefined ? [] : [result.checks])
    const total = checks.reduce((sum, check) => ({searches: sum.searches + check.searches, values: sum.values + check.values, mismatches: sum.mismatches + check.mismatches}), {searches: 0, values: 0, mismatches: 0})
    const failed = results.flatMap(result => result.error === undefined ? [] : [`${result.engine} at ${result.states} states: ${result.error.split('\n')[0]}`])
    const found = [problems(name), ...failed].filter(text => text !== '').join('; ')
    rows.push([name, thousands(total.searches), thousands(total.values), thousands(total.mismatches), found === '' ? 'none' : found])
    grand.searches += total.searches
    grand.values += total.values
    grand.mismatches += total.mismatches
  }
  rows.push(['in all', thousands(grand.searches), thousands(grand.values), thousands(grand.mismatches), ''])
  const patterns = run('compact-1000000')?.page?.patterns ?? []
  const patternRows = patterns.map(pattern => [
    tick(pattern.pattern), String(pattern.states), String(pattern.capacity), pattern.exactOnBytes ? 'yes' : 'no',
    thousands(pattern.documentsWithMatch['everything']!), thousands(pattern.documentsWithMatch['keys']!), thousands(pattern.documentsWithMatch['strings']!),
    thousands(pattern.regExpDiffers), thousands(pattern.walkDiffers.keys), thousands(pattern.walkDiffers.strings),
  ])
  return [
    'Every timed search\'s results were compared with the plain JavaScript loop over the same automaton (`createBitRowSearch`), for every document of the run: the match count of each document where the kernel returns counts, and whether each document has a match where it returns bits. For a scope, the loop reads `table-loop.ts`\'s display kinds as its mask.',
    '',
    table(['Run', 'Searches compared', 'Values compared', 'Mismatched', 'Problems'], rows),
    '',
    'The patterns over the 1,000,000 documents, and the documents where regular JavaScript answers "does this document have a match" differently from the loop:',
    '',
    table(['Pattern', 'States', 'Runs on the program for', 'The same matches on bytes', 'Documents with a match: everything', 'keys', 'string values', '`pattern.test(text)` differs', 'The walk over keys differs', 'The walk over string values differs'], patternRows),
  ].join('\n')
})

section('paint', 'Painting the map from one search\'s results, ms', () => {
  const out: string[] = []
  for (const count of [1_000_000, 100_000]) {
    const paint = run(`compact-${count}`)?.page?.paint
    if (paint === undefined) continue
    const rows = Object.entries(paint).filter(([, value]) => typeof value === 'object' && 'fillMs' in value).map(([name, value]) => [name, `${value.width} by ${value.height}`, cell(value.fillMs), cell(value.putImageDataMs), cell(value.fillAndPutMs), cell(value.toSecondFrameMs)])
    out.push(
      `${thousands(count)} documents, 11 paints each after 3 of warmup, alternating between two searches' results:`,
      '',
      table(['What is painted', 'Canvas pixels', 'Writing the pixels', '`putImageData`', 'Both', 'From the start until the second animation frame after it'], rows),
      '',
      `Counting the documents with a match: ${cell(paint['documentsWithMatchFromCountsMs'])} ms from 1,000,000 counts, ${cell(paint['documentsWithMatchFromBitsMs'])} ms from bits.`.replace('1,000,000', thousands(count)),
      '',
    )
  }
  return out.join('\n')
})

// The report's own tables: a few rows of the tables above.
type JsEntry = {pattern: string, ms: Summary}
type JsScoped = {pattern: string, stringValues: {ms: Summary}, keys: {ms: Summary}}
const slowPattern = '([a-z]+)+x'
// The smallest and the largest median over the patterns that don't make RegExp backtrack.
const span = (entries: readonly (Summary | undefined)[]) => {
  const medians = entries.flatMap(entry => entry === undefined ? [] : [entry.median])
  return medians.length === 0 ? '' : `${digits(Math.min(...medians))} to ${digits(Math.max(...medians))}`
}
section('report', 'The report\'s tables', () => {
  const out: string[] = []
  // 1. Does it fit.
  const today = run('program-1000000')?.page
  const todayMemory = today?.memory?.['after creating the searcher']
  const fixed = run('load-fixed-1000000')?.page
  const packed = run('load-packed-1000000')?.page
  const noTexts = run('load-fixed-1000000-no-texts')?.page
  const loadBytes = (page: Page | undefined) => {
    const bytes = page?.load?.bufferBytes
    if (bytes === undefined) return undefined
    const documents = page!.config.layout === 'packed' ? Number(bytes['documentBytesUsed']) + Number(bytes['starts']) : (bytes['documents'] as number[]).reduce((total, size) => total + size, 0)
    return {documents, scopes: Number(bytes['scopes']), results: Number(bytes['results'])}
  }
  const fitRow = (name: string, perDocument: string, memory: Memory | undefined, bytes: {documents: number, scopes: number, results: number} | undefined, underDefaults: string) => [
    name, perDocument, bytes === undefined ? '' : `${megabytes(bytes.documents)} + ${megabytes(bytes.scopes)} + ${megabytes(bytes.results)}`,
    megabytes(memory?.javaScriptBytes), peakCell(processesOf(memory).gpu), peakCell(processesOf(memory).renderer), underDefaults,
  ]
  out.push(
    '**1. Memory at 1,000,000 documents, one run each.** A process\'s memory is its footprint once every document is on the GPU, and the largest footprint it had until then.',
    '',
    table(['Layout', 'Bytes per document', 'GPU buffers: documents + kinds or scope bits + results', 'JavaScript', 'Chrome\'s GPU process', 'The page\'s renderer process, with its workers', 'Documents per buffer under WebGPU\'s default limits'], [
      fitRow('today\'s, through searcher.ts, with the texts in the page', '2,052 + 2,048', todayMemory, today?.searcher === undefined ? undefined : {documents: today.searcher.bufferBytes['cells']!, scopes: today.searcher.bufferBytes['kinds']!, results: today.searcher.bufferBytes['summary']! + today.searcher.bufferBytes['matchCounts']!}, '65,408'),
      fitRow('bytes, 512 per document, with the texts in the page', '512 + 128', fixed?.memory?.['after the load'], loadBytes(fixed), '262,144, so four buffers'),
      fitRow('bytes, packed, with the texts in the page', '301 on average + 4 + 128', packed?.memory?.['after the load'], loadBytes(packed), '445,000 on average'),
      fitRow('bytes, 512 per document, no texts in the page', '512 + 128', noTexts?.memory?.['after the load'], loadBytes(noTexts), ''),
    ]),
    '',
  )
  // 2. The load.
  const loadRows = [100_000, 1_000_000].flatMap(count => {
    const page = run(`load-fixed-${count}`)?.page
    if (page?.load === undefined || page.timeline === undefined) return []
    const {timeline, load} = page
    return [[thousands(count), String(Math.round(timeline['kernelCompiledMs']!)), String(Math.round(Number(load['firstPieceArrivedMs']))), String(Math.round(timeline['firstAnswerMs']!)), String(Math.round(Number(load['lastPieceArrivedMs']))), String(Math.round(timeline['everyDocumentSearchedMs']!)), `${Math.round(load.workerMs['generate']!)}, ${Math.round(load.workerMs['pack']!)}, ${Math.round(load.workerMs['highlight']!)}`, String(load.load)]]
  })
  out.push(
    '**2. The load, ms from the navigation, 512 bytes per document, 8 workers, one run each.**',
    '',
    table(['Documents', 'The kernel is compiled', 'The first piece of 25,000 arrives', 'Its answer is in JavaScript', 'The last piece arrives', 'Every document searched', 'The workers\' time, summed: texts, bytes, scope bits', 'Load average'], loadRows),
    '',
  )
  // 3. One keystroke.
  const million = compactResults(mainKernelRun)
  const kernelRow = (label: string, engine: string, scopeName: string) => {
    const row = [label]
    for (const states of [8, 16, 32]) {
      const scope = million.find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scopeName)
      row.push(scope === undefined ? '' : `${cell(scope.backToBack.totalMs)}; ${cell(pauseOf(scope, 200))}`)
    }
    return row
  }
  const programRow = ['searcher.ts with loop-emit.ts\'s shaders, the program as the page ran it when this check was made, one f32 per code point, a count per document']
  for (const states of [8, 16, 32]) {
    const result = ((today?.results ?? []) as ProgramResult[]).find(entry => entry.states === states && entry.scope === 'everything')
    programRow.push(result === undefined ? '' : `${cell(result.backToBack.totalMs)}; ${cell(pauseOf(result, 200))}`)
  }
  const js = run('js-1000000')?.page?.js as {wholeText?: JsEntry[], walk?: JsScoped[], collected?: JsScoped[], workers?: {patterns: JsEntry[]}, jsonParse?: {ms: Summary}} | undefined
  const ordinary = <Entry extends {pattern: string}>(entries: readonly Entry[] | undefined) => (entries ?? []).filter(entry => entry.pattern !== slowPattern)
  const slow = <Entry extends {pattern: string}>(entries: readonly Entry[] | undefined) => (entries ?? []).find(entry => entry.pattern === slowPattern)
  // The whole-text search after a pause, from the run that measured it.
  type Paused = JsEntry & {afterPause?: {ms: Summary}}
  const paused = run('js-pause-1000000')?.page?.js as {wholeText?: Paused[], workers?: {patterns: Paused[]}} | undefined
  const jsRows = [
    ['`texts.filter(text => pattern.test(text)).length`, whole text', span(ordinary(js?.wholeText).map(entry => entry.ms)), cell(slow(js?.wholeText)?.ms)],
    ['a walk over objects that were parsed once: string values, and keys', `${span(ordinary(js?.walk).map(entry => entry.stringValues.ms))}, and ${span(ordinary(js?.walk).map(entry => entry.keys.ms))}`, `${cell(slow(js?.walk)?.stringValues.ms)}, and ${cell(slow(js?.walk)?.keys.ms)}`],
    ['arrays of strings that were collected once: string values, and keys', `${span(ordinary(js?.collected).map(entry => entry.stringValues.ms))}, and ${span(ordinary(js?.collected).map(entry => entry.keys.ms))}`, `${cell(slow(js?.collected)?.stringValues.ms)}, and ${cell(slow(js?.collected)?.keys.ms)}`],
    ['the whole-text filter in 8 workers, which isn\'t what Cheng asked about', span(ordinary(js?.workers?.patterns).map(entry => entry.ms)), cell(slow(js?.workers?.patterns)?.ms)],
    ['`JSON.parse` of every document, the validation at load', cell(js?.jsonParse?.ms), ''],
  ]
  // The same searches again, from the other run of a million documents.
  const shortRun = compactResults(otherKernelRun)
  const shortCells = (engine: string, scopeName: string) => [8, 16, 32].map(states => {
    const scope = shortRun.find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scopeName)
    return `${cell(scope?.backToBack.totalMs)}; ${cell(pauseOf(scope, 200))}`
  }).join(' at 8 states, ').replace(/ at 8 states, ([^,]+)$/, ' at 16, and $1 at 32')
  const shortLine = shortRun.length === 0 ? '' : `The same searches in \`${otherKernelRun}\`, where ${seriesOf(otherKernelRun)} (load average ${loadOf([otherKernelRun])}), again back to back; after a pause of 200 ms. Which documents match, with a scope: ${shortCells('bytes-scope-has', 'strings')}. Without a scope: ${shortCells('bytes-has', 'everything')}. A count per document, with a scope: ${shortCells('bytes-scope', 'strings')}. Without a scope: ${shortCells('bytes', 'everything')}. \`bitRowKernel\`: ${shortCells('f32-kernel', 'everything')}.`
  // Every run that timed the whole-text search both ways: 'js-pause-1000000', and the runs with only the ordinary patterns.
  const pausedRuns = [...runs.keys()].filter(key => key.startsWith('js-pause-1000000')).sort((left, right) => left.length - right.length || left.localeCompare(right)).map(name => ({name, js: run(name)?.page?.js as {wholeText?: Paused[], workers?: {patterns: Paused[]}} | undefined}))
  const pausedLine = paused === undefined ? '' : `The same searches after a pause of 200 ms, from the runs that time each search both ways, as the smallest and the largest median of the five ordinary patterns. ${pausedRuns.map(({name, js: both}) => `\`${name}\` (load average ${loadOf([name])}): ${span(ordinary(both?.wholeText).map(entry => entry.afterPause?.ms))} ms on one thread after a pause against ${span(ordinary(both?.wholeText).map(entry => entry.ms))} ms without one, and ${span(ordinary(both?.workers?.patterns).map(entry => entry.afterPause?.ms))} ms in 8 workers against ${span(ordinary(both?.workers?.patterns).map(entry => entry.ms))} ms.`).join(' ')}`
  // Other plain ways to write the whole-text search, from the run that times them.
  type Form = {ms: Summary}
  const forms = (run('js-forms-1000000')?.page?.js as {forms?: {pattern: string, filterWithoutFlag: Form, filterWithU: Form, loopWithoutFlag: Form, includes?: Form}[]} | undefined)?.forms
  const flagLine = forms === undefined ? '' : `Every RegExp above has no flag, as in \`/error/\`. Other plain ways to write the whole-text search, from \`js-forms-1000000\` (load average ${loadOf(['js-forms-1000000'])}): the same filter, the filter with the u flag, a loop that counts instead of \`filter\`, and \`text.includes(word)\` for a plain word took ${forms.map(entry => `${[entry.filterWithoutFlag, entry.filterWithU, entry.loopWithoutFlag, ...(entry.includes === undefined ? [] : [entry.includes])].map(form => digits(form.ms.median)).join(', ')} ms for ${tick(entry.pattern)}`).join('; ')}.`
  out.push(
    `**3. One search of 1,000,000 documents, ms.** A kernel's cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From \`${mainKernelRun}\`, where ${seriesOf(mainKernelRun)} (load average ${loadOf([mainKernelRun])}), \`program-1000000\` (${loadOf(['program-1000000'])}) and \`js-1000000\` (${loadOf(['js-1000000'])}).`,
    '',
    table(['What runs on the GPU', 'Patterns of up to 8 states', 'up to 16 states', 'up to 32 states'], [
      kernelRow('hand-written kernel on bytes: which documents match, with a scope (string values)', 'bytes-scope-has', 'strings'),
      kernelRow('the same without a scope', 'bytes-has', 'everything'),
      kernelRow('hand-written kernel on bytes: a match count per document, with a scope (string values)', 'bytes-scope', 'strings'),
      kernelRow('the same without a scope', 'bytes', 'everything'),
      kernelRow('the same on packed bytes', 'packed', 'everything'),
      kernelRow('the lab\'s `bitRowKernel` as it is, one f32 per code point, a count per document', 'f32-kernel', 'everything'),
      programRow,
      // A kernel that the run didn't measure has no row.
    ].filter(row => row.slice(1).some(text => text !== ''))),
    '',
    shortLine,
    '',
    table(['Regular JavaScript on one thread, 9 runs each', 'The five ordinary patterns, the smallest and the largest median', '`([a-z]+)+x`'], jsRows),
    '',
    pausedLine,
    '',
    flagLine,
    '',
  )
  // 4. What was compared.
  const checked = {runs: 0, searches: 0, values: 0, mismatches: 0}
  for (const name of [...runs.keys()].filter(key => key.startsWith('compact-') || key.startsWith('program-') || key.startsWith('warm-'))) {
    checked.runs++
    for (const result of (run(name)?.page?.results ?? []) as CompactResult[]) {
      checked.searches += result.checks?.searches ?? 0
      checked.values += result.checks?.values ?? 0
      checked.mismatches += result.checks?.mismatches ?? 0
    }
  }
  const patterns = run('compact-1000000')?.page?.patterns ?? []
  const differ = patterns.reduce((total, pattern) => total + pattern.regExpDiffers + pattern.walkDiffers.keys + pattern.walkDiffers.strings, 0)
  const scopesChecked = run('scopes-1000000')?.page?.scopes as {comparedWords: number, mismatchedWords: number} | undefined
  // The last two lines of what independent.ts printed, when the folder holds its output.
  const independentFile = join(from, 'independent.txt')
  const independentLine = existsSync(independentFile) ? readFileSync(independentFile, 'utf8').trim().split('\n').slice(-2).join(' ') : undefined
  out.push(
    `**4. What was compared.** Every timed search of the ${checked.runs} kernel and program runs, ${thousands(checked.searches)} searches, was compared with the lab's plain JavaScript loop over the same automaton for every document of its run: the match count per document where the kernel returns counts, and whether the document has a match where it returns bits, with \`table-loop.ts\`'s display kinds as the mask for a scope. ${thousands(checked.values)} values, ${thousands(checked.mismatches)} mismatched. Over the 1,000,000 documents and the ${patterns.length} patterns, \`pattern.test(text)\`, the walk over keys and the walk over string values say "this document has a match" for ${differ === 0 ? 'exactly the same documents as the loop' : `the same documents as the loop, except for ${thousands(differ)}`}. The scope bits from the highlighter's pass on the GPU: ${thousands(scopesChecked?.comparedWords ?? 0)} words compared with the table loop's, ${thousands(scopesChecked?.mismatchedWords ?? 0)} mismatched.${independentLine === undefined ? '' : ` The review's independent count, which shares only the document generator with the above, compared what the main kernels returned over everything, string values and keys with \`RegExp\` over the whole text and over every string value and key of the parsed document. ${independentLine} A kernel's scope reads the text as written, with its quotes and escapes, which is where the two added patterns differ, see independent.txt.`}`,
    '',
  )
  // 5. The map.
  const paint = run(mainKernelRun)?.page?.paint ?? run('compact-1000000')?.page?.paint
  if (paint !== undefined) {
    out.push(
      '**5. The map of 1,000,000 documents, ms, 11 paints each.**',
      '',
      table(['What is painted', 'Canvas pixels', 'Writing the pixels and `putImageData`'], Object.entries(paint).filter(([, value]) => typeof value === 'object' && 'fillMs' in value).map(([name, value]) => [name, `${value.width} by ${value.height}`, cell(value.fillAndPutMs)])),
      '',
    )
  }
  // 5. The rewrites.
  out.push(
    `**6. The program's step and what a rewrite of its operations gives, 100,000 documents as one f32 per code point, ms.** Back to back; after a pause of 200 ms. From \`compact-100000\`, load average ${loadOf(['compact-100000'])}.`,
    '',
    table(['What runs on the GPU', '8 states', '16 states', '32 states'], ['program-step', 'rewrite-1', 'rewrite-2', 'f32-kernel'].map(engine => {
      const row = [engineNames[engine]!]
      for (const states of [8, 16, 32]) {
        const scope = compactResults('compact-100000').find(result => result.engine === engine && result.states === states)?.scopes?.[0]
        row.push(scope === undefined ? '' : `${cell(scope.backToBack.totalMs)}; ${cell(pauseOf(scope, 200))}`)
      }
      return row
    })),
  )
  return out.join('\n')
})

// The code writer's check: every run of the folder that timed bit-emit.ts's shader, and every 'writers' run.
if (wanted?.includes('writer') === true) section('writer', 'The search step as each code writer writes it, 100,000 documents as one f32 per code point, ms', () => {
  const out: string[] = []
  const engines = ['program-step', 'program-bits', 'rewrite-2', 'program-step-masked', 'program-bits-masked']
  for (const name of [...runs.keys()].filter(key => compactResults(key).some(result => result.engine === 'program-bits'))) {
    const results = compactResults(name)
    const rows: string[][] = []
    const checked = {searches: 0, values: 0, mismatches: 0}
    for (const engine of engines) {
      const scopes = [...new Set(results.filter(result => result.engine === engine).flatMap(result => result.scopes?.map(scope => scope.scope) ?? []))]
      for (const scope of scopes) {
        const row = [engineNames[engine] ?? engine, scopeWords[scope] ?? scope]
        for (const states of [8, 16, 32]) {
          const found = results.find(result => result.engine === engine && result.states === states)?.scopes?.find(entry => entry.scope === scope)
          row.push(found === undefined ? '' : `${cell(found.backToBack.totalMs)}; ${cell(pauseOf(found, 200))}`)
        }
        rows.push(row)
      }
    }
    for (const result of results) {
      checked.searches += result.checks?.searches ?? 0
      checked.values += result.checks?.values ?? 0
      checked.mismatches += result.checks?.mismatches ?? 0
    }
    const compile = engines.map(engine => `${engineNames[engine] ?? engine}: ${[8, 16, 32].map(states => digits(results.find(result => result.engine === engine && result.states === states)?.compileMs ?? Number.NaN)).join(', ')}`)
    out.push(
      `From \`${name}\`, load average ${loadOf([name])}. ${problems(name)} A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.`,
      '',
      table(['What runs on the GPU', 'The search reads', '8 states', '16 states', '32 states'], rows),
      '',
      `Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: ${compile.join('; ')}.`,
      '',
      `Every timed search was compared with the lab's plain JavaScript loop for every document: ${thousands(checked.searches)} searches, ${thousands(checked.values)} values, ${thousands(checked.mismatches)} mismatched.`,
      '',
    )
  }
  for (const [name, found] of runs) {
    const page = found.page
    if (page?.comparisons === undefined) continue
    const search = page.comparisons.filter(entry => entry.program.startsWith('the search step'))
    const sets = page.comparisons.filter(entry => entry.program === 'the characters of the wanted sets')
    const highlighter = page.comparisons.filter(entry => entry.program.startsWith('the JSON highlighter'))
    const sum = (entries: readonly {values: number, mismatches: number}[]) => `${thousands(entries.reduce((total, entry) => total + entry.values, 0))} values, ${thousands(entries.reduce((total, entry) => total + entry.mismatches, 0))} mismatched`
    out.push(
      `From \`${name}\`, ${thousands(page.config.count)} documents, load average ${loadOf([name])}. ${problems(name)} Every output of bit-emit.ts's shader against loop-emit.ts's on the GPU. The highlighter's summary and display kinds: ${sum(highlighter)}. The count and the marks of character-sets.ts's program, for ${sets.length} choices of sets: ${sum(sets)}, ${thousands(sets.reduce((total, entry) => total + entry.total, 0))} characters counted, and ${thousands(sets.reduce((total, entry) => total + entry.differFromJavaScript, 0))} of ${thousands(sets.length * page.config.count)} counts differ from plain JavaScript's. The search step's match count of every document and mark of every position, ${search.length} searches (each pattern at each state capacity that holds it, without a scope and with each of three scopes): ${sum(search)}, and ${thousands(search.reduce((total, entry) => total + entry.total, 0))} matches in all. In total ${thousands(page.compared?.values ?? 0)} values, ${thousands(page.compared?.mismatches ?? 0)} mismatched.`,
      '',
    )
  }
  return out.join('\n')
})

if (existsSync(join(from, 'stats.txt')) && (wanted === undefined || wanted.includes('stats'))) console.log(`### The documents and the patterns, from stats.ts\n\n${readFileSync(join(from, 'stats.txt'), 'utf8')}`)
