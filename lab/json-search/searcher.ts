// One module for a demo page: many JSON documents, validated and highlighted once, then searched for a pattern as the
// visitor types. It has no page globals. The GPU version is created from a device and the documents' texts, and the CPU
// version from the texts alone, with the same interface, for a browser without WebGPU or a GPU that fails the self check.
//
//   const {device} = await requestBatchDevice(bufferBytesFor(texts.length))
//   const searcher = await createGpuSearcher(device, texts)          // or createCpuSearcher(texts.slice(0, 500))
//   searcher.validation.valid[7]                                     // 1 when document 7 is valid JSON
//   const result = await searcher.search({pattern: '(the|an?) [a-z]+', scope: 'strings', window: {firstDocument: 0, documentCount: 40}})
//   if (result?.status === 'searched') result.matchCounts[7]         // matches inside document 7's string values
//
// Both versions run the same two programs, each as a loop over a document's 512 positions (loop-program.ts):
// - json-step.ts, the JSON highlighter's step, once when the searcher is created: valid, the first error's position
//   and kind, truncated, and the display kind of every code point, which stays on the GPU.
// - search-step.ts, regex search's step with the pattern as data, once per search: the match count of every document,
//   and for the documents of a window, e.g. the ones on screen, a mark per code point. It reads the display kinds, so
//   a search can read only string values, only keys, or everything. There is one such program per state capacity,
//   8, 16 and 32 by default, and a pattern runs on the smallest one that holds it. A step takes one table read per
//   pair of states, so on the CPU its time grows steeply with the capacity: 0.14, 0.34 and 1.8 ms per document at 8,
//   16 and 32 states. On the GPU, bit-emit.ts writes the reads of one state as one AND of two 32-bit words, and the
//   three programs take nearly the same time.
// On the GPU a search uploads the search program's shared cells, 1,135 to 16,591 numbers, of which the pattern writes
// 1,097 to 16,481, and the 272 to 1,088 words that the runner packs from them, and nothing per document.
//
// A page calls search when the pattern, the scope or the window changes. One evaluation is in flight at a time: a
// request waits for the one before it, and a request that a newer one replaced, before or while it ran, resolves to
// undefined, so a page never shows a result for a pattern the visitor has already changed. The result arrives after
// the frame that asked for it, so a page treats it as an input of a later frame.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {capacity as positions} from '../../src/json-highlighter/kinds.ts'
import {type CompiledPattern, PatternSyntaxError, capacityErrors, compilePattern} from '../regex-search/pattern.ts'
import {type ProgramRunner, createDocumentStore, createProgramRunner} from './gpu/host.ts'
import {emitBitLoopWgsl} from './bit-emit.ts'
import {buildJsonLoop, stepSummaryNames} from './json-step.ts'
import {emitLoopWgsl} from './loop-emit.ts'
import {type LoopProgram, type LoopRunner, createLoopRunner, describeLoop} from './loop-program.ts'
import {cellsPerDocument, writeDocumentCells} from './program.ts'
import {type SearchLoop, type SearchScope, boundaryCapacity, buildSearchLoop, classCapacity} from './search-step.ts'

export {positions}
export const defaultStateCapacities: readonly number[] = [8, 16, 32]
// The bytes of the largest buffer a GPU searcher creates for this many documents, for requestBatchDevice.
export const bufferBytesFor = (documentCount: number) => documentCount * cellsPerDocument * 4

export type DocumentWindow = {firstDocument: number, documentCount: number}

// What the highlighter says about every document. firstErrorKind indexes src/json-highlighter/kinds.ts's errorKinds.
export type Validation = {
  valid: Uint8Array
  // -1 for a valid document.
  firstErrorPosition: Int16Array
  firstErrorKind: Uint8Array
  // 1 when the text holds more than 512 code points.
  truncated: Uint8Array
  validCount: number
}

export type SearchRequest = {
  pattern: string
  // Which display kinds the search reads, 'everything' unless given, see search-step.ts.
  scope?: SearchScope
  // The documents that get marks, e.g. the ones on screen. None unless given.
  window?: DocumentWindow
  // 'window' searches only the window's documents, e.g. after a scroll with the same pattern, which takes one round
  // trip instead of a pass over every document. 'all' unless given.
  documents?: 'all' | 'window'
  // Asks the GPU for the compute pass's own time. Reading it back adds a wait after the search.
  timestamps?: boolean
}

export type SearchResult =
  | {
    status: 'searched'
    pattern: string
    scope: SearchScope
    documents: 'all' | 'window'
    // The state capacity of the program that ran, and how many states the pattern has.
    states: number
    patternStates: number
    // With 'all', one count per document. With 'window', one per document of the window.
    matchCounts: Float32Array
    matches: number
    documentsWithMatches: number
    window: DocumentWindow
    // 512 marks per document of the window: 0 outside a match, 1 inside one, 2 at a match's first code point.
    marks: Float32Array
    timings: {
      // JavaScript before the evaluation: compiling the pattern and writing its cells.
      patternMs: number
      // On the GPU: the upload of the pattern's cells, the pass, and the readback. On the CPU: the loops.
      evaluateMs: number
      totalMs: number
      // The compute pass alone, with `timestamps` on a device that has them.
      passMs: number | undefined
    }
  }
  | {status: 'syntaxError', pattern: string, message: string, position: number}
  // The pattern needs more states, classes or class boundaries than the largest program holds.
  | {status: 'tooLarge', pattern: string, messages: string[]}

export type SelfCheck = {documents: number, searches: number, values: number, mismatches: number, cpuMs: number, gpuMs: number}

export type ProgramDescription = {
  name: string
  // The operations of each stage, e.g. [8, 151, 92] for a search's start, reverse step and forward step.
  operations: number[]
  // Only on the GPU: the shader's size, and the ms from createShaderModule until JavaScript has its pipeline. That
  // is more than the GPU's compile: JavaScript builds the search programs while the highlighter's shader compiles,
  // and the search programs' shaders compile at the same time as each other. E.g. the highlighter's shader shows 31
  // to 38 ms for 1,000 and 10,000 documents, where it showed 14 to 16 ms when nothing else was built meanwhile.
  statements: number | undefined
  compileMs: number | undefined
}

export type Searcher = {
  backend: 'gpu' | 'cpu'
  documentCount: number
  stateCapacities: readonly number[]
  validation: Validation
  // The time to create the searcher, in ms: JavaScript writing the cells, then everything else. On the GPU that is
  // the upload, the highlighter's shader compile and its pass over every document, and building and compiling every
  // search program, which overlap, so `validateMs` holds all of them and the total is the sum of the two.
  load: {cellsMs: number, validateMs: number, totalMs: number}
  // The programs built so far: on the GPU every one, and on the CPU the highlighter and each search program that a
  // search has run on.
  programs: () => ProgramDescription[]
  // What the device granted, and how many documents fit one buffer. Undefined on the CPU.
  limits: {maxStorageBufferBindingSize: number, maxBufferSize: number, maxDocuments: number, hasTimestamps: boolean} | undefined
  // Runs the highlighter over every document again, e.g. to time it. The documents don't change, so the values are
  // the ones `validation` already holds.
  validate: (options?: {timestamps?: boolean}) => Promise<{validation: Validation, evaluateMs: number, passMs: number | undefined}>
  // The display kinds of a window's documents, 512 per document.
  kinds: (window: DocumentWindow) => Promise<Float32Array>
  // Resolves to undefined when a newer request replaced this one.
  search: (request: SearchRequest) => Promise<SearchResult | undefined>
  // Compares the first `documents` documents with the same programs on the other backend: on the GPU with generated
  // JavaScript, and on the CPU with the CPU executor. A page that gets mismatches from a GPU searcher uses the CPU one.
  selfCheck: (documents: number, searches?: readonly {pattern: string, scope: SearchScope}[]) => Promise<SelfCheck>
  destroy: () => void
}

// This folder's two writers of a loop program's WGSL. Both write the same program, and a GPU gives the same values
// from either shader.
// - 'loop-emit' writes every operation as one f32 statement, e.g. one table read per pair of states in a search step.
// - 'bit-emit' holds a value that is proven to be 0 or 1 as a bit, and writes the table reads that one gate combines
//   as one AND of two 32-bit words, see bit-emit.ts.
export type ShaderWriter = 'bit-emit' | 'loop-emit'

export type SearcherOptions = {
  stateCapacities?: readonly number[]
  // Which writer writes the GPU searcher's shaders, for tests and measurements that compare the two. Unless given,
  // the search programs' shaders are bit-emit.ts's and the highlighter's is loop-emit.ts's, see createGpuSearcher.
  writers?: {search?: ShaderWriter, highlighter?: ShaderWriter}
  // How many documents a window holds at most, 64 unless given.
  windowCapacity?: number
  // Goes into every shader's source, see gpu/host.ts. For measuring cold compiles.
  shaderSalt?: number
  // Every document's cells, from a caller that has written them already with program.ts's writeDocumentCells, e.g. a
  // page that writes them a few documents at a time between frames: writing the cells of 100,000 documents in one
  // piece takes about 45 ms. Without it, the searcher writes them from the texts.
  cells?: Float32Array
}

// What a self check searches for. The last seven are there for what the first four leave out:
// - A pattern that has exactly as many states as a program holds, for each of the three programs, e.g. bit 31 of a
//   word at 32 states.
// - A pattern of characters above U+00FF.
// - One that matches at every document's last character.
// - A class that holds every character but one, twice, so a match stops only where the searched characters stop: at
//   the text's end, and with 'strings' at each string value's closing quote. The step reads -1 past either, and a
//   shader that took that -1 for a character, e.g. for U+0000, would let these matches run on.
export const defaultSelfCheckSearches: readonly {pattern: string, scope: SearchScope}[] = [
  {pattern: '[a-z]+', scope: 'everything'},
  {pattern: '(the|an?) [a-z]+', scope: 'strings'},
  {pattern: '"[a-z]+"', scope: 'keys'},
  {pattern: '\\d+', scope: 'stringsAndKeys'},
  {pattern: 'example', scope: 'everything'},
  {pattern: 'connection rese', scope: 'everything'},
  {pattern: 'tLogin": ?"\\d\\d\\d\\d-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ"', scope: 'everything'},
  {pattern: '東京', scope: 'strings'},
  {pattern: '[}\\]]', scope: 'everything'},
  {pattern: '[^,]+', scope: 'everything'},
  {pattern: '[^,]+', scope: 'strings'},
]

// One evaluation at a time, and only the newest request gets a result.
function createGate() {
  let inFlight: Promise<void> | undefined
  let latest = 0
  return {
    // A request that needs no evaluation, e.g. a syntax error, still replaces the ones before it.
    supersede() {
      latest++
    },
    async run<Result>(evaluate: () => Promise<Result>): Promise<Result | undefined> {
      const token = ++latest
      while (inFlight !== undefined) {
        await inFlight
        if (token !== latest) return undefined
      }
      let release = () => {}
      inFlight = new Promise<void>(resolve => {
        release = resolve
      })
      try {
        const result = await evaluate()
        return token === latest ? result : undefined
      } finally {
        inFlight = undefined
        release()
      }
    },
  }
}

type Resolved = {compiled: CompiledPattern, states: number} | Exclude<SearchResult, {status: 'searched'}>

// The compiled pattern and the smallest state capacity that holds it, or the result that says why there is none.
function resolvePattern(pattern: string, stateCapacities: readonly number[]): Resolved {
  let compiled: CompiledPattern
  try {
    compiled = compilePattern(pattern)
  } catch (error) {
    if (!(error instanceof PatternSyntaxError)) throw error
    return {status: 'syntaxError', pattern, message: error.message, position: error.position}
  }
  const fits = (states: number) => capacityErrors(compiled, {states, classes: classCapacity, boundaries: boundaryCapacity})
  const states = stateCapacities.find(candidate => fits(candidate).length === 0)
  if (states === undefined) return {status: 'tooLarge', pattern, messages: fits(Math.max(...stateCapacities)).map(error => error.message)}
  return {compiled, states}
}

function summarize(matchCounts: Float32Array) {
  let matches = 0
  let documentsWithMatches = 0
  for (let index = 0; index < matchCounts.length; index++) {
    matches += matchCounts[index]!
    if (matchCounts[index]! > 0) documentsWithMatches++
  }
  return {matches, documentsWithMatches}
}

// The loop's summary rows, valid, firstErrorPosition, truncated and firstErrorKind, as one typed array per value.
function validationOf(summary: Float32Array, documentCount: number): Validation {
  const columns = stepSummaryNames.length
  const validation = {valid: new Uint8Array(documentCount), firstErrorPosition: new Int16Array(documentCount), firstErrorKind: new Uint8Array(documentCount), truncated: new Uint8Array(documentCount), validCount: 0}
  for (let row = 0; row < documentCount; row++) {
    validation.valid[row] = summary[row * columns]!
    validation.firstErrorPosition[row] = summary[row * columns + 1]!
    validation.truncated[row] = summary[row * columns + 2]!
    validation.firstErrorKind[row] = summary[row * columns + 3]!
    validation.validCount += summary[row * columns]!
  }
  return validation
}

function writeCells(texts: readonly string[], written: Float32Array | undefined) {
  if (written !== undefined) {
    invariant(written.length === texts.length * cellsPerDocument, `the cells of ${texts.length} documents are ${texts.length * cellsPerDocument} numbers, got ${written.length}`)
    return written
  }
  const cells = new Float32Array(texts.length * cellsPerDocument)
  for (let row = 0; row < texts.length; row++) writeDocumentCells(cells, row * cellsPerDocument, texts[row]!)
  return cells
}

// The search program for a state capacity. On the CPU its loops stop at the text's end, which saves the share of the
// 512 positions that hold no text, 40% for documents of 300 code points, and gives the same values: a position past
// the end holds -1, whose class has no steps. On the GPU the loops run every position, since stopping made a search
// slower there with either writer's shader, e.g. 13 ms against 4.4 ms for 100,000 documents at 8 states with
// bit-emit.ts's.
const buildMaskedLoop = (states: number, stopAtLength: boolean) => buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument, masked: true, stopAtLength})

// A loop program's shader, as one of the two writers writes it.
const writeShader = (loop: LoopProgram, writer: ShaderWriter) => writer === 'bit-emit' ? emitBitLoopWgsl(loop) : emitLoopWgsl(loop)

// A pause until a later task, so that a page's thread handles what arrived meanwhile, e.g. a key.
const laterTask = () => new Promise<void>(resolve => {
  setTimeout(resolve, 0)
})

function checkWindow(window: DocumentWindow, documentCount: number, windowCapacity: number) {
  invariant(Number.isInteger(window.firstDocument) && Number.isInteger(window.documentCount) && window.firstDocument >= 0 && window.documentCount >= 0, 'a window is a range of documents')
  invariant(window.firstDocument + window.documentCount <= documentCount && window.documentCount <= windowCapacity, `a window holds at most ${windowCapacity} of the ${documentCount} documents`)
}

type CpuOptions = SearcherOptions & {
  backend?: 'generated' | 'executor'
  // When the highlighter runs. 'atCreation' unless given: on every document when the searcher is created, which takes
  // about 9 s for 100,000 documents as generated JavaScript. With 'whenFirstRead' it runs on a document when a search
  // or `kinds` first reads that document, e.g. for a page that searches a few documents at a time in a worker and shows
  // each piece's answer as it arrives. The highlighter's time is then in no search's timings, and reading `validation`
  // runs the highlighter on every document that it hasn't run on yet.
  highlight?: 'atCreation' | 'whenFirstRead'
}
// One search without the gate, for a self check.
type EvaluateOnCpu = (compiled: CompiledPattern, states: number, request: SearchRequest, patternStarted: number) => SearchResult & {status: 'searched'}

// The same programs on the CPU. `backend` is 'generated' unless given: generated JavaScript of each step, which takes
// e.g. 0.14 ms per search at 8 states for a document of 300 code points in Chrome, so a page gives it hundreds of
// documents, or searches a few documents at a time in a worker, with `documents: 'window'`.
export function createCpuSearcher(texts: readonly string[], options: CpuOptions = {}): Searcher {
  return buildCpuSearcher(texts, options).searcher
}

function buildCpuSearcher(texts: readonly string[], options: CpuOptions): {searcher: Searcher, evaluate: EvaluateOnCpu} {
  const started = performance.now()
  const documentCount = texts.length
  invariant(documentCount >= 1, 'a searcher holds at least one document')
  const stateCapacities = [...(options.stateCapacities ?? defaultStateCapacities)].sort((left, right) => left - right)
  const windowCapacity = options.windowCapacity ?? 64
  const backend = options.backend ?? 'generated'
  const cells = writeCells(texts, options.cells)
  const cellsMs = performance.now() - started
  const json = buildJsonLoop(cellsPerDocument)
  const jsonRunner = createLoopRunner(json.loop, backend)
  const summary = new Float32Array(documentCount * stepSummaryNames.length)
  const kinds = new Float32Array(documentCount * positions)
  // 1 for a document that the highlighter has run on.
  const highlighted = new Uint8Array(documentCount)
  const highlight = (firstDocument: number, count: number) => {
    for (let row = firstDocument; row < firstDocument + count; row++) {
      if (highlighted[row] === 1) continue
      jsonRunner.run([cells], row, [summary, kinds], row, row)
      highlighted[row] = 1
    }
  }
  // What the highlighter says about every document, which runs it on the documents that it hasn't run on yet.
  let validation: Validation | undefined
  const validationOfEveryDocument = () => {
    highlight(0, documentCount)
    validation ??= validationOf(summary, documentCount)
    return validation
  }
  if (options.highlight !== 'whenFirstRead') validationOfEveryDocument()
  const load = {cellsMs, validateMs: performance.now() - started - cellsMs, totalMs: performance.now() - started}
  const searches = new Map<number, {built: SearchLoop, runner: LoopRunner, shared: Float32Array}>()
  const searchFor = (states: number) => {
    let entry = searches.get(states)
    if (entry === undefined) {
      const built = buildMaskedLoop(states, true)
      entry = {built, runner: createLoopRunner(built.loop, backend), shared: new Float32Array(built.loop.sharedValues)}
      searches.set(states, entry)
    }
    return entry
  }
  const gate = createGate()

  const evaluate: EvaluateOnCpu = (compiled, states, request, patternStarted) => {
    const scope = request.scope ?? 'everything'
    const window = request.window ?? {firstDocument: 0, documentCount: 0}
    checkWindow(window, documentCount, windowCapacity)
    const all = request.documents !== 'window'
    const first = all ? 0 : window.firstDocument
    const count = all ? documentCount : window.documentCount
    // The search reads its documents' display kinds. With `highlight: 'whenFirstRead'`, the highlighter runs here on
    // the ones that it hasn't run on yet, and the search's timings leave its time out.
    const highlightStarted = performance.now()
    highlight(first, count)
    const highlightMs = performance.now() - highlightStarted
    const {built, runner, shared} = searchFor(states)
    shared.set(built.loop.sharedValues)
    built.writePattern(shared, compiled)
    built.writeScope(shared, scope)
    runner.setShared(shared)
    const evaluateStarted = performance.now()
    const matchCounts = new Float32Array(count)
    const marks = new Float32Array(window.documentCount * positions)
    for (let index = 0; index < count; index++) {
      const row = first + index
      const windowRow = row >= window.firstDocument && row < window.firstDocument + window.documentCount ? row - window.firstDocument : -1
      runner.run([cells, kinds], row, [matchCounts, marks], index, windowRow)
    }
    const finished = performance.now()
    return {
      status: 'searched', pattern: request.pattern, scope, documents: all ? 'all' : 'window', states, patternStates: compiled.automaton.stateCount,
      matchCounts, ...summarize(matchCounts), window, marks,
      timings: {patternMs: evaluateStarted - patternStarted - highlightMs, evaluateMs: finished - evaluateStarted, totalMs: finished - patternStarted - highlightMs, passMs: undefined},
    }
  }

  const searcher: Searcher = {
    backend: 'cpu', documentCount, stateCapacities, load, limits: undefined,
    get validation() {
      return validationOfEveryDocument()
    },
    programs: () => [
      {name: 'JSON highlighter', operations: describeLoop(json.loop).map(stage => stage.operations), statements: undefined, compileMs: undefined},
      ...[...searches].map(([states, {built}]) => ({name: `regex search, ${states} states`, operations: describeLoop(built.loop).map(stage => stage.operations), statements: undefined, compileMs: undefined})),
    ],
    validate() {
      const validateStarted = performance.now()
      highlighted.fill(0)
      highlight(0, documentCount)
      return Promise.resolve({validation: validationOf(summary, documentCount), evaluateMs: performance.now() - validateStarted, passMs: undefined})
    },
    kinds: window => {
      checkWindow(window, documentCount, documentCount)
      highlight(window.firstDocument, window.documentCount)
      return Promise.resolve(kinds.slice(window.firstDocument * positions, (window.firstDocument + window.documentCount) * positions))
    },
    search(request) {
      const patternStarted = performance.now()
      const resolved = resolvePattern(request.pattern, stateCapacities)
      if ('status' in resolved) {
        gate.supersede()
        return Promise.resolve(resolved)
      }
      return gate.run(() => Promise.resolve(evaluate(resolved.compiled, resolved.states, request, patternStarted)))
    },
    // The other backend here is the CPU executor, the repo's definition of a program's values.
    selfCheck(documents, checks = defaultSelfCheckSearches) {
      const sample = Math.min(documents, documentCount)
      const cpuStarted = performance.now()
      const reference = buildCpuSearcher(texts.slice(0, sample), {stateCapacities, windowCapacity: sample, backend: backend === 'generated' ? 'executor' : 'generated'})
      const result: SelfCheck = {documents: sample, searches: 0, values: 0, mismatches: 0, cpuMs: 0, gpuMs: 0}
      const compare = (actual: ArrayLike<number>, expected: ArrayLike<number>, length: number) => {
        result.values += length
        for (let index = 0; index < length; index++) if (actual[index] !== expected[index]) result.mismatches++
      }
      for (const name of ['valid', 'firstErrorPosition', 'firstErrorKind', 'truncated'] as const) compare(validationOfEveryDocument()[name], reference.searcher.validation[name], sample)
      for (const {pattern, scope} of checks) {
        const resolved = resolvePattern(pattern, stateCapacities)
        if ('status' in resolved) continue
        const window = {firstDocument: 0, documentCount: Math.min(sample, windowCapacity)}
        const counted = evaluate(resolved.compiled, resolved.states, {pattern, scope}, performance.now())
        const marked = evaluate(resolved.compiled, resolved.states, {pattern, scope, window, documents: 'window'}, performance.now())
        const expected = reference.evaluate(resolved.compiled, resolved.states, {pattern, scope, window: {firstDocument: 0, documentCount: sample}}, performance.now())
        result.searches++
        compare(counted.matchCounts, expected.matchCounts, sample)
        compare(marked.marks, expected.marks, window.documentCount * positions)
      }
      result.cpuMs = performance.now() - cpuStarted
      return Promise.resolve(result)
    },
    destroy() {},
  }
  return {searcher, evaluate}
}

// The searcher on the GPU. Creating it writes and uploads every document's cells, validates every document with the
// highlighter's shader, and builds and compiles the search program of every state capacity, so that no search waits
// for a compile. On an Apple M5 Max, creating it for 100,000 documents takes 86 to 93 ms after the cells are written,
// as the medians of five sets of loads of the demo page. The searcher before October 14, 2026, which compiled only
// the smallest program's shader at creation, as loop-emit.ts writes it, took 75 to 86 ms, 3 to 14 ms less in each
// set: the three programs are built and compiled while the GPU compiles the highlighter's shader and runs its pass.
// For 20,000 documents, where that wait is shorter than JavaScript's 50 ms for the three programs, it takes 64 to
// 72 ms where the one before took 26 to 39 ms.
//
// Which writer writes which shader, unless `writers` says otherwise:
// - The search programs' shaders are bit-emit.ts's. One search of 100,000 documents takes 4.6, 4.7 and 5.2 ms at 8, 16
//   and 32 states when searches follow each other, where loop-emit.ts's shaders take 7.8, 69 and 945 ms.
// - The highlighter's shader is loop-emit.ts's. Its step has no gate over several table reads, so bit-emit.ts packs
//   nothing for it, and its pass didn't get faster from bit-emit.ts's shader: 2.3 to 4.5 ms for 100,000 documents
//   against 2.3 to 3.9 ms, in six turns each. In two of the six pairs of turns the two took the same time within
//   0.03 ms, and in four bit-emit.ts's took 0.5 to 0.7 ms longer.
export async function createGpuSearcher(device: GPUDevice, texts: readonly string[], options: SearcherOptions = {}): Promise<Searcher> {
  const started = performance.now()
  const documentCount = texts.length
  invariant(documentCount >= 1, 'a searcher holds at least one document')
  const stateCapacities = [...(options.stateCapacities ?? defaultStateCapacities)].sort((left, right) => left - right)
  const windowCapacity = options.windowCapacity ?? 64
  // Read here, so that the functions below don't keep `options`, and with it the caller's cells, 205 MB for 100,000
  // documents, for as long as the searcher lives.
  const {shaderSalt} = options
  const searchWriter = options.writers?.search ?? 'bit-emit'
  const highlighterWriter = options.writers?.highlighter ?? 'loop-emit'
  const maxDocuments = Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / (cellsPerDocument * 4))
  invariant(documentCount <= maxDocuments, `${documentCount} documents need a buffer of ${bufferBytesFor(documentCount)} bytes, and this device binds ${device.limits.maxStorageBufferBindingSize}. Ask for more with requestBatchDevice(bufferBytesFor(count)), or pass fewer documents.`)
  const cells = writeCells(texts, options.cells)
  const cellsMs = performance.now() - started
  const store = await createDocumentStore(device, cellsPerDocument, documentCount)
  store.write(cells, documentCount)

  // The highlighter, once. Its display kinds stay in the runner's second output buffer, for every document.
  const json = buildJsonLoop(cellsPerDocument)
  const jsonShader = writeShader(json.loop, highlighterWriter)
  const jsonRunnerCreated = createProgramRunner(device, jsonShader, json.loop.sharedValues, store, shaderSalt, {windowCapacity: documentCount})
  // Awaited below, where a failure is thrown. Until then a failure isn't an unhandled one.
  jsonRunnerCreated.catch(() => {})
  // While the GPU compiles the highlighter's shader, JavaScript builds each search program and writes its shader, 7,
  // 12 and 31 ms at 8, 16 and 32 states in Chrome. Building a program and writing its shader are a task each, so
  // that a page's thread handles input in between, and no piece holds it for more than about 20 ms.
  const sources: {states: number, built: SearchLoop, shader: ReturnType<typeof writeShader>}[] = []
  for (const states of stateCapacities) {
    await laterTask()
    const built = buildMaskedLoop(states, false)
    await laterTask()
    sources.push({states, built, shader: writeShader(built.loop, searchWriter)})
  }
  const jsonRunner = await jsonRunnerCreated
  const everyDocument = {firstDocument: 0, documentCount}
  // The pass over every document and the search shaders' compiles, all at the same time. gpu/host.ts's error scopes
  // of the three runners then overlap, so what the GPU refuses for one runner, e.g. a bind group that doesn't fit its
  // shader, may be thrown by another runner's promise. Creating the searcher fails with the GPU's message and its
  // kind of error either way, see `checked` there.
  const [validated, ...runners] = await Promise.all([
    jsonRunner.evaluate({count: documentCount, window: everyDocument, readbacks: [{group: 0, ...everyDocument}]}),
    ...sources.map(({built, shader}) => createProgramRunner(device, shader, built.loop.sharedValues, store, shaderSalt, {inputs: [jsonRunner.outputBuffers[1]!], windowCapacity})),
  ])
  const validation = validationOf(validated.outputs[0]!, documentCount)
  type Search = {built: SearchLoop, runner: ProgramRunner, shared: Float32Array, statements: number}
  const searches = new Map<number, Search>(sources.map(({states, built, shader}, index) => [states, {built, runner: runners[index]!, shared: new Float32Array(built.loop.sharedValues), statements: shader.statementCount}]))
  const searchFor = (states: number) => {
    const search = searches.get(states)
    invariant(search !== undefined, `${states} isn't one of this searcher's state capacities`)
    return search
  }
  const load = {cellsMs, validateMs: performance.now() - started - cellsMs, totalMs: performance.now() - started}
  const gate = createGate()

  async function evaluate(compiled: CompiledPattern, states: number, request: SearchRequest, patternStarted: number): Promise<SearchResult & {status: 'searched'}> {
    const scope = request.scope ?? 'everything'
    const window = request.window ?? {firstDocument: 0, documentCount: 0}
    checkWindow(window, documentCount, windowCapacity)
    const all = request.documents !== 'window'
    const search = searchFor(states)
    search.shared.set(search.built.loop.sharedValues)
    search.built.writePattern(search.shared, compiled)
    search.built.writeScope(search.shared, scope)
    const evaluateStarted = performance.now()
    const first = all ? 0 : window.firstDocument
    const count = all ? documentCount : window.documentCount
    let matchCounts = new Float32Array(0)
    let marks = new Float32Array(0)
    let passMs: number | undefined
    if (count > 0) {
      const evaluation = await search.runner.evaluate({
        count, firstDocument: first, shared: search.shared, window,
        readbacks: [{group: 0, firstDocument: first, documentCount: count}, ...(window.documentCount > 0 ? [{group: 1, firstDocument: 0, documentCount: window.documentCount}] : [])],
        ...(request.timestamps === true && search.runner.hasTimestamps ? {timestamps: true} : {}),
      })
      // Copies, since the runner's arrays are overwritten by the next evaluation, which may start before a page has
      // drawn this result.
      matchCounts = evaluation.outputs[0]!.slice()
      marks = evaluation.outputs[1]?.slice() ?? marks
      passMs = evaluation.passMs
    }
    const finished = performance.now()
    return {
      status: 'searched', pattern: request.pattern, scope, documents: all ? 'all' : 'window', states, patternStates: compiled.automaton.stateCount,
      matchCounts, ...summarize(matchCounts), window, marks,
      timings: {patternMs: evaluateStarted - patternStarted, evaluateMs: finished - evaluateStarted, totalMs: finished - patternStarted, passMs},
    }
  }

  return {
    backend: 'gpu', documentCount, stateCapacities, validation, load,
    limits: {maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize, maxDocuments, hasTimestamps: device.features.has('timestamp-query')},
    programs: () => [
      {name: 'JSON highlighter', operations: describeLoop(json.loop).map(stage => stage.operations), statements: jsonShader.statementCount, compileMs: jsonRunner.compileMs},
      ...[...searches].map(([states, search]) => ({name: `regex search, ${states} states`, operations: describeLoop(search.built.loop).map(stage => stage.operations), statements: search.statements, compileMs: search.runner.compileMs})),
    ],
    async validate({timestamps = false} = {}) {
      const evaluation = await jsonRunner.evaluate({count: documentCount, window: everyDocument, readbacks: [{group: 0, ...everyDocument}], ...(timestamps && jsonRunner.hasTimestamps ? {timestamps: true} : {})})
      return {validation: validationOf(evaluation.outputs[0]!, documentCount), evaluateMs: evaluation.totalMs, passMs: evaluation.passMs}
    },
    kinds: window => {
      checkWindow(window, documentCount, documentCount)
      return window.documentCount === 0 ? Promise.resolve(new Float32Array(0)) : jsonRunner.read({group: 1, ...window})
    },
    search(request) {
      const patternStarted = performance.now()
      const resolved = resolvePattern(request.pattern, stateCapacities)
      if ('status' in resolved) {
        gate.supersede()
        return Promise.resolve(resolved)
      }
      return gate.run(() => evaluate(resolved.compiled, resolved.states, request, patternStarted))
    },
    // Runs when no search is in flight, e.g. right after creating the searcher: it doesn't go through the gate. It
    // checks the highlighter, and each search program with every one of the searches that the program holds.
    async selfCheck(documents, checks = defaultSelfCheckSearches) {
      const sample = Math.min(documents, documentCount)
      const cpuStarted = performance.now()
      const reference = buildCpuSearcher(texts.slice(0, sample), {stateCapacities, windowCapacity: sample})
      const result: SelfCheck = {documents: sample, searches: 0, values: 0, mismatches: 0, cpuMs: performance.now() - cpuStarted, gpuMs: 0}
      const compare = (actual: ArrayLike<number>, expected: ArrayLike<number>, length: number) => {
        result.values += length
        for (let index = 0; index < length; index++) if (actual[index] !== expected[index]) result.mismatches++
      }
      for (const name of ['valid', 'firstErrorPosition', 'firstErrorKind', 'truncated'] as const) compare(validation[name], reference.searcher.validation[name], sample)
      let gpuStarted = performance.now()
      const gpuKinds = await jsonRunner.read({group: 1, firstDocument: 0, documentCount: sample})
      result.gpuMs += performance.now() - gpuStarted
      compare(gpuKinds, await reference.searcher.kinds({firstDocument: 0, documentCount: sample}), sample * positions)
      for (const states of stateCapacities) {
        for (const {pattern, scope} of checks) {
          const resolved = resolvePattern(pattern, [states])
          if ('status' in resolved) continue
          const expectedStarted = performance.now()
          const expected = reference.evaluate(resolved.compiled, states, {pattern, scope, window: {firstDocument: 0, documentCount: sample}}, expectedStarted)
          result.cpuMs += performance.now() - expectedStarted
          result.searches++
          gpuStarted = performance.now()
          // The counts of the sample's documents, then their marks, a window at a time.
          for (let first = 0; first < sample; first += windowCapacity) {
            const window = {firstDocument: first, documentCount: Math.min(windowCapacity, sample - first)}
            const actual = await evaluate(resolved.compiled, states, {pattern, scope, window, documents: 'window'}, performance.now())
            compare(actual.matchCounts, expected.matchCounts.subarray(first), window.documentCount)
            compare(actual.marks, expected.marks.subarray(first * positions), window.documentCount * positions)
          }
          result.gpuMs += performance.now() - gpuStarted
        }
      }
      return result
    },
    destroy() {
      jsonRunner.destroy()
      for (const search of searches.values()) search.runner.destroy()
      store.destroy()
    },
  }
}
