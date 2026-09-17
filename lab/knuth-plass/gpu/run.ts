// Opens page.html in a fresh headless Chrome with WebGPU, runs one mode, and writes what the page posts to a JSON file.
//   bun lab/knuth-plass/gpu/run.ts --mode main --profile <new folder> --out <file.json>
//     [--sizes 64:8:1,256:8:1000] [--kernels full,dense-rows] [--inputs line-costs,positions,widths]
//     [--max-matrix-mb 2200] [--salt <number>] [--timeout-seconds 3600] [--chrome <path>]
//   bun lab/knuth-plass/gpu/run.ts --mode check --profile <new folder> --out <file.json> [--check-windows 2,5,8,16,32]
//     [--check-breaks 1,2,3,5,17,37,64,256,1024,4096]
// A size is breaks:window:paragraphs. Chrome runs with --enable-webgpu-developer-features, so timestamp queries aren't
// rounded to 100 µs.
import {mkdirSync, writeFileSync} from 'node:fs'
import page from './page.html'
import type {PageConfig, Size} from './page.ts'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const required = (name: string) => {
  const value = argument(name)
  if (value === undefined) throw new Error(`run.ts needs ${name}`)
  return value
}
const numbers = (text: string) => text.split(',').map(Number)
const mode = (argument('--mode') ?? 'main') as PageConfig['mode']
const profile = required('--profile')
const out = required('--out')
const chromePath = argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = Number(argument('--timeout-seconds') ?? 3600) * 1000

// One paragraph at every break count and window, then batches of 256 break points. The batches stop where the matrices
// would need more than 2.2 GB: at P = 10,000 they need 1,288 MB at W = 8, 5,151 MB at W = 16 and 20,603 MB at W = 32, and
// at P = 3,000 and W = 32, 6,181 MB.
export const defaultSizes: Size[] = [
  ...[64, 256, 1024, 4096].flatMap(breaks => [8, 16, 32].map(window => ({breaks, window, paragraphs: 1}))),
  ...[10, 100, 1000].flatMap(paragraphs => [8, 16, 32].map(window => ({breaks: 256, window, paragraphs}))),
  {breaks: 256, window: 8, paragraphs: 3000}, {breaks: 256, window: 16, paragraphs: 3000}, {breaks: 256, window: 8, paragraphs: 10_000},
]
const sizes = argument('--sizes')?.split(',').map(entry => {
  const [breaks, window, paragraphs] = entry.split(':').map(Number)
  return {breaks: breaks!, window: window!, paragraphs: paragraphs!}
}) ?? defaultSizes

const config: PageConfig = {
  mode,
  sizes,
  kernels: (argument('--kernels') ?? 'full,dense-rows').split(',') as PageConfig['kernels'],
  inputs: (argument('--inputs') ?? 'line-costs,positions,widths').split(',') as PageConfig['inputs'],
  widths: [300, 340],
  // A new salt by default, so the shaders compile cold. --salt with an earlier run's salt measures warm compiles.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  warmupMs: 500,
  sampleMs: 2000,
  minimumSamples: 15,
  maximumSamples: 300,
  maxMatrixMegabytes: Number(argument('--max-matrix-mb') ?? 2200),
  checkWindows: numbers(argument('--check-windows') ?? '2,5,8,16,32'),
  checkBreaks: numbers(argument('--check-breaks') ?? '1,2,3,5,17,37,64,256,1024,4096'),
}

const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()
const memoryFree = () => Bun.spawnSync(['memory_pressure']).stdout.toString().trim().split('\n').at(-1)
// The busiest processes, for the conditions of a run.
const busiest = () => Bun.spawnSync(['ps', '-Ao', 'pcpu,rss,comm', '-r']).stdout.toString().trim().split('\n').slice(0, 8)
const driver: Record<string, unknown> = {startedAt: new Date().toISOString(), loadBefore: loadAverage(), memoryBefore: memoryFree(), busiestBefore: busiest(), argv: process.argv.slice(2)}
let latestPage: unknown
const writeOut = () => writeFileSync(out, `${JSON.stringify({driver, page: latestPage}, null, 1)}\n`)

let finish: () => void = () => {}
const finished = new Promise<void>(resolve => {
  finish = resolve
})
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  development: false,
  routes: {
    // Bun bundles the page at /bundled, and / serves the same HTML with cross-origin isolation headers, so that
    // performance.now() in the page reads in steps of 5 µs instead of 100 µs.
    '/bundled': page,
    '/': async request => {
      const bundled = await fetch(new URL('/bundled', request.url))
      return new Response(bundled.body, {headers: {'content-type': 'text/html;charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp'}})
    },
    '/config': () => Response.json(config),
    '/result': {
      POST: async request => {
        latestPage = await request.json()
        writeOut()
        if ((latestPage as {done?: boolean}).done === true) finish()
        return new Response('ok')
      },
    },
  },
})

// A free port for Chrome's DevTools Protocol: listen on port 0, read the port, and close.
const probe = Bun.listen({hostname: '127.0.0.1', port: 0, socket: {data() {}}})
const devToolsPort = probe.port
probe.stop(true)
mkdirSync(profile, {recursive: true})
const flags = [
  '--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', `--remote-debugging-port=${devToolsPort}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1200,900',
]
driver['flags'] = flags
const chrome = Bun.spawn([chromePath, ...flags, 'about:blank'], {stdout: 'ignore', stderr: Bun.file(`${profile}.log`)})

async function stopChrome() {
  if (chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    const exited = await Promise.race([chrome.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
    if (!exited) chrome.kill('SIGKILL')
  }
  // Chrome's helper processes carry the profile folder in their arguments.
  Bun.spawnSync(['pkill', '-KILL', '-f', `--user-data-dir=${profile}`])
}

const hardTimeout = setTimeout(() => {
  driver['timedOut'] = `after ${timeoutMs / 1000} s`
  writeOut()
  void stopChrome().then(() => {
    void server.stop(true)
    process.exit(2)
  })
}, timeoutMs)

try {
  let version: {Browser: string} | undefined
  for (let attempt = 0; attempt < 600 && version === undefined; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json() as {Browser: string}
    } catch {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}, see ${profile}.log`)
      await Bun.sleep(100)
    }
  }
  if (version === undefined) throw new Error('Chrome did not answer on its DevTools port within 60 s')
  driver['browser'] = version.Browser
  const target = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/new?${encodeURIComponent(server.url.href)}`, {method: 'PUT'})).json() as {webSocketDebuggerUrl: string}
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as {method?: string, params?: {type?: string, args?: {value?: unknown, description?: string}[], exceptionDetails?: unknown}}
    if (message.method === 'Runtime.consoleAPICalled') console.log(`[page] ${message.params!.args!.map(arg => typeof arg.value === 'string' ? arg.value : arg.value === undefined ? String(arg.description) : JSON.stringify(arg.value)).join(' ')}`)
    else if (message.method === 'Runtime.exceptionThrown') console.log(`[page exception] ${JSON.stringify(message.params!.exceptionDetails)}`)
  }
  socket.send(JSON.stringify({id: 1, method: 'Runtime.enable', params: {}}))
  console.log(`${version.Browser}, ${mode}, DevTools port ${devToolsPort}, page ${server.url.href}`)
  await finished
  socket.close()
} catch (error) {
  driver['error'] = String(error)
  console.error(error)
} finally {
  clearTimeout(hardTimeout)
  await stopChrome()
  driver['finishedAt'] = new Date().toISOString()
  driver['loadAfter'] = loadAverage()
  driver['memoryAfter'] = memoryFree()
  driver['busiestAfter'] = busiest()
  writeOut()
  await server.stop(true)
}
