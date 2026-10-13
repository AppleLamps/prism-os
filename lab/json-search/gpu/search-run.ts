// Opens search-page.html in a fresh headless Chrome with WebGPU and writes what the page posts to a JSON file.
//   bun lab/json-search/gpu/search-run.ts --profile <new folder> --out <file.json>
//     [--sizes 8x256,8x512,16x256,16x512,32x256,32x512] [--counts 100,1000,10000,100000] [--engines step,step-stop,kernel]
//     [--idle-engines step-stop,kernel] [--idle-gaps 16,200,1000] [--port 4424] [--devtools-port 9424] [--salt <number>]
// Every run needs a profile folder that no other Chrome uses, see chrome.ts. The default run takes about 15 minutes.
import {defaultInvalidFraction, defaultSeed} from '../documents.ts'
import {argument, numbers, required, runPage} from './chrome.ts'
import page from './search-page.html'
import type {Engine, SearchPageConfig} from './search-page.ts'

// Patterns over what the generated documents hold: prose, e-mail addresses, dates, names, keys and numbers. The first
// one that fits a capacity is the one the CPU loops are timed with. `([a-z]+)+x` makes RegExp backtrack: a run of
// lowercase letters that no x follows is split in every possible way before the match fails.
const defaultPatterns = [
  '(the|an?) [a-z]+',
  'error',
  '[a-z0-9.]+@[a-z.]+',
  '"[a-z]+":',
  '[A-Z][a-z]+ [A-Z][a-z]+',
  '\\d+\\.\\d+',
  '\\d\\d\\d\\d-\\d\\d-\\d\\d',
  '(the|an?|some) [a-z]+(ing)?s?',
  '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ',
  '([a-z]+)+x',
]

const config: SearchPageConfig = {
  sizes: (argument('--sizes') ?? '8x256,8x512,16x256,16x512,32x256,32x512').split(',').map(size => size.split('x').map(Number) as [number, number]),
  counts: numbers(argument('--counts') ?? '100,1000,10000,100000'),
  engines: (argument('--engines') ?? 'step,step-stop,kernel').split(',') as Engine[],
  patterns: defaultPatterns,
  idleGapsMs: numbers(argument('--idle-gaps') ?? '16,200,1000'),
  idleSamples: Number(argument('--idle-samples') ?? 5),
  idleEngines: (argument('--idle-engines') ?? 'step-stop,kernel').split(',') as Engine[],
  windowDocuments: 64,
  // A new salt by default, so the shaders compile cold.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  seed: defaultSeed,
  invalidFraction: defaultInvalidFraction,
  workgroupSize: Number(argument('--workgroup') ?? 64),
  warmupMs: 200,
  sampleMs: Number(argument('--sample-ms') ?? 1000),
  minimumSamples: 15,
  maximumSamples: 200,
  cpuWarmupMs: 200,
  cpuSampleMs: 100,
  cpuSamples: 5,
  stepDocuments: Number(argument('--step-documents') ?? 200),
  executorDocuments: Number(argument('--executor-documents') ?? 40),
  fullProgramMaxOperations: Number(argument('--full-program-max-operations') ?? 400_000),
}

await runPage({
  page, config, label: 'search', profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4424), devToolsPort: Number(argument('--devtools-port') ?? 9424),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
