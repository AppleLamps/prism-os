// The page: one evaluation in each frame where the pattern or the text changed, then DOM writes from the output bits.
// Query parameters pick the program, e.g. ?form=builtin&states=32&text=1024, and ?pattern= sets the starting pattern.
import type {Circuit} from '../../src/runtime/numeric-ui-core.ts'
import {createBuiltInSearch} from './builtin-program.ts'
import {createDataSearch} from './data-program.ts'
import {type Match, codePointsOf, matchesFromBits} from './host.ts'
import {type CompiledPattern, PatternSyntaxError, capacityErrors, compilePattern} from './pattern.ts'
import {sampleText} from './sample-text.ts'

// What one frame took, for browser-frame.ts. evaluated is false when the pattern didn't compile or didn't fit. The first
// frame, which renders the starting pattern, has kind 'first'.
export type FrameTiming = {
  kind: 'first' | 'pattern' | 'text'
  evaluated: boolean
  compilePatternMs: number
  // Form (a): writing the pattern into cells. Form (b): building and compiling the program for a new pattern.
  programMs: number
  evaluateMs: number
  domMs: number
  // From the start of the frame's callback to the end of its DOM writes.
  callbackMs: number
  // From the first input event since the previous frame to the next requestAnimationFrame callback after the DOM writes.
  // For the first frame, from the start of the navigation, where performance.now() starts at 0.
  inputToNextFrameMs?: number
}

declare global {
  interface Window {
    regexSearchReady?: boolean
    regexSearchFrames?: FrameTiming[]
  }
}

const params = new URLSearchParams(location.search)
const form = params.get('form') === 'builtin' ? 'builtin' : 'data'
const states = [8, 16, 32].includes(Number(params.get('states'))) ? Number(params.get('states')) : 16
const textLength = params.get('text') === '256' ? 256 : 1024
const capacity = {states, classes: 16, boundaries: 32, textLength}

const patternInput = document.querySelector<HTMLInputElement>('#pattern')!
const formSelect = document.querySelector<HTMLSelectElement>('#form')!
const statesSelect = document.querySelector<HTMLSelectElement>('#states')!
const textLengthSelect = document.querySelector<HTMLSelectElement>('#text-length')!
const errorLine = document.querySelector<HTMLElement>('#error')!
const statusLine = document.querySelector<HTMLElement>('#status')!
const matchesView = document.querySelector<HTMLElement>('#matches')!
const textArea = document.querySelector<HTMLTextAreaElement>('#text')!

const initialPattern = params.get('pattern')
if (initialPattern !== null) patternInput.value = initialPattern
formSelect.value = form
statesSelect.value = String(states)
textLengthSelect.value = String(textLength)
// Leave room within the capacity, so typed text is searched.
textArea.value = String.fromCodePoint(...codePointsOf(sampleText).slice(0, textLength - 24))
for (const select of [formSelect, statesSelect, textLengthSelect]) {
  select.addEventListener('change', () => {
    location.search = new URLSearchParams({form: formSelect.value, states: statesSelect.value, text: textLengthSelect.value, pattern: patternInput.value}).toString()
  })
}

const count = (value: number) => value.toLocaleString('en-US')
// The automaton's size against the capacity, which both forms check before they evaluate.
const automatonSize = ({automaton, partition}: CompiledPattern) =>
  `Automaton: ${automaton.stateCount} of ${states} states, ${partition.classCount} of ${capacity.classes} classes, ${partition.boundaries.length} of ${capacity.boundaries} class boundaries.`
const milliseconds = (value: number) => `${value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : Math.round(value)} ms`

// Every operation the builder appended, and the deepest chain of them. Computed once per program, since a program can
// have millions of operations.
const programSizes = new WeakMap<Circuit, string>()
function programSize(circuit: Circuit) {
  let size = programSizes.get(circuit)
  if (size === undefined) {
    let layers = 0
    for (const depth of circuit.depths) layers = Math.max(layers, depth)
    size = `${count(circuit.operations.length)} operations in ${count(layers)} layers over ${count(circuit.sourceSize)} cells`
    programSizes.set(circuit, size)
  }
  return size
}

function writeMatches(codePoints: readonly number[], matches: readonly Match[]) {
  const fragment = document.createDocumentFragment()
  const textOf = (start: number, end: number) => String.fromCodePoint(...codePoints.slice(start, end))
  let position = 0
  matches.forEach((match, index) => {
    if (match.start > position) fragment.append(textOf(position, match.start))
    const mark = document.createElement('mark')
    mark.className = index % 2 === 0 ? 'even' : 'odd'
    mark.textContent = textOf(match.start, match.end)
    fragment.append(mark)
    position = match.end
  })
  fragment.append(textOf(position, Math.min(textLength, codePoints.length)))
  if (codePoints.length > textLength) {
    const past = document.createElement('span')
    past.className = 'past-capacity'
    past.textContent = textOf(textLength, codePoints.length)
    fragment.append(past)
  }
  matchesView.replaceChildren(fragment)
}

let dataSearch: ReturnType<typeof createDataSearch> | undefined
let dataBuildMs = 0
let builtIn: {pattern: string, search: ReturnType<typeof createBuiltInSearch>} | undefined
const frames: FrameTiming[] = []
window.regexSearchFrames = frames

let pendingKind: FrameTiming['kind'] | null = null
let firstInputTime = 0
let scheduledFrame: number | null = null
function schedule(kind: FrameTiming['kind']) {
  if (pendingKind === null) {
    pendingKind = kind
    firstInputTime = performance.now()
  }
  scheduledFrame ??= requestAnimationFrame(render)
}

function render() {
  scheduledFrame = null
  const kind = pendingKind ?? 'text'
  pendingKind = null
  const inputTime = firstInputTime
  const frameStart = performance.now()
  const codePoints = codePointsOf(textArea.value)
  const searched = codePoints.slice(0, textLength)
  const timing: FrameTiming = {kind, evaluated: false, compilePatternMs: 0, programMs: 0, evaluateMs: 0, domMs: 0, callbackMs: 0}
  const finish = () => {
    timing.callbackMs = performance.now() - frameStart
    frames.push(timing)
    requestAnimationFrame(() => {
      timing.inputToNextFrameMs = performance.now() - inputTime
    })
  }
  const pastCapacity = codePoints.length > textLength ? ` The text has ${count(codePoints.length)} code points, and the program searches the first ${count(textLength)}.` : ''
  // Form (a)'s program is the same for every pattern, so every frame shows its size.
  const dataProgram = dataSearch === undefined ? '' : ` Program: ${programSize(dataSearch.built.circuit)}, built and compiled once in ${milliseconds(dataBuildMs)}.`
  // A frame that doesn't evaluate: the message, and a status line with the automaton's size when the pattern compiled.
  const showNoMatches = (message: string, compiled: CompiledPattern | undefined) => {
    errorLine.textContent = `${message}. No matches are shown.`
    statusLine.textContent = `No matches.${compiled === undefined ? '' : ` ${automatonSize(compiled)}`}${dataProgram}${pastCapacity}`
    writeMatches(codePoints, [])
    finish()
  }

  let compiled: CompiledPattern
  try {
    compiled = compilePattern(patternInput.value)
  } catch (error) {
    if (!(error instanceof PatternSyntaxError)) throw error
    showNoMatches(`${error.message}, at code point ${error.position + 1}`, undefined)
    return
  }
  const afterPattern = performance.now()
  timing.compilePatternMs = afterPattern - frameStart

  // Both forms hold at most S states, 16 classes and 32 class boundaries, so form (b) never builds a program for a
  // pattern larger than that, e.g. a pasted pattern of 400 literal characters.
  const errors = capacityErrors(compiled, capacity)
  if (errors.length > 0) {
    showNoMatches(errors.map(error => error.message).join('; '), compiled)
    return
  }
  if (dataSearch !== undefined) {
    dataSearch.setPattern(compiled)
  } else if (builtIn?.pattern !== compiled.pattern) {
    builtIn = {pattern: compiled.pattern, search: createBuiltInSearch(compiled, textLength)}
  }
  const afterProgram = performance.now()
  timing.programMs = afterProgram - afterPattern

  const output = dataSearch !== undefined ? dataSearch.run(searched) : builtIn!.search.run(searched)
  const afterEvaluation = performance.now()
  timing.evaluateMs = afterEvaluation - afterProgram
  timing.evaluated = true

  const matches = matchesFromBits(output.highlighted, output.starts)
  writeMatches(codePoints, matches)
  errorLine.textContent = ''
  statusLine.textContent = dataSearch !== undefined
    ? `${count(matches.length)} matches. ${automatonSize(compiled)}${dataProgram} This frame: pattern written in ${milliseconds(timing.programMs)}, evaluation ${milliseconds(timing.evaluateMs)}.${pastCapacity}`
    : `${count(matches.length)} matches. ${automatonSize(compiled)} Program for this pattern: ${programSize(builtIn!.search.built.circuit)}. This frame: ${timing.programMs > 0.5 ? `built and compiled in ${milliseconds(timing.programMs)}, ` : ''}evaluation ${milliseconds(timing.evaluateMs)}.${pastCapacity}`
  timing.domMs = performance.now() - afterEvaluation
  finish()
}

// Let the page paint "Building the program…" before building.
requestAnimationFrame(() => setTimeout(() => {
  if (form === 'data') {
    const started = performance.now()
    dataSearch = createDataSearch(capacity)
    dataBuildMs = performance.now() - started
  }
  patternInput.addEventListener('input', () => schedule('pattern'))
  textArea.addEventListener('input', () => schedule('text'))
  pendingKind = 'first'
  render()
  window.regexSearchReady = true
}, 0))
