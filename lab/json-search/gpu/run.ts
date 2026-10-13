// Opens page.html in a fresh headless Chrome with WebGPU, runs one mode, and writes what the page posts to a JSON file.
//   bun lab/json-search/gpu/run.ts --mode main --profile <new folder> --out <file.json>
//     [--counts 100,1000,10000,100000] [--crossover-counts 1,10,30,300,3000,30000] [--idle-gaps 1,4,16,50,200,1000,3000]
//     [--port 4421] [--devtools-port 9421] [--salt <number>] [--timeout-seconds 3600] [--chrome <path>]
//   bun lab/json-search/gpu/run.ts --mode check --profile <new folder> --out <file.json> [--guards none,max]
// Every run needs a profile folder that no other Chrome uses: Chrome starts with a fresh profile there, and the run
// ends only the Chrome it started. Chrome runs with --enable-webgpu-developer-features, so timestamp queries aren't
// rounded to 100 µs. The main mode takes about 8 minutes, most of it waiting before the evaluations after a pause.
import type {Guard} from '../emit.ts'
import {defaultInvalidFraction, defaultSeed} from '../documents.ts'
import {argument, numbers, required, runPage} from './chrome.ts'
import page from './page.html'
import type {PageConfig} from './page.ts'

const mode = (argument('--mode') ?? 'main') as PageConfig['mode']
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

await runPage({
  page, config, label: mode, profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4421), devToolsPort: Number(argument('--devtools-port') ?? 9421),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
