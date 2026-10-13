// The page: a pattern field, three selects, and one text that is edited in place, with a transparent textarea over the
// text and the matches drawn as rectangles behind it. Listeners only record input and schedule a frame. A frame reads
// the DOM, builds a program when the selects ask for another one, evaluates once when the pattern, the text or the
// program changed, and writes the DOM from the output numbers.
// Query parameters pick the program, e.g. ?form=builtin&states=32&text=1024, and ?pattern= sets the starting pattern.
import {type Wire, invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type BuiltInSearch, buildBuiltInSearch} from './builtin-program.ts'
import {type DataSearch, buildDataSearch, writePattern} from './data-program.ts'
import {type Match, matchesFromBits, writeText} from './host.ts'
import {type CapacityError, type CompiledPattern, PatternSyntaxError, capacityErrors, compilePattern} from './pattern.ts'

// What one frame took, for browser-frame.ts. evaluated is false when the pattern didn't compile or didn't fit, and when
// the page refused to build the program. The first frame, which renders the starting pattern, has kind 'first', and a
// frame after a change of a select has kind 'program'. Both include building form (a)'s program in callbackMs.
export type FrameTiming = {
  kind: 'first' | 'program' | 'pattern' | 'text'
  evaluated: boolean
  compilePatternMs: number
  // Form (a): writing the pattern into cells. Form (b): building and compiling the program for a new pattern.
  programMs: number
  evaluateMs: number
  // The DOM writes, including the layout that the matches' rectangles are read from.
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

// What the three selects choose: form (a), one program that reads the pattern from cells, or form (b), a program built
// for each pattern, and how many states and code points the program holds.
type Choice = {form: 'data' | 'builtin', states: number, textLength: number}

const stateChoices = [8, 12, 16, 32]
const textLengthChoices = [256, 512, 768, 1024]
// Form (a) at 12 states and 768 code points. The starting pattern, (the|an?) [a-z]+, has 8 states, so 4 more atoms
// fit, and the starting text has 741 code points. Measured in Chrome 155 on an Apple M5 Max on October 13, 2026: the
// page is ready about 0.6 s after the navigation starts and holds about 170 MB of JavaScript heap, where 16 states and
// 1,024 code points take 1.3 s and 364 MB.
const defaultChoice: Choice = {form: 'data', states: 12, textLength: 768}
const classes = 16
const boundaries = 32

// Form (a)'s operations after compiling: 2S² + 4S + 71 per code point, which README.md derives, less 3S(S + 1) at the
// ends of the text. The compiled programs have exactly this many at the 13 choices that the page builds, e.g. 312,108
// at 12 states and 768 code points, and README.md's 2,297,760 at 32 states and 1,024.
const dataOperations = ({states, textLength}: Choice) => textLength * (2 * states * states + 4 * states + 71) - 3 * states * (states + 1)
// The page refuses to build a larger form (a). In Chrome 155 on an Apple M5 Max, a build held the main thread for about
// 1.9 µs and left about 0.55 KB of heap per operation, e.g. 1.28 s and 364 MB at 661,712 operations, so 1 million
// operations are about 2 s and 550 MB.
const maximumOperations = 1_000_000

function choiceOf(form: string | null, states: string | null, textLength: string | null): Choice {
  return {
    form: form === 'builtin' || form === 'data' ? form : defaultChoice.form,
    states: stateChoices.includes(Number(states)) ? Number(states) : defaultChoice.states,
    textLength: textLengthChoices.includes(Number(textLength)) ? Number(textLength) : defaultChoice.textLength,
  }
}

// The query string for a choice, e.g. states=16&text=1024. A default is left out, and other parameters stay, e.g.
// pattern.
function queryOf(search: string, choice: Choice): string {
  const params = new URLSearchParams(search)
  const entries = [['form', choice.form, defaultChoice.form], ['states', choice.states, defaultChoice.states], ['text', choice.textLength, defaultChoice.textLength]] as const
  for (const [name, value, defaultValue] of entries) {
    if (value === defaultValue) params.delete(name)
    else params.set(name, String(value))
  }
  return params.toString()
}

type Program = {
  // The selects' choice that the program was built for, e.g. 'data 12 768'.
  choiceKey: string
  // Form (b): the pattern in the program's operations. Form (a): null, since a pattern is written into cells.
  pattern: string | null
  // Form (a)'s cells and capacity, for writePattern. null in form (b).
  patternCells: DataSearch | null
  textCells: readonly Wire[]
  source: Float32Array
  validate: (source: Float32Array) => void
  // Returns the highlighted bits, then the start bits, then the match count. The next call overwrites the array.
  evaluate: (source: Float32Array) => Float32Array
  // The compiled program's operations and layers, and the time to build and compile them.
  operations: number
  layers: number
  buildMs: number
}

// Compiles a built search. cells.ts's createEvaluator would compile the same operations, but keeps the compiled
// program to itself, and the page shows that program's size.
function compileProgram(built: DataSearch | BuiltInSearch, startedAt: number, identity: Pick<Program, 'choiceKey' | 'pattern' | 'patternCells'>): Program {
  const {circuit, output} = built
  const tensorProgram = circuit.compileTensorProgram([...output.highlighted, ...output.starts, output.matchCount])
  const evaluate = circuit.createTensorProgramEvaluator(tensorProgram)
  return {
    ...identity,
    textCells: built.cells.text,
    source: new Float32Array(built.initialSource),
    validate: built.validate,
    evaluate,
    operations: tensorProgram.valueCount - tensorProgram.sourceSize,
    layers: tensorProgram.layers.length,
    buildMs: performance.now() - startedAt,
  }
}

function buildDataProgram(choice: Choice, choiceKey: string): Program {
  const startedAt = performance.now()
  const built = buildDataSearch({states: choice.states, classes, boundaries, textLength: choice.textLength})
  return compileProgram(built, startedAt, {choiceKey, pattern: null, patternCells: built})
}

function buildBuiltInProgram(compiled: CompiledPattern, choice: Choice, choiceKey: string): Program {
  const startedAt = performance.now()
  const built = buildBuiltInSearch(compiled, choice.textLength)
  return compileProgram(built, startedAt, {choiceKey, pattern: compiled.pattern, patternCells: null})
}

// The first `capacity` code points of the text, which the program reads, and the text's length in code points.
// offsets[index] is where code point `index` starts in the string, in UTF-16 code units, e.g. [0, 1, 3] for 'a😀',
// and the last entry is where the code points that the program reads end.
function readText(text: string, capacity: number) {
  const codePoints: number[] = []
  const offsets = [0]
  let length = 0
  for (let offset = 0; offset < text.length; length++) {
    const codePoint = text.codePointAt(offset)!
    offset += codePoint > 0xffff ? 2 : 1
    if (length < capacity) {
      codePoints.push(codePoint)
      offsets.push(offset)
    }
  }
  return {codePoints, offsets, length}
}

// A line of text for the page. A strong part is drawn bold, e.g. the number in "28 matches".
type Line = readonly (string | {readonly strong: string})[]
const strong = (text: string) => ({strong: text})

const count = (value: number) => value.toLocaleString('en-US')
// Chrome's performance.now() reads in steps of 0.1 ms on this page, so a short time gets one decimal. The space
// before the unit doesn't break, so a line never ends between a number and its unit.
const duration = (ms: number) => ms >= 995 ? `${(ms / 1000).toFixed(1)}\u00a0s` : ms >= 9.95 ? `${Math.round(ms)}\u00a0ms` : `${ms.toFixed(1)}\u00a0ms`

// One sentence per capacity that a pattern exceeds.
function limitSentence({reason, needed, capacity}: CapacityError): string {
  switch (reason) {
    case 'states':
      return `This pattern needs ${count(needed)} states, and the program holds ${capacity}.`
    case 'classes':
      return `This pattern tells ${count(needed)} classes of characters apart, and the program holds ${capacity}.`
    case 'boundaries':
      return `This pattern’s classes of characters change at ${count(needed)} places, and the program holds ${capacity}.`
  }
}

// What a frame draws: the text, the matches in it, and the lines around it.
type View = {
  text: string
  // readText's offsets for the code points that the program reads.
  offsets: readonly number[]
  matches: readonly Match[]
  statusState: 'busy' | 'bad' | 'ok'
  status: Line
  // The text's length against the capacity, e.g. "741 of 768 characters", and whether the text is longer.
  capacity: Line
  overCapacity: boolean
  // The statistics: what the program is, and how long building it and the last search took.
  statsProgram: Line
  statsTimes: Line
  fitStates: Line
  fitClasses: Line
  fitBoundaries: Line
  fitNumbers: Line
  fitNumbersNote: Line
}

function mountRegexSearch(document: Document, window: Window) {
  const find = <Found extends Element>(selector: string): Found => {
    const node = document.querySelector<Found>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  // A node that shows a Line. The status is a live region, which a screen reader reads again when it is rewritten, and
  // a reader may select the numbers of the other lines, so `written` holds the line the node shows, and a frame
  // rewrites the node only when the line changes.
  const lineNode = (selector: string) => ({node: find<HTMLElement>(selector), written: ''})

  const textBlock = find<HTMLElement>('#matches')
  const textNode = textBlock.firstChild
  invariant(textNode instanceof Text && textNode.nextSibling === null, '#matches holds the starting text and nothing else')

  const domCache = {
    pattern: find<HTMLInputElement>('#pattern'), // mount lifetime
    tryList: find<HTMLElement>('.try'), // mount lifetime
    form: find<HTMLSelectElement>('#form'), // mount lifetime
    states: find<HTMLSelectElement>('#states'), // mount lifetime
    textLength: find<HTMLSelectElement>('#text-length'), // mount lifetime
    status: find<HTMLElement>('#status'), // mount lifetime
    statusLine: lineNode('#status > span'), // mount lifetime
    capacity: lineNode('#capacity'), // mount lifetime
    // The text under the textarea: one text node and no other node, so both break their lines at the same places.
    // Setting a text node's data lays the text out again, so `written` holds the data, and a frame sets it only when
    // the text changes.
    text: textBlock, // mount lifetime
    textNode: {node: textNode, written: textNode.data}, // mount lifetime
    textarea: find<HTMLTextAreaElement>('#text'), // mount lifetime
    // One rectangle per match and line, behind the text. A frame that draws replaces all of them: they hold no focus
    // and no selection, since the textarea above them takes every pointer and key.
    marks: find<HTMLElement>('#marks'), // mount lifetime; its children live for one drawn frame
    // The fade over the text that the program doesn't read, and the bar where that text starts.
    veil: find<HTMLElement>('#veil'), // mount lifetime; its children live for one drawn frame
    statsProgram: lineNode('#stats-program'), // mount lifetime
    statsTimes: lineNode('#stats-times'), // mount lifetime
    fitStates: lineNode('#fit-states'), // mount lifetime
    fitClasses: lineNode('#fit-classes'), // mount lifetime
    fitBoundaries: lineNode('#fit-boundaries'), // mount lifetime
    fitNumbers: lineNode('#fit-numbers'), // mount lifetime
    fitNumbersNote: lineNode('#fit-numbers-note'), // mount lifetime
  }
  const lineHeight = Number.parseFloat(window.getComputedStyle(textBlock).lineHeight)

  function writeLine(target: {node: HTMLElement, written: string}, line: Line) {
    const key = JSON.stringify(line)
    if (target.written === key) return
    target.written = key
    target.node.replaceChildren(...line.map(part => {
      if (typeof part === 'string') return part
      const bold = document.createElement('b')
      bold.textContent = part.strong
      return bold
    }))
  }

  // Gives the pattern field the focus, with the caret at the pattern's end, so the next keystroke edits the pattern.
  function focusPattern() {
    domCache.pattern.focus({preventScroll: true})
    domCache.pattern.setSelectionRange(domCache.pattern.value.length, domCache.pattern.value.length)
  }

  function createBox(className: string, left: number, top: number, width: number, height: number) {
    const box = document.createElement('i')
    box.className = className
    box.style.cssText = `left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px`
    return box
  }

  const frames: FrameTiming[] = []
  window.regexSearchFrames = frames

  const initialParams = new URLSearchParams(window.location.search)
  const initialChoice = choiceOf(initialParams.get('form'), initialParams.get('states'), initialParams.get('text'))

  const st = {
    // The program the page holds. null before the first build, while the page announces a build, when the page
    // refuses the choice, and in form (b) until a pattern fits.
    program: null as Program | null,
    // The choice whose "Building the program…" the last frame drew. The frame after that one builds the program, so
    // the announcement is on the screen while the build holds the main thread.
    announced: null as string | null,
    // The last frame that drew: its inputs, the width its text wrapped in, and what it drew. A frame with the same
    // inputs and width returns at once, e.g. the frame after each search, which only completes the search's timing,
    // and a frame with another width only draws again, e.g. while the window is resized.
    drawn: null as {pattern: string, text: string, choiceKey: string, building: boolean, width: number, view: View} | null,
    // The last search: its inputs, its matches, which stay on the screen while another program is built, and how
    // long writing the cells and evaluating took.
    lastSearch: null as {pattern: string, text: string, matches: Match[], ms: number} | null,
    // The last frame's timing, which the next frame's callback completes, and the time of that frame's first input.
    openTiming: null as {timing: FrameTiming, inputTime: number} | null,
    // The query string that the address bar shows.
    query: queryOf(window.location.search, initialChoice),
    events: {
      // The first input since the last frame that searched: its time and what it changed.
      firstInputTime: null as number | null,
      kind: null as FrameTiming['kind'] | null,
      // The example of the Try line that was clicked.
      tryPattern: null as string | null,
    },
  }

  let scheduledRaf: number | null = null
  function scheduleRender() {
    if (scheduledRaf !== null) return
    scheduledRaf = window.requestAnimationFrame(function renderAndMaybeScheduleAnotherRender() {
      scheduledRaf = null
      if (render()) scheduleRender()
    })
  }

  // The frame's work between the DOM reads and the DOM writes, for a frame whose pattern, text or choice changed:
  // the program, the search, and what the page shows. Changes no state: render commits what this returns.
  function search(pattern: string, text: string, choice: Choice, choiceKey: string, frameStart: number) {
    const {codePoints, offsets, length} = readText(text, choice.textLength)
    const overCapacity = length > choice.textLength

    // The pattern: its automaton, or the sentences that say why there is none or why it doesn't fit.
    let compiled: CompiledPattern | null = null
    let problem: string | null = null
    try {
      compiled = compilePattern(pattern)
    } catch (error) {
      if (!(error instanceof PatternSyntaxError)) throw error
      problem = `Character ${count(error.position + 1)} of the pattern: ${error.message}.`
    }
    const afterPattern = window.performance.now()
    // Both forms hold at most S states, 16 classes and 32 class boundaries, so form (b) never builds a program for a
    // pattern larger than that, e.g. a pasted pattern of 400 literal characters.
    const limitErrors = compiled === null ? [] : capacityErrors(compiled, {states: choice.states, classes, boundaries})
    if (limitErrors.length > 0) problem = limitErrors.map(limitSentence).join(' ')
    const fitting = limitErrors.length === 0 ? compiled : null

    // The program. Another choice releases the program the page holds before anything is built, so the page never
    // holds two, e.g. 364 MB next to 321 MB.
    const refused = choice.form === 'data' && dataOperations(choice) > maximumOperations
    let program = st.program !== null && st.program.choiceKey === choiceKey ? st.program : null
    let build: (() => Program) | null = null
    if (refused) {
      build = null
    } else if (choice.form === 'data') {
      if (program === null) build = () => buildDataProgram(choice, choiceKey)
    } else if (fitting !== null && program?.pattern !== pattern) {
      build = () => buildBuiltInProgram(fitting, choice, choiceKey)
    }
    // A build for another choice of the selects waits one frame, which draws "Building the program…". A new pattern in
    // form (b) is built at once: its build is part of every keystroke, and the statistics line says how long it took.
    const building = build !== null && program === null && st.announced !== choiceKey
    let programMs = 0
    if (build !== null && !building) {
      program = build()
      if (choice.form === 'builtin') programMs = program.buildMs
    }
    const afterProgram = window.performance.now()

    // The search: the pattern's cells in form (a), the text's cells, and one evaluation.
    let found: {matches: Match[], evaluateMs: number} | null = null
    let afterEvaluation = afterProgram
    if (!building && program !== null && fitting !== null && (program.pattern === null || program.pattern === pattern)) {
      let afterPatternCells = afterProgram
      if (program.patternCells !== null) {
        writePattern(program.source, program.patternCells, fitting)
        afterPatternCells = window.performance.now()
        programMs = afterPatternCells - afterProgram
      }
      writeText(program.source, program.textCells, codePoints)
      program.validate(program.source)
      const values = program.evaluate(program.source)
      afterEvaluation = window.performance.now()
      const matches = matchesFromBits(Array.from(values.subarray(0, choice.textLength)), Array.from(values.subarray(choice.textLength, 2 * choice.textLength)))
      invariant(values[2 * choice.textLength] === matches.length, `the program counted ${values[2 * choice.textLength]} matches, and its bits hold ${matches.length}`)
      found = {matches, evaluateMs: afterEvaluation - afterPatternCells}
    }

    // What the page shows. While a program is being built, the last search's matches stay when they are for the same
    // pattern and text.
    let matches: readonly Match[] = []
    if (found !== null) matches = found.matches
    else if (building && st.lastSearch !== null && st.lastSearch.pattern === pattern && st.lastSearch.text === text) {
      matches = st.lastSearch.matches.filter(match => match.end <= codePoints.length)
    }

    let statusState: View['statusState']
    let status: Line
    if (building) {
      statusState = 'busy'
      status = ['Building the program…']
    } else if (refused) {
      statusState = 'bad'
      status = [`The page doesn’t build this program: ${choice.states} states and ${count(choice.textLength)} characters need about ${(dataOperations(choice) / 1e6).toFixed(1)} million operations, and building them would freeze the tab for seconds and take more than half a gigabyte of memory.`]
    } else if (problem !== null) {
      statusState = 'bad'
      status = [problem]
    } else {
      invariant(found !== null, 'a pattern that fits is searched')
      statusState = 'ok'
      status = found.matches.length === 0 ? ['No matches'] : [strong(count(found.matches.length)), found.matches.length === 1 ? ' match' : ' matches']
      // A text longer than the capacity is searched up to the capacity, and the result line says so.
      if (overCapacity) status = [...status, ' in the first ', strong(count(choice.textLength)), ' characters']
    }

    // The statistics' two sentences. Without a program to describe, the first one says what the page does instead,
    // and there is no second one.
    const searchMs = found?.evaluateMs ?? st.lastSearch?.ms
    const timesOf = (built: Program): Line => searchMs === undefined
      ? ['Building it took ', strong(duration(built.buildMs)), '.']
      : ['Building it took ', strong(duration(built.buildMs)), ', and the last search took ', strong(duration(searchMs)), '.']
    let statsProgram: Line
    let statsTimes: Line = []
    if (refused) {
      statsProgram = ['Choose fewer states or a smaller text capacity, or let the page build a program for each pattern.']
    } else if (choice.form === 'data') {
      if (program === null) {
        statsProgram = [`The page is building one program that searches for every pattern of up to ${choice.states} states in up to ${count(choice.textLength)} characters.`]
      } else {
        statsProgram = ['One program of ', strong(count(program.operations)), ' operations in ', strong(count(program.layers)), ' layers searches for every pattern.']
        statsTimes = timesOf(program)
      }
    } else if (program !== null && program.pattern === pattern) {
      statsProgram = ['This pattern has a program of its own, of ', strong(count(program.operations)), ' operations in ', strong(count(program.layers)), ' layers.']
      statsTimes = timesOf(program)
    } else {
      statsProgram = [building ? 'The page is building a program for this pattern.' : 'The page builds a program for each pattern that has no error and fits.']
    }

    const of = (used: number, held: number): Line => [strong(count(used)), ` of ${count(held)}`]
    const none: Line = ['none']
    // Form (a)'s cells that writePattern writes: the boundaries, the class of each region, a transition bit per class
    // and pair of states, and an accepting bit per state.
    const patternCellCount = boundaries + (boundaries + 1) + classes * choice.states * choice.states + choice.states
    const view: View = {
      text,
      offsets,
      matches,
      statusState,
      status,
      capacity: [strong(count(length)), ` of ${count(choice.textLength)} characters`],
      overCapacity,
      statsProgram,
      statsTimes,
      fitStates: compiled === null ? none : of(compiled.automaton.stateCount, choice.states),
      fitClasses: compiled === null ? none : of(compiled.partition.classCount, classes),
      fitBoundaries: compiled === null ? none : of(compiled.partition.boundaries.length, boundaries),
      fitNumbers: choice.form === 'data' ? [strong(count(patternCellCount))] : none,
      fitNumbersNote: choice.form === 'data'
        ? ['The pattern as the program reads it: the class of every character, and for each class which state follows which. A new pattern writes these numbers again and changes no operation.']
        : ['The pattern is built into the operations, so the program reads only the text.'],
    }
    return {view, program, building, found, compilePatternMs: afterPattern - frameStart, programMs, afterEvaluation}
  }

  function render(): boolean {
    const frameStart = window.performance.now()
    if (st.openTiming !== null) {
      st.openTiming.timing.inputToNextFrameMs = frameStart - st.openTiming.inputTime
      st.openTiming = null
    }

    // DOM reads. The pattern, the text and the selects' values are state that the browser keeps.
    const typedPattern = domCache.pattern.value
    const text = domCache.textarea.value
    const choice = choiceOf(domCache.form.value, domCache.states.value, domCache.textLength.value)
    const {pathname, search: locationSearch, hash} = window.location
    // The width that the text wraps in. When it changes, e.g. while the window is resized, the matches move.
    const width = domCache.text.clientWidth
    // A click on an example moves the focus to the pattern field where there is a mouse and a keyboard. On a phone
    // the focus would open the keyboard over the matches that the click asked for.
    const focusAfterExample = st.events.tryPattern !== null && window.matchMedia('(pointer: fine)').matches

    // Inputs.
    const pattern = st.events.tryPattern ?? typedPattern
    const choiceKey = `${choice.form} ${choice.states} ${choice.textLength}`
    const drawn = st.drawn
    const drawnInputs = drawn !== null && !drawn.building && drawn.pattern === pattern && drawn.text === text && drawn.choiceKey === choiceKey ? drawn : null
    if (drawnInputs !== null) {
      // Nothing to search, so the events since the last frame changed nothing, e.g. a click on the example that the
      // pattern field already holds.
      st.events.firstInputTime = null
      st.events.kind = null
      st.events.tryPattern = null
      if (drawnInputs.width === width && pattern === typedPattern) {
        if (focusAfterExample) focusPattern()
        return false
      }
    }
    const searched = drawnInputs === null ? search(pattern, text, choice, choiceKey, frameStart) : null
    const view = searched?.view ?? drawnInputs?.view
    invariant(view !== undefined, 'a frame draws a search or the last drawn frame again')
    const domStart = searched?.afterEvaluation ?? frameStart

    // DOM writes.
    // A textarea shows an empty last line after a trailing line feed, and a block of text doesn't, so the block gets
    // a space there, which keeps both the same height.
    const shownText = view.text.endsWith('\n') ? `${view.text} ` : view.text
    if (domCache.textNode.written !== shownText) domCache.textNode.node.data = domCache.textNode.written = shownText
    domCache.status.className = `status ${view.statusState}`
    writeLine(domCache.statusLine, view.status)
    domCache.capacity.node.className = view.overCapacity ? 'capacity over' : 'capacity'
    writeLine(domCache.capacity, view.capacity)
    writeLine(domCache.statsProgram, view.statsProgram)
    writeLine(domCache.statsTimes, view.statsTimes)
    writeLine(domCache.fitStates, view.fitStates)
    writeLine(domCache.fitClasses, view.fitClasses)
    writeLine(domCache.fitBoundaries, view.fitBoundaries)
    writeLine(domCache.fitNumbers, view.fitNumbers)
    writeLine(domCache.fitNumbersNote, view.fitNumbersNote)
    if (pattern !== typedPattern) domCache.pattern.value = pattern

    // DOM reads again, after the text is written: where the browser put each match. The text is one text node, so
    // that it wraps exactly like the textarea's text, and a match is drawn as rectangles behind the text instead of
    // an element around its characters. An element in the text moves the line breaks: in Chrome, a paragraph with
    // marks around half its words broke differently from the same paragraph without them at 198 of 4,001 widths.
    const range = document.createRange()
    const marksOrigin = domCache.marks.getBoundingClientRect()
    const marks: HTMLElement[] = []
    view.matches.forEach((match, index) => {
      range.setStart(domCache.textNode.node, view.offsets[match.start]!)
      range.setEnd(domCache.textNode.node, view.offsets[match.end]!)
      // One box per line that the match is on. The browser may return several rectangles for one line, e.g. Chrome
      // returns the space before a line break by itself, so rectangles that touch on one line become one box.
      const lines: {left: number, top: number, right: number, bottom: number}[] = []
      for (const {left, top, right, bottom} of range.getClientRects()) {
        if (right === left) continue
        const line = lines.at(-1)
        if (line !== undefined && Math.abs(top - line.top) < 1 && left - line.right < 1) line.right = Math.max(line.right, right)
        else lines.push({left, top, right, bottom})
      }
      // A mark is 2 px taller than its text on both sides.
      for (const {left, top, right, bottom} of lines) {
        marks.push(createBox(index % 2 === 0 ? 'even' : 'odd', left - marksOrigin.left, top - marksOrigin.top - 2, right - left, bottom - top + 4))
      }
    })
    const veil: HTMLElement[] = []
    const readEnd = view.offsets[view.offsets.length - 1]!
    if (readEnd < view.text.length) {
      // The first character that the program doesn't read: the fade covers the rest of its line, and every line below.
      range.setStart(domCache.textNode.node, readEnd)
      range.setEnd(domCache.textNode.node, readEnd + (view.text.codePointAt(readEnd)! > 0xffff ? 2 : 1))
      const first = range.getClientRects()[0]
      if (first !== undefined) {
        const veilOrigin = domCache.veil.getBoundingClientRect()
        const left = first.left - veilOrigin.left
        const lineTop = first.top + first.height / 2 - lineHeight / 2 - veilOrigin.top
        // The bar comes last, so it lies over the fade.
        veil.push(
          createBox('past', left, lineTop, veilOrigin.width - left, lineHeight),
          createBox('past', 0, lineTop + lineHeight, veilOrigin.width, Math.max(0, veilOrigin.height - lineTop - lineHeight)),
          createBox('cut', left - 1, lineTop, 2, lineHeight),
        )
      }
    }

    // DOM writes again.
    domCache.marks.replaceChildren(...marks)
    domCache.veil.replaceChildren(...veil)
    const afterDom = window.performance.now()

    // Side effects: the focus, and below, the address bar.
    if (focusAfterExample) focusPattern()
    if (searched === null) {
      // The same inputs at another width, where only the rectangles moved, or an example put back into a field that
      // was edited in the same frame.
      invariant(drawnInputs !== null, 'a frame that didn\'t search draws the last frame again')
      st.drawn = {...drawnInputs, width}
      return false
    }

    // The selects' choice goes into the address bar, so a reload or a copied link builds the same program.
    const query = queryOf(locationSearch, choice)
    if (query !== st.query) window.history.replaceState(null, '', `${pathname}${query === '' ? '' : `?${query}`}${hash}`)

    // Commit.
    const {program, building, found} = searched
    st.program = program
    st.announced = building ? choiceKey : null
    st.drawn = {pattern, text, choiceKey, building, width, view}
    st.query = query
    st.events.tryPattern = null
    if (found !== null) st.lastSearch = {pattern, text, matches: found.matches, ms: found.evaluateMs}
    if (!building) {
      const timing: FrameTiming = {
        kind: frames.length === 0 ? 'first' : st.events.kind ?? 'text',
        evaluated: found !== null,
        compilePatternMs: searched.compilePatternMs,
        programMs: searched.programMs,
        evaluateMs: found?.evaluateMs ?? 0,
        domMs: afterDom - domStart,
        callbackMs: afterDom - frameStart,
      }
      frames.push(timing)
      st.openTiming = {timing, inputTime: st.events.firstInputTime ?? 0}
      st.events.firstInputTime = null
      st.events.kind = null
      window.regexSearchReady = true
    }
    // The next frame builds the announced program, or completes this frame's timing.
    return true
  }

  const recordInput = (kind: FrameTiming['kind']) => (event: Event) => {
    st.events.firstInputTime ??= event.timeStamp
    st.events.kind ??= kind
    scheduleRender()
  }
  domCache.pattern.addEventListener('input', recordInput('pattern'))
  domCache.textarea.addEventListener('input', recordInput('text'))
  for (const select of [domCache.form, domCache.states, domCache.textLength]) select.addEventListener('change', recordInput('program'))
  domCache.tryList.addEventListener('click', event => {
    const example = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pattern]') : null
    if (example === null) return
    st.events.tryPattern = example.dataset['pattern'] ?? null
    recordInput('pattern')(event)
  })
  // The text wraps again when its width changes. A window resize is handled in its own frame, and the observer covers
  // every other cause one frame late, e.g. a scrollbar that appears.
  window.addEventListener('resize', scheduleRender)
  new ResizeObserver(scheduleRender).observe(domCache.text)

  const initialPattern = initialParams.get('pattern')
  if (initialPattern !== null) domCache.pattern.value = initialPattern
  domCache.form.value = initialChoice.form
  domCache.states.value = String(initialChoice.states)
  domCache.textLength.value = String(initialChoice.textLength)
  // The page's HTML holds the starting text under the textarea, so the first paint shows it before this script runs.
  domCache.textarea.value = domCache.textNode.written
  // Where there is a mouse and a keyboard, the page starts with the caret in the pattern field.
  if (window.matchMedia('(pointer: fine)').matches) focusPattern()
  scheduleRender()
}

mountRegexSearch(document, window)
