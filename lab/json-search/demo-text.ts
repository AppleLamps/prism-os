// The demo page's words and numbers, with no DOM: how many documents the page loads and the sentence that says why,
// the result of a search as sentences, the highlighter's first error in words, a document's text as runs of
// characters that look the same, and the lines of the comparison, the check and the statistics.
import {errorKinds, maximumDepth} from '../../src/json-highlighter/kinds.ts'
import {type CapacityError, PatternSyntaxError, capacityErrors, compilePattern} from '../regex-search/pattern.ts'
import {type SearchScope, boundaryCapacity, classCapacity} from './search-step.ts'
import type {ProgramDescription} from './searcher.ts'

// A line of text for the page. A strong part is drawn bold, e.g. the number in "26,456 of 100,000 documents", and a
// small part stands on a line of its own in small letters, e.g. what a time in the comparison was measured on.
export type Line = readonly (string | {readonly strong: string} | {readonly small: string})[]
export const strong = (text: string) => ({strong: text})
export const small = (text: string) => ({small: text})

export const count = (value: number) => value.toLocaleString('en-US')
// A measured time. Chrome's clock reads in steps of 0.1 ms on this page, so a short time gets one decimal. The space
// before the unit doesn't break, so a line never ends between a number and its unit.
export function duration(ms: number): string {
  if (ms >= 995) return `${(ms / 1000).toFixed(ms >= 9950 ? 0 : 1)}\u00a0s`
  if (ms >= 9.95) return `${Math.round(ms)}\u00a0ms`
  return ms < 0.05 ? 'under 0.1\u00a0ms' : `${ms.toFixed(1)}\u00a0ms`
}
// A time that is computed from a sample, e.g. 100,000 times what one document took, with two digits: 25 s, 5.9
// minutes, 1.0 minutes.
export function roughDuration(ms: number): string {
  if (ms < 995) return duration(ms)
  const twoDigits = (value: number) => value < 9.95 ? value.toFixed(1) : Number(value.toPrecision(2)).toLocaleString('en-US')
  if (ms < 59_500) return `${twoDigits(ms / 1000)}\u00a0s`
  if (ms < 3_570_000) return `${twoDigits(ms / 60_000)}\u00a0minutes`
  return `${twoDigits(ms / 3_600_000)}\u00a0hours`
}
// The time of one document, in µs below a ms, e.g. "84 µs", so that 100,000 times it is the total beside it.
export const perDocument = (ms: number) => ms >= 0.9995 ? duration(ms) : ms < 0.00995 ? `${(ms * 1000).toFixed(1)}\u00a0µs` : `${count(Math.round(ms * 1000))}\u00a0µs`
// How many times one time is another, e.g. "2.6 times", "71 times".
// A ratio of 100 or more has two digits, e.g. "1,400 times", since the times it is made of don't have more.
export const times = (ratio: number) => `${ratio >= 99.5 ? count(Number(ratio.toPrecision(2))) : ratio >= 9.95 ? count(Math.round(ratio)) : ratio.toFixed(1)}\u00a0times`
export const megabytes = (bytes: number) => `${count(Math.round(bytes / 1e6))}\u00a0MB`

// How many documents the page loads.
export const wideDocumentCount = 100_000
// A window narrower than 720 px gets fewer documents: with 100,000, the map would be several screens tall there, and
// a phone's browser may not give one page the 410 MB that they take on the GPU.
export const narrowDocumentCount = 20_000
// The same programs take about 0.25 ms per document and search on the CPU, so the CPU version holds this many.
export const cpuDocumentCount = 500

// Why the page shows something else than 100,000 documents on the GPU.
export type LoadReason =
  | {kind: 'none'}
  | {kind: 'narrowWindow'}
  | {kind: 'asked'}
  | {kind: 'bufferLimit', wanted: number}
  | {kind: 'noWebGpu'}
  | {kind: 'cpuAsked'}
  | {kind: 'gpuFailed', message: string}
  // `asked` when the address asks the page to treat the check as failed, to show what the page does then.
  | {kind: 'checkFailed', mismatches: number, asked: boolean}

// The count the page asks the GPU for: what the address names, e.g. ?documents=20000, or a count by the window's width.
export function wantedDocumentCount(asked: number | null, narrowWindow: boolean): {documentCount: number, reason: LoadReason} {
  if (asked !== null && Number.isInteger(asked) && asked >= 1 && asked <= 1_000_000) {
    return {documentCount: asked, reason: asked === wideDocumentCount ? {kind: 'none'} : {kind: 'asked'}}
  }
  return narrowWindow ? {documentCount: narrowDocumentCount, reason: {kind: 'narrowWindow'}} : {documentCount: wideDocumentCount, reason: {kind: 'none'}}
}

// How many of the wanted documents fit one buffer of the device, e.g. 65,000 of 100,000 in the 128 MiB that every
// WebGPU device binds, at 2,052 bytes per document. Fewer than wanted is rounded down to a round count.
export function documentsThatFit(wanted: number, largestBufferBytes: number, bytesPerDocument: number): number {
  const most = Math.floor(largestBufferBytes / bytesPerDocument)
  if (most >= wanted) return wanted
  const step = most >= 10_000 ? 1000 : most >= 1000 ? 100 : 1
  return Math.max(1, Math.floor(most / step) * step)
}

// One sentence that says what the page shows and why, or null when it shows 100,000 documents on the GPU.
export function loadNotice(reason: LoadReason, documentCount: number): string | null {
  const onTheCpu = `so the same programs run on the CPU here, on ${count(documentCount)} documents`
  switch (reason.kind) {
    case 'none':
      return null
    case 'narrowWindow':
      return `A window this narrow gets ${count(documentCount)} documents, and one of 720 px or more gets ${count(wideDocumentCount)}.`
    case 'asked':
      return `This page’s address asks for ${count(documentCount)} documents.`
    case 'bufferLimit':
      return `One buffer of this device’s GPU holds ${count(documentCount)} documents, so the page searches ${count(documentCount)} instead of ${count(reason.wanted)}.`
    case 'noWebGpu':
      return `WebGPU isn’t available in this browser, ${onTheCpu}.`
    case 'cpuAsked':
      return `This page’s address asks for the CPU, ${onTheCpu}.`
    case 'gpuFailed':
      return `The GPU didn’t run the programs (${reason.message}), ${onTheCpu}.`
    case 'checkFailed':
      if (reason.asked) return `This page’s address asks it to treat the check of the GPU’s values as failed, ${onTheCpu}.`
      return `This GPU returned ${count(reason.mismatches)} ${reason.mismatches === 1 ? 'value that differs' : 'values that differ'} from the CPU’s, ${onTheCpu}.`
  }
}

// What the search reads, as the select's options name it.
export const scopeChoices = [
  {scope: 'everything', label: 'everything', where: 'in the whole text'},
  {scope: 'strings', label: 'string values', where: 'inside string values'},
  {scope: 'keys', label: 'keys', where: 'inside keys'},
] as const satisfies readonly {scope: SearchScope, label: string, where: string}[]
export type ScopeChoice = typeof scopeChoices[number]['scope']
export const scopeChoiceOf = (value: string | null): ScopeChoice => scopeChoices.find(choice => choice.scope === value)?.scope ?? 'everything'

// The groups of the map, in the order of documents.ts's shapes, and last the documents with an error. A name stands
// above its group's block of marks, beside a count of up to 6 characters, in the 123 px that a block is wide on a
// page of full width, so the names are short.
export const groupNames = ['Packages', 'User records', 'Log events', 'Settings', 'Orders', 'Map features', 'Sensors', 'With an error'] as const
// A document of each group, in the selected document's line, e.g. "a log event".
export const groupNouns = ['a package manifest', 'a user record', 'a log event', 'editor settings', 'an order', 'a map feature', 'sensor readings'] as const

// One sentence per capacity that a pattern exceeds.
export function limitSentence({reason, needed, capacity}: Pick<CapacityError, 'reason' | 'needed' | 'capacity'>): string {
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
  | {kind: 'fits', patternStates: number, states: number}

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
  return {kind: 'fits', patternStates: compiled.automaton.stateCount, states}
}

// The result of a search over every document.
export function resultLine(documentsWithMatches: number, matches: number, documentCount: number): Line {
  if (documentsWithMatches === 0) return [`None of the ${count(documentCount)} documents has a match.`]
  return [
    strong(count(documentsWithMatches)), ` of ${count(documentCount)} documents ${documentsWithMatches === 1 ? 'has' : 'have'} a match, `,
    strong(count(matches)), matches === 1 ? ' match in all.' : ' matches in all.',
  ]
}

// The highlighter's first error as a sentence about the character at the error's position, in the words of the JSON
// highlighter's page. kinds.ts has an example of every kind.
const errorSentences: {[Kind in typeof errorKinds[number]]: string} = {
  none: 'Valid JSON.',
  unexpectedCharacter: 'Nothing in JSON starts with this character.',
  controlCharacterInString: 'This character needs an escape inside a string, e.g. \\t for a tab.',
  badEscape: 'After a backslash come only " \\ / b f n r t or u.',
  badUnicodeEscape: '\\u needs four hexadecimal digits after it, e.g. \\u00e9.',
  badNumber: 'This isn’t a JSON number, just as 01, 1. and 1e aren’t.',
  badLiteral: 'This word isn’t true, false or null.',
  expectedValue: 'A value was expected here, e.g. a string or a number.',
  expectedKey: 'A key in double quotes was expected here, e.g. "name".',
  expectedColon: 'A colon was expected here, after the key.',
  expectedCommaOrClose: 'A comma or a closing bracket was expected here.',
  mismatchedBracket: 'This bracket is the wrong kind: { ends with } and [ with ].',
  extraAfterValue: 'The value ended before this, and only blank space may follow it.',
  tooDeep: `This bracket opens nesting level ${maximumDepth + 1}, and the program follows ${maximumDepth}.`,
  unexpectedEnd: 'The text ends before the value is complete.',
  tooLong: '',
}
const lineFeed = 10

// What the highlighter says about one document: "Valid JSON.", or where the first error is and what it is, e.g.
// "Line 4, column 12. A comma or a closing bracket was expected here." The line and the column count code points.
export function validitySentence(text: string, firstErrorPosition: number, firstErrorKind: number, capacity: number): string {
  if (firstErrorPosition < 0) return errorSentences.none
  const kind = errorKinds[firstErrorKind] ?? 'none'
  const codePoints = Array.from(text)
  if (kind === 'tooLong') return `This text has ${count(codePoints.length)} characters, and the program reads the first ${count(capacity)}.`
  let line = 1
  let column = 1
  for (let position = 0; position < Math.min(firstErrorPosition, codePoints.length); position++) {
    if (codePoints[position]!.codePointAt(0) === lineFeed) {
      line++
      column = 1
    } else {
      column++
    }
  }
  const unclosedString = kind === 'controlCharacterInString' && codePoints[firstErrorPosition]?.codePointAt(0) === lineFeed
  return `Line ${count(line)}, column ${count(column)}. ${unclosedString ? 'This string isn’t closed before the end of its line.' : errorSentences[kind]}`
}

// A run of a document's characters that are drawn the same way.
export type Run = {
  text: string
  // The display kind, k0 to k8 in the order of kinds.ts, or -1 for text past the 512 code points that the programs read.
  kind: number
  // 0 outside a match. Inside one, 1 or 2 in turn from match to match, so that two matches in a row stay apart.
  match: 0 | 1 | 2
  // The character at the first error's position.
  firstError: boolean
}
// `marker` is where a mark stands for a first error that has no character to underline: the index of the run before
// which it stands, or runs.length for the end of the text, or -1 for none.
export type DocumentRuns = {runs: Run[], marker: number}

// A document's text as runs. `kinds` and `marks` hold one value per code point of the first `capacity`: the
// highlighter's display kinds, and the search's marks, 0 outside a match, 1 inside one and 2 at a match's first code
// point, or null without a search.
export function documentRuns(text: string, kinds: ArrayLike<number>, marks: ArrayLike<number> | null, firstErrorPosition: number, capacity: number): DocumentRuns {
  const runs: Run[] = []
  let marker = -1
  let matchIndex = 0
  let position = 0
  for (const character of text) {
    const read = position < capacity
    const mark = read && marks !== null ? marks[position]! : 0
    if (mark === 2) matchIndex++
    const match = mark === 0 ? 0 : matchIndex % 2 === 1 ? 1 : 2
    const isLineFeed = character.codePointAt(0) === lineFeed
    const atError = position === firstErrorPosition && read
    // A line feed has nothing to underline, so the mark stands before it.
    if (atError && isLineFeed) marker = runs.length
    const firstError = atError && !isLineFeed
    const kind = read ? kinds[position]! : -1
    const last = runs.at(-1)
    // The mark stands between two runs, so no run continues across it.
    if (last !== undefined && last.kind === kind && last.match === match && last.firstError === firstError && marker !== runs.length) last.text += character
    else runs.push({text: character, kind, match, firstError})
    position++
  }
  // An error at the end of the text, e.g. a value that isn't complete. A text longer than the capacity has its mark
  // where the programs stop reading.
  if (firstErrorPosition >= 0 && marker === -1 && !runs.some(run => run.firstError)) {
    marker = firstErrorPosition >= position ? runs.length : runs.findIndex(run => run.kind === -1)
  }
  return {runs, marker}
}

// The class names of a run's span: the display kind as the two text tools name it, e.g. k2, and the match's wash.
export function runClassName(run: Run): string {
  const names = [run.kind < 0 ? 'past-capacity' : `k${run.kind}`]
  if (run.match !== 0) names.push(run.match === 1 ? 'hit even' : 'hit odd')
  if (run.firstError) names.push('first-error')
  return names.join(' ')
}

// The line above the selected document, e.g. "Document 73,512 of 100,000, a log event, with 2 matches".
export function documentLine(index: number, documentCount: number, group: number, valid: boolean, matches: number | null, firstWithMatch: boolean): Line {
  const noun = groupNouns[group]
  const line: (string | {strong: string})[] = ['Document ', strong(count(index + 1)), ` of ${count(documentCount)}`]
  if (noun !== undefined) line.push(valid ? `, ${noun}` : `, ${noun} with an error`)
  if (matches !== null && matches > 0) line.push(firstWithMatch ? ', the first with a match' : matches === 1 ? ', with 1 match' : `, with ${count(matches)} matches`)
  return line
}

// The programs' sizes, one sentence per program, e.g. for the statistics line. A search program's stages are the
// start, which runs once, and the two steps that run at each position, and the highlighter's are its step and the
// end step, which runs once.
export function programLines(programs: readonly ProgramDescription[], positions: number): Line[] {
  return programs.map(({name, operations, statements, compileMs}): Line => {
    const isHighlighter = name === 'JSON highlighter'
    const perPosition = isHighlighter ? operations[0] ?? 0 : (operations[1] ?? 0) + (operations[2] ?? 0)
    const line: (string | {strong: string})[] = [
      isHighlighter ? 'The JSON highlighter is ' : `Regex search for a pattern of up to ${name.replace(/\D/g, '')} states is `,
      strong(count(perPosition)), ` operations at each of a document’s ${count(positions)} positions`,
    ]
    if (statements !== undefined && compileMs !== undefined) line.push(', a shader of ', strong(count(statements)), ' statements that compiled in ', strong(duration(compileMs)))
    line.push('.')
    return line
  })
}
export const operationsPerPosition = (program: ProgramDescription | undefined) => program === undefined ? 0 : (program.operations[1] ?? 0) + (program.operations[2] ?? 0)

// The self check's line.
export type CheckState = {state: 'waiting'} | {state: 'checking'} | {state: 'done', values: number, mismatches: number, documents: number}
export function checkLine(check: CheckState, backend: 'gpu' | 'cpu'): {state: 'busy' | 'ok' | 'bad' | 'idle', line: Line} {
  const against = backend === 'gpu' ? 'the same programs on the CPU' : 'the repo’s reference executor'
  switch (check.state) {
    case 'waiting':
      return {state: 'idle', line: [`The page checks its values against ${against} once it is idle.`]}
    case 'checking':
      return {state: 'busy', line: [`Checking the first documents against ${against}…`]}
    case 'done':
      if (check.mismatches === 0) return {state: 'ok', line: [`Checked against ${against}: `, strong(count(check.values)), ` values of the first ${count(check.documents)} documents, none different.`]}
      return {state: 'bad', line: [`Checked against ${against}: `, strong(count(check.mismatches)), ` of ${count(check.values)} values differ.`]}
  }
}

// The comparison's numbers, as the page has measured them so far. A null is a number that isn't measured yet.
export type ComparisonNumbers = {
  backend: 'gpu' | 'cpu'
  documentCount: number
  scope: ScopeChoice
  // Validating and highlighting every document, from the texts: on the GPU, JavaScript writing the characters as
  // numbers, the upload, the highlighter's shader compile and its pass, and on the CPU version, creating the searcher.
  highlightMs: number | null
  // On the GPU, the highlighter's pass again over the documents that are already there.
  secondPassMs: number | null
  // The table loop in plain JavaScript per document, as timed on some of the documents, and on the GPU version the
  // same program on the CPU, per document.
  plainHighlightMsPerDocument: number | null
  plainSampleDocuments: number
  cpuHighlightMsPerDocument: number | null
  // This search: the page's own time, and whether it is of a search made again after a pause, which is what a search
  // per keystroke takes on a GPU.
  searchMs: number | null
  searchAfterPause: boolean
  plainSearch: {state: 'none'} | {state: 'running', ms: number, documents: number} | {state: 'done', ms: number, matches: number, differing: number} | {state: 'refused', message: string}
  // Finding the runs of searched characters, e.g. every string value, which JavaScript does once per scope.
  plainRunsMs: number | null
  cpuSearchMsPerDocument: number | null
  cpuSampleDocuments: number
}

const notYet: Line = [small('measured once the page is idle')]

// The cells of the comparison: for each of the three ways, validating and highlighting every document, and this
// search. A cell is a time, and under it in small letters what the time is of.
export function comparisonCells(numbers: ComparisonNumbers): {programHighlight: Line, programSearch: Line, plainHighlight: Line, plainSearch: Line, cpuHighlight: Line, cpuSearch: Line} {
  const {documentCount, plainSearch, backend} = numbers
  // A time that was measured on some of the documents says so, and one that was measured on all of them is plain.
  const fromSample = (msPerDocument: number | null, sampleDocuments: number): Line => msPerDocument === null ? notYet
    : sampleDocuments >= documentCount ? [strong(duration(msPerDocument * documentCount))]
    : ['about ', strong(roughDuration(msPerDocument * documentCount)), small(`from ${count(sampleDocuments)} documents at ${perDocument(msPerDocument)} each`)]
  let plainSearchLine: Line
  switch (plainSearch.state) {
    case 'none':
      plainSearchLine = notYet
      break
    case 'running':
      plainSearchLine = [strong(duration(plainSearch.ms)), ' so far', small(`for ${count(plainSearch.documents)} of the documents`)]
      break
    case 'done':
      // Before its first search of a scope, JavaScript finds the runs of searched characters, e.g. every string value.
      plainSearchLine = numbers.plainRunsMs === null || numbers.scope === 'everything' ? [strong(duration(plainSearch.ms))]
        : [strong(duration(plainSearch.ms)), small(`after ${duration(numbers.plainRunsMs)} once to find the ${numbers.scope === 'strings' ? 'string values' : 'keys'}`)]
      break
    case 'refused':
      plainSearchLine = [small(plainSearch.message)]
      break
  }
  let programHighlight: Line = notYet
  if (numbers.highlightMs !== null) {
    programHighlight = backend === 'cpu' ? [strong(duration(numbers.highlightMs))]
      : numbers.secondPassMs === null ? [strong(duration(numbers.highlightMs)), ' from the texts']
      : [strong(duration(numbers.highlightMs)), ' from the texts', small(`A second pass, over the documents that are already on the GPU, took ${duration(numbers.secondPassMs)}.`)]
  }
  return {
    programHighlight,
    programSearch: numbers.searchMs === null ? [small('no search yet')] : numbers.searchAfterPause ? [strong(duration(numbers.searchMs)), ' after a pause'] : [strong(duration(numbers.searchMs))],
    plainHighlight: fromSample(numbers.plainHighlightMsPerDocument, numbers.plainSampleDocuments),
    plainSearch: plainSearchLine,
    cpuHighlight: fromSample(numbers.cpuHighlightMsPerDocument, numbers.cpuSampleDocuments),
    cpuSearch: fromSample(numbers.cpuSearchMsPerDocument, numbers.cpuSampleDocuments),
  }
}

// What the measured numbers say, in sentences, for the search on screen. It says only what the page measured, and
// what README.md allows a page to say: the search is in the range of RegExp on one thread on ordinary patterns, a
// pattern on a larger program is slower, a pattern that takes RegExp 10 times as long or more is the one case where
// the programs' time is clearly less, and the same programs on the CPU take hundreds of times as long.
// `operations` and `smallestOperations` are the operations at each character of the program that ran and of the
// smallest search program.
export function comparisonVerdict(numbers: ComparisonNumbers, program: {patternStates: number, states: number, smallestStates: number, operations: number, smallestOperations: number}): Line {
  const {searchMs, plainSearch, backend} = numbers
  const {patternStates, states, smallestStates} = program
  const sentences: Line[] = []
  if (states > smallestStates) {
    sentences.push([`This pattern has ${count(patternStates)} states, more than the ${count(smallestStates)} that the smallest search program holds, so it ran on the program for ${count(states)}, which does ${count(program.operations)} operations at each character instead of ${count(program.smallestOperations)}.`])
  }
  if (searchMs !== null && plainSearch.state === 'done') {
    // A time that the clock reads as 0, e.g. RegExp on 500 documents, counts as half the clock's step of 0.1 ms.
    const ratio = Math.max(plainSearch.ms, 0.05) / searchMs
    const regExpTook = ['RegExp on one thread took ', strong(duration(plainSearch.ms)), ' for the same search'] as const
    if (ratio >= 10) {
      sentences.push([...regExpTook, ', ', strong(times(ratio)), ` as long. A search program takes the same time for every pattern of up to ${count(states)} states, and RegExp’s time depends on the pattern.`])
    } else if (ratio >= 3) {
      sentences.push([...regExpTook, `, ${times(ratio)} as long.`])
    } else if (ratio > 1 / 3) {
      sentences.push([...regExpTook, ': the two are in the same range.'])
    } else {
      sentences.push([...regExpTook, ': ', strong(times(1 / ratio)), ' as fast.'])
    }
    if (plainSearch.differing > 0) {
      sentences.push([`RegExp counts ${count(plainSearch.matches)} matches, and its count differs from the program’s in ${count(plainSearch.differing)} ${plainSearch.differing === 1 ? 'document' : 'documents'}: RegExp takes the first alternative that matches and also counts empty matches, and the program takes the longest match and never an empty one.`])
    }
  }
  if (backend === 'gpu' && searchMs !== null && numbers.cpuSearchMsPerDocument !== null) {
    sentences.push(['On the CPU, the same search program would take about ', strong(times(numbers.cpuSearchMsPerDocument * numbers.documentCount / searchMs)), ' as long as on the GPU.'])
  }
  return sentences.flatMap((sentence, index) => index === 0 ? sentence : [' ', ...sentence])
}
