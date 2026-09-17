// Keystroke frames in headless Chrome. Serves the page with Bun.serve, starts headless Chrome with a fresh profile, fills
// the textarea with 512 code points of JSON, types a digit and a Backspace in turn through the DevTools Protocol, and
// reads the page's own timing of each frame.
//   bun lab/json-highlighter/measure-browser.ts loop 80
// CHROME_PATH overrides the Chrome binary, CHROME_PROFILE_DIR the profile folder, which defaults to a new folder in the
// system's temporary folder, and SCREENSHOT_PATH saves a PNG of the page with an error and a matched bracket at the end.
// The script kills Chrome and stops the server when it finishes, and after 90 s at most.
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import page from './index.html'
import {timingText} from './corpus.ts'
import {type ScanForm, scanForms} from './highlighter.ts'

const form = (process.argv[2] ?? 'loop') as ScanForm
if (!scanForms.includes(form)) throw new Error(`the form must be one of ${scanForms.join(', ')}`)
const keystrokes = Number(process.argv[3] ?? 80)
const chromePath = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = process.env['CHROME_PROFILE_DIR'] ?? mkdtempSync(join(tmpdir(), 'json-highlighter-chrome-'))
const screenshotPath = process.env['SCREENSHOT_PATH']

const server = Bun.serve({port: 0, hostname: '127.0.0.1', development: false, routes: {'/': page}})
const chrome = Bun.spawn([chromePath, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=900,800', 'about:blank'], {stdout: 'ignore', stderr: 'ignore'})
const finish = (code: number) => {
  chrome.kill('SIGKILL')
  void server.stop(true)
  process.exit(code)
}
setTimeout(() => {
  console.error('timed out after 90 s')
  finish(1)
}, 90_000)

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Chrome writes the port it picked into the profile folder, as the file's first line.
function readDevToolsPort(portFile: string): string | undefined {
  if (!existsSync(portFile)) return undefined
  const firstLine = readFileSync(portFile, 'utf8').split('\n')[0] ?? ''
  return firstLine === '' ? undefined : firstLine
}

try {
  const port = await waitFor(() => readDevToolsPort(join(profile, 'DevToolsActivePort')), 'DevToolsActivePort')
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json() as Promise<{type: string, webSocketDebuggerUrl: string}[]>).catch(() => [])
    return list.find(candidate => candidate.type === 'page')
  }, 'a page target')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}))
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  socket.addEventListener('message', message => {
    const data = JSON.parse(String(message.data)) as {id?: number, result?: unknown, error?: {message: string}}
    if (data.id === undefined) return
    if (data.error !== undefined) console.error('DevTools Protocol error', data.error.message)
    pending.get(data.id)?.(data.result)
    pending.delete(data.id)
  })
  const send = <Result>(method: string, params: object = {}) => new Promise<Result>(resolve => {
    const id = nextId++
    pending.set(id, result => resolve(result as Result))
    socket.send(JSON.stringify({id, method, params}))
  })
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await send<{result: {value: T}}>('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result.value
  const frameCount = () => evaluate<number | undefined>('window.jsonHighlighter?.frameTimings.length')

  await send('Page.navigate', {url: `http://${server.hostname}:${server.port}/?form=${form}`})
  await waitFor(async () => ((await frameCount()) ?? 0) >= 1 ? true : undefined, 'the first frame')
  const version = await send<{product: string}>('Browser.getVersion')
  // Fill the textarea through the page, then put the caret in the middle.
  const text = timingText()
  await evaluate(`(() => { const area = document.querySelector('textarea'); area.value = ${JSON.stringify(text)}; area.focus(); area.setSelectionRange(250, 250); area.dispatchEvent(new Event('input')); })()`)
  let frames = await waitFor(async () => {
    const count = await frameCount()
    return count !== undefined && count >= 2 ? count : undefined
  }, 'the frame after filling the text')

  for (let keystroke = 0; keystroke < keystrokes; keystroke++) {
    if (keystroke % 2 === 0) {
      await send('Input.insertText', {text: '7'})
    } else {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8})
    }
    const before = frames
    await waitFor(async () => {
      const count = await frameCount()
      return count !== undefined && count > before ? count : undefined
    }, `the frame of keystroke ${keystroke}`)
    // Later events of the same keystroke, e.g. keyup, render nothing new, so the count settles.
    await Bun.sleep(30)
    frames = (await frameCount()) ?? before
  }
  type FrameTiming = {inputToFrameMs: number, evaluateMs: number, domMs: number}
  const timings = (await evaluate<FrameTiming[]>('window.jsonHighlighter.frameTimings')).slice(2 + 10)
  const finalLength = await evaluate<number>('Array.from(document.querySelector("textarea").value).length')
  const summarize = (field: keyof FrameTiming) => {
    const values = timings.map(timing => timing[field]).sort((left, right) => left - right)
    const at = (fraction: number) => values[Math.min(values.length - 1, Math.floor(fraction * values.length))]!.toFixed(2)
    return `median ${at(0.5)} ms, 95th percentile ${at(0.95)} ms, largest ${at(1)} ms`
  }
  console.log(`${form}, ${version.product}, ${timings.length} keystroke frames after 10 warm-up frames, text of ${finalLength} code points`)
  console.log(`  evaluate: ${summarize('evaluateMs')}`)
  console.log(`  DOM writes: ${summarize('domMs')}`)
  console.log(`  input event to the frame after the DOM writes: ${summarize('inputToFrameMs')}`)

  if (screenshotPath !== undefined) {
    const broken = '{\n  "name": "demo",\n  "tags": ["a", "b"],\n  "size": 01,\n  "nested": {"list": [1, 2, {"ok": true}]}\n}\n'
    await evaluate(`(() => { const area = document.querySelector('textarea'); area.value = ${JSON.stringify(broken)}; area.focus(); area.setSelectionRange(${broken.indexOf('[1')}, ${broken.indexOf('[1')}); area.dispatchEvent(new Event('input')); })()`)
    await Bun.sleep(200)
    const shot = await send<{data: string}>('Page.captureScreenshot', {format: 'png'})
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    console.log(`  screenshot: ${screenshotPath}, status: ${await evaluate<string>('document.querySelector(".status").textContent')}`)
  }
  socket.close()
  finish(0)
} catch (error) {
  console.error(error)
  finish(1)
}
