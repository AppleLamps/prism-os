// A page for the independent check of bit-emit.ts's shaders on the GPU: it runs the search step as bit-emit.ts writes
// it over the documents and posts what every evaluation returned to writer-independent.ts, as the f32 values that the
// GPU wrote: the match count of every document and the mark of every position. writer-independent.ts compares them
// with RegExp over the documents' texts in Bun. Nothing is timed here, and nothing is compared here.
//
// The display kinds that a search with a scope reads also come from bit-emit.ts's shader, of the highlighter's step,
// and the page posts them too. So no shader of loop-emit.ts runs in this page. Every generated document is valid JSON,
// so the same shader also runs over the texts that the driver sends, most of them broken, and the page posts its
// summary and display kinds for them.
//
// For each state capacity the page runs three forms of the search step:
//   'plain'   without a scope, every position of the loops
//   'stop'    without a scope, with both loops stopping at the text's end (stopAtLength), which no other run puts
//             on a GPU as bit-emit.ts writes it
//   'scope'   with a scope, which is what searcher.ts runs for the demo page, once per scope
// Each search is evaluated a window of documents at a time, with the marks of every document of the window. A search
// with a scope is also evaluated once more as searcher.ts does it: every document in one pass, with the marks of 64
// documents in the middle.
import {capacityErrors, compilePattern} from '../../regex-search/pattern.ts'
import {emitBitLoopWgsl} from '../bit-emit.ts'
import {documentText} from '../demo-text.ts'
import {type ProgramRunner, createDocumentStore, createProgramRunner, requestBatchDevice} from '../gpu/host.ts'
import {buildJsonLoop} from '../json-step.ts'
import {cellsPerDocument, writeDocumentCells} from '../program.ts'
import {type SearchLoop, type SearchScope, boundaryCapacity, buildSearchLoop, classCapacity} from '../search-step.ts'
import {positions} from './layouts.ts'

export type WriterAnswersConfig = {
  count: number
  // How many documents one evaluation covers, e.g. 10,000 documents are 5,120,000 marks, 20 MB per post.
  windowDocuments: number
  patterns: string[]
  capacities: number[]
  shaderSalt: number
  // Other texts for the highlighter's step alone, most of them broken JSON, since every generated document is valid.
  brokenTexts: string[]
}
export const searchForms = ['plain', 'stop', 'scope'] as const
export type SearchForm = typeof searchForms[number]
export const namedScopes = ['everything', 'strings', 'keys', 'stringsAndKeys'] as const
// One search that the page ran and posted, a window of documents at a time.
export type WriterSearch = {patternIndex: number, states: number, form: SearchForm, scope: typeof namedScopes[number]}

const config = await (await fetch('/config')).json() as WriterAnswersConfig
const searches: WriterSearch[] = []
const shaders: Record<string, unknown>[] = []
// The report holds how many other texts there are, and not the texts.
const report: Record<string, unknown> = {startedAt: new Date().toISOString(), userAgent: navigator.userAgent, config: {...config, brokenTexts: config.brokenTexts.length}, searches, shaders}
const post = async (done: boolean) => {
  await fetch('/result', {method: 'POST', body: JSON.stringify({...report, done})})
}
// The values as the GPU wrote them, with nothing converted.
const postValues = async (route: string, query: Record<string, string | number>, values: Float32Array) => {
  const parameters = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, String(value)]))
  const response = await fetch(`${route}?${parameters.toString()}`, {method: 'POST', body: new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice()})
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${await response.text()}`)
}

try {
  const {count, windowDocuments} = config
  const onScreen = 64
  const {device} = await requestBatchDevice(count * cellsPerDocument * 4)
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
  })
  void device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
  })
  const store = await createDocumentStore(device, cellsPerDocument, count)
  const cells = new Float32Array(windowDocuments * cellsPerDocument)
  const windows: {first: number, documents: number}[] = []
  for (let first = 0; first < count; first += windowDocuments) windows.push({first, documents: Math.min(windowDocuments, count - first)})
  for (const {first, documents} of windows) {
    for (let row = 0; row < documents; row++) writeDocumentCells(cells, row * cellsPerDocument, documentText(first + row))
    store.write(cells, documents, first)
    await device.queue.onSubmittedWorkDone()
  }

  // The display kind of every position of every document, from bit-emit.ts's shader of the highlighter's step.
  const json = buildJsonLoop(cellsPerDocument)
  const jsonShader = emitBitLoopWgsl(json.loop)
  const highlighter = await createProgramRunner(device, jsonShader, json.loop.sharedValues, store, config.shaderSalt, {windowCapacity: count})
  shaders.push({program: 'the highlighter\'s step', compileMs: highlighter.compileMs, statements: jsonShader.statementCount, rules: jsonShader.rules})
  await highlighter.evaluate({count, window: {firstDocument: 0, documentCount: count}, readbacks: []})
  for (const {first, documents} of windows) {
    await postValues('/kinds', {first, documents}, await highlighter.read({group: 1, firstDocument: first, documentCount: documents}))
  }
  console.log('the display kinds are posted')
  // The same shader over the other texts, in a store of their own: the summary of every text, then its display kinds.
  const {brokenTexts} = config
  if (brokenTexts.length > 0) {
    const brokenStore = await createDocumentStore(device, cellsPerDocument, brokenTexts.length)
    const brokenCells = new Float32Array(brokenTexts.length * cellsPerDocument)
    brokenTexts.forEach((text, row) => writeDocumentCells(brokenCells, row * cellsPerDocument, text))
    brokenStore.write(brokenCells, brokenTexts.length)
    const every = {firstDocument: 0, documentCount: brokenTexts.length}
    const brokenRunner = await createProgramRunner(device, jsonShader, json.loop.sharedValues, brokenStore, config.shaderSalt, {windowCapacity: brokenTexts.length})
    const {outputs} = await brokenRunner.evaluate({count: brokenTexts.length, window: every, readbacks: [{group: 0, ...every}, {group: 1, ...every}]})
    const values = new Float32Array(outputs[0]!.length + outputs[1]!.length)
    values.set(outputs[0]!)
    values.set(outputs[1]!, outputs[0]!.length)
    await postValues('/broken', {documents: brokenTexts.length}, values)
    brokenRunner.destroy()
    brokenStore.destroy()
    console.log('the highlighter\'s answers for the other texts are posted')
  }
  await post(false)

  const patterns = config.patterns.map(pattern => compilePattern(pattern))
  for (const states of config.capacities) {
    const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
    const fitting = patterns.flatMap((compiled, patternIndex) => capacityErrors(compiled, capacity).length === 0 ? [{compiled, patternIndex}] : [])
    for (const form of searchForms) {
      const built: SearchLoop = buildSearchLoop(capacity, {positions, cellsPerDocument, masked: form === 'scope', stopAtLength: form === 'stop'})
      const shader = emitBitLoopWgsl(built.loop)
      const runner: ProgramRunner = await createProgramRunner(device, shader, built.loop.sharedValues, store, config.shaderSalt, {windowCapacity: windowDocuments, ...(form === 'scope' ? {inputs: [highlighter.outputBuffers[1]!]} : {})})
      shaders.push({program: 'the search step', states, form, compileMs: runner.compileMs, statements: shader.statementCount, rules: shader.rules, packedWords: shader.packedCells.length})
      const shared = new Float32Array(built.loop.sharedValues.length)
      for (const {compiled, patternIndex} of fitting) {
        for (const scope of form === 'scope' ? namedScopes : ['everything'] as const) {
          shared.set(built.loop.sharedValues)
          built.writePattern(shared, compiled)
          if (form === 'scope') built.writeScope(shared, scope satisfies SearchScope)
          for (const {first, documents} of windows) {
            const {outputs} = await runner.evaluate({
              count: documents, firstDocument: first, window: {firstDocument: first, documentCount: documents}, shared,
              readbacks: [{group: 0, firstDocument: first, documentCount: documents}, {group: 1, firstDocument: 0, documentCount: documents}],
            })
            // One body: the window's match counts, then its marks.
            const values = new Float32Array(documents * (1 + positions))
            values.set(outputs[0]!)
            values.set(outputs[1]!, documents)
            await postValues('/window', {pattern: patternIndex, states, form, scope, first, documents}, values)
          }
          if (form === 'scope') {
            // As searcher.ts calls the shader for the demo page: one evaluation over every document, with the marks
            // of the documents on screen, here 64 documents somewhere in the middle.
            const window = {firstDocument: (patternIndex * 4999 + states * 131) % (count - onScreen), documentCount: onScreen}
            const {outputs} = await runner.evaluate({count, shared, window, readbacks: [{group: 0, firstDocument: 0, documentCount: count}, {group: 1, firstDocument: 0, documentCount: onScreen}]})
            const values = new Float32Array(count + onScreen * positions)
            values.set(outputs[0]!)
            values.set(outputs[1]!, count)
            await postValues('/whole', {pattern: patternIndex, states, form, scope, first: window.firstDocument, documents: onScreen}, values)
          }
          searches.push({patternIndex, states, form, scope})
        }
      }
      runner.destroy()
      console.log(`${states} states, ${form}: ${fitting.length} patterns are posted`)
      await post(false)
    }
  }
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  await post(true)
}
