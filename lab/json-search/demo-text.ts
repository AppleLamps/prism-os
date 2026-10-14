// The demo page's documents, words and numbers, with no DOM: which documents the page holds and how many, the sentence
// that says why they aren't 100,000 documents on the GPU, what the pattern in the field is to the page, the line of
// numbers under the field, and a document's text as runs of characters that look the same. The page (demo.ts) and its
// worker (demo-worker.ts) both read this file, so both hold the same documents.
import {type CapacityError, PatternSyntaxError, capacityErrors, compilePattern} from '../regex-search/pattern.ts'
import {defaultSeed, documentAt} from './documents.ts'
import {boundaryCapacity, classCapacity} from './search-step.ts'

// The page's document at an index: documents.ts's generator without the documents that it breaks on purpose. So every
// document is valid JSON of at most 512 code points and a few levels of nesting, which both programs hold, and a
// document's kind, e.g. a log event or an order, is a hash of the seed and the index.
export const documentText = (index: number) => documentAt(defaultSeed, index, 0).text

// How many documents the page loads.
export const wideDocumentCount = 100_000
// A window narrower than 720 px gets fewer documents: a phone's browser may not give one page the 410 MB that 100,000
// documents take on the GPU, or the same again in the worker when the programs run on the CPU.
export const narrowDocumentCount = 20_000

// How many of the wanted documents fit one buffer of the device, e.g. 65,000 of 100,000 in the 128 MiB that every
// WebGPU device binds, at 2,052 bytes per document. Fewer than wanted is rounded down to a round count.
export function documentsThatFit(wanted: number, largestBufferBytes: number, bytesPerDocument: number): number {
  const most = Math.floor(largestBufferBytes / bytesPerDocument)
  if (most >= wanted) return wanted
  const step = most >= 10_000 ? 1000 : most >= 1000 ? 100 : 1
  return Math.max(1, Math.floor(most / step) * step)
}

export const count = (value: number) => value.toLocaleString('en-US')

// Why the page shows something else than the wanted documents on the GPU.
export type LoadReason =
  | {kind: 'none'}
  | {kind: 'bufferLimit', wanted: number}
  | {kind: 'noWebGpu'}
  | {kind: 'gpuFailed', message: string}

// One sentence that says what the page does instead, and why, or null when it searches the wanted documents on the GPU.
export function loadNotice(reason: LoadReason, documentCount: number): string | null {
  switch (reason.kind) {
    case 'none':
      return null
    case 'bufferLimit':
      return `One buffer of this GPU holds ${count(documentCount)} documents, so the page searches ${count(documentCount)} instead of ${count(reason.wanted)}.`
    case 'noWebGpu':
      return 'This browser has no WebGPU, so both programs run on the CPU here, as JavaScript in a worker.'
    case 'gpuFailed':
      return `The GPU didn’t run the programs (${reason.message}), so they run on the CPU here, as JavaScript in a worker.`
  }
}

// A failure that leaves the page nothing to search with: the documents couldn't be written, e.g. for lack of memory, or
// the page's worker failed. A worker whose script didn't load gives no message.
export type Failure =
  | {kind: 'documents', message: string}
  | {kind: 'worker', message: string | undefined}

// The sentence that the page shows in the place of the line of numbers.
export function failureSentence(failure: Failure): string {
  switch (failure.kind) {
    case 'documents':
      return `The page couldn’t load its documents: ${failure.message}.`
    case 'worker':
      return failure.message === undefined ? 'The page’s worker didn’t start, so the page can’t search.' : `The page’s worker stopped (${failure.message}), so the page can’t search.`
  }
}

// What a search reads: every character, or only the ones that the highlighter shows as keys or as string values.
export const scopes = ['everything', 'keys', 'strings'] as const
export type Scope = typeof scopes[number]
export const isScope = (value: string | undefined): value is Scope => scopes.some(scope => scope === value)

// Where the search program runs.
export type Where = 'gpu' | 'cpu'

// One sentence per capacity that a pattern exceeds.
function limitSentence({reason, needed, capacity}: CapacityError): string {
  switch (reason) {
    case 'states':
      return `This pattern needs ${count(needed)} states, and the largest search program holds ${capacity}.`
    case 'classes':
      return `This pattern tells ${count(needed)} classes of characters apart, and the search programs hold ${capacity}.`
    case 'boundaries':
      return `This pattern’s classes of characters change at ${count(needed)} places, and the search programs hold ${capacity}.`
  }
}

// What the page does with the pattern in the field: nothing for an empty one, a sentence for one with a syntax error
// or one that no search program holds, and otherwise a search on the smallest program that holds it, e.g. the program
// of 16 states for a pattern of 11.
export type PatternAnalysis =
  | {kind: 'empty'}
  | {kind: 'refused', sentence: string}
  | {kind: 'fits', states: number}

export function analyzePattern(pattern: string, stateCapacities: readonly number[]): PatternAnalysis {
  if (pattern === '') return {kind: 'empty'}
  let compiled
  try {
    compiled = compilePattern(pattern)
  } catch (error) {
    if (!(error instanceof PatternSyntaxError)) throw error
    return {kind: 'refused', sentence: `Character ${count(error.position + 1)} of the pattern: ${error.message}.`}
  }
  const errorsAt = (states: number) => capacityErrors(compiled, {states, classes: classCapacity, boundaries: boundaryCapacity})
  const states = stateCapacities.find(candidate => errorsAt(candidate).length === 0)
  if (states === undefined) return {kind: 'refused', sentence: errorsAt(Math.max(...stateCapacities)).map(limitSentence).join(' ')}
  return {kind: 'fits', states}
}

// A line of text for the page. A strong part is drawn bold, e.g. the number in "10,541 of 100,000 documents match".
export type Line = readonly (string | {readonly strong: string})[]
export const strong = (text: string) => ({strong: text})

// A measured time. Chrome's clock reads in steps of 0.1 ms on this page, so a short time gets one decimal. The space
// before the unit doesn't break, so a line never ends between a number and its unit.
export function duration(ms: number): string {
  if (ms >= 995) return `${(ms / 1000).toFixed(ms >= 9950 ? 0 : 1)} s`
  if (ms >= 9.95) return `${Math.round(ms)} ms`
  return ms < 0.05 ? 'under 0.1 ms' : `${ms.toFixed(1)} ms`
}

// RegExp's time for a search on one thread: measured, or that the page stopped RegExp after waiting this long for it,
// e.g. after 10 s on a pattern that makes RegExp backtrack for minutes.
export type RegExpTime =
  | {kind: 'measured', ms: number}
  | {kind: 'stopped', afterMs: number}

function regExpPart(time: RegExpTime | null): Line {
  if (time === null) return []
  switch (time.kind) {
    case 'measured':
      return [' RegExp: ', strong(duration(time.ms)), '.']
    case 'stopped':
      return [' RegExp: ', strong(`more than ${duration(time.afterMs)}`), '.']
  }
}

// The line of numbers for a search: how many documents have a match, how long the search program took where it ran,
// and how long RegExp took for the same search on one thread, once the page has measured it. A search on the CPU
// answers a few documents at a time, in the documents' order, and until it has answered for all of them the line says
// how far it is, e.g. "1,304 of the first 12,400 documents match. 3.1 s on the CPU so far."
export function resultLine(result: {withMatch: number, searched: number, ms: number}, documentCount: number, where: Where, regExpTime: RegExpTime | null): Line {
  const place = where === 'gpu' ? 'on the GPU' : 'on the CPU'
  const regExp = regExpPart(regExpTime)
  const verb = result.withMatch === 1 ? 'matches' : 'match'
  if (result.searched < documentCount) {
    return [strong(count(result.withMatch)), ` of the first ${count(result.searched)} documents ${verb}. `, strong(duration(result.ms)), ` ${place} so far.`, ...regExp]
  }
  if (result.withMatch === 0) return [`None of the ${count(documentCount)} documents matches. `, strong(duration(result.ms)), ` ${place}.`, ...regExp]
  return [strong(count(result.withMatch)), ` of ${count(documentCount)} documents ${verb}. `, strong(duration(result.ms)), ` ${place}.`, ...regExp]
}

// A run of a document's characters that are drawn the same way.
export type Run = {
  text: string
  // The display kind, k0 to k8 in the order of src/json-highlighter/kinds.ts.
  kind: number
  // 0 outside a match. Inside one, 1 or 2 in turn from match to match, so that two matches in a row stay apart.
  match: 0 | 1 | 2
}

// A document's text as runs. `kinds` and `marks` hold one value per code point: the highlighter's display kinds, and
// the search's marks, 0 outside a match, 1 inside one and 2 at a match's first code point, or null without a search.
export function documentRuns(text: string, kinds: ArrayLike<number>, marks: ArrayLike<number> | null): Run[] {
  const runs: Run[] = []
  let matchIndex = 0
  let position = 0
  for (const character of text) {
    const mark = marks === null ? 0 : marks[position]!
    if (mark === 2) matchIndex++
    const match = mark === 0 ? 0 : matchIndex % 2 === 1 ? 1 : 2
    const kind = kinds[position]!
    const last = runs.at(-1)
    if (last !== undefined && last.kind === kind && last.match === match) last.text += character
    else runs.push({text: character, kind, match})
    position++
  }
  return runs
}

// The class names of a run's span: the display kind as the two text tools name it, e.g. k2, and the match's wash.
export function runClassName(run: Run): string {
  switch (run.match) {
    case 0: return `k${run.kind}`
    case 1: return `k${run.kind} hit even`
    case 2: return `k${run.kind} hit odd`
  }
}
