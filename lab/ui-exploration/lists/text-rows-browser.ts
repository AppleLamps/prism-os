// Browser check and frame timings for text-rows.html in headless Chrome, driven over the DevTools Protocol. Run from the
// repo root:
//   bun lab/ui-exploration/lists/text-rows-browser.ts [--scratch <folder>] [--chrome <path>] [--queries <a,b>]
// It bundles the page into the scratch folder, serves it with cross-origin isolation headers, so performance.now()
// resolves to 5 µs instead of 100 µs, starts its own headless Chrome with a fresh profile in the scratch folder, and for
// each query, e.g. capacity=10000&rows=9800, runs scroll, resize, edit and append frames inside the page. Each frame
// runs the page's render now and then forces the browser's style and layout, and is checked. It prints one JSON line per
// query, writes the rows into results.json under "text-rows-browser", saves a screenshot per query, and closes Chrome
// and the server. Every step has a hard timeout.
import {mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

function option(name: string): string | undefined {
  const flag = `--${name}`
  const argumentsAfterScript = Bun.argv.slice(2)
  for (let index = 0; index < argumentsAfterScript.length; index++) {
    if (argumentsAfterScript[index] === flag) return argumentsAfterScript[index + 1]
    if (argumentsAfterScript[index]!.startsWith(`${flag}=`)) return argumentsAfterScript[index]!.slice(flag.length + 1)
  }
  return undefined
}

const scratch = resolve(option('scratch') ?? join(tmpdir(), `text-rows-browser-${Date.now()}`))
const chromePath = option('chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const queries = (option('queries') ?? 'capacity=1000&rows=900,capacity=10000&rows=9800').split(',')
mkdirSync(scratch, {recursive: true})

const children: {kill: () => void}[] = []
const hardTimeout = setTimeout(() => {
  console.error('text-rows-browser timed out after 15 minutes')
  for (const child of children) child.kill()
  process.exit(1)
}, 900_000)

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

type Timing = {evaluation: number, write: number, layout: number}
type PageSettings = {scrollFrames: number, resizeFrames: number, scrollAndResizeFrames: number, edits: number, seed: number}

// Runs inside the page, so it reads only the page's globals and its argument.
function checkInPage(settings: PageSettings) {
  const scroller = document.getElementById('scroller')!
  const demo = () => window.textRowsDemo!
  let seed = settings.seed
  const random = () => {
    seed = (seed * 48_271) % 2_147_483_647
    return seed / 2_147_483_647
  }
  const problems: string[] = []
  const timings: {scroll: Timing[], resize: Timing[], scrollAndResize: Timing[], edit: Timing[], append: Timing[]} = {scroll: [], resize: [], scrollAndResize: [], edit: [], append: []}
  const textHeights = {agree: 0, disagree: 0, examples: [] as string[]}
  // Rows and widths whose drawn text height differed, each counted once.
  const disagreements = new Set<string>()
  const disagreeingRows = new Set<number>()
  const anchoring = {resizesChecked: 0, resizesHeld: 0, resizesAboveView: 0, scrollAndResizeChecked: 0, scrollAndResizeHeld: 0, scrollAndResizeAboveView: 0, editsChecked: 0, editsHeld: 0, examples: [] as string[]}
  const followedAppends = {checked: 0, held: 0}

  // The demo's render, then the browser's style and layout of its DOM writes, forced by a layout read.
  function frame(): Timing {
    demo().renderNow()
    const layoutStart = performance.now()
    scroller.getBoundingClientRect()
    const layout = (performance.now() - layoutStart) * 1000
    return {evaluation: demo().evaluationMicroseconds, write: demo().writeMicroseconds, layout}
  }
  const drawn = () => {
    const output = demo().lastOutput!
    return output.slots.map((slot, index) => ({...slot, index})).filter(slot => slot.present === 1).sort((left, right) => left.row - right.row)
  }
  // Where a row's node is on screen, relative to the scroller's top edge, as the browser laid it out.
  const screenTopOfRow = (row: number) => {
    const slot = drawn().find(entry => entry.row === row)
    return slot === undefined ? undefined : demo().slotNodes[slot.index]!.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }
  function check(label: string) {
    const output = demo().lastOutput!
    const frameInput = demo().lastInput!
    const rows = drawn()
    const viewBottom = output.scrollTop + frameInput.viewportHeight
    if (scroller.scrollTop !== output.scrollTop) problems.push(`${label}: the scroller's scrollTop is ${scroller.scrollTop}, the program's ${output.scrollTop}`)
    rows.forEach((slot, position) => {
      if (slot.row !== output.firstRow + position) problems.push(`${label}: drawn rows aren't one run from row ${output.firstRow}`)
      if (!(slot.top + slot.height > output.scrollTop && slot.top < viewBottom)) problems.push(`${label}: row ${slot.row} is drawn but not in view`)
      if (slot.row % demo().slotCount !== slot.index) problems.push(`${label}: row ${slot.row} is in slot ${slot.index}`)
      // The browser's own layout of the text, against the height pretext's breakpoints gave the row.
      const nativeHeight = demo().slotNodes[slot.index]!.text.getBoundingClientRect().height
      if (nativeHeight === slot.height - demo().textRowLayout.verticalPadding) {
        textHeights.agree++
      } else {
        textHeights.disagree++
        disagreeingRows.add(slot.row)
        const key = `${slot.row}@${slot.layoutWidth}`
        if (!disagreements.has(key) && textHeights.examples.length < 6) textHeights.examples.push(`row ${slot.row} at ${slot.layoutWidth} px, ${demo().texts[slot.row]!.length} characters${/\S{41,}/.test(demo().texts[slot.row]!) ? ', with a word of more than 40 characters' : ''}: predicted ${slot.height - 16} px, drawn ${nativeHeight} px`)
        disagreements.add(key)
      }
    })
    const last = rows.at(-1)
    if (output.slotOverflow === 0 && last !== undefined && last.top + last.height < Math.min(viewBottom, output.totalHeight)) problems.push(`${label}: the drawn rows end before the view does`)
    if (rows.length === 0 && output.totalHeight > 0 && frameInput.viewportHeight > 0) problems.push(`${label}: nothing drawn`)
  }
  const scrollToRandomPlace = () => {
    const slots = drawn()
    const slot = slots[Math.floor(random() * slots.length)]
    scroller.scrollTop = random() < 0.3 && slot !== undefined ? slot.top + (random() < 0.5 ? 0 : slot.height) : random() * (scroller.scrollHeight - scroller.clientHeight)
  }

  frame()
  // Warm up the evaluator and the page's JIT.
  for (let index = 0; index < 60; index++) {
    scrollToRandomPlace()
    frame()
  }
  for (let index = 0; index < settings.scrollFrames; index++) {
    scrollToRandomPlace()
    timings.scroll.push(frame())
    check(`scroll ${index}`)
  }
  for (let index = 0; index < settings.resizeFrames; index++) {
    if (index % 3 === 0) {
      scrollToRandomPlace()
      frame()
    }
    const before = demo().lastOutput!
    const atEnd = scroller.scrollTop + scroller.clientHeight >= before.totalHeight
    const anchorRow = before.firstRow
    const screenTopBefore = screenTopOfRow(anchorRow)
    demo().setContainerWidth(375 + Math.floor(random() * 826))
    timings.resize.push(frame())
    check(`resize ${index}`)
    const after = demo().lastOutput!
    const maximumScroll = Math.max(0, after.totalHeight - demo().lastInput!.viewportHeight)
    if (!atEnd && screenTopBefore !== undefined && after.scrollTop > 0 && after.scrollTop < maximumScroll) {
      const screenTopAfter = screenTopOfRow(anchorRow)
      if (screenTopAfter === undefined) {
        // The row kept its top but got shorter than its part above the view, so it's now entirely above the view.
        anchoring.resizesAboveView++
        if (!(after.firstRow > anchorRow)) problems.push(`resize ${index}: row ${anchorRow} isn't drawn, but the first row is ${after.firstRow}`)
      } else {
        anchoring.resizesChecked++
        if (screenTopAfter === screenTopBefore) anchoring.resizesHeld++
        else if (anchoring.examples.length < 5) anchoring.examples.push(`resize ${index}: row ${anchorRow} moved from ${screenTopBefore} to ${screenTopAfter}`)
      }
    }
  }
  // A scroll by up to half the view and a resize in one frame: the row at the scroll position the DOM reports, as the
  // browser lays out the last frame's DOM, keeps its position on screen.
  for (let index = 0; index < settings.scrollAndResizeFrames; index++) {
    scroller.scrollTop = (0.2 + random() * 0.6) * (scroller.scrollHeight - scroller.clientHeight)
    frame()
    scroller.scrollTop += (random() - 0.5) * scroller.clientHeight
    // The drawn row whose node covers the top edge of the scroller's content box.
    const contentTop = scroller.getBoundingClientRect().top + scroller.clientTop
    const covering = drawn().find(slot => {
      const rectangle = demo().slotNodes[slot.index]!.node.getBoundingClientRect()
      return rectangle.top <= contentTop && contentTop < rectangle.bottom
    })
    const atEnd = scroller.scrollTop + scroller.clientHeight >= demo().lastOutput!.totalHeight
    const screenTopBefore = covering === undefined ? undefined : screenTopOfRow(covering.row)
    demo().setContainerWidth(375 + Math.floor(random() * 826))
    timings.scrollAndResize.push(frame())
    check(`scroll and resize ${index}`)
    const after = demo().lastOutput!
    const maximumScroll = Math.max(0, after.totalHeight - demo().lastInput!.viewportHeight)
    if (covering !== undefined && !atEnd && screenTopBefore !== undefined && after.scrollTop > 0 && after.scrollTop < maximumScroll) {
      const screenTopAfter = screenTopOfRow(covering.row)
      if (screenTopAfter === undefined) {
        anchoring.scrollAndResizeAboveView++
      } else {
        anchoring.scrollAndResizeChecked++
        if (screenTopAfter === screenTopBefore) anchoring.scrollAndResizeHeld++
        else if (anchoring.examples.length < 5) anchoring.examples.push(`scroll and resize ${index}: row ${covering.row} moved from ${screenTopBefore} to ${screenTopAfter}`)
      }
    }
  }
  for (let index = 0; index < settings.edits; index++) {
    scroller.scrollTop = (0.2 + random() * 0.6) * (scroller.scrollHeight - scroller.clientHeight)
    frame()
    const anchorRow = demo().lastOutput!.firstRow
    const screenTopBefore = screenTopOfRow(anchorRow)
    demo().editAboveView()
    timings.edit.push(frame())
    check(`edit ${index}`)
    anchoring.editsChecked++
    if (screenTopOfRow(anchorRow) === screenTopBefore) anchoring.editsHeld++
    else if (anchoring.examples.length < 5) anchoring.examples.push(`edit ${index}: row ${anchorRow} moved`)
  }
  // Appends at the end of the rows, which the view follows, until the table is full.
  scroller.scrollTop = scroller.scrollHeight
  frame()
  let appended = 0
  let refused = 0
  for (let attempt = 0; attempt < demo().capacity; attempt++) {
    if (!demo().appendRow(demo().nextMessage())) {
      refused++
      if (refused > 3) break
      continue
    }
    appended++
    if (appended % 5 === 0) {
      timings.append.push(frame())
      check(`append ${appended}`)
      const output = demo().lastOutput!
      followedAppends.checked++
      if (output.scrollTop === Math.max(0, output.totalHeight - demo().lastInput!.viewportHeight)) followedAppends.held++
    }
  }
  frame()
  const summarize = (values: readonly Timing[]) => {
    const summary = (read: (timing: Timing) => number) => {
      const sorted = values.map(read).sort((left, right) => left - right)
      const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length)
      return {mean: Math.round(mean), median: Math.round(sorted[sorted.length >> 1] ?? 0), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0)}
    }
    return {frames: values.length, evaluation: summary(timing => timing.evaluation), domWrites: summary(timing => timing.write), styleAndLayout: summary(timing => timing.layout), total: summary(timing => timing.evaluation + timing.write + timing.layout)}
  }
  const {size, prepareMilliseconds, tabulateMilliseconds, buildMilliseconds, compileMilliseconds, rowCount, capacity} = demo()
  return {
    crossOriginIsolated, devicePixelRatio, viewport: [scroller.clientWidth, scroller.clientHeight], capacity, rowsAtLoad: rowCount - appended,
    size, prepareMilliseconds: Math.round(prepareMilliseconds), tabulateMilliseconds: Math.round(tabulateMilliseconds), buildMilliseconds: Math.round(buildMilliseconds), compileMilliseconds: Math.round(compileMilliseconds),
    scroll: summarize(timings.scroll), resize: summarize(timings.resize), scrollAndResize: summarize(timings.scrollAndResize), edit: summarize(timings.edit), append: summarize(timings.append),
    problemCount: problems.length, problems: problems.slice(0, 10),
    textHeights: {...textHeights, distinctDisagreements: disagreements.size, disagreeingRows: disagreeingRows.size, disagreeingRowsWithLongWord: [...disagreeingRows].filter(row => /\S{41,}/.test(demo().texts[row]!)).length},
    anchoring, followedAppends,
    appended, full: demo().lastOutput!.full, refusedAfterFull: refused,
  }
}

async function connect(url: string) {
  const socket = new WebSocket(url)
  await withTimeout(new Promise<void>((resolveOpen, reject) => {
    socket.onopen = () => resolveOpen()
    socket.onerror = () => reject(new Error('the DevTools socket failed'))
  }), 10_000, 'connecting to Chrome')
  let nextId = 1
  const pending = new Map<number, {resolve: (result: Record<string, unknown>) => void, reject: (error: Error) => void}>()
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as {id?: number, result?: Record<string, unknown>, error?: {message: string}}
    const entry = message.id === undefined ? undefined : pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id!)
    if (message.error === undefined) entry.resolve(message.result ?? {})
    else entry.reject(new Error(message.error.message))
  }
  return {
    send(method: string, params: Record<string, unknown> = {}, milliseconds = 60_000) {
      const id = nextId++
      socket.send(JSON.stringify({id, method, params}))
      return withTimeout(new Promise<Record<string, unknown>>((resolveSend, reject) => pending.set(id, {resolve: resolveSend, reject})), milliseconds, method)
    },
    close: () => socket.close(),
  }
}

type Client = Awaited<ReturnType<typeof connect>>

async function evaluate<T>(client: Client, expression: string, milliseconds = 60_000): Promise<T> {
  const response = await client.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, milliseconds) as {result: {value?: unknown}, exceptionDetails?: {text: string, exception?: {description?: string}}}
  if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value as T
}

const build = await Bun.build({entrypoints: [resolve(import.meta.dir, 'text-rows.html')], outdir: join(scratch, 'build')})
if (!build.success) throw new Error(build.logs.map(String).join('\n'))
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = new URL(request.url).pathname
    const file = Bun.file(join(scratch, 'build', path === '/' ? 'text-rows.html' : path.slice(1)))
    if (!(await file.exists())) return new Response('Not found', {status: 404})
    return new Response(file, {headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}})
  },
})
children.push({kill: () => void server.stop(true)})
const profile = join(scratch, `chrome-profile-${Date.now()}`)
const chrome = Bun.spawn([chromePath, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,1000', 'about:blank'], {stdout: 'ignore', stderr: 'ignore'})
children.push(chrome)

const rows: unknown[] = []
try {
  let port = 0
  for (let attempt = 0; attempt < 150 && port === 0; attempt++) {
    const file = Bun.file(join(profile, 'DevToolsActivePort'))
    if (await file.exists()) port = Number((await file.text()).split('\n')[0])
    if (port === 0) await Bun.sleep(100)
  }
  if (port === 0) throw new Error("Chrome didn't write DevToolsActivePort within 15 s")
  const targets = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json() as Promise<{type: string, webSocketDebuggerUrl: string}[]>), 10_000, 'listing targets')
  const pageTarget = targets.find(target => target.type === 'page')
  if (pageTarget === undefined) throw new Error('Chrome has no page target')
  const client = await connect(pageTarget.webSocketDebuggerUrl)
  const settings: PageSettings = {scrollFrames: 300, resizeFrames: 120, scrollAndResizeFrames: 40, edits: 20, seed: 7}
  for (const query of queries) {
    await client.send('Page.navigate', {url: `${server.url.href}?${query}`})
    const loadStart = performance.now()
    while (!await evaluate<boolean>(client, `location.search === ${JSON.stringify(`?${query}`)} && window.textRowsDemo?.ready === true`)) {
      if (performance.now() - loadStart > 180_000) throw new Error(`the page with ${query} wasn't ready within 180 s`)
      await Bun.sleep(200)
    }
    const loadMilliseconds = Math.round(performance.now() - loadStart)
    const result = await evaluate<Record<string, unknown>>(client, `(${checkInPage.toString()})(${JSON.stringify(settings)})`, 600_000)
    const screenshot = await client.send('Page.captureScreenshot', {format: 'png'}) as {data: string}
    await Bun.write(join(scratch, `text-rows-${query.replace(/[^a-z0-9]+/gi, '-')}.png`), Buffer.from(screenshot.data, 'base64'))
    const row = {query, loadMilliseconds, ...result}
    console.log(JSON.stringify(row))
    rows.push(row)
  }
  await client.send('Browser.close').catch(() => undefined)
  client.close()
} finally {
  chrome.kill()
  await server.stop(true)
  clearTimeout(hardTimeout)
}
const resultsFile = Bun.file(new URL('./results.json', import.meta.url))
const previous = await resultsFile.exists() ? await resultsFile.json() as Record<string, unknown[]> : {}
await Bun.write(resultsFile, JSON.stringify({...previous, 'text-rows-browser': rows}, null, 2) + '\n')
