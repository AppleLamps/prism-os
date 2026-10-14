// The review's page: checks and baselines that the measurement pages didn't have. review-run.ts serves it, opens it in
// headless Chrome, and writes what it posts to /result. Modes, from /config:
// - 'edge': a GPU searcher over the documents of edge-cases.ts, i.e. texts at exactly the capacity, empty texts, every
//   kind of broken document and nesting around the maximum depth, with patterns that fill each program's states,
//   classes and class boundaries or match nothing or everything. Every value is compared with the programs that have
//   every position written out, on the CPU executor. Then three requests at once, of which only the newest gets a
//   result, and the first stage's two shaders over the same documents.
// - 'many': a GPU searcher over the measurements' generated documents. The validation and every display kind of every
//   document are compared with the highlighter on the CPU executor, the searches with the same loop programs as
//   generated JavaScript over every document, and with the loop programs on the CPU executor over the first ones.
// - 'baselines': other ways to write the plain JavaScript baselines, timed in this page: four ways to count a
//   pattern's matches with RegExp, the table loop with one array for every document's kinds or one array of 512, and
//   JSON.parse and RegExp in several workers that each hold a share of the documents.
import {type EdgeSearch, compareSearchers, compareWithWrittenOutPrograms, edgeDocuments, edgeSearches, highlighterOnTheExecutor} from '../../../tests/json-search/edge-cases.ts'
import {generateDocuments} from '../../../src/json-search/documents.ts'
import {buildBatchPrograms, cellsPerDocument, kindCount, summaryCount, writeDocumentCells} from '../../../src/json-search/program.ts'
import {capacity as positions} from '../../../src/json-search/highlighter/kinds.ts'
import {type ShaderWriter, bufferBytesFor, createCpuSearcher, createGpuSearcher} from '../../../src/json-search/searcher.ts'
import {highlightWithTables, tableLoopResult} from '../../../src/json-search/table-loop.ts'
import {createDocumentStore, createProgramRunner, requestBatchDevice, selfCheck} from '../../../src/json-search/gpu/host.ts'
import {type SamplingConfig, createReporter, round, summary, timeCpu} from './measure.ts'

export type ReviewPageConfig = SamplingConfig & {
  mode: 'edge' | 'many' | 'baselines'
  shaderSalt: number
  // Which writer writes the search programs' shaders, see searcher.ts.
  searchWriter: ShaderWriter
  seed: number
  invalidFraction: number
  // 'edge': how many documents of each kind edge-cases.ts adds to its hand-written ones, and how many a window holds.
  edgeSizes: {broken: number, generated: number, random: number, mutated: number, long: number}
  windowDocuments: number
  // 'many' and 'baselines': how many generated documents.
  documents: number
  // 'many': how many of the first documents the loop programs run on the CPU executor, and as generated JavaScript at
  // 32 states, where one document takes 3.6 ms.
  executorDocuments: number
  generatedDocumentsAt32States: number
  // 'baselines': the patterns, and the worker counts.
  patterns: string[]
  workerCounts: number[]
}

const {report, post, log} = createReporter()
const config = await (await fetch('/config')).json() as ReviewPageConfig
report['config'] = config

async function requestDevice(bytes: number) {
  const granted = await requestBatchDevice(bytes)
  void granted.device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
    void post(true)
  })
  granted.device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
    void post(true)
  })
  report['adapter'] = {info: granted.adapterInfo, limits: granted.adapterLimits, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  return granted.device
}

const windowsOver = (count: number, size: number) => Array.from({length: Math.ceil(count / size)}, (_, index) => ({firstDocument: index * size, documentCount: Math.min(size, count - index * size)}))

async function runEdge() {
  const documents = edgeDocuments(config.edgeSizes)
  const texts = documents.map(document => document.text)
  const count = texts.length
  const device = await requestDevice(bufferBytesFor(count))
  const searcher = await createGpuSearcher(device, texts, {windowCapacity: config.windowDocuments, shaderSalt: config.shaderSalt, writers: {search: config.searchWriter}})
  report['documents'] = {count, valid: searcher.validation.validCount, codePointLengths: summary(texts.map(text => Array.from(text).length))}
  report['programs'] = searcher.programs()
  log(`${count} edge documents, ${searcher.validation.validCount} valid by the GPU, programs ${JSON.stringify(searcher.programs().map(program => [program.name, program.statements, round(program.compileMs ?? 0)]))}`)
  await post(false)

  // Up to 16 states: every value against the programs with every position written out, on the CPU executor.
  const searches = [...edgeSearches(8), ...edgeSearches(16)]
  let started = performance.now()
  const writtenOut = await compareWithWrittenOutPrograms(searcher, texts, searches, {windowDocuments: config.windowDocuments, maxWrittenOutStates: 16})
  report['againstWrittenOutProgramsOnTheExecutor'] = {...writtenOut, executorMs: round(writtenOut.executorMs), totalMs: round(performance.now() - started)}
  log(`against the written-out programs on the executor: ${JSON.stringify(report['againstWrittenOutProgramsOnTheExecutor'])}`)
  await post(false)

  // 32 states: the written-out program is 1,167,392 operations, so the GPU is compared with the same loop program as
  // generated JavaScript on every document, and on the CPU executor on a few.
  started = performance.now()
  const cpu = createCpuSearcher(texts, {windowCapacity: config.windowDocuments})
  const windows = windowsOver(count, config.windowDocuments)
  const someWindows = [windows[0]!, windows[windows.length >> 1]!, windows.at(-1)!]
  const at32 = await compareSearchers(searcher, cpu, edgeSearches(32), someWindows)
  report['at32StatesAgainstGeneratedJavaScript'] = {...at32, totalMs: round(performance.now() - started)}
  log(`32 states against generated JavaScript: ${JSON.stringify(report['at32StatesAgainstGeneratedJavaScript'])}`)
  // The loop program on the CPU executor takes 39 ms per document at 32 states, so a second searcher holds a sample:
  // every fifth of the hand-written documents of more than one code point.
  started = performance.now()
  const sampleTexts = documents.filter(document => !document.name.startsWith('one code point')).filter((_, index) => index % 5 === 0).slice(0, 32).map(document => document.text)
  const sampleSearcher = await createGpuSearcher(device, sampleTexts, {windowCapacity: sampleTexts.length, shaderSalt: config.shaderSalt, writers: {search: config.searchWriter}})
  const at32OnTheExecutor = await compareSearchers(sampleSearcher, createCpuSearcher(sampleTexts, {windowCapacity: sampleTexts.length, backend: 'executor'}), edgeSearches(32), [{firstDocument: 0, documentCount: sampleTexts.length}])
  sampleSearcher.destroy()
  report['at32StatesAgainstTheLoopProgramOnTheExecutor'] = {...at32OnTheExecutor, totalMs: round(performance.now() - started)}
  log(`32 states against the loop program on the executor: ${JSON.stringify(report['at32StatesAgainstTheLoopProgramOnTheExecutor'])}`)
  report['selfCheck'] = await searcher.selfCheck(Math.min(count, 300))
  log(`self check ${JSON.stringify(report['selfCheck'])}`)
  await post(false)

  // Three requests at once: the first one is in flight when the others arrive, and only the newest gets a result.
  const window = {firstDocument: Math.max(0, count - config.windowDocuments), documentCount: Math.min(count, config.windowDocuments)}
  const requests: (EdgeSearch & {window: typeof window})[] = [
    {pattern: 'a', scope: 'everything', window}, {pattern: '\\d+', scope: 'everything', window}, {pattern: '"[a-z ]+"', scope: 'strings', window},
  ]
  const overlapping = {rounds: 0, olderRequestsWithAResult: 0, newestWithoutAResult: 0, values: 0, mismatches: 0}
  for (let round = 0; round < 20; round++) {
    // Each round ends with another request, so the newest one differs from the round before.
    const order = [requests[round % 3]!, requests[(round + 1) % 3]!, requests[(round + 2) % 3]!]
    const [first, second, third] = await Promise.all(order.map(request => searcher.search(request)))
    overlapping.rounds++
    if (first !== undefined) overlapping.olderRequestsWithAResult++
    if (second !== undefined) overlapping.olderRequestsWithAResult++
    const alone = await searcher.search(order[2]!)
    if (third?.status !== 'searched' || alone?.status !== 'searched' || third.pattern !== order[2]!.pattern) {
      overlapping.newestWithoutAResult++
      continue
    }
    overlapping.values += third.matchCounts.length + third.marks.length
    for (let index = 0; index < third.matchCounts.length; index++) if (third.matchCounts[index] !== alone.matchCounts[index]) overlapping.mismatches++
    for (let index = 0; index < third.marks.length; index++) if (third.marks[index] !== alone.marks[index]) overlapping.mismatches++
  }
  report['threeRequestsAtOnce'] = overlapping
  log(`three requests at once: ${JSON.stringify(overlapping)}`)
  searcher.destroy()
  await post(false)

  // The first stage's shaders, every position written out, over the same documents, against the executor.
  const batch = buildBatchPrograms()
  const cells = new Float32Array(count * cellsPerDocument)
  texts.forEach((text, row) => writeDocumentCells(cells, row * cellsPerDocument, text))
  const store = await createDocumentStore(device, cellsPerDocument, count)
  store.write(cells, count)
  const firstStage: Record<string, unknown>[] = []
  for (const program of batch.programs) {
    const shader = program.emitShader()
    const runner = await createProgramRunner(device, shader, program.packShared(shader), store, config.shaderSalt)
    const check = await selfCheck(runner, program, cells, count)
    firstStage.push({rootSet: program.rootSet, compileMs: round(runner.compileMs), documents: check.documents, values: check.values, mismatches: check.mismatches})
    runner.destroy()
  }
  store.destroy()
  report['firstStageShadersOverTheEdgeDocuments'] = firstStage
  log(`the first stage's shaders: ${JSON.stringify(firstStage)}`)
}

async function runMany() {
  const count = config.documents
  const texts = generateDocuments(count, config.seed, config.invalidFraction).map(document => document.text)
  const device = await requestDevice(bufferBytesFor(count))
  const searcher = await createGpuSearcher(device, texts, {windowCapacity: config.windowDocuments, shaderSalt: config.shaderSalt, writers: {search: config.searchWriter}})
  log(`${count} generated documents on the GPU, ${searcher.validation.validCount} valid`)

  // The highlighter on the CPU executor, every position written out, for every document. Its 410 MB of expected values
  // are let go before the next comparison.
  let started = performance.now()
  const compareValidation = async () => {
    const expected = highlighterOnTheExecutor(texts)
    const validation = {documents: count, values: 0, mismatches: 0, expectedValidDocuments: 0, expectedKindsThatAreNotWhitespace: 0, executorMs: round(performance.now() - started)}
    for (let row = 0; row < count; row++) {
      const actual = [searcher.validation.valid[row]!, searcher.validation.firstErrorPosition[row]!, searcher.validation.truncated[row]!, searcher.validation.firstErrorKind[row]!]
      const wanted = [expected.summary[row * summaryCount]!, expected.summary[row * summaryCount + 1]!, expected.summary[row * summaryCount + 2]!, expected.errorKinds[row]!]
      validation.expectedValidDocuments += wanted[0]!
      validation.values += 4
      for (let column = 0; column < 4; column++) if (actual[column] !== wanted[column]) validation.mismatches++
    }
    for (const range of windowsOver(count, 4096)) {
      const kinds = await searcher.kinds(range)
      validation.values += kinds.length
      for (let index = 0; index < kinds.length; index++) {
        const wanted = expected.kinds[range.firstDocument * kindCount + index]!
        if (wanted !== 0) validation.expectedKindsThatAreNotWhitespace++
        if (kinds[index] !== wanted) validation.mismatches++
      }
    }
    return validation
  }
  const validation = await compareValidation()
  report['validationAgainstTheHighlighterOnTheExecutor'] = validation
  // searcher.validate()'s own evaluateMs, which the searcher's measurement page reports, next to the time from the
  // call until its promise resolves, which also holds JavaScript turning the summary into four typed arrays.
  const validateWall: number[] = []
  const validateEvaluate: number[] = []
  for (let index = 0; index < 60; index++) {
    const validateStarted = performance.now()
    const {evaluateMs} = await searcher.validate()
    if (index >= 10) {
      validateWall.push(performance.now() - validateStarted)
      validateEvaluate.push(evaluateMs)
    }
  }
  report['validateBackToBack'] = {fromCallToResolveMs: summary(validateWall), evaluateMs: summary(validateEvaluate)}
  log(`validate back to back: ${JSON.stringify(report['validateBackToBack'])}`)
  log(`validation and kinds against the highlighter on the executor: ${JSON.stringify(validation)}`)
  await post(false)

  // The searches: the same loop programs as generated JavaScript, over every document.
  const middle = {firstDocument: Math.floor((count - config.windowDocuments) / 2), documentCount: Math.min(count, config.windowDocuments)}
  const windows = [middle, {firstDocument: 0, documentCount: middle.documentCount}, {firstDocument: count - middle.documentCount, documentCount: middle.documentCount}]
  const searches: EdgeSearch[] = [
    {pattern: '(the|an?) [a-z]+', scope: 'strings'}, {pattern: '"[a-z]+":', scope: 'everything'}, {pattern: '[a-z0-9.]+@[a-z.]+', scope: 'stringsAndKeys'}, {pattern: '[a-z]+', scope: 'keys'},
    {pattern: '(the|an?|some) [a-z]+(ing)?s?', scope: 'strings'},
  ]
  started = performance.now()
  const generated = createCpuSearcher(texts, {windowCapacity: config.windowDocuments})
  const againstGenerated = await compareSearchers(searcher, generated, searches, windows)
  // The loop programs' own times on the CPU, over every document: the highlighter once, and each search.
  report['againstGeneratedJavaScript'] = {...againstGenerated, searchesRun: searches, validateMicrosecondsPerDocument: round(generated.load.validateMs * 1000 / count), totalMs: round(performance.now() - started)}
  log(`against the loop programs as generated JavaScript: ${JSON.stringify(report['againstGeneratedJavaScript'])}`)
  await post(false)

  // 32 states as generated JavaScript, over the first documents.
  started = performance.now()
  const generatedFew = createCpuSearcher(texts.slice(0, config.generatedDocumentsAt32States), {windowCapacity: config.windowDocuments})
  const fewWindows = [{firstDocument: 0, documentCount: middle.documentCount}]
  const at32 = await compareSearchers(searcher, generatedFew, [{pattern: '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', scope: 'strings'}, {pattern: 'connection reset', scope: 'everything'}], fewWindows)
  report['at32StatesAgainstGeneratedJavaScript'] = {...at32, totalMs: round(performance.now() - started)}
  log(`32 states against generated JavaScript: ${JSON.stringify(report['at32StatesAgainstGeneratedJavaScript'])}`)
  await post(false)

  // The loop programs on the CPU executor, over the first documents.
  started = performance.now()
  const executor = createCpuSearcher(texts.slice(0, config.executorDocuments), {windowCapacity: config.windowDocuments, backend: 'executor'})
  const againstExecutor = await compareSearchers(searcher, executor, [...searches.slice(0, 2), searches.at(-1)!], fewWindows)
  report['againstTheLoopProgramsOnTheExecutor'] = {...againstExecutor, validateMicrosecondsPerDocument: round(executor.load.validateMs * 1000 / config.executorDocuments), totalMs: round(performance.now() - started)}
  log(`against the loop programs on the executor: ${JSON.stringify(report['againstTheLoopProgramsOnTheExecutor'])}`)
  searcher.destroy()
}

function codePointSlice(text: string, limit: number) {
  // A text of at most `limit` code units has at most that many code points.
  return text.length <= limit ? text : Array.from(text).slice(0, limit).join('')
}

// A worker that holds a share of the documents and answers a request with one typed array.
const workerSource = `
let texts = []
onmessage = event => {
  const message = event.data
  if (message.texts !== undefined) {
    texts = message.texts
    postMessage({ready: texts.length})
  } else if (message.kind === 'parse') {
    const valid = new Uint8Array(texts.length)
    for (let index = 0; index < texts.length; index++) {
      try {
        JSON.parse(texts[index])
        valid[index] = 1
      } catch {}
    }
    postMessage({values: valid}, [valid.buffer])
  } else {
    const global = new RegExp(message.pattern, 'gu')
    const counts = new Float32Array(texts.length)
    for (let index = 0; index < texts.length; index++) {
      const found = texts[index].match(global)
      counts[index] = found === null ? 0 : found.length
    }
    postMessage({values: counts}, [counts.buffer])
  }
}
`

async function runBaselines() {
  const count = config.documents
  const texts = generateDocuments(count, config.seed, config.invalidFraction).map(document => document.text)
  const sliced = texts.map(text => codePointSlice(text, positions))
  let sink = 0

  // JSON.parse, and the table loop written two ways: every document's kinds into one array of 512, as the searcher's
  // page timed it, and into an array that holds every document's kinds, as the first stage's page timed it.
  const kindsScratch = new Uint8Array(positions)
  const kindsOfEveryDocument = new Uint8Array(count * positions)
  const validate = {
    jsonParse: timeCpu(config, () => {
      for (let index = 0; index < count; index++) {
        try {
          JSON.parse(texts[index]!)
          sink++
        } catch {}
      }
    }, count),
    tableLoopIntoOneArrayOf512: timeCpu(config, () => {
      for (let index = 0; index < count; index++) {
        highlightWithTables(texts[index]!, kindsScratch, 0)
        sink += tableLoopResult.firstErrorPosition
      }
    }, count),
    tableLoopIntoEveryDocumentsKinds: timeCpu(config, () => {
      for (let index = 0; index < count; index++) {
        highlightWithTables(texts[index]!, kindsOfEveryDocument, index * positions)
        sink += tableLoopResult.firstErrorPosition
      }
    }, count),
  }
  report['validate'] = validate
  log(`validate, µs per document: ${Object.entries(validate).map(([name, time]) => `${name} ${time.microsecondsPerDocument}`).join(', ')}`)
  await post(false)

  // Four ways to count a pattern's matches in each document with RegExp.
  const regExp: Record<string, unknown>[] = []
  report['regExp'] = regExp
  for (const pattern of config.patterns) {
    const global = new RegExp(pattern, 'gu')
    const globalWithoutU = new RegExp(pattern, 'g')
    const ways = {
      // What the measurement pages time: String.prototype.match with the g flag, which builds an array of the matches.
      match: (text: string) => text.match(global)?.length ?? 0,
      matchWithoutTheUFlag: (text: string) => text.match(globalWithoutU)?.length ?? 0,
      // RegExp.prototype.test with the g flag continues from lastIndex and builds nothing. A pattern here never matches
      // the empty text in these documents, so the loop moves on.
      testLoop: (text: string) => {
        let found = 0
        global.lastIndex = 0
        while (global.test(text)) found++
        return found
      },
      execLoop: (text: string) => {
        let found = 0
        global.lastIndex = 0
        while (global.exec(text) !== null) found++
        return found
      },
    }
    const totals = Object.fromEntries(Object.entries(ways).map(([name, countIn]) => [name, sliced.reduce((total, text) => total + countIn(text), 0)]))
    const times = Object.fromEntries(Object.entries(ways).map(([name, countIn]) => [name, timeCpu(config, () => {
      for (let index = 0; index < count; index++) sink += countIn(sliced[index]!)
    }, count)]))
    regExp.push({pattern, totals, times})
    log(`RegExp ${pattern}: matches ${JSON.stringify(totals)}, µs per document ${Object.entries(times).map(([name, time]) => `${name} ${time.microsecondsPerDocument}`).join(', ')}`)
    await post(false)
  }

  // Several workers, each with a share of the documents, sent once. One request is one message to every worker, and
  // its time runs until the last worker's typed array has arrived.
  const url = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}))
  const workersResults: Record<string, unknown>[] = []
  report['workers'] = workersResults
  for (const workerCount of config.workerCounts) {
    const share = Math.ceil(count / workerCount)
    const workers = Array.from({length: workerCount}, () => new Worker(url))
    const reply = (worker: Worker) => new Promise<{ready?: number, values?: Uint8Array | Float32Array}>(resolve => {
      worker.onmessage = event => resolve(event.data as {ready?: number, values?: Uint8Array | Float32Array})
    })
    let started = performance.now()
    await Promise.all(workers.map((worker, index) => {
      const answered = reply(worker)
      worker.postMessage({texts: sliced.slice(index * share, (index + 1) * share)})
      return answered
    }))
    const sendMs = performance.now() - started
    const request = async (message: {kind: 'parse'} | {kind: 'count', pattern: string}) => {
      const answers = await Promise.all(workers.map(worker => {
        const answered = reply(worker)
        worker.postMessage(message)
        return answered
      }))
      let total = 0
      for (const answer of answers) for (const value of answer.values!) total += value
      return total
    }
    // 5 requests of warmup and 15 samples, or fewer for a request that takes long: at least 1 and 3.
    const timeRequest = async (message: {kind: 'parse'} | {kind: 'count', pattern: string}) => {
      let total = 0
      const warmStarted = performance.now()
      for (let warm = 0; warm < 5 && (warm < 1 || performance.now() - warmStarted < 500); warm++) total = await request(message)
      const samples: number[] = []
      const sampleStarted = performance.now()
      while (samples.length < 15 && (samples.length < 3 || performance.now() - sampleStarted < 2000)) {
        started = performance.now()
        total = await request(message)
        samples.push(performance.now() - started)
      }
      return {total, ms: summary(samples)}
    }
    const entry = {workers: workerCount, documents: count, sendingTheDocumentsMs: round(sendMs), jsonParse: await timeRequest({kind: 'parse'}), regExp: [] as unknown[]}
    for (const pattern of config.patterns) entry.regExp.push({pattern, ...await timeRequest({kind: 'count', pattern})})
    workersResults.push(entry)
    log(`${workerCount} workers: documents sent in ${round(sendMs)} ms, JSON.parse ${entry.jsonParse.ms?.median} ms, RegExp ${JSON.stringify(entry.regExp)}`)
    for (const worker of workers) worker.terminate()
    await post(false)
  }
  URL.revokeObjectURL(url)
  report['sink'] = sink
}

try {
  if (config.mode === 'edge') await runEdge()
  else if (config.mode === 'many') await runMany()
  else await runBaselines()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
