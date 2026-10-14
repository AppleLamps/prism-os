// Opens the million-document check's page in a fresh headless Chrome with WebGPU and writes what the page posts to a
// JSON file. One run is one mode at one document count, and ends its Chrome before the next one starts, since a page
// with a million documents holds several GB.
//
//   bun lab/json-search/million/run.ts --mode compact --count 1000000 --profile <new folder> --out <file.json>
//   bun lab/json-search/million/run.ts --mode program --count 500000 --profile <new folder> --out <file.json>
//   bun lab/json-search/million/run.ts --mode load --count 1000000 --layout fixed --profile <new folder> --out <file.json>
//   bun lab/json-search/million/run.ts --mode js --count 1000000 --profile <new folder> --out <file.json>
//     [--engines bytes,bytes-has] [--capacities 8,16,32] [--no-f32] [--workers 8] [--no-scope-bits] [--limits default]
//     [--keep-texts] [--js-parts wholeText,forms,parse,walk,collected,workers] [--regexp-flags u] [--warm-pauses 200:16]
//     [--port 4511] [--devtools-port 9511] [--search-writer loop-emit] [--chrome <path>]
//
// In the 'program' mode the searcher is the demo page's unless --search-writer says otherwise: bit-emit.ts's shaders
// for the search programs. `--search-writer loop-emit` is what the demo page ran when this check was made, and what
// all.ts's 'program' runs pass.
//
// all.ts runs every table's runs one after the other, and summarize.ts prints the tables from the JSON files.
// Before a run of 500,000 documents or more, this script reads how much memory is free, and stops when it is less than
// --minimum-free-gb, 8 unless given.
import {join} from 'node:path'
import {argument, numbers, required, runPage} from '../gpu/chrome.ts'
import page from './page.html'
import type {PageConfig} from './page.ts'

const has = (name: string) => process.argv.includes(name)
const mode = (argument('--mode') ?? 'compact') as PageConfig['mode']
const count = Number(argument('--count') ?? 100_000)
const profile = required('--profile')

// The page's patterns, and one of 17 states.
const pagePatterns = ['error', '[a-z]+Id', '[a-z0-9.]+@[a-z.]+', '\\d\\d\\d\\d-\\d\\d-\\d\\d', '([a-z]+)+x', 'connection reset']
const everyEngine = ['f32-kernel', 'bytes-boundaries', 'bytes', 'bytes-scope', 'packed', 'packed-scope', 'bytes-bits', 'bytes-has', 'bytes-scope-has', 'packed-scope-has']

const searchWriter = argument('--search-writer') ?? 'bit-emit'
if (searchWriter !== 'bit-emit' && searchWriter !== 'loop-emit') throw new Error(`--search-writer is bit-emit or loop-emit, got ${searchWriter}`)

const config: PageConfig = {
  mode, count, searchWriter,
  patterns: (argument('--patterns') ?? pagePatterns.join('\n')).split('\n'),
  capacities: numbers(argument('--capacities') ?? '8,16,32'),
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  pieceDocuments: Number(argument('--piece') ?? (mode === 'load' ? 25_000 : 50_000)),
  engines: (argument('--engines') ?? everyEngine.join(',')).split(','),
  f32: !has('--no-f32'),
  pausesMs: numbers(argument('--pauses') ?? '200'),
  longPausesMs: numbers(argument('--long-pauses') ?? '1000'),
  longPauseEngines: (argument('--long-pause-engines') ?? 'f32-kernel,bytes,bytes-scope-has').split(','),
  pauseSamples: Number(argument('--pause-samples') ?? 9),
  restMs: Number(argument('--rest') ?? 0),
  // e.g. --warm-pauses 200:16,1000:50 for a pause of 200 ms with a small search every 16 ms, and one of 1 s with one every 50 ms.
  warmPauses: (argument('--warm-pauses') ?? '').split(',').filter(entry => entry !== '').map(entry => ({pauseMs: Number(entry.split(':')[0]), everyMs: Number(entry.split(':')[1])})),
  minimumSamples: Number(argument('--samples') ?? 15),
  sampleMs: Number(argument('--sample-ms') ?? 1000),
  layout: (argument('--layout') ?? 'fixed') as PageConfig['layout'],
  workers: Number(argument('--workers') ?? 8),
  scopeBits: !has('--no-scope-bits'),
  limits: (argument('--limits') ?? 'needed') as PageConfig['limits'],
  keepTexts: has('--keep-texts'),
  regExpFlags: argument('--regexp-flags') ?? '',
  jsSamples: Number(argument('--js-samples') ?? 9),
  jsPauseMs: Number(argument('--js-pause') ?? 0),
  filterWorkers: Number(argument('--filter-workers') ?? 8),
  jsParts: (argument('--js-parts') ?? 'wholeText,parse,walk,collected,workers').split(',') as PageConfig['jsParts'],
}

// How much memory the machine could give without swapping, in GB: free, inactive, speculative and purgeable pages.
function availableGigabytes() {
  const text = Bun.spawnSync(['vm_stat']).stdout.toString()
  const pageBytes = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384)
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0)
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageBytes / 2 ** 30
}
const swapUsed = () => Bun.spawnSync(['sysctl', '-n', 'vm.swapusage']).stdout.toString().trim()
const minimumFree = Number(argument('--minimum-free-gb') ?? 8)
const freeBefore = availableGigabytes()
console.log(`${mode}, ${count} documents: ${freeBefore.toFixed(1)} GB available, swap ${swapUsed()}`)
if (count >= 500_000 && freeBefore < minimumFree) {
  console.error(`less than ${minimumFree} GB is available, so this run doesn't start`)
  process.exit(3)
}

// The worker's script as one file, since Bun's bundler doesn't follow `new Worker(...)`.
const built = await Bun.build({entrypoints: [join(import.meta.dir, 'worker.ts')], target: 'browser'})
if (!built.success) throw new Error(`the worker didn't build: ${built.logs.map(log => log.message).join('\n')}`)
const workerScript = await built.outputs[0]!.text()

// The memory of this run's Chrome processes, which carry the profile folder in their arguments: the resident size from
// ps, and the footprint, which also counts the memory of GPU buffers that the process owns.
function chromeMemory() {
  const lines = Bun.spawnSync(['ps', '-Ao', 'pid=,rss=,args=']).stdout.toString().split('\n').filter(line => line.includes(`--user-data-dir=${profile}`))
  return lines.map(line => {
    const [pid, rss] = line.trim().split(/\s+/)
    const type = /--type=([a-z-]+)/.exec(line)?.[1] ?? 'browser'
    const footprint = Bun.spawnSync(['footprint', '-f', 'bytes', '--noCategories', '-p', pid!]).stdout.toString()
    return {
      pid: Number(pid), type, residentBytes: Number(rss) * 1024,
      footprintBytes: Number(/phys_footprint: (\d+) B/.exec(footprint)?.[1] ?? Number.NaN), footprintPeakBytes: Number(/phys_footprint_peak: (\d+) B/.exec(footprint)?.[1] ?? Number.NaN),
    }
  }).filter(process => process.type !== 'utility' && process.type !== 'crashpad-handler')
}

const isolated = {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp'}
// The lowest amount of available memory during the run, sampled every 2 s.
// When less than --stop-below-gb is available, 3 unless given, the run's Chrome is stopped, so that the machine doesn't swap.
let lowestFree = freeBefore
const stopBelow = Number(argument('--stop-below-gb') ?? 3)
const freeTimer = setInterval(() => {
  const free = availableGigabytes()
  lowestFree = Math.min(lowestFree, free)
  if (free < stopBelow) {
    console.error(`${free.toFixed(1)} GB available, less than ${stopBelow} GB: stopping this run's Chrome`)
    Bun.spawnSync(['pkill', '-KILL', '-f', `--user-data-dir=${profile}`])
    process.exit(4)
  }
}, 2000)

await runPage({
  page, config, label: `million ${mode} ${count}`, profile, out: required('--out'),
  port: Number(argument('--port') ?? 4511), devToolsPort: Number(argument('--devtools-port') ?? 9511),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // --expose-gc lets the page ask for a garbage collection before it measures its JavaScript memory.
  flags: ['--js-flags=--expose-gc'],
  routes: {
    '/million-worker.js': () => new Response(workerScript, {headers: {'content-type': 'text/javascript;charset=utf-8', ...isolated}}),
    '/memory': () => Response.json({processes: chromeMemory(), availableGigabytes: Math.round(availableGigabytes() * 10) / 10, swap: swapUsed()}),
    '/load': () => Response.json({load: Number(Bun.spawnSync(['sysctl', '-n', 'vm.loadavg']).stdout.toString().trim().split(/\s+/)[1])}),
  },
})
clearInterval(freeTimer)
console.log(`${mode}, ${count} documents: done, ${availableGigabytes().toFixed(1)} GB available, lowest during the run ${lowestFree.toFixed(1)} GB, swap ${swapUsed()}`)
