// The comparison on the demo page, measured in the page for the search on screen, in small pieces so that typing stays
// smooth. It has no DOM: the page calls step() from a frame when nothing else is going on, and each call works for
// about `budgetMs` and returns whether more remains.
//
// Two baselines, as in README.md's three rows:
// - Plain JavaScript: the table loop (table-loop.ts) for every document's display kinds, and RegExp per search
//   (plain-search.ts), on each run of searched characters. The table loop is timed on the first 4,000 documents in
//   one piece, 6 times, and the fastest time is multiplied up to every document. For RegExp the documents are split
//   into chunks of 250, each with its own plain search, so one piece of work is at most one chunk, e.g. 5 ms of a
//   pattern that takes RegExp 2 s in all, and the search's time is the sum of the pieces' times, each read from the
//   clock once before and once after the piece. A search that takes less than 100 ms is timed twice, and the faster
//   time counts, as it would in a loop that does nothing else.
// - The same programs on the CPU (createCpuSearcher): the first 32 documents, timed and multiplied up to every
//   document. A search of 16 or 32 states is timed on 12 or 2 of them, and each time is the fastest of 4 to 10 runs.
import {capacity} from '../../src/json-highlighter/kinds.ts'
import {createPlainSearch} from './plain-search.ts'
import type {SearchScope} from './search-step.ts'
import {type Searcher, createCpuSearcher} from './searcher.ts'
import {highlightWithTables} from './table-loop.ts'

export type BaselineRequest = {
  pattern: string
  scope: SearchScope
  // The state capacity of the program that ran the search.
  states: number
  // The program's match count of every document, to count the documents where RegExp's count differs.
  programCounts: Float32Array
}

export type PlainSearchProgress = {state: 'none'} | {state: 'running', ms: number, documents: number} | {state: 'done', ms: number, matches: number, differing: number} | {state: 'refused', message: string}

export type BaselineNumbers = {
  // The table loop's time per document, and how many documents it was timed on.
  plainHighlightMsPerDocument: number | null
  plainSampleDocuments: number
  // Finding the runs of searched characters, e.g. every string value, which JavaScript does once per scope.
  plainRunsMs: number | null
  plainSearch: PlainSearchProgress
  // The same programs on the CPU, per document, and how many documents each was timed on.
  cpuHighlightMsPerDocument: number | null
  cpuHighlightDocuments: number
  cpuSearchMsPerDocument: number | null
  cpuSearchDocuments: number
}

export type Baselines = ReturnType<typeof createBaselines>

const chunkDocuments = 250
const plainSampleDocuments = 4000
const plainSampleRuns = 6
// A search that RegExp finishes in less than this is timed a second time.
const timedTwiceBelowMs = 100
const cpuDocuments = 32
// A search on the CPU is timed at least 4 times and at most 10, until a run is no longer faster than the fastest
// before it by more than 5%: the first runs include building the program, and running it before the JavaScript
// engine has optimized it.
const fewestCpuRuns = 4
const mostCpuRuns = 10
function cpuRunsAreDone(times: readonly number[]) {
  if (times.length < fewestCpuRuns) return false
  return times.length >= mostCpuRuns || times.at(-1)! >= 0.95 * Math.min(...times.slice(0, -1))
}
// About 8 ms of search on the CPU per run: 0.25 ms per document at 8 states, 0.7 ms at 16 and 4 to 7 ms at 32.
const cpuDocumentsFor = (states: number) => states <= 8 ? cpuDocuments : states <= 16 ? 12 : 2
// A pattern that matches nothing in the documents, to make a plain search find a scope's runs of searched characters
// without timing a search: U+FFFF, which no document holds.
const matchesNothing = String.fromCharCode(0xffff)

export function createBaselines(texts: readonly string[], options: {withCpu: boolean, now?: () => number}) {
  const now = options.now ?? (() => performance.now())
  const documentCount = texts.length
  const chunkCount = Math.ceil(documentCount / chunkDocuments)
  const chunks: ReturnType<typeof createPlainSearch>[] = []
  // Per scope: how many chunks have their runs, and the time so far.
  const runs = new Map<string, {chunks: number, ms: number}>()

  const plainSample = Math.min(plainSampleDocuments, documentCount)
  const plainSampleTimes: number[] = []
  const kindsOfOneDocument = new Uint8Array(capacity)

  const cpuSample = Math.min(cpuDocuments, documentCount)
  let cpu: Searcher | undefined
  // A CPU searcher answers through a promise, which resolves after the call that did the work returns.
  let cpuPending = false
  const cpuHighlightTimes: number[] = []

  // The search that is being measured: the CPU's runs, and RegExp's passes over the chunks. `best` is the fastest
  // complete pass.
  type Pass = {nextChunk: number, ms: number, matches: number, differing: number}
  let current: {
    key: string
    request: BaselineRequest
    cpuTimes: number[]
    pass: Pass
    passes: number
    best: Pass | null
    refused: string | null
  } | undefined

  const keyOf = (request: BaselineRequest) => `${String(request.scope)}\n${request.pattern}`
  const plainIsDone = (measured: NonNullable<typeof current>) => measured.refused !== null || (measured.best !== null && (measured.passes >= 2 || measured.best.ms >= timedTwiceBelowMs))

  function numbers(request: BaselineRequest | null): BaselineNumbers {
    const measured = request !== null && current?.key === keyOf(request) ? current : undefined
    const scopeRuns = request === null ? undefined : runs.get(String(request.scope))
    let plainSearch: PlainSearchProgress = {state: 'none'}
    if (measured !== undefined) {
      const {pass, best} = measured
      if (measured.refused !== null) plainSearch = {state: 'refused', message: measured.refused}
      else if (best !== null) plainSearch = {state: 'done', ms: best.ms, matches: best.matches, differing: best.differing}
      else if (pass.nextChunk > 0) plainSearch = {state: 'running', ms: pass.ms, documents: Math.min(documentCount, pass.nextChunk * chunkDocuments)}
    }
    const cpuFastest = measured !== undefined && cpuRunsAreDone(measured.cpuTimes) ? Math.min(...measured.cpuTimes) : Number.POSITIVE_INFINITY
    const cpuSearchDocuments = Math.min(cpuSample, cpuDocumentsFor(measured?.request.states ?? 0))
    return {
      plainHighlightMsPerDocument: plainSampleTimes.length >= plainSampleRuns ? Math.min(...plainSampleTimes) / plainSample : null,
      plainSampleDocuments: plainSample,
      plainRunsMs: scopeRuns !== undefined && scopeRuns.chunks === chunkCount ? scopeRuns.ms : null,
      plainSearch,
      cpuHighlightMsPerDocument: cpuHighlightTimes.length >= 2 ? Math.min(...cpuHighlightTimes) / cpuSample : null,
      cpuHighlightDocuments: cpuSample,
      // A pattern that the CPU searcher didn't search has no time.
      cpuSearchMsPerDocument: Number.isFinite(cpuFastest) ? cpuFastest / cpuSearchDocuments : null,
      cpuSearchDocuments,
    }
  }

  // One piece of the programs' times on the CPU. Returns whether it did or awaits something.
  function stepCpu(measured: NonNullable<typeof current>): boolean {
    if (cpuPending) return true
    if (cpu === undefined) {
      cpu = createCpuSearcher(texts.slice(0, cpuSample), {windowCapacity: cpuSample})
      return true
    }
    if (cpuHighlightTimes.length < 2) {
      cpuPending = true
      void cpu.validate().then(({evaluateMs}) => {
        cpuHighlightTimes.push(evaluateMs)
        cpuPending = false
      })
      return true
    }
    if (!cpuRunsAreDone(measured.cpuTimes)) {
      const {pattern, scope, states} = measured.request
      cpuPending = true
      void cpu.search({pattern, scope, window: {firstDocument: 0, documentCount: Math.min(cpuSample, cpuDocumentsFor(states))}, documents: 'window'}).then(result => {
        measured.cpuTimes.push(result?.status === 'searched' ? result.timings.evaluateMs : Number.POSITIVE_INFINITY)
        cpuPending = false
      })
      return true
    }
    return false
  }

  // Pieces of the plain JavaScript baseline until the budget is used: the table loop's time on the sample, then for
  // the chunks that don't have them their kinds and the scope's runs, then the search. Returns whether more remains.
  function stepPlain(measured: NonNullable<typeof current>, budgetMs: number): boolean {
    const {request} = measured
    const scopeKey = String(request.scope)
    let scopeRuns = runs.get(scopeKey)
    if (scopeRuns === undefined) {
      scopeRuns = {chunks: 0, ms: 0}
      runs.set(scopeKey, scopeRuns)
    }
    if (plainSampleTimes.length < plainSampleRuns) {
      // What table-loop.ts's loop takes for the sample's documents, with nothing between two documents.
      const started = now()
      for (let index = 0; index < plainSample; index++) highlightWithTables(texts[index]!, kindsOfOneDocument, 0)
      plainSampleTimes.push(now() - started)
      return true
    }
    const started = now()
    let pieceStarted = started
    let time = started
    // At least one piece per call, and more while the budget lasts.
    do {
      const {pass} = measured
      if (chunks.length < chunkCount) {
        chunks.push(createPlainSearch(texts.slice(chunks.length * chunkDocuments, (chunks.length + 1) * chunkDocuments)))
        time = now()
      } else if (scopeRuns.chunks < chunkCount) {
        chunks[scopeRuns.chunks]!.search(matchesNothing, request.scope)
        scopeRuns.chunks++
        time = now()
        scopeRuns.ms += time - pieceStarted
      } else if (!plainIsDone(measured)) {
        const first = pass.nextChunk * chunkDocuments
        try {
          const {matchCounts, matches} = chunks[pass.nextChunk]!.search(request.pattern, request.scope)
          pass.matches += matches
          const rows = Math.min(chunkDocuments, documentCount - first)
          for (let row = 0; row < rows; row++) if (matchCounts[row] !== request.programCounts[first + row]) pass.differing++
          pass.nextChunk++
        } catch (error) {
          // The pattern language is a subset of RegExp's, so this isn't expected.
          measured.refused = `RegExp doesn’t take this pattern: ${error instanceof Error ? error.message : String(error)}`
        }
        time = now()
        pass.ms += time - pieceStarted
        if (pass.nextChunk >= chunkCount) {
          measured.passes++
          if (measured.best === null || pass.ms < measured.best.ms) measured.best = pass
          measured.pass = {nextChunk: 0, ms: 0, matches: 0, differing: 0}
          // A second pass starts in a piece of its own, after a pause like the first one's.
          break
        }
      } else {
        return false
      }
      pieceStarted = time
    } while (time - started < budgetMs)
    return !plainIsDone(measured)
  }

  return {
    numbers,
    // Works on the comparison of one search for about budgetMs. Another search than the last call's starts over, and
    // keeps what doesn't depend on the pattern: the table loop's time, the chunks' kinds and each scope's runs.
    step(request: BaselineRequest, budgetMs: number): boolean {
      const key = keyOf(request)
      if (current?.key !== key) current = {key, request, cpuTimes: [], pass: {nextChunk: 0, ms: 0, matches: 0, differing: 0}, passes: 0, best: null, refused: null}
      if (options.withCpu && stepCpu(current)) return true
      return stepPlain(current, budgetMs)
    },
  }
}
