// Keystroke frames of demo.html in headless Chrome. Serves the page with Bun, starts Chrome with its own profile, types
// a pattern or text one code point at a time with the DevTools Protocol, and reads the page's own timings.
//   bun lab/regex-search/browser-frame.ts --profile <empty folder> [--chrome <path>] [--only <scenario index>]
import {existsSync, mkdirSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import page from './demo.html'
import type {FrameTiming} from './demo.ts'
import {patternsByStates} from './report.ts'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const chromePath = argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = argument('--profile') ?? join(tmpdir(), `regex-search-chrome-${process.pid}`)
const only = argument('--only')
mkdirSync(profile, {recursive: true})

type Scenario = {query: string, field: 'pattern' | 'text', typed: string}
const scenarios: Scenario[] = [
  {query: 'form=data&states=8&text=256', field: 'pattern', typed: patternsByStates[8]!},
  {query: 'form=data&states=16&text=1024', field: 'pattern', typed: patternsByStates[16]!},
  // The page's text starts 24 code points below the capacity, so every typed code point is searched.
  {query: 'form=data&states=16&text=1024', field: 'text', typed: ' and the lights went out'},
  {query: 'form=builtin&states=32&text=1024', field: 'pattern', typed: patternsByStates[32]!},
  {query: 'form=data&states=32&text=1024', field: 'pattern', typed: patternsByStates[32]!},
]

const server = Bun.serve({port: 0, hostname: '127.0.0.1', development: false, routes: {'/': page}})
// Chrome's own messages go next to the profile folder, e.g. when it exits before listening.
const chrome = Bun.spawn([
  chromePath, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--window-size=1200,900', 'about:blank',
], {stdout: 'ignore', stderr: Bun.file(`${profile}.log`)})
const hardTimeout = setTimeout(() => {
  chrome.kill('SIGKILL')
  void server.stop(true)
  console.error('browser-frame.ts timed out after 15 minutes')
  process.exit(1)
}, 900_000)

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function devToolsPort() {
  const portPath = join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 600; attempt++) {
    // Checked with node:fs on every attempt. An earlier version that checked one BunFile created before Chrome started
    // never saw the file, although Chrome had written it.
    if (existsSync(portPath)) {
      const port = Number(readFileSync(portPath, 'utf8').split('\n')[0])
      if (port > 0) return port
    }
    if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}, see ${profile}.log`)
    await sleep(100)
  }
  throw new Error(`Chrome didn't write DevToolsActivePort within 60 s, see ${profile}.log`)
}

async function openPage(port: number, url: string) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {method: 'PUT'})
  const target = await response.json() as {id: string, webSocketDebuggerUrl: string}
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let nextId = 1
  const pending = new Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void}>()
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as {id?: number, result?: unknown, error?: {message: string}}
    if (message.id === undefined) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) request?.reject(new Error(message.error.message))
    else request?.resolve(message.result)
  }
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {resolve, reject})
    socket.send(JSON.stringify({id, method, params}))
  })
  async function evaluate<Result>(expression: string): Promise<Result> {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}) as {result: {value: Result}, exceptionDetails?: {text: string}}
    if (result.exceptionDetails !== undefined) throw new Error(`${expression}: ${result.exceptionDetails.text}`)
    return result.result.value
  }
  async function waitFor(expression: string, timeoutMs: number) {
    const deadline = performance.now() + timeoutMs
    while (!(await evaluate<boolean>(expression))) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${expression}`)
      await sleep(10)
    }
  }
  const close = async () => {
    socket.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
  }
  return {send, evaluate, waitFor, close}
}

const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
const round = (value: number) => Math.round(value * 10) / 10

async function measure(port: number, {query, field, typed}: Scenario) {
  const cdp = await openPage(port, `${server.url.href}?${query}`)
  try {
    const loadStarted = performance.now()
    await cdp.waitFor('window.regexSearchReady === true', 300_000)
    const readyMs = performance.now() - loadStarted
    // Chrome's performance.memory, after the page built its first program.
    const heapMegabytes = await cdp.evaluate<number>('performance.memory.usedJSHeapSize / 1e6')
    const selector = field === 'pattern' ? '#pattern' : '#text'
    // Start from an empty pattern, or with the caret at the end of the text.
    await cdp.evaluate(`(() => {
      document.querySelector('details').open = true
      const element = document.querySelector('${selector}')
      if (${field === 'pattern'}) { element.value = ''; element.dispatchEvent(new Event('input')) }
      element.focus()
      element.selectionStart = element.selectionEnd = element.value.length
    })()`)
    // The first frame, plus the frame for the emptied pattern.
    const setupFrames = field === 'pattern' ? 2 : 1
    await cdp.waitFor(`window.regexSearchFrames.length >= ${setupFrames} && window.regexSearchFrames.at(-1).inputToNextFrameMs !== undefined`, 60_000)
    const start = await cdp.evaluate<number>('window.regexSearchFrames.length')
    for (const character of typed) {
      const before = await cdp.evaluate<number>('window.regexSearchFrames.length')
      await cdp.send('Input.insertText', {text: character})
      await cdp.waitFor(`window.regexSearchFrames.length > ${before} && window.regexSearchFrames.at(-1).inputToNextFrameMs !== undefined`, 120_000)
    }
    const frames = await cdp.evaluate<FrameTiming[]>(`window.regexSearchFrames.slice(${start})`)
    const evaluated = frames.filter(frame => frame.evaluated)
    const summary = (name: keyof FrameTiming) => {
      const values = evaluated.map(frame => frame[name] as number)
      return {median: round(median(values)), max: round(Math.max(...values))}
    }
    const status = await cdp.evaluate<string>('document.querySelector("#status").textContent')
    return {
      query, field, typed, readyMs: round(readyMs), heapMegabytes: Math.round(heapMegabytes), keystrokes: frames.length, evaluatedFrames: evaluated.length,
      compilePatternMs: summary('compilePatternMs'), programMs: summary('programMs'), evaluateMs: summary('evaluateMs'),
      domMs: summary('domMs'), callbackMs: summary('callbackMs'), inputToNextFrameMs: summary('inputToNextFrameMs'), status,
    }
  } finally {
    await cdp.close()
  }
}

try {
  const port = await devToolsPort()
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as {Browser: string}
  console.log(JSON.stringify({browser: version.Browser}))
  for (const [index, scenario] of scenarios.entries()) {
    if (only !== undefined && Number(only) !== index) continue
    try {
      console.log(JSON.stringify(await measure(port, scenario)))
    } catch (error) {
      console.log(JSON.stringify({query: scenario.query, field: scenario.field, error: String(error)}))
    }
  }
} finally {
  clearTimeout(hardTimeout)
  chrome.kill()
  await chrome.exited
  await server.stop(true)
}
