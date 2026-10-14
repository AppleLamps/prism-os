// The GPU measurement page for the combination: searcher.ts as a demo page would use it. combined-run.ts serves it, opens
// it in headless Chrome, and writes what it posts to /result. Per document count it creates a GPU searcher, which
// validates every document with the highlighter's loop and compiles the search program, and then:
// - compares the searcher's validation of every document, and every display kind, with the plain JavaScript table loop,
//   and runs the searcher's own self check against the same programs on the CPU;
// - times the highlighter's pass, back to back and after pauses;
// - times one search per scope, back to back and after pauses, with a different pattern each time, and compares every
//   match count, and the marks of the window's documents, with the plain JavaScript loop over the same automaton
//   (bit-rows.ts), which this page first compares with the loop program on the CPU for the first documents;
// - times the same answers in plain JavaScript (plain-search.ts: the table loop, then RegExp per search), JSON.parse,
//   and the same programs on the CPU.
// In 'straightLine' runs it also compiles the first stage's display shader, every position written out, to time it in
// the same process as the loop.
import {capacityErrors, compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {type KindMask, bitRowTables, createBitRowSearch} from '../../../tests/json-search/bit-rows.ts'
import {generateDocuments} from '../../../src/json-search/documents.ts'
import {createPlainSearch} from '../../../src/json-search/plain-search.ts'
import {buildBatchProgram, cellsPerDocument, kindCount, writeDocumentCells} from '../../../src/json-search/program.ts'
import {type SearchScope, boundaryCapacity, classCapacity, kindCount as displayKindCount, searchableKinds} from '../../../src/json-search/search-step.ts'
import {capacity as positions} from '../../../src/json-search/highlighter/kinds.ts'
import {type Searcher, type ShaderWriter, bufferBytesFor, createCpuSearcher, createGpuSearcher} from '../../../src/json-search/searcher.ts'
import {highlightWithTables, tableLoopResult} from '../../../src/json-search/table-loop.ts'
import {createDocumentStore, createProgramRunner, requestBatchDevice} from '../../../src/json-search/gpu/host.ts'
import {type SamplingConfig, compileEmptyPipeline, createReporter, round, sample, sleep, summary, timeCpu} from './measure.ts'

export type CombinedPageConfig = SamplingConfig & {
  counts: number[]
  // The patterns a search is timed with, in turn, per state capacity.
  patterns: string[]
  scopes: SearchScope[]
  // One evaluation after the page left the GPU alone for this long.
  idleGapsMs: number[]
  idleSamples: number
  windowDocuments: number
  shaderSalt: number
  // Which writer writes the search programs' shaders and the highlighter's, see searcher.ts.
  writers: {search: ShaderWriter, highlighter: ShaderWriter}
  seed: number
  invalidFraction: number
  // How many documents the plain JavaScript loop is compared with the loop program on the CPU, and how many the
  // programs on the CPU are timed on.
  cpuDocuments: number
  executorDocuments: number
  selfCheckDocuments: number
  // The 32-state program is timed up to this many documents, since one search of loop-emit.ts's shader takes about
  // 1 s per 100,000.
  largestCountFor32States: number
  // Also compiles and times the first stage's display shader at the largest count.
  straightLine: boolean
}

const {report, post, log} = createReporter()
const config = await (await fetch('/config')).json() as CombinedPageConfig
report['config'] = config

type Timed = {totalMs: number, patternMs: number, evaluateMs: number, passMs: number | undefined, gapMs: number}
const summarizeTimed = (records: readonly Timed[]) => ({
  // From before JavaScript compiles the pattern until the copies of the values that were read back exist.
  totalMs: summary(records.map(record => record.totalMs)),
  patternMs: summary(records.map(record => record.patternMs)),
  evaluateMs: summary(records.map(record => record.evaluateMs)),
  passMs: summary(records.map(record => record.passMs)),
  gapMs: summary(records.map(record => record.gapMs)),
})

async function run() {
  const maxCount = Math.max(...config.counts)
  const documents = generateDocuments(maxCount, config.seed, config.invalidFraction)
  const allTexts = documents.map(document => document.text)
  const granted = await requestBatchDevice(bufferBytesFor(maxCount))
  const {device} = granted
  void device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
    void post(true)
  })
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
    void post(true)
  })
  report['adapter'] = {info: granted.adapterInfo, limits: granted.adapterLimits, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(device, config.shaderSalt))

  const capacityOf = (pattern: string) => [8, 16, 32].find(states => capacityErrors(compilePattern(pattern), {states, classes: classCapacity, boundaries: boundaryCapacity}).length === 0)
  const patternsOf = (states: number) => config.patterns.filter(pattern => capacityOf(pattern) === states)
  const results: Record<string, unknown>[] = []
  report['results'] = results
  let sink = 0

  for (const [countIndex, count] of config.counts.entries()) {
    const texts = allTexts.slice(0, count)
    const entry: Record<string, unknown> = {count, at: new Date().toISOString()}
    results.push(entry)

    // Plain JavaScript: the table loop for validity, the first error and the kinds, and JSON.parse for validity only.
    const plain = createPlainSearch(texts)
    const kindsScratch = new Uint8Array(positions)
    const plainTimes: Record<string, unknown> = {
      tableLoop: timeCpu(config, () => {
        for (let index = 0; index < count; index++) {
          highlightWithTables(texts[index]!, kindsScratch, 0)
          sink += tableLoopResult.firstErrorPosition
        }
      }, count),
      jsonParse: timeCpu(config, () => {
        for (let index = 0; index < count; index++) {
          try {
            JSON.parse(texts[index]!)
            sink++
          } catch {}
        }
      }, count),
    }
    entry['plainJavaScript'] = plainTimes

    // The searcher, as a page creates it. A different salt per count, so that every count compiles cold.
    const searcher: Searcher = await createGpuSearcher(device, texts, {windowCapacity: config.windowDocuments, shaderSalt: config.shaderSalt + countIndex, writers: config.writers})
    entry['load'] = {cellsMs: round(searcher.load.cellsMs), validateMs: round(searcher.load.validateMs), totalMs: round(searcher.load.totalMs), megabytesOfCells: round(count * cellsPerDocument * 4 / 1e6)}
    entry['limits'] = searcher.limits
    log(`${count} documents: searcher created in ${round(searcher.load.totalMs)} ms, ${JSON.stringify(searcher.programs())}`)

    // The validation of every document and every display kind against the table loop.
    const validationCheck = {documents: count, values: 0, mismatches: 0, validDocuments: searcher.validation.validCount}
    for (const name of ['valid', 'firstErrorPosition', 'firstErrorKind', 'truncated'] as const) {
      validationCheck.values += count
      for (let row = 0; row < count; row++) if (searcher.validation[name][row] !== plain.validation[name][row]) validationCheck.mismatches++
    }
    const chunk = 4096
    for (let first = 0; first < count; first += chunk) {
      const documentCount = Math.min(chunk, count - first)
      const kinds = await searcher.kinds({firstDocument: first, documentCount})
      validationCheck.values += kinds.length
      for (let index = 0; index < kinds.length; index++) if (kinds[index] !== plain.kinds[first * positions + index]) validationCheck.mismatches++
    }
    entry['validationCheck'] = validationCheck
    entry['selfCheck'] = await searcher.selfCheck(Math.min(count, config.selfCheckDocuments))
    log(`${count} documents: validation ${JSON.stringify(validationCheck)}, self check ${JSON.stringify(entry['selfCheck'])}`)
    await post(false)

    // The highlighter's pass again, with the documents on the GPU.
    let previousEnd = performance.now()
    const validateOnce = async (options: {timestamps?: boolean, gapStart?: number}): Promise<Timed> => {
      const gapMs = performance.now() - (options.gapStart ?? previousEnd)
      const {validation, evaluateMs, passMs} = await searcher.validate(options.timestamps === true ? {timestamps: true} : {})
      previousEnd = performance.now()
      if (validation.validCount !== searcher.validation.validCount) validationCheck.mismatches++
      return {totalMs: evaluateMs, patternMs: 0, evaluateMs, passMs, gapMs}
    }
    const validate: Record<string, unknown> = {backToBack: summarizeTimed(await sample(config, () => validateOnce({})))}
    if (granted.hasTimestamps) validate['withTimestamps'] = summarizeTimed(await sample(config, () => validateOnce({timestamps: true})))
    const validateIdle: Record<string, unknown>[] = []
    for (const gap of config.idleGapsMs) {
      const records: Timed[] = []
      for (let index = 0; index < config.idleSamples; index++) {
        const gapStart = performance.now()
        await sleep(gap)
        records.push(await validateOnce({gapStart}))
      }
      validateIdle.push({idleMs: gap, ...summarizeTimed(records)})
    }
    validate['afterIdle'] = validateIdle
    entry['validate'] = validate
    log(`${count} documents: validate back to back ${(validate['backToBack'] as ReturnType<typeof summarizeTimed>).totalMs?.median} ms`)

    // The searches. Expected values: the plain JavaScript loop over the automaton, masked by the table loop's kinds.
    const window = {firstDocument: Math.floor((count - Math.min(count, config.windowDocuments)) / 2), documentCount: Math.min(count, config.windowDocuments)}
    const searchableOf = (scope: SearchScope) => {
      const searchable = new Uint8Array(displayKindCount)
      for (const kind of searchableKinds(scope)) searchable[kind] = 1
      return searchable
    }
    const expectedCounts = new Map<string, Float32Array>()
    const expectedFor = (pattern: string, scope: SearchScope) => {
      const key = `${pattern}\n${String(scope)}`
      let counts = expectedCounts.get(key)
      if (counts === undefined) {
        const search = createBitRowSearch(bitRowTables(compilePattern(pattern), 32), positions)
        const mask: KindMask = {kinds: plain.kinds, offset: 0, searchable: searchableOf(scope)}
        counts = new Float32Array(count)
        for (let row = 0; row < count; row++) {
          mask.offset = row * positions
          counts[row] = search(texts[row]!, undefined, 0, mask)
        }
        expectedCounts.set(key, counts)
      }
      return counts
    }
    const expectedMarks = new Uint8Array(window.documentCount * positions)
    const searchChecks = {searches: 0, values: 0, mismatches: 0}
    const compare = (pattern: string, scope: SearchScope, counts: Float32Array, marks: Float32Array, first: number, documentCount: number) => {
      const expected = expectedFor(pattern, scope)
      searchChecks.searches++
      searchChecks.values += documentCount + marks.length
      for (let index = 0; index < documentCount; index++) if (counts[index] !== expected[first + index]) searchChecks.mismatches++
      const search = createBitRowSearch(bitRowTables(compilePattern(pattern), 32), positions)
      const mask: KindMask = {kinds: plain.kinds, offset: 0, searchable: searchableOf(scope)}
      for (let row = 0; row < window.documentCount; row++) {
        mask.offset = (window.firstDocument + row) * positions
        search(texts[window.firstDocument + row]!, expectedMarks, row * positions, mask)
      }
      for (let index = 0; index < marks.length; index++) if (marks[index] !== expectedMarks[index]) searchChecks.mismatches++
    }

    // The plain JavaScript loop against the loop program on the CPU, for the first documents.
    const cpuDocuments = Math.min(count, config.cpuDocuments)
    const cpuSearcher = createCpuSearcher(texts.slice(0, cpuDocuments), {windowCapacity: cpuDocuments})
    const oracleCheck = {documents: cpuDocuments, searches: 0, values: 0, mismatches: 0}
    const oracleMarks = new Uint8Array(positions)
    for (const pattern of config.patterns) {
      for (const scope of config.scopes) {
        const result = await cpuSearcher.search({pattern, scope, window: {firstDocument: 0, documentCount: cpuDocuments}})
        if (result?.status !== 'searched') throw new Error(`the CPU searcher didn't search ${pattern}`)
        const search = createBitRowSearch(bitRowTables(compilePattern(pattern), 32), positions)
        const mask: KindMask = {kinds: plain.kinds, offset: 0, searchable: searchableOf(scope)}
        oracleCheck.searches++
        for (let row = 0; row < cpuDocuments; row++) {
          mask.offset = row * positions
          const expected = search(texts[row]!, oracleMarks, 0, mask)
          oracleCheck.values += 1 + positions
          if (result.matchCounts[row] !== expected) oracleCheck.mismatches++
          for (let position = 0; position < positions; position++) if (result.marks[row * positions + position] !== oracleMarks[position]) oracleCheck.mismatches++
        }
      }
    }
    entry['plainLoopAgainstTheProgramOnTheCpu'] = oracleCheck
    log(`${count} documents: the plain loop against the program on the CPU ${JSON.stringify(oracleCheck)}`)

    const searchResults: Record<string, unknown>[] = []
    entry['searches'] = searchResults
    for (const states of [8, 16, 32]) {
      const patterns = patternsOf(states)
      if (patterns.length === 0 || (states === 32 && count > config.largestCountFor32States)) continue
      for (const scope of config.scopes) {
        let turn = 0
        previousEnd = performance.now()
        const searchOnce = async (options: {timestamps?: boolean, gapStart?: number, documents?: 'all' | 'window'}): Promise<Timed> => {
          const pattern = patterns[turn++ % patterns.length]!
          const gapMs = performance.now() - (options.gapStart ?? previousEnd)
          const started = performance.now()
          const result = await searcher.search({pattern, scope, window, ...(options.documents === undefined ? {} : {documents: options.documents}), ...(options.timestamps === true ? {timestamps: true} : {})})
          const totalMs = performance.now() - started
          previousEnd = performance.now()
          if (result?.status !== 'searched' || result.states !== states) throw new Error(`unexpected result for ${pattern}: ${JSON.stringify(result?.status)}`)
          if (options.documents === 'window') compare(pattern, scope, result.matchCounts, result.marks, window.firstDocument, window.documentCount)
          else compare(pattern, scope, result.matchCounts, result.marks, 0, count)
          return {totalMs, patternMs: result.timings.patternMs, evaluateMs: result.timings.evaluateMs, passMs: result.timings.passMs, gapMs}
        }
        const result: Record<string, unknown> = {states, scope, patterns}
        result['backToBack'] = summarizeTimed(await sample(config, () => searchOnce({})))
        if (granted.hasTimestamps) result['withTimestamps'] = summarizeTimed(await sample(config, () => searchOnce({timestamps: true})))
        // After a pause, and the window's documents alone, for the first scope of each capacity.
        if (scope === config.scopes[0]) {
          const idle: Record<string, unknown>[] = []
          for (const gap of config.idleGapsMs) {
            const records: Timed[] = []
            for (let index = 0; index < config.idleSamples; index++) {
              const gapStart = performance.now()
              await sleep(gap)
              records.push(await searchOnce({gapStart}))
            }
            idle.push({idleMs: gap, ...summarizeTimed(records)})
          }
          result['afterIdle'] = idle
          result['windowOnly'] = summarizeTimed(await sample(config, () => searchOnce({documents: 'window'})))
        }
        searchResults.push(result)
        log(`${count} documents, ${states} states, ${String(scope)}: back to back ${(result['backToBack'] as ReturnType<typeof summarizeTimed>).totalMs?.median} ms, checks so far ${JSON.stringify(searchChecks)}`)
        await post(false)
      }
    }
    entry['searchChecks'] = searchChecks
    entry['programs'] = searcher.programs().map(program => ({...program, compileMs: program.compileMs === undefined ? undefined : round(program.compileMs)}))

    // The same searches in plain JavaScript: RegExp on each run of searched characters.
    const regExp: Record<string, unknown>[] = []
    plainTimes['regExp'] = regExp
    for (const pattern of config.patterns) {
      for (const scope of config.scopes) {
        const expected = expectedFor(pattern, scope)
        // The first search of a scope finds its runs of searched characters, and the timed ones only run RegExp.
        const {matchCounts, matches, prepareMs, runs} = plain.search(pattern, scope)
        let sameCount = 0
        for (let row = 0; row < count; row++) if (matchCounts[row] === expected[row]) sameCount++
        regExp.push({pattern, scope, states: compilePattern(pattern).automaton.stateCount, matches, documentsWhereTheProgramCountsTheSame: sameCount, runs, findingTheRunsMs: round(prepareMs), ...timeCpu(config, () => {
          sink += plain.search(pattern, scope).matches
        }, count)})
      }
    }

    // The same programs on the CPU, for the first documents: generated JavaScript, and the CPU executor.
    const executorDocuments = Math.min(count, config.executorDocuments)
    const executorSearcher = createCpuSearcher(texts.slice(0, executorDocuments), {backend: 'executor'})
    const cpuPrograms: Record<string, unknown>[] = []
    entry['programsOnTheCpu'] = cpuPrograms
    for (const [name, cpu, documentCount] of [['generated JavaScript', cpuSearcher, cpuDocuments], ['CPU executor', executorSearcher, executorDocuments]] as const) {
      const programTimes: Record<string, unknown> = {name, documents: documentCount, validateMs: round(cpu.load.validateMs), validateMicrosecondsPerDocument: round(cpu.load.validateMs * 1000 / documentCount)}
      for (const states of [8, 16, 32]) {
        const pattern = patternsOf(states)[0]
        if (pattern === undefined) continue
        const times: number[] = []
        for (let repeat = 0; repeat < 4; repeat++) {
          const result = await cpu.search({pattern, scope: config.scopes[0]!})
          if (result?.status !== 'searched') throw new Error(`the CPU searcher didn't search ${pattern}`)
          if (repeat > 0) times.push(result.timings.totalMs * 1000 / documentCount)
        }
        programTimes[`searchMicrosecondsPerDocumentAt${states}States`] = summary(times)?.median
      }
      cpuPrograms.push(programTimes)
    }
    log(`${count} documents: on the CPU ${JSON.stringify(cpuPrograms)}`)
    searcher.destroy()
    await post(false)
  }

  if (config.straightLine) {
    // The first stage's display shader, every position written out, in the same process: its compile, and one
    // evaluation with the summary of every document and the kinds of the window read back.
    const texts = allTexts
    const cells = new Float32Array(maxCount * cellsPerDocument)
    for (let row = 0; row < maxCount; row++) writeDocumentCells(cells, row * cellsPerDocument, texts[row]!)
    const store = await createDocumentStore(device, cellsPerDocument, maxCount)
    store.write(cells, maxCount)
    const program = buildBatchProgram('display')
    const shader = program.emitShader()
    const runner = await createProgramRunner(device, shader, program.packShared(shader), store, config.shaderSalt)
    const straight: Record<string, unknown>[] = []
    for (const count of config.counts) {
      const windowDocuments = Math.min(count, config.windowDocuments)
      const readbacks = [{group: 0, firstDocument: 0, documentCount: count}, {group: 1, firstDocument: Math.floor((count - windowDocuments) / 2), documentCount: windowDocuments}]
      const totals = await sample(config, async () => (await runner.evaluate({count, readbacks})).totalMs)
      straight.push({count, backToBackMs: summary(totals)})
    }
    report['straightLineDisplayShader'] = {statements: shader.statementCount, shaderBytes: shader.bytes, compileMs: round(runner.compileMs), kindsPerDocument: kindCount, byCount: straight}
    log(`the display shader with every position written out: ${JSON.stringify(report['straightLineDisplayShader'])}`)
    runner.destroy()
    store.destroy()
  }
  report['sink'] = sink
}

try {
  await run()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
