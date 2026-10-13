// Opens combined-page.html in a fresh headless Chrome with WebGPU and writes what the page posts to a JSON file: the
// demo page's module, searcher.ts, created, checked and timed at each document count.
//   bun lab/json-search/gpu/combined-run.ts --profile <new folder> --out <file.json>
//     [--counts 100,1000,10000,100000] [--idle-gaps 16,200,1000] [--port 4424] [--devtools-port 9424] [--salt <number>]
// Every run needs a profile folder that no other Chrome uses, see chrome.ts. One run takes about 6 minutes.
import {defaultInvalidFraction, defaultSeed} from '../documents.ts'
import {argument, numbers, required, runPage} from './chrome.ts'
import page from './combined-page.html'
import type {CombinedPageConfig} from './combined-page.ts'

const config: CombinedPageConfig = {
  counts: numbers(argument('--counts') ?? '100,1000,10000,100000'),
  // Up to 8 states, then one of 11, one of 16, one of 17 and one of 32. `([a-z]+)+x` makes RegExp backtrack.
  patterns: [
    '(the|an?) [a-z]+', 'error', '[a-z0-9.]+@[a-z.]+', '[A-Z][a-z]+ [A-Z][a-z]+', '\\d+\\.\\d+', '([a-z]+)+x',
    '\\d\\d\\d\\d-\\d\\d-\\d\\d', '(the|an?|some) [a-z]+(ing)?s?',
    'connection reset', '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ',
  ],
  scopes: ['strings', 'everything', 'keys'],
  idleGapsMs: numbers(argument('--idle-gaps') ?? '16,200,1000'),
  idleSamples: Number(argument('--idle-samples') ?? 5),
  windowDocuments: 64,
  // A new salt by default, so the shaders compile cold.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  seed: defaultSeed,
  invalidFraction: defaultInvalidFraction,
  warmupMs: 200,
  sampleMs: Number(argument('--sample-ms') ?? 1000),
  minimumSamples: 15,
  maximumSamples: 200,
  cpuWarmupMs: 200,
  cpuSampleMs: 100,
  cpuSamples: 5,
  cpuDocuments: Number(argument('--cpu-documents') ?? 200),
  executorDocuments: Number(argument('--executor-documents') ?? 16),
  selfCheckDocuments: Number(argument('--self-check-documents') ?? 300),
  largestCountFor32States: Number(argument('--largest-count-for-32-states') ?? 10_000),
  straightLine: !process.argv.includes('--no-straight-line'),
}

await runPage({
  page, config, label: 'combined', profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4424), devToolsPort: Number(argument('--devtools-port') ?? 9424),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
