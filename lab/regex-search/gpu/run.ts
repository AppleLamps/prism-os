// Opens page.html in a fresh headless Chrome with WebGPU, runs one mode, and writes what the page posts to a JSON file.
//   bun lab/regex-search/gpu/run.ts --mode main --profile <new folder> --expected <folder of cpu-time.ts bits> --out <file.json>
//     [--states 8,16,32] [--text-lengths 256,1024] [--kernels 8:row-16x16,16:row-16x16,32:row-16x16] [--frames 120]
//     [--salt <number>] [--timeout-seconds 2400] [--chrome <path>]
// The check mode computes its references in the page, and doesn't need --expected.
// Chrome runs with --enable-webgpu-developer-features, so timestamp queries aren't rounded to 100 µs.
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {patternsByStates} from '../report.ts'
import page from './page.html'
import type {PageConfig} from './page.ts'

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
const expectedFolder = mode === 'check' ? argument('--expected') : required('--expected')
const out = required('--out')
const chromePath = argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = Number(argument('--timeout-seconds') ?? 2400) * 1000
const settingsByMode: Record<PageConfig['mode'], Pick<PageConfig, 'warmupMs' | 'sampleMs' | 'minimumSamples' | 'maximumSamples'>> = {
  sweep: {warmupMs: 500, sampleMs: 1500, minimumSamples: 8, maximumSamples: 60},
  main: {warmupMs: 1000, sampleMs: 3000, minimumSamples: 15, maximumSamples: 300},
  frames: {warmupMs: 0, sampleMs: 0, minimumSamples: 0, maximumSamples: 0},
  check: {warmupMs: 0, sampleMs: 0, minimumSamples: 0, maximumSamples: 0},
}
const defaultTextLengths: Record<PageConfig['mode'], string> = {sweep: '16384', frames: '1024', check: '1,2,3,37,1024,4096', main: '256,512,1024,2048,4096,8192,16384,32768,65536'}
const config: PageConfig = {
  mode,
  patterns: Object.fromEntries(Object.entries(patternsByStates).map(([states, pattern]) => [states, pattern])),
  states: numbers(argument('--states') ?? '8,16,32'),
  textLengths: numbers(argument('--text-lengths') ?? defaultTextLengths[mode]),
  kernels: Object.fromEntries((argument('--kernels') ?? '').split(',').filter(entry => entry !== '').map(entry => entry.split(':') as [string, string])),
  // A new salt by default, so the shaders compile cold. --salt with an earlier run's salt measures warm compiles.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  ...settingsByMode[mode],
  frames: Number(argument('--frames') ?? 120),
  expectedFiles: expectedFolder !== undefined && existsSync(expectedFolder) ? readdirSync(expectedFolder).filter(name => name.endsWith('.bin')) : [],
}

const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()
const memoryFree = () => Bun.spawnSync(['memory_pressure']).stdout.toString().trim().split('\n').at(-1)
const driver: Record<string, unknown> = {startedAt: new Date().toISOString(), loadBefore: loadAverage(), memoryBefore: memoryFree(), argv: process.argv.slice(2)}
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
    '/expected/:name': request => {
      const {name} = request.params
      if (expectedFolder === undefined || !config.expectedFiles.includes(name)) return new Response('not found', {status: 404})
      return new Response(Bun.file(join(expectedFolder, name)))
    },
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
  writeOut()
  await server.stop(true)
}
