// Serves every demo page in the repo from one Bun server, with an index page at "/".
//
//   bun lab/ui-exploration/serve-demos.ts              (from the repo root)
//   bun lab/ui-exploration/serve-demos.ts --port 5000  (or PORT=5000; the default is 4321)
//   bun lab/ui-exploration/serve-demos.ts --host 0.0.0.0  (or HOST; the default is 127.0.0.1)
//
// Each page is a Bun HTML import. Bun bundles a page the first time it's requested, the same way
// `bun demo.html` does, so a page's scripts, its stylesheets, the files those stylesheets reference
// with url() (e.g. the photo-gallery-*.webp files in assets/) and the JSON files its modules
// import all resolve relative to the page's own file, whatever URL the page is served at.
//
// A page's URL path is its path in the repo, e.g. /lab/ui-exploration/instanced-items/demo.html, so query
// parameters from the READMEs work as written, e.g. /lab/ui-exploration/instanced-items/demo.html?count=221.
// The READMEs the index page links to are served as plain text at their repo paths too.

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import indexPage from './demos.html'

import handwiredOS from '../../assets/index.html'
import candidateGallery from '../candidate-gallery/candidate-gallery.html'
import learnedGallery from '../learned-gallery/learned-gallery.html'
import hardAttend from '../hard-attend/hard-attend.html'
import generativeFields from '../generative-fields/demo.html'
import eventWindow from '../event-window/demo.html'
import reusableLayout from '../reusable-layout/demo.html'
import knuthPlass from '../knuth-plass/demo.html'

import textWalker from './text-walker/demo.html'
import textTabulated from './text-tabulated/demo.html'
import virtualizedList from './lists/list.html'
import draggableCards from './lists/cards.html'
import textRows from './lists/text-rows.html'
import inputQueue from './input/demo.html'
import layoutTree from './layout-tree/demo.html'
import hnThread from './hn-thread/demo.html'
import codegen from './codegen/demo.html'
import numericLibrary from './numeric-library/demo.html'

import instancedItems from './instanced-items/demo.html'

import streamingWords from './streaming-words/demo.html'
import dragKnobs from './drag-knobs/demo.html'
import eventTime from './event-time/demo.html'
import pixelOutput from './pixel-output/demo.html'
import codePoints from './code-points/demo.html'

const repoRoot = resolve(import.meta.dir, '../..')

const pages = {
  '/assets/index.html': handwiredOS,
  '/lab/candidate-gallery/candidate-gallery.html': candidateGallery,
  '/lab/learned-gallery/learned-gallery.html': learnedGallery,
  '/lab/hard-attend/hard-attend.html': hardAttend,
  '/lab/generative-fields/demo.html': generativeFields,
  '/lab/event-window/demo.html': eventWindow,
  '/lab/reusable-layout/demo.html': reusableLayout,
  '/lab/knuth-plass/demo.html': knuthPlass,
  '/lab/ui-exploration/text-walker/demo.html': textWalker,
  '/lab/ui-exploration/text-tabulated/demo.html': textTabulated,
  '/lab/ui-exploration/lists/list.html': virtualizedList,
  '/lab/ui-exploration/lists/cards.html': draggableCards,
  '/lab/ui-exploration/lists/text-rows.html': textRows,
  '/lab/ui-exploration/input/demo.html': inputQueue,
  '/lab/ui-exploration/layout-tree/demo.html': layoutTree,
  '/lab/ui-exploration/hn-thread/demo.html': hnThread,
  '/lab/ui-exploration/codegen/demo.html': codegen,
  '/lab/ui-exploration/numeric-library/demo.html': numericLibrary,
  '/lab/ui-exploration/instanced-items/demo.html': instancedItems,
  '/lab/ui-exploration/streaming-words/demo.html': streamingWords,
  '/lab/ui-exploration/drag-knobs/demo.html': dragKnobs,
  '/lab/ui-exploration/event-time/demo.html': eventTime,
  '/lab/ui-exploration/pixel-output/demo.html': pixelOutput,
  '/lab/ui-exploration/code-points/demo.html': codePoints,
}

const prototypeFolders = [
  'text-walker', 'text-tabulated', 'lists', 'input', 'layout-tree', 'hn-thread', 'codegen', 'numeric-library',
  'instanced-items', 'streaming-words', 'drag-knobs', 'event-time', 'pixel-output', 'code-points',
  // Folders without a demo page. The index page points at their READMEs.
  'user-population', 'learned-bits',
]
const readmePaths = [
  'README.md',
  'lab/generative-fields/README.md',
  'lab/event-window/README.md',
  'lab/reusable-layout/README.md',
  'lab/learned-gallery/README.md',
  'lab/hard-attend/README.md',
  'lab/candidate-gallery/README.md',
  'src/json-highlighter/README.md',
  'lab/regex-search/README.md',
  'lab/knuth-plass/README.md',
  'lab/ui-exploration/README.md',
  ...prototypeFolders.map(folder => `lab/ui-exploration/${folder}/README.md`),
]
const readmes = Object.fromEntries(readmePaths.map(path => [
  `/${path}`,
  () => new Response(Bun.file(resolve(repoRoot, path)), {headers: {'content-type': 'text/plain; charset=utf-8'}}),
]))

// Browsers request /favicon.ico on the first page they open. An empty response keeps a 404 out of that page's console.
const routes = {'/': indexPage, ...pages, ...readmes, '/favicon.ico': new Response(null, {status: 204})}

// Warn when the index page links to a path this server doesn't serve, e.g. after a demo is renamed.
const indexHtml = readFileSync(resolve(import.meta.dir, 'demos.html'), 'utf8')
for (const match of indexHtml.matchAll(/href="(\/[^"?#]*)/g)) {
  const path = match[1]!
  if (!(path in routes)) console.warn(`demos.html links to ${path}, which this server doesn't serve`)
}

function option(name: string): string | undefined {
  const flag = `--${name}`
  const argumentsAfterScript = Bun.argv.slice(2)
  for (let index = 0; index < argumentsAfterScript.length; index++) {
    const argument = argumentsAfterScript[index]!
    if (argument === flag) return argumentsAfterScript[index + 1]
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1)
  }
  return undefined
}

const portText = option('port') ?? process.env['PORT'] ?? '4321'
const port = Number(portText)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`The port must be an integer from 0 to 65535, got "${portText}".`)
  process.exit(1)
}
// 127.0.0.1 rather than localhost: localhost resolves to IPv6 ::1 first, and while one server holds
// [::1]:4321, a second server can start on 127.0.0.1:4321 without an error, and a browser may reach either.
const hostname = option('host') ?? process.env['HOST'] ?? '127.0.0.1'

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    port,
    hostname,
    // Development mode bundles each page on its first request and reloads open pages when their
    // files change, like `bun demo.html`.
    development: true,
    routes,
    fetch: () => new Response('Not found', {status: 404}),
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Couldn't start the server on ${hostname}:${port} (${message}). Pick another port with --port <number> or PORT=<number>.`)
  process.exit(1)
}

console.log(`Handwired demos: ${server.url}`)
