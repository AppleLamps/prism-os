// A second page of the million-document check, for the review's independent count: it runs the main kernels over the
// documents and posts what each search returned, as raw bytes, to answers-run.ts. independent.ts then compares every
// document's answer with RegExp and JSON.parse in Bun, with none of expected.ts's code. Nothing is timed here.
//
// The kernels are the ones the report's table 3 is about: the reverse pass alone with and without scope bits, which
// returns one bit per document, the two kernels that return a match count per document, and the count kernel over four
// buffers of 128 MB.
import {capacityErrors, compilePattern} from '../../regex-search/pattern.ts'
import {bitRowTables} from '../bit-rows.ts'
import {documentText} from '../demo-text.ts'
import {requestBatchDevice} from '../gpu/host.ts'
import {boundaryCapacity, classCapacity} from '../search-step.ts'
import {highlightWithTables} from '../table-loop.ts'
import {type DocumentPart, type Engine, checked, createEngine} from './engine.ts'
import {byteKernel} from './kernels.ts'
import {type ScopeName, byteTableLength, byteTables, bytesPerDocument, packFixed, packScopeBits, positions, scopeMasks, scopeWordsPerDocument} from './layouts.ts'

export type AnswersConfig = {count: number, patterns: string[]}
// One search's answer: `file`.bin holds one u32 match count per document, or for 'has' one bit per document, 32
// documents a word.
export type Answer = {pattern: string, patternIndex: number, states: number, engine: string, scope: ScopeName, output: 'count' | 'has', file: string}

const GPUBufferUsage = {COPY_SRC: 0x0004, COPY_DST: 0x0008, STORAGE: 0x0080} as const
const config = await (await fetch('/config')).json() as AnswersConfig
const answers: Answer[] = []
const report: Record<string, unknown> = {startedAt: new Date().toISOString(), config, answers}
const post = async (done: boolean) => {
  await fetch('/result', {method: 'POST', body: JSON.stringify({...report, done})})
}

const engineKinds: {name: string, scope: boolean, output: 'count' | 'has', split: boolean, scopes: readonly ScopeName[]}[] = [
  {name: 'bytes-has', scope: false, output: 'has', split: false, scopes: ['everything']},
  {name: 'bytes-scope-has', scope: true, output: 'has', split: false, scopes: ['everything', 'keys', 'strings']},
  {name: 'bytes', scope: false, output: 'count', split: false, scopes: ['everything']},
  {name: 'bytes-scope', scope: true, output: 'count', split: false, scopes: ['everything', 'keys', 'strings']},
  {name: 'bytes-split', scope: false, output: 'count', split: true, scopes: ['everything']},
]

try {
  const {count} = config
  const {device} = await requestBatchDevice(count * bytesPerDocument)
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
  })
  const storage = (bytes: number) => checked(device, () => device.createBuffer({size: Math.max(4, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC}))
  const fixed = await storage(count * bytesPerDocument)
  const scopes = await storage(count * scopeWordsPerDocument * 4)
  const pieceDocuments = Math.min(count, 50_000)
  const kinds = new Uint8Array(pieceDocuments * positions)
  for (let first = 0; first < count; first += pieceDocuments) {
    const documents = Math.min(pieceDocuments, count - first)
    const texts = Array.from({length: documents}, (_, index) => documentText(first + index))
    device.queue.writeBuffer(fixed, first * bytesPerDocument, packFixed(texts))
    for (let row = 0; row < documents; row++) highlightWithTables(texts[row]!, kinds, row * positions)
    const scopeWords = new Uint32Array(documents * scopeWordsPerDocument)
    packScopeBits(kinds, documents, scopeWords)
    device.queue.writeBuffer(scopes, first * scopeWordsPerDocument * 4, scopeWords)
    await device.queue.onSubmittedWorkDone()
  }
  // The same documents as buffers of at most 262,144 documents, 128 MiB, as a device with default limits needs.
  const partDocuments = 262_144
  const splitParts: DocumentPart[] = []
  for (let first = 0; first < count; first += partDocuments) {
    const documents = Math.min(partDocuments, count - first)
    const buffer = await checked(device, () => device.createBuffer({size: documents * bytesPerDocument, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}))
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(fixed, first * bytesPerDocument, buffer, 0, documents * bytesPerDocument)
    device.queue.submit([encoder.finish()])
    splitParts.push({buffer, firstDocument: first, documentCount: documents})
  }
  await device.queue.onSubmittedWorkDone()
  const parts: DocumentPart[] = [{buffer: fixed, firstDocument: 0, documentCount: count}]

  const engines = new Map<string, Engine>()
  for (const [patternIndex, pattern] of config.patterns.entries()) {
    const compiled = compilePattern(pattern)
    const states = [8, 16, 32].find(capacity => capacityErrors(compiled, {states: capacity, classes: classCapacity, boundaries: boundaryCapacity}).length === 0)
    if (states === undefined) throw new Error(`${pattern} needs more than 32 states`)
    const tables = byteTables(bitRowTables(compiled, states))
    for (const kind of engineKinds) {
      const key = `${kind.name}-${states}`
      let engine = engines.get(key)
      if (engine === undefined) {
        engine = await createEngine(device, byteKernel({states, layout: 'fixed', classes: 'table', scope: kind.scope, output: kind.output}), {parts: kind.split ? splitParts : parts, ...(kind.scope ? {scopes} : {})}, byteTableLength(states), count)
        engines.set(key, engine)
      }
      for (const scope of kind.scopes) {
        const {values} = await engine.search({count, tables, scopeMask: scopeMasks[scope]})
        const file = `${patternIndex}-${kind.name}-${scope}`
        await fetch(`/answer?name=${file}`, {method: 'POST', body: new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice()})
        answers.push({pattern, patternIndex, states, engine: kind.name, scope, output: kind.output, file})
      }
    }
    console.log(`${pattern}: its answers at ${states} states are posted`)
    await post(false)
  }
  report['finishedAt'] = new Date().toISOString()
  await post(true)
} catch (error) {
  report['error'] = `${String(error)}\n${(error as Error).stack ?? ''}`
  await post(true)
}
