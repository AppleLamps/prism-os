// The GPU measurement page for the JSON highlighter over many documents. run.ts serves it, opens it in headless Chrome,
// and writes what it posts to /result. Modes, from /config:
// - 'main': generates the documents, runs the CPU executor on every one for the expected outputs, times the CPU
//   baselines in this page, compiles both shaders cold, checks the highlighter's own test texts on the GPU, and then,
//   per variant and document count, times one evaluation: back to back, after idle gaps, and with a new upload of every
//   document. Every readback is compared with the executor's outputs, in whole except where measure says otherwise.
// - 'check': both shaders with each guard, over the highlighter's test texts and the first generated documents.
//
// The variants, i.e. what one evaluation computes and reads back:
//   summary         the summary shader, and valid, firstErrorPosition and truncated of every document
//   display-window  the display shader, the summary of every document, and the display kinds of `windowDocuments`
//                   documents in the middle, e.g. the ones a list shows
//   display-all     the display shader, the summary and the 512 display kinds of every document
import {createCorpus} from '../../../tests/json-search/highlighter/corpus.ts'
import {highlightReference} from '../../../tests/json-search/highlighter/reference.ts'
import {countMismatches, expectedOutputs} from '../../../src/json-search/check.ts'
import {type GeneratedDocument, describeDocuments, generateDocuments} from '../../../src/json-search/documents.ts'
import type {Guard} from '../../../src/json-search/emit.ts'
import {type BatchProgram, buildBatchPrograms, cellsPerDocument, kindCount, summaryCount, writeDocumentCells} from '../../../src/json-search/program.ts'
import {highlightWithTables, tableLoopResult} from '../../../src/json-search/table-loop.ts'
import {type Evaluation, type ProgramRunner, type Readback, createDocumentStore, createProgramRunner, requestBatchDevice, selfCheck} from '../../../src/json-search/gpu/host.ts'

export type PageConfig = {
  mode: 'main' | 'check'
  // Every variant is measured at these document counts.
  counts: number[]
  // More counts for the summary variant back to back, to find where the GPU passes each baseline.
  crossoverCounts: number[]
  // One evaluation after the page left the GPU alone for this long.
  idleGapsMs: number[]
  idleSamples: number
  // The summary variant repeats the gaps with a timestamp query, this many times each.
  idleTimestampSamples: number
  // During a gap of this length, a one-document dispatch every 16 ms, to see whether it keeps the next evaluation fast.
  keepWarmGapMs: number
  windowDocuments: number
  // Goes into every shader's source, see src/json-search/gpu/host.ts. A salt that no earlier run used gives cold compile times.
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
  // The CPU executor and generated JavaScript are timed on the first documents, at most this many.
  executorDocuments: number
  generatedJsDocuments: number
  selfCheckDocuments: number
  // Check mode.
  guards: Guard[]
  checkDocuments: number
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

// crossOriginIsolated is true when run.ts's headers took effect, and performance.now() reads in steps of 5 µs.
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

const config = await (await fetch('/config')).json() as PageConfig
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
// passed, or maximumSamples.
async function sample<Sample>(evaluateOnce: () => Promise<Sample>) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 || performance.now() - warmStarted < config.warmupMs; warm++) await evaluateOnce()
  const samples: Sample[] = []
  const started = performance.now()
  while (samples.length < config.maximumSamples && (samples.length < config.minimumSamples || performance.now() - started < config.sampleMs)) samples.push(await evaluateOnce())
  return samples
}

type Timed = Evaluation & {cellsMs: number, gapMs: number}
const summarizeTimed = (records: readonly Timed[]) => ({
  cellsMs: summary(records.map(record => record.cellsMs)),
  uploadMs: summary(records.map(record => record.uploadMs)),
  encodeAndSubmitMs: summary(records.map(record => record.encodeAndSubmitMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  totalMs: summary(records.map(record => record.totalMs)),
  totalWithCellsMs: summary(records.map(record => record.totalMs + record.cellsMs)),
  passMs: summary(records.map(record => record.passMs)),
  // From the end of the previous evaluation to the start of this one: the comparison with the expected outputs, and in
  // an idle series the gap itself.
  gapMs: summary(records.map(record => record.gapMs)),
})

// Rows firstDocument to firstDocument + documentCount - 1 of `expected` against the rows of `actual`, which start at
// its row 0. With `reversedWithin`, actual row j is expected row reversedWithin - 1 - j, for documents uploaded in
// reverse order.
function mismatchedValues(actual: Float32Array, expected: ArrayLike<number>, perDocument: number, firstDocument: number, documentCount: number, reversedWithin: number | undefined) {
  let mismatches = 0
  if (reversedWithin === undefined) {
    const base = firstDocument * perDocument
    const length = documentCount * perDocument
    for (let index = 0; index < length; index++) if (actual[index] !== expected[base + index]) mismatches++
    return mismatches
  }
  for (let row = 0; row < documentCount; row++) {
    const actualBase = row * perDocument
    const expectedBase = (reversedWithin - 1 - row) * perDocument
    for (let column = 0; column < perDocument; column++) if (actual[actualBase + column] !== expected[expectedBase + column]) mismatches++
  }
  return mismatches
}

async function requestDevice(largestBufferBytes: number) {
  const granted = await requestBatchDevice(largestBufferBytes)
  void granted.device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
    void post(true)
  })
  granted.device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
    void post(true)
  })
  report['adapter'] = {info: granted.adapterInfo, limits: granted.adapterLimits, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  return granted
}

// The first pipeline of a Chrome process pays for one-time setup, so a shader of one empty function compiles first,
// and its time is reported apart from the two programs' compile times.
async function compileEmptyPipeline(device: GPUDevice) {
  const started = performance.now()
  const module = device.createShaderModule({code: `@compute @workgroup_size(1)\nfn main() {\nlet salt: u32 = ${config.shaderSalt}u;\n_ = salt;\n}\n`})
  await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  return performance.now() - started
}

// The highlighter's own test texts, e.g. texts at and past the capacity and at the maximum depth, through a runner,
// against the executor. It leaves the texts' cells in the store's first documents.
async function checkCorpus(runner: ProgramRunner, program: BatchProgram) {
  const corpus = createCorpus(20260917, {random: 700, mutated: 1600, long: 80}).all
  if (runner.capacity < corpus.length) throw new Error('the store holds fewer documents than the test texts')
  const cells = new Float32Array(corpus.length * cellsPerDocument)
  corpus.forEach((text, index) => writeDocumentCells(cells, index * cellsPerDocument, text))
  const expected = expectedOutputs(program, cells, corpus.length)
  const {outputs} = await runner.evaluate({count: corpus.length, cells, readbacks: program.outputCounts.map((_, group) => ({group, firstDocument: 0, documentCount: corpus.length}))})
  let values = 0
  let mismatches = 0
  outputs.forEach((group, groupIndex) => {
    values += group.length
    mismatches += countMismatches(group, expected[groupIndex]!, group.length)
  })
  return {texts: corpus.length, values, mismatches}
}
// The number of test texts above, which a store must hold.
const corpusTexts = 2509

// How many documents' kinds a back to back display-all series compares per readback, see measure.
const partDocuments = 256

type Variant = {
  name: 'summary' | 'display-window' | 'display-all'
  runner: ProgramRunner
  readbacks: (count: number) => Readback[]
  megabytesReadBack: (count: number) => number
}

async function runMain() {
  const results: Record<string, unknown>[] = []
  report['results'] = results
  const maxCount = Math.max(...config.counts, ...config.crossoverCounts)

  // The programs and their shaders.
  const batch = buildBatchPrograms()
  const [summaryProgram, displayProgram] = batch.programs as [BatchProgram, BatchProgram]
  const shaders = batch.programs.map(program => {
    const started = performance.now()
    const shader = program.emitShader({workgroupSize: config.workgroupSize})
    return {shader, emitMs: performance.now() - started}
  })
  report['programs'] = batch.programs.map((program, index) => {
    const {shader, emitMs} = shaders[index]!
    return {rootSet: program.rootSet, buildMs: round(batch.buildMs), ...program.sizes, compileMs: round(program.sizes.compileMs), emitMs: round(emitMs), statements: shader.statementCount, shaderBytes: shader.bytes, rowCounts: shader.rowCounts, outputCounts: shader.outputCounts}
  })

  // The documents, their cells, and the executor's outputs for every one of them.
  let started = performance.now()
  const documents: GeneratedDocument[] = generateDocuments(maxCount, config.seed, config.invalidFraction)
  const generateMs = performance.now() - started
  const texts = documents.map(document => document.text)
  const cells = new Float32Array(maxCount * cellsPerDocument)
  started = performance.now()
  for (let index = 0; index < maxCount; index++) writeDocumentCells(cells, index * cellsPerDocument, texts[index]!)
  const writeCellsMs = performance.now() - started
  report['documents'] = {generateMs: round(generateMs), writeCellsMs: round(writeCellsMs), megabytesOfCells: round(cells.byteLength / 1e6), ...describeDocuments(documents)}
  log(`${maxCount} documents generated in ${round(generateMs)} ms, cells written in ${round(writeCellsMs)} ms`)
  await post(false)
  const expectedSummary = new Float32Array(maxCount * summaryCount)
  const expectedKinds = new Uint8Array(maxCount * kindCount)
  started = performance.now()
  expectedOutputs(displayProgram, cells, maxCount, [expectedSummary, expectedKinds])
  const executorEveryDocumentMs = performance.now() - started
  log(`the executor ran the display program over ${maxCount} documents in ${round(executorEveryDocumentMs)} ms`)

  // Whether the CPU versions agree, document by document: the labels, JSON.parse, the reference and the table loop
  // against the executor's outputs.
  const agreement = {documents: maxCount, labelDisagrees: 0, jsonParseDisagrees: 0, referenceDisagrees: 0, tableLoopDisagrees: 0, validDocuments: 0}
  const kindsScratch = new Uint8Array(kindCount)
  for (let index = 0; index < maxCount; index++) {
    const {text, defect} = documents[index]!
    const valid = expectedSummary[index * summaryCount]!
    const firstErrorPosition = expectedSummary[index * summaryCount + 1]!
    const truncated = expectedSummary[index * summaryCount + 2]!
    agreement.validDocuments += valid
    if ((valid === 1) !== (defect === 'none')) agreement.labelDisagrees++
    let parses = true
    try {
      JSON.parse(text)
    } catch {
      parses = false
    }
    // JSON.parse accepts nesting past depth 16 and texts past 512 code points, which the highlighter reports.
    if (parses !== (valid === 1 || defect === 'tooDeep' || defect === 'tooLong')) agreement.jsonParseDisagrees++
    const kinds = expectedKinds.subarray(index * kindCount, (index + 1) * kindCount)
    const reference = highlightReference(text)
    if (reference.valid !== valid || reference.firstErrorPosition !== firstErrorPosition || reference.truncated !== truncated || countMismatches(reference.displayKinds, kinds, kindCount) > 0) agreement.referenceDisagrees++
    highlightWithTables(text, kindsScratch, 0)
    if (tableLoopResult.firstErrorPosition !== firstErrorPosition || tableLoopResult.truncated !== truncated || countMismatches(kindsScratch, kinds, kindCount) > 0) agreement.tableLoopDisagrees++
  }
  report['agreement'] = agreement
  log(`agreement with the executor: ${JSON.stringify(agreement)}`)
  await post(false)

  // The CPU baselines in this page, at each count.
  const generated = batch.programs.map(program => program.emitJavaScript())
  const generatedOutputs = batch.programs.map(program => program.outputCounts.map(outputCount => new Float32Array(config.generatedJsDocuments * outputCount)))
  // Generated JavaScript against the executor, on its documents.
  const generatedCount = Math.min(maxCount, config.generatedJsDocuments)
  let generatedMismatches = 0
  batch.programs.forEach((program, index) => {
    generated[index]!.run(program.sharedValues, cells, generatedCount, generatedOutputs[index]!)
    generatedMismatches += countMismatches(generatedOutputs[index]![0]!, expectedSummary, generatedCount * summaryCount)
    if (program.rootSet === 'display') generatedMismatches += countMismatches(generatedOutputs[index]![1]!, expectedKinds, generatedCount * kindCount)
  })
  const kindsOfEveryDocument = new Uint8Array(maxCount * kindCount)
  const source = new Float32Array(summaryProgram.sharedValues)
  let sink = 0
  const cpu: Record<string, unknown>[] = []
  for (const count of config.counts) {
    const executorCount = Math.min(count, config.executorDocuments)
    const jsCount = Math.min(count, config.generatedJsDocuments)
    const entry = {
      count, executorDocuments: executorCount, generatedJsDocuments: jsCount,
      // Validity only.
      jsonParse: timeCpu(() => {
        for (let index = 0; index < count; index++) {
          try {
            JSON.parse(texts[index]!)
            sink++
          } catch {}
        }
      }, count),
      // A display kind per character and the first error, like the display program.
      reference: timeCpu(() => {
        for (let index = 0; index < count; index++) sink += highlightReference(texts[index]!).firstErrorPosition
      }, count),
      tableLoop: timeCpu(() => {
        for (let index = 0; index < count; index++) {
          highlightWithTables(texts[index]!, kindsOfEveryDocument, index * kindCount)
          sink += tableLoopResult.firstErrorPosition
        }
      }, count),
      // The same programs on the CPU, on the first documents only.
      executorSummary: timeCpu(() => {
        for (let index = 0; index < executorCount; index++) sink += summaryProgram.evaluate(summaryProgram.writeSource(source, cells, index))[0]!
      }, executorCount),
      executorDisplay: timeCpu(() => {
        for (let index = 0; index < executorCount; index++) sink += displayProgram.evaluate(displayProgram.writeSource(source, cells, index))[0]!
      }, executorCount),
      generatedJsSummary: timeCpu(() => generated[0]!.run(summaryProgram.sharedValues, cells, jsCount, generatedOutputs[0]!), jsCount),
      generatedJsDisplay: timeCpu(() => generated[1]!.run(displayProgram.sharedValues, cells, jsCount, generatedOutputs[1]!), jsCount),
    }
    cpu.push(entry)
    log(`CPU in this page, ${count} documents, µs per document: ${Object.entries(entry).filter(([, value]) => typeof value === 'object').map(([name, value]) => `${name} ${(value as {microsecondsPerDocument: number}).microsecondsPerDocument}`).join(', ')}`)
    await post(false)
  }
  // JSON.parse on the valid and on the broken documents apart, since a broken one costs a thrown SyntaxError.
  const validTexts = texts.filter((_, index) => expectedSummary[index * summaryCount] === 1)
  const parseFailingTexts = texts.filter((_, index) => documents[index]!.defect !== 'none' && documents[index]!.defect !== 'tooDeep' && documents[index]!.defect !== 'tooLong')
  const parseOver = (list: readonly string[]) => timeCpu(() => {
    for (const text of list) {
      try {
        JSON.parse(text)
        sink++
      } catch {}
    }
  }, list.length)
  report['cpu'] = {
    byCount: cpu, executorEveryDocumentMs: round(executorEveryDocumentMs), generatedJsMismatchesAgainstExecutor: generatedMismatches, generatedJsSourceBytes: generated.map(entry => entry.sourceBytes),
    jsonParseValidOnly: {documents: validTexts.length, ...parseOver(validTexts)}, jsonParseThrowingOnly: {documents: parseFailingTexts.length, ...parseOver(parseFailingTexts)}, sink,
  }
  await post(false)

  // The GPU: one store for the documents, and both shaders compiled cold.
  const granted = await requestDevice(maxCount * Math.max(cellsPerDocument, kindCount) * 4)
  const {device} = granted
  const emptyPipelineMs = await compileEmptyPipeline(device)
  const store = await createDocumentStore(device, cellsPerDocument, Math.max(maxCount, corpusTexts))
  const runners: ProgramRunner[] = []
  const compile: Record<string, unknown>[] = []
  for (const [index, program] of batch.programs.entries()) {
    const {shader} = shaders[index]!
    const runner = await createProgramRunner(device, shader, program.packShared(shader), store, config.shaderSalt)
    runners.push(runner)
    const corpusCheck = await checkCorpus(runner, program)
    compile.push({rootSet: program.rootSet, shaderSalt: config.shaderSalt, statements: shader.statementCount, shaderBytes: shader.bytes, compileMs: round(runner.compileMs), corpusCheck})
    log(`${program.rootSet}: ${shader.statementCount} statements compiled in ${round(runner.compileMs)} ms, test texts ${JSON.stringify(corpusCheck)}`)
  }
  report['compile'] = {emptyPipelineMs: round(emptyPipelineMs), programs: compile}
  await post(false)
  const [summaryRunner, displayRunner] = runners as [ProgramRunner, ProgramRunner]

  // The first load: every document's cells uploaded, and the first evaluation at the largest count.
  started = performance.now()
  store.write(cells, maxCount)
  const firstEvaluation = await summaryRunner.evaluate({count: maxCount, readbacks: [{group: 0, firstDocument: 0, documentCount: maxCount}]})
  report['firstLoad'] = {
    documents: maxCount, megabytesUploaded: round(cells.byteLength / 1e6), uploadAndFirstEvaluationMs: round(performance.now() - started),
    mismatches: mismatchedValues(firstEvaluation.outputs[0]!, expectedSummary, summaryCount, 0, maxCount, undefined),
  }
  report['selfCheck'] = await selfCheck(displayRunner, displayProgram, cells, Math.min(maxCount, config.selfCheckDocuments))
  log(`first load ${JSON.stringify(report['firstLoad'])}, self check ${JSON.stringify(report['selfCheck'])}`)
  await post(false)

  const windowOf = (count: number) => {
    const documentCount = Math.min(count, config.windowDocuments)
    return {firstDocument: Math.floor((count - documentCount) / 2), documentCount}
  }
  const megabytes = (values: number) => round(values * 4 / 1e6)
  const variants: Variant[] = [
    {name: 'summary', runner: summaryRunner, readbacks: count => [{group: 0, firstDocument: 0, documentCount: count}], megabytesReadBack: count => megabytes(count * summaryCount)},
    {
      name: 'display-window', runner: displayRunner, readbacks: count => [{group: 0, firstDocument: 0, documentCount: count}, {group: 1, ...windowOf(count)}],
      megabytesReadBack: count => megabytes(count * summaryCount + windowOf(count).documentCount * kindCount),
    },
    {
      name: 'display-all', runner: displayRunner, readbacks: count => [{group: 0, firstDocument: 0, documentCount: count}, {group: 1, firstDocument: 0, documentCount: count}],
      megabytesReadBack: count => megabytes(count * (summaryCount + kindCount)),
    },
  ]
  const uploadCells = new Float32Array(maxCount * cellsPerDocument)

  async function measure(variant: Variant, count: number, parts: {idle: boolean, upload: boolean}) {
    const checks = {readbacks: 0, values: 0, mismatches: 0}
    const readbacks = variant.readbacks(count)
    // Comparing the 51 million display kinds of 100,000 documents takes about 50 ms, during which the GPU is idle, and
    // an evaluation after a pause is slower. So a back to back series compares the kinds of only 256 documents of each
    // readback, a different 256 each time, and a second series compares every value, with that pause between its
    // evaluations.
    const partKinds = variant.name === 'display-all' && count > partDocuments
    let previousEnd = performance.now()
    let evaluations = 0
    // One evaluation, then the comparison of what it read back. `reversed` says the store holds the first `count`
    // documents in reverse order.
    const evaluateOnce = async (options: {timestamps?: boolean, cells?: Float32Array, reversed?: boolean, cellsMs?: number, gapStart?: number, partOfKinds?: boolean}): Promise<Timed> => {
      const cellsMs = options.cellsMs ?? 0
      // From the end of the previous evaluation, or from the start of an idle gap, to the start of this evaluation's
      // own work, which with an upload starts with writing the cells.
      const gapMs = performance.now() - cellsMs - (options.gapStart ?? previousEnd)
      const evaluation = await variant.runner.evaluate({count, readbacks, ...(options.timestamps === true ? {timestamps: true} : {}), ...(options.cells === undefined ? {} : {cells: options.cells})})
      previousEnd = performance.now()
      evaluations++
      readbacks.forEach((readback, index) => {
        const perDocument = readback.group === 0 ? summaryCount : kindCount
        let values = evaluation.outputs[index]!
        let {firstDocument, documentCount} = readback
        if (readback.group === 1 && options.partOfKinds === true) {
          const start = (evaluations * partDocuments) % (documentCount - partDocuments + 1)
          values = values.subarray(start * perDocument, (start + partDocuments) * perDocument)
          firstDocument += start
          documentCount = partDocuments
        }
        checks.readbacks++
        checks.values += values.length
        checks.mismatches += mismatchedValues(values, readback.group === 0 ? expectedSummary : expectedKinds, perDocument, firstDocument, documentCount, options.reversed === true ? count : undefined)
      })
      return {...evaluation, cellsMs, gapMs}
    }
    const result: Record<string, unknown> = {kind: 'gpu', variant: variant.name, count, at: new Date().toISOString(), megabytesReadBack: variant.megabytesReadBack(count), megabytesOfCells: megabytes(count * cellsPerDocument)}
    result['backToBack'] = summarizeTimed(await sample(() => evaluateOnce({partOfKinds: partKinds})))
    if (variant.runner.hasTimestamps) result['withTimestamps'] = summarizeTimed(await sample(() => evaluateOnce({timestamps: true, partOfKinds: partKinds})))
    if (partKinds) result['everyValueCompared'] = summarizeTimed(await sample(() => evaluateOnce({})))
    if (parts.idle) {
      // One evaluation after the page did nothing for a while, e.g. between two keystrokes.
      const idle: Record<string, unknown>[] = []
      for (const gap of config.idleGapsMs) {
        const records: Timed[] = []
        for (let index = 0; index < config.idleSamples; index++) {
          const gapStart = performance.now()
          await sleep(gap)
          records.push(await evaluateOnce({gapStart}))
        }
        idle.push({idleMs: gap, ...summarizeTimed(records), totals: records.map(record => round(record.totalMs))})
      }
      result['afterIdle'] = idle
      if (variant.name === 'summary') {
        // The same gaps with a timestamp query, which tells the compute pass's part of a slower evaluation from the
        // rest of the round trip.
        if (variant.runner.hasTimestamps) {
          const withTimestamps: Record<string, unknown>[] = []
          for (const gap of config.idleGapsMs) {
            const records: Timed[] = []
            for (let index = 0; index < config.idleTimestampSamples; index++) {
              const gapStart = performance.now()
              await sleep(gap)
              records.push(await evaluateOnce({gapStart, timestamps: true}))
            }
            withTimestamps.push({idleMs: gap, ...summarizeTimed(records), totals: records.map(record => round(record.totalMs)), passes: records.map(record => round(record.passMs ?? 0))})
          }
          result['afterIdleWithTimestamps'] = withTimestamps
        }
        // The same gap, with a one-document dispatch every 16 ms during it.
        const records: Timed[] = []
        let dispatches = 0
        for (let index = 0; index < config.idleSamples; index++) {
          const gapStart = performance.now()
          while (performance.now() - gapStart < config.keepWarmGapMs) {
            await variant.runner.evaluate({count: 1, readbacks: []})
            dispatches++
            await sleep(16)
          }
          records.push(await evaluateOnce({gapStart}))
        }
        result['afterIdleWithKeepWarm'] = {idleMs: config.keepWarmGapMs, dispatchesPerGap: dispatches / config.idleSamples, ...summarizeTimed(records), totals: records.map(record => round(record.totalMs))}
      }
    }
    if (parts.upload) {
      // Every evaluation writes the first `count` documents' cells again from their texts and uploads them. Consecutive
      // evaluations alternate the documents' order, so a readback that matches shows that the upload arrived.
      let flip = 0
      const records = await sample(() => {
        const reversed = flip++ % 2 === 1
        const cellsStarted = performance.now()
        for (let row = 0; row < count; row++) writeDocumentCells(uploadCells, row * cellsPerDocument, texts[reversed ? count - 1 - row : row]!)
        const cellsMs = performance.now() - cellsStarted
        return evaluateOnce({cells: uploadCells, reversed, cellsMs})
      })
      result['withUpload'] = summarizeTimed(records)
      // The documents go back in their own order for the next measurement.
      store.write(cells, count)
      await evaluateOnce({})
    }
    result['checks'] = checks
    results.push(result)
    const backToBack = result['backToBack'] as ReturnType<typeof summarizeTimed>
    log(`${variant.name}, ${count} documents: back to back ${backToBack.totalMs?.median} ms, pass ${(result['withTimestamps'] as ReturnType<typeof summarizeTimed> | undefined)?.passMs?.median} ms, with upload ${(result['withUpload'] as ReturnType<typeof summarizeTimed> | undefined)?.totalWithCellsMs?.median} ms, checks ${JSON.stringify(checks)}`)
    await post(false)
  }

  for (const variant of variants) {
    for (const count of config.counts) await measure(variant, count, {idle: true, upload: variant.name !== 'display-window'})
  }
  for (const count of config.crossoverCounts) await measure(variants[0]!, count, {idle: false, upload: false})
  for (const runner of runners) runner.destroy()
  store.destroy()
}

async function runChecks() {
  const results: Record<string, unknown>[] = []
  report['results'] = results
  const count = config.checkDocuments
  const batch = buildBatchPrograms()
  const documents = generateDocuments(count, config.seed, config.invalidFraction)
  const cells = new Float32Array(count * cellsPerDocument)
  documents.forEach((document, index) => writeDocumentCells(cells, index * cellsPerDocument, document.text))
  const granted = await requestDevice(count * Math.max(cellsPerDocument, kindCount) * 4)
  const {device} = granted
  report['compile'] = {emptyPipelineMs: round(await compileEmptyPipeline(device))}
  const store = await createDocumentStore(device, cellsPerDocument, Math.max(count, corpusTexts))
  for (const guard of config.guards) {
    for (const program of batch.programs) {
      const shader = program.emitShader({guard, workgroupSize: config.workgroupSize})
      const runner = await createProgramRunner(device, shader, program.packShared(shader), store, config.shaderSalt)
      const corpusCheck = await checkCorpus(runner, program)
      store.write(cells, count)
      const generatedCheck = await selfCheck(runner, program, cells, count)
      const readbacks = [{group: 0, firstDocument: 0, documentCount: count}]
      const backToBack = await sample(async () => (await runner.evaluate({count, readbacks})).totalMs)
      const result = {
        kind: 'check', rootSet: program.rootSet, guard, statements: shader.statementCount, shaderBytes: shader.bytes, guards: shader.guards, compileMs: round(runner.compileMs),
        corpusCheck, generatedCheck, summaryBackToBackMs: summary(backToBack),
      }
      results.push(result)
      log(`check ${program.rootSet}, ${guard} guard: ${JSON.stringify(result)}`)
      await post(false)
      runner.destroy()
    }
  }
  store.destroy()
}

try {
  if (config.mode === 'check') await runChecks()
  else await runMain()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
