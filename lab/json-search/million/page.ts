// The measurement page of the million-document check. run.ts serves it, opens it in headless Chrome, and writes what it
// posts to /result. One run is one mode at one document count, in its own Chrome process:
//
//   'compact'  hand-written kernels over the documents in compact layouts: the time of one search, back to back and
//              after a pause, with every answer of every timed search compared with a plain JavaScript loop over the
//              same automaton. Also the time to paint a map of the results.
//   'program'  what the demo page runs today: searcher.ts on the documents as one f32 per code point.
//   'load'     the load of a page: workers write the documents and their scope bits, the page uploads them, and a
//              search answers. With the memory of the page and of Chrome's processes afterwards.
//   'js'       regular JavaScript on one thread: RegExp over the whole texts, JSON.parse, a walk over parsed objects,
//              arrays of strings collected once, and the whole-text search in several workers.
//   'scopes'   where the scope bits come from when the highlighter stays the repo's program: its own pass on the GPU, a
//              piece of the documents at a time, between a kernel that unpacks bytes and one that packs display kinds.
//   'writers'  every output of bit-emit.ts's shaders against loop-emit.ts's, for the same loop programs on the same
//              documents: the highlighter's summary and display kinds, character-sets.ts's count and marks, and the
//              search step's match count of every document and mark of every position, without a scope and with each
//              scope.
//
// The documents are the demo page's: documentText(index), every one valid JSON of at most 512 code points.
import {capacityErrors, compilePattern} from '../../regex-search/pattern.ts'
import {bitRowKernel, bitRowTables} from '../bit-rows.ts'
import {mapLayout, paintCells} from '../demo-map.ts'
import {documentText} from '../demo-text.ts'
import {displayKind} from '../../../src/json-highlighter/kinds.ts'
import {emitBitLoopWgsl} from '../bit-emit.ts'
import {type DocumentStore, type ProgramRunner, type RunnableShader, createDocumentStore, createProgramRunner, requestBatchDevice} from '../gpu/host.ts'
import {buildJsonLoop, stepSummaryNames} from '../json-step.ts'
import {compileEmptyPipeline, createReporter, round, sleep, summary} from '../gpu/measure.ts'
import {emitLoopWgsl} from '../loop-emit.ts'
import type {LoopProgram} from '../loop-program.ts'
import {cellsPerDocument, writeDocumentCells} from '../program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from '../search-step.ts'
import {type SearchResult, bufferBytesFor, createGpuSearcher} from '../searcher.ts'
import {highlightWithTables} from '../table-loop.ts'
import {buildCharacterSets, countCharacters} from './character-sets.ts'
import {type DocumentPart, type Engine, checked, compile, createEngine} from './engine.ts'
import {type ExpectedPattern, type Json, collectStrings, createExpected, keyMatches, valueMatches} from './expected.ts'
import {type ByteKernelOptions, type Kernel, byteKernel, cellTables, packKindsKernel, rewriteKernel, unpackCellsKernel} from './kernels.ts'
import {type ScopeName, byteTableLength, byteTables, bytesPerDocument, packFixed, packPacked, packScopeBits, positions, scopeMasks, scopeWordsPerDocument} from './layouts.ts'
import type {FilterAnswer, FilterRequest, HoldRequest, LoadRequest, LoadedPiece} from './worker.ts'

export type PageConfig = {
  mode: 'compact' | 'program' | 'load' | 'js' | 'scopes' | 'writers'
  count: number
  patterns: string[]
  capacities: number[]
  shaderSalt: number
  // How many documents are written, packed and checked at a time.
  pieceDocuments: number
  // 'compact': which engines run, see engineSpecs, and whether the documents also go to the GPU as one f32 per code point.
  engines: string[]
  f32: boolean
  // The pauses before a search, in ms, for every engine, and the longer ones for the engines of `longPauseEngines`.
  pausesMs: number[]
  longPausesMs: number[]
  longPauseEngines: string[]
  pauseSamples: number
  // A rest before each series of searches, in ms, so that a series doesn't start on a GPU that the series before it
  // kept at full load: in the first run of a million documents, the searches of a back to back series got slower one
  // after the other once the run had kept the GPU busy for two minutes.
  restMs: number
  // For the engines of `longPauseEngines`: a pause in which a search of 64 documents runs every `everyMs`, which a page
  // could do while the pattern's field has the focus, so that a keystroke's search doesn't find the GPU at rest.
  warmPauses: {pauseMs: number, everyMs: number}[]
  minimumSamples: number
  sampleMs: number
  // 'load': the layout, how many workers write the documents, whether they also write the scope bits, whether the device
  // is asked for larger buffers than every WebGPU device has, and whether the page keeps the texts.
  layout: 'fixed' | 'packed'
  workers: number
  scopeBits: boolean
  limits: 'needed' | 'default'
  keepTexts: boolean
  // 'js': the flags of every timed RegExp, e.g. '' for /error/ or 'u'. Without a flag is what a programmer writes
  // first, and in Chrome 155 the u flag made a search with a character class 8 to 14% slower.
  regExpFlags: string
  // 'js': how many times each search is timed, and how many workers the whole-text search gets.
  jsSamples: number
  // 'js': with a pause above 0, the whole-text search is also timed after a pause of this many ms, on one thread and in
  // the workers, as a keystroke would find the CPU. A search of more than 1.5 s has no such series.
  jsPauseMs: number
  filterWorkers: number
  // 'js': what is measured. The parsed objects of a million documents may not fit one tab. 'forms' times other plain
  // ways to write the whole-text search, to see that the measured one isn't a slow one.
  jsParts: ('wholeText' | 'forms' | 'parse' | 'walk' | 'collected' | 'workers')[]
}

const GPUBufferUsage = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080} as const
const GPUMapMode = {READ: 0x0001} as const
const {report, post, log} = createReporter()
const config = await (await fetch('/config')).json() as PageConfig
report['config'] = config
const navigationToScriptMs = round(performance.now())

type Memory = {javaScriptBytes: number | undefined, javaScriptBreakdown: unknown, usedHeapBytes: number | undefined, processes: unknown}
const memoryLog: Record<string, Memory> = {}
report['memory'] = memoryLog

// The page's JavaScript memory, by Chrome's performance.measureUserAgentSpecificMemory, which includes the workers,
// and the memory of this run's Chrome processes, which the driver reads with ps and footprint.
async function measureMemory(label: string) {
  type Measured = {bytes: number, breakdown: {bytes: number, types: string[], attribution: {scope: string}[]}[]}
  const measure = (performance as unknown as {measureUserAgentSpecificMemory?: () => Promise<Measured>}).measureUserAgentSpecificMemory
  let measured: Measured | undefined
  if (measure !== undefined) {
    const pending = measure.call(performance).catch(() => undefined)
    // The measurement waits for a garbage collection, which Chrome's --js-flags=--expose-gc lets the page ask for.
    const collect = (globalThis as unknown as {gc?: () => void}).gc
    collect?.()
    measured = await Promise.race([pending, sleep(30_000).then(() => undefined)])
  }
  const usedHeapBytes = (performance as unknown as {memory?: {usedJSHeapSize: number}}).memory?.usedJSHeapSize
  const processes: unknown = await (await fetch('/memory')).json()
  const entry: Memory = {
    javaScriptBytes: measured?.bytes,
    javaScriptBreakdown: measured?.breakdown.filter(part => part.bytes > 1e6).map(part => ({megabytes: Math.round(part.bytes / 1e6), types: part.types, scopes: part.attribution.map(attribution => attribution.scope)})),
    usedHeapBytes, processes,
  }
  memoryLog[label] = entry
  log(`memory, ${label}: ${JSON.stringify(entry)}`)
  return entry
}

const loadAverage = async () => (await (await fetch('/load')).json() as {load: number}).load

function watchDevice(device: GPUDevice) {
  void device.lost.then(info => {
    report['deviceLost'] = `${info.reason}: ${info.message}`
    void post(true)
  })
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
    log(`uncaptured GPU error: ${event.error.message}`)
  })
}

const textsOf = (firstDocument: number, documentCount: number) => Array.from({length: documentCount}, (_, index) => documentText(firstDocument + index))

// ----------------------------------------------------------------------------------------------------------------
// 'compact'

type Timed = {patternMs: number, totalMs: number, submitMs: number, waitMs: number, copyMs: number, passMs: number | undefined, gapMs: number}
const summarizeTimed = (records: readonly Timed[]) => ({
  // JavaScript before the upload: compiling the pattern and writing its tables.
  patternMs: summary(records.map(record => record.patternMs)),
  submitMs: summary(records.map(record => record.submitMs)),
  waitMs: summary(records.map(record => record.waitMs)),
  copyMs: summary(records.map(record => record.copyMs)),
  // From before JavaScript compiles the pattern until the results are in a JavaScript array.
  totalMs: summary(records.map(record => record.totalMs)),
  passMs: summary(records.map(record => record.passMs)),
  // From the end of the previous search to the start of this one: the comparison with the expected values, and in a
  // series with pauses the pause.
  gapMs: summary(records.map(record => record.gapMs)),
  totals: records.map(record => round(record.totalMs)),
})

// One engine of the 'compact' mode: what runs on the GPU, the scopes it is timed with, and its tables for a pattern.
type EngineSpec = {
  name: string
  what: string
  needs: 'bytes' | 'packed' | 'f32'
  scopes: readonly ScopeName[]
  // How many states the engine is made for, when not for every capacity.
  onlyStates?: number[]
  create: (states: number) => Promise<{
    compileMs: number
    output: 'counts' | 'bits' | 'floats'
    search: (options: {count: number, pattern: ExpectedPattern, scope: ScopeName, timestamps: boolean}) => Promise<Timed & {values: Uint32Array | Float32Array}>
    destroy: () => void
  }>
}

async function runCompact() {
  const {count} = config
  const pieceDocuments = Math.min(count, config.pieceDocuments)
  const fixedBytes = count * bytesPerDocument
  const f32Bytes = count * cellsPerDocument * 4
  const granted = await requestBatchDevice(config.f32 ? f32Bytes : fixedBytes)
  const {device} = granted
  watchDevice(device)
  report['adapter'] = {info: granted.adapterInfo, limits: granted.adapterLimits, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(device, config.shaderSalt))
  const storage = (bytes: number) => checked(device, () => device.createBuffer({size: Math.max(4, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC}))
  const fixed = await storage(fixedBytes)
  const scopes = await storage(count * scopeWordsPerDocument * 4)
  let f32: GPUBuffer | undefined
  if (config.f32) {
    try {
      f32 = await storage(f32Bytes)
    } catch (error) {
      report['f32Error'] = String(error)
      log(`the buffer of one f32 per code point, ${f32Bytes} bytes, wasn't created: ${String(error)}`)
    }
  }

  // The documents, a piece at a time: the texts, their bytes, their scope bits, and what every search is compared with.
  const expected = createExpected(config.patterns, config.capacities, count)
  const prepare = {generateMs: 0, fixedMs: 0, packedMs: 0, highlightMs: 0, scopeBitsMs: 0, cellsMs: 0, expectedMs: 0, characters: 0, longestCodePoints: 0, documentsPast512: 0}
  const packedPieces: {bytes: Uint8Array<ArrayBuffer>, starts: Uint32Array<ArrayBuffer>}[] = []
  let packedWords = 0
  const kinds = new Uint8Array(pieceDocuments * positions)
  const cells = f32 === undefined ? undefined : new Float32Array(pieceDocuments * cellsPerDocument)
  for (let first = 0; first < count; first += pieceDocuments) {
    const documents = Math.min(pieceDocuments, count - first)
    let started = performance.now()
    const texts = textsOf(first, documents)
    prepare.generateMs += performance.now() - started
    for (const text of texts) {
      prepare.characters += text.length
      const codePoints = Array.from(text).length
      prepare.longestCodePoints = Math.max(prepare.longestCodePoints, codePoints)
      if (codePoints > positions) prepare.documentsPast512++
    }
    started = performance.now()
    const bytes = packFixed(texts)
    prepare.fixedMs += performance.now() - started
    device.queue.writeBuffer(fixed, first * bytesPerDocument, bytes)
    started = performance.now()
    const packed = packPacked(texts, packedWords)
    prepare.packedMs += performance.now() - started
    packedPieces.push(packed)
    packedWords += packed.words
    started = performance.now()
    for (let row = 0; row < documents; row++) highlightWithTables(texts[row]!, kinds, row * positions)
    prepare.highlightMs += performance.now() - started
    started = performance.now()
    const scopeWords = new Uint32Array(documents * scopeWordsPerDocument)
    packScopeBits(kinds, documents, scopeWords)
    prepare.scopeBitsMs += performance.now() - started
    device.queue.writeBuffer(scopes, first * scopeWordsPerDocument * 4, scopeWords)
    if (f32 !== undefined && cells !== undefined) {
      started = performance.now()
      for (let row = 0; row < documents; row++) writeDocumentCells(cells, row * cellsPerDocument, texts[row]!)
      prepare.cellsMs += performance.now() - started
      device.queue.writeBuffer(f32, first * cellsPerDocument * 4, cells, 0, documents * cellsPerDocument)
    }
    started = performance.now()
    expected.add(first, texts, kinds, true)
    prepare.expectedMs += performance.now() - started
    await device.queue.onSubmittedWorkDone()
    log(`${first + documents} documents written and their expected answers computed`)
  }
  const packedBuffer = await storage(packedWords * 4)
  const startsBuffer = await storage((count + 1) * 4)
  let packedAt = 0
  packedPieces.forEach((piece, index) => {
    device.queue.writeBuffer(packedBuffer, packedAt, piece.bytes)
    // The last entry of a piece is the first entry of the next one.
    device.queue.writeBuffer(startsBuffer, index * pieceDocuments * 4, piece.starts)
    packedAt += piece.bytes.length
  })
  packedPieces.length = 0
  await device.queue.onSubmittedWorkDone()
  report['prepare'] = Object.fromEntries(Object.entries(prepare).map(([name, value]) => [name, round(value)]))
  report['buffers'] = {fixedBytes: fixed.size, scopeBytes: scopes.size, packedBytes: packedBuffer.size, startsBytes: startsBuffer.size, f32Bytes: f32?.size ?? 0}
  report['patterns'] = expected.describe()
  log(`patterns: ${JSON.stringify(expected.describe())}`)
  await post(false)

  const parts: DocumentPart[] = [{buffer: fixed, firstDocument: 0, documentCount: count}]
  const packedParts: DocumentPart[] = [{buffer: packedBuffer, firstDocument: 0, documentCount: count}]
  // The same documents as four parts of at most 262,144 documents, 128 MiB, the size every WebGPU device binds.
  const partDocuments = 262_144
  const splitParts: DocumentPart[] = []
  if (config.engines.includes('bytes-split')) {
    for (let first = 0; first < count; first += partDocuments) {
      const documents = Math.min(partDocuments, count - first)
      const buffer = await checked(device, () => device.createBuffer({size: documents * bytesPerDocument, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}))
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(fixed, first * bytesPerDocument, buffer, 0, documents * bytesPerDocument)
      device.queue.submit([encoder.finish()])
      splitParts.push({buffer, firstDocument: first, documentCount: documents})
    }
    await device.queue.onSubmittedWorkDone()
  }

  const timed = (started: number, patternMs: number, timing: {totalMs: number, submitMs: number, waitMs: number, copyMs: number, passMs: number | undefined}): Omit<Timed, 'gapMs'> =>
    ({patternMs, totalMs: performance.now() - started, submitMs: timing.submitMs, waitMs: timing.waitMs, copyMs: timing.copyMs, passMs: timing.passMs})
  const byteEngine = (name: string, what: string, options: Omit<ByteKernelOptions, 'states'>, scopeList: readonly ScopeName[], more: {packBits?: boolean, split?: boolean} = {}): EngineSpec => ({
    name, what, needs: options.layout === 'packed' ? 'packed' : 'bytes', scopes: scopeList,
    async create(states) {
      const kernel = byteKernel({...options, states})
      const engine: Engine = await createEngine(device, withSalt(kernel), {
        parts: options.layout === 'packed' ? packedParts : more.split === true ? splitParts : parts,
        ...(options.layout === 'packed' ? {starts: startsBuffer} : {}), ...(options.scope ? {scopes} : {}),
      }, byteTableLength(states), count, {packBits: more.packBits === true})
      return {
        compileMs: engine.compileMs, output: engine.output,
        async search({count: documents, pattern, scope, timestamps}) {
          const started = performance.now()
          const tables = byteTables(bitRowTables(compilePattern(pattern.pattern), states))
          const patternMs = performance.now() - started
          const result = await engine.search({count: documents, tables, scopeMask: scopeMasks[scope], timestamps})
          return {...timed(started, patternMs, result), gapMs: 0, values: result.values}
        },
        destroy: () => engine.destroy(),
      }
    },
  })
  const f32Engine = (name: string, what: string, kernelFor: (states: number) => Kernel & {tableLength: number}, tablesFor: (tables: Uint32Array<ArrayBuffer>, states: number) => Uint32Array<ArrayBuffer>, output: 'counts' | 'floats'): EngineSpec => ({
    name, what, needs: 'f32', scopes: ['everything'],
    async create(states) {
      const kernel = kernelFor(states)
      const engine = await createEngine(device, withSalt(kernel), {parts: [{buffer: f32!, firstDocument: 0, documentCount: count}]}, kernel.tableLength, count)
      const floats = new Float32Array(count)
      return {
        compileMs: engine.compileMs, output,
        async search({count: documents, pattern, timestamps}) {
          const started = performance.now()
          const tables = tablesFor(bitRowTables(compilePattern(pattern.pattern), states).tables, states)
          const patternMs = performance.now() - started
          const result = await engine.search({count: documents, tables, timestamps})
          if (output === 'floats') floats.set(new Float32Array(result.values.buffer, 0, documents))
          return {...timed(started, patternMs, result), gapMs: 0, values: output === 'floats' ? floats : result.values}
        },
        destroy: () => engine.destroy(),
      }
    },
  })
  const everything = ['everything'] as const
  // The repo's own search step (search-step.ts) over the f32 documents, as one of the two writers writes it. With a
  // scope, the step also reads every code point's display kind, which the highlighter's own pass writes once.
  const store: DocumentStore | undefined = f32 === undefined ? undefined : {buffer: f32, capacity: count, cellsPerDocument, write: () => {}, destroy: () => {}}
  let highlighter: ProgramRunner | undefined
  const kindsBuffer = async () => {
    if (highlighter === undefined) {
      const json = buildJsonLoop(cellsPerDocument)
      highlighter = await createProgramRunner(device, emitLoopWgsl(json.loop), json.loop.sharedValues, store!, config.shaderSalt, {windowCapacity: count})
      await highlighter.evaluate({count, window: {firstDocument: 0, documentCount: count}, readbacks: []})
    }
    return highlighter.outputBuffers[1]!
  }
  const stepEngine = (name: string, what: string, emit: (loop: LoopProgram) => RunnableShader, masked: boolean): EngineSpec => ({
    name, what, needs: 'f32', scopes: masked ? ['everything', 'strings', 'keys'] : everything,
    async create(states) {
      const built = buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions, cellsPerDocument, masked, stopAtLength: false})
      const runner = await createProgramRunner(device, emit(built.loop), built.loop.sharedValues, store!, config.shaderSalt, {windowCapacity: 1, ...(masked ? {inputs: [await kindsBuffer()]} : {})})
      const shared = new Float32Array(built.loop.sharedValues.length)
      return {
        compileMs: runner.compileMs, output: 'floats',
        async search({count: documents, pattern, scope, timestamps}) {
          const started = performance.now()
          shared.set(built.loop.sharedValues)
          built.writePattern(shared, compilePattern(pattern.pattern))
          if (masked) built.writeScope(shared, scope)
          const patternMs = performance.now() - started
          const evaluation = await runner.evaluate({count: documents, shared, readbacks: [{group: 0, firstDocument: 0, documentCount: documents}], timestamps})
          return {patternMs, totalMs: performance.now() - started, submitMs: evaluation.uploadMs + evaluation.encodeAndSubmitMs, waitMs: evaluation.waitMs, copyMs: evaluation.copyMs, passMs: evaluation.passMs, gapMs: 0, values: evaluation.outputs[0]!}
        },
        destroy: () => runner.destroy(),
      }
    },
  })
  const engineSpecs: EngineSpec[] = [
    f32Engine('f32-kernel', 'bit-rows.ts\'s kernel as it is, on one f32 per code point', states => {
      const kernel = bitRowKernel(states, positions, cellsPerDocument)
      return {code: kernel.code, workgroupSize: kernel.workgroupSize, bindings: ['params', 'tables', 'documents', 'results'], output: 'count', tableLength: kernel.tableLength}
    }, tables => tables, 'floats'),
    byteEngine('bytes-boundaries', 'the same kernel on 512 bytes per document, the class of a byte from 32 comparisons', {layout: 'fixed', classes: 'boundaries', scope: false, output: 'count'}, everything),
    byteEngine('bytes', 'the same with the class of a byte from one table read', {layout: 'fixed', classes: 'table', scope: false, output: 'count'}, everything),
    byteEngine('bytes-scope', 'the same with 2 scope bits per character', {layout: 'fixed', classes: 'table', scope: true, output: 'count'}, ['everything', 'keys', 'strings']),
    byteEngine('packed', 'the documents one after the other, each loop over its own document\'s words', {layout: 'packed', classes: 'table', scope: false, output: 'count'}, everything),
    byteEngine('packed-scope', 'packed, with 2 scope bits per character', {layout: 'packed', classes: 'table', scope: true, output: 'count'}, ['strings']),
    byteEngine('bytes-bits', 'the counts, then a second pass that packs them into one bit per document', {layout: 'fixed', classes: 'table', scope: false, output: 'count'}, everything, {packBits: true}),
    byteEngine('bytes-has', 'the reverse pass alone, one bit per document', {layout: 'fixed', classes: 'table', scope: false, output: 'has'}, everything),
    byteEngine('bytes-scope-has', 'the reverse pass alone with scope bits, one bit per document', {layout: 'fixed', classes: 'table', scope: true, output: 'has'}, ['everything', 'keys', 'strings']),
    byteEngine('packed-scope-has', 'packed, the reverse pass alone with scope bits, one bit per document', {layout: 'packed', classes: 'table', scope: true, output: 'has'}, ['everything', 'strings']),
    byteEngine('bytes-split', 'the counts, from four buffers of at most 128 MiB', {layout: 'fixed', classes: 'table', scope: false, output: 'count'}, everything, {split: true}),
    f32Engine('rewrite-1', 'the program\'s step with every 0-or-1 value as a bit, one table read per pair of states', states => rewriteKernel(states, 1, cellsPerDocument), cellTables, 'counts'),
    f32Engine('rewrite-2', 'the same with the reads of one sum as one word', states => rewriteKernel(states, 2, cellsPerDocument), tables => tables, 'counts'),
    stepEngine('program-step', 'the program\'s own step as loop-emit.ts writes it, without a scope', emitLoopWgsl, false),
    stepEngine('program-bits', 'the same step as bit-emit.ts writes it', emitBitLoopWgsl, false),
    stepEngine('program-step-masked', 'the program\'s step with a scope, which the demo page runs, as loop-emit.ts writes it', emitLoopWgsl, true),
    stepEngine('program-bits-masked', 'the same step with a scope as bit-emit.ts writes it', emitBitLoopWgsl, true),
  ]
  // A salt goes into every kernel's source, so that it compiles without hitting a shader cache.
  function withSalt<Shader extends {code: string}>(kernel: Shader): Shader {
    return {...kernel, code: kernel.code.replace('fn main(@builtin(global_invocation_id) id: vec3<u32>) {', `fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n  let salt: u32 = ${config.shaderSalt}u;\n  _ = salt;`)}
  }

  const results: Record<string, unknown>[] = []
  report['results'] = results
  // The last counts and bits of two different patterns, for the map.
  const kept: {counts: Uint32Array[], bits: Uint32Array[]} = {counts: [], bits: []}
  for (const states of config.capacities) {
    const fitting = expected.entries.filter(entry => capacityErrors(entry.compiled, {states, classes: classCapacity, boundaries: boundaryCapacity}).length === 0)
    for (const spec of engineSpecs) {
      if (!config.engines.includes(spec.name) || (spec.needs === 'f32' && f32 === undefined)) continue
      const entry: Record<string, unknown> = {states, engine: spec.name, what: spec.what, patterns: fitting.map(pattern => pattern.pattern)}
      results.push(entry)
      let created: Awaited<ReturnType<EngineSpec['create']>>
      try {
        created = await spec.create(states)
      } catch (error) {
        entry['error'] = String(error)
        log(`${states} states, ${spec.name}: ${String(error)}`)
        continue
      }
      entry['compileMs'] = round(created.compileMs)
      const checks = {searches: 0, values: 0, mismatches: 0}
      let turn = 0
      let previousEnd = performance.now()
      const searchOnce = async (scope: ScopeName, options: {timestamps?: boolean, gapStart?: number}): Promise<Timed> => {
        const pattern = fitting[turn++ % fitting.length]!
        const gapMs = performance.now() - (options.gapStart ?? previousEnd)
        const {values, ...record} = await created.search({count, pattern, scope, timestamps: options.timestamps === true})
        previousEnd = performance.now()
        checks.searches++
        checks.values += count
        if (created.output === 'bits') {
          const bits = pattern.bits[scope]
          for (let word = 0; word < bits.length; word++) if (values[word] !== bits[word]) checks.mismatches += count32(values[word]! ^ bits[word]!)
        } else {
          const counts = pattern.counts[scope]
          for (let index = 0; index < count; index++) if (values[index] !== counts[index]) checks.mismatches++
        }
        return {...record, gapMs}
      }
      const byScope: Record<string, unknown>[] = []
      entry['scopes'] = byScope
      for (const scope of spec.scopes) {
        const first = await searchOnce(scope, {})
        const result: Record<string, unknown> = {scope, at: new Date().toISOString(), load: await loadAverage(), firstSearchMs: round(first.totalMs)}
        await sleep(config.restMs)
        result['backToBack'] = summarizeTimed(await sampleSearches(() => searchOnce(scope, {})))
        await sleep(config.restMs)
        if (granted.hasTimestamps) result['withTimestamps'] = summarizeTimed(await sampleSearches(() => searchOnce(scope, {timestamps: true}), 9))
        const pauses: Record<string, unknown>[] = []
        // A search that takes seconds isn't slowed by a pause in a way that can be seen, so it gets no pause series.
        const slow = (result['backToBack'] as ReturnType<typeof summarizeTimed>).totalMs!.median > 1500
        for (const pause of slow ? [] : [...config.pausesMs, ...(config.longPauseEngines.includes(spec.name) ? config.longPausesMs : [])]) {
          const records: Timed[] = []
          for (let index = 0; index < config.pauseSamples; index++) {
            const gapStart = performance.now()
            await sleep(pause)
            records.push(await searchOnce(scope, {gapStart}))
          }
          pauses.push({pauseMs: pause, ...summarizeTimed(records)})
        }
        for (const {pauseMs, everyMs} of slow || !config.longPauseEngines.includes(spec.name) ? [] : config.warmPauses) {
          const records: Timed[] = []
          for (let index = 0; index < config.pauseSamples; index++) {
            const gapStart = performance.now()
            while (performance.now() - gapStart < pauseMs) {
              await sleep(everyMs)
              await created.search({count: Math.min(64, count), pattern: fitting[0]!, scope, timestamps: false})
            }
            records.push(await searchOnce(scope, {gapStart}))
          }
          pauses.push({pauseMs, everyMs, ...summarizeTimed(records)})
        }
        result['afterPause'] = pauses
        result['loadAfter'] = await loadAverage()
        byScope.push(result)
        const backToBack = result['backToBack'] as ReturnType<typeof summarizeTimed>
        log(`${states} states, ${spec.name}, ${scope}, ${count} documents: back to back ${backToBack.totalMs?.median} ms, pass ${(result['withTimestamps'] as ReturnType<typeof summarizeTimed> | undefined)?.passMs?.median} ms, after a pause ${pauses.map(pause => `${String(pause['pauseMs'])} ms${typeof pause['everyMs'] === 'number' ? `, busy every ${pause['everyMs']} ms` : ''}: ${(pause as ReturnType<typeof summarizeTimed>).totalMs?.median}`).join(', ')}, checks so far ${JSON.stringify(checks)}`)
      }
      entry['checks'] = checks
      // Two searches' results for the map, of the first two patterns.
      if (states === config.capacities[0] && (spec.name === 'bytes' || spec.name === 'bytes-has')) {
        for (let index = 0; index < 2; index++) {
          turn = index
          const {values} = await created.search({count, pattern: fitting[index % fitting.length]!, scope: 'everything', timestamps: false})
          kept[spec.name === 'bytes' ? 'counts' : 'bits'].push(new Uint32Array(values))
        }
      }
      created.destroy()
      await post(false)
    }
  }
  if (kept.counts.length === 2 && kept.bits.length === 2) report['paint'] = await measurePaint(count, kept.counts, kept.bits)
  await measureMemory('after the searches, with every layout\'s buffers')
  highlighter?.destroy()
  for (const buffer of [fixed, scopes, packedBuffer, startsBuffer, f32, ...splitParts.map(part => part.buffer)]) buffer?.destroy()
}

function count32(value: number) {
  let bits = value >>> 0
  let total = 0
  while (bits !== 0) {
    bits &= bits - 1
    total++
  }
  return total
}

// Warms up with at least 3 searches and 200 ms, then samples until `minimum` samples and config.sampleMs have passed.
// A search that takes longer than 300 ms is sampled 9 times.
async function sampleSearches(searchOnce: () => Promise<Timed>, minimum = config.minimumSamples) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 && (warm < 1 || performance.now() - warmStarted < 4000) || performance.now() - warmStarted < 200; warm++) await searchOnce()
  const samples: Timed[] = []
  const started = performance.now()
  while (samples.length < 100) {
    const elapsed = performance.now() - started
    if (samples.length >= minimum && elapsed >= config.sampleMs) break
    if (samples.length >= 9 && elapsed >= 3000) break
    samples.push(await searchOnce())
  }
  return samples
}

// ----------------------------------------------------------------------------------------------------------------
// The map: one cell per document, painted from one search's results.

const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))

async function measurePaint(count: number, counts: readonly Uint32Array[], bits: readonly Uint32Array[]) {
  const match = 0xff3c6fc8
  const plain = 0xffe8e2d8
  const side = Math.ceil(Math.sqrt(count))
  const results: Record<string, unknown> = {side}
  const time = async (name: string, width: number, height: number, fill: (pixels: Uint32Array, turn: number) => void) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.style.cssText = `display: block; width: ${Math.min(width, 1000)}px; height: ${Math.round(Math.min(width, 1000) * height / width)}px`
    document.body.append(canvas)
    const context = canvas.getContext('2d')!
    const image = context.createImageData(width, height)
    const pixels = new Uint32Array(image.data.buffer)
    const records: {fillMs: number, putMs: number, toSecondFrameMs: number}[] = []
    for (let turn = 0; turn < 14; turn++) {
      await nextFrame()
      const started = performance.now()
      fill(pixels, turn)
      const filled = performance.now()
      context.putImageData(image, 0, 0)
      const put = performance.now()
      await nextFrame()
      await nextFrame()
      // The first 3 turns warm the loop up.
      if (turn >= 3) records.push({fillMs: filled - started, putMs: put - filled, toSecondFrameMs: performance.now() - started})
    }
    canvas.remove()
    results[name] = {
      width, height, samples: records.length,
      fillMs: summary(records.map(record => record.fillMs)), putImageDataMs: summary(records.map(record => record.putMs)),
      fillAndPutMs: summary(records.map(record => record.fillMs + record.putMs)), toSecondFrameMs: summary(records.map(record => record.toSecondFrameMs)),
    }
  }
  await time('one pixel per document, from counts', side, side, (pixels, turn) => {
    const values = counts[turn % 2]!
    for (let index = 0; index < count; index++) pixels[index] = values[index]! > 0 ? match : plain
  })
  await time('one pixel per document, from bits', side, side, (pixels, turn) => {
    const words = bits[turn % 2]!
    for (let index = 0; index < count; index++) pixels[index] = (words[index >> 5]! >>> (index & 31)) & 1 ? match : plain
  })
  await time('2 by 2 pixels per document, from bits', side * 2, side * 2, (pixels, turn) => {
    const words = bits[turn % 2]!
    const width = side * 2
    for (let index = 0, column = 0, row = 0; index < count; index++) {
      const color = (words[index >> 5]! >>> (index & 31)) & 1 ? match : plain
      const offset = row * 2 * width + column * 2
      pixels[offset] = color
      pixels[offset + 1] = color
      pixels[offset + width] = color
      pixels[offset + width + 1] = color
      if (++column === side) {
        column = 0
        row++
      }
    }
  })
  // The demo page's own map, which leaves a gap between cells: at one device pixel per CSS px and 1,000 CSS px of width.
  const layout = mapLayout(1000, 1, count)
  const floats = counts.map(values => Float32Array.from(values))
  await time('the demo page\'s paintCells, with its gaps', layout.width, layout.height, (pixels, turn) => {
    paintCells(pixels, layout, count, count, floats[turn % 2]!, {match, plain, waiting: plain}, plain)
  })
  results['demoLayout'] = layout
  // What JavaScript does with the results besides painting: how many documents have a match.
  const countTimes: number[] = []
  const bitTimes: number[] = []
  let sink = 0
  for (let turn = 0; turn < 20; turn++) {
    let started = performance.now()
    const values = counts[turn % 2]!
    let withMatch = 0
    for (let index = 0; index < count; index++) if (values[index]! > 0) withMatch++
    if (turn >= 5) countTimes.push(performance.now() - started)
    started = performance.now()
    const words = bits[turn % 2]!
    let fromBits = 0
    for (let word = 0; word < words.length; word++) fromBits += count32(words[word]!)
    if (turn >= 5) bitTimes.push(performance.now() - started)
    sink += withMatch - fromBits
  }
  results['documentsWithMatchFromCountsMs'] = summary(countTimes)
  results['documentsWithMatchFromBitsMs'] = summary(bitTimes)
  results['countsAndBitsAgree'] = sink === 0
  return results
}

// ----------------------------------------------------------------------------------------------------------------
// 'program': searcher.ts, as the demo page uses it.

async function runProgram() {
  const {count} = config
  let started = performance.now()
  const texts = textsOf(0, count)
  const generateMs = performance.now() - started
  log(`${count} documents written in ${round(generateMs)} ms`)
  await measureMemory('the texts in the page')
  const granted = await requestBatchDevice(bufferBytesFor(count))
  watchDevice(granted.device)
  report['adapter'] = {info: granted.adapterInfo, limits: granted.adapterLimits, hasTimestamps: granted.hasTimestamps, grantedBufferBytes: granted.largestBufferBytes}
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(granted.device, config.shaderSalt))
  started = performance.now()
  const searcher = await createGpuSearcher(granted.device, texts, {shaderSalt: config.shaderSalt})
  report['searcher'] = {
    generateMs: round(generateMs), createMs: round(performance.now() - started), load: searcher.load, limits: searcher.limits, validCount: searcher.validation.validCount,
    // The store of cells, the highlighter's display kinds, and its summary of 4 values per document.
    bufferBytes: {cells: bufferBytesFor(count), kinds: count * positions * 4, summary: count * 16, matchCounts: count * 4},
  }
  log(`searcher: ${JSON.stringify(report['searcher'])}`)
  await post(false)
  await measureMemory('after creating the searcher')

  // The expected answers of every document, from the plain loop with the table loop's kinds as the mask.
  const pieceDocuments = Math.min(count, config.pieceDocuments)
  const expected = createExpected(config.patterns, config.capacities, count)
  const kinds = new Uint8Array(pieceDocuments * positions)
  for (let first = 0; first < count; first += pieceDocuments) {
    const documents = Math.min(pieceDocuments, count - first)
    const piece = texts.slice(first, first + documents)
    for (let row = 0; row < documents; row++) highlightWithTables(piece[row]!, kinds, row * positions)
    expected.add(first, piece, kinds, false)
    log(`the expected answers of ${first + documents} documents computed`)
  }
  report['patterns'] = expected.describe()

  const results: Record<string, unknown>[] = []
  report['results'] = results
  for (const states of config.capacities) {
    const fitting = expected.entries.filter(entry => entry.capacity === states)
    if (fitting.length === 0) continue
    const prepareMs = await searcher.prepare(states)
    for (const scope of states === config.capacities[0] ? ['everything', 'strings', 'keys'] as const : ['everything'] as const) {
      const checks = {searches: 0, values: 0, mismatches: 0}
      let turn = 0
      let previousEnd = performance.now()
      const searchOnce = async (options: {timestamps?: boolean, gapStart?: number}): Promise<Timed> => {
        const pattern = fitting[turn++ % fitting.length]!
        const gapMs = performance.now() - (options.gapStart ?? previousEnd)
        const result = await searcher.search({pattern: pattern.pattern, scope, timestamps: options.timestamps === true}) as SearchResult & {status: 'searched'}
        previousEnd = performance.now()
        checks.searches++
        checks.values += count
        const counts = pattern.counts[scope]
        for (let index = 0; index < count; index++) if (result.matchCounts[index] !== counts[index]) checks.mismatches++
        // totalMs is what the demo page's line shows.
        return {patternMs: result.timings.patternMs, totalMs: result.timings.totalMs, submitMs: 0, waitMs: result.timings.evaluateMs, copyMs: 0, passMs: result.timings.passMs, gapMs}
      }
      const first = await searchOnce({})
      const entry: Record<string, unknown> = {states, engine: 'searcher', what: 'searcher.ts on one f32 per code point, what the demo page runs today', scope, patterns: fitting.map(pattern => pattern.pattern), prepareMs: round(prepareMs), at: new Date().toISOString(), load: await loadAverage(), firstSearchMs: round(first.totalMs)}
      results.push(entry)
      entry['backToBack'] = summarizeTimed(await sampleSearches(() => searchOnce({}), 9))
      const slow = (entry['backToBack'] as ReturnType<typeof summarizeTimed>).totalMs!.median > 1500
      if (granted.hasTimestamps && !slow) entry['withTimestamps'] = summarizeTimed(await sampleSearches(() => searchOnce({timestamps: true}), 9))
      const pauses: Record<string, unknown>[] = []
      for (const pause of slow ? [] : [...config.pausesMs, ...config.longPausesMs]) {
        const records: Timed[] = []
        for (let index = 0; index < config.pauseSamples; index++) {
          const gapStart = performance.now()
          await sleep(pause)
          records.push(await searchOnce({gapStart}))
        }
        pauses.push({pauseMs: pause, ...summarizeTimed(records)})
      }
      entry['afterPause'] = pauses
      entry['checks'] = checks
      entry['loadAfter'] = await loadAverage()
      log(`${states} states, searcher, ${scope}, ${count} documents: back to back ${(entry['backToBack'] as ReturnType<typeof summarizeTimed>).totalMs?.median} ms, after a pause ${pauses.map(pause => `${String(pause['pauseMs'])} ms: ${(pause as ReturnType<typeof summarizeTimed>).totalMs?.median}`).join(', ')}, checks ${JSON.stringify(checks)}`)
      await post(false)
    }
  }
  report['programs'] = searcher.programs()
  await measureMemory('after the searches')
  searcher.destroy()
}

// ----------------------------------------------------------------------------------------------------------------
// 'load': the load of a page, with the work where a page would put it.

async function runLoad() {
  const {count, layout} = config
  const timeline: Record<string, number> = {navigationToScriptMs}
  report['timeline'] = timeline
  const mark = (name: string) => {
    timeline[name] = round(performance.now())
  }
  // The workers start first, so that they write documents while the page asks for its device.
  const pieceDocuments = Math.min(count, config.pieceDocuments)
  const pieceCount = Math.ceil(count / pieceDocuments)
  const workers = Array.from({length: Math.min(config.workers, pieceCount)}, () => new Worker('/million-worker.js', {type: 'module'}))
  const arrived: (LoadedPiece | undefined)[] = Array.from({length: pieceCount}, () => undefined)
  const arrivals: number[] = []
  const workerMs = {generate: 0, pack: 0, highlight: 0}
  let wake = () => {}
  workers.forEach((worker, workerIndex) => {
    const pieces = Array.from({length: pieceCount}, (_, piece) => piece).filter(piece => piece % workers.length === workerIndex)
      .map(piece => ({firstDocument: piece * pieceDocuments, documentCount: Math.min(pieceDocuments, count - piece * pieceDocuments)}))
    worker.addEventListener('message', event => {
      const message = event.data as LoadedPiece | {kind: 'loaded'}
      if (message.kind !== 'piece') return
      arrived[message.firstDocument / pieceDocuments] = message
      arrivals.push(round(performance.now()))
      workerMs.generate += message.generateMs
      workerMs.pack += message.packMs
      workerMs.highlight += message.highlightMs
      wake()
    })
    worker.addEventListener('error', event => {
      report['workerError'] = event.message
      void post(true)
    })
    const request: LoadRequest = {kind: 'load', pieces, layout, scopeBits: config.scopeBits}
    worker.postMessage(request)
  })
  mark('workersStartedMs')

  // The device. With 'default' limits, the documents go into buffers of at most 128 MiB, which every device binds.
  const defaultBinding = 134_217_728
  let device: GPUDevice
  if (config.limits === 'default') {
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})
    if (adapter === null) throw new Error('this browser has no WebGPU adapter')
    device = await adapter.requestDevice()
  } else {
    device = (await requestBatchDevice(count * bytesPerDocument)).device
  }
  watchDevice(device)
  report['deviceLimits'] = {maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize, maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage}
  mark('deviceMs')
  const storage = (bytes: number) => checked(device, () => device.createBuffer({size: Math.max(4, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}))
  const partDocuments = config.limits === 'default' ? Math.floor(defaultBinding / bytesPerDocument / pieceDocuments) * pieceDocuments : count
  const parts: DocumentPart[] = []
  // The packed layout's buffer is as large as the fixed one here, since the page doesn't know the documents' lengths
  // before the workers have written them. The bytes that the documents take are in the report.
  for (let first = 0; first < count; first += partDocuments) {
    const documents = Math.min(partDocuments, count - first)
    parts.push({buffer: await storage(documents * bytesPerDocument), firstDocument: first, documentCount: documents})
  }
  const starts = layout === 'packed' ? await storage((count + 1) * 4) : undefined
  const scopes = config.scopeBits ? await storage(count * scopeWordsPerDocument * 4) : undefined
  mark('buffersMs')
  const states = config.capacities[0]!
  const engine = await createEngine(device, byteKernel({states, layout, classes: 'table', scope: config.scopeBits, output: 'count'}), {parts, ...(starts === undefined ? {} : {starts}), ...(scopes === undefined ? {} : {scopes})}, byteTableLength(states), count)
  mark('kernelCompiledMs')
  const pattern = config.patterns[0]!
  const tables = byteTables(bitRowTables(compilePattern(pattern), states))

  // Uploads the pieces in the documents' order as they arrive, and searches the documents that are there after the first
  // piece and after the last one.
  let uploaded = 0
  let packedWords = 0
  let uploadMs = 0
  let firstAnswer: Record<string, unknown> | undefined
  const texts: string[] = []
  while (uploaded < pieceCount) {
    const piece = arrived[uploaded]
    if (piece === undefined) {
      await new Promise<void>(resolve => {
        wake = resolve
      })
      continue
    }
    arrived[uploaded] = undefined
    const started = performance.now()
    if (layout === 'packed') {
      // A worker's starts count from its piece's first word.
      const pieceStarts = piece.starts!
      for (let index = 0; index < pieceStarts.length; index++) pieceStarts[index]! += packedWords
      device.queue.writeBuffer(parts[0]!.buffer, packedWords * 4, piece.bytes)
      device.queue.writeBuffer(starts!, piece.firstDocument * 4, pieceStarts)
      packedWords += piece.bytes.length / 4
    } else {
      const part = parts.find(candidate => piece.firstDocument >= candidate.firstDocument && piece.firstDocument < candidate.firstDocument + candidate.documentCount)!
      device.queue.writeBuffer(part.buffer, (piece.firstDocument - part.firstDocument) * bytesPerDocument, piece.bytes)
    }
    if (scopes !== undefined) device.queue.writeBuffer(scopes, piece.firstDocument * scopeWordsPerDocument * 4, piece.scopeWords!)
    uploadMs += performance.now() - started
    uploaded++
    if (uploaded === 1) {
      mark('firstPieceUploadedMs')
      const result = await engine.search({count: piece.documentCount, tables})
      mark('firstAnswerMs')
      firstAnswer = {documents: piece.documentCount, searchMs: round(result.totalMs), documentsWithMatch: result.values.subarray(0, piece.documentCount).reduce((total, value) => total + (value > 0 ? 1 : 0), 0)}
    }
  }
  mark('everyPieceUploadedMs')
  const whole = await engine.search({count, tables})
  mark('everyDocumentSearchedMs')
  // After the timeline: the texts in the page's thread, as today's page keeps them to show a document. A page can also
  // write the one document that it shows when it shows it.
  let writingTheTextsMs: number | undefined
  if (config.keepTexts) {
    const started = performance.now()
    for (let index = 0; index < count; index++) texts.push(documentText(index))
    writingTheTextsMs = round(performance.now() - started)
  }
  let documentsWithMatch = 0
  for (let index = 0; index < count; index++) if (whole.values[index]! > 0) documentsWithMatch++
  // A search inside string values, as a second answer to compare with the 'compact' run's.
  const inStrings = config.scopeBits ? await engine.search({count, tables, scopeMask: scopeMasks.strings}) : undefined
  let stringDocuments = 0
  if (inStrings !== undefined) for (let index = 0; index < count; index++) if (inStrings.values[index]! > 0) stringDocuments++
  report['load'] = {
    pattern, states, pieces: pieceCount, pieceDocuments, workers: workers.length, firstAnswer,
    firstPieceArrivedMs: Math.min(...arrivals), lastPieceArrivedMs: Math.max(...arrivals),
    // The sum over the workers of where their time went, and the page's own writeBuffer calls.
    workerMs: {generate: round(workerMs.generate), pack: round(workerMs.pack), highlight: round(workerMs.highlight)},
    uploadCallsMs: round(uploadMs), wholeSearchMs: round(whole.totalMs), documentsWithMatch, documentsWithMatchInStrings: inStrings === undefined ? undefined : stringDocuments,
    textsHeld: texts.length, writingTheTextsMs,
    bufferBytes: {
      documents: parts.map(part => part.buffer.size), documentBytesUsed: layout === 'packed' ? packedWords * 4 : count * bytesPerDocument,
      starts: starts?.size ?? 0, scopes: scopes?.size ?? 0, ...engine.bufferBytes,
    },
    load: await loadAverage(),
  }
  log(`load: ${JSON.stringify(report['load'])}, timeline ${JSON.stringify(timeline)}`)
  for (const worker of workers) worker.terminate()
  await post(false)
  await sleep(1000)
  await measureMemory('after the load')
  // The texts stay alive until the memory is measured.
  report['textsStillHeld'] = texts.length
  engine.destroy()
  for (const buffer of [...parts.map(part => part.buffer), starts, scopes]) buffer?.destroy()
}

// ----------------------------------------------------------------------------------------------------------------
// 'js': regular JavaScript.

async function timeJs<Result>(run: () => Result, samples = config.jsSamples) {
  // One run of warmup, then the samples, with a turn of the event loop between them so the page stays alive.
  let result = run()
  const times: number[] = []
  for (let index = 0; index < samples; index++) {
    await sleep(0)
    const started = performance.now()
    result = run()
    times.push(performance.now() - started)
  }
  return {result, ms: summary(times), times: times.map(round)}
}

// One run after each of `samples` pauses.
async function timeJsAfterPause<Result>(run: () => Result | Promise<Result>, samples = config.jsSamples) {
  const times: number[] = []
  for (let index = 0; index < samples; index++) {
    await sleep(config.jsPauseMs)
    const started = performance.now()
    await run()
    times.push(performance.now() - started)
  }
  return {pauseMs: config.jsPauseMs, ms: summary(times), times: times.map(round)}
}

async function runJs() {
  const {count} = config
  const results: Record<string, unknown> = {}
  report['js'] = results
  const load = async () => (results['load'] as number[] | undefined ?? (results['load'] = [])).push(await loadAverage())
  await load()
  let started = performance.now()
  const texts = textsOf(0, count)
  results['generateMs'] = round(performance.now() - started)
  results['characters'] = texts.reduce((total, text) => total + text.length, 0)
  results['regExpFlags'] = config.regExpFlags
  await measureMemory('the texts')

  if (config.jsParts.includes('wholeText')) {
    const wholeText: Record<string, unknown>[] = []
    results['wholeText'] = wholeText
    for (const source of config.patterns) {
      const pattern = new RegExp(source, config.regExpFlags)
      const measured = await timeJs(() => texts.filter(text => pattern.test(text)).length)
      const afterPause = config.jsPauseMs > 0 && measured.ms!.median < 1500 ? await timeJsAfterPause(() => texts.filter(text => pattern.test(text)).length) : undefined
      wholeText.push({pattern: source, documentsWithMatch: measured.result, ms: measured.ms, times: measured.times, afterPause})
      log(`whole text, ${source}: ${measured.result} documents, ${measured.ms?.median} ms`)
      await post(false)
    }
    await load()
  }

  if (config.jsParts.includes('forms')) {
    // The whole-text search written in other plain ways, each timed like the search above: with the u flag and without
    // a flag, as a loop that counts instead of filter, and for a pattern that is a plain word as text.includes(word).
    const forms: Record<string, unknown>[] = []
    results['forms'] = forms
    for (const source of config.patterns) {
      const withFlag = new RegExp(source, 'u')
      const plain = new RegExp(source)
      // A search that takes seconds, e.g. one that makes RegExp backtrack, is timed 3 times.
      const once = performance.now()
      texts.filter(text => plain.test(text))
      const samples = performance.now() - once > 1500 ? 3 : config.jsSamples
      const form = async (run: () => number) => {
        const measured = await timeJs(run, samples)
        return {documentsWithMatch: measured.result, ms: measured.ms, times: measured.times}
      }
      const entry: Record<string, unknown> = {
        pattern: source,
        filterWithoutFlag: await form(() => texts.filter(text => plain.test(text)).length),
        filterWithU: await form(() => texts.filter(text => withFlag.test(text)).length),
        loopWithoutFlag: await form(() => {
          let found = 0
          for (const text of texts) if (plain.test(text)) found++
          return found
        }),
      }
      if (/^[a-z ]+$/.test(source)) entry['includes'] = await form(() => texts.filter(text => text.includes(source)).length)
      forms.push(entry)
      log(`forms, ${source}: ${JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([name]) => name !== 'pattern').map(([name, value]) => [name, (value as {ms: {median: number}}).ms.median])))}`)
      await post(false)
    }
    await load()
  }

  let parsed: Json[] | undefined
  if (config.jsParts.includes('parse')) {
    const validate = await timeJs(() => {
      let valid = 0
      for (const text of texts) {
        try {
          JSON.parse(text)
          valid++
        } catch {}
      }
      return valid
    })
    results['jsonParse'] = {valid: validate.result, ms: validate.ms, times: validate.times}
    log(`JSON.parse of every document: ${validate.result} valid, ${validate.ms?.median} ms`)
    await load()
    await post(false)
  }
  if (config.jsParts.includes('walk')) {
    started = performance.now()
    parsed = texts.map(text => JSON.parse(text) as Json)
    results['parseAndKeepMs'] = round(performance.now() - started)
    await measureMemory('the texts and the parsed objects')
    const walk: Record<string, unknown>[] = []
    results['walk'] = walk
    const objects = parsed
    for (const source of config.patterns) {
      const pattern = new RegExp(source, config.regExpFlags)
      const values = await timeJs(() => {
        let found = 0
        for (const value of objects) if (valueMatches(value, pattern)) found++
        return found
      })
      const keys = await timeJs(() => {
        let found = 0
        for (const value of objects) if (keyMatches(value, pattern)) found++
        return found
      })
      walk.push({pattern: source, stringValues: {documentsWithMatch: values.result, ms: values.ms, times: values.times}, keys: {documentsWithMatch: keys.result, ms: keys.ms, times: keys.times}})
      log(`walk, ${source}: string values ${values.result} documents, ${values.ms?.median} ms; keys ${keys.result} documents, ${keys.ms?.median} ms`)
      await post(false)
    }
    await load()
  }
  if (config.jsParts.includes('collected')) {
    started = performance.now()
    const objects = parsed ?? texts.map(text => JSON.parse(text) as Json)
    const collected = objects.map(value => {
      const values: string[] = []
      const keys: string[] = []
      collectStrings(value, values, keys)
      return {values, keys}
    })
    results['collectMs'] = round(performance.now() - started)
    results['collectedStrings'] = {values: collected.reduce((total, entry) => total + entry.values.length, 0), keys: collected.reduce((total, entry) => total + entry.keys.length, 0)}
    await measureMemory(parsed === undefined ? 'the texts and the collected strings' : 'the texts, the parsed objects and the collected strings')
    const fromArrays: Record<string, unknown>[] = []
    results['collected'] = fromArrays
    for (const source of config.patterns) {
      const pattern = new RegExp(source, config.regExpFlags)
      const values = await timeJs(() => {
        let found = 0
        for (const entry of collected) if (entry.values.some(value => pattern.test(value))) found++
        return found
      })
      const keys = await timeJs(() => {
        let found = 0
        for (const entry of collected) if (entry.keys.some(key => pattern.test(key))) found++
        return found
      })
      fromArrays.push({pattern: source, stringValues: {documentsWithMatch: values.result, ms: values.ms, times: values.times}, keys: {documentsWithMatch: keys.result, ms: keys.ms, times: keys.times}})
      log(`collected, ${source}: string values ${values.result} documents, ${values.ms?.median} ms; keys ${keys.result} documents, ${keys.ms?.median} ms`)
      await post(false)
    }
    await load()
  }

  if (config.jsParts.includes('workers')) {
    // The whole-text search in several workers, each with its own share of the documents.
    const share = Math.ceil(count / config.filterWorkers)
    const workers = Array.from({length: config.filterWorkers}, () => new Worker('/million-worker.js', {type: 'module'}))
    const ask = <Answer>(worker: Worker, message: HoldRequest | FilterRequest) => new Promise<Answer>(resolve => {
      worker.onmessage = event => resolve(event.data as Answer)
      worker.postMessage(message)
    })
    started = performance.now()
    await Promise.all(workers.map((worker, index) => ask(worker, {kind: 'hold', firstDocument: index * share, documentCount: Math.max(0, Math.min(share, count - index * share))})))
    const holdMs = performance.now() - started
    const inWorkers: Record<string, unknown>[] = []
    results['workers'] = {workers: config.filterWorkers, writingTheDocumentsMs: round(holdMs), patterns: inWorkers}
    for (const source of config.patterns) {
      const pattern = new RegExp(source, config.regExpFlags)
      const request = async (flags: boolean) => {
        const requested = performance.now()
        const answers = await Promise.all(workers.map(worker => ask<FilterAnswer>(worker, {kind: 'filter', pattern: source, regExpFlags: config.regExpFlags, flags})))
        return {ms: performance.now() - requested, answers}
      }
      // The check, outside the timed requests: which documents each worker says match, against the page's own RegExp.
      const checkedAnswers = (await request(true)).answers
      let differs = 0
      checkedAnswers.forEach((answer, index) => {
        answer.flags!.forEach((flag, row) => {
          if ((flag === 1) !== pattern.test(texts[index * share + row]!)) differs++
        })
      })
      const times: number[] = []
      let matching = 0
      for (let index = 0; index < config.jsSamples; index++) {
        const {ms, answers} = await request(false)
        times.push(ms)
        matching = answers.reduce((total, answer) => total + answer.matching, 0)
      }
      const afterPause = config.jsPauseMs > 0 && summary(times)!.median < 1500 ? await timeJsAfterPause(() => request(false)) : undefined
      inWorkers.push({pattern: source, documentsWithMatch: matching, documentsThatDifferFromOneThread: differs, ms: summary(times), times: times.map(round), afterPause})
      log(`${config.filterWorkers} workers, ${source}: ${matching} documents, ${summary(times)?.median} ms, ${differs} differ`)
      await post(false)
    }
    await measureMemory('the texts in the page and in the workers')
    for (const worker of workers) worker.terminate()
    await load()
  }
}

// ----------------------------------------------------------------------------------------------------------------
// 'scopes': the scope bits from the JSON highlighter's own pass on the GPU.

async function runScopes() {
  const {count} = config
  const pieceDocuments = Math.min(count, config.pieceDocuments)
  const granted = await requestBatchDevice(Math.max(count * bytesPerDocument, pieceDocuments * cellsPerDocument * 4))
  const {device} = granted
  watchDevice(device)
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(device, config.shaderSalt))
  const storage = (bytes: number) => checked(device, () => device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC}))
  const fixed = await storage(count * bytesPerDocument)
  const scopes = await storage(count * scopeWordsPerDocument * 4)
  // The documents' bytes, and the scope bits from table-loop.ts's plain JavaScript highlighter to compare with.
  const expectedWords = new Uint32Array(count * scopeWordsPerDocument)
  const kinds = new Uint8Array(pieceDocuments * positions)
  const onOneThread = {highlightMs: 0, scopeBitsMs: 0}
  for (let first = 0; first < count; first += pieceDocuments) {
    const texts = textsOf(first, Math.min(pieceDocuments, count - first))
    device.queue.writeBuffer(fixed, first * bytesPerDocument, packFixed(texts))
    let started = performance.now()
    for (let row = 0; row < texts.length; row++) highlightWithTables(texts[row]!, kinds, row * positions)
    onOneThread.highlightMs += performance.now() - started
    started = performance.now()
    packScopeBits(kinds, texts.length, expectedWords, first)
    onOneThread.scopeBitsMs += performance.now() - started
    await device.queue.onSubmittedWorkDone()
  }
  log(`${count} documents written`)

  // The highlighter's loop over a store that holds one piece, its display kinds in the runner's second output buffer.
  const json = buildJsonLoop(cellsPerDocument)
  const store = await createDocumentStore(device, cellsPerDocument, pieceDocuments)
  const runner = await createProgramRunner(device, emitLoopWgsl(json.loop), json.loop.sharedValues, store, config.shaderSalt, {windowCapacity: pieceDocuments})
  const unpack = await compile(device, unpackCellsKernel(cellsPerDocument).code)
  const pack = await compile(device, packKindsKernel(displayKind.key, displayKind.string).code)
  const params = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
  const group = (pipeline: GPUComputePipeline, from: GPUBuffer, to: GPUBuffer) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: params}}, {binding: 1, resource: {buffer: from}}, {binding: 2, resource: {buffer: to}}],
  })
  const unpackGroup = group(unpack.pipeline, fixed, store.buffer)
  const packGroup = group(pack.pipeline, runner.outputBuffers[1]!, scopes)
  const submit = (pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, documents: number) => {
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(documents / 64))
    pass.end()
    device.queue.submit([encoder.finish()])
  }
  const columns = stepSummaryNames.length
  // Every document once: unpack a piece's bytes, run the highlighter, read back its summary, pack its kinds.
  const highlightAll = async () => {
    const started = performance.now()
    let valid = 0
    let highlighterMs = 0
    for (let first = 0; first < count; first += pieceDocuments) {
      const documents = Math.min(pieceDocuments, count - first)
      device.queue.writeBuffer(params, 0, new Uint32Array([documents, first, 0, 0]))
      submit(unpack.pipeline, unpackGroup, documents)
      const evaluation = await runner.evaluate({count: documents, window: {firstDocument: 0, documentCount: documents}, readbacks: [{group: 0, firstDocument: 0, documentCount: documents}]})
      highlighterMs += evaluation.totalMs
      for (let row = 0; row < documents; row++) valid += evaluation.outputs[0]![row * columns]!
      submit(pack.pipeline, packGroup, documents)
    }
    await device.queue.onSubmittedWorkDone()
    return {ms: performance.now() - started, highlighterMs, valid}
  }
  const first = await highlightAll()
  const runs: Awaited<ReturnType<typeof highlightAll>>[] = []
  for (let index = 0; index < 9; index++) runs.push(await highlightAll())
  const afterPause: number[] = []
  for (let index = 0; index < 9; index++) {
    await sleep(1000)
    afterPause.push((await highlightAll()).ms)
  }

  // Every scope word of every document against the table loop's.
  const readback = device.createBuffer({size: pieceDocuments * scopeWordsPerDocument * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
  let mismatchedWords = 0
  for (let firstDocument = 0; firstDocument < count; firstDocument += pieceDocuments) {
    const words = Math.min(pieceDocuments, count - firstDocument) * scopeWordsPerDocument
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(scopes, firstDocument * scopeWordsPerDocument * 4, readback, 0, words * 4)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ, 0, words * 4)
    const got = new Uint32Array(readback.getMappedRange(0, words * 4))
    const base = firstDocument * scopeWordsPerDocument
    for (let word = 0; word < words; word++) if (got[word] !== expectedWords[base + word]) mismatchedWords++
    readback.unmap()
  }
  report['scopes'] = {
    pieceDocuments, pieces: Math.ceil(count / pieceDocuments),
    compileMs: {highlighter: round(runner.compileMs), unpack: round(unpack.compileMs), pack: round(pack.compileMs)},
    firstMs: round(first.ms), ms: summary(runs.map(run => run.ms)), times: runs.map(run => round(run.ms)), highlighterMs: summary(runs.map(run => run.highlighterMs)),
    afterPauseOf1000Ms: summary(afterPause),
    valid: first.valid, comparedWords: expectedWords.length, mismatchedWords,
    // The same answer in plain JavaScript on this page's one thread: table-loop.ts, then packing 2 bits per position.
    onOneThread: {highlightMs: round(onOneThread.highlightMs), scopeBitsMs: round(onOneThread.scopeBitsMs)},
    bufferBytes: {cellsOfOnePiece: store.buffer.size, kindsOfOnePiece: runner.outputBuffers[1]!.size, scopes: scopes.size},
    load: await loadAverage(),
  }
  log(`scopes: ${JSON.stringify(report['scopes'])}`)
  await measureMemory('after the highlighter\'s passes')
  runner.destroy()
  for (const buffer of [fixed, scopes, store.buffer, params, readback]) buffer.destroy()
}

// ----------------------------------------------------------------------------------------------------------------
// 'writers': bit-emit.ts's shaders against loop-emit.ts's, value by value.

async function runWriters() {
  const {count} = config
  // How many documents get per position outputs in one evaluation, e.g. 10,000 documents are 5,120,000 marks.
  const windowDocuments = Math.min(count, config.pieceDocuments, 10_000)
  const granted = await requestBatchDevice(count * cellsPerDocument * 4)
  const {device} = granted
  watchDevice(device)
  report['emptyPipelineMs'] = round(await compileEmptyPipeline(device, config.shaderSalt))
  const store = await createDocumentStore(device, cellsPerDocument, count)
  const cells = new Float32Array(windowDocuments * cellsPerDocument)
  for (let first = 0; first < count; first += windowDocuments) {
    const documents = Math.min(windowDocuments, count - first)
    for (let row = 0; row < documents; row++) writeDocumentCells(cells, row * cellsPerDocument, documentText(first + row))
    store.write(cells, documents, first)
    await device.queue.onSubmittedWorkDone()
  }
  log(`${count} documents written`)

  type Comparison = Record<string, unknown> & {values: number, mismatches: number}
  const comparisons: Comparison[] = []
  report['comparisons'] = comparisons
  // Both shaders of one loop program over every document, a window of documents at a time: each output group's values
  // of the window's documents from one runner against the other's. `total` sums output group 0, to see that the
  // compared values aren't all 0. With `expected`, the first value of output group 0 of every document is also compared
  // with what plain JavaScript gives for that document.
  const compare = async (today: ProgramRunner, bits: ProgramRunner, shared: Float32Array | undefined, expected?: (document: number) => number) => {
    const result = {values: 0, mismatches: 0, total: 0, differFromJavaScript: 0}
    for (let first = 0; first < count; first += windowDocuments) {
      const window = {firstDocument: first, documentCount: Math.min(windowDocuments, count - first)}
      const options = {
        count: window.documentCount, firstDocument: first, window, ...(shared === undefined ? {} : {shared}),
        readbacks: [{group: 0, firstDocument: first, documentCount: window.documentCount}, {group: 1, firstDocument: 0, documentCount: window.documentCount}],
      }
      const fromToday = await today.evaluate(options)
      const actual = await bits.evaluate(options)
      fromToday.outputs.forEach((values, group) => {
        const others = actual.outputs[group]!
        result.values += values.length
        for (let index = 0; index < values.length; index++) if (values[index] !== others[index]) result.mismatches++
      })
      for (const value of fromToday.outputs[0]!) result.total += value
      if (expected !== undefined) {
        const perDocument = fromToday.outputs[0]!.length / window.documentCount
        for (let row = 0; row < window.documentCount; row++) if (actual.outputs[0]![row * perDocument] !== expected(first + row)) result.differFromJavaScript++
      }
    }
    return result
  }
  const describe = (shader: ReturnType<typeof emitBitLoopWgsl>) => ({statements: shader.statementCount, bytes: shader.bytes, rules: shader.rules, rows: shader.rowCounts, packedWords: shader.packedCells.length})

  // The highlighter's step: its summary of every document, and its display kind of every position.
  const json = buildJsonLoop(cellsPerDocument)
  const jsonBitShader = emitBitLoopWgsl(json.loop)
  const jsonToday = await createProgramRunner(device, emitLoopWgsl(json.loop), json.loop.sharedValues, store, config.shaderSalt, {windowCapacity: count})
  const jsonBits = await createProgramRunner(device, jsonBitShader, json.loop.sharedValues, store, config.shaderSalt, {windowCapacity: windowDocuments})
  // Today's shader first writes every document's display kinds, which the searches with a scope read.
  await jsonToday.evaluate({count, window: {firstDocument: 0, documentCount: count}, readbacks: []})
  const jsonReference = await createProgramRunner(device, emitLoopWgsl(json.loop), json.loop.sharedValues, store, config.shaderSalt, {windowCapacity: windowDocuments})
  comparisons.push({program: 'the JSON highlighter\'s step', compileMs: {today: round(jsonReference.compileMs), bits: round(jsonBits.compileMs)}, ...describe(jsonBitShader), ...await compare(jsonReference, jsonBits, undefined)})
  log(`the highlighter: ${JSON.stringify(comparisons.at(-1))}`)
  jsonReference.destroy()
  jsonBits.destroy()
  await post(false)

  // A third program over the same documents, see character-sets.ts: both shaders, and its count in plain JavaScript.
  const sets = buildCharacterSets(positions, cellsPerDocument)
  const setsBitShader = emitBitLoopWgsl(sets.loop)
  const setsToday = await createProgramRunner(device, emitLoopWgsl(sets.loop), sets.loop.sharedValues, store, config.shaderSalt, {windowCapacity: windowDocuments})
  const setsBits = await createProgramRunner(device, setsBitShader, sets.loop.sharedValues, store, config.shaderSalt, {windowCapacity: windowDocuments})
  const setsShared = new Float32Array(sets.loop.sharedValues)
  for (const wanted of [[true, false, false, false], [false, true, true, false], [false, false, false, true], [true, true, true, true], [false, false, false, false]]) {
    sets.writeWanted(setsShared, wanted)
    comparisons.push({
      program: 'the characters of the wanted sets', wanted, compileMs: {today: round(setsToday.compileMs), bits: round(setsBits.compileMs)}, ...describe(setsBitShader),
      ...await compare(setsToday, setsBits, setsShared, document => countCharacters(documentText(document), wanted, positions)),
    })
    log(`the characters of the wanted sets, ${JSON.stringify(wanted)}: ${JSON.stringify(comparisons.at(-1))}`)
  }
  setsToday.destroy()
  setsBits.destroy()
  await post(false)

  const patterns = config.patterns.map(pattern => compilePattern(pattern))
  for (const states of config.capacities) {
    const capacity = {states, classes: classCapacity, boundaries: boundaryCapacity}
    for (const masked of [false, true]) {
      const built = buildSearchLoop(capacity, {positions, cellsPerDocument, masked, stopAtLength: false})
      const bitShader = emitBitLoopWgsl(built.loop)
      const runnerOptions = {windowCapacity: windowDocuments, ...(masked ? {inputs: [jsonToday.outputBuffers[1]!]} : {})}
      const today = await createProgramRunner(device, emitLoopWgsl(built.loop), built.loop.sharedValues, store, config.shaderSalt, runnerOptions)
      const bits = await createProgramRunner(device, bitShader, built.loop.sharedValues, store, config.shaderSalt, runnerOptions)
      const shared = new Float32Array(built.loop.sharedValues.length)
      for (const compiled of patterns) {
        // Every pattern that fits this capacity, also one that a smaller capacity holds.
        if (capacityErrors(compiled, capacity).length > 0) continue
        for (const scope of masked ? ['everything', 'strings', 'keys'] as const : ['everything'] as const) {
          shared.set(built.loop.sharedValues)
          built.writePattern(shared, compiled)
          if (masked) built.writeScope(shared, scope)
          const started = performance.now()
          comparisons.push({
            program: `the search step, ${states} states${masked ? ', with a scope' : ''}`, states, masked, scope, pattern: compiled.pattern,
            compileMs: {today: round(today.compileMs), bits: round(bits.compileMs)}, ...describe(bitShader), ...await compare(today, bits, shared), ms: round(performance.now() - started), load: await loadAverage(),
          })
          const {values, mismatches, total} = comparisons.at(-1)!
          log(`${states} states${masked ? ', with a scope' : ''}, ${compiled.pattern}, ${scope}: ${values} values, ${mismatches} mismatched, ${String(total)} matches`)
        }
      }
      today.destroy()
      bits.destroy()
      await post(false)
    }
  }
  report['compared'] = {comparisons: comparisons.length, values: comparisons.reduce((total, entry) => total + entry.values, 0), mismatches: comparisons.reduce((total, entry) => total + entry.mismatches, 0)}
  log(`compared: ${JSON.stringify(report['compared'])}`)
  jsonToday.destroy()
  store.destroy()
}

try {
  report['loadAtStart'] = await loadAverage()
  if (config.mode === 'compact') await runCompact()
  else if (config.mode === 'program') await runProgram()
  else if (config.mode === 'load') await runLoad()
  else if (config.mode === 'scopes') await runScopes()
  else if (config.mode === 'writers') await runWriters()
  else await runJs()
  report['loadAtEnd'] = await loadAverage()
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  log(String(report['error']))
  await post(true)
}
