// Opens gpu/page.html in a fresh headless Chrome with WebGPU, runs one mode, and writes what the page posts to a JSON file.
//   bun lab/ui-exploration/text-walker/batch/gpu/run.ts --mode main --profile <new folder> --expected <folder> --out <file.json>
//     [--sizes short,long] [--counts 1,100,1000,10000,100000] [--guards max,none] [--workgroups 64] [--salt <number>]
//     [--check-count 65536] [--check-grid-count 1024] [--timeout-seconds 3600] [--chrome <path>]
// --expected is the folder from shaders.ts's expected command, written for the same counts. The check mode computes its
// references in the page, and doesn't need it. Chrome runs with --enable-webgpu-developer-features, so timestamp queries
// aren't rounded to 100 µs, and with a JavaScript heap limit of 16 GB, since 100,000 long prepared paragraphs need a few GB.
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import type {Guard} from '../../../codegen/wgsl.ts'
import type {ParagraphSize} from '../paragraphs.ts'
import {sweepWidths} from '../report.ts'
import page from './page.html'
import type {PageConfig} from './page.ts'
import {type BatchShader, type ShaderPlan, buildBatchShader} from './shaders.ts'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const required = (name: string) => {
  const value = argument(name)
  if (value === undefined) throw new Error(`run.ts needs ${name}`)
  return value
}
const list = (text: string) => text.split(',').filter(entry => entry !== '')
const mode = (argument('--mode') ?? 'main') as PageConfig['mode']
const profile = required('--profile')
const expectedFolder = mode === 'check' ? argument('--expected') : required('--expected')
const out = required('--out')
const chromePath = argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const timeoutMs = Number(argument('--timeout-seconds') ?? 3600) * 1000
const settingsByMode: Record<PageConfig['mode'], Pick<PageConfig, 'warmupMs' | 'sampleMs' | 'minimumSamples' | 'maximumSamples'>> = {
  main: {warmupMs: 1000, sampleMs: 3000, minimumSamples: 15, maximumSamples: 300},
  sweep: {warmupMs: 1000, sampleMs: 2000, minimumSamples: 10, maximumSamples: 200},
  check: {warmupMs: 0, sampleMs: 0, minimumSamples: 0, maximumSamples: 0},
}
const config: PageConfig = {
  mode,
  sizes: list(argument('--sizes') ?? 'short,long') as ParagraphSize[],
  counts: list(argument('--counts') ?? (mode === 'sweep' ? '10000,100000' : '1,100,1000,10000,100000')).map(Number),
  guards: list(argument('--guards') ?? (mode === 'sweep' ? 'max' : 'max,none')) as Guard[],
  workgroupSizes: list(argument('--workgroups') ?? (mode === 'sweep' ? '16,64,256' : '64')).map(Number),
  checkWidths: sweepWidths(),
  checkCount: Number(argument('--check-count') ?? 65_536),
  checkGridCount: Number(argument('--check-grid-count') ?? 1024),
  // A new salt by default, so the shaders compile cold. --salt with an earlier run's salt measures warm compiles.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  ...settingsByMode[mode],
  cpuWarmupMs: 1000,
  cpuSampleMs: 300,
  cpuSamples: 7,
}

const loadAverage = () => Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim()
const memoryFree = () => Bun.spawnSync(['memory_pressure']).stdout.toString().trim().split('\n').at(-1)
// The busiest processes on the machine, e.g. another Chrome, by CPU percentage.
const busiest = () => Bun.spawnSync(['ps', '-Ao', 'pcpu=,rss=,comm=', '-r']).stdout.toString().trim().split('\n').slice(0, 6).map(line => line.trim().replace(/\s+/g, ' ').slice(0, 140))
const driver: Record<string, unknown> = {startedAt: new Date().toISOString(), loadBefore: loadAverage(), memoryBefore: memoryFree(), busiestBefore: busiest(), argv: process.argv.slice(2)}
let latestPage: unknown
const writeOut = () => writeFileSync(out, `${JSON.stringify({driver, page: latestPage}, null, 1)}\n`)

const shaders = new Map<string, BatchShader>()
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
    '/shader': request => {
      const query = new URL(request.url).searchParams
      const key = query.toString()
      let shader = shaders.get(key)
      if (shader === undefined) {
        shader = buildBatchShader(query.get('size') as ParagraphSize, query.get('plan') as ShaderPlan, query.get('guard') as Guard, Number(query.get('workgroup')))
        shaders.set(key, shader)
      }
      return Response.json(shader)
    },
    '/expected/:name': request => {
      const {name} = request.params
      if (expectedFolder === undefined || !existsSync(expectedFolder) || !readdirSync(expectedFolder).includes(name)) return new Response('not found', {status: 404})
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
  '--js-flags=--max-old-space-size=16384',
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
    const message = JSON.parse(String(event.data)) as {method?: string, params?: {args?: {value?: unknown, description?: string}[], exceptionDetails?: unknown}}
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
