// The page: a pattern field, a select for what the search reads, a map with one mark per document, the selected
// document drawn as code, and a comparison measured in the page. searcher.ts does the work: the JSON highlighter once
// per document at load, and regex search once per document at each keystroke, both on the GPU, or on the CPU for a
// few hundred documents where there is no WebGPU.
//
// Listeners only record input and schedule a frame. A frame reads the DOM, takes in what arrived since the last
// frame, e.g. a search's result, decides what the page shows, writes the DOM and the canvas, and last starts the one
// piece of work that is due, e.g. a search for the pattern in the field. A result arrives from a promise after the
// frame that asked for it, is recorded, and is an input of the next frame. One piece of work is in flight at a time.
//
// Query parameters, for looking at the page's other states: ?pattern= and ?scope= set the starting search,
// ?documents=20000 loads another count, ?backend=cpu runs the CPU version, ?buffer=134217728 asks the GPU for buffers
// of at most that many bytes, as a device with small limits would grant, and ?simulate=check-failure treats the self
// check as failed.
import {capacity as positions} from '../../src/json-highlighter/kinds.ts'
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type Baselines, createBaselines} from './demo-baselines.ts'
import {
  type MapLayout, type MapOrder, type MarkColors, groupDocuments, labelBandCss, mapGrid, mapLayout, markCenterCss, markOffsets, matchesByGroup,
  nextDocumentWithMatch, nominalGroupSizes, paintMarks, positionAt,
} from './demo-map.ts'
import {
  type CheckState, type Line, type LoadReason, type PatternAnalysis, type ScopeChoice, analyzePattern, checkLine, comparisonCells, comparisonVerdict,
  count, cpuDocumentCount, documentLine, documentRuns, documentsThatFit, duration, groupNames, loadNotice, megabytes, notValidLine, operationsPerPosition, programLines,
  resultLine, runClassName, scopeChoiceOf, scopeChoices, strong, validitySentence, wantedDocumentCount,
} from './demo-text.ts'
import {defaultSeed, documentAt, shapes} from './documents.ts'
import {requestBatchDevice} from './gpu/host.ts'
import {cellsPerDocument, writeDocumentCells} from './program.ts'
import {type DocumentWindow, type ProgramDescription, type Searcher, type SelfCheck, bufferBytesFor, createCpuSearcher, createGpuSearcher, defaultSelfCheckSearches} from './searcher.ts'

// What one search took on its way to the screen, for scripts that measure the page.
export type SearchTiming = {
  pattern: string
  scope: string
  states: number
  matches: number
  documentsWithMatches: number
  // When the frame that painted the result ended, in ms since the page's navigation started.
  paintedAt: number
  // The searcher's own time for the search.
  searchMs: number
  // Painting every mark of the map into the canvas.
  paintMs: number
  // From the first input event since the last frame to the frame after the one that painted the result.
  inputToNextFrameMs?: number
}
export type JsonSearchDebug = {
  ready: boolean
  backend: 'gpu' | 'cpu' | null
  documentCount: number
  // The slices that wrote the documents while the page loaded, each in ms of work on the main thread.
  loadBlocks: number[]
  loadMs: {writeDocuments: number, writeCells: number, createSearcher: number, total: number} | null
  // The searches whose results were painted, the latest 1,000, and each repaint of the map in ms.
  searches: SearchTiming[]
  paints: number[]
  check: CheckState
  // Where a document's mark is in the window, in CSS px, or null before the documents exist.
  locate: (index: number) => {x: number, y: number} | null
}

declare global {
  interface Window {
    jsonSearch?: JsonSearchDebug
  }
}

// What the page searches: the documents, the searcher that holds them, and where each document is on the map.
type World = {
  id: number
  backend: 'gpu' | 'cpu'
  searcher: Searcher
  device: GPUDevice | null
  documentCount: number
  texts: readonly string[]
  // The index of each document's shape in documents.ts's shapes.
  shapeOf: Uint8Array
  order: MapOrder
  // How many documents aren't valid, and why, as a sentence.
  notValid: Line
  baselines: Baselines
  // How many documents a window of marks holds: the selected document and its neighbors by index.
  windowDocuments: number
  // In ms: writing the documents' texts, writing their characters as numbers, creating the searcher, and from the
  // page's start until the searcher existed.
  writeDocumentsMs: number
  writeCellsMs: number
  createSearcherMs: number
  readyAfterMs: number
}

// A search's answer for every document, from either searcher.
type Found = {
  key: string
  matchCounts: Float32Array
  matches: number
  documentsWithMatches: number
  states: number
  patternStates: number
  ms: number
  // How many documents of each group have a match, and the first document with a match, or -1.
  byGroup: number[]
  firstMatch: number
}
// The marks of some documents for one search: 512 per document, 0 outside a match, 1 inside one, 2 at its start.
type Marks = {key: string, firstDocument: number, documentCount: number, values: Float32Array}

// What a piece of work answers with.
type Answer =
  | {kind: 'search', key: string, found: Omit<Found, 'byGroup' | 'firstMatch'> | null, marks: Marks | null}
  | {kind: 'window', marks: Marks | null, kinds: {firstDocument: number, values: Float32Array} | null}
  | {kind: 'check', result: SelfCheck, piece: number, searchPrograms: number}
  | {kind: 'searchTime', key: string, ms: number | null}
  | {kind: 'secondPassTime', ms: number}
  | {kind: 'failed', message: string}
// What arrives between two frames: the loaded documents, the answer of the piece of work in flight, by its id, and a
// GPU device that stopped working.
type Arrival =
  | {kind: 'loaded', world: World}
  | {kind: 'answer', job: number, answer: Answer}
  | {kind: 'deviceFailed', message: string}

// A search that has been in flight this long gets a line that says so, and its map fades. A search on the GPU takes
// up to 80 ms on the programs for 8 and 16 states, and one on the CPU about 125 ms at 8 states, so those never show
// the line, which would flash at each key. A search on the program for 32 states takes about 0.9 s, and shows it.
const longSearchMs = 250
// How long after the last key the self check and the comparison start. Both work on the main thread in pieces: about
// 30 ms for a piece of the check and 8 ms for one of the comparison while the smallest search program is the only
// one. The first piece after a larger program was built also builds that program for the CPU, once, which takes up
// to 0.15 s for 32 states, so those pieces wait longer for the keys to stop.
const checkIdleMs = 200
const comparisonIdleMs = 500
const largerProgramIdleMs = 1000
// How long one piece of the comparison works in a frame, and how long the GPU rests before the page times a search
// "after a pause": README.md measured that a search after 200 ms or more of rest takes more than twice the time of
// one that follows another.
const comparisonPieceMs = 8
const gpuPauseMs = 300

const nominalOf = (documentCount: number) => nominalGroupSizes(documentCount, shapes.length)
const keyOf = (pattern: string, scope: ScopeChoice) => `${scope}\n${pattern}`
// The window of documents around one document: a few before it and the rest after it, since the documents of a block
// of the map follow each other by index, with the other groups' documents between them.
function windowAround(index: number, documentCount: number, windowDocuments: number): DocumentWindow {
  const size = Math.min(windowDocuments, documentCount)
  return {firstDocument: Math.max(0, Math.min(documentCount - size, index - (size >> 3))), documentCount: size}
}
const holds = (window: DocumentWindow, index: number) => index >= window.firstDocument && index < window.firstDocument + window.documentCount

// A pause that lets the browser handle input and paint before the next piece of work: a message to oneself, which
// arrives as a task of its own, without the 4 ms that a timer waits at least once timers follow each other.
const nextTask = () => new Promise<void>(resolve => {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    resolve()
  }
  channel.port2.postMessage(null)
})

// The same search on the CPU searcher, a few documents at a time: one call of search blocks until its documents are
// done, 0.25 ms per document at 8 states, so each piece is about 6 ms of them. Resolves to null when the page wants
// another search before this one is done. The search's time is the sum of the pieces' times, and when the first piece
// also builds the search program, that piece counts with its loops' time alone.
async function searchInPieces(searcher: Searcher, pattern: string, scope: ScopeChoice, key: string, window: DocumentWindow, programExists: boolean, isWanted: () => boolean): Promise<{found: Omit<Found, 'byGroup' | 'firstMatch'>, marks: Marks} | null> {
  const {documentCount} = searcher
  const matchCounts = new Float32Array(documentCount)
  const marks = new Float32Array(window.documentCount * positions)
  let ms = 0
  let states = 0
  let patternStates = 0
  let pieceDocuments = 4
  for (let first = 0; first < documentCount;) {
    const piece = {firstDocument: first, documentCount: Math.min(pieceDocuments, documentCount - first)}
    const result = await searcher.search({pattern, scope, window: piece, documents: 'window'})
    if (result?.status !== 'searched') return null
    matchCounts.set(result.matchCounts, first)
    for (let row = 0; row < piece.documentCount; row++) {
      if (holds(window, first + row)) marks.set(result.marks.subarray(row * positions, (row + 1) * positions), (first + row - window.firstDocument) * positions)
    }
    ms += programExists || first > 0 ? result.timings.totalMs : result.timings.evaluateMs
    states = result.states
    patternStates = result.patternStates
    first += piece.documentCount
    // The next piece holds the documents of about 6 ms, and at most 32, since a short piece's time is only known to
    // the clock's 0.1 ms.
    pieceDocuments = Math.max(1, Math.min(32, Math.round(6 * piece.documentCount / Math.max(0.1, result.timings.evaluateMs))))
    await nextTask()
    if (!isWanted()) return null
  }
  let matches = 0
  let documentsWithMatches = 0
  for (let index = 0; index < documentCount; index++) {
    matches += matchCounts[index]!
    if (matchCounts[index]! > 0) documentsWithMatches++
  }
  return {found: {key, matchCounts, matches, documentsWithMatches, states, patternStates, ms}, marks: {key, ...window, values: marks}}
}

function mountJsonSearch(document: Document, window: Window) {
  const pageStart = window.performance.now()
  const find = <Found extends Element>(selector: string): Found => {
    const node = document.querySelector<Found>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  // A node that shows a Line. `written` holds the line the node shows, and a frame rewrites the node only when the
  // line changes: a rewrite collapses a selection inside the node, and a screen reader reads a status again.
  const lineNode = (selector: string) => ({node: find<HTMLElement>(selector), written: ''})

  const canvas = find<HTMLCanvasElement>('#marks')
  const context = canvas.getContext('2d')
  invariant(context !== null, 'the canvas has no 2D context')
  const labels = find<HTMLElement>('#labels')

  const domCache = {
    pattern: find<HTMLInputElement>('#pattern'), // mount lifetime
    tryList: find<HTMLElement>('.try'), // mount lifetime
    scope: find<HTMLSelectElement>('#scope'), // mount lifetime
    notice: lineNode('#notice'), // mount lifetime
    status: find<HTMLElement>('#status'), // mount lifetime
    statusLine: lineNode('#status > span'), // mount lifetime
    timing: lineNode('#timing'), // mount lifetime
    map: find<HTMLElement>('#map'), // mount lifetime
    canvas, // mount lifetime; its pixels live until the next search's result or the next layout
    context, // mount lifetime
    // One label per group, above the group's block of marks: the group's name, and how many of its documents have a
    // match.
    groupLabels: groupNames.map(name => { // mount lifetime
      const node = labels.appendChild(document.createElement('span'))
      node.appendChild(document.createElement('span')).textContent = name
      return {node, count: {node: node.appendChild(document.createElement('b')), written: ''}, countClass: '', placed: ''}
    }),
    pointerRing: find<HTMLElement>('#pointer-ring'), // mount lifetime
    selectedRing: find<HTMLElement>('#selected-ring'), // mount lifetime
    preparing: find<HTMLElement>('#preparing'), // mount lifetime
    preparingLine: lineNode('#preparing-line'), // mount lifetime
    progress: find<HTMLElement>('#progress'), // mount lifetime
    errors: lineNode('#errors'), // mount lifetime
    documentLine: lineNode('#document-line'), // mount lifetime
    // The selected document's text: one span per run of characters that look the same. A frame replaces all of them
    // when another document or another search's marks are shown, and leaves them alone otherwise, so a selection in
    // the text stays.
    documentText: find<HTMLElement>('#document-text'), // mount lifetime; its children live until the text or its marks change
    documentStatus: find<HTMLElement>('#document-status'), // mount lifetime
    documentStatusLine: lineNode('#document-status > span'), // mount lifetime
    documentSize: lineNode('#document-size'), // mount lifetime
    previousMatch: find<HTMLButtonElement>('#previous-match'), // mount lifetime
    nextMatch: find<HTMLButtonElement>('#next-match'), // mount lifetime
    release: find<HTMLButtonElement>('#release'), // mount lifetime
    programRow: lineNode('#program-row'), // mount lifetime
    programHighlight: lineNode('#program-highlight'), // mount lifetime
    programSearch: lineNode('#program-search'), // mount lifetime
    plainHow: lineNode('#plain-how'), // mount lifetime
    plainHighlight: lineNode('#plain-highlight'), // mount lifetime
    plainSearch: lineNode('#plain-search'), // mount lifetime
    cpuRow: find<HTMLElement>('#cpu-row'), // mount lifetime
    cpuHighlight: lineNode('#cpu-highlight'), // mount lifetime
    cpuSearch: lineNode('#cpu-search'), // mount lifetime
    verdict: lineNode('#verdict'), // mount lifetime
    check: find<HTMLElement>('#check'), // mount lifetime
    checkLine: lineNode('#check > span'), // mount lifetime
    stats: {node: find<HTMLElement>('#stats'), written: ''}, // mount lifetime; one span per sentence, replaced when a sentence changes
  }
  // What the last frame wrote into the nodes that aren't lines, so a frame writes only what changed.
  const written = {
    statusClass: '', noticeDisplay: '', mapHeight: '', canvasSize: '', canvasOpacity: '', preparingDisplay: '', progress: '', pointerRing: '', selectedRing: '',
    documentKey: '', documentStatusClass: '', stepDisabled: true, releaseDisplay: '', cpuRowDisplay: '', checkClass: '',
    // The match counts of the last search whose timing is recorded.
    timedCounts: null as Float32Array | null,
  }
  // The map's layout and pixels, and the display kinds read back so far. They are caches of what the state implies,
  // and hold arrays that are too large to copy, so they sit outside the state.
  const mapCache = {
    key: '',
    layout: null as MapLayout | null,
    offsets: null as Uint32Array | null,
    image: null as ImageData | null,
    pixels: null as Uint32Array | null,
    // The match counts that the canvas shows, null for marks without matches, and undefined before the first paint.
    painted: undefined as Float32Array | null | undefined,
  }
  // The display kinds of the documents read back so far, 512 per document. Emptied when it holds 4,096 documents.
  const kindsCache = new Map<number, Float32Array>()
  // What the pattern in the field is to the page, kept from frame to frame while the pattern stays.
  const analysisCache = {pattern: null as string | null, capacities: '', analysis: {kind: 'empty'} as PatternAnalysis}

  // The marks' colors, from the tokens: a pixel of an ImageData is four bytes, red, green, blue and alpha, read here
  // as one 32-bit word.
  const rootStyle = window.getComputedStyle(document.documentElement)
  function pixelOf(tokenName: string, strength: number): number {
    const hex = /^#([0-9a-f]{6})$/i.exec(rootStyle.getPropertyValue(tokenName).trim())?.[1]
    invariant(hex !== undefined, `${tokenName} isn't a color of six hex digits`)
    const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16)
    return new Uint32Array(new Uint8ClampedArray([channel(0), channel(2), channel(4), Math.round(strength * 255)]).buffer)[0]!
  }
  const strengthOf = (name: string) => Number.parseFloat(rootStyle.getPropertyValue(name))
  const colors: MarkColors = {valid: pixelOf('--ink', strengthOf('--mark-valid-strength')), match: pixelOf('--copper', 1), error: pixelOf('--wire-red', strengthOf('--mark-error-strength'))}

  function writeLine(target: {node: HTMLElement, written: string}, line: Line) {
    const key = JSON.stringify(line)
    if (target.written === key) return
    target.written = key
    target.node.replaceChildren(...line.map(part => {
      if (typeof part === 'string') return part
      const node = document.createElement('strong' in part ? 'b' : 'small')
      node.textContent = 'strong' in part ? part.strong : part.small
      return node
    }))
  }

  // Gives the pattern field the focus, with the caret at the pattern's end, so the next keystroke edits the pattern.
  function focusPattern() {
    domCache.pattern.focus({preventScroll: true})
    domCache.pattern.setSelectionRange(domCache.pattern.value.length, domCache.pattern.value.length)
  }

  const params = new URLSearchParams(window.location.search)
  const askedDocuments = params.get('documents')
  const narrowWindow = window.matchMedia('(max-width: 719px)').matches
  const wanted = wantedDocumentCount(askedDocuments === null ? null : Number(askedDocuments), narrowWindow)
  // A browser without WebGPU has no navigator.gpu, or an undefined one.
  const hasWebGpu = (window.navigator as {gpu?: unknown}).gpu !== undefined
  const cpuAsked = params.get('backend') === 'cpu'
  const firstPlan: {documentCount: number, reason: LoadReason} = cpuAsked ? {documentCount: Math.min(wanted.documentCount, cpuDocumentCount), reason: {kind: 'cpuAsked'}}
    : hasWebGpu ? wanted
    : {documentCount: Math.min(wanted.documentCount, cpuDocumentCount), reason: {kind: 'noWebGpu'}}

  const debug: JsonSearchDebug = {
    ready: false, backend: null, documentCount: firstPlan.documentCount, loadBlocks: [], loadMs: null, searches: [], paints: [], check: {state: 'waiting'},
    locate(index) {
      const world = st.world
      if (world === null || mapCache.layout === null || index < 0 || index >= world.documentCount) return null
      const center = markCenterCss(mapCache.layout, world.order.positionOf[index]!)
      const box = domCache.map.getBoundingClientRect()
      return {x: box.left + center.x, y: box.top + center.y}
    },
  }
  window.jsonSearch = debug

  const st = {
    // What the page is loading or has loaded: the count of documents, why it isn't 100,000 on the GPU, and how many
    // documents are written so far.
    plan: firstPlan,
    documentsWritten: 0,
    world: null as World | null,
    programs: [] as ProgramDescription[],
    // The search whose result the page wants: the field's pattern and the select's scope at the last frame.
    wantedKey: '',
    // The last search's answer, which the page shows while its key is the wanted one.
    found: null as Found | null,
    marks: null as Marks | null,
    // The time of the last change of the pattern or the scope, and since when the page has wanted a search's answer
    // that it doesn't have.
    lastTypingAt: 0,
    searchStartedAt: null as number | null,
    // The piece of work in flight. Its promise's callback pushes an arrival with its id.
    job: null as {id: number, name: 'search' | 'window' | 'check' | 'searchTime' | 'secondPassTime'} | null,
    arrivals: [] as Arrival[],
    // A failure with nothing to fall back on, e.g. of the CPU version. The page shows it and starts no more work.
    failure: null as string | null,
    // The document that a click keeps, the pointer's place over the map, and the document that the panel shows.
    pinned: null as number | null,
    pointer: null as {x: number, y: number} | null,
    shownDocument: 0,
    // The self check: how many pieces are done, of how many search programs, and what they found.
    check: {piecesDone: 0, searchProgramsChecked: 0, values: 0, mismatches: 0, documents: 0},
    // For the comparison, on the GPU version: the search on screen made again after a pause, which is what a search
    // per keystroke takes, the highlighter's pass made again over the documents that are already on the GPU, and
    // when the GPU last finished a piece of work, since a pause is the time since then.
    pausedSearch: null as {key: string, ms: number} | null,
    secondPassMs: null as number | null,
    gpuWorkEndedAt: 0,
    // The last result line and time line, and the lines of the document that the panel shows. They stay on screen
    // while a search is in flight.
    resultView: {statusClass: 'status idle', status: [] as Line, timing: [] as Line},
    documentView: {key: '', line: [] as Line, statusClass: 'status idle', status: [] as Line, size: [] as Line},
    // What else the last search's answer decided, which also stays while a search is in flight, so that nothing
    // flashes between two keystrokes: each group's count of documents with a match, whether there is a match to
    // step to, and the comparison's cells and sentences.
    answerView: {byGroup: null as readonly number[] | null, stepDisabled: true, cells: null as ReturnType<typeof comparisonCells> | null, verdict: [] as Line},
    // The last search's timing, which the next frame completes.
    openTiming: null as {timing: SearchTiming, inputTime: number | null} | null,
    wakeAt: null as number | null,
    events: {
      firstInputTime: null as number | null,
      example: null as {pattern: string, scope: string | null} | null,
      click: null as {x: number, y: number} | null,
      pointerLeft: false,
      step: 0 as -1 | 0 | 1,
      release: false,
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
  // The timer for a frame that something waits for, e.g. the self check for the keys to stop.
  let wakeTimer: number | undefined
  function wake() {
    st.wakeAt = null
    scheduleRender()
  }

  // Starts one piece of work. Its answer arrives in a later frame.
  let nextJobId = 1
  function start<Value>(name: NonNullable<typeof st.job>['name'], work: Promise<Value>, answerOf: (value: Value) => Answer) {
    const job = nextJobId++
    st.job = {id: job, name}
    work.then(answerOf, (error: unknown): Answer => ({kind: 'failed', message: error instanceof Error ? error.message : String(error)})).then(answer => {
      st.arrivals.push({kind: 'answer', job, answer})
      scheduleRender()
    }, () => {})
  }

  let nextWorldId = 1
  function createWorld(searcher: Searcher, device: GPUDevice | null, texts: readonly string[], shapeOf: Uint8Array, times: Pick<World, 'writeDocumentsMs' | 'writeCellsMs' | 'createSearcherMs'>): World {
    const order = groupDocuments(shapeOf, searcher.validation.valid, shapes.length)
    return {
      id: nextWorldId++, backend: searcher.backend, searcher, device, documentCount: texts.length, texts, shapeOf, order,
      notValid: notValidLine(searcher.validation.firstErrorKind, searcher.validation.valid, positions),
      baselines: createBaselines(texts, {withCpu: searcher.backend === 'gpu'}),
      windowDocuments: searcher.backend === 'gpu' ? 64 : 8,
      ...times, readyAfterMs: window.performance.now() - pageStart,
    }
  }
  // The CPU version over the first documents, e.g. where there is no WebGPU. It holds search programs of up to 16
  // states: the one of 32 takes about 4 ms per document.
  function createCpuWorld(texts: readonly string[], shapeOf: Uint8Array, writeDocumentsMs: number): World {
    const started = window.performance.now()
    const documentCount = Math.min(texts.length, cpuDocumentCount)
    const searcher = createCpuSearcher(texts.slice(0, documentCount), {stateCapacities: [8, 16]})
    const createSearcherMs = window.performance.now() - started
    return createWorld(searcher, null, texts.slice(0, documentCount), shapeOf.slice(0, documentCount), {writeDocumentsMs, writeCellsMs: searcher.load.cellsMs, createSearcherMs: createSearcherMs - searcher.load.cellsMs})
  }

  // The load: asks for a GPU device, writes the documents in slices of about 6 ms with a pause after each, so the
  // page answers input while it loads, and creates the searcher. For the GPU, each slice also writes its documents'
  // characters as numbers, the searcher's cells, which the searcher would otherwise write in one piece of about
  // 45 ms for 100,000 documents.
  async function load(): Promise<World> {
    // The frame that asked for the load paints the empty map first.
    await nextTask()
    let plan = st.plan
    let device: GPUDevice | null = null
    if (hasWebGpu && !cpuAsked) {
      try {
        const askedBuffer = Number(params.get('buffer') ?? Number.POSITIVE_INFINITY)
        const granted = await requestBatchDevice(Math.min(bufferBytesFor(plan.documentCount), Number.isFinite(askedBuffer) && askedBuffer > 0 ? askedBuffer : Number.POSITIVE_INFINITY))
        device = granted.device
        // A device that stops working, e.g. when the GPU's process ends, resolves `lost`. So does destroying the
        // device, which the page does only after it has switched to the CPU version.
        void device.lost.then(info => {
          st.arrivals.push({kind: 'deviceFailed', message: info.message === '' ? 'the device was lost' : info.message})
          scheduleRender()
        })
        device.addEventListener('uncapturederror', event => {
          st.arrivals.push({kind: 'deviceFailed', message: event.error.message})
          scheduleRender()
        })
        const fits = documentsThatFit(plan.documentCount, granted.largestBufferBytes, bufferBytesFor(1))
        if (fits < plan.documentCount) plan = {documentCount: fits, reason: {kind: 'bufferLimit', wanted: plan.documentCount}}
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        plan = {documentCount: Math.min(plan.documentCount, cpuDocumentCount), reason: message.includes('no WebGPU adapter') ? {kind: 'noWebGpu'} : {kind: 'gpuFailed', message}}
      }
    }
    st.plan = plan
    scheduleRender()

    const texts: string[] = []
    const shapeOf = new Uint8Array(plan.documentCount)
    const cells = device === null ? null : new Float32Array(plan.documentCount * cellsPerDocument)
    let writeDocumentsMs = 0
    let writeCellsMs = 0
    while (texts.length < plan.documentCount) {
      const sliceStarted = window.performance.now()
      const first = texts.length
      do {
        const generated = documentAt(defaultSeed, texts.length)
        shapeOf[texts.length] = shapes.indexOf(generated.shape)
        texts.push(generated.text)
      } while (texts.length < plan.documentCount && (texts.length % 32 !== 0 || window.performance.now() - sliceStarted < 5))
      const textsWritten = window.performance.now()
      if (cells !== null) for (let index = first; index < texts.length; index++) writeDocumentCells(cells, index * cellsPerDocument, texts[index]!)
      const sliceEnded = window.performance.now()
      writeDocumentsMs += textsWritten - sliceStarted
      writeCellsMs += sliceEnded - textsWritten
      debug.loadBlocks.push(sliceEnded - sliceStarted)
      st.documentsWritten = texts.length
      scheduleRender()
      await nextTask()
    }

    if (device !== null && cells !== null) {
      const createStarted = window.performance.now()
      try {
        const searcher = await createGpuSearcher(device, texts, {cells})
        return createWorld(searcher, device, texts, shapeOf, {writeDocumentsMs, writeCellsMs, createSearcherMs: window.performance.now() - createStarted})
      } catch (error) {
        device.destroy()
        st.plan = {documentCount: Math.min(texts.length, cpuDocumentCount), reason: {kind: 'gpuFailed', message: error instanceof Error ? error.message : String(error)}}
      }
    }
    await nextTask()
    return createCpuWorld(texts, shapeOf, writeDocumentsMs)
  }

  // The spans of a document's text.
  function documentNodes(world: World, index: number, marks: Marks | null, kinds: Float32Array): {nodes: HTMLElement[], firstHit: HTMLElement | null} {
    const text = world.texts[index]!
    const ownMarks = marks === null ? null : marks.values.subarray((index - marks.firstDocument) * positions, (index - marks.firstDocument + 1) * positions)
    const {runs, marker} = documentRuns(text, kinds, ownMarks, world.searcher.validation.firstErrorPosition[index]!, positions)
    const nodes: HTMLElement[] = []
    let firstHit: HTMLElement | null = null
    const addMarker = () => {
      const node = document.createElement('span')
      node.className = 'end-marker'
      nodes.push(node)
    }
    runs.forEach((run, runIndex) => {
      if (runIndex === marker) addMarker()
      const node = document.createElement('span')
      node.className = runClassName(run)
      node.textContent = run.text
      nodes.push(node)
      if (run.match !== 0) firstHit ??= node
    })
    if (marker === runs.length) addMarker()
    return {nodes, firstHit}
  }

  function render(): boolean {
    const frameStart = window.performance.now()
    if (st.openTiming !== null) {
      if (st.openTiming.inputTime !== null) st.openTiming.timing.inputToNextFrameMs = frameStart - st.openTiming.inputTime
      st.openTiming = null
    }

    // DOM reads. The pattern and the scope are state that the browser keeps, and so is the map's width, which the
    // window decides.
    const typedPattern = domCache.pattern.value
    const typedScope = domCache.scope.value
    const mapWidthCss = domCache.map.clientWidth
    const scale = Math.max(1, Math.min(4, Math.round(window.devicePixelRatio)))
    const mapBox = st.pointer !== null || st.events.click !== null ? domCache.map.getBoundingClientRect() : null
    // A click on an example moves the focus to the pattern field where there is a mouse and a keyboard. On a phone
    // the focus would open the keyboard over the map.
    const focusAfterExample = st.events.example !== null && window.matchMedia('(pointer: fine)').matches

    // Inputs: what arrived since the last frame.
    let gpuFailure: string | null = null
    for (const arrival of st.arrivals) {
      if (arrival.kind === 'loaded') {
        st.world = arrival.world
        continue
      }
      if (arrival.kind === 'deviceFailed') {
        gpuFailure ??= arrival.message
        continue
      }
      // The answer of a piece of work that the page gave up, e.g. one of the GPU version after the page switched to
      // the CPU version, is dropped.
      if (st.job?.id !== arrival.job) continue
      st.job = null
      st.gpuWorkEndedAt = frameStart
      const {answer} = arrival
      switch (answer.kind) {
        case 'search':
          // An answer to a search that the page no longer wants is dropped, e.g. after another keystroke.
          if (answer.found !== null && answer.key === st.wantedKey && st.world !== null) {
            const {matchCounts} = answer.found
            st.found = {...answer.found, byGroup: matchesByGroup(matchCounts, st.world.order.groupOf, groupNames.length), firstMatch: matchCounts.findIndex(matches => matches > 0)}
            st.marks = answer.marks
          }
          break
        case 'window':
          if (answer.marks !== null && answer.marks.key === st.wantedKey) st.marks = answer.marks
          if (answer.kinds !== null) {
            if (kindsCache.size >= 4096) kindsCache.clear()
            const {firstDocument, values} = answer.kinds
            for (let row = 0; row < values.length / positions; row++) kindsCache.set(firstDocument + row, values.subarray(row * positions, (row + 1) * positions))
          }
          break
        case 'check': {
          const {result, piece, searchPrograms} = answer
          // A piece compares the validation and the kinds of its documents, and for each search program the counts
          // and the marks of one search. Only the first piece's validation and kinds are new values, and only the
          // searches that no earlier piece ran: every program's for a new pattern, and a new program's otherwise.
          const perSearch = result.documents * (1 + positions)
          const newSearches = piece < defaultSelfCheckSearches.length ? searchPrograms : searchPrograms - st.check.searchProgramsChecked
          st.check = {
            piecesDone: st.check.piecesDone + 1,
            searchProgramsChecked: searchPrograms,
            values: st.check.values + (st.check.piecesDone === 0 ? result.values - searchPrograms * perSearch : 0) + newSearches * perSearch,
            mismatches: st.check.mismatches + result.mismatches,
            documents: Math.max(st.check.documents, result.documents),
          }
          break
        }
        case 'searchTime':
          if (answer.ms !== null && answer.key === st.wantedKey) st.pausedSearch = {key: answer.key, ms: answer.ms}
          break
        case 'secondPassTime':
          st.secondPassMs = answer.ms
          break
        case 'failed':
          if (st.world?.backend === 'gpu') gpuFailure ??= answer.message
          else st.failure = answer.message
          break
      }
    }
    st.arrivals.length = 0

    // A GPU that failed, or whose values differ from the CPU's: the page goes on with the CPU version.
    let world = st.world
    if (world !== null && world.backend === 'gpu') {
      const checkFailureAsked = params.get('simulate') === 'check-failure' && st.check.piecesDone > 0
      if (gpuFailure !== null || st.check.mismatches > 0 || checkFailureAsked) {
        const reason: LoadReason = gpuFailure !== null ? {kind: 'gpuFailed', message: gpuFailure} : {kind: 'checkFailed', mismatches: st.check.mismatches, asked: st.check.mismatches === 0}
        const cpuWorld = createCpuWorld(world.texts, world.shapeOf, world.writeDocumentsMs)
        world.searcher.destroy()
        world.device?.destroy()
        st.world = world = {...cpuWorld, readyAfterMs: world.readyAfterMs}
        st.plan = {documentCount: world.documentCount, reason}
        st.job = null
        st.searchStartedAt = null
        st.found = null
        st.marks = null
        st.pausedSearch = null
        st.secondPassMs = null
        st.pinned = null
        st.shownDocument = 0
        st.documentView = {key: '', line: [], statusClass: 'status idle', status: [], size: []}
        st.answerView = {byGroup: null, stepDisabled: true, cells: null, verdict: []}
        kindsCache.clear()
      }
    }
    if (world !== null) {
      const programs = world.searcher.programs()
      if (st.programs.length !== programs.length || st.programs[0]?.statements !== programs[0]?.statements) st.programs = programs
    }
    if (world !== null && !debug.ready) {
      debug.ready = true
      debug.loadMs = {writeDocuments: world.writeDocumentsMs, writeCells: world.writeCellsMs, createSearcher: world.createSearcherMs, total: world.readyAfterMs}
    }
    debug.backend = world?.backend ?? null
    debug.documentCount = st.plan.documentCount

    const programOf = (states: number) => st.programs.find(program => program.name === `regex search, ${states} states`)

    // Inputs: the pattern and the scope. An example of the Try line replaces both.
    const example = st.events.example
    const pattern = example?.pattern ?? typedPattern
    const scope = scopeChoiceOf(example?.scope ?? typedScope)
    const key = keyOf(pattern, scope)
    if (key !== st.wantedKey) {
      st.wantedKey = key
      st.lastTypingAt = frameStart
    }
    if (world !== null && (analysisCache.pattern !== pattern || analysisCache.capacities !== world.searcher.stateCapacities.join())) {
      analysisCache.pattern = pattern
      analysisCache.capacities = world.searcher.stateCapacities.join()
      analysisCache.analysis = analyzePattern(pattern, world.searcher.stateCapacities)
    }
    const analysis: PatternAnalysis = world === null ? {kind: 'empty'} : analysisCache.analysis
    // The search's answer, while it is the answer for the pattern in the field.
    const found = st.found !== null && st.found.key === key && analysis.kind === 'fits' ? st.found : null
    const searchPending = analysis.kind === 'fits' && found === null && st.failure === null
    // Since when the page has been without the answer that it wants.
    if (!searchPending) st.searchStartedAt = null
    else st.searchStartedAt ??= frameStart
    const searchRunsLong = searchPending && st.searchStartedAt !== null && frameStart - st.searchStartedAt >= longSearchMs
    const idleFor = frameStart - st.lastTypingAt

    // The map's layout, for the documents that exist, or before that for the count that is being loaded.
    const documentCount = world?.documentCount ?? st.plan.documentCount
    const mapKey = `${mapWidthCss} ${scale} ${documentCount} ${world?.id ?? 0}`
    if (mapCache.key !== mapKey) {
      const nominal = nominalOf(documentCount)
      mapCache.key = mapKey
      mapCache.layout = mapLayout(mapGrid(mapWidthCss, scale, nominal), world?.order.groupSizes ?? nominal, nominal)
      mapCache.offsets = world === null ? null : markOffsets(mapCache.layout)
      mapCache.image = null
      mapCache.pixels = null
      mapCache.painted = undefined
    }
    const layout = mapCache.layout
    invariant(layout !== null, 'the map has a layout')

    // Inputs: the pointer over the map, a click on it, and the buttons.
    let hovered: number | null = null
    if (world !== null && mapBox !== null) {
      if (st.pointer !== null) {
        const position = positionAt(layout, st.pointer.x - mapBox.left, st.pointer.y - mapBox.top)
        if (position >= 0) hovered = world.order.order[position]!
      }
      if (st.events.click !== null) {
        const position = positionAt(layout, st.events.click.x - mapBox.left, st.events.click.y - mapBox.top)
        // A click on a mark keeps its document, and a click on the kept document's mark lets it go.
        if (position >= 0) st.pinned = st.pinned === world.order.order[position]! ? null : world.order.order[position]!
      }
    }
    if (st.events.release) st.pinned = null
    const firstMatch = found !== null && found.firstMatch >= 0 ? found.firstMatch : null
    if (found !== null && st.events.step !== 0) {
      const next = nextDocumentWithMatch(found.matchCounts, st.pinned ?? firstMatch ?? 0, st.events.step)
      if (next >= 0) st.pinned = next
    }
    // The document that the panel should show: the one under the pointer, else the kept one, else the first with a
    // match. The panel shows it once its display kinds are here, and its marks when there is a search to mark, and
    // until then, and while a search is in flight, the panel stays as it is.
    const target = hovered ?? st.pinned ?? (searchPending ? st.shownDocument : firstMatch ?? 0)
    const targetWindow = world === null ? null : windowAround(target, world.documentCount, world.windowDocuments)
    const targetKinds = kindsCache.get(target)
    const targetMarks = found !== null && st.marks !== null && st.marks.key === key && holds(st.marks, target) ? st.marks : null
    const targetReady = world !== null && targetKinds !== undefined && !searchPending && (found === null || targetMarks !== null)

    // The self check, on the GPU version: a piece for each of the searcher's four searches, and one more piece
    // whenever a search program exists that no piece has run, e.g. the one of 16 states after its first search.
    const searchProgramsBuilt = Math.max(0, st.programs.length - 1)
    const checkDue = world !== null && world.backend === 'gpu' && (st.check.piecesDone < defaultSelfCheckSearches.length || st.check.searchProgramsChecked < searchProgramsBuilt)
    // For the comparison, on the GPU version: the search on screen once more after a pause, when it ran on the
    // smallest search program, where a pause more than doubles the time, and the highlighter's pass once more.
    const pausedSearch = st.pausedSearch !== null && st.pausedSearch.key === key ? st.pausedSearch : null
    const searchTimeDue = world !== null && world.backend === 'gpu' && found !== null && found.states === world.searcher.stateCapacities[0] && pausedSearch === null
    const secondPassTimeDue = world !== null && world.backend === 'gpu' && st.secondPassMs === null
    // The comparison's baselines, a piece per frame while nothing else is going on: no key for half a second, no
    // search or check in flight or due, and the pointer away from the map.
    const comparisonIdle = found !== null && world !== null && found.states > world.searcher.stateCapacities[0]! ? largerProgramIdleMs : comparisonIdleMs
    let comparing = false
    if (world !== null && found !== null && st.job === null && targetReady && !checkDue && idleFor >= comparisonIdle && hovered === null) {
      comparing = world.baselines.step({pattern, scope, states: found.states, programCounts: found.matchCounts}, comparisonPieceMs)
    }

    // What the page shows: the result line and the search's time.
    const notice = loadNotice(st.plan.reason, documentCount)
    let resultView = st.resultView
    if (st.failure !== null) {
      resultView = {statusClass: 'status bad', status: [world === null ? `The page couldn’t load its documents: ${st.failure}.` : `The search stopped: ${st.failure}.`], timing: []}
    } else if (world === null) {
      resultView = {statusClass: 'status idle', status: [], timing: []}
    } else if (analysis.kind === 'empty') {
      resultView = {statusClass: 'status idle', status: [`Type a pattern to search the ${count(documentCount)} documents.`], timing: []}
    } else if (analysis.kind === 'refused') {
      resultView = {statusClass: 'status bad', status: [analysis.sentence], timing: []}
    } else if (found !== null) {
      const where = world.backend === 'gpu' ? 'on the GPU' : 'on the CPU'
      resultView = {
        statusClass: 'status ok',
        status: resultLine(found.documentsWithMatches, found.matches, documentCount),
        timing: found.states > world.searcher.stateCapacities[0]!
          ? ['Searched in ', strong(duration(found.ms)), ` ${where}, by the larger program for ${found.states} states`]
          : ['Searched in ', strong(duration(found.ms)), ` ${where}`],
      }
    } else if (searchRunsLong || st.found === null) {
      // A search that takes longer than a few frames, e.g. on the program for 32 states, and the first search.
      const larger = analysis.states > world.searcher.stateCapacities[0]! ? ` with the program for ${analysis.states} states` : ''
      resultView = {statusClass: 'status busy', status: [`Searching ${count(documentCount)} documents${larger}…`], timing: []}
    }
    // The matches on the map: the answer for the pattern in the field, none for a pattern that isn't searched, and
    // the last answer for as long as a search is in flight, faded once the search runs long.
    const mapCounts = found !== null ? found.matchCounts : searchPending ? mapCache.painted ?? null : null
    const mapIsStale = searchRunsLong && mapCounts !== null

    // The selected document's lines and text.
    let documentView = st.documentView
    let documentMarks: Marks | null = null
    if (world !== null && targetReady) {
      const {validation} = world.searcher
      const valid = validation.valid[target] === 1
      documentMarks = targetMarks
      documentView = {
        key: `${world.id} ${target} ${targetMarks === null ? '' : key}`,
        line: documentLine(target, documentCount, world.shapeOf[target]!, valid, found === null ? null : found.matchCounts[target]!, target === firstMatch && st.pinned === null && hovered === null),
        statusClass: valid ? 'status ok' : 'status bad',
        status: [validitySentence(world.texts[target]!, validation.firstErrorPosition[target]!, validation.firstErrorKind[target]!, positions)],
        size: [strong(count(Array.from(world.texts[target]!).length)), ` of ${count(positions)} characters`],
      }
    }
    const shown = targetReady ? target : st.shownDocument

    // The comparison's lines.
    const baselineNumbers = world?.baselines.numbers(found === null ? null : {pattern, scope, states: found.states, programCounts: found.matchCounts})
    const comparisonNumbers = world === null || baselineNumbers === undefined ? null : {
      backend: world.backend, documentCount, scope,
      // From the texts: JavaScript writing the characters as numbers, then the upload, the highlighter's shader
      // compile and its pass, or on the CPU, building the highlighter and running it.
      highlightMs: world.writeCellsMs + world.searcher.load.validateMs,
      secondPassMs: st.secondPassMs,
      searchMs: pausedSearch?.ms ?? found?.ms ?? null,
      searchAfterPause: pausedSearch !== null,
      ...baselineNumbers,
    }
    // A search that runs long, e.g. on the program for 32 states, leaves the last answer's numbers no place.
    const answerView = searchPending && !searchRunsLong ? st.answerView : {
      byGroup: found?.byGroup ?? null,
      stepDisabled: found === null || found.documentsWithMatches === 0,
      cells: comparisonNumbers === null ? null : comparisonCells(comparisonNumbers),
      verdict: comparisonNumbers === null || found === null || world === null ? [] : comparisonVerdict(comparisonNumbers, {
        patternStates: found.patternStates, states: found.states, smallestStates: world.searcher.stateCapacities[0]!,
        operations: operationsPerPosition(programOf(found.states)), smallestOperations: operationsPerPosition(programOf(world.searcher.stateCapacities[0]!)),
      }),
    }
    const {cells, verdict} = answerView
    const plainHow = scope === 'everything' ? 'RegExp on each document' : scope === 'strings' ? 'RegExp on each string value' : 'RegExp on each key'

    // The check's line and the statistics.
    const check: CheckState = st.check.piecesDone === 0 && st.job?.name !== 'check' ? {state: 'waiting'}
      : checkDue ? {state: 'checking'}
      : {state: 'done', values: st.check.values, mismatches: st.check.mismatches, documents: st.check.documents}
    // After a check that found a difference, the line keeps what the check found, next to the CPU version's results.
    const checkView = world !== null && world.backend === 'cpu' && st.check.mismatches === 0
      ? {state: 'idle' as const, line: ['On a GPU, the page compares the GPU’s values with these programs on the CPU. Here the CPU’s values are the page’s own.'] as Line}
      : checkLine(world !== null && world.backend === 'cpu' ? {state: 'done', values: st.check.values, mismatches: st.check.mismatches, documents: st.check.documents} : check, 'gpu')
    const statsLines: Line[] = []
    if (world !== null) {
      statsLines.push(...programLines(st.programs, positions))
      const size = world.backend === 'gpu' ? `, and the documents and their display kinds take ${megabytes(documentCount * (2 * positions + 1) * 4)} on the GPU` : ''
      statsLines.push([
        'The page was ready ', strong(duration(world.readyAfterMs)), ' after it started: ', strong(duration(world.writeDocumentsMs)), ` to write ${count(documentCount)} documents, `,
        strong(duration(world.writeCellsMs)), ' to write their characters as numbers, and ', strong(duration(world.createSearcherMs)),
        world.backend === 'gpu' ? ' to upload them, compile the two shaders and run the highlighter' : ' to build the highlighter and run it', `${size}.`,
      ])
    }

    // Commit what the frame decided.
    st.resultView = resultView
    st.documentView = documentView
    st.answerView = answerView
    st.shownDocument = shown
    debug.check = check

    // DOM writes.
    writeLine(domCache.notice, notice === null ? [] : [notice])
    const noticeDisplay = notice === null ? 'none' : 'block'
    if (written.noticeDisplay !== noticeDisplay) domCache.notice.node.style.display = written.noticeDisplay = noticeDisplay
    if (written.statusClass !== resultView.statusClass) domCache.status.className = written.statusClass = resultView.statusClass
    writeLine(domCache.statusLine, resultView.status)
    writeLine(domCache.timing, resultView.timing)
    if (example !== null) {
      if (pattern !== typedPattern) domCache.pattern.value = pattern
      if (scope !== typedScope) domCache.scope.value = scope
    }

    // The map: its size, the line that stands in it while the documents are made, and its marks.
    const mapHeight = `${Math.ceil(layout.height / scale)}px`
    if (written.mapHeight !== mapHeight) domCache.map.style.height = written.mapHeight = mapHeight
    const preparingDisplay = world === null ? 'flex' : 'none'
    if (written.preparingDisplay !== preparingDisplay) domCache.preparing.style.display = written.preparingDisplay = preparingDisplay
    if (world === null) {
      // The page's HTML holds this line for 100,000 documents and, in a narrow window, for 20,000.
      if (st.plan.reason.kind !== 'none' && st.plan.reason.kind !== 'narrowWindow') writeLine(domCache.preparingLine, [`Preparing ${count(documentCount)} documents…`])
      const progress = `scaleX(${(st.documentsWritten / documentCount).toFixed(3)})`
      if (written.progress !== progress) domCache.progress.style.transform = written.progress = progress
    }
    let paintMs: number | null = null
    if (world !== null && mapCache.offsets !== null) {
      const canvasSize = `${layout.width} ${layout.height}`
      if (written.canvasSize !== canvasSize) {
        written.canvasSize = canvasSize
        domCache.canvas.width = layout.width
        domCache.canvas.height = layout.height
        domCache.canvas.style.width = `${layout.width / scale}px`
        domCache.canvas.style.height = `${layout.height / scale}px`
        mapCache.painted = undefined
      }
      if (mapCache.painted !== mapCounts) {
        const paintStarted = window.performance.now()
        mapCache.image ??= domCache.context.createImageData(layout.width, layout.height)
        mapCache.pixels ??= new Uint32Array(mapCache.image.data.buffer)
        paintMarks(mapCache.pixels, layout, mapCache.offsets, world.order.order, world.searcher.validation.valid, mapCounts, colors)
        domCache.context.putImageData(mapCache.image, 0, 0)
        mapCache.painted = mapCounts
        paintMs = window.performance.now() - paintStarted
        debug.paints.push(paintMs)
      }
    }
    const canvasOpacity = mapIsStale ? '0.45' : '1'
    if (written.canvasOpacity !== canvasOpacity) domCache.canvas.style.opacity = written.canvasOpacity = canvasOpacity
    layout.blocks.forEach((block, group) => {
      const label = domCache.groupLabels[group]
      if (label === undefined) return
      const placed = `left: ${block.x / scale}px; top: ${block.y / scale - labelBandCss}px; width: ${((layout.columns - 1) * layout.pitch + layout.mark) / scale}px`
      if (label.placed !== placed) label.node.style.cssText = label.placed = placed
      const matching = answerView.byGroup === null ? null : answerView.byGroup[group] ?? 0
      // A group without a match gets a quiet 0, and the copper is for the groups that the search found something in.
      const countClass = matching === 0 ? 'none' : ''
      if (label.countClass !== countClass) label.count.node.className = label.countClass = countClass
      writeLine(label.count, matching === null ? [] : [count(matching)])
    })
    // The rings: around the mark under the pointer, and around the mark of the document that the panel shows.
    const ringAt = (index: number | null) => {
      if (world === null || index === null) return 'display: none'
      const center = markCenterCss(layout, world.order.positionOf[index]!)
      return `transform: translate(${center.x}px, ${center.y}px)`
    }
    const pointerRing = ringAt(hovered !== null && hovered !== shown ? hovered : null)
    if (written.pointerRing !== pointerRing) domCache.pointerRing.style.cssText = written.pointerRing = pointerRing
    const selectedRing = ringAt(documentView.key === '' ? null : shown)
    if (written.selectedRing !== selectedRing) domCache.selectedRing.style.cssText = written.selectedRing = selectedRing
    writeLine(domCache.errors, world === null ? [] : world.notValid)

    // The selected document.
    writeLine(domCache.documentLine, documentView.line)
    let firstHit: HTMLElement | null = null
    const documentChanged = written.documentKey !== documentView.key
    if (documentChanged) {
      written.documentKey = documentView.key
      if (world === null || targetKinds === undefined || !targetReady) {
        domCache.documentText.replaceChildren()
      } else {
        const built = documentNodes(world, target, documentMarks, targetKinds)
        firstHit = built.firstHit
        domCache.documentText.replaceChildren(...built.nodes)
      }
    }
    if (written.documentStatusClass !== documentView.statusClass) domCache.documentStatus.className = written.documentStatusClass = documentView.statusClass
    writeLine(domCache.documentStatusLine, documentView.status)
    writeLine(domCache.documentSize, documentView.size)
    const {stepDisabled} = answerView
    if (written.stepDisabled !== stepDisabled) domCache.previousMatch.disabled = domCache.nextMatch.disabled = written.stepDisabled = stepDisabled
    const releaseDisplay = st.pinned === null ? 'none' : 'inline-flex'
    if (written.releaseDisplay !== releaseDisplay) domCache.release.style.display = written.releaseDisplay = releaseDisplay

    // The comparison, the check and the statistics.
    writeLine(domCache.programRow, [world?.backend === 'cpu' ? 'The two programs on the CPU, as this page runs them' : 'The two programs on the GPU'])
    const cpuRowDisplay = world?.backend === 'cpu' ? 'none' : ''
    if (written.cpuRowDisplay !== cpuRowDisplay) domCache.cpuRow.style.display = written.cpuRowDisplay = cpuRowDisplay
    writeLine(domCache.plainHow, [plainHow])
    if (cells !== null) {
      writeLine(domCache.programHighlight, cells.programHighlight)
      writeLine(domCache.programSearch, cells.programSearch)
      writeLine(domCache.plainHighlight, cells.plainHighlight)
      writeLine(domCache.plainSearch, cells.plainSearch)
      writeLine(domCache.cpuHighlight, cells.cpuHighlight)
      writeLine(domCache.cpuSearch, cells.cpuSearch)
    }
    writeLine(domCache.verdict, verdict)
    const checkClass = `status check ${checkView.state}`
    if (written.checkClass !== checkClass) domCache.check.className = written.checkClass = checkClass
    writeLine(domCache.checkLine, checkView.line)
    const statsKey = JSON.stringify(statsLines)
    if (domCache.stats.written !== statsKey) {
      domCache.stats.written = statsKey
      domCache.stats.node.replaceChildren(...statsLines.map(line => {
        const sentence = {node: document.createElement('span'), written: ''}
        writeLine(sentence, line)
        return sentence.node
      }))
    }

    // Side effects. The document's text scrolls to its first match when another document or another search's marks
    // are shown: reading the match's place lays the text out, once, after every write above.
    if (documentChanged) domCache.documentText.scrollTop = firstHit === null ? 0 : Math.max(0, firstHit.offsetTop - domCache.documentText.offsetTop - 72)
    if (focusAfterExample) focusPattern()

    // The search's timing, once its result is on the canvas.
    if (found !== null && paintMs !== null && written.timedCounts !== found.matchCounts) {
      written.timedCounts = found.matchCounts
      const timing: SearchTiming = {pattern, scope, states: found.states, matches: found.matches, documentsWithMatches: found.documentsWithMatches, paintedAt: window.performance.now(), searchMs: found.ms, paintMs}
      if (debug.searches.length >= 1000) debug.searches.shift()
      if (debug.paints.length >= 1000) debug.paints.splice(0, debug.paints.length - 999)
      debug.searches.push(timing)
      st.openTiming = {timing, inputTime: st.events.firstInputTime}
    }

    // The one piece of work that is due, most urgent first: the search for the pattern in the field, the marks and
    // the kinds of the document that the panel should show, a piece of the self check, and the highlighter's time.
    // What waits for the page to be idle sets a timer for the frame that starts it.
    const due = {at: null as number | null}
    const wakeBy = (time: number) => {
      due.at = due.at === null ? time : Math.min(due.at, time)
    }
    if (world !== null && st.job === null && targetWindow !== null && st.failure === null) {
      const {searcher} = world
      const startCheckPiece = () => {
        // A piece runs every search program built so far on the CPU, at 0.25 ms per document for 8 states and up to
        // 4 ms for 32, so it checks fewer documents once a larger program exists.
        const piece = st.check.piecesDone
        const largestStates = Math.max(...st.programs.map(program => Number(program.name.replace(/\D/g, ''))))
        const documents = largestStates > 16 ? 8 : largestStates > 8 ? 24 : 64
        const search = defaultSelfCheckSearches[piece < defaultSelfCheckSearches.length ? piece : 0]!
        start('check', searcher.selfCheck(documents, [search]), (result): Answer => ({kind: 'check', result, piece, searchPrograms: searchProgramsBuilt}))
      }
      if (searchPending && world.backend === 'gpu' && st.check.piecesDone < defaultSelfCheckSearches.length && programOf(analysis.states) === undefined) {
        // A search that needs a larger program waits for the check's first four pieces, so that they run while the
        // smallest search program is the only one, on 64 documents.
        startCheckPiece()
      } else if (searchPending) {
        // A search's time runs from before the pattern is compiled until the results are copied. The first search on
        // a program also builds that program, and on the GPU compiles its shader, once: that search's time leaves
        // both out, and the statistics have the shader's compile time.
        const programExists = programOf(analysis.states) !== undefined
        if (world.backend === 'gpu') {
          start('search', searcher.search({pattern, scope, window: targetWindow}), (result): Answer => result?.status !== 'searched' ? {kind: 'search', key, found: null, marks: null} : {
            kind: 'search', key,
            found: {
              key, matchCounts: result.matchCounts, matches: result.matches, documentsWithMatches: result.documentsWithMatches, states: result.states, patternStates: result.patternStates,
              ms: programExists ? result.timings.totalMs : result.timings.evaluateMs,
            },
            marks: {key, ...targetWindow, values: result.marks},
          })
        } else {
          start('search', searchInPieces(searcher, pattern, scope, key, targetWindow, programExists, () => st.wantedKey === key), (result): Answer => ({kind: 'search', key, found: result?.found ?? null, marks: result?.marks ?? null}))
        }
      } else if (!targetReady) {
        const needsMarks = found !== null && targetMarks === null
        const needsKinds = targetKinds === undefined
        start('window', (async () => {
          const result = needsMarks ? await searcher.search({pattern, scope, window: targetWindow, documents: 'window'}) : undefined
          const kinds = needsKinds ? await searcher.kinds(targetWindow) : null
          return {marks: result?.status === 'searched' ? {key, ...targetWindow, values: result.marks} : null, kinds}
        })(), ({marks, kinds}): Answer => ({kind: 'window', marks, kinds: kinds === null ? null : {firstDocument: targetWindow.firstDocument, values: kinds}}))
      } else if (checkDue) {
        const checkIdle = st.check.piecesDone < defaultSelfCheckSearches.length ? checkIdleMs : largerProgramIdleMs
        if (idleFor >= checkIdle) startCheckPiece()
        else wakeBy(st.lastTypingAt + checkIdle)
      } else if (searchTimeDue || secondPassTimeDue) {
        // Both are times after a pause: no key for half a second, and nothing on the GPU for 0.3 s.
        const startAt = Math.max(st.lastTypingAt + comparisonIdle, st.gpuWorkEndedAt + gpuPauseMs)
        if (frameStart < startAt) {
          wakeBy(startAt)
        } else if (searchTimeDue) {
          start('searchTime', searcher.search({pattern, scope, window: targetWindow}), (result): Answer => ({kind: 'searchTime', key, ms: result?.status === 'searched' ? result.timings.totalMs : null}))
        } else {
          start('secondPassTime', searcher.validate(), ({evaluateMs}): Answer => ({kind: 'secondPassTime', ms: evaluateMs}))
        }
      } else if (found !== null && idleFor < comparisonIdle) {
        wakeBy(st.lastTypingAt + comparisonIdle)
      }
    }
    if (searchPending && !searchRunsLong && st.searchStartedAt !== null) wakeBy(st.searchStartedAt + longSearchMs)
    if (due.at !== st.wakeAt) {
      window.clearTimeout(wakeTimer)
      // A timer may fire a fraction of a ms early, and its frame would then find nothing due yet. So the timer aims
      // a ms late, and when it fires, the state forgets it, so that a frame that still waits sets a new one.
      if (due.at !== null) wakeTimer = window.setTimeout(wake, Math.ceil(Math.max(0, due.at - window.performance.now())) + 1)
      st.wakeAt = due.at
    }

    // The events are handled.
    st.events.example = null
    st.events.click = null
    st.events.step = 0
    st.events.release = false
    if (st.events.pointerLeft) st.pointer = null
    st.events.pointerLeft = false
    // The time of an input is kept for as long as its search is in flight.
    if (!searchPending) st.events.firstInputTime = null

    // Another frame completes the search's timing, or goes on with the comparison.
    return st.openTiming !== null || comparing
  }

  const recordInput = (event: Event) => {
    st.events.firstInputTime ??= event.timeStamp
    scheduleRender()
  }
  domCache.pattern.addEventListener('input', recordInput)
  domCache.scope.addEventListener('change', recordInput)
  domCache.tryList.addEventListener('click', event => {
    const example = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pattern]') : null
    if (example === null) return
    st.events.example = {pattern: example.dataset['pattern'] ?? '', scope: example.dataset['scope'] ?? null}
    recordInput(event)
  })
  // The pointer over the map: a mouse or a pen points at a document, and a touch only clicks.
  domCache.map.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    st.pointer = {x: event.clientX, y: event.clientY}
    scheduleRender()
  })
  domCache.map.addEventListener('pointerleave', () => {
    st.events.pointerLeft = true
    scheduleRender()
  })
  domCache.map.addEventListener('click', event => {
    st.events.click = {x: event.clientX, y: event.clientY}
    scheduleRender()
  })
  domCache.previousMatch.addEventListener('click', () => {
    st.events.step = -1
    scheduleRender()
  })
  domCache.nextMatch.addEventListener('click', () => {
    st.events.step = 1
    scheduleRender()
  })
  domCache.release.addEventListener('click', () => {
    st.events.release = true
    scheduleRender()
  })
  // The map's width follows the window's. The observer covers every other cause one frame late, e.g. a scrollbar that
  // appears, and a scroll moves the map under a pointer that stays where it is.
  window.addEventListener('resize', scheduleRender)
  window.addEventListener('scroll', scheduleRender, {passive: true})
  const mapObserver = new ResizeObserver(scheduleRender)
  mapObserver.observe(domCache.map)
  // The marks are drawn for the screen's device pixels, and a window that moves to another screen keeps its size in
  // CSS px. Where the browser can observe an element's size in device pixels, the map is drawn again for the new
  // screen, and elsewhere after the next resize.
  try {
    mapObserver.observe(domCache.map, {box: 'device-pixel-content-box'})
  } catch {}

  const initialPattern = params.get('pattern')
  if (initialPattern !== null) domCache.pattern.value = initialPattern
  domCache.scope.value = scopeChoiceOf(params.get('scope'))
  // Where there is a mouse and a keyboard, the page starts with the caret in the pattern field.
  if (window.matchMedia('(pointer: fine)').matches) focusPattern()
  scheduleRender()
  // The first frame paints the empty map before the documents are written.
  window.requestAnimationFrame(() => {
    load().then(world => {
      st.arrivals.push({kind: 'loaded', world})
      scheduleRender()
    }, (error: unknown) => {
      st.failure = error instanceof Error ? error.message : String(error)
      scheduleRender()
    })
  })
  invariant(scopeChoices.length === domCache.scope.options.length, 'the select has one option per scope')
}

mountJsonSearch(document, window)
