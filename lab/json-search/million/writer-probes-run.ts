// Opens writer-probes-page.ts in a fresh headless Chrome with WebGPU and writes what the page posts to --out.
//
//   bun lab/json-search/million/writer-probes-run.ts --profile <new folder> --out <file.json> [--fuzz 300] [--port 4552] [--devtools-port 9552]
import {argument, required, runPage} from '../gpu/chrome.ts'
import page from './writer-probes-page.html'
import type {ProbesConfig} from './writer-probes-page.ts'

const config: ProbesConfig = {
  fuzzPrograms: Number(argument('--fuzz') ?? 300),
  rounds: Number(argument('--rounds') ?? 12),
  fuzzRounds: Number(argument('--fuzz-rounds') ?? 4),
  salt: Number(argument('--salt') ?? Math.floor(Math.random() * 1e9)),
}

await runPage({
  page, config, label: 'the reviewer\'s programs for bit-emit.ts', profile: required('--profile'), out: required('--out'),
  port: Number(argument('--port') ?? 4552), devToolsPort: Number(argument('--devtools-port') ?? 9552), timeoutMs: 1800 * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
