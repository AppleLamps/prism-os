// The GPU measurement page for regex search over many documents. search-run.ts serves it, opens it in headless Chrome,
// and writes what it posts to /result. Per capacity (states, positions) it compiles each engine's shader cold, checks
// every pattern, and times one search at each document count.
//
// The engines, i.e. what runs on the GPU:
//   step         the loop shader of search-step.ts: the program's own step, once per position, every position
//   step-stop    the same, with both loops stopping at the text's end
//   step-f32     'step' with the reverse pass's bits kept as one f32 each instead of one word per position
//   step-layers  'step' with each stage's statements in the compiled program's order, layer after layer
//   kernel     bit-rows.ts's hand-written kernel, as a comparison. It isn't the repo's program.
//
// One timed search is what a page does when the pattern changes: JavaScript compiles the pattern and writes its cells,
// the cells are uploaded, one compute pass runs every document, and the match count of every document comes back,
// with the marks of `windowDocuments` documents for the loop shaders. Consecutive searches use different patterns, and
// every readback is compared with the plain JavaScript loop over the same automaton (bit-rows.ts), which this page
// first compares with the program on the CPU: the loop program on generated JavaScript for the first `stepDocuments`
// documents, and the program with every position written out on the CPU executor for the first `executorDocuments`.
import {buildDataSearch, writePattern} from '../../regex-search/data-program.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../../regex-search/pattern.ts'
import {type BitRowTables, bitRowKernel, bitRowTables, createBitRowSearch} from '../bit-rows.ts'
import {generateDocuments} from '../documents.ts'
import {emitLoopWgsl} from '../loop-emit.ts'
import {createLoopRunner, describeLoop, operationsPerDocument} from '../loop-program.ts'
import {cellsPerDocument, writeDocumentCells} from '../program.ts'
import {type SearchLoop, boundaryCapacity, buildSearchLoop, classCapacity} from '../search-step.ts'
import {type DocumentStore, type KernelRunner, type ProgramRunner, createDocumentStore, createKernelRunner, createProgramRunner, requestBatchDevice} from './host.ts'

export type Engine = 'step' | 'step-stop' | 'step-f32' | 'step-layers' | 'kernel'

export type SearchPageConfig = {
  sizes: [states: number, positions: number][]
  counts: number[]
  engines: Engine[]
  // The patterns to check and to time RegExp with. A search is timed with the ones that fit the capacity, in turn.
  patterns: string[]
  // One search after the page left the GPU alone for this long, for these engines.
  idleGapsMs: number[]
  idleSamples: number
  idleEngines: Engine[]
  windowDocuments: number
  shaderSalt: number
  seed: number
  invalidFraction: number
  workgroupSize: number
  warmupMs: number
  sampleMs: number
  minimumSamples: number
  maximumSamples: number
  cpuWarmupMs: number
  cpuSampleMs: number
  cpuSamples: number
  // How many documents the program on the CPU is checked and timed on.
  stepDocuments: number
  executorDocuments: number
  // The program with every position written out is only built up to this many operations, e.g. 572,064 at 32 states
  // and 256 code points, since building it holds about 0.5 KB of heap per operation.
  fullProgramMaxOperations: number
}

const round = (value: number) => Math.round(value * 1000) / 1000
function summary(values: readonly (number | undefined)[]) {
  const sorted = values.filter(value => value !== undefined).sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  // The median of an even count is the mean of the two middle values.
  const middle = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return {count: sorted.length, median: round(median), p10: round(at(0.1)), p90: round(at(0.9)), min: round(sorted[0]!), max: round(sorted.at(-1)!)}
}
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

// crossOriginIsolated is true when the driver's headers took effect, and performance.now() reads in steps of 5 µs.
const report: Record<string, unknown> = {startedAt: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated: globalThis.crossOriginIsolated}
const logLines: string[] = []
async function post(done: boolean) {
  await fetch('/result', {method: 'POST', body: JSON.stringify({...report, logLines, done})})
}
function log(line: string) {
  console.log(line)
  logLines.push(`${round(performance.now())} ms: ${line}`)
  document.querySelector('#log')!.textContent = logLines.join('\n')
}

const config = await (await fetch('/config')).json() as SearchPageConfig
report['config'] = config

// µs per document of a JavaScript loop over `count` documents: cpuWarmupMs and at least 2 runs of warmup, then
// cpuSamples samples of whole runs, each at least cpuSampleMs, and their median.
function timeCpu(run: () => void, count: number) {
  const warmUntil = performance.now() + config.cpuWarmupMs
  for (let runs = 0; runs < 2 || performance.now() < warmUntil; runs++) run()
  const samples: number[] = []
  for (let index = 0; index < config.cpuSamples; index++) {
    let runs = 0
    const started = performance.now()
    do {
      run()
      runs++
    } while (performance.now() - started < config.cpuSampleMs)
    samples.push((performance.now() - started) * 1000 / (runs * count))
  }
  return {microsecondsPerDocument: summary(samples)!.median, samples: samples.map(round)}
}

// Evaluates until at least warmupMs and 3 evaluations have passed, then samples until sampleMs and minimumSamples have
// passed, or maximumSamples. A slow search, e.g. 2 s, stops at 5 samples once 4 times sampleMs have passed.
async function sample<Sample>(evaluateOnce: () => Promise<Sample>) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 && (warm < 1 || performance.now() - warmStarted < 4 * config.sampleMs) || performance.now() - warmStarted < config.warmupMs; warm++) await evaluateOnce()
  const samples: Sample[] = []
  const started = performance.now()
  while (samples.length < config.maximumSamples) {
    const elapsed = performance.now() - started
    if (samples.length >= config.minimumSamples && elapsed >= config.sampleMs) break
    if (samples.length >= 5 && elapsed >= 4 * config.sampleMs) break
    samples.push(await evaluateOnce())
  }
  return samples
}

// One search's times in ms. patternMs is JavaScript before the upload: compiling the pattern and writing its cells.
type Timed = {patternMs: number, uploadMs: number, waitMs: number, copyMs: number, totalMs: number, passMs: number | undefined, gapMs: number}
const summarizeTimed = (records: readonly Timed[]) => ({
  patternMs: summary(records.map(record => record.patternMs)),
  uploadMs: summary(records.map(record => record.uploadMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  // From before JavaScript compiles the pattern until the values that were read back are in JavaScript arrays.
  totalMs: summary(records.map(record => record.totalMs)),
  passMs: summary(records.map(record => record.passMs)),
  // From the end of the previous search to the start of this one: the comparison with the expected values, and in an
  // idle series the gap itself.
  gapMs: summary(records.map(record => record.gapMs)),
})

function codePointSlice(text: string, positions: number) {
  // A text of at most `positions` code units has at most that many code points.
  return text.length <= positions ? text : Array.from(text).slice(0, positions).join('')
}

// The first pipeline of a Chrome process pays for one-time setup, so a shader of one empty function compiles first.
async function compileEmptyPipeline(device: GPUDevice) {
  const started = performance.now()
  const module = device.createShaderModule({code: `@compute @workgroup_size(1)\nfn main() {\nlet salt: u32 = ${config.shaderSalt}u;\n_ = salt;\n}\n`})
  await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  return performance.now() - started
}

type PatternEntry = {
  pattern: string
  compiled: CompiledPattern
  tables: BitRowTables
  // The plain JavaScript loop's match count of every document, which every readback is compared with.
  expectedCounts: Float32Array
}

async function run() {
  const maxCount = Math.max(...config.counts)
  const documents = generateDocuments(maxCount, config.seed, config.invalidFraction)
  const texts = documents.map(document => document.text)
  const cells = new Float32Array(maxCount * cellsPerDocument)
  for (let index = 0; index < maxCount; index++) writeDocumentCells(cells, index * cellsPerDocument, texts[index]!)
  log(`${maxCount} documents generated`)

  const granted = await requestBatchDevice(maxCount * cellsPerDocument * 4)
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
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(device))
  const store: DocumentStore = await createDocumentStore(device, cellsPerDocument, maxCount)
  store.write(cells, maxCount)
  await device.queue.onSubmittedWorkDone()

  const windowOf = (count: number) => {
    const documentCount = Math.min(count, config.windowDocuments)
    return {firstDocument: Math.floor((count - documentCount) / 2), documentCount}
  }

  // RegExp in this page, per number of positions: its time doesn't depend on the program's state capacity.
  const regExpResults: Record<string, unknown>[] = []
  report['regExp'] = regExpResults
  const slicedTexts = new Map<number, string[]>()
  let sink = 0
  for (const positions of [...new Set(config.sizes.map(size => size[1]))]) {
    const sliced = texts.map(text => codePointSlice(text, positions))
    slicedTexts.set(positions, sliced)
    const codePoints = sliced.reduce((total, text) => total + Array.from(text).length, 0)
    for (const pattern of config.patterns) {
      const global = new RegExp(pattern, 'gu')
      const single = new RegExp(pattern, 'u')
      let matches = 0
      let documentsWithMatch = 0
      for (const text of sliced) {
        const found = text.match(global)?.length ?? 0
        matches += found
        if (found > 0) documentsWithMatch++
      }
      const byCount = config.counts.map(count => ({
        count,
        // The number of matches in every document: String.prototype.match with the g flag.
        countAll: timeCpu(() => {
          for (let index = 0; index < count; index++) sink += sliced[index]!.match(global)?.length ?? 0
        }, count),
        // Whether each document has a match: RegExp.prototype.test, which stops at the first one.
        test: timeCpu(() => {
          for (let index = 0; index < count; index++) if (single.test(sliced[index]!)) sink++
        }, count),
      }))
      regExpResults.push({positions, pattern, matches, documentsWithMatch, meanCodePoints: round(codePoints / maxCount), byCount})
      log(`RegExp, ${positions} positions, ${pattern}: ${matches} matches, µs per document ${byCount.map(entry => `${entry.count}: all ${entry.countAll.microsecondsPerDocument}, test ${entry.test.microsecondsPerDocument}`).join('; ')}`)
    }
    await post(false)
  }

  const results: Record<string, unknown>[] = []
  report['results'] = results
  for (const [states, positions] of config.sizes) {
    const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
    const sliced = slicedTexts.get(positions)!
    const entry: Record<string, unknown> = {states, positions}
    results.push(entry)

    // The patterns that fit, with the plain JavaScript loop's counts for every document.
    const fitting: PatternEntry[] = []
    const patternReports: Record<string, unknown>[] = []
    entry['patterns'] = patternReports
    for (const pattern of config.patterns) {
      const compiled = compilePattern(pattern)
      if (capacityErrors(compiled, capacity).length > 0) continue
      const tables = bitRowTables(compiled, states)
      const search = createBitRowSearch(tables, positions)
      const expectedCounts = new Float32Array(maxCount)
      let matches = 0
      for (let index = 0; index < maxCount; index++) matches += expectedCounts[index] = search(sliced[index]!)
      const global = new RegExp(pattern, 'gu')
      let regExpAgrees = 0
      for (let index = 0; index < maxCount; index++) if ((sliced[index]!.match(global)?.length ?? 0) === expectedCounts[index]) regExpAgrees++
      fitting.push({pattern, compiled, tables, expectedCounts})
      patternReports.push({pattern, states: compiled.automaton.stateCount, classes: compiled.partition.classCount, boundaries: compiled.partition.boundaries.length, matches, documentsWhereRegExpCountsTheSame: regExpAgrees})
    }
    if (fitting.length === 0) throw new Error(`no pattern fits ${states} states`)

    // The program on the CPU, and the plain JavaScript loop against it.
    const plain = buildSearchLoop(capacity, {positions, cellsPerDocument, masked: false, stopAtLength: false})
    const stepOperations = describeLoop(plain.loop)
    entry['program'] = {stages: stepOperations, operationsPerDocument: operationsPerDocument(plain.loop), sharedCells: plain.loop.sharedValues.length, patternCells: plain.patternCells}
    const generatedRunner = createLoopRunner(plain.loop, 'generated')
    const executorRunner = createLoopRunner(plain.loop, 'executor')
    const shared = new Float32Array(plain.loop.sharedValues)
    const marks = new Uint8Array(positions)
    const stepOutputs = [new Float32Array(1), new Float32Array(positions)]
    const stepDocuments = Math.min(maxCount, config.stepDocuments)
    const cpuCheck = {stepDocuments, stepValues: 0, stepMismatches: 0, executorDocuments: 0, executorValues: 0, executorMismatches: 0, fullProgramOperations: 0}
    for (const {compiled, tables} of fitting) {
      plain.writePattern(shared, compiled)
      generatedRunner.setShared(shared)
      const search = createBitRowSearch(tables, positions)
      for (let index = 0; index < stepDocuments; index++) {
        const count = search(sliced[index]!, marks)
        generatedRunner.run([cells], index, stepOutputs, 0, 0)
        cpuCheck.stepValues += 1 + positions
        if (stepOutputs[0]![0] !== count) cpuCheck.stepMismatches++
        for (let position = 0; position < positions; position++) if (stepOutputs[1]![position] !== marks[position]) cpuCheck.stepMismatches++
      }
    }
    const fullOperations = positions * stepOperations.filter(stage => stage.repeat !== 'once').reduce((total, stage) => total + stage.operations, 0)
    let evaluateFull: ((index: number) => Float32Array) | undefined
    let writeFullPattern: ((compiled: CompiledPattern) => void) | undefined
    if (fullOperations <= config.fullProgramMaxOperations) {
      const buildStarted = performance.now()
      const full = buildDataSearch({...capacity, textLength: positions})
      const evaluate = full.circuit.createTensorEvaluator([...full.output.highlighted, ...full.output.starts, full.output.matchCount])
      const source = new Float32Array(full.initialSource)
      cpuCheck.fullProgramOperations = full.circuit.operations.length
      entry['fullProgramBuildMs'] = round(performance.now() - buildStarted)
      writeFullPattern = compiled => writePattern(source, full, compiled)
      evaluateFull = index => {
        const base = index * cellsPerDocument
        for (let position = 0; position < positions; position++) source[full.cells.text[position]!] = cells[base + position]!
        return evaluate(source)
      }
      const executorDocuments = Math.min(maxCount, config.executorDocuments)
      cpuCheck.executorDocuments = executorDocuments
      for (const {compiled, tables} of fitting) {
        writeFullPattern(compiled)
        const search = createBitRowSearch(tables, positions)
        for (let index = 0; index < executorDocuments; index++) {
          const count = search(sliced[index]!, marks)
          const values = evaluateFull(index)
          cpuCheck.executorValues += 1 + positions
          if (values[2 * positions] !== count) cpuCheck.executorMismatches++
          for (let position = 0; position < positions; position++) if (values[position]! + values[positions + position]! !== marks[position]) cpuCheck.executorMismatches++
        }
      }
    }
    entry['cpuCheck'] = cpuCheck
    log(`${states} states, ${positions} positions: ${fitting.length} patterns fit, program ${JSON.stringify(entry['program'])}, CPU check ${JSON.stringify(cpuCheck)}`)

    // CPU times for one pattern: the plain JavaScript loop at each count, and the program on samples.
    const timingPattern = fitting[0]!
    const timingSearch = createBitRowSearch(timingPattern.tables, positions)
    plain.writePattern(shared, timingPattern.compiled)
    generatedRunner.setShared(shared)
    executorRunner.setShared(shared)
    writeFullPattern?.(timingPattern.compiled)
    const sampleOf = (limit: number) => Math.max(1, Math.min(maxCount, limit))
    const generatedSample = sampleOf(config.stepDocuments)
    const executorSample = sampleOf(config.executorDocuments)
    entry['cpu'] = {
      pattern: timingPattern.pattern,
      bitRowLoop: config.counts.map(count => ({count, ...timeCpu(() => {
        for (let index = 0; index < count; index++) sink += timingSearch(sliced[index]!)
      }, count)})),
      // The loop program's steps as generated JavaScript, and on the CPU executor.
      stepGenerated: {documents: generatedSample, ...timeCpu(() => {
        for (let index = 0; index < generatedSample; index++) generatedRunner.run([cells], index, stepOutputs, 0, -1)
      }, generatedSample)},
      stepExecutor: {documents: Math.min(executorSample, 8), ...timeCpu(() => {
        for (let index = 0; index < Math.min(executorSample, 8); index++) executorRunner.run([cells], index, stepOutputs, 0, -1)
      }, Math.min(executorSample, 8))},
      // The program with every position written out, on the CPU executor.
      fullExecutor: evaluateFull === undefined ? undefined : {documents: executorSample, ...timeCpu(() => {
        for (let index = 0; index < executorSample; index++) sink += evaluateFull(index)[2 * positions]!
      }, executorSample)},
    }
    log(`CPU: ${JSON.stringify(entry['cpu'])}`)
    await post(false)

    // The engines on the GPU.
    const engineResults: Record<string, unknown>[] = []
    entry['engines'] = engineResults
    for (const engine of config.engines) {
      const engineEntry: Record<string, unknown> = {engine}
      engineResults.push(engineEntry)
      let loopRunner: ProgramRunner | undefined
      let kernelRunner: KernelRunner | undefined
      let built: SearchLoop | undefined
      if (engine === 'kernel') {
        const kernel = bitRowKernel(states, positions, cellsPerDocument, config.workgroupSize)
        kernelRunner = await createKernelRunner(device, kernel, store, config.shaderSalt)
        Object.assign(engineEntry, {shaderBytes: kernel.bytes, compileMs: round(kernelRunner.compileMs)})
      } else {
        built = buildSearchLoop(capacity, {positions, cellsPerDocument, masked: false, stopAtLength: engine === 'step-stop', bitFields: engine !== 'step-f32'})
        const emitStarted = performance.now()
        const shader = emitLoopWgsl(built.loop, {workgroupSize: config.workgroupSize, order: engine === 'step-layers' ? 'layers' : 'use'})
        const emitMs = performance.now() - emitStarted
        loopRunner = await createProgramRunner(device, shader, built.loop.sharedValues, store, config.shaderSalt, {windowCapacity: config.windowDocuments})
        Object.assign(engineEntry, {statements: shader.statementCount, shaderBytes: shader.bytes, emitMs: round(emitMs), compileMs: round(loopRunner.compileMs)})
      }
      log(`${states} states, ${positions} positions, ${engine}: ${JSON.stringify(engineEntry)}`)

      // One search: the next pattern in turn, compiled and written by JavaScript, uploaded, run and read back, and
      // then compared with the expected values.
      const scratchShared = new Float32Array(plain.loop.sharedValues.length)
      const checks = {searches: 0, values: 0, mismatches: 0}
      const expectedMarks = new Uint8Array(config.windowDocuments * positions)
      let turn = 0
      let previousEnd = performance.now()
      const searchOnce = async (count: number, options: {timestamps?: boolean, gapStart?: number}): Promise<Timed> => {
        const {pattern, expectedCounts, tables} = fitting[turn++ % fitting.length]!
        const window = windowOf(count)
        const gapMs = performance.now() - (options.gapStart ?? previousEnd)
        const started = performance.now()
        const compiled = compilePattern(pattern)
        let record: Timed
        let counts: Float32Array
        let gotMarks: Float32Array | undefined
        if (kernelRunner !== undefined) {
          const patternTables = bitRowTables(compiled, states).tables
          const patternMs = performance.now() - started
          const evaluation = await kernelRunner.evaluate({count, tables: patternTables, ...(options.timestamps === true ? {timestamps: true} : {})})
          counts = evaluation.counts
          record = {patternMs, uploadMs: 0, waitMs: evaluation.totalMs, copyMs: 0, totalMs: evaluation.totalMs + patternMs, passMs: evaluation.passMs, gapMs}
        } else {
          scratchShared.set(built!.loop.sharedValues)
          built!.writePattern(scratchShared, compiled)
          const patternMs = performance.now() - started
          const evaluation = await loopRunner!.evaluate({
            count, shared: scratchShared, window, ...(options.timestamps === true ? {timestamps: true} : {}),
            readbacks: [{group: 0, firstDocument: 0, documentCount: count}, {group: 1, firstDocument: 0, documentCount: window.documentCount}],
          })
          counts = evaluation.outputs[0]!
          gotMarks = evaluation.outputs[1]!
          record = {patternMs, uploadMs: evaluation.uploadMs, waitMs: evaluation.waitMs, copyMs: evaluation.copyMs, totalMs: evaluation.totalMs + patternMs, passMs: evaluation.passMs, gapMs}
        }
        previousEnd = performance.now()
        checks.searches++
        checks.values += count
        for (let index = 0; index < count; index++) if (counts[index] !== expectedCounts[index]) checks.mismatches++
        if (gotMarks !== undefined) {
          const search = createBitRowSearch(tables, positions)
          for (let row = 0; row < window.documentCount; row++) search(sliced[window.firstDocument + row]!, expectedMarks, row * positions)
          const length = window.documentCount * positions
          checks.values += length
          for (let index = 0; index < length; index++) if (gotMarks[index] !== expectedMarks[index]) checks.mismatches++
        }
        return record
      }

      const byCount: Record<string, unknown>[] = []
      engineEntry['byCount'] = byCount
      for (const count of config.counts) {
        const first = await searchOnce(count, {})
        const result: Record<string, unknown> = {count, at: new Date().toISOString(), firstSearchMs: round(first.totalMs)}
        result['backToBack'] = summarizeTimed(await sample(() => searchOnce(count, {})))
        if (granted.hasTimestamps) result['withTimestamps'] = summarizeTimed(await sample(() => searchOnce(count, {timestamps: true})))
        if (config.idleEngines.includes(engine)) {
          const idle: Record<string, unknown>[] = []
          for (const gap of config.idleGapsMs) {
            const records: Timed[] = []
            for (let index = 0; index < config.idleSamples; index++) {
              const gapStart = performance.now()
              await sleep(gap)
              records.push(await searchOnce(count, {gapStart}))
            }
            idle.push({idleMs: gap, ...summarizeTimed(records), totals: records.map(record => round(record.totalMs))})
          }
          result['afterIdle'] = idle
        }
        byCount.push(result)
        const backToBack = result['backToBack'] as ReturnType<typeof summarizeTimed>
        log(`${states} states, ${positions} positions, ${engine}, ${count} documents: back to back ${backToBack.totalMs?.median} ms, pass ${(result['withTimestamps'] as ReturnType<typeof summarizeTimed> | undefined)?.passMs?.median} ms, checks so far ${JSON.stringify(checks)}`)
        await post(false)
      }
      engineEntry['checks'] = checks
      loopRunner?.destroy()
      kernelRunner?.destroy()
      await post(false)
    }
  }
  report['sink'] = sink
  store.destroy()
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
