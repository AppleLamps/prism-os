// The demo page's worker: the work that the page keeps off its own thread, so that typing stays smooth.
// - RegExp's time for the search on screen: plain-search.ts over every document, i.e. RegExp on each document, or on
//   each key or each string value.
// - Both programs on the CPU, when the page's toggle says CPU or the browser has no WebGPU: searcher.ts's CPU version,
//   i.e. the programs as generated JavaScript. A search goes through the documents in their order, a few at a time,
//   and posts each piece's match counts, so the page fills its map in while the search runs. The JSON highlighter runs
//   on a document when a search first reaches it, and its time isn't part of the search's.
//
// The worker writes the page's documents itself, from the same generator as the page. A message only records what the
// page wants, and each turn does one piece of work, so a new search replaces the one in progress within a piece's
// time, about 8 ms.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type Scope, documentText} from './demo-text.ts'
import {createPlainSearch} from './plain-search.ts'
import {type Searcher, createCpuSearcher} from './searcher.ts'

export type WorkerRequest =
  // The first message: how many documents the page holds.
  | {kind: 'documents', documentCount: number}
  | {kind: 'regExp', key: string, pattern: string, scope: Scope}
  // A search of every document with the programs on the CPU, which replaces the one in progress. null stops it.
  // `id` is the page's number for this search, which the search's answers carry: a key of the pattern alone would
  // also fit the answers of an earlier search for the same pattern that the page has given up since.
  | {kind: 'search', search: {id: number, pattern: string, scope: Scope} | null}
  // One document's display kinds, and with a search its marks, from the programs on the CPU.
  | {kind: 'document', key: string, index: number, search: {pattern: string, scope: Scope} | null}

export type WorkerAnswer =
  | {kind: 'regExp', key: string, ms: number}
  // The match counts of the documents from `firstDocument` on, and the search program's time for them.
  | {kind: 'searched', id: number, firstDocument: number, matchCounts: Float32Array, ms: number}
  // 512 display kinds, and 512 marks: 0 outside a match, 1 inside one, 2 at a match's first code point.
  | {kind: 'document', key: string, index: number, kinds: Float32Array, marks: Float32Array | null}

// How long a piece of a search should take, and how many documents a piece holds at most.
const pieceMs = 8
const mostPieceDocuments = 256
// A search that RegExp finishes in less than this is timed a second time, and the faster time counts.
const timedTwiceBelowMs = 100

// What the page wants, as of its last messages.
const wanted = {
  documentCount: 0,
  regExp: null as Extract<WorkerRequest, {kind: 'regExp'}> | null,
  // `nextDocument` is how far the search is, and `pieceDocuments` how many documents its next piece holds.
  search: null as {id: number, pattern: string, scope: Scope, nextDocument: number, pieceDocuments: number} | null,
  document: null as Extract<WorkerRequest, {kind: 'document'}> | null,
}
// The documents, and what is built from them when it is first needed.
let texts: string[] | null = null
let plain: ReturnType<typeof createPlainSearch> | null = null
let cpu: Searcher | null = null

const post = (answer: WorkerAnswer, transfer: Transferable[] = []) => self.postMessage(answer, {transfer})

// One piece of work, the most urgent first: the document that the page shows, RegExp's time, then the search.
async function work() {
  if (wanted.documentCount === 0) return
  texts ??= Array.from({length: wanted.documentCount}, (_, index) => documentText(index))
  if (wanted.document !== null) {
    const {key, index, search} = wanted.document
    wanted.document = null
    cpu ??= createCpuSearcher(texts, {highlight: 'whenFirstRead', windowCapacity: mostPieceDocuments})
    const window = {firstDocument: index, documentCount: 1}
    const kinds = await cpu.kinds(window)
    let marks: Float32Array | null = null
    if (search !== null) {
      const result = await cpu.search({...search, window, documents: 'window'})
      invariant(result?.status === 'searched', 'the page asks for a pattern that a search program holds')
      marks = result.marks
    }
    post({kind: 'document', key, index, kinds, marks}, marks === null ? [kinds.buffer] : [kinds.buffer, marks.buffer])
  } else if (wanted.regExp !== null) {
    const {key, pattern, scope} = wanted.regExp
    wanted.regExp = null
    plain ??= createPlainSearch(texts)
    let ms = plain.search(pattern, scope).ms
    if (ms < timedTwiceBelowMs) ms = Math.min(ms, plain.search(pattern, scope).ms)
    post({kind: 'regExp', key, ms})
  } else if (wanted.search !== null) {
    const search = wanted.search
    cpu ??= createCpuSearcher(texts, {highlight: 'whenFirstRead', windowCapacity: mostPieceDocuments})
    const window = {firstDocument: search.nextDocument, documentCount: Math.min(search.pieceDocuments, texts.length - search.nextDocument)}
    const started = performance.now()
    const result = await cpu.search({pattern: search.pattern, scope: search.scope, window, documents: 'window'})
    const pieceTook = performance.now() - started
    invariant(result?.status === 'searched', 'the page asks for a pattern that a search program holds')
    // The search's time is its loops' time: the first piece also builds the search program, and a first search also
    // runs the highlighter, and neither is part of it.
    post({kind: 'searched', id: search.id, firstDocument: window.firstDocument, matchCounts: result.matchCounts, ms: result.timings.evaluateMs}, [result.matchCounts.buffer])
    search.nextDocument += window.documentCount
    // The clock reads in steps of 0.1 ms, so a piece that took less counts as 0.1 ms.
    search.pieceDocuments = Math.max(1, Math.min(mostPieceDocuments, Math.round(window.documentCount * pieceMs / Math.max(0.1, pieceTook))))
    if (search.nextDocument === texts.length) wanted.search = null
  }
}

// A turn is a task of its own, so the messages that arrived during a piece are recorded before the next piece starts.
// The task is a message to oneself: a timer would wait 4 ms once timers follow each other.
const turns = new MessageChannel()
let turnScheduled = false
function scheduleTurn() {
  if (turnScheduled) return
  turnScheduled = true
  turns.port2.postMessage(null)
}
turns.port1.onmessage = () => {
  turnScheduled = false
  // A piece that throws is reported as the worker's error, which the page hears and shows.
  work().then(() => {
    if (wanted.document !== null || wanted.regExp !== null || wanted.search !== null) scheduleTurn()
  }, reportError)
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  switch (request.kind) {
    case 'documents':
      wanted.documentCount = request.documentCount
      break
    case 'regExp':
      wanted.regExp = request
      break
    case 'search':
      // A piece starts small, since a pattern on a larger program takes up to 30 times as long per document.
      wanted.search = request.search === null ? null : {...request.search, nextDocument: 0, pieceDocuments: 2}
      break
    case 'document':
      wanted.document = request
      break
  }
  scheduleTurn()
})
