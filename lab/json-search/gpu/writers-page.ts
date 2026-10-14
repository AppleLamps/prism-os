// The GPU measurement page for the searcher's two code writers, loop-emit.ts and bit-emit.ts, in one Chrome process.
// writers-run.ts serves it, opens it in headless Chrome, and writes what it posts to /result. Other jobs use the
// machine and the GPU, and a search's time moves with them, so the page creates the searchers side by side and gives
// them turns: a few seconds lie between two times that are compared. Over the demo page's documents, which are all
// valid JSON, it:
// - creates three GPU searchers on one device: with loop-emit.ts's shaders for the search programs, which the demo
//   page ran until October 14, 2026, with bit-emit.ts's, which it runs since, and with bit-emit.ts's shader for the
//   highlighter too;
// - compares every value of the highlighter from either writer's shader, and for each pattern every document's match
//   count and the marks of 64 documents from either writer's search shader;
// - times the highlighter's pass with either writer's shader, back to back and after a pause;
// - times one search of every document per pattern with either writer's shaders, back to back and after a pause, with
//   the time from the call of `searcher.search` until its promise resolves;
// - in the 'stop' part, times bit-emit.ts's search shader with loops that run every position, which the searcher uses,
//   next to the same shader with loops that stop at the text's end.
import {capacity as positions} from '../../../src/json-search/highlighter/kinds.ts'
import {compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {emitBitLoopWgsl} from '../../../src/json-search/bit-emit.ts'
import {documentText} from '../../../src/json-search/demo-text.ts'
import {buildJsonLoop} from '../../../src/json-search/json-step.ts'
import {emitLoopWgsl} from '../../../src/json-search/loop-emit.ts'
import {cellsPerDocument, writeDocumentCells} from '../../../src/json-search/program.ts'
import {type SearchScope, boundaryCapacity, buildSearchLoop, classCapacity} from '../../../src/json-search/search-step.ts'
import {type Searcher, bufferBytesFor, createGpuSearcher} from '../../../src/json-search/searcher.ts'
import {createDocumentStore, createProgramRunner, requestBatchDevice} from '../../../src/json-search/gpu/host.ts'
import {createReporter, round, sleep, summary} from './measure.ts'

export type WritersPageConfig = {
  count: number
  shaderSalt: number
  // How many turns each searcher gets per pattern, how many searches a back to back series holds after 3 of warmup,
  // and the pause before each search of the other series.
  rounds: number
  samples: number
  pauseMs: number
  pauseSamples: number
  patterns: {pattern: string, scope: SearchScope}[]
  parts: ('searchers' | 'stop')[]
}

const {report, post, log} = createReporter()
const config = await (await fetch('/config')).json() as WritersPageConfig
report['config'] = config

const searcherNames = ['loop-emit.ts\'s search shaders', 'bit-emit.ts\'s search shaders', 'bit-emit.ts\'s search shaders and highlighter shader'] as const

async function runSearchers(device: GPUDevice, texts: readonly string[], cells: Float32Array) {
  const {count} = config
  const searchers: Searcher[] = []
  const created: Record<string, unknown>[] = []
  report['created'] = created
  for (const [index, name] of searcherNames.entries()) {
    // A salt per searcher, so that no shader's compile reads another's from a cache.
    const searcher = await createGpuSearcher(device, texts, {cells, shaderSalt: config.shaderSalt + index, writers: {search: index === 0 ? 'loop-emit' : 'bit-emit', highlighter: index === 2 ? 'bit-emit' : 'loop-emit'}})
    searchers.push(searcher)
    const programs = searcher.programs().map(program => ({name: program.name, statements: program.statements, compileMs: round(program.compileMs ?? 0)}))
    created.push({name, createMs: round(searcher.load.totalMs), programs})
    log(`${name}: created in ${round(searcher.load.totalMs)} ms, ${JSON.stringify(programs.map(program => [program.statements, program.compileMs]))}`)
  }
  const [before, after, withBitHighlighter] = searchers as [Searcher, Searcher, Searcher]

  // The highlighter's values from either writer's shader: the validation and every display kind.
  const highlighterValues = {values: count * 4 + count * positions, different: 0, validDocuments: after.validation.validCount}
  for (const name of ['valid', 'firstErrorPosition', 'firstErrorKind', 'truncated'] as const) {
    for (let row = 0; row < count; row++) if (after.validation[name][row] !== withBitHighlighter.validation[name][row]) highlighterValues.different++
  }
  for (let first = 0; first < count; first += 4096) {
    const window = {firstDocument: first, documentCount: Math.min(4096, count - first)}
    const [left, right] = [await after.kinds(window), await withBitHighlighter.kinds(window)]
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) highlighterValues.different++
  }
  report['highlighterValues'] = highlighterValues
  log(`the highlighter's values from either writer's shader: ${JSON.stringify(highlighterValues)}`)
  await post(false)

  // The highlighter's pass over every document, as `validate` runs it.
  const validate: Record<string, unknown>[] = []
  report['validate'] = validate
  for (let turn = 0; turn < config.rounds * 2; turn++) {
    const searcher = turn % 2 === 0 ? after : withBitHighlighter
    const writer = turn % 2 === 0 ? 'loop-emit' : 'bit-emit'
    const backToBack: number[] = []
    const passes: number[] = []
    // Every other pass asks for the pass's own time, and reading that back adds a wait, so those passes aren't in the
    // back to back times.
    for (let index = 0; index < 2 * config.samples + 3; index++) {
      const started = performance.now()
      const {validation, passMs} = await searcher.validate({timestamps: index % 2 === 1})
      if (index >= 3 && passMs === undefined) backToBack.push(performance.now() - started)
      if (index >= 3 && passMs !== undefined) passes.push(passMs)
      if (validation.validCount !== highlighterValues.validDocuments) throw new Error('a pass gave another count of valid documents')
    }
    const afterPause: number[] = []
    for (let index = 0; index < config.pauseSamples; index++) {
      await sleep(config.pauseMs)
      const started = performance.now()
      await searcher.validate()
      afterPause.push(performance.now() - started)
    }
    validate.push({writer, backToBack: summary(backToBack), passMs: summary(passes), afterPause: summary(afterPause)})
    log(`the highlighter's pass, ${writer}.ts's shader: back to back ${summary(backToBack)?.median} ms, the pass alone ${summary(passes)?.median} ms, after ${config.pauseMs} ms ${summary(afterPause)?.median} ms`)
  }
  await post(false)

  const searches: Record<string, unknown>[] = []
  report['searches'] = searches
  const searchValues = {searches: 0, values: 0, different: 0}
  report['searchValues'] = searchValues
  const window = {firstDocument: Math.floor((count - Math.min(count, 64)) / 2), documentCount: Math.min(count, 64)}
  for (const {pattern, scope} of config.patterns) {
    // The same search from both writers' shaders: every document's count, and the marks of the window's documents.
    const [fromBefore, fromAfter] = [await before.search({pattern, scope, window}), await after.search({pattern, scope, window})]
    if (fromBefore?.status !== 'searched' || fromAfter?.status !== 'searched') throw new Error(`${pattern} wasn't searched`)
    searchValues.searches++
    searchValues.values += fromBefore.matchCounts.length + fromBefore.marks.length
    for (let index = 0; index < fromBefore.matchCounts.length; index++) if (fromBefore.matchCounts[index] !== fromAfter.matchCounts[index]) searchValues.different++
    for (let index = 0; index < fromBefore.marks.length; index++) if (fromBefore.marks[index] !== fromAfter.marks[index]) searchValues.different++
    for (let turn = 0; turn < config.rounds * 2; turn++) {
      const searcher = turn % 2 === 0 ? before : after
      const writer = turn % 2 === 0 ? 'loop-emit' : 'bit-emit'
      const once = async () => {
        const started = performance.now()
        const result = await searcher.search({pattern, scope})
        const totalMs = performance.now() - started
        if (result?.status !== 'searched' || result.documentsWithMatches !== fromAfter.documentsWithMatches) throw new Error(`${pattern}: another answer`)
        return totalMs
      }
      // A search that takes about 1 s is sampled fewer times.
      const slow = await once() > 300
      const backToBack: number[] = []
      for (let index = 0; index < (slow ? 5 : config.samples + 2); index++) {
        const ms = await once()
        if (slow || index >= 2) backToBack.push(ms)
      }
      const afterPause: number[] = []
      for (let index = 0; index < (slow ? 4 : config.pauseSamples); index++) {
        await sleep(config.pauseMs)
        afterPause.push(await once())
      }
      searches.push({pattern, scope, patternStates: fromAfter.patternStates, states: fromAfter.states, documentsWithMatches: fromAfter.documentsWithMatches, writer, backToBack: summary(backToBack), afterPause: summary(afterPause)})
      log(`${pattern} in ${String(scope)}, ${fromAfter.states} states, ${writer}.ts: back to back ${summary(backToBack)?.median} ms (${summary(backToBack)?.min} to ${summary(backToBack)?.max}), after ${config.pauseMs} ms ${summary(afterPause)?.median} ms (${summary(afterPause)?.min} to ${summary(afterPause)?.max})`)
    }
    await post(false)
  }
  log(`the searches' values from either writer's shaders: ${JSON.stringify(searchValues)}`)
  for (const searcher of searchers) searcher.destroy()
}

// bit-emit.ts's search shader with loops that run every position, as the searcher uses it, and with loops that stop at
// the text's end, as the CPU searcher's do.
async function runStop(device: GPUDevice, cells: Float32Array) {
  const {count} = config
  const store = await createDocumentStore(device, cellsPerDocument, count)
  store.write(cells, count)
  const json = buildJsonLoop(cellsPerDocument)
  const jsonRunner = await createProgramRunner(device, emitLoopWgsl(json.loop), json.loop.sharedValues, store, config.shaderSalt + 10, {windowCapacity: count})
  const everyDocument = {firstDocument: 0, documentCount: count}
  await jsonRunner.evaluate({count, window: everyDocument, readbacks: [{group: 0, ...everyDocument}]})
  const stop: Record<string, unknown>[] = []
  report['stopAtLength'] = stop
  for (const [states, pattern] of [[8, 'error'], [16, '\\d\\d\\d\\d-\\d\\d-\\d\\d'], [32, 'connection reset']] as const) {
    const compiled = compilePattern(pattern)
    const variants = []
    for (const stopAtLength of [false, true]) {
      const built = buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument, masked: true, stopAtLength})
      const shader = emitBitLoopWgsl(built.loop)
      const runner = await createProgramRunner(device, shader, built.loop.sharedValues, store, config.shaderSalt + 20 + states + (stopAtLength ? 1 : 0), {inputs: [jsonRunner.outputBuffers[1]!], windowCapacity: 64})
      const shared = new Float32Array(built.loop.sharedValues)
      built.writePattern(shared, compiled)
      built.writeScope(shared, 'everything')
      variants.push({stopAtLength, runner, shared, statements: shader.statementCount, matches: new Set<number>()})
    }
    for (let turn = 0; turn < config.rounds * 2; turn++) {
      const variant = variants[turn % 2]!
      const once = async () => {
        const evaluation = await variant.runner.evaluate({count, shared: variant.shared, readbacks: [{group: 0, firstDocument: 0, documentCount: count}]})
        let matches = 0
        for (const value of evaluation.outputs[0]!) matches += value
        variant.matches.add(matches)
        return evaluation.totalMs
      }
      const backToBack: number[] = []
      for (let index = 0; index < config.samples + 3; index++) {
        const ms = await once()
        if (index >= 3) backToBack.push(ms)
      }
      const afterPause: number[] = []
      for (let index = 0; index < config.pauseSamples; index++) {
        await sleep(config.pauseMs)
        afterPause.push(await once())
      }
      stop.push({states, pattern, stopAtLength: variant.stopAtLength, statements: variant.statements, compileMs: round(variant.runner.compileMs), backToBack: summary(backToBack), afterPause: summary(afterPause)})
      log(`${states} states, loops ${variant.stopAtLength ? 'stop at the text\'s end' : 'run every position'}: compiled in ${round(variant.runner.compileMs)} ms, back to back ${summary(backToBack)?.median} ms, after ${config.pauseMs} ms ${summary(afterPause)?.median} ms`)
    }
    // Every evaluation of both shaders found the same number of matches.
    stop.push({states, pattern, matchesWithEveryPosition: [...variants[0]!.matches], matchesWithStopping: [...variants[1]!.matches]})
    for (const variant of variants) variant.runner.destroy()
    await post(false)
  }
  jsonRunner.destroy()
  store.destroy()
}

async function run() {
  const {count} = config
  const texts = Array.from({length: count}, (_, index) => documentText(index))
  const cells = new Float32Array(count * cellsPerDocument)
  for (let row = 0; row < count; row++) writeDocumentCells(cells, row * cellsPerDocument, texts[row]!)
  const granted = await requestBatchDevice(bufferBytesFor(count))
  const {device} = granted
  void device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
    void post(true)
  })
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
    void post(true)
  })
  report['adapter'] = {info: granted.adapterInfo, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  if (config.parts.includes('searchers')) await runSearchers(device, texts, cells)
  if (config.parts.includes('stop')) await runStop(device, cells)
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
