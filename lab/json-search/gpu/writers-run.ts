// Opens writers-page.html in a fresh headless Chrome with WebGPU and writes what the page posts to a JSON file: the
// searcher with loop-emit.ts's shaders and with bit-emit.ts's, taking turns in one Chrome process, over the demo
// page's documents.
//   bun lab/json-search/gpu/writers-run.ts --profile <new folder> --out <file.json>
//     [--count 100000] [--rounds 3] [--samples 15] [--parts searchers,stop] [--port 4429] [--devtools-port 9429]
//     [--salt <number>] [--chrome <path>]
// Every run needs a profile folder that no other Chrome uses, see chrome.ts. One run takes about 5 minutes, most of
// it for loop-emit.ts's shader of 32 states, about 1 s per search. writers-summarize.ts prints the tables.
import {argument, required, runPage} from './chrome.ts'
import page from './writers-page.html'
import type {WritersPageConfig} from './writers-page.ts'

const config: WritersPageConfig = {
  count: Number(argument('--count') ?? 100_000),
  // A new salt by default, so the shaders compile cold.
  shaderSalt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
  rounds: Number(argument('--rounds') ?? 3),
  samples: Number(argument('--samples') ?? 15),
  pauseMs: Number(argument('--pause') ?? 200),
  pauseSamples: 9,
  // The demo page's first pattern and its four examples, with what each reads, then patterns that fill the programs
  // of 8 and 16 states, one of 17 states and one that fills 32.
  patterns: [
    {pattern: 'error', scope: 'everything'}, {pattern: '[a-z0-9.]+@[a-z.]+', scope: 'strings'}, {pattern: '[a-z]+Id', scope: 'keys'},
    {pattern: '\\d\\d\\d\\d-\\d\\d-\\d\\d', scope: 'everything'}, {pattern: '([a-z]+)+x', scope: 'everything'},
    {pattern: '(the|an?) [a-z]+', scope: 'strings'}, {pattern: '(the|an?|some) [a-z]+(ing)?s?', scope: 'everything'},
    {pattern: 'connection reset', scope: 'everything'}, {pattern: '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', scope: 'everything'},
  ],
  parts: (argument('--parts') ?? 'searchers,stop').split(',').filter((part): part is WritersPageConfig['parts'][number] => part === 'searchers' || part === 'stop'),
}

await runPage({
  page, config, label: 'writers', profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4429), devToolsPort: Number(argument('--devtools-port') ?? 9429),
  timeoutMs: Number(argument('--timeout-seconds') ?? 3600) * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
