// Opens review-page.html in a fresh headless Chrome with WebGPU and writes what the page posts to a JSON file: the
// review's checks and baselines, see review-page.ts.
//   bun lab/json-search/gpu/review-run.ts --mode edge --profile <new folder> --out <file.json>        about 5 minutes
//   bun lab/json-search/gpu/review-run.ts --mode many --profile <new folder> --out <file.json>        about 6 minutes
//   bun lab/json-search/gpu/review-run.ts --mode baselines --profile <new folder> --out <file.json>   about 4 minutes
//     [--documents 100000] [--port 4427] [--devtools-port 9427] [--salt <number>] [--search-writer loop-emit] [--chrome <path>]
// Every run needs a profile folder that no other Chrome uses, see chrome.ts. Without --search-writer the searcher is
// the demo page's, with bit-emit.ts's shaders for the search programs. `--search-writer loop-emit` is the searcher of
// results/review-edge-1.json and review-many-1.json.
import {defaultInvalidFraction, defaultSeed} from '../../../src/json-search/documents.ts'
import {argument, numbers, required, runPage} from './chrome.ts'
import page from './review-page.html'
import type {ReviewPageConfig} from './review-page.ts'

const mode = (argument('--mode') ?? 'edge') as ReviewPageConfig['mode']
const searchWriter = argument('--search-writer') ?? 'bit-emit'
if (searchWriter !== 'bit-emit' && searchWriter !== 'loop-emit') throw new Error(`--search-writer is bit-emit or loop-emit, got ${searchWriter}`)
const config: ReviewPageConfig = {
  mode,
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  searchWriter,
  seed: defaultSeed,
  invalidFraction: defaultInvalidFraction,
  edgeSizes: {broken: 400, generated: 200, random: 100, mutated: 300, long: 40},
  windowDocuments: mode === 'edge' ? 256 : 64,
  documents: Number(argument('--documents') ?? 100_000),
  executorDocuments: Number(argument('--executor-documents') ?? 2000),
  generatedDocumentsAt32States: Number(argument('--generated-documents-at-32-states') ?? 10_000),
  // search-run.ts's patterns.
  patterns: [
    '(the|an?) [a-z]+', 'error', '[a-z0-9.]+@[a-z.]+', '"[a-z]+":', '[A-Z][a-z]+ [A-Z][a-z]+', '\\d+\\.\\d+', '\\d\\d\\d\\d-\\d\\d-\\d\\d',
    '(the|an?|some) [a-z]+(ing)?s?', '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', '([a-z]+)+x',
  ],
  workerCounts: numbers(argument('--workers') ?? '1,2,4,8,16'),
  warmupMs: 200,
  sampleMs: 1000,
  minimumSamples: 15,
  maximumSamples: 200,
  cpuWarmupMs: 300,
  cpuSampleMs: 200,
  cpuSamples: 5,
}

await runPage({
  page, config, label: `review ${mode}`, profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4427), devToolsPort: Number(argument('--devtools-port') ?? 9427),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
