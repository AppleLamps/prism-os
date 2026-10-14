// The page: a pattern field with two toggles, a line of numbers, a map with one cell per document, and one document
// drawn as code. searcher.ts does the work on the GPU: the JSON highlighter once per document at load, and regex
// search once per document at each keystroke. The page starts its worker script (demo-worker.ts) twice: one worker
// times RegExp for the same search, and the other runs both programs on the CPU when the toggle says CPU or the
// browser has no WebGPU.
//
// Listeners and the workers' messages only record what arrived and schedule a frame. A frame reads the DOM, takes in
// what arrived since the last frame, e.g. a search's answer, decides what the page shows, writes the DOM and the
// canvas, and last asks for the work that is due, e.g. a search for the pattern in the field. An answer arrives after
// the frame that asked for it, is recorded, and is an input of the next frame.
//
// One query parameter, for a state that few machines show: ?buffer=134217728 asks the GPU for buffers of at most
// that many bytes, as a device with small limits would grant.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type CellColors, type MapLayout, cellCenterCss, mapLayout, nextMatch, paintCells, pickedDocument} from './demo-map.ts'
import {
  type Failure, type Line, type LoadReason, type PatternAnalysis, type RegExpTime, type Scope, type Where, analyzePattern, count, documentRuns, documentText,
  documentsThatFit, failureSentence, isScope, loadNotice, narrowDocumentCount, resultLine, runClassName, wideDocumentCount,
} from './demo-text.ts'
import type {WorkerAnswer, WorkerRequest} from './demo-worker.ts'
import {requestBatchDevice} from './gpu/host.ts'
import {cellsPerDocument, writeDocumentCells} from './program.ts'
import {type Searcher, bufferBytesFor, createGpuSearcher, defaultStateCapacities} from './searcher.ts'

// What one search took on its way to the screen, for scripts that measure the page.
export type SearchTiming = {
  pattern: string
  scope: Scope
  where: Where
  documentsWithMatches: number
  // The search program's own time: on the GPU from before the pattern is compiled until the counts are copied, and
  // on the CPU the sum of the pieces' loops.
  searchMs: number
  // Painting every cell of the map into the canvas, in the frame that painted the complete answer.
  paintMs: number
  // When that frame ended, in ms since the page's navigation started.
  paintedAt: number
  // From the first input event since the last answer to the frame after the one that painted the answer.
  inputToNextFrameMs?: number
}
export type JsonSearchDebug = {
  ready: boolean
  // Where the search program runs, or null before the documents exist.
  where: Where | null
  documentCount: number
  // In ms: writing the documents' texts, writing their characters as numbers for the GPU, creating the GPU's
  // searcher, and from the page's start until the documents were ready to search.
  loadMs: {writeDocuments: number, writeCells: number, createSearcher: number, total: number} | null
  // The searches whose complete answers were painted, the latest 1,000.
  searches: SearchTiming[]
  // Where a document's cell is in the window, in CSS px, or null before the map is laid out.
  locate: (index: number) => {x: number, y: number} | null
}

declare global {
  interface Window {
    jsonSearch?: JsonSearchDebug
  }
}

// What the page searches.
type World = {
  documentCount: number
  texts: readonly string[]
  // The searcher on the GPU and its device, or null where both programs run on the CPU, in a worker.
  gpu: {searcher: Searcher, device: GPUDevice} | null
  loadMs: NonNullable<JsonSearchDebug['loadMs']>
}

// A search's answer. One on the CPU arrives a few documents at a time, in the documents' order.
type Found = {
  // The search: where it ran, what it read and the pattern.
  key: string
  // One count per document, and 0 for a document that the search hasn't reached.
  matchCounts: Float32Array
  // How many documents the search has answered for, and how many of them have a match.
  searched: number
  withMatch: number
  // The first document with a match, or -1.
  firstMatch: number
  // The search program's time so far.
  ms: number
}
// The document in the panel: its display kinds, and its marks for the search of `key`, or null and '' without one.
type Shown = {index: number, key: string, kinds: Float32Array, marks: Float32Array | null}

type GpuAnswer =
  | {kind: 'found', found: Found}
  | {kind: 'document', shown: Shown}
  | {kind: 'failed', message: string}
// What arrives between two frames.
type Arrival =
  | {kind: 'loaded', world: World}
  // The answer of the GPU's piece of work in flight, by its id.
  | {kind: 'gpu', job: number, answer: GpuAnswer}
  | {kind: 'gpuLost', message: string}
  | {kind: 'worker', answer: WorkerAnswer}
  // Without a message when the workers' script didn't load.
  | {kind: 'workerFailed', message: string | undefined}

// A search that has been in flight this long gets a line that says so, and the map shows no matches. A search on the
// GPU takes up to 80 ms on the programs for 8 and 16 states, so it never shows the line, which would flash at each
// key. A search on the program for 32 states takes about 0.9 s, and shows it.
const longSearchMs = 250
// How long the page waits for RegExp's time. RegExp can backtrack for minutes on a pattern, e.g. on (([a-z]+)+)+x,
// which has one pair of parentheses more than the Try list's pattern, and nothing stops a RegExp that is running
// except the end of its worker. For the search on screen the page waits 10 s, and then says "more than 10 s". For a
// search that it has left since, e.g. after another keystroke, it waits 1 s. A pattern that doesn't backtrack takes
// about 0.1 s or less on an Apple M5 Max, so a machine several times slower still finishes those.
const regExpLimitMs = 10_000
const leftRegExpLimitMs = 1000
// For the map before a search's answer: no document's count is read.
const noCounts = new Float32Array(0)

const searchKeyOf = (where: Where, scope: Scope, pattern: string) => `${where}\n${scope}\n${pattern}`

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

// A search of every document on the GPU. The first search on a program also builds the program and compiles its
// shader, once: `prepare` does both ahead of the search, so the search's time leaves them out.
async function searchOnGpu(searcher: Searcher, key: string, pattern: string, scope: Scope, states: number): Promise<GpuAnswer> {
  await searcher.prepare(states)
  const result = await searcher.search({pattern, scope})
  invariant(result?.status === 'searched', 'the page searches one pattern at a time, and only one that a search program holds')
  const {matchCounts} = result
  return {kind: 'found', found: {key, matchCounts, searched: matchCounts.length, withMatch: result.documentsWithMatches, firstMatch: matchCounts.findIndex(matches => matches > 0), ms: result.timings.totalMs}}
}

// One document's display kinds, read back from the GPU, and with a search its marks, from a pass over that document.
async function documentOnGpu(searcher: Searcher, index: number, key: string, search: {pattern: string, scope: Scope} | null): Promise<GpuAnswer> {
  const window = {firstDocument: index, documentCount: 1}
  const kinds = await searcher.kinds(window)
  if (search === null) return {kind: 'document', shown: {index, key, kinds, marks: null}}
  const result = await searcher.search({...search, window, documents: 'window'})
  invariant(result?.status === 'searched', 'the page searches one pattern at a time, and only one that a search program holds')
  return {kind: 'document', shown: {index, key, kinds, marks: result.marks}}
}

function mountJsonSearch(document: Document, window: Window) {
  const pageStart = window.performance.now()
  const find = <Found extends Element>(selector: string): Found => {
    const node = document.querySelector<Found>(selector)
    invariant(node !== null, `${selector} is missing`)
    return node
  }
  const canvas = find<HTMLCanvasElement>('#cells')
  const context = canvas.getContext('2d')
  invariant(context !== null, 'the canvas has no 2D context')

  const domCache = {
    pattern: find<HTMLInputElement>('#pattern'), // mount lifetime
    tryList: find<HTMLElement>('.try'), // mount lifetime
    scopes: [...document.querySelectorAll<HTMLInputElement>('input[name="scope"]')], // mount lifetime
    whereGpu: find<HTMLInputElement>('input[name="where"][value="gpu"]'), // mount lifetime
    whereCpu: find<HTMLInputElement>('input[name="where"][value="cpu"]'), // mount lifetime
    title: find<HTMLElement>('h1.title'), // mount lifetime
    notice: find<HTMLElement>('#notice'), // mount lifetime
    status: find<HTMLElement>('#status'), // mount lifetime
    statusLine: find<HTMLElement>('#status > span'), // mount lifetime; its children live until the line changes
    map: find<HTMLElement>('#map'), // mount lifetime
    canvas, // mount lifetime; its pixels live until the next answer or the next layout
    context, // mount lifetime
    ring: find<HTMLElement>('#ring'), // mount lifetime
    documentName: find<HTMLElement>('#document-name'), // mount lifetime
    // The document's text: one span per run of characters that look the same. A frame replaces all of them when
    // another document or another search's marks are shown, and leaves them alone otherwise, so a selection in the
    // text stays.
    documentText: find<HTMLElement>('#document-text'), // mount lifetime; its children live until the document or its marks change
  }
  // What the last frame wrote, so a frame writes only what changed: a rewrite of a line would have a screen reader
  // read it again, and one of the document's text would collapse a selection in it.
  const written = {
    title: '', notice: '', statusClass: '', statusBusy: '', statusLine: '', gpuDisabled: false, mapHeight: '', ring: '', ringClass: '', documentName: '', documentKey: '',
    // The answer whose timing is recorded.
    timedFound: null as Found | null,
  }
  // The canvas's pixels, which are too large to copy, and what they show.
  const mapCache = {
    layout: null as MapLayout | null,
    size: '',
    image: null as ImageData | null,
    pixels: null as Uint32Array | null,
    painted: '',
  }

  // The cells' colors, from the tokens: a pixel of an ImageData is four bytes, red, green, blue and alpha, read here
  // as one 32-bit word.
  const rootStyle = window.getComputedStyle(document.documentElement)
  function pixelOf(tokenName: string, strength: number): number {
    const hex = /^#([0-9a-f]{6})$/i.exec(rootStyle.getPropertyValue(tokenName).trim())?.[1]
    invariant(hex !== undefined, `${tokenName} isn't a color of six hex digits`)
    const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16)
    return new Uint32Array(new Uint8ClampedArray([channel(0), channel(2), channel(4), Math.round(strength * 255)]).buffer)[0]!
  }
  const strengthOf = (name: string) => Number.parseFloat(rootStyle.getPropertyValue(name))
  const colors: CellColors = {match: pixelOf('--copper', 1), plain: pixelOf('--ink', strengthOf('--cell-plain-strength')), waiting: pixelOf('--ink', strengthOf('--cell-waiting-strength'))}

  // A browser without WebGPU has no navigator.gpu, or an undefined one.
  const hasWebGpu = (window.navigator as {gpu?: unknown}).gpu !== undefined
  const wantedDocumentCount = window.matchMedia('(max-width: 719px)').matches ? narrowDocumentCount : wideDocumentCount

  const debug: JsonSearchDebug = {
    ready: false, where: null, documentCount: wantedDocumentCount, loadMs: null, searches: [],
    locate(index) {
      if (mapCache.layout === null || index < 0 || index >= mapCache.layout.documentCount) return null
      const center = cellCenterCss(mapCache.layout, index)
      const box = domCache.map.getBoundingClientRect()
      return {x: box.left + center.x, y: box.top + center.y}
    },
  }
  window.jsonSearch = debug

  const firstPlan: {documentCount: number, reason: LoadReason} = {documentCount: wantedDocumentCount, reason: hasWebGpu ? {kind: 'none'} : {kind: 'noWebGpu'}}
  const st = {
    // How many documents the page loads, why that isn't the wanted count on the GPU, and how many are written so far.
    plan: firstPlan,
    loaded: 0,
    world: null as World | null,
    // A failure with nothing to fall back on, e.g. of a worker. The page says so in the line's place and asks for no
    // more work.
    failure: null as Failure | null,
    // The search whose answer the page wants, as of the last frame, '' for none, and since when it has wanted it.
    wantedKey: '',
    wantedSince: 0,
    // The last search's answer, which the page shows while its key is the wanted one, and RegExp's time for a
    // search, by what the search reads and its pattern.
    found: null as Found | null,
    regExp: null as {key: string, time: RegExpTime} | null,
    // The timing of RegExp that its worker is busy with, and since when. The page asks for one at a time.
    timing: null as {key: string, since: number} | null,
    shown: null as Shown | null,
    // The document that a click or the Enter key keeps, and the pointer's place over the map, or null while the
    // pointer is elsewhere.
    kept: null as number | null,
    pointer: null as {x: number, y: number} | null,
    // The GPU's piece of work in flight. Its promise's callback pushes an arrival with its id.
    job: null as number | null,
    // What the worker for the CPU was last asked for: the search, by its key and by the number that its answers
    // carry, and whether a document's answer is still to come.
    asked: {search: null as {id: number, key: string} | null, document: false},
    // The last line of numbers and the last answer on the map. Both stay on screen while a search is in flight, so
    // that nothing flashes between two keystrokes.
    lineView: {state: 'busy' as 'idle' | 'busy' | 'ok' | 'bad', line: [] as Line},
    mapView: {found: null as Found | null, rest: 'plain' as 'plain' | 'waiting'},
    // The last search's timing, which the next frame completes.
    openTiming: null as {timing: SearchTiming, inputTime: number | null} | null,
    // When the timer asks for the next frame, or infinity without one.
    wakeAt: Number.POSITIVE_INFINITY,
    arrivals: [] as Arrival[],
    events: {
      firstInputTime: null as number | null,
      example: null as {pattern: string, scope: Scope} | null,
      click: null as {x: number, y: number} | null,
      // Presses of Enter since the last frame, less the ones with Shift.
      steps: 0,
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
  // The timer for a frame that nothing else asks for, e.g. the one that says that a search runs long.
  let wakeTimer: number | undefined
  function wake() {
    st.wakeAt = Number.POSITIVE_INFINITY
    scheduleRender()
  }

  // A worker, which first writes the page's documents on its own thread.
  function startWorker(documentCount: number): Worker {
    const worker = new Worker('./demo-worker.js')
    worker.addEventListener('message', (event: MessageEvent<WorkerAnswer>) => {
      st.arrivals.push({kind: 'worker', answer: event.data})
      scheduleRender()
    })
    // An error that the worker throws arrives with its message. A script that didn't load arrives as a plain event,
    // without one.
    worker.addEventListener('error', (event: Event | ErrorEvent) => {
      st.arrivals.push({kind: 'workerFailed', message: 'message' in event ? event.message : undefined})
      scheduleRender()
    })
    worker.postMessage({kind: 'documents', documentCount} satisfies WorkerRequest)
    return worker
  }
  // The page's two workers. One only times RegExp, so that the page can end it when RegExp takes too long without
  // ending anything else. The other runs the programs on the CPU. The load starts the first one, and the second one
  // where there is no GPU, so that their documents are written while the page writes its own. Otherwise a worker
  // starts when the page first asks it for something.
  let regExpWorker: Worker | null = null
  let cpuWorker: Worker | null = null

  // The number of the next search on the CPU, which its answers carry.
  let nextSearchId = 1
  // Starts the GPU's one piece of work. Its answer arrives in a later frame.
  let nextJob = 1
  function startOnGpu(work: Promise<GpuAnswer>) {
    const job = nextJob++
    st.job = job
    work.catch((error: unknown): GpuAnswer => ({kind: 'failed', message: error instanceof Error ? error.message : String(error)})).then(answer => {
      st.arrivals.push({kind: 'gpu', job, answer})
      scheduleRender()
    }, () => {})
  }

  // The load: asks for a GPU device, writes the documents in slices of about 6 ms with a pause after each, so the
  // page answers input while it loads, and creates the GPU's searcher. For the GPU, each slice also writes its
  // documents' characters as numbers, the searcher's cells, which the searcher would otherwise write in one piece of
  // about 45 ms for 100,000 documents.
  async function load(): Promise<World> {
    // The frame that asked for the load paints the empty map first.
    await nextTask()
    let {documentCount} = st.plan
    let device: GPUDevice | null = null
    if (hasWebGpu) {
      try {
        const askedBuffer = Number(new URLSearchParams(window.location.search).get('buffer') ?? Number.POSITIVE_INFINITY)
        const granted = await requestBatchDevice(Math.min(bufferBytesFor(documentCount), Number.isFinite(askedBuffer) && askedBuffer > 0 ? askedBuffer : Number.POSITIVE_INFINITY))
        device = granted.device
        // A device that stops working, e.g. when the GPU's process ends, resolves `lost`. So does destroying the
        // device, which the page does only once it has stopped using it.
        void device.lost.then(info => {
          st.arrivals.push({kind: 'gpuLost', message: info.message === '' ? 'the device was lost' : info.message})
          scheduleRender()
        })
        device.addEventListener('uncapturederror', event => {
          st.arrivals.push({kind: 'gpuLost', message: event.error.message})
          scheduleRender()
        })
        const fits = documentsThatFit(documentCount, granted.largestBufferBytes, bufferBytesFor(1))
        if (fits < documentCount) {
          st.plan = {documentCount: fits, reason: {kind: 'bufferLimit', wanted: documentCount}}
          documentCount = fits
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        st.plan = {documentCount, reason: message.includes('no WebGPU adapter') ? {kind: 'noWebGpu'} : {kind: 'gpuFailed', message}}
      }
    }
    // The workers write the same documents on their own threads meanwhile.
    regExpWorker = startWorker(documentCount)
    if (device === null) cpuWorker = startWorker(documentCount)
    scheduleRender()

    const texts: string[] = []
    const cells = device === null ? null : new Float32Array(documentCount * cellsPerDocument)
    let writeDocumentsMs = 0
    let writeCellsMs = 0
    while (texts.length < documentCount) {
      const sliceStarted = window.performance.now()
      const first = texts.length
      do texts.push(documentText(texts.length))
      while (texts.length < documentCount && (texts.length % 32 !== 0 || window.performance.now() - sliceStarted < 5))
      const textsWritten = window.performance.now()
      if (cells !== null) for (let index = first; index < texts.length; index++) writeDocumentCells(cells, index * cellsPerDocument, texts[index]!)
      const sliceEnded = window.performance.now()
      writeDocumentsMs += textsWritten - sliceStarted
      writeCellsMs += sliceEnded - textsWritten
      st.loaded = texts.length
      scheduleRender()
      await nextTask()
    }

    let gpu: World['gpu'] = null
    let createSearcherMs = 0
    if (device !== null && cells !== null) {
      const createStarted = window.performance.now()
      try {
        gpu = {searcher: await createGpuSearcher(device, texts, {cells}), device}
        createSearcherMs = window.performance.now() - createStarted
      } catch (error) {
        device.destroy()
        st.plan = {documentCount, reason: {kind: 'gpuFailed', message: error instanceof Error ? error.message : String(error)}}
      }
    }
    return {documentCount, texts, gpu, loadMs: {writeDocuments: writeDocumentsMs, writeCells: writeCellsMs, createSearcher: createSearcherMs, total: window.performance.now() - pageStart}}
  }

  function writeLine(node: HTMLElement, line: Line) {
    node.replaceChildren(...line.map(part => {
      if (typeof part === 'string') return part
      const bold = document.createElement('b')
      bold.textContent = part.strong
      return bold
    }))
  }

  function render(): boolean {
    const frameStart = window.performance.now()
    if (st.openTiming !== null) {
      if (st.openTiming.inputTime !== null) st.openTiming.timing.inputToNextFrameMs = frameStart - st.openTiming.inputTime
      st.openTiming = null
    }

    // DOM reads. The pattern and the toggles are state that the browser keeps, and so is the map's width, which the
    // window decides.
    const typedPattern = domCache.pattern.value
    const typedScope = domCache.scopes.find(input => input.checked)?.value
    const typedWhere: Where = domCache.whereCpu.checked ? 'cpu' : 'gpu'
    const mapWidthCss = domCache.map.clientWidth
    const scale = Math.max(1, Math.min(4, Math.round(window.devicePixelRatio)))
    const mapBox = st.pointer !== null || st.events.click !== null ? domCache.map.getBoundingClientRect() : null
    // A click on an example moves the focus to the pattern field where there is a mouse and a keyboard. On a phone
    // the focus would open the keyboard over the map.
    const focusAfterExample = st.events.example !== null && window.matchMedia('(pointer: fine)').matches

    // Inputs: what arrived since the last frame. An answer to a search that the page no longer wants is dropped,
    // e.g. after another keystroke.
    let gpuFailure: string | null = null
    for (const arrival of st.arrivals) {
      switch (arrival.kind) {
        case 'loaded':
          st.world = arrival.world
          break
        case 'gpuLost':
          gpuFailure ??= arrival.message
          break
        case 'workerFailed':
          st.failure = {kind: 'worker', message: arrival.message}
          break
        case 'gpu': {
          // The answer of a piece of work that the page gave up, e.g. after the GPU stopped working, is dropped.
          if (st.job !== arrival.job) break
          st.job = null
          const {answer} = arrival
          switch (answer.kind) {
            case 'found':
              if (answer.found.key === st.wantedKey) st.found = answer.found
              break
            case 'document':
              if (answer.shown.key === st.wantedKey) st.shown = answer.shown
              break
            case 'failed':
              gpuFailure ??= answer.message
              break
          }
          break
        }
        case 'worker': {
          const {answer} = arrival
          switch (answer.kind) {
            case 'regExp':
              // The answer of a worker that the page has ended since is dropped.
              if (st.timing?.key !== answer.key) break
              st.timing = null
              st.regExp = {key: answer.key, time: {kind: 'measured', ms: answer.ms}}
              break
            case 'searched': {
              // A piece of a search that the page has replaced or stopped since is dropped.
              if (st.asked.search?.id !== answer.id || st.world === null) break
              // The first piece of a search starts its answer, and each piece adds its documents' counts.
              if (answer.firstDocument === 0) st.found = {key: st.asked.search.key, matchCounts: new Float32Array(st.world.documentCount), searched: 0, withMatch: 0, firstMatch: -1, ms: 0}
              const found = st.found
              invariant(found !== null && found.searched === answer.firstDocument, 'a search\'s pieces arrive in the documents\' order')
              found.matchCounts.set(answer.matchCounts, answer.firstDocument)
              found.searched = answer.firstDocument + answer.matchCounts.length
              found.ms += answer.ms
              for (let row = 0; row < answer.matchCounts.length; row++) {
                if (answer.matchCounts[row]! === 0) continue
                found.withMatch++
                if (found.firstMatch === -1) found.firstMatch = answer.firstDocument + row
              }
              break
            }
            case 'document':
              st.asked.document = false
              if (answer.key === st.wantedKey) st.shown = {index: answer.index, key: answer.key, kinds: answer.kinds, marks: answer.marks}
              break
          }
          break
        }
      }
    }
    st.arrivals.length = 0

    // A GPU that stopped working: the page goes on with both programs on the CPU.
    let world = st.world
    if (world !== null && world.gpu !== null && gpuFailure !== null) {
      world.gpu.searcher.destroy()
      world.gpu.device.destroy()
      st.world = world = {...world, gpu: null}
      st.plan = {documentCount: world.documentCount, reason: {kind: 'gpuFailed', message: gpuFailure}}
      st.job = null
    }
    if (world !== null && !debug.ready) {
      debug.ready = true
      debug.loadMs = world.loadMs
    }
    const documentCount = world?.documentCount ?? st.plan.documentCount
    debug.documentCount = documentCount

    // Inputs: the pattern, what the search reads and where it runs. An example of the Try list replaces the first two.
    // Without a GPU the search runs on the CPU whatever the toggle says: from the first frame in a browser without
    // WebGPU, and from the load's end or later for a GPU that failed.
    const example = st.events.example
    const pattern = example?.pattern ?? typedPattern
    const scope: Scope = example?.scope ?? (isScope(typedScope) ? typedScope : 'everything')
    const withoutGpu = world === null ? !hasWebGpu : world.gpu === null
    const where: Where = withoutGpu ? 'cpu' : typedWhere
    debug.where = world === null ? null : where
    const analysis: PatternAnalysis = world === null ? {kind: 'empty'} : analyzePattern(pattern, defaultStateCapacities)
    const key = analysis.kind === 'fits' ? searchKeyOf(where, scope, pattern) : ''
    const regExpKey = analysis.kind === 'fits' ? `${scope}\n${pattern}` : ''
    if (key !== st.wantedKey) {
      st.wantedKey = key
      st.wantedSince = frameStart
    }
    // The search's answer, while it is the answer for the pattern in the field.
    const found = key !== '' && st.found !== null && st.found.key === key ? st.found : null
    const searchPending = key !== '' && found === null && st.failure === null
    const searchRunsLong = searchPending && frameStart - st.wantedSince >= longSearchMs
    // A timing of RegExp that has run for too long is given up. When it is the one for the search on screen, its
    // answer is that it took more than the page waits.
    let timingGivenUp = false
    if (st.timing !== null && frameStart - st.timing.since >= (st.timing.key === regExpKey ? regExpLimitMs : leftRegExpLimitMs)) {
      if (st.timing.key === regExpKey) st.regExp = {key: regExpKey, time: {kind: 'stopped', afterMs: regExpLimitMs}}
      st.timing = null
      timingGivenUp = true
    }
    const regExpTime = regExpKey !== '' && st.regExp !== null && st.regExp.key === regExpKey ? st.regExp.time : null

    const layout = mapLayout(mapWidthCss, scale, documentCount)
    // The matches on the map: the answer for the pattern in the field, none for a pattern that isn't searched, and
    // the last answer for as long as a search is in flight, until the search runs long.
    let mapView = st.mapView
    if (found !== null) mapView = {found, rest: 'waiting'}
    else if (!searchPending) mapView = {found: null, rest: 'plain'}
    else if (searchRunsLong) mapView = {found: null, rest: 'waiting'}
    const onMap = mapView.found

    // Inputs: the pointer over the map, a click on it, and the Enter key, each for the matches that the map shows.
    // The pointer picks the nearest document with a match, or the document under it where the search hasn't been
    // yet, and when no document has a match.
    const pick = (point: {x: number, y: number}, box: DOMRect) => {
      const index = pickedDocument(layout, onMap?.matchCounts ?? noCounts, onMap?.searched ?? 0, point.x - box.left, point.y - box.top)
      return index >= 0 ? index : null
    }
    let hovered: number | null = null
    if (world !== null && mapBox !== null) {
      if (st.pointer !== null) hovered = pick(st.pointer, mapBox)
      if (st.events.click !== null) {
        // A click keeps the document that the pointer picks, and a click on the kept document lets it go. A finger
        // has no pointer over the map, so its tap picks by its own place. A mouse's click doesn't: the browser
        // reports a click's place in whole CSS px and a pointer's in fractions, and a cell of 100,000 is 1.5 px
        // from the next, so the click could keep the neighbor of the document that the panel shows.
        const clicked = st.pointer !== null ? hovered : pick(st.events.click, mapBox)
        if (clicked !== null) st.kept = st.kept === clicked ? null : clicked
      }
    }
    if (onMap !== null) {
      for (let step = 0; step < Math.abs(st.events.steps); step++) {
        const next = nextMatch(onMap.matchCounts, onMap.searched, st.kept ?? st.shown?.index ?? 0, st.events.steps > 0 ? 1 : -1)
        if (next >= 0) st.kept = next
      }
    }
    // A kept document that the search found nothing in is let go.
    if (found !== null && st.kept !== null && st.kept < found.searched && found.matchCounts[st.kept] === 0) st.kept = null
    // The document that the panel should show: the one that the pointer picks, else the kept one, else the first with
    // a match. While a search is in flight the panel stays as it is, and it shows another document once that
    // document's display kinds and marks are here.
    const target = hovered ?? st.kept ?? (found !== null && found.firstMatch >= 0 ? found.firstMatch : st.shown?.index ?? 0)
    const wantedDocument = world === null || searchPending ? null : {index: target, key}
    const documentIsHere = wantedDocument === null || (st.shown !== null && st.shown.index === wantedDocument.index && st.shown.key === wantedDocument.key)

    // What the page shows: the line of numbers.
    const notice = loadNotice(st.plan.reason, documentCount) ?? ''
    let lineView = st.lineView
    if (st.failure !== null) {
      lineView = {state: 'bad', line: [failureSentence(st.failure)]}
    } else if (world === null) {
      lineView = {state: 'busy', line: [`Loading ${count(documentCount)} documents…`]}
    } else {
      switch (analysis.kind) {
        case 'empty':
          lineView = {state: 'idle', line: [`Type a pattern to search the ${count(documentCount)} documents.`]}
          break
        case 'refused':
          lineView = {state: 'bad', line: [analysis.sentence]}
          break
        case 'fits':
          // Without the answer yet, the line stays as it is, except for a search that takes longer than a few
          // frames, e.g. on the program for 32 states, and for the first search.
          if (found !== null) lineView = {state: found.searched < documentCount ? 'busy' : 'ok', line: resultLine(found, documentCount, where, regExpTime)}
          else if (searchRunsLong || st.found === null) lineView = {state: 'busy', line: [`Searching ${count(documentCount)} documents…`]}
          break
      }
    }

    // Commit what the frame decided.
    st.lineView = lineView
    st.mapView = mapView

    // DOM writes. The title, in the heading and on the browser's tab, has the count that the page holds. Before the
    // first frame, the page's HTML and demo.css show the count that the window's width asks for, which is the same
    // one. Later the two can differ: a window that changes its width keeps its documents, e.g. a phone turned on its
    // side, and a GPU with small buffers gets fewer documents than the width asks for.
    const title = `Search ${count(documentCount)} JSON documents`
    if (written.title !== title) {
      domCache.title.textContent = written.title = title
      document.title = `${title} · Handwired`
    }
    if (written.notice !== notice) {
      domCache.notice.textContent = written.notice = notice
      domCache.notice.style.display = notice === '' ? 'none' : 'block'
    }
    const statusClass = `status ${lineView.state}`
    if (written.statusClass !== statusClass) domCache.status.className = written.statusClass = statusClass
    // A screen reader waits with the line while a search on the CPU still changes it at each frame.
    const statusBusy = lineView.state === 'busy' ? 'true' : 'false'
    if (written.statusBusy !== statusBusy) domCache.status.ariaBusy = written.statusBusy = statusBusy
    const statusLine = JSON.stringify(lineView.line)
    if (written.statusLine !== statusLine) {
      written.statusLine = statusLine
      writeLine(domCache.statusLine, lineView.line)
    }
    if (example !== null) {
      domCache.pattern.value = pattern
      for (const input of domCache.scopes) input.checked = input.value === scope
    }
    // Without a GPU the toggle stays on CPU.
    if (written.gpuDisabled !== withoutGpu) {
      domCache.whereGpu.disabled = written.gpuDisabled = withoutGpu
      if (withoutGpu) domCache.whereCpu.checked = true
    }

    // The map: its size and its cells.
    const mapHeight = `${Math.ceil(layout.height / scale)}px`
    if (written.mapHeight !== mapHeight) domCache.map.style.height = written.mapHeight = mapHeight
    const size = `${layout.width} ${layout.height} ${layout.pitch} ${layout.documentCount}`
    if (mapCache.size !== size) {
      mapCache.size = size
      domCache.canvas.width = layout.width
      domCache.canvas.height = layout.height
      domCache.canvas.style.width = `${layout.width / scale}px`
      domCache.canvas.style.height = `${layout.height / scale}px`
      mapCache.image = domCache.context.createImageData(layout.width, layout.height)
      mapCache.pixels = new Uint32Array(mapCache.image.data.buffer)
      mapCache.painted = ''
    }
    mapCache.layout = layout
    let paintMs: number | null = null
    const painted = `${st.loaded} ${mapView.found?.key ?? ''} ${mapView.found?.searched ?? 0} ${mapView.rest}`
    if (mapCache.painted !== painted && mapCache.image !== null && mapCache.pixels !== null) {
      const paintStarted = window.performance.now()
      paintCells(mapCache.pixels, layout, st.loaded, mapView.found?.searched ?? 0, mapView.found?.matchCounts ?? noCounts, colors, mapView.rest === 'plain' ? colors.plain : colors.waiting)
      domCache.context.putImageData(mapCache.image, 0, 0)
      mapCache.painted = painted
      paintMs = window.performance.now() - paintStarted
    }
    // The ring around the cell of the document that the panel shows, which is heavier for a kept document.
    const shown = st.shown
    let ring = 'display: none'
    if (shown !== null) {
      const center = cellCenterCss(layout, shown.index)
      ring = `transform: translate(${center.x}px, ${center.y}px)`
    }
    if (written.ring !== ring) domCache.ring.style.cssText = written.ring = ring
    const ringClass = shown !== null && shown.index === st.kept ? 'ring kept' : 'ring'
    if (written.ringClass !== ringClass) domCache.ring.className = written.ringClass = ringClass

    // The document.
    const documentName = shown === null ? '' : `Document ${count(shown.index + 1)}`
    if (written.documentName !== documentName) domCache.documentName.textContent = written.documentName = documentName
    let firstHit: HTMLElement | null = null
    const documentKey = shown === null ? '' : `${shown.index} ${shown.key}`
    const documentChanged = written.documentKey !== documentKey
    if (documentChanged) {
      written.documentKey = documentKey
      const nodes: HTMLElement[] = []
      if (shown !== null && world !== null) {
        for (const run of documentRuns(world.texts[shown.index]!, shown.kinds, shown.marks)) {
          const node = document.createElement('span')
          node.className = runClassName(run)
          node.textContent = run.text
          nodes.push(node)
          if (run.match !== 0) firstHit ??= node
        }
      }
      domCache.documentText.replaceChildren(...nodes)
    }

    // Side effects. The document's text scrolls to its first match when another document or another search's marks
    // are shown, so that the match stands three lines under the text's upper edge: reading the match's place, which
    // is its distance from that edge, lays the text out, once, after every write above.
    if (documentChanged) domCache.documentText.scrollTop = firstHit === null ? 0 : Math.max(0, firstHit.offsetTop - 72)
    if (focusAfterExample) {
      domCache.pattern.focus({preventScroll: true})
      domCache.pattern.setSelectionRange(pattern.length, pattern.length)
    }

    // The search's timing, once its complete answer is on the canvas.
    if (found !== null && found.searched === documentCount && paintMs !== null && written.timedFound !== found) {
      written.timedFound = found
      const timing: SearchTiming = {pattern, scope, where, documentsWithMatches: found.withMatch, searchMs: found.ms, paintMs, paintedAt: window.performance.now()}
      if (debug.searches.length >= 1000) debug.searches.shift()
      debug.searches.push(timing)
      st.openTiming = {timing, inputTime: st.events.firstInputTime}
    }

    // The work that is due. A timing of RegExp that was given up is stopped by ending its worker.
    if (timingGivenUp && regExpWorker !== null) {
      regExpWorker.terminate()
      regExpWorker = null
    }
    if (world !== null && st.failure === null) {
      const search = analysis.kind === 'fits' ? {pattern, scope} : null
      // On the GPU, one piece at a time: the search for the pattern in the field, then the document that the panel
      // should show.
      if (where === 'gpu' && world.gpu !== null && st.job === null) {
        if (searchPending && analysis.kind === 'fits') startOnGpu(searchOnGpu(world.gpu.searcher, key, pattern, scope, analysis.states))
        else if (wantedDocument !== null && !documentIsHere) startOnGpu(documentOnGpu(world.gpu.searcher, wantedDocument.index, key, search))
      }
      // RegExp's time for the search, one timing at a time: the next one waits for the answer of the one in flight,
      // or for the frame that gives it up.
      if (search !== null && regExpTime === null && st.timing === null) {
        st.timing = {key: regExpKey, since: frameStart}
        regExpWorker ??= startWorker(documentCount)
        regExpWorker.postMessage({kind: 'regExp', key: regExpKey, ...search} satisfies WorkerRequest)
      }
      // The worker for the CPU: the search when it runs there, which replaces the one in progress, and the
      // document, one request at a time.
      const cpuSearch = where === 'cpu' ? search : null
      if (cpuSearch === null) {
        if (st.asked.search !== null && cpuWorker !== null) {
          st.asked.search = null
          cpuWorker.postMessage({kind: 'search', search: null} satisfies WorkerRequest)
        }
      } else if (st.asked.search?.key !== key) {
        st.asked.search = {id: nextSearchId++, key}
        cpuWorker ??= startWorker(documentCount)
        cpuWorker.postMessage({kind: 'search', search: {id: st.asked.search.id, ...cpuSearch}} satisfies WorkerRequest)
      }
      if (where === 'cpu' && wantedDocument !== null && !documentIsHere && !st.asked.document) {
        st.asked.document = true
        cpuWorker ??= startWorker(documentCount)
        cpuWorker.postMessage({kind: 'document', key, index: wantedDocument.index, search} satisfies WorkerRequest)
      }
    }
    // The next frame that nothing else asks for: the one that says that a search runs long, or the one that gives
    // up the timing of RegExp in flight.
    const searchRunsLongAt = searchPending && !searchRunsLong ? st.wantedSince + longSearchMs : Number.POSITIVE_INFINITY
    const timingGivenUpAt = st.timing === null ? Number.POSITIVE_INFINITY : st.timing.since + (st.timing.key === regExpKey ? regExpLimitMs : leftRegExpLimitMs)
    const wakeAt = Math.min(searchRunsLongAt, timingGivenUpAt)
    if (wakeAt !== st.wakeAt) {
      window.clearTimeout(wakeTimer)
      // A timer may fire a fraction of a ms early, and its frame would then find that it is too early. So the timer
      // aims a ms late, and when it fires, the state forgets it, so that a frame that still waits sets a new one.
      if (wakeAt !== Number.POSITIVE_INFINITY) wakeTimer = window.setTimeout(wake, Math.ceil(Math.max(0, wakeAt - window.performance.now())) + 1)
      st.wakeAt = wakeAt
    }

    // The events are handled.
    st.events.example = null
    st.events.click = null
    st.events.steps = 0
    // The time of an input is kept for as long as its search is in flight.
    if (!searchPending) st.events.firstInputTime = null

    // Another frame completes the search's timing.
    return st.openTiming !== null
  }

  const recordInput = (event: Event) => {
    st.events.firstInputTime ??= event.timeStamp
    scheduleRender()
  }
  domCache.pattern.addEventListener('input', recordInput)
  // Enter and Shift+Enter step to the next and the previous document with a match, as in a browser's find bar. They
  // do so with the focus in the field and anywhere else on the page, since a click on the map or on a toggle takes
  // the focus out of the field. On a link or a button, Enter is the click.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || (event.target instanceof Element && event.target.closest('a, button') !== null)) return
    st.events.steps += event.shiftKey ? -1 : 1
    scheduleRender()
  })
  for (const input of [...domCache.scopes, domCache.whereGpu, domCache.whereCpu]) input.addEventListener('change', recordInput)
  domCache.tryList.addEventListener('click', event => {
    const example = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pattern]') : null
    if (example === null) return
    const pattern = example.dataset['pattern']
    const scope = example.dataset['scope']
    invariant(pattern !== undefined && isScope(scope), 'an example names its pattern and what it reads')
    st.events.example = {pattern, scope}
    recordInput(event)
  })
  // The pointer over the map: a mouse or a pen points at a document, and a touch only clicks.
  domCache.map.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    st.pointer = {x: event.clientX, y: event.clientY}
    scheduleRender()
  })
  domCache.map.addEventListener('pointerleave', () => {
    st.pointer = null
    scheduleRender()
  })
  domCache.map.addEventListener('click', event => {
    st.events.click = {x: event.clientX, y: event.clientY}
    scheduleRender()
  })
  // The map's width follows the window's. The observer covers every other cause one frame late, e.g. a scrollbar that
  // appears, and a scroll moves the map under a pointer that stays where it is.
  window.addEventListener('resize', scheduleRender)
  window.addEventListener('scroll', scheduleRender, {passive: true})
  const mapObserver = new ResizeObserver(scheduleRender)
  mapObserver.observe(domCache.map)
  // The cells are drawn for the screen's device pixels, and a window that moves to another screen keeps its size in
  // CSS px. Where the browser can observe an element's size in device pixels, the map is drawn again for the new
  // screen, and elsewhere after the next resize.
  try {
    mapObserver.observe(domCache.map, {box: 'device-pixel-content-box'})
  } catch {}

  // Where there is a mouse and a keyboard, the page starts with the caret in the pattern field, at the pattern's end.
  if (window.matchMedia('(pointer: fine)').matches) {
    domCache.pattern.focus({preventScroll: true})
    domCache.pattern.setSelectionRange(domCache.pattern.value.length, domCache.pattern.value.length)
  }
  scheduleRender()
  // The first frame paints the empty map before the documents are written.
  window.requestAnimationFrame(() => {
    load().then(world => {
      st.arrivals.push({kind: 'loaded', world})
      scheduleRender()
    }, (error: unknown) => {
      st.failure = {kind: 'documents', message: error instanceof Error ? error.message : String(error)}
      scheduleRender()
    })
  })
}

mountJsonSearch(document, window)
