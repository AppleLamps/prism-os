// Opens page.html in a fresh headless Chrome with WebGPU, runs one mode, and writes what the page posts to a JSON file.
//   bun lab/json-search/gpu/run.ts --mode main --profile <new folder> --out <file.json>
//     [--counts 100,1000,10000,100000] [--crossover-counts 1,10,30,300,3000,30000] [--idle-gaps 1,4,16,50,200,1000,3000]
//     [--port 4421] [--devtools-port 9421] [--salt <number>] [--timeout-seconds 3600] [--chrome <path>]
//   bun lab/json-search/gpu/run.ts --mode check --profile <new folder> --out <file.json> [--guards none,max]
// Every run needs a profile folder that no other Chrome uses: Chrome starts with a fresh profile there, and the run
// ends only the Chrome it started. Chrome runs with --enable-webgpu-developer-features, so timestamp queries aren't
// rounded to 100 µs. The main mode takes about 10 minutes, most of it the idle gaps.
import {mkdirSync, writeFileSync} from 'node:fs'
import type {Guard} from '../emit.ts'
import {defaultInvalidFraction, defaultSeed} from '../documents.ts'
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
const numbers = (text: string) => text.split(',').filter(entry => entry !== '').map(Number)
const mode = (argument('--mode') ?? 'main') as PageConfig['mode']
const profile = required('--profile')
const out = required('--out')
const chromePath = argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = Number(argument('--timeout-seconds') ?? 3600) * 1000
const config: PageConfig = {
  mode,
  counts: numbers(argument('--counts') ?? '100,1000,10000,100000'),
  crossoverCounts: numbers(argument('--crossover-counts') ?? '1,10,30,300,3000,30000'),
  idleGapsMs: numbers(argument('--idle-gaps') ?? '1,4,16,50,200,1000,3000'),
  idleSamples: Number(argument('--idle-samples') ?? 5),
  idleTimestampSamples: 3,
  keepWarmGapMs: 1000,
  windowDocuments: 64,
  // A new salt by default, so the shaders compile cold. --salt with an earlier run's salt measures warm compiles.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  seed: defaultSeed,
  invalidFraction: defaultInvalidFraction,
  workgroupSize: Number(argument('--workgroup') ?? 64),
  warmupMs: 300,
  sampleMs: 1500,
  minimumSamples: 15,
  maximumSamples: 200,
  cpuWarmupMs: 500,
  cpuSampleMs: 200,
  cpuSamples: 5,
  executorDocuments: 300,
  generatedJsDocuments: 5000,
  selfCheckDocuments: 500,
  guards: (argument('--guards') ?? 'none,max').split(',') as Guard[],
  checkDocuments: Number(argument('--check-documents') ?? 20_000),
}

const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()
const memoryFree = () => Bun.spawnSync(['memory_pressure']).stdout.toString().trim().split('\n').at(-1)
// The busiest processes on the machine, e.g. another agent's Chrome, by CPU percentage.
const busiest = () => Bun.spawnSync(['ps', '-Ao', 'pcpu=,rss=,comm=', '-r']).stdout.toString().trim().split('\n').slice(0, 6).map(line => line.trim().replace(/\s+/g, ' ').slice(0, 140))
const machine = () => `${Bun.spawnSync(['sysctl', '-n', 'machdep.cpu.brand_string']).stdout.toString().trim()}, ${Bun.spawnSync(['sysctl', '-n', 'hw.ncpu']).stdout.toString().trim()} cores, ${Math.round(Number(Bun.spawnSync(['sysctl', '-n', 'hw.memsize']).stdout.toString()) / 2 ** 30)} GiB, macOS ${Bun.spawnSync(['sw_vers', '-productVersion']).stdout.toString().trim()}`
// The 1-minute load average every 10 s, with the time, so a measurement can be read next to the load around it.
const loadSamples: {at: string, load: string}[] = []
const driver: Record<string, unknown> = {startedAt: new Date().toISOString(), machine: machine(), bun: Bun.version, loadBefore: loadAverage(), memoryBefore: memoryFree(), busiestBefore: busiest(), argv: process.argv.slice(2), loadSamples}
let latestPage: unknown
const writeOut = () => writeFileSync(out, `${JSON.stringify({driver, page: latestPage}, null, 1)}\n`)
const loadTimer = setInterval(() => loadSamples.push({at: new Date().toISOString(), load: loadAverage()}), 10_000)

let finish: () => void = () => {}
const finished = new Promise<void>(resolve => {
  finish = resolve
})
const server = Bun.serve({
  port: Number(argument('--port') ?? 4421),
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

const devToolsPort = Number(argument('--devtools-port') ?? 9421)
mkdirSync(profile, {recursive: true})
const flags = [
  '--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', `--remote-debugging-port=${devToolsPort}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1200,900',
]
driver['flags'] = flags
const occupied = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then(() => true, () => false)
if (occupied) throw new Error(`port ${devToolsPort} already has a debugger listening, pick another --devtools-port`)
const chrome = Bun.spawn([chromePath, ...flags, 'about:blank'], {stdout: 'ignore', stderr: Bun.file(`${profile}.log`)})
driver['chromePid'] = chrome.pid
writeFileSync(`${profile}.pid`, `${chrome.pid}\n`)

async function stopChrome() {
  if (chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    const exited = await Promise.race([chrome.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
    if (!exited) chrome.kill('SIGKILL')
  }
  // Chrome's helper processes carry this run's profile folder in their arguments, and no other Chrome does.
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
  console.log(`${version.Browser}, ${mode}, Chrome PID ${chrome.pid}, DevTools port ${devToolsPort}, page ${server.url.href}`)
  await finished
  socket.close()
} catch (error) {
  driver['error'] = String(error)
  console.error(error)
} finally {
  clearTimeout(hardTimeout)
  clearInterval(loadTimer)
  await stopChrome()
  driver['finishedAt'] = new Date().toISOString()
  driver['loadAfter'] = loadAverage()
  driver['memoryAfter'] = memoryFree()
  driver['busiestAfter'] = busiest()
  writeOut()
  await server.stop(true)
}
