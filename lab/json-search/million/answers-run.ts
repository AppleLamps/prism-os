// Opens answers-page.ts in a fresh headless Chrome with WebGPU and writes what each kernel returned into --out: one
// file per search, and answers.json with the list. independent.ts compares them with RegExp and JSON.parse.
//
//   bun lab/json-search/million/answers-run.ts --out <new folder> --profile <new folder> [--count 1000000] [--port 4511] [--devtools-port 9511]
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {argument, required, runPage} from '../gpu/chrome.ts'
import page from './answers-page.html'
import type {AnswersConfig} from './answers-page.ts'

const out = required('--out')
mkdirSync(out, {recursive: true})
// The report's six patterns, and two more that read a quote and a character past U+007F.
const config: AnswersConfig = {
  count: Number(argument('--count') ?? 1_000_000),
  patterns: ['error', '[a-z]+Id', '[a-z0-9.]+@[a-z.]+', '\\d\\d\\d\\d-\\d\\d-\\d\\d', '([a-z]+)+x', 'connection reset', '"[^"]+"', 'Müller'],
}

await runPage({
  page, config, label: `million answers ${config.count}`, profile: required('--profile'), out: join(out, 'answers.json'),
  port: Number(argument('--port') ?? 4511), devToolsPort: Number(argument('--devtools-port') ?? 9511), timeoutMs: 1200 * 1000,
  chromePath: argument('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  routes: {
    '/answer': async request => {
      const name = new URL(request.url).searchParams.get('name') ?? ''
      if (!/^[a-z0-9-]+$/.test(name)) return new Response('a name of letters, digits and dashes', {status: 400})
      writeFileSync(join(out, `${name}.bin`), new Uint8Array(await request.arrayBuffer()))
      return new Response('ok')
    },
  },
})
